# 우클릭 컨텍스트 메뉴 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 카테고리·노트(카드 + NoteDetail)에 우클릭 컨텍스트 메뉴 추가 — 이름변경/색상/삭제, 즐겨찾기/카테고리이동/본문·ID복사/삭제.

**Architecture:** Base UI `ContextMenu`(이미 의존성에 있음)의 styled 프리미티브 1개를 만들고, 사이드바 카테고리 행·카드·NoteDetail 세 곳에 연결. 백엔드 IPC는 전부 기존 것 재사용(신규 Rust 작업 0). DOM 보존을 위해 `render` prop으로 트리거를 기존 요소에 병합(grid/flex 레이아웃 유지).

**Tech Stack:** React 19, Base UI (`@base-ui-components/react` 1.0.0-rc.0), TanStack Query, Zustand, Tailwind v4, lucide-react, TypeScript. Tauri v2 IPC.

## Global Constraints

- 테스트 러너 없음 — 데스크톱 앱 `package.json`에 `test` 스크립트·vitest/jest 미설정. 태스크별 검증은 **`bun run build`(`tsc -b && vite build`)** 타입/컴파일 게이트 + 최종 **브라우저 목 스모크테스트**(`tauri-v2-browser-audit-mock`).
- i18n: `ko.ts`가 원본(source-of-truth). `en.ts`는 `Record<keyof typeof ko, string>`로 컴파일타임 동기화 → 키 추가 시 **두 파일 모두** 수정해야 빌드 통과.
- 색상 "없음"은 빈 문자열 `""` (`updateCategory(id: string, color: string)` non-nullable). 절대 `null`.
- `inbox` 카테고리: 이름변경·삭제 비활성(`c.id === "inbox"`).
- z-index: ContextMenu Positioner `z-[70]` (Dialog z-50, Popover z-60 위).
- 모든 뮤테이션 후 `qc.invalidateQueries` (기존 `onDelete`/`onToggleFavorite` 패턴 준수).
- Base UI `render` prop으로 wrapper div 회피 (카드=grid 자식, 사이드바=flex-col 자식).

**Spec:** `docs/superpowers/specs/2026-07-31-context-menus-design.md`

---

## File Structure

| 파일 | 책임 | 상태 |
|---|---|---|
| `src/components/ContextMenu.tsx` | Base UI ContextMenu styled 프리미티브 (`CtxMenu/Trigger/Item/Separator/Group/GroupLabel/Submenu`) | 신규 |
| `src/components/Sidebar.tsx` | 카테고리 행 추출 + 메뉴 + 인라인 rename | 수정 |
| `src/components/Card.tsx` | 카드에 노트 메뉴 연결, prop 2개 추가 | 수정 |
| `src/components/CardGrid.tsx` | `onMoveCategory`/`onCopyBody` 핸들러 | 수정 |
| `src/components/NoteDetail.tsx` | 편집기 메뉴 | 수정 |
| `src/lib/locales/ko.ts`, `en.ts` | 키 7개 추가 | 수정 |

---

### Task 1: ContextMenu styled 프리미티브

**Files:**
- Create: `apps/desktop/src/components/ContextMenu.tsx`

**Interfaces:**
- Produces: `CtxTrigger`, `CtxMenu`, `CtxItem`, `CtxSeparator`, `CtxGroupLabel`, `CtxSubmenu` — 후속 태스크가 임포트.

- [ ] **Step 1: 파일 작성**

```tsx
// apps/desktop/src/components/ContextMenu.tsx
import { ContextMenu } from "@base-ui-components/react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

const POPUP_CLS =
  "min-w-44 rounded-lg border border-zinc-200 bg-white p-1 text-sm text-zinc-700 shadow-xl dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200";

/** Trigger — 기본 <div>; grid/flex 자식에는 render prop으로 기존 요소에 병합. */
export const CtxTrigger = ContextMenu.Trigger;

/** Root + Portal + Positioner + Popup 컨테이너. 자식으로 Item/Separator/Submenu. */
export function CtxMenu({ children }: { children: ReactNode }) {
  return (
    <ContextMenu.Portal>
      <ContextMenu.Positioner className="z-[70]">
        <ContextMenu.Popup className={POPUP_CLS}>{children}</ContextMenu.Popup>
      </ContextMenu.Positioner>
    </ContextMenu.Portal>
  );
}

export function CtxItem({
  icon: Icon,
  label,
  onClick,
  disabled,
  danger,
}: {
  icon?: LucideIcon;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <ContextMenu.Item
      onClick={onClick}
      disabled={disabled}
      className={
        "flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 outline-none data-[highlighted]:bg-zinc-100 dark:data-[highlighted]:bg-zinc-800 disabled:opacity-30 disabled:data-[highlighted]:bg-transparent " +
        (danger ? "text-red-600 dark:text-red-400" : "")
      }
    >
      {Icon && <Icon size={14} className="shrink-0" />}
      <span>{label}</span>
    </ContextMenu.Item>
  );
}

export function CtxSeparator() {
  return <ContextMenu.Separator className="my-1 h-px bg-zinc-200 dark:bg-zinc-700" />;
}

export function CtxGroupLabel({ children }: { children: ReactNode }) {
  return (
    <ContextMenu.GroupLabel className="px-2.5 py-1 text-[11px] font-medium uppercase tracking-wider text-zinc-400">
      {children}
    </ContextMenu.GroupLabel>
  );
}

/** 서브메뉴(▸). children = 서브 Item 들. */
export function CtxSubmenu({
  label,
  icon: Icon,
  children,
}: {
  label: string;
  icon?: LucideIcon;
  children: ReactNode;
}) {
  return (
    <ContextMenu.SubmenuRoot>
      <ContextMenu.SubmenuTrigger
        className="flex w-full cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 outline-none data-[highlighted]:bg-zinc-100 dark:data-[highlighted]:bg-zinc-800"
      >
        {Icon && <Icon size={14} className="shrink-0" />}
        <span className="flex-1 text-left">{label}</span>
        <span className="text-zinc-400">▸</span>
      </ContextMenu.SubmenuTrigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner align="start" sideOffset={4} className="z-[70]">
          <ContextMenu.Popup className={POPUP_CLS}>{children}</ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.SubmenuRoot>
  );
}
```

- [ ] **Step 2: 타입 체크**

Run: `cd apps/desktop && bunx tsc -b --noEmit`
Expected: PASS (새 파일이 아직 임포트되지 않아도 컴파일).

- [ ] **Step 3: 커밋**

```bash
git add apps/desktop/src/components/ContextMenu.tsx
git commit -m "feat(desktop): add ContextMenu styled primitives"
```

---

### Task 2: i18n 키 추가

**Files:**
- Modify: `apps/desktop/src/lib/locales/ko.ts`
- Modify: `apps/desktop/src/lib/locales/en.ts`

**Interfaces:**
- Produces: `action_rename`, `action_unfavorite`, `action_move_category`, `action_copy_body`, `action_copy_id`, `no_color`, `inbox_immutable` — 후속 태스크가 `t.xxx`로 사용.

- [ ] **Step 1: ko.ts에 키 추가** — `clear_filters` 줄(67) 뒤, 닫는 `}` 전에 삽입:

```ts
  action_rename: "이름 변경",
  action_unfavorite: "즐겨찾기 해제",
  action_move_category: "카테고리 이동",
  action_copy_body: "본문 복사",
  action_copy_id: "ID 복사",
  no_color: "색상 없음",
  inbox_immutable: "Inbox는 변경할 수 없어요",
```

- [ ] **Step 2: en.ts에 동일 키 추가** — `clear_filters` 줄(67) 뒤, 닫는 `}` 전에:

```ts
  action_rename: "Rename",
  action_unfavorite: "Unfavorite",
  action_move_category: "Move to category",
  action_copy_body: "Copy body",
  action_copy_id: "Copy ID",
  no_color: "No color",
  inbox_immutable: "Inbox is immutable",
```

- [ ] **Step 3: 타입 체크** — `en.ts`가 `Record<keyof typeof ko, string>`이므로 키 불일치 시 컴파일 에러.

Run: `cd apps/desktop && bunx tsc -b --noEmit`
Expected: PASS (두 파일 키 쌍 일치).

- [ ] **Step 4: 커밋**

```bash
git add apps/desktop/src/lib/locales/ko.ts apps/desktop/src/lib/locales/en.ts
git commit -m "i18n(desktop): add context menu keys"
```

---

### Task 3: 사이드바 카테고리 메뉴 + 인라인 rename

**Files:**
- Modify: `apps/desktop/src/components/Sidebar.tsx`

**Interfaces:**
- Consumes: `CtxTrigger/CtxMenu/CtxItem/CtxSeparator/CtxSubmenu` (Task 1), i18n 키 (Task 2), `renameCategory/updateCategory/deleteCategory/listCategories` (`lib/api`), `COLOR_PRESETS/presetToString/colorForCategory` (`lib/color`).
- Produces: `CategoryRow` 컴포넌트(내부). `Sidebar` 본문의 `catDefs.map`이 이를 사용.

- [ ] **Step 1: import 추가** — Sidebar.tsx 상단 import 블록에 추가:

```tsx
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Palette, Trash2, FolderInput } from "lucide-react";
import { useState, useRef, type KeyboardEvent } from "react";
import { renameCategory, updateCategory, deleteCategory } from "../lib/api";
import { COLOR_PRESETS, presetToString } from "../lib/color";
import { CtxTrigger, CtxMenu, CtxItem, CtxSeparator, CtxSubmenu } from "./ContextMenu";
```
(`useQuery`는 이미 있음 — `useQueryClient`만 추가. 기존 import와 병합.)

- [ ] **Step 2: `CategoryRow` 컴포넌트 작성** — `Sidebar` 함수 위(파일 내, `STATE_CLASS` 아래)에 추가:

```tsx
function CategoryRow({ def, count, selected, catDefs }: {
  def: CategoryDef;
  count: number | undefined;
  selected: boolean;
  catDefs: CategoryDef[];
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const setCategory = useUI((s) => s.setCategory);
  const setToast = useUI((s) => s.setToast);
  const setError = useUI((s) => s.setError);
  const isInbox = def.id === "inbox";

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(def.id);
  const cancelRef = useRef(false);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["categories"] });
    qc.invalidateQueries({ queryKey: ["facets"] });
    qc.invalidateQueries({ queryKey: ["notes"] });
  };

  const commit = async () => {
    if (cancelRef.current) { cancelRef.current = false; setEditing(false); return; }
    const next = draft.trim();
    setEditing(false);
    if (!next || next === def.id) return;
    if (catDefs.some((c) => c.id === next)) { setError(`"${next}" already exists`); return; }
    try {
      const moved = await renameCategory(def.id, next);
      setToast(`${moved} ${moved === 1 ? "note moved" : "notes moved"}`);
      invalidate();
    } catch (e) { setError(String(e).split("\n")[0]); }
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); (e.currentTarget as HTMLInputElement).blur(); }
    else if (e.key === "Escape") { e.preventDefault(); cancelRef.current = true; (e.currentTarget as HTMLInputElement).blur(); }
  };

  const btnCls = `flex items-center gap-2 rounded-md px-2 py-1 text-left text-sm ${
    selected ? "bg-zinc-200/70 font-semibold dark:bg-zinc-700" : "hover:bg-zinc-100 dark:hover:bg-zinc-800"
  }`;

  if (editing) {
    return (
      <input
        autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
        onBlur={commit} onKeyDown={onKey}
        className="min-w-0 rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm outline-none focus:border-blue-400 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100"
      />
    );
  }

  return (
    <CtxTrigger render={
      <button type="button" className={btnCls} onClick={() => setCategory(selected ? null : def.id)} />
    }>
      <span className="inline-block h-2.5 w-2.5 rounded-full"
        style={{ backgroundColor: colorForCategory(def.id, catDefs) }} />
      <span>{def.id}</span>
      {count !== undefined && <span className="ml-auto text-[11px] text-zinc-400">{count}</span>}
      <CtxMenu>
        <CtxItem icon={Pencil} label={t.action_rename} disabled={isInbox} onClick={() => { setDraft(def.id); setEditing(true); }} />
        <CtxSubmenu icon={Palette} label={t.color}>
          {COLOR_PRESETS.map((p) => (
            <CtxItem key={p.id} label={p.id}
              onClick={() => updateCategory(def.id, presetToString(p)).then(invalidate).catch((e) => setError(String(e).split("\n")[0]))} />
          ))}
          <CtxSeparator />
          <CtxItem label={t.no_color}
            onClick={() => updateCategory(def.id, "").then(invalidate).catch((e) => setError(String(e).split("\n")[0]))} />
        </CtxSubmenu>
        <CtxSeparator />
        <CtxItem icon={Trash2} label={t.action_delete} danger disabled={isInbox}
          onClick={() => deleteCategory(def.id).then(invalidate).catch((e) => setError(String(e).split("\n")[0]))} />
      </CtxMenu>
    </CtxTrigger>
  );
}
```
(`CategoryDef` 타입 import 필요 — `import type { CategoryDef } from "../lib/types";` Sidebar에 이미 `colorForCategory` 사용 중이므로 확인.)

- [ ] **Step 3: `Sidebar` 본문의 map 교체** — 기존 `{catDefs.map((c) => { ... })}` 블록을:

```tsx
{catDefs.map((c) => (
  <CategoryRow
    key={c.id} def={c} catDefs={catDefs}
    count={categories.find(([id]) => id === c.id)?.[1]}
    selected={categoryFilter === c.id}
  />
))}
```

- [ ] **Step 4: 타입 체크**

Run: `cd apps/desktop && bunx tsc -b --noEmit`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add apps/desktop/src/components/Sidebar.tsx
git commit -m "feat(desktop): category context menu with inline rename"
```

---

### Task 4: 노트 카드 메뉴 + CardGrid 핸들러

**Files:**
- Modify: `apps/desktop/src/components/Card.tsx`
- Modify: `apps/desktop/src/components/CardGrid.tsx`

**Interfaces:**
- Consumes: `CtxTrigger/CtxMenu/CtxItem/CtxSeparator/CtxSubmenu` (Task 1), i18n (Task 2). `Card` 새 prop `onMoveCategory(id, category)`, `onCopyBody(id)`.
- Produces: 카드 우클릭 메뉴.

- [ ] **Step 1: Card.tsx Props 확장** — interface `Props`에 추가:

```tsx
  onMoveCategory: (id: string, category: string) => void;
  onCopyBody: (id: string) => void;
```

- [ ] **Step 2: Card.tsx import + 래퍼** — 상단 import:

```tsx
import { Star, Trash2, Copy, FolderInput, ClipboardCopy } from "lucide-react";
import { CtxTrigger, CtxMenu, CtxItem, CtxSeparator, CtxSubmenu } from "./ContextMenu";
```
함수 시그니처에 `onMoveCategory, onCopyBody` 추가. `<article ...>`을 `CtxTrigger render={<article .../>}`로 감싸기: 기존 `<article onClick={...} style={...} className={...}>` 여는 태그를 `CtxTrigger`로 교체하고 같은 속성 전달. `</article>` → `</CtxTrigger>`. article 본문 + hover 버튼은 그대로. `CtxMenu`를 article 첫 자식(또는 hover 버튼 div 형제)으로 배치.

- [ ] **Step 3: Card.tsx 메뉴 본문** — `CtxMenu` 내용:

```tsx
<CtxMenu>
  <CtxItem icon={Star} label={note.favorite ? t.action_unfavorite : t.action_favorite}
    onClick={() => onToggleFavorite(note.id)} />
  <CtxSubmenu icon={FolderInput} label={t.action_move_category}>
    {categories.map((c) => (
      <CtxItem key={c.id} label={c.id} disabled={note.category === c.id}
        onClick={() => onMoveCategory(note.id, c.id)} />
    ))}
  </CtxSubmenu>
  <CtxSeparator />
  <CtxItem icon={ClipboardCopy} label={t.action_copy_body} onClick={() => onCopyBody(note.id)} />
  <CtxItem icon={Copy} label={t.action_copy_id} onClick={() => {
    void navigator.clipboard.writeText(note.id).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 800); });
  }} />
  <CtxSeparator />
  <CtxItem icon={Trash2} label={t.action_delete} danger onClick={() => onDelete(note.id)} />
</CtxMenu>
```

- [ ] **Step 4: CardGrid.tsx 핸들러** — `onDelete` 근처에 추가:

```tsx
const onMoveCategory = (id: string, category: string) => {
  void updateNote(id, null, null, category)
    .then(() => {
      qc.invalidateQueries({ queryKey: ["notes"] });
      qc.invalidateQueries({ queryKey: ["facets"] });
    })
    .catch((e) => setError(String(e).split("\n")[0]));
};
const onCopyBody = (id: string) => {
  void getNote(id)
    .then((n) => navigator.clipboard.writeText(n.body))
    .catch((e) => setError(String(e).split("\n")[0]));
};
```
`getNote`를 `../lib/api` import에 추가. `<Card .../>`에 `onMoveCategory={onMoveCategory} onCopyBody={onCopyBody}` 전달.

- [ ] **Step 5: 타입 체크**

Run: `cd apps/desktop && bunx tsc -b --noEmit`
Expected: PASS.

- [ ] **Step 6: 커밋**

```bash
git add apps/desktop/src/components/Card.tsx apps/desktop/src/components/CardGrid.tsx
git commit -m "feat(desktop): note card context menu"
```

---

### Task 5: NoteDetail 편집기 메뉴

**Files:**
- Modify: `apps/desktop/src/components/NoteDetail.tsx`

**Interfaces:**
- Consumes: `CtxTrigger/CtxMenu/CtxItem/...` (Task 1), i18n (Task 2). 로컬 `body/favorite/category` 상태 + `updateNote`/`deleteNote`.

- [ ] **Step 1: import + 트리거** — 상단:

```tsx
import { Star, Trash2, Copy, FolderInput, ClipboardCopy } from "lucide-react";
import { CtxTrigger, CtxMenu, CtxItem, CtxSeparator, CtxSubmenu } from "./ContextMenu";
```
`Dialog.Popup` 내부 콘텐츠 프래그먼트(`<>...</>`)를 `<CtxTrigger render={<div className="contents" />}>...</CtxTrigger>`로 감싸거나, id/span 헤더 영역을 트리거로. `display:contents` 래퍼는 레이아웃 영향 없음.

- [ ] **Step 2: 메뉴 본문** — 트리거 내에 `CtxMenu`:

```tsx
<CtxMenu>
  <CtxItem icon={Star} label={favorite ? t.action_unfavorite : t.action_favorite} onClick={() => edit(setFavorite)(!favorite)} />
  <CtxSubmenu icon={FolderInput} label={t.action_move_category}>
    {categories.map((c) => (
      <CtxItem key={c.id} label={c.id} disabled={category === c.id} onClick={() => edit(setCategory)(c.id)} />
    ))}
  </CtxSubmenu>
  <CtxSeparator />
  <CtxItem icon={ClipboardCopy} label={t.action_copy_body} onClick={() => void navigator.clipboard.writeText(body)} />
  <CtxItem icon={Copy} label={t.action_copy_id} onClick={() => void navigator.clipboard.writeText(note.data!.id)} />
  <CtxSeparator />
  <CtxItem icon={Trash2} label={t.action_delete} danger onClick={() => {
    void deleteNote(note.data!.id).then(() => { qc.invalidateQueries({ queryKey: ["notes"] }); qc.invalidateQueries({ queryKey: ["facets"] }); close(); });
  }} />
</CtxMenu>
```

- [ ] **Step 3: 타입 체크**

Run: `cd apps/desktop && bunx tsc -b --noEmit`
Expected: PASS.

- [ ] **Step 4: 커밋**

```bash
git add apps/desktop/src/components/NoteDetail.tsx
git commit -m "feat(desktop): NoteDetail context menu"
```

---

### Task 6: 빌드 게이트

- [ ] **Step 1: 전체 빌드**

Run: `cd apps/desktop && bun run build`
Expected: PASS (`tsc -b && vite build`).

- [ ] **Step 2: 실패 시 수정 후 재빌드**

---

### Task 7: 브라우저 목 스모크테스트

- [ ] **Step 1: `tauri-v2-browser-audit-mock` 스킬로 목 환경 구동** — `window.__TAURI_INTERNALS__`를 시드 데이터로 목킹해 Vite 빌드 산출물을 헤드리스 브라운저에서 로드.

- [ ] **Step 2: 시나리오 검증** — 각각 `contextmenu` 이벤트 발화:
  - 사이드바 카테고리 우클릭 → 메뉴 표시 → "이름 변경" 클릭 → 인라인 input 전환
  - 색상 서브메뉴 ▸ 호버 → 프리셋 표시
  - 노트 카드 우클릭 → 메뉴 → "카테고리 이동" 서브메뉴
  - 다크모드 + 영어 로케일 전환 후 라벨 확인

- [ ] **Step 3: 스크린샷으로 시각 확인**

- [ ] **Step 4: 최종 커밋**(문서/스타일 튜닝분 있으면)

```bash
git add -A && git commit -m "polish(desktop): context menu refinements from smoke test"
```

---

## Self-Review (작성자)

- **Spec coverage:** §3.1→Task1, §3.2→Task3, §3.3→Task4, §3.4→Task4(handlers), §3.5→Task5, §5 i18n→Task2, §8 검증→Task6/7. §6 엣지케이스(z-index/inbox/DOM보존/빈문자열)는 각 태스크 코드에 반영. ✓
- **Placeholder scan:** TBD/TODO 없음. 모든 코드 스텝에 실제 코드. ✓
- **Type consistency:** `CtxItem({icon,label,onClick,disabled,danger})` 시그니처 전 태스크 일치. `onMoveCategory(id,category)`/`onCopyBody(id)` Card↔CardGrid 일치. ✓
