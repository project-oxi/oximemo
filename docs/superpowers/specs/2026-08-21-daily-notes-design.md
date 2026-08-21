# Daily Notes — Design

**Date:** 2026-08-21
**Status:** Approved (brainstorm session 2026-08-21)
**References:** Logseq journals, Obsidian Daily Notes core plugin + Calendar plugin (liamcain), Day One

## Goal

One note per day, created on demand, integrated with the existing
per-folder template mechanism. A persistent sidebar calendar
(Finder-model curation surface) shows which days have notes and opens
or creates a day's note in one click. Daily notes are ordinary notes —
no special index, no special editor.

## Decisions (from brainstorm)

| Question | Decision |
|---|---|
| Calendar placement | **A — persistent sidebar mini-calendar** (Obsidian Calendar / Day One pattern) |
| Auto-open on launch | **No** — memo-first app; entry via Today button / calendar |
| Day dots | **Presence only** — one dot if the day's note exists (no word-count meter) |
| Weekly/monthly notes | **Out of scope** (Obsidian split these out too — YAGNI) |

## §1 Data model

- A daily note is a regular note in a configurable folder.
- Title (H1) = ISO date `YYYY-MM-DD`; file = `{folder}/{date}.md`
  (or `.html` in html-template folders). Locale-neutral, sortable,
  greppable. UI displays use locale formatting; the file never does.
- Config: `oximemo.toml` gains a `[daily]` section (serde-defaulted,
  vaults without it behave as `enabled = true`, `folder = "daily"`):

  ```toml
  [daily]
  enabled = true
  folder = "daily"
  ```

  `enabled = false` hides the sidebar Today button and calendar
  (same pattern as the `[brain]` panel).
- The daily folder is auto-created by `write_note`'s existing
  `create_dir_all`; no folder pre-creation.

## §2 Backend

`Vault::open_daily(&self, date: &str) -> Memo` — authoritative,
idempotent create-or-open:

1. Validate `date` against `^\d{4}-\d{2}-\d{2}$` (error otherwise).
2. Resolve folder from config (`[daily].folder`).
3. Look for an existing note at `{folder}/{date}.md` or
   `{folder}/{date}.html` (folder-scoped list scan). Found → return it.
   This also adopts user-created files with matching names.
4. Missing → create via the normal path so index/search/watcher all
   fire:
   - Body = the folder's `TEMPLATE.md`/`TEMPLATE.html` applied with a
     **new** `TemplateCtx::for_date(date, folder, counter)` — the
     caller-supplied local date drives `{{date}}`/`{{year}}`/
     `{{month}}`/`{{day}}`, and weekday is derived from the date.
     Rationale: existing `TemplateCtx::now()` uses UTC, which is off
     by one day for KST evenings. `open_daily` receives the date as a
     parameter (computed client-side in local time), so the backend
     never guesses a timezone.
   - No template → body starts empty.
   - **H1 normalization:** after template application, if the derived
     title ≠ `date`, prepend `# {date}\n\n`. This guarantees the
     deterministic filename `{folder}/{date}.md` even when the
     template's H1 is something else (`# 일지`).
   - Format: html only when the folder has `TEMPLATE.html` and no
     `TEMPLATE.md` (existing `create_note_auto` rule).
5. Emit `memos:changed` as usual after creation.

New Tauri command `open_daily_note(date: string) -> Memo` registered
in `generate_handler`. CLI: not in scope.

## §3 Frontend

**Sidebar (component `Sidebar.tsx`)**

- FAVORITES gains a **"오늘의 노트" (Today's note)** button under
  Gallery: Calendar icon, opens/creates today's note. Active state
  while today's note is the open note.
- New **DAILY section** between FAVORITES and RECENTS:
  - Month header: `2026년 8월` / `August 2026` + `‹ ›` month nav.
  - Weekday row `일 월 화 수 목 금 토` (Sunday-first; en uses
    `Su Mo …`; single Sunday-first grid for both locales).
  - Day grid: days with a note get one dot under the number; today
    gets the primary-fill highlight; adjacent-month days are dimmed
    and clickable. Click = open-or-create that day's note (backfill
    past, plan future — Obsidian parity, no confirm dialog).
  - Viewed month is component state, defaulting to the current
    month; month nav is unbounded.
- Dot data: `useQuery(["memos", "daily"], () => listMemos(null, 500,
  { folder: dailyFolder }))` → `Set<string>` of dates parsed from
  paths with `/{(\d{4}-\d{2}-\d{2})}\.(md|html)$/`. The existing
  `["memos"]` prefix invalidation refreshes it on every change.
  Non-matching files in the folder are ignored (no dot).
- Open flow: `openDailyNote(date)` API → invalidate `["memos"]` →
  `useUI.select(id)` + `setView("memos")` → MemoDetail opens.
- All daily UI hidden when `[daily] enabled = false`.

**"Today"** is computed client-side in local time
(`new Date()` → `YYYY-MM-DD`), so midnight rollover reflects in the
UI on re-render.

## §4 Browser fallback (`tauri.ts`)

`openDailyNote(date)` mirrors the semantics on the localStorage
store: find a memo whose `path` matches `{folder}/{date}.(md|html)`;
else create one with body `# {date}` (no template — the fallback
cannot read vault files), folder set to the configured daily folder,
then emit the same change event. Remains a first-class verification
surface.

## §5 i18n

New keys added to `ko.ts` + `en.ts` in the same commit:
`today_note`, `daily_section`, plus month/weekday formatting via
`Intl.DateTimeFormat(locale)`. No "(root)"-style raw literals in UI.

## §6 Testing

- **Rust (`vault.rs` tests):** open creates then re-open returns the
  same note (idempotent by id); template applied with caller date
  (not UTC); H1 normalization when template H1 ≠ date; custom
  `[daily].folder` respected; html-only template folder produces
  `.html`; invalid date rejected; existing manually-named file
  adopted, not duplicated.
- **Frontend (browser fallback E2E):** calendar renders with correct
  month/weekday layout; dots appear for seeded notes; clicking an
  empty day creates `{folder}/{date}` note and opens it; clicking a
  dotted day opens without duplicating; Today button opens today's;
  `enabled=false` hides all daily UI.

## Out of scope

Weekly/monthly periodic notes, word-count dot meters, launch
auto-open, CLI command, settings GUI for `[daily]` (edit the toml;
GUI parity can come later).
