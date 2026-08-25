# Query Views — Design

Date: 2026-08-25 · Status: approved (brainstorm session 2026-08-25)

## Goal

Notion-database-view / Obsidian-Bases / dataview-class querying over the
vault, delivered as two surfaces that share one engine:

1. **Query collections** — standalone `.query` files in the vault that
   render as full-screen database views (table/cards/list/board) with
   Notion-style view tabs, a point-and-click filter builder, and a YAML
   code editor.
2. **Inline query blocks** — `![[query-name]]` embeds and ` ```query `
   fenced blocks rendered live inside notes.

Both are powered by a Bases-compatible expression engine
(`status != "done"`, `now() - "1w"`, `(now() - note.created).days()`)
implemented in `oximemo-core`, evaluated in-memory over the redb index
snapshot — no note-file I/O on the query path — and shared with the CLI
(`oximemo base list|run`).

## Decisions (from brainstorm)

| Question | Decision |
|---|---|
| v1 surfaces | Both (query collections + inline blocks) in one spec |
| Editing through the view | Full Notion parity: cells editable in-place in v1 |
| Expression power | Bases-grade: formulas + function library (not just filters) |
| Saved-query existence | `.query` YAML files inside the vault (Obsidian `.base` model) |
| Engine | Own Rust engine (`expr` module), Bases-compatible syntax; CEL crate rejected (no date±duration operator overloads), frontend JS rejected (snapshot transfer, no CLI) |
| Query scope | Whole vault by default; `file.folder`/`file.inFolder()` narrows |
| Inline blocks | Read-only compact results (limit 10, ≤4 columns); editing happens in the full-screen view |
| Board (kanban) | Query views only in v1, not a folder ViewMode |

## §1 `.query` file format

A standalone YAML file anywhere in the vault (`.md`-less, so never indexed
as a note; name = filename stem). Schema mirrors Obsidian Bases:

```yaml
filters:                    # applies to all views; and/or/not nested
  and:
    - 'status != "done"'
    - or:
        - 'file.inFolder("book")'
        - 'favorite == true'
formulas:                   # computed columns, shared across views
  age: '(now() - note.created).days()'
properties:                 # display config per property
  status: { displayName: 상태 }
views:                      # Notion-style view tabs
  - type: table             # table | cards | list | board
    name: 읽는 중
    filters: 'rating >= 4'  # view-level, ANDed with base filters
    order:
      - { property: note.updated, direction: desc }
    columns: [file.name, status, note.rating, formula.age]
    groupBy: { property: status, direction: asc }
    summaries: { note.rating: Average }
    limit: 50
```

Structural rules:

- `filters` at base level and per view are logically equivalent; evaluation
  concatenates them with AND (Bases semantics).
- `formulas` may reference other formulas (`formula.age`); cycles are a
  load-time error.
- `properties.<key>.displayName` affects rendering only, never evaluation.
- Unknown top-level YAML keys are preserved on round-trip (flatten
  catch-all map) so newer app versions / hand edits don't lose data.
- Identifier namespaces: `note.*` (or bare `*`) = frontmatter props,
  `file.*` = core fields, `formula.*` = other formulas, `this.*` =
  embedding note when embedded (falls back to the base file's own context
  when opened full-screen — Bases `this` semantics).

`file.*` fields: `created` (Date), `updated` (Date), `favorite` (Bool),
`tags` (List<Str>), `folder` (Str, vault-relative), `path` (Str),
`name` (Str, derived title or filename stem), `format` (`markdown|html`),
`deleted` (Bool). Unknown prop access yields `Null` — never an error.

## §2 Expression engine (`crates/oximemo-core/src/expr/`)

Modules: `lexer.rs`, `parser.rs` (Pratt precedence climbing),
`value.rs`, `eval.rs`, `funcs.rs`.

Value model:

```rust
enum Value { Null, Bool(bool), Num(f64), Str(String),
             List(Vec<Value>), Date(DateTime<Utc>), Duration(Duration) }
```

`PropValue` (Str|Bool|List) converts losslessly; promotion is contextual:

- Ordering (`> < >= <=`) and arithmetic (`+ - * / %`): a `Str` operand is
  promoted to `Num` if numerically parseable, to `Date` if ISO-8601
  parseable; `Date ± Duration` and `Date - Date → Num(ms)` are defined.
  Promotion failure is an expression error.
- Equality (`==`/`!=`): cross-type attempts Str↔Num and Str↔Date parses;
  otherwise values are simply unequal (filters must not crash on messy
  data). Same-type comparison is exact; lists compare by membership for
  `note.<multiselect> == "x"` (any member equals — matches existing
  `PropPredicate::Eq` semantics).

Operators (Bases set): `+ - * / %`, `== != > < >= <=`, `! && ||`,
member access `.`, index `[]`, calls, string/number/bool literals,
duration string arithmetic (`now() - "1w"`; units `y M w d h m s`).

Function library (v1):

| Group | Functions |
|---|---|
| Global | `now() today() date(s) list(...) if(cond,a,b) isEmpty(v) isBlank(v) typeof(v) length(v)` |
| String | `contains startsWith endsWith lower upper trim replace split join` (+ method forms) |
| List | `includes first last unique sort` |
| Numeric | `round floor ceil abs min max sum mean` |
| Date | fields `.year .month .day .hour .minute .second .weekday`, `format(fmt)` |
| File | `file.hasTag(t) file.inFolder(prefix)` |

Safety: the language has no assignment, no loops, no recursion; call depth
capped. Evaluation is total and terminating by construction.

Errors: `CoreError::Expr { message, line, col }`. Filter-expression errors
are query-fatal (result set undefined); per-row formula errors are not —
the cell renders `⚠︎` with the message as tooltip (Bases behavior).

## §3 Execution pipeline (backend)

- `BaseDef` (serde, from YAML) in a new `crates/oximemo-core/src/base.rs`;
  `load_base(path)` with mtime cache (same pattern as `folder_schema`),
  `save_base(path, yaml)` with optimistic mtime conflict check
  (`Expected-mtime` param; mismatch → conflict error, UI re-loads),
  `delete_base(path)` (plain file delete + confirm dialog; `.query` files
  are outside the note trash system by design).
- `list_bases() -> Vec<BaseInfo { path, name, mtime }>` — vault scan,
  cached, invalidated by `bases:changed`.
- `run_base(source, view_index, offset, limit) -> BasePage`:
  - `source` = `Inline(BaseDef)` (builder preview, fenced blocks) or
    `Path(vault-relative)` (saved query, reloaded through the cache).
  - Pipeline over the index snapshot (same in-memory path as
    `query_notes`; never reads note files): base filters AND view filters
    → multi-key stable sort (`order`; missing values sort last) → formula
    evaluation → page slice.
  - `BasePage { rows, total, group_counts, summaries, error_cells? }`:
    `rows: Vec<BaseRow>` where `BaseRow = { summary: MemoSummary, cells:
    Vec<Value> }` (one per resolved column); `group_counts` — when
    `groupBy` is set, exact per-group counts over the *full* filtered set
    (frontend groups loaded rows client-side and shows exact counts);
    `summaries` — `{ column_id: { name, value } }` over the full set.
  - Grouping by a List-valued property groups by first member (v1).
- Summary functions v1: `All Checked Unchecked Empty Filled Unique Average
  Sum Min Max Median` (Bases defaults minus Stddev/Range; custom summary
  formulas are a non-goal).
- New Tauri commands: `run_base`, `list_bases`, `load_base`, `save_base`,
  `delete_base`, `base_props` (distinct prop keys + observed value kinds +
  top ≤50 values each, one snapshot pass — feeds builder dropdowns
  Notion-style with observed values).
- Watcher: `.query` files become watched; changes emit a new
  `bases:changed` event (sidebar list, open views, embeds invalidate).
  Note edits keep using `memos:changed`; the renderer's invalidation list
  gains `['base']` and `['bases']` keys.
- CLI: `oximemo base list`, `oximemo base run <path> [--view N]
  [--limit N]` — ASCII table output.

## §4 Table view + in-place cell editing

- `ViewMode` gains `Table` (config enum + TS literal). Table is available
  for **folders too** (columns = schema props in schema order; schema-less
  folders get `file.name, tags, file.updated`), sharing the component with
  query views. Folder tables don't persist column customization in v1
  (schema-driven); query views carry explicit `columns`.
- `views/TableView.tsx`: row virtualization (`@tanstack/react-virtual`),
  sticky header, frozen first column (`file.name`, opens the note on
  click), column drag-reorder (in-query-view order writes back to YAML),
  group section headers (collapsible, exact counts from `group_counts`),
  sticky summary footer.
- Cell render by property type: select → badge (`badgeTone`), bool →
  checkbox, date → date popover, multiselect → chips, text → inline text;
  preset vocabulary via existing `propValueLabel(key, value, t, preset)`.
  Formula cells are read-only, visually muted.
- **Cell editing** reuses PropertyPanel's editors (`SelectEditor
  ChipsEditor DateEditor BoolEditor TextEditor`). Commit → existing
  `update_memo` with `sets/removes` → `apply_transitions` runs as today
  (e.g. `status → done` stamps the completion date) → `memos:changed` →
  `['base']`/listing queries refetch. Optimistic update on the edited row.
- Board (`views/BoardView.tsx`, query views only in v1): columns =
  `groupBy` groups from `group_counts`, cards reuse the existing `Card`
  compact form; drag between columns commits a `update_memo` set of the
  group property — transitions fire exactly as in table cells.

## §5 Query collection surface

- `stores/ui.ts`: new `baseFilter: string | null` (vault-relative `.query`
  path) alongside `folderFilter`; setting it switches CardGrid into base
  view mode (the smart-collection `folderFilter === null` lane is
  untouched).
- Sidebar gains a **QUERIES** section (below FAVORITES): `list_bases()`
  rows (Database icon, name, ⚠ on parse failure), click → open. "+ 새 쿼리"
  creates `queries/<name>.query` under the vault root with a starter
  template.
- Full-screen base view (CardGrid in base mode): view tabs from
  `views[].name` (plus 「새 뷰 추가」), right-aligned controls — 「필터」
  (builder popover), 「코드」 (YAML toggle: CodeMirror editor inline,
  save → `save_base`, parse errors annotated with line/col from
  `CoreError::Expr`), view-type switcher per tab.
- Filter builder (Notion-style): condition rows (property dropdown fed by
  `base_props`, operator dropdown, value input with observed-value
  suggestions) organized as and/or group tree. Builder state is the
  expression tree itself — conditions that fit the "simple form"
  (`<prop> <op> <literal>`) render as rows; anything else collapses into a
  single "고급" expression row (Bases' point-and-click + code duality).
  Saving writes YAML via `save_base`.
- Creation paths: sidebar "+", CommandPalette `새 쿼리` / `쿼리 열기
  <name>`, and 「이 필터를 쿼리로 저장」 in CardGrid's chip bar while a
  prop filter is active (serializes the current `propFilter` into the
  starter YAML).

## §6 Inline embeds

Two syntaxes, one renderer:

1. `![[독서-대시보드]]` — reference to a saved `.query` by name (filename
   stem). `embeds.ts` gains a resolution branch: memo-id lookup misses →
   `list_bases()` name match (duplicate stems: first by path order, warn
   badge).
2. ` ```query ` fenced block with inline YAML body (filters/columns/order/
   limit; same schema as a view) — Bases' "embed in a code block" model.

- Editor: new `queryExtension` mirroring `embeds.ts` (StateField cache +
  ViewPlugin resolving visible blocks + block-replacement widget;
  depth-1 — no nested re-render inside embeds; 800-char-class budget
  n/a, results render compact). The fence is a multi-line range (unlike
  the single-line embed regex); the same resolver plugin handles both.
- Rendering: compact read-only table (default limit 10, ≤4 columns,
  title column frozen), footer "N개 결과 · 전체 열기" → opens the base
  full-screen (fenced blocks synthesize an `Inline` source). Cell click →
  open note. Loading / parse-error / empty states mirror embed widgets.
- Card previews (`previewText`, 280-char budget): blocks collapse to
  `[쿼리: N개 결과]` — live results never enter preview text.
- HTML-format notes: fences are not rendered (plain code block);
  markdown-only in v1.

## §7 Synchronization & error handling

- `.query` edited externally while app open → watcher → `bases:changed` →
  open view reloads (mtime cache invalidated). In-app save races an
  external edit → `save_base` mtime conflict → reload prompt.
- YAML parse failure: full-screen falls back to code mode with the error
  annotated; sidebar row shows ⚠; embeds render a small error chip.
- Runtime per-row formula errors: `⚠︎` cell + tooltip; row stays.
- Partially-synced/corrupt file (iCloud): load failure → ⚠ state, code
  mode fallback, never a crash.

## §8 i18n

New keys (ko source of truth, en mirrored): `section_queries`,
`query_new`, `query_open`, `query_save_as_collection`, `query_filter`,
`query_builder_add_condition`, `query_builder_advanced`,
`query_new_view`, `query_code`, `query_open_full`, `query_results_n`,
`query_error_parse`, `query_conflict_reload`, `view_table`, `view_board`,
`summary_all/checked/unchecked/empty/filled/unique/average/sum/min/max/
median`, `group_none` (그룹 없음). Property/value labels reuse
`propKeyLabel`/`propValueLabel`.

## §9 Testing

**Rust — expr (unit):** lexer/parser round-trips (quickcheck: parse→print
→parse idempotent), precedence table, contextual promotion matrix
(Str↔Num, Str↔Date, list membership equality), duration units, error
spans (line/col), depth cap. **run_base (integration, tmp-vault
fixture):** filter combinations incl. nested and/or/not, view+base filter
AND, multi-key sort with missing-last, group counts over full set vs
paged rows, summaries, `this` context, formula chains + cycles rejected
at load, unknown-key tolerance on YAML round-trip, mtime cache + conflict.

**Frontend (bun test):** builder↔YAML serialization round-trip (simple
form ↔ rows, advanced form passthrough), TableView cell-commit flow
(optimistic set + transitions path), embed resolution (memo-id miss →
base-name hit), compact table column clamping. **Manual/E2E:** full-screen
view tabs, code editor save/reload, sidebar section, inline `![[...]]`
and fenced block in a live note, board drag → transition fires, browser
fallback (`tauri.ts`) parity for `run_base`/`list_bases` over the local
store.

## Implementation order

1. `expr` engine + tests → 2. `base.rs` + `run_base`/`load/save/list` +
   CLI → 3. `TableView` + cell editing (+ `ViewMode::Table`) →
   4. Query collection surface (sidebar, builder, code editor) →
   5. Inline embeds (`![[name]]` + fenced blocks) → 6. `BoardView`.

Each step ships independently usable. Sequencing note: the approved
Calendar spec (2026-08-25) also extends `ViewMode` and the view switcher;
whichever implementation plan lands second rebases on the first.

## Non-goals (v1)

- `file.links` / `file.hasLink` / backlink expressions (needs link edges
  in the index snapshot — natural follow-up).
- Custom summary formulas; Stddev/Range summaries.
- Board/calendar as folder ViewModes (query views only).
- Cell editing inside inline (embedded) results.
- Per-folder custom table column persistence (folders are schema-driven).
- Chart/timeline/map query view types; cross-vault queries; formula
  result caching; `.query` file templates gallery.
