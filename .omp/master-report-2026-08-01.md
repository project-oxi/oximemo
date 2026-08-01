# Oxi Ecosystem — 2026-08-01 통합 작업 보고서

## 개요
- 실행일: 2026-08-01 (KST)
- 총 작업: 6개
- 완료: 5개 정상 완료 / 1개 부분 완료 (oxi TUI 통합 미커밋)
- 모델: zai/glm-5.2
- 보고서 취합: 각 작업의 `/tmp/oxi-reports/*.md` 요약 6건 (전건 존재)

> **이메일 발송 관련 (정직한 기록):** 본 환경에 이메일 자격증명이 없습니다
> (`RESEND_API_KEY` / `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` 모두 unset),
> `resend` CLI 미설치, Cloudflare 도메인도 미인증 상태입니다. 따라서 이메일 발송은
> 불가하여, **본 보고서는 파일(`/tmp/oxi-reports/master-report.md`)로만 전달**됩니다.

---

## 1. 02:00 — Oxios: 예약 작업(Scheduled Task) 기능 완성 ✅

CronScheduler와 Task 모듈은 대부분 구현되어 있었으나 부팅 시 연결되지 않았다.
이번 작업으로 **CronJob이 부팅 시 자동 실행**되고, **Task 실행/예약 API가 실제 동작**하며,
프론트엔드에서 **스케줄 설정 + 실행 기록**을 관리할 수 있게 되었다.

**백엔드 (Rust):**
- `KernelHandle::run_goal` — 공유 실행 프리미티브. CronScheduler 자동실행 루프, Task 자동실행 루프,
  `POST /api/tasks/:id/run`이 동일 실행 경로 사용.
- **CronScheduler 자동 시작** (`cmd_serve`) — 부팅 시 `restore_jobs` + `load_from_config` + tick 루프.
  `CronConfig.enabled` 기본값 `true`로 변경 (별도 설정 없이 자동 실행).
- **`POST /api/tasks/:id/run`** — 503 스텁을 실제 구현으로 교체. `execute_task_run` (mark_running → 300s 타임아웃 run_goal → mark_finished). `GET /api/tasks/:id/runs` 실행 기록 추가.
- **`PUT /api/tasks/:id/schedule`** — automation 필드 미저장 버그 수정.
- **Task 자동실행 루프** (`plugin.rs`) — 60s tick 폴링, per-task 실행 (동시성 + 600s 타임아웃), 부팅 시 `recover_stranded`.
- 성공 신호 버그 수정 (`failure_class.is_none() && evaluation_passed.unwrap_or(true)` — 일반 goal이 항상 실패로 기록되던 버그).

**프론트엔드 (React):**
- CreateTaskDialog (선택적 자동화 섹션), TaskCard (다음 실행 시간/스케줄 배지),
  TaskDetailDialog (전체 지시문, 인라인 스케줄 편집, 실행 기록 타임라인).
- `useRunTask` / `useTaskRuns` hook, 한/영 i18n 키 추가.

**검증:** `cargo test` 795 passed / 0 failed (신규 7개 포함) · clippy 클린 ·
`tsc --noEmit` + `bun run build` + biome 클린 · 부팅 스모크 (cron 루프 시작, Task API E2E 동작).

**커밋:** `cabc48fc2`, `27af77f0f`, `ba99e50ac`, `c8847a308` (4건)

---

## 2. 03:00 — Oxi Ecosystem: 통합 디자인 시스템 ✅

3개 프로젝트(oxinot, oxipage, oxios) 디자인 분석 → 통합 DESIGN.md(UNIFIED-DESIGN.md) 생성.

**토큰 상태 분석:**

| 프로젝트 | 토큰 계층 | 다크모드 | 폰트 | 비고 |
|---|---|---|---|---|
| oxios | ✅ 3-tier 완료 | `.dark` ✅ | SUIT/SUITE | 가장 앞서 있음 (정규값 출처) |
| oxipage | ⚠️ v1 (`[data-theme]`) | 마이그레이션 필요 | Pretendard/Fraunces→SUIT/SUITE | 별점 골드·로비 3모드 고유 |
| oxinot | ⚠️ 레거시 hex | `.dark` ✅ | Inter/Pretendard→SUIT/SUITE | OKLCH 라벨 팔레트 원천 |

**통합 방향:**
1. OKLCH 3-tier 토큰 (primitive → semantic → component) 단일 체계
2. 6-hue 라벨 팔레트 (L≈0.70–0.75, C≈0.12–0.15) — oxinot `lib/color.ts` 원천
3. 상태색 APCA 최적화 — oxios 대시보드 실측값이 정규
4. SUIT(본문) + SUITE(헤드라인) + Geist Mono(코드), 세리프 없음, jsDelivr 배포
5. `.dark` 클래스 단일 트리거, `oxi-theme` 저장 키
6. 컴포넌트는 Tailwind 유틸리티만 소비 (`dark:`, hex, 프리미티브 직접 접근 금지)

**산출물:**
- `oxinot/doc/UNIFIED-DESIGN.md` (25.9KB — 메인 통합 문서, 정규 11섹션 구조)
- `oxinot/doc/DESIGN.md` (참조 + 타이포그래피 §7.1.1 추가)
- `oxipage/doc/UNIFIED-DESIGN.md`, `oxios/web/UNIFIED-DESIGN.md` (프로젝트 adaptation)

**발견사항:** 정규 통합 스펙이 이미 `oxios/web/DESIGN.md` (v1.0, 1151줄) + `oxi-design-system` 매니지드 스킬로 존재. oxios가 가장 완성된 구현체. 새 UNIFIED-DESIGN.md는 이를 요청 구조로 재구성 + 값 검증.

**레퍼런스 우선순위:** oxinot(1순위) > oxipage(2순위) > oxios(3순위).

---

## 3. 04:00 — Oxi: TUI 레이아웃 리디자인 (grok-build 포팅) ⚠️ 부분 완료

**중요 정정:** 작업 문서/AGENTS.md는 `oxi-tui` (tape 모델)를 대상으로 했으나,
**실제 프로덕션 TUI 크레이트는 `oxi-vtui`** 이다. `oxi-tui`는 고아 크레이트 (workspace member 아님, 프로덕션 미컴파일).
프로덕션 렌더 경로는 `oxi-cli/src/tui_vt/main_loop.rs::render_frame` (ratatui + `oxi_vtui` InlineSession).
따라서 grok-build 레이아웃을 **`oxi-vtui/src/design/layout/`** 에 포팅.

**수행 작업:**
- grok-build `xai-grok-pager/src/views/agent.rs` 의 `AgentViewLayout::compute()`, `ActivePane`, `PaneAreas` 등 전체 분석 (소스 직독).
- 단일 파일 `design/layout.rs` → 디렉토리 분할. LayoutMode 보존 + grok 프리미티브 추가
  (`agent.rs`, `config.rs`, `status_bar.rs`, `shortcuts_bar.rs`, `welcome.rs`).
- **grok 원본 대신 개선:** `LayoutInput` 구조체로 ~15개 height 파라미터 명명 전달 (too-many-args 버그 방지),
  `take_optional`/`take_section`/`take_pane` 헬퍼, `ActivePane::cycle(visible)`,
  스타일링 트레이트 분리, ratatui `Widget` 구현.
- 프로덕션 통합 (`frame_layout.rs`): `render_chrome()`가 `AgentViewLayout::compute()` 계산 후 StatusBar + ShortcutsBar 렌더.
  ShortcutsBar 힌트는 실제 키 디스패치와 필드별 교차 검증 (추측 금지).

**검증:** `cargo check` · `clippy --all-targets -D warnings` (0 warnings) · `fmt --check` 클린 ·
`nextest run -p oxi-cli -p oxi-vtui` **781 passed, 2 skipped** (layout 라이브러리 단독 22 tests + 통합 render smoke 2 tests).

**커밋 상태 (정직한 보고):**
- **커밋됨 (`7e0ee3cf`)**: 레이아웃 라이브러리 + 설계 spec. 단독 컴파일 가능, 22 테스트 통과.
- **작업 트리 (미커밋, 검증됨)**: 프로덕션 통합 (`frame_layout.rs` + `main_loop.rs::render_frame`).
  **이유:** 워크스페이스에 47개 파일/+1687행의 다중 세션 인터의존적 WIP가 있어, 내 슬라이스만 커밋하면 캐논컬 상태가 컴파일되지 않음. 비컴파일 커밋은 해로우므로 통합은 WIP 확정 후 함께 커밋되어야 함. 통합 자체는 781 테스트 + clippy로 검증 완료.

---

## 4. 05:00 — Oxipage: Console 개선 ✅

**결론:** 작업 문서 전제가 대폭 stale. 실사 결과 5개 중 3개(#1 라우팅, #3 미리보기, #4 GitHub Pages)는 이미 구현 완료 상태.
실제 결함은 #2(테마) 라우팅 컨텍스트 버그 1건 + #5(콘텐츠) 데이터 손실/표시 결함들이었다.

| # | 이슈 | 실제 상태 | 조치 |
|---|---|---|---|
| 1 | `/sites` raw HTML | 클린 리빌드 후 모든 라우트 동일 admin.html 서빙, 해시 자산 전부 200 | **이미 완료** (재현 확인) |
| 2 | 테마 시스템 | appearance 완전 연결. **실제 버그:** ThemeBootstrap이 `<Routes>` 밖이라 `useParams()` 항상 {} → 항상 default 테마만 fetch | **수정 (F1)** |
| 3 | 미리보기 버튼 | DeployPage에 "Preview Site" + preview 엔드포인트 완전 구현 | **이미 완료** (dead const 제거) |
| 4 | GitHub Pages 배포 UI | SettingsPage 폼, preflight, POST /deploy→SSE→gh-pages push | **이미 완료** |
| 5 | 확장 콘텐츠 | 이미지 업로드·Profile 탭 존재. **실제 버그:** BooksTab cover 누락(데이터손실), ProjectsTab 썸네일 broken | **수정 (F4–F7)** |

**적용한 수정 (F1–F8):**
- F1(핵심): `applyServerTheme(slug)`를 `ThemeBootstrap`(Routes 밖) → `ConsoleShell`(라우트 컨텍스트)로 이동.
- F2: ThemesPage apply 후 팔레트 republish. F3: EditorPreviewDrawer가 hardcode "paper" 대신 활성 public theme 사용.
- F4(데이터손실): BooksTab 저장 payload에 `cover_image_url` 추가. F5: ISBN-13 + rating 검증 연결.
- F6: ProjectsTab 썸네일을 adminAssetResolver로 해석. F7: 비활성 확장 탭 숨김. F8: dead `PREVIEW_DISABLED_CODES` 제거.

**검증:** `bun run build` (tsc clean + vite emit) · `cargo build` (SPA re-embed, 새 해시) ·
서버 smoke (`/sites` 서빙 회귀 없음, themes 카탈로그 6개) · 브라우저 (per-site theme fetch 확인).

**명시적 scope-out:** EditorPreviewDrawer 7개 에디터 일반화 (전용 follow-up), 서브 mutation onError 강화 (공통 toast hook 별도 패스).

**커밋:** `11e8490`, `efb0b23`, `e23baca` (Release v0.8.0).

---

## 5. 05:30 — OxiLine: UI 리디자인 (Flat Premium) ✅

**"Flat Premium" 방향** 타임라인 리디자인. 코드 재검증 결과 태스크 문서의 '문제점' 대부분이 **이미 해결된 상태** (그리드라인 없음 · oxi 3-티어 토큰 · 미묘한 NowLine)였으므로, 회귀 없이 진짜 갭만 다듬었다.

**변경 컴포넌트:**
- **styles.css** — 타임라인 전용 토큰 레이어 추가 (`--shadow-card`, `--shadow-block-{rest,hover,drag}`, `--color-block-{bg,border}`, `--tl-rail/spine-width`, `--tl-tick-color`). 기존 3-티어 아키텍처 확장만, 회귀 없음.
- **BlockView.tsx** — flat tinted fill + 1px 헤어라인 (hover 시 밝게) + 3단계 elevation. **좌측 3px 카테고리 accent rail** 추가 ("color is data").
- **DayTimeline.tsx** — 외부 카드 shadow `lg→card(sm)`, spine `2px→1px` 재중심, 미묘한 6px 시간 tick notch (그리드라인 아님 — 리듬만).
- **NowLine.tsx** — HH:MM 라벨에 raised-bg pill. **Header.tsx** — `pt-2` 상단 여백.

**리디자인 방향:** 미니멀/평면 (Linear·Cron·Amie 계열). 그림자 의존 ↓, 색=데이터(rail) ↑, 넉넉한 여백. 2025-26 캘린더 앱 트렌드 정합.

**검증 (증명):**
- 빌드: `bun run build` (tsc+vite) ✅ · `cargo build` ✅
- 시각 (실제 DOM + 스크린샷, Tauri 목 데이터):
  - 라이트 — 카드 shadow sm(0.07), 블록 10개, 3px rail (done=success 녹 / work=blue), flat fill + 헤어라인 + rest box-shadow `none` ✅
  - 다크 — 1차 감사에서 블록 fill(24% L)이 카드(22%)에 묻혀 rail에만 의존 → **`--color-block-bg` 다크 24%→28% L** (6% delta) 수정 후 블록 자립 분리 확인 ✅
- 회귀 grep: 컴포넌트에 `dark:`/`data-theme` 없음, 폰트 유지, 그리드라인 재도입 없음 ✅

**배포:** `bunx @tauri-apps/cli build` → **OxiLine.app** 빌드 성공 (6.8M, ad-hoc 서명, arm64) · **`/Applications/OxiLine.app` 설치 + quarantine 제거 + 실행 확인** (PID 53093).

**커밋:** `4fc5bc3`, `77cd3ae`, `8edef84`, `c62c2d3`, `6efb22e` (5건).

---

## 6. 06:00 — Oxinot: 앱 개선 (검증 중심) ✅

**중요:** 이 태스크에 열거된 **모든 기능(P0 + 작업 1~4)은 본 실행 이전에 이미 구현·커밋된 상태**였다.
스펙의 파일명/식별자는 구식 (Note→Memo 전역 리네임 이전): `NoteDetail.tsx`/`createNote`/`notes:changed` →
실제로는 `MemoDetail.tsx`/`createMemo`/`memos:changed`. 본 실행은 **이미 구현된 코드를 코드 검사 + 데이터 계층 스모크 + 릴리스 빌드로 검증**.

**이번 실행에서 실제 수행한 작업 (NEW):**
1. **Tauri CLI 복구** — `cargo-tauri` 바이너리가 레지스트리엔 있으나 `~/.cargo/bin`에 실종. `cargo install tauri-cli --version "^2.0" --locked --force`로 복구 (2.11.4, 2m03s).
2. **CI 환경변수 충돌 해결** — `CI=1`이 tauri-cli의 `--ci` 불 플래그와 충돌 (`error: invalid value '1' for '--ci'`). `CI` 해제 후 빌드 재실행.
3. **릴리스 빌드 성공** — `cargo tauri build` (release, 1m01s): 바이너리 + **DMG `oxinot_0.3.0_aarch64.dmg` (7.4 MB)**.
4. **/Applications 설치** — 기존 app 제거 후 DMG에서 Fresh .app 설치 (v0.3.0, ad-hoc 서명).
5. 전 기능 코드 검사 + 데이터 계층 스모크 테스트.

**P0 — 메모 저장 후 목록 미표시 버그: 이미 수정됨 (검증 완료).** 근본 원인 (커밋 `7d6cddc`):
Tauri v2는 `invoke` 인자를 Rust 파라미터의 **camelCase**로 바인딩. `list_memos`는 snake_case 파라미터를 가져 JS가 snake_case 키를 보내면 바인딩 실패 → 목록이 비어 보임.
수정: `api.ts`가 camelCase 키(`includeTags` 등)로 invoke, `create/update/delete_memo`가 `memos:changed` 발행, `CardGrid`가 이를 무효화.

**작업별 검증 (이미 구현됨):**
- 작업 1 설정창 재구성 + 카테고리 관리 ✅ (SettingsMenu Drawer, CategorySwatch OKLCH, 카테고리 CRUD IPC)
- 작업 2 Inbox 카드 무색 기본 ✅ (`AUTO_COLORS[0]=""`, `colorForCategory` 폴백)
- 작업 3 빠른 캡처 오버레이 ✅ (QuickCaptureForm, SlashCategoryMenu, `show_capture` 560×200)
- 작업 4 카테고리 드롭다운 → search-as-you-type ✅ (CategoryCombobox, `⌘L` 단축키, 위쪽으로 열림)

**검증 증거:** 코드 경로 검사 · 데이터 계층 스모크 (`oxinot new` → `oxinot list` 즉시 표시, 다중 메모 영속) · 릴리스 빌드 성공 (tsc 2284 모듈 0 에러) · 앱 부팅 확인 (PID 66283).
⚠️ **대화형/시각적 GUI 스모크 미실행**: 자동 실행 환경에서 macOS Screen Recording/Accessibility 권한 거부로 인터랙티브 검증 불가. 런타임 재패치/가상화는 코드 경로로 입증되나 GUI 상호작용 자체는 본 환경에서 불가.

**이메일 보고:** ⚠️ 미발송 (알려진 제약 — 본 보고서가 취합 대상이므로 이 항목에서는 정상).

---

## 종합 요약

| 프로젝트 | 작업 | 상태 | 비고 |
|---|---|---|---|
| oxios | Scheduled Task 기능 | ✅ | 부팅 시 cron 자동실행, Task API 동작, 프론트 스케줄 UI + 실행 기록. 테스트 795 passed. |
| oxinot/oxipage/oxios | 통합 DESIGN.md | ✅ | UNIFIED-DESIGN.md 생성, OKLCH 3-tier 단일 체계, oxinot=정규 원천. |
| oxi | TUI 레이아웃 | ⚠️ 부분 | grok-build 레이아웃 라이브러리 커밋(`7e0ee3cf`) + 22 테스트. **프로덕션 통합은 WIP 의존성으로 미커밋** (781 테스트로 검증됨). |
| oxipage | Console 개선 | ✅ | 테마 라우팅 컨텍스트 버그(F1) + 콘텐츠 데이터 결함(F4–F7) 수정. 3개는 이미 완료 상태. Release v0.8.0. |
| oxiline | UI 리디자인 | ✅ | Flat Premium (rail·flatten·soften), 다크 block-bg 보정. 빌드 + /Applications 설치 완료. |
| oxinot | 앱 개선 | ✅ (검증) | 스펙 전 기능 이미 구현됨. Tauri CLI 복구 + 릴리스 빌드 + /Applications 설치 + 코드/데이터 스모크 검증. |

### 공통 패턴 / 인사이트
- **3건(oxipage·oxiline·oxinot)이 "이미 구현됨" 상태에서 시작** — 자동 실행 태스크 문서가 실제 코드 상태보다 stale. 실사(stale 검증)가 가장 큰 가치를 창출함.
- **정직한 커밋 원칙 준수**: oxi는 비컴파일 커밋을 피하려 라이브러리만 커밋하고 통합은 WIP 확정 후 보류. oxinot은 소스 변경 없음을 명시.
- **이메일 인프라 미구축이 전체 파이프라인의 병목** — 6개 보고서 모두 파일로만 존재. 자동 이메일 발송을 원한다면 Resend 인증(CLOUDFLARE DNS의 DKIM 충돌 해소) 또는 Cloudflare Email Sending 도메인 온보딩이 선행 필요.

### 미해결 / 후속 항목
1. **oxi 프로덕션 통합 커밋** — 워크스페이스 WIP(47파일) 확정 후 `frame_layout.rs` + `main_loop.rs` 함께 커밋 필요.
2. **oxinot 대화형 GUI 스모크** — macOS 권한(Screen Recording/Accessibility) 부여 후 재실행 권장.
3. **oxipage EditorPreviewDrawer 7에디터 일반화** — 전용 follow-up.
4. **이메일 발송 인프라** — Resend `oxinot.dev` DKIM 충돌(3 competing TXT) 해소 또는 `mail.oxinot.dev` 서브도메인 등록.
