# Codex 데스크톱 앱(v26.917.71314) — 시스템 피드백·예외 경로 정적 분석 보고

근거 표기: `파일경로:라인 — 스니펫/토큰`. minified 1-line 파일은 커버리지 한계가 있으며(아래 §9), 문자열·코드에서 직접 읽은 것만 **실측**, 그 외는 **[추정]** 명시.

---

## 0. 한눈 요약

앱의 시스템 피드백은 **4개 채널 + 1개 네이티브 계층**으로 구성된다:
1. **토스트** — 전역 스토어 API(`success`/`warning`/`danger`), 에러 토스트는 `errorAnalytics.toastId`로 원격측정 상관. 실행취소(undo) 토스트가 기본 패턴.
2. **배너/공지** — 컴포저 위 단일 슬롯에 우선순위 후보 큐(`windows-sandbox → wsl-migration → full-access → cyber-safety → codex-usage → ultra-usage → misalignment-policy → safety-buffering → dictation-first-use`), `role="status"` + `aria-live="polite"`, 영구 dismiss는 플래그 저장.
3. **인라인 오류 + 재시도** — 섹션 단위 `role="alert"` + Retry 버튼, lazy 청크 재시도(200ms 후 1회 → errorFallback + Sentry), 탭 렌더 에러 바운더리, 크래시 복구 화면.
4. **권한/승인 프롬프트** — 턴 내 승인 카드(한 번만/항상/이 대화 허용·거부+사유), 샌드박스 권한 모델(네트워크/파일시스템 read·write), MCP elicit(accept/decline/cancel), 브라우저 사이트 권한 안내 다이얼로그.
5. **네이티브 계층** — 업데이트 라이프사이클 전체(다운로드 진행률→설치 확인→재시작 카운트다운→EOL 강제), NSHapticFeedbackManager 햅틱(darwin 한정).

---

## 1. 토스트

### 1.1 API 실측 (스토어 시그니처)
- `app-shared-7b9edc1bfb7f.js:286 — eZe().danger(<FormattedMessage id:'clipboard.copyError.title' defaultMessage:'Couldn't copy to clipboard' …>, {errorAnalytics:{toastId:'copy_to_clipboard_failed_to_copy'}, description:<…'The content wasn't copied. Try again while ChatGPT is focused'…>, id:'copy-to-clipboard-error'})`
  - 토스트 = `{title, description, id}` + `errorAnalytics.toastId` → **실패 토스트는 원격측정 ID와 1:1 결합**.
- `plugin-request-empty-state-44bc76026d2c.js — i.get(we).success(…'skills.appsPage.addMarketplace.success' "{marketplaceName} marketplace added")`, `.warning(…'refreshFailed' "{marketplaceName} marketplace is configured, but failed to refresh the plugin list")` — 성공/경고 변조 실측.
- `deferred-verification-banner-e314c15c65cb.js — i.get(_).danger(…, {errorAnalytics:{toastId:'healthcareVerificationPage.workspaceVerificationStartError'}})`
- 성격상 변조 집합은 success/warning/danger가 실측, info는 [추정](호출 흔적 미확보).

### 1.2 문구 사례 (ko-KR 카탈로그 — `webview/assets/ko-KR-b96747fbd4d7.js`, 전문은 artifact://58)
| id | 문구 | 성격 |
|---|---|---|
| `appUndo.threadArchived` | 채팅이 복원되었습니다 | undo 토스트(보관 해제) |
| `appUndo.actionUndone` | 작업 실행 취소됨 | undo 실행 결과 확인 |
| `appUndo.chatPinned` / `chatUnpinned` / `projectRestored` / `queuedMessageDeleted` 등 18종 | 채팅이 고정되었습니다 / 대기열의 메시지가 복원되었습니다 … | 파괴적·상태 변경 액션의 되돌림 피드백 |
| `chatgpt.message_reactions.toast.save_error_short` | 반응을 저장하지 못했습니다 | 실패(짧은 단문) |
| `chatgpt.settings.about_you.correction.toast.noop` | 메모리가 변경되지 않았습니다 | 무효(no-op) 결과 투명화 |
| `chatgpt.beacons.send_prompt.system_hint_rate_limit.toast.title/description.no_reset_details` | {toolName}을(를) 일시적으로 사용할 수 없음 / 사용량 한도가 초기화된 후 다시 시도하세요 | 레이트리밋 |
| `automations.sharing.publisher.toast.unshared` / `.task_share_failed` | 작업 공유를 중지했습니다 / 작업을 공유하는 중 오류가 발생했습니다 | 공유 성공/실패 |
| `apps.enable.success` / `apps.disable.success` | {appName} 앱이 활성화되었습니다 / 비활성화했습니다 | 상태 토글 |
| `appgenShareDialog.copySuccess` | 클립보드에 복사되었습니다 | 복사 성공 |

영문 원문 실측(코드 인라인): `plugin-request-empty-state` — "Plugin request submitted"(성공), `{marketplaceName} is already added`(중복 안내).

### 1.3 설계 특징
- **되돌림 우선**: 파괴 작업은 확인 다이얼로그보다 "실행 + undo 토스트"를 채택(`appUndo.*` 18종이 그 증거).
- 실패 토스트 문구는 "다시 시도" 행동 지시를 포함하는 경향(`Try again…` / `다시 시도하세요`).
- 레이트리밋은 토스트 title+description 2단 구성.

---

## 2. 빈 상태 (Empty State)

### 2.1 컴포넌트 구조 실측
- `compact-empty-state-7d00ecb673ed.js`(전체): `flex w-full flex-col items-center justify-center px-4 py-8 text-center` 래퍼 → 내부 `max-w-72` 컬럼 → **아이콘(`size-8 text-secondary`) → 제목(`text-lg leading-6 font-medium text-default`) → 설명(`text-sm text-secondary`) → 액션 행(`flex-wrap justify-center gap-2`)**. props: `{icon,title,description,actions}`.
- 일러스트 변형: `plugin-request-empty-state-44bc76026d2c.js` 내 `tn({title, description, illustration})` — 로드 에러 시 일러스트 `h-20 w-auto text-tertiary` + `loadErrorTitle` 표시. 즉 **빈 상태와 로드 실패가 동일한 자리를 공유**.
- 제목 길이 제한 헬퍼: `app-shared-7b9edc1bfb7f.js:282 — t.length>36 → 36자 절단 + '…'`(타이틀 트리밍).

### 2.2 문구 사례 (ko-KR 카탈로그)
| 맥락 | 제목 | 본문/액션 |
|---|---|---|
| 사이트 목록 | `appgenPage.empty.title` 아직 사이트가 없습니다 | `…empty.description` "데이터베이스와 로그인 기능이 있는 웹사이트와 앱을 만들어 보세요. '팀 대시보드 만들어줘'…처럼 요청해 보세요" + `…empty.create` 새 사이트 만들기 |
| 분석 이벤트 | `appgenAnalytics.events.emptyTitle` 아직 맞춤 이벤트가 없습니다 | `…emptyDescription` "이 사이트에서 기록한 이벤트가 여기에 표시됩니다" |
| 검색 결과 없음 | `appgenPage.sites.search.empty` 사이트를 찾을 수 없습니다 | `…emptyDescription` **"다른 검색어를 시도해 보세요"** (검색 empty는 다음 행동 제시) |
| 스킬/플러그인 | `browserSkills.empty` 스킬이 없습니다 / `browserPluginSettings.empty` 아직 설치한 플러그인이 없습니다 | — |
| 예약 작업 | `automations.scheduled.empty` 작업 없음 | `automations.editor.latestUpdate.emptyState.title` 사용 가능한 업데이트 없음 |
| 댓글 | `artifactComments.empty` 아직 댓글이 없습니다 | — |
| 헬스 | `HealthV3ChatsPanel.empty` 건강 채팅이 여기에 표시됩니다 | zeroState: `HealthV3AppLinkInvite.zeroState.title/body` |
| Codex 모드 | `chatgpt.codex_mode.empty_state.pet_selection.button.label` Work 펫 선택 | 펫 선택을 빈 상태 CTA로 사용 |
| Explore 피드(Valdi) | `explore_empty_title` 탐색 카드 없음 | `explore_empty_message` "지금은 둘러볼 내용이 없습니다." (`ko-b71b0572ad12.js`) |

패턴: **제목="아직/없음" 단문, 본문=예시 프롬프트 또는 다음 행동, CTA=생성 버튼**. 예시 프롬프트를 본문에 녹이는 것이 이 앱의 특징.

---

## 3. 오류 표면 (Error Boundary / Retry / loadError)

### 3.1 계층별 실측
1. **lazy 청크 로드 실패**: `app-shared-7b9edc1bfb7f.js:286 — function cct(e,{fallback,suspendToParent,errorFallback,propagateLoadError})` — 로드 실패 시 `setTimeout 200ms` 후 **1회 재시도**, 재실패 시 `errorFallback` 렌더 + Sentry(`pZe(...,{tags:{operation:'lazy-component-load'}})`). `composer-banners` 청크는 `{suspendToParent:true, propagateLoadError:true}`로 상위로 전파.
2. **탭 렌더 에러 바운더리**: 카탈로그 `appShell.tabPanelRenderError.title` "탭 내용을 표시할 수 없습니다" + `.retry` "다시 시도".
3. **크래시 복구 전체 화면**: `appServerCrash.recoveryTitle` "ChatGPT에 문제가 발생했습니다" / `recoveryDescription` "문제가 발생했습니다. ChatGPT를 다시 시작해 다시 시도하세요." / 액션 3종: `restartChatGPT`(ChatGPT 다시 시작) · `reviewConfiguration`(구성 검토 + `configurationRecoveryDescription`) · `sendFeedback`(피드백 보내기 + `feedbackGuidance`).
4. **백엔드(Codex CLI) 연결 오류**: `appServer.error.genericRestartRequired` "Codex CLI에 연결하는 중 문제가 발생했습니다. 다시 시작해 보세요" / `loginRequired` / `remoteCodexNotFound` / `unsupportedVersion`({minVersion} 이상으로 업데이트… 현재 버전: {currentVersion}) / `restartAvailable`(재시작으로 업데이트 안내).
5. **인라인 섹션 오류**: `query-error-84d2fab3c467.js`(전체) — billing: `role:"alert"` + `text-sm text-warning` 한 줄에 메시지+Retry 버튼(`settings.consumerBilling.loadError` "Unable to load billing information. Please try again." / `.retry` "Retry").
6. **네트워크 진단 loadError(브라우저 사이드바)**: `browserSidebar.loadError.heading` "이 사이트에 연결할 수 없습니다" + 원인별 summary(DNS/프록시/방화벽/오프라인/타임아웃/연결거부/인증서) + `try` "다음을 시도해 보세요:" 체크리스트 + `reload` 새로고침. (네이티브 카탈로그 `ko-KR.json`에도 동일 키 존재 — 네이티브/웹뷰 카탈로그 공유 실측)
7. **인증 오류 페이지**: `error-page-e95f8806fb0a.js`(전체) — errorCode 스위치(RequestTimeout/AuthRateLimit→"busy", providerMismatch, accountDeactivated, unsupportedRegion, ssoRequired…) + 미지원 코드는 안전 폴백 "Something went wrong while signing you in…"(`description`에 *"no raw provider diagnostic is shown"* 명시) + `role="alert"`, Go back 버튼, 안전 정지 변형 전용 페이지. 표시 시 `ChatgptAuthErrorShown` 분석 이벤트.
8. **부분 실패/재시도 산재 사례**: `appgenPage.partialError` "일부 라이브러리 항목을 불러오지 못했습니다", `artifactTab.xlsxSaveProblem`(+`.retry`), `chatgpt.pythonExecution.retryImage` "이미지를 사용할 수 없음 — 다시 시도", `automations.editor.latestUpdate.loadError/retry`, `beacons.connectApp.loadError.title/description/button.retry/button.cancel`("다시 시도하거나 취소하고 이전 페이지로 돌아가세요"), `chatgpt.profile.v2.showcase.skills.empty` 등.

### 3.2 문구 설계 규칙(실측 일반화)
- 제목 "불러올 수 없습니다/표시할 수 없습니다" + 행동 버튼 "다시 시도"의 2원 조합이 표준.
- 원인 진단 가능한 오류(네트워크/CLI 버전)는 **원인 요약 1줄 + 해결 체크리스트**로 확장.
- raw 에러 노출 금지 폴백이 description에 명시적.

---

## 4. 권한 프롬프트 (permission / allow-deny / sandbox)

### 4.1 턴 내 승인 카드 (ko-KR 카탈로그 실측)
- `approvalRequestCard.allowOnce` **한 번만 허용** / `alwaysAllow` **항상 허용** / `allowConversation` **이 대화 허용** / `deny` **거부** / `reasonLabel` **사유** / `approvalOptions` **승인 옵션**.
- `approvalRequest.autoReviewNudge.*`: `title` "승인 요청을 줄이고 싶으세요?" / `enable` "나 대신 승인하기" / `keepManual` "수동 승인 유지" / `description`(자동 승인 시 크레딧 소비 경고) / `enableFailed` "자동 검토를 활성화하지 못했습니다. 다시 시도하세요" — 승인 피로도 완화 업셀.
- `assistantMessage.autoReviewStats.*`: 자동 검토 결과 표시(승인됨/거부됨, `noRationale` "자동 검토에 사유가 포함되지 않았습니다.", 명령 기록/통계).
- 펫/활동 오버레이 권한 액션 `avatarOverlay.waitingRequest.*`: `allow` 허용, `allowOnce` 이번만 허용, `allowNetwork` 네트워크 허용, `allowTarget` "{target} 허용", `deny` 거부, `updateAccess` 권한 업데이트, `moreAccessTarget` "ChatGPT에 {target} 추가 액세스 필요", 요청 유형 어휘(`fileAccess` 파일 액세스, `networkAccess`, `toolServer` 도구 서버, `connector`, `plugin`, `runCommand`/`reviewCommand` 등).

### 4.2 샌드박스 권한 모델 (코드 실측)
- `permission-request-model-5651a96c7a72.js`(전체): 요청을 `{kind:'network'}` + `{kind:'fileSystem', access:'read'|'write'|'readWrite', paths[]}`로 그룹핑. 특수 경로 토큰: `:minimal`, `:project_roots(/subpath)`, `:tmpdir`, `/tmp`, `/`(root).
- `main-C-Mhak1n.js:8 — function Xt(e){switch(e){case 'accept':…{action,content,_meta}; case 'decline': case 'cancel': {action, content:null…}}}` — MCP elicitation 응답을 accept/decline/cancel로 매핑.
- `main-C-Mhak1n.js:575 — approvalMode, chromeHistoryApprovalMode, iabHistoryApprovalMode, downloadApprovalMode, uploadApprovalMode, allowedOrigins, deniedOrigins` — 브라우저 사용 승인 모드 구성.
- 실행 환경 승격 통제: `main-C-Mhak1n.js:421 — "Do not request escalated permissions or broader sandbox access unless the user explicitly asks…"`(에이전트 지시문 내 샌드박스 정책).
- 실행 코드 승인 아이템 타입: `app-initial-51da50e6c6e3.js:2538 — e.type==='chatgpt-tool-approval' ? 'chatgpt-tool-approval-'+ly(e.messageId)`.
- 샌드박스 프로토콜: `webview/index.html` CSP — `codex-sandbox://*.web-sandbox.oaiusercontent.com`; `app-initial:2541 — /sandbox:[^\s)\]>]+skill\.zip/i`, `:2540 — sandboxPath` 필터.
- 코드 실행 네트워크 승인: 카탈로그 `chatgpt.codeExecution.networkApproval.title` **"네트워크 액세스를 허용할까요?"**.

### 4.3 권한 모드 프리셋 (커넥터/플러그인)
`browserPluginSettings.permission.*`: `alwaysAsk` "항상 묻기"(읽거나 변경하기 전에 묻기) / `read` "읽기 액션 허용"(묻지 않고 읽되, 변경 전에는 확인) / `lowRisk` "위험도가 낮은 액션 허용"(자동 승인, 민감 액션은 거부될 수 있음) / `all` "모든 액션 허용"(위험도가 높습니다 경고 포함) + `defaultPermissionMode`, `resetPermissions` "기본값으로 재설정", `permissionSaveFailed`, 스코프 만료 시 `missingScopes`/`newScopes`(재연결 안내).

### 4.4 시스템/브라우저 권한 안내
- 위치 권한 차단 시: `permission-denied-dialog-d97cccd05f4a.js`(전체) — "Turn on location access" 제목 + "주소창 옆 아이콘에서 사이트 설정 → Location 허용 → 새로고침" 안내(브라우저 권한이 이미 차단된 경우의 복구 다이얼로그).
- 받아쓰기 첫 사용 고지 배너: `composer-banners-92519a56d6b2.js — B('dictation-first-use', …)` 후보 슬롯(마이크 사용 고지 [추정: 문구는 미확보]).
- GPT→플러그인 마이그레이션에서 워크스페이스 권한 부족 시: `notices-dbed4ccd62e0.js — permissionRequired` "Your workspace must allow you to use plugins to migrate this GPT"(비활성 CTA + 툴팁).
- 신원 인증 게이트: `deferred-verification-banner` — "Verify your identity to start chatting" + Verify CTA(로딩 중 disabled), 확인 실패 시 `type:'error'` 배너 + Retry.
- **미확인**: macOS 시스템 권한(마이크/알림 TCC) 프롬프트 문자열은 카탈로그 미확인 영역에 존재 가능(§9).

---

## 5. 업데이트/설치 프롬프트

라이프사이클 전체가 문자열로 실측됨(두 카탈로그에 동일 키 — 네이티브 헤더와 웹뷰가 공유):

| 단계 | 키 | 문구 |
|---|---|---|
| 다운로드 중 | `appHeader.downloadingUpdate` / `downloadingUpdatePercent` | 다운로드 중 / {downloadProgressPercent}% 다운로드 중 |
| 설치 확인 | `appHeader.installUpdate.confirmTitle/confirmSubtitle/confirmInstall/confirmCancel` | 지금 {appName} 업데이트를 설치할까요? / "업데이트를 설치하려면 {appName}을(를) 종료해야 하며, **이 컴퓨터의 활성 로컬 세션이 중단됩니다**" / 업데이트 / 취소 |
| 설치 진행 | `appUpdate.installProgress.title/preparing/percent/subtitle/progressLabel` | 업데이트 설치 중 / 준비 중… / {progressPercent}% / "설치가 끝나면 {appName}이(가) 다시 시작됩니다." |
| 재시작 독려(에스컬레이션) | `appUpdate.relaunchNotice.titleMinutes/titleHours/titleDays/titleNow/body/restartNow` | "{count, plural, one {#분 후}…} 재시작 필요" → "지금 다시 시작해야 합니다" / "업데이트 설치를 완료하려면 {appName}을(를) 다시 시작해야 합니다" |
| 복구 화면 업데이트 | `appUpdate.recovery.checkingForUpdates/downloadingUpdate/installingUpdate/updateChatGPT` | 업데이트 확인 중 … ChatGPT 업데이트 |
| 지원 종료 강제 | `appSunset.title/body.inAppUpdate/manualDownload` | 업데이트 필요 / "이 버전의 앱은 더 이상 지원되지 않습니다…" / 직접 다운로드 링크 |
| 메뉴 | `electron.appMenu.app.checkForUpdates` | 업데이트 확인… (`ko-KR.json` + `main-C-Mhak1n.js:1559` 메뉴↔intl id 매핑 실측) |

설계 특징: **세션 중단 영향을 사전 고지**(confirmSubtitle), **시간 단위 재시작 독려의 단계적 강화**(분→시간→일→지금), **EOL 시 하드 게이트**.

---

## 6. 사운드/햅틱 피드백

- **햅틱 (실측)**: `main-C-Mhak1n.js:1600 — var gat=class{logger=r.r('composer-snap-haptics'); … process.platform==='darwin' && this.load(); snap(){ this.manager?.defaultPerformer().performFeedbackPattern$performanceTime$(1,1) } … import('objc-js') → NSHapticFeedbackManager(AppKit)`. darwin 전용, 실패 시 manager 폐기 + warning 로그. 컴포저 스냅 제스처에 햅틱 1 패턴.
- **알림 사운드 토글 (실측 문자열)**: `avatarOverlay.enablePetNotifications` **"작업 알림 소리 켜기"**, `avatarOverlay.muteThreadNotifications` **"작업 알림 소리 끄기"** — 작업(펫) 알림에 사운드가 존재하며 per-thread 음소거 제공. 관련: `muteMicrophone/unmuteMicrophone`, `muteOutput` "음성 채팅 소리 끄기".
- **재생 구현**: 웹뷰 공유 번들에서 `new Audio|AudioContext|playSound|.mp3` **부재 확인**(grep 0건), 메인에서 `NSSound` **부재 확인**. → 재생 경로는 미확인. [추정] macOS 시스템 알림 기본음 또는 미도출 파일.
- **청각 대체(a11y) 실측**: 드래그 앤 드롭 스크린리더 안내 `app-initial-51da50e6c6e3.js:49-51 — "To pick up a draggable item, press the space bar…"`, 배너의 `ariaLive:'polite'` + `role:'status'`(composer-banners 청크).
- **햅틱 관련 청크**: `codex-micro-joystick-feedback-*.js` 등 micro-* 계열은 모바일 컨트롤러용으로 데스크톱 UX 범위 외로 판단.

---

## 7. 배너/공지 시스템 (toast와 별개의 인라인 채널)

- **슬롯 우선순위 큐 실측**: `composer-banners-92519a56d6b2.js — candidates = [windows-sandbox, wsl-migration, full-access, cyber-safety, codex-usage, ultra-usage, misalignment-policy, safety-buffering, dictation-first-use]` (+홈 후보, 작업 공지 `task-announcement-candidates`). 컴포저 위 **단일 슬롯**, 후보 중 표시 가능한 것만.
- **배너 컴포넌트 props 실측**: 같은 파일 — `type:'warning'`, `content`, `Icon`, `secondaryCtaText:'Dismiss'`, `onSecondaryCtaClick`(저장 플래그 `ultra-agent-usage-warning-dismissed`로 **영구 dismiss**), `ariaLive:'polite'`, `role:'status'`. 예시 문구: "Ultra with up to {count} agents can use your usage limits quickly".
- **공지 변형**: `notices-dbed4ccd62e0.js` — variant `announcement`/`announcementInset`, `stackOnNarrow`, `wrapCtas`, trailing dismiss 아이콘(aria-label "Dismiss migration notice", **페이지 세션 한정 숨김**), healthcare 배너의 `type:'error'` + primaryCta(Retry).
- **스레드 상단 배너**: `banner-content-6fd3d18d582a.js — mx-auto mb-3 w-full max-w-[var(--thread-content-max-width)]` 컨테이너, 액세스 상태 머신 `pending/allowed/denied/error` + onRetry.

---

## 8. ko-KR.json(네이티브 메뉴 카탈로그) 수집 결과

전수 확인 결과 **toast/empty-state 네임스페이스는 이 카탈로그에 없음**(네이티브 메뉴·시스템 다이얼로그 전용). 수집된 피드백 관련 네임스페이스:
- 오류: `browserSidebar.loadError.*`(heading, dns/proxy/firewall/offline/timeout/refused/certificate summary, try, reload, checkConnection, networkAccessHeader/Body) — 웹뷰 카탈로그와 동일 키(공유 실측)
- 업데이트: `appHeader.installUpdate.*`(4종), `electron.appMenu.app.checkForUpdates`
- 경고: `desktop.intelLaunchWarning.message/detail/quit/continue`(Rosetta 성능 경고), `desktop.quitConfirmation.*`(활성 로컬 채팅·예약 작업 중단 고지 8종 변형)
- 기타: `browserSidebar.zoomBanner.*`(확대/축소/재설정), `desktop.remoteHostedPIP.*`(PIP 제어), `threadHeader.copySessionId` 등

웹뷰 한국어 카탈로그(`ko-KR-b96747fbd4d7.js`) 주요 피드백 네임스페이스 인벤토리: `appUndo.*`(undo 토스트 18), `appServer.error.*`(5), `appServerCrash.*`(8), `appShell.tabPanelRenderError.*`(2), `appHeader/appUpdate/appSunset.*`(업데이트 25+), `approvalRequest*`(11), `avatarOverlay.waitingRequest.*`(35+)/`statusX`(5), `browserPluginSettings.permission*`(12), `browserSidebar.loadError.*`(17), `browser.auth.error.*`(20+), `browserSkills.*` 업로드 오류군(8), `automations.*.loadError/retry/empty`(15+), `appgenPage.cloudUpload.panel.*`(진행률 패널: queued/uploading {progress}%/uploaded/failed/fileFailedRetryable/fileTooLarge/storageFull/retry/remove), `chatgpt.feedback.*`(피드백 폼), `chatgpt.codeBlocks.feedback/share.*`(성공/실패 쌍).

---

## 9. 방법론 한계 (실측/추정 구분)

- **실측**: 위 모든 인용(문자열·코드 스니펫). 주요 원천: `app-shared:282,286`(raw 전수 판독), 소형 청크 9종(전체 판독), `ko-KR-b96747fbd4d7.js` 선두 150KB + 말미, `ko-b71b0572ad12.js`, `native-menu-locales/ko-KR.json` 전문, `main-C-Mhak1n.js` 라인 8/421/575/1095/1559/1600.
- **커버리지 한계**: minified 1-line 대형 번들은 grep 창(4MB)·라인 표시 상한(512B/150KB) 때문에 `app-initial`(11MB) 후반부, `app-primary` 일부, ko-KR 카탈로그 중간 ~110KB(`codex.*`, `thread.*`, `chatgptConversations.*` 중간, 마이크 권한 가능성)는 미판독. 해당 영역의 네임스페이스 부재를 단정하지 않음.
- **추정으로 남긴 것**: 토스트 `info` 변조 존재, 토스트 컨테이너 마크업(app-shared CSS에 `toast` 셀렉터 존재만 확인), 알림 사운드 재생 구현 경로, macOS TCC 권한 프롬프트 문자열, 승인 카드(app-primary:113 부근 매치 확인)의 렌더 마크업.

## 10. garden-ui EXPERIENCE.md용 설계 시사점 (실측 기반)

1. **피드백 채널 분배 규칙**: 되돌릴 수 있는 변경→토스트(+undo), 지속 상태 경고→컴포저 상단 단일 배너 슬롯(우선순위 큐), 섹션 데이터 실패→인라인 alert+Retry, 전역 파괴→복구 화면. 하나의 화면에 오류 UI를 중첩하지 않는다.
2. **문구 3요소**: 무엇이 실패했는가(짧은 단문) + 왜/무엇이 영향받는가(세션 중단 등) + 다음 행동(다시 시도/다른 검색어/재시작). 원시 에러는 절대 노출 금지(폴백 문구 별도).
3. **승인 UX 스케일**: 한 번만 → 이 대화 → 항상 → 자동 승인(업셀+통계 투시). 거부에는 사유 필드. 권한 요청은 network/fileSystem(read·write)로 묶어 청킹.
4. **업데이트**: 진행률 가시화 + 종료 영향 고지 + 시간 단위 재시작 에스컬레이션 + EOL 하드 게이트의 4단.
5. **비음성 피드백**: 제스처 햅틱(darwin NSHapticFeedbackManager)과 a11y 라이브 리전(`role=status`+`aria-live=polite`)을 기본 계층으로. 알림음은 사용자 토글 제어.