# In-app update architecture (RFC)

Status: **Proposed** (oximemo v0.9.1 ships the CLI half; GUI half is the next
migration step. oxiline's standalone CLI is the same shape with different
binary names.)

This document is the single source of truth for how the oximemo family updates
itself. It records the decision, the boundaries between components, the wire
contracts, and what is still open.

## The decision

**The CLI is the only place that downloads, verifies, and swaps. The GUI is
a view of the CLI.**

Concretely:

- The CLI owns: manifest fetch, version compare, download, signature
  verification, extraction, atomic swap, and the "I just updated" signal.
- The GUI owns: when to trigger the CLI, the progress UI, and the relaunch.
- The GUI does **not** download or verify anything. `tauri-plugin-updater` is
  removed.

One engine, two surfaces. Not two engines.

## Why

Two existing designs, both shippable, both with one real weakness each:

| Design | Strength | Real weakness |
|---|---|---|
| **Tauri plugin in the GUI** (oxiline today) | Single code path; Tauri signs, Tauri relaunches, Tauri reopens | Standalone CLI (headless, agent, CI) is stranded forever |
| **CLI self-update** (oximemo v0.9.1 today) | Standalone machines update themselves | GUI process is stale after the CLI swaps the bundle; the user has to relaunch the GUI by hand |

Putting both engines in the same project means two code paths to keep
trustworthy, and each one covers only half the deployment. The unified design
keeps the *engine* in the CLI (so headless is free) and lets the GUI be a thin
view of that engine (so UX stays consistent and the safety net of a Tauri
relaunch survives).

## Components

```text
                 oximemo upgrade  (CLI = the only engine)
   ┌──────────────────────────────────────────────────────────┐
   │  1. fetch latest.json                                    │
   │  2. version compare                                      │
   │  3. download with progress → JSON events on stdout       │
   │  4. minisign verify                                      │
   │  5. atomic swap (.app bundle, or standalone binary)      │
   │  6. write settings.update_request_at = now (ISO 8601)    │
   └──────────────────────────────────────────────────────────┘
                            │
                            │ spawn as sidecar
                            ▼
   ┌─────────────────────────────┐    ┌─────────────────────┐
   │  Terminal                   │    │  OxiMemo.app (GUI)  │
   │  oximemo upgrade            │    │  view of the engine │
   │  - plain text, exits        │    │  - parses JSON      │
   │  - user re-runs manually    │    │  - shows progress   │
   │  - ignores update_request_at│    │  - on "done" event, │
   │                             │    │    the running GUI  │
   │                             │    │    has already been │
   │                             │    │    watching the     │
   │                             │    │    setting and will │
   │                             │    │    tauri-plugin-    │
   │                             │    │    process::relaunch│
   └─────────────────────────────┘    └─────────────────────┘
```

`update_request_at` is the only channel between the two processes, and it
carries the narrowest possible meaning: *"I just finished swapping; please
relaunch yourself."* It is the same channel oxiline already uses for the same
purpose.

## Wire contract: CLI progress events

`oximemo upgrade [--check] [--json-progress]`

- Without `--json-progress`: human-readable lines, as today.
- With `--json-progress`: one JSON object per line, no other output on stdout
  (stderr is free for logs). Schema:

```jsonc
{"type":"checking"}
{"type":"current","version":"0.9.1"}
{"type":"available","from":"0.9.1","to":"0.9.2","notes":"…"}
// (also emitted when already up to date, with to=from)
{"type":"latest","version":"0.9.1"}
{"type":"download","pct":0}
{"type":"download","pct":42}
…
{"type":"verifying"}
{"type":"swapping","mode":"app"}    // or "standalone"
{"type":"done","version":"0.9.2"}
{"type":"error","message":"…"}
```

`--check` exits after the `latest`/`available` event. The GUI never
interprets the absence of `done` as success.

## Wire contract: the relaunch signal

Setting: `settings.update_request_at` (string, RFC 3339 timestamp).

Semantics:

- The CLI writes this *after* the atomic swap succeeds.
- The GUI watches this setting (polling, on focus, on resume — whatever the
  surface already does for `update_request_at` from a CLI→GUI signal in
  oxiline). On a value it has not seen before, it:
  1. clears the value (so a later GUI launch does not refire on the stale
     timestamp),
  2. calls `tauri-plugin-process::relaunch()`.
- Standalone (no GUI) ignores the setting. It is harmless to write.

## Component boundaries

| Concern | Lives in |
|---|---|
| `latest.json` URL | `tauri.conf.json` → read by the CLI via the same constant the GUI updater used to read; no longer in Tauri config. |
| minisign public key | The CLI's `PUBKEY` constant (a single line of base64). GUI no longer embeds it. |
| Download / verify / extract | CLI only. |
| Atomic rename | CLI only. Lives in `crates/oximemo-cli/src/upgrade.rs::upgrade_in_app` / `upgrade_standalone`. |
| Auto-check cadence | GUI only (boot + 6h, as oxiline does today). The GUI spawns the sidecar. |
| Progress UI | GUI only. Parses the JSON contract above. |
| Relaunch | GUI only. `tauri-plugin-process`. |

What is **not** in the picture anymore: `tauri-plugin-updater`, the
`plugins.updater` block in `tauri.conf.json`, `bundle.createUpdaterArtifacts`,
the `updater:default` capability, and `@tauri-apps/plugin-updater` in the
frontend.

## Release pipeline

The release workflow builds the macOS bundle and signs it (this is unchanged
from oximemo v0.9.1 and oxiline today), then **manually** emits `latest.json`
via `jq`. The current `release.yml` already uses `jq -n --arg` to safely
encode the multi-line minisign signature; this is kept verbatim. Once
`createUpdaterArtifacts` is removed from `tauri.conf.json`, that step must
stay — Tauri will not auto-emit the manifest.

Required assets in the GitHub release:

- `OxiMemo.app.tar.gz` and `OxiMemo.app.tar.gz.sig` (GUI bundle + minisign)
- `oximemo-aarch64-apple-darwin.tar.gz` and its `.sha256` (standalone CLI)
- `OxiMemo_0.9.x_aarch64.dmg` (installer, unchanged)
- `latest.json` (manifest)

The signature embedded in `latest.json` is the one over
`OxiMemo.app.tar.gz`. It is what the CLI verifies before swapping the bundle.

## Migration: oximemo v0.9.1 → unified

The CLI half already exists (`oximemo upgrade`, `crates/oximemo-cli/src/upgrade.rs`).
The GUI half is what changes:

1. Add `--json-progress` to the CLI and a `done` event.
2. Make `oximemo upgrade` write `update_request_at` on success.
3. Remove from the Tauri app:
   - `tauri-plugin-updater` from `Cargo.toml`
   - `plugins.updater` from `tauri.conf.json`
   - `bundle.createUpdaterArtifacts` from `tauri.conf.json`
   - `updater:default` from `capabilities/default.json`
   - `@tauri-apps/plugin-updater` from `package.json`
4. Rewrite `lib/updater.ts` to spawn the sidecar (`@tauri-apps/plugin-shell`)
   and parse the JSON contract. Keep the zustand store, the banner, the
   Preferences section, and the `update_request_at` watcher.
5. `release.yml`: keep the manual `jq` manifest step (it is the only
   remaining path once `createUpdaterArtifacts` is gone).

## Migration: oxiline → unified

Same shape, different binary names. oxiline's GUI already has the auto-check
cadence, banner, and `update_request_at` watcher, so the visible UI does not
change much. The invisible half (the updater plugin and its Tauri-managed
verify) is removed and replaced with a sidecar spawn of the CLI.

Net effect for oxiline: standalone `oxiline` CLI (the headless / agent /
CI machine) finally gets a self-update path, without losing any of the
GUI's existing UX.

## Open questions

- **End-to-end swap is not yet exercised against a live newer release.**
  The CLI's verify path is exercised by an ignored network test against the
  v0.9.0 signature (passing). The download → extract → rename → relaunch
  path is *only* verified at the code level. Before removing the
  `tauri-plugin-updater` safety net in either project, someone must run the
  CLI swap against a real newer `.app.tar.gz` end-to-end on a machine where
  the GUI is running. The cheapest probe is to temporarily build the CLI
  with `CARGO_PKG_VERSION` set to an older release and point it at the live
  `latest.json`. This is a follow-up to this RFC, not a precondition for
  landing it.
- **Quarantine xattr.** A downloaded `.app.tar.gz` is unzipped and a fresh
  `.app` is written under `/Applications/...`. Whether Gatekeeper on
  relaunch blocks the swapped bundle (because the new `OxiMemo.app` has the
  `com.apple.quarantine` xattr from the temp directory it was extracted in)
  needs to be checked on first run. If it does, the CLI must
  `xattr -dr com.apple.quarantine` the new bundle as the last step before
  signalling relaunch.
- **Concurrent CLI invocations.** Two `oximemo upgrade` processes racing on
  the same `.app` could collide. The CLI already creates a sibling tempdir
  per call and uses atomic rename, so the swap itself is safe, but two
  downloads waste bandwidth. A flock on `~/Library/Application
  Support/com.oximemo.app/upgrade.lock` would prevent the double-work. Not
  required for v1, noted for v2.
- **Codesign identity after swap.** The Tauri release signs the bundle
  in-place during build. After the CLI extracts the `.app` into a new
  location and renames it, the ad-hoc signature travels with the files
  (signatures are on individual binaries, not directory paths), so this
  should be fine. To be confirmed during the end-to-end probe.
- **Release notes delivery.** `latest.json` already carries a `notes`
  field. The CLI's `available` event surfaces it; the GUI's banner /
  Preferences section can render it directly. No change needed.
