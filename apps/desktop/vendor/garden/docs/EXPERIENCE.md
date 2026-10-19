# Garden UI — Experience (Codex 데스크톱 UX 추출)

Codex 데스크톱 앱의 **경험 설계(UX)** — IA, 플로우, 상태 머신, 키보드·포커스,
피드백 — 를 app.asar 정적 분석 + 실행 앱 실측으로 추출한 문서. 비주얼 토큰은
`DESIGN.md`, 컴포넌트 배리언트 계약은 `PARITY.md`가 담당한다. 이 문서는
"언제, 무엇이, 어떻게 동작하는가"의 원전이다.

## 0. Provenance

- **소스**: `/Applications/ChatGPT.app` v26.917.71314 — `Contents/Resources/app.asar`
  (`openai-codex-electron`, main `.vite/build/`, webview 청크). TUI(codex-rs)는 범위 밖.
- **방법**: 번역 카탈로그(`native-menu-locales/ko-KR.json`, `webview/assets/ko-KR-*.js`)
  전수 + minified JS 패턴 마이닝(커맨드 레지스트리 `worker.js:462`, 메뉴 매핑
  `main-C-Mhak1n.js:1559`, 전역 핫키 `main:1588` 등 전문 판독).
- **실행 앱 실측**: 포커스 탈취 없는 창 캡처(CGWindowList→`screencapture -l`).
  사이드바·컴포저 하단 바(워크스페이스 칩 "Sandbox", "나 대신 승인" 칩, 모델
  선택기, 원형 전송 버튼) 실측 확인. 스크린샷: 스킬 `codex-design/reference/`.
- **표기**: 근거가 있는 것만 서술. 해석은 `[추정]`, 미검출은 명시. 정적 분석
  상세 보고서 4부(IA/상태머신/키보드/피드백)는 각 절 말단에 요약, 원문은
  `docs/extraction/*.md`.

---

## 1. 정보 구조 (IA)

### 1.1 창 → 탭 → 패널 모델

URL 라우팅이 아니라 **창/탭/패널 상태 객체**로 내비게이션한다 `[실측: 경로
문자열 부재, 탭 라우트 체크포인트 청크 존재]`.

```
Primary Window (복수 허용 — main:1613 primaryWindows:Set)
├─ 사이드바 (⌘B) : 고정 진입(새 채팅·검색·라이브러리·태스크·플러그인·탐색)
│                  + 프로젝트 → 스레드 트리 + 사용량 위젯 + 온보딩 체크리스트
├─ 탭 영역 (탭 = 라우트) : Home · Thread · Browser · Review/PR
├─ 우측 스레드 사이드 패널 : MCP 앱 · Automation · 클라우드 브라우저 · 소스 ·
│                            이미지 · PR 코드 · 목표(goal) 탭
├─ 하단 패널 (⌘J) : 터미널(`` Ctrl+` ``) 등, 패널도 탭 구조
└─ 오버레이 : 펫(Alt+Space), 명령 팔레트(⌘K), 파일 검색(⌘P), 찾기(⌘F)
```

창 종류: primary(복수) · detached(항상 위 pin) · Quick Chat 핫키 창 ·
브라우저 댓글 팝업 · About(고정 크기 modal). **탭 닫기와 창 닫기가 같은
커맨드 ID**(`⌘W`) — 닫기는 탭→앱셸→창 순 폴백.

### 1.2 작업 대상 3종과 프로젝트

- 대상: `local | worktree | cloud` `[실측: app-primary:119]`. 컴포저에서 실행
  위치 전환(로컬↔클라우드, 워크트리 모드)이 1급 칩.
- 프로젝트 = 폴더/리포지토리. 워크스페이스 루트 기본 `~/Documents/Codex`.
  스레드 속성: `isPinned`, `needsAttention`, `label` `[실측: main:1091]`.
- 임시 채팅(⌘⇧N)과 독립형 채팅(⌘⌥O, 프로젝트 없는 출력 디렉터리)이 별개.

### 1.3 커맨드 표면의 통일

커맨드 팔레트(⌘K/⌘⇧P), 네이티브 앱 메뉴, 설정의 단축키 편집기가 **하나의
커맨드 레지스트리**를 공유한다. 각 커맨드: `{id, titleIntlId, shortcutScope,
defaultKeybindings, isOverridableByBrowserWebpage…}` `[실측: worker.js:462]`.
새 UI 액션을 만들 때는 레지스트리 항목(라벨·키·메뉴 그룹)이 1차원 정의이고
메뉴·팔레트·단축키 설정이 이를 소비한다.

---

## 2. 핵심 플로우: 프롬프트 → 턴 → 승인 → 완료

1. **컴포저에서 시작** — 전송 버튼은 입력 없으면 고스트, 있으면 primary
   inverse 원형. 하단 바: `+`(첨부, ⌘U) · 승인 모드 칩("나 대신 승인") ·
   모델 피커(Ctrl+Shift+M) · 마이크 · 전송. 실행 위치 칩(워크스페이스/워크트리/
   클라우드)이 컴포저 상단에 인라인.
2. **턴 실행** — 턴 상태는 `inProgress | completed` 2값 + `error`·`diff`는
   별도 필드 `[실측: app-initial:1793, main:495]`. **failed는 상태가 아니라
   error 필드로 표현**한다.
3. **승인 대응** — 서버가 request로 승인을 요청(`emitApprovalRequest`), 앱은
   전용 decision 메서드로 응답: 커맨드 실행 승인 / 파일 변경 승인 / 권한 요청 /
   사용자 입력 / 옵션 피커 / MCP elicitation `[실측: main:495]`.
   - decision: `accept|decline|cancel` → `accepted|declined|canceled`,
     파싱 실패 `unknown`, **300초 타임아웃 → `timeout`**
     `[실측: main:8, Ure=3e5]`
   - 지속: `_meta.persist: 'always' | 'session'`
   - 카드 액션 스케일: **한 번만 허용 → 이 대화 허용 → 항상 허용 → 거부(+사유)**
     `[실측: approvalRequestCard.*]`. 승인 피로 완화 업셀("나 대신 승인하기",
     자동 승인 시 크레딧 경고)과 자동 검토 통계 표시가 뒤따른다.
   - 권한 요청은 `network` / `fileSystem(read|write|readWrite + paths)`로
     묶어 청킹 제시 `[실측: permission-request-model]`.
4. **완료** — `item/completed(final_answer)` → `turn/complete`. 턴 파라미터에
   `approvalPolicy·approvalsReviewer·sandboxPolicy·model·effort`가 매번 실린다.
5. **중단** — `interruptConversation(mode: system|user-stop|descendant-cleanup)`.
   사용자 정지(⌘. 계열 버튼)는 자손 서브에이전트까지 백그라운드 인터럽트.

### 스트리밍 표현 — 디테일 3단

`conversationDetailMode: STEPS_PROSE | STEPS_COMMANDS | STEPS_EXECUTION`
`[실측: app-shared:277]` — 같은 턴을 산문/커맨드/실행 출력 3단 밀도로 보여주는
정식 UI 상태다. 델타 채널: agentMessage/plan/reasoning/commandExecution
(출력 50ms 플러시, 상단 `[output truncated]` 마커)/fileChange(patchUpdated).
`[실측: main:407]`

### 후속 입력 — queue | steer | interrupt

실행 중 입력 동작은 사용자 설정 enum: 대기(queue) / 스티어(현재 턴에
`steeringUserMessage` 주입) / 인터럽트. 전송 시 `⌘⇧Enter`로 반전.
`[실측: app-shared:277]`

---

## 3. 상태 머신 (요약)

| 머신 | 상태 | 비고 |
|---|---|---|
| 턴 | `inProgress → completed` | error/diff는 필드. failed 상태 없음 |
| 승인 | `requested → accepted/declined/canceled/unknown/timeout` | timeout 300s, persist always/session |
| 후속 입력 | `queue / steer / interrupt` | 설정 enum, ⌘⇧Enter 반전 |
| 골(반복 작업) | `active ⇄ paused` | 시스템 인터럽트 시 자동 pause |
| 받아쓰기 | `recording → completed/cancelled`, 복구 시 `→ interrupted` | surface: composer/global |
| 첨부 | `ready / uploading / error` | |
| 네트워크 | `pending/success/error × idle/fetching/paused` | 오프라인 → paused, 재접속 시 pagination 리셋 |
| 워크트리 | `setting-up → 활성` | 정리 사유 enum 존재 |
| PR 리뷰 | `approved / changes_requested / merged / opened` | |
| 배너 액세스 | `pending/allowed/denied/error` | error 시 onRetry |

TUI식 토큰(`queued`, `in_progress`, `awaiting_approval`, `apply_patch`…)은
데스크톱 번들에 **미검출** — Garden도 데스크톱 어휘를 따른다.

---

## 4. 키보드 · 포커스

### 4.1 키맵 아키텍처

3계층: ① 커맨드 레지스트리(webview/vscode/electron 통합, 중복 ID 가드, 사용자
재할당 zod 스키마) ② Electron 메뉴 가속기(키맵 변경 시 메뉴 재생성) ③ OS 전역
globalShortcut(핫키 창·전역 받아쓰기·펫). 시퀀스(체드) 키는 webview 커맨드만
허용. find/findNext/findPrevious는 재할당 불가 예약.

### 4.2 대표 키맵 `[실측: worker.js:462 / main:1559 / main:1588]`

| 그룹 | 키 |
|---|---|
| 생성 | 새 채팅 ⌘N/⌘⇧O · 임시 ⌘⇧N · 독립형 ⌘⌥O · 브라우저 탭 ⌘T · 폴더 ⌘O |
| 탭/스레드 | 채팅 N ⌘1–9 · 탭 N ⌃1–9(mac) · 다음/이전 ⌘⇧]/[ · 최근 ⌃Tab · 주의 필요 ⌘⌥A |
| 패널 | 사이드바 ⌘B · 하단 ⌘J · 터미널 `` Ctrl+` `` · 파일트리 ⌘⇧E · 리뷰 ⌘⌥B |
| 검색/이동 | 팔레트 ⌘K/⌘⇧P · 파일 ⌘P · 찾기 ⌘F(⌘G/⌘⇧G) · 뒤로/앞으로 ⌘[/⌘] |
| 컴포저 | 백그라운드 전송 ⌘Enter · 받아쓰기 ⌃⇧D · 모델 ⌃⇧M · 첨부 ⌘U |
| **승인** | **승인 Enter · 거부 Escape** |
| 되돌리기 | ⌘Z / ⌘⇧Z (앱 액션 undo 18종 문구 실측) |
| 기타 | 설정 ⌘, · 단축키표 ⌘/ · 모든 읽음 해제 ⇧Escape · 펫 Alt+Space · Appshot DoubleCommand |

### 4.3 Escape 규약 (우선순위)

OS 전역 받아쓰기 취소 → 승인 거부 → 에디터 제안/슬래시 메뉴 → 단축키 캡처 종료
(bare Escape만) → 드래그 취소 → 오버레이(Dialog/Popover) 닫기. IME 조합 중
(`keyCode===229`) Escape 무시 `[실측: app-primary:14]`.

### 4.4 포커스 규칙

- 링: `focus-visible:ring-2` — keyboard-only. 스크롤 컨테이너도 `tabIndex`로
  포커스 가능.
- 오버레이: Radix FocusScope trap + RovingFocusGroup(메뉴·툴바), body 스크롤
  잠금(스크롤바 보상 패딩).
- 앱셸이 `focusArea: main | bottom-panel | right-panel` 상태를 유지하고 패널
  토글·주소창 포커스가 이를 타겟 `[실측: main:1559]`.
- react-aria Dialog: Title/Description을 `sr-only`로라도 제공(접근성 경고 억제).
- dnd: Space 픽업 → 화살표 이동 → Space 드롭 / Escape 취소, 스크린리더 공지.

---

## 5. 피드백 시스템

### 5.1 채널 분배 규칙 (핵심 설계)

| 상황 | 채널 |
|---|---|
| 되돌릴 수 있는 변경(보관·고정·삭제) | **토스트 + undo** — 확인 다이얼로그 대신 실행 후 되돌리기 (`appUndo.*` 18종) |
| 지속 상태 경고(샌드박스·사용량·안전) | **컴포저 위 단일 배너 슬롯** — 우선순위 큐(windows-sandbox → … → dictation-first-use), `role="status"`+`aria-live="polite"`, 영구 dismiss는 플래그 |
| 섹션 데이터 실패 | **인라인 alert + Retry** (`role="alert"` + 경고색 한 줄) |
| 전역 파괴/크래시 | **복구 화면** — 재시작/구성 검토/피드백 3액션 |
| 업데이트 | 진행률 → 설치 확인(세션 중단 고지) → 분/시간/일 재시작 에스컬레이션 → EOL 하드 게이트 |

하나의 화면에 오류 UI를 중첩하지 않는다. 원시 에러 문구는 절대 노출 금지
(안전 폴백 문구가 description에 명시적).

### 5.2 문구 3요소

무엇이 실패했나(짧은 단문) + 무엇이 영향받나(세션 중단 등) + 다음 행동(다시
시도/다른 검색어/재시작). 빈 상태는 "아직 ~가 없습니다" + **예시 프롬프트를
본문에 녹이고** 생성 CTA를 붙인다. 빈 상태와 로드 실패가 같은 슬롯을 공유.

### 5.3 비음성 피드백

- 햅틱: 컴포저 스냅 제스처에 NSHapticFeedbackManager 1 패턴(darwin 한정)
  `[실측: main:1600]`
- 알림음: 작업(펫) 알림 사운드 on/off 토글, 스레드별 음소거
- 라이브 리전: 배너 `role=status`+`polite`, 저장 실패 `role=alert`

---

## 6. Garden 적용 매핑 (갭 표)

| Codex UX 패턴 | Garden 현황 | 조치 |
|---|---|---|
| 승인 카드(한 번만/이 대화/항상/거부+사유, Enter/Escape) | GApprovalCard는 skip/continue 2액션 | **확장**: decision 3종+지속+사유, 키 규약 |
| 턴 상태(2값 + error/diff 필드) | GTaskRow running/completed/failed/pending | failed=error 파생 문서화, pending 유지 |
| 스트리밍 디테일 3단 | GThinkingIndicator 단일 | **TurnStream 구현**(prose\|commands\|execution) |
| undo 토스트 | 없음 | **신규 GToast**(success/warning/danger + action) |
| 컴포저 배너(우선순위 큐) | 없음 | **신규 GBanner**(warning/error + dismiss) |
| 빈 상태(예시 프롬프트+CTA) | 없음 | **신규 GEmptyState** |
| 인라인 오류+Retry | 없음 | **신규 GInlineError** |
| 디프 뷰(green/red 알파 필) | 없음 | **신규 Diff/GDiffView** — 승인 플로우와 짝 |
| 명령 팔레트(⌘K) | 없음 | **신규 CommandMenu/GCommandPalette** |
| 컴포저 하단 바(승인 모드·모델·실행 위치 칩) | GPromptBar 전송 상태만 | **신규 GardenComposer/GComposer** |

신규 컴포넌트는 PARITY.md 배리언트 표에 추가하고 React·SwiftUI 동시 구현한다
(Tier 2 규칙).

---

## 7. 한계

- minified 단일 라인 번들의 grep 창 한계로 app-initial(11MB) 후반부는 미검증 —
  `routeKind` 전체 enum, 사이드바 섹션 문자열 일부는 미완전 열거.
- 토스트 컨테이너 마크업, 알림음 재생 경로, macOS TCC 프롬프트 문자열은 미확인.
- URL 경로 기반 라우팅 부재는 "부재의 실측"이며 deeplink(`codex://review?…`)만
  문자열로 실측됨.
