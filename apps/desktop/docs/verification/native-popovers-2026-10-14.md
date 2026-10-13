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
| 480×360 filter builder | Its 480px panel extended beyond the window edge. The candidate adds available-space bounds and wrapping actions; its post-fix native check is pending. |
| Native knowledge property editors | Serialized Rust `type` fields were read as `prop_type`, producing text editors for select/list/date properties. Boundary normalization restores the typed controls. |
| Native multiselect autocomplete | Opening suggestions moved focus out of the input; subsequent typing reached the note body. The final fix retains input focus, anchors directly to the input and supports direction-key navigation. |

## Completed verification

- Native 480×360 audit: note context menu, long folder move submenu, breadcrumb,
  folder search, note format menu, property add, backlink, calendar overflow,
  calendar date field, schema filter and property select popovers.
- Native 480×360 ↔ 1868×1050: zoomed and restored the window with a submenu
  open; it stayed bounded and retained its focused last option.
- Native schema filter and property select: Tab reached the last of 34 options
  including a long label; Escape restored the trigger focus.
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

## Pending native checks

The Mac locked during the final native pass. Final multiselect focus and filter
builder checks in the native WebView, native 768×600/1100×720 checks, and the installed application update
remain pending until the owner unlocks the Mac. Browser checks are supplemental
and do not substitute for these native checks. The final isolated 480×360
candidate is `OxiMemo Menu Review 480.app`; its configuration and private vault
copy are in `target/native-popovers-20261014/` in the primary checkout.

No new tag, public release or installed app replacement has been performed.
The installation remains 0.19.1. Configured-provider model menus and image
context menus were not exercised by this fixture pass.
