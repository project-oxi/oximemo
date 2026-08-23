# Shared Vault Git Layer — Ecosystem Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give oximemo a local, git-based safety net for `~/.oxi/vault` (mechanical, offline-capable, per C1) by extracting oxios's already-shipped `GitLayer` into a shared crate, and expose oxibrain's already-recorded full-content revision history (`episodes.content`) as a queryable per-note history API, so oximemo's UI can show semantic history on top without any new backend storage.

**Architecture:** Two independent layers, never merged into one store (see design rationale below):
1. **Mechanical layer** — `oxi-vault-git` (new shared crate, extracted from `oxios-kernel::git_layer`), consumed directly by both oxios and oximemo. Synchronous gix commits, no network, no daemon dependency.
2. **Semantic layer** — oxibrain's existing pull-connector occurrence chain (ADR-010, already ingesting `~/.oxi/vault`), extended with one new read API (`Brain::episodes_for_locator`) so oximemo can render "how this note evolved" without oxibrain ever writing into the vault (C3 unchanged).

**Tech Stack:** Rust (edition 2024), `gix` 0.83 (pure-Rust git, no CLI shell-out), `tokio` (async commit consumer), `rusqlite` (oxibrain store, unchanged schema), Tauri 2 IPC (oximemo).

**Why this split (not "put git in oxibrain"):** `oxibrain/doc/ECOSYSTEM.md` C1 — the brain must be additive, never load-bearing; a daemon-down user must still be able to undo a bad edit. C3 — oxibrain never writes into a user's vault. A git-commit safety net requires both synchronous local writes and availability with the daemon stopped/uninstalled, which rules out hosting it in oxibrain. Full rationale is in the session transcript preceding this plan; Phase 5 records it as an ADR.

## Global Constraints

- Every repo's own `AGENTS.md`/`CONTRIBUTING.md` conventions apply: conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`), squash merge, English commit messages.
- `oximemo`'s capture path budget is CI-measured ≤16 ms (ECOSYSTEM.md §3.1 guardrail #1) — no git operation may run synchronously inside a Tauri command that touches capture. All commit work is queued to a background consumer.
- oxibrain's stable surface (`oxibrain::*`, pinned in `doc/CONSUMPTION_CONTRACT.md`) is additive-only within a major version — the new API is a pure addition, no signature changes to existing methods.
- `oxi-vault-git`'s ownership-marker check must not break any existing oxios installation that already has `.oxios-git` written to a live vault — legacy marker must remain recognized, not migrated.
- Each phase ends with the affected repo's full test/lint gate green before merge: `cargo fmt --all -- --check`, `cargo clippy --workspace --all-features -- -D warnings` (or the repo's documented equivalent), `cargo test`/`cargo nextest run --workspace`.

---

## Phase 1 — Extract `oxi-vault-git` (home: oximemo repo, mirrors `oxi-frontmatter`)

Precedent: `oxi-frontmatter` lives at `oximemo/crates/oxi-frontmatter`, `publish = true`, released to crates.io by `.github/workflows/release.yml`'s `publish-crates` job (leaf crates first, `cargo publish -p <crate>` gated on "not already at this version"). `oxi-vault-git` follows the identical shape.

### Task 1.1: Scaffold the crate and move `GitLayer` verbatim

**Files:**
- Create: `oximemo/crates/oxi-vault-git/Cargo.toml`
- Create: `oximemo/crates/oxi-vault-git/src/lib.rs`
- Move: `oxios/crates/oxios-kernel/src/git_layer.rs` → `oximemo/crates/oxi-vault-git/src/lib.rs` (content copied verbatim first; oxios's copy is deleted in Task 2.1, not here — Phase 1 must build and pass tests standalone before Phase 2 touches oxios)
- Modify: `oximemo/Cargo.toml` — add `"crates/oxi-vault-git"` to `[workspace] members`

**Interfaces:**
- Produces (public API, unchanged from the current `oxios-kernel::git_layer` surface):
  - `GitLayer::new(root: PathBuf, enabled: bool) -> Result<Self>`
  - `GitLayer::new_for_vault(root: PathBuf, enabled: bool, adopt_foreign_repo: bool) -> Result<Self>` (behavior changes in Task 1.2)
  - `GitLayer::commit_file(&self, rel_path: &str, msg: &str) -> Result<CommitInfo>`
  - `GitLayer::remove_file(&self, rel_path: &str, msg: &str) -> Result<CommitInfo>`
  - `GitLayer::is_enabled(&self) -> bool`
  - `GitLayer::root(&self) -> &Path`
  - `GitLayer::disabled_reason(&self) -> Option<&str>`
  - `pub fn rel_path(kb_root: &Path, git_root: &Path, path: &str) -> String`
  - Types: `CommitInfo`, `LogEntry`, `CommitContext`, `DiffKind`, `FileDiff`, `DiffStats`, `CommitDiff`

**Cargo.toml contents** (mirrors `oxios-kernel`'s existing dependency versions exactly — `gix = { version = "0.83", features = ["tree-editor", "blob-diff"] }`, `anyhow`, `parking_lot`, `tempfile` dev-dep):

```toml
[package]
name = "oxi-vault-git"
version = "0.1.0"
edition = "2024"
description = "Shared local git-based revision safety net for the oxi ecosystem's shared vault (~/.oxi/vault). Synchronous, offline-capable, no daemon dependency."
license = "MIT"
repository = "https://github.com/project-oxi/oximemo"
homepage = "https://github.com/project-oxi/oximemo"
categories = ["filesystem"]
keywords = ["git", "vault", "oxi", "version-control"]
publish = true

[dependencies]
anyhow = "1"
gix = { version = "0.83", features = ["tree-editor", "blob-diff"] }
parking_lot = "0.12"
serde = { version = "1", features = ["derive"] }

[dev-dependencies]
tempfile = "3"

[lints]
workspace = true
```

- [ ] Copy `oxios/crates/oxios-kernel/src/git_layer.rs` content into `oximemo/crates/oxi-vault-git/src/lib.rs` unchanged (this is Task 1.2's starting point — do not edit yet in this step).
- [ ] Add the crate to `oximemo/Cargo.toml` workspace members.
- [ ] Run: `cargo build -p oxi-vault-git` (from `oximemo/`). Expected: compiles clean — `git_layer.rs` has zero `oxios-kernel`-internal imports (verified: only `anyhow`, `gix`, `parking_lot`, `std`).
- [ ] Run: `cargo test -p oxi-vault-git`. Expected: all ~30 existing tests pass unchanged (they were already fully self-contained — construct a `tempfile::TempDir`, call `GitLayer::new`/`new_for_vault`).
- [ ] Commit: `git add crates/oxi-vault-git Cargo.toml && git commit -m "feat(oxi-vault-git): scaffold crate, port GitLayer from oxios-kernel"`

### Task 1.2: Generalize the ownership marker to an ecosystem-shared name with legacy back-compat

**Files:**
- Modify: `oximemo/crates/oxi-vault-git/src/lib.rs`

**Interfaces:**
- Produces: `pub const VAULT_GIT_MARKER: &str = ".oxi-vault-git";` (new, exported) and `pub const LEGACY_VAULT_GIT_MARKERS: &[&str] = &[".oxios-git"];` (new, exported)
- `new_for_vault`'s ownership check changes from "does `GIT_OWNERSHIP_MARKER` exist" to "does `VAULT_GIT_MARKER` OR any of `LEGACY_VAULT_GIT_MARKERS` exist" — this is the only behavior change; everything else (foreign-repo detection, `adopt_foreign_repo`, corruption fallback) is unchanged.

**Why:** oximemo and oxios will both auto-commit into the *same* `~/.oxi/vault` repo. If each app checked its own private marker name, whichever app boots second would see the other's already-initialized repo as "foreign" (no matching marker) and disable itself with a loud warning — a real regression for any user running both apps. A single shared marker name, recognized by both, plus the pre-existing `.oxios-git` name kept as a permanently-recognized legacy alias, avoids a breaking migration for oxios's existing installed base.

- [ ] Rename `GIT_OWNERSHIP_MARKER` → `VAULT_GIT_MARKER`, change its value from `.oxios-git` to `.oxi-vault-git`, and make it `pub` (was `pub(crate)`).
- [ ] Add `pub const LEGACY_VAULT_GIT_MARKERS: &[&str] = &[".oxios-git"];`.
- [ ] In `new_for_vault` and `new_with_ownership`, replace every `root.join(GIT_OWNERSHIP_MARKER).exists()` ownership check with a helper:
  ```rust
  fn vault_marker_present(root: &Path) -> bool {
      root.join(VAULT_GIT_MARKER).exists()
          || LEGACY_VAULT_GIT_MARKERS.iter().any(|m| root.join(m).exists())
  }
  ```
- [ ] Fresh-init path (no marker of any kind present) writes `VAULT_GIT_MARKER` only — never writes a legacy name. A legacy-only repo is recognized as owned but is **not** rewritten with the new marker (no forced mutation of an existing user's tree); both marker files may coexist over time as vaults get touched by newer binaries, which is harmless.
- [ ] Update `GITIGNORE` constant's `.oxios-git` line to `.oxi-vault-git` and add a second line for `.oxios-git` (both must stay untracked).
- [ ] Update every test in `mod tests` that references `.oxios-git`/`GIT_OWNERSHIP_MARKER` to use the renamed constants; add one new test:
  ```rust
  #[test]
  fn legacy_oxios_marker_is_recognized_as_owned() {
      let dir = tempfile::tempdir().unwrap();
      let root = dir.path().to_path_buf();
      // Simulate a pre-existing oxios-owned repo (old marker only).
      let legacy = GitLayer::new(root.clone(), true).unwrap();
      std::fs::write(root.join(".oxios-git"), "legacy marker").unwrap();
      drop(legacy);

      let layer = GitLayer::new_for_vault(root, true, false).unwrap();
      assert!(layer.is_enabled(), "legacy .oxios-git marker must be recognized as ownership proof");
      assert!(layer.disabled_reason().is_none());
  }
  ```
- [ ] Run: `cargo test -p oxi-vault-git`. Expected: all tests pass, including the new legacy-marker test.
- [ ] Commit: `git commit -am "feat(oxi-vault-git): shared .oxi-vault-git marker with .oxios-git back-compat"`

### Task 1.3: Wire crates.io publishing

**Files:**
- Modify: `oximemo/.github/workflows/release.yml` — add `oxi-vault-git` to the leaf-crates publish loop (same job that already publishes `oximemo-core oximemo-capture`)

- [ ] In the `publish-crates` job's "Publish leaf crates" step, change `for crate in oximemo-core oximemo-capture; do` to `for crate in oximemo-core oximemo-capture oxi-vault-git; do` (it has no internal workspace dependency, so it's a leaf crate like the other two — no ordering constraint against them).
- [ ] Commit: `git commit -am "ci(release): publish oxi-vault-git to crates.io"`

### Task 1.4: Merge Phase 1 to oximemo main

- [ ] Open PR from the working branch (`feat/oxi-vault-git-extraction`) against `main`.
- [ ] Verify CI green (fmt, clippy, full test suite for the whole oximemo workspace — adding a workspace member must not break existing `oximemo-core`/`oximemo-cli`/`oximemo-capture` builds).
- [ ] Squash-merge.
- [ ] Tag a release per oximemo's existing release process so `publish-crates` runs and `oxi-vault-git@0.1.0` lands on crates.io — Phase 2 and Phase 4 both depend on this being published before they can add the crates.io dependency.

---

## Phase 2 — oxios adopts `oxi-vault-git`

Depends on: Phase 1 published (`oxi-vault-git@0.1.0` on crates.io).

### Task 2.1: Replace the internal module with the published crate

**Files:**
- Delete: `oxios/crates/oxios-kernel/src/git_layer.rs`
- Modify: `oxios/crates/oxios-kernel/src/lib.rs` — remove `pub mod git_layer;`, add `pub use oxi_vault_git as git_layer;` (keeps every existing `use crate::git_layer::{GitLayer, ...}` call site in oxios unchanged — zero call-site churn)
- Modify: `oxios/crates/oxios-kernel/Cargo.toml` — remove the inline `gix = { version = "0.83", ... }` dependency (now transitively provided by `oxi-vault-git`, but oxios-kernel still calls `gix` types directly in a few spots per the earlier read — check for any direct `gix::` usage outside `git_layer.rs` before removing; if any exists, keep `gix` as a direct dependency too), add `oxi-vault-git = "0.1"`
- Modify: `oxios/Cargo.toml` (workspace root) — add `oxi-vault-git = "0.1"` to `[workspace.dependencies]` alongside the existing `oxi-frontmatter = "0.1"` line (`Cargo.toml:135`), matching that exact pattern.

**Interfaces:**
- Consumes: `oxi_vault_git::{GitLayer, CommitInfo, LogEntry, CommitContext, DiffKind, FileDiff, DiffStats, CommitDiff, rel_path, VAULT_GIT_MARKER, LEGACY_VAULT_GIT_MARKERS}` (all names identical to the pre-extraction module, so `use crate::git_layer::GitLayer` continues to resolve via the re-export).

- [ ] Perform the deletion + re-export swap.
- [ ] `cargo build -p oxios-kernel`. Expected: compiles with zero call-site changes needed in `src/kernel.rs` (both `GitLayer::new(...)` at kernel.rs:1192 and `GitLayer::new_for_vault(...)` at kernel.rs:1204 keep working through the re-export).
- [ ] `cargo test -p oxios-kernel`. Expected: all `git_layer`-dependent tests (`register_knowledge_git_autocommit` integration test at kernel.rs:~2480 and any test in the deleted module now living in `oxi-vault-git`) pass.
- [ ] Commit: `git commit -am "refactor(kernel): adopt oxi-vault-git, drop in-tree git_layer module"`

### Task 2.2: Verify existing users' vaults are unaffected

**Files:** none (verification-only task)

- [ ] Manual smoke test: point `OXIOS_WORKSPACE`/config at a fixture vault that has only the legacy `.oxios-git` marker (no `.oxi-vault-git`). Boot oxios, confirm `oxios brain status`-equivalent / kernel logs show the layer `enabled=true` with no "foreign repo" warning (Task 1.2's `legacy_oxios_marker_is_recognized_as_owned` test already covers this at the unit level; this step is the integration-level confirmation against a real oxios boot).
- [ ] Commit is not applicable (verification only) — record the result in the PR description.

### Task 2.3: Merge Phase 2 to oxios main

- [ ] PR + full gate: `cargo fmt --all -- --check`, `cargo clippy --workspace --all-features -- -D warnings`, `cargo nextest run --workspace --no-fail-fast`.
- [ ] Squash-merge.

---

## Phase 3 — oxibrain: expose per-note revision history

Independent of Phase 1/2 — can run in parallel with them. Adds one read-only API; changes nothing about ingestion, C3, or the daemon-write boundary.

### Task 3.1: Add `Brain::episodes_for_locator`

**Files:**
- Modify: `oxibrain/crates/oxibrain-store/src/ledger.rs` (or the store module that already implements `Brain::get_episode`/`Brain::episode_count` per `CONSUMPTION_CONTRACT.md` — the query joins `episodes` on `source_id` + `occurrence_id`/`locator`; per §4.2.1 the pull connector stores `locator` implicitly inside the occurrence-chain derivation, so this task's first step is confirming exactly which column currently carries the raw locator string per episode row — read the store schema/migration before writing the query, since it wasn't fully re-derivable in this design's own research)
- Modify: `oxibrain/crates/oxibrain/src/lib.rs` (the `Brain` facade — add the new stable method)
- Modify: `oxibrain/doc/CONSUMPTION_CONTRACT.md` — bump to 1.3, document the new method under "Query"
- Modify: `oxibrain-client` — add the RPC + typed client method, bump `oxibrain-client` to `0.7`

**Interfaces:**
- Produces: `Brain::episodes_for_locator(space: &str, source_id: &str, locator: &str) -> Result<Vec<Episode>>` — returns every episode on the occurrence chain for that file path, ordered oldest→newest (walk `predecessor` links, or a simple `WHERE source_id = ? AND locator = ? ORDER BY occurred_at` if the store already indexes `locator` as a column — confirm during implementation, this is the one open question flagged for the implementer).
- `Episode` (existing stable type, re-exported already per `CONSUMPTION_CONTRACT.md` — its `content: String` field is what the oximemo history panel renders).

- [ ] Read `oxibrain/doc/ARCHITECTURE.md` §5 (schema section) in full to confirm whether `locator` is a first-class column on `episodes`/`sources`-linked table or must be derived from `source_ref`/`claims_json`. Do not guess — the schema snippet read during this design (`ARCHITECTURE.md:803-825`) shows `episodes` with `source_id`/`occurrence_id` but the `locator` string itself wasn't visible in the excerpted range; locate it before writing the query.
- [ ] Write the store-layer query function following the existing `P9` convention (`oxibrain-core` decides, `oxibrain-store` only fetches/writes — do not embed filtering logic in the store call beyond the `WHERE`).
- [ ] Add the facade method to `Brain`, add it to the compat test in `crates/oxibrain/src/compat.rs` (per `CONSUMPTION_CONTRACT.md`'s existing "Compatibility test" mechanism).
- [ ] Add the native RPC handler (mirrors the existing `sync/run` addition pattern from ADR-010 — new RPC name e.g. `episodes/for_locator`, not a sixteenth MCP tool, per the project's stated MCP-tool-cap discipline).
- [ ] Add `BrainClient::episodes_for_locator(dir_or_source, locator) -> Result<Vec<Episode>>` to `oxibrain-client`.
- [ ] Write unit test: ingest a locator through the pull connector fixture 3 times with distinct content (`"A"`, `"B"`, `"A"` — reusing the exact fixture shape from `ARCHITECTURE.md §4.2.1`'s worked example), call `episodes_for_locator`, assert 3 results in order with distinct `occurrence_id`s and correct `content` values.
- [ ] Run: `cargo test --workspace` (oxibrain). Expected: new test passes, existing suite unaffected (purely additive).
- [ ] Commit: `git commit -am "feat(brain): add episodes_for_locator query API (Consumption Contract 1.3)"`

### Task 3.2: Merge Phase 3 to oxibrain main

- [ ] PR + gates: `cargo fmt --all -- --check`, `cargo clippy --all-targets --all-features -- -D warnings`, `cargo test --workspace`.
- [ ] Squash-merge, tag a release so `oxibrain-client@0.7` is available for oximemo to depend on in Phase 4.

---

## Phase 4 — oximemo: adopt the safety net + expose the history panel

Depends on: Phase 1 (crate published) and Phase 3 (`oxibrain-client@0.7` published). Independent sub-tasks (4.1 vs 4.2) can run in parallel once both dependencies land.

### Task 4.1: Wire git auto-commit into the vault write path

**Files:**
- Modify: `oximemo/apps/desktop/src-tauri/Cargo.toml` — add `oxi-vault-git = { workspace = true }` (add `oxi-vault-git = "0.1"` to root `Cargo.toml`'s `[workspace.dependencies]` first)
- Modify: `oximemo/apps/desktop/src-tauri/src/lib.rs` — extend `AppState` with the git layer handle, extend `spawn_watcher`'s `on_change` closure (currently at `lib.rs:307-312`)

**Interfaces:**
- Consumes: `oxi_vault_git::GitLayer::new_for_vault(root, enabled, adopt_foreign_repo)`, `.commit_file(rel_path, msg)`, `.remove_file(rel_path, msg)`, `.is_enabled()`.
- Consumes: existing `oximemo_core::watcher::{MemoWatcher, OnChange}` (no changes to `oximemo-core` itself — this task lives entirely in the Tauri app layer, mirroring how oxios's `KnowledgeBase` stayed git-agnostic and `kernel.rs` did the bridging).

**Design (concrete, not the oxios pattern verbatim — oximemo already has a debounced watcher, so no second channel/consumer pair is needed):**

```rust
// AppState gains:
pub git: Arc<oxi_vault_git::GitLayer>,

// In AppState::new / app setup, after vault.ensure_initialized():
let git = Arc::new(oxi_vault_git::GitLayer::new_for_vault(
    vault.paths().vault.clone(),
    vault.with_config(|c| c.git.auto_commit), // new [git] config section, mirrors oxios's GitConfig shape
    vault.with_config(|c| c.git.adopt_foreign_repo),
)?);
```

```rust
// spawn_watcher's on_change closure (lib.rs:307-312) gains a git commit,
// queued through a bounded channel to a background tokio consumer so the
// ≤16 ms capture-path budget is never touched by a synchronous gix commit:
let (git_tx, git_rx) = tokio::sync::mpsc::channel::<(PathBuf, bool)>(64); // bool = path.exists()
let on_change: oximemo_core::watcher::OnChange = Arc::new(move |path| {
    if let Ok(v) = oximemo_core::Vault::open(Some(&vault_path)) {
        v.reindex_path(&path);
    }
    let _ = emit_handle.emit("memos:changed", ());
    let exists = path.exists();
    let _ = git_tx.try_send((path, exists)); // non-blocking; drop on backpressure, next settle retries via reconcile
});
// Background consumer, spawned once at app setup:
tokio::spawn(async move {
    while let Some((path, exists)) = git_rx.recv().await {
        if !git.is_enabled() { continue; }
        let rel = oxi_vault_git::rel_path(&vault_root, git.root(), &path.to_string_lossy());
        let msg = if exists { format!("vault: update {rel}") } else { format!("vault: delete {rel}") };
        let result = if exists { git.commit_file(&rel, &msg) } else { git.remove_file(&rel, &msg) };
        if let Err(e) = result {
            tracing::warn!(error = %e, "vault git commit failed");
        }
    }
});
```

- [ ] Add `[git]` section to `oximemo-core`'s config (mirrors `oxios::GitConfig` shape exactly: `auto_commit: bool` default `true`, `adopt_foreign_repo: bool` default `false`) — modify `oximemo/crates/oximemo-core/src/config.rs` (the existing section-setter pattern from `[brain]`/`[daily]` per the earlier settings-menu work applies here: `GitSection` + `set_git_config` IPC, `ToggleRow` in the settings UI).
- [ ] Implement `AppState.git` construction and the channel/consumer wiring as above.
- [ ] Add `vault_history_for(id: MemoId) -> Result<Vec<CommitInfo>>` convenience is **not** needed at the git layer — history comes from oxibrain (Task 4.2); git here is write-path-only (the "undo my last edit" affordance is a separate, smaller feature: exposing `GitLayer::log_for_file`/`restore_file`, which already exist per the source read — wire a minimal `oximemo_core` CLI/IPC command `restore_note_version(id, commit_hash)` calling `git.restore_file` if the user wants local-only undo without oxibrain; flagged here as in-scope for Phase 4 completion, not deferred, since it's the actual payoff of the mechanical layer).
- [ ] Smoke test: launch the dev app (`bun run dev` + `cargo tauri dev` per `CONTRIBUTING.md`), create a note, confirm `~/.oxi/vault/.git` gets a new commit (`git -C ~/.oxi/vault log --oneline -1`), confirm capture overlay latency is unaffected (existing CI latency gate must stay green — no new synchronous work was added to the capture path, only a `try_send`).
- [ ] Commit: `git commit -am "feat(vault): auto-commit notes to local git via oxi-vault-git"`

### Task 4.2: History panel backed by oxibrain's occurrence chain

**Files:**
- Modify: `oximemo/apps/desktop/src-tauri/Cargo.toml` — bump `oxibrain-client` to `0.7`
- Modify: `oximemo/apps/desktop/src-tauri/src/lib.rs` — add `brain_history(path: String) -> Result<Vec<EpisodeSummary>, String>` Tauri command (mirrors existing `brain_gather`/`brain_status` commands' error-to-string + offline-degrades-quietly pattern)
- Modify: `oximemo/apps/desktop/src/lib/api.ts` — add `brainHistory(path: string): Promise<EpisodeSummary[]>` (mirrors `brainGather`)
- Create: `oximemo/apps/desktop/src/components/HistoryPanel.tsx` (mirrors `BrainCard.tsx`'s closable, degrade-when-offline structure)

**Interfaces:**
- Consumes: `oxibrain_client::BrainClient::episodes_for_locator` (Phase 3, Task 3.1) — signature `(space: &str, source_id: &str, locator: &str) -> Result<Vec<Episode>>`, `source_id` resolved the same way the existing `oxibrain sync` registration does (`ensure_source(space, name = canonical(vault_dir), kind = "document_revision", mode = "pull")` — oximemo's Tauri layer must compute the same canonical path it already passes when it (indirectly, via the daemon watcher) registers the vault, not re-derive a different one).
- Produces: `EpisodeSummary { occurred_at: i64, content: String, occurrence_id: String }` (new, oximemo-local DTO — do not leak oxibrain's full `Episode` type into the frontend; trim to what the panel renders).

- [ ] Add the Tauri command, following `brain_status`'s existing "daemon offline → typed empty/offline result, never an error toast" convention (`ContextDock.tsx:87-91`'s `.catch(() => setOffline(true))` pattern already establishes the frontend contract to match).
- [ ] Add `HistoryPanel.tsx`: renders a timeline of `EpisodeSummary` entries (timestamp + content snippet), closable, hidden entirely (not shown-with-error) when `brainHistory` throws — same as `ContextDock`'s offline behavior.
- [ ] Wire the panel into `MemoDetail` alongside the existing `BrainCard`.
- [ ] Add i18n strings to `en.ts`/`ko.ts` following the `brain_*` key naming convention already established (`brain_history`, `brain_history_empty`, etc.).
- [ ] Smoke test via browser/Tauri dev: edit a note twice with the daemon running and vault-synced, open the history panel, confirm 2+ entries render with correct content; stop the daemon, confirm the panel disappears without an error state (C1 compliance, verified against the actual running app — not inferred).
- [ ] Commit: `git commit -am "feat(brain): note history panel via episodes_for_locator"`

### Task 4.3: Merge Phase 4 to oximemo main

- [ ] PR + gates: existing oximemo CI (91+ core/CLI tests per `CHANGELOG.md`'s stated baseline, plus `bun run typecheck`, frontend build).
- [ ] Squash-merge.

---

## Phase 5 — Record the decision in canonical ecosystem docs

Depends on: Phases 1–4 merged (this phase documents what shipped, not what's planned).

### Task 5.1: New ADR in oxibrain

**Files:**
- Create: `oxibrain/doc/adr/ADR-011-vault-git-history-stays-consumer-owned.md` (numbering: confirm `ADR-010` is still the highest at execution time; increment accordingly)

- [ ] Write the ADR in the existing ADR format (see `ADR-010-daemon-hosted-vault-watch.md` for the section shape: Context / Decision / Shape / Consequences / Verification). Content: the C1/C3 argument from this plan's header, the `episodes.content` full-text finding, the decision to keep git in a shared `oxi-vault-git` crate rather than in oxibrain, and a pointer to `episodes_for_locator` (Phase 3) as the read-side complement.
- [ ] Commit + merge (same repo, same gate as Phase 3).

### Task 5.2: Update `ECOSYSTEM.md` §C5 file tree

**Files:**
- Modify: `oxibrain/doc/ECOSYSTEM.md` (the `vault/` tree diagram at the line documented as `_assets/, .trash/, .git/ # app machinery (oximemo) + git history (oxios)`)

- [ ] Update the comment to reflect shared ownership: `_assets/, .trash/, .git/ # app machinery + shared git history (oxi-vault-git, oximemo + oxios)`.
- [ ] Bump the document version header per its existing convention (currently v1.1 → v1.2) and add a changelog line.
- [ ] Commit + merge.

### Task 5.3: Update `project-oxi/.github/DESIGN.md` decision log (only if Phase 4's history panel touched shared UI patterns)

**Files:**
- Modify: `project-oxi/.github/DESIGN.md` §11 (Decision log)

- [ ] Add a decision-log row: "Vault git safety net is a shared crate (`oxi-vault-git`), not per-app or brain-owned; history UI reuses the closable-panel-degrades-offline pattern (§6, oximemo `BrainCard`)." — only if `HistoryPanel.tsx` introduced any new component pattern beyond what `BrainCard` already established; if it's a pure reuse, skip this task (note it as skipped with reason in the PR, do not pad the log with a no-op entry).
- [ ] Commit + merge.

---

## Self-Review Notes (from the plan author, before handoff)

- **Spec coverage:** every project named in the prior design turn — oxios (extraction source), a new shared crate location (resolved to oximemo's workspace, matching the `oxi-frontmatter` precedent rather than a brand-new repo), oximemo (consumer + UI), oxibrain (new read API) — has a phase.
- **Known open question, flagged not hidden:** Task 3.1 could not fully pin the exact SQL/column for `locator` from the documentation excerpts read during design (the `episodes` table schema shown didn't include a bare `locator` column — it may live in a separate `sources`/`occurrences` join table not yet read). The implementer must resolve this by reading `oxibrain/doc/ARCHITECTURE.md` §5 in full before writing code — this is a real research step, not a placeholder for logic.
- **Backward compatibility:** Task 1.2/2.2 explicitly protect existing oxios installations already carrying `.oxios-git` — no silent breakage, no forced migration.
- **Capture-path latency:** Task 4.1 uses `try_send` (non-blocking) into an already-async consumer specifically to protect oximemo's CI-gated ≤16 ms capture budget — called out explicitly rather than left implicit.

---

**Execution choice needed before starting:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks. Given Phase 1/Phase 3 are mutually independent (different repos, no shared files) and Phase 4 depends on both, this plan's natural concurrency (Phase 1 ∥ Phase 3, then Phase 2 ∥ Task 4.1 once Phase 1 lands, then Task 4.2 once Phase 3 lands, then Phase 5) maps directly onto `dispatching-parallel-agents` + `subagent-driven-development`.
2. **Inline Execution** — this session runs tasks sequentially with checkpoints via `executing-plans`.

Which approach?
