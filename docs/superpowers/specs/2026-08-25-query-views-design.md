# Query Views — Design

Date: 2026-08-25 · Status: approved (brainstorm 2026-08-25) · revised after
design review 2026-08-25 (see "Review corrections" at the end)

## Goal

Notion-database-view / Obsidian-Bases / dataview-class querying over the
vault, delivered as two surfaces that share one engine:

1. **Query collections** — standalone `.query` files in the vault that
   render as full-screen database views (table/board/cards/list) with
   Notion-style view tabs, a point-and-click filter builder, and a YAML
   code editor.
2. **Inline query blocks** — `![[query:이름]]` embeds and ` ```query `
   fenced blocks rendered live inside notes.

Both are powered by a Bases-compatible expression engine
(`status != "done"`, `now() - "1w"`, `(now() - file.created).days()`)
implemented in `oximemo-core`, evaluated over a cached in-memory index
snapshot — no note-file I/O on the query path — and shared with the CLI
(`oximemo base list|run`).

## Decisions (from brainstorm)

| Question | Decision |
|---|---|
| v1 surfaces | Both (query collections + inline blocks) |
| Editing through the view | Full Notion parity: table cells editable in place |
| Expression power | Bases-grade: formulas + function library |
| Saved-query existence | `.query` YAML files inside the vault (Obsidian `.base` model) |
| Engine | Own Rust engine (`expr` module); CEL crate rejected (no date±duration operator overloads), frontend JS rejected (snapshot transfer, no CLI) |
| Query scope | Whole vault; `file.folder`/`file.inFolder()` narrows |
| Inline blocks | Read-only compact results; editing happens full-screen |
| Board (kanban) | Query views only; scalar group property only |
| Browser fallback (`tauri.ts`) | Out of scope — query surfaces are desktop-only in v1 (a second TS engine is not acceptable) |

## §1 `.query` file format

A standalone YAML file anywhere in the vault (not `.md`, so never indexed
as a note; name = filename stem). Schema mirrors Obsidian Bases:

```yaml
filters:                    # applies to all views; string OR and/or/not map
  and:
    - 'status != "done"'
    - or:
        - 'file.inFolder("book")'
        - 'file.favorite == true'
formulas:                   # computed columns, shared across views
  age: '(now() - file.created).days()'
properties:                 # display config per column
  status: { displayName: 상태 }
views:                      # Notion-style view tabs
  - type: table             # table | board | cards | list
    name: 읽는 중
    filters:                # same union as base-level filters
      and:
        - 'rating >= 4'
        - 'file.hasTag("소설")'
    order:
      - { property: note.updated, direction: desc }
    columns: [file.name, status, note.rating, formula.age]
    groupBy: { property: status, direction: asc }
    summaries: { note.rating: Average }
    limit: 500
```

Structural rules:

- `filters` is the **same union at both levels** — a single expression
  string or a nested `and`/`or`/`not` map. Base and view filters are
  ANDed. (The builder edits either level; a view needs >1 condition.)
- `formulas` may reference other formulas; cycles are a load-time error.
- `properties.<key>.displayName` affects rendering only, never evaluation.
- `order`, `groupBy`, `summaries`, and `columns` may reference any
  identifier including `formula.*`.
- `limit` is a hard cap on the view dataset (Bases semantics), applied
  after filter/sort and before `total`/`group_counts`/`summaries`; the
  request's `offset`/`limit` page *within* that capped dataset. Absent =
  uncapped.
- Unknown top-level keys are preserved semantically on builder
  round-trip via flatten catch-all. Comments/whitespace/quote style are
  not preserved when the builder rewrites YAML; direct code-mode saves
  preserve the raw text. `views[].type` is stored as a string, not a
  closed serde enum, so an unknown view type is preserved and renders as
  a skipped/errored tab rather than failing the whole file.
- `views: []` (or a missing `views`) auto-materializes one default
  `table` view in memory; it is written to disk on first edit.
- Duplicate view names get a `(2)`-style suffix in the tab strip only;
  YAML is untouched. `view_index` addresses views positionally.

### Identifier resolution

| Namespace | Resolves to |
|---|---|
| `file.*` | `created`, `updated`, `favorite`, `tags`, `path`, `folder`, `name`, `format` |
| `note.*` / bare | frontmatter props; **falls back to the `file.*` core field when the key is one of `CORE_KEYS`** (`props.rs:19` excludes `id/created/updated/favorite/deleted` from props, so `created`/`favorite` must resolve through the core fallback — Bases-like behavior) |
| `formula.*` | other formulas in the same file |
| `this.*` | the embedding note (embeds); full-screen see below |
| unknown key | `Null`, never an error |

- `file.folder` and `file.format` are **derived in the engine from
  `summary.path`** (folder = path up to the last `/`, format = extension).
  `MemoSummary` (`memo.rs:137-157`) carries neither field, and widening it
  would touch every listing's serialization for no gain.
- `file.name` = the derived H1 title when present, else the filename stem
  (without extension). This is the value used for display, sort, and group.
- `file.inFolder(p)` is a **recursive prefix** match (`p` or `p/…`);
  `file.folder == "book"` is the exact-folder form.
- **Soft-deleted notes are always excluded** from every base pipeline
  (their paths live under `.trash/…` and would otherwise leak into
  `file.folder`). There is no `file.deleted` identifier — trashed notes are
  simply not part of the dataset.
- `this.*` full-screen: a `.query` file is not a note, so `this.file.*` is
  synthesized from the `.query` file itself (`path`, `folder`, `name`,
  `created`/`updated` from fs mtimes) and every `this.note.*` is `Null`.
  Filters that depend on `this.note.*` are a load-time warning outside
  embeds.

## §2 Expression engine (`crates/oximemo-core/src/expr/`)

Modules: `lexer.rs`, `parser.rs` (Pratt precedence climbing),
`value.rs`, `eval.rs`, `funcs.rs`.

```rust
enum Value { Null, Bool(bool), Num(f64), Str(String),
             List(Vec<Value>), Date(OffsetDateTime), Duration(DurationSpec) }
struct DurationSpec { calendar_months: i32, fixed_millis: i64 }
struct EvalClock { now_utc: OffsetDateTime, local_offset: UtcOffset }
```

`time::Duration` alone cannot represent calendar months/years: `1M` from
January 31 is not a fixed number of seconds. `y`/`M` compile into
`calendar_months`; `w`/`d`/`h`/`m`/`s` into `fixed_millis`. Date
arithmetic applies calendar months first (clamping to the target month's
last day), then the fixed duration. `today()` and date fields use the
request's pinned system-local UTC offset; stored timestamps remain UTC.

`PropValue` (Str|Bool|List — no `Num` variant, `props.rs:28-32`) converts
losslessly; promotion is contextual:

- Ordering (`> < >= <=`) and arithmetic (`+ - * / %`): a `Str` operand is
  promoted to `Num` if numerically parseable, to `Date` if ISO-8601
  parseable. `Date ± Duration → Date`, `Date - Date → Num` (ms).
  Promotion failure is an expression error.
- Equality (`==`/`!=`): cross-type attempts Str↔Num and Str↔Date parses;
  otherwise values are simply unequal. Lists compare by membership
  (`note.<multiselect> == "x"` = any member equals), matching
  `PropPredicate::Eq` (`props.rs:138-152`).
- Division by zero and non-finite numeric results are expression errors;
  `NaN`/infinity never enter sort/group/summary keys.
- `now()` is pinned once per **view session**, not independently per
  page. The first `run_base` response returns `clock_ms` and
  `local_offset_seconds`; later pages reuse both.

Operators: `+ - * / %`, `== != > < >= <=`, `! && ||`, member access `.`,
index `[]`, calls, string/number/bool literals, duration-string arithmetic
(`now() - "1w"`; units `y M w d h m s`). None of these exist in today's
`PropOp { Eq, In, Contains }` (`props.rs:105-114`) — the engine is a new
module, not an extension of `PropPredicate`.

Function library (v1):

| Group | Functions |
|---|---|
| Global | `now() today() date(s) list(...) if(c,a,b) isEmpty(v) isBlank(v) typeof(v) length(v)` |
| String | `contains startsWith endsWith lower upper trim replace split join` (+ method forms) |
| List | `includes first last unique sort` |
| Numeric | `round floor ceil abs min max sum mean` |
| Date | fields `.year .month .day .hour .minute .second .weekday`, `format(fmt)`, `.days()` |
| File | `file.hasTag(t) file.inFolder(prefix)` |

Safety: no assignment, no loops, no recursion; call depth capped.
Evaluation is total and terminating by construction.

### Error taxonomy

| Error | Destination |
|---|---|
| YAML parse failure, formula cycle, unresolved `formula.x` reference, column referencing a non-existent formula | **load-time** error — surface opens in code mode with line/col |
| Filter expression type error | **query-fatal** (result set undefined) — view shows the error, no partial rows |
| Per-row error in a cell expression | `⚠︎` cell + tooltip, row kept |
| Per-row error in an `order` key | sorts last |
| Per-row error in a `groupBy` key | 그룹 없음 bucket |
| Per-row error in a `summaries` input | excluded from that aggregate |

`CoreError::Expr { message, line, col }` carries the position.

### Deterministic ordering and known divergence

Engine ordering is total and stable: after contextual promotion, values
sort `Bool < Num < Date < Str < List < Null/error`; strings use
case-sensitive Unicode scalar order, lists compare by first member.
Every order ends with `MemoId` ascending as an implicit tie-breaker —
required so offset pages never duplicate/skip equal-key rows.

The existing folder chip-bar sort (`SortSpec::PropAsc` →
`prop_sort_key`, `props.rs:289-297`) is plain lexicographic. Base views
use the engine order; the chip bar keeps its current behavior in v1.
Unifying them belongs to the `PropValue::Num` work already anticipated
in that comment — tracked as a follow-up, not silently diverged.

## §3 Execution pipeline (backend)

### Snapshot cache (prerequisite)

`query_notes` today does `export_since(None)` per call — a full `by_sort`
scan plus one `by_id.get` + JSON deserialization per note, then one
`to_summary()` clone per record (`vault.rs:1504-1506`,
`index.rs:101-120`). `run_base` would multiply that by every open view,
every "load more", every visible inline embed, and every `base_props`
call, with full-set formulas/group_counts/summaries on top. So the cache
is part of this spec, not a non-goal:

- `Vault::snapshot() -> (generation: u64, Arc<Vec<IndexRecord>>)` — built
  once, held behind the existing lock, bumped/invalidated by any index
  write (`upsert`/`remove`/`reindex`/`reindex_path`).
- `run_base`, `base_props`, and `query_notes` all read the cached
  snapshot. Existing full-scan callers (`memo_stats`, `list_facets`,
  `graph_data`, `get_backlinks`) may adopt it opportunistically.
- Snapshot caching alone is insufficient: offset page 2 must not
  re-filter/re-evaluate 20k rows. `BaseResultCache` stores the evaluated,
  ordered row ids + referenced cell values + group counts + summaries.
  Key = `(source_fingerprint, view_index, index_generation, clock,
  include_group_counts, include_summaries)`, where a path source
  fingerprint includes the `.query` content hash/mtime and an inline
  source fingerprint hashes its canonical AST. This prevents stale
  results after a query edit and keeps `now()` results session-stable.
  Pages are slices of this cached result.
- Formula evaluation covers the transitive dependency closure reachable
  from active filters/columns/order/groupBy/summaries only, memoized once
  per row per result key.
- Both caches are bounded: snapshot budget ≤64 MiB; result-cache LRU ≤16
  keys / 64 MiB. Eviction only costs recomputation. Target: ≤20k notes,
  warm page slice < 30 ms. Tests assert one snapshot/result build per key
  and generation; wall-clock targets live in benchmarks, not CI asserts.

### Pipeline

Pipeline: filter (base AND view, soft-deleted always excluded) →
**evaluate referenced formulas** → deterministic group-major sort →
apply the view's hard `limit` → compute `total`/`group_counts`/summaries
over that capped dataset → return a page slice. Formula evaluation
precedes sorting because `order`/`groupBy`/`summaries` may reference
`formula.*`.

When `groupBy` is set, group key (`groupBy.direction`) sorts first, then
the view's `order` within each group, then the implicit MemoId tie-breaker.
`offset`/`limit` page over that stable order. Grouping a List property
uses its first member; missing/error values enter 그룹 없음.

### Surface

- `crates/oximemo-core/src/base.rs`: `BaseDef` (serde YAML),
  `load_base(path)` (mtime cache, same shape as `folder_schema`,
  `vault.rs:165-189`), `save_base(path, yaml, expected_mtime)`,
  `rename_base(from, to, expected_mtime)`, `trash_base(path)`, and
  `restore_base(token)`. Query deletion is a move to
  `.trash/_queries/`, never an irreversible unlink. `list_bases()` skips
  `.trash`, `_assets`, and hidden/reserved app directories.
- Every path command canonicalizes the vault root + parent, rejects
  `..`, absolute paths, symlink escapes, reserved directories, and a
  non-`.query` extension before any read/write/move.
- `list_bases()` walks in sorted path order. A duplicate stem is marked
  ambiguous; no API silently selects the first.
- `run_base(source, view_index, offset, limit, clock?, group?) ->
  BasePage`, where `source = Inline(BaseDef) | Path(String)` and optional
  `group` selects one canonical group key for board column paging.
- `BaseCell { value: Option<Value>, error: Option<ExprError> }`;
  `BaseRow { summary: MemoSummary, folder: String, format: NoteFormat,
  cells: Vec<BaseCell> }`; `BasePage { rows, total, group_counts,
  summaries, clock, result_key }`. `BaseCell` is required by §2's
  per-cell ⚠︎ contract; `Vec<Value>` cannot carry an error tooltip.
- Summary functions: `All Checked Unchecked Empty Filled Unique Average
  Sum Min Max Median`.
- Board loading: one `run_base(..., group: Some(key))` page per visible
  scalar group column. Counts and columns come from the same capped
  cached result key, so per-group pages cannot exceed the view limit.
- Tauri commands: `run_base`, `list_bases`, `load_base`, `save_base`,
  `rename_base`, `trash_base`, `restore_base`, `base_props`.
  `base_props` returns `{ key, observed_types, options }`; a key with
  conflicting observed/schema types offers only equality/contains in
  the builder until the user switches to an advanced expression.
- Watcher: `is_user_content` (`watcher.rs:102-111`) currently accepts only
  `md|html|markdown|htm` + `oximemo.toml`, so `.query` must be added.
  Query changes emit `bases:changed`, clear path-matching result keys,
  and invalidate the mtime/name caches.
- CLI: `oximemo base list`, `oximemo base run <path> [--view N]
  [--limit N]`, `oximemo base rename`, `oximemo base trash|restore`.

## §4 Table view + in-place cell editing

- `ViewMode` gains `Table` (Rust enum + TS literal), available for folders
  too (columns = schema props in schema order; schema-less folders get
  `file.name, tags, file.updated`), sharing the component with query views.
- `views/TableView.tsx`: row virtualization, sticky header, frozen first
  column (`file.name`, click opens the note), column drag-reorder (writes
  back to YAML in query views; not persisted for folders in v1),
  collapsible group sections with exact counts, sticky summary footer.
- Cells by property type: select → badge (`badgeTone`), bool → checkbox,
  date → date input, multiselect → chips, text → inline text; formula
  cells are read-only.
- A base can cross folders whose schemas give the same key different
  types/vocabularies. `TableView` batches `folder_schema` for the unique
  `BaseRow.folder` values (the existing `useSchemaInfo(paths)` pattern)
  and chooses the editor + `propValueLabel` preset **per row**. Missing
  schema falls back to the runtime PropValue shape; a conflicting key
  does not borrow another folder's schema.
- Editable matrix:
  - `note.*` / bare frontmatter props: typed editor.
  - `file.favorite`: existing favorite mutation.
  - `file.name`, tags, created/updated, path/folder/format, and every
    `formula.*`: read-only. Tags are derived data today, not a
    `PropMutation`; title/path rename is a separate workflow.
- **Editing** reuses PropertyPanel's editors. Required rework:
  - Lift editor context (`propKey`, `def`, row `preset`, `value`,
    `onCommit`) out of PropertyPanel; preserve `BoolEditor`'s boolean
    callback fork.
  - `commit()` today invalidates only `["memo", id]` + `["memos"]`
    (`PropertyPanel.tsx:712-734`) — it must also invalidate `["base"]`.
    `memos:changed` (`CardGrid.tsx:469-481`) invalidates `["base"]`;
    `bases:changed` alone invalidates `["bases"]`.
  - `update_memo` returns the post-transition `NoteDto`
    (`src-tauri/src/lib.rs:799-814`), so the row reconciles from that
    response and transition side effects appear immediately.
  - Editing a table sorted by updated time freezes only the displayed row
    id order. Values still patch and invalidations mark the result stale;
    the queued result swaps in on blur/commit. External changes are never
    discarded by suppressing invalidation.
- `views/BoardView.tsx` uses a BoardCard adapter/drag mode instead of
  Card's folder-move drag contract. Drag commits the scalar group prop;
  List-valued group props disable board drag, while table grouping still
  works. Dragging to 그룹 없음 commits a `removes` mutation.
- `cards` / `list` are note-only adapters over `BasePage.rows` reusing
  Card rendering and virtualization, not GridView/ListView's folder-card
  handlers. They honor filters/order/limit, ignore columns/summaries, and
  offer no cell editing.

## §5 Query collection surface

- **`stores/ui.ts` gets a tagged browse-location union**, replacing the
  `folderFilter === null` magic without conflating search with navigation:

  ```ts
  type Location =
    | { kind: "folder"; path: string }   // "" = vault root
    | { kind: "all" } | { kind: "favorites" }
    | { kind: "base"; source: { path: string } | { inline: BaseDef } };
  ```

  Existing `search` + `searchScope: "folder"|"all"` remain a transient
  overlay; folder-scoped search must not be regressed into a location
  variant. Entering a base clears search and hides the global search
  input; query filtering/searching happens through the base filter
  builder. Clicking a tag or starting global search first exits the base
  to the previous non-base location.

  Exactly one location is active; `folderFilter` survives only as a
  derived getter (`kind === "folder" ? path : null`) so listing IPC keeps
  its shape, but no decision site reads it directly. Cutover sites:
  `Sidebar.tsx:238,250`, `BreadcrumbBar.tsx:111`,
  `CardGrid.tsx:170,185,1010,1021,1025,1214`,
  `ui.ts:160-174,198-209`. ⌘↑ exits a base to its recorded previous
  non-base location. The `inline` source lets a fenced block's
  「전체 열기」 open without first saving a file.
- While a base is open, sidebar tags/favorites do not silently AND into
  it. Their actions leave the base first; the base's own filter builder is
  the single visible query model.
- Sidebar **QUERIES** section (below FAVORITES): `list_bases()` rows
  (Database icon, ⚠ on load failure/ambiguous stem). 「+ 새 쿼리」 creates
  `queries/<unique-name>.query`; context actions rename or move it to the
  query trash, with an undo action backed by `restore_base`.
- Full-screen base surface: per-base view tabs (+「새 뷰 추가」), 「필터」
  builder popover, 「코드」 YAML editor (CodeMirror, save → `save_base`,
  errors annotated from `CoreError::Expr`). In base mode the global
  search, view switcher, and folder-view lock are hidden — view tabs and
  the builder replace them.
- View switcher overflow: with `Table` added (and `Calendar` pending) the
  folder header would carry 6-8 icons. At ≥6 modes it collapses into a
  Base UI dropdown.
- Filter builder: condition rows (property dropdown from `base_props`,
  operator, value with observed-value suggestions) over an and/or/not
  tree. Builder state is the parsed expression tree, serialized as tagged
  JSON nodes and printed to YAML on save; a condition that doesn't fit
  `<identifier> <op> <literal>` renders as one 고급 expression row.
- Creation paths: sidebar 「+」, CommandPalette (`새 쿼리`, `쿼리 열기`),
  and 「이 필터를 쿼리로 저장」 in the chip bar.

## §6 Inline embeds

1. `![[query:독서-대시보드]]` (unique stem) or
   `![[query:queries/독서-대시보드.query]]` (explicit vault-relative
   path). The bare `![[X]]` form is reserved for memo ids
   (`embeds.ts:31,157`), while wiki-link insertion serializes titles
   (`memoLinks.ts:39,56`). A duplicate stem is an error listing candidate
   paths — never an arbitrary first match.
2. ` ```query ` fenced block with inline YAML (one view's worth of keys).

- New `queryExtension` (CM6) — **not** a reuse of `embedExtension`:
  `embeds.ts` emits one single-line `Decoration.replace({block:true})` per
  matched line (`embeds.ts:110-118`), which cannot span a fence. The new
  extension walks `syntaxTree` for `FencedCode` nodes whose info string is
  `query` and renders the result **as a widget below the fence, leaving
  the YAML visible and editable** (Obsidian Bases' model). This also
  avoids fighting `@atomic-editor/editor`'s `fencedCodeSelectionPlugin`,
  which decorates selections inside fences. The `![[query:…]]` form keeps
  the existing single-line block-replace shape.
- The StateField/ViewPlugin orchestration pattern (visible-range resolve,
  effect-driven cache, widgets never fetch) is reused for both forms.
  Widget keys use the backend `result_key` (§3), which includes source
  content fingerprint, view, index generation, clock, and aggregate
  flags. `.query` edits and note-index updates therefore cannot serve a
  stale widget.
- Embeds request `group_counts: false` / `summaries: false` and a small
  `limit` (default 10, ≤4 columns) — compact, read-only, cell click opens
  the note, footer 「N개 결과 · 전체 열기」 switches location to
  `{ kind: "base", source }` (path form for `![[query:…]]`, inline form
  for a fence). Depth-1: embeds inside embedded notes don't recurse.
- Card previews (`previewText`, 280-char budget) collapse a block to
  `[쿼리: N개 결과]`. HTML-format notes don't render query blocks in v1.

## §7 Synchronization & error handling

- External `.query` edit → widened watcher → `bases:changed` → mtime/name
  caches and source-matching result keys invalidated; open view + sidebar
  reload. In-app save racing an external edit → mtime conflict → reload.
- Rename is an atomic guarded fs rename. Delete moves into
  `.trash/_queries/` and returns a restore token; normal `list_bases`
  never scans that directory.
- Load-time errors (§2 taxonomy) open in code mode with annotation;
  sidebar shows ⚠; embeds render an error chip.
- Partially-synced/corrupt file (iCloud) → ⚠ + code-mode fallback, never
  a crash.

## §8 i18n

New keys (ko source of truth, en mirrored): `section_queries`,
`query_new`, `query_open`, `query_save_as_collection`, `query_filter`,
`query_builder_add_condition`, `query_builder_advanced`, `query_new_view`,
`query_code`, `query_open_full`, `query_results_n`, `query_error_parse`,
`query_error_filter`, `query_conflict_reload`, `query_unknown_view_type`,
`view_table`, `view_board`, `view_cards`, `view_list`,
`summary_{all,checked,unchecked,empty,filled,unique,average,sum,min,max,median}`,
`group_none` (그룹 없음). None collide with the existing
`query_all_notes`/`query_favorites`/`query_search`/`query_tags`
(`locales/en.ts:403-406`). Property/value labels reuse
`propKeyLabel`/`propValueLabel`.

## §9 Testing

`oximemo-core` dev-dependencies today are `tempfile` only
(`Cargo.toml:42-43`) — this work adds `proptest`.

**Rust — expr (unit + property):** parser round-trip, precedence,
promotion matrix, list membership, calendar-aware month/year arithmetic
(Jan 31 + 1M clamps correctly; leap years), pinned local clock,
division-by-zero/non-finite rejection, total ordering + MemoId tie-break,
error spans, depth cap. **base/run_base (integration, `tmp_vault()`
fixture, `vault.rs:2573-2576`):** nested filters, base∧view filters,
formula dependency closure/cycles, formula order/group/summary keys,
group-major stable paging, view-limit-before-aggregate semantics,
per-group board paging, soft-deleted exclusion, `this` embed/full-screen,
unknown view type/keys semantic preservation, `views: []`, mtime/save
conflict, path traversal/symlink/reserved-directory rejection,
rename/trash/restore, duplicate-stem ambiguity, one snapshot build per
generation, and one evaluated-result build per complete result key.

**Frontend (bun test):** builder↔YAML tagged-AST round-trip, table cell
commit + returned-NoteDto reconciliation, per-row cross-schema editor
selection, core/formula read-only matrix, queued row-order refresh,
browse-location branch coverage with folder-scoped search preserved,
unique-stem/path embed resolution and ambiguous-stem error, compact
column clamping, board group request and BoardCard drag mode. **Manual
Tauri E2E:** tabs, code save/reload, sidebar rename/trash/undo,
`![[query:…]]` + fenced block, board transition, multiselect drag disabled.

Browser-mode (`tauri.ts`) query commands return an explicit
"desktop-only" state — no second engine.

## Implementation plans

This spec is **six implementation plans** with independently demonstrable
surfaces:

- **Plan A — query foundation**: generation snapshot cache + bounded
  evaluated-result cache, `expr`, `base.rs`, guarded file CRUD, watcher,
  Tauri commands, CLI. Demonstrated through CLI.
- **Plan B — table + editing**: `ViewMode::Table`, TableView, editor
  extraction, row-specific schema selection, cache invalidation,
  returned-NoteDto reconciliation, stable-order queue. Demonstrated on
  normal folders without `.query` UI.
- **Plan C — base navigation shell**: browse-location union migration,
  Sidebar QUERIES CRUD/undo, view tabs, YAML code editor, base-mode
  header. Demonstrated by opening/editing a hand-written `.query`.
- **Plan D — filter builder**: typed prop catalog, and/or/not builder,
  advanced-expression rows, tagged-AST↔YAML serialization.
- **Plan E — inline embeds**: explicit marker/path resolution, fenced-code
  extension, result-key widget cache, compact full-screen handoff.
- **Plan F — alternate layouts**: BoardView + BoardCard drag mode and
  per-group paging, then cards/list note-only adapters.

Sequencing note: the approved Calendar spec (2026-08-25) also extends
`ViewMode` and the view switcher; whichever lands second rebases, and the
≥6-mode dropdown collapse belongs to whichever lands second.

## Non-goals (v1)

- `file.links` / `file.hasLink` / backlink expressions (needs link edges
  in the snapshot).
- Custom summary formulas; Stddev/Range summaries.
- Board/calendar as folder ViewModes; per-folder column persistence.
- Cell editing inside inline (embedded) results.
- Result caches are bounded by §3; persistent/on-disk compiled-query or
  formula caches are out of scope.
- Browser-mode (`tauri.ts`) query execution; wasm-shared engine.
- Chart/map view types; cross-vault queries; `.query` template gallery.
- Unifying the chip-bar's lexicographic prop sort with the engine's
  type-aware ordering (waits on `PropValue::Num`).

## Review corrections (2026-08-25)

Findings from the post-write design review, all evidence-checked, and what
changed:

| Was | Now |
|---|---|
| `run_base` over `export_since(None)` per call (`vault.rs:1504-1506`, `index.rs:101-120`), caching a non-goal | §3 bounded snapshot + evaluated-result caches with generation/content/clock keys and stated budgets |
| No deleted-note policy; pipeline bypassed `MemoFilter` (`memo.rs:290-291`) | §1: soft-deleted always excluded, `file.deleted` removed |
| `baseFilter` "alongside" `folderFilter`, colliding with 10+ `null` branches | §5 tagged `Location` union + explicit cutover list |
| `![[name]]` resolving via memo-id miss (`embeds.ts:157` vs `memoLinks.ts:56`) | §6 explicit `![[query:이름]]` marker + name map |
| Fenced block "same resolver plugin" as embeds (`embeds.ts:110-118` is per-line) | §6 new `queryExtension` over `syntaxTree` `FencedCode`, result rendered below a still-editable fence |
| Formulas evaluated after sort while order/groupBy/summaries may be formulas | §3 formulas evaluated before sort |
| Examples used `favorite`/`note.created`, which `CORE_KEYS` excludes from props (`props.rs:19`) | §1 core-key fallback rule + corrected examples |
| `file.folder`/`file.format` assumed on `MemoSummary` (`memo.rs:137-157` has neither) | §1 derived from `path` in the engine row |
| View-level `filters` a bare string, builder produced trees | §1 same union at both levels |
| Group pagination undefined (interleaved pages vs exact counts) | §3 group-major ordering; board pages per group |
| Board drag on a multiselect group property | §4 drag disabled for List-valued group keys |
| Error taxonomy covered only filters and cells | §2 error table incl. load-time, order, group, summary |
| `cards`/`list` advertised, unspecified | §4 thin adapters, explicit limitations |
| Watcher assumed to see `.query` (`watcher.rs:102-111` excludes it) | §3 widening called out as required work |
| PropertyPanel `commit()` assumed to invalidate base queries | §4 `["base"]` invalidation + `NoteDto` reconciliation |
| Sort churn on cell edit unaddressed | §4 row-order freeze while focused |
| View switcher growth unaddressed | §5 dropdown collapse at ≥6 modes |
| Browser fallback parity in testing | Desktop-only decision; explicit unsupported state |
| `quickcheck` assumed present (`Cargo.toml:42-43`: only `tempfile`) | §9 adds `proptest` |
| Chip-bar vs engine sort divergence unmentioned | §2 documented + follow-up |
| view `limit` vs request `offset/limit` undefined | §1 view limit caps, request pages within |
| `now()` drift across pages | §2 clock pinned per view session and reused across pages |
| Degenerate bases (empty views, unknown type, dup names/stems) | §1/§6 define defaults, string view types, and ambiguity errors |
| "one plan, 6 steps" | Six independently demonstrable implementation plans |

## Final review corrections (2026-08-25)

- Replaced fixed `Duration` with calendar-aware `DurationSpec` and pinned
  local-time evaluation; month/year arithmetic is no longer falsely
  described as fixed seconds.
- Added deterministic total ordering + MemoId tie-break for stable pages.
- Added a bounded evaluated-result cache; snapshot caching alone did not
  prevent O(notes × formulas) recomputation on every offset page.
- Made result keys include query content, generation, clock, view, and
  aggregate flags so edited `.query` files/`now()` cannot reuse stale data.
- Made cell errors representable in the DTO (`BaseCell`), and made board
  group paging representable in `run_base(group?)`.
- Separated browse location from the existing folder-scoped search
  overlay; the earlier `location.kind = search` would regress search.
- Defined row-specific schema/editor selection and the core-field
  read-only matrix for cross-collection table results.
- Replaced irreversible query deletion with guarded rename/trash/restore;
  added traversal/symlink/reserved-path protection and trash scan exclusion.
- Replaced ambiguous stem \"first match\" with explicit-path support and
  an ambiguity error.
- Split the still-oversized frontend plan into navigation shell, builder,
  embeds, and alternate-layout plans.
