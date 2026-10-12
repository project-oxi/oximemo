# Desktop UI changes

## 2026-10-12

- Integrate Garden Button, Tooltip, SegmentedControl, Switch, Input, GPage and
  settings group/row components through the public UI package.
- Retain the Oxi Glass palette, compact corners, note sheet and immersive view.
- Follow live system theme changes and synchronize main/capture preferences.
- Reflow settings controls and daily-note tools in compact windows; add an
  accessible close action and Escape behavior to compact navigation.
- Keep document editing, persistence guards and native host behavior in their
  existing owners.
- Use achromatic chrome, inverse neutral actions, gray folder markers, selections
  and editor syntax; retain the sheet and immersive layouts.
- Align Tauri Rust pins, configure main-window geometry from Tauri config, and
  reserve native window-control space down to the 480×360 minimum.
- Use a 48px scrollable settings category strip in compact windows.
- Keep pointer selections in place, measure keyboard caret scrolling after
  preview layout, and retain caret visibility when resizing a focused editor.
- Consume existing typed emphasis closers without duplicating Markdown syntax;
  protect IME confirmation from global and save/close shortcuts.
- Bind quick capture to its draft state so reopening clears its input, with an
  opaque writing surface for consistent contrast.

See the repository-root changelog for application releases.
