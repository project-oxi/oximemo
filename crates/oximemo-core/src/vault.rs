//! The [`Vault`] facade: the single entry point both the CLI and the Tauri app
//! use. It coordinates the file store (source of truth) with the derived redb +
//! tantivy indexes, guarded by a cross-process advisory lock (§5.7).
//!
//! # Concurrency model
//! redb guarantees a single in-process writer but nothing across processes.
//! We bracket every operation with an `fs2` flock on `meta.redb.lock`:
//! - **shared** for reads (multiple readers, including a CLI reading while the
//!   GUI runs),
//! - **exclusive** for writes.
//!
//! redb and tantivy are opened *transiently* within the lock scope, so no
//! process holds them open across the boundary — two processes never collide on
//! redb's or tantivy's own single-writer locks. This keeps the agent path
//! (`oximemo …` while the GUI is running) correct.

use std::path::{Path, PathBuf};
use std::time::Duration;

use time::OffsetDateTime;

use parking_lot::RwLock;

use crate::config::VaultConfig;
use crate::error::{CoreError, Result};
use crate::hash;
use crate::lock::{FileLock, LockKind, acquire};
use crate::memo::{
    Cursor, Facets, IndexStats, Memo, MemoFilter, MemoId, MemoSummary, Page, note_title,
    preview_of, searchable_body, tags_of,
};
use crate::paths::Paths;
use crate::store::files::FileStore;
use crate::store::index::{IndexRecord, MemoIndex, RedbIndex};
use crate::store::search::{SearchIndex, TantivySearch};
use crate::sync::{FullRecord, ManifestRecord};

/// How long to wait for the cross-process index lock before timing out (§5.7).
const LOCK_TIMEOUT: Duration = Duration::from_secs(5);

/// Indexed preview format version. Bump when `make_preview`'s output changes;
/// [`Vault::migrate`] reindexes once per bump so cached card previews are
/// regenerated. Stored in `<index_dir>/index-fmt`.
const INDEX_FORMAT_VERSION: u32 = 3;

pub struct Vault {
    paths: Paths,
    config: RwLock<VaultConfig>,
    files: FileStore,
}

impl Vault {
    /// Resolve a vault (default location when `vault` is `None`) and load its
    /// config. Does not create directories — call [`Self::ensure_initialized`]
    /// for that.
    pub fn open(vault: Option<&Path>) -> Result<Self> {
        let paths = Paths::resolve(vault);
        let config = VaultConfig::load(&paths);
        let files = FileStore::new(paths.clone());
        Ok(Self {
            paths,
            config: RwLock::new(config),
            files,
        })
    }

    /// Read config under a read guard.
    pub fn with_config<R>(&self, f: impl FnOnce(&VaultConfig) -> R) -> R {
        f(&self.config.read())
    }

    /// Snapshot of the current folder list (cloned under the read guard).
    pub fn folders(&self) -> Vec<crate::config::FolderDef> {
        self.config.read().folders.items.clone()
    }

    /// Create a physical folder (mkdir -p). No-op if it already exists.
    pub fn create_folder(&self, path: &str) -> Result<()> {
        let dir = if path.is_empty() {
            self.paths.vault.clone()
        } else {
            self.paths.vault.join(path)
        };
        std::fs::create_dir_all(&dir)?;
        Ok(())
    }

    /// Delete a physical folder. Fails if it contains notes.
    pub fn delete_folder(&self, path: &str) -> Result<()> {
        if path.is_empty() {
            return Err(CoreError::other("cannot delete vault root"));
        }
        let dir = self.paths.vault.join(path);
        if !dir.exists() {
            return Err(CoreError::other(format!("folder '{path}' not found")));
        }
        let has_notes = std::fs::read_dir(&dir)
            .ok()
            .into_iter()
            .flatten()
            .flatten()
            .any(|e| {
                e.file_name().to_string_lossy().ends_with(".md")
                    && e.file_name().to_string_lossy() != crate::paths::TEMPLATE_NAME
            });
        if has_notes {
            return Err(CoreError::other(format!("folder '{path}' is not empty")));
        }
        std::fs::remove_dir_all(&dir)?;
        Ok(())
    }
    /// Rename/move a folder tree. Disk rename first (atomic, preserves
    /// templates and subfolders), then index records under the old prefix
    /// are rewritten (best-effort; the watcher repairs any stragglers),
    /// then config folder entries are re-pathed.
    pub fn rename_folder(&self, from: &str, to: &str) -> Result<()> {
        if from.is_empty() {
            return Err(CoreError::other("cannot rename vault root"));
        }
        if to.is_empty() {
            return Err(CoreError::other("rename target must not be empty"));
        }
        if from == to {
            return Err(CoreError::other("rename target is the same as source"));
        }
        let from_dir = self.paths.vault.join(from);
        let to_dir = self.paths.vault.join(to);
        if !from_dir.is_dir() {
            return Err(CoreError::NotFound(from.to_string()));
        }
        if to_dir.exists() {
            return Err(CoreError::other(format!("folder '{to}' already exists")));
        }
        if let Some(parent) = to_dir.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::rename(&from_dir, &to_dir)?;
        // Re-path index records under `from/`. Live notes: read the file at
        // its new on-disk location and re-upsert the record + search entry
        // so the search index keeps the up-to-date body and title.
        // Tombstones (soft-deleted within retention): their file lives in
        // `.trash/` while the record keeps its ORIGINAL `from/...` path —
        // re-path the record-only without a file read or search upsert.
        // A tombstone must never keep referencing `from/...` after the
        // disk tree moved, and a tombstone re-path is not a failure.
        let prefix = format!("{from}/");
        let recs = self.with_redb(|idx| idx.export_since(None))?;
        let mut index_failures: u32 = 0;
        for r in recs {
            if !r.path.starts_with(&prefix) {
                continue;
            }
            let new_rel = format!("{to}/{}", &r.path[prefix.len()..]);
            if r.deleted {
                let mut rec2 = r.clone();
                rec2.path = new_rel;
                if self.with_redb(|idx| idx.upsert(&rec2)).is_err() {
                    index_failures += 1;
                }
                continue;
            }
            let stripped = &r.path[prefix.len()..];
            match self.files.read_memo(&to_dir.join(stripped)) {
                Ok(Some(note)) => {
                    let fmt = crate::memo::NoteFormat::from_rel(&new_rel);
                    let (sbody, stitle) = search_fields(fmt, &note);
                    let mut rec2 = r.clone();
                    rec2.path = new_rel;
                    if self
                        .with_redb_and_search(|idx, search| {
                            idx.upsert(&rec2)?;
                            search.upsert(note.id, &sbody, stitle.as_deref(), &note.tags)
                        })
                        .is_err()
                    {
                        index_failures += 1;
                    }
                }
                _ => {
                    index_failures += 1;
                }
            }
        }

        // Re-path config entries under `from/`. Exact match on `from` keeps
        // the same `FolderDef` (preserving view/color/pin); prefix matches
        // are rewritten by stripping and re-attaching the new prefix.
        {
            let mut cfg = self.config.write();
            let fp = format!("{from}/");
            for f in cfg.folders.items.iter_mut() {
                if f.path == from {
                    f.path = to.to_string();
                } else if f.path.starts_with(&fp) {
                    f.path = format!("{to}/{}", &f.path[fp.len()..]);
                }
            }
            cfg.save(&self.paths)?;
        }

        if index_failures > 0 {
            return Err(CoreError::other(format!(
                "folder renamed on disk but {index_failures} index entries need reindex"
            )));
        }
        Ok(())
    }

    /// List the folder tree as a flat list of `(path, note_count)`.
    ///
    /// Includes physical directories with zero notes (they exist on disk but
    /// no file row references them), so the UI can list and manage folders
    /// the user just created. The vault root itself is never an entry.
    pub fn list_folders(&self) -> Result<Vec<(String, u32)>> {
        let mut counts: std::collections::BTreeMap<String, u32> = Default::default();
        for path in self.files.scan() {
            if let Some(rel) = self.paths.relative_path(&path) {
                let folder = rel.rfind('/').map(|i| &rel[..i]).unwrap_or("");
                *counts.entry(folder.to_string()).or_insert(0) += 1;
            }
        }
        collect_folder_dirs(&self.paths.vault, "", &mut counts);
        Ok(counts.into_iter().collect())
    }

    /// Folder cards for one browse level: deep counts (reverse-sorted
    /// prefix summation over `list_folders`), direct subfolder counts, and
    /// up to 3 recent note titles attributed to the nearest displayed
    /// ancestor (index scan, early exit).
    pub fn folder_children(&self, parent: &str) -> Result<Vec<FolderCard>> {
        let all = self.list_folders()?; // BTree-sorted (path, immediate)
        let prefix = if parent.is_empty() {
            String::new()
        } else {
            format!("{parent}/")
        };
        let is_child =
            |p: &str| !p.is_empty() && p.starts_with(&prefix) && !p[prefix.len()..].contains('/');
        let kids: Vec<&String> = all.iter().map(|(p, _)| p).filter(|p| is_child(p)).collect();

        // Deep counts: reverse iteration guarantees children finalize first.
        let mut deep: std::collections::BTreeMap<String, u32> = all.iter().cloned().collect();
        for (p, _) in all.iter().rev() {
            if let Some(i) = p.rfind('/') {
                let d = deep[p];
                *deep.entry(p[..i].to_string()).or_insert(0) += d;
            }
        }

        let subfolder_count = |kid: &str| {
            let kp = format!("{kid}/");
            all.iter()
                .filter(|(p, _)| p.starts_with(&kp) && !p[kp.len()..].contains('/'))
                .count() as u32
        };

        // Recents from the newest-first index: walk each note's path up
        // until it lands on a kid, capping the per-kid sample at
        // min(3, its deep count) so empty / small folders finalize cleanly.
        let recs = self.with_redb(|idx| idx.export_since(None))?;
        let mut recent: Vec<(String, Vec<FolderRecent>)> =
            kids.iter().map(|k| ((*k).clone(), Vec::new())).collect();
        let target: Vec<usize> = kids
            .iter()
            .enumerate()
            .filter(|(_, k)| deep[k.as_str()] > 0)
            .map(|(i, _)| i)
            .collect();
        let mut done = 0usize;
        'scan: for r in recs.iter().filter(|r| !r.deleted) {
            if done == target.len() {
                break;
            }
            let mut probe = match r.path.rfind('/') {
                Some(i) => &r.path[..i],
                None => "",
            };
            loop {
                if let Some(slot) = recent.iter_mut().find(|(p, _)| p == probe) {
                    let cap = 3u32.min(deep[slot.0.as_str()]);
                    if (slot.1.len() as u32) < cap {
                        slot.1.push(FolderRecent {
                            id: r.id,
                            title: r.title.clone(),
                            updated_at: r.updated_at,
                        });
                        if slot.1.len() as u32 == cap {
                            done += 1;
                        }
                    }
                    continue 'scan;
                }
                match probe.rfind('/') {
                    Some(i) => probe = &probe[..i],
                    None => continue 'scan,
                }
            }
        }

        Ok(kids
            .iter()
            .map(|k| FolderCard {
                path: (*k).clone(),
                note_count: all
                    .iter()
                    .find(|(p, _)| p == *k)
                    .map(|(_, n)| *n)
                    .unwrap_or(0),
                note_count_deep: deep[k.as_str()],
                subfolder_count: subfolder_count(k),
                recent: recent
                    .iter()
                    .find(|(p, _)| p == *k)
                    .map(|(_, v)| v.clone())
                    .unwrap_or_default(),
            })
            .collect())
    }

    pub fn paths(&self) -> &Paths {
        &self.paths
    }

    /// Create the vault + index directories if missing.
    pub fn ensure_initialized(&self) -> Result<()> {
        std::fs::create_dir_all(&self.paths.vault)?;
        std::fs::create_dir_all(self.paths.trash_root())?;
        std::fs::create_dir_all(self.paths.assets_root())?;
        std::fs::create_dir_all(&self.paths.index_dir)?;
        Ok(())
    }

    // -- assets ----------------------------------------------------------

    /// Persist raw image bytes as a content-addressed asset and return the
    /// `oximg://` reference to drop into markdown. Identical bytes dedup to
    /// the same file (no rewrite). `ext` is normalized + whitelisted.
    pub fn save_asset(&self, bytes: &[u8], ext: &str) -> Result<crate::assets::AssetRef> {
        self.ensure_initialized()?;
        let ext = crate::assets::normalize_ext(ext)?;
        let name = crate::assets::asset_name(bytes, ext);
        let path = self.paths.asset_path(&name);
        if !path.exists() {
            // Atomic write like memo files: temp + rename.
            let tmp = path.with_extension("tmp");
            std::fs::write(&tmp, bytes)?;
            std::fs::rename(&tmp, &path)?;
        }
        Ok(crate::assets::AssetRef {
            url: format!("oximg://localhost/{name}"),
            name,
        })
    }

    /// Read an image from an arbitrary path (file-picker) and store it. The
    /// extension is taken from the source filename.
    pub fn save_asset_from_path(&self, src: &Path) -> Result<crate::assets::AssetRef> {
        let ext = src
            .extension()
            .and_then(|e| e.to_str())
            .ok_or_else(|| CoreError::AssetRejected("source has no extension".into()))?;
        let bytes = std::fs::read(src)?;
        self.save_asset(&bytes, ext)
    }

    /// Serve an asset's bytes + content-type for the `oximg://` handler.
    /// Returns `None` if the name is malformed or the file is absent.
    pub fn read_asset(&self, name: &str) -> Option<(Vec<u8>, &'static str)> {
        if !crate::assets::valid_name(name) {
            return None;
        }
        let ext = crate::assets::ext_of(name)?;
        let path = self.paths.asset_path(name);
        std::fs::read(&path)
            .ok()
            .map(|b| (b, crate::assets::mime_for_ext(ext)))
    }

    /// All assets on disk, newest-first (gallery). Cheap: a single dir read.
    pub fn list_assets(&self) -> Result<Vec<crate::assets::AssetInfo>> {
        use crate::assets::{AssetInfo, valid_name};
        let root = self.paths.assets_root();
        if !root.exists() {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&root)? {
            let entry = entry?;
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if !valid_name(&name) {
                continue;
            }
            let meta = entry.metadata()?;
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| {
                    OffsetDateTime::from_unix_timestamp(d.as_secs() as i64)
                        .unwrap_or_else(|_| OffsetDateTime::now_utc())
                })
                .unwrap_or_else(OffsetDateTime::now_utc);
            let ext = crate::assets::ext_of(&name).unwrap_or("").to_string();
            out.push(AssetInfo {
                url: format!("oximg://localhost/{name}"),
                name,
                ext,
                bytes: meta.len(),
                modified,
            });
        }
        out.sort_by_key(|b| std::cmp::Reverse(b.modified));
        Ok(out)
    }

    /// Delete assets referenced by no live memo. Returns the count removed.
    /// Scans every memo body, so call from an explicit user action (gallery
    /// "clean up"), not a hot path.
    pub fn gc_assets(&self) -> Result<u64> {
        let live = self.asset_refs_in_bodies()?;
        let root = self.paths.assets_root();
        if !root.exists() {
            return Ok(0);
        }
        let mut removed = 0u64;
        for entry in std::fs::read_dir(&root)? {
            let entry = entry?;
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if !crate::assets::valid_name(&name) || live.contains(&name) {
                continue;
            }
            if std::fs::remove_file(entry.path()).is_ok() {
                removed += 1;
            }
        }
        Ok(removed)
    }

    /// Collect every `oximg://<name>` referenced across all live memo bodies.
    fn asset_refs_in_bodies(&self) -> Result<std::collections::HashSet<String>> {
        let mut live = std::collections::HashSet::new();
        for path in self.files.list_memo_files() {
            match self.files.read_memo(&path) {
                Ok(Some(parsed)) => {
                    for name in crate::assets::refs_in_body(&parsed.body) {
                        live.insert(name);
                    }
                }
                Ok(None) => {}
                Err(e) => tracing::warn!(
                    path = %path.display(),
                    error = %e,
                    "gc: skipping unparseable memo; its image refs are not counted"
                ),
            }
        }
        Ok(live)
    }

    /// First live memo whose body references asset `name`, or `None`. Powers
    /// the gallery's "open the memo containing this image".
    pub fn find_memo_by_asset(&self, name: &str) -> Result<Option<MemoId>> {
        for path in self.files.list_memo_files() {
            match self.files.read_memo(&path) {
                Ok(Some(parsed)) if crate::assets::refs_in_body(&parsed.body).contains(name) => {
                    return Ok(Some(parsed.id));
                }
                _ => {}
            }
        }
        Ok(None)
    }

    // -- locking helpers --------------------------------------------------

    fn lock(&self, kind: LockKind) -> Result<FileLock> {
        acquire(&self.paths.meta_lock_path(), kind, LOCK_TIMEOUT)
    }

    /// Shared lock + transient redb, for a read operation.
    fn with_redb<R>(&self, f: impl FnOnce(&RedbIndex) -> Result<R>) -> Result<R> {
        let _g = self.lock(LockKind::Shared)?;
        let idx = RedbIndex::open(&self.paths.meta_db_path())?;
        f(&idx)
    }

    /// Exclusive lock + transient redb & tantivy, for a mutating operation.
    fn with_redb_and_search<R>(
        &self,
        f: impl FnOnce(&RedbIndex, &TantivySearch) -> Result<R>,
    ) -> Result<R> {
        let _g = self.lock(LockKind::Exclusive)?;
        let idx = RedbIndex::open(&self.paths.meta_db_path())?;
        let search = TantivySearch::open(&self.paths.search_dir())?;
        f(&idx, &search)
    }

    // -- CRUD -------------------------------------------------------------

    /// Create a note in `folder` (empty = vault root) in the given format.
    /// The filename is derived from the body's title (H1 for markdown,
    /// `<h1>`/`<title>` for html), or a timestamp if untitled.
    pub fn create_note(
        &self,
        folder: &str,
        body: String,
        fmt: crate::memo::NoteFormat,
    ) -> Result<Memo> {
        self.ensure_initialized()?;
        // Apply template if body is blank and a matching TEMPLATE exists.
        let body = if crate::template::is_blank_body(fmt, &body) {
            if let Some(tmpl) = crate::template::load_template(&self.paths, folder, fmt) {
                let counter = crate::template::count_notes(&self.paths, folder) + 1;
                let ctx = crate::template::TemplateCtx::now(folder, counter);
                crate::template::apply_template(&tmpl, &ctx)
            } else {
                body
            }
        } else {
            body
        };
        let tags = tags_of(fmt, &body);
        validate_note_input(&body, &tags)?;
        let now = OffsetDateTime::now_utc();
        let id = MemoId::now();
        let note = Memo {
            id,
            created_at: now,
            updated_at: now,
            hash: hash::hash_memo(body.as_bytes(), false),
            favorite: false,
            tags,
            body,
            deleted_at: None,
        };
        let path = self.files.write_note(folder, &note, fmt)?;
        let rel = self.paths.relative_path(&path).unwrap_or_default();
        let (sbody, stitle) = search_fields(fmt, &note);
        self.with_redb_and_search(|idx, search| {
            idx.upsert(&record_of(&note, &rel))?;
            search.upsert(note.id, &sbody, stitle.as_deref(), &note.tags)
        })?;
        Ok(note)
    }

    /// Create a note whose format follows the folder's templates: a folder
    /// with `TEMPLATE.html` but no `TEMPLATE.md` produces html notes;
    /// everything else defaults to markdown (spec §D8).
    pub fn create_note_auto(&self, folder: &str, body: String) -> Result<Memo> {
        let fmt =
            if crate::template::load_template(&self.paths, folder, crate::memo::NoteFormat::Html)
                .is_some()
                && crate::template::load_template(
                    &self.paths,
                    folder,
                    crate::memo::NoteFormat::Markdown,
                )
                .is_none()
            {
                crate::memo::NoteFormat::Html
            } else {
                crate::memo::NoteFormat::Markdown
            };
        self.create_note(folder, body, fmt)
    }

    /// Backward-compat alias: create a markdown note at vault root.
    pub fn create_memo(&self, body: String, _category: Option<String>) -> Result<Memo> {
        self.create_note("", body, crate::memo::NoteFormat::Markdown)
    }

    /// Read a note by id. Uses the index to locate the file path; falls back
    /// to a vault scan if the index is stale.
    pub fn get_memo(&self, id: MemoId) -> Result<Memo> {
        // Try the index for the path.
        if let Some(rec) = self.with_redb(|idx| idx.get(id))? {
            let abs = self.paths.vault.join(&rec.path);
            if abs.exists() {
                return self
                    .files
                    .read_memo(&abs)?
                    .ok_or_else(|| CoreError::NotFound(id.to_string()));
            }
            // Maybe in trash.
            let trash = self.paths.trash_path(&rec.path);
            if trash.exists() {
                return self
                    .files
                    .read_memo(&trash)?
                    .ok_or_else(|| CoreError::NotFound(id.to_string()));
            }
        }
        // Index miss: scan the vault.
        for path in self
            .files
            .scan()
            .iter()
            .chain(self.files.scan_trash().iter())
        {
            if let Ok(Some(n)) = self.files.read_memo(path)
                && n.id == id
            {
                return Ok(n);
            }
        }
        Err(CoreError::NotFound(id.to_string()))
    }
    /// Update a note's body and/or favorite flag. If the note's title changes,
    /// the file is renamed to match the new title (format preserved).
    pub fn update_note(
        &self,
        id: MemoId,
        body: Option<String>,
        favorite: Option<bool>,
    ) -> Result<Memo> {
        let mut note = self.get_memo(id)?;
        // Determine the note's format from its indexed path (empty fallback
        // = markdown, matching NoteFormat::from_rel).
        let rec = self.with_redb(|idx| idx.get(id))?;
        let old_rel = rec.as_ref().map(|r| r.path.clone()).unwrap_or_default();
        let fmt = crate::memo::NoteFormat::from_rel(&old_rel);

        let old_title = note_title(fmt, &note.body);
        if let Some(b) = body {
            note.body = b;
            note.tags = tags_of(fmt, &note.body);
        }
        if let Some(p) = favorite {
            note.favorite = p;
        }
        validate_note_input(&note.body, &note.tags)?;
        note.updated_at = OffsetDateTime::now_utc();
        note.hash = hash::hash_memo(note.body.as_bytes(), note.favorite);

        let old_path = self.paths.vault.join(&old_rel);

        // If the title changed (or old path doesn't exist), compute new path.
        let new_title = note_title(fmt, &note.body);
        let needs_rename = old_title != new_title && old_path.exists();

        if needs_rename {
            // Derive new filename and folder from old path.
            let folder = old_rel.rfind('/').map(|i| &old_rel[..i]).unwrap_or("");
            let new_path = self.files.write_note(folder, &note, fmt)?;
            // Remove the old file if it differs.
            if new_path != old_path && old_path.exists() {
                std::fs::remove_file(&old_path)?;
            }
            let new_rel = self.paths.relative_path(&new_path).unwrap_or_default();
            let (sbody, stitle) = search_fields(fmt, &note);
            self.with_redb_and_search(|idx, search| {
                idx.upsert(&record_of(&note, &new_rel))?;
                search.upsert(note.id, &sbody, stitle.as_deref(), &note.tags)
            })?;
        } else {
            // Write in place at the existing path.
            if !old_path.exists() {
                // No known path — write to root.
                let p = self.files.write_note("", &note, fmt)?;
                let rel = self.paths.relative_path(&p).unwrap_or_default();
                let (sbody, stitle) = search_fields(fmt, &note);
                self.with_redb_and_search(|idx, search| {
                    idx.upsert(&record_of(&note, &rel))?;
                    search.upsert(note.id, &sbody, stitle.as_deref(), &note.tags)
                })?;
            } else {
                let text = FileStore::serialize_as(&note, fmt)?;
                std::fs::write(&old_path, text.as_bytes())?;
                let (sbody, stitle) = search_fields(fmt, &note);
                self.with_redb_and_search(|idx, search| {
                    idx.upsert(&record_of(&note, &old_rel))?;
                    search.upsert(note.id, &sbody, stitle.as_deref(), &note.tags)
                })?;
            }
        }

        // Rename propagation (§4.4): rewrite [[old title]] → [[new title]]
        // in every other note that references it. Only when both titles exist.
        if needs_rename && old_title.is_some() && new_title.is_some() {
            let old = old_title.as_deref().unwrap();
            let new = new_title.as_deref().unwrap();
            let recs = self.with_redb(|idx| idx.export_since(None))?;
            let mut updates: Vec<(Memo, String)> = Vec::new();
            for r in &recs {
                if r.deleted || r.id == id {
                    continue;
                }
                let src_fmt = crate::memo::NoteFormat::from_rel(&r.path);
                let abs = self.paths.vault.join(&r.path);
                let Ok(Some(src)) = self.files.read_memo(&abs) else {
                    continue;
                };
                if crate::wiki::links_to(link_scan_body(src_fmt, &src.body).as_ref(), old) {
                    let rewritten = crate::wiki::replace_link_target(&src.body, old, new);
                    let mut updated = src.clone();
                    updated.body = rewritten;
                    updated.tags = tags_of(src_fmt, &updated.body);
                    updated.updated_at = OffsetDateTime::now_utc();
                    updated.hash = hash::hash_memo(updated.body.as_bytes(), updated.favorite);
                    let text = FileStore::serialize_as(&updated, src_fmt)?;
                    std::fs::write(&abs, text.as_bytes())?;
                    updates.push((updated, r.path.clone()));
                }
            }
            if !updates.is_empty() {
                self.with_redb_and_search(|idx, search| {
                    for (n, p) in &updates {
                        idx.upsert(&record_of(n, p))?;
                        let (sbody, stitle) =
                            search_fields(crate::memo::NoteFormat::from_rel(p), n);
                        search.upsert(n.id, &sbody, stitle.as_deref(), &n.tags)?;
                    }
                    Ok(())
                })?;
            }
        }
        Ok(note)
    }

    /// Backward-compat wrapper (category ignored).
    pub fn update_memo(
        &self,
        id: MemoId,
        body: Option<String>,
        favorite: Option<bool>,
        _category: Option<String>,
    ) -> Result<Memo> {
        self.update_note(id, body, favorite)
    }

    /// Soft-delete: move to trash, mark tombstone, drop from search.
    pub fn delete_memo(&self, id: MemoId) -> Result<()> {
        let mut note = self.get_memo(id)?;
        let rec = self.with_redb(|idx| idx.get(id))?;
        let rel = rec.as_ref().map(|r| r.path.clone()).unwrap_or_default();
        let fmt = crate::memo::NoteFormat::from_rel(&rel);
        let now = OffsetDateTime::now_utc();
        note.deleted_at = Some(now);
        note.updated_at = now;
        note.hash = hash::hash_memo(note.body.as_bytes(), note.favorite);
        // Move file to trash (preserving structure).
        if !rel.is_empty() {
            self.files.move_to_trash(&rel)?;
            // Write the tombstone version into trash.
            let trash_abs = self.paths.trash_path(&rel);
            if let Some(parent) = trash_abs.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let text = FileStore::serialize_as(&note, fmt)?;
            std::fs::write(&trash_abs, text.as_bytes())?;
        }
        self.with_redb_and_search(|idx, search| {
            idx.upsert(&record_of(&note, &rel))?;
            search.remove(note.id)
        })?;
        Ok(())
    }

    pub fn restore_memo(&self, id: MemoId) -> Result<Memo> {
        let mut note = self.get_memo(id)?;
        let rec = self.with_redb(|idx| idx.get(id))?;
        let rel = rec.as_ref().map(|r| r.path.clone()).unwrap_or_default();
        let fmt = crate::memo::NoteFormat::from_rel(&rel);
        note.deleted_at = None;
        note.updated_at = OffsetDateTime::now_utc();
        note.hash = hash::hash_memo(note.body.as_bytes(), note.favorite);
        if !rel.is_empty() {
            self.files.restore_from_trash(&rel)?;
            // Write the restored note with deleted_at cleared.
            let abs = self.paths.vault.join(&rel);
            if let Some(parent) = abs.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let text = FileStore::serialize_as(&note, fmt)?;
            std::fs::write(&abs, text.as_bytes())?;
        }
        let (sbody, stitle) = search_fields(fmt, &note);
        self.with_redb_and_search(|idx, search| {
            idx.upsert(&record_of(&note, &rel))?;
            search.upsert(note.id, &sbody, stitle.as_deref(), &note.tags)
        })?;
        Ok(note)
    }

    /// Hard-delete trashed notes whose `deleted_at` is older than `retention`.
    pub fn purge(&self, retention: Duration) -> Result<u64> {
        let cutoff = OffsetDateTime::now_utc() - retention;
        let mut purged = 0u64;
        self.with_redb_and_search(|idx, search| {
            for path in self.files.scan_trash() {
                let Ok(Some(n)) = self.files.read_memo(&path) else {
                    continue;
                };
                if n.deleted_at.is_some_and(|t| t < cutoff) {
                    if let Some(rel) = self.paths.relative_path(&path) {
                        let trash_rel = rel.strip_prefix(".trash/").unwrap_or(&rel).to_string();
                        self.files.purge(&trash_rel)?;
                    } else {
                        std::fs::remove_file(&path)?;
                    }
                    idx.remove(n.id)?;
                    search.remove(n.id)?;
                    purged += 1;
                }
            }
            Ok(())
        })?;
        Ok(purged)
    }

    // -- queries ----------------------------------------------------------

    pub fn list_memos(
        &self,
        after: Option<Cursor>,
        limit: u32,
        filter: MemoFilter,
    ) -> Result<Page<MemoSummary>> {
        self.with_redb(|idx| {
            let recs = idx.list(after, limit, &filter)?;
            let items: Vec<MemoSummary> = recs.iter().map(|r| r.to_summary()).collect();
            let next_cursor = items.last().and_then(|s| {
                serde_json::to_string(&Cursor {
                    updated_at: s.updated_at,
                    id: s.id,
                })
                .ok()
            });
            Ok(Page { items, next_cursor })
        })
    }

    pub fn search_memos(&self, query: &str, limit: u32) -> Result<Vec<MemoSummary>> {
        let _g = self.lock(LockKind::Shared)?;
        let search = TantivySearch::open(&self.paths.search_dir())?;
        let idx = RedbIndex::open(&self.paths.meta_db_path())?;
        let ids = search.search(query, limit)?;
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(r) = idx.get(id)? {
                if r.deleted {
                    continue;
                }
                out.push(r.to_summary());
            }
        }
        Ok(out)
    }

    pub fn get_note_summary(&self, id: MemoId) -> Result<MemoSummary> {
        self.with_redb(|idx| match idx.get(id)? {
            Some(r) => Ok(r.to_summary()),
            None => Err(CoreError::NotFound(id.to_string())),
        })
    }

    /// Live note counts (soft-deleted tombstones excluded).
    pub fn memo_stats(&self) -> Result<crate::memo::MemoStats> {
        self.with_redb(|idx| {
            let recs = idx.export_since(None)?;
            let mut stats = crate::memo::MemoStats::default();
            for r in &recs {
                if r.deleted {
                    continue;
                }
                stats.memos += 1;
                if r.favorite {
                    stats.favorites += 1;
                }
            }
            Ok(stats)
        })
    }

    /// Full-note DTO (memo + placement) for the desktop API. The path comes
    /// from the index record; falls back to an empty path when the note has
    /// not been indexed yet (callers upsert before requesting).
    pub fn note_dto(&self, memo: &Memo) -> crate::memo::NoteDto {
        let rel = self
            .with_redb(|idx| idx.get(memo.id))
            .ok()
            .flatten()
            .map(|r| r.path)
            .unwrap_or_default();
        crate::memo::NoteDto::from_memo(memo, &rel)
    }

    /// Tag + color counts over live (non-deleted) notes for the sidebar (§4.2).
    pub fn list_facets(&self) -> Result<Facets> {
        self.with_redb(|idx| {
            let recs = idx.export_since(None)?;
            let mut tag_map: std::collections::BTreeMap<String, u32> = Default::default();
            let mut folder_map: std::collections::BTreeMap<String, u32> = Default::default();
            for r in &recs {
                if r.deleted {
                    continue;
                }
                for t in &r.tags {
                    *tag_map.entry(t.clone()).or_insert(0) += 1;
                }
                let folder = r.path.rfind('/').map(|i| &r.path[..i]).unwrap_or("");
                *folder_map.entry(folder.to_string()).or_insert(0) += 1;
            }
            Ok(Facets {
                tags: tag_map.into_iter().collect(),
                folders: folder_map.into_iter().collect(),
            })
        })
    }

    // -- graph + config (§6 graph view, §6.3 folder views) ---------------

    /// Build the wiki-link graph: nodes = live notes, edges = `[[...]]` links.
    /// Resolves link targets by title (case-insensitive). No self-loops.
    pub fn graph_data(&self) -> Result<GraphData> {
        let recs = self.with_redb(|idx| idx.export_since(None))?;
        let live: Vec<&IndexRecord> = recs.iter().filter(|r| !r.deleted).collect();

        // Title → id map (case-insensitive, first wins).
        let mut title_map: std::collections::HashMap<String, MemoId> = Default::default();
        for r in &live {
            if let Some(ref t) = r.title {
                title_map.entry(t.trim().to_lowercase()).or_insert(r.id);
            }
        }

        let config_items = self.config.read().folders.items.clone();
        let mut nodes = Vec::with_capacity(live.len());
        let mut edges = Vec::new();
        let mut conn: std::collections::HashMap<String, u32> = Default::default();

        for r in &live {
            let abs = self.paths.vault.join(&r.path);
            let body = match self.files.read_memo(&abs) {
                Ok(Some(n)) => n.body,
                _ => continue,
            };
            let folder = r.path.rfind('/').map(|i| &r.path[..i]).unwrap_or("");
            let color =
                crate::config::resolve_folder_color(folder, &config_items).unwrap_or_default();

            let fmt = crate::memo::NoteFormat::from_rel(&r.path);
            for link in crate::wiki::extract_links(link_scan_body(fmt, &body).as_ref()) {
                let key = link.target.trim().to_lowercase();
                if let Some(&tgt) = title_map.get(&key)
                    && tgt != r.id
                {
                    edges.push(GraphEdge {
                        source: r.id.to_string(),
                        target: tgt.to_string(),
                    });
                    *conn.entry(r.id.to_string()).or_insert(0) += 1;
                }
            }

            nodes.push(GraphNode {
                id: r.id.to_string(),
                title: r.title.clone().unwrap_or_else(|| "Untitled".to_string()),
                folder: folder.to_string(),
                connections: 0, // filled below
                color,
            });
        }

        // Fill connection counts now that all edges are counted.
        for n in &mut nodes {
            n.connections = *conn.get(&n.id).unwrap_or(&0);
        }

        Ok(GraphData { nodes, edges })
    }

    /// Serialize config as JSON with `folders` flattened to a plain array
    /// (matching the frontend `Config` type).
    pub fn config_json(&self) -> serde_json::Value {
        self.config.read().config_json()
    }

    /// Lock (or unlock) a folder's default view mode, persisted to
    /// `oximemo.toml`.
    pub fn set_folder_view(&self, path: &str, view: Option<crate::config::ViewMode>) -> Result<()> {
        let mut cfg = self.config.write();
        match view {
            Some(v) => {
                if let Some(f) = cfg.folders.items.iter_mut().find(|f| f.path == path) {
                    f.view = Some(v);
                } else {
                    cfg.folders.items.push(crate::config::FolderDef {
                        path: path.to_string(),
                        view: Some(v),
                        color: None,
                        pinned: None,
                    });
                }
            }
            None => {
                if let Some(f) = cfg.folders.items.iter_mut().find(|f| f.path == path) {
                    f.view = None;
                    // Drop the entry if it has no color or pin either (clean config).
                    if f.color.is_none() && f.pinned.is_none() {
                        cfg.folders.items.retain(|f| f.path != path);
                    }
                }
            }
        }
        cfg.save(&self.paths)?;
        Ok(())
    }

    /// Pin/unpin a folder to the sidebar favorites, persisted to `oximemo.toml`.
    pub fn set_folder_pinned(&self, path: &str, pinned: bool) -> Result<()> {
        let mut cfg = self.config.write();
        if pinned {
            if let Some(f) = cfg.folders.items.iter_mut().find(|f| f.path == path) {
                f.pinned = Some(true);
            } else {
                cfg.folders.items.push(crate::config::FolderDef {
                    path: path.to_string(),
                    view: None,
                    color: None,
                    pinned: Some(true),
                });
            }
        } else if let Some(f) = cfg.folders.items.iter_mut().find(|f| f.path == path) {
            f.pinned = None;
            if f.view.is_none() && f.color.is_none() {
                cfg.folders.items.retain(|f| f.path != path);
            }
        }
        cfg.save(&self.paths)?;
        Ok(())
    }

    /// Replace an entire config section and persist to `oximemo.toml`.
    /// Section-granular (not per-field) on purpose: the TOML file is
    /// section-shaped and the settings UI edits whole sections.
    fn replace_section<T>(&self, set: impl FnOnce(&mut VaultConfig, T), value: T) -> Result<()> {
        let mut cfg = self.config.write();
        set(&mut cfg, value);
        cfg.save(&self.paths)?;
        Ok(())
    }

    /// `[brain]` — oxibrain daemon connection settings.
    pub fn set_brain_config(&self, v: crate::config::BrainConfig) -> Result<()> {
        self.replace_section(|c, v| c.brain = v, v)
    }

    /// `[general]` — trash retention and future behavior knobs.
    pub fn set_general_config(&self, v: crate::config::GeneralConfig) -> Result<()> {
        self.replace_section(|c, v| c.general = v, v)
    }

    /// `[capture]` — overlay and trigger tuning.
    pub fn set_capture_config(&self, v: crate::config::CaptureConfig) -> Result<()> {
        self.replace_section(|c, v| c.capture = v, v)
    }

    /// `[appearance]` — theme and dock visibility.
    pub fn set_appearance_config(&self, v: crate::config::AppearanceConfig) -> Result<()> {
        self.replace_section(|c, v| c.appearance = v, v)
    }

    /// `[index]` — vault watcher tuning.
    pub fn set_index_config(&self, v: crate::config::IndexConfig) -> Result<()> {
        self.replace_section(|c, v| c.index = v, v)
    }

    /// Move a note to a different folder. Renames the file to
    /// `<new_folder>/<title-slug><ext>` (format preserved) and updates the
    /// index path.
    pub fn move_note(&self, id: MemoId, new_folder: &str) -> Result<Memo> {
        let note = self.get_memo(id)?;
        let rec = self.with_redb(|idx| idx.get(id))?;
        let old_rel = rec.as_ref().map(|r| r.path.clone()).unwrap_or_default();
        let fmt = crate::memo::NoteFormat::from_rel(&old_rel);
        let old_path = self.paths.vault.join(&old_rel);

        if !old_path.exists() {
            return Err(CoreError::other("note file not found; cannot move"));
        }

        // Write to the new folder (derives filename from title).
        let new_path = self.files.write_note(new_folder, &note, fmt)?;

        // Remove old file if the path changed.
        if new_path != old_path && old_path.exists() {
            std::fs::remove_file(&old_path)?;
        }

        let new_rel = self.paths.relative_path(&new_path).unwrap_or_default();
        let (sbody, stitle) = search_fields(fmt, &note);
        self.with_redb_and_search(|idx, search| {
            idx.upsert(&record_of(&note, &new_rel))?;
            search.upsert(note.id, &sbody, stitle.as_deref(), &note.tags)
        })?;
        Ok(note)
    }

    /// Find all live notes whose body links to the target note (by title).
    /// Returns source note id, title, and preview for each backlink.
    pub fn get_backlinks(&self, id: MemoId) -> Result<Vec<BacklinkInfo>> {
        let recs = self.with_redb(|idx| idx.export_since(None))?;
        // Get the target note's title.
        let target_title = recs
            .iter()
            .find(|r| r.id == id && !r.deleted)
            .and_then(|r| r.title.as_deref())
            .ok_or_else(|| CoreError::NotFound(id.to_string()))?
            .to_string();

        let mut out = Vec::new();
        for r in &recs {
            if r.deleted || r.id == id {
                continue;
            }
            let abs = self.paths.vault.join(&r.path);
            let body = match self.files.read_memo(&abs) {
                Ok(Some(n)) => n.body,
                _ => continue,
            };
            let src_fmt = crate::memo::NoteFormat::from_rel(&r.path);
            if crate::wiki::links_to(link_scan_body(src_fmt, &body).as_ref(), &target_title) {
                out.push(BacklinkInfo {
                    id: r.id.to_string(),
                    title: r.title.clone().unwrap_or_else(|| "Untitled".to_string()),
                    preview: preview_of(src_fmt, &body),
                });
            }
        }
        Ok(out)
    }

    // -- sync / export (§9.2) --------------------------------------------

    pub fn export_manifest(&self, since: Option<OffsetDateTime>) -> Result<Vec<ManifestRecord>> {
        self.with_redb(|idx| {
            let recs = idx.export_since(since)?;
            Ok(recs
                .iter()
                .map(|r| ManifestRecord {
                    id: r.id,
                    hash: r.hash.clone(),
                    updated_at: r.updated_at,
                    deleted: r.deleted,
                })
                .collect())
        })
    }

    pub fn export_full(&self, ids: &[MemoId]) -> Result<Vec<FullRecord>> {
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            match self.get_memo(*id) {
                Ok(n) => out.push(FullRecord::from_memo(&n)),
                Err(CoreError::NotFound(_)) => { /* skip missing */ }
                Err(e) => return Err(e),
            }
        }
        Ok(out)
    }

    // -- maintenance ------------------------------------------------------

    /// Rebuild the indexes from the source-of-truth files (§5.5, §9.1).
    pub fn reindex(&self) -> Result<IndexStats> {
        self.ensure_initialized()?;
        self.with_redb_and_search(|idx, search| {
            let mut stats = IndexStats::default();
            let mut search_owned: Vec<(MemoId, String, Option<String>, Vec<String>)> = Vec::new();
            for path in self.files.scan() {
                match self.files.read_memo(&path) {
                    Ok(Some(note)) => {
                        let rel = self.paths.relative_path(&path).unwrap_or_default();
                        let fmt = crate::memo::NoteFormat::from_rel(&rel);
                        let (sbody, stitle) = search_fields(fmt, &note);
                        let title = stitle;
                        let rec = record_of(&note, &rel);
                        match idx.get(note.id)? {
                            None => {
                                idx.upsert(&rec)?;
                                search_owned.push((note.id, sbody, title, note.tags));
                                stats.added += 1;
                            }
                            Some(prev) if prev.hash == rec.hash && prev.preview == rec.preview => {
                                stats.unchanged += 1;
                            }
                            Some(_) => {
                                idx.upsert(&rec)?;
                                search_owned.push((note.id, sbody, title, note.tags));
                                stats.updated += 1;
                            }
                        }
                        stats.memos += 1;
                    }
                    Ok(None) => {}
                    Err(e) => {
                        tracing::warn!(path = %path.display(), error = %e, "reindex: parse failed");
                        stats.failed += 1;
                    }
                }
            }
            for path in self.files.scan_trash() {
                if let Ok(Some(note)) = self.files.read_memo(&path) {
                    let rel = self
                        .paths
                        .relative_path(&path)
                        .and_then(|r| r.strip_prefix(".trash/").map(|s| s.to_string()))
                        .unwrap_or_default();
                    let (sbody, stitle) =
                        search_fields(crate::memo::NoteFormat::from_rel(&rel), &note);
                    let rec = record_of(&note, &rel);
                    idx.upsert(&rec)?;
                    search_owned.push((note.id, sbody, stitle, note.tags));
                    stats.trashed_memos += 1;
                }
            }
            let batch: Vec<crate::store::search::Upsert<'_>> = search_owned
                .iter()
                .map(|(id, body, title, tags)| crate::store::search::Upsert {
                    id: *id,
                    body,
                    title: title.as_deref(),
                    tags,
                })
                .collect();
            search.upsert_batch(&batch)?;
            Ok(stats)
        })
    }
    /// One-time migration: rebuild the index when the cached preview format
    /// lags the current `make_preview` (or the marker is absent), so existing
    /// notes' card previews pick up changes.
    ///
    /// Idempotent: a no-op once the marker is current.
    pub fn migrate(&self) -> Result<()> {
        self.ensure_initialized()?;
        let marker = self.paths.index_fmt_marker_path();
        let wants = INDEX_FORMAT_VERSION.to_string();
        if std::fs::read_to_string(&marker)
            .ok()
            .map(|s| s.trim() == wants)
            .unwrap_or(false)
        {
            return Ok(());
        }
        tracing::info!(version = INDEX_FORMAT_VERSION, "migrating index format");
        self.reindex()?;
        std::fs::write(&marker, &wants)?;
        Ok(())
    }

    /// Re-index a single changed file. Called by the watcher (debounced). Handles
    /// create/modify (upsert) and removal (delete from index + search).
    pub fn reindex_path(&self, path: &Path) {
        if let Err(e) = self.do_reindex_path(path) {
            tracing::warn!(path = %path.display(), error = %e, "watcher reindex failed");
        }
    }

    fn do_reindex_path(&self, path: &Path) -> Result<()> {
        if !path.exists() {
            if let Some(id) = id_from_path(path) {
                self.with_redb_and_search(|idx, search| {
                    idx.remove(id)?;
                    search.remove(id)
                })?;
            }
            return Ok(());
        }
        match self.files.read_memo(path)? {
            Some(note) => {
                let rel = self.paths.relative_path(path).unwrap_or_default();
                let fmt = crate::memo::NoteFormat::from_rel(&rel);
                let (sbody, stitle) = search_fields(fmt, &note);
                self.with_redb_and_search(|idx, search| {
                    idx.upsert(&record_of(&note, &rel))?;
                    search.upsert(note.id, &sbody, stitle.as_deref(), &note.tags)
                })
            }
            None => Ok(()),
        }
    }

    /// Start the background file watcher (§5.5). The returned handle must be
    /// kept alive for the lifetime of the watch.
    pub fn watch(&self) -> Result<crate::watcher::MemoWatcher> {
        let debounce = Duration::from_millis(self.config.read().index.watcher_debounce_ms as u64);
        let vault_path = self.paths.vault.clone();
        let on_change: crate::watcher::OnChange = std::sync::Arc::new(move |path| {
            let Ok(v) = Vault::open(Some(&vault_path)) else {
                return;
            };
            v.reindex_path(&path);
        });
        crate::watcher::MemoWatcher::spawn(
            vec![self.paths.vault.clone(), self.paths.trash_root()],
            debounce,
            on_change,
        )
    }

    /// Consistency check (§9.3). When `fix` is true, safe repairs are applied
    /// (hash recompute + rewrite; orphan index cleanup). Files are never deleted.
    pub fn doctor(&self, fix: bool) -> Result<DoctorReport> {
        self.ensure_initialized()?;
        let mut report = DoctorReport {
            index_locked: crate::lock::is_locked(&self.paths.meta_lock_path()),
            ..DoctorReport::default()
        };

        // Gather indexed ids for orphan detection.
        let all_recs = self.with_redb(|idx| idx.export_since(None))?;
        let indexed: std::collections::HashMap<MemoId, IndexRecord> =
            all_recs.iter().map(|r| (r.id, r.clone())).collect();

        let mut seen: std::collections::HashSet<MemoId> = std::collections::HashSet::new();
        for path in self
            .files
            .list_memo_files()
            .iter()
            .chain(self.files.list_trash_files().iter())
        {
            match self.files.read_memo(path) {
                Ok(Some(mut note)) => {
                    seen.insert(note.id);
                    // Categories have no format validity — only orphan/index
                    // consistency is checked here.
                    let recomputed = hash::hash_memo(note.body.as_bytes(), note.favorite);
                    if recomputed != note.hash {
                        // Report only *unresolved* mismatches. When --fix
                        // rewrites successfully the memo is no longer a
                        // mismatch; a failed rewrite is counted separately.
                        let repaired = if fix {
                            note.hash = recomputed;
                            let rel = self.paths.relative_path(path).unwrap_or_default();
                            match self.files.write_note_at(&rel, &note) {
                                Ok(_) => true,
                                Err(e) => {
                                    report.hash_repair_failed += 1;
                                    tracing::warn!(
                                        id = %note.id,
                                        error = %e,
                                        "doctor: failed to rewrite hash"
                                    );
                                    false
                                }
                            }
                        } else {
                            false
                        };
                        if !repaired {
                            report.hash_mismatches.push(note.id);
                        }
                    }
                }
                Ok(None) => report.orphan_files.push(path.clone()),
                Err(CoreError::Frontmatter { reason, .. }) => {
                    report.corrupt_frontmatter.push((path.clone(), reason));
                }
                Err(e) => {
                    report
                        .corrupt_frontmatter
                        .push((path.clone(), e.to_string()));
                }
            }
        }

        for id in indexed.keys() {
            if !seen.contains(id) {
                report.orphan_index_records.push(*id);
            }
        }
        if fix {
            // Remove orphan index records + search docs in one locked pass.
            let orphans = report.orphan_index_records.clone();
            self.with_redb_and_search(|idx, search| {
                for id in &orphans {
                    idx.remove(*id)?;
                    search.remove(*id)?;
                }
                Ok(())
            })?;
            report.orphan_index_records.clear();
        }

        // Trash purge estimate.
        let cutoff = OffsetDateTime::now_utc()
            - Duration::from_secs(86400 * self.config.read().general.trash_retention_days as u64);
        for path in self.files.list_trash_files() {
            if let Ok(Some(n)) = self.files.read_memo(&path)
                && n.deleted_at.is_some_and(|t| t < cutoff)
            {
                report.trash_expiring += 1;
            }
        }

        report.vault_ok = self.paths.vault.is_dir();
        Ok(report)
    }

    /// Wipe all notes, trash, and the derived redb + tantivy indexes,
    /// returning the vault to an empty state. Note files (identified by the
    /// scanner) are deleted; `_assets/`, `.trash/`, config, and `TEMPLATE.md`
    /// are preserved. Backs the settings "reset" action.
    pub fn reset(&self) -> Result<()> {
        self.ensure_initialized()?;
        self.with_redb_and_search(|idx, search| {
            // Delete all live note files the scanner finds.
            for path in self.files.scan() {
                std::fs::remove_file(&path)?;
            }
            // Wipe the trash.
            let trash = self.paths.trash_root();
            if trash.exists() {
                std::fs::remove_dir_all(&trash)?;
                std::fs::create_dir_all(&trash)?;
            }
            idx.clear()?;
            search.clear()?;
            Ok(())
        })
    }
}

/// Build an [`IndexRecord`] from a [`Memo`] + its vault-relative path. The
/// format is derived from the path's extension.
fn record_of(n: &Memo, path: &str) -> IndexRecord {
    let fmt = crate::memo::NoteFormat::from_rel(path);
    IndexRecord {
        id: n.id,
        created_at: n.created_at,
        updated_at: n.updated_at,
        hash: n.hash.clone(),
        favorite: n.favorite,
        path: path.to_string(),
        title: note_title(fmt, &n.body),
        tags: n.tags.clone(),
        deleted: n.deleted_at.is_some(),
        deleted_at: n.deleted_at,
        preview: preview_of(fmt, &n.body),
    }
}

/// Derived search-index fields for a note: the searchable body text and the
/// title, both format-aware.
fn search_fields(fmt: crate::memo::NoteFormat, note: &Memo) -> (String, Option<String>) {
    (
        searchable_body(fmt, &note.body).into_owned(),
        note_title(fmt, &note.body),
    )
}

/// Body prepared for wiki-link scanning: html comments (which carry the
/// frontmatter) are removed so their contents cannot masquerade as links.
fn link_scan_body<'a>(fmt: crate::memo::NoteFormat, body: &'a str) -> std::borrow::Cow<'a, str> {
    match fmt {
        crate::memo::NoteFormat::Markdown => std::borrow::Cow::Borrowed(body),
        crate::memo::NoteFormat::Html => std::borrow::Cow::Owned(crate::html::strip_comments(body)),
    }
}

fn id_from_path(path: &Path) -> Option<MemoId> {
    let stem = path.file_stem()?.to_str()?;
    MemoId::parse(stem).ok()
}

/// Soft input bounds (H6). A note is a quick card, not a document; reject
/// absurdly large bodies or tag spam before they hit the store/index so a
/// malformed input can't bloat the indexes.
const MAX_BODY_BYTES: usize = 64 * 1024;
const MAX_TAGS: usize = 64;
const MAX_TAG_LEN: usize = 64;

fn validate_note_input(body: &str, tags: &[String]) -> Result<()> {
    if body.len() > MAX_BODY_BYTES {
        return Err(CoreError::other(format!(
            "memo body too large: {} bytes (max {})",
            body.len(),
            MAX_BODY_BYTES
        )));
    }
    if tags.len() > MAX_TAGS {
        return Err(CoreError::other(format!(
            "too many tags: {} (max {})",
            tags.len(),
            MAX_TAGS
        )));
    }
    for t in tags {
        if t.chars().count() > MAX_TAG_LEN {
            return Err(CoreError::other(format!(
                "tag too long: {} chars (max {})",
                t.chars().count(),
                MAX_TAG_LEN
            )));
        }
    }
    Ok(())
}

/// Output of `oximemo doctor` (§9.3).
#[derive(Debug, Default, serde::Serialize)]
pub struct DoctorReport {
    pub corrupt_frontmatter: Vec<(PathBuf, String)>,
    pub orphan_index_records: Vec<MemoId>,
    pub orphan_files: Vec<PathBuf>,
    pub hash_mismatches: Vec<MemoId>,
    /// Notes whose hash was rewritten by `doctor --fix` but the write failed.
    pub hash_repair_failed: u64,
    pub index_locked: bool,
    pub trash_expiring: u64,
    pub vault_ok: bool,
}

// -- graph data (§6.1 graph view) -------------------------------------

/// A node in the wiki-link graph: one note.
#[derive(Debug, Clone, serde::Serialize)]
pub struct GraphNode {
    pub id: String,
    pub title: String,
    pub folder: String,
    pub connections: u32,
    /// OKLCH color string (may be empty — frontend recomputes via colorForFolder).
    pub color: String,
}

/// A directed edge: source note links to target note via `[[...]]`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
}

/// The full wiki-link graph for the graph view.
#[derive(Debug, Clone, serde::Serialize)]
pub struct GraphData {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

/// A backlink: a note that links to the target note.
#[derive(Debug, Clone, serde::Serialize)]
pub struct BacklinkInfo {
    pub id: String,
    pub title: String,
    pub preview: String,
}

/// Recursively register physical directories (even note-less ones) as folder

/// A single recent note attributed to a folder card (newest-first sample).
#[derive(Debug, Clone, serde::Serialize)]
pub struct FolderRecent {
    pub id: crate::memo::MemoId,
    pub title: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

/// One folder tile: direct + recursive counts plus a sample of recent note
/// titles attributed to the nearest displayed ancestor. Drives the folder
/// picker in the Finder-style browser.
#[derive(Debug, Clone, serde::Serialize)]
pub struct FolderCard {
    pub path: String,
    /// Direct note count as `list_folders` reports it.
    pub note_count: u32,
    /// Recursive note count (notes anywhere under this folder).
    pub note_count_deep: u32,
    /// Direct subfolder count.
    pub subfolder_count: u32,
    /// Up to 3 newest notes attributed to this folder (newest-first).
    pub recent: Vec<FolderRecent>,
}

/// entries with count 0. Mirrors `scan_md_into`'s skip rules: hidden dirs
/// (`.trash`, …) and `_assets/` are not folders.
fn collect_folder_dirs(
    dir: &Path,
    rel: &str,
    counts: &mut std::collections::BTreeMap<String, u32>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == crate::paths::ASSETS_DIR {
            continue;
        }
        let child_rel = if rel.is_empty() {
            name
        } else {
            format!("{rel}/{name}")
        };
        counts.entry(child_rel.clone()).or_insert(0);
        collect_folder_dirs(&entry.path(), &child_rel, counts);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn tmp_vault() -> (TempDir, Vault) {
        let dir = TempDir::new().unwrap();
        let v = Vault::open(Some(dir.path())).unwrap();
        (dir, v)
    }

    #[test]
    fn section_setters_roundtrip_and_removed_fields_still_parse() {
        let (dir, v) = tmp_vault();

        let brain = crate::config::BrainConfig {
            enabled: false,
            socket: "/tmp/other.sock".into(),
            space: "work".into(),
        };
        v.set_brain_config(brain.clone()).unwrap();
        v.set_general_config(crate::config::GeneralConfig {
            trash_retention_days: 7,
        })
        .unwrap();
        v.set_capture_config(crate::config::CaptureConfig {
            double_tap_threshold_ms: 500,
            overlay_max_height: 320,
        })
        .unwrap();
        v.set_index_config(crate::config::IndexConfig {
            watcher_debounce_ms: 120,
        })
        .unwrap();

        // Reload from disk: every section persisted.
        let re = Vault::open(Some(dir.path())).unwrap();
        re.with_config(|c| {
            assert_eq!(c.brain, brain);
            assert_eq!(c.general.trash_retention_days, 7);
            assert_eq!(c.capture.double_tap_threshold_ms, 500);
            assert_eq!(c.index.watcher_debounce_ms, 120);
        });

        // A config written before the retry fields were removed still parses
        // (unknown fields are ignored).
        let legacy = r#"
[index]
watcher_debounce_ms = 300
watcher_retry_count = 2
watcher_retry_interval_ms = 200
"#;
        let parsed: crate::config::VaultConfig = toml::from_str(legacy).unwrap();
        assert_eq!(parsed.index.watcher_debounce_ms, 300);
    }

    #[test]
    fn create_get_update_delete_restore() {
        let (_t, v) = tmp_vault();
        let n = v.create_memo("hello world".into(), None).unwrap();
        let got = v.get_memo(n.id).unwrap();
        assert_eq!(got.body, "hello world");

        let updated = v
            .update_memo(n.id, Some("edited".into()), Some(true), None)
            .unwrap();
        assert!(updated.favorite);
        assert_ne!(updated.hash, n.hash);

        v.delete_memo(n.id).unwrap();
        let trashed = v.get_memo(n.id).unwrap();
        assert!(trashed.deleted_at.is_some());

        v.restore_memo(n.id).unwrap();
        assert!(v.get_memo(n.id).unwrap().deleted_at.is_none());
    }

    #[test]
    fn list_folders_includes_empty_directories() {
        let (_t, v) = tmp_vault();
        v.create_memo("root note".into(), None).unwrap();
        v.create_note(
            "novel",
            "in folder".into(),
            crate::memo::NoteFormat::Markdown,
        )
        .unwrap();
        // Empty folder: created but holding no notes yet — must still be
        // listed so the UI can show and manage it.
        std::fs::create_dir_all(v.paths().vault.join("ideas/empty")).unwrap();

        let rows = v.list_folders().unwrap();
        let get = |p: &str| rows.iter().find(|(k, _)| k == p).map(|(_, c)| *c);
        assert_eq!(get(""), Some(1), "loose root notes counted");
        assert_eq!(get("novel"), Some(1));
        assert_eq!(get("ideas/empty"), Some(0), "empty dir listed with count 0");
    }

    #[test]
    fn folder_children_counts_recursively_and_peeks_recents() {
        let (_t, v) = tmp_vault();
        let a = v
            .create_note(
                "novel/act1",
                "# Chapter One".into(),
                crate::memo::NoteFormat::Markdown,
            )
            .unwrap();
        v.create_note(
            "novel/act1",
            "# Chapter Two".into(),
            crate::memo::NoteFormat::Markdown,
        )
        .unwrap();
        v.create_memo("# Loose".into(), None).unwrap();
        v.create_folder("empty").unwrap();

        let root = v.folder_children("").unwrap();
        let novel = root.iter().find(|c| c.path == "novel").unwrap();
        assert_eq!(
            (
                novel.note_count,
                novel.note_count_deep,
                novel.subfolder_count
            ),
            (0, 2, 1)
        );
        assert_eq!(novel.recent.len(), 2);
        assert_eq!(novel.recent[0].title.as_deref(), Some("Chapter Two"));

        let act1 = v.folder_children("novel").unwrap();
        assert_eq!(act1.len(), 1);
        assert_eq!(act1[0].path, "novel/act1");
        assert_eq!((act1[0].note_count, act1[0].note_count_deep), (2, 2));
        assert!(
            v.folder_children("")
                .unwrap()
                .iter()
                .any(|c| c.path == "empty" && c.recent.is_empty())
        );
        let _ = a;
    }

    #[test]
    fn list_and_search() {
        let (_t, v) = tmp_vault();
        v.create_memo("rust async runtime".into(), None).unwrap();
        v.create_memo("go goroutines".into(), None).unwrap();
        let page = v.list_memos(None, 10, MemoFilter::default()).unwrap();
        assert_eq!(page.items.len(), 2);
        let hits = v.search_memos("rust", 10).unwrap();
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn list_notes_next_cursor_roundtrips_as_string() {
        // The Tauri `list_memos(after: Option<String>)` command and the
        // frontend's cursor pagination both treat `next_cursor` as a JSON
        // *string* that `Cursor::parse(&str)` can read back. This locks that
        // contract: a non-null cursor must be a string and must round-trip.
        let (_t, v) = tmp_vault();
        v.create_memo("first note".into(), None).unwrap();
        v.create_memo("second note".into(), None).unwrap();

        // limit below the count forces a non-null cursor on page 1.
        let page = v.list_memos(None, 1, MemoFilter::default()).unwrap();
        assert_eq!(page.items.len(), 1);
        let cursor = page.next_cursor.expect("page 1 must carry a next cursor");
        assert!(
            cursor.starts_with('{'),
            "next_cursor must be a JSON object string, got: {cursor}"
        );

        let parsed = Cursor::parse(&cursor).expect("cursor must round-trip via Cursor::parse");
        let page2 = v
            .list_memos(Some(parsed), 10, MemoFilter::default())
            .unwrap();
        assert_eq!(
            page2.items.len(),
            1,
            "page 2 must return the remaining note"
        );
        // The cursor on page 2 still points past its last item; the pagination
        // terminator is the NEXT fetch returning an empty page with no cursor.
        let c2 = page2.next_cursor.expect("page 2 carries a cursor");
        let page3 = v
            .list_memos(Some(Cursor::parse(&c2).unwrap()), 10, MemoFilter::default())
            .unwrap();
        assert!(page3.items.is_empty(), "page 3 must be empty");
        assert!(
            page3.next_cursor.is_none(),
            "empty page must carry no cursor"
        );
    }

    #[test]
    fn export_manifest_and_full_roundtrip() {
        let (_t, v) = tmp_vault();
        let n = v.create_memo("body text".into(), None).unwrap();
        let manifest = v.export_manifest(None).unwrap();
        assert_eq!(manifest.len(), 1);
        let full = v.export_full(&[n.id]).unwrap();
        assert_eq!(full[0].body, "body text");
    }

    #[test]
    fn reindex_is_idempotent() {
        let (_t, v) = tmp_vault();
        v.create_memo("one".into(), None).unwrap();
        let s1 = v.reindex().unwrap();
        let s2 = v.reindex().unwrap();
        assert_eq!(s2.added, 0);
        assert!(s2.unchanged >= 1);
        let _ = s1;
    }
    #[test]
    fn derived_tags_from_body_end_to_end() {
        let (_t, v) = tmp_vault();
        let n = v.create_memo("회의록 #work #urgent".into(), None).unwrap();
        let got = v.get_memo(n.id).unwrap();
        // Tags are derived from the body, normalized + lowercased.
        assert_eq!(got.tags, vec!["work", "urgent"]);

        // include filter (AND) matches a memo carrying the tag.
        let inc = v
            .list_memos(
                None,
                10,
                MemoFilter {
                    include_tags: vec!["work".into()],
                    match_all: true,
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(inc.items.len(), 1);

        // exclude removes the memo that also carries the excluded tag.
        let exc = v
            .list_memos(
                None,
                10,
                MemoFilter {
                    include_tags: vec!["work".into()],
                    exclude_tags: vec!["urgent".into()],
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(exc.items.is_empty());

        // facets aggregate derived tags over the vault.
        let facets = v.list_facets().unwrap();
        assert_eq!(
            facets
                .tags
                .iter()
                .find(|(t, _)| t == "work")
                .map(|(_, c)| *c),
            Some(1)
        );
        assert_eq!(
            facets
                .tags
                .iter()
                .find(|(t, _)| t == "urgent")
                .map(|(_, c)| *c),
            Some(1)
        );
    }

    #[test]
    fn folder_create_delete() {
        let (_t, v) = tmp_vault();
        v.ensure_initialized().unwrap();
        v.create_folder("novel").unwrap();
        assert!(v.paths.vault.join("novel").exists());
        // Cannot delete root.
        assert!(v.delete_folder("").is_err());
        // Empty folder can be deleted.
        v.delete_folder("novel").unwrap();
        assert!(!v.paths.vault.join("novel").exists());
    }

    #[test]
    fn note_title_derives_filename() {
        let (_t, v) = tmp_vault();
        v.ensure_initialized().unwrap();
        v.create_folder("novel").unwrap();
        let n = v
            .create_note(
                "novel",
                "# 첫 번째 장\n\n본문".into(),
                crate::memo::NoteFormat::Markdown,
            )
            .unwrap();
        let got = v.get_memo(n.id).unwrap();
        assert_eq!(got.body, "# 첫 번째 장\n\n본문");
        // The file should be named from the title.
        let files: Vec<_> = std::fs::read_dir(v.paths.vault.join("novel"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(
            files.iter().any(|f| f.contains("첫-번째-장")),
            "files: {files:?}"
        );
    }

    #[test]
    fn untitled_note_uses_timestamp_filename() {
        let (_t, v) = tmp_vault();
        let n = v
            .create_note(
                "",
                "just a quick memo".into(),
                crate::memo::NoteFormat::Markdown,
            )
            .unwrap();
        // No H1 → timestamp filename at vault root.
        let files: Vec<_> = std::fs::read_dir(&v.paths.vault)
            .unwrap()
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                if name.ends_with(".md") {
                    Some(name)
                } else {
                    None
                }
            })
            .collect();
        assert!(
            files.iter().any(|f| f.len() >= "2026-08-13-143052.md".len()
                && f.chars().filter(|c| c.is_ascii_digit()).count() >= 10),
            "expected timestamp filename, got: {files:?}"
        );
        let _ = n;
    }

    #[test]
    fn update_renames_on_title_change() {
        let (_t, v) = tmp_vault();
        let n = v
            .create_note(
                "",
                "# Old Title\nbody".into(),
                crate::memo::NoteFormat::Markdown,
            )
            .unwrap();
        v.update_note(n.id, Some("# New Title\nbody".into()), None)
            .unwrap();
        let files: Vec<_> = std::fs::read_dir(&v.paths.vault)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(
            files.iter().any(|f| f.contains("New-Title")),
            "files: {files:?}"
        );
        assert!(
            !files.iter().any(|f| f.contains("Old-Title")),
            "files: {files:?}"
        );
    }

    #[test]
    fn folder_filter_in_listing() {
        let (_t, v) = tmp_vault();
        v.ensure_initialized().unwrap();
        v.create_folder("novel").unwrap();
        v.create_note(
            "novel",
            "# Chapter 1".into(),
            crate::memo::NoteFormat::Markdown,
        )
        .unwrap();
        v.create_note("", "quick note".into(), crate::memo::NoteFormat::Markdown)
            .unwrap();
        let all = v.list_memos(None, 10, MemoFilter::default()).unwrap();
        assert_eq!(all.items.len(), 2);
        let novel = v
            .list_memos(
                None,
                10,
                MemoFilter {
                    folder: Some("novel".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(novel.items.len(), 1);
    }

    #[test]
    fn reset_clears_notes_and_indexes() {
        let (_t, v) = tmp_vault();
        v.create_note("", "one".into(), crate::memo::NoteFormat::Markdown)
            .unwrap();
        v.create_note("", "two".into(), crate::memo::NoteFormat::Markdown)
            .unwrap();
        assert_eq!(v.memo_stats().unwrap().memos, 2);
        v.reset().unwrap();
        assert_eq!(v.memo_stats().unwrap().memos, 0);
        v.create_note("", "three".into(), crate::memo::NoteFormat::Markdown)
            .unwrap();
        assert_eq!(v.memo_stats().unwrap().memos, 1);
    }

    #[test]
    fn reset_clears_memos_and_indexes() {
        let (_t, v) = tmp_vault();
        v.create_memo("one".into(), None).unwrap();
        v.create_memo("two".into(), None).unwrap();
        assert_eq!(v.memo_stats().unwrap().memos, 2);
        v.reset().unwrap();
        // Live memos + derived indexes are gone; the vault stays usable.
        assert_eq!(v.memo_stats().unwrap().memos, 0);
        v.create_memo("three".into(), None).unwrap();
        assert_eq!(v.memo_stats().unwrap().memos, 1);
    }

    #[test]
    fn asset_save_dedup_read_list() {
        let (_t, v) = tmp_vault();
        let bytes = [1u8, 2, 3, 4, 5];
        let r = v.save_asset(&bytes, "PNG").unwrap();
        // Canonical scheme: name in the path, host is localhost.
        assert_eq!(r.url, format!("oximg://localhost/{}", r.name));
        assert!(r.name.ends_with(".png"));
        // Dedup: identical bytes → identical name, no second file.
        let r2 = v.save_asset(&bytes, "png").unwrap();
        assert_eq!(r.name, r2.name);
        // read_asset returns the bytes + mime.
        let (got, mime) = v.read_asset(&r.name).unwrap();
        assert_eq!(got, bytes);
        assert_eq!(mime, "image/png");
        // list_assets surfaces it.
        let list = v.list_assets().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, r.name);
    }

    #[test]
    fn asset_gc_removes_orphans_keeps_referenced() {
        let (_t, v) = tmp_vault();
        // Referenced: memo body cites this asset.
        let referenced = v.save_asset(&[1, 2, 3], "png").unwrap();
        v.create_memo(format!("see ![]({})", referenced.url), None)
            .unwrap();
        // Orphan: saved but never cited.
        let orphan = v.save_asset(&[9, 9, 9], "gif").unwrap();
        assert_eq!(v.list_assets().unwrap().len(), 2);

        let removed = v.gc_assets().unwrap();
        assert_eq!(removed, 1);
        assert!(v.read_asset(&referenced.name).is_some());
        assert!(v.read_asset(&orphan.name).is_none());
    }

    #[test]
    fn read_asset_rejects_traversal() {
        let (_t, v) = tmp_vault();
        // Malformed names must never reach the filesystem.
        assert!(v.read_asset("../../etc/passwd").is_none());
        assert!(v.read_asset("deadbeefdeadbeef.exe").is_none());
    }

    #[test]
    fn graph_data_builds_nodes_and_edges() {
        let (_t, v) = tmp_vault();
        let a = v
            .create_note(
                "",
                "# Alpha\n\nLinks to [[Beta]]".into(),
                crate::memo::NoteFormat::Markdown,
            )
            .unwrap();
        let b = v
            .create_note(
                "",
                "# Beta\n\nLinks back to [[Alpha]]".into(),
                crate::memo::NoteFormat::Markdown,
            )
            .unwrap();
        let g = v.graph_data().unwrap();
        // Two nodes, two edges (A→B and B→A).
        assert_eq!(g.nodes.len(), 2);
        assert_eq!(g.edges.len(), 2);
        // Each node has 1 connection.
        for n in &g.nodes {
            assert_eq!(
                n.connections, 1,
                "node {} should have 1 connection",
                n.title
            );
        }
        // Edge source/target are correct.
        assert!(
            g.edges
                .iter()
                .any(|e| e.source == a.id.to_string() && e.target == b.id.to_string())
        );
        assert!(
            g.edges
                .iter()
                .any(|e| e.source == b.id.to_string() && e.target == a.id.to_string())
        );
    }

    #[test]
    fn graph_data_excludes_deleted_and_self_loops() {
        let (_t, v) = tmp_vault();
        let a = v
            .create_note(
                "",
                "# Solo\n\nSelf ref [[Solo]]".into(),
                crate::memo::NoteFormat::Markdown,
            )
            .unwrap();
        v.create_note(
            "",
            "# Ghost\n\nLinks [[Solo]]".into(),
            crate::memo::NoteFormat::Markdown,
        )
        .unwrap();
        // Delete the ghost.
        let page = v.list_memos(None, 10, MemoFilter::default()).unwrap();
        let ghost = page
            .items
            .iter()
            .find(|s| s.title.as_deref() == Some("Ghost"))
            .unwrap();
        v.delete_memo(ghost.id).unwrap();
        let g = v.graph_data().unwrap();
        // Only Solo remains; no self-loop edge.
        assert_eq!(g.nodes.len(), 1);
        assert_eq!(g.edges.len(), 0);
        let _ = a;
    }

    #[test]
    fn config_json_flattens_folders() {
        let (_t, v) = tmp_vault();
        let json = v.config_json();
        // folders should be a plain array, not { items: [...] }
        assert!(json["folders"].is_array());
        assert_eq!(json["schema_version"], 3);
    }

    #[test]
    fn set_folder_pinned_roundtrip() {
        let (_t, v) = tmp_vault();
        v.set_folder_pinned("novel", true).unwrap();
        assert_eq!(
            v.with_config(|c| c
                .folders
                .items
                .iter()
                .find(|f| f.path == "novel")
                .and_then(|f| f.pinned)),
            Some(true)
        );
        // Unpin with nothing else set → entry dropped (clean config).
        v.set_folder_pinned("novel", false).unwrap();
        assert!(v.with_config(|c| c.folders.items.iter().all(|f| f.path != "novel")));
    }
    #[test]
    fn set_folder_view_persists_and_unlocks() {
        let (_t, v) = tmp_vault();
        // Lock a folder to list view.
        v.set_folder_view("novel", Some(crate::config::ViewMode::List))
            .unwrap();
        let json = v.config_json();
        let folders = json["folders"].as_array().unwrap();
        let novel = folders.iter().find(|f| f["path"] == "novel").unwrap();
        assert_eq!(novel["view"], "list");

        // Unlock: view removed.
        v.set_folder_view("novel", None).unwrap();
        let json2 = v.config_json();
        let folders2 = json2["folders"].as_array().unwrap();
        assert!(folders2.iter().all(|f| f["path"] != "novel"));
    }

    #[test]
    fn move_note_changes_folder() {
        let (_t, v) = tmp_vault();
        v.create_folder("work").unwrap();
        let n = v
            .create_note(
                "",
                "# Project\n\nbody".into(),
                crate::memo::NoteFormat::Markdown,
            )
            .unwrap();
        // Initially at root.
        let page = v.list_memos(None, 10, MemoFilter::default()).unwrap();
        assert_eq!(page.items[0].path, "Project.md");

        // Move to work/.
        v.move_note(n.id, "work").unwrap();
        let page2 = v.list_memos(None, 10, MemoFilter::default()).unwrap();
        assert_eq!(page2.items[0].path, "work/Project.md");

        // Old file is gone.
        assert!(!v.paths().vault.join("Project.md").exists());
        assert!(v.paths().vault.join("work/Project.md").exists());
    }
    #[test]
    fn rename_folder_moves_files_index_and_config() {
        let (_t, v) = tmp_vault();
        let n = v
            .create_note(
                "novel",
                "# Old Home\n\nbody".into(),
                crate::memo::NoteFormat::Markdown,
            )
            .unwrap();
        v.set_folder_pinned("novel", true).unwrap();
        v.rename_folder("novel", "book").unwrap();
        // Disk: novel/ gone, book/ exists, memo file under book/.
        assert!(!v.paths().vault.join("novel").exists());
        assert!(v.paths().vault.join("book").exists());
        assert!(v.paths().vault.join("book/Old-Home.md").exists());
        // Index: record path rewritten.
        let rec = v.with_redb(|idx| idx.get(n.id)).unwrap().unwrap();
        assert_eq!(rec.path, "book/Old-Home.md");
        // Config: novel entry moved to book with pinned preserved.
        assert!(v.with_config(|c| {
            c.folders
                .items
                .iter()
                .any(|f| f.path == "book" && f.pinned == Some(true))
        }));
        assert!(v.with_config(|c| c.folders.items.iter().all(|f| f.path != "novel")));
        // Target must not already exist.
        v.create_folder("other").unwrap();
        assert!(v.rename_folder("book", "other").is_err());
    }

    #[test]
    fn rename_folder_repaths_tombstones() {
        let (_t, v) = tmp_vault();
        let n = v
            .create_note(
                "novel",
                "# Ghost\n\nbody".into(),
                crate::memo::NoteFormat::Markdown,
            )
            .unwrap();
        // Soft-delete: file moves to .trash/, record stays as `novel/...`
        // but with `deleted: true`. The tombstone's `path` is what the
        // rename_folder loop sees; before the fix this caused a false
        // "N index entries need reindex" error on every rename of a
        // folder containing any trashed note.
        v.delete_memo(n.id).unwrap();
        // Rename must succeed (no error) and the tombstone record must
        // be re-pathed to the new prefix.
        v.rename_folder("novel", "book").unwrap();
        let rec = v.with_redb(|idx| idx.get(n.id)).unwrap().unwrap();
        assert!(rec.deleted, "tombstone stays deleted after rename");
        assert_eq!(
            rec.path, "book/Ghost.md",
            "tombstone record re-pathed under the new prefix"
        );
        // File stays at the trashed path recorded at delete time —
        // rename_folder only moves live tree, not `.trash/`. The tombstone
        // record's `path` field is now logical (`book/Ghost.md`), pointing
        // at a path that no longer exists on disk until restore; until
        // then the file still lives where delete_memo parked it.
        assert!(v.paths().trash_path("novel/Ghost.md").exists());
    }

    #[test]
    fn get_backlinks_finds_linking_notes() {
        let (_t, v) = tmp_vault();
        let target = v
            .create_note(
                "",
                "# Target\n\nHello".into(),
                crate::memo::NoteFormat::Markdown,
            )
            .unwrap();
        v.create_note(
            "",
            "# Source A\n\nSee [[Target]] for details".into(),
            crate::memo::NoteFormat::Markdown,
        )
        .unwrap();
        v.create_note(
            "",
            "# Source B\n\nAlso references [[Target|the target]]".into(),
            crate::memo::NoteFormat::Markdown,
        )
        .unwrap();
        v.create_note(
            "",
            "# Unrelated\n\nNo links here".into(),
            crate::memo::NoteFormat::Markdown,
        )
        .unwrap();

        let backlinks = v.get_backlinks(target.id).unwrap();
        assert_eq!(backlinks.len(), 2, "should find 2 linking notes");
        let titles: Vec<&str> = backlinks.iter().map(|b| b.title.as_str()).collect();
        assert!(titles.contains(&"Source A"));
        assert!(titles.contains(&"Source B"));
    }

    #[test]
    fn rename_propagation_rewrites_links() {
        let (_t, v) = tmp_vault();
        // Create target note.
        let target = v
            .create_note(
                "",
                "# Old Title\n\nbody".into(),
                crate::memo::NoteFormat::Markdown,
            )
            .unwrap();
        // Create a note that links to it.
        let linker = v
            .create_note(
                "",
                "# Linker\n\nSee [[Old Title]] for more".into(),
                crate::memo::NoteFormat::Markdown,
            )
            .unwrap();

        // Rename target by changing its H1.
        v.update_note(target.id, Some("# New Title\n\nbody".into()), None)
            .unwrap();

        // The linker's body should now reference [[New Title]].
        let updated = v.get_memo(linker.id).unwrap();
        assert!(
            updated.body.contains("[[New Title]]"),
            "link should be updated, got: {}",
            updated.body
        );
        assert!(
            !updated.body.contains("[[Old Title]]"),
            "old link should be gone, got: {}",
            updated.body
        );

        // The linker's index record title must be its own ("Linker"), not
        // the renamed note's title ("New Title") — regression guard for a
        // bug that corrupted search titles during rename propagation.
        let summary = v.get_note_summary(linker.id).unwrap();
        assert_eq!(
            summary.title.as_deref(),
            Some("Linker"),
            "linker's search title must not be corrupted by rename propagation"
        );
    }
    #[test]
    fn html_note_roundtrip_via_vault() {
        let (_t, v) = tmp_vault();
        v.ensure_initialized().unwrap();
        let body =
            "<h1>HTML 제목</h1>\n<p>본문 <a href=\"#\">링크</a></p>\n<p>#태그</p>".to_string();
        let n = v
            .create_note("", body, crate::memo::NoteFormat::Html)
            .unwrap();

        // File landed as .html and reads back identically.
        let rec = v.with_redb(|idx| idx.get(n.id)).unwrap().unwrap();
        assert!(rec.path.ends_with(".html"), "path: {}", rec.path);
        assert_eq!(rec.title.as_deref(), Some("HTML 제목"));
        assert!(rec.preview.contains("본문"), "preview: {}", rec.preview);

        // Tags extracted from the html body.
        assert!(n.tags.contains(&"태그".to_string()));

        // Search finds the visible text.
        let hits = v.search_memos("본문", 10).unwrap();
        assert!(hits.iter().any(|m| m.id == n.id));
    }

    #[test]
    fn create_note_auto_follows_folder_template() {
        let (_t, v) = tmp_vault();
        v.ensure_initialized().unwrap();
        v.create_folder("web").unwrap();
        std::fs::write(
            v.paths.vault.join("web/TEMPLATE.html"),
            "<h1>{{date}} 노트</h1>\n<p></p>",
        )
        .unwrap();

        // Blank body → html template applied → html file.
        let n = v.create_note_auto("web", String::new()).unwrap();
        let rec = v.with_redb(|idx| idx.get(n.id)).unwrap().unwrap();
        assert!(rec.path.starts_with("web/"), "path: {}", rec.path);
        assert!(rec.path.ends_with(".html"), "path: {}", rec.path);
        assert!(n.body.contains("<h1>"), "body: {}", n.body);
        assert!(n.body.contains("노트"));

        // Folders without an html template stay markdown.
        let md = v.create_note_auto("", "# 그냥 메모".into()).unwrap();
        let rec2 = v.with_redb(|idx| idx.get(md.id)).unwrap().unwrap();
        assert!(rec2.path.ends_with(".md"), "path: {}", rec2.path);
    }

    #[test]
    fn html_frontmatter_comment_not_scanned_for_links() {
        let (_t, v) = tmp_vault();
        v.ensure_initialized().unwrap();
        // Frontmatter inside an html comment contains a wiki-link-looking
        // string; it must not create graph edges or backlinks.
        let target = v
            .create_note(
                "",
                "# Target\n\nx".into(),
                crate::memo::NoteFormat::Markdown,
            )
            .unwrap();
        let body = "<!--\n+++\ntitle = \"see [[Target]] inside\"\n+++\n-->\n<h1>Page</h1>\n<p>no links</p>"
            .to_string();
        let src = v
            .create_note("", body, crate::memo::NoteFormat::Html)
            .unwrap();

        let links = v.get_backlinks(target.id).unwrap();
        assert!(
            links.iter().all(|b| b.id != src.id.to_string()),
            "frontmatter comment must not count as a backlink"
        );
    }

    #[test]
    fn note_dto_derives_placement() {
        let (_t, v) = tmp_vault();
        v.ensure_initialized().unwrap();
        v.create_folder("web").unwrap();
        let n = v
            .create_note(
                "web",
                "<h1>페이지</h1>\n<p>#html</p>".into(),
                crate::memo::NoteFormat::Html,
            )
            .unwrap();

        let dto = v.note_dto(&n);
        assert_eq!(dto.id, n.id);
        assert_eq!(dto.title.as_deref(), Some("페이지"));
        assert_eq!(dto.folder, "web");
        assert!(dto.path.starts_with("web/") && dto.path.ends_with(".html"));
        assert_eq!(dto.format, crate::memo::NoteFormat::Html);
        assert_eq!(dto.body, n.body);

        // Root markdown note: folder empty, format markdown.
        let m = v
            .create_note("", "# MD\n\nx".into(), crate::memo::NoteFormat::Markdown)
            .unwrap();
        let d2 = v.note_dto(&m);
        assert_eq!(d2.folder, "");
        assert_eq!(d2.format, crate::memo::NoteFormat::Markdown);
        assert_eq!(d2.title.as_deref(), Some("MD"));
    }
}
