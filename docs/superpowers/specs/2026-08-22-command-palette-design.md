# Command Palette (⌘K) — Design

**Date:** 2026-08-22
**Status:** Decided (autonomous session — user delegated decisions)
**Scope:** `apps/desktop` renderer + one new Rust IPC command

---

## 1. Problem

oximemo has no global intent surface. Every navigation and action is a
mouse trip: sidebar for collections/folders, header for view switching and
new notes, gear for settings, tray for capture. The existing ⌘⇧O
FolderPalette proves the palette interaction model works in this codebase
but covers only folder jumps.

Reference: `../oxios` `web/src/components/layout/command-palette/`
(lexer/providers/registry/ranker) — studied and **deliberately simplified**:
oximemo has no verb grammar need (no agent/skill/persona nouns), so the
federated provider registry is over-engineering here. We keep: score-based
ranking, recency log, disabled-host filtering (we own all filtering),
section grouping. We drop: verb prefixes, entity tokens, provider
federation, mode system.

## 2. Decision: search bar unification — keep separate

The header search and the palette are different tools:

| | Header search | ⌘K palette |
|---|---|---|
| Role | Persistent **in-context filter** | Transient **global intent surface** |
| Interacts with | scope chip, tag filters, favorites, folder browse | nothing — always vault-global |
| Lifetime | Lives with the view | Opens, acts, closes |

Merging them would break the browse workflows the header search is
load-bearing for (folder-scoped search + tag narrowing + favorites), and a
transient overlay cannot host persistent filter state. Precedent: macOS
Finder ⌘F (find in context) vs Spotlight (global). **Finder model wins.**

Bridge: the palette's notes section ends with a "`{q}` — search all notes"
row that writes the query into the store search and closes — a transient
query can graduate into the persistent filter.

## 3. Decision: consolidate FolderPalette

The ⌘K palette fully subsumes FolderPalette (folders are first-class
results with the same path-substring matching, color dots, note counts).
Clean cutover: **delete `FolderPalette.tsx`**, keep ⌘⇧O as an **alias**
that opens the ⌘K palette (muscle memory keeps working, one component
maintained).

## 4. Command catalog

Sections and items (titles resolve via i18n; ko shown):

**이동 (navigation)**
- 전체 메모 — query mode: `setView("memos"); setFavoritesOnly(false); setFolderFilter(null)` (sidebar convention; tags untouched)
- 즐겨찾기 — `folderFilter(null) + favoritesOnly(true)`
- 갤러리 — `setView("gallery")`
- 볼트 루트 — `folderFilter("") + favoritesOnly(false)`
- 오늘의 노트 — `openDailyNote(todayLocalISO())` → `select` + `setDraftId` when created (Sidebar's `openDaily` flow, `dailyEnabled` guard)
- Every folder (from `listFolders`) — `jumpToFolder(path)`: `setView("memos") + favoritesOnly(false) + setFolderFilter(path)` + drop search (CardGrid's `jumpToFolder` convention). Matching on full path, substring, case-insensitive ("a/b" matches nested).
- Tag `#{tag}` (from `listFacets`) — sidebar tag convention: `setView("memos"); setFavoritesOnly(false); setFolderFilter(null); cycleTag(tag)`

**보기 (view)** — each also `setView("memos")` (implied context)
- 그리드/리스트/타임라인/그래프 보기 — `setNoteView(v)` (raw store action; session-level, no folder pin). Current mode excluded from results.
- 사이드바 전환 — `toggleSidebar()`

**작업 (actions)**
- 새 MD 노트 (`⌘N` hint) / 새 HTML 노트 — CardGrid's `onNewNote`/`onNewHtmlNote` passed as props
- 새 폴더 — respects the UX principle *folder creation lives in the main area*: sets a `requestNewFolder` store flag consumed by a CardGrid effect that calls `startFolderCreate()`; if in query mode (`folderFilter === null`) first switch to vault root browse so the creation lands somewhere definite
- 빠른 캡처 (`⌘⇧N` hint) — new Rust command `show_capture_window` wrapping the existing private `show_capture` (toggle semantics preserved)
- 설정 열기 — new `settingsOpen` store flag; `SettingsMenu` becomes store-controlled (gear trigger sets the same flag)
- 테마: 시스템/라이트/다크 — SettingsMenu's `onTheme` flow verbatim: `setTheme + applyTheme + setAppearanceConfig + invalidate ["config"]`; current theme excluded

**노트 (notes)**
- Empty query: 최근 노트 — reuse the Sidebar recents cache `["memos","recents"]` (`listMemos(null, 7)`), top 5
- Query (≥1 char, 150 ms debounce): `searchMemos(q, 8)` under key `["palette-search", q]` (distinct from CardGrid's infinite `["search", q]` to avoid cache-shape collision)
- Row: folder color dot, `title ?? empty_memo`, folder path, relative time. Enter → `setView("memos"); select(id)`
- Bridge row (query ≥ 1): "`{q}` — 전체에서 검색" → CardGrid-provided `onSearchAll(q)`: query mode + search mirrors set (global search graduation)

**Home state (empty query):** 제안 section = recent commands (recency log, ≤5) filled to 6 with curated order (오늘의 노트, 새 MD 노트, 빠른 캡처, 전체 메모, 즐겨찾기, 갤러리), then 최근 노트 (5). ⌘K → ⏎ opens the most recent note — the killer path.

## 5. Ranking

Deterministic, pure, per keystroke. Command candidates match on the
localized title **and** the other locale's title (type "테마" or "theme" —
both work):

```
exact (ci)            1000
prefix                  500
word-boundary start     300   // after space or '/'
substring               200
subsequence              60 + density bonus
+ recency boost          0..25  // 25·(1 − rank/20), last 20 selections
```

Folders and tags fold into the same ladder (path/tag-name scoring). Ties:
stable by curated order. Notes stay in BM25 order from the backend — never
mixed into command ranking.

Recency log: `localStorage["oximemo.paletteRecency"]`, last 20 command ids
(`nav.all`, `folder:<path>`, `tag:<tag>`, `theme:dark`, …). Note
selections are not recorded (notes are content, not commands).

## 6. Interaction

- ⌘K / Ctrl+K toggles; ⌘⇧O opens (alias). Esc closes (Base UI Dialog default).
- Guards: inert while `selectedId` (MemoDetail owns keys — same rule as the old ⌘⇧O branch); works in gallery view (palette mounts once, outside the view branches). Capture window never sees it (separate document).
- While open: ⌘N, ⌘↑, Esc-search-clear, and ⌘⇧O all inert (extend the existing `paletteOpen` guards with `cmdPaletteOpen`).
- Keyboard in the input: ↓/↑ move (clamped), ⏎ run selected, Home/End, click, hover-select, `scrollIntoView({block:"nearest"})`. **IME guard:** `e.nativeEvent.isComposing` suppresses ⏎ (Korean IME confirm-Enter must not run a command).
- Palette closes after any command runs (single-shot), except nothing keeps it open in v1.

## 7. Architecture

```
CardGrid (owns keydown, passes onNewNote/onNewHtmlNote/jumpToFolder/onSearchAll/folders/folderDefs)
  └─ CommandPalette (Base UI Dialog; generalizes FolderPalette's markup)
       ├─ lib/paletteCommands.ts   — pure: types, buildCommands(deps), score ladder,
       │                             RecencyLog (localStorage); no React
       ├─ queries: ["folders"]+["config"]+["facets"] via props/cache,
       │           ["memos","recents"], ["palette-search", q]
       └─ stores/ui.ts             — +cmdPaletteOpen, +settingsOpen, +requestNewFolder
```

New/changed files:
- `src/lib/paletteCommands.ts` (new, pure logic)
- `src/lib/paletteCommands.test.ts` (new, `bun test`)
- `src/components/CommandPalette.tsx` (new)
- `src/components/FolderPalette.tsx` (deleted)
- `src/stores/ui.ts` (+3 fields/actions)
- `src/components/CardGrid.tsx` (⌘K branch, guards, mount, new-folder effect, FolderPalette removal)
- `src/components/SettingsMenu.tsx` (store-controlled open)
- `src/lib/api.ts` (+`showCaptureWindow`)
- `src/lib/locales/{ko,en}.ts` (+~14 keys)
- `src-tauri/src/lib.rs` (+`show_capture_window` command + registration)

## 8. Visual design

Matches the DESIGN.md canonical + FolderPalette conventions exactly:
- Top-center `top-20`, `w-[min(560px,92vw)]`, backdrop `z-40` black/40 blur-sm, popup `z-50`, `--dialog-radius`, `bg-surface-raised`, `border-line`, `shadow-lg`, scale/fade entrance.
- Input row: `Search` icon (14, text-text-subtle) + input, `border-b border-line`; trailing `esc` kbd hint (text-[10px] font-mono).
- Section headers: `text-[10px] font-semibold uppercase tracking-wide text-text-subtle` (sidebar style).
- Items: `px-2 py-1.5 rounded-md text-[13px]`, icon 14 `text-text-muted`, selected `bg-surface-muted text-text` + trailing `CornerDownLeft`; kbd hints (`⌘N`, `⌘⇧N`) right-aligned `font-mono text-[10px]`.
- Note rows: color dot (8px, `colorForFolder`), title truncate, path + relative time `text-[11px] text-text-subtle`.
- List `max-h-[60vh] overflow-y-auto`; footer hint bar `↑↓ 선택 · ⏎ 실행 · esc 닫기` (text-[10px], `border-t border-line`).

## 9. Error handling

- `openDailyNote` / `showCaptureWindow` / theme-write failures → `setError` toast (existing pattern).
- Palette search failure → inline error line in the notes section.
- Missing data (folders loading) → those commands simply absent until cached (queries already warm from CardGrid/Sidebar).

## 10. Testing

- Unit (`bun test`): scoring ladder (exact > prefix > boundary > substring > subsequence), IME-safe lexing N/A, recency boost/order/cap, buildCommands section composition, current-state exclusions (active theme/view), folder/tag matching, suggestions fill logic.
- Manual (verification phase): dev run — ⌘K open/close, Korean IME Enter, arrow nav, run each command class, gallery availability, guard behavior with MemoDetail open, ⌘⇧O alias, recency persistence across reload.

## 11. Non-goals (v1)

- Verb-prefix grammar (oxios-style) — no evidence of need
- Note bulk actions / favorites toggling from the palette
- Nested secondary menus (e.g. per-note actions)
- Palette availability inside MemoDetail or the capture window
