# Brain 0.10 Cutover — Caller-Owned oxibrain Integration (Design)

**Status:** Approved (user, 2026-08-29 — autonomous execution authorized).
**Date:** 2026-08-29
**Companion:** `2026-08-28-spaces-design.md` (§2 amended by this spec).

## Why

oximemo pins `oxibrain-client` git tag `v0.7.0` (workspace `Cargo.toml`),
which targets the retired daemon topology. oxibrain 0.8.0 (Consumption
Contract 1.4, ARCHITECTURE v2.11) deleted the daemon, the
`~/.oxi/brain/oxibrain.sock` listener, the vault watcher, and the
`sync_run` RPC; 0.10.x (ARCHITECTURE v2.13, ADR-013) made `space`
required on every op. ADR-007 states it outright: *client 0.7.x is
retired by the daemon cutover*. Today oximemo's brain panel therefore
degrades to permanently-offline and vault→brain ingestion never runs.

The new oxibrain has **no resident process and no on/off state**. The
brain is a function call: spawn `oxibrain`, speak JSON-RPC over stdio,
child dies when the caller drops it. "Offline" stops being a state and
becomes a failure reason (binary missing / spawn failed / handshake
failed).

## Decisions locked in brainstorming

1. **Ingestion trigger is oximemo** — after open and on debounced vault
   saves, oximemo runs the reconcile itself. No manual CLI step.
2. **Binary resolution is PATH** — spawn `oxibrain` by name; OS resolves
   PATH. `[brain].executable` exists only as an override (default empty).
3. **One cycle with spaces** — this spec is primary; the spaces spec's
   registration clause is amended to this mechanism (both were written
   against the deleted `sync_run`).
4. **Short-lived spawn per interaction** — no session-held child in the
   non-hot-swappable `AppState`; matches the ecosystem's
   operation-scoped, caller-owned model. Spawn cost (~tens of ms) is
   irrelevant at panel-interaction frequency.
5. **`documents.toml` ensure is idempotent and exact-match** — extends
   the spaces spec's "single sanctioned write" pattern: oximemo touches
   only a root whose `path` is exactly the active vault.

## Dependency

```toml
oxibrain-client = { version = "0.10", git = "https://github.com/a7garden/oxibrain", tag = "v0.10.1" }
```

Client 0.10.x surface used (verified in
`crates/oxibrain-client/src/lib.rs`): `LocalProcessEndpoint::new`,
`BrainClient::spawn_local` → `handshake(default_client_hello(...))`
(spawn_local does NOT handshake), `stats(space) -> Value`,
`recall(query, space, token_budget) -> Value`, `BrainCapabilities {
server_version, … }`.

Release note: the crates.io publish leg resolves `^0.10` from the
registry. If `oxibrain-client 0.10.1` is not published when oximemo's
release runs, the oxibrain publish must land first (same dual
git+version path as the 0.7 round). Verify at release time; not a code
change here.

## What changes

### 1. Configuration — `BrainConfig`

`crates/oximemo-core/src/config.rs`:

```rust
pub struct BrainConfig {
    pub enabled: bool,
    /// Override for the oxibrain binary. Empty = spawn "oxibrain" (PATH).
    pub executable: String,
}
```

- `socket` deleted (transport gone). `space` deletion already covered by
  the amended spaces spec §2 (derived from vault dirname).
- `#[serde(default)]` retained: stale `socket`/`space` keys in existing
  `oximemo.toml` parse and are ignored silently.
- Data dir is **not** configurable: the agreed ecosystem default
  `~/.oxi/brain` is hardcoded as the `--dir` value
  (`Paths`-style helper `brain_dir()` in `paths.rs`, overridable only by
  the existing test harness).

### 2. Core — documents-plane glue (`oximemo-core/src/brain.rs` rewrite)

Deleted: `register()` startup flow, socket connect paths, any
`sync_run`-shaped call. The module becomes two pure-ish operations:

**`ensure_document_root(vault_dir, space) -> EnsureOutcome`**
(serde-free TOML surgery on `~/.oxi/brain/documents.toml`, oxibrain's
canonical config):

- Read the file; find a `[[root]]` whose `path` resolves equal to
  `vault_dir`. Found → `EnsureOutcome::Present` (no write, regardless
  of its alias/space/include — never clobber operator config).
- Not found and file parses → append
  `root = { alias = "<space>", path = "<vault_dir>", space = "<space>" }`;
  atomic write (tempfile + rename). Include/exclude omitted — server
  defaults apply. `EnsureOutcome::Added`.
- File absent → create with exactly that one root.
  `EnsureOutcome::Added`.
- File present but unparseable → `EnsureOutcome::SkippedInvalid` — no
  write, log warn. Never corrupt oxibrain's config.
- No daemon involved; brain-installed-or-not is irrelevant.

**`spawn_index_run(executable, dir) -> JoinHandle`-style fire-and-forget**
run by the desktop app (not core-async): spawn `oxibrain index
--documents --dir <dir>` detached, log exit status, swallow failure.
Single-flight: at most one index child at a time per app process
(`AtomicBool` guard in the desktop state; core stays stateless).

Trigger points (desktop): once after `Vault::open` succeeds (after
`ensure_document_root`), and debounced (reuse the existing vault-save
watch debounce) on subsequent mutations. Both skipped silently when
`[brain].enabled = false`.

`oximemo.toml` `[brain]` section keeps its writer
(`set_brain_config`) — field set changes only.

### 3. Desktop IPC (`apps/desktop/src-tauri/src/lib.rs`)

Shared helper:

```rust
async fn spawn_brain(cfg: &BrainConfig) -> Result<(BrainClient, BrainCapabilities), BrainFailure>
enum BrainFailure { BinaryMissing, SpawnFailed(String), HandshakeFailed(String) }
```

- executable = `cfg.executable` if non-empty else `"oxibrain"`;
  `LocalProcessEndpoint::new(exec, brain_dir())`; `spawn_local` then
  `handshake(default_client_hello(concat!(env!("CARGO_PKG_NAME"), " ",
  env!("CARGO_PKG_VERSION"))))`. `SpawnError` kindNotFound on spawn
  maps to `BinaryMissing` (checked by attempting the spawn; no
  up-front `which`).
- Every caller drops the client at scope end (child reaped via
  `kill_on_drop`).

**`brain_status`** — replace the returned shape with:

```jsonc
{ "online": true|false, "reason": null|"binary_missing"|"spawn_failed"|"handshake_failed"|"disabled",
  "server_version": "0.10.1"|null,
  "episodes": u64|null, "entities": u64|null, "statements": u64|null, "contradictions": u64|null }
```

Success path: spawn → handshake → `stats(space)` where space = active
vault basename (spaces spec §2 derivation; `Vault` supplies it — the
frontend passes the already-derived space from `vault_status`-style
state, falling back to `"personal"`). Count keys parsed leniently
(missing key → null). Any failure → `online: false` + reason; never
`Err` to the frontend (panel contract unchanged in spirit).

**`brain_gather(query, budget)`** — spawn → `recall(query, space,
budget as usize)`; forward the returned envelope Value verbatim to the
frontend (layer rendering unchanged client-side). Failure → `Err`
string as today (frontend offline handling unchanged). If the envelope
carries `meta.dropped` with non-empty content, the frontend renders a
collapsible "N results truncated" note (ko/en).

Deleted: socket-based `connect_default`/`connect` usage, the
`BrainEndpointConf` socket branch, and the Settings brain-space picker
consumption of daemon `list_spaces` (spaces spec replaces the picker
with the derived-space readout).

`apps/desktop/src-tauri/tests/brain_live.rs` rewritten: ignored test
spawns a real `oxibrain` via `spawn_brain`-equivalent path against
`~/.oxi/brain`, asserts handshake capabilities and stats keys; skips
cleanly (pass with explicit ignore reason) when the binary is absent.

### 4. Frontend

- `BrainPanel`: status dot gains the reason state — binary missing /
  failed reasons render gray with a localized one-liner instead of a
  bare "offline". `online:false` remains a normal state, not an error
  surface (C1).
- Settings → Brain: rows are `enabled` toggle + optional `executable`
  text field (placeholder: "oxibrain (PATH)"). The space picker is
  replaced by the read-only derived-space line (spaces spec §2).
- Locales: delete `brain_socket`/`brain_socket_ph`; add
  `brain_executable`, `brain_executable_ph`, `brain_reason_*`,
  `brain_dropped` keys (ko/en).
- `ContextDock` / `brainGather` plumbing: unchanged except the dropped
  note.

### 5. Spaces spec amendment (§2 of 2026-08-28-spaces-design.md)

The sentence assigning registration to `sync_run(<vault>, <basename>)`
is replaced by: *registration = `ensure_document_root(<vault_dir>,
<basename>)` + the debounced index trigger from the brain 0.10 cutover
spec.* The spec's verification bullet
"`open_spec(Space("work"))` registers `sync_run(...)`" becomes
"`...` ensures a `documents.toml` root `{path: …/work, space: "work"}`
(recorder-based)". Everything else in that spec stands (flat-root
rewrite §3.4 included — it predates and matches this pattern).

## Non-goals

- No `--embed` on the index run this cycle (documents plane recall runs
  on FTS; vectors are a follow-up toggle).
- No token/scoped-session support (`spawn_local_with_token`) — local
  single-user use spawns unauthenticated, per the ecosystem default.
- No session-held brain child, no hot-reload of `[brain]` changes
  (settings take effect on next spawn — i.e., immediately for the next
  panel interaction).
- No oxibrain-side changes; no `documents.toml` provisioning for
  non-active spaces.
- Known limitation (accepted): `documents.toml` read-modify-write races
  a concurrent `oxibrain space add` are last-writer-wins on a small
  file; not locked.

## Verification

- `cargo test -p oximemo-core`: ensure matrix — absent file creates one
  root; exact-path present → no write (property: mtime unchanged);
  same path different alias/space → no write; unparseable file →
  untouched + `SkippedInvalid`; atomic-rename temp cleanup. Brain dir
  override via test harness.
- `cargo test -p oximemo-core` (config): stale `socket`/`space` keys
  parse-and-ignore; new defaults serialize.
- `cargo test -p oximemo-cli && cargo check --workspace`: workspace
  green after dep bump.
- Desktop: `bun x tsc --noEmit`, `bun test`, `bun run build`.
- Live smoke (this machine, `oxibrain` on PATH): app open →
  `documents.toml` gains the active-space root → panel `online: true`
  with real counts → gather returns layers; `PATH` stripped variant →
  `online: false, reason: binary_missing` rendered gray.
- Docs: README `[brain]` section + CHANGELOG entry.
