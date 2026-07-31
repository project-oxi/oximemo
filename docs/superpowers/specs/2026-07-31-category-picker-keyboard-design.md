# NoteDetail 카테고리 피커 — 키보드 중심 + 클리핑 수정 Design Spec

**Date:** 2026-07-31
**Status:** Draft (pending user review)
**Scope:** NoteDetail 편집 중 카테고리 선택을 (1) 잘림 없이 위로 열리고 (2) 순수 키보드로 호출 가능하게 만든다. 한글 IME 환경에서도 마우스 없이 동작한다.

## 1. 목표

- **클리핑 수정:** `CategoryCombobox` 패널이 Dialog 하단에 가려 잘리는 현상 제거. 패널은 항상 잘림 없이 보여야 한다.
- **키보드 호출:** 본문(CodeMirror) 편집 중 `⌘L` 한 번으로 카테고리 메뉴를 열고 필터 입력에 포커스. ↑/↓ 탐색 → Enter 선택/생성 → Esc 닫기 → 포커스는 편집기로 복귀. 마우스 0회. 칩 옆에 흐릿한 `⌘L` 힌트 표시로 발견성 확보(기존 `confirmKbd="⌘⏎"` 패턴과 일관).
- **IME 안전:** `⌘L`는 macOS에서 `Cmd`+키가 입력기를 우회해 베이스 레이아웃(US)의 키값을 전달하므로 한글 모드에서도 동작. 순수 키보드 경로가 IME 상태와 무관하게 보장된다.

## 2. 접근법 결정

세 축이 있고, 각각의 결정과 근거는 다음과 같다.

### 2.1 클리핑 → Base UI `Popover` 포털화 (채택)

**근거:**
- 근본 원인: 패널이 `absolute top-full`(아래로) 이며 `Dialog.Popup`(`NoteDetail.tsx:119`, `overflow-hidden`)의 DOM 자식이라 오버플로우에 잘림.
- `@base-ui-components/react`의 `Popover`는 이미 의존성이고 `SettingsMenu`에서 사용 중. `Portal`로 `document.body`에 렌더 → Dialog `overflow-hidden`을 벗어남. 배치 + flip(위/아래 자동 전환)을 기본 제공.
- 피커(칩)는 Dialog 하단에 있으므로 placement `top` + flip으로 안정적으로 **위로** 열림.

**배제:** 직접 `bottom-full` 플립 — 다이얼로그가 작거나 칩이 높이 있을 때 위쪽도 잘릴 수 있어 불안정. 수동 `createPortal` + flip 계산 — Popover가 이미 해결하는 것의 재구현.

### 2.2 키보드 호출 → `⌘L` (채택)

**근거:**
- `Cmd`+키는 macOS에서 입력기를 우회 → 한글 모드에서도 `⌘L`이 그대로 전달. IME에 구애받지 않는 순수 키보드 경로.
- `⌘L`(`Mod-l`)은 CM6 모든 내장 키맵에서 **미바인딩** 확인: `defaultKeymap`·`searchKeymap`(⌘**⇧**L만 사용)·`markdownKeymap`·`closeBracketsKeymap`. 따라서 편집기 포커스 중에도 CM6가 이벤트를 소비하지 않고 다이얼로그 핸들러로 버블링.
- NoteDetail 다이얼로그에 이미 `⌘⏎`(저장) `onKeyDown` 핸들러가 있음(`NoteDetail.tsx:113`). 동일 지점에 `⌘L` 분기 추가 → 일관된 단축키 패턴, dialog 핸들러 수준 ~5줄. CM6 확장 불필요.
- "라벨 = 카테고리"로 읽혀 의미가 자연스럽움.

**배제 — `⌘/`:** 처음엔 슬래시 의미론을 살린 IME-safe 트리거로 검토했으나, CM6 `defaultKeymap`이 `{ key: "Mod-/", run: toggleComment }`에 바인딩(`AtomicCodeMirrorEditor.js:129`이 `...defaultKeymap` 포함). 편집기 포커스 중 `⌘/`는 곧 comment-toggle로 소비되어 dialog 핸들러에 도달하지 못함(또는 동시 실행). 쓰려면 `Prec.high` CM6 확장으로 toggleComment를 선점하고 comment-toggle을 다른 코드(예. `⌘⇧/`)로 재바인드해야 함 — "간단한 ~5줄" 전제가 붕괴하고 표준 단축키 이동이라는 부작용 발생. 동일한 CM6-확장 비용이 드는 bare `/`(아래)와 비용 차이도 줄어들어 "⌘/ 깔끔·bare-/ 무거움" 디코토미가 성립하지 않음. 따라서 기각.

### 2.3 인-도큐먼트 bare `/` → **연기(비목표)**

QuickCapture처럼 본문에 `/`를 직접 입력해 메뉴를 여는 Notion 스타일. CM6 `extensions` 슬롯(`AtomicCodeMirrorEditor`가 지원)으로 빌드 가능하나:
- 트랜잭션 리스너 + 커서 위치 tooltip(React 포털) + 공유 keymap 상태 브리징 ~200줄.
- Latin 전용(한글 IME에선 `ㅂ`). 단독으로는 IME-safe 키보드 경로를 보장하지 못함 — `⌘L` 같은 동반 트리거가 어차피 필요.
- "깔끔하지 않으면 관둔다" 기준에서 무거운 쪽 → 본 스펙에서 제외. 필요해지면 별도 스펙으로 추가.

> ⌘L이 IME 안전 + 비충돌 + 저비용으로 키보드 목표를 달성하므로 슬래시 접근은 연기. 칩 클릭(마우스) 경로는 그대로 유지된다.

## 3. 아키텍처

`CategoryCombobox`를 Base UI `Popover` 기반으로 재구성하고, 동일 메뉴를 칩 클릭과 `⌘L`이 모두 연다. 신규 파일 없이 기존 컴포넌트 3개 수정.

### 3.1 `CategoryCombobox.tsx` — Popover화 + imperative open

내부 `open` 상태를 유지하되 Base UI `Popover`에 `open`/`onOpenChange`로 위임:

```
<Popover.Root open={open} onOpenChange={setOpen}>
  <Popover.Trigger render={<chip-button/>} />   // 클릭 토글
  <Popover.Portal>
    <Popover.Positioner placement="top" /* flip 내장 */>
      <Popover.Popup className="z-[60] ...">
        <filter input/>
        <list (role=listbox)/>
        <create row/>
      </Popover.Popup>
    </Popover.Positioner>
  </Popover.Portal>
</Popover.Root>
```

- 필터 입력 오픈 시 자동 포커스, ↑/↓/Enter/Esc 기존 로직 그대로(`onKeyDown`). `activate(i)` → 선택/생성 → `close()`.
- **imperative handle 추가:** `useImperativeHandle`로 `open()` 노출 (`setOpen(true)`; 기존 effect가 입력 포커스). `⌘L`이 이 메서드를 호출.
- **포커스 복귀:** 메뉴가 닫힐 때(선택·Esc·외부클릭 모두) 상위로 알리기 위해 `onClose?: () => void` prop 추가. 내부 `close()`에서 호출. 포커스 복귀 자체는 편집기 핸들을 소유한 `NoteEditorForm`이 `onClose`에서 수행(§3.2) — `CategoryCombobox`는 편집기 의존성을 갖지 않는다.

### 3.2 `NoteEditorForm.tsx` — 피커 ref 스레딩 + 편집기 핸들 노출

- `MarkdownEditor`의 내부 `handleRef`(`AtomicCodeMirrorEditorHandle`, `focus()` 보유)를 prop으로 받아 올림. `NoteEditorForm`이 이 ref를 보관.
- 새 prop `categoryPickerRef?: Ref<CategoryComboboxHandle>` 추가 → `CategoryCombobox`의 ref로 전달.
- `onCategoryChange`는 카테고리 데이터만 전달. **포커스 복귀**는 `onClose={() => editorHandleRef.current?.focus()}`로 연결 — 메뉴가 어떤 이유로 닫히든 편집기로 복귀(키보드 흐름 완결). `MarkdownEditor`의 `editorHandleRef`를 올려받아 보관(§3.4).

### 3.3 `NoteDetail.tsx` — `⌘L` 단축키

기존 `onKeyDown`(`NoteDetail.tsx:113`)에 `⌘L` 분기를 추가(이미 있는 `⌘⏎` 저장과 나란히):

```ts
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

`⌘L`은 CM6가 소비하지 않으므로(§2.2) 편집기 포커스 중에도 이벤트가 다이얼로그 핸들러로 버블링. `categoryPickerRef`는 `NoteEditorForm`으로 전달. 오픈 → 입력 포커스 → 키보드 선택 → `onCategoryChange` → 편집기 복귀.

### 3.4 `MarkdownEditor.tsx` — 핸들 노출

내부 `useRef` 대신 optional `editorHandleRef` prop을 받아 동일 ref에 연결(상위에서 `focus()` 호출 가능). 래퍼 API만 확장, 동작 변화 없음.

## 4. 키보드 흐름 (종단 간)

```
본문 편집 중 ─⌘L─▶ CategoryCombobox.open()
                     │ 패널 포털 오픈(위쪽), 필터 입력 포커스
                     │
                ↑/↓ 탐색 / 타이핑 필터
                     │
                Enter ─▶ activate() ─▶ onValueChange(id) | onCreate(query)
                     │                   │
                     │              onCategoryChange ─▶ setCategory (autosave 디바운스)
                     │
                editorHandle.focus() ─▶ 편집기로 복귀
```

Esc: 메뉴 닫기(변경 없음) → 편집기 복귀. Tab: 기존 동작 유지(필드 이탈, 닫기).

## 5. IME 처리

- `⌘L`: macOS 입력기 우회(Cmd+키) → 한글/영문 모드 무관 동작. **보장된 키보드 경로.**
- bare `/`: Latin 전용이나 본 스펙에서 제외(2.3).
- 칩 클릭: 마우스 경로(보조). 클리핑 수정 후 정상 동작.
- 결과: Korean-mode 작성자도 마우스 0회로 카테고리 지정 가능.

## 6. 비목표

- 인-도큐먼트 bare `/` CM6 확장 (별도 스펙 검토).
- QuickCaptureForm의 슬래시 메뉴 변경 — 이미 동작 중, 본 스펙 범위 외.
- 카테고리 CRUD UI — `SettingsMenu`/`category-management-ux` 스펙이 소유.

## 7. 검증

- **클리핑:** NoteDetail 열고 칩 클릭 → 패널이 다이얼로그 위로 잘림 없이 표시(위쪽). 다크모드/라이트모두.
- **`⌘L`:** 본문 편집 중 `⌘L` → 메뉴 오픈 + 필터 포커스. 한글 IME 켜진 상태에서도 동작 확인(핵심). comment-toggle이 발동하지 않는지도 확인.
- **선택/생성:** Enter로 기존 카테고리 선택, 신규 Create 행 동작. 선택 후 포커스 편집기 복귀, 본문에 계속 입력 가능.
- **Esc/Tab:** Esc 닫기(변경 없음), Tab 필드 이탈.
- **기존 동작 회귀 없음:** 칩 클릭 토글, 색상 점/배경 동기화, autosave 디바운스 정상.

## 8. 참조

- `apps/desktop/src/components/CategoryCombobox.tsx:156` — 기존 `absolute top-full` 패널(클리핑 원인).
- `apps/desktop/src/components/NoteDetail.tsx:113,119` — `⌘⏎` 핸들러 / `overflow-hidden` 팝업.
- `apps/desktop/src/components/NoteEditorForm.tsx:60` — 칩이 위치한 하단 툴바.
- `apps/desktop/node_modules/@atomic-editor/editor/dist/AtomicCodeMirrorEditor.d.ts:159` — `extensions` 슬롯(bare `/`용, 연기).
- `doc/CAPTURE_SLASH_PALETTE.md` — 슬래시 팔레트 미해결 이슈 #5(IME); 본 스펙은 `⌘L`로 회피.
- `apps/desktop/node_modules/@atomic-editor/editor/dist/AtomicCodeMirrorEditor.js:129` — `...defaultKeymap` 포함. `@codemirror/commands` defaultKeymap의 `{ key: "Mod-/", run: toggleComment }`가 `⌘/` 기각 사유. `⌘L`(`Mod-l`)은 4개 키맵(default/search/markdown/closeBrackets) 전부 미바인딩 확인.
