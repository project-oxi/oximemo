# garden

An opinionated personal application framework with a standard layout, React/shadcn-style controls, portable document tools, Bun services, and self-contained project templates. Native desktop hosting uses Rust and Tauri 2.

Start with the [complete framework standard](contracts/framework/README.md). It defines the stack, titlebar and pane layout, prohibited UI/copy patterns, document/editor/query/property boundaries, and explicit per-app exceptions. The [machine-readable rule registry](contracts/framework/contract.json) distinguishes automatic checks from visual, runtime and conformance verification.

## Work locally

```sh
bun install
bun run sync
bun run build
bun test
bun run doctor
bun run dev
```

## Create an app

```sh
bun run cli:install
garden new my-app
garden new my-worker --template service
```

Each project contains a vendored framework snapshot, generated agent routing, and a garden.json manifest with the `garden-personal/1` profile. The default shell provides left/right pane toggles and an upper-right command field. App names/logos in chrome and filler subtitles are prohibited. Justified deviations are recorded by rule, reason and local decision document. See the generated README for build and run commands.

For an existing app, run `garden init --dry-run`, then `garden init`. The CLI
installs framework infrastructure and records the remaining app integration.
The Garden plugin skill for Codex Desktop and OMP completes the code and layout migration using the
app's existing behavior. Run `garden update` to pull later changes from this
local checkout, including changed snapshots at the same development version.
See [CLI usage](cli/README.md). `bun run plugin:build` packages the skill and a
self-contained framework snapshot for personal installation.

## Structure

- playbook: normative engineering workflow and agent routing
- contracts: token, behavior, UI, document, and daemon authorities
- packages: reusable UI, editor, Markdown, daemon, and configuration code
- templates and cli: adoption, generation, checks, and controlled updates
- apps/playground: executable UI reference
- docs/decisions: rationale; docs/EXPERIENCE.md: preserved UX source observations

The local `archive/swiftui-v0` tag preserves the retired SwiftUI implementation. The three token vocabularies and blue --accent meaning are unchanged.

Document data adopts PDC 2 Markdown and first-class HTML, with read-only PDC 1 legacy inputs. See contracts/markdown for exact supported capabilities; source preservation takes precedence over presentation.
