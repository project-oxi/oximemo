# Native popover verification — 2026-10-14

The candidate keeps the existing monochrome shell and immersive layout. It
bounds Base UI popovers to the anchor's available space, restores native schema
property types at the IPC boundary, and keeps multiselect typing in its input.
Document formats, parsing, storage, guarded mutations and managed Garden source
are unchanged by these fixes.

## Observed defects

| Native reproduction | Result |
| --- | --- |
| 480×360 task edit popup | Description and footer extended beyond the window. The bounded popup now scrolls; Tab reaches the description and Escape restores editor focus. |
| 480×360 folder move submenu, 29 folders and a long path | An oversized blank portion covered the window while options extended outside it. The list now fits and End reaches its last option. |
| 480×360 breadcrumb folder menu with a long path | Intrinsic width pushed its right edge outside the window. A bounded width and truncated labels keep it inside. |
| 480×360 filter builder | Its 480px panel extended beyond the window edge. Available-space bounds and wrapping actions now keep the panel inside the window, including added conditions and a nested group. |
| Native knowledge property editors | Serialized Rust `type` fields were read as `prop_type`, producing text editors for select/list/date properties. Boundary normalization restores the typed controls. |
| Native multiselect autocomplete | Opening suggestions moved focus out of the input; subsequent typing reached the note body. The final fix retains input focus, anchors directly to the input and supports direction-key navigation. |
| Task popup open during 480×360 → 1920×1050 resize in immersive mode | The opening-time caret snapshot left the popup far from its task. The virtual anchor now measures the live task line and exposes the editor element for Base UI layout and scroll tracking. |

## Completed verification

- Native 480×360 audit: note context menu, long folder move submenu, breadcrumb,
  folder search, note format menu, property add, backlink, calendar overflow,
  calendar date field, schema filter and property select popovers.
- Native 480×360 ↔ 1868×1050: zoomed and restored the window with a submenu
  open; it stayed bounded and retained its focused last option.
- Native schema filter and property select: Tab reached the last of 34 options
  including a long label; Escape restored the trigger focus.
- Final native 480×360, 768×600 and 1100×720: multiselect suggestions stayed
  inside each window. Typing AI and an additional character remained in the
  property input and left the note body empty. Down/Up navigated to the
  suggestion and back; Enter added the chip; typing after Escape still reached
  the input. Native property editors retained their select/list/date types.
- Final native 480×360 filter builder: added two conditions and a nested group.
  The panel stayed between the 12px window margins and scrolled within its
  available height. Tab could leave the non-modal panel without trapping focus.
- Final native immersive task edit: zoomed 480×360 → 1920×1050 → 480×360 with
  the popup open. It followed the task line at both sizes. Tab revealed the
  description and footer at the small size; Escape returned to the editor.
- Final native 768×600: the 25-profile switcher and bottom-anchored recent list
  stayed inside the window. The current long profile name and the last of 34
  property options remained reachable; Escape restored their trigger focus.
- Final native 1100×720: the 29-folder move submenu reached its last long option
  with End. In immersive mode, folder search retained its input and truncated
  the long matching folder name within the popup.
- Isolated in-app browser at 480×360, 768×600 and 1100×720: final multiselect
  popup stayed within the viewport and kept text focus. Typing AI left the note
  body empty; Down/Up moved between the input and suggestion; Enter added the
  property chip; Escape closed suggestions without moving to the body.
- `bun run build`, 667 passing Bun tests (3 existing skips), Garden sync and
  healthy Garden doctor. The schema tests cover all five Rust property types,
  existing browser fixtures and absence of a schema.
- Locked Rust CLI release build with Rust 1.98.1; unsigned native candidate
  build with the final UI and an executable 0.19.2 sidecar.

Native screenshots and browser evidence are saved locally under
`/Users/garden/Documents/Codex/oximemo-ui-2026-10-14/`.

## Scope and evidence

The final native pass resumed after the owner unlocked the Mac. Each configured
window size ran a separate production-built Tauri WebView with an isolated
fixture copy. The three `OxiMemo Menu Review` apps, configuration and private
vault copies are in `target/native-popovers-20261014/` in the primary checkout.
Window zoom used the native accessibility action and screenshots confirmed the
actual dimensions. Test input and property additions used these fixture copies.

Configured-provider model menus and image context menus were not exercised by
this fixture pass. This audit covers the observed defects and exercised controls,
not a claim that every app surface is free of bugs. Public artifact signing,
notarization, checksums and installation are separate release verification gates.
