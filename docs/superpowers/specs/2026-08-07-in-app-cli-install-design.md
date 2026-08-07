# In-app CLI install (Settings button + first-launch nudge)

**Date:** 2026-08-07
**Status:** Approved — proceeding to implementation

## Problem

The desktop `.dmg` and the `oximemo` CLI ship as **separate** GitHub release
artifacts. Installing the app does not put `oximemo` on `$PATH`, so the
"agent-friendly" promise (the CLI reads/writes the *same* vault the GUI shows,
at `~/Library/Application Support/com.oximemo.app/vault`) is invisible to
anyone who only installs the app.

The CLI is a core feature, not an afterthought. It must be reachable from the
GUI install with near-zero friction.

## Non-goals

- Headless / server / CI install: **already covered** by the existing
  `oximemo-aarch64-apple-darwin.tar.gz` release artifact (`curl | tar`). No
  change needed there.
- Windows / Linux: the app is Apple-Silicon-only; `/usr/local/bin` + `osascript`
  is macOS-specific by design.
- A custom updater for the CLI once installed — the symlink targets the bundle,
  so app updates replace the CLI automatically.

## Decision

**Bundle the CLI binary inside the `.app` and expose it via an explicit
"Install command" button in Settings** (VS Code / Cursor pattern), plus a
one-time first-launch nudge for discoverability.

### Why a button, not silent auto-install

The user chose explicit consent. macOS offers no user-writable directory that is
on the default `$PATH` *without* editing shell rc files. `/usr/local/bin` is on
the default PATH (covers interactive **and** non-interactive/agent/SSH shells,
no `.zshrc` surgery) but needs admin privileges. A user-clicked button makes the
one-time sudo prompt expected rather than creepy.

## Architecture

### Bundling — Tauri `externalBin` (signing-safe)

A nested Mach-O placed in `Contents/Resources/` is not reliably signed, so a
signed/notarized app would block it when run from the terminal. Tauri's
`externalBin` (sidecar) mechanism places the binary in `Contents/MacOS/` and
signs it as part of the bundle in both signed and unsigned builds.

```jsonc
// tauri.conf.json
"bundle": { ..., "externalBin": ["binaries/oximemo"] }   // Tauri appends -<triple>
```

- **Release workflow**: after `cargo build -p oximemo-cli`, copy the binary to
  `apps/desktop/src-tauri/binaries/oximemo-aarch64-apple-darwin` *before*
  `cargo tauri build`. Tauri bundles + signs it.
- **Local dev**: `cargo tauri dev` does **not** require the sidecar (it isn't
  resolved outside bundling). `cargo tauri build` locally needs a one-time
  `stage-cli.sh` run. `binaries/` is gitignored.

### Path resolution — runtime, not hardcoded

The symlink target is resolved from `std::env::current_exe().parent()` joined
with `oximemo-<arch>-apple-darwin` (the sidecar sits next to the main binary in
`Contents/MacOS/`). This tracks wherever the user dragged the `.app`, so the
only `Stale` case is a post-install move (fixed by Reinstall).

### Commands (`mod commands` in `src-tauri/src/lib.rs`)

| Command | Returns | Behavior |
|---|---|---|
| `cli_status` | `CliState` enum | Compares `/usr/local/bin/oximemo` symlink target (canonicalized) to the bundled path → `Installed` / `NotInstalled` / `Stale` |
| `install_cli` | `Result<(), String>` | `osascript` admin prompt → `ln -sf <bundle> /usr/local/bin/oximemo` |
| `uninstall_cli` | `Result<(), String>` | `osascript` admin prompt → `rm -f /usr/local/bin/oximemo` |

`osascript -e 'do shell script "..." with administrator privileges'` triggers the
standard macOS auth dialog once. Cancellation surfaces as an error string.

### Frontend

- **Settings → new "Command-line tool" section** (before About): queries
  `cli_status`, shows Install / Uninstall / Reinstall per state, toasts on
  success ("restart your terminal").
- **First-launch nudge** (`CliNudge` banner in `Shell`): shown once (until
  dismissed via localStorage, or once installed) when `cli_status` ≠ installed.
  Primary "Install now" + "Later" dismiss. Gated to the real Tauri shell.
- **i18n**: new keys added to `ko.ts` (source of truth) + `en.ts`.
- **Browser/dev fallback**: `cli_status` → `"not-installed"`; install/uninstall
  throw "only available in the desktop app".

## Edge cases

| Situation | Handling |
|---|---|
| User cancels sudo | `install_cli` returns error → toast "admin privileges required" |
| `.app` moved post-install | symlink stale → `cli_status` = `Stale` → "Reinstall" |
| App update | bundle path stable → symlink stays valid, CLI auto-updated |
| Future Intel/universal build | triple derived from `std::env::consts::ARCH`, not hardcoded |

## Verification

- `cargo build -p oximemo-desktop` compiles with the new commands.
- Frontend `tsc -b && vite build` passes.
- (Runtime) In a built app: button → sudo prompt → `which oximemo` resolves;
  `oximemo --version` runs; `cli_status` reports `Installed`.
