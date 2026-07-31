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

use crate::config::VaultConfig;
use crate::error::{CoreError, Result};
use crate::hash;
use crate::lock::{FileLock, LockKind, acquire};
use crate::note::{
    Cursor, IndexStats, Note, NoteFilter, NoteId, NoteSummary, Page, make_preview,
};
use crate::paths::Paths;
use crate::store::files::FileStore;
use crate::store::index::{IndexRecord, NoteIndex, RedbIndex};
use crate::store::search::{SearchIndex, TantivySearch};
use crate::sync::{FullRecord, ManifestRecord};
use crate::tags::extract_tags;

/// How long to wait for the cross-process index lock before timing out (§5.7).
const LOCK_TIMEOUT: Duration = Duration::from_secs(5);

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

    pub fn paths(&self) -> &Paths {
        &self.paths
    }

    /// Create the vault + index directories if missing.
    pub fn ensure_initialized(&self) -> Result<()> {
        std::fs::create_dir_all(self.paths.notes_root())?;
        std::fs::create_dir_all(self.paths.trash_root())?;
        std::fs::create_dir_all(&self.paths.index_dir)?;
        Ok(())
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

    pub fn create_note(&self, body: String, category: Option<String>) -> Result<Note> {
        self.ensure_initialized()?;
        let tags = extract_tags(&body);
        validate_note_input(&body, &tags)?;
        let now = OffsetDateTime::now_utc();
        let id = NoteId::now();
        let category = category.unwrap_or_else(|| crate::note::DEFAULT_CATEGORY.to_string());
        let note = Note {
            id,
            created_at: now,
            updated_at: now,
            hash: hash::hash_note(body.as_bytes(), false, &category),
            pinned: false,
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

    pub fn get_note(&self, id: NoteId) -> Result<Note> {
        // Use the index to learn created_at, which pins the sharded file path.
        let created_at = self.with_redb(|idx| idx.get(id))?.map(|r| r.created_at);
        if let Some(ca) = created_at {
            let live = self.paths.note_path(id, ca);
            if live.exists() {
                return self
                    .files
                    .read_note(&live)?
                    .ok_or_else(|| CoreError::NotFound(id.to_string()));
            }
            let trash = self.paths.trash_path(id);
            if trash.exists() {
                return self
                    .files
                    .read_note(&trash)?
                    .ok_or_else(|| CoreError::NotFound(id.to_string()));
            }
        }
        // Index miss (not yet indexed): scan the tree.
        for path in self
            .files
            .list_note_files()
            .iter()
            .chain(self.files.list_trash_files().iter())
        {
            if let Ok(Some(n)) = self.files.read_note(path)
                && n.id == id
            {
                return Ok(n);
            }
        }
        Err(CoreError::NotFound(id.to_string()))
    }

    pub fn update_note(
        &self,
        id: NoteId,
        body: Option<String>,
        pinned: Option<bool>,
        category: Option<String>,
    ) -> Result<Note> {
        let mut note = self.get_note(id)?;
        if let Some(b) = body {
            note.body = b;
            note.tags = extract_tags(&note.body);
        }
        if let Some(p) = pinned {
            note.pinned = p;
        }
        if let Some(c) = category {
            note.category = c;
        }
        validate_note_input(&note.body, &note.tags)?;
        note.updated_at = OffsetDateTime::now_utc();
        note.hash = hash::hash_note(note.body.as_bytes(), note.pinned, &note.category);
        self.files.write(&note)?;
        self.with_redb_and_search(|idx, search| {
            idx.upsert(&record_of(&note))?;
            search.upsert(note.id, &note.body, &note.tags)
        })?;
        Ok(note)
    }

    /// Soft-delete: move to trash, mark tombstone, drop from search (§5.4).
    pub fn delete_note(&self, id: NoteId) -> Result<()> {
        let mut note = self.get_note(id)?;
        let now = OffsetDateTime::now_utc();
        note.deleted_at = Some(now);
        note.updated_at = now;
        note.hash = hash::hash_note(note.body.as_bytes(), note.pinned, &note.category);
        self.files.move_to_trash(&note)?;
        self.files.write(&note)?;
        self.with_redb_and_search(|idx, search| {
            idx.upsert(&record_of(&note))?;
            search.remove(note.id)
        })?;
        Ok(())
    }

    pub fn restore_note(&self, id: NoteId) -> Result<Note> {
        let mut note = self.get_note(id)?;
        note.deleted_at = None;
        note.updated_at = OffsetDateTime::now_utc();
        note.hash = hash::hash_note(note.body.as_bytes(), note.pinned, &note.category);
        self.files.restore_from_trash(&note)?;
        self.files.write(&note)?;
        self.with_redb_and_search(|idx, search| {
            idx.upsert(&record_of(&note))?;
            search.upsert(note.id, &note.body, &note.tags)
        })?;
        Ok(note)
    }

    /// Hard-delete trashed notes whose `deleted_at` is older than `retention`.
    /// Returns the number purged.
    pub fn purge(&self, retention: Duration) -> Result<u64> {
        let cutoff = OffsetDateTime::now_utc() - retention;
        let mut purged = 0u64;
        self.with_redb_and_search(|idx, search| {
            for path in self.files.list_trash_files() {
                let Ok(Some(n)) = self.files.read_note(&path) else {
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

    pub fn list_notes(
        &self,
        after: Option<Cursor>,
        limit: u32,
        filter: NoteFilter,
    ) -> Result<Page<NoteSummary>> {
        self.with_redb(|idx| {
            let recs = idx.list(after, limit, &filter)?;
            let items: Vec<NoteSummary> = recs.iter().map(|r| r.to_summary()).collect();
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

    pub fn search_notes(&self, query: &str, limit: u32) -> Result<Vec<NoteSummary>> {
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

    pub fn get_note_summary(&self, id: NoteId) -> Result<NoteSummary> {
        self.with_redb(|idx| match idx.get(id)? {
            Some(r) => Ok(r.to_summary()),
            None => Err(CoreError::NotFound(id.to_string())),
        })
    }

    /// Live note counts (soft-deleted tombstones excluded).
    pub fn note_stats(&self) -> Result<crate::note::NoteStats> {
        self.with_redb(|idx| {
            let recs = idx.export_since(None)?;
            let mut stats = crate::note::NoteStats::default();
            for r in &recs {
                if r.deleted {
                    continue;
                }
                stats.notes += 1;
                if r.pinned {
                    stats.pinned += 1;
                }
            }
            Ok(stats)
        })
    }

    /// Tag + color counts over live (non-deleted) notes for the sidebar (§4.2).
    pub fn list_facets(&self) -> Result<crate::note::Facets> {
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
            Ok(crate::note::Facets {
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

    pub fn export_full(&self, ids: &[NoteId]) -> Result<Vec<FullRecord>> {
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            match self.get_note(*id) {
                Ok(n) => out.push(FullRecord::from_note(&n)),
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
            let mut search_owned: Vec<(NoteId, String, Vec<String>)> = Vec::new();
            for path in self.files.list_note_files() {
                match self.files.read_note(&path) {
                    Ok(Some(note)) => {
                        let rec = record_of(&note);
                        match idx.get(note.id)? {
                            None => {
                                idx.upsert(&rec)?;
                                search_owned.push((note.id, note.body, note.tags));
                                stats.added += 1;
                            }
                            Some(prev) if prev.hash == rec.hash => {
                                stats.unchanged += 1;
                            }
                            Some(_) => {
                                idx.upsert(&rec)?;
                                search_owned.push((note.id, note.body, note.tags));
                                stats.updated += 1;
                            }
                        }
                        stats.notes += 1;
                    }
                    Ok(None) => {}
                    Err(e) => {
                        tracing::warn!(path = %path.display(), error = %e, "reindex: parse failed");
                        stats.failed += 1;
                    }
                }
            }
            for path in self.files.list_trash_files() {
                if let Ok(Some(note)) = self.files.read_note(&path) {
                    let rec = record_of(&note);
                    idx.upsert(&rec)?;
                    search_owned.push((note.id, note.body, note.tags));
                    stats.trashed += 1;
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
        match self.files.read_note(path)? {
            Some(note) => self.with_redb_and_search(|idx, search| {
                idx.upsert(&record_of(&note))?;
                search.upsert(note.id, &note.body, &note.tags)
            }),
            None => Ok(()),
        }
    }

    /// Start the background file watcher (§5.5). The returned handle must be
    /// kept alive for the lifetime of the watch.
    pub fn watch(&self) -> Result<crate::watcher::NoteWatcher> {
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
        crate::watcher::NoteWatcher::spawn(
            vec![self.paths.notes_root(), self.paths.trash_root()],
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
        let indexed: std::collections::HashMap<NoteId, IndexRecord> =
            all_recs.iter().map(|r| (r.id, r.clone())).collect();

        let mut seen: std::collections::HashSet<NoteId> = std::collections::HashSet::new();
        for path in self
            .files
            .list_note_files()
            .iter()
            .chain(self.files.list_trash_files().iter())
        {
            match self.files.read_note(path) {
                Ok(Some(mut note)) => {
                    seen.insert(note.id);
                    // Categories have no format validity — only orphan/index
                    // consistency is checked here.
                    let recomputed =
                        hash::hash_note(note.body.as_bytes(), note.pinned, &note.category);
                    if recomputed != note.hash {
                        // Report only *unresolved* mismatches. When --fix
                        // rewrites successfully the note is no longer a
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
            if let Ok(Some(n)) = self.files.read_note(&path)
                && n.deleted_at.is_some_and(|t| t < cutoff)
            {
                report.trash_expiring += 1;
            }
        }

        report.vault_ok = self.paths.vault.is_dir();
        Ok(report)
    }
}

/// Build an [`IndexRecord`] from a [`Note`], deriving the card preview.
fn record_of(n: &Note) -> IndexRecord {
    IndexRecord {
        id: n.id,
        created_at: n.created_at,
        updated_at: n.updated_at,
        hash: n.hash.clone(),
        pinned: n.pinned,
        category: n.category.clone(),
        tags: n.tags.clone(),
        deleted: n.deleted_at.is_some(),
        deleted_at: n.deleted_at,
        preview: make_preview(&n.body),
    }
}

fn id_from_path(path: &Path) -> Option<NoteId> {
    let stem = path.file_stem()?.to_str()?;
    NoteId::parse(stem).ok()
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
            "note body too large: {} bytes (max {})",
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
    pub orphan_index_records: Vec<NoteId>,
    pub orphan_files: Vec<PathBuf>,
    pub hash_mismatches: Vec<NoteId>,
    /// Notes whose hash was rewritten by `doctor --fix` but the write failed.
    pub hash_repair_failed: u64,
    pub index_locked: bool,
    pub trash_expiring: u64,
    pub vault_ok: bool,
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
        let n = v.create_note("hello world".into(), None).unwrap();
        let got = v.get_note(n.id).unwrap();
        assert_eq!(got.body, "hello world");

        let updated = v
            .update_note(n.id, Some("edited".into()), Some(true), None)
            .unwrap();
        assert!(updated.pinned);
        assert_ne!(updated.hash, n.hash);

        v.delete_note(n.id).unwrap();
        let trashed = v.get_note(n.id).unwrap();
        assert!(trashed.deleted_at.is_some());

        v.restore_note(n.id).unwrap();
        assert!(v.get_note(n.id).unwrap().deleted_at.is_none());
    }

    #[test]
    fn list_and_search() {
        let (_t, v) = tmp_vault();
        v.create_note("rust async runtime".into(), None).unwrap();
        v.create_note("go goroutines".into(), None).unwrap();
        let page = v.list_notes(None, 10, NoteFilter::default()).unwrap();
        assert_eq!(page.items.len(), 2);
        let hits = v.search_notes("rust", 10).unwrap();
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn list_notes_next_cursor_roundtrips_as_string() {
        // The Tauri `list_notes(after: Option<String>)` command and the
        // frontend's cursor pagination both treat `next_cursor` as a JSON
        // *string* that `Cursor::parse(&str)` can read back. This locks that
        // contract: a non-null cursor must be a string and must round-trip.
        let (_t, v) = tmp_vault();
        v.create_note("first note".into(), None).unwrap();
        v.create_note("second note".into(), None).unwrap();

        // limit below the count forces a non-null cursor on page 1.
        let page = v.list_notes(None, 1, NoteFilter::default()).unwrap();
        assert_eq!(page.items.len(), 1);
        let cursor = page.next_cursor.expect("page 1 must carry a next cursor");
        assert!(
            cursor.starts_with('{'),
            "next_cursor must be a JSON object string, got: {cursor}"
        );

        let parsed = Cursor::parse(&cursor).expect("cursor must round-trip via Cursor::parse");
        let page2 = v.list_notes(Some(parsed), 10, NoteFilter::default()).unwrap();
        assert_eq!(page2.items.len(), 1, "page 2 must return the remaining note");
        // The cursor on page 2 still points past its last item; the pagination
        // terminator is the NEXT fetch returning an empty page with no cursor.
        let c2 = page2.next_cursor.expect("page 2 carries a cursor");
        let page3 = v
            .list_notes(Some(Cursor::parse(&c2).unwrap()), 10, NoteFilter::default())
            .unwrap();
        assert!(page3.items.is_empty(), "page 3 must be empty");
        assert!(page3.next_cursor.is_none(), "empty page must carry no cursor");
    }

    #[test]
    fn export_manifest_and_full_roundtrip() {
        let (_t, v) = tmp_vault();
        let n = v.create_note("body text".into(), None).unwrap();
        let manifest = v.export_manifest(None).unwrap();
        assert_eq!(manifest.len(), 1);
        let full = v.export_full(&[n.id]).unwrap();
        assert_eq!(full[0].body, "body text");
    }

    #[test]
    fn reindex_is_idempotent() {
        let (_t, v) = tmp_vault();
        v.create_note("one".into(), None).unwrap();
        let s1 = v.reindex().unwrap();
        let s2 = v.reindex().unwrap();
        assert_eq!(s2.added, 0);
        assert!(s2.unchanged >= 1);
        let _ = s1;
    }
    #[test]
    fn derived_tags_from_body_end_to_end() {
        let (_t, v) = tmp_vault();
        let n = v.create_note("회의록 #work #urgent".into(), None).unwrap();
        let got = v.get_note(n.id).unwrap();
        // Tags are derived from the body, normalized + lowercased.
        assert_eq!(got.tags, vec!["work", "urgent"]);

        // include filter (AND) matches a note carrying the tag.
        let inc = v
            .list_notes(
                None,
                10,
                NoteFilter {
                    include_tags: vec!["work".into()],
                    match_all: true,
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(inc.items.len(), 1);

        // exclude removes the note that also carries the excluded tag.
        let exc = v
            .list_notes(
                None,
                10,
                NoteFilter {
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
}
