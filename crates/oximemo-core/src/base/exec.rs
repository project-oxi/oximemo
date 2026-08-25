//! `run_base` executor — the runtime pipeline behind `.query` base views
//! (spec 2026-08-25 §3).
//!
//! Pipeline (order is load-bearing): filter (base ∧ view, soft-deleted
//! records always excluded) → per-row formula evaluation (topological,
//! memoized within the row, errors stored) → deterministic group-major
//! stable sort → view hard `limit` cap → `total`/`group_counts`/
//! `summaries` over the capped dataset → page slice (`group = Some(k)`
//! slices that group's rows; `""` is the 그룹 없음 bucket).
//!
//! `result_key` is the content fingerprint the result cache (Task 10)
//! deduplicates runs on; see [`crate::base::cache::ResultKey`] for the
//! key fields. Like `base::files`, this module is
//! private (`pub(crate)`) — callers reach every public item through
//! [`crate::base`], so the module path stays `crate::base` for
//! Tasks 10–13.

use std::cell::Cell;
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

use serde::Serialize;
use time::format_description::well_known::Rfc3339;

use super::{BaseDef, BaseViewDef, FilterGroup, FilterSpec, validate};
use super::formula_deps;
use time::{OffsetDateTime, UtcOffset};
use crate::expr::value::{Value, group_string, parse_date_ish, promote_num, total_order, type_name};
use crate::expr::eval::{EvalClock, EvalCtx, RowData, compare, eval};
use crate::expr::parser::{Expr, parse_expr};
use crate::error::{CoreError, Result};

use crate::memo::{MemoHash, MemoId, MemoSummary, NoteFormat};
use crate::props::PropValue;
use crate::store::index::IndexRecord;
use crate::vault::Vault;

/// `SystemTime` → UTC instant (pre-epoch and out-of-range clamp to the
/// epoch). Used by the full-screen `this.file.created/updated`
/// synthesis from the `.query` file's mtime.
fn systemtime_to_odt(t: std::time::SystemTime) -> OffsetDateTime {
    match t.duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => OffsetDateTime::from_unix_timestamp_nanos(d.as_nanos() as i128)
            .unwrap_or(OffsetDateTime::UNIX_EPOCH),
        Err(_) => OffsetDateTime::UNIX_EPOCH,
    }
}



/// One rendered cell: the evaluated value, or the error that replaced it
/// (spec §2's per-cell ⚠︎ contract — `Vec<Value>` cannot carry a tooltip).
#[derive(Debug, Clone, Serialize)]
pub struct BaseCell {
    pub value: Option<Value>,
    pub error: Option<String>,
}

/// One row of a page: the indexed summary plus derived folder/format and
/// the resolved column cells.
#[derive(Debug, Clone, Serialize)]
pub struct BaseRow {
    pub summary: MemoSummary,
    pub folder: String,
    pub format: String,
    pub cells: Vec<BaseCell>,
}

/// Count of rows in one group bucket, in group order (그룹 없음 last).
#[derive(Debug, Clone, Serialize)]
pub struct GroupCount {
    pub key: String,
    pub count: usize,
}

/// Echo of the pinned per-view-session clock (spec §2: `now()` is pinned
/// once per view session; later pages reuse `now_ms`/offset). `now_utc`
/// is RFC 3339; `local_offset_seconds` is the pinned UTC offset.
#[derive(Debug, Clone, Serialize)]
pub struct EvalClockDto {
    pub now_utc: String,
    pub local_offset_seconds: i32,
}

/// Result of one aggregate over the capped dataset.
#[derive(Debug, Clone, Serialize)]
pub struct SummaryValue {
    /// The summary function name (`Average`, `Sum`, ...).
    pub name: String,
    pub value: Value,
}

/// One page of a base view run.
#[derive(Debug, Clone, Serialize)]
pub struct BasePage {
    pub rows: Vec<BaseRow>,
    /// Size of the capped dataset (after the view's hard `limit`), not
    /// the page slice size.
    pub total: usize,
    pub group_counts: Option<Vec<GroupCount>>,
    pub summaries: Option<BTreeMap<String, SummaryValue>>,
    pub clock: EvalClockDto,
    /// Content fingerprint (Task 10); rendered form lives at
    /// [`crate::base::cache::render_result_key`].
    pub result_key: String,
    pub warnings: Vec<String>,
}

/// Where the [`BaseDef`] comes from: a vault-relative `.query` path or an
/// in-memory definition (inline query blocks).
#[derive(Debug, Clone)]
pub enum BaseSource {
    Inline(BaseDef),
    Path(String),
}

/// Request shape for [`crate::vault::Vault::run_base`].
#[derive(Debug, Clone)]
pub struct RunBaseReq {
    pub view_index: usize,
    pub offset: usize,
    pub limit: u32,
    /// Board column paging: only rows whose group bucket equals `k`
    /// (`""` = 그룹 없음) appear in the page.
    pub group: Option<String>,
    /// Clock pinning: supply both to keep `now()` stable across pages.
    pub now_ms: Option<i64>,
    pub local_offset_seconds: Option<i32>,
    pub include_group_counts: bool,
    pub include_summaries: bool,
    /// Embedding note for `this.*` resolution; `None` outside embeds.
    pub this_id: Option<MemoId>,
}

/// Effective column list: the view's `columns` or the default
/// `[file.name]` (spec §1).
pub fn default_columns(view: &BaseViewDef) -> Vec<String> {
    view.columns
        .clone()
        .unwrap_or_else(|| vec!["file.name".to_string()])
}

// --- property catalog (base_props) ----------------------------------------

/// A Str key with at most this many distinct observed values is a
/// `select`; anything wider is free-form `text` (Task 11 brief).
const PROPS_SELECT_DISTINCT: usize = 20;

/// Options returned per key: top values by frequency, then alpha.
const PROPS_OPTIONS_CAP: usize = 50;

/// A Str key whose values parse as dates at ≥80% of observations
/// (weight = occurrence count) is a `date`. Expressed as `×5 ≥ ×4`
/// integer math — no floats.
const PROPS_DATE_NUM: u64 = 4;
const PROPS_DATE_DEN: u64 = 5;

/// One observed property key for filter-builder UIs (spec §3
/// `base_props`). `kinds` is every value kind observed for the key
/// across non-deleted records — a Str key contributes exactly one of
/// `date`/`select`/`text`, so conflicting kinds (e.g. `bool` + `select`)
/// ride together and the builder degrades to equality/contains (spec
/// §3). `options` is the top [`PROPS_OPTIONS_CAP`] observed string
/// values by frequency (desc), then alpha (asc); empty for `text`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PropInfo {
    pub key: String,
    /// Observed kinds: `"text" | "select" | "multiselect" | "bool" | "date"`,
    /// alpha-ordered.
    pub kinds: Vec<String>,
    pub options: Vec<String>,
}

/// Per-key accumulator for one [`Vault::base_props`] scan.
#[derive(Default)]
struct KeyStats {
    /// Str value → occurrence count (drives date ratio + select bound).
    str_freq: BTreeMap<String, u32>,
    /// List member value → occurrence count (multiselect suggestions).
    member_freq: BTreeMap<String, u32>,
    has_bool: bool,
}

/// One snapshot pass over non-deleted records → the property catalog,
/// sorted by key. Soft-deleted records never contribute (spec §1).
fn observed_props(snap: &[IndexRecord]) -> Vec<PropInfo> {
    let mut stats: BTreeMap<&str, KeyStats> = BTreeMap::new();
    for rec in snap.iter().filter(|r| !r.deleted) {
        for (key, value) in &rec.props {
            let st = stats.entry(key.as_str()).or_default();
            match value {
                PropValue::Str(s) => *st.str_freq.entry(s.clone()).or_insert(0) += 1,
                PropValue::List(items) => {
                    for m in items {
                        *st.member_freq.entry(m.clone()).or_insert(0) += 1;
                    }
                }
                PropValue::Bool(_) => st.has_bool = true,
            }
        }
    }
    stats
        .into_iter()
        .map(|(key, st)| {
            let mut kinds: Vec<&str> = Vec::new();
            if st.has_bool {
                kinds.push("bool");
            }
            if !st.str_freq.is_empty() {
                let total: u64 = st.str_freq.values().map(|&c| c as u64).sum();
                let dated: u64 = st
                    .str_freq
                    .iter()
                    .filter(|(s, _)| parse_date_ish(s).is_some())
                    .map(|(_, &c)| c as u64)
                    .sum();
                // Date wins over select: an ISO-valued key wants a date
                // picker, not a dropdown of timestamps.
                if dated * PROPS_DATE_DEN >= total * PROPS_DATE_NUM {
                    kinds.push("date");
                } else if st.str_freq.len() <= PROPS_SELECT_DISTINCT {
                    kinds.push("select");
                } else {
                    kinds.push("text");
                }
            }
            if !st.member_freq.is_empty() {
                kinds.push("multiselect");
            }
            // Options: the unioned Str-value + List-member frequency
            // space, top PROPS_OPTIONS_CAP by frequency then alpha.
            // High-cardinality text keys offer none (their value space
            // is unbounded suggestions noise).
            let options: Vec<String> = if kinds.contains(&"text") {
                Vec::new()
            } else {
                let mut merged: BTreeMap<&str, u64> = BTreeMap::new();
                for (s, c) in st.str_freq.iter().chain(st.member_freq.iter()) {
                    *merged.entry(s.as_str()).or_insert(0) += *c as u64;
                }
                let mut pairs: Vec<(&str, u64)> = merged.into_iter().collect();
                pairs.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
                pairs.truncate(PROPS_OPTIONS_CAP);
                pairs.into_iter().map(|(s, _)| s.to_string()).collect()
            };
            kinds.sort_unstable();
            let kinds: Vec<String> = kinds.into_iter().map(str::to_string).collect();
            PropInfo {
                key: key.to_string(),
                kinds,
                options,
            }
        })
        .collect()
}

// --- executor ------------------------------------------------------------

/// A row that survived filtering: the record, its per-row formula
/// results (for later cell/order/group/summary resolution), and its
/// precomputed sort keys. `keys[0]` is the group key when `groupBy` is
/// active, followed by one entry per `order` spec; `None` = error/Null
/// key, which sorts last regardless of direction.
struct Kept<'a> {
    rec: &'a IndexRecord,
    formulas: HashMap<String, Result<Value, CoreError>>,
    keys: Vec<Option<Value>>,
    /// Canonical group bucket (`""` = 그룹 없음, also when no `groupBy`).
    group_str: String,
}

/// Runtime query-fatal error (spec §2 taxonomy: line/col zero).
fn fatal(message: impl Into<String>) -> CoreError {
    CoreError::Expr {
        message: message.into(),
        line: 0,
        col: 0,
    }
}
impl Vault {
    /// Execute one page of a base view (spec §3 pipeline). Cache-aware:
    /// builds a [`crate::base::cache::ResultKey`] from the source identity,
    /// view index, snapshot generation, pinned clock, and embed scope; on a
    /// hit it slices the cached [`crate::base::cache::BaseResult`] without
    /// re-evaluation.
    pub fn run_base(&self, source: &BaseSource, req: &RunBaseReq) -> Result<BasePage> {
        // 1. Definition + load-time validation. Hard errors bubble;
        //    warnings ride along on the page.
        let def = match source {
            BaseSource::Path(rel) => self.load_base(rel)?,
            BaseSource::Inline(d) => d.clone(),
        };
        let mut warnings = validate(&def)?;
        // Inside an embed (`this_id` present) the load-time
        // "this.note.* will evaluate to Null outside an embed" warning
        // is false — only run_base knows the embed context, so it
        // drops that warning here (spec §1).
        if req.this_id.is_some() {
            warnings.retain(|w| !w.contains("will evaluate to Null outside an embed"));
        }
        // 2. View selection — fail fast before statting the index.
        let Some(view) = def.views.get(req.view_index) else {
            return Err(CoreError::other("view index out of range"));
        };
        // 3. Cache fingerprint. Source identity is stable across the
        //    run, but the snapshot generation depends on which path
        //    `snapshot()` takes — a cache miss rebuilds and locks in
        //    the post-stat, so we must call snapshot() FIRST and
        //    build the generation-aware key from its now-cached
        //    value. That makes a hit key equal to a "what changed
        //    since last call" probe key.
        let source_hash = self.base_source_hash(source)?;
        let (now_utc, local) = clock_from_req(req.now_ms, req.local_offset_seconds)?;
        let clock_ms: i64 = (now_utc.unix_timestamp_nanos() / 1_000_000).try_into().unwrap_or(0);
        let local_offset_seconds: i32 = local.whole_seconds();
        // Single snapshot call returns BOTH the records and the
        // generation the snapshot cache just locked in. Using that
        // exact gen for the result key removes the double-stat
        // window that could otherwise round to the same mtime and
        // miss the cache entry we just stored.
        let (snap, generation) = self.snapshot_with_gen()?;
        let key = crate::base::cache::ResultKey {
            source_hash,
            view_index: req.view_index,
            generation,
            clock_ms,
            local_offset_seconds,
            group_counts: req.include_group_counts,
            summaries: req.include_summaries,
            this_id: req.this_id,
        };
        // Cache hit? Slice and return. The cached BaseResult holds
        // the full dataset (capped at the view's hard limit) plus
        // group_strs parallel to rows, so group paging is pure
        // filter+offset+limit with no re-evaluation.
        if let Some(hit) = self.base_cache_get(&key) {
            let now_str = now_utc
                .format(&Rfc3339)
                .map_err(|e| CoreError::other(format!("clock formatting failed: {e}")))?;
            let page_rows: Vec<BaseRow> = match &req.group {
                Some(g) => hit
                    .rows
                    .iter()
                    .zip(hit.group_strs.iter())
                    .filter(|(_, gs)| gs.as_str() == g.as_str())
                    .skip(req.offset)
                    .take(req.limit as usize)
                    .map(|(r, _)| r.clone())
                    .collect(),
                None => hit
                    .rows
                    .iter()
                    .skip(req.offset)
                    .take(req.limit as usize)
                    .cloned()
                    .collect(),
            };
            let result_key = crate::base::cache::render_result_key(&key);
            return Ok(BasePage {
                rows: page_rows,
                total: hit.total,
                group_counts: hit.group_counts.clone(),
                summaries: hit.summaries.clone(),
                clock: EvalClockDto {
                    now_utc: now_str,
                    local_offset_seconds,
                },
                result_key,
                warnings: hit.warnings.clone(),
            });
        }
        let clock = EvalClock { now_utc, local };
        let ctx = EvalCtx {
            clock: &clock,
            depth: Cell::new(0),
        };

        let mut filters: Vec<Expr> = Vec::new();
        if let Some(f) = &def.filters {
            filters.push(compile_filter(f)?);
        }
        if let Some(f) = &view.filters {
            filters.push(compile_filter(f)?);
        }
        let formulas = topo_formulas(def.formulas.as_ref())?;
        let columns: Vec<Expr> = default_columns(view)
            .iter()
            .map(|c| parse_expr(c))
            .collect::<Result<Vec<_>, _>>()?;
        let order_specs: Vec<(Expr, bool)> = match &view.order {
            Some(specs) => specs
                .iter()
                .map(|o| Ok((parse_expr(&o.property)?, is_desc(o.direction.as_deref()))))
                .collect::<Result<Vec<_>>>()?,
            None => Vec::new(),
        };
        let group_spec = match &view.group_by {
            Some(g) => Some((parse_expr(&g.property)?, is_desc(g.direction.as_deref()))),
            None => None,
        };


        // 5. Snapshot → filter. Soft-deleted records never enter any
        //    base pipeline (spec §1).
        // snap is already populated above by snapshot_with_gen.
        let empty_formulas: HashMap<String, Result<Value, CoreError>> = HashMap::new();
        // `this` scope: an embed (`this_id`) resolves to that note's
        // row. Without one, a full-screen Path run synthesizes the
        // scope from the `.query` file itself (spec §1): `this.file.*`
        // serves path/folder/name (from the rel path) and
        // created/updated (both from the file's mtime — fs creation
        // time is not portable), while `this.note.*` stays Null.
        let query_rec: Option<IndexRecord> = match (req.this_id.is_none(), source) {
            (true, BaseSource::Path(rel)) => {
                let mtime = self
                    .query_rel_path(rel)
                    .ok()
                    .and_then(|abs| std::fs::metadata(abs).ok())
                    .and_then(|m| m.modified().ok())
                    .unwrap_or(std::time::UNIX_EPOCH);
                Some(IndexRecord {
                    id: MemoId(uuid::Uuid::nil()),
                    created_at: systemtime_to_odt(mtime),
                    updated_at: systemtime_to_odt(mtime),
                    hash: MemoHash::new(""),
                    favorite: false,
                    path: rel.clone(),
                    title: None,
                    tags: Vec::new(),
                    props: Default::default(),
                    deleted: false,
                    deleted_at: None,
                    preview: String::new(),
                })
            }
            _ => None,
        };
        let this_row = match req.this_id {
            Some(id) => snap
                .iter()
                .find(|r| r.id == id)
                .map(|rec| RowData::from_record(rec, &empty_formulas, None)),
            None => query_rec
                .as_ref()
                .map(|rec| RowData::from_query_file(rec, &empty_formulas)),
        };
        let mut kept: Vec<Kept> = Vec::new();
        for rec in snap.iter().filter(|r| !r.deleted) {
            // Formulas first, in dependency order, memoized per row;
            // errors are stored and re-raised as cell errors on lookup.
            let mut fmap: HashMap<String, Result<Value, CoreError>> =
                HashMap::with_capacity(formulas.len());
            for (name, expr) in &formulas {
                let row = RowData::from_record(rec, &fmap, this_row.as_ref());
                let v = eval(expr, &row, &ctx);
                fmap.insert(name.clone(), v);
            }
            let row = RowData::from_record(rec, &fmap, this_row.as_ref());
            // Filters: keep Ok(Bool(true)); Ok(Bool(false))/Ok(Null)
            // drop the row; any Err or other non-Bool is query-fatal
            // (spec §2 — Null is the documented "outside an embed"
            // value, not a type error).
            let mut passes = true;
            for f in &filters {
                match eval(f, &row, &ctx) {
                    Ok(Value::Bool(true)) => {}
                    Ok(Value::Bool(false)) | Ok(Value::Null) => {
                        passes = false;
                        break;
                    }
                    Err(e) => return Err(e),
                    Ok(v) => {
                        return Err(fatal(format!(
                            "filter must evaluate to a boolean, got {}",
                            type_name(&v)
                        )))
                    }
                }
            }
            if !passes {
                continue;
            }
            // Sort keys: group key first (spec §3 group-major), then
            // the view order. Errors/Null → None (sorts last); a List
            // group key uses its first member (spec §3). Without a
            // groupBy there is no group key position at all.
            let mut keys = Vec::with_capacity(order_specs.len() + usize::from(group_spec.is_some()));
            let mut group_str = String::new();
            if let Some((e, _)) = &group_spec {
                let g = group_key(e, &row, &ctx);
                group_str = match &g {
                    Some(v) => group_string(v),
                    None => String::new(),
                };
                keys.push(g);
            }
            for (e, _) in &order_specs {
                keys.push(match eval(e, &row, &ctx) {
                    Ok(Value::Null) | Err(_) => None,
                    Ok(v) => Some(v),
                });
            }
            kept.push(Kept {
                rec,
                formulas: fmap,
                keys,
                group_str,
            });
        }

        // 6. Group-major stable sort; MemoId ascending is the final
        //    tie-break so offset pages never duplicate or skip rows.
        let mut descs: Vec<bool> = Vec::with_capacity(1 + order_specs.len());
        if let Some((_, d)) = &group_spec {
            descs.push(*d);
        }
        for (_, d) in &order_specs {
            descs.push(*d);
        }
        kept.sort_by(|a, b| {
            for i in 0..descs.len() {
                let ord = cmp_key(&a.keys[i], &b.keys[i], descs[i]);
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            a.rec.id.cmp(&b.rec.id)
        });

        // 7. Hard cap, then `total` = capped dataset size.
        if let Some(cap) = view.limit {
            kept.truncate(cap as usize);
        }
        let total = kept.len();

        // 8. Group counts over the capped dataset, in group order (the
        //    dataset is already group-major, so first-appearance order
        //    IS the direction order; 그룹 없음 sorts last, so its ""
        //    bucket lands last too).
        let group_counts = if req.include_group_counts && group_spec.is_some() {
            let mut out: Vec<GroupCount> = Vec::new();
            let mut index: HashMap<&str, usize> = HashMap::new();
            for k in &kept {
                match index.get(k.group_str.as_str()) {
                    Some(&i) => out[i].count += 1,
                    None => {
                        index.insert(k.group_str.as_str(), out.len());
                        out.push(GroupCount {
                            key: k.group_str.clone(),
                            count: 1,
                        });
                    }
                }
            }
            Some(out)
        } else {
            None
        };

        // 9. Summaries over the capped dataset.
        let summaries = if req.include_summaries {
            Some(compute_summaries(view, &kept, this_row.as_ref(), &ctx, &mut warnings)?)
        } else {
            None
        };


        // Cells + group_strs for EVERY kept row (the cached BaseResult
        // holds the full dataset so group paging can slice without
        // re-evaluation). Cell eval is the only place that observes
        // `this.*`/formula errors per row, so it has to happen before
        // the cache stores anything.
        let mut full_rows: Vec<BaseRow> = Vec::with_capacity(kept.len());
        let mut group_strs: Vec<String> = Vec::with_capacity(kept.len());
        for k in kept.iter() {
            let row = RowData::from_record(k.rec, &k.formulas, this_row.as_ref());
            let cells: Vec<BaseCell> = columns
                .iter()
                .map(|c| match eval(c, &row, &ctx) {
                    Ok(v) => BaseCell { value: Some(v), error: None },
                    Err(e) => BaseCell { value: None, error: Some(e.to_string()) },
                })
                .collect();
            full_rows.push(BaseRow {
                summary: k.rec.to_summary(),
                folder: folder_of(&k.rec.path),
                format: format_of(&k.rec.path).to_string(),
                cells,
            });
            group_strs.push(k.group_str.clone());
        }
        // 12. Build the cached BaseResult over the full dataset. The
        let cached = Arc::new(crate::base::cache::BaseResult {
            rows: full_rows,
            group_strs,
            total,
            group_counts: group_counts.clone(),
            summaries: summaries.clone(),
            warnings: warnings.clone(),
            props: None,
        });
        // Spec §3 row cap:
        // RESULT_CACHE_ROW_CAP are returned uncached (same bypass as
        // `snapshot()`'s >SNAPSHOT_CACHE_CAP) so the 64 MiB envelope
        // is preserved.
        if total <= crate::base::cache::RESULT_CACHE_ROW_CAP {
            self.base_cache_put(key.clone(), cached.clone());
        }
        //     limit are request-level paging — never part of the key.
        let page_rows: Vec<BaseRow> = match &req.group {
            Some(g) => cached
                .rows
                .iter()
                .zip(cached.group_strs.iter())
                .filter(|(_, gs)| gs.as_str() == g.as_str())
                .skip(req.offset)
                .take(req.limit as usize)
                .map(|(r, _)| r.clone())
                .collect(),
            None => cached
                .rows
                .iter()
                .skip(req.offset)
                .take(req.limit as usize)
                .cloned()
                .collect(),
        };
        let result_key = crate::base::cache::render_result_key(&key);
        // 14. result_key + clock DTO.
        let now_str = now_utc
            .format(&Rfc3339)
            .map_err(|e| CoreError::other(format!("clock formatting failed: {e}")))?;
        Ok(BasePage {
            rows: page_rows,
            total: cached.total,
            group_counts: cached.group_counts.clone(),
            summaries: cached.summaries.clone(),
            clock: EvalClockDto {
                now_utc: now_str,
                local_offset_seconds,
            },
            result_key,
            warnings: cached.warnings.clone(),
        })
    }

    /// Observed property catalog for filter-builder UIs (spec §3
    /// `base_props`, Task 11). One snapshot pass over non-deleted
    /// records; see [`observed_props`] for the kind/option rules.
    ///
    /// Cached in the shared result cache under a fixed synthetic key
    /// (reserved `source_hash: 0`) that embeds the snapshot generation,
    /// so any index write naturally invalidates it and an unchanged
    /// index costs one map lookup.
    pub fn base_props(&self) -> Result<Vec<PropInfo>> {
        let (snap, generation) = self.snapshot_with_gen()?;
        let key = crate::base::cache::props_result_key(generation);
        if let Some(hit) = self.base_cache_get(&key)
            && let Some(props) = &hit.props
        {
            return Ok(props.clone());
        }
        let catalog = observed_props(&snap);
        self.base_cache_put(
            key,
            Arc::new(crate::base::cache::BaseResult {
                rows: Vec::new(),
                group_strs: Vec::new(),
                total: 0,
                group_counts: None,
                summaries: None,
                warnings: Vec::new(),
                props: Some(catalog.clone()),
            }),
        );
        Ok(catalog)
    }
}

/// `true` for `direction: desc`; anything else (including `asc` and
/// absent) is ascending.
fn is_desc(dir: Option<&str>) -> bool {
    dir == Some("desc")
}

/// Clock from the request, or the system default (`current_local_offset`
/// may fail in multi-threaded processes; UTC is the documented fallback).
fn clock_from_req(
    now_ms: Option<i64>,
    offset_s: Option<i32>,
) -> Result<(OffsetDateTime, UtcOffset)> {
    let now_utc = match now_ms {
        Some(ms) => OffsetDateTime::from_unix_timestamp_nanos(ms as i128 * 1_000_000)
            .map_err(|e| CoreError::other(format!("invalid now_ms {ms}: {e}")))?,
        None => OffsetDateTime::now_utc(),
    };
    let local = match offset_s {
        // `from_whole_seconds` validates the ±25:59:59 range itself;
        // values outside it are caller errors, not panics.
        Some(s) => UtcOffset::from_whole_seconds(s)
            .map_err(|e| CoreError::other(format!("invalid local_offset_seconds {s}: {e}")))?,
        None => UtcOffset::current_local_offset().unwrap_or(UtcOffset::UTC),
    };
    Ok((now_utc, local))
}

/// Fold one `FilterSpec` into a single [`Expr`] tree. Groups reuse the
/// engine's own `&&`/`||`/`!` nodes, so group semantics (strict
/// booleans, short-circuit, error propagation) are exactly the
/// operator semantics. Empty `and` is vacuously true, empty `or`/`not`
/// false.
fn compile_filter(spec: &FilterSpec) -> Result<Expr> {
    match spec {
        FilterSpec::Expr(src) => parse_expr(src),
        FilterSpec::Group(FilterGroup::And(xs)) => fold_group(xs, "&&"),
        FilterSpec::Group(FilterGroup::Or(xs)) => fold_group(xs, "||"),
        FilterSpec::Group(FilterGroup::Not(xs)) => Ok(Expr::Unary {
            op: "!",
            expr: Box::new(fold_group(xs, "&&")?),
        }),
    }
}

fn fold_group(xs: &[FilterSpec], op: &'static str) -> Result<Expr> {
    let init = match xs.first() {
        Some(first) => compile_filter(first)?,
        None => {
            return Ok(Expr::Lit(Value::Bool(op == "&&")));
        }
    };
    xs[1..].iter().try_fold(init, |acc, x| {
        compile_filter(x).map(|e| Expr::Binary {
            op,
            lhs: Box::new(acc),
            rhs: Box::new(e),
        })
    })
}

/// Formulas in dependency order (deps first). Cycles were rejected by
/// [`validate`]; the on-stack check is defensive for direct callers.
/// Each entry is (name, parsed expr); names of unknown deps stay
/// unresolved (Null at lookup) and surface as stored cell errors.
fn topo_formulas(formulas: Option<&BTreeMap<String, String>>) -> Result<Vec<(String, Expr)>> {
    let Some(formulas) = formulas else {
        return Ok(Vec::new());
    };
    let mut out = Vec::with_capacity(formulas.len());
    // Owned names: `dep` strings from formula_deps are locals, so the
    // visited-set borrows cannot tie to `formulas`' lifetime.
    let mut done: HashSet<String> = HashSet::new();
    let mut on_stack: HashSet<String> = HashSet::new();
    for name in formulas.keys() {
        visit_formula(name, formulas, &mut done, &mut on_stack, &mut out)?;
    }
    Ok(out)
}

fn visit_formula(
    name: &str,
    formulas: &BTreeMap<String, String>,
    done: &mut HashSet<String>,
    on_stack: &mut HashSet<String>,
    out: &mut Vec<(String, Expr)>,
) -> Result<()> {
    if done.contains(name) {
        return Ok(());
    }
    if !on_stack.insert(name.to_string()) {
        return Err(fatal(format!("formula cycle: {name}")));
    }
    let src = formulas
        .get(name)
        .ok_or_else(|| fatal(format!("formula `{name}` missing")))?;
    let expr = parse_expr(src)?;
    for dep in formula_deps(src)? {
        if formulas.contains_key(&dep) {
            visit_formula(&dep, formulas, done, on_stack, out)?;
        }
    }
    on_stack.remove(name);
    done.insert(name.to_string());
    out.push((name.to_string(), expr));
    Ok(())
}

/// Group key for one row: evaluation errors, Null, and an empty or
/// Null-headed List all land in 그룹 없음 (`None` → `""` bucket); a
/// non-empty List uses its first member (spec §3).
fn group_key(expr: &Expr, row: &RowData, ctx: &EvalCtx) -> Option<Value> {
    match eval(expr, row, ctx) {
        Ok(Value::Null) | Err(_) => None,
        Ok(Value::List(items)) => items
            .into_iter()
            .next()
            .filter(|v| !matches!(v, Value::Null)),
        Ok(v) => Some(v),
    }
}

/// Compare one sort-key position. `None` (error/Null key) sorts last
/// regardless of direction; otherwise the engine's promotion-aware
/// order (`compare`), inverted for `desc`. A non-promotable kind
/// mismatch (e.g. Bool vs Str) falls back to the spec §2 total kind
/// order (`Bool < Num < Date < Str < List < Null`) instead of
/// comparing Equal, so mixed-kind keys still get a deterministic
/// kind-ranked order under the same direction inversion.
fn cmp_key(a: &Option<Value>, b: &Option<Value>, desc: bool) -> Ordering {
    match (a, b) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(x), Some(y)) => {
            let ord = compare(x, y).unwrap_or_else(|_| total_order(x, y));
            if desc {
                ord.reverse()
            } else {
                ord
            }
        }
    }
}

/// Aggregates for one `summaries` entry. Errors during resolution are
/// excluded from every aggregate and reported via `warnings` (spec §2);
/// Null values count toward All/Empty/Filled and are skipped by the
/// numeric aggregates; a non-promotable non-Null member makes the
/// numeric aggregate Null with a warning.
fn compute_summaries(
    view: &BaseViewDef,
    kept: &[Kept],
    this_row: Option<&RowData>,
    ctx: &EvalCtx,
    warnings: &mut Vec<String>,
) -> Result<BTreeMap<String, SummaryValue>> {
    let mut out = BTreeMap::new();
    let Some(specs) = &view.summaries else {
        return Ok(out);
    };
    for (path, fname) in specs {
        let expr = parse_expr(path)?;
        let mut vals: Vec<Value> = Vec::with_capacity(kept.len());
        let mut errors = 0usize;
        for k in kept {
            let row = RowData::from_record(k.rec, &k.formulas, this_row);
            match eval(&expr, &row, ctx) {
                Ok(v) => vals.push(v),
                Err(_) => errors += 1,
            }
        }
        if errors > 0 {
            warnings.push(format!(
                "summary {path}: excluded {errors} row(s) with evaluation errors"
            ));
        }
        let value = summary_value(fname, &vals, path, warnings);
        out.insert(path.clone(), SummaryValue { name: fname.clone(), value });
    }
    Ok(out)
}

fn summary_value(fname: &str, vals: &[Value], path: &str, warnings: &mut Vec<String>) -> Value {
    let count = |pred: &dyn Fn(&Value) -> bool| {
        Value::Num(vals.iter().filter(|v| pred(v)).count() as f64)
    };
    match fname {
        "All" => Value::Num(vals.len() as f64),
        "Checked" => count(&|v| matches!(v, Value::Bool(true))),
        "Unchecked" => count(&|v| matches!(v, Value::Bool(false))),
        "Empty" => count(&is_empty_value),
        "Filled" => count(&|v| !is_empty_value(v)),
        "Unique" => {
            // Distinct non-Null values by their canonical group form,
            // so Num(9) and Str("9") are one value (group_string's
            // documented bucketing contract).
            let distinct: HashSet<String> = vals
                .iter()
                .filter(|v| !matches!(v, Value::Null))
                .map(group_string)
                .collect();
            Value::Num(distinct.len() as f64)
        }
        "Average" | "Sum" | "Min" | "Max" | "Median" => {
            let mut nums: Vec<f64> = Vec::with_capacity(vals.len());
            for v in vals {
                if matches!(v, Value::Null) {
                    continue;
                }
                match promote_num(v).filter(|n| n.is_finite()) {
                    Some(n) => nums.push(n),
                    None => {
                        warnings.push(format!(
                            "summary {path}: cannot aggregate {} as a number",
                            type_name(v)
                        ));
                        return Value::Null;
                    }
                }
            }
            match fname {
                "Sum" => Value::Num(nums.iter().sum()),
                "Average" => {
                    if nums.is_empty() {
                        Value::Null
                    } else {
                        Value::Num(nums.iter().sum::<f64>() / nums.len() as f64)
                    }
                }
                "Min" => nums
                    .iter()
                    .copied()
                    .reduce(f64::min)
                    .map(Value::Num)
                    .unwrap_or(Value::Null),
                "Max" => nums
                    .iter()
                    .copied()
                    .reduce(f64::max)
                    .map(Value::Num)
                    .unwrap_or(Value::Null),
                // Even length: mean of the two middle members.
                "Median" => {
                    if nums.is_empty() {
                        Value::Null
                    } else {
                        nums.sort_by(|a, b| a.total_cmp(b));
                        let mid = nums.len() / 2;
                        let m = if nums.len() % 2 == 1 {
                            nums[mid]
                        } else {
                            (nums[mid - 1] + nums[mid]) / 2.0
                        };
                        Value::Num(m)
                    }
                }
                _ => unreachable!("dispatched by the outer match"),
            }
        }
        other => {
            warnings.push(format!("summary {path}: unknown summary function `{other}`"));
            Value::Null
        }
    }
}

fn is_empty_value(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::Str(s) => s.is_empty(),
        Value::List(items) => items.is_empty(),
        _ => false,
    }
}

/// Folder portion of a vault-relative path. Mirrors the value
/// `RowData` derives (and keeps private); not worth widening that API.
fn folder_of(path: &str) -> String {
    path.rsplit_once('/')
        .map(|(dir, _)| dir.to_string())
        .unwrap_or_default()
}

fn format_of(path: &str) -> &'static str {
    match NoteFormat::from_rel(path) {
        NoteFormat::Markdown => "markdown",
        NoteFormat::Html => "html",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memo::NoteFormat;
    use crate::props::{PropMutation, PropValue};
    use crate::vault::Vault;
    use tempfile::TempDir;
    use time::format_description::well_known::Rfc3339;
    use time::{Duration, OffsetDateTime};

    fn tmp_vault() -> (TempDir, Vault) {
        let dir = TempDir::new().unwrap();
        let v = Vault::open(Some(dir.path())).unwrap();
        (dir, v)
    }

    /// Create a titled note with string props; returns its id.
    fn note(
        v: &Vault,
        folder: &str,
        title: &str,
        props: &[(&str, &str)],
        favorite: bool,
    ) -> MemoId {
        let n = v
            .create_note(
                folder,
                format!("# {title}\n\n{title} 본문"),
                NoteFormat::Markdown,
            )
            .unwrap();
        if favorite || !props.is_empty() {
            v.update_note_with(
                n.id,
                None,
                favorite.then_some(true),
                Some(PropMutation {
                    sets: props
                        .iter()
                        .map(|(k, x)| ((*k).to_string(), PropValue::Str((*x).to_string())))
                        .collect(),
                    removes: vec![],
                }),
            )
            .unwrap();
        }
        n.id
    }

    /// The brief's seed: 6 live notes across `book/` and `film/` with
    /// `status`/`rating` props plus 1 soft-deleted note.
    /// Returns ids as `[b1, b2, b3, b4, f1, f2]`.
    fn seed() -> (TempDir, Vault, [MemoId; 6]) {
        let (dir, v) = tmp_vault();
        let b1 = note(&v, "book", "책1", &[("status", "읽는중"), ("rating", "9")], false);
        let b2 = note(&v, "book", "책2", &[("status", "읽는중"), ("rating", "10")], false);
        let b3 = note(&v, "book", "책3", &[("status", "완독"), ("rating", "7")], false);
        // No rating: Null sort key + the formula-error row for tests.
        let b4 = note(&v, "book", "책4", &[("status", "완독")], false);
        let f1 = note(&v, "film", "영화1", &[("status", "보는중"), ("rating", "8")], false);
        let f2 = note(&v, "film", "영화2", &[("status", "완독"), ("rating", "9")], true);
        let trashed = note(&v, "book", "낡은책", &[("status", "읽는중"), ("rating", "1")], false);
        v.delete_memo(trashed).unwrap();
        (dir, v, [b1, b2, b3, b4, f1, f2])
    }

    fn req(view_index: usize) -> RunBaseReq {
        RunBaseReq {
            view_index,
            offset: 0,
            limit: 100,
            group: None,
            now_ms: None,
            local_offset_seconds: None,
            include_group_counts: false,
            include_summaries: false,
            this_id: None,
        }
    }

    /// Persist `yaml` as a `.query` file and run it (Path source).
    fn run(v: &Vault, yaml: &str, req: &RunBaseReq) -> BasePage {
        v.save_base("queries/t.query", yaml, None).unwrap();
        v.run_base(&BaseSource::Path("queries/t.query".to_string()), req)
            .unwrap()
    }

    /// `cells[0]` of every row (the `file.name` column in these fixtures).
    fn names(page: &BasePage) -> Vec<String> {
        page.rows
            .iter()
            .map(|r| match &r.cells[0].value {
                Some(Value::Str(s)) => s.clone(),
                other => panic!("expected a file.name string cell, got {other:?}"),
            })
            .collect()
    }

    fn status_cells(page: &BasePage) -> Vec<String> {
        page.rows
            .iter()
            .map(|r| match &r.cells[1].value {
                Some(Value::Str(s)) => s.clone(),
                other => panic!("expected a status string cell, got {other:?}"),
            })
            .collect()
    }

    // 1. Nested and/or/not filters from the spec example narrow correctly.
    #[test]
    fn nested_filters_narrow_correctly() {
        let (_d, v, _ids) = seed();
        let yaml = r#"
filters:
  and:
    - 'status != "done"'
    - or:
        - 'file.inFolder("book")'
        - 'file.favorite == true'
views:
  - type: table
    name: 메인
    filters:
      not: ['status == "보는중"']
"#;
        let page = run(&v, yaml, &req(0));
        assert_eq!(page.total, 5, "4 book notes + the favorite film");
        let mut got = names(&page);
        got.sort();
        assert_eq!(got, vec!["영화2", "책1", "책2", "책3", "책4"]);
        assert!(page.warnings.is_empty(), "{:?}", page.warnings);
    }

    // 2. Soft-deleted notes never enter the pipeline; no `.trash` leak.
    #[test]
    fn soft_deleted_excluded_and_no_trash_leak() {
        let (_d, v, _ids) = seed();
        let yaml = "views:\n  - type: table\n";
        let page = run(&v, yaml, &req(0));
        assert_eq!(page.total, 6, "the trashed note is absent");
        assert!(!names(&page).contains(&"낡은책".to_string()));
        for r in &page.rows {
            assert!(!r.summary.path.starts_with(".trash"), "{}", r.summary.path);
            assert!(!r.folder.starts_with(".trash"), "{}", r.folder);
            assert_eq!(r.cells.len(), 1, "default columns = [file.name]");
        }
        assert!(page.rows.iter().any(|r| r.folder == "book"));
        assert!(page.rows.iter().any(|r| r.folder == "film"));
    }

    // 3. Numeric desc order ("10" > "9" as numbers), id-asc tie-break,
    //    disjoint pages whose union is the full set.
    #[test]
    fn numeric_desc_order_with_id_tiebreak_across_pages() {
        let (_d, v, [b1, _b2, _b3, _b4, _f1, f2]) = seed();
        let yaml = r#"
views:
  - type: table
    order:
      - { property: rating, direction: desc }
    columns: [file.name, rating]
"#;
        let mut r0 = req(0);
        r0.limit = 3;
        let p1 = run(&v, yaml, &r0);
        let mut r1 = req(0);
        r1.offset = 3;
        r1.limit = 3;
        let p2 = run(&v, yaml, &r1);

        assert_eq!(p1.total, 6);
        assert_eq!(p2.total, 6);
        // Numeric, not lexicographic: lexicographic desc would rank "9"
        // above "10" and put 책1 first.
        assert_eq!(names(&p1), vec!["책2", "책1", "영화2"]);
        // The rating-9 tie is broken by MemoId ascending.
        let tie: Vec<MemoId> = p1.rows[1..3].iter().map(|r| r.summary.id).collect();
        assert_eq!(tie, vec![b1.min(f2), b1.max(f2)]);
        // 8, then 7, then the rating-less row last (regardless of desc).
        assert_eq!(names(&p2), vec!["영화1", "책3", "책4"]);
        // Pages are disjoint and cover the full dataset.
        let ids1: HashSet<MemoId> = p1.rows.iter().map(|r| r.summary.id).collect();
        let ids2: HashSet<MemoId> = p2.rows.iter().map(|r| r.summary.id).collect();
        assert!(ids1.is_disjoint(&ids2), "pages overlap: {ids1:?} ∩ {ids2:?}");
        let union: HashSet<MemoId> = ids1.union(&ids2).copied().collect();
        assert_eq!(union.len(), 6);
    }

    // 4. Group-major order, group_counts sum to total, group slice.
    #[test]
    fn group_major_order_counts_and_group_slice() {
        let (_d, v, [b1, b2, _b3, _b4, _f1, _f2]) = seed();
        let yaml = r#"
views:
  - type: table
    groupBy: { property: status, direction: asc }
    columns: [file.name, status]
"#;
        let mut r = req(0);
        r.include_group_counts = true;
        let page = run(&v, yaml, &r);
        assert_eq!(page.total, 6);
        // Group-major: contiguous blocks in Unicode asc key order
        // (보는중 U+BCF4 < 완독 U+C644 < 읽는중 U+C77D).
        let statuses = status_cells(&page);
        let mut blocks: Vec<&String> = Vec::new();
        for s in &statuses {
            if blocks.last() != Some(&s) {
                blocks.push(s);
            }
        }
        assert_eq!(
            blocks,
            vec![
                &"보는중".to_string(),
                &"완독".to_string(),
                &"읽는중".to_string()
            ]
        );
        let counts = page.group_counts.clone().expect("group_counts");
        let got: Vec<(String, usize)> = counts.iter().map(|c| (c.key.clone(), c.count)).collect();
        assert_eq!(
            got,
            vec![
                ("보는중".to_string(), 1),
                ("완독".to_string(), 3),
                ("읽는중".to_string(), 2),
            ]
        );
        assert_eq!(counts.iter().map(|c| c.count).sum::<usize>(), page.total);

        // Board-style slice: only the 읽는중 rows, order preserved.
        let mut rg = req(0);
        rg.group = Some("읽는중".to_string());
        rg.include_group_counts = true;
        let pg = run(&v, yaml, &rg);
        assert_eq!(pg.total, 6, "total stays the capped dataset size");
        let got_ids: Vec<MemoId> = pg.rows.iter().map(|r| r.summary.id).collect();
        let mut want = vec![b1, b2];
        want.sort();
        assert_eq!(got_ids, want);
    }

    // 5. The view limit is a hard cap on total AND group_counts.
    #[test]
    fn limit_caps_total_and_group_counts() {
        let (_d, v, _ids) = seed();
        let yaml = r#"
views:
  - type: table
    groupBy: { property: status, direction: asc }
    limit: 2
"#;
        let mut r = req(0);
        r.include_group_counts = true;
        let page = run(&v, yaml, &r);
        assert_eq!(page.total, 2);
        assert_eq!(page.rows.len(), 2);
        let counts = page.group_counts.expect("group_counts");
        let got: Vec<(String, usize)> = counts.iter().map(|c| (c.key.clone(), c.count)).collect();
        assert_eq!(got, vec![("보는중".to_string(), 1), ("완독".to_string(), 1)]);
        assert_eq!(counts.iter().map(|c| c.count).sum::<usize>(), page.total);
    }

    // 6. Formula cells: age >= 0 everywhere; a formula erroring on one
    //    row yields a cell error and the row stays. Clock DTO echoes.
    #[test]
    fn formula_cells_and_error_keeps_row() {
        let (_d, v, _ids) = seed();
        let yaml = r#"
formulas:
  age: '(now() - file.created).days()'
  num: 'rating + 0'
views:
  - type: table
    columns: [file.name, formula.age, formula.num]
"#;
        // Pin the clock 2 days ahead of every created_at.
        let now_ms = (OffsetDateTime::now_utc() + Duration::days(2)).unix_timestamp() * 1000;
        let mut r = req(0);
        r.now_ms = Some(now_ms);
        r.local_offset_seconds = Some(32_400); // KST
        let page = run(&v, yaml, &r);
        assert_eq!(page.total, 6);
        for row in &page.rows {
            match row.cells[1].value.as_ref().expect("age value") {
                Value::Num(n) => assert!(*n >= 0.0, "age was {n}"),
                other => panic!("age cell was {other:?}"),
            }
        }
        // 책4 has no rating → `rating + 0` errors there; the row stays.
        let b4_idx = page
            .rows
            .iter()
            .position(|row| matches!(&row.cells[0].value, Some(Value::Str(s)) if s == "책4"))
            .expect("책4 row kept");
        let b4 = &page.rows[b4_idx];
        assert!(b4.cells[2].error.is_some(), "{:?}", b4.cells[2]);
        for (i, row) in page.rows.iter().enumerate() {
            if i != b4_idx {
                assert!(row.cells[2].error.is_none(), "{:?}", row.cells[2]);
                assert!(matches!(&row.cells[2].value, Some(Value::Num(_))));
            }
        }
        // Clock DTO echo: RFC 3339 round-trip at ms precision.
        assert_eq!(page.clock.local_offset_seconds, 32_400);
        let parsed = OffsetDateTime::parse(&page.clock.now_utc, &Rfc3339).unwrap();
        assert_eq!(parsed.unix_timestamp() * 1000, now_ms);
    }

    // 7. `this.*` filter outside an embed: rows drop, warnings non-empty.
    #[test]
    fn this_ref_without_this_id_warns() {
        let (_d, v, _ids) = seed();
        let yaml = r#"
views:
  - type: table
    filters: this.note.status == "보는중"
"#;
        let page = run(&v, yaml, &req(0));
        assert_eq!(page.total, 0, "this.note.* is Null outside embeds");
        assert!(
            page.warnings.iter().any(|w| w.contains("this.note")),
            "{:?}",
            page.warnings
        );
    }

    // 8. view_index out of range is an error.
    #[test]
    fn view_index_out_of_range_errors() {
        let (_d, v) = tmp_vault();
        let def = crate::base::parse_base("views:\n  - type: table\n").unwrap();
        let err = v.run_base(&BaseSource::Inline(def), &req(99)).unwrap_err();
        assert!(err.to_string().contains("view index out of range"), "{err}");
    }

    // 9. Summaries over the capped dataset: numeric promotion, Null
    //    exclusion, per-row error exclusion with a warning.
    #[test]
    fn summaries_average_sum_and_error_exclusion() {
        let (_d, v, _ids) = seed();
        let yaml = r#"
formulas:
  num: 'rating + 0'
views:
  - type: table
    columns: [file.name]
    summaries: { formula.num: Sum, rating: Average, status: Filled }
"#;
        let mut r = req(0);
        r.include_summaries = true;
        let page = run(&v, yaml, &r);
        assert_eq!(page.total, 6);
        let sums = page.summaries.as_ref().expect("summaries");
        // rating: 9+10+7+8+9 over the five rated rows (책4 Null excluded) = 8.6.
        let avg = sums.get("rating").expect("rating summary");
        assert_eq!(avg.name, "Average");
        assert_eq!(avg.value, Value::Num(43.0 / 5.0));
        // formula.num errors on 책4 → excluded with a warning; the sum
        // still aggregates the other five rows.
        let sum = sums.get("formula.num").expect("formula.num summary");
        assert_eq!(sum.name, "Sum");
        assert_eq!(sum.value, Value::Num(43.0));
        assert!(
            page.warnings
                .iter()
                .any(|w| w.contains("formula.num") && w.contains("excluded")),
            "{:?}",
            page.warnings
        );
        let filled = sums.get("status").expect("status summary");
        assert_eq!(filled.value, Value::Num(6.0));
    }

    /// `note` with arbitrary PropValue kinds (Bool/Str/List) — used by
    /// the mixed-kind order test.
    fn note_raw(
        v: &Vault,
        folder: &str,
        title: &str,
        props: &[(&str, crate::props::PropValue)],
    ) -> MemoId {
        let n = v
            .create_note(
                folder,
                format!("# {title}\n\n{title} 본문"),
                NoteFormat::Markdown,
            )
            .unwrap();
        v.update_note_with(
            n.id,
            None,
            None,
            Some(PropMutation {
                sets: props
                    .iter()
                    .map(|(k, x)| ((*k).to_string(), x.clone()))
                    .collect(),
                removes: vec![],
            }),
        )
        .unwrap();
        n.id
    }

    // 10. Cross-kind order keys fall back to the spec §2 kind ranking
    //     (Bool < Num < Date < Str < List), inverted uniformly for desc.
    #[test]
    fn mixed_kind_order_keys_use_kind_rank_fallback() {
        let (_d, v) = tmp_vault();
        note_raw(&v, "mix", "F", &[("flag", PropValue::Bool(false))]);
        note_raw(&v, "mix", "T", &[("flag", PropValue::Bool(true))]);
        note_raw(&v, "mix", "S", &[("flag", PropValue::Str("a".into()))]);
        note_raw(&v, "mix", "L", &[("flag", PropValue::List(vec!["x".into()]))]);
        let yaml = "views:\n  - type: table\n    order:\n      - { property: flag, direction: asc }\n";
        let page = run(&v, yaml, &req(0));
        assert_eq!(names(&page), vec!["F", "T", "S", "L"], "Bool < Str < List");
        let yaml_desc =
            "views:\n  - type: table\n    order:\n      - { property: flag, direction: desc }\n";
        let page = run(&v, yaml_desc, &req(0));
        assert_eq!(names(&page), vec!["L", "S", "T", "F"], "desc inverts uniformly");
    }

    // 11. Full-screen Path runs synthesize `this.file.*` from the
    //     `.query` file itself (spec §1); `this.note.*` stays Null.
    #[test]
    fn full_screen_this_file_synthesized_from_query_file() {
        let (_d, v, _ids) = seed();
        // run() saves at queries/t.query → folder "queries", name "t".
        let yaml = "views:\n  - type: table\n    filters: this.file.folder == \"queries\"\n";
        let page = run(&v, yaml, &req(0));
        assert_eq!(page.total, 6, "folder matches every row through");
        let yaml = "views:\n  - type: table\n    filters: this.file.name == \"t\"\n";
        let page = run(&v, yaml, &req(0));
        assert_eq!(page.total, 6, "name is the .query filename stem");
        let yaml = "views:\n  - type: table\n    filters: this.file.name == \"nope\"\n";
        let page = run(&v, yaml, &req(0));
        assert_eq!(page.total, 0);
        // this.note.* stays Null even with the file scope present.
        let yaml = "views:\n  - type: table\n    filters: 'this.file.folder == \"queries\" && this.note.status == \"읽는중\"'\n";
        let page = run(&v, yaml, &req(0));
        assert_eq!(page.total, 0, "this.note.* is Null full-screen");
    }

    // 12. Embed runs (this_id) resolve this.note.* through the embed
    //     and suppress the outside-embed warning.
    #[test]
    fn embed_this_id_resolves_and_suppresses_warning() {
        let (_d, v, [b1, ..]) = seed();
        let mut r = req(0);
        r.this_id = Some(b1);
        // b1's status is 읽는중 → the constant filter is false for every row.
        let yaml = "views:\n  - type: table\n    filters: this.note.status == \"보는중\"\n";
        let page = run(&v, yaml, &r);
        assert_eq!(page.total, 0);
        assert!(
            !page
                .warnings
                .iter()
                .any(|w| w.contains("outside an embed")),
            "{:?}",
            page.warnings
        );
        // Matching constant keeps every row; still no warning.
        let yaml = "views:\n  - type: table\n    filters: this.note.status == \"읽는중\"\n";
        let page = run(&v, yaml, &r);
        assert_eq!(page.total, 6);
        assert!(
            !page
                .warnings
                .iter()
                .any(|w| w.contains("outside an embed")),
            "{:?}",
            page.warnings
        );
    }

    // -- Task 10: BaseResultCache ------------------------------------

    /// Same key twice → same `result_key`, cache holds one entry.
    #[test]
    fn cache_hit_returns_same_result_key_and_grows_once() {
        let (_d, v, _ids) = seed();
        v.save_base("queries/t.query", "views:\n  - type: table\n", None)
            .unwrap();
        let mut r = req(0);
        r.now_ms = Some(1_700_000_000_000);
        r.local_offset_seconds = Some(0);
        let p1 = run(&v, "views:\n  - type: table\n", &r);
        assert_eq!(v.base_cache_len(), 1, "first call populated cache");
        let p2 = run(&v, "views:\n  - type: table\n", &r);
        assert_eq!(p1.result_key, p2.result_key, "stable result_key");
        assert_eq!(
            v.base_cache_len(),
            1,
            "same fingerprint must not grow the cache"
        );

    }

    /// A new note writes through `meta.redb` → generation changes →
    /// cache miss. Deterministic: `run_base` uses `snapshot_with_gen`
    /// so the result-key gen is the exact post-stat the snapshot
    /// locked in.
    #[test]
    fn cache_misses_on_note_creation() {
        let (_d, v, _ids) = seed();
        let mut r = req(0);
        r.now_ms = Some(1_700_000_000_000);
        r.local_offset_seconds = Some(0);
        let len_before = v.base_cache_len();
        let _ = run(&v, "views:\n  - type: table\n", &r);
        v.create_note(
            "novel",
            "# 새 노트\n\nbody".into(),
            crate::memo::NoteFormat::Markdown,
        )
        .unwrap();
        let _ = run(&v, "views:\n  - type: table\n", &r);
        assert!(
            v.base_cache_len() > len_before,
            "new note must add a fresh cache entry"
        );
    }

    /// Editing the `.query` file changes its bytes → cache miss.
    #[test]
    fn cache_misses_on_query_file_edit() {
        let (_d, v, _ids) = seed();
        v.save_base("queries/t.query", "views:\n  - type: table\n", None)
            .unwrap();
        let mut r = req(0);
        r.now_ms = Some(1_700_000_000_000);
        r.local_offset_seconds = Some(0);
        let p1 = run(&v, "views:\n  - type: table\n", &r);
        std::thread::sleep(std::time::Duration::from_millis(10));
        v.save_base(
            "queries/t.query",
            "views:\n  - type: table\n    name: edited\n",
            None,
        )
        .unwrap();
        let p2 = run(&v, "views:\n  - type: table\n    name: edited\n", &r);
        assert_ne!(p1.result_key, p2.result_key, "file edit → new result_key");
    }

    /// `invalidate_base_caches` drops the result cache too.
    #[test]
    fn invalidate_base_caches_also_clears_result_cache() {
        let (_d, v, _ids) = seed();
        v.save_base("queries/t.query", "views:\n  - type: table\n", None)
            .unwrap();
        let _ = run(&v, "views:\n  - type: table\n", &req(0));
        assert!(v.base_cache_len() >= 1);
        v.invalidate_base_caches();
        assert_eq!(v.base_cache_len(), 0, "result cache cleared");
    }

    /// `result_key` is non-empty and stable across identical requests.
    #[test]
    fn result_key_is_non_empty_and_stable() {
        let (_d, v, _ids) = seed();
        v.save_base("queries/t.query", "views:\n  - type: table\n", None)
            .unwrap();
        let mut r = req(0);
        r.now_ms = Some(1_700_000_000_000);
        r.local_offset_seconds = Some(0);
        let p1 = run(&v, "views:\n  - type: table\n", &r);
        let p2 = run(&v, "views:\n  - type: table\n", &r);
        assert!(!p1.result_key.is_empty());
        assert_eq!(p1.result_key, p2.result_key);
    }

    /// Paging (offset/limit) re-slices one cached dataset: the cache
    /// must not grow across page fetches of the same view.
    #[test]
    fn cache_len_constant_across_paging_and_grows_per_view() {
        let (_d, v, _ids) = seed();
        let mut r = req(0);
        r.now_ms = Some(1_700_000_000_000);
        r.local_offset_seconds = Some(0);
        r.limit = 3;
        for off in [0, 3, 6] {
            r.offset = off;
            let _ = run(&v, "views:\n  - type: table\n", &r);
        }
        assert_eq!(
            v.base_cache_len(),
            1,
            "offset/limit are slices of one cached dataset"
        );
        // A distinct view_index is a distinct execution → new entry.
        let _ = run(
            &v,
            "views:\n  - type: table\n  - type: table\n    name: other\n",
            &req(1),
        );
        assert_eq!(v.base_cache_len(), 2, "distinct view_index grows cache");
    }

    /// Two embeds of the same `.query` in one session (same pinned
    /// clock) differ only by `this_id` — distinct keys, own cells.
    #[test]
    fn distinct_this_ids_get_distinct_result_keys() {
        let (_d, v, ids) = seed();
        v.save_base(
            "queries/t.query",
            "views:\n  - type: table\n    columns: [file.name, this.note.status]\n",
            None,
        )
        .unwrap();
        let mut r = req(0);
        r.now_ms = Some(1_700_000_000_000);
        r.local_offset_seconds = Some(0);
        r.this_id = Some(ids[0]);
        let p1 = v
            .run_base(&BaseSource::Path("queries/t.query".to_string()), &r)
            .unwrap();
        r.this_id = Some(ids[2]);
        let p2 = v
            .run_base(&BaseSource::Path("queries/t.query".to_string()), &r)
            .unwrap();
        assert_ne!(
            p1.result_key, p2.result_key,
            "embed scope is part of the key"
        );
        let cell = |p: &BasePage| match &p.rows[0].cells[1].value {
            Some(Value::Str(s)) => s.clone(),
            other => panic!("expected this.note.status string, got {other:?}"),
        };
        assert_eq!(cell(&p1), "읽는중");
        assert_eq!(cell(&p2), "완독");
    }

    /// Datasets over `RESULT_CACHE_ROW_CAP` rows are computed fresh
    /// and returned UNCACHED (the 64 MiB belt, snapshot-cap pattern).
    #[test]
    fn oversize_datasets_are_not_cached() {
        let (dir, v) = tmp_vault();
        v.ensure_initialized().unwrap();
        // Seed RESULT_CACHE_ROW_CAP + 1 index records in ONE redb
        // transaction — `create_note` and per-record `upsert` both
        // commit per record and would stall the suite. run_base reads
        // the snapshot only, so the index contents are all that
        // matters here.
        let recs: Vec<IndexRecord> = (0..=crate::base::cache::RESULT_CACHE_ROW_CAP as u64)
            .map(|i| IndexRecord {
                id: MemoId(uuid::Uuid::from_u64_pair(i, 0)),
                created_at: OffsetDateTime::UNIX_EPOCH,
                updated_at: OffsetDateTime::UNIX_EPOCH,
                hash: MemoHash::new(""),
                favorite: false,
                path: format!("bulk/n{i}.md"),
                title: Some(format!("n{i}")),
                tags: Vec::new(),
                props: Default::default(),
                deleted: false,
                deleted_at: None,
                preview: String::new(),
            })
            .collect();
        v.with_redb(|idx| idx.upsert_bulk(&recs)).unwrap();
        let mut r = req(0);
        r.now_ms = Some(1_700_000_000_000);
        r.local_offset_seconds = Some(0);
        let page = run(&v, "views:\n  - type: table\n", &r);
        assert!(!page.rows.is_empty());
        assert_eq!(
            page.total,
            crate::base::cache::RESULT_CACHE_ROW_CAP + 1,
            "full oversize dataset is still computed and returned"
        );
        assert_eq!(
            v.base_cache_len(),
            0,
            "oversize dataset must not enter the result cache"
        );
        drop(dir);
    }

    // ---- base_props (Task 11) --------------------------------------------

    /// Seed `n` synthetic non-deleted index records in ONE bulk upsert
    /// (per-record commits stall the suite — see the oversize test
    /// above). `base_props` reads the snapshot only, so the index
    /// contents are all that matters.
    fn bulk_notes(n: u64, props_per: impl Fn(u64) -> Vec<(String, PropValue)>) -> (TempDir, Vault) {
        let (dir, v) = tmp_vault();
        v.ensure_initialized().unwrap();
        let recs: Vec<IndexRecord> = (0..n)
            .map(|i| IndexRecord {
                id: MemoId(uuid::Uuid::from_u64_pair(i, 0xBEEF)),
                created_at: OffsetDateTime::UNIX_EPOCH,
                updated_at: OffsetDateTime::UNIX_EPOCH,
                hash: MemoHash::new(""),
                favorite: false,
                path: format!("bulk/n{i}.md"),
                title: Some(format!("n{i}")),
                tags: Vec::new(),
                props: props_per(i).into_iter().collect(),
                deleted: false,
                deleted_at: None,
                preview: String::new(),
            })
            .collect();
        v.with_redb(|idx| idx.upsert_bulk(&recs)).unwrap();
        (dir, v)
    }

    fn info<'a>(props: &'a [crate::base::PropInfo], key: &str) -> &'a crate::base::PropInfo {
        props
            .iter()
            .find(|p| p.key == key)
            .unwrap_or_else(|| panic!("no catalog entry for {key:?}: {props:?}"))
    }

    #[test]
    fn base_props_select_options_sorted_by_frequency() {
        // status: b×3, x×2, y×2, a×1, c×1 → select; options ordered by
        // frequency desc, ties alpha asc.
        let (_d, v) = bulk_notes(9, |i| {
            let val = match i {
                0 | 1 | 2 => "b",
                3 | 4 => "x",
                5 | 6 => "y",
                7 => "a",
                _ => "c",
            };
            vec![("status".to_string(), PropValue::Str(val.to_string()))]
        });
        let props = v.base_props().unwrap();
        let st = info(&props, "status");
        assert_eq!(st.kinds, vec!["select"]);
        assert_eq!(st.options, vec!["b", "x", "y", "a", "c"]);
    }

    #[test]
    fn base_props_text_when_high_cardinality() {
        // Boundary: exactly 20 distinct Str values → select; 21 → text
        // with empty options.
        let (_d, v) = bulk_notes(21, |i| {
            let mut props = vec![("over20".to_string(), PropValue::Str(format!("w{i:02}")))];
            if i < 20 {
                props.push(("cap20".to_string(), PropValue::Str(format!("v{i:02}"))));
            }
            props
        });
        let props = v.base_props().unwrap();
        assert_eq!(info(&props, "cap20").kinds, vec!["select"]);
        assert_eq!(info(&props, "cap20").options.len(), 20);
        assert_eq!(info(&props, "over20").kinds, vec!["text"]);
        assert!(info(&props, "over20").options.is_empty(), "text has no options");
    }

    #[test]
    fn base_props_date_kind_at_80_percent_iso() {
        // when: 4/5 ISO dates = exactly 80% → date (inclusive ≥80%).
        // when2: 1/3 dates → below threshold → select.
        let (_d, v) = bulk_notes(6, |i| {
            let (when, when2): (Option<&str>, Option<&str>) = match i {
                0 | 1 => (Some("2024-01-01"), None),
                2 => (Some("2024-01-02"), None),
                3 => (Some("2024-01-03"), Some("nope")),
                4 => (Some("maybe"), Some("2024-02-01")),
                // when2 total: 1 ISO date of 3 → 33% → select fallback.
                _ => (None, Some("nah")),
            };
            let mut props = Vec::new();
            if let Some(w) = when {
                props.push(("when".to_string(), PropValue::Str(w.to_string())));
            }
            if let Some(w) = when2 {
                props.push(("when2".to_string(), PropValue::Str(w.to_string())));
            }
            props
        });
        let props = v.base_props().unwrap();
        let when = info(&props, "when");
        assert_eq!(when.kinds, vec!["date"]);
        assert_eq!(
            when.options,
            vec!["2024-01-01", "2024-01-02", "2024-01-03", "maybe"]
        );
        assert_eq!(info(&props, "when2").kinds, vec!["select"]);
    }

    #[test]
    fn base_props_list_bool_and_mixed_kinds() {
        let (dir, v) = tmp_vault();
        v.ensure_initialized().unwrap();
        let recs = vec![
            IndexRecord {
                id: MemoId(uuid::Uuid::from_u64_pair(1, 1)),
                created_at: OffsetDateTime::UNIX_EPOCH,
                updated_at: OffsetDateTime::UNIX_EPOCH,
                hash: MemoHash::new(""),
                favorite: false,
                path: "a/n1.md".to_string(),
                title: Some("n1".to_string()),
                tags: Vec::new(),
                props: vec![
                    ("genre".to_string(), PropValue::List(vec!["a".into(), "b".into()])),
                    ("done".to_string(), PropValue::Bool(true)),
                    ("mood".to_string(), PropValue::Str("ok".into())),
                ]
                .into_iter()
                .collect(),
                deleted: false,
                deleted_at: None,
                preview: String::new(),
            },
            IndexRecord {
                id: MemoId(uuid::Uuid::from_u64_pair(2, 1)),
                created_at: OffsetDateTime::UNIX_EPOCH,
                updated_at: OffsetDateTime::UNIX_EPOCH,
                hash: MemoHash::new(""),
                favorite: false,
                path: "a/n2.md".to_string(),
                title: Some("n2".to_string()),
                tags: Vec::new(),
                props: vec![
                    ("genre".to_string(), PropValue::List(vec!["a".into(), "c".into()])),
                    ("done".to_string(), PropValue::Bool(false)),
                    ("mood".to_string(), PropValue::Bool(true)),
                ]
                .into_iter()
                .collect(),
                deleted: false,
                deleted_at: None,
                preview: String::new(),
            },
        ];
        v.with_redb(|idx| idx.upsert_bulk(&recs)).unwrap();
        let props = v.base_props().unwrap();
        let genre = info(&props, "genre");
        assert_eq!(genre.kinds, vec!["multiselect"]);
        assert_eq!(genre.options, vec!["a", "b", "c"]);
        let done = info(&props, "done");
        assert_eq!(done.kinds, vec!["bool"]);
        assert!(done.options.is_empty());
        // Conflicting observed kinds ride together, alpha-ordered.
        let mood = info(&props, "mood");
        assert_eq!(mood.kinds, vec!["bool", "select"]);
        assert_eq!(mood.options, vec!["ok"]);
        drop(dir);
    }

    #[test]
    fn base_props_unions_folders_and_excludes_soft_deleted() {
        let (dir, v) = tmp_vault();
        v.ensure_initialized().unwrap();
        let rec = |id: u64, path: &str, props: Vec<(String, PropValue)>, deleted: bool| IndexRecord {
            id: MemoId(uuid::Uuid::from_u64_pair(id, 2)),
            created_at: OffsetDateTime::UNIX_EPOCH,
            updated_at: OffsetDateTime::UNIX_EPOCH,
            hash: MemoHash::new(""),
            favorite: false,
            path: path.to_string(),
            title: Some(format!("n{id}")),
            tags: Vec::new(),
            props: props.into_iter().collect(),
            deleted,
            deleted_at: deleted.then_some(OffsetDateTime::UNIX_EPOCH),
            preview: String::new(),
        };
        let recs = vec![
            rec(1, "book/n1.md", vec![("status".into(), PropValue::Str("읽는중".into()))], false),
            rec(2, "film/n2.md", vec![("status".into(), PropValue::Str("보는중".into()))], false),
            rec(
                3,
                "book/n3.md",
                vec![
                    ("status".into(), PropValue::Str("낡은".into())),
                    ("legacy".into(), PropValue::Str("1".into())),
                ],
                true,
            ),
        ];
        v.with_redb(|idx| idx.upsert_bulk(&recs)).unwrap();
        let props = v.base_props().unwrap();
        // One unioned entry across folders...
        let st = info(&props, "status");
        assert_eq!(st.options, vec!["보는중", "읽는중"]);
        // ...and the tombstone contributes neither values nor keys.
        assert!(!st.options.contains(&"낡은".to_string()));
        assert!(props.iter().all(|p| p.key != "legacy"), "{props:?}");
        drop(dir);
    }

    #[test]
    fn base_props_empty_vault_is_empty() {
        // Initialized vault whose index exists but holds no records —
        // the same precondition every snapshot reader (query_notes,
        // run_base) already requires.
        let (_d, v) = tmp_vault();
        v.ensure_initialized().unwrap();
        v.with_redb(|_| Ok(())).unwrap();
        assert!(v.base_props().unwrap().is_empty());
    }

    #[test]
    fn base_props_cached_once_per_generation() {
        let (dir, v) = tmp_vault();
        v.ensure_initialized().unwrap();
        let seed: Vec<IndexRecord> = (0..3)
            .map(|i| IndexRecord {
                id: MemoId(uuid::Uuid::from_u64_pair(i, 3)),
                created_at: OffsetDateTime::UNIX_EPOCH,
                updated_at: OffsetDateTime::UNIX_EPOCH,
                hash: MemoHash::new(""),
                favorite: false,
                path: format!("bulk/n{i}.md"),
                title: Some(format!("n{i}")),
                tags: Vec::new(),
                props: vec![(
                    "status".to_string(),
                    PropValue::Str(if i % 2 == 0 { "a" } else { "b" }.to_string()),
                )]
                .into_iter()
                .collect(),
                deleted: false,
                deleted_at: None,
                preview: String::new(),
            })
            .collect();
        v.with_redb(|idx| idx.upsert_bulk(&seed)).unwrap();

        let first = v.base_props().unwrap();
        assert_eq!(v.base_cache_len(), 1, "one synthetic cache entry");
        let second = v.base_props().unwrap();
        assert_eq!(first, second, "unchanged index is served from the cache");
        assert_eq!(
            v.base_cache_len(),
            1,
            "second call must not grow the cache beyond +1"
        );

        // Generation change: a new record with a fresh key shows up.
        let extra = IndexRecord {
            id: MemoId(uuid::Uuid::from_u64_pair(9, 3)),
            created_at: OffsetDateTime::UNIX_EPOCH,
            updated_at: OffsetDateTime::UNIX_EPOCH,
            hash: MemoHash::new(""),
            favorite: false,
            path: "bulk/n9.md".to_string(),
            title: Some("n9".to_string()),
            tags: Vec::new(),
            props: vec![("fresh".to_string(), PropValue::Str("1".to_string()))]
                .into_iter()
                .collect(),
            deleted: false,
            deleted_at: None,
            preview: String::new(),
        };
        v.with_redb(|idx| idx.upsert_bulk(&[extra])).unwrap();
        let third = v.base_props().unwrap();
        assert!(
            third.iter().any(|p| p.key == "fresh"),
            "new generation must be observed: {third:?}"
        );
        drop(dir);
    }

    #[test]
    fn base_props_options_capped_at_50() {
        // m00..m09 appear twice, s00..s45 once → 56 distinct members;
        // top 50 = the ten m's (freq 2) + s00..s39.
        let (_d, v) = bulk_notes(48, |i| {
            let list: Vec<String> = if i < 2 {
                (0..10).map(|j| format!("m{j:02}")).collect()
            } else {
                let j = i - 2;
                vec![format!("s{j:02}")]
            };
            vec![("genre".to_string(), PropValue::List(list))]
        });
        let props = v.base_props().unwrap();
        let genre = info(&props, "genre");
        assert_eq!(genre.kinds, vec!["multiselect"]);
        assert_eq!(genre.options.len(), 50, "{:?}", genre.options);
        for j in 0..10 {
            assert!(genre.options.contains(&format!("m{j:02}")));
        }
        assert!(genre.options.contains(&"s39".to_string()));
        assert!(!genre.options.contains(&"s40".to_string()));
    }
}
