# 0001: Incremental Garden UI integration

Status: accepted. Date: 2026-10-12.

The owner requested actual Garden component use while preserving the current
Liquid Glass design and immersive note view. Adopt the self-contained Garden
0.1.0 snapshot with the `ui` adoption. Import public APIs from `@garden/ui` and
load its public stylesheet; do not modify managed framework source.

## Composition

Use Garden Button, Tooltip, SegmentedControl, Switch, Input, GSettingsGroup,
GSettingsRow and GPage. The app still owns domain actions, settings commits,
source snapshots and persistence. Existing Base UI dialogs and menus continue
to own modal focus and dismissal. Local icon-tool compositions combine public
Garden components; they do not implement a competing button primitive.

## Narrow exceptions

- `shell.layout`: retain the 52px workbench toolbar, compact sidebar, grouped
  settings navigation, right note sheet and full-window immersive mode. The
  same editor stays mounted when the note layout changes. Each content region
  keeps its existing scroll owner.
- `ui.tokens`: `src/garden-adapter.css` maps Garden semantic variables to the
  root Oxi Glass tokens. Keep the system/SUIT font stack, monochrome surfaces,
  inverse neutral primary actions,
  6px controls, 8px cards, 10px menus and 12px sheets. Markdown reads at 760px;
  authored HTML keeps full available width. Controls and labels reflow in
  compact settings panes. This does not style authored document content.
- `stack.ui`: public Garden controls coexist with the established Base UI
  modal and popup layer. Do not nest a new modal focus trap around the note
  editor or Copilot. This exception permits incremental control integration,
  not an alternative local primitive library. The settings host adapts arrow,
  Home and End selection because Base UI stops document key events used by
  Radix RadioGroup. Garden continues to own radio semantics and rendering.
- `stack.desktop`: retain the custom Tauri host, capture, tray and updater.
  The owner subsequently requested native verification and Rust pin alignment:
  `tauri = 2.12.0` and `tauri-build = 2.7.0` are now exact dependencies. Main-window
  geometry comes from Tauri configuration while manual creation preserves the
  traffic-light inset. Production starts at 1100×720, with a 480×360 minimum.
  Native overlays reserve window-control space in compact layouts. The existing
  host remains an explicit architecture exception; doctor now passes its pins.

## Preferences and document boundary

System theme is the default. Follow live OS changes in main and capture windows;
explicit light/dark choices override detection. Synchronize saved preferences
between windows. Product strings use matching `locales/en.json` and `ko.json`
catalogs, with typed compatibility exports for existing app imports.

The document/editor packages are not part of this adoption. PDC and the staged
repository migration remain authoritative for document formats and write guards.

## Verification

Run Garden sync and doctor, the frontend build and relevant behavior tests.
For native changes run locked Rust tests and Clippy with warnings denied.
Exercise real controls, keyboard choices, focus return, both note layouts,
capture, live light/dark detection and compact through wide viewport sizes.
Record observed results and any doctor limitations in the UI assessment.
