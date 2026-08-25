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
- `limit` is a hard cap on the view's result set (Bases semantics); the
  request's `offset`/`limit` page *within* that cap. Absent = uncapped.
- Unknown top-level keys and unknown `views[].type` values are preserved
  on round-trip (flatten catch-all); an unknown view type renders as a
  skipped/errored tab rather than failing the whole file — forward
  compatibility with newer app versions.
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
             List(Vec<Value>), Date(OffsetDateTime), Duration(Duration) }
```

`PropValue` (Str|Bool|List — no `Num` variant, `props.rs:28-32`) converts
losslessly; promotion is contextual:

- Ordering (`> < >= <=`) and arithmetic (`+ - * / %`): a `Str` operand is
  promoted to `Num` if numerically parseable, to `Date` if ISO-8601
  parseable. `Date ± Duration → Date`, `Date - Date → Num` (ms).
  Promotion failure is an expression error.
- Equality (`==`/`!=`): cross-type attempts Str↔Num and Str↔Date parses;
  otherwise values are simply unequal (filters must not crash on messy
  data). Lists compare by membership (`note.<multiselect> == "x"` = any
  member equals), matching `PropPredicate::Eq` (`props.rs:138-152`).
- `now()` is **pinned once per request** and passed into the eval context,
  so `now()`-dependent filters/formulas cannot drift between pages of one
  scroll session (`run_base` accepts an optional `now_ms` the frontend
  reuses across pages of the same view).

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

### Ordering consistency (known divergence)

The engine sorts numerically/date-aware; the existing folder chip-bar sort
(`SortSpec::PropAsc` → `prop_sort_key`, `props.rs:289-297`) is plain
lexicographic. Base views use engine ordering; the chip bar keeps its
current behavior in v1. Unifying them belongs to the `PropValue::Num`
work already anticipated in that comment — tracked as a follow-up, not
silently diverged.

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
  `graph_data`, `get_backlinks`) may adopt it opportunistically — same
  correctness, strictly less work.
- Per request, only the formulas actually referenced by the active view
  are evaluated, memoized per row.
- Budget: ≤20k notes, warm page fetch < 30 ms; a `bench`-style test
  asserts the snapshot is built once per generation, not once per call.

### Pipeline

Filter (base AND view, soft-deleted always excluded) → **evaluate
referenced formulas** → sort → page slice. Formula evaluation precedes
sorting because `order`/`groupBy`/`summaries` may reference `formula.*`.

When `groupBy` is set the sort is **group-major**: group key (by
`groupBy.direction`) first, then the view's `order` within each group, and
`offset`/`limit` page over that order — so pages fill groups contiguously
and a section's loaded rows can be compared against its exact count.
Grouping a List-valued property groups by first member.

### Surface

- `crates/oximemo-core/src/base.rs`: `BaseDef` (serde YAML),
  `load_base(path)` (mtime cache, same shape as `folder_schema`,
  `vault.rs:165-189`), `save_base(path, yaml, expected_mtime)`
  (optimistic conflict → error, UI reloads), `delete_base(path)`,
  `list_bases()` (sorted-path walk; duplicate stems resolve to the first
  in sorted order and both rows carry a warn badge).
- `run_base(source, view_index, offset, limit, now_ms?) -> BasePage`
  where `source = Inline(BaseDef) | Path(String)`.
- `BaseRow { summary: MemoSummary, folder: String, format: NoteFormat,
  cells: Vec<Value> }`; `BasePage { rows, total, group_counts, summaries,
  clock_ms }`. `group_counts` and `summaries` are exact over the full
  filtered set; the frontend renders group sections from loaded rows
  (safe because paging is group-major).
- Summary functions: `All Checked Unchecked Empty Filled Unique Average
  Sum Min Max Median`.
- Board loading: per-group paging — the board requests `limit` rows per
  visible group column (`groupBy` + a group-key filter injected into the
  request), never a single flat page. Column headers use `group_counts`.
- Tauri commands: `run_base`, `list_bases`, `load_base`, `save_base`,
  `delete_base`, `base_props` (distinct prop keys + observed kinds + top
  ≤50 values, one snapshot pass, cached per generation).
- Watcher: `is_user_content` (`watcher.rs:102-111`) currently accepts only
  `md|html|markdown|htm` + `oximemo.toml`, so `.query` files are invisible
  today — it must be widened, emitting a new `bases:changed` event.
- CLI: `oximemo base list`, `oximemo base run <path> [--view N]
  [--limit N]`.

## §4 Table view + in-place cell editing

- `ViewMode` gains `Table` (Rust enum + TS literal), available for folders
  too (columns = schema props in schema order; schema-less folders get
  `file.name, tags, file.updated`), sharing the component with query views.
- `views/TableView.tsx`: row virtualization, sticky header, frozen first
  column (`file.name`, click opens the note), column drag-reorder (writes
  back to YAML in query views; not persisted for folders in v1),
  collapsible group sections with exact counts, sticky summary footer.
- Cells by property type: select → badge (`badgeTone`), bool → checkbox,
  date → date input, multiselect → chips, text → inline text; labels via
  `propValueLabel(key, value, t, preset)`. Formula cells are read-only.
- **Editing** reuses PropertyPanel's editors. Required rework:
  - Lift the editors' context (`propKey`, `def: SchemaPropertyDef`,
    `preset`, `value`, `onCommit`) out of PropertyPanel's render tree;
    `BoolEditor`'s `onCommitBool(boolean)` fork is preserved.
  - `commit()` today invalidates only `["memo", id]` + `["memos"]`
    (`PropertyPanel.tsx:712-734`) — it must also invalidate `["base"]`,
    and the `memos:changed` listener (`CardGrid.tsx:469-481`) gains
    `["base"]`/`["bases"]`.
  - `update_memo` returns the **post-transition `NoteDto`**
    (`src-tauri/src/lib.rs:799-814`), so the edited row is reconciled from
    the response — no full refetch, and schema transitions
    (`schema.rs:336-408`) that touch other props show up immediately.
  - **Row-order freeze**: editing rewrites `updated_at`, so a table sorted
    by `note.updated desc` would yank the edited row to the top. While a
    cell in a table has focus or an in-flight commit, that table suppresses
    re-sort/invalidation; order settles on blur.
- `views/BoardView.tsx` (query views only): columns from `group_counts`,
  cards reuse `Card`, per-group paging (§3). Drag commits an
  `update_memo` set of the group property. **A List-valued (multiselect)
  group property disables board drag** — replacing the list would destroy
  the other members; such a query may still group in a table. Dragging to
  그룹 없음 commits a `removes` mutation.
- `cards` / `list` view types are thin adapters over `BasePage.rows`
  reusing `GridView`/`ListView`; they honor filters/order/limit and ignore
  `columns`/`summaries`, and offer no cell editing.

## §5 Query collection surface

- **`stores/ui.ts` gets a tagged location union**, replacing the
  `folderFilter === null` magic:

  ```ts
  type Location =
    | { kind: "folder"; path: string }   // "" = vault root
    | { kind: "all" } | { kind: "favorites" }
    | { kind: "search"; q: string }
    | { kind: "base"; source: { path: string } | { inline: BaseDef } };
  ```

  Exactly one location is active; `folderFilter` survives only as a
  derived getter (`kind === "folder" ? path : null`) so listing queries
  keep their shape, but no decision site reads it directly. Cutover sites:
  `Sidebar.tsx:238,250` (all-notes/favorites highlight),
  `BreadcrumbBar.tsx:111` (crumb labels), `CardGrid.tsx:170`
  (`setNoteViewLocked`), `:185` (listing key), `:1010` (`openCollection`),
  `:1021` (`selectTag`), `:1025` (`setViewMode`), `:1214` (lock button),
  `ui.ts:198-209` (`navigateUp` — ⌘↑ must exit a base to its previous
  location, not to root browse), plus `loadQueryView`/`QUERY_VIEW_KEY`
  (`ui.ts:160-174`), which stays scoped to the smart collections.
  The `inline` variant exists so a fenced block's 「전체 열기」 has a
  target (a fenced block has no path).
- While a base is open: sidebar tag chips / `favoritesOnly` / the search
  box do **not** silently AND into the base — the base's own filters are
  the source of truth. Tag chips and search switch the location away from
  the base (same as clicking a folder), which keeps one visible filter
  model on screen.
- Sidebar **QUERIES** section (below FAVORITES): `list_bases()` rows
  (Database icon, ⚠ on load failure), 「+ 새 쿼리」 creates
  `queries/<unique-name>.query` at the vault root from a starter template.
- Full-screen base surface: per-base view tabs (+「새 뷰 추가」), 「필터」
  builder popover, 「코드」 YAML editor (CodeMirror, save → `save_base`,
  errors annotated from `CoreError::Expr`). In base mode the **global view
  switcher and folder-view lock are hidden** — view tabs replace them.
- View switcher overflow: with `Table` added (and `Calendar` pending) the
  folder header would carry 6-8 icon buttons next to BreadcrumbBar and the
  search input. At ≥6 modes it collapses into a Base UI dropdown.
- Filter builder: condition rows (property dropdown from `base_props`,
  operator, value with observed-value suggestions) over an and/or/not
  tree. Builder state **is** the parsed expression tree, serialized as
  tagged JSON nodes and printed back to YAML on save; a condition that
  doesn't fit `<identifier> <op> <literal>` renders as a single 고급
  expression row (Bases' point-and-click + code duality).
- Creation paths: sidebar 「+」, CommandPalette (`새 쿼리`, `쿼리 열기`),
  and 「이 필터를 쿼리로 저장」 in the chip bar (serializes the active
  `propFilter` into starter YAML).

## §6 Inline embeds

1. `![[query:독서-대시보드]]` — an explicit `query:` marker. The bare
   `![[X]]` form cannot be used: `embeds.ts:31,157` resolves the captured
   string as a **memo id** via `getMemo`, while the wiki-link path
   serializes **titles** (`memoLinks.ts:39,56`), so a name-miss fallback
   would be both unreachable and ambiguous with note titles. The marker
   resolves against a cached `list_bases()` name map.
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
  Results are cached per `(source, index generation)` so a debounced save
  of the containing note does not re-run every embed's full pipeline.
- Embeds request `group_counts: false` / `summaries: false` and a small
  `limit` (default 10, ≤4 columns) — compact, read-only, cell click opens
  the note, footer 「N개 결과 · 전체 열기」 switches location to
  `{ kind: "base", source }` (path form for `![[query:…]]`, inline form
  for a fence). Depth-1: embeds inside embedded notes don't recurse.
- Card previews (`previewText`, 280-char budget) collapse a block to
  `[쿼리: N개 결과]`. HTML-format notes don't render query blocks in v1.

## §7 Synchronization & error handling

- External `.query` edit → widened watcher → `bases:changed` → mtime cache
  invalidated, open view + sidebar reload. In-app save racing an external
  edit → `save_base` mtime conflict → reload prompt.
- Load-time errors (§2 taxonomy) open the surface in code mode with the
  error annotated; the sidebar row shows ⚠; embeds render an error chip.
- Partially-synced/corrupt file (iCloud) → ⚠ state and code-mode
  fallback, never a crash.

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

**Rust — expr (unit + property):** parser round-trip (print→parse
idempotence), precedence table, promotion matrix (Str↔Num, Str↔Date, list
membership equality), duration units, pinned `now()`, error spans, depth
cap. **base/run_base (integration, `tmp_vault()` fixture,
`vault.rs:2573-2576`):** nested filter groups, base∧view filters, formula
chains + cycle rejection, formulas referenced by order/groupBy/summaries,
group-major paging (loaded rows match `group_counts` prefixes), summaries
over the full set, soft-deleted exclusion (a trashed note never appears
and never leaks a `.trash/` folder), `this` in embed vs full-screen,
unknown view type/keys preserved on round-trip, `views: []`
materialization, mtime cache + save conflict, and a snapshot-cache test
asserting one build per index generation.

**Frontend (bun test):** builder↔YAML tagged-JSON round-trip, table cell
commit (optimistic set reconciled from the returned `NoteDto`, `["base"]`
invalidation, row-order freeze while focused), location-union branch
coverage for the sites listed in §5, embed marker resolution, compact
column clamping. **Manual E2E:** view tabs, code editor save/reload,
sidebar section, `![[query:…]]` + fenced block in a live note, board drag
firing a transition, board drag disabled on a multiselect group property.

Browser-mode (`tauri.ts`) query commands return an explicit
"desktop-only" state — no second engine.

## Implementation plans

This spec is **three plans**, not one:

- **Plan A — engine + backend**: snapshot cache, `expr` module, `base.rs`,
  the six Tauri commands, watcher widening, CLI. User-visible surface is
  the CLI; the desktop UI lands in B/C.
- **Plan B — table + editing**: `ViewMode::Table`, `TableView`, cell
  editing rework (editor extraction, `["base"]` invalidation, row-order
  freeze), folder tables.
- **Plan C — query surfaces**: location union cutover, sidebar QUERIES,
  view tabs, filter builder + code editor, inline embeds
  (`![[query:…]]` + fence), `BoardView`, `cards`/`list` adapters, i18n.

Sequencing note: the approved Calendar spec (2026-08-25) also extends
`ViewMode` and the view switcher; whichever lands second rebases, and the
≥6-mode dropdown collapse belongs to whichever lands second.

## Non-goals (v1)

- `file.links` / `file.hasLink` / backlink expressions (needs link edges
  in the snapshot).
- Custom summary formulas; Stddev/Range summaries.
- Board/calendar as folder ViewModes; per-folder column persistence.
- Cell editing inside inline (embedded) results.
- Cross-request result caching beyond the snapshot + per-view/embed
  generation keys defined in §3/§6.
- Browser-mode (`tauri.ts`) query execution; wasm-shared engine.
- Chart/map view types; cross-vault queries; `.query` template gallery.
- Unifying the chip-bar's lexicographic prop sort with the engine's
  type-aware ordering (waits on `PropValue::Num`).

## Review corrections (2026-08-25)

Findings from the post-write design review, all evidence-checked, and what
changed:

| Was | Now |
|---|---|
| `run_base` over `export_since(None)` per call (`vault.rs:1504-1506`, `index.rs:101-120`), caching a non-goal | §3 snapshot cache with generation invalidation + per-request formula memoization + stated budget |
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
| `now()` drift across pages | §2 clock pinned per request, reused across pages |
| Degenerate bases (empty views, unknown type, dup names/stems) | §1 defined |
| "one plan, 6 steps" | Three plans (A/B/C) |
