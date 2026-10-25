# 우클릭 컨텍스트 메뉴 실태와 설계 — 2026-10-25

범위: 데스크톱 앱(`apps/desktop`)의 우클릭(롱프레스) 컨텍스트 메뉴 전반.
모바일(`apps/mobile`)은 제외 — 우클릭 개념이 없고 롱프레스는 별도 과제.

## 0. 증상 진단 — "사이드바에서 아무것도 안 뜬다"

`main.tsx:38-42`가 네이티브 contextmenu를 capture 단계에서 전역 `preventDefault`
한다(DEV에서 Alt+우클릭만 네이티브 통과). 따라서 **자체 Base UI 메뉴를 붙인
서피스에서만** 우클릭이 동작하고, 나머지는 전부 의도된 no-op이다.

사이드바에서 메뉴가 붙어 있는 것은 3곳뿐이다:

| 사이드바 영역 | 상태 | 근거 |
|---|---|---|
| 핀된 폴더 행 | 메뉴 있음 (열기/이름 변경/고정 해제/2단 삭제) | `Sidebar.tsx:774-931` |
| 컬렉션 셀 (LOCATIONS 핀) | 메뉴 있음 (동일 구성) | `Sidebar.tsx:1096-1157` |
| 태그 칩 | 메뉴 있음 (포함/제외/해제/이름 변경/필터 초기화) | `Sidebar.tsx:600-651` |

즉 증상은 버그가 아니라 **커버리지 공백**이다: FAVORITES 셀, LOCATIONS 시스템
위치 셀(볼트 루트/데일리/지식), 쿼리 행, 할 일 패널 행, 최근 항목 팝오버,
사이드바 빈 공간에는 트리거가 아예 없다. 이 설계는 공백을 원칙에 따라 메운다.

## 1. 기존 인프라 (새로 만들 것 없음)

| 블록 | 용도 | 파일 |
|---|---|---|
| `CtxRoot/CtxTrigger/CtxMenu/CtxItem/CtxSeparator/CtxGroupLabel/CtxSubmenu` | 우클릭 메뉴 (Base UI ContextMenu 래퍼, glass-menu, z-70) | `ContextMenu.tsx` |
| `BtnMenuRoot/Trigger/Popup/Item/Separator` | 좌클릭 팝오버 메뉴 — 같은 시각 어휘 | `ContextMenu.tsx` |
| `PointMenu` | CM6·캔버스 등 React 밖 DOM용 좌표 메뉴 | `PointMenu.tsx` |
| `TextCtxMenu` | 편집 가능 input/textarea 표준 편집 메뉴 | `TextCtxMenu.tsx` |
| CM6→React 브리지 | `oximemo:image-menu` window CustomEvent → `PointMenu` | `cm6Images.ts:133-150` → `MarkdownEditor.tsx:89-96` |
| 체크박스 브리지 | 직접 콜백(`onPopoverRequest`) → `TaskEditPopover` | `taskCheckboxes.ts:280-284` |
| 오브젝트 메뉴 | `NoteCtxMenu`, `FolderCtxMenu`(FolderTile export), 태그 칩 메뉴 | 각 파일 |

중첩 트리거 패턴은 검증돼 있다: 콘텐츠 영역 빈 공간 메뉴(`CardGrid.tsx:1938-1959`,
CtxTrigger가 `renderMainSurface()` 전체를 감쌈) 안에서 카드·폴더 타일의 개별
메뉴가 정상 동작한다. 사이드바도 같은 모양으로 감싸면 된다.

### 이미 메뉴가 붙어 있는 표면 (재설계 대상 아님)

- 노트 카드/리스트 행/타임라인 행 → `NoteCtxMenu` (즐겨찾기/폴더 이동/본문·ID 복사/삭제)
- 폴더 타일/리스트 폴더 행/사이드바 폴더 핀 → `FolderCtxMenu`
- 갤러리 썸네일, 그래프 노드, 백링크 항목(`LinksCard.tsx:44-73`)
- 편집기 본문 `TextCtxMenu`, 인라인 이미지 `PointMenu`, 태스크 체크박스 → `TaskEditPopover`
- 콘텐츠 빈 공간 (새 MD 노트/새 HTML 노트/새 폴더, `CardGrid.tsx:1938-1959`)
- 퀵캡처 textarea, 폴더 콤보박스 input, MarkdownEditor/HtmlEditor host → `TextCtxMenu`

## 2. 설계 원칙

1. **오브젝트 하나 = 메뉴 하나.** 같은 종류의 오브젝트는 어떤 표면에서 우클릭해도
   동일한 항목 세트. 노트는 `NoteCtxMenu`, 폴더는 `FolderCtxMenu`만 재사용하고
   새 사본을 만들지 않는다.
2. **우클릭 = hover ⋯ 버튼과 같은 메뉴의 두 번째 진입점.** ⋯ 전용 메뉴(쿼리 행)는
   항목 정의를 공유하고 두 래퍼가 각자 렌더한다.
3. **항목 순서 규약:** 탐색(열기) → 상태 토글(즐겨찾기/필터/완료) → 관리(이름 변경/
   고정/이동) → 클립보드 → 구분선 → 파괴(danger + 기존 2단 arm 패턴).
4. **인프라 확장 금지.** React 트리 안이면 `Ctx*` 래퍼, CM6/iframe이면 기존
   CustomEvent/PointMenu 브리지 패턴만 쓴다.
5. **문서 플레인 보존.** PDC 문서 행 메뉴는 열기·복사까지. 변환/삭제/수리 항목은
   금지(portable-document-contract 게이트). 구현 착수 시 해당 skill을 먼저 로드한다.
6. **메뉴를 줄 곳은 안 준다.** 유일한 어포던스가 "이동"뿐인 고정 셀과, 모든 액션이
   이미 보이는 버튼으로 존재하는 패널은 no-op을 유지한다(§5).

## 3. 표면별 설계

### 3.1 사이드바 (P0 — 사용자 증상 직접 해소)

**쿼리 행** — 우클릭을 ⋯ 메뉴와 동일하게. 항목: 열기 / 이름 변경 / ─ / 삭제(2단 아님,
기존 `deleteQuery` 그대로). `BtnMenuItem`과 `CtxItem`은 다른 래퍼이므로 항목을
데이터 배열로 한 번 정의하고 두 래퍼가 각자 렌더한다 (`Sidebar.tsx:516-542`).

**할 일 패널 행** (`TasksPanel.tsx:213+`) — 새 `TaskRowCtxMenu`:
노트 열기(`useOpenTask` 재사용) / 완료·미완료 토글(`useTaskToggle`) / ─ / 텍스트 복사.
삭제 항목 없음 — 패널은 최소 유지 철학이고 삭제는 할 일 베이스 뷰 소유.

**최근 항목 팝오버 항목** (`Sidebar.tsx:668-676`) — `NoteCtxMenu` 재사용.
노트 액션 핸들러(즐겨찾기/이동/복사/삭제)는 `CardGrid`가 이미 소유하므로
CardGrid→Sidebar로 props 전달 한 번 추가. 팝오버 안 `CtxRoot` 중첩은 포털이라 충돌 없음.

**사이드바 빈 공간** — `motion.aside` 내용을 `CtxRoot/CtxTrigger`로 감싸 생성 메뉴:
새 노트(마크다운) / 새 폴더 / ─ / 새 쿼리. 새 노트는 CardGrid의 `requestAdd`를
콜백 props로 위임, 새 폴더는 CardGrid의 낙관적 생성 흐름(`CardGrid.tsx:787-824`)을
공용 훅으로 추출해 볼트 루트에 생성, 새 쿼리는 기존 `createQuery` 재사용.

**FAVORITES 셀·LOCATIONS 시스템 위치 셀** — 메뉴 없음 유지(§5). 위 배경 메뉴가
같은 영역의 여백 우클릭을 담당한다.

### 3.2 노트 표면 일관성 (P1 — 중복 제거의 최대 지점)

`NoteCtxMenu`는 "모든 노트 표면이 동일 메뉴"라는 원칙(Task 12)으로 만들어졌으나
실제로는 3개 뷰에만 붙어 있다. 나머지에 동일 메뉴를 붙인다:

| 표면 | 작업 | 근거 |
|---|---|---|
| `views/TableView.tsx` 노트/태스크 행 | CtxRoot 래핑 + `NoteCtxMenu` (태스크 행은 §3.1 TaskRowCtxMenu) | 행 렌더 :301+, `onToggleFavorite` 등 props 존재 |
| `views/BoardView.tsx` 칸반 카드 | 동일 | `BoardCard` :300+, `onSelect`/`updateMemo` 존재 |
| `views/CalendarView.tsx` 일자 셀 노트 버튼 | 동일 (콜백 props 전달 필요) | :224-233 |
| `MemoDetail.tsx` 시트 헤더 | 열린 노트에 `NoteCtxMenu` (헤더/폴더 표시 위) | `MemoDetail.tsx:492-580`, CardGrid가 콜백 소유 |
| `BreadcrumbBar.tsx` 경로 세그먼트 | `FolderCtxMenu` 재사용 (열기/이름 변경/고정/2단 삭제) | 세그먼트=폴더 경로, `SegmentButton` |

### 3.3 텍스트 입력 누락분 (P2 — 기계적 일관성 수정)

`TextCtxMenu`이 붙지 않은 편집 위젯에 동일 메뉴 추가:

- `PdcView.tsx` SourceViewer input/textarea, CreateDocumentForm 입력 (:140,146 부근)
- `SpacePicker.tsx` 이름 input
- `FilterBuilder.tsx` 값 input
- `MetadataAddDialog.tsx` 검색 input

### 3.4 새 기능성 메뉴 (P3 — 별도 승인 권장, 새 액션 구현 포함)

| 표면 | 메뉴 항목 | 비고 |
|---|---|---|
| `PropertyPanel.tsx` 속성 행 | 값 복사 / 이름 복사 / ─ / 속성 제거 | 제거는 기존 X 핸들러 재사용. 값 복사가 실질 신규 가치 |
| `BaseView.tsx` 뷰 탭 | 이름 변경(인라인) / ─ / 뷰 삭제(2단 arm) | 뷰 rename/delete은 미구현 — `saveYaml`/`addView`(:240,250) 확장 필요 |
| `CopilotPanel.tsx` 대화 엔트리 | 복사 / 재시도(user·error, `onRetry` 재사용) / ─ / 대화 초기화(2단) | `resetCopilotChat` 존재 |
| `CopilotComposer.tsx` 컨텍스트 칩 | 노트 열기 / 참조 제거 | `attachNote`/`openMemo`(:215-245) 재사용 |

### 3.5 의도적 no-op (문서화 후 유지)

- FAVORITES 고정 셀(모든 메모/즐겨찾기/갤러리/PDC 문서), LOCATIONS 시스템 셀 —
  유일한 어포던스가 탐색뿐. 관리 가능한 상태가 없다.
- `CommandPalette` 결과 행 — Esc 해제되는 트랜지언트 팔레트. 메뉴 부착이 패턴을 해친다.
- `SessionRecorderPanel` — 모든 액션이 이미 가시 버튼(`sessionReviewAccept` 등).
  메뉴는 중복이며 가치 없음.
- `FilterBuilder` 조건 행 — 제거 × 버튼 존재.
- `HtmlPreview` 위키링크 — sandboxed iframe 내부. 브리지 비용 대비 가치 낮음(읽기 표면).
  필요해지면 `oximemo:image-menu`와 같은 postMessage 브리지로만 추가.

## 4. i18n (ko.ts / en.ts 동시 추가)

기존 키 재사용: `folder_open`, `rename_folder`, `folder_unpin`, `delete_confirm_arm`,
`delete_folder_action`, `query_rename`, `query_delete`, `query_new`,
`action_favorite/unfavorite`, `action_move_folder`, `action_copy_body`,
`action_copy_id`, `action_delete`, `tag_menu_*`.

신규 키(안): `task_menu_open`, `task_menu_done`, `task_menu_undone`,
`task_menu_copy_text`, `property_menu_copy_name`, `property_menu_copy_value`,
`property_menu_remove`, `copilot_menu_copy`, `copilot_menu_retry`,
`copilot_menu_clear`, `view_menu_rename`, `view_menu_delete`,
`sidebar_new_note`, `sidebar_new_folder` (폴더/쿼리 생성 라벨은 기존 키 확인 후 정리).

## 5. 구현 단계

| 단계 | 내용 | 주요 파일 |
|---|---|---|
| P0 | 쿼리 행 우클릭, 사이드바 배경 생성 메뉴, 최근 항목 메뉴, 할 일 행 메뉴 | `Sidebar.tsx`, `TasksPanel.tsx`, `CardGrid.tsx`(콜백 전달·훅 추출) |
| P1 | TableView/BoardView/CalendarView/MemoDetail/BreadcrumbBar에 오브젝트 메뉴 재사용 | `views/*.tsx`, `MemoDetail.tsx`, `BreadcrumbBar.tsx` |
| P2 | TextCtxMenu 누락 4곳 | `PdcView.tsx`, `SpacePicker.tsx`, `FilterBuilder.tsx`, `MetadataAddDialog.tsx` |
| P3 | 속성 행·뷰 탭·Copilot 메뉴(새 액션 포함) | `PropertyPanel.tsx`, `BaseView.tsx`, `CopilotPanel.tsx`, `CopilotComposer.tsx` |

공통 주의: 메뉴 아이템 클릭이 트리거의 onClick으로 버블링되지 않도록 기존
`CtxMenu`의 `stopPropagation` 유지(`ContextMenu.tsx:50`), 삭제류는 기존 2단 arm,
i18n은 ko/en 동시.

## 6. 검증 계획

- 단계마다 `bun run typecheck` + 해당 컴포넌트 기존 테스트.
- 실제 서피스 확인: `tauri dev` 또는 qa 프리뷰에서 P0 항목 우클릭 동작
  (쿼리 행/빈 공간/최근 항목/할 일 행) — 스크린샷 증적.
- 중첩 트리거 회귀: 사이드바 폴더 핀·태그 칩의 기존 메뉴가 배경 메뉴 추가 후에도
  정상 열림/단독 동작하는지 확인.
- PDC 건드리는 P1/P3 작업 전 `portable-document-contract` skill 로드.
