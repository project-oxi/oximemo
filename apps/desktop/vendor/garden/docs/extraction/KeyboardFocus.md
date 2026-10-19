# Codex 데스크톱 앱 (app.asar v26.917.71314) 키보드·포커스 인터랙션 추출 보고

대상: `/tmp/codex-ux/extracted/` (webview assets + `.vite/build` Electron 메인). 모든 근거는 `파일:라인` 실측 스니펫. 렌더러 번들(app-initial 등)은 수백 KB짜리 초대형 라인(minified)으로 구성되어 있어, 라인 단위 grep(매치 라인 번호) + `:raw` 라인 판독으로 검증했다.

---

## 1. 키바인딩 아키텍처 (실측 요약)

앱은 `useHotkey`/react-hotkeys-hook류 라이브러리를 **쓰지 않는다**(app-shared·app-primary 전체 검색, 매치 없음 — 실측). 대신 자체 3계층 커맨드 키맵 시스템:

1. **커맨드 레지스트리** — `_$`(webview 커맨드) + `Rde`(vscode-only) + `Lde`(electron-only), `kind` 태그로 합침. 각 항목: `{id, titleIntlId, descriptionIntlId, requiredAccess, shortcutScope, allowsBareModifiers, allowsKeyRepeat, commandMenuGroupKey, electron:{menuTitle, defaultKeybindings, platformDefaultKeybindings, isOverridableByBrowserWebpage}, browser:{defaultKeybindings}, vscodeCommand}`.
   근거: `.vite/build/worker.js:462` — `var Lde=[{id:\`hotkeyWindow\`,...shortcutScope:\`os-global\`},...,{id:\`closeTab\`,...defaultKeybindings:[{key:\`CmdOrCtrl+W\`}],platformDefaultKeybindings:{default:[{key:\`Ctrl+W\`},{key:\`Ctrl+F4\`}]}}...` / `var _$=[...v$([{id:\`newTask\`,titleIntlId:\`codex.command.newThread\`,...,electron:{...defaultKeybindings:[{key:\`CmdOrCtrl+N\`},...]}}],\`webview\`),...v$(Rde,\`vscode-only\`),...v$(Lde,\`electron-only\`)]`
   - 중복 ID 가드: 같은 라인 — `if(y$.has(e.id))throw Error(\`Duplicate Codex command id: ${e.id}\`)`
   - 사용자 커스텀 바인딩 스키마(zod): 같은 라인 — `Bde=_P.object({command:_P.string(),key:_P.string().nullable()}); _P.array(Bde)`
   - 이 레지스트리는 `src-DldfpmrL.js`(main이 `require("./src-DldfpmrL.js")`로 import — main-C-Mhak1n.js:1)에 동일 번들되어 main이 `n.Ft`(레지스트리), `n.At`/`n.xt`(바인딩 조회), `n.Ct`(keymapState) 로 소비. 근거: main-C-Mhak1n.js:1559.
2. **Electron 애플리케이션 메뉴 가속기** — `sit({commandKeymapState...})`가 전체 메뉴를 빌드하고, 키맵 변경 시 `cit.refresh()`로 메뉴 재생성(main:1559). 메뉴 아이템은 첫 가속기만 visible이고 나머지는 `acceleratorWorksWhenHidden:!0, visible:!1` 숨김 아이템으로 모두 활성화(`F=({accelerators,click,...})=>e.map(...)`).
3. **OS 전역 단축키(globalShortcut)** — Appshot 핫키 / 글로벌 받아쓰기(hold·toggle) / pet overlay. 근거: main-C-Mhak1n.js:732, 1588.

바인딩 문자열 문법(실측): `CmdOrCtrl+`, `Command+`, `Ctrl+`, `Control+\``, `Alt+`, `Shift+`, `Super+`, `MouseBack`/`MouseForward`, 그리고 Windows 전용 더블모디파이어 `DoubleAlt`/`DoubleShift`/`leftalt+rightalt`. 정규화기(v7): `cmdorctrl→command(mac)|control(win)`, `option→alt(mac)`, `meta/super→command(mac)|super`, `esc/escape→escape`, `plus→=(mac)` 후 정렬·join. 근거: main:1559 — `function v7(e,t){return e.split(\`+\`).map(...).sort().join(\`+\`)}`
전역 핫키 파서 허용 수정키 집합: main:732 — `var HV=new Set([\`cmdorctrl\`,\`command\`,\`cmd\`,\`control\`,\`ctrl\`,\`alt\`,\`option\`,\`super\`]),Aze=new Set([...HV,\`shift\`])`. Windows VK 매핑: 같은 라인 — `Rze=new Map([[\'cmdorctrl\',[17]],[\'command\',[91,92]],[\'ctrl\',[17]],[\'alt\',[18]],[\'shift\',[16]]])` (PowerShell `GetAsyncKeyState` 10ms 폴링으로 key-up 감지, `__KEY_GROUP_SPEC__` 템플릿 — main:732).

---

## 2. 키맵 표 (커맨드 → 기본 키 → 근거)

형식: `기본(electron)` — `macOS 플랫폼별` / `기타 플랫폼`. 모든 행의 근거는 별도 표기 외에는 **worker.js:462** (레지스트리 항목 발초). `CmdOrCtrl` = macOS ⌘ / Win·Linux Ctrl.

### 2.1 스레드/채팅 (task asked: newThread, toggleSidebar, thread1-9 포함)
| 커맨드 | 기본 키 | 비고 |
|---|---|---|
| `newTask` (`codex.command.newThread`) | `⌘N`, `⌘⇧O` | browser: `⌘⇧O`. 메뉴명 "New Chat". 메뉴 클릭 시 `{type:'run-command',id:'newTask'}` 전송 (main:1559) |
| `newProjectlessTask` | `⌘⌥O` | "New standalone chat", `availableIn:['electron']` |
| `temporaryChat` | `⌘⇧N` | 창 상태 `temporaryChatEnabled` 게이트 (main:1559) |
| `quickChat` | `⌘⌥N` | `shortcutScope:'app'` |
| `openSideChat` | `⌘⌥S` | |
| `openThreadInNewWindow` | — | 바인딩 없음 |
| `archiveThread` | `⌘⇧A` | |
| `markThreadUnread` | `⌘⇧U` | |
| `toggleThreadPin` | `⌘⌥P` | |
| `renameThread` | `⌘⌥R` | |
| `forkThread` | — | |
| `nextThread` | `⌘⇧]` | mac: `⌘⇧]`,`⌘⌥→` / others: `Ctrl+Shift+]`,`Ctrl+PageDown`. `nextTab`과 동일 키 + `Ctrl+Tab` |
| `previousThread` | `⌘⇧[` | mac: `⌘⇧[`,`⌘⌥←` / others: `Ctrl+Shift+[`,`Ctrl+PageUp` |
| `nextTab` / `previousTab` | `⌘⇧]` / `⌘⇧[` | 추가: `Ctrl+Tab`/`Ctrl+Shift+Tab`, `⌘⌥→/←`, `Ctrl+PageDown/Up`. `allowsKeyRepeat:!0` |
| `nextRecentThread` / `previousRecentThread` | `Ctrl+Tab` / `Ctrl+Shift+Tab` | `allowsKeyRepeat:!0` |
| `recentThread1..6` | `⌘⌥1..6` | 4번엔 `⌘⇧9`, 5번엔 `⌘⇧8` 추가 |
| `thread1..thread9` | **`⌘1..⌘9`** (`CmdOrCtrl+1..9`) | 메뉴명 "Go to Chat N". 요청 커맨드 실측 완료 |
| `focusTab1..9` | mac `⌃1..9` / others `Alt+1..9` | `[1..9].map(e=>({id:\`focusTab${e}\`,...platformDefaultKeybindings:{macOS:[{key:\`Ctrl+${e}\`}],default:[{key:\`Alt+${e}\`}]}}))` |
| `switchToMode1/2/3` (Chat/Work/Codex) | mac `⌃1/2/3` / others `Alt+1/2/3` | |
| **숫자키 스왑 설정** | `primaryNumberShortcutTarget: 'tabs'\|'sidebar'` | `'sidebar'`면 "⌘1–9 채팅 전환 + ⌃1–9 탭 전환", `'tabs'`면 반대. 근거: keyboard-shortcuts-settings-5511d1126168.js:1 — `Use {primary}1–9 to switch chats and {secondary}1–9 to switch tabs` / 메뉴 리빌드 시 `commandKeymapState:{...n.Ct(),primaryNumberShortcutTarget:...}` 주입 (main:1559 말미) |

### 2.2 패널/레이아웃
| 커맨드 | 기본 키 |
|---|---|
| `toggleSidebar` | **electron `⌘B`**, browser `⌘⇧S` — `{id:\`toggleSidebar\`,...,browser:{defaultKeybindings:[{key:\`CmdOrCtrl+Shift+S\`}]},electron:{...defaultKeybindings:[{key:\`CmdOrCtrl+B\`}]}}` (worker.js:462). 메뉴 클릭 → `{type:'toggle-sidebar'}` (main:1559); 렌더러 수신부는 app-primary:112-116 대형 라인에 존재(프레즌스 실측) |
| `toggleBottomPanel` | `⌘J` |
| `toggleTerminal` | `Control+\`` (grace note 그대로: `{key:"Control+\`"}`) |
| `toggleFileTreePanel` | `⌘⇧E` |
| `openBrowserTab` | `⌘T` |
| `closeOtherTabs` | `⌘⌥W` |
| `reopenClosedTab` | `⌘⇧T` |
| `closeTab` / `closeWindow` | `⌘W` / win: `Ctrl+W`,`Ctrl+F4`. closeTab은 브라우저 탭→앱셸→창 순 폴백 체인 (main:1559 `ne()`) |
| `showWorkspaceTabView` | `⌘⇧F` (unified tab strip 게이트) |
| `stepWorkspaceLayout` | `⌘⇧B` — 메뉴 라벨 "Show or hide tabs"/"Toggle browser panel" 이원화 (main:1559) |
| `toggleSidePanel`(review panel) | `⌘⌥B` |
| `openReviewTab` | `Ctrl+Shift+G` |
| `openFolder` | `⌘O` |
| `settings` | **`⌘,`** (`CmdOrCtrl+,`) |

### 2.3 내비게이션/검색
| 커맨드 | 기본 키 |
|---|---|
| `openCommandMenu` | `⌘K`, `⌘⇧P` |
| `searchFiles` | `⌘P` |
| `searchChats` | browser `⌘K`만 기본, electron 메뉴 항목은 별도 가속기 없음 |
| `showKeyboardShortcuts` | **`⌘/`** |
| `findInThread` | `⌘F` (`isOverridableByBrowserWebpage`). `Find Next ⌘G` / `Find Previous ⌘⇧G`(win `Ctrl+G`/`Shift+F3`)는 메뉴에 하드코딩 (main:1559 — `C=r?[`Command+F`,`Command+G`,`Command+Shift+G`]:[`Ctrl+F`,`Ctrl+G`,`Shift+F3`]`) |
| `goToLine` / `focusBrowserAddressBar` | `⌘L` (중복 허용) |
| `navigateBack` / `navigateForward` | `⌘[` / `⌘]` + `MouseBack`/`MouseForward` |
| `navigateBrowserBack`/`Forward` | mac `⌘←`/`⌘→`, others `Alt+←`/`Alt+→` (`isOverridableByBrowserWebpage`) |
| `file.navigateBack`/`Forward` | mac `Control+-` / `Control+Shift+-` |
| `file.goToDefinition` | mac `⌃]` / others `⌘]` |
| `nextThreadNeedingAttention` | `⌘⌥A` |
| `togglePriorityFilter` | `⌘⌥U` |
| `clearAllUnreads` | **`Shift+Escape`** |

### 2.4 컴포저/에디터/승인
| 커맨드 | 기본 키 |
|---|---|
| `composer.submitInBackground` | `⌘Enter` |
| `composer.startDictation` | `Ctrl+Shift+D` |
| `composer.startVoiceMode` | mac `Ctrl+Shift+V` / others 없음 |
| `composer.openModelPicker` | `Ctrl+Shift+M` |
| `composer.openProjectPicker` | `⌘⌥⇧O` |
| `composer.addFiles` | `⌘U` |
| `approval.approve` | **`Enter`** |
| `approval.decline` | **`Escape`** |
| `undoAppAction` / `redoAppAction` | `⌘Z` / mac `⌘⇧Z`, win `Ctrl+Y`,`Ctrl+Shift+Z` |
| `toggleDebugModal` | `Ctrl+D` (devtools 게이트) |
| `toggleTraceRecording` | `⌘⇧S` |
| `environmentAction1..9` | 1번만 `Command+Shift+D`, 2–9은 미배정 슬롯 |

### 2.5 고정(Electron) 메뉴 가속기 — main:1559
- 붙여넣기 서식 유지: `⌘⌥⇧V`(숨김, `acceleratorWorksWhenHidden`) + 표시용 `⌘⇧V` 별도 삽입(mac)
- 창 새로고침 `⌘⌃R`, 브라우저 페이지 `⌘R`/강제 `⌘⇧R`(`isOverridableByBrowserWebpage`)
- 확대/축소: `⌘+`(win 추가 `Ctrl+=`) / `⌘-` / `⌘0`, 숫자패드 `CmdOrCtrl+numadd|numsub|num0`
- 전체화면: mac `⌘⌃F`(숨김), 그 외 `F11`
- 쿼리 devtools(디버그): `⌘⌥Y` / 종료(win): `Ctrl+Q`
- `⌘⇧C`는 브라우저 URL 복사(`copyWorkingDirectory`)와 충돌 조정 — `we.accelerator`가 `CmdOrCtrl+Shift+C`면 브라우저 copy-url 우선 (main:1559 `pe()`)

### 2.6 OS 전역 (os-global)
| 커맨드 | 기본 키 | 근거 |
|---|---|---|
| `hotkeyWindow` | 레지스트리에 기본값 없음 — 설정 UI에서 할당, 변경 시 `hotkey-window` 쿼리 무효화 + `hotkeyWindowLifecycleManager.collapseToHome()` 연계 | worker.js:462 / keyboard-shortcuts-settings:1 (`n===\`hotkeyWindow\`&&i.push(je)`) / main:1559 |
| `globalDictationHold` / `globalDictationToggle` | 기본값 없음(사용자 할당, `allowsBareModifiers:!0`), 레거시 fallback `globalDictationHotkey`/`globalDictationToggleHotkey` globalState | worker.js:462 / main:1588 (`cH(\`globalDictationHold\`)...dH({keymapHotkey,legacyHotkey})`) |
| `realtimeVoice` | `allowsBareModifiers:!0`, 미배정 | worker.js:462 |
| `openAvatarOverlay` (pet) | mac **`Alt+Space`** / others `Super+Alt+P` | worker.js:462 — `platformDefaultKeybindings:{macOS:[{key:\`Alt+Space\`}],default:[{key:\`Super+Alt+P\`}]}`; main 등록: main:1588 `Fit()` — `n.bt({commandId:\`openAvatarOverlay\`,isMacOS})` |
| Appshot 핫키 (`appshotHotkey`) | mac 기본 **`DoubleCommand`**, win 기본 **`DoubleAlt`** (허용: `doublealt`,`leftalt+rightalt`,`doubleshift`,`leftshift+rightshift`) | main:1588 — `Ait=\`DoubleCommand\`,jit=\`DoubleAlt\``, `c=e.getStored(\`appshotHotkey\`);this.configuredHotkey=c===void 0?(win32?jit:Ait):c`, `S7(e)` 허용집합, `qit` 정규화 |
| 글로벌 받아쓰기 취소 | **`Escape`(OS 레벨 등록)** | main:1588 — `this.escapeRegistration=qV(\`Escape\`,{onPressed:()=>this.cancelDictation()},{ownership:this.lifecycleLock})` (세션·붙여넣기 대기 중에만 등록) |

Appshot 동작 세부(main:1588 실측): 누름 → destination 설정(`automatic`/`last-chat`/`new-chat`)에 따라 현재 뷰로 `{type:'appshot-shortcut'}` 또는 새 채팅 `{type:'new-chat-with-appshot'}` 전송; `automatic`은 "60초 내 포커스"(`Mit=6e4`) 조건; 핫키 처리 시 렌더러 백그라운드 스로틀 2초 해제(`Nit=2e3`). 등록은 ref-count(`KV`)로 `globalShortcut.unregister` 관리(main:732 `jze()`); bare modifier 트리거 모드: `immediatePress`(appshot/pet) vs `cancellablePress`(받아쓰기) — main:1588. 받아쓰기 toggle은 탭 디텍션: 최소 250ms(`U7`), 더블탭 윈도우 400ms(`uat`); hold 해제 감지는 mac NSEvent/Win VK 폴링; 전사 결과는 클립보드 경유 AX Paste(150ms 지연, 700ms 후 클립보드 복원, osascript `keystroke "v" using command down` 폴백); 오버레이 창 720×84 하단 중앙 `setIgnoreMouseEvents` (main:1588).

---

## 3. keydown 특수키 처리 (렌더러)
- **IME 가드 + Escape**: app-primary-d66705000d76.js:14 — writing-block ProseMirror 플러그인 `handleKeyDown(t,n){if(n.defaultPrevented||n.isComposing||n.keyCode===229)return!1;...if(n.key===\`Escape\`&&KR(r)){n.preventDefault(),n.stopPropagation();...setMeta(UR,{type:\`close\`})` → 슬래시/제안 오버레이를 Escape로 닫되 IME 조합 중엔 무시.
- **키 스트로크 캡처 입력**(설정): keyboard-shortcuts-settings:1 — `onKeyDown:P?e=>{if(e.repeat)return;if(e.preventDefault(),e.stopPropagation(),e.key===\`Escape\`&&!e.altKey&&!e.ctrlKey&&!e.metaKey&&!e.shiftKey){...캡처 종료}...let t=tt(e.nativeEvent)...}` → repeat 무시, 수정키 없는 bare Escape만 취소, 이벤트→가속기 문자열 변환(`tt`+`he` 정규화), **스페이스로 연결된 시퀀스(코드)** 지원: `n=\`${M} ${e}\``, 프리픽스 매칭 `At(e,t)=e===t||e.startsWith(t+\` \`)`, 충돌 판정 `Nt`는 시퀀스 첫 체드 비교. `allowsSequences:r.kind===\`webview\`` — 시퀀스는 webview 커맨드만 허용.
- **예약 키**: find/findNext/findPrevious는 커스텀 바인딩 불가 고정 — settings `jt()`의 `case\`find\`:case\`findNext\`:case\`findPrevious\`` + main:1559의 예약집합 `C` 이중 관리.
- **renderer 키 디스패처**: 메인이 메뉴 가속기 클릭을 `{type:'run-command', id, keyboardEvent|originPanel|allowAppShellTabShortcut}` 메시지로 전달하며, `triggeredByAccelerator` 시 원본 modifier(`altKey/ctrlKey/metaKey/shiftKey`)를 보존해 전송(main:1559 — `keyboardEvent:{altKey:n.altKey===!0,...,key:e.accelerator?.split(\`+\`).at(-1)??\`\`}`). 이후 렌더러 커맨드 버스가 실행(수신부는 app-initial 후반부/app-primary 대형 라인 — 프레즌스만 실측).
- 스레드 내비게이션은 `allowAppShellTabShortcut` 조건부 위임: `Le(e)`가 `nextThread/nextRecentThread→nextTab`, `previousThread/...→previousTab`으로 별칭하고, `threadNavigationShortcutLocked`가 아니며 가속기가 탭 전환 키와 일치할 때만 탭 쪽으로 통과(main:1559 `ze/Be/le`).

## 4. Escape 처리 총목록 (실측)
1. OS 전역 받아쓰기 취소 — `qV(\`Escape\`,...)` 등록/해제 (main:1588).
2. 승인 거부 `approval.decline = Escape` (worker.js:462).
3. `clearAllUnreads = Shift+Escape` (worker.js:462).
4. 에디터 제안/슬래시 메뉴 닫기 — `n.key===\`Escape\`` preventDefault+stopPropagation (app-primary:14).
5. 단축키 캡처 모드 종료 — bare Escape (keyboard-shortcuts-settings:1).
6. dnd-kit 드래그 취소 안내 문구 "press escape to cancel" (app-initial:50-51) — 드래그 중 Escape 취소.
7. [INFERENCE] Radix DismissableLayer/Dialog 계열(앱-shared 벤더, app-shared:99·139·287 대형 라인에 `[Ee]scapeKeyDown` 매치 존재)에 의한 오버레이(Dialog/DropdownMenu/Popover) Escape 닫기 — 라이브러리 표준 동작, 라인 내부 위치는 미검증.

## 5. 포커스 규칙 요약
- **초점 링**: Tailwind `focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset` + 명시적 `tabIndex` 속성을 지닌 스크롤 컨테이너(코드 스니펫 뷰어). keyboard-only 포커스 링 규약. 근거: app-shared:289 — `o=J(\`text-size-chat overflow-auto p-2 outline-none focus-visible:ring-2 ...\`,r),...jsx(\`div\`,{ref:i,className:o,tabIndex:a,...`
- **focus trap / roving tabindex**: Radix 프리미티브 번들 존재 실측 — `FocusScope|trapFocus` 매치 app-shared:99,139,282-284 / `RovingFocus` 매치 app-shared:139,288-292(메뉴·툴바용 RovingFocusGroup). [INFERENCE] Dialog/Menu 조합의 표준 trap+roving 동작.
- **react-aria Dialog 접근성**: app-shared:286 — `Warning: Missing \`Description\` or \`aria-describedby={undefined}\` for {...}` 개발 경고, app-shared:284 — "wrap it with our VisuallyHidden component". 실제 사용예: keyboard-shortcuts-settings:1 리셋 확인 다이얼로그가 `ee`(Title)/`h`(Description)를 `className:\`sr-only\``로 렌더.
- **스크롤 락**: 오버레이 오픈 시 body 스크롤 잠금(react-remove-scroll) — app-shared:100-102(`.${dge}{overflow:hidden;padding-right:${s}px}` 스크롤바 보상) 및 138-139(`.allow-interactivity-${e}{pointer-events:all}` 사이드카, `qE`=remove-scroll 컴포넌트+sideCar 조립).
- **dnd-kit 키보드 드래그**: app-initial:50-52 — 안내문 "While dragging, use the arrow keys to move the item. / Press space again to drop the item in its new position, or press escape to cancel." + 라이브 지역 공지 `lPe={onDragStart...\`Picked up draggable item \`+t.id...\`` (Space 픽업→화살표 이동→Space 드롭/Escape 취소, 스크린리더 공지).
- **설정 UI 포커스/ARIA**: keyboard-shortcuts-settings:1 — 캡처 입력 `autoFocus:P`(캡처 진입 시 자동 포커스), 행 `role:\`group\``+`aria-labelledby`(`keyboard-shortcut-${id}-label`), 캡처 입력 `aria-label:"Shortcut capture for {commandTitle}"`, 저장 오류 `role:\`alert\``, 메뉴 트리거 `aria-labelledby` 병합, keystroke 검색 토글에 `aria-pressed`.
- **포커스 영역 라우팅(메인)**: `focusArea` 상태(`main|bottom-panel|right-panel`)를 앱셸이 유지하고, `focusBrowserAddressBar`·스레드 전환 시 어느 패널을 타겟할지 `q()`/`fU()`가 결정 (main:1559).

## 6. aria-live / role 사용처
- `aria-live`: app-shared:99,100-102,281-285 및 app-primary:1-2,28-31,61-66,72-75,112-116 대형 라인에 다수 매치(프레즌스 실측; 라인 내 좌표 미검증). dnd-kit 라이브 공지가 대표 소비처(app-initial:50-52).
- `role:\`status\``: app-primary 동 대형 라인들에 매치(프레즌스). `role:\`alert\``: keyboard-shortcuts-settings:1 실측(저장 실패 2곳). `role:\`dialog\``류는 react-aria Dialog(useDialog) 경로로 존재 — app-shared:284-286 경고문이 간접 실측.
- 라이브러리 구성 실측: formatjs/react-intl(app-shared:99), react-remove-scroll(100-102,138-139), react-aria(284,286), Radix(139,286-292), dnd-kit(app-initial:50-52), ProseMirror(app-primary:14), pdf.js 뷰어(pdf-*.js:3 — 폼 필드 `Enter`/`Escape` 커밋 `#P(e){...e.key===\`Enter\`||e.key===\`Escape\`&&this.#f&&this.#I()}`).

## 7. 방법론·한계
- 렌더러 메인 번들은 수백 KB짜리 초대형 라인(예: app-shared:287 = 167.7KB)이라 grep 표시가 라인 선두 512바이트만 보여주며, app-initial은 grep이 선두 4MB(≈라인 3000까지)만 커버. 따라서 레지스트리·메뉴·핫키의 **모든 기본 바인딩은 worker.js:462 / main:1559 / main:1588에서 전문 판독으로 실측**했고, app-initial 후반부(라인 3000+)의 `run-command` 수신 디스패처와 `role:\`status\`` 개별 사용처는 프레즌스 수준 근거로 남긴다(명시 표기).
- app.asar의 `worker.js`와 `src-DldfpmrL.js`는 같은 공유 모듈의 이중 번들임을 레지스트리 문자열 일치로 확인(교차 검증).
- 키맵 사용자 변경은 `{type:'append'|'set'|'replace'|'previousAccelerator'...'remove'|'reset'}` 뮤테이션(`set-codex-command-keybinding`)으로 저장되며, `hotkeyWindow`·`globalDictationHold/Toggle` 변경은 메인의 전역 핫키 재등록까지 전파된다(keyboard-shortcuts-settings:1 + main:1588 `syncCommandKeybindings`).