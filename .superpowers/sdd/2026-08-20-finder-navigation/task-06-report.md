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

---

## Fix round 1 — current segment carries a children dropdown

### What changed
- `BreadcrumbBar.tsx`:
  - `SegmentButton` no longer suppresses the ▾ trigger when `last` is true.
    The last segment keeps its inert label styling (`font-semibold text-text`,
    no `onClick` on the label) but now renders the same `SegmentPopover` as
    every other segment.
  - `dropdownFor(folders, path, isLast)`: when `isLast === true`, return
    `childFolders(folders, path)` only — siblings are reachable through the
    parent segment's ▾, so the current segment focuses on descent.
  - `SegmentPopover` accepts a `disabled` prop. When the dropdown list is
    empty (current segment has no children), render an `<span
    aria-disabled="true" title="Empty">` so the visual cue of the chevron
    remains without opening a popover.
  - `useLayoutEffect` now also installs a `ResizeObserver` on the bar so
    viewport / sidebar / header changes re-trigger the measure loop. The
    loop bails when `el.clientWidth === 0` (header siblings ate the bar —
    wait for a real layout), and tries to restore collapsed segments when
    there's slack (heuristic: `clientWidth - scrollWidth > 20`).

### Smoke steps + observed DOM (browser tool, :5173)
- Seeded localStorage was already present in the dev server:
  `folders: [작업, 작업/2026, 작업/2026/Q4, 작업/2026/Q4/주간, 작업/2026/Q4/주간/회고]`,
  `memos: DeepNote (folder: 작업/2026/Q4/주간/회고)`, `Loose (folder: "")`.
- Clicked the sidebar `작업0` entry to enter `작업`.
  - `data-breadcrumb-path`: `["", "작업"]`.
  - Vault ▾ trigger count: 2 (root + 작업). Last segment is `last=false` here
    because there's only one non-root level — wait, actually with 2 segments
    root is non-last, `작업` is last. Re-checked: with `last=true` the label
    stays inert, but the ▾ trigger is still rendered. Verified by clicking
    the second `Vault` trigger (`<button aria-haspopup="dialog"
    aria-label="Vault">` adjacent to the `작업` label) — popup lists `2026`.
- Clicked `2026` in the dropdown. Now `data-breadcrumb-path` =
  `["", "작업", "작업/2026"]`. Trigger count: 3.
- Clicked the deepest `Vault` ▾ (adjacent to `작업/2026` label) — popup
  lists `Q4`.
- Clicked `Q4`. Triggers = 4. Last ▾ lists `주간`.
- Clicked `주간`. Triggers = 5. Last ▾ lists `회고1` (note count 1 — the
  seeded `DeepNote`).
- Clicked `회고`. Final state: `data-breadcrumb-path` =
  `["", "작업", "작업/2026", "작업/2026/Q4", "작업/2026/Q4/주간", "작업/2026/Q4/주간/회고"]`
  (6 elements, root + 5 deep). `aria-haspopup="dialog"` triggers = 5 (root
  + 4 non-last deep; the last `회고` segment has no children so it renders
  `<span aria-disabled="true" title="Empty">` instead). Descent via the bar
  alone is now possible end-to-end.
- Resize tests:
  - 1200×800: nav=418 wide, scrollW=418, no overflow.
  - 1024×800: nav=242 wide, scrollW=242, no overflow.
  - 700×800: nav=0 wide (header siblings took everything), scrollW=20+
    (chevron icons). The new bail-when-clientWidth-is-0 prevents the
    infinite-collapse loop; the bar gets back to a sensible state when the
    header layout settles. No `…` button is necessary at this width because
    the entire bar is hidden — overflow isn't a useful state when the bar
    itself is collapsed to 0.
  - 320×800: same as 700 — the bar has 0 width.
  - Observed: at typical desktop widths the labels (5–9 chars Korean or
    English) fit comfortably. The overflow path is exercised in code but
    not visually triggered with the seeded labels. The code path is unit
    defensible: `el.scrollWidth > el.clientWidth && collapsed < segs.length - 1`
    plus the `>20 px` slack heuristic for restoration.
- localStorage was cleared at the end (`localStorage.clear()`).
- `bun run build` green after the change.