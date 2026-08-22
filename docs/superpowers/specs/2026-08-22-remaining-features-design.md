# Remaining Features — Sidebar Management, Tag Rename, Import, Editor/Graph Menus

**Date**: 2026-08-22 · **Status**: design approved (scope C: ①~⑥)
**Predecessor**: `2026-08-22-context-menus-design.md` (its D4 out-of-scope list)

## Scope

| # | Feature | Decision |
|---|---|---|
| ① | Sidebar pin row management (rename/delete) | inline rename session + armed delete |
| ② | Pin reordering | dedicated drag handle (not modifier key) |
| ③ | Tag rename (vault-wide) | body rewrite via new core command; merges on collision |
| ④ | External file drop → note | copy semantics (.md/.markdown/.txt) |
| ⑤ | Editor inline-image menu | CM6 CustomEvent bridge → PointMenu |
| ⑥ | Graph node menu | per-node Base UI menu (SVG nodes are React elements — no hit-testing needed) |

Out of scope: calendar day menu (left-click covers), gallery→editor drag (dialog occlusion), multi-select (separate project).

## ① Sidebar pin row management

`SidebarFolderRow` menu becomes: 열기 / 이름 바꾸기 / 고정 해제 / 삭제…(armed
two-click, FolderMenu rules). The row itself becomes the context trigger
(today only the ⋯ button is).

- **Rename**: label swaps to an inline `<input>` (TextCtxMenu-wrapped),
  Enter commits → `renameFolder(path, name)` → invalidate
  memos/folders/config. Escape cancels. Naming session state
  (`{path, isNew:false} | null`) lives in `Sidebar`, threaded to rows —
  same `NamingSession` type as FolderTile.
- **Delete**: `folderChildren(path)` query (menu-open-gated, cached)
  supplies the recursive note count for the confirm wording;
  commit → `deleteFolder(path)` (existing IPC, trashes notes;
  `memos:changed` already fires).

## ② Pin reordering

Row drag already means "move into folder" — reorder gets a dedicated
**⠿ handle** (visible on hover, `draggable`), payload type
`application/x-oximemo-pin` carrying the pin path.

- Drop on another pin: top half of the row = insert BEFORE, bottom half
  = AFTER (clientY vs midpoint).
- Backend `set_pin_order(order: Vec<String>)`: reorder pinned entries of
  `cfg.folders.items` into `order`, preserving unpinned entries'
  relative order (TOML Vec order is the persistence — verified).
  Emits `config:changed`; frontend invalidates `["config"]`.
- Browser fallback: rewrite `oximemo:folderpins:v1` array order.
- Guards: dropping onto itself, or an order array that isn't a
  permutation of current pins → no-op/error.

## ③ Tag rename (vault-wide)

Core `rename_tag(old: String, new: String) -> Result<u64>`:

- Scan live memos; rewrite `#old` → `#new` in bodies using the SAME
  token model as `crates/oximemo-core/src/tags.rs` (`#` not preceded by
  `[\p{L}\p{N}_]`, token = run of word chars; boundary check after the
  match). Write changed files, update index, emit `memos:changed`.
- `old == new` (case-insensitive, NFC — tags normalize) → 0.
- Empty/invalid `new` → error. Collision with an existing tag = merge
  (no prompt — tags are body-derived).
- Returns changed-note count.

UI: tag chip menu gains **태그 이름 바꾸기** → chip swaps to inline
input (seeded `#old` sans `#`) → commit → `renameTag` → invalidate
memos/facets → toast "N개 노트 업데이트".

## ④ External file drop → note import

`CardGrid`'s main scroll area gets file-drop handlers:

- `dragover`: active only when `dataTransfer.types` includes `"Files"`
  (note/folder payload drops keep their existing targets — types differ,
  no interference) → `preventDefault` + full-area ring.
- `drop`: for each file with extension `.md`/`.markdown`/`.txt`:
  `await file.text()` → `createMemo(body, folder = folderFilter when
  browsing else "")`. Titles follow the existing `create_memo`
  derivation. Toast "N개 노트 가져옴". **Copy semantics** — the source
  file is never modified or moved.

## ⑤ Editor inline-image menu

`cm6Images` `domEventHandlers` gains `contextmenu(e)`: when target is an
`img[data-ox-name]` (existing marker), `stopPropagation` (so the host
TextCtxMenu doesn't open) and dispatch
`window.dispatchEvent(new CustomEvent("oximemo:image-menu", { detail: {
name, x: e.clientX, y: e.clientY } }))`. `MarkdownEditor` listens and
renders **PointMenu** at (x,y):

- **이미지 삭제** — remove the image's markdown line (regex by content
  hash in the oximg URL — `commitWidth` shows the pattern)
- **너비 초기화** — strip the `#w=` hint (existing `widthOfUrl`/
  `commitWidth` helpers)
- **URL 복사** — `navigator.clipboard.writeText(oximg URL)`

**PointMenu** (new `components/PointMenu.tsx`): fixed-position popup at
a viewport point, same `POPUP_CLS` visual vocabulary, closes on
outside-pointerdown/Escape/scroll, items = CtxItem props shape.

## ⑥ Graph node menu

Each SVG node `<g>` becomes a `CtxRoot/CtxTrigger render={<g …/>}` with
a menu: **노트 열기** (select) / **즐겨찾기 토글** (favorite state from
the `items` prop) / **삭제** (danger). Node click keeps its open
behavior. Menu must `stopPropagation` on item clicks (existing CtxMenu
popup already does).

## Verification

- `cargo test -p oximemo-core`: roundtrips for `set_pin_order`
  (permutation reorder + unpinned-order preservation) and `rename_tag`
  (boundary Korean tags, merge, no-op).
- `tsc -b` + `vite build`.
- Browser smoke: ① inline rename + delete confirm count; ② handle drag
  → pins order changes (store order in fallback); ③ tag rename rewrites
  bodies + facets refresh; ④ synthetic file drop creates notes in the
  current folder; ⑤⑥ build-verified (CM6/graph surfaces need desktop
  data paths where applicable).
