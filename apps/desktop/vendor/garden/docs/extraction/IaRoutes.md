# OpenAI Codex 데스크톱 앱 (app.asar v26.917.71314) — 정보 구조·내비게이션 역설계

> 산출물: 화면/패널 계층도 + 라우트 목록 + 근거. 대상은 데스크톱 앱 번들만(TUI 제외).
> 표기 규칙: **[실측]** = 번들 문자열/코드에서 직접 인용. **[추정]** = 실측 근거로부터의 해석.
> 모든 경로는 `/tmp/codex-ux/extracted/` 기준.

---

## 1. 요약 [실측 종합]

- 셸은 Electron 다중 창 앱. **"기본(primary) 창 다중 생성 + 탭"** 모델: 메인 프로세스 WindowManager가 `primaryWindows=new Set`, `lastActivePrimaryWindow`, `primaryWindowChangedHandlers`를 유지 (`.vite/build/main-C-Mhak1n.js:1613`).
- URL 라우팅보다 **창 → 탭 → 패널 상태 기반 내비게이션**이 핵심. 라우터 상태에 `routeKind`가 존재하고(`local-thread` 실측), 탭마다 route 체크포인트를 저장·복원한다(`unrestored-thread-tab-route-*.js`, `thread-tab-route-checkpoint-*.js`).
- 전체 커맨드 표면은 커맨드 팔레트 + 네이티브 앱 메뉴가 하나의 커맨드 레지스트리를 공유한다. `main-C-Mhak1n.js:1559`가 커맨드 ID → electron 메뉴 매핑(`electron.appMenu.file.newWindow` 등)을 수행하고, 레지스트리 각 항목은 `titleIntlId`, `electron.menuTitle`을 가짐(`main-C-Mhak1n.js:1559`의 `n.Ft.flatMap(...)`). 실측된 커맨드 전체 목록은 §5.

---

## 2. 창(Window) 계층 — 다중 창 시맨틱

### 2.1 창 종류
| 창 | 근거 |
|---|---|
| **기본(primary) 창, 복수 허용** | `main-C-Mhak1n.js:1613` — `primaryWindows=new Set; primaryWindowLastActiveAtMs=new WeakMap; lastActivePrimaryWindow=null; lastNotifiedPrimaryWindow=...; primaryWindowChangedHandlers` [실측] |
| **분리(detached) 창** | `webview/detached-window.html` (별도 HTML 엔트리, `detachedWindow-1eedcac94c8e.js` → `initializeDetachedWindow()`, `pagehide` 시 dispose) [실측]. 렌더러 TitleBar에 `alwaysOnTop`, `pin`, `statusContent`, `onSetAlwaysOnTop` 프로ップ → **항상 위 고정(pin) 기능 창** (`entry-d8508ad25dff.js:1`) [실측] |
| **브라우저 댓글 팝업 창** | `app-shared-7b9edc1bfb7f.js:217` — `codex-renderer-window:` 접두사 + `JR={BROWSER_COMMENT_POPUP:'browserCommentPopup'}`, 창 식별자 = `codex-renderer-window:browserCommentPopup:{conversationId\0browserTabId}:{sessionId}` [실측] |
| **Quick Chat(핫키) 창** | `main-C-Mhak1n.js:109` — `focusQuickChat`, `previousQuickChatApplication/Window` 복원 로직 [실측]. 렌더러 페이지 청크 `hotkey-window-new-thread-page-*.js`, `hotkey-window-thread-page-*.js`, `use-hotkey-window-detail-layout-*.js` [실측 → 핫키 창은 "새 쓰레드 페이지 / 기존 쓰레드 페이지" 2종을 가짐] |
| **About 대화상자 창** | `main-C-Mhak1n.js:1446-1447` — 고정 크기(`resizable:!1,minimizable:!1,maximizable:!1,fullscreenable:!1,autoHideMenuBar:!0`), `parent` 지정 및 조건부 `modal:!0`인 `new BrowserWindow` [실측] |
| **디버그 창** | `main-C-Mhak1n.js:709` — `debugWindowManager` 필드 [실측] |

### 2.2 창 생성/메뉴 시맨틱
- 앱 메뉴: `electron.appMenu.file.newWindow`(새 창), `view.reloadWindow`, `view.toggleFullScreen`, `view.actualSize`, `window.bringAllToFront/minimize/zoom`, `app.quit/hide/hideOthers`, `help.systemStatus/taskManager/troubleshooting`, `trace.start/stop`(성능 추적) — `native-menu-locales/ko-KR.json` [실측]. Windows용 별도 메뉴 바 문자열 `windowsMenuBar.file/edit/view/help` 동일 파일 [실측].
- 커맨드 기반 창 조작: `codex.command.openThreadInNewWindow`(새 창에서 열기), `closeTab`/`closeWindow`이 **동일 커맨드 ID** `codex.tabs.contextMenu.close` 공유 → 탭 닫기와 창 닫기가 동일 시맨틱으로 취급됨 (`main-C-Mhak1n.js:1559` `g7={closeTab:..., closeWindow:..., newWindow:'electron.appMenu.file.newWindow', ...}` + ko-KR.json `codex.commandMenuTitle.closeTab/closeWindow`) [실측].
- 종료 확인: 활성 로컬 채팅·워크트리 작업·예약 작업 유무에 따라 `desktop.quitConfirmation.*` 변형 메시지 (ko-KR.json) [실측].

---

## 3. 메인 윈도우 화면/패널 계층도

```
[Primary Window] (index.html 엔트리; 제목 "ChatGPT", CSP에 codex-sandbox:// 프레임 허용 — webview/index.html) [실측]
├─ 앱 헤더(appHeader): 업데이트 설치 확인 다이얼로그(appHeader.installUpdate.*) — ko-KR.json [실측]
├─ [좌] 사이드바 (toggle: codex.command.toggleSidebar)
│   ├─ 새 채팅 / 검색 / 라이브러리 / 태스크 / 프로젝트 진입 아이콘
│   │    (sidebar-new-chat-icon / sidebar-search-icon / sidebar-library-icon / sidebar-tasks-icon /
│   │     sidebar-projects-icon / sidebar-plugins-icon / sidebar-more-icon 청크) [실측: 파일명]
│   ├─ 프로젝트→쓰레드 트리 (§4 참조)
│   ├─ 사용량 알림 위젯 (sidebarElectron.usageAlert.* — 진행 바, 리셋 시각, 소유자 통지) fr-CA 로케일 [실측]
│   ├─ 온보딩 체크리스트 (sidebar-onboarding-checklist(.electron)-*.js) [실측: 파일명]
│   └─ 도움말: sidebarHelp.whatsNew(새로운 기능) — ko-KR.json [실측]
├─ [중앙] 탭 영역 (탭 = 라우트, §6)
│   ├─ Home (HomeComposerRoute / kind==='home'): 히어로(codex-home-hero-*), 제안 카드(home-suggestion-*),
│   │    비콘 공지(codex-app-home-beacon-announcement-*) [실측: 청크명 + app-primary:66 kind==='home']
│   ├─ Thread 탭 (routeKind==='local-thread' 등): 대화 타임라인(af.timelineTurn 셀렉터, app-initial:1641),
│   │    composer(plan/fast/worktree/cloud 전환 — codex.commandDescription.composer.* es-419 로케일) [실측]
│   ├─ Browser 탭 (codex.command.openBrowserTab): 주소창 포커스 커맨드, 뒤/앞/새로고침/검사/외부 브라우저,
│   │    탭 컨텍스트 메뉴, 줌 배너, 로드 에러 페이지(DNS/프록시/방화벽/인증서) — browserSidebar.* ko-KR.json [실측]
│   │    하위 청크: browser-*.js, webview-page-*.js, tab-input-*.js, cloud-browser-side-panel-*.js [실측: 파일명]
│   ├─ Review/PR 탭 (pull-request-route, security-route): 파일 트리 사이드 페인(review-file-tree-side-pane),
│   │    파일 소스 브라우저 파일트리 토글(review.fileSource.browser.toggleFileTree), diff/코멘트/커밋/PR 생성
│   │    (localConversationPage.createPullRequest*, review.commit.* — da-DK/es-419 로케일) [실측]
│   └─ 탭 전환: thread1~thread9(⌘1-9 계열), nextThread/previousThread, searchChats(채팅 전환…) — ko-KR.json [실측]
├─ [우] 스레드 사이드 패널 (thread-side-panel-tabs-*.js, toggleThreadSidePanel — thread-right-panel-state-*.js:1) [실측]
│   ├─ 탭 프레임: side-panel-tab-frame-*.js [실측: 파일명]
│   ├─ 탭 종류(청크명 실측): MCP 앱(thread-mcp-app-side-panel-tab), Automation(automation-side-panel-tab),
│   │    클라우드 브라우저(cloud-browser-side-panel), 소스(open-sources-side-panel-tab,
│   │    open-local-conversation-sources-side-panel-tab), 이미지(image-side-panel),
│   │    PR 코드(open-thread-pull-request-side-panel-tab / -code-tab), 목표(thread-goal-side-panel-content)
│   └─ 확장 패널 product surface: CODEX_EXPANDED_SIDE_PANEL_PRODUCT_SURFACE_WORK / _CHAT (app-primary:66) [실측]
├─ [하] 바텀 패널 (toggle: codex.command.toggleBottomPanel / toggleTerminal)
│   ├─ 터미널(terminal-panel-*.js, terminal-tab-*.js, xterm-output-panel-*.js, shell-label-*.js) [실측: 파일명]
│   ├─ 패널 자체도 탭 구조: activateThreadPanelTab / getThreadPanelTabController (thread-panel-state-*.js:1) [실측]
│   └─ 토글 버튼(thread-panel-toggle-button-*.js/.css), 레이아웃(pane-layout-*.js) [실측: 파일명]
└─ [오버레이/부유] 펫(Pet): codex.command.openPetOverlay, desktop.remoteHostedPIP.*(
    화면 속 PiP ⇄ 펫 전환) — ko-KR.json [실측], codex-pet-assets-*.js [실측: 파일명]
```

참고: 별도 대화상자/페이지 성 청크 — `delete-thread-dialog`, `codex-thread-report-dialog`, `create-project-dialog`, `share-dialog`, `app-connect-modal`, `codex-mobile-setup-dialog`, `permission-denied-dialog`, `voice-personalization-dialog` 등 [실측: 파일명].

---

## 4. 사이드바 트리 모델

**[실측] 근거와 조합된 모델 [일부 추정]:**

```
사이드바
├─ (새 채팅 / 검색 / 라이브러리 등 고정 진입)      [실측: 아이콘 청크명]
├─ 프로젝트(Projects) = 폴더/리포지토리 단위
│   ├─ 프로젝트 목록 셀렉터: af.sidebarProjectList  — app-initial-51da50e6c6e3.js:1641 [실측]
│   ├─ 프로젝트 생성: create-project-dialog-*.js + codex.command.openFolder(폴더 열기…) [실측]
│   ├─ 프로젝트 안 쓰레드 항목 속성: isPinned, pinnedBeforeThreadId(핀 순서 보존), label,
│   │    labelEdited, needsAttention, conversationStartResult — main-C-Mhak1n.js:1091 updateMetadata [실측]
│   └─ 프로젝트별 워크트리/로컬 환경(settings.localEnvironments.environment.* — "이 프로젝트에 아직
│        구성된 로컬 환경이 없습니다", da-DK 로케일:4) [실측]
├─ 핀(Pin): codex.command.toggleThreadPin(채팅 고정/고정 해제), togglePinnedSummary(고정된 요약) [실측]
├─ 보관(Archive): codex.command.archiveThread(채팅 보관) [실측]
├─ 임시/독립 채팅 2종:
│   ├─ codex.command.temporaryChat (새 임시 채팅) [실측]
│   └─ codex.command.newProjectlessTask (새 독립형 채팅) [실측] — 프로젝트 없는 출력 디렉터리 개념
│        projectlessOutputDirectory — conversation-blocks-3f59e850f9fb.js:10 [실측]
└─ 쓰레드 조작: renameThread(sidebarElectron.renameThread), delete-thread-dialog, 검색(searchChats) [실측]
```

- 쓰레드 식별 체계: `hostId + conversationId(threadId) + turnId` 구독 키 — app-initial:1792 (`subscribe({type:'thread',key:{hostId,threadId}...})`, `{type:'turn',key:{...,entityKey}}`) [실측].
- 대화(작업) 대상 타입 3종: `local` / `worktree` / `cloud` — app-primary-d66705000d76.js:119 (`K.type===`local`||K.type===`worktree``, `K.type===`cloud``) [실측]. 라우트 종류도 이에 대응하는 `routeKind:'local-thread'` 존재 [실측, artifact-originating-turn-*.js:1].
- 실행 위치 전환: composer에서 `codex.commandDescription.composer.toggleWorkRunLocation`(ChatGPT Work 클라우드↔로컬 실행 전환), `toggleWorktreeMode` — es-419 로케일:2 [실측].

---

## 5. 내비게이션 커맨드 인벤토리 (커맨드 팔레트 = 앱 메뉴 공유)

출처: `native-menu-locales/ko-KR.json`(전 수집, key = 커맨드 ID) + `main-C-Mhak1n.js:1559`. **[실측]**

| 그룹 | 커맨드 ID → 한국어 라벨 |
|---|---|
| 생성 | `newThread` 새 채팅 · `newProjectlessTask` 새 독립형 채팅 · `temporaryChat` 새 임시 채팅 · `openBrowserTab` 브라우저 탭 열기 · `openFolder` 폴더 열기 |
| 창/탭 | `openThreadInNewWindow` 새 창에서 열기 · `closeTab`/`closeWindow`(동일 ID `codex.tabs.contextMenu.close`) · `thread1..thread9` 채팅 N로 이동 · `nextThread`/`previousThread` · `searchChats` 채팅 전환 |
| 패널 토글 | `toggleSidebar` · `toggleBottomPanel` · `toggleTerminal` · `toggleReviewPanel` · `toggleFileTreePanel` · `togglePinnedSummary` |
| 이동/찾기 | `navigateBack`/`navigateForward` · `navigateBrowserBack`/`navigateBrowserForward` · `focusBrowserAddressBar` · `findInThread`(스레드 내 찾기, `codex.threadFindBar.next/previousResult`) · `searchFiles`(파일 검색) |
| 스레드 조작 | `archiveThread` · `toggleThreadPin` · `renameThread` · `copyConversationPath` · `copyDeeplink`(딥링크 복사) · `copyWorkingDirectory` · `threadHeader.copySessionId` |
| 브라우저 | `reloadBrowserPage`/`hardReloadBrowserPage` · `thread.browser.reload` · `browserSidebar.contextMenu.*`(뒤로/앞으로/다시 로드/검사/새 탭에서 링크 열기/외부 브라우저에서 열기/댓글 달기) · zoom 배너 |
| 앱 | `settings` · `showKeyboardShortcuts` · `openCommandMenu` · `logOut` · `openPetOverlay` · `composer.startDictation` · `toggleTraceRecording`(성능 추적) |
| composer 부속(es-419 로케일에서 실측) | `composer.togglePlanMode` · `composer.toggleFastMode` · `composer.toggleWorktreeMode` · `composer.toggleWorkRunLocation` · `composer.submitInBackground` |

설정 진입 구조: 설정 페이지는 **검색 인덱스**를 가짐(`_virtual_settings-search-documents-*.js`, 페이지별 문서 묶음 `t={account:[...], ...}`) [실측]. 실측된 설정 네비 ID: `settings.nav.browser-use`(브라우저) — ko-KR.json [실측]. 설정 섹션 흔적(locale ID 접두사, 다국어 카탈로그에서 실측): `settings.agent.*`(권한 모드 fullAccess, 속도, 의존성 진단), `settings.agentEnvironment`, `settings.localEnvironments.*`, `settings.remoteConnections.*`(원격 제어 기기 페어링 포함), `settings.usage.*`(사용량/크레딧/상위 채팅), `settings.import.*`(가져오기 자동 동기화), `security.findingReview.*`(보안 스캔 결과 상세) — bs-BA:4-5, da-DK:4, fr-FR:2, fa:10-11, fr-CA:2. 설정 페이지 청크: `worktrees-settings-page`, `hooks-settings-route`, `pets-settings-route`, `chatgpt-personalization-route`, `browser-use-settings`, `codex-micro-settings` [실측: 파일명].

---

## 6. 라우트 목록

### 6.1 라우트 컴포넌트 청크 (라우트 = 지연 로드 모듈) [실측: 파일명·export]
| 청크 | export(실측) | 의미 [추정] |
|---|---|---|
| `authed-route-6fd5c2ed960f.js` | `AppLayoutRoute`, `AuthedRoute`(from app-primary) | 인증 후 셸 레이아웃 루트 |
| `home-composer-route-a340373310ac.js` | `HomeComposerRoute` | 홈(컴포저 우선) 화면 |
| `login-route-cd4402eba474.js` | — | 로그인 |
| `login-handoff-page`, `magic-link-page`, `verify-age-page`, `app-connect-oauth-callback-page` | 각 page 청크 | 인증 플로우 페이지들(쿼리 `callback_path`/`next` 사용 — magic-link-page:1) |
| `settings-route-state-de5cb00d62ce.js` | settings 라우트 상태 파서: `workspaceRoot`, `securitySubviewHasParent`, `returnToPreviousHistoryEntry`, `passkeyEnrollmentCompleted`, `pepperOnboardingPersonalization` | 설정은 서브뷰/이력 복원 상태를 가짐 |
| `security-route-a9075c0a0fdd.js` | — | 보안 스캔 화면 |
| `pull-request-route-97e9806193a2.js` | — | PR 리뷰 화면 |
| `library-file-route-94f52659f7e0.js` | — | 라이브러리 파일 |
| `shared-task-route-f3f90508dd5e.js` | — | 공유 작업 |
| `appgen-site-detail-route`, `appgen-publication-terms-route`, `site-edit-route` | — | 앱/사이트 제너레이션 |
| `unrestored-thread-tab-route-a2c0a461cb92.js` | props `routeKind`, `routeResourceLabel`, 메시지 `threadTabRoute.unrestored.dismiss/.routeKind` | **세션 복원 실패 탭** 처리 → 탭=라우트 모델 재확인 |
| `thread-tab-route-checkpoint-5cbbb4add2f7.js` | `captureThreadTabRouteCheckpoint`(from app-primary) | 탭 라우트 체크포인트 캡처 |

### 6.2 라우트 상태 모델 [실측]
- 라우트 값에 `kind` 필드: `Pe.kind==='home'` — app-primary:66 [실측].
- 라우트 값에 `routeKind` 필드: `routeKind==='local-thread'`(대화 ID 결합) — artifact-originating-turn:1, codex-analytics-attribution:1 [실측]. 그 외 routeKind 리터럴은 검색 창(4MB) 내 미확인 — 전체 열거 불가로 명시.
- 라우트 이동 옵션에 `navigation:'background'`(백그라운드 열기) 존재 — app-primary:66 `s?.navigation===\`backg...\`` [실측].
- 네비게이션 차단기 존재: `use-navigation-blocker-*.js` 청크 [실측: 파일명]. 뷰 상태 영속화: `view-state-persistence-*.js` [실측: 파일명].

### 6.3 URL 경로 문자열에 대하여
`path:"/..."` / ``path:`/...` `` 형태의 라우트 경로 정의는 app-primary(2.2MB), app-shared(3.7MB) 전체와 app-initial 앞 4MB에서 부재(react-router 라이브러리 내부 오류 메시지 `<Route path=...>`, `useRoutes(routes, location)` 만 확인 — app-initial:1639). **[추정]** 앱 셸 내비게이션은 URL 경로가 아니라 창/탭/라우트 상태 객체 기반이며, 외부 진입은 `codex://` 딥링크로 담당:
- `codex://review?pr=PR_URL&path=FILE_PATH&line=LINE&side=right|left` — 에이전트 시스템 프롬프트에 문서화 (.vite/build/src-DldfpmrL.js:749, worker.js:444) [실측]. 커맨드 `copyDeeplink` [실측]. 커스텀 스킴 샌드박스 `codex-sandbox://*.web-sandbox.oaiusercontent.com` — webview/index.html CSP [실측].

---

## 7. 워크스페이스/폴더 개념

- **워크스페이스 루트**: 기본 `~/Documents/Codex` (`sUe({configuredWorkspaceRoot,homeDirectory,path}) → path.join(home,'Documents','Codex')`) — app-shared:277 [실측]. 라우트/설정 상태에 `workspaceRoot` 보관 — settings-route-state:1 [실측].
- **프로젝트 = 폴더/리포지토리**: 대상 직렬화 `{target:{type:'project', project_id}, compatibility_cwds, execution_environment, local_environment_config_path}` — main-C-Mhak1n.js:574 [실측].
- **워크트리**: git worktree 1급 시민. 생성 `create-worktree`(`worktreesRoot` 설정, `upstreamRefreshMode` 설정키, `operationSource:'worktree_pending_create'`) — main:1092 [실측]; 정리 사유 enum `worktree_settings_delete / worktree_archive_cleanup / worktree_auto_cleanup / worktree_new_branch_cleanup` — main:1093 [실측]; 청크군 `worktree-environment-dropdown`, `worktree-onboarding-*`, `worktree-setup-auto-fix` [실측: 파일명].
- **원격**: SSH 호스트 접속(`runRemoteLoginShellCommand`, `codex --version` 프로브) — main:571-572 [실측]; 설정 `settings.remoteConnections.*`(이 Mac을 제어할 수 있는 기기/SSH 연결별 기기 목록) — fr-FR:2 [실측]; 클라우드 대상 `K.type==='cloud'` — app-primary:119 [실측].
- **기타 입력 원**: 컴퓨터 히스토리(`computer-history-*`), 원격 작업공간 설정 오류 메시지(`ChatGPT couldn't finish remote setup`) — main:99 [실측].

---

## 8. 근거 파일 인덱스 (재검증용)

| 근거 | 위치 |
|---|---|
| 커맨드 카탈로그(한국어, 전체) | native-menu-locales/ko-KR.json |
| 커맨드 ID↔메뉴 매핑, 탭/창 닫기 동일화 | .vite/build/main-C-Mhak1n.js:1559 |
| WindowManager(다중 primary 창) | .vite/build/main-C-Mhak1n.js:1613 |
| About 모달 BrowserWindow | .vite/build/main-C-Mhak1n.js:1446-1447 |
| Quick Chat 창 포커스 | .vite/build/main-C-Mhak1n.js:109 |
| 워크트리 항목 상태(isPinned 등) | .vite/build/main-C-Mhak1n.js:1091-1093 |
| 프로젝트 타깃 직렬화 | .vite/build/main-C-Mhak1n.js:574 |
| 렌더러 팝업 창 식별자 | webview/assets/app-shared-7b9edc1bfb7f.js:217 |
| 기본 워크스페이스 루트/`new-chat` 슬러그 | webview/assets/app-shared-7b9edc1bfb7f.js:277 |
| react-router 존재, sidebarProjectList 셀렉터 | webview/assets/app-initial-51da50e6c6e3.js:1639, 1641 |
| home kind, 확장 패널 surface, background 내비 | webview/assets/app-primary-d66705000d76.js:66 |
| local/worktree/cloud 타깃 | webview/assets/app-primary-d66705000d76.js:119 |
| routeKind 'local-thread' | webview/assets/artifact-originating-turn-1e474bff8fcc.js:1, codex-analytics-attribution-42c546370ade.js:1 |
| 탭 라우트 복원/체크포인트 | unrestored-thread-tab-route-a2c0a461cb92.js:1, thread-tab-route-checkpoint-5cbbb4add2f7.js:1 |
| detached 창 + TitleBar pin/alwaysOnTop | webview/detached-window.html, detachedWindow-1eedcac94c8e.js:1, entry-d8508ad25dff.js:1 |
| codex://review 딥링크 스펙 | .vite/build/src-DldfpmrL.js:749, worker.js:444 |
| 설정 검색 인덱스(페이지별 묶음) | webview/assets/_virtual_settings-search-documents-d81257e4909b.js |
| 설정 섹션 locale 흔적 | bs-BA-*.js:4-5, da-DK-*.js:4, fr-FR-*.js:2, fr-CA-*.js:2, fa-*.js:10-11, es-419-*.js:2-3 |

### 한계 명시
- app-initial(11MB)은 정적 grep이 앞 4MB만 커버 → 후반부의 라우트 테이블/사이드바 렌더러 코드는 미검증. `routeKind` 전체 enum, 사이드바 섹션 헤더 문자열, 설정 네비 전체 목록은 **미완전 열거**로 기록함.
- URL path 문자열 미발견은 "부재의 실측"이지 "URL 라우팅 없음의 증명"이 아님(§6.3 참조).