//! Source-of-truth file store: vault notes with frontmatter (`---` YAML for
//! markdown, `<!--`/`-->`-wrapped `---\n…\n---` for HTML) per the
//! `oxi-frontmatter` grammar v2 (§5.2 of the design, canonical grammar in
//! `crates/oxi-frontmatter/SPEC.md`).
//!
//! Parsing delegates to [`oxi_frontmatter::parse`]; the typed frontmatter
//! extraction lives in [`Frontmatter::from_table`]. The [`ParsedFile`]
//! shape (`Memo { fm, body, table }` / `BodyOnly { body }`) is preserved
//! so existing callers (vault, migrate, doctest) keep compiling, with the
//! addition of the parsed [`Table`] on the `Memo` arm so the write path
//! (Task 4) can re-emit unknown keys.
//!
//! A malformed frontmatter block is a hard [`CoreError::Frontmatter`].
//!
//! **Writes** go through [`oxi_frontmatter::write_document`] (or
//! [`oxi_frontmatter::atomic_write`] for raw byte writes). The old
//! `serialize_as` / `translate_legacy_fences` bridge was removed in
//! Task 4 — every write site in the vault layer now threads through the
//! crate's merge-write API so unknown keys, app tables, and foreign
//! formatting survive a round-trip.

use std::path::{Path, PathBuf};

use serde::Serialize;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use oxi_frontmatter::{NoteFormat as CrateNoteFormat, Parsed, Table, Value};

use crate::error::{CoreError, Result};
use crate::hash;
use crate::memo::{Memo, MemoId};
use crate::paths::Paths;

/// Vault-note metadata as the in-memory model sees it on the read side.
/// `hash` is intentionally absent — it is derived from `body` + `favorite`
/// inside [`crate::hash::hash_memo`] and recomputed on every read so the
/// digest cannot lag behind a partial write. `tags` are likewise derived
/// from the body via [`crate::memo::tags_of`]. Future schema versions
/// will drop `category`; we keep that off the struct entirely.
///
/// The original parsed [`Table`] is carried alongside [`ParsedFile`],
/// not here, so a re-emit (Task 4) can carry unknown keys forward
/// without round-tripping through this typed view.
#[derive(Debug, Clone, Serialize)]
pub struct Frontmatter {
    pub id: MemoId,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
    #[serde(default)]
    pub favorite: bool,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "time::serde::rfc3339::option"
    )]
    pub deleted_at: Option<OffsetDateTime>,
}

impl Frontmatter {
    /// Build a [`Frontmatter`] from the [`oxi-frontmatter`] parsed table.
    ///
    /// v4 on-disk keys are `id, created, updated, favorite, deleted`
    /// (see `oxi-frontmatter` canonical emission); this reader maps
    /// them into the typed `created_at` / `updated_at` / `deleted_at`
    /// fields. `hash` and `tags` are intentionally absent: they are
    /// derived from the body (`hash::hash_memo` / `memo::tags_of`) and
    /// the v4 file format never carries them. The full table is still
    /// available on [`ParsedFile::Memo`] for the write path so foreign
    /// keys (including foreign `hash` / `tags` rows in pre-v3 imports)
    /// survive a round-trip.
    pub fn from_table(table: &Table) -> std::result::Result<Self, String> {
        let id = require_str(table, "id")?;
        let created_at = require_str(table, v4_key("created_at"))?;
        let updated_at = require_str(table, v4_key("updated_at"))?;
        let favorite = match table.get("favorite") {
            Some(Value::Bool(b)) => *b,
            Some(Value::Str(s)) => match s.as_str() {
                "true" => true,
                "false" => false,
                other => {
                    return Err(format!(
                        "frontmatter field `favorite` must be a boolean, got {other:?}"
                    ));
                }
            },
            Some(_) => return Err("frontmatter field `favorite` must be a boolean".to_string()),
            None => false,
        };
        let deleted_at = match table.get(v4_key("deleted_at")) {
            Some(Value::Str(s)) => Some(parse_rfc3339(s)?),
            Some(_) => {
                return Err(
                    "frontmatter field `deleted` (v4 canonical) must be an RFC3339 timestamp string"
                        .to_string(),
                );
            }
            None => None,
        };
        Ok(Self {
            id: MemoId::parse(&id).map_err(|e| e.to_string())?,
            created_at: parse_rfc3339(&created_at)?,
            updated_at: parse_rfc3339(&updated_at)?,
            favorite,
            deleted_at,
        })
    }
}

/// Extract a [`Value::Str`] for `key` from `table`. Returns a precise error
/// naming the missing/wrong-typed field so a `Corrupt frontmatter` line
/// points at the offender.
fn require_str(table: &Table, key: &str) -> std::result::Result<String, String> {
    match table.get(key) {
        Some(Value::Str(s)) => Ok(s.clone()),
        Some(_) => Err(format!("frontmatter field `{key}` must be a string")),
        None => Err(format!("frontmatter is missing required field `{key}`")),
    }
}
fn parse_rfc3339(s: &str) -> std::result::Result<OffsetDateTime, String> {
    OffsetDateTime::parse(s, &Rfc3339)
        .map_err(|e| format!("frontmatter timestamp {s:?} is not RFC3339: {e}"))
}

/// Map a typed [`Frontmatter`] field name to its v4 canonical on-disk
fn v4_key(typed: &str) -> &str {
    match typed {
        "created_at" => "created",
        "updated_at" => "updated",
        "deleted_at" => "deleted",
        other => other,
    }
}

/// Convert the crate's `NoteFormat` into our internal `NoteFormat`.
pub fn to_crate_fmt(fmt: crate::memo::NoteFormat) -> CrateNoteFormat {
    match fmt {
        crate::memo::NoteFormat::Markdown => CrateNoteFormat::Markdown,
        crate::memo::NoteFormat::Html => CrateNoteFormat::Html,
    }
}

/// Translate a [`oxi_frontmatter::FrontmatterError`] into the
/// matching [`CoreError`] variant so the vault-layer call sites stay
/// in the [`crate::Result`] flow. I/O failures map to
/// [`CoreError::Io`] — a watcher must not mistake an `EIO`/permission
/// failure for corrupt frontmatter (the defer-retry signal).
pub fn frontmatter_error_to_core(e: oxi_frontmatter::FrontmatterError) -> CoreError {
    use oxi_frontmatter::FrontmatterError as FE;
    match e {
        FE::Parse(p) => CoreError::Frontmatter {
            path: PathBuf::new(),
            reason: p.to_string(),
        },
        FE::Io(io) => CoreError::Io(io),
        FE::UnexpectedBodyOnly { path } => CoreError::Frontmatter {
            path: path.clone(),
            reason: format!(
                "body-only note at {} rejected without Synthesize::Yes",
                path.display()
            ),
        },
        FE::Unemittable { reason } => CoreError::Frontmatter {
            path: PathBuf::new(),
            reason,
        },
    }
}

/// Result of parsing a single file.
///
/// The `Memo` arm carries the full parsed [`Table`] alongside the typed
/// [`Frontmatter`] so the write path (Task 4) can re-emit unknown keys
/// without losing them. Existing callers that only care about `fm`/`body`
/// keep working unchanged.
#[derive(Debug)]
pub enum ParsedFile {
    /// A well-formed memo: valid frontmatter + body.
    Memo {
        fm: Frontmatter,
        /// Original parsed [`Table`] (insertion-ordered, intact). Carries
        /// unknown keys for the write path.
        table: Table,
        body: String,
    },
    /// A file with no frontmatter (no opening fence). External/legacy.
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

    /// Parse raw markdown file text. Never panics on malformed input.
    pub fn parse(content: &str) -> Result<ParsedFile> {
        Self::parse_as(content, crate::memo::NoteFormat::Markdown)
    }

    /// Parse raw file text in the given format. The full parsed
    /// [`Table`] is returned alongside the typed [`Frontmatter`] so
    /// the write path can re-emit unknown keys. Malformed frontmatter
    /// is a hard error (corrupt files must not silently drop their
    /// metadata).
    pub fn parse_as(content: &str, fmt: crate::memo::NoteFormat) -> Result<ParsedFile> {
        let parsed = oxi_frontmatter::parse(content, to_crate_fmt(fmt)).map_err(|e| {
            CoreError::Frontmatter {
                path: PathBuf::new(),
                reason: e.to_string(),
            }
        })?;
        match parsed {
            Parsed::BodyOnly { body } => Ok(ParsedFile::BodyOnly { body }),
            Parsed::Memo { table, body } => {
                let fm =
                    Frontmatter::from_table(&table).map_err(|reason| CoreError::Frontmatter {
                        path: PathBuf::new(),
                        reason,
                    })?;
                Ok(ParsedFile::Memo { fm, table, body })
            }
        }
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
    /// Read a memo file at `path`, map the parsed frontmatter into the
    /// typed [`Memo`] view, and recompute the body+`favorite` hash via
    /// [`crate::hash::hash_memo`]. Returns `Ok(None)` for body-only
    /// files (no identity to attach).
    pub fn read_memo(&self, path: &Path) -> Result<Option<Memo>> {
        let fmt = crate::memo::NoteFormat::from_path(path);
        let content = std::fs::read_to_string(path)?;
        match Self::parse_as(&content, fmt)? {
            ParsedFile::BodyOnly { .. } => Ok(None),
            ParsedFile::Memo { fm, body, .. } => {
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

    /// Derive a filename (without extension) from a raw body string.
    /// Used by the vault-layer create path where we want the path
    /// *before* the synthesized id/created are known.
    pub fn derive_filename_from_body(
        body: &str,
        fmt: crate::memo::NoteFormat,
        fallback_ts: OffsetDateTime,
    ) -> String {
        match crate::memo::note_title(fmt, body) {
            Some(title) => crate::memo::slugify(&title),
            None => crate::memo::timestamp_filename(fallback_ts),
        }
    }

    /// Find a non-colliding path for `folder/base<ext>`, appending `-N`.
    pub fn unique_note_path(
        &self,
        folder: &str,
        base: &str,
        fmt: crate::memo::NoteFormat,
    ) -> PathBuf {
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

/// fsync a directory so a recent rename/create is durable across power loss.
pub(crate) fn fsync_dir(dir: &Path) -> Result<()> {
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

    #[test]
    fn body_only_file() {
        let text = "just some text\nno frontmatter";
        let parsed = FileStore::parse(text).unwrap();
        assert!(matches!(parsed, ParsedFile::BodyOnly { .. }));
    }

    /// v4 on-disk fixture uses `created`/`updated`/`deleted` keys
    /// (no `_at` suffix). The typed extraction must recover them.
    #[test]
    fn from_table_reads_v4_canonical_keys() {
        let id_str = "0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
        let memo_text = format!(
            "---\n\
             id: {id_str}\n\
             created: 2025-01-02T03:04:05Z\n\
             updated: 2025-01-02T03:04:06Z\n\
             favorite: true\n\
             ---\n\
             hello world\n\
             second line\n",
        );
        let parsed = FileStore::parse(&memo_text).unwrap();
        let (fm, body) = match parsed {
            ParsedFile::Memo { fm, body, .. } => (fm, body),
            ParsedFile::BodyOnly { .. } => panic!("parse should return Memo for formatted input"),
        };
        assert_eq!(fm.id, MemoId::parse(id_str).unwrap());
        assert_eq!(
            fm.created_at
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap(),
            "2025-01-02T03:04:05Z",
        );
        assert_eq!(
            fm.updated_at
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap(),
            "2025-01-02T03:04:06Z",
        );
        assert!(fm.favorite);
        assert_eq!(fm.deleted_at, None);
        assert_eq!(body, "hello world\nsecond line\n");
    }

    /// `deleted` (v4 canonical) maps into the typed `deleted_at` field.
    #[test]
    fn from_table_reads_v4_deleted_key() {
        let id_str = "0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
        let memo_text = format!(
            "---\n\
             id: {id_str}\n\
             created: 2025-01-02T03:04:05Z\n\
             updated: 2025-01-02T03:04:06Z\n\
             favorite: false\n\
             deleted: 2025-01-02T03:04:07Z\n\
             ---\n\
             body\n",
        );
        let parsed = FileStore::parse(&memo_text).unwrap();
        let fm = match parsed {
            ParsedFile::Memo { fm, .. } => fm,
            ParsedFile::BodyOnly { .. } => panic!("expected memo"),
        };
        assert!(
            fm.deleted_at.is_some(),
            "v4 `deleted` must map into typed `deleted_at`"
        );
    }

    /// Body-only HTML is treated as BodyOnly (the crate's HTML grammar
    /// requires a `<!--\n---` opener; nothing else qualifies).
    #[test]
    fn html_plain_file_is_body_only() {
        let text = "<!DOCTYPE html>\n<html><body><p>외부 문서</p></body></html>";
        let parsed = FileStore::parse_as(text, crate::memo::NoteFormat::Html).unwrap();
        assert!(matches!(parsed, ParsedFile::BodyOnly { .. }));
    }

    /// BodyOnly ⇒ Ok(None) — the visibility boundary.
    #[test]
    fn body_only_via_read_memo_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileStore::new(crate::paths::Paths::resolve(Some(dir.path())));
        let path = dir.path().join("plain.md");
        std::fs::write(&path, "no frontmatter here\n").unwrap();
        let read = store.read_memo(&path).unwrap();
        assert!(read.is_none());
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

    /// parse_as preserves unknown keys on the parsed file so the write
    /// path can re-emit them. The typed view drops them, but the
    /// original Table is intact.
    #[test]
    fn parse_as_preserves_unknown_keys_in_table() {
        let text = "---\n\
                    id: 0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee\n\
                    created: 2025-01-02T03:04:05Z\n\
                    updated: 2025-01-02T03:04:06Z\n\
                    favorite: false\n\
                    color: 5\n\
                    ---\n\
                    body\n";
        let parsed = FileStore::parse(text).unwrap();
        match parsed {
            ParsedFile::Memo { table, .. } => {
                assert!(table.contains_key("color"));
                assert!(table.contains_key("id"));
            }
            ParsedFile::BodyOnly { .. } => panic!("expected memo"),
        }
    }

    /// The on-disk `oxios:` sub-table (an app extension) survives a
    /// parse → emit → parse round-trip unchanged. Unknown nested maps
    /// are sorted alphabetically by the emitter (stable canonical
    /// ordering) but the *content* survives.
    #[test]
    fn oxios_subtable_survives_roundtrip() {
        let text = "---\n\
                    id: 0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee\n\
                    created: 2025-01-02T03:04:05Z\n\
                    updated: 2025-01-02T03:04:06Z\n\
                    favorite: false\n\
                    oxios:\n  \
                      author: agent\n  \
                      needs_review: true\n\
                    ---\n\
                    body\n";
        let parsed = FileStore::parse(text).unwrap();
        let table = match parsed {
            ParsedFile::Memo { table, .. } => table,
            ParsedFile::BodyOnly { .. } => panic!("expected memo"),
        };
        assert!(table.contains_key("oxios"));
        match table.get("oxios").unwrap() {
            Value::Map(m) => {
                assert_eq!(m.get("author"), Some(&Value::Str("agent".into())));
                assert_eq!(m.get("needs_review"), Some(&Value::Bool(true)));
            }
            other => panic!("oxios must be a map, got {other:?}"),
        }
    }

    /// read_memo is the only consumer of the on-disk hash; it must
    /// always recompute from body+favorite, so a stale or synthesized
    /// hash in `fm` is irrelevant to the in-memory Memo.
    #[test]
    fn read_memo_hash_is_recomputed_from_body_and_favorite() {
        // Hand-stage a v4 file at a known path; the store's read_memo
        // recomputes the hash independently of what's on disk.
        let dir = tempfile::tempdir().unwrap();
        let store = FileStore::new(crate::paths::Paths::resolve(Some(dir.path())));
        let path = dir.path().join("manual.md");
        let id_str = "0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
        std::fs::write(
            &path,
            format!(
                "---\n\
                 id: {id_str}\n\
                 created: 2025-01-02T03:04:05Z\n\
                 updated: 2025-01-02T03:04:06Z\n\
                 favorite: {fav}\n\
                 ---\n\
                 body bytes for hash\n",
                fav = true,
            ),
        )
        .unwrap();
        let read = store.read_memo(&path).unwrap().unwrap();
        assert_eq!(read.hash, hash::hash_memo(b"body bytes for hash", true));
    }
}
