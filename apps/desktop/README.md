# Oximemo desktop

React/Vite UI for the repository Tauri host. See the repository-root README and
AGENTS.md for application architecture, native development and PDC migration.

## Develop

```sh
bun install --frozen-lockfile
bun run dev
bun run build
bun test src/lib/theme.test.ts src/stores/ui.test.ts src/lib/locales.test.ts src/lib/paletteCommands.test.ts
```

The web preview runs at http://127.0.0.1:5173/ and uses browser-only sample data.
Native backend behavior requires the repository Tauri host.

## Garden UI

Garden 0.1.0 is vendored under `vendor/garden` and selected by `garden.json`.
The UI workspace uses public `@garden/ui` APIs. The app-owned visual adapter
retains Oxi Glass and both note layouts. Read
[the integration decision](docs/decisions/0001-garden-ui-integration.md) and
[the UI assessment](../../docs/GARDEN-UI-ASSESSMENT.md).

```sh
bun run garden:sync
bun run garden:doctor
```

The native host uses exact Garden pins (`tauri = 2.12.0`, `tauri-build = 2.7.0`)
and the selected Rust 1.98.1 toolchain. Doctor passes the managed snapshot,
contracts, tokens, locales and dependency checks. The custom host and visual
exceptions remain recorded; this is incremental framework adoption.

Native checks, from this directory:

```sh
cargo test --locked -p oximemo-desktop --lib
cargo clippy --locked -p oximemo-desktop --all-targets -- -D warnings
```

Product copy lives in `locales/en.json` and `locales/ko.json`. TypeScript
compatibility exports retain existing imports and key types. `bun run typecheck`
keeps strict app diagnostics and vendor type errors, while excluding only the
unused-import diagnostics introduced by Garden's public TypeScript source.
