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
//! redb and tantivy are opened *transiently* within the lock scope, so no
//! process holds them open across the boundary — two processes never collide on
//! redb's or tantivy's own single-writer locks. This keeps the agent path
//! (`oxinot …` while the GUI is running) correct.

use std::path::{Path, PathBuf};
use std::time::Duration;

use time::OffsetDateTime;

use crate::config::VaultConfig;
use crate::error::{CoreError, Result};
use crate::hash;
use crate::lock::{acquire, FileLock, LockKind};
use crate::note::{
    make_preview, Cursor, IndexStats, Note, NoteColor, NoteFilter, NoteId, NoteSummary, Page,
};
use crate::paths::Paths;
use crate::store::files::FileStore;
use crate::store::index::{IndexRecord, NoteIndex, RedbIndex};
use crate::store::search::{SearchIndex, TantivySearch};
use crate::sync::{FullRecord, ManifestRecord};

/// How long to wait for the cross-process index lock before timing out (§5.7).
const LOCK_TIMEOUT: Duration = Duration::from_secs(5);

pub struct Vault {
    paths: Paths,
    config: VaultConfig,
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
        Ok(Self { paths, config, files })
    }

    pub fn paths(&self) -> &Paths {
        &self.paths
    }

    pub fn config(&self) -> &VaultConfig {
        &self.config
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

    pub fn create_note(
        &self,
        body: String,
        tags: Vec<String>,
        color: Option<String>,
    ) -> Result<Note> {
        self.ensure_initialized()?;
        let now = OffsetDateTime::now_utc();
        let id = NoteId::now();
        let color = color.map(NoteColor).unwrap_or_default();
        let note = Note {
            id,
            created_at: now,
            updated_at: now,
            hash: hash::hash_note(body.as_bytes(), &tags, false, &color.0),
            pinned: false,
            color,
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
                return self.files.read_note(&live)?.ok_or_else(|| CoreError::NotFound(id.to_string()));
            }
            let trash = self.paths.trash_path(id);
            if trash.exists() {
                return self.files.read_note(&trash)?.ok_or_else(|| CoreError::NotFound(id.to_string()));
            }
        }
        // Index miss (not yet indexed): scan the tree.
        for path in self.files.list_note_files().iter().chain(self.files.list_trash_files().iter()) {
            if let Ok(Some(n)) = self.files.read_note(path) {
                if n.id == id {
                    return Ok(n);
                }
            }
        }
        Err(CoreError::NotFound(id.to_string()))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update_note(
        &self,
        id: NoteId,
        body: Option<String>,
        tags: Option<Vec<String>>,
        pinned: Option<bool>,
        color: Option<String>,
    ) -> Result<Note> {
        let mut note = self.get_note(id)?;
        if let Some(b) = body {
            note.body = b;
        }
        if let Some(t) = tags {
            note.tags = t;
        }
        if let Some(p) = pinned {
            note.pinned = p;
        }
        if let Some(c) = color {
            note.color = NoteColor(c);
        }
        note.updated_at = OffsetDateTime::now_utc();
        note.hash = hash::hash_note(note.body.as_bytes(), &note.tags, note.pinned, &note.color.0);
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
        note.hash = hash::hash_note(note.body.as_bytes(), &note.tags, note.pinned, &note.color.0);
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
        note.hash = hash::hash_note(note.body.as_bytes(), &note.tags, note.pinned, &note.color.0);
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
                let Ok(Some(n)) = self.files.read_note(&path) else { continue };
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
            let next_cursor = items
                .last()
                .map(|s| Cursor { updated_at: s.updated_at, id: s.id });
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
            for path in self.files.list_note_files() {
                match self.files.read_note(&path) {
                    Ok(Some(note)) => {
                        let rec = record_of(&note);
                        match idx.get(note.id)? {
                            None => {
                                idx.upsert(&rec)?;
                                search.upsert(note.id, &note.body, &note.tags)?;
                                stats.added += 1;
                            }
                            Some(prev) if prev.hash == rec.hash => {
                                stats.unchanged += 1;
                            }
                            Some(_) => {
                                idx.upsert(&rec)?;
                                search.upsert(note.id, &note.body, &note.tags)?;
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
                    search.upsert(note.id, &note.body, &note.tags)?;
                    stats.trashed += 1;
                }
            }
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
        let debounce = Duration::from_millis(self.config.index.watcher_debounce_ms as u64);
        let vault_path = self.paths.vault.clone();
        // Re-open a Vault per callback: each op takes its own lock, so the
        // watcher coordinates with concurrent CLI/GUI access naturally.
        let on_change: crate::watcher::OnChange = std::sync::Arc::new(move |path| {
            let Ok(v) = Vault::open(Some(&vault_path)) else { return };
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
        let mut report = DoctorReport::default();
        report.index_locked = crate::lock::is_locked(&self.paths.meta_lock_path());

        // Gather indexed ids for orphan detection.
        let all_recs = self.with_redb(|idx| idx.export_since(None))?;
        let indexed: std::collections::HashMap<NoteId, IndexRecord> =
            all_recs.iter().map(|r| (r.id, r.clone())).collect();

        let mut seen: std::collections::HashSet<NoteId> = std::collections::HashSet::new();
        for path in self.files.list_note_files().iter().chain(self.files.list_trash_files().iter()) {
            match self.files.read_note(path) {
                Ok(Some(mut note)) => {
                    seen.insert(note.id);
                    if !note.color.is_valid() {
                        report.invalid_colors.push(note.id);
                    }
                    let recomputed =
                        hash::hash_note(note.body.as_bytes(), &note.tags, note.pinned, &note.color.0);
                    if recomputed != note.hash {
                        report.hash_mismatches.push(note.id);
                        if fix {
                            note.hash = recomputed;
                            let _ = self.files.write(&note);
                        }
                    }
                }
                Ok(None) => report.orphan_files.push(path.clone()),
                Err(CoreError::Frontmatter { reason, .. }) => {
                    report.corrupt_frontmatter.push((path.clone(), reason));
                }
                Err(e) => {
                    report.corrupt_frontmatter.push((path.clone(), e.to_string()));
                }
            }
        }

        for (id, _) in &indexed {
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
            report.hash_mismatches.clear();
        }

        // Trash purge estimate.
        let cutoff = OffsetDateTime::now_utc()
            - Duration::from_secs(86400 * self.config.general.trash_retention_days as u64);
        for path in self.files.list_trash_files() {
            if let Ok(Some(n)) = self.files.read_note(&path) {
                if n.deleted_at.is_some_and(|t| t < cutoff) {
                    report.trash_expiring += 1;
                }
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
        color: n.color.clone(),
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

/// Output of `oxinot doctor` (§9.3).
#[derive(Debug, Default, serde::Serialize)]
pub struct DoctorReport {
    pub corrupt_frontmatter: Vec<(PathBuf, String)>,
    pub orphan_index_records: Vec<NoteId>,
    pub orphan_files: Vec<PathBuf>,
    pub hash_mismatches: Vec<NoteId>,
    pub invalid_colors: Vec<NoteId>,
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
        let n = v.create_note("hello world".into(), vec!["t".into()], None).unwrap();
        let got = v.get_note(n.id).unwrap();
        assert_eq!(got.body, "hello world");

        let updated = v.update_note(n.id, Some("edited".into()), None, Some(true), None).unwrap();
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
        v.create_note("rust async runtime".into(), vec!["rust".into()], None).unwrap();
        v.create_note("go goroutines".into(), vec!["go".into()], None).unwrap();
        let page = v.list_notes(None, 10, NoteFilter::default()).unwrap();
        assert_eq!(page.items.len(), 2);
        let hits = v.search_notes("rust", 10).unwrap();
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn export_manifest_and_full_roundtrip() {
        let (_t, v) = tmp_vault();
        let n = v.create_note("body text".into(), vec!["a".into()], None).unwrap();
        let manifest = v.export_manifest(None).unwrap();
        assert_eq!(manifest.len(), 1);
        let full = v.export_full(&[n.id]).unwrap();
        assert_eq!(full[0].body, "body text");
    }

    #[test]
    fn reindex_is_idempotent() {
        let (_t, v) = tmp_vault();
        v.create_note("one".into(), vec![], None).unwrap();
        let s1 = v.reindex().unwrap();
        let s2 = v.reindex().unwrap();
        assert_eq!(s2.added, 0);
        assert!(s2.unchanged >= 1);
        let _ = s1;
    }
}
