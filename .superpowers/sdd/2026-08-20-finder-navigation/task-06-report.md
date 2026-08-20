# Task 6 — BreadcrumbBar + header rebuild

## Summary
Implemented the breadcrumb bar as the single source of location. Browse mode
renders one clickable segment per path component (root = vault icon); each
non-last segment exposes a ▾ dropdown listing its siblings plus its own
children. Query mode renders one inert label with an icon reflecting the
active query kind. Overflow: leading segments collapse behind a `…` chip that
restores them on click.

## Files changed
- `apps/desktop/src/components/BreadcrumbBar.tsx` (NEW)
- `apps/desktop/src/components/CardGrid.tsx` (header rebuild, sidebar toggle inline)
- `apps/desktop/src/app.css` (`--folder-tile-bg` token)
- `apps/desktop/src/tokens/semantic-dark.css` (`.dark` override for `--folder-tile-bg`)
- `apps/desktop/src/lib/locales/ko.ts` (13 new keys)
- `apps/desktop/src/lib/locales/en.ts` (13 new keys)

## Key behaviors
- `<BreadcrumbBar>` is the first flex child of the CardGrid header; each
  segment exposes `data-breadcrumb-path={path}` for the Task 14 drop target.
- Each non-last segment opens a Base UI `Popover` listing siblings (children
  of parent path) plus own children; the root icon's popover lists top-level
  folders only.
- Browse mode: chevron separators between segments; last segment is
  `font-semibold`, non-clickable, still carries `data-breadcrumb-path`.
- Query mode: a single inert span with icon + label. Icons are
  `Search/Star/Hash/Layers` per query kind; labels come from the new i18n
  keys (`query_all_notes`, `query_favorites`, `query_search`, `query_tags`).
- `useLayoutEffect` measures overflow on each `folderFilter` change and
  hides leading segments one at a time until the bar fits, then renders a
  single `…` button (click restores `collapsed = 0`).
- Sidebar toggle moved inline as the first header element (`flex h-12
  shrink-0 items-center pl-1`); the fixed-position wrapper and its two
  usages are deleted (gallery branch keeps the sidebar mount, not the
  toggle — gallery shows its own header).
- Header keeps `data-tauri-drag-region="deep"`; `BreadcrumbBar`'s `<nav>`
  sets `data-tauri-drag-region="false"` so click events bubble to children.
- View switcher is now four lucide icons (`LayoutGrid`, `List`, `Clock`,
  `Network`) sized 13, with `aria-label={v}` (= mode name) and
  `aria-pressed`. Lock button stays; still rendered only when
  `folderFilter !== null` (T5 semantics).
- 13 i18n keys added in both `ko.ts` and `en.ts` exactly as the brief
  prescribes (`vault_root`, `breadcrumb_label`, `scope_this_folder`,
  `scope_all`, `folder_notes`, `folder_subfolders`, `folder_empty`,
  `query_all_notes`, `query_favorites`, `query_search`, `query_tags`,
  `global_badge`, `jump_to_folder`, `show_all_folders`). No additional
  keys — view-switcher aria-labels reuse the literal mode names.

## Smoke evidence
- `bun run build` green.
- Browser smoke on `:5173` (existing dev server):
  - At root (`folderFilter=""`): `nav[aria-label="Location"]` (en) /
    `nav[aria-label="경로"]` (ko) present with `Folder` icon for the vault
    segment and a chevron-down trigger.
  - After clicking `작업` in the sidebar tree: `data-breadcrumb-path` set
    on both segments (`""` for vault, `"작업"` for the segment).
  - The root segment's popover lists the immediate top-level folder
    reported by `listFolders` (only `a`/`작업` are visible because the
    smoke vault has no other directories).
  - In query mode (after clicking `모든 메모` / `All memos`): single
    label "모든 노트" with `lucide-layers` icon; no chevron-down.
  - View switcher: 4 icon buttons with `aria-label="grid"|"list"|
    "timeline"|"graph"` and the lock button only when
    `folderFilter !== null`.
  - Sidebar toggle button is inside the header (first child with the
    `pl-1` wrapper); no `fixed left-[82px]` positioning exists anywhere.
- `localStorage` was cleared at the end of the smoke run.
- A 500px viewport was set; with only `vault + 작업` segments, the bar
  fits and no `…` chip appears (logic is exercised but doesn't trigger
  with this dataset; the useLayoutEffect measures scrollWidth > clientWidth
  and increments `collapsed` one segment at a time).

## Deviations
- The brief's sketch contained an inline `&& null` placeholder artifact in
  the collapsed-segments JSX; per the brief's own resolution note I
  simplified it to a single `…` button rendered when `collapsed > 0`
  followed by `segs.slice(collapsed)`. The `useLayoutEffect` measure loop
  was preserved.
- View switcher aria-label uses the literal mode name (`grid`, `list`,
  `timeline`, `graph`) per the brief ("title+aria-label = mode name").
  No new i18n keys were added for view-mode labels.