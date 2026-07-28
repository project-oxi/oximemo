# Contributing to oxinot

Thanks for your interest in oxinot! This guide covers the essentials for
getting a change landed. oxinot is a small, opinionated project — when in
doubt, prefer the boring, minimal option.

## Project layout

```
crates/
  oxinot-core/     # Pure-Rust core: file store, index, search, sync, watcher
  oxinot-cli/      # `oxinot` binary — thin clap adapter over oxinot-core
  oxinot-capture/  # macOS global Option double-tap monitor (objc2)
apps/desktop/      # Tauri 2 + React 19 desktop app
skills/oxinot/     # Agent-facing SKILL.md (CLI usage for coding agents)
doc/DESIGN.md      # The full design document (read this before deep changes)
```

`oxinot-core` knows nothing about Tauri or clap. The CLI and the desktop app
are both thin adapters over [`oxinot_core::Vault`](crates/oxinot-core/src/vault.rs).
Keep it that way: domain logic belongs in the core.

## Prerequisites

- **Rust** 1.85+ (edition 2024) — <https://rustup.rs>
- **Node.js** 20+ and **pnpm** 9+ — for the desktop frontend
- **macOS 14+ on Apple Silicon** — oxinot targets `aarch64-apple-darwin` only

## Setup

```bash
git clone https://github.com/a7garden/oxinot.git
cd oxinot

# Rust checks
cargo fmt
cargo clippy --all-targets -- -D warnings
cargo test

# Desktop frontend
cd apps/desktop
pnpm install
pnpm build
```

## Development loop

| What | Command |
| :--- | :--- |
| Run the CLI | `cargo run -p oxinot-cli -- vault path` |
| Dev server (frontend) | `cd apps/desktop && pnpm dev` |
| Full desktop app (dev) | `cargo tauri dev` *(needs `cargo install tauri-cli`)* |
| Build release CLI | `cargo build --release -p oxinot-cli` |

A temporary vault is great for manual testing:

```bash
cargo run -p oxinot-cli -- --vault /tmp/oxinot-test new "hello" --tag dev
cargo run -p oxinot-cli -- --vault /tmp/oxinot-test list
```

## Before you open a pull request

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs all of these
locally — please run them too:

- [ ] `cargo fmt --all -- --check` passes
- [ ] `cargo clippy -p oxinot-core -p oxinot-cli -p oxinot-capture --all-targets -- -D warnings` is clean
- [ ] `cargo test -p oxinot-core -p oxinot-cli -p oxinot-capture` passes
- [ ] `cd apps/desktop && pnpm build` passes (TypeScript + Vite)
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
[`skills/oxinot/SKILL.md`](skills/oxinot/SKILL.md) if the CLI surface
changes) in the same PR.

## Licensing

By contributing, you agree that your contributions will be dual-licensed under
the [MIT](LICENSE-MIT) and [Apache 2.0](LICENSE-APACHE) licenses, the same as
the rest of the project.
