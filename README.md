<div align="center">

# oximemo

**Capture a thought before it's gone.**

A fast, minimal, card-based memo app for macOS (Apple Silicon).

Where a human hits `Option` twice and a coding agent reads the same vault over a CLI — with parity, no cloud, and plain-text files as the source of truth.

[![CI](https://img.shields.io/github/actions/workflow/status/project-oxi/oximemo/ci.yml?branch=main&logo=github&label=CI)](https://github.com/project-oxi/oximemo/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/project-oxi/oximemo?include_prereleases&logo=github)](https://github.com/project-oxi/oximemo/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Rust](https://img.shields.io/badge/Rust-1.89%2B-dea584?logo=rust&logoColor=000)](https://www.rust-lang.org)
[![Tauri](https://img.shields.io/badge/Tauri-2-24c8d8?logo=tauri&logoColor=000)](https://v2.tauri.app)
[![macOS](https://img.shields.io/badge/platform-macOS%20%7C%20Apple%20Silicon-000000?logo=apple&logoColor=fff)](#system-requirements)

</div>

---

> **oximemo** is optimized for the *speed of catching a thought*. Every memo is a **card**; cards live on a **grid**. There is no AI summary, no auto-tagging, no chatbot — those trade away the capture speed and reliability this project exists to protect.

Two core scenarios, one vault:

1. **A human** double-taps `Option` anywhere on macOS, types one line, and disappears back into their work.
2. **An agent** (coding agent, local script) reads and writes those same notes over the `oximemo` CLI — safely, with no duplicates.

## Highlights

- **Files are the source of truth.** Notes are plain `.md` files with TOML frontmatter. `grep` and `cat` work. The index is just a cache — rebuildable at any time with `oximemo reindex`.
- **Three-tier storage, pure Rust.** Plain files + a `redb` metadata index + a `tantivy` BM25 full-text index. No SQLite, no C dependencies in the index layer.
- **Capture that doesn't make you wait.** The overlay window is warmed up off-screen so it appears in a single frame (target ≤ 16 ms) on trigger.
- **Human/agent parity.** Every GUI operation is a CLI operation. Agent-facing commands default to **JSON / NDJSON** for clean streaming and scripting.
- **Hash-based sync.** `oximemo export` emits a body-less manifest of `{id, hash, updated_at, deleted}`; diff the hashes, fetch only what changed, advance your cursor. Handles `ARG_MAX` with `--ids-file` / `--ids-stdin`.
- **OKLCH colors.** Perceptually uniform, CSS-native color labels that look right in both light and dark mode.
- **Hardened against external writes.** The file watcher debounces, retries partial writes (editors, iCloud), and never crashes the indexer.
- **HTML notes (`.html`).** `.html` files are first-class notes alongside `.md` — frontmatter lives in a leading HTML comment, the title is derived from the first `<h1>`/`<title>`, and the same TEMPLATE rule applies (`TEMPLATE.html` for HTML notes, `TEMPLATE.md` for markdown). The CLI creates HTML notes with `oximemo new --html`.
- **oxibrain context panel.** A read-only panel in `MemoDetail` gathers recall layers from the local oxibrain daemon over its Unix socket (no cloud); `[brain]` in `oximemo.toml` controls `enabled`/`socket`/`space`.

## Table of contents

- [System requirements](#system-requirements)
- [Install](#install)
- [Quick start (CLI)](#quick-start-cli)
- [The vault](#the-vault)
- [Architecture](#architecture)
- [Project structure](#project-structure)
- [Synchronization for agents](#synchronization-for-agents)
- [Development](#development)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

## System requirements

- **macOS 14+** on **Apple Silicon** (`aarch64-apple-darwin`).
- Rust 1.89+ (edition 2024) to build from source.

Windows, Linux, and mobile are intentionally out of scope for the MVP. See the [design doc](doc/DESIGN.md).

## Install

### From a release

Download the prebuilt `oximemo` binary and `.dmg` from the
[latest release](https://github.com/project-oxi/oximemo/releases), then:

```bash
tar -xzf oximemo-aarch64-apple-darwin.tar.gz
sudo install -m 0755 oximemo /usr/local/bin/oximemo
oximemo --version
```

### From source

```bash
git clone https://github.com/project-oxi/oximemo.git
cd oximemo
cargo build --release -p oximemo-cli
# binary: target/release/oximemo
```

> A Homebrew tap (`brew install`) is planned. For now, use a release tarball or build from source.

## Quick start (CLI)

The CLI is the authoritative interface — the same `oximemo-core` the desktop app uses.

```bash
# Capture a thought (text arg, or omit to read stdin)
oximemo new "Ship the redb bump before the freeze" --tag backlog --category todo

# Create an HTML note (frontmatter lives in a leading <!-- +++ ... +++ --> comment)
oximemo new "Knowledge distillation draft" --html

# List recent notes — table for humans (default), JSON/NDJSON for agents
oximemo list --limit 10
oximemo list --favorites --format ndjson

# Read one memo (JSON by default; --md for the raw file)
oximemo get 019fa927-a897-7e12-9102-8a8c7ebbb594 --md

# Full-text search (BM25 over body + tags)
oximemo search "redb upgrade" --limit 5 --format ndjson

# Edit a memo (favorite / category / body) and manage categories
oximemo update 019fa927-a897-7e12-9102-8a8c7ebbb594 --favorite --category idea
oximemo category list
oximemo category new research --color "oklch(0.72 0.15 310)"

# Where does my vault live?
oximemo vault path
```

<details>
<summary><strong>Full command reference</strong></summary>

oximemo new [TEXT] [--tag TAG]… [--category ID] [--html]   # --html creates a .html note (frontmatter in a leading HTML comment)
oximemo list [--limit N] [--tag T] [--category ID] [--favorites] [--format table|json|ndjson]
oximemo list --where status=stub --sort status_changed --offset 40   # property query (offset path)
oximemo list --where domain=TECH,MATH --where subdomain~AI           # comma = any-of; ~ = list membership
oximemo update <ID> --set status=understood --unset draft            # property set/remove
oximemo get <ID> [--md]
oximemo export [--since RFC3339] [--ids a,b,c | --ids-file PATH | --ids-stdin]
              [--full] [--format ndjson|json]
oximemo delete <ID>                                     # soft-delete → .trash/
oximemo restore <ID>                                    # un-delete a trashed memo
oximemo purge [--older-than 30d]
oximemo category list [--format table|json|ndjson]
oximemo category new <ID> [--color "oklch(...)"]
oximemo category recolor <ID> <COLOR> | --none         # set or clear a category's color
oximemo category rename <OLD> <NEW>                    # moves memos; prints count
oximemo category delete <ID>                           # inbox cannot be deleted
oximemo reindex                                        # rebuild indexes from files
oximemo doctor [--fix]                                 # audit / safe-repair
oximemo vault path                                     # print the vault root
oximemo upgrade [--check]                              # self-update from GitHub Releases
```

Global: `--vault <PATH>` (or `OXIMEMO_VAULT`) selects a non-default vault. Output formats: `table` (human), `json` (single array), `ndjson` (one value per line, the default for `export`/`search`). Timestamps are RFC 3339.

</details>

<details>
<summary><strong>Global capture & desktop app</strong></summary>

- **Capture overlay:** double-tap `Option` (needs Accessibility / Input Monitoring permission), or the always-available `Cmd+Shift+N`, or the menu-bar icon. `Enter` saves & dismisses, `Shift+Enter` newline, `Esc` cancels.
- **Card grid:** search, tag/favorite filters, OKLCH color labels, virtualized for large vaults.
- Light/dark follows the macOS system appearance.

</details>

## The vault

Notes are plain text — humans and agents can read them with anything.

```plain
vault/
├── memos/
│   └── 2026/07/
│       ├── 01991a2e-7c3f-7c91-9f3e-6b1a2e8f9c10.md
│       └── 01991a31-9b10-70aa-8c2e-4f0a1d2b3c44.md
├── .trash/          # soft-deleted memos
└── config.toml      # optional vault settings
```


Notes can also be `.html` files — frontmatter sits in a leading HTML comment (`<!-- +++ ... +++ -->`), the title is derived from the first `<h1>` (or `<title>`), and folder templates follow the same rule: a folder with `TEMPLATE.html` (and no `TEMPLATE.md`) auto-creates new notes as HTML, and a folder can ship both to drive the toolbar's split "new note" button.

`oximemo.toml` also carries an optional `[brain]` section (`enabled`/`socket`/`space`, defaults `true` / `""` / `"personal"`) for the read-only oxibrain context panel in `MemoDetail`; the panel hides itself when `enabled = false`.

Each memo is one file with TOML frontmatter delimited by `+++`:

```markdown
+++
id = "01991a2e-7c3f-7c91-9f3e-6b1a2e8f9c10"
created_at = "2026-07-28T10:15:03+09:00"
updated_at = "2026-07-28T10:15:03+09:00"
hash = "b3:6f2a9e1d4c7b8a90f1e2d3c4b5a6978…"
favorite = false
category = "inbox"
tags = ["idea", "oximemo"]
+++

The capture overlay must appear in under one frame.
```

The `id` is a time-sortable **UUIDv7**; the `hash` is **`b3:` + BLAKE3** over the normalized body, tags, favorite flag, and category — so a pure metadata edit (add a tag, change a category) bumps the hash and is detected by sync. Full parsing rules and the safe-writing guide are in [`doc/DESIGN.md`](doc/DESIGN.md) §5 and [`skills/oximemo/SKILL.md`](skills/oximemo/SKILL.md).

### Daily notes

A persistent sidebar calendar (DAILY section) opens — or creates — one note per day in the `[daily]` folder (`oximemo.toml`: `enabled`, `folder`, default `daily`). Notes are titled by ISO date (`2026-08-21.md`), so they are ordinary notes: searchable, taggable, movable. A `TEMPLATE.md` in the daily folder seeds new entries (`{{date}}`, `{{weekday}}`, … are filled with the *local* date); if the template's heading isn't the date, the date heading is prepended so filenames stay deterministic. Days with a note show a dot; past and future days can be created (backfilling and planning). Set `enabled = false` to hide the sidebar section and Today button.

### Note properties & folder schemas

Every frontmatter key beyond the core five (`id`, `created`, `updated`,
`favorite`, `deleted`) is a **property** — indexed, searchable through
aliases, covered by the sync digest, and editable in the app's property
panel or over the CLI (`--set` / `--unset`). Files stay plain
Obsidian-compatible markdown.

A folder that carries a `SCHEMA.toml` declares its property system:
types and allowed values, card badges with color tokens, state
transitions (e.g. the knowledge preset's `peak_status` max-merge that
preserves the all-time high through decay/re-learn cycles), and an
optional `[review]` block that turns the folder's header into a review
queue ("설명 가능함" reasserts, "막힘" decays). The ⌘K action **지식 관리
폴더 만들기** installs the full knowledge-state preset (stub → vague →
understood → mastered, decayed) as two editable files. TEMPLATE.md
frontmatter seeds new notes' properties — a quick capture into a schema
folder starts at `status: stub`.

`[[wiki links]]` resolve through titles **and** `aliases`, and links
inside property values (e.g. `related`) count for backlinks, the graph,
and rename propagation — so an empty stub stays connected.

## Architecture

`oximemo-core` is a pure-Rust library that owns the file store, indexes, file-watching, and sync. The desktop app (Tauri) and the CLI are **thin adapters** over [`oximemo_core::Vault`](crates/oximemo-core/src/vault.rs) — so the GUI and CLI always behave identically and can share one live vault (guarded by an `fs2` advisory lock).

```mermaid
flowchart TB
    subgraph Native["macOS native"]
        CAP["oximemo-capture\nobjc2 global flagsChanged monitor\n(Option double-tap)"]
        MENU["Menu-bar NSStatusItem"]
    end
    subgraph App["Tauri desktop app (apps/desktop)"]
        RUST["Tauri Rust backend"]
        UI["React 19 frontend\ncard grid + overlay"]
    end
    subgraph CLI["oximemo-cli"]
        BIN["clap subcommands\nnew / list / search / export …"]
    end
    subgraph Core["oximemo-core (pure Rust)"]
        FILES[("Files (*.md)\nsource of truth")]
        LOCK["fs2 advisory lock"]
        REDB[("redb metadata\nindex")]
        TANT[("tantivy\nBM25 search")]
        WATCH["notify watcher"]
        SYNC["hash dedup / export"]
    end
    AGENT["External agent\n(coding agent / script)"]

    CAP --> RUST
    MENU --> RUST
    RUST <--> UI
    RUST --> Core
    BIN --> Core
    FILES --> WATCH --> REDB
    WATCH --> TANT
    LOCK -. guards .-> REDB
    REDB --> SYNC
    AGENT -- "CLI call" --> BIN
```

| Layer | Role | Tech |
| :--- | :--- | :--- |
| Source of truth | Human-readable memo bodies | `.md` files + TOML frontmatter |
| Metadata index | Fast pagination, filters, sync cursor | `redb` |
| Full-text index | BM25 keyword search | `tantivy` |

The index layers are 100% derivable from the files — corrupt or stale? One `oximemo reindex` restores them.

## Project structure

```
oximemo/
├── crates/
│   ├── oximemo-core/      # Pure-Rust core: store, index, search, watcher, sync
│   ├── oximemo-cli/       # `oximemo` binary — clap adapter over oximemo-core
│   └── oximemo-capture/   # macOS global Option double-tap monitor (objc2)
├── apps/desktop/         # Tauri 2 + React 19 desktop app
│   ├── src-tauri/        #   Rust backend
│   └── src/              #   React frontend (Tailwind v4, Base UI, TanStack)
├── skills/oximemo/        # SKILL.md — agent-facing CLI guide
└── doc/DESIGN.md         # Full design document
```

## Synchronization for agents

The manifest is cheap on purpose — bodies are omitted, so it stays light for tens of thousands of notes.

1. **Fetch the manifest since your cursor:**
   ```bash
   oximemo export --since "$CURSOR" --format ndjson > manifest.ndjson
   ```
2. **Diff against your local `id → hash` cache** (in your code):
   - `id` unseen → **fetch**
   - `hash` differs → **fetch** (covers tag/favorite/color edits too)
   - `deleted: true` → **drop**
3. **Fetch changed bodies in bulk** (use `--ids-file`/`--ids-stdin` past `ARG_MAX`):
   ```bash
   oximemo export --ids-file ids.txt --full --format ndjson
   ```
4. **Advance your cursor** to the max `updated_at` seen. Repeat.

The full procedure, output schemas, and the safe direct-write rules are in [`skills/oximemo/SKILL.md`](skills/oximemo/SKILL.md).

## Development

```bash
# Rust
cargo fmt
cargo clippy -p oximemo-core -p oximemo-cli -p oximemo-capture --all-targets -- -D warnings
cargo test -p oximemo-core -p oximemo-cli -p oximemo-capture

# Desktop frontend
cd apps/desktop
bun install
bun run build
```

A scratch vault is handy for manual testing:

```bash
cargo run -p oximemo-cli -- --vault /tmp/oximemo-test new "hello" --tag dev
cargo run -p oximemo-cli -- --vault /tmp/oximemo-test list
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full workflow, and [`doc/DESIGN.md`](doc/DESIGN.md) for the design authority.

## Roadmap

- **v0.3+** — MCP server mode (`oximemo mcp serve`), multiple vaults, iCloud-Drive vault auto-detection, optional wikilinks/backlinks.
- **Deferred by design** — AI summaries, auto-tagging, chatbot, and embedding-based semantic search. BM25 keeps the capture loop fast; an offline embedding path (Rust `candle`, Metal-accelerated) stays a possibility if real demand appears.

## Contributing

Contributions are welcome! Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) first.

By contributing, you agree your contributions will be licensed under the
[MIT License](LICENSE).

## License

Licensed under the [MIT License](LICENSE).

Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in this project by you shall be licensed under the MIT License,
without any additional terms or conditions.
