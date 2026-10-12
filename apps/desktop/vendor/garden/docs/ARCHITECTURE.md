# Garden Architecture

Garden is an opinionated personal application framework governed by [the complete framework standard](../contracts/framework/README.md). It combines normative playbook rules, machine-readable contracts, shared packages, and templates that vendor the selected framework files into each app. A generated app remains self-contained and does not depend on a private Garden checkout at runtime.

## Workspace map

```text
playbook/                   English engineering rules and agent routing
contracts/                  machine-readable token, UI, behavior, Markdown, and daemon contracts
packages/ui/                @garden/ui: React components and the Tauri webview shell
packages/config/            shared Biome, TypeScript, and CI configuration
packages/daemon-kit/        reusable TypeScript daemon mechanics
packages/markdown/          Markdown document model, parsing, and validation
packages/editor/             Garden Markdown editor integration
packages/native/             generated Rust command bindings
apps/playground/             runnable UI and contract playground
cli/                         garden new, doctor, sync, and update
scripts/build-tokens.mjs     deterministic CSS and TypeScript token bindings
```

The desktop app has one UI implementation: React in a WebView hosted by Tauri 2. Rust owns the native shell and backend boundary. The former SwiftUI implementation is archived in Git tag `archive/swiftui-v0`; `docs/EXPERIENCE.md` remains the UX source record because it contains measurements from Codex desktop's app bundle. This removes a second UI source while preserving the evidence behind the design decisions.

React packages (`ui`, `editor`) and generated UI apps share the bundler-oriented
TypeScript configuration from `packages/config`; their source-export packages
are typechecked without emitting a competing distribution tree. Headless
Markdown/native/service packages retain their appropriate NodeNext build
boundaries. Do not typecheck browser source packages with a NodeNext resolver
that contradicts the Vite/shared UI import model.

## Token pipeline

`contracts/tokens/garden.tokens.json` is the only hand-edited token source. `scripts/build-tokens.mjs` reads it and the preserved beautifului vendor stylesheet to produce:

```text
packages/ui/src/styles/garden.css     generated CSS and Tailwind mappings
packages/ui/src/tokens.generated.ts   generated TypeScript token object
```

Both outputs are deterministic. Run `node scripts/build-tokens.mjs` to update them and `node scripts/build-tokens.mjs --check` to detect drift without writing. Generated files carry a DO NOT EDIT marker. The original three-layer vocabulary and the `--accent` decision remain intact: Garden's `--g-*` layer feeds the beautifului aliases and the shadcn aliases, while shadcn's ambiguous `--accent` is intentionally omitted. The focus blue remains `--accent`; neutral hover uses `--hover` / `bg-hover`. See [PARITY.md](./PARITY.md).

## UI package boundary

`@garden/ui` exports framework components and semantic primitives from `packages/ui/src/index.ts`. Its `styles.css` entry imports the generated token sheet, the font faces, and the shared shell rules. Library internals use relative imports so the template can vendor this package under `vendor/garden/packages/ui` without an app-specific `@/` resolver. The old shadcn CLI configuration was removed because it described an alias generated apps could not resolve. React and React DOM are exact `19.3.0` peers; the root and each generated app pin the same version.

`GAppShell` composes titlebar, sidebar, main content, optional right and bottom panels, composer, and command palette. `GAppShell` supplies pane toggles and an upper-right command launcher by default. `GTitleBar` has additional left, center, and right slots and an empty-space Tauri drag region. App identity remains outside visible app chrome; page titles have no default subtitle. `GSettings` provides the common section-navigation/form layout. `GCommandPalette` provides Meta/Control+P, keyboard navigation, focus containment, and focus restoration. Accessible names, placeholders, empty-state labels, and app copy are passed by callers from `locales/ko.json` and `locales/en.json`; the package has no hidden language default.

The original component demo remains available only in the playground at `?view=legacy`. It is a migration fixture, not a framework API. Vendor source and its MIT attribution are kept with the package and in `docs/LICENSE-beautifului.txt`.

## Vendoring and updates

Templates copy `playbook`, adopted `contracts`, and selected `packages` into the new repository. The generated `garden.json` manifest declares the `garden-personal/1` profile, named adoptions and rule-specific exceptions with local decision records. `contracts/adoptions.json` resolves adopted contract paths and package names. `garden sync` regenerates derived files from vendored contract sources; `garden doctor` runs generator check mode and validates pins and adoption paths. `garden update` is the only version promotion path and carries migration notes. A generated app can be built and reviewed without access to the source Garden repository.

## Dependency and shell boundaries

React components depend on React and explicit component libraries. They do not import Tauri APIs. Tauri window creation, tray integration, global shortcuts, file access, and protocol supervision belong to the Rust shell and its typed bridges. The webview and TS daemon share contracts rather than implementation details. `contracts/ui-spec` records surface composition and plugin mapping; `contracts/daemon-protocol` defines daemon handshake and RPC behavior.

## Design decisions

- **React plus Tauri 2:** use one reusable web UI and keep native window and backend code in Rust. This avoids keeping React and SwiftUI component trees in parity.
- **Library first:** shared surfaces ship as `@garden/ui`; the playground is the visual test bed. Settings and quick chat become additional native windows through templates, not standalone UI libraries.
- **Vendored package source:** generated repositories include their adopted rules, contracts, and package code. This keeps personal apps independently buildable without a package registry or access to the framework checkout.
- **Token semantics unchanged:** the original color, spacing, and radius values, three vocabularies, and `--accent` resolution remain because components depend on them. Unused Swift-specific annotations were removed with the retired binding.
- **Reference measurements are structural evidence:** Cassette and Obsidian screenshots establish that independent navigation, toolbar, and document panes work across products. Their screenshot pixel counts are not copied as CSS dimensions. Codex app-bundle measurements remain the source for Garden's concrete token recipe.
