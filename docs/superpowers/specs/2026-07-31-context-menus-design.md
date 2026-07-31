# 우클릭 컨텍스트 메뉴 — Design Spec

**Date:** 2026-07-31
**Status:** Draft (pending user review)
**Scope:** 카테고리·노트에 대한 우클릭(right-click) 컨텍스트 메뉴 추가. 기존엔 우클릭/롱프레스 어디서도 불가.

## 1. 목표

- 사이드바의 카테고리 항목을 우클릭해 **바로 이름 편집 / 색상 변경 / 삭제**.
- 노트 카드와 NoteDetail 편집기를 우클릭해 **즐겨찾기 토글 / 카테고리 이동 / 본문·ID 복사 / 삭제**.
- 좌클릭(필터/선택) 동작은 그대로. hover 액션 버튼도 유지(메뉴는 보조 + 신규 기능).

## 2. 접근법 결정

**채택: Base UI `ContextMenu`** (`@base-ui-components/react`, 이미 의존성에 존재).

근거:
- 새 의존성 0. `Root/Trigger/Positioner/Popup/Item/Group/GroupLabel/Separator/SubmenuRoot/SubmenuTrigger` 전부 사용 가능.
- 접근성·포커스 트랩·ESC·커서 위치 자동 배치·서브메뉴(호버 오픈)를 기본 제공.
- `ContextMenu.Trigger`는 기본 `<div>` 렌더 → button-in-button DOM 위반 없이 기존 `<button>`/`<input>` 행을 그대로 감쌀 수 있음.

**배제:**
- Tauri 네이티브 메뉴 — OS 메뉴라 앱 스타일과 불일치, **인라인 텍스트 편집 불가**(요청 핵심인 "바로 이름 편집" 실현 불가).
- 직접 구현 — 포지셔닝·포커스·ESC 중복 구현. Base UI가 이미 해결.

## 3. 아키텍처

공유 프리미티브 1개 + 타깃별 메뉴 연결 3곳. 단일 시각 어휘로 일관성 확보.

### 3.1 새 파일: `src/components/ContextMenu.tsx`

Base UI `ContextMenu` 파트의 얇은 styled 래퍼. 앱 디자인 토큰(라운드·보더·다크모드)에 맞춰 사전 스타일링하고, 다음을 내보냄:

- `CtxMenu` — `Root + Portal + Positioner + Popup` 조합. `z-[70]`(Dialog z-50, Popover z-60 위). 자식으로 `Item`/`Group`/`Separator`/`Submenu` 배치. **Trigger는 호출측이 별도 렌더**(아래 DOM 보존 참고).
- `CtxTrigger` — `ContextMenu.Trigger`의 pass-through. `render` prop을 그대로 전달받아 기존 요소에 병합.
- `CtxItem({ icon, label, onClick, disabled, danger })` — 좌측 아이콘 + 라벨. `danger`면 삭제 빨강 스타일.
- `CtxSeparator`, `CtxGroup`, `CtxGroupLabel`.
- `CtxSubmenu({ label, icon, children })` — `SubmenuRoot + SubmenuTrigger(▸) + Positioner + Popup`. 색상·카테고리 서브메뉴용.

Popup 스타일: `min-w-44 rounded-lg border bg-white dark:bg-zinc-900 p-1 shadow-xl`, hover/하이라이트는 zinc-100/dark:zinc-800. 기존 Popover(SettingsMenu)·Card 시각과 동일 톤.

- **DOM 보존(핵심)**: `ContextMenu.Trigger`는 기본 `<div>`를 렌더하지만, 카드(CSS grid 직접 자식)·사이드바(flex-col 자식)처럼 추가 wrapper div가 레이아웃을 깨는 곳에서는 Base UI `render` prop으로 트리거를 **기존 요소 자체에 병합**(`render={<button/>}`, `render={<article/>}`)한다. 인라인 편집 중(input)에는 우클릭이 불필요하므로 트리거 없이 일반 `<input>`을 렌더.

### 3.2 `Sidebar.tsx` — 카테고리 메뉴 + 인라인 rename

카테고리 리스트를 새 `CategoryRow` 컴포넌트로 추출(`Sidebar` 본문은 map만 남김).

`CategoryRow` 상태 머신:
- 보통: 필터 토글 `<button>`을 `CtxTrigger render={<button .../>}`로 병합(wrapper div 없음).
- 편집: 일반 `<input>`으로 교체(트리거 없음). `categoryFilter`/`setCategory`/invalidate는 동일.

인라인 rename 로직 — SettingsMenu(`CategoriesSection`)의 검증된 패턴을 그대로 차용:
- `editingId`/`editingDraft` + `cancelRenameRef`.
- Enter → blur → `onCommitRename` → `renameCategory(oldId, next)` + `invalidate(["categories"],["facets"],["notes"])` + 토스트.
- Escape → `cancelRenameRef = true` → blur → 취소.
- 중복 id 체크 → `setError`.

메뉴 항목:
| 항목 | 동작 | inbox |
|---|---|---|
| 이름 변경 | 메뉴 닫힘(`closeOnClick` 기본 true) → `setEditingId` | 비활성 |
| 색상 ▸ | `CtxSubmenu`: 6 프리셋(`COLOR_PRESETS`) + "색상 없음" → `updateCategory(id, color)` + invalidate | 허용 |

**색상 "없음"은 신규 기능.** `updateCategory(id, color: string)`가 non-nullable이므로 빈 문자열 `""`로 전달(절대 `null` 아님 — TS 에러). `""`는 `colorForCategory`의 `INBOX_NEUTRAL`과 동일 표현이며 `paperFor("")`/`edgeFor("")`는 기본 서피스로 폴백. 기존 `CategorySwatch`는 `onBlur`의 `v &&` 가드로 색상을 지울 수 없어, 이 메뉴 항목이 처음으로 색상 해제를 지원한다(의도적 enhancement). 현재값은 `colorForCategory`/`c.color`로 체크 표시.

### 3.3 `Card.tsx` — 노트 카드 메뉴

`<article>`을 `CtxTrigger render={<article .../>}`로 병합하여 wrapper div 없이 grid 자식 유지(DOM 보존). `onSelect`(좌클릭 열기)는 그대로 — Trigger는 contextmenu 이벤트만 소비하고 click은 article로 전달된다.

`Card` Props 추가: `onMoveCategory: (id, category) => void`, `onCopyBody: (id) => void`.

메뉴:
| 즐겨찾기 / 즐겨찾기 해제 | `onToggleFavorite` (라벨은 `note.favorite` 토글) |
|---|---|
| 카테고리 이동 ▸ | `categories` 서브메뉴 → `onMoveCategory(note.id, cat.id)` |
| ───── | |
| 본문 복사 | `onCopyBody(note.id)` |
| ID 복사 | clipboard `note.id` + `copied` 토글 |
| ───── | |
| 삭제 | `onDelete` (danger) |

:hover 버튼(복사/즐겨찾기/삭제)은 **유지**. 메뉴는 보조 + "카테고리 이동"/"본문 복사" 신규 기능.

### 3.4 `CardGrid.tsx` — 핸들러 전달

`onDelete`/`onToggleFavorite` 패턴과 동일하게 추가:
```ts
const onMoveCategory = (id: string, category: string) =>
  updateNote(id, null, null, category)
    .then(() => { invalidate notes/facets })
    .catch(setError);

const onCopyBody = (id: string) =>
  getNote(id)
    .then((n) => navigator.clipboard.writeText(n.body))
    .then(() => setToast(...))
    .catch(setError);
```
두 핸들러를 `<Card .../>`에 전달.

### 3.5 `NoteDetail.tsx` — 편집기 메뉴

`Dialog.Popup` 콘텐츠를 `CtxTrigger`로 감싸고, Card와 동일한 노트 메뉴 렌더. 차이:
- 즐겨찾기: 로컬 `favorite` 상태 + `updateNote`.
- 본문 복사: `getNote` 생략, 상태 `body`를 그대로 복사.
- 카테고리 이동: `setCategory` + `updateNote(id,null,null,cat)` (기존 autosave 경로).
- 삭제: `deleteNote` 후 `close()`(선택 해제).
Positioner `z-[70]`가 Dialog(z-50) 위에 렌더되도록 보장(`CtxMenu` 기본값).

## 4. 데이터 희름 / API

모든 연산은 기존 IPC(`lib/api.ts`) — 신규 백엔드 작업 0.

| 액션 | IPC |
|---|---|
| 카테고리 이름변경 | `renameCategory(old, new)` → moved count |
| 카테고리 색상 | `updateCategory(id, color)` |
| 카테고리 삭제 | `deleteCategory(id)` |
| 노트 즐겨찾기 | `updateNote(id, null, favorite, null)` |
| 노트 카테고리 이동 | `updateNote(id, null, null, category)` |
| 노트 본문 복사 | `getNote(id)` → clipboard |
| 노트 삭제 | `deleteNote(id)` |

모든 뮤테이션 후 `qc.invalidateQueries({ queryKey: ["notes"] })` + `["facets"]`(필요시 `["categories"]`,`["stats"]`,`["search"]`). 기존 패턴과 동일.

## 5. i18n 새 키 (`ko.ts` 원본 + `en.ts` 동기화)

| key | ko | en |
|---|---|---|
| `action_rename` | 이름 변경 | Rename |
| `action_unfavorite` | 즐겨찾기 해제 | Unfavorite |
| `action_move_category` | 카테고리 이동 | Move to category |
| `action_copy_body` | 본문 복사 | Copy body |
| `action_copy_id` | ID 복사 | Copy ID |
| `no_color` | 색상 없음 | No color |
| `inbox_immutable` | Inbox는 변경할 수 없어요 | Inbox is immutable |

(`action_favorite`/... 기존 키 재사용.)

## 6. 엣지 케이스 / 레이어링

- **NoteDetail(Dialog z-50) 내 메뉴** → `CtxMenu` Positioner `z-[70]`로 백드롭/팝업 위 렌더.
- **inbox 카테고리** — 이름변경·삭제 비활성(기존 `isInbox`/`c.builtin` semantics). 색상은 허용.
- **button-in-button** — `CtxTrigger`는 `<div>`; 기존 `<button>`(필터)/`<input>`(편집)을 자식으로 두어 DOM 무결성 유지.
- **빈 카테고리 리스트** — "카테고리 이동" 서브메뉴가 비면 inbox 한 개는 항상 존재(builtin)하므로 빈 상태 없음.
- **롱프레스** — Base UI Trigger가 모바일/트랙패드 롱프레스도 contextmenu로 처리(요청한 "길게 클릭" 대안 자동 충족).
- **삭제 확인** — 없음. 기존 SettingsMenu와 일관(즉시 삭제 + invalidate). 회귀 아님.

## 7. 파일 변경 요약

| 파일 | 변경 |
|---|---|
| `src/components/ContextMenu.tsx` | **신규** — styled 프리미티브 |
| `src/components/Sidebar.tsx` | `CategoryRow` 추출 + 메뉴 + 인라인 rename |
| `src/components/Card.tsx` | Trigger + 노트 메뉴, prop 2개 추가 |
| `src/components/CardGrid.tsx` | `onMoveCategory`/`onCopyBody` 핸들러 |
| `src/components/NoteDetail.tsx` | 편집기 메뉴 |
| `src/lib/locales/ko.ts`, `en.ts` | 키 7개 |

## 8. 검증

1. `bun run build`(`tsc -b && vite build`) — 타입/컴파일 게이트.
2. **브라우저 목(mock) 스모크테스트** — `tauri-v2-browser-audit-mock` 스킬로 `window.__TAURI_INTERNALS__`를 시드 데이터로 목킹해 React 프론트엔드를 헤드리스 브라운저에서 구동. 우클릭 이벤트(`contextmenu`)를 발화해 각 메뉴가 열리고 항목이 동작하는지 시각 확인(카테고리 rename 인라인 전환, 색상 서브메뉴, 노트 카테고리 이동, 삭제). DB/Tauri 불필요.
3. 다국어(ko/en) 라벨이 두 테마(라이트/다크)에서 올바르게 렌더되는지 확인.
