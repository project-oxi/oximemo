# 코파일럿 패널 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. (본 세션 확립 선호: 인라인 실행)

**Goal:** 스펙 `docs/superpowers/specs/2026-08-23-copilot-panel-design.md`(f6930c5)을 v1 범위까지 구현한다.

**Architecture:** oximemo는 터미널 에이전트 CLI(oxios 단일 v1 어댑터)를 턴당 subprocess로 디스패치한다. 코어에는 `[copilot]` config만, src-tauri에 어댑터·턴 수명주기·IPC, 프런트에 사이드패널·설정 pane. 캡처 경로·앱 시작 경로에 probe 없음.

**Tech Stack:** Rust(tauri 2, tokio process), React 19 + zustand + TanStack Query, Tailwind v4 토큰.

## Global Constraints

- 캡처 경로 불가침: 앱 시작·오버레이 경로에서 probe subprocess 금지 (스펙 §6, AC-2)
- oximemo 저장소에 모델 지시문 문자열 금지 — 선언적 컨텍스트만 (스펙 §3·§7, AC-3)
- 권한 우회 플래그 자동 부착 금지 (스펙 §11, AC-8)
- 변경 링크 라벨은 "이 턴 동안 변경된 노트" (스펙 §9.4, AC-6)
- 코어는 네트워크·subprocess 프리 유지 — copilot 실행부는 src-tauri 전용 (메타데이터 섹션 선례와 동일)

## 파일 구조

- `skills/oximemo/SKILL.md` — v4 재작성 (블로커 0)
- `apps/desktop/src-tauri/tauri.conf.json` — `bundle.resources` 추가 (블로커 1)
- `crates/oximemo-core/src/config.rs` — `CopilotConfig` + `VaultConfig.copilot`
- `apps/desktop/src-tauri/src/copilot.rs` — 신규: 후보·probe·컨텍스트 빌더·disclosure·턴 실행·변경 diff
- `apps/desktop/src-tauri/src/lib.rs` — `mod copilot`, `AppState.copilot`, IPC 등록
- `apps/desktop/src/lib/api.ts` — copilot API 래퍼 + 타입
- `apps/desktop/src/lib/types.ts` — `CopilotTurnResult` 등
- `apps/desktop/src/stores/ui.ts` — `copilotOpen`
- `apps/desktop/src/components/CopilotPanel.tsx` — 신규 패널
- `apps/desktop/src/components/CardGrid.tsx` — ⌘⇧C + 헤더 아이콘
- `apps/desktop/src/components/SettingsMenu.tsx` — 연동 그룹 "코파일럿" pane
- `apps/desktop/src/lib/locales/ko.ts`·`en.ts` — 문자열
- `README.md`, `doc/DESIGN.md` — 스코프 명확화
- `/Volumes/MERCURY/PROJECTS/oxibrain/doc/ECOSYSTEM.md` — §3.1 개정 (별 레포 커밋)

---

### Task 1: SKILL.md v4 재작성 (블로커 0)

v4 사실로 전면 갱신: `~/.oxi/vault` 기본 경로, `---` YAML 프런트매터(제한 서브셋: 평면 key: value, depth-2 앱 테이블, flow/block 시퀀스, `|` 블록 스칼라; 금지: 앵커·별칭·탭·주석), core 5키(`id, created, updated, favorite, deleted`) + 미지 키·`oxios:` 테이블 보존, 스키마 v1에서 `hash`/`tags` 파생으로 제외, 역할 분리(네이티브 판단 → `update --body-stdin` 커밋; raw write는 원자성·`updated` bump·미지 키 보존을 잃음), 현재 CLI 플래그 전체(`new --folder/--html`, `update --body-stdin/--set/--unset`, `list --where`, `move`는 GUI 전용 제외), 위키링크·백링크 출하 사실, 동기화 알고리즘(hash는 walk-time 파생).

- [ ] 재작성 → `git commit -m "docs: SKILL.md v4 — YAML frontmatter, ~/.oxi/vault, CLI commit path"`
- [ ] 검증: 문서 내 `+++`·`Application Support`·`TOML frontmatter` 문자열 부재 grep

### Task 2: 번들 리소스 (블로커 1)

`tauri.conf.json` `bundle`에 `"resources": { "../../skills/oximemo": "skills/oximemo" }` 추가(src-tauri 기준 상대경로). 런타임은 `app.path().resolve("skills/oximemo/SKILL.md", BaseDirectory::Resource)`로 해석 — `bundled_cli_path()`와 함께 `copilot.rs`의 `context_paths(app)`가 담당. 검증은 Task 5 단위 테스트(경로 조립)로 대체(번들은 release 빌드에서만 완전 검증됨).

- [ ] 수정 → Task 5와 함께 커밋

### Task 3: 코어 config

`config.rs`: `CopilotConfig { enabled: bool(true), agent: String, executable: String, timeout_secs: u64(300) }`, `#[serde(default)]`, `VaultConfig`에 `pub copilot: CopilotConfig` + Default. 테스트: 빈 config → 기본값, `[copilot]` 라운드트립, unknown 필드 무관(기존 스키마버전 관례).

- [ ] 실패 테스트 → 구현 → 통과 → `git commit -m "feat(core): [copilot] config section"`

### Task 4: src-tauri copilot 모듈

`copilot.rs`:

```rust
pub struct AgentCandidate { pub id: String, pub display_name: String, pub executable: PathBuf, pub version: Option<String>, pub supported: bool }
pub struct Disclosure { pub agent: String, pub model: Option<String>, pub provider: Option<String> }
pub struct TurnOutcome { pub response: String, pub session_id: Option<String>, pub exit_code: i32, pub stderr: String, pub changed: Vec<ChangedNote>, pub started_at: String, pub ended_at: String }
pub struct ChangedNote { pub id: String, pub title: String, pub kind: String } // created|changed|deleted
```

- `KNOWN_AGENTS`: oxios(지원), oxicode·claude·codex·omp(미지원 — `supported:false`).
- `probe(exe)` — `--version` subprocess, 3s timeout, stdout 첫 줄.
- `build_context(vault_root, cli, skill, active_memo, user_request) -> String` — 선언적 블록(지시문 금지).
- `disclosure(exe)` — `~/.oxios/config.toml`에서 `[engine] default_model = "..."` 라인 스캔 → provider = `/` 앞 세그먼트. 없으면 `None`.
- `run_turn(...)` — `tokio::process::Command`, `.process_group(0)`, 인자: oxios는 `run --json [--session SID] -- PROMPT`(stdin으로 컨텍스트+요청 전달 — `--context-file -`가 stdin을 받으므로 argv 오염 없음). timeout 초과·취소 시 `kill -pgid`(libc). stdout JSON에서 `response`/`session_id` 파싱, 실패 시 원문을 response로.
- `diff_manifests(before, after) -> Vec<ChangedNote>` — export_manifest(id,hash,deleted) 전후 diff.
- `ActiveTurn { pgid, child, started_at }` — `AppState.copilot: Mutex<Option<ActiveTurn>>`.

테스트: 컨텍스트 빌더(지시문 부재·active_memo 선택적), disclosure 파서(정상/무효/부재), manifest diff(created/changed/deleted), 가짜 에이전트(`/bin/cat` echo JSON) 턴 성공 + 타임아웃 트리거. 취소·tree-kill은 macOS에서 실제 자식(fork하는 션 스크립트)로 검증.

- [ ] 실패 테스트 → 구현 → 통과 → `git commit -m "feat(desktop): copilot adapter module — probe, context, turn lifecycle"`

### Task 5: IPC

`lib.rs` commands: `copilot_status`(config+active+가시성), `copilot_probe_agents`, `copilot_activate {agent, executable}`(캔버스: probe 재검증 → config 저장), `copilot_deactivate`, `copilot_send {message, active_memo}`(turn 실행, 결과 반환), `copilot_cancel`. `generate_handler!` 등록. `api.ts` 래퍼 + `types.ts`.

- [ ] 등록 → `cargo check` → `git commit -m "feat(desktop): copilot IPC commands"`

### Task 6: 프런트엔드 — 패널

`ui.ts`: `copilotOpen` + setter. `CardGrid.tsx` 키 핸들러에 ⌘⇧C(⌘K와 동일 가드), 헤더에 Bot 아이콘 버튼(가시성은 `copilot_status`). `CopilotPanel.tsx`: 우측 고정 패널, 헤더(에이전트·provider·새 대화), 메시지 리스트(사용자/에이전트/오류), 실행 중 상태 + 취소 버튼, 결과에 "이 턴 동안 변경된 노트" 링크(클릭 → memo 열기), stderr/exit code 폴더. 컴포넌트는 `getConfig().copilot` + `copilot_status`로 게이트. ko/en 문자열.

- [ ] 구현 → `bun run build`(tsc 통과) → `git commit -m "feat(desktop): copilot side panel + ⌘⇧C"`

### Task 7: 프런트엔드 — 설정 pane

`SettingsMenu.tsx` 연동 그룹에 "코파일럿" rail 항목 + `CopilotSection`: 마스터 토글(`set_copilot_config`), 탐지 버튼(`copilot_probe_agents`), 후보 목록(경로·버전·지원 여부), 활성화 버튼 → **최초 활성화 시 동의 다이얼로그**(에이전트·provider·전송 범위 고지), 타임아웃 스피너. `set_copilot_config` IPC 추가(코어 config 세터 — `set_brain_config` 선례 준수).

- [ ] 구현 → `bun run build` → `git commit -m "feat(desktop): copilot settings pane — probe, activate, consent"`

### Task 8: 문서

README 22행 스코프 명확화 + Highlights에 코파일럿 항목. `doc/DESIGN.md` 코파일럿 섹션. `oxibrain/doc/ECOSYSTEM.md` §3.1 개정(별 레포 커밋, 스펙 §19 문면 사용).

- [ ] 각 커밋

### Task 9: 검증

- `cargo test -p oximemo-core -p oximemo-desktop`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `bun run build`(apps/desktop)
- 브라우저 스모크: vite dev + mock invoke(mock-data-injection 방식)로 패널·설정 pane 렌더 확인. Tauri 런타임 IPC는 cargo test의 가짜 에이전트 턴으로 대체 검증함을 보고에 명시.

## Self-Review

- 스펙 §5 어댑터 trait: v1 구현은 oxios 1개 — trait 객체 대신 모듈 내 `run_turn`이 id 분기(스펙 §18-4 "v1은 내장 1개라 미결 무방" 허용). 과추상화 금지.
- §8 타임아웃·취소·stderr·exit code: Task 4·6 커버. §10 충돌 노출: v1 패널 라벨로 노출(턴 결과에 "변경된 노트"가 열린 메모와 겹치면 경고 라벨).
- §12 동의: Task 7. §13 oxios 전용: Task 4 KNOWN_AGENTS.
