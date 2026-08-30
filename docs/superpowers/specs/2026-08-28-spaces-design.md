# Spaces — Per-Space Vault Switching (Design)

**Status:** Draft — awaiting user review.
**Date:** 2026-08-28

## Why

oxibrain separates knowledge into **spaces**, each backed by its own vault
directory at `~/.oxi/vault/<space>/` (oxibrain spec §4.3, `space add`
provisioning). oximemo is the vault input tool for that ecosystem, but it
still opens the **flat legacy root** `~/.oxi/vault` — the parent of the
space directories, not one of them. Consequences today:

- Notes land at the flat root; oxibrain's flat-root registration (verified
  live: `~/.oxi/brain/documents.toml` registers `path = ~/.oxi/vault` under
  `space = "personal"`) is a legacy compatibility shape.
- A second space provisioned by `oxibrain space add` would be double-indexed
  by the flat root's `**/*.md` include — the exact divergence
  `doc/ECOSYSTEM.md` ("Vault resolution, as shipped") documents as a known
  fragmentation hazard.
- The `[brain].space` picker in Settings picks a *registration* space while
  the vault path stays flat — two notions of "space" that can disagree.

Decision (user-approved in brainstorming): oximemo adopts the same model —
**a space is one directory under `~/.oxi/vault/`, and the space name is the
directory name.** Users create a space by typing a name (the path is fixed
by convention) and switch by picking from the existing list, Obsidian-style
but without path entry.

Design constraints locked during brainstorming:

1. Existing flat vault migrates one-time into the default space
   (`personal`) — automatic, on `Vault::open`.
2. The active space is an **oximemo-local** setting (app support), not the
   ecosystem `~/.oxi/config.toml [vault].space` key. Because space ==
   directory name, brain registration always uses the dirname, so a local
   choice cannot diverge from what the daemon ingests.
3. Switching restarts the app process (Obsidian parity; the
   `AppState { Arc<Vault>, watcher, git layer, capture monitor }` graph is
   boot-built and not hot-swappable).
4. CLI gets real subcommands — the CLI is the official mutation path for
   copilot/agents (project principle).
5. UI entry points: sidebar header picker + command palette items.

## What changes

### 1. Vault resolution — `space` becomes the path selector

New module-level resolution in `oximemo-core` (single source shared by
desktop boot and CLI):

```rust
pub enum VaultSpec {
    /// Explicit path (--vault / OXIMEMO_VAULT). Tests and custom setups.
    Explicit(PathBuf),
    /// A space directory: ~/.oxi/vault/<name>/
    Space(String),
}

/// Precedence (highest first):
/// 1. --vault / OXIMEMO_VAULT        → Explicit(path)
/// 2. --space / OXIMEMO_SPACE        → Space(name)      (validated name)
/// 3. app-support settings last_space → Space(name)     (only if dir exists)
/// 4. default                         → Space("personal")
pub fn resolve_vault_spec(explicit: Option<&Path>, space: Option<&str>) -> VaultSpec;
```

- `Paths::resolve_spec` learns the spec. Index layout (amended by the
  2026-08-30 unified home: the Oxi home is `~/.oxi` and oximemo's
  private state moved to `~/.oxi/oximemo/`):
  - `Space(name)` → vault `~/.oxi/spaces/<name>/vault/`, index
    `~/.oxi/oximemo/index/<name>/`
  - `Explicit(path)` → unchanged: index `…/index/by-vault/<hash>/`
    (existing `vault_namespace` machinery).
- `Vault::open(vault: Option<&Path>)` keeps its signature (zero test churn)
  but `None` now routes through `resolve_vault_spec(None, None)` — i.e. the
  default vault becomes the per-space default `~/.oxi/vault/personal/`,
  after the §2 migration prelude runs.
- New `Vault::open_spec(spec: &VaultSpec)` for callers that resolved
  explicitly (desktop/CLI pass both flags through).
- **`last_space` storage**: `…/com.oximemo.app/settings.json`
  `{"last_space": "<name>"}`, atomic write (tempfile + rename). Core-owned
  helpers `last_space() -> Option<String>` / `set_last_space(&str)` beside
  the existing app-support path helpers in `paths.rs`.
- Missing `last_space` directory (deleted externally) falls through to the
  default — self-heal, never an error loop.

### 2. Brain registration — space is derived, not configured

- Registration space = **vault directory basename** (for `Space(name)`
  vaults, exactly `name`; for `Explicit` vaults, the basename).
  **(Amended 2026-08-29, brain 0.10 cutover spec):** `sync_run` was
  deleted by oxibrain 0.8.0. Registration is now
  `ensure_document_root(<vault_dir>, <basename>)` plus the debounced
  `oxibrain index --documents` trigger — see
  `2026-08-29-brain-010-cutover-design.md` §2.
- **Delete** `crate::brain::resolve_space()` (the
  `~/.oxi/config.toml [vault].space` > `oximemo.toml [brain].space`
  precedence chain) and the `BrainConfig::space` field.
  - Existing `oximemo.toml` files keep loading: `BrainConfig` uses
    `#[serde(default)]` without `deny_unknown_fields`, so a stale
    `space = "…"` key is ignored silently.
  - oximemo neither reads nor writes the ecosystem `[vault].space` key from
    this point on. (Flagged for user confirmation: this is a deliberate
    behavior change — the key no longer influences oximemo in any way.)
- Settings → Brain section: replace the space picker (`select`/free-text
  input writing `[brain].space`) with a read-only line showing the derived
  space. `enabled`/`executable` rows per the brain 0.10 cutover spec
  (socket is gone).

### 3. One-time flat → space migration

New `oximemo-core::migrate_spaces` module, executed from the `Vault::open`
prelude exactly like today's `migrate_vault` (app-support → `~/.oxi/vault`
move). It runs **before** path resolution and at most once.

**Trigger** (all must hold):

- The resolved spec is `Space(_)` (not `Explicit`), and
- `~/.oxi/vault/personal/` does **not** exist, and
- `~/.oxi/vault/` shows the legacy-flat signature: a top-level
  `oximemo.toml`/`config.toml` (vault-local config at the flat root) **or**
  any top-level regular file (e.g. dated `2026-*.md` notes).

**Action**:

1. Read `~/.oxi/brain/documents.toml` and collect the set of per-space root
   names (roots whose `path` is `~/.oxi/vault/<name>`). Those directories
   are provisioned spaces — **excluded** from the move. (Absent file →
   empty set; brain-down is irrelevant, this is a file read.)
2. Move every remaining top-level entry of `~/.oxi/vault/` — folders,
   notes, `_assets`, `.trash`, `.git`, dotfiles — into
   `~/.oxi/vault/personal/`. Git history and the `oxi-vault-git` ownership
   marker move with the tree.
3. Rename the derived index `…/index/` → `…/index/personal/` (index
   records are keyed by vault-relative paths, so they stay valid; the
   `index-fmt`/`inbox-seed` markers move with the directory). Only when
   `…/index/` directly contains `meta.redb` (flat signature) and
   `…/index/personal/` does not already exist; otherwise skip (already
   namespaced or fresh install).
4. Rewrite the flat root in `~/.oxi/brain/documents.toml`: a root whose
   `path` is exactly `~/.oxi/vault` (any alias, any space value) gets
   `path = ~/.oxi/vault/personal`. **Only that one entry, only on exact
   match.** Rationale: left alone, the flat root's `**/*.md` include would
   ingest every *future* space's notes into the old space — the documented
   fragmentation hazard. This is the single sanctioned oximemo write into
   the brain directory.

**Collision → merge-required, not data loss**: if `~/.oxi/vault/personal/`
already exists while the flat signature also holds, do nothing and surface
`VaultStatus::MergeRequired` (existing pattern from `migrate_vault`;
`oximemo doctor` + GUI banner instruct a manual merge).

Live-machine note (verified 2026-08-28): flat vault with 26 top-level
entries, `documents.toml` flat root under `personal`, no
`~/.oxi/config.toml`, no per-space roots — the happy path of this
migration.

### 4. Space create / list / switch — core + IPC + CLI

**Name validation** (`oximemo-core::spaces`): trim; any-script letters,
digits, `-`, `_`; length 1..=64. Identical rule to oxibrain's
`validate_space_name` (spec §4.2) — reimplemented locally (~15 lines) to
avoid a new cross-crate dependency; a property test pins the two rules'
agreement on a shared corpus. No reserved names: space dirs live at
`~/.oxi/vault/` level, one level above any vault-internal scaffold
(`_assets`, `.trash`), so collisions are structurally impossible.

**Core API** (`oximemo-core::spaces`):

- `list_spaces() -> Vec<String>` — subdirectories of `~/.oxi/vault/`,
  skipping dotfiles, validated names only. Sorted. The filesystem is the
  single source of truth; the daemon is never required (offline is normal).
- `create_space(name) -> PathBuf` — validate → `mkdir -p
  ~/.oxi/vault/<name>` → `Vault::open_spec(Space(name))` +
  `ensure_initialized()` (scaffold + `oximemo.toml`). Idempotent: an
  existing valid space dir is success, not an error (same philosophy as
  `oxibrain space add`). No brain-directory writes here — the active
  space's `documents.toml` root is ensured on the next open (brain 0.10
  cutover spec §2).
- `switch_space(name)` — validate + dir-exists check → `set_last_space`.
  Caller (IPC or CLI) decides what happens next (restart vs. nothing).

**Desktop IPC** (all fail with surfaced error strings; browser fallback in
`tauri.ts` returns `[{ name: "personal", current: true }]` for `space_list`
and no-ops the mutators — existing pattern):

- `space_list() -> Vec<SpaceInfo>` — name + is_current.
- `space_create(name: string) -> SpaceInfo`.
- `space_switch(name: string)` — writes `last_space`, then
  `app.restart()` (tauri process restart; same class as the updater's
  install-and-relaunch).
- Existing `vault_path` unchanged for display.

**Sidebar header**: current space name + chevron at the top of
`Sidebar.tsx`; click opens a popover listing spaces (check on current) with
a "새 space…" row that flips to a name input (validated client-side with
the same rule; server re-validates). Selecting a different space calls
`space_switch` → restart. The picker works with the daemon down.

**Command palette** (`paletteCommands.ts`): "space 전환" (opens the same
picker as a palette-mode list) and "space 생성" (name prompt) entries, i18n
ko/en.

**CLI** (`oximemo-cli`):

```
oximemo space list                # names, current marked *
oximemo space add <name>          # create (idempotent) + scaffold
oximemo space switch <name>       # record last_space (no daemon involved)
oximemo --space <name> <cmd>      # global flag, one-shot, not persisted
```

- `--space` is `global = true`, `env = "OXIMEMO_SPACE"`, mutually exclusive
  with `--vault` (both given → error before any I/O).
- `space switch` prints the resolved vault path for confirmation.
- Copilot context block (`copilot.rs build_context`) gains a `space:
  <name>` fact line next to `vault_root` so agents know which space they
  edit; the CLI `--space` flag flows through the same resolution.

### 5. `doctor` / status surfacing

- `oximemo doctor` reports: active space, space count, flat-migration
  state (done / not-needed / **merge-required** with both paths), and
  whether the active space's dir matches `last_space` (self-heal notice if
  it fell through to default).
- `VaultStatus::MergeRequired` handling is reused verbatim from the
  app-support→`.oxi` migration (GUI banner + doctor guidance).

## Non-goals

- No space renaming, deletion, or per-space display names — the filesystem
  is the registry; manage it in Finder/terminal if ever needed. (Obsidian
  parity is *switching*, not vault management.)
- No daemon-required flows: every space operation works offline;
  `ensure_document_root` + the index trigger run on next open
  (brain 0.10 cutover spec §2).
- No writes to `~/.oxi/brain/` beyond the brain 0.10 cutover spec's two
  sanctioned writes: the §3.4 flat-root path rewrite and the active
  space's `ensure_document_root`. oximemo never provisions roots for
  *non-active* spaces — that is `oxibrain space add`'s job.
- No hot-swap of `AppState` (restart-only switching, per decision 3).
- No change to `Explicit` (`--vault`) behavior, index hashing, or the
  browser-dev localStorage fallback beyond stub space commands.
- No Windows/Linux path work — `app_support_dir()` stays macOS-shaped, as
  today.

## Verification

- `cargo test -p oximemo-core`:
  - Resolution matrix: every precedence tier (`--vault` > `--space` >
    `last_space` > default), missing-dir fallthrough, invalid `--space`
    name rejection, `--vault`+`--space` mutual exclusion.
  - Migration: happy path (flat content + `.git` lands in `personal/`,
    index renamed, `documents.toml` flat root rewritten); provisioned-space
    dirs excluded from the move; collision → `MergeRequired` with zero
    mutations; no flat signature → no-op; empty `~/.oxi/vault` → no-op.
  - Index namespace: `Space("a")` and `Space("b")` produce disjoint
    `index/<name>/` dirs; `Explicit` keeps `by-vault/<hash>`.
  - Name validation boundaries (0, 1, 64, 65 chars; `/`, `.`, space,
    unicode letters pass; NFD/NFC Korean both valid).
  - Registration: `open_spec(Space("work"))` ensures a `documents.toml`
    root `{path: …/work, space: "work"}` (recorder-based, existing
    `with_test_recorder` harness); stale `oximemo.toml` `[brain]
    space`/`socket` keys parse and are ignored.
- `cargo test -p oximemo-cli`: `space list/add/switch` arms incl.
  idempotent add, switch-to-missing error, `--space` flag plumbing.
- Desktop: `bun x tsc --noEmit`, `bun test`, `bun run build`.
- Smoke (this machine, after implementation): run the app once → flat vault
  migrates into `~/.oxi/vault/personal/` (26 entries, `.git` intact,
  `documents.toml` rewritten); sidebar header shows `personal`; create
  `work` from the picker; switch → restart lands in `work` with an empty
  scaffold; `oxibrain doctor`-side flat root no longer points at
  `~/.oxi/vault`; switch back to `personal` → notes unchanged.
