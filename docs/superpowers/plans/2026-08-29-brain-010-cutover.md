# Brain 0.10 Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port oximemo's oxibrain integration from the retired daemon/socket client v0.7 to the caller-owned stdio client v0.10.1, with oximemo-owned ingestion (documents.toml ensure + debounced index runs).

**Architecture:** No resident daemon. Each brain interaction spawns `oxibrain admin serve --stdio --dir <brain_dir>` via `BrainClient::spawn_local`, handshakes, calls one op, and drops the child. Vault→brain ingestion is two core/desktop operations: an idempotent `ensure_document_root` write into `~/.oxi/brain/documents.toml` at open, and a single-flight detached `oxibrain index --documents` run on boot and debounced saves.

**Tech Stack:** Rust (edition 2024, tokio, toml), oxibrain-client 0.10.1 (git tag v0.10.1), Tauri 2, React 19.

**Spec:** `docs/superpowers/specs/2026-08-29-brain-010-cutover-design.md` (spaces companion: `docs/superpowers/specs/2026-08-28-spaces-design.md`; existing spaces plan: `docs/superpowers/plans/2026-08-28-spaces.md` — Task 7 below amends it).

## Global Constraints

- Client dep (workspace root `Cargo.toml`): `oxibrain-client = { version = "0.10", git = "https://github.com/a7garden/oxibrain", tag = "v0.10.1" }` — verbatim.
- Brain data dir: `~/.oxi/brain` (HOME-derived; NOT user-configurable). documents.toml lives at `~/.oxi/brain/documents.toml`.
- Spawn argv is the client's job: `LocalProcessEndpoint::new(executable, dir)` → `oxibrain admin serve --stdio --dir <dir>` (v2.13 admin namespace).
- `spawn_local` does NOT handshake — callers must `handshake(default_client_hello("oximemo <version>"))` after spawning.
- Space derivation (pulled forward from amended spaces spec §2): space = vault directory basename; root-less/flat fallback `"personal"`. `resolve_space` and `BrainConfig::space`/`socket` are deleted; stale TOML keys parse-and-ignore via `#[serde(default)]`.
- Brain is additive (C1): every failure path logs and degrades; no command may block open or error the editor.
- English code/comments/commits; conventional commits; Korean UI copy mirrors in `locales/ko.ts` + `en.ts`.
- Environment note: the harness shell worker is dead — run all commands via the eval kernel (`Bun.spawn([...])`), one binary per spawn, e.g. `Bun.spawn(["cargo","test","-p","oximemo-core","brain"],{cwd:"/Volumes/MERCURY/PROJECTS/oximemo",stdout:"pipe",stderr:"pipe"})`.

---

### Task 1: Core — config rework + `brain.rs` rewrite to documents-plane glue

**Files:**
- Modify: `Cargo.toml` (workspace root, line 57 dep)
- Modify: `crates/oximemo-core/src/config.rs:60-81` (`BrainConfig`), tests ~383-407
- Modify: `crates/oximemo-core/src/brain.rs` (full rewrite of non-test part; test module replaced)
- Modify: `crates/oximemo-core/src/vault.rs:231-239` (open registration block) and brain-related vault tests (~5782-5840, ~7619+)
- Modify: `crates/oximemo-core/src/paths.rs` (add `brain_dir()`)
- Modify: `apps/desktop/src-tauri/tests/brain_live.rs` (rewrite; compiles against new API)

**Interfaces:**
- Produces (used by Task 2):
  - `oximemo_core::brain::brain_dir() -> PathBuf` — `HOME/.oxi/brain` (panics never; falls back to `.oxi/brain` under empty HOME).
  - `oximemo_core::brain::ensure_document_root(vault: &Path, space: &str) -> EnsureOutcome` — `enum EnsureOutcome { Added, Present, SkippedInvalid }`.
  - `oximemo_core::brain::vault_space_name(vault: &Path) -> String` — basename or `"personal"`.
  - `Vault::open` no longer spawns threads/clients; it calls `ensure_document_root` synchronously when `config.brain.enabled`.
- Deleted: `Registration`, `BrainRegistrar`, `register_vault`, `resolve_space`, `with_test_recorder`, `RealBrainRegistrar`, memo statics.

- [ ] **Step 1: Failing tests first** (new `brain.rs` test module). Core cases:

```rust
// each test seeds HOME = tempdir via a helper `with_home(dir, f)` (swap
// std::env::set_var("HOME"), matching paths.rs migrate-test precedent)
#[test] fn absent_documents_toml_is_created_with_one_root() {
    with_home(|home| {
        let vault = home.join(".oxi/vault/personal");
        std::fs::create_dir_all(&vault).unwrap();
        let out = ensure_document_root(&vault, "personal");
        assert_eq!(out, EnsureOutcome::Added);
        let text = std::fs::read_to_string(home.join(".oxi/brain/documents.toml")).unwrap();
        assert!(text.contains(&format!("path = \"{}\"", vault.display())));
        assert!(text.contains("space = \"personal\""));
    });
}
#[test] fn exact_path_root_is_present_no_rewrite();      // pre-seed documents.toml with the root, assert outcome Present AND file bytes unchanged
#[test] fn same_path_different_alias_space_is_present(); // operator config never clobbered
#[test] fn invalid_toml_is_never_touched();              // seed "not [ toml", assert SkippedInvalid + bytes unchanged
#[test] fn vault_space_name_uses_basename_or_personal(); // /tmp/x/work -> "work"; "/tmp" (no basename match, i.e. root) -> "personal"
#[test] fn stale_config_keys_parse_and_ignore();         // in config.rs tests: "[brain]\nsocket = \"/x\"\nspace = \"work\"" parses, defaults hold
```

- [ ] **Step 2: Run to verify fail** — `cargo test -p oximemo-core brain` → compile error (functions missing).

- [ ] **Step 3: Implement.**

`config.rs`:

```rust
/// oxibrain integration settings. `executable` empty = spawn `"oxibrain"`
/// and let the OS resolve PATH. Stale `socket`/`space` keys from older
/// oximemo.toml files parse as unknown and are ignored (`#[serde(default)]`,
/// no `deny_unknown_fields`).
pub struct BrainConfig {
    /// Panel visibility and context gathering master switch.
    pub enabled: bool,
    /// Override for the oxibrain binary; empty = PATH lookup.
    pub executable: String,
}
impl Default for BrainConfig { /* enabled: true, executable: "" */ }
```

Update config tests: replace socket/space assertions with `executable == ""`; add the stale-keys-parse case; `config_json()` gains `executable`.

`paths.rs` (beside `default_vault_dir`):

```rust
/// `~/.oxi/brain` — the oxibrain data plane (caller-owned stdio children
/// are pointed here with `--dir`). Empty HOME falls back to `.oxi/brain`
/// (tests swap HOME the same way as migrate-vault tests).
pub fn brain_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".oxi").join("brain")
}
```

`brain.rs` rewrite — module doc states: brain is a CLI call, no daemon; oximemo owns exactly two writes into the brain dir (this ensure + the migration flat-root rewrite); registration is idempotent by exact-path filesystem check, no memo needed. Implementation:

```rust
pub fn vault_space_name(vault: &Path) -> String {
    vault.file_name().and_then(|n| n.to_str()).filter(|s| !s.is_empty())
        .unwrap_or("personal").to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnsureOutcome { Added, Present, SkippedInvalid }

#[derive(serde::Deserialize, serde::Serialize)]
struct DocumentRoot { alias: String, path: String, space: String }

#[derive(serde::Deserialize, serde::Serialize, Default)]
struct DocumentsFile { #[serde(default, rename = "root")] roots: Vec<DocumentRoot> }

pub fn ensure_document_root(vault: &Path, space: &str) -> EnsureOutcome {
    let file = crate::paths::brain_dir().join("documents.toml");
    let (mut doc, outcome_seed) = match std::fs::read_to_string(&file) {
        Err(_) => (DocumentsFile::default(), None),
        Ok(text) => match toml::from_str::<DocumentsFile>(&text) {
            Ok(d) => (d, Some(text)),
            Err(e) => { tracing::warn!(error = %e, "brain: documents.toml unparseable; leaving untouched"); return EnsureOutcome::SkippedInvalid; }
        },
    };
    let vault_str = vault.to_string_lossy();
    if doc.roots.iter().any(|r| Path::new(&r.path) == vault) {
        return EnsureOutcome::Present;
    }
    doc.roots.push(DocumentRoot { alias: space.to_string(), path: vault_str.into_owned(), space: space.to_string() });
    let body = toml::to_string_pretty(&doc).expect("serialize documents.toml");
    // atomic write: tempfile in same dir + rename
    let tmp = file.with_extension("toml.oximemo-tmp");
    if std::fs::write(&tmp, body).and_then(|_| std::fs::rename(&tmp, &file)).is_err() {
        tracing::warn!("brain: failed to write documents.toml");
    }
    let _ = outcome_seed;
    EnsureOutcome::Added
}
```

(Path comparison on `Path` equality: lexical, matching how oxibrain seeds absolute paths; migration rewrite §3.4 of the spaces plan uses exact string match — keep that plan's rule unchanged there.)

`vault.rs` open block:

```rust
if config.brain.enabled {
    let space = crate::brain::vault_space_name(&paths.vault);
    match crate::brain::ensure_document_root(&paths.vault, &space) {
        Ok(outcome) => tracing::debug!(?outcome, space = %space, "brain: document root ensured"),
        // ensure returns EnsureOutcome, not Result — keep signature Result-free
    }
}
```

(If `ensure_document_root` is infallible — it is — call it directly.)

Vault brain tests: replace recorder-based registration tests with filesystem assertions — after `Vault::open`, `documents.toml` contains the vault path root; repeated open does not duplicate roots (count roots with matching path == 1). Delete `with_test_recorder`/`fresh_recorder` helpers and `repeated_open_same_tuple_registers_only_once` (superseded by no-duplicate-root test).

- [ ] **Step 4: Run core tests** — `cargo test -p oximemo-core` PASS; `cargo check --workspace` — desktop will NOT compile yet (expected; Task 2 fixes). Core-only green is the gate.

- [ ] **Step 5: Commit** — `feat(core): brain 0.10 documents-plane glue replaces daemon registration`

### Task 2: Desktop — spawn_brain, command ports, index trigger

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs:659-705` (`BrainEndpointConf`/`brain_connect` → `spawn_brain`), `1473-1588` (four commands → three), `generate_handler` list, `AppState` (index trigger)
- Modify: `apps/desktop/src-tauri/src/lib.rs` watcher debounce site (call `request_brain_index()` where the vault reindex is debounced)
- Modify: `apps/desktop/src-tauri/tests/brain_live.rs`

**Interfaces:**
- Consumes: Task 1 (`brain_dir`, `vault_space_name`, `ensure_document_root`).
- Produces (frontend contract, Task 3):
  - `brain_status` → `{ online, reason: null|"binary_missing"|"spawn_failed"|"handshake_failed"|"stats_failed"|"disabled", server_version: string|null, episodes/entities/statements/contradictions: number|null }`
  - `brain_gather(query, budget?)` → recall envelope Value verbatim; `Err(string)` on failure (unchanged contract)
  - `brain_history(path)` → `[{ revision: string, committed_at_ms: number, content: string }]` (from `document_history`)
  - `brain_list_spaces` — DELETED
  - `requestBrainIndex()` — internal, not a command

- [ ] **Step 1: spawn_brain helper** (replaces `BrainEndpointConf` + `brain_connect`):

```rust
enum BrainFailure { BinaryMissing, SpawnFailed(String), HandshakeFailed(String) }

struct BrainConf { enabled: bool, executable: String, space: String }
impl BrainConf {
    fn from_vault_config(c: &oximemo_core::config::VaultConfig) -> Self {
        Self {
            enabled: c.brain.enabled,
            executable: c.brain.executable.clone(),
            space: oximemo_core::brain::vault_space_name(c.vault_path()), // see note
        }
    }
}
// note: VaultConfig does not carry the vault path; resolve space at the
// command site from state.vault.paths().vault instead — BrainConf holds
// enabled+executable only, space is passed per call.

async fn spawn_brain(executable: &str) -> Result<(BrainClient, BrainCapabilities), BrainFailure> {
    let endpoint = oxibrain_client::LocalProcessEndpoint::new(
        if executable.is_empty() { "oxibrain".to_string() } else { executable.to_string() },
        oximemo_core::paths::brain_dir(),
    );
    let mut client = BrainClient::spawn_local(endpoint).await
        .map_err(|e| match e.downcast_ref::<std::io::Error>() {
            Some(io) if io.kind() == std::io::ErrorKind::NotFound => BrainFailure::BinaryMissing,
            _ => BrainFailure::SpawnFailed(e.to_string()),
        })?;
    let caps = client.handshake(default_client_hello(concat!(env!("CARGO_PKG_NAME"), " ", env!("CARGO_PKG_VERSION")))).await
        .map_err(|e| BrainFailure::HandshakeFailed(e.to_string()))?;
    Ok((client, caps))
}
```

Spawn error typing: if the client's error type is `anyhow::Error`, `e.root_cause().downcast_ref::<std::io::Error>()`; verify against the actual error shape at implementation time (client `spawn_child` uses `.context("spawn …")` on `cmd.spawn()` — root cause is the io::Error). Unit-test the executable default: empty → `"oxibrain"` (pure fn `resolve_executable(&str) -> String`, test it).

- [ ] **Step 2: Port commands.**

`brain_status`: disabled → `{online:false, reason:"disabled"}`; BrainFailure → `{online:false, reason:"<variant>"}`; success → spawn → `stats(space)` → counts (lenient `as_u64`), `server_version` from caps; stats error → `{online:false, reason:"stats_failed"}`. Never `Err`.

`brain_gather`: unchanged shape; spawn_brain failure → `Err(format!("brain offline: {reason:?}"))`; then `client.recall(&query, &space, budget)` forwarded verbatim.

`brain_history`: replace `episodes_for_locator` with `client.document_history(&space, &alias, &path)` where `alias = space` (Task 1 ensure uses alias == space; keep one derivation helper). Map `Vec<DocumentRevisionDto>` → JSON array `{revision, committed_at_ms, content}`.

Delete `brain_list_spaces` command + handler entry.

- [ ] **Step 3: Index trigger in AppState.**

```rust
struct AppState {
    // existing fields…
    brain_indexing: std::sync::atomic::AtomicBool,
    brain_executable: String,
}
impl AppState {
    /// Single-flight, fire-and-forget reconcile of documents.toml roots.
    fn request_brain_index(&self) {
        use std::sync::atomic::Ordering;
        if !self.brain_enabled { return; }           // captured at boot from config
        if self.brain_indexing.swap(true, Ordering::SeqCst) { return; }
        let exec = self.brain_executable.clone();
        std::thread::Builder::new().name("oximemo-brain-index".into()).spawn(move || {
            let _guard = IndexInFlight;              // guard struct resets AtomicBool on drop (or reset inline after wait)
            let output = std::process::Command::new(if exec.is_empty() { "oxibrain" } else { &exec })
                .arg("index").arg("--documents")
                .arg("--dir").arg(oximemo_core::paths::brain_dir())
                .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
                .output();
            match output { Ok(o) => tracing::debug!(status = %o.status, "brain index done"), Err(e) => tracing::debug!(error = %e, "brain index skipped") }
        }).ok();
    }
}
```

Call sites: once after boot `Vault::open` succeeds; in the watcher debounce handler right after the vault reindex call. Reset `brain_indexing` when the thread finishes (guard-drop pattern; keep the reset inside the thread body).

Verify `oxibrain index --documents --dir <dir>` argument shape against `oxibrain --help` on this machine before finalizing (the v2.13 CLI moved verbs under namespaces; if `index` now requires different spelling, match the real CLI — run `oxibrain index --help` and adjust).

- [ ] **Step 4: brain_live.rs rewrite:**

```rust
//! Live oxibrain integration: spawns the real binary. Requires `oxibrain`
//! on PATH; run with `cargo test -p oximemo-desktop --ignored`.
#[tokio::test] #[ignore = "requires the oxibrain binary on PATH"]
async fn live_status_and_recall() {
    // skip cleanly when binary missing: which oxibrain / spawn probe
    // spawn_brain("") → caps.server_version non-empty; stats("personal") has count keys
}
```

- [ ] **Step 5: `cargo check -p oximemo-desktop` PASS; commit** — `feat(desktop): caller-owned brain client and index trigger`

### Task 3: Frontend — types, api, panel reason states, settings rows, locales

**Files:**
- Modify: `apps/desktop/src/lib/types.ts:44-57` (BrainStatus), `:241` (brain config), `HistoryEpisode` (align to document_history shape)
- Modify: `apps/desktop/src/lib/api.ts` (remove `brainListSpaces`; type updates)
- Modify: `apps/desktop/src/lib/tauri.ts` (remove `brain_list_spaces` case; `brain_status` fallback gains `reason`)
- Modify: `apps/desktop/src/components/ContextDock.tsx` (dropped note), `BrainCard.tsx` (reason line), `SettingsMenu.tsx:270-352` (Brain section), `HistoryPanel.tsx` (field names if changed)
- Modify: `apps/desktop/src/lib/locales/ko.ts` + `en.ts`

- [ ] **Step 1: types/api.** `BrainStatus { online; reason?: "binary_missing"|"spawn_failed"|"handshake_failed"|"stats_failed"|"disabled"; server_version?; episodes?; entities?; statements?; contradictions? }`. `brain?: { enabled?: boolean; executable?: string }`. Remove `BrainSpaces` type + `brainListSpaces`. `HistoryEpisode { revision; committed_at_ms; content }` (rename fields only if Rust shape differs).

- [ ] **Step 2: SettingsMenu Brain section.** Rows: enabled toggle (existing) + `executable` TextRow (`label: t.brain_executable`, `placeholder: t.brain_executable_ph`, `patch({ executable: v })`). Delete the daemon-spaces picker block and its `brain-spaces` query. (Spaces spec's derived-space readout line arrives with the spaces plan Task 8 — not here.)

- [ ] **Step 3: BrainCard reason + offline copy.** When `status?.online === false && status.reason` and reason ≠ "disabled", render `<p className="text-xs text-text-subtle">{t["brain_reason_"+reason]}</p>` where present (fallback to the existing offline line). ContextDock: after `layersOf(v)`, if `v?.meta?.dropped` non-empty set a `dropped` count; render collapsible `{t.brain_dropped.replace("{n}", …)}` line.

- [ ] **Step 4: locales** (ko / en respectively):

```ts
// remove: brain_socket, brain_socket_ph, brain_space, brain_space_offline
brain_executable: "oxibrain 실행 파일" / "oxibrain binary",
brain_executable_ph: "비워두면 PATH에서 oxibrain" / "Empty = oxibrain from PATH",
brain_reason_binary_missing: "oxibrain을 찾을 수 없습니다 (설치: cargo install oxibrain-cli)" / "oxibrain not found (install: cargo install oxibrain-cli)",
brain_reason_spawn_failed: "oxibrain 실행 실패" / "Failed to start oxibrain",
brain_reason_handshake_failed: "oxibrain 버전이 호환되지 않습니다" / "Incompatible oxibrain version",
brain_reason_stats_failed: "브레인 통계를 읽지 못했습니다" / "Failed to read brain stats",
brain_dropped: "결과 {n}개 잘림" / "{n} results truncated",
```

Also update `git_autocommit_hint` copy removing the "브레인 데몬 없이" daemon phrasing ("브레인 없이도 동작합니다").

- [ ] **Step 5: `bun x tsc --noEmit` && `bun test` && `bun run build` PASS; commit** — `feat(desktop): brain panel failure reasons, executable setting, dropped notice`

### Task 4: Spaces plan delta + docs

**Files:**
- Modify: `docs/superpowers/plans/2026-08-28-spaces.md` (delta edits below)
- Modify: `CHANGELOG.md`, `README.md`

- [ ] **Step 1: Spaces plan delta edits** (each is a concrete replacement in that file):
  1. Global Constraints: add pointer — "brain registration follows the 0.10 cutover plan (ensure_document_root + index trigger); no recorder/sync_run anywhere."
  2. Task 4 registration block: replace `crate::brain::register_vault(&paths.vault, &space, &config.brain.socket)` with `crate::brain::ensure_document_root(&paths.vault, &space);` (already in mainline after this plan's Task 1 — the delta makes the spaces plan consistent if re-read standalone). Replace the `BrainEndpointConf` snippet's `socket: c.brain.socket.clone()` with `executable: c.brain.executable.clone()` and space from `vault_space_name`.
  3. Task 4 `resolve_space` deletion + module-doc replacement: already landed in this plan's Task 1 — mark those steps "done in 2026-08-29 cutover Task 1" (keep as checkboxes for standalone readers is fine; note the overlap).
  4. Task 7: remove "remove `brain_list_spaces` command" step (already gone); `generate_handler` delta note only.
  5. Task 8: Settings Brain section rewrite step references `executable` row (already landed) — reduce to the derived-space readout line only.
- [ ] **Step 2: README** — rewrite the `[brain]` section: `enabled`/`executable`, PATH lookup, no socket, oxibrain ≥ 0.10 required, ingestion is oximemo-triggered (`oxibrain index --documents`).
- [ ] **Step 3: CHANGELOG** — new entry: brain 0.10 cutover (breaking: `[brain]` socket/space keys ignored; oxibrain ≥0.10.1 required; `brain_list_spaces` IPC removed; HistoryPanel now backed by `document_history`), spaces pointer.
- [ ] **Step 4: Commit** — `docs: brain 0.10 cutover notes; align spaces plan`

### Task 5: Verification

- [ ] `cargo test -p oximemo-core` and `cargo test -p oximemo-cli` PASS (eval kernel).
- [ ] `cargo check --workspace` clean.
- [ ] `bun x tsc --noEmit`, `bun test`, `bun run build` PASS.
- [ ] Live smoke (this machine has oxibrain): run `oxibrain index --documents --dir ~/.oxi/brain` manually once → exit 0; `cargo test -p oximemo-desktop --ignored --brain_live` → handshake + stats assert PASS. GUI smoke deferred to user if app can't launch headless; the CLI-level live test is the exercised proof.
- [ ] Working tree clean: batch-commit any residue (batch-commit-autonomously skill).

## Self-Review

- Spec coverage: dep bump (T1), config (T1), core glue (T1), spawn/status/gather (T2), index trigger (T2), brain_history port (T2 — spec gap found during exploration, folded in), brain_list_spaces removal (T2/T3), UI reasons + locales + dropped notice (T3), spaces spec amendment (committed earlier) + spaces plan delta (T4), README/CHANGELOG (T4), live smoke (T5). No gaps.
- Placeholders: none — every code step has concrete code or an exact file+line anchor; the two "verify at implementation" notes (client error downcast, `oxibrain index` argv) are bounded lookups with stated defaults, not open questions.
- Type consistency: `EnsureOutcome`/`vault_space_name`/`brain_dir` names match between T1 produces and T2 consumes; frontend `reason` string union matches T2's serialized variants.
