//! Synchronization records and the dedup algorithm (§9.2).
//!
//! Two projections of a note:
//! - [`ManifestRecord`]: lightweight (no body) — the agent diffs against its
//!   local `id → hash` cache to decide what changed.
//! - [`FullRecord`]: the complete note body, requested only for ids the diff
//!   flagged as "needs fetch".
//!
//! [`diff_manifest`] implements the agent-side dedup so callers (and tests) can
//! reason about it without the CLI.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::note::{Memo, MemoHash, MemoId};

/// Lightweight manifest entry: identity + content hash + timestamp + tombstone.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestRecord {
    pub id: MemoId,
    pub hash: MemoHash,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
    pub deleted: bool,
}

impl ManifestRecord {
    pub fn from_note(n: &Memo) -> Self {
        Self {
            id: n.id,
            hash: n.hash.clone(),
            updated_at: n.updated_at,
            deleted: n.deleted_at.is_some(),
        }
    }
}

/// Full note payload, returned for ids flagged by the diff.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FullRecord {
    pub id: MemoId,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
    pub hash: MemoHash,
    pub pinned: bool,
    pub category: String,
    pub tags: Vec<String>,
    pub body: String,
    pub deleted: bool,
}

impl FullRecord {
    pub fn from_note(n: &Memo) -> Self {
        Self {
            id: n.id,
            created_at: n.created_at,
            updated_at: n.updated_at,
            hash: n.hash.clone(),
            pinned: n.pinned,
            category: n.category.clone(),
            tags: n.tags.clone(),
            body: n.body.clone(),
            deleted: n.deleted_at.is_some(),
        }
    }
}

/// Result of diffing a manifest against a local cache (§9.2, steps 3–4).
#[derive(Debug, Clone, Default)]
pub struct ManifestDiff {
    /// New or content-changed ids the caller should fetch in full.
    pub to_fetch: Vec<MemoId>,
    /// Tombstoned ids the caller should drop from its local cache.
    pub to_drop: Vec<MemoId>,
    /// Max `updated_at` across the manifest, for advancing the cursor.
    pub max_updated_at: Option<OffsetDateTime>,
}

/// `known` maps `id (hyphenated) → hash ("b3:…")`, exactly what an agent caches.
pub fn diff_manifest(manifest: &[ManifestRecord], known: &HashMap<String, String>) -> ManifestDiff {
    let mut diff = ManifestDiff::default();
    for rec in manifest {
        let key = rec.id.to_string();
        // Tombstones are signaled explicitly and must propagate regardless of
        // whether the agent's cached hash still matches (a soft-delete can leave
        // the body hash unchanged while `deleted` flips).
        if rec.deleted {
            diff.to_drop.push(rec.id);
        } else {
            match known.get(&key) {
                Some(h) if *h == rec.hash.0 => { /* unchanged */ }
                _ => diff.to_fetch.push(rec.id),
            }
        }
        diff.max_updated_at = Some(match diff.max_updated_at {
            Some(t) if t >= rec.updated_at => t,
            None => rec.updated_at,
            Some(_) => rec.updated_at,
        });
    }
    diff
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn note(body: &str, hash: &str) -> Memo {
        let id = MemoId::now();
        let now = OffsetDateTime::now_utc();
        Memo {
            id,
            created_at: now,
            updated_at: now,
            hash: MemoHash::from_stored(hash),
            pinned: false,
            category: String::new(),
            tags: vec![],
            body: body.into(),
            deleted_at: None,
        }
    }

    #[test]
    fn unchanged_skipped_changed_fetched() {
        let a = note("a", "b3:1");
        let b = note("b", "b3:2");
        let manifest = vec![ManifestRecord::from_note(&a), ManifestRecord::from_note(&b)];
        let mut known = HashMap::new();
        known.insert(a.id.to_string(), "b3:1".to_string()); // a unchanged
        known.insert(b.id.to_string(), "b3:OLD".to_string()); // b changed
        let diff = diff_manifest(&manifest, &known);
        assert_eq!(diff.to_fetch, vec![b.id]);
        assert!(diff.to_drop.is_empty());
    }

    #[test]
    fn deleted_dropped() {
        let mut n = note("c", "b3:3");
        n.deleted_at = Some(OffsetDateTime::now_utc());
        let manifest = vec![ManifestRecord::from_note(&n)];
        let known = HashMap::from([(n.id.to_string(), "b3:3".to_string())]);
        let diff = diff_manifest(&manifest, &known);
        assert!(diff.to_fetch.is_empty());
        assert_eq!(diff.to_drop, vec![n.id]);
    }
}
