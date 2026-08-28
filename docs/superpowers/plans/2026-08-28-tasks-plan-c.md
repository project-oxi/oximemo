# Tasks Plan C — View Adapters and Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The frontend consumes Plan A/B's task core end to end: every base view renders task rows keyed by `row_id`, task cells toggle through guarded `patch_task`, the CM6 editor gets live checkbox/field widgets backed by the pure Rust transformer (browser mode by a golden-tested TS mirror), an edit popover, field auto-suggest, icon-chip metadata rendering, and inert card previews.

**Architecture:** Two render contexts share one semantic component vocabulary (§7.0): React surfaces (`TaskFieldChip`, `TaskCheckbox`) and CM6 widget DOM (CSS `mask-image` with inlined lucide SVGs). All editor mutations flow through ONE pure transform (`transform_task_draft` on desktop, `lib/taskLine.ts` mirror in browser, both verified against a Rust-generated fixture corpus); all out-of-editor mutations flow through strict `patch_task(TaskSelector::Exact)`. Row identity becomes `BaseRow.row_id` (`n:<id>` / `t:<id>:<line>`), generation-scoped: local view state resets when `result_key` changes.

**Tech Stack:** React 19 + TS + Tailwind 4 tokens, CodeMirror 6 (`@codemirror/view` ^6.43.7, `@codemirror/autocomplete` ^6.20.3 — both already direct deps), `lucide-react` ^0.460.0, `@base-ui-components/react` 1.0.0-rc.0 Popover, `marked` ^14.1.3, Tauri 2 commands, `bun test`. No new dependencies.

## Global Constraints

- Governing spec: `docs/superpowers/specs/2026-08-27-tasks-design.md` §4 (view-adapter bullets), §7.0–§7.5, §12 (i18n keys), §13 (Frontend + Manual E2E bullets). Line anchors below were verified against the current tree; re-verify before citing in commits.
- Rust gates still apply when Rust is touched: `cargo test -p oximemo-core -p oximemo-cli` 0 fail, `cargo clippy -p oximemo-core -p oximemo-cli -- -D warnings` clean, `cargo fmt --check` clean. The Tauri crate (`apps/desktop/src-tauri`) must keep `cargo check` clean.
- Frontend tests: `cd apps/desktop && bun test` (pattern: `src/lib/*.test.ts`, e.g. `summaryFolder.test.ts`). Every task adds or extends a `*.test.ts` for its pure logic. Visual components are verified by the Manual E2E checklist in the DoD, not by unit tests.
- Wire-DTO discipline (the v0.10.0 crash rule): `lib/types.ts` mirrors Rust serde output 1:1, snake_case, `line_hash`/`memo_id` are strings; UI-derived fields live in a separate repair layer (`summaryFolder.ts` precedent), never inside the wire type.
- Browser fallback: task QUERY commands (`list_tasks`, `patch_task`, `add_task`, `move_tasks`) are desktop-only — the browser fallback rejects them with a typed error; browser-mode editor transforms use the `lib/taskLine.ts` mirror (non-goal: a second query parser).
- Icons: the §7.0 catalog table is the single mapping; React uses `lucide-react` components, CM6 widgets use static SVG masks from the same pinned catalog; a parity test asserts every catalog entry has both.
- Dates are local-only (`lib/dates.ts` conventions: `todayLocalISO`, `isoToLocalDate`, `daysBetween`); never construct `new Date(iso)` across UTC.
- Korean is the source locale: new keys land in `locales/ko.ts` (`as const satisfies Record<string, string>`) and the typed mirror `locales/en.ts` (`Record<keyof typeof ko, string>`) in the same task. Rust never hardcodes Korean.
- `today` is caller-local: every transform/patch call passes the frontend's local date (`todayLocalISO`); the backend never guesses.
- Do not touch: `stores/` semantics beyond the added `pendingTaskAnchor`, `.ox-query-embed` existing CSS (extend, don't restyle), the sidebar calendar (§9 non-goal).

## File Structure

New files (all under `apps/desktop/src`):
- `lib/taskLine.ts` — browser transform mirror + minimal task-line parsing/splicing (fixture-verified)
- `lib/taskFixtures.json` — Rust-generated golden corpus (committed)
- `lib/taskNav.ts` — `openTask(TaskRef)` repair flow + row-identity helpers
- `lib/taskIcons.ts` — the §7.0 catalog as data (field → lucide component name + CSS mask class)
- `lib/relativeDay.ts` — `relativeDayLabel(iso, todayISO, locale)` + midnight `todayKey` hook
- `components/TaskFieldChip.tsx`, `components/TaskCheckbox.tsx` — shared semantic components
- `components/TaskEditPopover.tsx` — §7.2 popover
- `lib/taskCheckboxes.ts` — CM6 widget extension factory
- `lib/taskSuggest.ts` — §7.3 CompletionSource factory
- `lib/taskPreview.ts` — preview preprocessing (extended markers → inert chips)

Modified: `src-tauri/src/lib.rs` (commands), `lib/types.ts`, `lib/api.ts`, `lib/tauri.ts`, `lib/tableModel.ts`, `lib/markdownPreview.ts`, `lib/chatMarkdown.ts` (if it shares preprocessing), `components/{BaseView,TableView,BoardView,BaseAdapters,MemoDetail,MemoEditorForm,MarkdownEditor}.tsx`, `components/views/*`, `lib/queryEmbeds.ts`, `lib/locales/{ko,en}.ts`, `app.css`, `stores/ui.ts`.
Rust: `crates/oximemo-core/src/tasks.rs` (fixture-emitting test), `apps/desktop/src-tauri/src/lib.rs`.
---

### Task 1: Golden fixture corpus + browser transform mirror (`lib/taskLine.ts`)

**Files:**
- Create: `apps/desktop/src/lib/taskLine.ts`, `apps/desktop/src/lib/taskFixtures.json`, `apps/desktop/src/lib/taskLine.test.ts`
- Modify: `crates/oximemo-core/src/tasks.rs` (test module only — fixture emitter)

**Interfaces:**
- Consumes: `transform_task_draft`, `parse_task_line`, `TasksConfig` (Plan A, unchanged).
- Produces (TS, consumed by Tasks 2/8/9/10):
  - `parseTaskLine(raw: string, cfg: TaskLineCfg): ParsedLine | null` — `{ symbol, statusType, text, spans: { checkbox, fields: Array<{ field, start, end }> } }`
  - `type TaskEdit = { kind: "toggle" } | { kind: "status"; symbol: string } | { kind: "date"; field: "created"|"start"|"scheduled"|"due"|"done"|"cancelled"; value: string | null } | { kind: "priority"; value: "highest"|"high"|"medium"|"low"|"lowest"|null } | { kind: "text"; value: string } | { kind: "recurrence"; value: string | null }` — defined mirror-local (the mirror must not import Tauri types); Task 2's `types.ts` wire types are structurally identical and add a compile-time alias check (`type WireTaskEditMatches = WireTaskEdit extends TaskEdit ? true : never`) to keep the two in lockstep.
  - `transformTaskDraft(body: string, line: number, edit: TaskEdit, todayISO: string, cfg: TaskLineCfg): { changes: Array<{ startLine: number; deleteLines: number; insertLines: string[] }> }`
  - `type TaskLineCfg = { writeFormat: "emoji" | "dataview"; globalFilter: string; recurrenceInsert: "above" | "below"; statuses: Array<{ symbol: string; type: string; next: string }> }`
  - Fixture shape (`taskFixtures.json`): `{ cases: Array<{ name, cfg, body, line, edit, today, expected: TaskDraftTransformJson }> }`

- [ ] **Step 1: Write the Rust fixture emitter (test-only)**

In `tasks.rs` `mod tests`, add `#[test] fn emit_golden_fixture_corpus()` — it builds a `serde_json::Value` of cases covering: toggle across every default status transition (todo→done with/without dates, done→todo clearing, cancelled paths), SetDate set/clear per field in both write formats, SetPriority each level, SetText preserving tags/filter bytes, SetRecurrence, recurrence spawn above and below (incl. `when done`, due>scheduled>start priority), CRLF bodies, `global_filter` set and empty, duplicate-field collapse, unsupported-rule non-spawn. Each case records `(cfg_json, body, line, edit_json, today, expected_changes_json)` using the REAL `transform_task_draft`. The test writes `apps/desktop/src/lib/taskFixtures.json` via `std::fs::write` when `env::var("UPDATE_TASK_FIXTURES").is_ok()`, and otherwise ASSERTS the committed file round-trips (guard with `#[ignore]`-free plain test but skip the file-compare when the path doesn't exist — CI machines may not have the frontend checkout; compare only if the file exists). Run with `UPDATE_TASK_FIXTURES=1 cargo test -p oximemo-core emit_golden` to (re)generate.

- [ ] **Step 2: Write the failing mirror test**

`taskLine.test.ts` loads `taskFixtures.json` and, per case, asserts `transformTaskDraft(body, line, editFromJson, today, cfg)` deep-equals `expected`. Start with a handful of cases and a stub mirror; run `bun test taskLine` → FAIL.

- [ ] **Step 3: Implement the mirror**

`lib/taskLine.ts` ports the Rust kernel minimally: one-line scanner (checkbox symbol via cfg.statuses, field token spans for both formats — reuse the same token grammar: emoji table + `[key:: value]`), splice logic (remove spans of the target field, append canonical token per `writeFormat`), terminal-transition date stamping/clearing, recurrence spawn (port `parse_recurrence_spec`, `date_add` calendar-month clamp via a small local `addMonths` mirroring `dates.ts`), above/below insertion with subtree scan, CRLF preservation (detect `\r\n` and rejoin accordingly), global-filter substring preservation on SetText. Keep it under ~450 lines; no dependencies.

- [ ] **Step 4: Full fixture differential green**

`cd apps/desktop && bun test taskLine` → all cases PASS. `cargo test -p oximemo-core tasks::` still green. Commit:
`feat(web): golden-fixture task line transform mirror`

---

### Task 2: Tauri task commands + TS wire types + api + browser policy

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs` (commands mod ~:246 `generate_handler!`), `apps/desktop/src/lib/types.ts`, `apps/desktop/src/lib/api.ts`, `apps/desktop/src/lib/tauri.ts`

**Interfaces:**
- Consumes: `Vault::{list-task DTOs? no — task_list_dtos is CLI-level; core exposes snapshot/run_base}`. Commands defined here call `vault.patch_task/add_task/move_tasks` and a new thin core helper if needed for listing (reuse `vault.snapshot()` + `record.tasks` mapping to `TaskDto` — the mapping fn `TaskDto::from_row` is already pub).
- Produces (Rust commands, all snake_case JSON):
  - `list_tasks(note_id: Option<String>) -> Vec<TaskDto>`
  - `resolve_task_line(note_id: String, line: u32, line_hash: String) -> Option<u32>` — hash-repair for `openTask` (Task 4): reads the note body, returns the unchanged line early when its bytes still hash to `line_hash`, otherwise scans for the unique line whose `TaskLineHash::of_line` matches; `None` when absent or ambiguous.
  - `patch_task(selector: TaskSelectorJson, edit: TaskEditJson, today: String) -> PatchTaskResultJson`
  - `add_task(target: AddTargetJson, text: String, fields: TaskFieldsJson, today: String) -> PatchTaskResultJson`
  - `move_tasks(request: MoveTasksRequestJson, today: String) -> MoveTasksReceiptJson`
  - `transform_task_draft(body: String, line: u32, edit: TaskEditJson, today: String) -> TaskDraftTransformJson` (pure; no lock)
- Produces (TS in `types.ts`): `TaskRef`, `TaskLineHash` (branded string), `TaskDto`, `TaskEdit`, `TaskSelector`, `AddTarget`, `TaskFields`, `PatchTaskResult`, `MoveTasksRequest`, `MoveTasksReceipt`, `TaskDraftTransform`, `TaskLineChange`. Produces (TS api): `listTasks`, `resolveTaskLine`, `patchTask`, `addTask`, `moveTasks`, `transformTaskDraft` (desktop invoke; browser → Task-1 mirror for `transformTaskDraft`, typed rejection for the rest).

- [ ] **Step 1: TS types first (contract pin)** — add the types to `types.ts` matching Rust serde (read `tasks.rs` serde attributes; externally-tagged enums serialize as `{ "Exact": {...} }`). Write `types.test-d.ts`-style assertions? The repo has no type-test runner — instead assert JSON round-trip shapes in Task 3's tests via sample literals. Commit types with api stubs.
- [ ] **Step 2: Rust commands** — in `lib.rs` commands mod, add the six commands taking/returning serde types (core types are already Serialize/Deserialize). `today: String` parsed with `time::Date::parse(...)` in the command, errors via the existing command error type. Register in `generate_handler!`. `cargo check` in `apps/desktop/src-tauri` green; run the existing tauri dev build headlessly if the repo has a check script — else `cargo check` suffices.
- [ ] **Step 3: api.ts + tauri.ts fallback** — `api.ts` gains the six fns through the `invoke` shim. In `tauri.ts`'s browser fallback, `transform_task_draft` dispatches to `taskLine.transformTaskDraft`; the five vault commands (`list_tasks`, `resolve_task_line`, `patch_task`, `add_task`, `move_tasks`) reject with `new Error("task commands require the desktop app")`. Follow the existing fallback dispatch pattern in `lib/tauri.ts`.

---

### Task 3: Icon catalog, chips, checkbox control, relative dates, midnight timer

**Files:**
- Create: `lib/taskIcons.ts`, `lib/relativeDay.ts`, `components/TaskFieldChip.tsx`, `components/TaskCheckbox.tsx`, `lib/taskIcons.test.ts`, `lib/relativeDay.test.ts`
- Modify: `app.css` (mask classes + `.ox-task-*` styles), `lib/locales/ko.ts`, `lib/locales/en.ts`

**Interfaces:**
- `taskIcons.ts` exports `TASK_FIELD_ICONS: Record<TaskIconField, { lucide: LucideIcon; maskClass: string }>` for: created→CalendarPlus, start→Play, scheduled→CalendarClock, due→CalendarDays, done→CalendarCheck, cancelled→CalendarX, recurrence→Repeat, priority highest/high→ChevronsUp/ChevronUp, medium→Equal, low/lowest→ChevronDown/ChevronsDown, invalidDate→TriangleAlert, unsupportedRecurrence→CircleAlert.
- `relativeDay.ts` exports `relativeDayLabel(iso: string, todayISO: string, locale: "ko" | "en"): string` (오늘/내일/어제/`8월 30일`/`3일 지남` per §7.0, built on `daysBetween`) and `useTodayKey(): string` (hook: state = `todayLocalISO()`, a module-level midnight timer shared across consumers, `setInterval` until next local midnight, cleaned on last unsubscribe).
- `TaskFieldChip.tsx`: `({ field, value, tone }: { field: TaskIconField; value: string; tone?: "overdue" | "today" | "future" })` → icon + label span with tone classes (`text-[var(--color-status-error)]` etc.).
- `TaskCheckbox.tsx`: `({ statusType, label, onToggle, disabled })` → `<button type="button" role="checkbox" aria-checked={...} aria-label={label}>` with CSS box; inner mark: Check (done), Minus (cancelled), half-fill (in_progress); `focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]`.
- i18n keys added (both locales): `task_status_todo`, `task_status_in_progress`, `task_status_on_hold`, `task_status_done`, `task_status_cancelled`, `task_status_non_task`, `task_priority_highest/high/medium/low/lowest/none`, `task_field_created/start/scheduled/due/done/cancelled`, `task_recurrence`, `task_warning_invalid/duplicate/unsupported`, `day_today/tomorrow/yesterday/days_ago` (for relativeDay), `task_conflict_reload`.

- [ ] **Step 1: Failing tests** — `taskIcons.test.ts`: every §7.0 catalog row has a lucide component AND a `maskClass` present in `app.css` source (read the css file in the test via `Bun.file`); `relativeDay.test.ts`: today/tomorrow/yesterday/month-day/year-crossing/overdue-count cases with fixed dates.
- [ ] **Step 2: Implement** catalog, css masks (inline the lucide SVG path data as data-URI `mask-image` with `background-color: currentColor`, ISC license comment per §7.0), components, hook. `bun test taskIcons relativeDay` green.
- [ ] **Step 3: Commit** `feat(ui): task icon catalog, chips, checkbox control, relative day labels`.

---

### Task 4: `openTask` navigation + repair flow + row-identity helpers

**Files:**
- Create: `lib/taskNav.ts`, `lib/taskNav.test.ts`
- Modify: `stores/ui.ts` (add `pendingTaskAnchor`), `components/MemoDetail.tsx` (consume anchor → scroll+reveal)

**Interfaces:**
- `taskNav.ts`:
  - Hash repair lives in Rust (Task 2's `resolve_task_line`): the frontend cannot recompute `TaskLineHash` (BLAKE3), so `openTask` resolves lines through that command. This module only orchestrates the flow.
  - `openTask(ref: TaskRef, opts: { select: (id: string) => void; setAnchor: (a: TaskAnchor | null) => void; resolve: (ref: TaskRef) => Promise<number | null>; onStale?: () => void })` — `select(memo_id)`; `setAnchor({ memoId, line })`; if resolve returns null → open parent without anchor + `onStale()` toast.
- `stores/ui.ts`: `pendingTaskAnchor: { memoId: string; line: number } | null` + `consumeTaskAnchor(memoId): number | null`.
- `MemoDetail.tsx` effect: on anchor for this memo, after editor mount, `view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "center" }) , selection: { anchor: pos } })` where `pos = view.state.doc.line(line + 1).from` (editor doc IS the body; verified `MemoEditorForm` passes `body`).

- [ ] **Step 1:** TS: `taskNav.test.ts` with a mocked `resolve`/`select`/`setAnchor` asserting the three flows (fresh line, moved line, stale). `resolve_task_line` is already registered by Task 2 — consume, don't re-add; any core-side adjustment it reveals is its own commit.
- [ ] **Step 2:** Implement + wire `MemoDetail` anchor consumption. `bun test taskNav` green; `cargo check` green.
- [ ] **Step 3:** Commit `feat(web): openTask navigation with hash repair and scroll anchor`.

---

### Task 5: `row_id` cutover across every view + task row rendering

**Files:**
- Modify: `components/BaseView.tsx`, `components/views/TableView.tsx`, `components/views/BoardView.tsx`, `components/views/BaseAdapters.tsx`, `lib/queryEmbeds.ts`, `lib/tableModel.ts`, `lib/types.ts` (`BaseRow` gains `row_id: string; task: TaskDto | null` — wire, not derived)
- Test: `lib/tableModel.test.ts` (extend), new `lib/rowIdentity.test.ts`

**Interfaces:**
- Every row-keyed site switches from `n:${row.id}` / `row.id` to `row.row_id`: `TableView.tsx:346` (`key={`n:${row.id}`}`), group-virtual row keys (`:319`), freeze/patch maps (keyed maps in TableView state), BoardView column→row maps and drag state, `BaseAdapters.tsx` `rows.map` keys, `queryEmbeds.ts` row identity, `BaseView` selection state.
- Task rows render task content: adapters detect `row.task` and render `TaskCheckbox` (wired in Task 6 — here render static markup) + `row.task.text` + `TaskFieldChip`s (due/scheduled/priority/recurrence) + parent breadcrumb (`row.summary.name`); note rows unchanged.
- Local patched/frozen state resets when `BasePage.result_key` changes: `TableView` keeps `resultKeyRef`; on change, `setPatched(new Map()); setFrozenOrder(null)`.
- `tableModel.ts`: `reconcileRow`/`applyFrozenOrder` operate on `row_id`; `groupRows` unchanged (already group-key based).
- `BaseView` view-type switch accepts `type: "tasks"` (render path lands in Plan E's surface task? NO — §7.4 tasks view is C scope): add `TasksView` minimal list here? **Scope decision: the `tasks` checkbox-list view type is Plan E (installed surface); Plan C ships table/board/list/cards accepting task rows + the shared `TaskRowContent` renderer. `BaseView` warns-and-falls-back to table for `type: tasks` until E.** Keep `KNOWN_VIEW_TYPES` Rust-side already accepting it.

- [ ] **Step 1: Failing tests** — `rowIdentity.test.ts`: build two task rows + one note row sharing a parent id; assert tableModel's grouping/freeze/reconcile keyed structures distinguish all three (calls into the real pure fns).
- [ ] **Step 2: Implement the cutover file by file** (order: types → tableModel → TableView → BoardView → BaseAdapters → queryEmbeds → BaseView). Keep diffs mechanical; no behavior change for note rows beyond key strings.
- [ ] **Step 3:** `bun test` green (whole suite); manual E2E note: task rows visible in table/board/list/cards requires a real vault — defer to DoD checklist. Commit `refactor(views): key all base rows by row_id and render task content`.

---

### Task 6: Editable task cells + board drag → guarded `patch_task`

**Files:**
- Modify: `components/views/TableView.tsx` (cell commit path `:161-164`), `components/views/BoardView.tsx`, `lib/api.ts` (uses Task 2)
- Test: extend `lib/tableModel.test.ts` or new `lib/taskCellCommit.test.ts` for the pure edit-mapping

**Interfaces:**
- Editable cells (spec §4): column property in `task.status|task.due|task.scheduled|task.start|task.priority|task.text` when the row has `task`. Edits map to `TaskEdit`: status → `{kind:"status", symbol}`, dates → `{kind:"date", field, value: iso|null}`, priority → `{kind:"priority"}`, text → `{kind:"text"}`. Commit = `patchTask({ Exact: row.task.task_ref }, edit, todayLocalISO())` then `queryClient.invalidateQueries({ queryKey: ["base"] })` (mirror `TableView.tsx:161-164`). `TaskConflict` error → toast `task_conflict_reload` + invalidate.
- Board drag: when `groupBy.property === "task.status"`, dropping into column with symbol S commits `SetStatus(S)` per dragged `row.task.task_ref`; grouped by anything else (incl. `task.type`) → drag disabled with a tooltip (view-only).
- All `file.*`/`note.*`/`formula.*` columns and note rows keep the existing `updateMemo` path.

- [ ] **Step 1:** failing pure test for `editForCell(property, value)` mapping + `isEditableTaskColumn`.
- [ ] **Step 2:** implement both surfaces; wire `TaskCheckbox.onToggle` inside task rows (status toggle via patch). `bun test` green. Commit `feat(views): guarded task cell edits and status board drag`.

---

### Task 7: Preview transforms — inert task chips in card/chat previews

**Files:**
- Create: `lib/taskPreview.ts`, `lib/taskPreview.test.ts`
- Modify: `lib/markdownPreview.ts` (and `lib/chatMarkdown.ts` if the pipeline is shared), possibly `components/Card.tsx` (no click change — article click stays `:60-64`)

**Interfaces:**
- `taskPreview.ts` exports `preprocessTaskMarkdown(md: string): string` — before `marked`: (1) extended checkbox markers `[ ]|[xX]|[/]|[-]` (plus configured symbols? previews have no config context — cover the four canonical + leave unknown markers verbatim) at list-item start → replaced with `<span class="ox-task-box ox-task-{state}" aria-hidden="true"></span>` inline markup that `marked` passes through; (2) recognized metadata tokens (emoji table + `[key:: value]`) → `<span class="ox-task-field ox-task-{field}">{value}</span>`; user-authored emoji outside recognized tokens untouched.
- Sanitizer: existing FORBID-list keeps `span`/`class` (verify in `markdownPreview.ts` sanitize call; if `class` is stripped, add an allowlist entry for `^ox-task(-[a-z]+)?$`).
- CSS in `app.css`: `.ox-task-box` (static square, state fills), `.ox-task-field` chip styles reusing mask classes from Task 3.
- `previewText` strips recognized metadata only (leave `previewText` alone if it already ignores them; verify).

- [ ] **Step 1:** failing `taskPreview.test.ts` — cases: `- [/] wip 📅 2026-08-30 ⏫` → box span + field spans + priority hidden (priority emoji → chip class w/o value), user emoji `🚀` survives, `[due:: 2026-08-30]` dataview form, fenced code containing task syntax untouched, `[x]` GFM.
- [ ] **Step 2:** implement + wire into the preview pipeline call sites. `bun test taskPreview chatMarkdown` green. Commit `feat(preview): inert task chips and metadata stripping in previews`.

---

### Task 8: CM6 task widgets (`taskCheckboxes.ts`) + MemoDetail shift-guard

**Files:**
- Create: `lib/taskCheckboxes.ts`
- Modify: `components/MemoEditorForm.tsx` (mount factory in the extension assembly), `components/MemoDetail.tsx:129` (add `&& !e.shiftKey`), `app.css` (widget DOM styles reuse Task-3 classes)

**Interfaces:**
- `taskCheckboxExtension(opts: { cfg: TaskLineCfg; labels: { status: Record<string, string> }; onConflict?: () => void; onPopoverRequest?: (line: number) => void })` returns `[field, keymap, viewPlugin]` following `lib/embeds.ts` (`:27-199`): `StateField<DecorationSet>` + `ViewPlugin` rebuilding on `docChanged || viewportChanged || selectionSet` (selection rebuild is the caret-reveal mechanism), `Decoration.replace` per task line rendering `TaskCheckbox`-equivalent DOM (plain DOM in `toDOM`, not React) + field-chip spans for recognized tokens; `WidgetType.eq` compares line text + symbol.
- Widget click → `applyTransform(view, line, { kind: "toggle" })`; `⌘⇧Enter` keymap (`Prec.highest`, matchExisting keymap style) applies toggle on the caret's task line. `applyTransform`: take FULL doc string, call `transformTaskDraft` (desktop invoke or browser mirror via Task-2 api), map each `TaskLineChange` to doc offsets (`doc.line(startLine+1).from` .. `doc.line(startLine+deleteLines).to`), dispatch ONE transaction with all changes + `selection` preserved by mapping; `mousedown` on the button calls `event.preventDefault()` before the transform.
- Right-click (`contextmenu`) on the checkbox → `onPopoverRequest(line)` (popover itself is Task 9; here the hook fires).
- Caret inside the decorated range → decoration omitted for that line (raw text visible/editable), restored on caret leave.
- `MemoDetail.tsx:129` gains `&& !e.shiftKey` in the same commit (spec-mandated cutover).
- No `patch_task` while the editor owns an unsaved buffer — the widget ONLY transforms the draft; autosave persists.

- [ ] **Step 1:** pure helpers extracted for testability: `lineIsTask(raw, cfg)`, `widgetRangesFor(doc_text, selectionHead, cfg)` (returns per-line: decorate-or-reveal + token spans) — failing `bun test taskCheckboxes` cases: reveal under caret, fence exclusion, CRLF, configured symbol.
- [ ] **Step 2:** implement the CM6 machinery on top of the helpers; wire into `MemoEditorForm`'s extension array; shift-guard fix. Full `bun test` green; `cargo check` untouched. Manual E2E deferred to DoD. Commit `feat(editor): task checkbox and field widgets with caret reveal`.

---

### Task 9: Task edit popover (§7.2)

**Files:**
- Create: `components/TaskEditPopover.tsx`
- Modify: `components/MemoEditorForm.tsx` / `components/MemoDetail.tsx` (mount + anchor), `lib/locales/{ko,en}.ts` (`task_new`, `task_edit`, `task_delete`, `task_recurrence_next`, `task_recurrence_needs_date`, `today`, `tomorrow`, `clear`)

**Interfaces:**
- Trigger: `⌘⇧E` on a task line (editor) or right-click on a task checkbox (Task 8 hook) or a task row's edit affordance in views. Base UI `Popover` (structure per `FolderCombobox.tsx`: `Popover.Root/Trigger/Popup` with `z-[60]`).
- Controls: status select (cfg.statuses + localized type labels), priority select, start/scheduled/due native `<input type="date">` + 오늘/내일/지우기 shortcut buttons, recurrence text input with live next-occurrence preview (compute via `taskLine` recurrence parse + shift — pure, reused from Task 1; show `task_recurrence_next` label or `task_recurrence_needs_date` when no anchor date), description input.
- Commit: inside editor → `applyTransform` with the corresponding edits (one per field, sequenced); outside editor → strict `patchTask` + invalidate `["base"]`. `⌘Enter` commits; plain Tab order; `Esc` closes.
- Live preview must NOT write `오늘` — all values serialize as ISO in cfg format.

- [ ] **Step 1:** pure `nextOccurrencePreview(ruleISO, anchorISO, todayISO)` extracted + tested (reuse Task-1 pieces).
- [ ] **Step 2:** component + wiring. `bun test` green. Commit `feat(ui): task edit popover with recurrence preview`.

---

### Task 10: Line auto-suggest (§7.3)

**Files:**
- Create: `lib/taskSuggest.ts`, `lib/taskSuggest.test.ts`
- Modify: `components/MemoEditorForm.tsx` (mount), `lib/locales/{ko,en}.ts` (`task_field_*` reuse, slash labels NOT here — Plan D)

**Interfaces:**
- `taskSuggestExtension(opts: { cfg: TaskLineCfg; locale }): CompletionSource` — activates when the caret is inside a recognized task line AND the typed token starts a field trigger (`📅`? No: triggers are the localized label or the field name — spec: "offers only fields not already present"; trigger on word chars after whitespace). Options: absent fields among due/scheduled/start/priority/done/created/recurrence, each rendered with lucide icon + localized label (custom `render` per option). Date options offer 오늘/내일/pick — selecting writes the ISO date token in cfg write format (`📅 2026-08-27` or `[due:: 2026-08-27]`), never a literal label.
- IME-safe: reuse the project doctrine — check how existing completions (wiki-links?) guard composition; gate on `view.composing === false` and require an explicit trigger re-eval on composition end. Inline-code/fenced-code spans excluded (reuse Task-8 helpers).
- After insert, the widget (Task 8) immediately decorates the token (decoration rebuild rides doc change).

- [ ] **Step 1:** failing tests for `suggestOptionsFor(line, cfg, caret)` — absent-field filtering, present-field exclusion, date option ISO emission in both write formats, non-task line → no options.
- [ ] **Step 2:** implement + mount. `bun test taskSuggest` green. Commit `feat(editor): task field auto-suggest`.

---

## Plan C Definition of Done

- `cd apps/desktop && bun test` fully green (new: taskLine/taskIcons/relativeDay/taskNav/rowIdentity/taskCellCommit/taskPreview/taskCheckboxes/taskSuggest suites); `cargo test -p oximemo-core -p oximemo-cli`, clippy, fmt green; `cargo check` in `apps/desktop/src-tauri` green.
- Fixture differential: `UPDATE_TASK_FIXTURES=1 cargo test -p oximemo-core emit_golden` produces a corpus the committed mirror passes byte-for-byte.
- Manual E2E (record outcomes in the final task report; run `bun run tauri dev`):
  1. Editor: toggle a task via checkbox click and ⌘⇧Enter; recurrence spawn appears live; caret reveal/restore works; ⌘⇧E popover edits due date and commits; ⌘⇧Enter no longer closes the dialog.
  2. Views: a `source: tasks` .query renders in table/board/list/cards with task text + chips + breadcrumb; two tasks from one parent are separately selectable (no row collision); checkbox toggle in a view invalidates and refreshes; board drag on `task.status` commits; on `task.type` is disabled.
  3. openTask: click a task row → parent note opens scrolled to the line; hand-edit the note above the task in an external editor scenario (or via CLI `task done` on another line) → stale toast path.
  4. Previews: card/chat previews show inert chips; user emoji survives; article click still opens the note.
  5. Auto-suggest: on a task line, offering absent fields, inserting ISO dates in both write formats; silent inside code spans; Korean IME composition doesn't fire it.
  6. Icon parity spot-check in dark and light themes.
- No `patch_task` call originates from the editor while a draft is unsaved (widget path is draft-transform only) — verified by code inspection + E2E step 1.
