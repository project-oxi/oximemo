# Copilot Agent Adapters (Claude Code · Codex CLI · OxiCode) + Activation UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship verified copilot adapters for Claude Code, Codex CLI, and OxiCode (specs §13/§5 — only live-verified non-interactive contracts ship enabled), and make activation produce visible feedback.

**Architecture:** Each adapter is a pure argv builder + stdout parser + disclosure reader in `apps/desktop/src-tauri/src/copilot.rs`, dispatched from `copilot_send` (cwd = vault root, context via stdin except OxiCode which ignores stdin). Frontend gains a policy-blocked note, an honest empty model-picker state, and an activation toast with an "open copilot" action.

**Tech Stack:** Rust (tokio, tauri v2 IPC), React 19 + TanStack Query + zustand, i18n dicts in `src/lib/locales/{en,ko}.ts`.

## Global Constraints

- Spec §11 + acceptance criterion 8: **oximemo never attaches permission-bypass or sandbox flags** (`--dangerously-skip-permissions`, `-s workspace-write`, `--approve-for-me`, `--permission-mode` …). Policy belongs to each agent's own config. We only pass flags whose absence breaks the mechanical turn: `-p --output-format=json`, `--json`, `--skip-git-repo-check` (preflight check, not a permission), `--mode=json`, `--print`.
- Spec §12: provider disclosure is measured/known-only. Unknown → "unknown provider", never guessed.
- Spec §7: no instruction prose authored by oximemo. The context block stays declarative facts; `user_request:` is a fact field (already the spec's own §7 sample shape).
- Verified on this machine 2026-08-24: claude 2.1.229 (`~/.local/bin`), codex-cli 0.147.0 (`~/.local/bin`), oxicode 0.76.0 (`~/bin`), omp 18.0.3, oxios 1.43.1. Gemini CLI absent → listed as `supported=false` only.
- Turn = one subprocess (`run_agent_process`, unchanged). No token streaming.
- All UI copy: Korean in `ko.ts`, English in `en.ts`, keys in both files, same insertion point (after `copilot_model_filter`).

### Verified adapter contracts (evidence from live turns, /tmp/copilot-verify)

| | argv (no session) | argv (resume) | stdin | response source | session id | model disclosure |
|---|---|---|---|---|---|---|
| claude | `-p --output-format=json [--model M] -- PROMPT` | `… -r SID -- PROMPT` | appended as context | single JSON: `result` | `session_id` | `modelUsage` first key: `canonicalModel`, `provider` (`firstParty`→`anthropic`); `permission_denials[].tool_name` counts policy blocks |
| codex | `exec --json --skip-git-repo-check [-m M] -- PROMPT` | `exec resume --json --skip-git-repo-check [-m M] SID -- PROMPT` | appended as `<stdin>` block | JSONL `item.completed` `item.type=="agent_message"` `.text` (join), else `error` messages | `thread.started` `thread_id` | none in events → None |
| oxicode | `--print --mode=json [-m M] -- CTXPROMPT` | **none** (no by-id resume; `-c` is cwd-latest — rejected as racy) | **ignored** (verified: stdin facts invisible to the agent) | JSONL `message_end` `.text` (last) | none | none in events → None |

Dash-terminator `--` verified on all three (prompt starting with `-` reaches the agent). OxiCode context rides the positional prompt as `build_context(...) + "user_request: <message>\n"`.

---

### Task 1: Rust adapter cores — argv builders, parsers, disclosures, model listings

**Files:**
- Modify: `apps/desktop/src-tauri/src/copilot.rs` (KNOWN_AGENTS ~L38; disclosure ~L211; after `omp_args`/`parse_omp_jsonl` ~L695/L783; `list_models` ~L900)
- Test: same file, `mod tests`

**Interfaces (produced):**
- `claude_args(session: Option<&str>, model: Option<&str>, prompt: &str) -> Vec<String>`
- `codex_args(session: Option<&str>, model: Option<&str>, prompt: &str) -> Vec<String>` — resume form: `["exec","resume","--json","--skip-git-repo-check",(-m M…),SID,"--",PROMPT]`
- `oxicode_args(model: Option<&str>, prompt: &str) -> Vec<String>` (no session param)
- `struct ClaudeTurn { response, session_id, model, provider, denied: Vec<String> }` + `parse_claude_result(stdout: &str) -> ClaudeTurn`
- `struct CodexTurn { response, session_id }` + `parse_codex_jsonl(stdout: &str) -> CodexTurn`
- `parse_oxicode_jsonl(stdout: &str) -> String` (response only; reuse `parse_omp_jsonl`? No — different event names)
- `disclosure()`: claude → `~/.claude/settings.json` `model`, provider `Some("anthropic")` only when `ANTHROPIC_BASE_URL` unset, else None; codex → `~/.codex/config.toml` top-level `model` + `model_provider` (absent ⇒ `Some("openai")`); oxicode → `~/.oxicode/settings.json` `last_used_model`/`last_used_provider`
- `list_models()`: claude ⇒ `Ok(vec![])`, oxicode ⇒ `Ok(vec![])`, codex ⇒ `~/.codex/models_cache.json` `models[]` filtered `visibility=="list"` → `ModelInfo { id: slug, name: display_name, provider, context_window: None }`; missing file ⇒ `Ok(vec![])`
- KNOWN_AGENTS: `("claude", "claude", "Claude Code", true)`, `("codex", "codex", "Codex CLI", true)`, `("oxicode", "oxicode", "OxiCode", true)`, `("gemini", "gemini", "Gemini CLI", false)`

- [ ] **Step 1: failing tests** — parser tests with the exact live payloads captured above: claude (result/session_id/modelUsage canonicalModel `claude-haiku-4-5`, provider mapping, permission_denials with 1 Write denial), claude non-JSON fallback, codex JSONL (thread_id, agent_message join, error-event fallback), oxicode NDJSON (message_end text, multi-message last-wins, raw fallback), codex models_cache parse (7 models → 6, `codex-auto-review` hidden), disclosure parses for claude/codex/oxicode config bodies (fixture strings, not live $HOME).
- [ ] **Step 2: run** `cd apps/desktop/src-tauri && cargo test --lib copilot` — new tests FAIL (functions absent), existing pass.
- [ ] **Step 3: implement** builders/parsers/disclosures/KNOWN_AGENTS per Interfaces.
- [ ] **Step 4: run** `cargo test --lib copilot` — all PASS. `cargo clippy --lib` clean.
- [ ] **Step 5: commit** `feat: verified copilot adapters — claude, codex, oxicode (parsers+argv+disclosure)`

### Task 2: Turn dispatch + TurnResult.denials

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs` (dispatch ~L1871, response parse ~L1927, TurnResult ~L1731)
- Modify: `apps/desktop/src/lib/api.ts` (TurnResult + `denials: string[] | null`)

**Interfaces:**
- `copilot_send` match adds: `"claude" => (claude_args(session, model, &message), Some(vault_root))`, `"codex" => (codex_args(...), Some(vault_root))`, `"oxicode"` — prompt becomes `format!("{ctx}user_request: {message}\n")`, args `oxicode_args(model, &prompt_with_ctx)`, stdin `""`, cwd vault root. For oxicode only, pass empty stdin to `run_agent_process` (it ignores stdin anyway; empty keeps the write cheap).
- Response parse: claude ⇒ `parse_claude_result` → (response, session_id, model, provider) + `denials = t.denied`; codex ⇒ `parse_codex_jsonl` → (response, Some session, None, None); oxicode ⇒ `parse_oxicode_jsonl` → (response, None, None, None). `TurnResult.denials: Option<Vec<String>>` (None for non-claude).
- [ ] **Step 1: failing test** in copilot.rs tests: dispatch-shaped unit — `oxicode` prompt embedding (`build_context` output + `user_request:` line, selection block can't break out), and a `claude` end-to-end ignored test `real_claude_turn` mirroring `real_omp_turn` (asserts response non-empty, session_id Some, model Some, runs the exact adapter argv via `run_agent_process`). Same for `real_codex_turn` and `real_oxicode_turn` (all `#[ignore]`).
- [ ] **Step 2: run** — unit test fails, ignored tests compile.
- [ ] **Step 3: implement dispatch + TurnResult + api.ts type.**
- [ ] **Step 4:** `cargo test --lib copilot` PASS; run the three ignored tests once each (`cargo test --lib real_ -- --ignored --nocapture`) — live proof through the REAL adapter path (≈$0.15 total on the user's own CLIs, same precedent as `real_omp_turn`).
- [ ] **Step 5: commit** `feat: dispatch copilot turns through claude/codex/oxicode adapters`

### Task 3: Panel — policy-block note + honest model-picker empty state

**Files:**
- Modify: `apps/desktop/src/components/CopilotPanel.tsx` (AgentMessage ~L578; picker ~L268-321)
- Modify: `apps/desktop/src/lib/locales/{en,ko}.ts`

**Interfaces:** consumes `TurnResult.denials`. New keys: `copilot_denied_tools` (ko: `"{n}개 도구 요청이 {agent} 정책에 의해 차단되었습니다 — 쓰기 위임은 해당 에이전트 설정에서 허용하세요"` / en: `"{n} tool request(s) were blocked by {agent}'s own policy — allow writes in that agent's settings if you want vault edits"`), `copilot_model_unlisted` (ko: `이 에이전트는 모델 목록을 제공하지 않습니다` / en: `This agent does not publish a model list`).

- [ ] **Step 1:** AgentMessage renders the note (subtle, `text-[10px] text-text-subtle`, icon-free, between response and model line) when `denials?.length`; picker shows `copilot_model_unlisted` hint when `!models.isLoading && (models.data?.length ?? 0) === 0`, and the red error line stays for real `models.isError`.
- [ ] **Step 2:** `npx tsc -b` clean; visual smoke via browser (mock copilot-status + entries with denials).
- [ ] **Step 3: commit** `feat: copilot panel shows policy-blocked tool requests and unlisted-model state`

### Task 4: Settings — activation that visibly does something

**Files:**
- Modify: `apps/desktop/src/components/SettingsMenu.tsx` (CopilotSection ~L358-548)
- Modify: `apps/desktop/src/lib/locales/{en,ko}.ts`

**Interfaces:** consumes existing `setToast(msg, {label, onClick})`, `useUI.setCopilotOpen`, `copilotStatus`. New keys: `copilot_activated_toast` (ko: `"{agent} 활성화됨"` / en: `"{agent} activated"`), `copilot_open_panel` (ko: `코파일럿 열기` / en: `Open copilot`), `copilot_policy_readonly` (ko: `기본 정책이 읽기 전용일 수 있습니다 — 쓰기 위임은 이 에이전트의 설정에서 허용하세요` / en: `Its default policy may be read-only — allow writes in this agent's own settings to delegate vault edits`).

- [ ] **Step 1:** `activate()` success path: `setToast(t.copilot_activated_toast.replace("{agent}", c.display_name), { label: t.copilot_open_panel, onClick: () => setCopilotOpen(true) })`. Active-agent box: title becomes display name (from a `copilotStatus` query already in the tree — `agent_name`), raw id moves to the mono sub-line; for `claude`/`codex` add the one-line `copilot_policy_readonly` hint (verified read-only defaults only).
- [ ] **Step 2:** `npx tsc -b` clean; browser smoke: activate flow → toast + FAB + panel open.
- [ ] **Step 3: commit** `feat: copilot activation gives visible feedback (toast + open action + display names)`

### Task 5: Docs + real-run proof

**Files:**
- Modify: `CHANGELOG.md` (Added), `README.md` L40 adapters parenthetical, `docs/superpowers/specs/2026-08-23-copilot-panel-design.md` status line (개정 3), `doc/DESIGN.md` §10.4 if it enumerates adapters.

- [ ] **Step 1:** Update all four (adapters: `oxios`, `omp`, `claude`, `codex`, `oxicode`; gemini listed-unverified; oxicode single-turn note; §11 constraint unchanged and now load-bearing across 5 adapters).
- [ ] **Step 2:** Full local gates: `cargo test --lib` (src-tauri), `cargo fmt --check`+`clippy`, `npx tsc -b`, vitest run of existing copilot unit tests, `cargo test -p oximemo-core -p oximemo-cli -p oximemo-capture` (CI parity).
- [ ] **Step 3: commit** `docs: copilot adapters claude/codex/oxicode — changelog, readme, spec status`
