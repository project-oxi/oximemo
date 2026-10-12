//! Metadata index backed by `redb` (§5.1).
//!
//! Two tables maintain the index:
//! - `by_id`: `id (16B)` → serialized [`IndexRecord`]
//! - `by_sort`: `sort_key (24B)` → `id (16B)`, where `sort_key` encodes
//!   `(updated_at, id)` such that ascending byte order is **newest-first**.
//!
//! Newest-first ordering is achieved by storing the bitwise complement of the
//! timestamp and id bytes: larger natural values map to smaller encoded keys,
//! so a plain ascending range scan yields notes newest-first, and "older than
//! cursor" is simply `range((Excluded(cursor_key), Unbounded))`. This needs no
//! reverse iteration and bounds pagination work to the page size.

use crate::error::CoreError;
use redb::{ReadableDatabase, ReadableTable, ReadableTableMetadata};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::error::Result;
use crate::memo::{Cursor, MemoFilter, MemoHash, MemoId, MemoSummary};
use uuid::Uuid;

const BY_ID: redb::TableDefinition<&[u8], &[u8]> = redb::TableDefinition::new("by_id");
const BY_SORT: redb::TableDefinition<&[u8], &[u8]> = redb::TableDefinition::new("by_sort");
/// `IndexRecord::path` → the list of every claiming id. A live note and a
/// trash copy can share the stripped relative path; watcher removals apply
/// plane-specific filtering after looking up all claimants.
const BY_PATH: redb::TableDefinition<&str, &[u8]> = redb::TableDefinition::new("by_path");

/// A note's indexed metadata (no body). Stored as the index value.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexRecord {
    pub id: MemoId,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
    pub hash: MemoHash,
    #[serde(default, alias = "pinned")]
    pub favorite: bool,
    /// Vault-root-relative path, e.g. `"novel/act1/첫-번째-장.md"`.
    #[serde(default)]
    pub path: String,
    /// Title derived from H1, or `None` for untitled notes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Frontmatter properties (non-core keys) — the indexed snapshot so
    /// property queries never read files (design 2026-08-23 §5.1).
    #[serde(default)]
    pub props: crate::props::Props,
    #[serde(default)]
    pub tasks: Vec<crate::tasks::TaskRow>,
    #[serde(default)]
    pub tasks_truncated: bool,
    pub deleted: bool,
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub deleted_at: Option<OffsetDateTime>,
    /// Cached card preview (derived from body) so listings avoid file reads.
    pub preview: String,
}

impl IndexRecord {
    pub fn to_summary(&self) -> MemoSummary {
        MemoSummary {
            id: self.id,
            created_at: self.created_at,
            updated_at: self.updated_at,
            hash: self.hash.clone(),
            favorite: self.favorite,
            title: self.title.clone(),
            path: self.path.clone(),
            tags: self.tags.clone(),
            props: self.props.clone(),
            preview: self.preview.clone(),
            deleted: self.deleted,
        }
    }
}

/// Swappable storage boundary (§5.1). A future SQLite+FTS5 backend implements
/// this same trait.
pub trait MemoIndex: Send + Sync {
    fn upsert(&self, rec: &IndexRecord) -> Result<()>;
    fn remove(&self, id: MemoId) -> Result<()>;
    fn get(&self, id: MemoId) -> Result<Option<IndexRecord>>;
    /// Cursor-paginated, newest-first listing with in-memory filter.
    fn list(
        &self,
        after: Option<Cursor>,
        limit: u32,
        filter: &MemoFilter,
    ) -> Result<Vec<IndexRecord>>;
    /// Notes with `updated_at >= since` (newest-first). `None` = all notes.
    fn export_since(&self, since: Option<OffsetDateTime>) -> Result<Vec<IndexRecord>>;
    /// Ids whose record claims `path` (the stored, `.trash/`-stripped
    /// spelling). Usually zero or one id; a live note and a tombstoned
    /// trash copy may both claim the same path with different ids.
    /// `None` means the lookup table is absent or empty (legacy index
    /// that has not been backfilled yet), so the answer is unknown and
    /// callers must fall back to a full export.
    fn id_for_path(&self, path: &str) -> Result<Option<Vec<MemoId>>>;
    fn count(&self) -> Result<u64>;
    fn clear(&self) -> Result<()>;
}

/// `redb`-backed [`MemoIndex`].
pub struct RedbIndex {
    db: redb::Database,
}

impl RedbIndex {
    /// Open (creating) the index database. Caller is responsible for the
    /// cross-process advisory lock (§5.7) around open + use.
    ///
    /// Read-first: when both `by_id` and `by_sort` already exist, we
    /// return immediately without committing any transaction. The
    /// previous implementation always ran `begin_write + open_table +
    /// commit`, which bumped `meta.redb`'s mtime on every open even
    /// when no user-visible write had happened.
    ///
    /// redb's `Database` constructor writes the file header on open, so
    /// the file's mtime bumps regardless. [`crate::vault::Vault::snapshot`]
    /// keys its cache on the *post-open* stat so the cache stays
    /// self-consistent across back-to-back reads (see the doc on
    /// `snapshot` for the rationale).
    ///
    /// v2 → v3 file format: redb 3 hard-rejects a v2 file
    /// (`DatabaseError::UpgradeRequired`) and ships no upgrade path of
    /// its own, so on that error we hop through redb 2.6's
    /// `Database::upgrade()` — an in-place, two-phase-commit format bump
    /// that moves no data pages — and retry. Vaults written by redb ≥2.6
    /// (every oximemo release to date) and v3 vaults both open here;
    /// older-than-2.6 vaults were never shipped.
    pub fn open(path: &std::path::Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let db = match redb::Database::create(path) {
            Ok(db) => db,
            Err(redb::DatabaseError::UpgradeRequired(version)) => {
                upgrade_file_format(path, version)?;
                redb::Database::create(path)?
            }
            Err(e) => return Err(e.into()),
        };
        // Probe both tables in a read transaction. If both already
        // exist (the steady state for every open after the first), we
        // skip the legacy `begin_write + open_table + commit` creation
        // path so we never commit an empty transaction.
        {
            let tx = db.begin_read()?;
            let has_by_id = tx.open_table(BY_ID).is_ok();
            let has_by_sort = tx.open_table(BY_SORT).is_ok();
            let has_by_path = tx.open_table(BY_PATH).is_ok();
            if has_by_id && has_by_sort && has_by_path {
                return Ok(Self { db });
            }
        }
        // Fresh DB or a partial schema from an interrupted first-open:
        // create all tables before subsequent paths assume they exist.
        // When upgrading a legacy schema (BY_ID already has rows), the
        // lookup table is backfilled from every readable BY_ID row in this
        // transaction. Corrupt rows are warned about and skipped so one
        // unreadable record does not prevent opening the vault.
        let tx = db.begin_write()?;
        let _ = tx.open_table(BY_ID)?;
        let _ = tx.open_table(BY_SORT)?;
        {
            let mut by_path = tx.open_table(BY_PATH)?;
            let by_id = tx.open_table(BY_ID)?;
            for row in by_id.iter()? {
                let (_, value) = row?;
                let rec: IndexRecord = match serde_json::from_slice(value.value()) {
                    Ok(rec) => rec,
                    Err(error) => {
                        tracing::warn!(
                            error = %error,
                            "by_path backfill skipped unreadable index record"
                        );
                        continue;
                    }
                };
                if rec.path.is_empty() {
                    continue;
                }
                let id = rec.id.as_uuid();
                path_add(&mut by_path, &rec.path, id.as_bytes())?;
            }
        }
        tx.commit()?;
        Ok(Self { db })
    }

    fn upgrade_via_redb2(path: &std::path::Path) -> Result<()> {
        // redb2's error types are distinct from the redb 3 ones CoreError
        // knows; stringify — this is a one-shot compatibility hop, and
        // the message carries everything a bug report needs.
        let mut legacy = redb2::Database::open(path)
            .map_err(|e| CoreError::Other(format!("redb2 open for upgrade: {e}")))?;
        legacy
            .upgrade()
            .map_err(|e| CoreError::Other(format!("redb2 file-format upgrade: {e}")))?;
        Ok(())
    }

    /// Insert many records in ONE transaction. Bulk fixture helper:
    /// [`MemoIndex::upsert`] commits per record, which makes seeding
    /// tens of thousands of test records quadratic in fsyncs.
    pub fn upsert_bulk(&self, recs: &[IndexRecord]) -> Result<()> {
        let tx = self.db.begin_write()?;
        {
            let mut by_id = tx.open_table(BY_ID)?;
            let mut by_sort = tx.open_table(BY_SORT)?;
            let mut by_path = tx.open_table(BY_PATH)?;
            for rec in recs {
                let uuid = rec.id.as_uuid();
                let id_slice: &[u8] = uuid.as_bytes();
                let sort_key = encode_sort(rec.updated_at, rec.id);
                let value = serde_json::to_vec(rec)?;
                if let Some(prev) = by_id.get(id_slice)? {
                    let prev_rec: IndexRecord = serde_json::from_slice(prev.value())?;
                    let prev_key = encode_sort(prev_rec.updated_at, prev_rec.id);
                    by_sort.remove(&prev_key[..])?;
                    path_remove(&mut by_path, &prev_rec.path, id_slice)?;
                }
                by_id.insert(id_slice, value.as_slice())?;
                by_sort.insert(sort_key.as_slice(), id_slice)?;
                path_add(&mut by_path, &rec.path, id_slice)?;
            }
        }
        tx.commit()?;
        Ok(())
    }
}

/// Return the complete 16-byte UUID entries in a path's id list, warning
/// when the stored value ends with a truncated entry.
fn complete_path_ids<'a>(path: &str, bytes: &'a [u8]) -> &'a [u8] {
    let complete_len = bytes.len() / 16 * 16;
    if complete_len != bytes.len() {
        tracing::warn!(
            path,
            length = bytes.len(),
            "by_path ID list has a truncated entry"
        );
    }
    &bytes[..complete_len]
}

/// Append `id` to `path`'s id list in `by_path`, deduplicated. A live note
/// and a tombstoned trash copy may share the stripped path.
fn path_add(table: &mut redb::Table<&str, &[u8]>, path: &str, id: &[u8]) -> Result<()> {
    let mut list: Vec<u8> = match table.get(path)? {
        Some(guard) => guard.value().to_vec(),
        None => Vec::new(),
    };
    let complete_len = complete_path_ids(path, &list).len();
    list.truncate(complete_len);
    if !list
        .as_chunks::<16>()
        .0
        .iter()
        .any(|existing| existing == id)
    {
        list.extend_from_slice(id);
    }
    table.insert(path, list.as_slice())?;
    Ok(())
}

/// Remove `id` from `path`'s id list in `by_path`, deleting the key when the
/// list becomes empty. Missing keys/ids are ignored (idempotent cleanup).
fn path_remove(table: &mut redb::Table<&str, &[u8]>, path: &str, id: &[u8]) -> Result<()> {
    let kept: Vec<u8> = match table.get(path)? {
        Some(guard) => complete_path_ids(path, guard.value())
            .as_chunks::<16>()
            .0
            .iter()
            .filter(|existing| *existing != id)
            .flatten()
            .copied()
            .collect(),
        None => return Ok(()),
    };
    if kept.is_empty() {
        table.remove(path)?;
    } else {
        table.insert(path, kept.as_slice())?;
    }
    Ok(())
}

/// Free function so the migration reads at the call site without the
/// `RedbIndex` receiver (the index doesn't exist yet when it runs).
fn upgrade_file_format(path: &std::path::Path, from_version: u8) -> Result<()> {
    if from_version != 2 {
        // v1 predates any shipped oximemo; anything else is corruption.
        return Err(CoreError::Other(format!(
            "unsupported redb file format version {from_version}"
        )));
    }
    RedbIndex::upgrade_via_redb2(path)
}

impl MemoIndex for RedbIndex {
    fn upsert(&self, rec: &IndexRecord) -> Result<()> {
        let uuid = rec.id.as_uuid();
        let id_slice: &[u8] = uuid.as_bytes();
        let sort_key = encode_sort(rec.updated_at, rec.id);
        let value = serde_json::to_vec(rec)?;

        let tx = self.db.begin_write()?;
        {
            let mut by_id = tx.open_table(BY_ID)?;
            let mut by_sort = tx.open_table(BY_SORT)?;
            let mut by_path = tx.open_table(BY_PATH)?;
            // A previous sort key may exist for this id (updated_at may have
            // changed); remove it before inserting the fresh one.
            if let Some(prev) = by_id.get(id_slice)? {
                let prev_rec: IndexRecord = serde_json::from_slice(prev.value())?;
                let prev_key = encode_sort(prev_rec.updated_at, prev_rec.id);
                by_sort.remove(&prev_key[..])?;
                path_remove(&mut by_path, &prev_rec.path, id_slice)?;
            }
            by_id.insert(id_slice, value.as_slice())?;
            by_sort.insert(sort_key.as_slice(), id_slice)?;
            path_add(&mut by_path, &rec.path, id_slice)?;
        }
        tx.commit()?;
        Ok(())
    }

    fn remove(&self, id: MemoId) -> Result<()> {
        let uuid = id.as_uuid();
        let id_slice: &[u8] = uuid.as_bytes();
        let tx = self.db.begin_write()?;
        {
            let mut by_id = tx.open_table(BY_ID)?;
            let mut by_sort = tx.open_table(BY_SORT)?;
            let mut by_path = tx.open_table(BY_PATH)?;
            if let Some(prev) = by_id.get(id_slice)? {
                let prev_rec: IndexRecord = serde_json::from_slice(prev.value())?;
                let prev_key = encode_sort(prev_rec.updated_at, prev_rec.id);
                by_sort.remove(&prev_key[..])?;
                path_remove(&mut by_path, &prev_rec.path, id_slice)?;
            }
            by_id.remove(id_slice)?;
        }
        tx.commit()?;
        Ok(())
    }

    fn id_for_path(&self, path: &str) -> Result<Option<Vec<MemoId>>> {
        let tx = self.db.begin_read()?;
        let Ok(by_path) = tx.open_table(BY_PATH) else {
            // Table not yet created: only possible before `open` ran its
            // schema-creation/backfill transaction.
            return Ok(None);
        };
        let Some(guard) = by_path.get(path)? else {
            // The table is complete (backfilled atomically at creation and
            // kept in sync by upsert/remove), so an absent key genuinely
            // means "no record claims this path".
            return Ok(Some(Vec::new()));
        };
        Ok(Some(
            complete_path_ids(path, guard.value())
                .as_chunks::<16>()
                .0
                .iter()
                .filter_map(|bytes| Uuid::from_slice(bytes).ok())
                .map(MemoId)
                .collect(),
        ))
    }
    fn get(&self, id: MemoId) -> Result<Option<IndexRecord>> {
        let uuid = id.as_uuid();
        let id_slice: &[u8] = uuid.as_bytes();
        let tx = self.db.begin_read()?;
        let table = tx.open_table(BY_ID)?;
        Ok(match table.get(id_slice)? {
            Some(g) => Some(serde_json::from_slice(g.value())?),
            None => None,
        })
    }

    fn list(
        &self,
        after: Option<Cursor>,
        limit: u32,
        filter: &MemoFilter,
    ) -> Result<Vec<IndexRecord>> {
        let tx = self.db.begin_read()?;
        let by_sort = tx.open_table(BY_SORT)?;
        let by_id = tx.open_table(BY_ID)?;

        let mut out = Vec::new();
        let iter = match after {
            None => by_sort.iter()?,
            Some(c) => {
                let start = encode_sort(c.updated_at, c.id);
                let bounds: (std::ops::Bound<&[u8]>, std::ops::Bound<&[u8]>) = (
                    std::ops::Bound::Excluded(start.as_slice()),
                    std::ops::Bound::Unbounded,
                );
                by_sort.range::<&[u8]>(bounds)?
            }
        };

        for item in iter {
            let (_sort_key, id_guard) = item?;
            let id_slice: &[u8] = id_guard.value();
            let rec: IndexRecord = match by_id.get(id_slice)? {
                Some(g) => serde_json::from_slice(g.value())?,
                None => continue,
            };
            let summary = rec.to_summary();
            if !filter.matches(&summary) {
                continue;
            }
            out.push(rec);
            if out.len() >= limit as usize {
                break;
            }
        }
        Ok(out)
    }

    fn export_since(&self, since: Option<OffsetDateTime>) -> Result<Vec<IndexRecord>> {
        let tx = self.db.begin_read()?;
        let by_sort = tx.open_table(BY_SORT)?;
        let by_id = tx.open_table(BY_ID)?;

        let mut out = Vec::new();
        for item in by_sort.iter()? {
            let (_sort_key, id_guard) = item?;
            let id_slice: &[u8] = id_guard.value();
            let rec: IndexRecord = match by_id.get(id_slice)? {
                Some(g) => serde_json::from_slice(g.value())?,
                None => continue,
            };
            match since {
                Some(t) if rec.updated_at < t => break,
                _ => out.push(rec),
            }
        }
        Ok(out)
    }

    fn count(&self) -> Result<u64> {
        let tx = self.db.begin_read()?;
        let table = tx.open_table(BY_ID)?;
        Ok(table.len()?)
    }

    fn clear(&self) -> Result<()> {
        let tx = self.db.begin_write()?;
        {
            tx.delete_table(BY_ID)?;
            tx.delete_table(BY_SORT)?;
            tx.delete_table(BY_PATH)?;
            let _ = tx.open_table(BY_ID)?;
            let _ = tx.open_table(BY_SORT)?;
            let _ = tx.open_table(BY_PATH)?;
        }
        tx.commit()?;
        Ok(())
    }
}

/// Encode a sort key: 8 bytes (inverted timestamp) ++ 16 bytes (inverted id),
/// so ascending byte order is newest-first.
fn encode_sort(updated_at: OffsetDateTime, id: MemoId) -> [u8; 24] {
    let mut out = [0u8; 24];
    let nanos = updated_at.unix_timestamp_nanos();
    let clamped = nanos.clamp(0, i64::MAX as i128) as i64;
    let inv_ts = i64::MAX - clamped;
    out[..8].copy_from_slice(&inv_ts.to_be_bytes());
    let uuid = id.as_uuid();
    let id_bytes = uuid.as_bytes();
    for (i, b) in id_bytes.iter().enumerate() {
        out[8 + i] = !b;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn rec(id: MemoId, ts: OffsetDateTime) -> IndexRecord {
        IndexRecord {
            id,
            created_at: ts,
            updated_at: ts,
            hash: MemoHash::new("deadbeef"),
            favorite: false,
            path: "test.md".to_string(),
            title: None,
            tags: vec![],
            props: Default::default(),
            deleted: false,
            deleted_at: None,
            preview: String::new(),
            tasks: Vec::new(),
            tasks_truncated: false,
        }
    }

    fn open_tmp() -> (TempDir, RedbIndex) {
        let dir = TempDir::new().unwrap();
        let idx = RedbIndex::open(&dir.path().join("meta.redb")).unwrap();
        (dir, idx)
    }

    #[test]
    fn upsert_get_remove() {
        let (_t, idx) = open_tmp();
        let id = MemoId::now();
        let r = rec(id, OffsetDateTime::now_utc());
        idx.upsert(&r).unwrap();
        assert_eq!(idx.get(id).unwrap().unwrap().id, id);
        idx.remove(id).unwrap();
        assert!(idx.get(id).unwrap().is_none());
    }

    #[test]
    fn id_for_path_tracks_live_and_trash_rows_per_path() {
        let (_t, idx) = open_tmp();
        let live = MemoId::now();
        let mut live_rec = rec(live, OffsetDateTime::now_utc());
        live_rec.path = "notes/x.md".into();
        idx.upsert(&live_rec).unwrap();
        assert_eq!(idx.id_for_path("notes/x.md").unwrap(), Some(vec![live]));

        // A tombstoned trash copy with a different id claims the same
        // stripped path; both ids are returned.
        let trashed = MemoId::now();
        let mut trash_rec = rec(trashed, OffsetDateTime::now_utc());
        trash_rec.path = "notes/x.md".into();
        trash_rec.deleted = true;
        idx.upsert(&trash_rec).unwrap();
        let mut ids = idx.id_for_path("notes/x.md").unwrap().unwrap();
        ids.sort();
        assert_eq!(ids, vec![live, trashed]);

        // An untracked path is known-empty once the table is populated.
        assert_eq!(idx.id_for_path("notes/other.md").unwrap(), Some(Vec::new()));

        // Renaming a path moves the id between path keys.
        live_rec.path = "notes/y.md".into();
        idx.upsert(&live_rec).unwrap();
        assert_eq!(idx.id_for_path("notes/y.md").unwrap(), Some(vec![live]));
        assert_eq!(idx.id_for_path("notes/x.md").unwrap(), Some(vec![trashed]));

        // Removal clears the path entry when its last id goes away.
        idx.remove(trashed).unwrap();
        assert_eq!(idx.id_for_path("notes/x.md").unwrap(), Some(Vec::new()));
        idx.remove(live).unwrap();
        assert_eq!(idx.id_for_path("notes/y.md").unwrap(), Some(Vec::new()));
    }

    fn append_truncated_path_id(idx: &RedbIndex, path: &str) {
        let tx = idx.db.begin_write().unwrap();
        {
            let mut by_path = tx.open_table(BY_PATH).unwrap();
            let mut value = by_path.get(path).unwrap().unwrap().value().to_vec();
            value.push(0xff);
            by_path.insert(path, value.as_slice()).unwrap();
        }
        tx.commit().unwrap();
    }

    #[test]
    fn path_lookup_and_updates_tolerate_truncated_id_lists() {
        let (_t, idx) = open_tmp();
        let now = OffsetDateTime::now_utc();
        let path = "notes/shared.md";
        let mut first = rec(MemoId::now(), now);
        first.path = path.into();
        let mut second = rec(MemoId::now(), now);
        second.path = path.into();
        idx.upsert(&first).unwrap();
        idx.upsert(&second).unwrap();

        append_truncated_path_id(&idx, path);
        let mut ids = idx.id_for_path(path).unwrap().unwrap();
        ids.sort();
        let mut expected = vec![first.id, second.id];
        expected.sort();
        assert_eq!(ids, expected);

        let mut third = rec(MemoId::now(), now);
        third.path = path.into();
        idx.upsert(&third).unwrap();
        let mut ids = idx.id_for_path(path).unwrap().unwrap();
        ids.sort();
        expected.push(third.id);
        expected.sort();
        assert_eq!(ids, expected);

        append_truncated_path_id(&idx, path);
        idx.remove(first.id).unwrap();
        expected.retain(|id| *id != first.id);
        assert_eq!(idx.id_for_path(path).unwrap(), Some(expected));
    }

    /// Seed a legacy-schema database (BY_ID rows only, no BY_PATH) the
    /// way a pre-`by_path` oximemo vault looks on disk.
    fn seed_legacy_db(path: &std::path::Path, recs: &[IndexRecord]) {
        let db = redb::Database::create(path).unwrap();
        let tx = db.begin_write().unwrap();
        {
            let mut by_id = tx.open_table(BY_ID).unwrap();
            let mut by_sort = tx.open_table(BY_SORT).unwrap();
            for rec in recs {
                let id = rec.id.as_uuid();
                let id_slice: &[u8] = id.as_bytes();
                by_id
                    .insert(id_slice, serde_json::to_vec(rec).unwrap().as_slice())
                    .unwrap();
                let sort_key = encode_sort(rec.updated_at, rec.id);
                by_sort.insert(sort_key.as_slice(), id_slice).unwrap();
            }
        }
        tx.commit().unwrap();
    }

    #[test]
    fn legacy_index_backfills_by_path_atomically_on_open() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("meta.redb");
        let base = OffsetDateTime::now_utc();
        let mut untouched = rec(MemoId::now(), base);
        untouched.path = "notes/untouched.md".into();
        let mut renamed = rec(MemoId::now(), base + time::Duration::seconds(1));
        renamed.path = "notes/old.md".into();
        seed_legacy_db(&path, &[untouched.clone(), renamed.clone()]);

        let idx = RedbIndex::open(&path).unwrap();

        // Every legacy record is visible through by_path right after open,
        // including paths that are never touched afterwards.
        assert_eq!(
            idx.id_for_path("notes/untouched.md").unwrap(),
            Some(vec![untouched.id])
        );
        assert_eq!(
            idx.id_for_path("notes/old.md").unwrap(),
            Some(vec![renamed.id])
        );
        // Known-untracked, not a legacy unknown.
        assert_eq!(idx.id_for_path("notes/never.md").unwrap(), Some(Vec::new()));

        // One path updated: the id moves to the new path key.
        renamed.path = "notes/new.md".into();
        idx.upsert(&renamed).unwrap();
        assert_eq!(idx.id_for_path("notes/old.md").unwrap(), Some(Vec::new()));
        assert_eq!(
            idx.id_for_path("notes/new.md").unwrap(),
            Some(vec![renamed.id])
        );

        // Deleting the record that was never updated clears its path entry.
        idx.remove(untouched.id).unwrap();
        assert_eq!(
            idx.id_for_path("notes/untouched.md").unwrap(),
            Some(Vec::new())
        );
        assert_eq!(
            idx.id_for_path("notes/new.md").unwrap(),
            Some(vec![renamed.id])
        );
    }

    #[test]
    fn legacy_backfill_skips_corrupt_by_id_rows() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("meta.redb");
        let valid = rec(MemoId::now(), OffsetDateTime::now_utc());
        let corrupt_id = MemoId::now();
        {
            let db = redb::Database::create(&path).unwrap();
            let tx = db.begin_write().unwrap();
            {
                let mut by_id = tx.open_table(BY_ID).unwrap();
                let _by_sort = tx.open_table(BY_SORT).unwrap();
                let valid_id = valid.id.as_uuid();
                let valid_id_bytes: &[u8] = valid_id.as_bytes();
                let valid_bytes = serde_json::to_vec(&valid).unwrap();
                by_id
                    .insert(valid_id_bytes, valid_bytes.as_slice())
                    .unwrap();
                let corrupt_uuid = corrupt_id.as_uuid();
                let corrupt_bytes: &[u8] = corrupt_uuid.as_bytes();
                by_id.insert(corrupt_bytes, b"not-json".as_slice()).unwrap();
            }
            tx.commit().unwrap();
        }

        let idx = RedbIndex::open(&path).unwrap();
        assert_eq!(idx.id_for_path(&valid.path).unwrap(), Some(vec![valid.id]));
    }

    #[test]
    fn opens_v2_file_by_upgrading_in_place() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("meta.redb");
        let record = rec(MemoId::now(), OffsetDateTime::now_utc());
        // Seed a v2-format file the way every oximemo release to date
        // wrote it: redb 2.6, which defaults new databases to v2.
        {
            const BY_ID2: redb2::TableDefinition<&[u8], &[u8]> =
                redb2::TableDefinition::new("by_id");
            const BY_SORT2: redb2::TableDefinition<&[u8], &[u8]> =
                redb2::TableDefinition::new("by_sort");
            let db = redb2::Database::create(&path).unwrap();
            let tx = db.begin_write().unwrap();
            {
                let mut by_id = tx.open_table(BY_ID2).unwrap();
                let mut by_sort = tx.open_table(BY_SORT2).unwrap();
                let id = record.id.as_uuid();
                let id_bytes: &[u8] = id.as_bytes();
                let value = serde_json::to_vec(&record).unwrap();
                by_id.insert(id_bytes, value.as_slice()).unwrap();
                let sort_key = encode_sort(record.updated_at, record.id);
                by_sort.insert(sort_key.as_slice(), id_bytes).unwrap();
            }
            tx.commit().unwrap();
        }
        // redb 3 alone would hard-reject this file; RedbIndex::open hops
        // it to v3 transparently and the data survives.
        let idx = RedbIndex::open(&path).unwrap();
        let stored = idx.get(record.id).unwrap().expect("legacy row survives");
        assert_eq!(stored.path, "test.md");
        assert_eq!(idx.id_for_path("test.md").unwrap(), Some(vec![record.id]));
        // Idempotent: a second open finds v3 and skips the hop. The
        // first handle must be dropped first — redb locks the file.
        drop(idx);
        let _again = RedbIndex::open(&path).unwrap();
    }
    #[test]
    fn list_is_newest_first_with_pagination() {
        let (_t, idx) = open_tmp();
        let base = OffsetDateTime::now_utc();
        let ids: Vec<MemoId> = (0..5).map(|_| MemoId::now()).collect();
        for (i, id) in ids.iter().enumerate() {
            idx.upsert(&rec(*id, base + time::Duration::seconds(i as i64)))
                .unwrap();
        }
        let page = idx.list(None, 3, &MemoFilter::default()).unwrap();
        assert_eq!(page.len(), 3);
        // newest first: last-inserted (largest ts) comes first
        assert_eq!(page[0].id, *ids.last().unwrap());
        let cursor = Cursor {
            updated_at: page[2].updated_at,
            id: page[2].id,
        };
        let next = idx.list(Some(cursor), 3, &MemoFilter::default()).unwrap();
        assert_eq!(next.len(), 2);
    }
    #[test]
    fn deserializes_legacy_pinned_and_missing_favorite() {
        // Pre-release vaults stored the favorite flag as `pinned`; redb index
        // records were serialized as JSON with a `pinned` field. The alias +
        // default make old records load. Old `category` field is ignored;
        // missing `path`/`title` default to empty/None.
        let legacy_pinned = r#"{"id":"019fa927-a897-7e12-9102-8a8c7ebbb594","created_at":"2026-07-01T00:00:00Z","updated_at":"2026-07-01T00:00:00Z","hash":"b3:abc","pinned":true,"category":"inbox","tags":[],"deleted":false,"deleted_at":null,"preview":""}"#;
        let rec: IndexRecord = serde_json::from_str(legacy_pinned).unwrap();
        assert!(rec.favorite);

        let no_flag = r#"{"id":"019fa927-a897-7e12-9102-8a8c7ebbb594","created_at":"2026-07-01T00:00:00Z","updated_at":"2026-07-01T00:00:00Z","hash":"b3:abc","category":"inbox","tags":[],"deleted":false,"deleted_at":null,"preview":""}"#;
        let rec: IndexRecord = serde_json::from_str(no_flag).unwrap();
        assert!(!rec.favorite);
    }
}
