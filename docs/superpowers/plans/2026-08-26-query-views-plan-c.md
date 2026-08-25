# Query Views — Plan C (Base Navigation Shell) Implementation Plan

**Goal:** Spec §5 navigation + query-collection shell: tagged `Location` union in
`stores/ui.ts` (base entry/exit, ⌘↑, search interactions), Sidebar QUERIES
section (list/create/rename/trash+undo), full-screen `BaseView` (view tabs,
YAML code editor with annotated save, table rendering over `run_base`),
creation paths (palette + chip-bar save-as). Demonstrated by opening and
editing a hand-written `.query`.

Foundation already landed (Plan A): Tauri commands + `api.ts` wrappers
(`runBase/listBases/loadBase/saveBase/renameBase/trashBase/restoreBase/baseProps`)
and wire types (`BasePage/BaseRow/BaseCell/BaseInfo/LoadBaseDto/PropInfo`).

**Spec:** `docs/superpowers/specs/2026-08-25-query-views-design.md` §5, §7, §8.
Spec wins over this plan; flag conflicts in task reports.

## Constraints

- Conventional commits, English. UI copy Korean (ko source, en mirror).
- One new dependency is authorized: `@codemirror/lang-yaml` (spec names a
  CodeMirror YAML editor; CM6 core packages already present).
- No repo-wide formatter runs; format only touched files.
- Each task ends green: `cd apps/desktop && bun run build && bun test`;
  Rust-touching tasks add `cargo test -p oximemo-core`.
- Line numbers refer to current HEAD; re-locate by symbol.

## Tasks

### Task 1 — `Location` union in `stores/ui.ts`

- `type Location = { kind: "folder"; path: string } | { kind: "all" } |
  { kind: "favorites" } | { kind: "base"; source: { path: string } | { inline: string } }`
  (`inline` carries raw YAML — the fenced-block handoff, spec §5).
- `location: Location` is the single source of truth. `folderFilter` and
  `favoritesOnly` become **derived getters** (`folderFilter` non-null iff
  `kind === "folder"`; `favoritesOnly` iff `kind === "favorites"`) so the
  listing IPC and existing queries keep their shape — but no decision site
  may read them for navigation decisions (grep-audit after cutover).
- `setFolderFilter(path | null)` maps onto location (`null` → `all`);
  favorites toggle → `favorites`. New actions: `openBase(source)` (records
  `lastNonBaseLocation`, clears search), `exitBase()` (⌘↑ and tag/search
  exits restore it), `saveAsBaseLastNonBase` accessor for chip-bar.
- Cutover audits: `Sidebar.tsx`, `BreadcrumbBar.tsx`, `CardGrid.tsx`,
  `ui.ts` — replace `folderFilter === null` navigation branches with
  location-kind checks; folder-scoped search overlay semantics unchanged.
- Base mode interactions (spec §5): entering a base clears search and hides
  the global search input + view switcher + folder-view lock; tag clicks /
  global search start first `exitBase()`.
- Acceptance: `bun run build && bun test` green; existing flows (folder
  browse, all/favorites, search, ⌘↑ folder nav) unchanged; new unit tests
  for openBase/exitBase/state mapping in a `stores/ui.test.ts`.

### Task 2 — Sidebar QUERIES section

- Below FAVORITES: `useQuery(["bases"], listBases)`; rows with Database
  icon (lucide `Database`), `⚠` when `loadable === false` (title = path).
  Click → `openBase({ path })`. `bases:changed` Tauri event (already
  emitted by the watcher) invalidates `["bases"]` — add the listener where
  `memos:changed` is handled.
- 「+ 새 쿼리」: creates `queries/<기본-이름>.query` via `saveBase` with a
  starter def (one default table view), then `openBase`.
- Context menu: 이름 변경 (`renameBase`, inline prompt), 삭제 → 휴지통
  (`trashBase`) with an undo toast action (`restoreBase(token)`) — same
  toast-action pattern as note trash.
- i18n: `section_queries`, `query_new`, `query_rename`, `query_delete`,
  `query_deleted_undo` (ko/en).
- Acceptance: build+tests; sidebar section renders from a scratch `.query`
  in dev vault (manual browser check with mock or desktop run).

### Task 3 — `BaseView` full-screen surface + table rendering

- New `components/BaseView.tsx` mounted by CardGrid when
  `location.kind === "base"` (base mode replaces the normal header: no
  global search / view switcher / folder lock — spec §5).
- Data: `useQuery(["base", sourceKey, viewIndex, offset, limit, flags], () =>
  runBase(source, req))`; first response pins the clock (`nowMs`/
  `localOffsetSeconds`) in component state for later pages/refreshes.
- Header: base name, view tabs from the loaded def (`loadBase` for path
  sources; parse inline YAML for inline), 「+ 새 뷰 추가」 appends a default
  table view through `saveBase` (path sources only; inline sources are
  read-only), 「필터」 button disabled with tooltip "Plan D" until Plan D
  lands, 「코드」 toggles the YAML editor (Task 4).
- Duplicate view names get `(2)` suffix in the tab strip only (spec §1).
- Load-time error (parse/cycle/unresolved formula): open in code mode with
  the error message annotated (spec §2 taxonomy); tab strip hidden.
- Unknown `views[].type`: tab preserved, body renders an error notice
  (`query_unknown_view_type`), never fails the file (spec §1).
- `board`/`cards`/`list` types: temporary 「지원 예정」 notice panel —
  replaced by Plan F rendering (documented here, not in code comments).
- Table rendering: extend `TableView` with `columns?: TableColumn[]`
  override + `formulaCells?: (rowId, key) => BaseCell | undefined` +
  `onColumnsReordered?(cols)`; base mode maps `view.columns` entries:
  `file.name` → name, `tags` → tags, `note.<k>`/bare → prop, `formula.<k>`
  → new `{ kind: "formula"; key }` read-only cell (value formatted via a
  `formatBaseValue`, `⚠` + title on `error`). Column drag in base mode
  writes the new order back through `saveBase` (YAML `columns` list —
  spec §4 write-back; folder mode stays session-only). Cell editing on
  prop columns reuses the existing commit path; `["base"]` invalidation
  already wired in Plan B.
- Row identity for freeze/reconcile: `BaseRow.summary` is a `MemoSummary`.
- Acceptance: hand-written scratch `.query` (filters + formula + groupBy +
  summaries) renders; paging (load-more) works; warnings surfaced as a
  muted line; build+tests green.

### Task 4 — YAML code editor

- `components/BaseCodeEditor.tsx`: CodeMirror 6 (`EditorView` +
  `@codemirror/lang-yaml`), save on ⌘S/blur → `saveBase(path, text,
  expectedMtimeMs)`; mtime conflict → toast `query_conflict_reload` with a
  reload action (re-`loadBase`); `CoreError::Expr` line/col surfaced as a
  CM6 diagnostic decoration when save fails.
- Save success invalidates `["bases"]` (sidebar) and `["base"]` (results).
- Acceptance: edit → save → tabs/results update; stale mtime → conflict
  toast; parse error → annotation + stay in code mode.

### Task 5 — Creation paths

- CommandPalette: `새 쿼리` (create+open), `쿼리 열기…` (lists `listBases`
  entries) — `paletteCommands.ts` + callbacks from App shell; i18n
  `query_open`.
- Chip bar (prop query active): 「이 필터를 쿼리로 저장」 builds a `.query`
  YAML from the current include/exclude/matchAll chips (`filters.and`
  string rows) and saves via `saveBase`; i18n `query_save_as_collection`.
- Acceptance: palette creates+opens; chip-bar path round-trips the same
  result set as the live chip filter.

## Deferred (explicit)

- Filter builder popover = Plan D (button ships disabled).
- Board/cards/list rendering = Plan F (notice panel in the interim).
- `inline` source opening from embeds = Plan E (union member lands now).
