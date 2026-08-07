# MemoEditorForm Layout — Unified Flex-Slot Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the MemoDetail editor's body area expand/contract in lockstep with the dialog (no per-line growth), by unifying the layout under a single flex-slot strategy across immersive and non-immersive modes.

**Architecture:** The dialog popup owns the height budget (`h-[80vh]` / `h-[94vh]`). MemoEditorForm is always `flex-1 min-h-0`, the body wrapper is always `flex-1 min-h-0 overflow-y-auto`. The only mode difference is dialog size — a single source of truth.

**Tech Stack:** React 19, Tailwind CSS v4, Base UI Dialog, CodeMirror 6 (`@atomic-editor/editor`).

## Global Constraints

- Files outside the two listed below are not touched.
- No new dependencies.
- Comments and commits in English.
- Preserve existing keyboard shortcuts (`⌘.` to toggle immersive, `⌘⏎` to close, `⌘L` for category picker, `⌘I` for image picker).
- Keep the `Maximize2`/`Minimize2` toolbar button and its `aria-label`/`title` behavior intact.

## File Structure

| File | Responsibility |
|---|---|
| `apps/desktop/src/components/MemoDetail.tsx` | Owns `immersive` state, dialog size class, autofocus on immersive toggle, debounced autosave. Single source of layout intent for the popup. |
| `apps/desktop/src/components/MemoEditorForm.tsx` | Renders editor body + tag row + action bar. Always lays out as `flex flex-1 min-h-0 flex-col`, lets children use `flex-1` slots. No mode-specific layout. |

The dialog popup gets a fixed height (`h-[80vh]`/`h-[94vh]`). MemoEditorForm and its body wrap are pure flex consumers — they fill whatever their parent gives them.

## Context Captured From Investigation

- Reproduced the issue in browser via Vite dev server: dialog height grew from 474px (1 line) to 565px (11 lines), wrap from 349px to 440px. Each new line added ~10px until 55vh was hit.
- Confirmed `@atomic-editor/editor` wraps CM6 in `<div class="atomic-cm-editor">` with `height: 100%` (from `inline-preview.css`). The editor is a passive height consumer — parent must bound it.
- `MemoEditorForm` is used only by `MemoDetail`. `immersive` prop is passed only from `MemoDetail`.
- `immersive` mode already used `flex-1 min-h-0 overflow-y-auto` on the body wrap and worked correctly. The bug was the non-immersive fallback `max-h-[55vh] overflow-y-auto` — `max-h` without `h` lets the container shrink-fit content, defeating the cap when content < cap.

---

### Task 1: Bound the dialog popup to a fixed height

**Files:**
- Modify: `apps/desktop/src/components/MemoDetail.tsx:111-113`

**Interfaces:**
- Consumes: existing `immersive: boolean` state (line 42).
- Produces: a `popupSize` string used by `Dialog.Popup className` (line 133).

- [ ] **Step 1: Edit `popupSize` to use `h-[…]` instead of `max-h-[…]`**

Replace lines 111-113:

```tsx
const popupSize = immersive
  ? "h-[94vh] w-[min(900px,96vw)] p-6"
  : "h-[80vh] w-[min(640px,92vw)] p-5";
```

Rationale: dialog now owns the height budget. No more silent growth when children grow. `h-[…]` (not `max-h-`) gives the flex children an exact slot to fill.

- [ ] **Step 2: Verify in browser that dialog height stays constant across line additions**

Run the dev server (already running at `http://localhost:5173`), open the memo detail dialog, type lines, confirm `Dialog.Popup` `offsetHeight` does not change. Expected: same value (640px at viewport 800px) regardless of line count. Wrap may still grow — that's fine, next task fixes it.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/components/MemoDetail.tsx
git commit -m "refactor(memo-detail): bound popup height with h-[vh] instead of max-h-[vh]"
```

---

### Task 2: Strip mode branching from MemoEditorForm layout

**Files:**
- Modify: `apps/desktop/src/components/MemoEditorForm.tsx`

Two coordinated edits:
- root `<div>` (line 102): always include `flex-1 min-h-0`.
- body wrap className (line 109): always `flex-1 min-h-0 overflow-y-auto`.

**Interfaces:**
- Consumes: dialog popup now gives exact height; parent passes through.
- Produces: an editor form that uniformly fills its parent slot.

- [ ] **Step 1: Update the root className**

Replace line 102:

```tsx
<div className={cx("flex flex-1 min-h-0 flex-col gap-2.5", className)}>
```

(The `immersive && "flex-1 min-h-0"` part becomes unconditional.)

- [ ] **Step 2: Update the body wrap className**

Replace line 109:

```tsx
className="flex-1 min-h-0 overflow-y-auto"
```

(No `immersive ? … : …` ternary.)

- [ ] **Step 3: Verify in browser that wrap and dialog heights are stable**

Type 50 lines into the editor. Confirm:
- `Dialog.Popup` `offsetHeight` constant (640px at 800vh).
- `MarkdownEditor` wrap `offsetHeight` constant — fills dialog minus header + tag row + action bar (≈440-470px depending on padding).
- `cm-content` `scrollHeight` grows as expected, scrollbar appears inside the wrap.

- [ ] **Step 4: Verify immersive toggle still works**

Click the maximize/minimize button (or `⌘.`). Dialog height jumps 80vh ↔ 94vh. Wrap height adjusts accordingly (because `flex-1` distributes whatever slot dialog gives). Editor remains focused (autofocus effect on line 88-91 unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/MemoEditorForm.tsx
git commit -m "refactor(memo-editor-form): unify layout under flex-1 min-h-0 across modes"
```

---

### Task 3: Drop immersive *layout* branches; keep the prop for autofocus UX

After Task 2, `immersive` no longer affects any layout branch inside `MemoEditorForm`. The prop itself stays — it's still the dependency of the autofocus useEffect that returns focus to the editor after the toolbar button is clicked to toggle the mode:

```tsx
useEffect(() => {
  const id = requestAnimationFrame(() => editorHandleRef.current?.focus());
  return () => cancelAnimationFrame(id);
}, [immersive]);
```

Removing the prop would strand focus on the toolbar button — a UX regression.

**Files:**
- Modify: `apps/desktop/src/components/MemoEditorForm.tsx:102, 109`

No further code changes — Task 2 already removed the two layout branches. This task is just the conscious decision to keep the prop.

**No commit** — Task 2's commit (`refactor(memo-editor-form): unify layout under flex-1 min-h-0 across modes`) already covers this. The change at this point is documentation-only.

---

### Task 4: Verify edge cases

**Files:** none (verification only).

- [ ] **Step 1: Verify on a fresh memo (empty body)**

Open a new memo. Confirm dialog = 80vh, body wrap = dialog minus header+tags+actions (≈440px on 800vh viewport), with a tall blank scrollable area. Typing the first character should not grow anything.

- [ ] **Step 2: Verify with a long single line that wraps**

Type a single 200-character line. Confirm body wrap scrolls horizontally inside, no vertical growth, dialog constant.

- [ ] **Step 3: Verify image insertion doesn't break the layout**

`⌘I`, insert an image. Confirm image renders inside the wrap, wrap and dialog stay constant, vertical scroll remains inside the wrap.

- [ ] **Step 4: Final visual check**

Take screenshots of:
- Empty memo, non-immersive (80vh dialog, mostly empty body wrap).
- Empty memo, immersive (94vh dialog, taller body wrap).
- 50-line memo, non-immersive (scrolled to bottom inside wrap).

Store under `apps/desktop/src/components/__screenshots__/` or attach to the PR.

No commit unless changes were needed.

---

## Self-Review Checklist

- [ ] Spec coverage: Each named constraint (height bound, flex-1 unification, immersive still works, no behavior regressions) maps to a task.
- [ ] Placeholder scan: No "TODO", "TBD", "implement later" — all code shown.
- [ ] Type consistency: no prop renames — `immersive` remains in `MemoEditorFormProps` for autofocus (Task 3).
- [ ] Tests: no automated tests added — visual/behavioral verification only (UI change, existing test suite unaffected).
- [ ] Behavior preserved: autofocus on mount and on immersive toggle (lines 82-91 of MemoEditorForm) is untouched.
- [ ] Layout correctness: dialog bounded by `h-[vh]` (Task 1), children use `flex-1 min-h-0` (Task 2), immersive layout branches removed but prop kept for autofocus (Task 3).
