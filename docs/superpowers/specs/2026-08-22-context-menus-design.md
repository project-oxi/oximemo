# Context Menus + Drag-and-Drop Completion — Design

**Date**: 2026-08-22 · **Status**: approved for implementation (user delegated decisions; autonomous run)

## Goal

1. Block the WKWebView's native right-click menu everywhere in the app
   (main + capture windows). Every place where a right-click SHOULD do
   something gets a designed Base UI context menu instead; everywhere
   else, right-click is a no-op.
2. Complete drag-and-drop coverage: audit what exists (most of it does),
   close the gaps, keep every flow working under the new menu block.

## Current state (audited)

Already shipped on `feat/command-palette`:

- `ContextMenu.tsx` — styled Base UI wrappers (`CtxRoot/Trigger/Menu/Item/
  Separator/Submenu`), z-70 above Dialog.
- `NoteCtxMenu` — shared by grid Card, ListView row, Timeline row:
  favorite, move-to-folder submenu, copy body, copy id, delete.
- `FolderMenu` — shared by FolderTile + ListView folder row: open,
  rename, pin/unpin, armed two-click delete.
- Sidebar pinned rows: thin menu (open, unpin) on the ⋯ button.
- DnD (T14/M16): note drags from Card + ListView row; folder drags from
  FolderTile / FolderChipBar chip / ListView folder row; drop targets on
  sidebar pins, breadcrumb crumbs, folder chips, folder tiles, list
  folder rows — with cycle/ancestor no-op suppression. CM6 already
  accepts image file drops/pastes.

## Decisions

### D1 — Global native-menu block

`main.tsx` (shared by main + capture routes) installs ONE capture-phase
`contextmenu` listener that calls `preventDefault()`. Base UI menus are
unaffected (they open their own popups and prevent default themselves).
Dev escape hatch: Alt+right-click keeps the native menu in dev builds
(`import.meta.env.DEV`) for WebKit debugging. No Tauri-side config
exists for the macOS WKWebView menu, so JS blocking is the mechanism.

### D2 — TextCtxMenu (new component)

One menu for every editable surface: **잘라내기 / 복사 / 붙여넣기 /
모두 선택**. Wraps an existing element via `CtxTrigger render=...`
(same pattern as FolderMenu) so no layout wrappers.

- **Cut / Copy / Select All** — `document.execCommand` against the
  focused editable (menu click is user activation; selection survives
  right-click in WKWebView).
- **Paste** — reads the clipboard text via the new
  `tauri-plugin-clipboard-manager` (`readText`), then inserts:
  - CM6 editors: dispatch a synthetic `ClipboardEvent("paste")` with a
    `DataTransfer` on `view.contentDOM` — the EXISTING CM6/cmp paste
    handlers (including `cm6Images`) do the insert. No editor-internal
    API needed.
  - `<textarea>`/`<input>`: `setRangeText` + dispatch `input` (React
    `onChange` fires).
- Wraps: MarkdownEditor, HtmlEditor (CM6 html source), CardGrid search
  input, FolderCombobox filter input, QuickCaptureForm textarea,
  FolderTile/ListView rename inputs. Settings inputs are NOT wrapped
  (rarely right-clicked; keyboard shortcuts unaffected) — documented
  exception.
- Browser fallback: `navigator.clipboard.readText()` (no plugin).

New dependency: `tauri-plugin-clipboard-manager` (Rust) +
`@tauri-apps/plugin-clipboard-manager` (JS), capabilities
`clipboard-manager:allow-read-text`. macOS needs no
extra entitlement for pasteboard reads.

### D3 — New small menus

| Surface | Items |
|---|---|
| Gallery thumbnail | 노트 열기 (opens referencing memo; orphan → disabled) · 크게 보기 (lightbox) |
| Sidebar tag chip | 이 태그만 (include) · 이 태그 제외 (exclude) · 필터 끄기 (off) · — · 필터 모두 지우기 |
| LinksCard backlink entry | 노트 열기 · `[[위키링크]] 복사` |

Wiki-link copy writes `[[title]]` (the app's link resolution key —
see `lib/memoLinks.ts`).

### D4 — Explicitly out of scope (documented, not built)

- Sidebar pin row rename/delete (management lives on tiles/list rows;
  would need folderChildren data + naming session in the sidebar).
- Calendar day cells, GraphView canvas nodes (hit-testing cost vs.
  value; left-click already navigates).
- Editor inline-image context menu (resize handles exist via Alt+drag).
- Tag rename, multi-select drag, pin reordering (no backend ordering
  API), external `.md` file drop-to-note, gallery→editor image drag.

### D5 — DnD completion

Existing flows stay as-is. Additions:

1. **TimelineView rows become drag sources** (`application/x-oximemo-notes`,
   same as Card/ListView) — grid/list/timeline parity.
2. **Sidebar Locations rows become drop targets**: the 볼트 root row
   (`useFolderDrop("")` → move note to root / move folder tree to root)
   and the daily row (move into the daily folder). Same visual language
   (`dropCls`) as pins.

Paste is TEXT-only by design: native ⌘V already carries images through
the trusted-event path (`cm6Images`); a menu-driven image paste would
need plugin image decoding → `File` re-encoding for no new capability.

## Verification plan

- `tsc -b` + `vite build`.
- Browser smoke (vite on :5199):
  - right-click on empty space / card / editor → NO native menu, custom
    menu where expected (`contextmenu` default prevented — assert via
    listener probe);
  - TextCtxMenu on the search input: select all + copy work, paste
    inserts at caret (browser path);
  - gallery/tag/backlink menus open with the right items;
  - timeline row drag → drop on sidebar pin moves the note;
  - drag note onto 볼트 row moves it to root.
- Rust: `cargo check` for the plugin addition.

## Risks

- Synthetic `ClipboardEvent` clipboardData: supported in WebKit +
  Chromium; if a future engine ignores it, CM6 paste falls back to
  nothing (menu item still succeeds silently) — acceptable, keyboard
  ⌘V unaffected.
- `execCommand` is deprecated but remains the only scriptable path in
  WKWebView for cut/copy/selectAll; menu-only usage keeps blast radius
  small.
