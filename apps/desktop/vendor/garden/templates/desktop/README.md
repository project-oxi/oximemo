# Garden desktop app

```sh
bun install
bun run build
bun run desktop
bun run desktop:build
bun run doctor
```

This app adopts `garden-personal/1`; see [the complete standard](vendor/garden/contracts/framework/README.md). React renders shared Garden surfaces with shell-owned pane toggles and an upper-right command field. Do not add app branding to headers/sidebars or filler below page titles. Rust hosts the native window and exposes a small explicit command boundary. Framework packages and contracts are vendored under vendor/garden; this app has no private-repository dependency. Strings live in locales/en.json and locales/ko.json.

The starter is a single-workspace example, so its one-level `GNavigation` is intentional. Multi-workspace products should use a `GActivityRail` for major workspaces and a contextual `GNavigation` sidebar listing only the selected workspace's destinations; the rail and sidebar are different classification levels, so do not re-list every destination in the sidebar.

On macOS, the platform override uses a decorated overlay titlebar: AppKit owns the window corners, shadow, and traffic lights. Other platforms use the custom window controls. To create an unsigned local macOS application bundle for inspection, run `bunx tauri build --debug --bundles app`. Signing and distribution are a separate release step.

The `GDocumentEditor` demonstrates a canonical PDC Markdown draft in memory, including the shared property sheet. A product that persists documents must use the Markdown contract and storage adapter, handle external-change conflicts, and provide its own vault-contained link resolution. The native daemon health probe is configured with `GARDEN_DAEMON_SOCKET`; run the built executable with `--daemon-probe` to verify handshake and health without opening a window.
