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

const BY_ID: redb::TableDefinition<&[u8], &[u8]> = redb::TableDefinition::new("by_id");
const BY_SORT: redb::TableDefinition<&[u8], &[u8]> = redb::TableDefinition::new("by_sort");

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
            if has_by_id && has_by_sort {
                return Ok(Self { db });
            }
        }
        // Fresh DB or a partial schema from an interrupted first-open:
        // run the one-time creation transaction so both tables exist
        // before subsequent code paths assume they do.
        let tx = db.begin_write()?;
        let _ = tx.open_table(BY_ID)?;
        let _ = tx.open_table(BY_SORT)?;
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
            for rec in recs {
                let uuid = rec.id.as_uuid();
                let id_slice: &[u8] = uuid.as_bytes();
                let sort_key = encode_sort(rec.updated_at, rec.id);
                let value = serde_json::to_vec(rec)?;
                if let Some(prev) = by_id.get(id_slice)? {
                    let prev_rec: IndexRecord = serde_json::from_slice(prev.value())?;
                    let prev_key = encode_sort(prev_rec.updated_at, prev_rec.id);
                    by_sort.remove(&prev_key[..])?;
                }
                by_id.insert(id_slice, value.as_slice())?;
                by_sort.insert(sort_key.as_slice(), id_slice)?;
            }
        }
        tx.commit()?;
        Ok(())
    }
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
            // A previous sort key may exist for this id (updated_at may have
            // changed); remove it before inserting the fresh one.
            if let Some(prev) = by_id.get(id_slice)? {
                let prev_rec: IndexRecord = serde_json::from_slice(prev.value())?;
                let prev_key = encode_sort(prev_rec.updated_at, prev_rec.id);
                by_sort.remove(&prev_key[..])?;
            }
            by_id.insert(id_slice, value.as_slice())?;
            by_sort.insert(sort_key.as_slice(), id_slice)?;
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
            if let Some(prev) = by_id.get(id_slice)? {
                let prev_rec: IndexRecord = serde_json::from_slice(prev.value())?;
                let prev_key = encode_sort(prev_rec.updated_at, prev_rec.id);
                by_sort.remove(&prev_key[..])?;
            }
            by_id.remove(id_slice)?;
        }
        tx.commit()?;
        Ok(())
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
            let _ = tx.open_table(BY_ID)?;
            let _ = tx.open_table(BY_SORT)?;
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
    fn opens_v2_file_by_upgrading_in_place() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("meta.redb");
        // Seed a v2-format file the way every oximemo release to date
        // wrote it: redb 2.6, which defaults new databases to v2.
        {
            const BY_ID2: redb2::TableDefinition<&[u8], &[u8]> =
                redb2::TableDefinition::new("by_id");
            let db = redb2::Database::create(&path).unwrap();
            let tx = db.begin_write().unwrap();
            {
                let mut t = tx.open_table(BY_ID2).unwrap();
                t.insert(b"k1".as_slice(), b"v1".as_slice()).unwrap();
            }
            tx.commit().unwrap();
        }
        // redb 3 alone would hard-reject this file; RedbIndex::open hops
        // it to v3 transparently and the data survives.
        let idx = RedbIndex::open(&path).unwrap();
        let tx = idx.db.begin_read().unwrap();
        let t = tx.open_table(BY_ID).unwrap();
        assert_eq!(t.get(b"k1".as_slice()).unwrap().unwrap().value(), b"v1");
        // Idempotent: a second open finds v3 and skips the hop. The
        // first handle must be dropped first — redb locks the file.
        drop(t);
        drop(tx);
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
