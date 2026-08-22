# Sidebar Redesign — Finder Completion (A안)

Date: 2026-08-22 · Status: approved (user picked Concept A + pins in Locations)

## Problem

1. "모든 노트" (folderFilter=null) is a flat smart collection, but root notes'
   card label reused `t.all_memos` — reads like a folder named "모든 노트".
2. Root browsing (folderFilter="") is the launch view yet becomes unreachable
   from the sidebar once in query mode (breadcrumb is label-only there,
   folder chips are non-clickable spans, navigateUp no-ops).
3. Today's-note button (Favorites) and the Daily calendar section are split.
4. Root is named "최상위" (folder_root) in the folder picker and "볼트"
   (vault_root) in breadcrumbs.

## Design (Concept A — 완성형 Finder)

Sidebar sections, top to bottom:

- **즐겨찾기** — 전체 메모 (count) · 즐겨찾기 (count) · 갤러리
- **위치** (new, `locations_section`) — 볼트 (root browse entry, no count —
  a location, not a collection) · pinned folder rows (color dot)
- **데일리** — "오늘의 노트" row (local-date subtitle) directly above the
  mini calendar: one integrated block
- **최근 항목**, **태그** — unchanged

Naming (i18n):

- `all_memos`: 모든 노트 → 전체 메모 (ko); en stays "All Notes"
- `query_all_notes`: follows all_memos
- `folder_root`: 최상위 → 볼트 (unify with vault_root); en "Vault"
- new `locations_section`: 위치 / Locations

Behavior:

- Sidebar 볼트 click → `setFolderFilter("")`; active when
  `view==="memos" && !favoritesOnly && folderFilter === ""`
- Folder chips on cards/timeline rows (query mode) become buttons →
  `setFolderFilter(folder)` (browse that folder)
- Root notes' card header omits the folder label entirely (no dot, no name,
  no separator) instead of showing "모든 노트"
- `navigateUp` (⌘↑): query mode now steps to root browse ("") instead of
  no-op

Unchanged: main-grid folder tiles, folder create/rename flows, tag →
all-notes flow, FolderPalette.

## Surfaces

- `Sidebar.tsx` — section reorder, Locations section, today row into Daily
- `Card.tsx` — root-label omission, clickable folder chip (new prop)
- `TimelineView.tsx` — clickable folder chip (onOpenFolder already present)
- `GridView.tsx` / `CardGrid.tsx` — thread `onOpenFolder` to Card
- `stores/ui.ts` — navigateUp query-mode step
- `locales/ko.ts`, `locales/en.ts`
