# NoteDetail 카테고리 피커 — 키보드 중심 + 클리핑 수정 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** NoteDetail 편집 중 카테고리 선택을 (1) 잘림 없이 위로 열리고 (2) `⌘L` 한 번으로 순수 키보드 호출 가능하게 만든다(한글 IME 환경 포함).

**Architecture:** `CategoryCombobox`의 손수 만든 절대위치 패널을 Base UI `Popover`(Portal + collision flip)로 교체해 Dialog `overflow-hidden`을 벗어난다. 동일 메뉴를 칩 클릭과 `⌘L`이 모두 여닫도록, 피커에 imperative `open()` + `onClose` 콜백을 추가하고 `NoteDetail`의 기존 `⌘⏎` 핸들러 옆에 `⌘L` 분기를 둔다. 메뉴가 닫힐 때 편집기로 포커스 복귀.

**Tech Stack:** React 19, `@base-ui-components/react@1.0.0-rc.0` (Popover), `@atomic-editor/editor` (CodeMirror 6), TypeScript, Tailwind v4.

## Global Constraints

- **테스트 러너 없음:** 본 프로젝트는 vitest/jest 미사용. 각 태스크 종료 검증은 `cd apps/desktop && bun run build`(`tsc -b && vite build`, 타입체크+빌드) + spec §7 수동 스모크. 단위 테스트 작성 금지(러너 부재).
- **Base UI Popover API:** `Popover.Root`(controlled: `open`/`onOpenChange`) → `Popover.Trigger` → `Popover.Portal` → `Popover.Positioner`(`side`/`align`/`sideOffset`) → `Popover.Popup`. 사용례: `SettingsMenu.tsx:350-401`. z-index는 Dialog(z-50) 위 `z-[60]`.
- **`⌘L`(`Mod-l`)은 CM6 4개 키맵에서 미바인딩 확인됨.** `⌘/`는 `defaultKeymap`의 `toggleComment`에 충돌 → 사용 금지.
- **forwardRef/useImperativeHandle:** 코드베이스에 전례 없으나 표준 React 패턴. 첫 도입.
- **i18n:** 평면 딕셔너리(`locales/ko.ts`·`en.ts`). 새 키는 양쪽 모두 추가.
- **CategoryCombobox는 i18n-free 유지:** 문자열은 prop으로 주입.

## File Structure

신규 파일 없음. 수정 6개:

- `apps/desktop/src/components/MarkdownEditor.tsx` — 편집기 핸들을 상위로 노출(`editorHandleRef` prop).
- `apps/desktop/src/components/CategoryCombobox.tsx` — Popover화 + imperative `open()`/`onClose`/`triggerAriaLabel` + `⌘L` 힌트. (가장 큰 변경)
- `apps/desktop/src/components/NoteEditorForm.tsx` — 피커 ref·편집기 ref 스레딩, `onClose`→편집기 포커스.
- `apps/desktop/src/components/NoteDetail.tsx` — `⌘L` keydown 분기.
- `apps/desktop/src/lib/locales/ko.ts` · `en.ts` — `set_category` 키 추가.

---

### Task 1: MarkdownEditor — 편집기 핸들 노출

**Files:**
- Modify: `apps/desktop/src/components/MarkdownEditor.tsx`

**Interfaces:**
- Produces: `MarkdownEditor`가 optional `editorHandleRef?: MutableRefObject<AtomicCodeMirrorEditorHandle | null>` prop 수용. 미제공 시 내부 fallback ref 사용(기존 동작 보존). 상위에서 `editorHandleRef.current?.focus()` 호출 가능.

- [ ] **Step 1: `editorHandleRef` prop 추가 + fallback**

`apps/desktop/src/components/MarkdownEditor.tsx` 전체를 아래로 교체:

```tsx
/**
 * React wrapper around `@atomic-editor/editor` (§4.1).
 *
 * The wrapper:
 *  - forces a `documentId` prop so swapping notes remounts the CM6 view
 *    (undo/cursor state from the previous note never leaks into the next)
 *  - forwards link clicks to the optional handler, falling back to a plain
 *    `window.open` so external links work in both browser-dev and Tauri.
 *  - optionally exposes the editor's imperative handle upward so a parent
 *    can call `focus()` (e.g. to return focus after a category pick).
 *
 * Read-only mode, code-language highlighting, and wiki-links are
 * intentionally NOT exposed — they're deferred to v2 to keep the wrapper
 * small and the bundle slim. Per spec §2, this is a deliberate scope cut.
 */
import { useRef, type MutableRefObject } from "react";
import {
  AtomicCodeMirrorEditor,
  type AtomicCodeMirrorEditorHandle,
} from "@atomic-editor/editor";
import "@atomic-editor/editor/styles.css";

interface Props {
  body: string;
  onChange: (v: string) => void;
  /** Note identity — change it to swap documents (forces remount). */
  documentId: string;
  className?: string;
  onLinkClick?: (url: string) => void;
  /** Optional external ref to the editor's imperative handle. When
   *  omitted, an internal fallback is used (preserves prior behavior). */
  editorHandleRef?: MutableRefObject<AtomicCodeMirrorEditorHandle | null>;
}

function defaultOpenLink(url: string): void {
  try {
    window.open(url, "_blank", "noopener,noreferrer");
  } catch {
    // window.open can throw in sandboxed contexts; nothing we can do.
  }
}

export function MarkdownEditor({
  body,
  onChange,
  documentId,
  className,
  onLinkClick,
  editorHandleRef,
}: Props) {
  const fallback = useRef<AtomicCodeMirrorEditorHandle | null>(null);
  const handleRef = editorHandleRef ?? fallback;
  return (
    <div className={className}>
      <AtomicCodeMirrorEditor
        documentId={documentId}
        markdownSource={body}
        onMarkdownChange={onChange}
        editorHandleRef={handleRef}
        onLinkClick={onLinkClick ?? defaultOpenLink}
      />
    </div>
  );
}
```

- [ ] **Step 2: 타입체크+빌드**

Run: `cd apps/desktop && bun run build`
Expected: PASS (tsc + vite build 성공; 동작 변화 없음 — ref만 외부 노출).

- [ ] **Step 3: 커밋**

```bash
git add apps/desktop/src/components/MarkdownEditor.tsx
git commit -m "refactor(desktop): expose MarkdownEditor handle via optional ref prop"
```

---

### Task 2: CategoryCombobox — Base UI Popover + imperative open

**Files:**
- Modify: `apps/desktop/src/components/CategoryCombobox.tsx` (전면 재작성)

**Interfaces:**
- Consumes: 없음(독립).
- Produces:
  - `CategoryComboboxHandle { open(): void }` — `useImperativeHandle`으로 노출. `⌘L`이 호출.
  - prop `onClose?: () => void` — 메뉴가 닫힐 때(선택·Esc·외부클릭) 1회 호출.
  - prop `triggerAriaLabel?: string` — 칩의 `aria-label`/`title`(i18n 주입용).
- 컴포넌트를 `forwardRef<CategoryComboboxHandle, CategoryComboboxProps>`로 변환.

**설계 메모(onClose 단일 발화):** Base UI Popover는 Esc·외부클릭·트리거 재클릭 시 `onOpenChange(false)`를 호출 → 래퍼에서 `closeWithNotify()` 1회. Enter-선택(프로그래밍)은 `onOpenChange`를 타지 않으므로 `activate()`에서 명시적으로 `closeWithNotify()`. 입력 `onKeyDown`은 ↑/↓/Enter만 처리(Esc는 Base UI에 위임 → 이중 발화 방지).

- [ ] **Step 1: 컴포넌트 전면 재작성**

`apps/desktop/src/components/CategoryCombobox.tsx` 전체를 아래로 교체:

```tsx
/**
 * Keyboard-first category picker. Renders a trigger chip (color dot + id)
 * that opens a Base UI Popover containing a filter input and a scrollable
 * list of matching categories. When the typed query matches no existing
 * id, a "✨ Create '<typed>'" row appears at the bottom; activating it
 * calls `onCreate(query)`.
 *
 * The panel is rendered via Popover.Portal → it escapes the NoteDetail
 * Dialog.Popup's `overflow-hidden` (which previously clipped it) and
 * auto-flips to stay on screen. It opens upward (side="top") by default
 * because the chip lives at the dialog's bottom edge.
 *
 * The picker exposes an imperative `open()` (via ref) so a keyboard
 * shortcut (⌘L in NoteDetail) can open it without a mouse click, and an
 * `onClose` callback so the host can return focus to the editor.
 *
 * Keys (when panel is open):
 *   ↑ / ↓   move highlight
 *   Enter   activate highlighted row (select existing OR create new)
 *   Esc     close without changes  (handled by Base UI Popover)
 */
import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Popover } from "@base-ui-components/react";

import type { CategoryDef } from "../lib/types";

const cx = (...xs: (string | false | null | undefined)[]) =>
  xs.filter(Boolean).join(" ");

export interface CategoryComboboxHandle {
  /** Open the panel and focus the filter input. */
  open: () => void;
}

export interface CategoryComboboxProps {
  value: string;
  onValueChange: (id: string) => void;
  categories: CategoryDef[];
  /** Called when the user activates the inline "Create" row. */
  onCreate?: (id: string) => void;
  /** Fired exactly once when the panel closes (select / Esc / outside). */
  onClose?: () => void;
  /** Accessible label / tooltip for the trigger chip (i18n-injected). */
  triggerAriaLabel?: string;
  className?: string;
}

export const CategoryCombobox = forwardRef<
  CategoryComboboxHandle,
  CategoryComboboxProps
>(function CategoryCombobox(
  { value, onValueChange, categories, onCreate, onClose, triggerAriaLabel, className },
  ref,
) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listboxId = useId();

  const selected = categories.find((c) => c.id === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return categories;
    return categories.filter((c) => c.id.toLowerCase().includes(q));
  }, [categories, query]);

  const trimmed = query.trim();
  const showCreate =
    trimmed.length > 0 &&
    !categories.some((c) => c.id === trimmed) &&
    !!onCreate;

  const totalRows = filtered.length + (showCreate ? 1 : 0);

  /** Close the panel + notify host once. */
  const closeWithNotify = () => {
    setOpen(false);
    setQuery("");
    onClose?.();
  };

  useImperativeHandle(
    ref,
    () => ({
      open: () => setOpen(true),
    }),
    [],
  );

  useEffect(() => {
    setHighlight(0);
  }, [query, open]);

  /** Focus the filter input when the panel opens. */
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  /** Keep the highlighted row in view as ↑/↓ moves. */
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    const item = list.querySelector<HTMLElement>(`[data-row="${highlight}"]`);
    item?.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  const activate = (i: number) => {
    if (showCreate && i === filtered.length) {
      onCreate?.(trimmed);
    } else {
      const row = filtered[i];
      if (row) onValueChange(row.id);
    }
    closeWithNotify();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => (totalRows === 0 ? 0 : (h + 1) % totalRows));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) =>
        totalRows === 0 ? 0 : (h - 1 + totalRows) % totalRows,
      );
    } else if (e.key === "Enter") {
      if (totalRows === 0) return;
      e.preventDefault();
      activate(highlight);
    } else if (e.key === "Tab") {
      // Let Tab leave the field naturally; close silently (no onClose →
      // focus follows the natural Tab target, not forced to editor).
      setOpen(false);
    }
    // Escape is handled by Base UI Popover → onOpenChange(false) → closeWithNotify.
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => (next ? setOpen(true) : closeWithNotify())}
    >
      <Popover.Trigger
        aria-label={triggerAriaLabel}
        title={triggerAriaLabel}
        className={cx(
          "inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2 text-xs dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100",
          className,
        )}
      >
        <span
          aria-hidden
          className="inline-block h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: selected?.color || "var(--card-edge)" }}
        />
        <span>{value}</span>
        <span aria-hidden className="text-zinc-400">▾</span>
        <kbd className="ml-0.5 font-mono text-[10px] leading-none text-zinc-400 dark:text-zinc-500">
          ⌘L
        </kbd>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side="top"
          align="start"
          sideOffset={4}
          className="z-[60]"
        >
          <Popover.Popup className="w-56 rounded-lg border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-800">
            <div className="border-b border-zinc-100 p-1 dark:border-zinc-700">
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Filter…"
                autoComplete="off"
                spellCheck={false}
                aria-controls={listboxId}
                className="w-full rounded-md bg-transparent px-2 py-1 text-xs outline-none placeholder:text-zinc-400"
              />
            </div>
            <ul
              ref={listRef}
              id={listboxId}
              role="listbox"
              className="max-h-56 overflow-y-auto py-1"
            >
              {filtered.length === 0 && !showCreate && (
                <li className="px-3 py-1.5 text-xs text-zinc-400">No matches</li>
              )}
              {filtered.map((c, i) => (
                <li
                  key={c.id}
                  role="option"
                  aria-selected={c.id === value}
                  data-row={i}
                  onMouseEnter={() => setHighlight(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    activate(i);
                  }}
                  className={cx(
                    "flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs",
                    i === highlight ? "bg-zinc-100 dark:bg-zinc-700" : "",
                  )}
                >
                  <span
                    aria-hidden
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: c.color }}
                  />
                  <span className="flex-1 truncate">{c.id}</span>
                  {c.builtin && (
                    <span className="text-[10px] text-zinc-400">built-in</span>
                  )}
                </li>
              ))}
              {showCreate && (
                <li
                  role="option"
                  aria-selected={false}
                  data-row={filtered.length}
                  onMouseEnter={() => setHighlight(filtered.length)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    activate(filtered.length);
                  }}
                  className={cx(
                    "flex w-full cursor-pointer items-center gap-2 border-t border-zinc-100 px-3 py-1.5 text-left text-xs text-purple-600 dark:border-zinc-700 dark:text-purple-400",
                    filtered.length === highlight ? "bg-zinc-100 dark:bg-zinc-700" : "",
                  )}
                >
                  <span aria-hidden>✨</span>
                  <span className="truncate">Create '{trimmed}'</span>
                </li>
              )}
            </ul>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
});
```

- [ ] **Step 2: 타입체크+빌드**

Run: `cd apps/desktop && bun run build`
Expected: PASS. (기존 호출측 `NoteEditorForm`은 여전히 `value/onValueChange/categories/onCreate`만 쓰므로 호환 — 새 prop은 optional.)

- [ ] **Step 3: 수동 스모크 — 클리핑 수정 확인**

`bun run dev`(또는 Tauri dev)로 NoteDetail 열기 → 카드 클릭 → 칩 클릭 → 패널이 다이얼로그 **위쪽**으로 잘림 없이 열리는지 확인. ↑/↓/Enter/Esc 동작 확인. 라이트/다크 모두.

- [ ] **Step 4: 커밋**

```bash
git add apps/desktop/src/components/CategoryCombobox.tsx
git commit -m "refactor(desktop): CategoryCombobox via Base UI Popover (fix clipping) + imperative open"
```

---

### Task 3: NoteEditorForm — ref 스레딩 + 포커스 복귀 + i18n 키

**Files:**
- Modify: `apps/desktop/src/components/NoteEditorForm.tsx`
- Modify: `apps/desktop/src/lib/locales/ko.ts`
- Modify: `apps/desktop/src/lib/locales/en.ts`

**Interfaces:**
- Consumes: Task 1의 `MarkdownEditor.editorHandleRef`, Task 2의 `CategoryComboboxHandle.open`/`onClose`/`triggerAriaLabel`.
- Produces: `NoteEditorForm`이 optional `categoryPickerRef?: Ref<CategoryComboboxHandle>` prop 수용(상위 NoteDetail이 ⌘L로 open 호출). `onClose` 시 편집기로 포커스 복귀.

- [ ] **Step 1: i18n 키 추가**

`apps/desktop/src/lib/locales/en.ts` — `done: "Done",` 근처에 추가:

```ts
  set_category: "Set category",
```

`apps/desktop/src/lib/locales/ko.ts` — `done: "완료",` 근처에 추가:

```ts
  set_category: "카테고리 설정",
```

- [ ] **Step 2: NoteEditorForm 수정**

`apps/desktop/src/components/NoteEditorForm.tsx` 전체를 아래로 교체:

```tsx
/**
 * NoteDetail 전용 편집 폼 (§4.3). 본문은 atomic-editor 기반
 * `MarkdownEditor`, 추출된 `#태그`는 `TagChipRow`, 하단에 컬러 + 완료.
 *
 * 기존 `NoteComposeForm`에서 textarea+mirror 오버레이 분기를 떼어내고
 * 본문 영역을 atomic-editor로 교체한 형태. 두 폼이 사용 의도가 다르므로
 * (NoteDetail=본격 편집, CaptureOverlay=빠른 캡처) 공통 컴포넌트로 묶지
 * 않고 의도적으로 분리함.
 */
import { Check } from "lucide-react";
import { type Ref, useRef } from "react";

import { createCategory } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { CategoryCombobox, type CategoryComboboxHandle } from "./CategoryCombobox";
import { MarkdownEditor } from "./MarkdownEditor";
import { TagChipRow } from "./TagChipRow";
import type { AtomicCodeMirrorEditorHandle } from "@atomic-editor/editor";
import type { CategoryDef } from "../lib/types";

const cx = (...xs: (string | false | null | undefined)[]) =>
  xs.filter(Boolean).join(" ");


export interface NoteEditorFormProps {
  body: string;
  onBodyChange: (v: string) => void;
  documentId: string;
  category: string;
  onCategoryChange: (c: string) => void;
  categories: CategoryDef[];
  /** Primary action — "done" in NoteDetail. */
  onConfirm: () => void;
  confirmLabel: string;
  confirmDisabled?: boolean;
  /** Keyboard hint rendered inside the confirm button (e.g. "⌘⏎"). */
  confirmKbd?: string;
  /** Optional ref to the category picker so a parent shortcut (⌘L) can
   *  open it imperatively. */
  categoryPickerRef?: Ref<CategoryComboboxHandle>;
  className?: string;
}

export function NoteEditorForm({
  body,
  onBodyChange,
  documentId,
  category,
  onCategoryChange,
  categories,
  onConfirm,
  confirmLabel,
  confirmDisabled,
  confirmKbd,
  categoryPickerRef,
  className,
}: NoteEditorFormProps) {
  const { t } = useI18n();
  const editorHandleRef = useRef<AtomicCodeMirrorEditorHandle | null>(null);

  return (
    <div className={cx("flex flex-col gap-2.5", className)}>
      <MarkdownEditor
        body={body}
        onChange={onBodyChange}
        documentId={documentId}
        editorHandleRef={editorHandleRef}
        className="max-h-[55vh] overflow-y-auto"
      />
      <TagChipRow body={body} />
      <div className="flex flex-wrap items-center gap-2.5">
        <CategoryCombobox
          ref={categoryPickerRef}
          value={category || "inbox"}
          onValueChange={onCategoryChange}
          categories={categories}
          triggerAriaLabel={t.set_category}
          onClose={() => editorHandleRef.current?.focus()}
          onCreate={async (id) => {
            try {
              const def = await createCategory(id, null);
              onCategoryChange(def.id);
            } catch {
              // Rejected (e.g. duplicate id) — leave selection unchanged.
            }
          }}
        />
        <button
          type="button"
          onClick={onConfirm}
          disabled={confirmDisabled}
          aria-label={confirmLabel}
          title={confirmLabel}
          className="group ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg bg-zinc-900 px-2 text-white shadow-sm transition-all hover:bg-zinc-800 active:scale-95 disabled:pointer-events-none disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          <Check
            size={15}
            strokeWidth={2.5}
            className="transition-transform group-hover:scale-110"
          />
          {confirmKbd && (
            <kbd className="font-mono text-[10px] leading-none text-white/60 dark:text-zinc-500">
              {confirmKbd}
            </kbd>
          )}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: import 확인**

Step 2 교체본의 React import가 `import { type Ref, useRef } from "react";` 인지 확인(`useRef` 포함 — 본문에서 `editorHandleRef` 용).

- [ ] **Step 4: 타입체크+빌드**

Run: `cd apps/desktop && bun run build`
Expected: PASS.

- [ ] **Step 5: 수동 스모크 — 포커스 복귀**

NoteDetail 열기 → 칩 클릭으로 카테고리 선택 → 메뉴 닫힐 때 **편집기로 커서 복귀**하는지 확인(본문에 바로 타이핑 가능). Esc로 닫아도 편집기 복귀 확인.

- [ ] **Step 6: 커밋**

```bash
git add apps/desktop/src/components/NoteEditorForm.tsx apps/desktop/src/lib/locales/ko.ts apps/desktop/src/lib/locales/en.ts
git commit -m "feat(desktop): wire category picker ref + editor focus-return in NoteEditorForm"
```

---

### Task 4: NoteDetail — `⌘L` 단축키

**Files:**
- Modify: `apps/desktop/src/components/NoteDetail.tsx`

**Interfaces:**
- Consumes: Task 3의 `NoteEditorForm.categoryPickerRef`.
- Produces: `⌘L`로 카테고리 피커 오픈(IME 안전, CM6 미충돌).

- [ ] **Step 1: picker ref + 타입 import**

`apps/desktop/src/components/NoteDetail.tsx` 상단: React import에 `useRef` 추가(현재 `import { useEffect, useState } from "react";`).

```tsx
import { useEffect, useRef, useState } from "react";
```

타입 import 추가(`NoteDetail`은 `NoteEditorForm`을 통해 간접 사용하므로 컴포넌트가 아닌 **타입만** import):

```tsx
import type { CategoryComboboxHandle } from "./CategoryCombobox";
```

컴포넌트 본문(`NoteDetail` 함수 내, 기존 state 선언 근처)에 ref 추가:

```tsx
  const categoryPickerRef = useRef<CategoryComboboxHandle>(null);
```

- [ ] **Step 2: `⌘L` keydown 분기 추가**

기존 `Dialog.Popup`의 `onKeyDown`(`NoteDetail.tsx:113-118`)을 아래로 교체:

```tsx
          onKeyDown={(e) => {
            const mod = e.metaKey || e.ctrlKey;
            if (mod && e.key === "Enter") {
              e.preventDefault();
              close();
            } else if (mod && e.key.toLowerCase() === "l") {
              e.preventDefault();
              categoryPickerRef.current?.open();
            }
          }}
```

- [ ] **Step 3: `categoryPickerRef`를 NoteEditorForm에 전달**

`<NoteEditorForm ... />` 호출(`NoteDetail.tsx:148-158`)에 prop 추가:

```tsx
              <NoteEditorForm
                body={body}
                onBodyChange={edit(setBody)}
                documentId={note.data.id}
                category={category}
                onCategoryChange={edit(setCategory)}
                categories={categories}
                onConfirm={close}
                confirmLabel={t.done}
                confirmKbd="⌘⏎"
                categoryPickerRef={categoryPickerRef}
              />
```

- [ ] **Step 4: 타입체크+빌드**

Run: `cd apps/desktop && bun run build`
Expected: PASS.

- [ ] **Step 5: 수동 스모크 — 종단 간 ⌘L 흐름 (spec §7 핵심)**

`bun run dev` → 노트 열기 → 본문에 커서 → **한글 IME 켜진 상태**에서 `⌘L`:
1. 카테고리 메뉴가 **위쪽**으로 열리고 필터 입력에 포커스.
2. comment-toggle이 발동하지 않는지 확인(본문에 `<!-- -->` 안 생김).
3. ↑/↓ + Enter로 카테고리 선택 → 메뉴 닫힘 → 편집기로 포커스 복귀 → 본문 타이핑 가능.
4. Esc로 닫기 → 편집기 복귀.
5. 영문 모드에서도 동일 동작.

- [ ] **Step 6: 커밋**

```bash
git add apps/desktop/src/components/NoteDetail.tsx
git commit -m "feat(desktop): ⌘L opens category picker from NoteDetail editor (IME-safe)"
```

---

## Verification (전체, spec §7)

모든 태스크 완료 후 최종 스모크:

- [ ] **클리핑:** NoteDetail 칩 클릭 → 패널 위쪽 잘림 없음(라이트/다크).
- [ ] **⌘L:** 한글 IME 상태에서 ⌘L → 메뉴 오픈 + 필터 포커스 + comment-toggle 미발동.
- [ ] **선택/생성:** Enter 선택, Create 행 동작, 편집기 포커스 복귀.
- [ ] **Esc/Tab:** Esc 닫기(편집기 복귀), Tab 필드 이탈.
- [ ] **회귀 없음:** 칩 클릭 토글, 색상 점/배경 동기화, autosave 디바운스, ⌘⏎ 저장 정상.
- [ ] **최종 빌드:** `cd apps/desktop && bun run build` PASS.
