# In-App Auto-Updater (GitHub Releases)

> **Status:** Design + implementation (executed inline — user asleep, authorized
> autonomous completion).

**Goal:** OxiMemo detects available updates automatically and installs them
in-place, sourcing signed bundles from GitHub Releases — no manual `.dmg`
download required.

**Architecture:** Tauri 2's official `tauri-plugin-updater`. The release
workflow signs the macOS `.app.tar.gz` with a Tauri minisign keypair, generates
a `latest.json` manifest, and uploads both to the GitHub release. The running
app fetches `releases/latest/download/latest.json`, compares versions, verifies
the signature against an embedded public key, downloads, and swaps the bundle.
`tauri-plugin-process` relaunches the app after install.

## Components

1. **Signing keypair** — `tauri signer generate`. Public key → `tauri.conf.json`
   `plugins.updater.pubkey`. Private key + password → GitHub Actions secrets
   `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Private
   key backed up to `~/.tauri/oximemo-updater.key` (outside the repo).

2. **Bundle target** — add `"app"` to `bundle.targets` (alongside `"dmg"`) so the
   build emits `OxiMemo.app.tar.gz` + `OxiMemo.app.tar.gz.sig`.

3. **Updater config** — `plugins.updater` with the pubkey and a single endpoint:
   `https://github.com/project-oxi/oximemo/releases/latest/download/latest.json`.

4. **Rust plugins** — `tauri-plugin-updater` + `tauri-plugin-process` registered
   in `lib.rs`.

5. **Capabilities** — `updater:default` + `process:default` in
   `capabilities/default.json`.

6. **Frontend** — `@tauri-apps/plugin-updater` + `@tauri-apps/plugin-process`.
   `src/lib/updater.ts` wraps `check()`. An `UpdaterSection` in Settings shows
   current version, a manual "Check for updates" button, the available version
   with a "Download & install" button, and a progress bar during download. After
   install, `relaunch()`. An auto-check on app launch sets a badge on the
   settings gear and toasts once per new version.

7. **Release workflow** — export `TAURI_SIGNING_PRIVATE_KEY*` env during the
   Tauri build (gated on the secret existing, mirroring the Apple-signing
   pattern). Collect `*.app.tar.gz` + `*.sig`. Assemble `latest.json` (version,
   signature from the `.sig` file, the asset download URL, pub_date). Upload all
   three to the GitHub release alongside the `.dmg` + CLI tarball.

## Constraints

- macOS Apple Silicon only (`darwin-aarch64`) — matches existing scope.
- Updates are **signed**; the app refuses unsigned bundles.
- No new external services — GitHub Releases is the single source.
- Frontend must degrade gracefully in browser/dev mode (the updater JS APIs are
  absent there).

## `latest.json` shape

```json
{
  "version": "0.8.2",
  "notes": "oximemo v0.8.2",
  "pub_date": "2026-08-08T12:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "<contents of OxiMemo.app.tar.gz.sig>",
      "url": "https://github.com/project-oxi/oximemo/releases/download/v0.8.2/OxiMemo.app.tar.gz"
    }
  }
}
```

`version` is bare (no `v`) to match `tauri.conf.json`. The app compares against
its embedded `version` field.
