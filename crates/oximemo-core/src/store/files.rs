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

/// TOML frontmatter payload. Simplified schema (v3): no `category` (folder
/// location replaces it), `deleted_at` only written when the note is trashed.
/// Old files with `category` / `deleted_at` parse fine — serde ignores
/// unknown fields by default (no `deny_unknown_fields`).
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
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "time::serde::rfc3339::option"
    )]
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

    /// Serialize a memo to its on-disk markdown representation.
    pub fn serialize(memo: &Memo) -> Result<String> {
        Self::serialize_as(memo, crate::memo::NoteFormat::Markdown)
    }

    /// Serialize a memo in the given format. HTML wraps the same TOML
    /// frontmatter in a leading comment so the file stays valid HTML.
    pub fn serialize_as(memo: &Memo, fmt: crate::memo::NoteFormat) -> Result<String> {
        let fm = Frontmatter::from_memo(memo);
        let toml = toml::to_string(&fm)?;
        match fmt {
            crate::memo::NoteFormat::Markdown => {
                let mut out = String::with_capacity(toml.len() + memo.body.len() + 16);
                out.push_str("+++\n");
                out.push_str(&toml);
                out.push_str("+++\n\n");
                out.push_str(&memo.body);
                Ok(out)
            }
            crate::memo::NoteFormat::Html => {
                Ok(crate::html::serialize_frontmatter(&toml, &memo.body))
            }
        }
    }

    /// Parse raw markdown file text. Never panics on malformed input.
    pub fn parse(content: &str) -> Result<ParsedFile> {
        Self::parse_as(content, crate::memo::NoteFormat::Markdown)
    }

    /// Parse raw file text in the given format.
    pub fn parse_as(content: &str, fmt: crate::memo::NoteFormat) -> Result<ParsedFile> {
        let (toml_text, body): (&str, &str) = match fmt {
            crate::memo::NoteFormat::Markdown => match split_frontmatter(content) {
                FrontmatterSplit::None { body } => {
                    return Ok(ParsedFile::BodyOnly {
                        body: body.to_string(),
                    });
                }
                FrontmatterSplit::Unclosed => {
                    return Err(CoreError::Frontmatter {
                        path: PathBuf::new(),
                        reason: "missing closing `+++` delimiter".into(),
                    });
                }
                FrontmatterSplit::Some { toml_text, body } => (toml_text, body),
            },
            crate::memo::NoteFormat::Html => match crate::html::split_frontmatter(content) {
                crate::html::HtmlFrontmatterSplit::Some { toml_text, body } => (toml_text, body),
                crate::html::HtmlFrontmatterSplit::None { body } => {
                    return Ok(ParsedFile::BodyOnly {
                        body: body.to_string(),
                    });
                }
            },
        };
        let fm: Frontmatter = toml::from_str(toml_text).map_err(|e| CoreError::Frontmatter {
            path: PathBuf::new(),
            reason: e.to_string(),
        })?;
        Ok(ParsedFile::Memo {
            fm,
            body: body.to_string(),
        })
    }

    /// Read and parse a file at an explicit path (format from the extension),
    /// attaching the path to any frontmatter error for diagnostics.
    pub fn read(&self, path: &Path) -> Result<ParsedFile> {
        let content = std::fs::read_to_string(path)?;
        Self::parse_as(&content, crate::memo::NoteFormat::from_path(path)).map_err(|e| match e {
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
        let fmt = crate::memo::NoteFormat::from_path(path);
        let content = std::fs::read_to_string(path)?;
        match Self::parse_as(&content, fmt)? {
            ParsedFile::BodyOnly { .. } => Ok(None),
            ParsedFile::Memo { fm, body } => {
                let tags = crate::memo::tags_of(fmt, &body);
                let memo = Memo {
                    id: fm.id,
                    created_at: fm.created_at,
                    updated_at: fm.updated_at,
                    hash: hash::hash_memo(body.as_bytes(), fm.favorite),
                    favorite: fm.favorite,
                    tags,
                    body,
                    deleted_at: fm.deleted_at,
                };
                Ok(Some(memo))
            }
        }
    }

    /// Derive a filename (without extension) from a memo's body: the
    /// slugified title (H1 for markdown, first `<h1>`/`<title>` for html),
    /// or a creation timestamp for untitled notes.
    pub fn derive_filename(memo: &Memo, fmt: crate::memo::NoteFormat) -> String {
        match crate::memo::note_title(fmt, &memo.body) {
            Some(title) => crate::memo::slugify(&title),
            None => crate::memo::timestamp_filename(memo.created_at),
        }
    }

    /// Atomically write a note to `<folder>/<filename><ext>`, handling
    /// filename collisions by appending `-2`, `-3`, etc. Returns the
    /// absolute path written.
    pub fn write_note(
        &self,
        folder: &str,
        memo: &Memo,
        fmt: crate::memo::NoteFormat,
    ) -> Result<PathBuf> {
        let base = Self::derive_filename(memo, fmt);
        let path = self.unique_note_path(folder, &base, fmt);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let text = Self::serialize_as(memo, fmt)?;
        atomic_write(&path, text.as_bytes())?;
        Ok(path)
    }

    /// Write a note to an explicit relative path (used by migration and
    /// restore). Creates parent dirs. Does NOT handle collisions. The format
    /// (and thus the serialization shape) comes from the path's extension.
    pub fn write_note_at(&self, rel_path: &str, memo: &Memo) -> Result<PathBuf> {
        let path = self.paths.vault.join(rel_path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let fmt = crate::memo::NoteFormat::from_path(&path);
        let text = Self::serialize_as(memo, fmt)?;
        atomic_write(&path, text.as_bytes())?;
        Ok(path)
    }

    /// Find a non-colliding path for `folder/base<ext>`, appending `-N`.
    fn unique_note_path(&self, folder: &str, base: &str, fmt: crate::memo::NoteFormat) -> PathBuf {
        let candidate = self.paths.note_path(folder, base, fmt);
        if !candidate.exists() {
            return candidate;
        }
        for n in 2..u32::MAX {
            let c = self.paths.note_path(folder, &format!("{base}-{n}"), fmt);
            if !c.exists() {
                return c;
            }
        }
        // Practically unreachable; fall back to the original.
        candidate
    }

    /// Move a note from a vault-relative live path into `.trash/<rel_path>`,
    /// preserving the folder structure. Idempotent.
    pub fn move_to_trash(&self, rel_path: &str) -> Result<PathBuf> {
        let live = self.paths.vault.join(rel_path);
        let trash = self.paths.trash_path(rel_path);
        if trash.exists() {
            return Ok(trash);
        }
        if live.exists() {
            if let Some(d) = trash.parent() {
                std::fs::create_dir_all(d)?;
            }
            std::fs::rename(&live, &trash)?;
            if let Some(d) = trash.parent() {
                fsync_dir(d)?;
            }
            if let Some(d) = live.parent() {
                fsync_dir(d)?;
            }
        }
        Ok(trash)
    }

    /// Restore a note from `.trash/<rel_path>` back to its original location.
    pub fn restore_from_trash(&self, rel_path: &str) -> Result<PathBuf> {
        let live = self.paths.vault.join(rel_path);
        let trash = self.paths.trash_path(rel_path);
        if live.exists() {
            return Ok(live);
        }
        if trash.exists() {
            if let Some(parent) = live.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::rename(&trash, &live)?;
            if let Some(d) = live.parent() {
                fsync_dir(d)?;
            }
            if let Some(d) = trash.parent() {
                fsync_dir(d)?;
            }
        }
        Ok(live)
    }

    /// Hard-delete a trashed file by its vault-relative path. Returns true if removed.
    pub fn purge(&self, rel_path: &str) -> Result<bool> {
        let trash = self.paths.trash_path(rel_path);
        if trash.exists() {
            std::fs::remove_file(&trash)?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Walk the vault root recursively, yielding every live `.md` file.
    /// Skips `_assets/`, `.trash/`, hidden dirs, and `TEMPLATE.md` files.
    pub fn scan(&self) -> Vec<PathBuf> {
        let mut out = Vec::new();
        scan_md_into(&self.paths.vault, &self.paths.vault, &mut out);
        out
    }

    /// Walk the trash directory.
    pub fn scan_trash(&self) -> Vec<PathBuf> {
        walk_md(&self.paths.trash_root())
    }

    /// Backward-compat alias for [`scan`](Self::scan).
    pub fn list_memo_files(&self) -> Vec<PathBuf> {
        self.scan()
    }

    /// Backward-compat alias for [`scan_trash`](Self::scan_trash).
    pub fn list_trash_files(&self) -> Vec<PathBuf> {
        self.scan_trash()
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
/// The extension is not `md`/`html`, so a stale temp file is never picked
/// up by the note walker.
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

fn is_note_ext(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e == "md" || e == "html")
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
        } else if ft.is_file() && is_note_ext(&path) {
            out.push(path);
        }
    }
}

/// Recursively collect note files (`.md` and `.html`) under `root`, skipping
/// `_assets/`, `.trash/`, hidden directories, and `TEMPLATE.md` /
/// `TEMPLATE.html` files. `root` is the vault root for computing relative
/// paths.
fn scan_md_into(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name_str = entry.file_name().to_string_lossy().into_owned();
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if ft.is_dir() {
            // Skip special directories.
            if name_str.starts_with('.') || name_str == crate::paths::ASSETS_DIR {
                continue;
            }
            scan_md_into(root, &path, out);
        } else if ft.is_file() && is_note_ext(&path) {
            // Skip templates and config files.
            if name_str == crate::paths::TEMPLATE_NAME
                || name_str == crate::paths::TEMPLATE_HTML_NAME
                || name_str == crate::paths::CONFIG_NAME
                || name_str == crate::paths::LEGACY_CONFIG_NAME
            {
                continue;
            }
            out.push(path);
        }
    }
    let _ = root; // root reserved for future relative-path computation
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
            hash: hash::hash_memo(body.as_bytes(), false),
            favorite: false,
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

    #[test]
    fn html_roundtrip_serialize_parse() {
        let memo = sample_memo("<h1>제목</h1>\n<p>본문 #태그</p>");
        let text = FileStore::serialize_as(&memo, crate::memo::NoteFormat::Html).unwrap();
        assert!(text.starts_with("<!--\n+++\n"));
        let parsed = FileStore::parse_as(&text, crate::memo::NoteFormat::Html).unwrap();
        match parsed {
            ParsedFile::Memo { fm, body } => {
                assert_eq!(fm.id, memo.id);
                assert_eq!(fm.tags, memo.tags);
                assert_eq!(body, memo.body);
            }
            _ => panic!("expected memo"),
        }
    }

    #[test]
    fn html_plain_file_is_body_only() {
        let text = "<!DOCTYPE html>\n<html><body><p>외부 문서</p></body></html>";
        let parsed = FileStore::parse_as(text, crate::memo::NoteFormat::Html).unwrap();
        assert!(matches!(parsed, ParsedFile::BodyOnly { .. }));
    }

    #[test]
    fn html_write_and_read_memo_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileStore::new(crate::paths::Paths::resolve(Some(dir.path())));
        let memo = sample_memo("<h1>첫 노트</h1>\n<p>내용 #실제 <a href=\"#sec\">링크</a></p>");
        let path = store
            .write_note("wiki", &memo, crate::memo::NoteFormat::Html)
            .unwrap();
        assert_eq!(path.extension().unwrap(), "html");
        assert!(path.to_string_lossy().contains("wiki/첫-노트.html"));
        let back = store.read_memo(&path).unwrap().unwrap();
        assert_eq!(back.id, memo.id);
        assert_eq!(back.body, memo.body);
        // Tags come from the html *text*, so the `#sec` fragment is not one.
        assert_eq!(back.tags, vec!["실제"]);
    }

    #[test]
    fn scan_collects_html_and_excludes_template() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path();
        std::fs::write(vault.join("note.md"), "x").unwrap();
        std::fs::write(vault.join("page.html"), "y").unwrap();
        std::fs::write(vault.join("TEMPLATE.html"), "z").unwrap();
        std::fs::create_dir_all(vault.join("sub")).unwrap();
        std::fs::write(vault.join("sub/TEMPLATE.md"), "t").unwrap();
        std::fs::write(vault.join("sub/deep.htm"), "skip-me").unwrap();
        let store = FileStore::new(crate::paths::Paths::resolve(Some(vault)));
        let mut names: Vec<String> = store
            .scan()
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, vec!["note.md", "page.html"]);
    }
}
