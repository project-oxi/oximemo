# Calendar View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Notion-style month-grid "Calendar" view as a sixth `ViewMode` on every folder and on the smart collections, bucketing notes by `created_at` (default) / `updated_at` / a schema `date`-typed property (per-folder choice), with click-to-open for titles, "+N더" overflow popovers, and a "날짜 없음" strip for notes missing the bucket date.

**Architecture:** Additive to existing extension points — `ViewMode` enum gains `Calendar`, `FolderDef` gains `calendar_date_field: Option<String>`, a new Tauri command `set_folder_calendar_field` mirrors `set_folder_view`. New `views/CalendarView.tsx` consumes a dedicated bounded react-query (2000 memos) independent of Grid/List's infinite-scroll cursor. View switcher gains a `Calendar` button + a `PropSelect` (existing, unmodified) for the bucket field.

**Tech Stack:** Rust (oximemo-core config/vault), Tauri 2 commands, React 19, react-query 5, `@base-ui-components/react` Popover, `marked` (unchanged), `lucide-react` icons, bun + vitest (frontend tests), cargo test (backend tests).

## Global Constraints

- Branch: `feat/calendar-view` in `.worktrees/feat-calendar-view`. All work happens in this directory.
- Korean response, English code/commit messages, no emojis, conclusions first.
- The existing latent bug (Shelf not in Rust `ViewMode`, hence `set_folder_view(path, "shelf")` fails IPC) is **out of scope**. Do not fix it; do not be tempted to. Calendar IS added to the Rust enum so it avoids the trap.
- Daily notes `[daily] enabled=false` must hide Calendar's empty-day click-to-create affordance — gate on both `folderFilter === dailyFolder && daily.enabled === true`.
- MemoSummary already carries `created_at`, `updated_at`, and `props`. No new persisted note fields, no new write-path hook, no schema migration.
- Calendar's data fetch is **independent** of the shared Grid/List infinite-scroll cursor — it uses a dedicated bounded query (limit 2000, no cursor). Reusing `viewProps.items` is forbidden because it can be incomplete for a fixed month grid.
- `PropSelect.tsx` is reused verbatim for the bucket-field dropdown — do not create a new select primitive.
- The day-cell overflow popover reuses `@base-ui-components/react` Popover (`Root/Trigger/Portal/Positioner/Popup`), same shell as `SegmentPopover` in `BreadcrumbBar.tsx`. Do not introduce a new modal/popover primitive.
- Conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`.
- Squash-merge friendly: small, self-contained commits per task. Each task ends with a `git status --porcelain` showing only the new/modified files for that task.
- No emojis. No marketing prose in code comments.

---

## File structure

Created/modified across tasks:

```
crates/oximemo-core/src/config.rs       # +1 ViewMode variant, +1 FolderDef field
crates/oximemo-core/src/vault.rs        # +1 method: set_folder_calendar_field
crates/oximemo-core/...                 # vault.rs tests for the new method (next to existing set_folder_view tests)
apps/desktop/src-tauri/src/...           # new Tauri command wrapper (next to set_folder_view in lib.rs)
apps/desktop/src/lib/types.ts           # +1 ViewMode literal, +1 FolderDef field
apps/desktop/src/lib/api.ts             # +1 wrapper: setFolderCalendarField
apps/desktop/src/lib/tauri.ts           # browser fallback for set_folder_calendar_field
apps/desktop/src/stores/ui.ts           # loadQueryView allows "calendar"; new oximemo.calendarField key
apps/desktop/src/components/views/CalendarView.tsx   # NEW: the month grid view
apps/desktop/src/components/CardGrid.tsx             # wire CalendarView + Calendar button + PropSelect
apps/desktop/src/lib/i18n/locales/ko.ts              # +6 keys
apps/desktop/src/lib/i18n/locales/en.ts              # +6 keys
CHANGELOG.md                            # 0.9.x entry
```

No restructuring of existing files. CardGrid gains two new code paths in `viewSwitcher` and the view-component dispatch — no other rewrites.

---

## Task 1: Backend — `ViewMode::Calendar` + `FolderDef.calendar_date_field`

**Files:**
- Modify: `crates/oximemo-core/src/config.rs`
- Test: `crates/oximemo-core/src/vault.rs` (existing `set_folder_view_persists_and_unlocks` test)

**Interfaces:**
- Consumes: nothing (this is the first task).
- Produces: `pub enum ViewMode { Grid, List, Timeline, Graph, Calendar }`; `pub struct FolderDef { path, view: Option<ViewMode>, color: Option<String>, pinned: Option<bool>, calendar_date_field: Option<String> }`. Both `view` and `calendar_date_field` already use `skip_serializing_if = "Option::is_none"` so the new field follows the same pattern.

- [ ] **Step 1.1: Write a failing test**

Extend `crates/oximemo-core/src/vault.rs`'s `set_folder_view_persists_and_unlocks` doc-area (or add a sibling test). Add a new test `set_folder_view_persists_calendar` that calls `v.set_folder_view("novel", Some(crate::config::ViewMode::Calendar))`, asserts the persisted JSON contains `"view":"calendar"`, then asserts `v.config_json()["folders"]` round-trips through `set_folder_view("novel", None)` and the entry vanishes.

```rust
#[test]
fn set_folder_view_persists_calendar() {
    let (_t, v) = tmp_vault();
    v.set_folder_view("novel", Some(crate::config::ViewMode::Calendar))
        .unwrap();
    let json = v.config_json();
    let folders = json["folders"].as_array().unwrap();
    let entry = folders.iter().find(|f| f["path"] == "novel").unwrap();
    assert_eq!(entry["view"], "calendar", "Calendar view must persist as 'calendar' in JSON");

    v.set_folder_view("novel", None).unwrap();
    let json2 = v.config_json();
    let folders2 = json2["folders"].as_array().unwrap();
    assert!(folders2.iter().all(|f| f["path"] != "novel"));
}
```

- [ ] **Step 1.2: Run the test to verify it fails**

Run: `cargo test -p oximemo-core set_folder_view_persists_calendar`
Expected: FAIL with "unknown variant `Calendar`, expected one of `grid`, `list`, `timeline`, `graph`".

- [ ] **Step 1.3: Add `Calendar` to `ViewMode` and `calendar_date_field` to `FolderDef`**

In `crates/oximemo-core/src/config.rs`, inside the `ViewMode` enum (currently `#[derive(...)] #[serde(rename_all = "lowercase")] pub enum ViewMode { Grid, List, Timeline, Graph }`), add `Calendar,` after `Graph,`.

In `FolderDef`, add:

```rust
/// Bucket field for the Calendar view: `"created_at"`, `"updated_at"`,
/// or a schema `date`-typed property key. `None` = `created_at`.
/// Stored as a plain string — if a schema later drops the prop, this
/// value becomes stale and the corresponding notes fall into the
/// "날짜 없음" bucket instead of erroring.
#[serde(default, skip_serializing_if = "Option::is_none")]
pub calendar_date_field: Option<String>,
```

Insert it directly after the existing `color` field. Make sure all `FolderDef { ... }` constructor sites (search for `FolderDef {`) include `calendar_date_field: None` — there are at least two in `vault.rs::set_folder_view` and one in `vault.rs::set_folder_pinned` and one in `config.rs` test code. Run `cargo build` and fix any compile errors by adding `calendar_date_field: None` to each struct literal that lacks it.

- [ ] **Step 1.4: Run the new test, expect PASS**

Run: `cargo test -p oximemo-core set_folder_view_persists_calendar`
Expected: PASS.

- [ ] **Step 1.5: Run the full Rust test suite**

Run: `cargo test -p oximemo-core`
Expected: all pre-existing tests still pass (12 → 13+ tests).

- [ ] **Step 1.6: Commit**

```bash
git add crates/oximemo-core/src/config.rs crates/oximemo-core/src/vault.rs
git commit -m "feat(core): Calendar ViewMode + FolderDef.calendar_date_field"
```

---

## Task 2: Backend — `Vault::set_folder_calendar_field` + Tauri command + TS type

**Files:**
- Modify: `crates/oximemo-core/src/vault.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs` (or wherever `set_folder_view` is wired — confirm in `apps/desktop/src-tauri/src/commands.rs` or similar)
- Modify: `apps/desktop/src/lib/types.ts`
- Modify: `apps/desktop/src/lib/api.ts`

**Interfaces:**
- Consumes: `FolderDef.calendar_date_field: Option<String>` (Task 1), `Tauri command surface for set_folder_view` (existing pattern to mirror).
- Produces: `pub fn Vault::set_folder_calendar_field(&self, path: &str, field: Option<String>) -> Result<()>` (mirror of `set_folder_view`); Tauri command `set_folder_calendar_field(path: String, field: Option<String>)`; TS `export async function setFolderCalendarField(path: string, field: string | null): Promise<void>`; TS `FolderDef.calendar_date_field?: string`.

- [ ] **Step 2.1: Write a failing test for `set_folder_calendar_field`**

Add to `crates/oximemo-core/src/vault.rs` `tests` module (next to `set_folder_view_persists_and_unlocks`):

```rust
#[test]
fn set_folder_calendar_field_persists_and_clears() {
    let (_t, v) = tmp_vault();
    v.set_folder_calendar_field("novel", Some("watched_at".into()))
        .unwrap();
    let folders = v.config_json()["folders"].as_array().unwrap().clone();
    let entry = folders.iter().find(|f| f["path"] == "novel").unwrap();
    assert_eq!(entry["calendar_date_field"], "watched_at");

    // Cleared field drops the JSON key (skip_serializing_if Option::is_none)
    v.set_folder_calendar_field("novel", None).unwrap();
    let folders2 = v.config_json()["folders"].as_array().unwrap().clone();
    let entry2 = folders2.iter().find(|f| f["path"] == "novel").unwrap();
    assert!(entry2.get("calendar_date_field").is_none());

    // Setting back to default ("created_at") also drops the key
    v.set_folder_calendar_field("novel", Some("created_at".into()))
        .unwrap();
    let folders3 = v.config_json()["folders"].as_array().unwrap().clone();
    let entry3 = folders3.iter().find(|f| f["path"] == "novel").unwrap();
    assert!(entry3.get("calendar_date_field").is_none());
}
```

The "back to default drops the key" subtest enforces the contract that the frontend will pass `null` for `created_at` and the field stays out of the JSON.

- [ ] **Step 2.2: Run the test, expect FAIL (method doesn't exist)**

Run: `cargo test -p oximemo-core set_folder_calendar_field_persists_and_clears`
Expected: FAIL — "no method named `set_folder_calendar_field`".

- [ ] **Step 2.3: Implement `Vault::set_folder_calendar_field`**

Add to `Vault` impl in `crates/oximemo-core/src/vault.rs` (right next to `set_folder_view`):

```rust
pub fn set_folder_calendar_field(
    &self,
    path: &str,
    field: Option<String>,
) -> Result<()> {
    let mut cfg = self.config.write();
    // Match set_folder_view semantics: treat None and Some("created_at") the same
    // (drop the field). Store any other string verbatim without validation.
    let normalized = field.filter(|s| s != "created_at");
    match cfg.folders.items.iter_mut().find(|f| f.path == path) {
        Some(f) => f.calendar_date_field = normalized,
        None => cfg.folders.items.push(crate::config::FolderDef {
            path: path.to_string(),
            view: None,
            color: None,
            pinned: None,
            calendar_date_field: normalized,
        }),
    }
    cfg.persist()
}
```

(Adjust if `persist()` returns a Result — the surrounding `set_folder_view` is the model. The exact return-shape is `Result<()>` per the existing method.)

- [ ] **Step 2.4: Run the test, expect PASS**

Run: `cargo test -p oximemo-core set_folder_calendar_field_persists_and_clears`
Expected: PASS.

- [ ] **Step 2.5: Wire the Tauri command**

In `apps/desktop/src-tauri/src/lib.rs` (next to the `set_folder_view` `#[tauri::command]`):

```rust
#[tauri::command]
pub fn set_folder_calendar_field(
    state: State<'_, AppState>,
    path: String,
    field: Option<String>,
) -> Result<(), String> {
    state
        .vault
        .set_folder_calendar_field(&path, field)
        .map_err(|e| e.to_string())
}
```

Register it in the `generate_handler!` list (find where `set_folder_view` is registered and add `set_folder_calendar_field` next to it, in the same order).

- [ ] **Step 2.6: Update TS types**

In `apps/desktop/src/lib/types.ts`:

- Extend `export type ViewMode = "grid" | "list" | "timeline" | "graph" | "shelf" | "calendar";`
- Extend `export interface FolderDef { path: string; view?: ViewMode; color?: string; pinned?: boolean; calendar_date_field?: string }`

In `apps/desktop/src/lib/api.ts`, next to `setFolderView`:

```ts
export async function setFolderCalendarField(
  path: string,
  field: string | null,
): Promise<void> {
  await invoke<void>("set_folder_calendar_field", {
    path,
    field,
  });
}
```

- [ ] **Step 2.7: Build the frontend to verify the new types compile**

Run: `PATH="$PWD/node_modules/.bin:$HOME/.bun/bin:$PATH" bun run build`
Expected: tsc clean (no errors related to ViewMode or FolderDef). Warnings about chunk size are pre-existing, not failures.

- [ ] **Step 2.8: Run Rust tests + frontend tests**

Run:
- `cargo test -p oximemo-core`
- `PATH="$PWD/node_modules/.bin:$HOME/.bun/bin:$PATH" bun test`

Expected: both suites green.

- [ ] **Step 2.9: Commit**

```bash
git add crates/oximemo-core/src/vault.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src/lib/types.ts apps/desktop/src/lib/api.ts
git commit -m "feat: set_folder_calendar_field command + TS bindings"
```

---

## Task 3: Browser fallback for `set_folder_calendar_field` + `loadQueryView` allowlist

**Files:**
- Modify: `apps/desktop/src/lib/tauri.ts`
- Modify: `apps/desktop/src/stores/ui.ts`

**Interfaces:**
- Consumes: TS `setFolderCalendarField` wrapper (Task 2); existing `loadQueryView()` shape (a function returning `ViewMode` validated against an allowlist of strings).
- Produces: a `case "set_folder_calendar_field":` arm in the tauri.ts IPC switch that updates the localStorage folders array the same way `set_folder_view` does; `loadQueryView()` recognizes `"calendar"` as a valid persisted value.

- [ ] **Step 3.1: Read the existing `set_folder_view` arm in tauri.ts**

Looking at `apps/desktop/src/lib/tauri.ts` around `case "set_folder_view":` (around line 1137). The arm reads `loadViews()`, mutates by path, calls `saveViews`. Mirror that structure for `set_folder_calendar_field` — but you need a separate localStorage key, e.g. `oximemo.folders.calendarField` keyed by `path → string`. Pick a parallel layout (one key with a `Record<path, string>` JSON object, OR a per-path key). Use whichever pattern `set_folder_view` already follows (`loadViews`/`saveViews`) for consistency — that means a sibling `loadCalendarFields`/`saveCalendarFields` pair keyed the same way.

- [ ] **Step 3.2: Implement the tauri.ts arm**

Add to `apps/desktop/src/lib/tauri.ts`:

```ts
const CALENDAR_FIELD_KEY = "oximemo.folders.calendarField";

function loadCalendarFields(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(CALENDAR_FIELD_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function saveCalendarFields(map: Record<string, string>): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(CALENDAR_FIELD_KEY, JSON.stringify(map));
}
```

And the IPC arm in the same `switch` block as `set_folder_view`:

```ts
case "set_folder_calendar_field": {
  const path = (args?.path as string | undefined) ?? "";
  const field = (args?.field as string | null | undefined) ?? null;
  const map = loadCalendarFields();
  if (field === null || field === "created_at") {
    delete map[path];
  } else {
    map[path] = field;
  }
  saveCalendarFields(map);
  break;
}
```

- [ ] **Step 3.3: Extend `loadQueryView()` allowlist**

In `apps/desktop/src/stores/ui.ts`, change:

```ts
export function loadQueryView(): ViewMode {
  if (typeof window === "undefined") return "grid";
  const v = window.localStorage.getItem(QUERY_VIEW_KEY);
  return v === "list" || v === "timeline" || v === "graph" ? v : "grid";
}
```

to:

```ts
export function loadQueryView(): ViewMode {
  if (typeof window === "undefined") return "grid";
  const v = window.localStorage.getItem(QUERY_VIEW_KEY);
  return v === "list" || v === "timeline" || v === "graph" || v === "calendar"
    ? v
    : "grid";
}
```

- [ ] **Step 3.4: Build + test**

Run:
- `PATH="$PWD/node_modules/.bin:$HOME/.bun/bin:$PATH" bun run build`
- `PATH="$PWD/node_modules/.bin:$HOME/.bun/bin:$PATH" bun test`

Expected: both green.

- [ ] **Step 3.5: Commit**

```bash
git add apps/desktop/src/lib/tauri.ts apps/desktop/src/stores/ui.ts
git commit -m "feat: browser fallback for set_folder_calendar_field + query view allowlist"
```

---

## Task 4: `CalendarView` component

**Files:**
- Create: `apps/desktop/src/components/views/CalendarView.tsx`

**Interfaces:**
- Consumes: `MemoSummary[]`, `dateField: "created_at" | "updated_at" | string`, `folders`, `onSelect(id: string)`, `onOpenFolder(path: string)`, `today: string`, `locale: string`, `dailyFolder: string | null`, `dailyEnabled: boolean`, `onOpenDailyNote(date: string)`.
- Produces: a pure presentational component that renders a month grid for the viewed month (local state, defaults to the current month) bucketed per `dateField`. Multiple notes per day → up to 3 clickable titles + `+N더` popover listing the rest. Notes missing the bucket date → "날짜 없음 (N)" collapsible strip below the grid.

- [ ] **Step 4.1: Read the existing reference components**

Read fully:
- `apps/desktop/src/components/Calendar.tsx` (mini-calendar in sidebar — visual tokens, month nav, today highlighting)
- `apps/desktop/src/lib/dates.ts` (monthGrid, monthTitle, weekdayLabels, addMonths, isoToLocalDate — all reusable)
- `apps/desktop/src/components/views/TimelineView.tsx` (MemoSummary iteration pattern + day grouping reference; note: Timeline uses `iso.slice(0,10)` which assumes UTC — CalendarView MUST use `isoToLocalDate` instead)
- `apps/desktop/src/components/BreadcrumbBar.tsx` (SegmentPopover at line ~399 — exact Popover.Root/Trigger/Portal/Positioner/Popup shape to copy for the overflow popover)
- `apps/desktop/src/lib/i18n/locales/ko.ts` and `en.ts` (the i18n shape; new keys get added in Task 6, but CalendarView reads them now via `useI18n()` so import paths are confirmed here)

- [ ] **Step 4.2: Write the component**

`apps/desktop/src/components/views/CalendarView.tsx`:

```tsx
/**
 * CalendarView — Notion-style month grid for any folder or smart collection.
 * Buckets notes by `dateField` (created_at / updated_at / schema date prop).
 * Per-day cells render up to 3 titles as direct-open buttons + a "+N더"
 * popover for the rest. Notes missing the bucket date surface in a
 * collapsible "날짜 없음" strip — never silently dropped.
 *
 * Scope: recursive (matches Timeline/Graph). Data is pre-fetched by the
 * parent via a dedicated bounded query — see CardGrid's
 * "memos.calendar" query key (§5).
 */
import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { addMonths, isoToLocalDate, monthGrid, monthTitle, weekdayLabels } from "../../lib/dates";
import { useI18n } from "../../lib/i18n";
import { Popover } from "@base-ui-components/react";

import type { FolderDef, MemoSummary } from "../../lib/types";

const MAX_VISIBLE_PER_DAY = 3;

interface Props {
  memos: MemoSummary[];
  dateField: string;
  folders: FolderDef[];
  onSelect: (id: string) => void;
  onOpenFolder: (path: string) => void;
  today: string;
  locale: string;
  dailyFolder: string | null;
  dailyEnabled: boolean;
  onOpenDailyNote: (date: string) => void;
}

function bucketKey(memo: MemoSummary, dateField: string): string | null {
  if (dateField === "created_at") return isoToLocalDate(memo.created_at);
  if (dateField === "updated_at") return isoToLocalDate(memo.updated_at);
  const v = memo.props?.[dateField];
  if (!v) return null;
  // PropValue externally-tagged: { Str: "YYYY-MM-DD" } shape
  const s = (v as { Str?: string }).Str;
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

export function CalendarView({
  memos,
  dateField,
  folders,
  onSelect,
  onOpenFolder,
  today,
  locale,
  dailyFolder,
  dailyEnabled,
  onOpenDailyNote,
}: Props) {
  const { t, locale: i18nLocale } = useI18n();
  const effectiveLocale = locale || i18nLocale || "ko";
  const [ty, tm] = today.split("-").map(Number);
  const todayMonth = { year: ty, month: tm };
  const [viewed, setViewed] = useState(todayMonth);

  const { byDate, noDate } = useMemo(() => {
    const map = new Map<string, MemoSummary[]>();
    const orphans: MemoSummary[] = [];
    for (const m of memos) {
      const key = bucketKey(m, dateField);
      if (!key) {
        orphans.push(m);
        continue;
      }
      const arr = map.get(key);
      if (arr) arr.push(m);
      else map.set(key, [m]);
    }
    return { byDate: map, noDate: orphans };
  }, [memos, dateField]);

  const cells = monthGrid(viewed.year, viewed.month);
  const atToday = viewed.year === todayMonth.year && viewed.month === todayMonth.month;
  const weekdayHeader = weekdayLabels(effectiveLocale);

  const handlePrev = () => setViewed(addMonths(viewed.year, viewed.month, -1));
  const handleNext = () => setViewed(addMonths(viewed.year, viewed.month, 1));
  const handleJumpToday = () => setViewed(todayMonth);

  const onEmptyDay = dailyEnabled && dailyFolder
    ? (date: string) => onOpenDailyNote(date)
    : null;

  return (
    <div data-calendar-view className="flex h-full flex-col gap-2 p-3">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-1 text-sm">
          <button type="button" onClick={handlePrev} aria-label="previous month"
            className="inline-flex h-6 w-6 items-center justify-center rounded-[var(--tag-radius)] text-text-subtle hover:bg-surface-muted hover:text-text">
            <ChevronLeft size={14} strokeWidth={2} />
          </button>
          <span className="min-w-32 text-center font-medium">
            {monthTitle(viewed.year, viewed.month, effectiveLocale)}
          </span>
          <button type="button" onClick={handleNext} aria-label="next month"
            className="inline-flex h-6 w-6 items-center justify-center rounded-[var(--tag-radius)] text-text-subtle hover:bg-surface-muted hover:text-text">
            <ChevronRight size={14} strokeWidth={2} />
          </button>
        </div>
        {!atToday && (
          <button type="button" onClick={handleJumpToday}
            className="text-xs text-text-subtle hover:text-text">
            {t.calendar_today ?? "today"}
          </button>
        )}
      </header>

      <div className="grid grid-cols-7 gap-px text-[10px] uppercase text-text-subtle">
        {weekdayHeader.map((wd, i) => (
          <div key={i} className="px-1 py-1 text-center">{wd}</div>
        ))}
      </div>

      <div className="grid flex-1 grid-cols-7 gap-px overflow-hidden rounded-[var(--card-radius)] border border-line bg-line">
        {cells.map((cell) => {
          const day = byDate.get(cell.date) ?? [];
          const isToday = cell.date === today;
          const isCurrentMonth = cell.inMonth;
          const visible = day.slice(0, MAX_VISIBLE_PER_DAY);
          const overflow = day.length - visible.length;
          const empty = day.length === 0;
          return (
            <div
              key={cell.date}
              data-calendar-cell
              data-today={isToday || undefined}
              data-empty={empty || undefined}
              onClick={empty && onEmptyDay ? () => onEmptyDay(cell.date) : undefined}
              className={`flex min-h-[88px] flex-col gap-0.5 bg-surface p-1 text-xs ${
                isCurrentMonth ? "" : "opacity-40"
              } ${empty && onEmptyDay ? "cursor-pointer hover:bg-surface-muted" : ""}`}
            >
              <div className={`text-right text-[11px] ${
                isToday ? "font-semibold text-text" : "text-text-subtle"
              }`}>
                {cell.day}
              </div>
              {visible.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onSelect(m.id); }}
                  title={m.title ?? m.path}
                  className="truncate rounded-[var(--tag-radius)] px-1 text-left text-[11px] text-text hover:bg-surface-muted"
                >
                  {m.title ?? m.path.split("/").pop() ?? "(untitled)"}
                </button>
              ))}
              {overflow > 0 && (
                <OverflowPopover
                  date={cell.date}
                  memos={day.slice(MAX_VISIBLE_PER_DAY)}
                  folders={folders}
                  onSelect={onSelect}
                  onOpenFolder={onOpenFolder}
                  label={t.calendar_more(overflow)}
                />
              )}
            </div>
          );
        })}
      </div>

      {noDate.length > 0 && (
        <NoDateStrip
          memos={noDate}
          folders={folders}
          onSelect={onSelect}
          onOpenFolder={onOpenFolder}
          label={t.calendar_no_date(noDate.length)}
        />
      )}
    </div>
  );
}

function OverflowPopover({
  date, memos, folders, onSelect, onOpenFolder, label,
}: {
  date: string;
  memos: MemoSummary[];
  folders: FolderDef[];
  onSelect: (id: string) => void;
  onOpenFolder: (path: string) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <button
            type="button"
            onClick={(e) => e.stopPropagation()}
            className="self-start rounded-[var(--tag-radius)] px-1 text-[10px] text-text-subtle hover:bg-surface-muted hover:text-text"
          >
            {label}
          </button>
        }
      />
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={2} className="z-50">
          <Popover.Popup className="min-w-48 max-h-72 overflow-y-auto rounded-[var(--popover-radius)] border border-line bg-surface-raised p-1 shadow-lg animate-popover-in">
            <ul role="list" className="flex flex-col gap-0.5">
              {memos.map((m) => {
                const folder = folders.find((f) => f.path === m.folder);
                const color = folder?.color;
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => { setOpen(false); onSelect(m.id); }}
                      className="flex w-full items-center gap-1.5 rounded-[var(--tag-radius)] px-2 py-1 text-left text-xs text-text hover:bg-surface-muted"
                    >
                      {color && (
                        <span
                          aria-hidden
                          className="inline-block h-2 w-2 shrink-0 rounded-full"
                          style={{ background: color }}
                        />
                      )}
                      <span className="truncate">{m.title ?? m.path.split("/").pop() ?? "(untitled)"}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function NoDateStrip({
  memos, folders, onSelect, onOpenFolder, label,
}: {
  memos: MemoSummary[];
  folders: FolderDef[];
  onSelect: (id: string) => void;
  onOpenFolder: (path: string) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-line/70 pt-1">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          render={
            <button
              type="button"
              className="text-xs text-text-subtle hover:text-text"
            >
              {label}
            </button>
          }
        />
        <Popover.Portal>
          <Popover.Positioner side="top" align="start" sideOffset={4} className="z-50">
            <Popover.Popup className="min-w-64 max-h-72 overflow-y-auto rounded-[var(--popover-radius)] border border-line bg-surface-raised p-1 shadow-lg animate-popover-in">
              <ul role="list" className="flex flex-col gap-0.5">
                {memos.map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => { setOpen(false); onSelect(m.id); }}
                      className="flex w-full items-center gap-1.5 rounded-[var(--tag-radius)] px-2 py-1 text-left text-xs text-text hover:bg-surface-muted"
                    >
                      <span className="truncate">{m.title ?? m.path.split("/").pop() ?? "(untitled)"}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
```

Notes for the implementer:
- `t.calendar_more` and `t.calendar_no_date` are i18n functions returning strings with a count parameter — they may not exist yet (Task 6 adds them). Cast/fallback in this task: if `t.calendar_more` is undefined, render `+${overflow}`. Add a `as any` or guard. Cleaner: define placeholder functions in this task and replace them in Task 6. **Decision: use placeholder fallbacks now, Task 6 swaps in real keys.** Replace the call sites like `t.calendar_more(overflow)` with `(\`+${overflow}\`)` if `calendar_more` doesn't exist; same for `calendar_no_date(noDate.length)` → `(\`날짜 없음 (${noDate.length})\`)`. The full locale-shaped form goes in Task 6.
- `t.calendar_today` — same fallback: literal "오늘" / "today".

- [ ] **Step 4.3: Build to verify the component compiles**

Run: `PATH="$PWD/node_modules/.bin:$HOME/.bun/bin:$PATH" bun run build`
Expected: tsc clean (component is unimported but `bun run build` will still type-check all `.tsx` files).

- [ ] **Step 4.4: Commit**

```bash
git add apps/desktop/src/components/views/CalendarView.tsx
git commit -m "feat(desktop): CalendarView component"
```

---

## Task 5: Wire CalendarView into CardGrid (view switcher + dedicated query + field picker)

**Files:**
- Modify: `apps/desktop/src/components/CardGrid.tsx`

**Interfaces:**
- Consumes: `CalendarView` (Task 4); existing `noteView`, `setNoteViewLocked`, `viewSwitcher` JSX (around line 1135); `PropSelect` (existing, unmodified); `schema` (`FolderSchema | null`); `folderFilter`; `folders`; `select`; `setFolderFilter`; `queryClient`; `dailyFolder`/`dailyEnabled` (read from config); `openDailyNote` (existing Tauri wrapper).
- Produces: a 5th view-switcher button `{ v: "calendar", Icon: Calendar }` aliased to avoid a name clash with `components/Calendar.tsx`; when `noteView === "calendar"`, a `PropSelect` next to it bound to created_at / updated_at / schema date props; a dedicated `useQuery` keyed `["memos", "calendar", folderFilter, includeTags, excludeTags, favoritesOnly]` with `listMemos(null, 2000, { ... })`; the `<CalendarView ... />` mount in the view-dispatch tree; `setFolderCalendarField` wired for folder mode and localStorage `oximemo.calendarField` for query mode.

- [ ] **Step 5.1: Add the imports**

At the top of `CardGrid.tsx`:

- `import { Calendar as CalendarIcon }` (renamed to avoid clashing with `components/Calendar.tsx`)
- `import { CalendarView } from "./views/CalendarView"`
- `import { PropSelect } from "./PropSelect"` (if not already)
- `import { setFolderCalendarField } from "../lib/api"`
- `import { propKeyLabel } from "../lib/propDisplay"`

- [ ] **Step 5.2: Add the dedicated calendar query**

Just above the existing `useInfiniteQuery` for `["memos", ...]`:

```ts
const calendarMemosQuery = useQuery({
  queryKey: ["memos", "calendar", folderFilter, includeTags, excludeTags, matchAll, favoritesOnly],
  enabled: noteView === "calendar",
  queryFn: () =>
    listMemos(null, 2000, {
      folder: folderFilter,
      include_tags: includeTags,
      exclude_tags: excludeTags,
      match_all: matchAll,
      favorites_only: favoritesOnly,
      immediate: false, // recursive — same scope as Timeline/Graph
    }),
});
```

Use the same `includeTags/excludeTags/matchAll` variables that the existing query uses (search for them in this file).

- [ ] **Step 5.3: Resolve the current date field**

In CardGrid scope:

```ts
const folderCalendarField: string = useMemo(() => {
  const def = folderFilter !== null ? folders.find((f) => f.path === folderFilter) : null;
  return def?.calendar_date_field ?? "created_at";
}, [folderFilter, folders]);
```

For query mode (folderFilter === null), the persisted value comes from localStorage; look for the existing pattern near `loadQueryView()` and add a sibling `loadCalendarFieldQuery()` reading `oximemo.calendarField` (default `"created_at"`). Use that value when `folderFilter === null`; otherwise use the FolderDef value above.

- [ ] **Step 5.4: Resolve the daily config**

CalendarView needs `dailyFolder` and `dailyEnabled`. Both are on the `Config` already fetched as `configQ.data` in CardGrid. Read:

```ts
const dailyFolder = configQ.data?.daily?.folder ?? null;
const dailyEnabled = configQ.data?.daily?.enabled ?? true;
```

(Adapt field names if the actual schema differs — read the relevant lines of `apps/desktop/src/lib/types.ts` and the existing config response shape used by the daily sidebar calendar.)

- [ ] **Step 5.5: Extend the view-switcher button array**

In `viewSwitcher` (around line 1141–1161), change the array from:

```tsx
{([
  { v: "grid", Icon: LayoutGrid },
  { v: "list", Icon: List },
  { v: "timeline", Icon: Clock },
  { v: "graph", Icon: Network },
] as const).map(...)
```

to:

```tsx
{([
  { v: "grid", Icon: LayoutGrid },
  { v: "list", Icon: List },
  { v: "timeline", Icon: Clock },
  { v: "graph", Icon: Network },
  { v: "calendar", Icon: CalendarIcon },
] as const).map(...)
```

Calendar is unconditional — no `shelfAvailable` gate.

- [ ] **Step 5.6: Add the `PropSelect` next to the Calendar button**

Inside the `viewSwitcher` div, after the `.map(...)` block and before the `shelfAvailable && ...` block, add:

```tsx
{noteView === "calendar" && (
  <PropSelect
    value={folderFilter === null ? currentQueryCalendarField : folderCalendarField}
    options={[
      { value: "created_at", label: t.calendar_field_created },
      { value: "updated_at", label: t.calendar_field_updated },
      ...(folderFilter !== null && schema?.properties
        ? Object.entries(schema.properties)
            .filter(([, d]) => d.prop_type === "date")
            .map(([k]) => ({ value: k, label: propKeyLabel(k, t) }))
        : []),
    ]}
    onChange={(value) => {
      if (folderFilter === null) {
        // Query mode: persist to localStorage
        if (typeof window !== "undefined") {
          window.localStorage.setItem("oximemo.calendarField", value);
        }
      } else {
        setFolderCalendarField(folderFilter, value === "created_at" ? null : value)
          .then(() => qc.invalidateQueries({ queryKey: ["config"] }))
          .catch((e) => setToast(String(e).split("\n")[0]));
      }
    }}
  />
)}
```

The current query-mode calendar field must be read into a local variable named `currentQueryCalendarField`. Compute it once near the other derived values:

```ts
const currentQueryCalendarField =
  folderFilter === null
    ? (typeof window !== "undefined"
        ? window.localStorage.getItem("oximemo.calendarField") ?? "created_at"
        : "created_at")
    : folderCalendarField;
```

(`t.calendar_field_created`/`calendar_field_updated` are new i18n keys from Task 6 — for this step, hardcode the Korean/English labels if the keys don't exist yet, or leave them as literal strings the implementer will replace in Task 6. Decision: hardcode the strings here as `"생성일"` and `"수정일"` — Task 6 swaps them for i18n keys.)

- [ ] **Step 7.7: Mount `<CalendarView />` in the view-dispatch tree**

Find the `noteView === "graph"` arm in the JSX (around line 1628). Add a new arm BEFORE the graph arm but after the timeline arm:

```tsx
) : noteView === "calendar" ? (
  <CalendarView
    memos={calendarMemosQuery.data?.pages.flatMap((p) => p.items) ?? []}
    dateField={folderFilter === null ? currentQueryCalendarField : folderCalendarField}
    folders={folders}
    onSelect={select}
    onOpenFolder={setFolderFilter}
    today={todayLocalISO()}
    locale={/* existing locale from useI18n() — reuse that variable */}
    dailyFolder={dailyFolder}
    dailyEnabled={dailyEnabled}
    onOpenDailyNote={(date) => openDailyNote(date).then(...).catch(...)}
  />
) : (
```

`todayLocalISO()` is already exported from `apps/desktop/src/lib/dates.ts`. `openDailyNote` is the existing Tauri wrapper (search for `openDailyNote` usages in `CardGrid.tsx` and follow the same call pattern as the sidebar Today button).

- [ ] **Step 5.8: Build + test**

Run:
- `PATH="$PWD/node_modules/.bin:$HOME/.bun/bin:$PATH" bun run build`
- `PATH="$PWD/node_modules/.bin:$HOME/.bun/bin:$PATH" bun test`

Expected: tsc clean (the new types align with Task 2), frontend tests pass.

- [ ] **Step 5.9: Smoke check in vite dev mode (browser fallback)**

Start `PATH="$PWD/node_modules/.bin:$HOME/.bun/bin:$PATH" bun run dev` and verify in a browser tab:
- View switcher shows a Calendar button between Graph and Shelf.
- Clicking it renders the month grid.
- Notes appear on their created_at day.
- "+N더" appears when ≥4 same-day notes; click → popover with the rest.

- [ ] **Step 5.10: Commit**

```bash
git add apps/desktop/src/components/CardGrid.tsx
git commit -m "feat(desktop): wire CalendarView into view switcher"
```

---

## Task 6: i18n keys (ko/en) + replace placeholder strings in CalendarView

**Files:**
- Modify: `apps/desktop/src/lib/i18n/locales/ko.ts`
- Modify: `apps/desktop/src/lib/i18n/locales/en.ts`
- Modify: `apps/desktop/src/components/views/CalendarView.tsx`
- Modify: `apps/desktop/src/components/CardGrid.tsx`

**Interfaces:**
- Consumes: existing i18n `t` object shape; `useI18n()` returns `{ t, locale }` where `t.<key>` is either a string or a function (for parameterized keys).
- Produces: 6 new keys — `view_calendar`, `calendar_field_created`, `calendar_field_updated`, `calendar_today`, `calendar_more(n)`, `calendar_no_date(n)`. Placeholder strings from Task 4/5 are replaced with these lookups.

- [ ] **Step 6.1: Read the i18n type signature**

Read enough of `apps/desktop/src/lib/i18n/index.ts` (or wherever the `Dict`/`Vocab` type lives) to determine whether parameterized keys are typed as `(n: number) => string` or as raw strings. The existing precedent (`t.calendar_more(overflow)`) assumes function form — verify the type agrees.

- [ ] **Step 6.2: Add keys to `ko.ts`**

```ts
view_calendar: "캘린더",
calendar_field_created: "생성일",
calendar_field_updated: "수정일",
calendar_today: "오늘로",
calendar_more: (n: number) => `+${n}더`,
calendar_no_date: (n: number) => `날짜 없음 (${n})`,
```

- [ ] **Step 6.3: Add keys to `en.ts`**

```ts
view_calendar: "Calendar",
calendar_field_created: "Created",
calendar_field_updated: "Updated",
calendar_today: "Today",
calendar_more: (n: number) => `+${n} more`,
calendar_no_date: (n: number) => `No date (${n})`,
```

- [ ] **Step 6.4: Replace placeholder strings in CalendarView.tsx**

In `apps/desktop/src/components/views/CalendarView.tsx`:

- Replace any `(\`+${overflow}\`)` fallback literal with `t.calendar_more(overflow)`.
- Replace any `(\`날짜 없음 (${n})\`)` literal with `t.calendar_no_date(n)`.
- Replace any `t.calendar_today ?? "today"` literal with `t.calendar_today` directly (the key is now guaranteed by the type).

- [ ] **Step 6.5: Replace placeholder labels in CardGrid.tsx**

Replace the hardcoded `"생성일"`/`"수정일"` strings in the `PropSelect` `options` array with `t.calendar_field_created`/`t.calendar_field_updated`.

- [ ] **Step 6.6: Add i18n coverage test**

In `apps/desktop/src/lib/i18n/__tests__/` (or wherever locale parity tests live — search for an existing locale parity test file), add assertions that both `ko.ts` and `en.ts` contain all 6 new keys with matching types (string for the first four, `(n: number) => string` for the last two). Mirror the existing test structure for any precedent parameterized key (`calendar_more`-style).

- [ ] **Step 6.7: Build + test**

Run:
- `PATH="$PWD/node_modules/.bin:$HOME/.bun/bin:$PATH" bun run build`
- `PATH="$PWD/node_modules/.bin:$HOME/.bun/bin:$PATH" bun test`

Expected: tsc clean, frontend tests pass including the new locale parity assertion.

- [ ] **Step 6.8: Commit**

```bash
git add apps/desktop/src/lib/i18n/locales/ko.ts apps/desktop/src/lib/i18n/locales/en.ts apps/desktop/src/components/views/CalendarView.tsx apps/desktop/src/components/CardGrid.tsx apps/desktop/src/lib/i18n/__tests__/...
git commit -m "feat(i18n): calendar view labels (ko/en) + locale parity test"
```

---

## Task 7: Final verification + CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: the spec verification list (§7 of the spec).
- Produces: a CHANGELOG entry under the next unreleased version.

- [ ] **Step 7.1: Run the full Rust + frontend test suites**

Run:
- `cargo test -p oximemo-core`
- `PATH="$PWD/node_modules/.bin:$HOME/.bun/bin:$PATH" bun test`
- `PATH="$PWD/node_modules/.bin:$HOME/.bun/bin:$PATH" bun run build`

Expected: all green, all warnings are pre-existing.

- [ ] **Step 7.2: Browser fallback E2E walkthrough**

`PATH="$PWD/node_modules/.bin:$HOME/.bun/bin:$PATH" bun run dev` and walk through the spec's §7 scenarios:
- Switch an arbitrary folder to Calendar → notes land on their local created_at day.
- Switch bucket field to a schema date prop via the dropdown → untagged notes move to "날짜 없음" strip; tagged ones to their day.
- Seed 5 same-day notes (via `createMemo` in the JS console) → cell shows 3 titles + "+2더"; popover lists the rest; clicking one opens it.
- Daily folder empty day → creates + opens; set `[daily] enabled=false` → same click is a no-op.
- Non-daily empty day → no-op.
- Query mode (전체 메모) Calendar → only created_at/updated_at in the field dropdown.
- Reload after picking Calendar + custom field → selection survives.

- [ ] **Step 7.3: Update CHANGELOG.md**

Add an entry under the next unreleased version header. Follow the existing CHANGELOG.md structure — find the most recent version header (currently 0.9.x). Likely target: 0.9.4 or whatever the next-increment would be. Mirror the section/sub-section structure of recent entries (look at the entry for the inbox rename or the latest feat: commit):

```markdown
## [0.9.4] - 2026-08-25

### Added
- **Calendar view**: Notion-style month-grid view as a 6th option alongside grid/list/timeline/graph/shelf. Available on every folder and on the smart collections (전체 메모/즐겨찾기). Default bucket is `created_at`; switchable per folder to `updated_at` or any schema `date`-typed property (`watched_at`, `published_at`, …) via a small dropdown next to the Calendar button. Multi-note days show up to 3 titles with a "+N더" popover for the rest; notes missing the bucket date surface in a collapsible "날짜 없음" strip rather than silently dropping. Daily folders keep their click-to-create empty-day behavior; every other folder's empty days are no-ops. New Tauri command `set_folder_calendar_field`, new `FolderDef.calendar_date_field`, dedicated bounded data fetch (limit 2000) decoupled from the Grid/List infinite-scroll cursor.
```

- [ ] **Step 7.4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): calendar view"
```

- [ ] **Step 7.5: Final verification — `git log` + `git status`**

```bash
git log --oneline 27202fe..HEAD
git status --porcelain
```

Expected: 7 commits (one per task), all with conventional commit messages, working tree clean.
