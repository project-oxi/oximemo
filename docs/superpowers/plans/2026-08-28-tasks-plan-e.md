# Tasks Plan E — Daily and Installed Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The shipped daily experience: new daily notes carry a guarded `## 할 일` query section, the sidebar gains a one-shot installed `할 일` base (오늘/예정/지연/전체 views incl. the `tasks` checkbox view), `⌘⇧T` quick-adds to today, an explicit palette rollover command with receipt-backed undo, and local-midnight refresh.

**Architecture:** Templates and installed files are Rust-owned (`schema.rs` presets + a one-shot install marker following the inbox-seed precedent); the `tasks` view type and quick-add/rollover UX are frontend-owned over Plan A's `add_task`/`move_tasks` primitives and Plan B's query source. Refresh is driven by Plan C's shared midnight `todayKey` invalidating `["base"]` queries.

**Tech Stack:** Rust (`oximemo-core` schema/migrate paths, Tauri commands), React 19 + TanStack Query, `bun test` + `cargo test`. No new dependencies.

## Global Constraints

- Governing spec: `docs/superpowers/specs/2026-08-27-tasks-design.md` §9 (daily composition), §7.4 (tasks surface + sidebar entry + default grouping), §12 (`task_rollover*`, `task_daily_recurrence_warning`, `task_group_*`, `view_tasks`, `tasks_section`), §13 (daily-query-with-undated-tasks E2E; rollover + hash-guarded undo).
- The §9 daily template fence is VERBATIM (spec block): `## 할 일` heading + the guarded `and:`-grouped filter pair; no new syntax, `this.file.name` day-scoping as shipped.
- Install-once ownership: the `할 일` base is seeded behind a persisted marker (mirror `vault.rs` inbox-seed marker pattern: marker exists + inventory check before seeding); deliberate deletion is permanent until the user re-installs manually; duplicating the base is allowed and untouched.
- Rollover is explicit-only, never automatic; undo applies the `MoveTasksReceipt` inverse only while BOTH post-hashes still match (`undo_move_tasks`); conflicts surface `task_rollover_conflict`.
- `add_task` with a recurring rule targeting a daily note surfaces `task_daily_recurrence_warning` (spec §9 anti-pattern warning) — core returns a warning the UI toasts; it does not block.
- `capture_target` (`daily | inbox`) governs `⌘⇧T` and the capture overlay's `/할일`; both call `add_task(target, …, todayLocalISO())`.
- Rust gates (test/clippy/fmt for core+cli, `cargo check` for src-tauri) + `bun test` green after every task. i18n keys in both locales in the same task that shows them.
- Sidebar calendar unchanged (§9 non-goal).

## File Structure

- Modify (Rust): `crates/oximemo-core/src/schema.rs` (`DAILY_TEMPLATE_MD`), `crates/oximemo-core/src/vault.rs` (install marker + seed in `migrate()`), `apps/desktop/src-tauri/src/lib.rs` (rollover/undo/install-status commands if not already present from Plan C)
- Modify (TS): `components/Sidebar.tsx` (할 일 system entry), new `components/views/TasksView.tsx` + registration in `components/BaseView.tsx`, `components/App.tsx` or global key handler for `⌘⇧T`, capture overlay (`/할일` routing), `lib/locales/{ko,en}.ts`, Plan C's `useTodayKey` consumers invalidate `["base"]` at midnight.

---

### Task 1: Daily template + guarded query fence

**Files:** Modify `crates/oximemo-core/src/schema.rs` (`DAILY_TEMPLATE_MD`, ~:514 area); Test: `schema.rs` tests + `vault.rs` integration test.

**Interfaces:**
- `DAILY_TEMPLATE_MD` gains the `## 할 일` section + the §9 verbatim fence. Existing daily notes are NEVER rewritten (template applies at creation/first-migrate only — verify `apply_preset` semantics: presets install the template when the folder/note is absent; assert no-op when today's note already exists).
- [ ] **Step 1:** failing test: `daily_template_contains_guarded_task_query` (exact fence text present, filter grammar parses via `parse_base`, `this.file.name` filter yields rows only for tasks due/scheduled ≤ the note's ISO name — integration: create a note with due-today + due-tomorrow + undated tasks, run the embedded query against a daily note, assert exactly the due-today row).
- [ ] **Step 2:** implement the template; tests green (core suite). Commit `feat(core): daily template gains guarded 할 일 query section`.

### Task 2: One-shot installed `할 일` base + `tasks` view type + sidebar entry

**Files:** Modify `crates/oximemo-core/src/vault.rs` (seed + marker), Create `apps/desktop/src/components/views/TasksView.tsx`, Modify `components/BaseView.tsx` (view-type switch), `components/Sidebar.tsx`, `lib/locales/{ko,en}.ts`.

**Interfaces:**
- Rust: `const TASKS_BASE_REL: &str = "queries/할 일.query"` content (verbatim, spec §7.4: `source: tasks`, views 오늘/예정/지연/전체 — filters: 오늘 = the §9 guarded pair scoped by `this.file.name`? NO — the installed base is vault-global: 오늘 = `task.due != null && task.due <= today()` guarded + scheduled fallback; 예정 = future-window; 지연 = `task.due != null && task.due < today()`; 전체 = no filter, `task.type != "DONE"` optional? spec says views named 오늘/예정/지연/전체 — 전체 = unfiltered). Seed in `migrate()` behind `tasks_base_seed_marker` + absence check; never recreated after deletion.
- `TasksView.tsx`: checkbox list rows — group section header (`task_group_overdue/today/tomorrow/this_week/later/no_date`, computed from `task.due` with `task.scheduled` fallback, pure helper `taskBucket(task, todayISO)`), `TaskCheckbox` (toggle → `patchTask` + invalidate `["base"]`), description, `TaskFieldChip`s, note breadcrumb; row click → `openTask`. Consumes the same `BasePage` rows; `type: tasks` in `BaseView`'s switch now routes here (Plan C left a fallback).
- Sidebar: `할 일` entry in LOCATIONS (or its own system section per existing grouping convention — follow the QUERIES section's behavior for opening a `.query`), icon per catalog, opens `queries/할 일.query`; hidden when `tasks.enabled = false` (config already gates — expose `enabled` through `get_config` if not already).
- [ ] **Step 1:** failing Rust test (seed-once semantics: fresh vault seeds; deleted file + marker present → no reseed; marker written once) + failing TS test for `taskBucket` boundaries (overdue at yesterday, today at today, tomorrow, this-week until local Sunday? define: 이번 주 = tomorrow..end-of-local-week (Sunday) per `dates.ts` week conventions; 이후 beyond; 날짜 없음 when both null).
- [ ] **Step 2:** implement all three layers. Gates green. Commit `feat(daily): installed 할 일 base, tasks view, sidebar entry`.

### Task 3: `⌘⇧T` quick add + `/할일` capture routing + recurrence warning

**Files:** Modify global key handling (`App.tsx` or the existing global-key module), capture overlay command routing, `lib/locales/{ko,en}.ts`; possibly `apps/desktop/src-tauri/src/lib.rs` if `add_task` warning needs a field (Plan C's `PatchTaskResult` may already carry it — spec: "`add_task` warns when a recurring task targets a daily note": core emits a warning value; surface as toast).

**Interfaces:**
- `⌘⇧T` anywhere (no dialog open): opens a minimal single-line input (reuse the capture overlay's input chrome) defaulting to capture_target; Enter → `addTask(target, text, { recurrence? }, today)`; `task_daily_recurrence_warning` toast when the result carries the daily+recurring warning and target was Daily.
- `/할일` in the capture overlay routes the same path (overlay's existing slash routing gains one entry — Plan D's editor menu is separate; the overlay has its own).
- [ ] **Step 1:** failing pure test for the routing decision (`quickAddTarget(cfg, override)`) and warning surfacing (`shouldWarnDailyRecurrence(target, fields)`).
- [ ] **Step 2:** implement; E2E-manual; gates green. Commit `feat(daily): ⌘⇧T quick add and capture 할일 routing with recurrence warning`.

### Task 4: Rollover command + receipt undo + midnight refresh

**Files:** Modify `lib/paletteCommands.ts` (new command `task_rollover` — palette registration, not a fork), `components/CommandPalette.tsx` if registration is data-driven (prefer pure `buildCommands` extension), toast component usage, Plan C's `useTodayKey` consumer wiring (`queryClient.invalidateQueries(["base"])` + daily note refetch on key change); Tauri commands `rollover_tasks`/`undo_move_tasks` wrappers if not present.

**Interfaces:**
- Palette command `어제의 미완료 이월`: fetches yesterday's not-done tasks (a one-off `run_base` inline def or `list_tasks`-equivalent — use `run_base` with inline def `source: tasks` + `filters: file.name == <yesterdayISO>` composed with not-done), previews count in a confirm toast (`task_rollover_none` when zero), commits via `moveTasks` with `expected_destination_hash` = today's note hash (or null when today's note doesn't exist yet — mirrors CLI rollover), shows `task_rollover_done` with an Undo action.
- Undo → `undoMoveTasks(receipt)`; `TaskConflict` → `task_rollover_conflict` toast; success → invalidate `["base"]`.
- Midnight: a top-level `useTodayKey()` effect calls `queryClient.invalidateQueries({ queryKey: ["base"] })` and refreshes the daily note when the key changes.
- [ ] **Step 1:** failing pure tests: `rolloverRequest(yesterdayISO, rows, todayHash | null)` builder (refs strict, destination hash policy), `undoAvailability(receipt, currentHashes)` gate.
- [ ] **Step 2:** implement command + toasts + midnight wiring. Gates green. Commit `feat(daily): explicit rollover command with guarded undo and midnight refresh`.

## Plan E Definition of Done

- All gates green: core+cli cargo test/clippy/fmt, src-tauri `cargo check`, `bun test`.
- Manual E2E (desktop): fresh vault → `할 일` base installed once (deleted → not recreated); daily note contains the guarded query rendering only due-today/scheduled-today tasks and staying healthy with undated tasks present; `⌘⇧T` appends to today's note under `## 할 일`; recurring quick-add to daily shows the warning toast; rollover moves yesterday's leftovers with undo working and conflict toast after an external edit; day rollover at midnight refreshes the base views without restart.
- §13 coverage complete for E: daily query with undated tasks ✓, rollover + hash-guarded undo ✓, palette entries ✓.
