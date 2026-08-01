# Contributing to oximemo

Thanks for your interest in oximemo! This guide covers the essentials for
getting a change landed. oximemo is a small, opinionated project — when in
doubt, prefer the boring, minimal option.

## Project layout

```
crates/
  oximemo-core/     # Pure-Rust core: file store, index, search, sync, watcher
  oximemo-cli/      # `oximemo` binary — thin clap adapter over oximemo-core
  oximemo-capture/  # macOS global Option double-tap monitor (objc2)
apps/desktop/      # Tauri 2 + React 19 desktop app
skills/oximemo/     # Agent-facing SKILL.md (CLI usage for coding agents)
doc/DESIGN.md      # The full design document (read this before deep changes)
```

`oximemo-core` knows nothing about Tauri or clap. The CLI and the desktop app
are both thin adapters over [`oximemo_core::Vault`](crates/oximemo-core/src/vault.rs).
Keep it that way: domain logic belongs in the core.

## Prerequisites

- **Rust** 1.89+ (edition 2024) — <https://rustup.rs>
- **Bun** 1.3+ — for the desktop frontend (`curl -fsSL https://bun.sh | bash`)
- **macOS 14+ on Apple Silicon** — oximemo targets `aarch64-apple-darwin` only

## Setup

```bash
git clone https://github.com/a7garden/oximemo.git
cd oximemo

# Rust checks
cargo fmt
cargo clippy --all-targets -- -D warnings
cargo test

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

- [ ] `cargo fmt --all -- --check` passes
- [ ] `cargo clippy -p oximemo-core -p oximemo-cli -p oximemo-capture --all-targets -- -D warnings` is clean
- [ ] `cargo test -p oximemo-core -p oximemo-cli -p oximemo-capture` passes
- [ ] `cd apps/desktop && bun run build` passes (TypeScript + Vite)
- [ ] New behavior is covered by a test where it makes sense

## Commit & PR conventions

- Keep commits focused; one logical change per commit.
- Write a clear imperative subject line (`Add purge --older-than flag`, not
  `added some stuff`).
- Reference issues in the PR description (`Closes #123`).
- Open a **draft PR** early for work-in-progress discussion.

## Design authority

[`doc/DESIGN.md`](doc/DESIGN.md) is the source of truth for data models, the
storage layer, the sync algorithm, and the CLI contract. If your change
affects any of those, update the design doc (and
[`skills/oximemo/SKILL.md`](skills/oximemo/SKILL.md) if the CLI surface
changes) in the same PR.

## Licensing

By contributing, you agree that your contributions will be dual-licensed under
the [MIT](LICENSE-MIT) and [Apache 2.0](LICENSE-APACHE) licenses, the same as
the rest of the project.
