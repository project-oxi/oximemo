# Calendar View — Design

Date: 2026-08-25 · Status: approved (brainstorm session 2026-08-25)

## Goal

A Notion-style month-grid "Calendar" view, a sixth `ViewMode` alongside
Grid/List/Timeline/Graph/Shelf. Buckets notes by a date — `created_at` by
default, switchable per folder to `updated_at` or any schema `date`-typed
property (`watched_at`, `published_at`, …). Available on every folder and
on the smart collections (전체 메모/즐겨찾기). No new stored note data —
purely a new lens over `MemoSummary` fields the app already fetches.

## Decisions (from brainstorm)

| Question | Decision |
|---|---|
| Which folders | All folders + smart collections (전체 메모/즐겨찾기) |
| Bucket field | `created_at` default; switchable to `updated_at` or a schema `date` prop |
| Field picker UI | Small dropdown next to the Calendar button in the view switcher |
| Multi-note days | 2–3 titles + "+N더" overflow badge → popover with the rest |
| Empty day click | Daily folder only (and only when `[daily] enabled=true`) → open-or-create; every other folder → no-op |
| Notes missing the bucket date | Not silently dropped — collapsible "날짜 없음 (N)" strip below the grid |
| Data fetch | Dedicated bounded query, independent of Grid/List's paginated scroll cursor |

## §1 Data model / bucketing

No new persisted fields on `Memo`/`MemoSummary` — `created_at`, `updated_at`,
and `props` are already present on every `MemoSummary`. Bucket key per note:

- field `"created_at"` → `isoToLocalDate(note.created_at)`
- field `"updated_at"` → `isoToLocalDate(note.updated_at)`
- field `<schema prop key>` → `note.props[key]` as `{ Str: "YYYY-MM-DD" }`;
  validate `^\d{4}-\d{2}-\d{2}$`. Missing prop or malformed value → the note
  goes into the "날짜 없음" bucket, never silently disappears.

Daily notes need no special-casing: `open_daily` already stamps
`created_at` to the day the note is opened/created, so `created_at`
bucketing places them correctly without filename-date parsing.

Reuses `lib/dates.ts` as-is: `monthGrid`, `monthTitle`, `weekdayLabels`,
`addMonths`, `isoToLocalDate`. No new date math.

## §2 Backend changes

Additive only — no migration, no write-path hook, no index/search change.

1. `crates/oximemo-core/src/config.rs`: `ViewMode` gains a `Calendar`
   variant (`#[serde(rename_all = "lowercase")]` → `"calendar"`), same
   shape as `Grid`/`List`/`Timeline`/`Graph`. Without this, persisting
   `calendar` through `set_folder_view` fails IPC deserialization — the
   exact latent trap `Shelf` is already in today (out of scope to fix;
   noted so Calendar doesn't repeat it).
2. `FolderDef` gains `pub calendar_date_field: Option<String>`
   (`#[serde(default, skip_serializing_if = "Option::is_none")]`).
   `None` = `created_at`. Stored as a plain string (not validated against
   the live schema) so a later schema edit that removes the prop degrades
   gracefully — the note just falls into "날짜 없음" instead of erroring.
3. `Vault::set_folder_calendar_field(&self, path: &str, field: Option<String>) -> Result<()>`
   — find-or-insert a `FolderDef` row, mirroring `set_folder_view`.
4. New Tauri command `set_folder_calendar_field(path: String, field: Option<String>)`,
   registered in `generate_handler`.
5. `tauri.ts` browser fallback mirrors the same command against the
   localStorage folders array, same shape as the existing `set_folder_view`
   fallback arm.

## §3 Frontend — data fetching

Calendar is a fixed month grid, not an infinite-scroll list — it cannot
reuse `viewProps.items` (Grid/List/Timeline's paginated cursor query),
because a month the user hasn't scrolled into yet may not have its notes
loaded. It needs its own bounded, cursor-independent fetch:

```
useQuery(
  ["memos", "calendar", folderFilter, includeTags, excludeTags, favoritesOnly],
  () => listMemos(null, 2000, {
    folder: folderFilter,
    include_tags: includeTags,
    exclude_tags: excludeTags,
    favorites_only: favoritesOnly,
    immediate: false, // recursive — same as Timeline/Graph
  }),
)
```

`folderFilter === null` (전체 메모/즐겨찾기) passes `folder: null` and
scans the whole vault. The 2000-item cap is a known v1 ceiling — mirrors
the existing 500-item cap the daily-dot sidebar query already accepts for
the same class of problem, just larger since this covers a folder's full
subtree rather than one folder. Server-side date-range pagination for
very large vaults is an explicit non-goal (see below).

## §4 Frontend — CalendarView component

New `views/CalendarView.tsx`:

- Props: `memos: MemoSummary[]` (the query above), `dateField: string`,
  `folders`, `onSelect`, `onOpenFolder`, `today`, `locale`.
- Local state: viewed `{ year, month }`, defaulting to the current month
  (mirrors `Calendar.tsx`).
- Header: month title + ‹› nav + "오늘로" jump, hidden when already on
  the current month (same `atToday` pattern as `Calendar.tsx`).
- Grid: `monthGrid(year, month)` cells, weekday header row
  (`weekdayLabels(locale)`), out-of-month cells dimmed, today highlighted
  — same visual tokens as the sidebar mini calendar.
- Bucketing: `useMemo` grouping `memos` by resolved key (§1) into
  `Map<string, MemoSummary[]>` plus a separate `noDate: MemoSummary[]`.
- Day cell: date number; up to 3 note titles as independently clickable
  buttons (each calls `onSelect(id)` directly, opens immediately); a 4th+
  collapses into a `+N더` badge. The badge opens a `Popover`
  (`@base-ui-components/react`, same `Root/Trigger/Portal/Positioner/Popup`
  shell as `SegmentPopover` in `BreadcrumbBar.tsx`) listing the day's
  remaining notes (title + folder chip, click to open). Titles inside the
  cell and the popover are the only click targets — the badge itself never
  opens a note directly.
- Footer: when `noDate.length > 0`, a collapsible "날짜 없음 ({n})" row
  using the identical Popover pattern to reveal the full list.
- Empty-day click: wired to `onDayClick(date) → openDailyNote(date)` only
  when `folderFilter === dailyConfig.folder && dailyConfig.enabled`
  (both conditions — matches the existing daily feature-flag gating, not
  just a path string match). Every other folder's empty cells have no
  click handler and no hover affordance beyond the date number itself.

## §5 View switcher UI

- `CardGrid.tsx`'s `viewSwitcher` (§`CardGrid.tsx:1135`) gains a 5th
  button `{ v: "calendar", Icon: CalendarIcon }` (lucide `Calendar`,
  imported aliased to avoid a name clash with the existing
  `components/Calendar.tsx`), unconditionally shown like
  grid/list/timeline/graph — no availability gate, unlike Shelf.
- When `noteView === "calendar"`, a `PropSelect` (existing component,
  unmodified) renders immediately to its right, bound to:
  - `{ value: "created_at", label: t.calendar_field_created }`
  - `{ value: "updated_at", label: t.calendar_field_updated }`
  - one entry per `Object.entries(schema?.properties ?? {})` filtered to
    `prop_type === "date"`, labeled via `propKeyLabel(key, t)` — only
    when `folderFilter !== null` (query mode has no single schema, so it
    only ever offers the first two).
  - `onChange` → `setFolderCalendarField(folderFilter, value === "created_at" ? null : value)`
    (persisting `null` for the default keeps `FolderDef` minimal) +
    invalidate `["config"]`. In query mode (`folderFilter === null`)
    there is no `FolderDef` to hang this on, so the selection persists to
    a new localStorage key `oximemo.calendarField` instead, same pattern
    as `QUERY_VIEW_KEY`.
- `loadQueryView()` in `stores/ui.ts`: allowed value set extended to
  include `"calendar"`.

## §6 i18n

New keys in `ko.ts` + `en.ts`: `view_calendar` ("캘린더"/"Calendar"),
`calendar_field_created` ("생성일"/"Created"),
`calendar_field_updated` ("수정일"/"Updated"),
`calendar_more` ("+{n}더"/"+{n} more"),
`calendar_no_date` ("날짜 없음 ({n})"/"No date ({n})").

## §7 Testing

**Rust (`config.rs`/`vault.rs`):** `ViewMode::Calendar` round-trips
through `set_folder_view` (serialize/deserialize + persist/unlock same as
the existing `set_folder_view_persists_and_unlocks` test); a new
`set_folder_calendar_field` test covers persist / clear / find-or-insert
parity with `set_folder_view`; an unknown or since-removed prop key is
stored verbatim with no write-time validation.

**Frontend (browser-fallback E2E, vite dev):**

- Switch an arbitrary folder to Calendar → notes land on their local
  `created_at` day.
- Switch the date field to a schema `date` prop via `PropSelect` → notes
  without that prop move into the "날짜 없음" strip; notes with it move
  to the new day.
- Seed 5 same-day notes → cell shows 3 titles + "+2더"; popover lists the
  remaining 2; clicking one opens it; clicking a visible title opens
  directly without the popover.
- Daily folder: click an empty day → creates + opens that day's note
  (`openDailyNote` contract unchanged); set `[daily] enabled=false` →
  the same click is a no-op.
- Non-daily folder: click an empty day → no-op, nothing created.
- Query mode (전체 메모): switch to Calendar, confirm vault-wide
  bucketing and that the field dropdown offers only created_at/updated_at.
- Reload after picking Calendar + a custom date field → selection
  survives (FolderDef for a real folder; localStorage for query mode).

`bun run build` (tsc, new `ViewMode` literal) and
`cargo test -p oximemo-core` (the two Rust additions) round out
verification.

## Non-goals (v1)

- Week/year calendar granularity.
- Dragging a note between days to rewrite its date prop.
- Recurring events, multi-day spans.
- Server-side date-range pagination — the 2000-item cap is a known v1
  ceiling for very large folders/vaults.
- Overlaying multiple folders' notes on one calendar simultaneously.
