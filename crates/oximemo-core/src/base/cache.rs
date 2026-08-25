//! Bounded LRU cache for evaluated [`super::BaseResult`]s (Task 10).
//!
//! The cache key is a [`ResultKey`]: a content fingerprint covering the
//! source's identity (blake3 of the `.query` file's raw bytes for a Path
//! source, blake3 of `write_base`'s YAML output for an Inline source),
//! the view index, the snapshot generation (the `(mtime, size)` of
//! `meta.redb` observed after `snapshot()` populated its own cache),
//! the pinned clock (`now_ms` + `local_offset_seconds`), and the
//! `group_counts` / `summaries` request flags. The `group` paging
//! field is intentionally **not** in the key — the cached value holds
//! the full dataset (capped at the view's hard `limit`), and
//! `group`/`offset`/`limit` page slices are derived from it on each
//! hit.
//!
//! The cap is 16 entries (spec §3 result-cache budget). Plain
//! `HashMap` + `VecDeque` is plenty at that size — no `lru` crate
//! dependency. The cache is wrapped in a `parking_lot::Mutex` and
//! lazily populated by [`crate::vault::Vault::run_base`].
//!
//! Invalidation rules (see also [`crate::vault::Vault`]):
//! - **meta.redb generation change** — natural miss because
//!   `generation` is in the key.
//! - **`.query` file save/rename/trash/restore** — natural miss for
//!   Path sources because `source_hash` is the file's bytes (a save
//!   changes content).
//! - **belt-and-suspenders** — `invalidate_base_caches` also clears
//!   the result cache, in case file-stat granularity ever lags an
//!   external edit.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::Arc;
use std::time::SystemTime;

use parking_lot::Mutex;

use crate::base::exec::{BaseRow, GroupCount, PropInfo, SummaryValue};

/// Maximum number of cached entries (spec §3: result LRU ≤ 16 keys).
const RESULT_CACHE_CAP: usize = 16;

/// Result-cache memory budget (spec §3: ≤ 64 MiB total).
const RESULT_CACHE_BUDGET_BYTES: usize = 64 * 1024 * 1024;

/// Estimated heap bytes per cached row. The whole-branch review probe
/// (2026-08-25) measured ~1.7 KiB for a realistic row (summary +
/// folder + cells); rounded up to 2 KiB for headroom.
const EST_BYTES_PER_ROW: usize = 2048;

/// Per-entry row cap, derived from the budget so a fully warm cache
/// stays inside spec §3's 64 MiB: BUDGET / RESULT_CACHE_CAP /
/// EST_BYTES_PER_ROW. A run_base whose kept-row count exceeds this is
/// still computed fresh but returned UNCACHED (same shape as
/// `snapshot()`'s `> SNAPSHOT_CACHE_CAP` bypass). The previous flat
/// 20_000-row cap bounded only entry count, not bytes — 16 entries ×
/// 20k realistic rows ≈ 500+ MiB, ten times the budget. This is
/// still a count-based approximation; true byte accounting is
/// deferred to Plan B profiling.
pub(crate) const RESULT_CACHE_ROW_CAP: usize =
    RESULT_CACHE_BUDGET_BYTES / RESULT_CACHE_CAP / EST_BYTES_PER_ROW;

/// Content fingerprint for one `run_base` result.
///
/// `source_hash` is the blake3 digest (first 8 bytes, big-endian) of:
/// - the `.query` file's raw bytes for `BaseSource::Path` (read once
///   per request so a save always misses even if the YAML is
///   byte-identical to the previous read — mtime alone is brittle),
/// - `write_base`'s YAML output for `BaseSource::Inline`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ResultKey {
    pub source_hash: u64,
    pub view_index: usize,
    /// `(meta.redb mtime, meta.redb size)` observed after `snapshot()`
    /// populated its own cache. Used verbatim in the rendered
    /// `result_key` string.
    pub generation: (SystemTime, u64),
    pub clock_ms: i64,
    pub local_offset_seconds: i32,
    pub group_counts: bool,
    pub summaries: bool,
    /// Embed scope id — two embeds of the same `.query` in one session
    /// (spec §6) resolve `this.note.*` against different rows, so
    /// they MUST be different keys. Absent for full-screen Path/Inline.
    pub this_id: Option<crate::memo::MemoId>,
}

/// Reserved `source_hash` for the `base_props` catalog entry (Task 11).
/// Real run_base keys are blake3 content digests; 0 marks the one
/// synthetic entry so it can never collide with a page result.
pub(crate) const PROPS_SOURCE_HASH: u64 = 0;

/// Fixed synthetic key under which [`crate::vault::Vault::base_props`]
/// caches its catalog. Every field except `generation` is constant, so
/// an unchanged index is a hit and any index write (which changes the
/// generation) is a natural miss — no separate invalidation path.
pub(crate) fn props_result_key(generation: (SystemTime, u64)) -> ResultKey {
    ResultKey {
        source_hash: PROPS_SOURCE_HASH,
        view_index: 0,
        generation,
        clock_ms: 0,
        local_offset_seconds: 0,
        group_counts: false,
        summaries: false,
        this_id: None,
    }
}

/// One evaluated result: the full dataset (capped at the view's hard
/// `limit`), the aggregate counts and summaries over that dataset,
/// and the warnings collected during evaluation. Group paging slices
/// `rows` on each hit; the cap is applied once at cache-miss time.
#[derive(Debug, Clone)]
pub struct BaseResult {
    pub rows: Vec<BaseRow>,
    /// Canonical group bucket per row (`""` = 그룹 없음), parallel to
    /// `rows`. Needed because a board's group slice filters by this
    /// value, but `rows` don't carry it (it lives only on the kept
    /// index during execution).
    pub group_strs: Vec<String>,
    pub total: usize,
    pub group_counts: Option<Vec<GroupCount>>,
    pub summaries: Option<BTreeMap<String, SummaryValue>>,
    /// Validation + eval warnings — surfaced verbatim on every cache
    /// hit so callers cannot tell a hit from a fresh run (binding
    /// ruling: "cache hits must be indistinguishable from fresh
    /// runs").
    pub warnings: Vec<String>,
    /// Observed property catalog — set only on the synthetic
    /// `base_props` entry (Task 11; see [`props_result_key`]). `None`
    /// for every page result.
    pub props: Option<Vec<PropInfo>>,
}

/// Bounded LRU cache. LRU = least-recently **inserted**; the brief's
/// "oldest evicted, recent retained" only requires that re-`put`-ing
/// under the cap does not churn, and a put-evict cycle below the cap
/// does not evict.
#[allow(dead_code)]
pub struct BaseResultCache {
    map: HashMap<ResultKey, Arc<BaseResult>>,
    /// Insertion order. `back()` is the most-recently inserted;
    /// `front()` is the next eviction candidate.
    order: VecDeque<ResultKey>,
}

impl Default for BaseResultCache {
    fn default() -> Self {
        Self::new()
    }
}

#[allow(dead_code)]
impl BaseResultCache {
    pub fn new() -> Self {
        Self {
            map: HashMap::with_capacity(RESULT_CACHE_CAP),
            order: VecDeque::with_capacity(RESULT_CACHE_CAP),
        }
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    pub fn get(&self, key: &ResultKey) -> Option<Arc<BaseResult>> {
        self.map.get(key).map(Arc::clone)
    }

    /// Insert; if `key` already exists the entry is replaced and the
    /// order list keeps the original position (no churn). When the
    /// cap is exceeded the oldest insertion is evicted.
    pub fn put(&mut self, key: ResultKey, result: Arc<BaseResult>) {
        if self.map.contains_key(&key) {
            // Re-put under the cap: refresh the value but preserve
            // insertion order so a tight loop does not churn entries.
            self.map.insert(key, result);
            return;
        }
        if self.map.len() >= RESULT_CACHE_CAP
            && let Some(oldest) = self.order.pop_front()
        {
            self.map.remove(&oldest);
        }
        self.order.push_back(key.clone());
        self.map.insert(key, result);
    }

    /// Drop every entry. Called from `Vault::invalidate_base_caches`.
    pub fn clear_all(&mut self) {
        self.map.clear();
        self.order.clear();
    }
}

/// blake3 of the first 8 bytes (big-endian) of `bytes`. 64 bits is
/// ample collision resistance for a single user's result cache (max
/// 16 entries); the spec's `HASH_LEN` for assets uses 64 bits too.
pub(crate) fn blake3_u64(bytes: &[u8]) -> u64 {
    let mut h = blake3::Hasher::new();
    h.update(bytes);
    let digest = h.finalize();
    let raw = digest.as_bytes();
    u64::from_be_bytes([
        raw[0], raw[1], raw[2], raw[3], raw[4], raw[5], raw[6], raw[7],
    ])
}

/// Stable, human-readable rendering of a [`ResultKey`] for the
/// `BasePage.result_key` field. Format:
/// `<source_hash:016x>-v<view>-g<mtime_secs>.<mtime_nanos:09>.<size>.<this_id>-c<clock_ms>.<offset>-f<flags>`
/// Sub-second mtime precision and `this_id` are included so two writes
/// within the same second and two embeds of the same `.query` in the
/// same session render distinct strings — both surface as stale
/// widgets (spec §6) if collapsed.
pub fn render_result_key(k: &ResultKey) -> String {
    let (secs, nanos) = k
        .generation
        .0
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| (d.as_secs(), d.subsec_nanos()))
        .unwrap_or((0, 0));
    let mut flags = 0u8;
    if k.group_counts {
        flags |= 1 << 0;
    }
    if k.summaries {
        flags |= 1 << 1;
    }
    let this_tag = match k.this_id {
        Some(id) => format!(".{}{}", k.generation.1, id.as_uuid().simple()),
        None => format!(".{}", k.generation.1),
    };
    format!(
        "{:016x}-v{}-g{}.{:09}{}-c{}.{}-f{}",
        k.source_hash, k.view_index, secs, nanos, this_tag,
        k.clock_ms, k.local_offset_seconds, flags
    )
}

/// Thread-safe handle used by [`crate::vault::Vault`]. Holds the
/// `parking_lot::Mutex` so callers don't have to wrap it again.
#[derive(Default)]
pub struct SharedResultCache {
    inner: Mutex<BaseResultCache>,
}

#[allow(dead_code)]
impl SharedResultCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.inner.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.inner.lock().is_empty()
    }

    pub fn get(&self, key: &ResultKey) -> Option<Arc<BaseResult>> {
        self.inner.lock().get(key)
    }

    pub fn put(&self, key: ResultKey, result: Arc<BaseResult>) {
        self.inner.lock().put(key, result);

    }

    pub fn clear_all(&self) {
        self.inner.lock().clear_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memo::{MemoHash, MemoId, MemoSummary};
    use time::OffsetDateTime;

    fn empty_result(n: usize) -> Arc<BaseResult> {
        Arc::new(BaseResult {
            rows: (0..n).map(|_| empty_row()).collect(),
            group_strs: vec![String::new(); n],
            total: n,
            group_counts: None,
            summaries: None,
            warnings: Vec::new(),
            props: None,
        })
    }

    fn empty_row() -> BaseRow {
        BaseRow {
            summary: empty_summary(),
            folder: String::new(),
            format: "md".to_string(),
            cells: Vec::new(),
        }
    }

    fn empty_summary() -> MemoSummary {
        MemoSummary {
            id: MemoId(uuid::Uuid::nil()),
            created_at: OffsetDateTime::UNIX_EPOCH,
            updated_at: OffsetDateTime::UNIX_EPOCH,
            hash: MemoHash::new(""),
            favorite: false,
            title: None,
            path: String::new(),
            tags: Vec::new(),
            props: Default::default(),
            preview: String::new(),
            deleted: false,
        }
    }

    fn key(h: u64, v: usize) -> ResultKey {
        ResultKey {
            source_hash: h,
            view_index: v,
            generation: (SystemTime::UNIX_EPOCH, 0),
            clock_ms: 0,
            local_offset_seconds: 0,
            group_counts: false,
            summaries: false,
            this_id: None,
        }
    }

    #[test]
    fn lru_evicts_oldest_above_cap() {
        let mut c = BaseResultCache::new();
        for i in 0..RESULT_CACHE_CAP {
            c.put(key(i as u64, 0), empty_result(1));
        }
        assert_eq!(c.len(), RESULT_CACHE_CAP);
        // 17th distinct insert evicts key(0,0).
        c.put(key(99, 0), empty_result(1));
        assert_eq!(c.len(), RESULT_CACHE_CAP);
        assert!(c.get(&key(0, 0)).is_none(), "oldest evicted");
        assert!(c.get(&key(1, 0)).is_some(), "second entry retained");
        assert!(c.get(&key(99, 0)).is_some(), "newest retained");
    }

    #[test]
    fn re_put_does_not_evict() {
        let mut c = BaseResultCache::new();
        for i in 0..RESULT_CACHE_CAP {
            c.put(key(i as u64, 0), empty_result(1));
        }
        // Re-put the oldest: must NOT evict a fresh insert.
        c.put(key(0, 0), empty_result(2));
        assert_eq!(c.len(), RESULT_CACHE_CAP);
        assert!(c.get(&key(0, 0)).is_some(), "re-put oldest preserved");
        assert!(c.get(&key(15, 0)).is_some(), "newest still present");
    }

    #[test]
    fn render_is_stable_and_distinguishes_fields() {
        let k = ResultKey {
            source_hash: 0xdead_beef,
            view_index: 3,
            generation: (SystemTime::UNIX_EPOCH, 42),
            clock_ms: 100,
            local_offset_seconds: 9 * 3600,
            group_counts: true,
            summaries: false,
            this_id: None,
        };
        let s = render_result_key(&k);
        assert!(s.starts_with("00000000deadbeef-v3-g0.000000000.42-c100.32400-f1"));
        let k2 = ResultKey {
            summaries: true,
            ..k.clone()
        };
        assert_ne!(s, render_result_key(&k2));
    }

    #[test]
    fn render_distinguishes_subsecond_and_this_id() {
        let base = ResultKey {
            source_hash: 1,
            view_index: 0,
            generation: (
                SystemTime::UNIX_EPOCH + std::time::Duration::new(5, 100),
                7,
            ),
            clock_ms: 0,
            local_offset_seconds: 0,
            group_counts: false,
            summaries: false,
            this_id: None,
        };
        let s = render_result_key(&base);
        // Same second, different nanos → distinct strings (spec §6:
        // same-second writes must not alias the widget key).
        let nanos = ResultKey {
            generation: (
                SystemTime::UNIX_EPOCH + std::time::Duration::new(5, 101),
                7,
            ),
            ..base.clone()
        };
        assert_ne!(s, render_result_key(&nanos));
        // Embed scope participates in the render too.
        let embed = ResultKey {
            this_id: Some(crate::memo::MemoId::now()),
            ..base.clone()
        };
        assert_ne!(s, render_result_key(&embed));
    }
}
