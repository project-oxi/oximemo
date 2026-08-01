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
//! (`oxinot …` while the GUI is running) correct.

use std::path::{Path, PathBuf};
use std::time::Duration;

use time::OffsetDateTime;

use parking_lot::RwLock;

use crate::config::{AUTO_COLORS, CategoryDef, VaultConfig};
use crate::error::{CoreError, Result};
use crate::hash;
use crate::lock::{FileLock, LockKind, acquire};
use crate::memo::{
    Cursor, IndexStats, Memo, MemoFilter, MemoId, MemoSummary, Page, make_preview,
};
use crate::paths::Paths;
use crate::store::files::FileStore;
use crate::store::index::{IndexRecord, MemoIndex, RedbIndex};
use crate::store::search::{SearchIndex, TantivySearch};
use crate::sync::{FullRecord, ManifestRecord};
use crate::tags::extract_tags;

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

    /// Read config under a read guard. Use [`Self::categories`] when you only
    /// need the list of categories — that helper already takes the guard and
    /// clones for you.
    pub fn with_config<R>(&self, f: impl FnOnce(&VaultConfig) -> R) -> R {
        f(&self.config.read())
    }

    /// Snapshot of the current category list (cloned under the read guard).
    pub fn categories(&self) -> Vec<crate::config::CategoryDef> {
        self.config.read().categories.items.clone()
    }

    /// Create a user-defined category. `id` is normalized (trimmed + lowercased);
    /// rejects empty ids and collisions (including the built-in `inbox`).
    /// `color = None` picks the first unused entry from `AUTO_COLORS`.
    pub fn create_category(&self, id: String, color: Option<String>) -> Result<CategoryDef> {
        let id = normalize_id(&id);
        if id.is_empty() {
            return Err(CoreError::other("category id empty"));
        }
        let mut cfg = self.config.write();
        if cfg.categories.items.iter().any(|c| c.id == id) {
            return Err(CoreError::other(format!("category '{id}' exists")));
        }
        let color = color.unwrap_or_else(|| pick_auto_color(&cfg.categories.items));
        let def = CategoryDef {
            id: id.clone(),
            color,
            builtin: false,
        };
        cfg.categories.items.push(def.clone());
        cfg.save(&self.paths)?;
        Ok(def)
    }

    /// Update an existing category's color. Errors if the id doesn't match any
    /// known category. `inbox` (and any other built-in) can be re-colored; only
    /// deletion is restricted.
    pub fn update_category(&self, id: String, color: String) -> Result<()> {
        let id = normalize_id(&id);
        let mut cfg = self.config.write();
        let def = cfg
            .categories
            .items
            .iter_mut()
            .find(|c| c.id == id)
            .ok_or_else(|| CoreError::other(format!("category '{id}' not found")))?;
        def.color = color;
        cfg.save(&self.paths)
    }

    /// Remove a user-defined category. The built-in `inbox` cannot be deleted.
    pub fn delete_category(&self, id: String) -> Result<()> {
        let id = normalize_id(&id);
        if id == crate::memo::DEFAULT_CATEGORY {
            return Err(CoreError::other("inbox cannot be deleted"));
        }
        let mut cfg = self.config.write();
        let before = cfg.categories.items.len();
        cfg.categories.items.retain(|c| c.id != id);
        if cfg.categories.items.len() == before {
            return Err(CoreError::other(format!("category '{id}' not found")));
        }
        cfg.save(&self.paths)
    }

    pub fn paths(&self) -> &Paths {
        &self.paths
    }

    /// Create the vault + index directories if missing.
    pub fn ensure_initialized(&self) -> Result<()> {
        std::fs::create_dir_all(self.paths.memos_root())?;
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
        std::fs::read(&path).ok().map(|b| (b, crate::assets::mime_for_ext(ext)))
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
                .map(|d| OffsetDateTime::from_unix_timestamp(d.as_secs() as i64).unwrap_or_else(|_| OffsetDateTime::now_utc()))
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
                Ok(Some(parsed))
                    if crate::assets::refs_in_body(&parsed.body).contains(name) =>
                {
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

    pub fn create_memo(&self, body: String, category: Option<String>) -> Result<Memo> {
        self.ensure_initialized()?;
        let tags = extract_tags(&body);
        validate_note_input(&body, &tags)?;
        let now = OffsetDateTime::now_utc();
        let id = MemoId::now();
        let category = category.unwrap_or_else(|| crate::memo::DEFAULT_CATEGORY.to_string());
        let note = Memo {
            id,
            created_at: now,
            updated_at: now,
            hash: hash::hash_memo(body.as_bytes(), false, &category),
            favorite: false,
            category,
            tags,
            body,
            deleted_at: None,
        };
        self.files.write(&note)?;
        self.with_redb_and_search(|idx, search| {
            idx.upsert(&record_of(&note))?;
            search.upsert(note.id, &note.body, &note.tags)
        })?;
        Ok(note)
    }

    pub fn get_memo(&self, id: MemoId) -> Result<Memo> {
        // Use the index to learn created_at, which pins the sharded file path.
        let created_at = self.with_redb(|idx| idx.get(id))?.map(|r| r.created_at);
        if let Some(ca) = created_at {
            let live = self.paths.memo_path(id, ca);
            if live.exists() {
                return self
                    .files
                    .read_memo(&live)?
                    .ok_or_else(|| CoreError::NotFound(id.to_string()));
            }
            let trash = self.paths.trash_path(id);
            if trash.exists() {
                return self
                    .files
                    .read_memo(&trash)?
                    .ok_or_else(|| CoreError::NotFound(id.to_string()));
            }
        }
        // Index miss (not yet indexed): scan the tree.
        for path in self
            .files
            .list_memo_files()
            .iter()
            .chain(self.files.list_trash_files().iter())
        {
            if let Ok(Some(n)) = self.files.read_memo(path)
                && n.id == id
            {
                return Ok(n);
            }
        }
        Err(CoreError::NotFound(id.to_string()))
    }

    pub fn update_memo(
        &self,
        id: MemoId,
        body: Option<String>,
        favorite: Option<bool>,
        category: Option<String>,
    ) -> Result<Memo> {
        let mut note = self.get_memo(id)?;
        if let Some(b) = body {
            note.body = b;
            note.tags = extract_tags(&note.body);
        }
        if let Some(p) = favorite {
            note.favorite = p;
        }
        if let Some(c) = category {
            note.category = c;
        }
        validate_note_input(&note.body, &note.tags)?;
        note.updated_at = OffsetDateTime::now_utc();
        note.hash = hash::hash_memo(note.body.as_bytes(), note.favorite, &note.category);
        self.files.write(&note)?;
        self.with_redb_and_search(|idx, search| {
            idx.upsert(&record_of(&note))?;
            search.upsert(note.id, &note.body, &note.tags)
        })?;
        Ok(note)
    }

    /// Soft-delete: move to trash, mark tombstone, drop from search (§5.4).
    pub fn delete_memo(&self, id: MemoId) -> Result<()> {
        let mut note = self.get_memo(id)?;
        let now = OffsetDateTime::now_utc();
        note.deleted_at = Some(now);
        note.updated_at = now;
        note.hash = hash::hash_memo(note.body.as_bytes(), note.favorite, &note.category);
        self.files.move_to_trash(&note)?;
        self.files.write(&note)?;
        self.with_redb_and_search(|idx, search| {
            idx.upsert(&record_of(&note))?;
            search.remove(note.id)
        })?;
        Ok(())
    }

    pub fn restore_memo(&self, id: MemoId) -> Result<Memo> {
        let mut note = self.get_memo(id)?;
        note.deleted_at = None;
        note.updated_at = OffsetDateTime::now_utc();
        note.hash = hash::hash_memo(note.body.as_bytes(), note.favorite, &note.category);
        self.files.restore_from_trash(&note)?;
        self.files.write(&note)?;
        self.with_redb_and_search(|idx, search| {
            idx.upsert(&record_of(&note))?;
            search.upsert(note.id, &note.body, &note.tags)
        })?;
        Ok(note)
    }

    /// Hard-delete trashed memos whose `deleted_at` is older than `retention`.
    /// Returns the number purged.
    pub fn purge(&self, retention: Duration) -> Result<u64> {
        let cutoff = OffsetDateTime::now_utc() - retention;
        let mut purged = 0u64;
        self.with_redb_and_search(|idx, search| {
            for path in self.files.list_trash_files() {
                let Ok(Some(n)) = self.files.read_memo(&path) else {
                    continue;
                };
                if n.deleted_at.is_some_and(|t| t < cutoff) {
                    self.files.purge(n.id)?;
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

    /// Tag + color counts over live (non-deleted) notes for the sidebar (§4.2).
    pub fn list_facets(&self) -> Result<crate::memo::Facets> {
        self.with_redb(|idx| {
            let recs = idx.export_since(None)?;
            let mut tag_map: std::collections::BTreeMap<String, u32> = Default::default();
            let mut cat_map: std::collections::BTreeMap<String, u32> = Default::default();
            for r in &recs {
                if r.deleted {
                    continue;
                }
                for t in &r.tags {
                    *tag_map.entry(t.clone()).or_insert(0) += 1;
                }
                if !r.category.is_empty() {
                    *cat_map.entry(r.category.clone()).or_insert(0) += 1;
                }
            }
            Ok(crate::memo::Facets {
                tags: tag_map.into_iter().collect(),
                categories: cat_map.into_iter().collect(),
            })
        })
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
            // Collect search upserts to commit once (H1: avoids one tantivy
            // commit/fsync per note). redb upserts stay per-call; they're cheap.
            let mut search_owned: Vec<(MemoId, String, Vec<String>)> = Vec::new();
            for path in self.files.list_memo_files() {
                match self.files.read_memo(&path) {
                    Ok(Some(note)) => {
                        let rec = record_of(&note);
                        match idx.get(note.id)? {
                            None => {
                                idx.upsert(&rec)?;
                                search_owned.push((note.id, note.body, note.tags));
                                stats.added += 1;
                            }
                            Some(prev) if prev.hash == rec.hash && prev.preview == rec.preview => {
                                stats.unchanged += 1;
                            }
                            Some(_) => {
                                idx.upsert(&rec)?;
                                search_owned.push((note.id, note.body, note.tags));
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
            for path in self.files.list_trash_files() {
                if let Ok(Some(note)) = self.files.read_memo(&path) {
                    let rec = record_of(&note);
                    idx.upsert(&rec)?;
                    search_owned.push((note.id, note.body, note.tags));
                    stats.trashed_memos += 1;
                }
            }
            // One tantivy commit for everything that changed.
            let batch: Vec<crate::store::search::Upsert<'_>> = search_owned
                .iter()
                .map(|(id, body, tags)| crate::store::search::Upsert {
                    id: *id,
                    body,
                    tags,
                })
                .collect();
            search.upsert_batch(&batch)?;
            Ok(stats)
        })
    }
    /// One-time migrations run on first use:
    /// 1. Rename the live memo tree from `notes/` to `memos/` if the legacy
    ///    path is non-empty and the new one is absent.
    /// 2. Rebuild the index when the cached preview format lags the current
    ///    `make_preview` (or the marker is absent), so existing memos' card
    ///    previews pick up line-break preservation.
    ///
    /// Idempotent: subsequent calls are no-ops once both markers are current.
    pub fn migrate(&self) -> Result<()> {
        // Rename the legacy live tree to its new name BEFORE ensure_initialized,
        // which would otherwise create an empty `memos/` and make the
        // `!new_root.exists()` guard permanently false.
        let old_root = self.paths.vault.join("notes");
        let new_root = self.paths.memos_root();
        if old_root.exists()
            && old_root != new_root
            && !new_root.exists()
            && std::fs::read_dir(&old_root)?.next().is_some()
        {
            tracing::info!(from = %old_root.display(), to = %new_root.display(), "renaming vault memos root");
            std::fs::rename(&old_root, &new_root)?;
        }
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
        tracing::info!(version = INDEX_FORMAT_VERSION, "migrating index preview format");
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
            Some(note) => self.with_redb_and_search(|idx, search| {
                idx.upsert(&record_of(&note))?;
                search.upsert(note.id, &note.body, &note.tags)
            }),
            None => Ok(()),
        }
    }

    /// Start the background file watcher (§5.5). The returned handle must be
    /// kept alive for the lifetime of the watch.
    pub fn watch(&self) -> Result<crate::watcher::MemoWatcher> {
        let debounce = Duration::from_millis(self.config.read().index.watcher_debounce_ms as u64);
        let vault_path = self.paths.vault.clone();
        // Re-open a Vault per callback: each op takes its own lock, so the
        // watcher coordinates with concurrent CLI/GUI access naturally.
        let on_change: crate::watcher::OnChange = std::sync::Arc::new(move |path| {
            let Ok(v) = Vault::open(Some(&vault_path)) else {
                return;
            };
            v.reindex_path(&path);
        });
        crate::watcher::MemoWatcher::spawn(
            vec![self.paths.memos_root(), self.paths.trash_root()],
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
                    let recomputed =
                        hash::hash_memo(note.body.as_bytes(), note.favorite, &note.category);
                    if recomputed != note.hash {
                        // Report only *unresolved* mismatches. When --fix
                        // rewrites successfully the memo is no longer a
                        // mismatch; a failed rewrite is counted separately.
                        let repaired = if fix {
                            note.hash = recomputed;
                            match self.files.write(&note) {
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

    /// Rename a category, migrating every note whose `category` matches `old`
    /// to `new`. Each migrated note is rewritten (category, updated_at, hash),
    /// re-added to the redb index and the tantivy search index, and the
    /// category registry is updated and persisted. Returns the number of
    /// notes migrated.
    ///
    /// Rules:
    /// - `old` and `new` are normalized (trimmed + lowercased).
    /// - Neither side may be the built-in `inbox` (immutable).
    /// - `old` must exist in the registry; `new` must not collide.
    /// - `old == new` is rejected.
    pub fn rename_category(&self, old: String, new: String) -> Result<u64> {
        let old = normalize_id(&old);
        let new = normalize_id(&new);
        if old == crate::memo::DEFAULT_CATEGORY || new == crate::memo::DEFAULT_CATEGORY {
            return Err(CoreError::other("inbox id is immutable"));
        }
        if old == new {
            return Err(CoreError::other("old == new"));
        }

        // validate + mutate registry under write lock, but defer save until after migration
        {
            let cfg = self.config.read();
            if !cfg.categories.items.iter().any(|c| c.id == old) {
                return Err(CoreError::other(format!("category '{old}' not found")));
            }
            if cfg.categories.items.iter().any(|c| c.id == new) {
                return Err(CoreError::other(format!("category '{new}' exists")));
            }
        }

        let mut migrated = 0u64;
        self.with_redb_and_search(|idx, search| {
            for rec in idx.export_since(None)? {
                if rec.category != old {
                    continue;
                }
                let path = self.paths.memo_path(rec.id, rec.created_at);
                let mut note = self
                    .files
                    .read_memo(&path)?
                    .ok_or_else(|| CoreError::NotFound(rec.id.to_string()))?;
                note.category = new.clone();
                note.updated_at = OffsetDateTime::now_utc();
                note.hash = hash::hash_memo(note.body.as_bytes(), note.favorite, &note.category);
                self.files.write(&note)?;
                idx.upsert(&record_of(&note))?;
                search.upsert(note.id, &note.body, &note.tags)?;
                migrated += 1;
            }
            Ok(())
        })?;

        // update registry + persist
        {
            let mut cfg = self.config.write();
            for def in cfg.categories.items.iter_mut() {
                if def.id == old {
                    def.id = new.clone();
                }
            }
            cfg.save(&self.paths)?;
        }
        Ok(migrated)
    }

    /// Wipe all memos, trash, and the derived redb + tantivy indexes,
    /// returning the vault to an empty state. The source-of-truth `.md` files
    /// (live + trash) are deleted and both indexes are cleared. Category/color
    /// config is preserved. Backs the settings "reset" action.
    pub fn reset(&self) -> Result<()> {
        self.ensure_initialized()?;
        // Wipe under the exclusive index lock so a concurrent reader never
        // observes an empty index pointing at files that still exist (or vice
        // versa). Source-of-truth files go first; any removal error aborts the
        // reset (indexes stay consistent with the surviving files) instead of
        // being swallowed into a half-wiped vault.
        let roots = [self.paths.memos_root(), self.paths.trash_root()];
        self.with_redb_and_search(|idx, search| {
            for root in roots {
                if root.exists() {
                    for entry in std::fs::read_dir(&root)? {
                        let path = entry?.path();
                        if path.is_dir() {
                            std::fs::remove_dir_all(&path)?;
                        } else {
                            std::fs::remove_file(&path)?;
                        }
                    }
                }
            }
            idx.clear()?;
            search.clear()?;
            Ok(())
        })
    }

}

/// Build an [`IndexRecord`] from a [`Memo`], deriving the card preview.
fn record_of(n: &Memo) -> IndexRecord {
    IndexRecord {
        id: n.id,
        created_at: n.created_at,
        updated_at: n.updated_at,
        hash: n.hash.clone(),
        favorite: n.favorite,
        category: n.category.clone(),
        tags: n.tags.clone(),
        deleted: n.deleted_at.is_some(),
        deleted_at: n.deleted_at,
        preview: make_preview(&n.body),
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

/// Output of `oxinot doctor` (§9.3).
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

/// Normalize a category id: trim surrounding whitespace and lowercase. ASCII
/// slugs are the canonical form (brief §Task 3 — "ASCII slugs suffice"). If
/// non-ASCII ids ever ship, prepend `.nfc().collect::<String>()` from
/// `unicode-normalization` (already a dep).
fn normalize_id(id: &str) -> String {
    id.trim().to_lowercase()
}

/// Pick the first non-transparent `AUTO_COLORS` entry not already used by an
/// existing item; falls back to the first real entry when every stop is in
/// use. The inbox slot (`AUTO_COLORS[0]`, empty/transparent) is deliberately
/// skipped so a new category always gets a real tint, never the transparent
/// default. Used when `Vault::create_category` is called with `color=None`.
fn pick_auto_color(items: &[CategoryDef]) -> String {
    AUTO_COLORS
        .iter()
        .skip(1) // skip inbox's transparent slot
        .find(|c| !items.iter().any(|item| &item.color == *c))
        .map(|s| (*s).to_string())
        .unwrap_or_else(|| AUTO_COLORS[1].to_string())
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
        let page2 = v.list_memos(Some(parsed), 10, MemoFilter::default()).unwrap();
        assert_eq!(page2.items.len(), 1, "page 2 must return the remaining note");
        // The cursor on page 2 still points past its last item; the pagination
        // terminator is the NEXT fetch returning an empty page with no cursor.
        let c2 = page2.next_cursor.expect("page 2 carries a cursor");
        let page3 = v
            .list_memos(Some(Cursor::parse(&c2).unwrap()), 10, MemoFilter::default())
            .unwrap();
        assert!(page3.items.is_empty(), "page 3 must be empty");
        assert!(page3.next_cursor.is_none(), "empty page must carry no cursor");
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
    fn category_crud_persists() {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(Some(dir.path())).unwrap();
        v.ensure_initialized().unwrap();

        // create
        let c = v.create_category("urgent".into(), None).unwrap();
        assert_eq!(c.id, "urgent");
        assert!(!c.color.is_empty());

        // duplicate rejected
        assert!(v.create_category("urgent".into(), None).is_err());
        // empty rejected
        assert!(v.create_category("  ".into(), None).is_err());
        // inbox collision rejected
        assert!(v.create_category("inbox".into(), None).is_err());

        // update color
        v.update_category("urgent".into(), "oklch(0.6 0.2 25)".into()).unwrap();
        assert_eq!(v.categories().iter().find(|c| c.id == "urgent").unwrap().color, "oklch(0.6 0.2 25)");

        // delete
        v.delete_category("urgent".into()).unwrap();
        assert!(v.categories().iter().all(|c| c.id != "urgent"));

        // inbox not deletable
        assert!(v.delete_category("inbox".into()).is_err());
        // unknown update/rename target rejected
        assert!(v.update_category("nope".into(), "x".into()).is_err());

        // persists across reopen
        let v2 = Vault::open(Some(dir.path())).unwrap();
        assert!(v2.categories().iter().all(|c| c.id != "urgent"));
    }

    #[test]
    fn rename_category_migrates_notes() {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(Some(dir.path())).unwrap();
        v.ensure_initialized().unwrap();

        let a = v.create_memo("note A".into(), Some("todo".into())).unwrap();
        let b = v.create_memo("note B".into(), Some("todo".into())).unwrap();
        let c = v.create_memo("note C".into(), Some("idea".into())).unwrap();

        let n = v.rename_category("todo".into(), "tasks".into()).unwrap();
        assert_eq!(n, 2);

        // migrated
        assert_eq!(v.get_memo(a.id).unwrap().category, "tasks");
        assert_eq!(v.get_memo(b.id).unwrap().category, "tasks");
        // unaffected
        assert_eq!(v.get_memo(c.id).unwrap().category, "idea");
        // registry updated
        assert!(v.categories().iter().any(|c| c.id == "tasks"));
        assert!(v.categories().iter().all(|c| c.id != "todo"));

        // inbox not renameable
        assert!(v.rename_category("inbox".into(), "x".into()).is_err());
        // collision
        assert!(v.rename_category("tasks".into(), "idea".into()).is_err());
    }

    #[test]
    fn migrate_renames_legacy_notes_root() {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(Some(dir.path())).unwrap();
        v.ensure_initialized().unwrap();
        let _ = v.create_memo("hello".into(), None).unwrap();
        let live = v.paths.memos_root();
        let legacy = v.paths.vault.join("notes");
        std::fs::rename(&live, &legacy).unwrap();
        assert!(legacy.exists());
        assert!(!live.exists());
        // Idempotent on a fresh open: no-op.
        let v2 = Vault::open(Some(dir.path())).unwrap();
        v2.migrate().unwrap();
        assert!(live.exists());
        assert!(!legacy.exists());
    }

    #[test]
    fn migrate_preserves_existing_memos_root() {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(Some(dir.path())).unwrap();
        v.ensure_initialized().unwrap();
        let live = v.paths.memos_root();
        let legacy = v.paths.vault.join("notes");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("stale.md"), "stale").unwrap();
        let new_id = v.create_memo("fresh".into(), None).unwrap();
        assert!(live.exists());
        assert!(legacy.exists());

        v.migrate().unwrap();
        assert!(live.exists());
        assert!(legacy.exists());
        assert!(v.get_memo(new_id.id).is_ok());
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
        v.create_memo(format!("see ![]({})", referenced.url), None).unwrap();
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
}
