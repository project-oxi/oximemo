# Context Menus + DnD Completion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Block the WKWebView native context menu app-wide and ship designed Base UI context menus for every surface that needs one, then complete drag-and-drop coverage (timeline drag sources, sidebar Locations drop targets).

**Architecture:** One global capture-phase `contextmenu` blocker in `main.tsx`; a reusable `TextCtxMenu` component (Base UI `Ctx*` wrappers) for all editable surfaces with clipboard reads via the new `tauri-plugin-clipboard-manager`; small menus for gallery thumbs, sidebar tag chips, and backlinks; `useFolderDrop` reuse for the new drop targets.

**Tech Stack:** React 19 + Base UI ContextMenu, CodeMirror 6 (`@atomic-editor/editor`, `@codemirror/view`), Tauri v2 plugins, TanStack Query.

## Global Constraints

- Repo: `/Volumes/MERCURY/PROJECTS/oximemo`; frontend `apps/desktop`, Rust `apps/desktop/src-tauri`.
- No JS unit-test runner exists — verification per task is `npx tsc -b` (from `apps/desktop`), `cargo check` (from `apps/desktop/src-tauri`) for Rust touches, and browser smoke on `vite --port 5199` (localStorage fallback store keys `oximemo:memos:v3`, `oximemo:folders:v1`, `oximemo:folderpins:v1`).
- Z-index: ContextMenu Positioner is `z-[70]` (above Dialog z-50 / Popover z-60) — already handled inside `ContextMenu.tsx`; never restyle.
- i18n: add keys to BOTH `apps/desktop/src/lib/locales/ko.ts` and `en.ts`. Korean copy is the source of truth; English mirrors.
- Commits: conventional (`feat(desktop):`, `fix(desktop):`), English bodies. Update `CHANGELOG.md` under `[Unreleased]` in the final task.
- Tauri IPC arg binding: JS camelCase keys only for multi-word params.
- Branch: work on current `feat/command-palette`.

---

### Task 1: Clipboard plugin wiring

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml` (deps block, after `tauri-plugin-process = "2"`)
- Modify: `apps/desktop/src-tauri/src/lib.rs:54` (plugin chain)
- Modify: `apps/desktop/src-tauri/capabilities/default.json` (permissions array)
- Modify: `apps/desktop/package.json` (dependencies)
- Create: `apps/desktop/src/lib/clipboard.ts`

**Interfaces:**
- Produces: `clipboardReadText(): Promise<string>` — Tauri: plugin `readText()`; browser-dev: `navigator.clipboard.readText()`.

- [ ] **Step 1: Add the Rust dependency**

In `Cargo.toml` `[dependencies]`, after the `tauri-plugin-process = "2"` line:

```toml
tauri-plugin-clipboard-manager = "2"
```

- [ ] **Step 2: Register the plugin**

`apps/desktop/src-tauri/src/lib.rs`, after line 54 (`.plugin(tauri_plugin_process::init())`):

```rust
        .plugin(tauri_plugin_clipboard_manager::init())
```

- [ ] **Step 3: Grant the capability**

`capabilities/default.json` permissions array — append after `"process:default"`:

```json
    "clipboard-manager:allow-read-text"
```

- [ ] **Step 4: Add the JS dependency**

```bash
cd apps/desktop && bun add @tauri-apps/plugin-clipboard-manager
```

- [ ] **Step 5: Create `src/lib/clipboard.ts`**

```ts
/**
 * Clipboard read for the text context menu (spec 2026-08-22 D2).
 * Tauri: official clipboard-manager plugin (WKWebView has no scriptable
 * paste). Browser-dev: async clipboard API. Text only — images keep the
 * native ⌘V trusted-event path (cm6Images).
 */
import { readText } from "@tauri-apps/plugin-clipboard-manager";

const inTauri = "__TAURI_INTERNALS__" in window;

export function clipboardReadText(): Promise<string> {
  if (inTauri) return readText();
  return navigator.clipboard.readText();
}
```

- [ ] **Step 6: Verify + commit**

```bash
cd apps/desktop/src-tauri && cargo check 2>&1 | tail -3
cd .. && npx tsc -b && echo TSC_OK
git add -A && git commit -m "feat(desktop): wire clipboard-manager plugin for menu paste"
```

---

### Task 2: Global native-menu block

**Files:**
- Modify: `apps/desktop/src/main.tsx` (after the `isRouteCapture()` block, before `createRoot`)

- [ ] **Step 1: Install the blocker**

```tsx
// Block the WKWebView's native context menu app-wide (main + capture
// windows — both routes share this entry). Surfaces that need a
// right-click affordance ship their own Base UI menu; everywhere else
// right-click is intentionally a no-op. Capture phase so nothing can
// stopPropagation past it. Dev escape hatch: Alt+right-click keeps the
// native menu for WebKit debugging.
window.addEventListener(
  "contextmenu",
  (e) => {
    if (import.meta.env.DEV && e.altKey) return;
    e.preventDefault();
  },
  { capture: true },
);
```

- [ ] **Step 2: Verify + commit**

```bash
cd apps/desktop && npx tsc -b && echo TSC_OK
git add -A && git commit -m "feat(desktop): block the native webview context menu app-wide"
```

---

### Task 3: TextCtxMenu component + i18n

**Files:**
- Create: `apps/desktop/src/components/TextCtxMenu.tsx`
- Modify: `apps/desktop/src/lib/locales/ko.ts`, `en.ts`

**Interfaces:**
- Consumes: `CtxRoot/CtxTrigger/CtxMenu/CtxItem/CtxSeparator` from `./ContextMenu`, `clipboardReadText` from `../lib/clipboard`.
- Produces:

```ts
export function TextCtxMenu(props: {
  /** The editable's own element (input/textarea/editor host div).
   *  Props are cloned so our pointer capture composes with yours. */
  render: React.ReactElement<Record<string, unknown>>;
  children: React.ReactNode;
  /** CM6 host: paste dispatches a synthetic ClipboardEvent on the
   *  .cm-content so the editor's own paste pipeline inserts. */
  cm6?: boolean;
}): JSX.Element
```

- [ ] **Step 1: i18n keys**

`ko.ts` (alphabetical area near other `menu_*`/action keys is fine — exact placement free):

```ts
  text_cut: "잘라내기",
  text_copy: "복사",
  text_paste: "붙여넣기",
  text_select_all: "모두 선택",
```

`en.ts`:

```ts
  text_cut: "Cut",
  text_copy: "Copy",
  text_paste: "Paste",
  text_select_all: "Select All",
```

- [ ] **Step 2: Create the component**

```tsx
/**
 * TextCtxMenu — the shared edit menu (cut/copy/paste/select-all) for
 * every editable surface (spec 2026-08-22 D2). The native webview menu
 * is blocked globally, so editables ship this instead.
 *
 * The trigger merges onto the editable's own element (no wrapper div).
 * Which editable was right-clicked is captured on pointerdown(button 2)
 * — right-click does not move focus, and the menu popup may, so the
 * target must be grabbed before the menu opens.
 */
import { cloneElement, useRef, type ReactElement, type ReactNode } from "react";
import { Scissors, Copy, ClipboardPaste, TextSelect } from "lucide-react";

import { useI18n } from "../lib/i18n";
import { clipboardReadText } from "../lib/clipboard";

import { CtxRoot, CtxTrigger, CtxMenu, CtxItem, CtxSeparator } from "./ContextMenu";

type AnyEditable = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

export function TextCtxMenu({
  render,
  children,
  cm6 = false,
}: {
  render: ReactElement<Record<string, unknown>>;
  children: ReactNode;
  cm6?: boolean;
}) {
  const { t } = useI18n();
  const targetRef = useRef<AnyEditable | null>(null);

  const grab = (e: { button: number; currentTarget: AnyEditable }) => {
    if (e.button === 2) targetRef.current = e.currentTarget;
  };

  const focusTarget = () => {
    const el = targetRef.current;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.focus();
    else (el as HTMLElement | null)?.querySelector<HTMLElement>(".cm-content")?.focus();
    return targetRef.current;
  };

  const paste = async () => {
    const el = targetRef.current;
    if (!el) return;
    let text: string;
    try {
      text = await clipboardReadText();
    } catch {
      return; // permission denied / empty — silent, ⌘V still works
    }
    const cm = cm6 ? (el as HTMLElement).querySelector<HTMLElement>(".cm-content") : null;
    if (cm) {
      // Reuse the editor's own paste pipeline (incl. cm6Images): CM6
      // reads clipboardData off the event, trusted or not.
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      cm.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
      );
      return;
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const s = el.selectionStart ?? el.value.length;
      const e2 = el.selectionEnd ?? s;
      el.setRangeText(text, s, e2, "end");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    // contenteditable fallback
    el.focus();
    document.execCommand("insertText", false, text);
  };

  const trigger = cloneElement(render, {
    onPointerDown: (e: React.PointerEvent<AnyEditable>) => {
      grab(e);
      (render.props as { onPointerDown?: (ev: React.PointerEvent) => void }).onPointerDown?.(e);
    },
  } as Record<string, unknown>);

  return (
    <CtxRoot>
      <CtxTrigger render={trigger}>
        {children}
        <CtxMenu>
          <CtxItem icon={Scissors} label={t.text_cut} onClick={() => { focusTarget(); document.execCommand("cut"); }} />
          <CtxItem icon={Copy} label={t.text_copy} onClick={() => { focusTarget(); document.execCommand("copy"); }} />
          <CtxItem icon={ClipboardPaste} label={t.text_paste} onClick={() => void paste()} />
          <CtxSeparator />
          <CtxItem icon={TextSelect} label={t.text_select_all} onClick={() => { focusTarget(); document.execCommand("selectAll"); }} />
        </CtxMenu>
      </CtxTrigger>
    </CtxRoot>
  );
}
```

- [ ] **Step 3: Verify + commit**

```bash
cd apps/desktop && npx tsc -b && echo TSC_OK
git add -A && git commit -m "feat(desktop): TextCtxMenu — shared cut/copy/paste/select-all menu"
```

---

### Task 4: Wrap the editable surfaces

**Files:**
- Modify: `apps/desktop/src/components/MarkdownEditor.tsx` (return JSX of `MarkdownEditor`, line ~100-149 — the root `<div ref={hostRef}...>`)
- Modify: `apps/desktop/src/components/HtmlEditor.tsx:74`
- Modify: `apps/desktop/src/components/CardGrid.tsx:886-898` (search input)
- Modify: `apps/desktop/src/components/FolderCombobox.tsx:85-91` (filter input)
- Modify: `apps/desktop/src/components/QuickCaptureForm.tsx` (body textarea — locate `bodyProps` usage)
- Modify: `apps/desktop/src/components/FolderTile.tsx` + `apps/desktop/src/components/views/ListView.tsx` (rename inputs — locate `naming` input)

**Interfaces:**
- Consumes: `TextCtxMenu` from Task 3. Pattern is identical everywhere: the existing element becomes the `render` prop; its children move inside.

- [ ] **Step 1: CM6 editors**

`HtmlEditor.tsx:74` — replace:

```tsx
  return <div ref={hostRef} key={documentId} className={className} data-html-editor />;
```

with:

```tsx
  return (
    <TextCtxMenu cm6 render={<div ref={hostRef} key={documentId} className={className} data-html-editor />} />
  );
```

`MarkdownEditor.tsx` — same shape on its root host div (the one holding `ref={hostRef}` / the CM6 mount). If the root div already has children (e.g. none — CM6 mounts into it), `render={<div .../>}` with no children is correct.

- [ ] **Step 2: Search input (CardGrid)**

Wrap the `<input .../>` (lines 886-897) — the surrounding `<div className="relative w-56">` keeps the search icon; inside it:

```tsx
<TextCtxMenu
  render={
    <input
      value={search}
      onChange={(e) => { setSearch(e.target.value); /* existing debounce body */ }}
      placeholder={t.search_placeholder}
      className="w-full rounded-[var(--input-radius)] bg-transparent py-1.5 pl-8 pr-3 text-sm placeholder:text-text-subtle shadow-[var(--input-shadow)] focus-visible:shadow-[var(--input-shadow-focus)] focus-visible:outline-none"
    />
  }
/>
```

(keep the existing `value`/`onChange`/ref wiring exactly as-is — only the element moves into `render`).

- [ ] **Step 3: FolderCombobox filter input**

Wrap the `<input autoFocus .../>` (lines 85-91) with `<TextCtxMenu render={...} />` the same way.

- [ ] **Step 4: QuickCaptureForm textarea**

Locate the body `<textarea {...bodyProps} ...>`; wrap with TextCtxMenu (`render={<textarea ... />}`, its existing children/none preserved).

- [ ] **Step 5: Rename inputs (FolderTile naming, ListView naming)**

Both render an inline `<input>` while `naming` is active. Wrap each with TextCtxMenu the same way. (These inputs commit on Enter/blur; paste via menu dispatches `input`, so React state stays in sync.)

- [ ] **Step 6: Verify + commit**

```bash
cd apps/desktop && npx tsc -b && echo TSC_OK && npx vite build 2>&1 | tail -1
git add -A && git commit -m "feat(desktop): text context menu on editors and inputs"
```

---

### Task 5: Gallery thumbnail menu

**Files:**
- Modify: `apps/desktop/src/components/GalleryView.tsx` (`Thumb` component, lines 23-46)
- Modify: `apps/desktop/src/lib/locales/ko.ts`, `en.ts`

- [ ] **Step 1: i18n keys**

ko: `gallery_open_note: "노트 열기"`, `gallery_view_large: "크게 보기"` /
en: `gallery_open_note: "Open Note"`, `gallery_view_large: "View Large"`

- [ ] **Step 2: Menu on the Thumb button**

`Thumb` gains an `onView` prop (GalleryView passes `() => setLightbox(asset)`). The existing `<button ...>` becomes the `render` element of a `CtxRoot/CtxTrigger` + `CtxMenu` pair (import from `./ContextMenu`), items:

```tsx
<CtxItem icon={FileText} label={t.gallery_open_note} onClick={() => onOpen(asset)} />
<CtxItem icon={Maximize2} label={t.gallery_view_large} onClick={() => onView(asset)} />
```

(`onOpen` already falls back to the lightbox for orphan assets — keep that.)

- [ ] **Step 3: Verify + commit**

```bash
cd apps/desktop && npx tsc -b && echo TSC_OK
git add -A && git commit -m "feat(desktop): gallery thumbnail context menu"
```

---

### Task 6: Sidebar tag chip menu

**Files:**
- Modify: `apps/desktop/src/components/Sidebar.tsx:280-300` (tag chip map)
- Modify: `apps/desktop/src/lib/locales/ko.ts`, `en.ts`

**Interfaces:**
- Consumes: existing `cycleTag(tag)`, `clearTagFilter`, `tagFilter` (`TagState = "in"|"off"|"out"`), and the store's direct tag-state setter (read the chip code: if only `cycleTag` exists, drive states via the same store action the sidebar already imports — `setTagState`/equivalent; if none is exported, add `setTagState(tag, state)` to `stores/ui.ts` mirroring `cycleTag`'s transition logic).
- Produces: none.

- [ ] **Step 1: i18n keys**

ko: `tag_menu_include: "이 태그만"`, `tag_menu_exclude: "이 태그 제외"`, `tag_menu_off: "필터 끄기"` /
en: `tag_menu_include: "Only This Tag"`, `tag_menu_exclude: "Exclude This Tag"`, `tag_menu_off: "Turn Off Filter"` (reuse existing `clear_filters` for the clear-all row).

- [ ] **Step 2: Wrap each chip**

The chip `<button>` (line 283) becomes a `CtxTrigger render`; menu items set the state DIRECTLY (not cycling): include → `setTagState(tag,"in")`, exclude → `setTagState(tag,"out")`, off → `setTagState(tag,"off")`, separator, `clear_filters` → `clearTagFilter()`. Every item also performs the chip's existing scope reset (`setView("memos"); setFavoritesOnly(false); setFolderFilter(null);`) — extract that snippet into a local `enterQueryMode()` helper and reuse it in both the chip onClick and the menu handlers. Active state shows via `CtxItem active={st === "in"}` etc.

- [ ] **Step 3: Verify + commit**

```bash
cd apps/desktop && npx tsc -b && echo TSC_OK
git add -A && git commit -m "feat(desktop): sidebar tag chip context menu"
```

---

### Task 7: Backlink entry menu

**Files:**
- Modify: `apps/desktop/src/components/LinksCard.tsx:30-45` (backlink buttons)
- Modify: `apps/desktop/src/lib/locales/ko.ts`, `en.ts`

- [ ] **Step 1: i18n keys**

ko: `link_open_note: "노트 열기"`, `link_copy_wikilink: "위키링크 복사"` /
en: `link_open_note: "Open Note"`, `link_copy_wikilink: "Copy Wiki Link"`

- [ ] **Step 2: Menu per backlink**

Each `<button onClick={() => onNavigate(bl.id)}>` becomes a `CtxTrigger render` element; items:

```tsx
<CtxItem icon={FileText} label={t.link_open_note} onClick={() => onNavigate(bl.id)} />
<CtxItem
  icon={Link2}
  label={t.link_copy_wikilink}
  onClick={() => void navigator.clipboard.writeText(`[[${bl.title}]]`)}
/>
```

Import `CtxRoot, CtxTrigger, CtxMenu, CtxItem` from `./ContextMenu`, `FileText, Link2` from `lucide-react`.

- [ ] **Step 3: Verify + commit**

```bash
cd apps/desktop && npx tsc -b && echo TSC_OK
git add -A && git commit -m "feat(desktop): backlink entry context menu"
```

---

### Task 8: DnD completion

**Files:**
- Modify: `apps/desktop/src/components/views/TimelineView.tsx:92-95` (row trigger div)
- Modify: `apps/desktop/src/components/Sidebar.tsx:170-194` (볼트 row + daily row)

**Interfaces:**
- Consumes: `useFolderDrop(path, onDropNote, onDropFolder?)` from `../lib/dropTarget`; `useUI((s) => s.setDraggingNote)`; Sidebar props `onMoveNote(id, folder)` / `onMoveFolderTree(path, dest)` (already passed to `SidebarFolderRow`).

- [ ] **Step 1: Timeline rows become drag sources**

Top of `TimelineView`: `const setDraggingNote = useUI((s) => s.setDraggingNote);`. On the row trigger `render={<div .../>}` add:

```tsx
draggable
onDragStart={(e: React.DragEvent) => {
  setDraggingNote(n);
  e.dataTransfer.setData("application/x-oximemo-notes", JSON.stringify([n.id]));
  e.dataTransfer.effectAllowed = "move";
}}
onDragEnd={() => setDraggingNote(null)}
```

- [ ] **Step 2: Extract a LocationsRow drop-target component**

Hooks can't run inline in Sidebar's JSX map/conditionals. Add below `SidebarFolderRow`:

```tsx
/** One LOCATIONS row (볼트 root / daily): navigation button that is
 *  also a drop target — dropping a note moves it to this folder,
 *  dropping a folder subtree reparents it here (T14 semantics). */
function LocationsRow({
  path,
  selected,
  onClick,
  onMoveNote,
  onMoveFolderTree,
  icon,
  label,
}: {
  path: string;
  selected: boolean;
  onClick: () => void;
  onMoveNote: (id: string, folder: string) => void;
  onMoveFolderTree?: (p: string, dest: string) => void;
  icon: React.ReactNode;
  label: string;
}) {
  const { dropCls, ...dropProps } = useFolderDrop(
    path,
    (id) => onMoveNote(id, path),
    onMoveFolderTree ? (p) => onMoveFolderTree(p, path) : undefined,
  );
  return (
    <div {...dropProps} className={`mx-2 rounded-md ${dropCls ?? ""}`}>
      <button
        type="button"
        onClick={onClick}
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] ${
          selected
            ? "bg-surface-muted font-semibold text-text"
            : "text-text-muted hover:bg-surface-muted"
        }`}
      >
        {icon} <span className="truncate">{label}</span>
      </button>
    </div>
  );
}
```

Replace the 볼트 `<button>` (lines 170-180) with `<LocationsRow path="" selected={view === "memos" && !favoritesOnly && folderFilter === ""} onClick={() => { setView("memos"); setFavoritesOnly(false); setFolderFilter(""); }} onMoveNote={onMoveNote} onMoveFolderTree={onMoveFolderTree} icon={<Archive size={14} />} label={t.vault_root} />` and the daily `<button>` (lines 182-194) analogously with `path={dailyFolder}` and `<CalendarDays size={14} />` + `dailyFolder` label. Keep the outer `{dailyEnabled && dailyFolder && ...}` condition.

- [ ] **Step 3: Verify + commit**

```bash
cd apps/desktop && npx tsc -b && echo TSC_OK && npx vite build 2>&1 | tail -1
git add -A && git commit -m "feat(desktop): timeline drag sources + Locations drop targets"
```

---

### Task 9: End-to-end browser smoke + changelog

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Smoke matrix (vite :5199, browser tool)**

Seed `oximemo:memos:v3` (2 root + 1 in `작업` + 1 daily) and `oximemo:folders:v1` = `["작업","daily"]`. Verify:
  1. `contextmenu` on empty main area → `defaultPrevented === true` (dispatch a synthetic event via `tab.evaluate`).
  2. Right-click a note card → NoteCtxMenu (favorite/move/copy/delete).
  3. Right-click search input → text menu; Select All + Copy fill the clipboard; Paste inserts at caret (browser `navigator.clipboard` path).
  4. Right-click a gallery thumb → 노트 열기/크게 보기.
  5. Right-click a sidebar tag chip → 이 태그만/제외/끄기/모두 지우기; "이 태그만" filters the grid.
  6. (Desktop-only: backlink menu — browser fallback lacks `get_backlinks`; verify wiring compiles + menu markup via a stubbed query cache entry if cheap, else document as desktop-verified-by-build.)
  7. Drag a timeline row onto a sidebar pin → note's `folder` changes in the store.
  8. Drag a grid card onto the 볼트 row → note's `path` moves to root.
  9. Drag a grid card onto the daily row → note's folder becomes `daily`.

- [ ] **Step 2: CHANGELOG under `[Unreleased]`**

One entry describing: native menu blocked app-wide; text edit menu on all editors/inputs (clipboard-manager plugin); gallery/tag/backlink menus; timeline drag; Locations drop targets.

- [ ] **Step 3: Final commit**

```bash
git add -A && git commit -m "docs: changelog for context menus + DnD completion"
```
