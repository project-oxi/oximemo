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

use redb::{ReadableTable, ReadableTableMetadata};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::error::Result;
use crate::note::{Cursor, NoteFilter, NoteHash, NoteId, NoteSummary};

const BY_ID: redb::TableDefinition<&[u8], &[u8]> = redb::TableDefinition::new("by_id");
const BY_SORT: redb::TableDefinition<&[u8], &[u8]> = redb::TableDefinition::new("by_sort");

/// A note's indexed metadata (no body). Stored as the index value.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexRecord {
    pub id: NoteId,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
    pub hash: NoteHash,
    pub pinned: bool,
    pub color: crate::note::NoteColor,
    #[serde(default)]
    pub tags: Vec<String>,
    pub deleted: bool,
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub deleted_at: Option<OffsetDateTime>,
    /// Cached card preview (derived from body) so listings avoid file reads.
    pub preview: String,
}

impl IndexRecord {
    pub fn to_summary(&self) -> NoteSummary {
        NoteSummary {
            id: self.id,
            created_at: self.created_at,
            updated_at: self.updated_at,
            hash: self.hash.clone(),
            pinned: self.pinned,
            color: self.color.clone(),
            tags: self.tags.clone(),
            preview: self.preview.clone(),
            deleted: self.deleted,
        }
    }
}

/// Swappable storage boundary (§5.1). A future SQLite+FTS5 backend implements
/// this same trait.
pub trait NoteIndex: Send + Sync {
    fn upsert(&self, rec: &IndexRecord) -> Result<()>;
    fn remove(&self, id: NoteId) -> Result<()>;
    fn get(&self, id: NoteId) -> Result<Option<IndexRecord>>;
    /// Cursor-paginated, newest-first listing with in-memory filter.
    fn list(
        &self,
        after: Option<Cursor>,
        limit: u32,
        filter: &NoteFilter,
    ) -> Result<Vec<IndexRecord>>;
    /// Notes with `updated_at >= since` (newest-first). `None` = all notes.
    fn export_since(&self, since: Option<OffsetDateTime>) -> Result<Vec<IndexRecord>>;
    fn count(&self) -> Result<u64>;
    fn clear(&self) -> Result<()>;
}

/// `redb`-backed [`NoteIndex`].
pub struct RedbIndex {
    db: redb::Database,
}

impl RedbIndex {
    /// Open (creating) the index database. Caller is responsible for the
    /// cross-process advisory lock (§5.7) around open + use.
    pub fn open(path: &std::path::Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let db = redb::Database::create(path)?;
        let tx = db.begin_write()?;
        {
            let _ = tx.open_table(BY_ID)?;
            let _ = tx.open_table(BY_SORT)?;
        }
        tx.commit()?;
        Ok(Self { db })
    }
}

impl NoteIndex for RedbIndex {
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

    fn remove(&self, id: NoteId) -> Result<()> {
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

    fn get(&self, id: NoteId) -> Result<Option<IndexRecord>> {
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
        filter: &NoteFilter,
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
fn encode_sort(updated_at: OffsetDateTime, id: NoteId) -> [u8; 24] {
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
    use crate::note::NoteColor;
    use tempfile::TempDir;

    fn rec(id: NoteId, ts: OffsetDateTime) -> IndexRecord {
        IndexRecord {
            id,
            created_at: ts,
            updated_at: ts,
            hash: NoteHash::new("deadbeef"),
            pinned: false,
            color: NoteColor::NONE,
            tags: vec![],
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
        let id = NoteId::now();
        let r = rec(id, OffsetDateTime::now_utc());
        idx.upsert(&r).unwrap();
        assert_eq!(idx.get(id).unwrap().unwrap().id, id);
        idx.remove(id).unwrap();
        assert!(idx.get(id).unwrap().is_none());
    }
    #[test]
    fn list_is_newest_first_with_pagination() {
        let (_t, idx) = open_tmp();
        let base = OffsetDateTime::now_utc();
        let ids: Vec<NoteId> = (0..5).map(|_| NoteId::now()).collect();
        for (i, id) in ids.iter().enumerate() {
            idx.upsert(&rec(*id, base + time::Duration::seconds(i as i64)))
                .unwrap();
        }
        let page = idx.list(None, 3, &NoteFilter::default()).unwrap();
        assert_eq!(page.len(), 3);
        // newest first: last-inserted (largest ts) comes first
        assert_eq!(page[0].id, *ids.last().unwrap());
        let cursor = Cursor {
            updated_at: page[2].updated_at,
            id: page[2].id,
        };
        let next = idx.list(Some(cursor), 3, &NoteFilter::default()).unwrap();
        assert_eq!(next.len(), 2);
    }
}
