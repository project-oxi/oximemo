# Contributing to oximemo

Thanks for your interest in oximemo! This guide covers the essentials for
getting a change landed. oximemo is a small, opinionated project — when in
doubt, prefer the boring, minimal option.

## Project layout

```
crates/
  oxi-frontmatter/  # PDC classification and frontmatter parsing
  oxi-vault-git/    # Git-backed vault helpers
  oximemo-core/     # Pure-Rust core: file store, index, search, sync, watcher, PDC
  oximemo-cli/      # `oximemo` binary — thin clap adapter over oximemo-core
  oximemo-capture/  # macOS global Option double-tap monitor (objc2)
  oximemo-metadata/ # Metadata integrations
  oximemo-session/  # Explicit session imports and local session recorder
apps/desktop/       # Tauri 2 + React 19 desktop app
skills/oximemo/    # Agent-facing SKILL.md (CLI usage for coding agents)
doc/DESIGN.md              # dated product and architecture reference
docs/PDC-MIGRATION.md      # current PDC implementation plan and safety gates

`oximemo-core` knows nothing about Tauri or clap. The CLI and the desktop app
are both thin adapters over [`oximemo_core::Vault`](crates/oximemo-core/src/vault.rs).
Keep it that way: domain logic belongs in the core.

## Prerequisites

- **Rust** 1.89+ (edition 2024) — <https://rustup.rs>
- **Bun** 1.3+ — for the desktop frontend (`curl -fsSL https://bun.sh | bash`)
- **macOS 14+ on Apple Silicon** — oximemo targets `aarch64-apple-darwin` only

## Setup

```bash
git clone https://github.com/project-oxi/oximemo.git
cd oximemo

# Rust checks
cargo fmt --all -- --check
cargo clippy --workspace --exclude oximemo-desktop --all-targets -- -D warnings
cargo test --workspace --exclude oximemo-desktop

# Desktop frontend
cd apps/desktop
bun install
bun run build
```

## Development loop

| What | Command |
| :--- | :--- |
| Run the CLI | `cargo run -p oximemo-cli -- vault path` |
| Dev server (frontend) | `cd apps/desktop && bun run dev` |
| Full desktop app (dev) | `cargo tauri dev` *(needs `cargo install tauri-cli`)* |
| Build release CLI | `cargo build --release -p oximemo-cli` |

A temporary vault is great for manual testing:

```bash
cargo run -p oximemo-cli -- --vault /tmp/oximemo-test new "hello" --tag dev
cargo run -p oximemo-cli -- --vault /tmp/oximemo-test list
```

## Before you open a pull request

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs all of these
locally — please run them too:

- [ ] `cargo fmt --all -- --check`
- [ ] `cargo clippy --workspace --exclude oximemo-desktop --all-targets -- -D warnings`
- [ ] `cargo test --workspace --exclude oximemo-desktop`
- [ ] `cd apps/desktop && bun install --frozen-lockfile && bun run build`
- [ ] From the repository root, `cargo clippy -p oximemo-desktop --all-targets -- -D warnings` and `cargo check -p oximemo-desktop`
- [ ] After the frontend build, `cargo test -p oximemo-desktop` from the repository root
- [ ] New behavior is covered by a test where it makes sense

## Commit & PR conventions

- Keep commits focused; one logical change per commit.
- Write a clear imperative subject line (`Add purge --older-than flag`, not
  `added some stuff`).
- Reference issues in the PR description (`Closes #123`).
- Open a **draft PR** early for work-in-progress discussion.

## Design authority

`doc/DESIGN.md` is a dated product and architecture reference, not the
current authority for every behavior. `AGENTS.md` routes repository work;
`docs/PDC-MIGRATION.md` governs the current PDC implementation and its
preservation gates. Update the applicable current guide, decision record, or
changelog when shipped behavior changes.

## Licensing

By contributing, you agree that your contributions will be dual-licensed under
the [MIT](LICENSE-MIT) and [Apache 2.0](LICENSE-APACHE) licenses, the same as
the rest of the project.
