//! Source-of-truth file store: TOML frontmatter `.md` files (§5.2).
//!
//! Parsing follows the strict rules in §5.2:
//! 1. The first line must be exactly `+++` for frontmatter to exist.
//! 2. Frontmatter runs up to the *second* `+++` line.
//! 3. Everything after the second `+++` is the body.
//! 4. A file whose first line is not `+++` is treated as body-only.
//! 5. A TOML parse failure is a recoverable [`CoreError::Frontmatter`].
//!
//! Writes are atomic: payload goes to `<path>.tmp` and is renamed into place.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::error::{CoreError, Result};
use crate::hash;
use crate::memo::{Memo, MemoId};
use crate::paths::Paths;

/// TOML frontmatter payload. Field order matches the on-disk example in §5.2.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Frontmatter {
    pub id: MemoId,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
    pub hash: crate::memo::MemoHash,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default = "crate::memo::default_category")]
    pub category: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub deleted_at: Option<OffsetDateTime>,
}

impl Frontmatter {
    pub fn from_memo(n: &Memo) -> Self {
        Self {
            id: n.id,
            created_at: n.created_at,
            updated_at: n.updated_at,
            hash: n.hash.clone(),
            favorite: n.favorite,
            category: n.category.clone(),
            tags: n.tags.clone(),
            deleted_at: n.deleted_at,
        }
    }
}

/// Result of parsing a single file.
#[derive(Debug)]
pub enum ParsedFile {
    /// A well-formed memo: valid frontmatter + body.
    Memo { fm: Frontmatter, body: String },
    /// A file with no frontmatter (first line was not `+++`). External/legacy.
    BodyOnly { body: String },
}

impl ParsedFile {
    pub fn body(&self) -> &str {
        match self {
            ParsedFile::Memo { body, .. } => body,
            ParsedFile::BodyOnly { body } => body,
        }
    }
}

/// Filesystem operations on the vault.
pub struct FileStore {
    paths: Paths,
}

impl FileStore {
    pub fn new(paths: Paths) -> Self {
        Self { paths }
    }

    pub fn paths(&self) -> &Paths {
        &self.paths
    }

    /// Serialize a memo to its on-disk representation (frontmatter + body).
    pub fn serialize(memo: &Memo) -> Result<String> {
        let fm = Frontmatter::from_memo(memo);
        let toml = toml::to_string(&fm)?;
        let mut out = String::with_capacity(toml.len() + memo.body.len() + 16);
        out.push_str("+++\n");
        out.push_str(&toml);
        out.push_str("+++\n\n");
        out.push_str(&memo.body);
        Ok(out)
    }

    /// Parse raw file text. Never panics on malformed input.
    pub fn parse(content: &str) -> Result<ParsedFile> {
        match split_frontmatter(content) {
            FrontmatterSplit::None { body } => Ok(ParsedFile::BodyOnly {
                body: body.to_string(),
            }),
            FrontmatterSplit::Unclosed => Err(CoreError::Frontmatter {
                path: PathBuf::new(),
                reason: "missing closing `+++` delimiter".into(),
            }),
            FrontmatterSplit::Some { toml_text, body } => {
                let fm: Frontmatter =
                    toml::from_str(toml_text).map_err(|e| CoreError::Frontmatter {
                        path: PathBuf::new(),
                        reason: e.to_string(),
                    })?;
                Ok(ParsedFile::Memo {
                    fm,
                    body: body.to_string(),
                })
            }
        }
    }

    /// Read and parse a file at an explicit path, attaching the path to any
    /// frontmatter error for diagnostics.
    pub fn read(&self, path: &Path) -> Result<ParsedFile> {
        let content = std::fs::read_to_string(path)?;
        Self::parse(&content).map_err(|e| match e {
            CoreError::Frontmatter { reason, .. } => CoreError::Frontmatter {
                path: path.to_path_buf(),
                reason,
            },
            other => other,
        })
    }

    /// Parse into a complete [`Memo`], recomputing the content hash from the
    /// body. Returns `None` for body-only files (no identity to attach).
    pub fn read_memo(&self, path: &Path) -> Result<Option<Memo>> {
        let content = std::fs::read_to_string(path)?;
        match Self::parse(&content)? {
            ParsedFile::BodyOnly { .. } => Ok(None),
            ParsedFile::Memo { fm, body } => {
                let tags = crate::tags::extract_tags(&body);
                let memo = Memo {
                    id: fm.id,
                    created_at: fm.created_at,
                    updated_at: fm.updated_at,
                    hash: hash::hash_memo(body.as_bytes(), fm.favorite, &fm.category),
                    favorite: fm.favorite,
                    category: fm.category,
                    tags,
                    body,
                    deleted_at: fm.deleted_at,
                };
                Ok(Some(memo))
            }
        }
    }

    /// Atomically write a memo to its sharded path (or trash path when
    /// `deleted_at` is set). Returns the path written.
    pub fn write(&self, memo: &Memo) -> Result<PathBuf> {
        let path = if memo.deleted_at.is_some() {
            self.paths.trash_path(memo.id)
        } else {
            self.paths.memo_path(memo.id, memo.created_at)
        };
        let text = Self::serialize(memo)?;
        atomic_write(&path, text.as_bytes())?;
        Ok(path)
    }

    /// Move a memo's file from the live tree into the trash. Idempotent if the
    /// file is already trashed. Returns the trash path.
    pub fn move_to_trash(&self, memo: &Memo) -> Result<PathBuf> {
        std::fs::create_dir_all(self.paths.trash_root())?;
        let live = self.paths.memo_path(memo.id, memo.created_at);
        let trash = self.paths.trash_path(memo.id);
        if trash.exists() {
            return Ok(trash);
        }
        if live.exists() {
            std::fs::rename(&live, &trash)?;
            // Durability (C2): persist the new trash entry and the removal
            // from the live shard so a crash can't lose the rename.
            if let Some(d) = trash.parent() {
                fsync_dir(d)?;
            }
            if let Some(d) = live.parent() {
                fsync_dir(d)?;
            }
        }
        Ok(trash)
    }

    /// Restore a memo from the trash back to its live path.
    pub fn restore_from_trash(&self, memo: &Memo) -> Result<PathBuf> {
        let live = self.paths.memo_path(memo.id, memo.created_at);
        let trash = self.paths.trash_path(memo.id);
        if live.exists() {
            return Ok(live);
        }
        if trash.exists() {
            if let Some(parent) = live.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::rename(&trash, &live)?;
            // Durability (C2): persist the restored entry and the removal
            // from trash.
            if let Some(d) = live.parent() {
                fsync_dir(d)?;
            }
            if let Some(d) = trash.parent() {
                fsync_dir(d)?;
            }
        }
        Ok(live)
    }

    /// Hard-delete a trashed memo file. Returns true if a file was removed.
    pub fn purge(&self, id: MemoId) -> Result<bool> {
        let trash = self.paths.trash_path(id);
        if trash.exists() {
            std::fs::remove_file(&trash)?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Walk the live memos tree, yielding every `.md` file.
    pub fn list_memo_files(&self) -> Vec<PathBuf> {
        walk_md(&self.paths.memos_root())
    }

    /// Walk the trash directory.
    pub fn list_trash_files(&self) -> Vec<PathBuf> {
        walk_md(&self.paths.trash_root())
    }
}

/// Delimiter-aware split of file content into frontmatter + body.
enum FrontmatterSplit<'a> {
    /// First line was not `+++`: the whole content is body.
    None { body: &'a str },
    /// First line was `+++` but no second `+++` line exists.
    Unclosed,
    /// Both delimiters found.
    Some { toml_text: &'a str, body: &'a str },
}

fn split_frontmatter(content: &str) -> FrontmatterSplit<'_> {
    let first_nl = content.find('\n');
    let first_line_end = first_nl.unwrap_or(content.len());
    let first_line = content[..first_line_end].trim_end_matches('\r');
    if first_line != "+++" {
        return FrontmatterSplit::None { body: content };
    }
    let after_first = first_nl.map(|i| i + 1).unwrap_or(content.len());

    let mut pos = after_first;
    while pos < content.len() {
        let rel = content[pos..].find('\n');
        let line_end = rel.map(|r| pos + r).unwrap_or(content.len());
        let line = content[pos..line_end].trim_end_matches('\r');
        if line == "+++" {
            let toml_text = &content[after_first..pos];
            // Body begins after this line's newline; drop exactly one leading
            // newline (the conventional blank separator) for a canonical body.
            let body_start = if rel.is_some() {
                line_end + 1
            } else {
                content.len()
            };
            let mut body = &content[body_start..];
            if body.starts_with('\n') {
                body = &body[1..];
            }
            return FrontmatterSplit::Some { toml_text, body };
        }
        pos = if rel.is_some() {
            line_end + 1
        } else {
            content.len()
        };
    }
    FrontmatterSplit::Unclosed
}

/// Atomic write: temp file in the same directory, fsync, rename over target.
///
/// Durability (C2): the file is fsync'd, then the parent *directory* is
/// fsync'd so the rename survives power loss — otherwise a crash can leave the
/// new content written but the directory entry pointing at the old (or no)
/// name. Collision safety (C3): the temp name embeds pid + a per-process
/// counter so two processes writing the same memo concurrently cannot stomp
/// each other's temp file.
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)?;
    let tmp = unique_temp(path);
    {
        let mut file = std::fs::File::create(&tmp)?;
        use std::io::Write;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    fsync_dir(parent)?;
    Ok(())
}

/// Build a unique sibling temp path for `target`: `<target>.tmp.<pid>.<n>`.
/// The extension is not `md`, so a stale temp file is never picked up by the
/// memo walker (`walk_md`).
fn unique_temp(target: &Path) -> PathBuf {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let suffix = format!("tmp.{}.{}", std::process::id(), n);
    let mut name = target
        .file_name()
        .map(|s| s.to_os_string())
        .unwrap_or_default();
    name.push(".");
    name.push(suffix);
    target.with_file_name(name)
}

/// fsync a directory so a recent rename/create is durable across power loss.
fn fsync_dir(dir: &Path) -> Result<()> {
    let f = std::fs::File::open(dir)?;
    f.sync_all()?;
    Ok(())
}

fn walk_md(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    walk_md_into(root, &mut out);
    out
}

fn walk_md_into(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if ft.is_dir() {
            walk_md_into(&path, out);
        } else if ft.is_file() && path.extension().is_some_and(|e| e == "md") {
            out.push(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hash;
    use crate::memo::MemoId;

    fn sample_memo(body: &str) -> Memo {
        let id = MemoId::now();
        let now = OffsetDateTime::now_utc();
        Memo {
            id,
            created_at: now,
            updated_at: now,
            hash: hash::hash_memo(body.as_bytes(), false, "todo"),
            favorite: false,
            category: "todo".to_string(),
            tags: vec!["idea".into()],
            body: body.into(),
            deleted_at: None,
        }
    }

    #[test]
    fn roundtrip_memo() {
        let memo = sample_memo("hello world\nsecond line");
        let text = FileStore::serialize(&memo).unwrap();
        assert!(text.starts_with("+++\n"));
        let parsed = FileStore::parse(&text).unwrap();
        match parsed {
            ParsedFile::Memo { fm, body } => {
                assert_eq!(fm.id, memo.id);
                assert_eq!(body, memo.body);
            }
            _ => panic!("expected memo"),
        }
    }

    #[test]
    fn body_only_file() {
        let text = "just some text\nno frontmatter";
        let parsed = FileStore::parse(text).unwrap();
        assert!(matches!(parsed, ParsedFile::BodyOnly { .. }));
    }

    #[test]
    fn unclosed_frontmatter_is_error() {
        let text = "+++\nid = \"x\"\nbody without closer";
        let err = FileStore::parse(text).unwrap_err();
        assert!(matches!(err, CoreError::Frontmatter { .. }));
    }

    #[test]
    fn body_with_plus_plus_plus_line() {
        let memo = sample_memo("text\n+++\nmore text");
        let text = FileStore::serialize(&memo).unwrap();
        let parsed = FileStore::parse(&text).unwrap();
        match parsed {
            ParsedFile::Memo { body, .. } => assert_eq!(body, memo.body),
            _ => panic!("expected memo"),
        }
    }
}
