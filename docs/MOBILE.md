# Tauri mobile app and local PC sync

The mobile client lives in `apps/mobile`. It uses Tauri 2, React, and the
`oximemo-sync` Rust client. The existing desktop app keeps its own windows,
capture hooks, and agent integrations. The mobile app has a touch layout for
notes, search, source editing, trash inspection, and PC connection settings.

## Connect a PC

Install Tailscale on the PC and phone, sign in to the same tailnet, and allow
phone-to-PC access in that tailnet's access policy. Enable HTTPS for Tailscale
Serve as described in the [Tailscale Serve guide](https://tailscale.com/docs/features/tailscale-serve).

Build the CLI from this checkout:

```sh
cargo build -p oximemo-cli
```

Create a private token once (reuse it across server restarts):

```sh
mkdir -p ~/.oxi/oximemo
(umask 077; openssl rand -hex 32 > ~/.oxi/oximemo/mobile-token)
```

Keep this terminal running while syncing. For the active space:

```sh
./target/debug/oximemo mobile-serve --token-file ~/.oxi/oximemo/mobile-token
```

For a selected vault:

```sh
./target/debug/oximemo --vault /absolute/path/to/vault mobile-serve \
  --token-file ~/.oxi/oximemo/mobile-token
```

In another terminal:

```sh
tailscale serve --bg http://127.0.0.1:9843
```

Use the HTTPS `https://<pc>.<tailnet>.ts.net` address printed by Serve to
generate a connection QR on the PC, while the server is running:

```sh
./target/debug/oximemo mobile-pair \
  --url https://my-pc.tail123.ts.net \
  --token-file ~/.oxi/oximemo/mobile-token
```

In the mobile app, open **PC 연결 → PC의 QR 스캔**, scan the terminal QR,
check the displayed PC address, and tap **이 PC 연결**. The app receives and
saves its sync credentials and starts syncing automatically. If the camera
is unavailable, copy the single `OM1:...` connection code printed on the PC,
paste it into **연결 코드**, and tap **코드 확인 → 이 PC 연결**. The code
contains the PC address, so no separate address or token entry is needed.

To show a QR page in a browser or print it, add `--qr-file /path/to/new-qr.html`
to the command. The file is created privately and must not already exist.
The page includes the same QR and copyable connection code, with no reusable
sync token. QR generation is local and does not use an external QR service.

Codes use a random 128-bit secret, expire after ten minutes, and connect one
request identity. Repeating the identical mobile request can recover a lost
response during that window; another request identity cannot reuse it. Each
`mobile-pair` command invalidates the previous code. Server restarts expire all
pending codes. Twenty invalid attempts lock the current code. Generate a new
code when it expires or is locked. The phone preserves its retry identity in
private state before exchanging the code.

The native Rust client performs credential exchange; reusable credentials are
never returned to the WebView. The credential file is private app data
(owner-only on Unix), not a Keychain credential in this initial version.
The **주소와 토큰으로 직접 연결** disclosure retains manual setup as a fallback.

The server binds only to loopback; non-loopback `--bind` values are refused.
Sync and code-generation routes require the token; the pairing exchange
requires the active one-time secret. Browser Origin requests are refused, and
request bodies are limited. HTTPS is terminated by Tailscale Serve. Redirects
are disabled and the client accepts only root HTTPS URLs on `.ts.net`, port
443. This uses the phone's installed Tailscale VPN; it does not embed a VPN or
use Funnel. No service or Tailscale configuration is started automatically.

To stop exposing this service, use `tailscale serve status` to inspect the
current configuration and remove this endpoint with the Serve CLI. The
server stops when its terminal process exits. Rotating the private token
requires restarting the server and reconnecting the phone with a new QR/code
(or entering the new token manually).

## Offline behavior and preservation

- Saving stores an editor draft in the app's private, atomic JSON cache. The
  cache holds exact PC source snapshots plus separate draft text; it is not a
  second canonical vault. A new offline draft becomes a canonical PDC 2 file
  when the PC acknowledges it. Do not uninstall the app with unsynced drafts.
- Unsent drafts can be reopened and edited. Once a send is attempted, its
  payload stays immutable until the result is confirmed. A disconnected
  request may already have reached the PC: **전송 결과 다시 확인** retries the
  same request rather than creating another one.
- Sync runs on launch/resume, browser connectivity events, and the sync
  button, and after a local save when a PC is registered. The local draft is
  persisted before sending. This version has no OS background service. The PC must be awake,
  and both Tailscale and the sync server must be running.
- Source SHA-256 guards every update. The server resolves canonical UUIDs to
  current paths, so a PC rename retains identity. Remote changes, duplicate
  IDs, or removal reject a stale update; the mobile snapshot and draft remain.
  A confirmed rejection offers **초안을 새 메모로 보관** or **PC 원문 사용**.
- The server persists immutable prepared-write receipts before touching a
  document. A retried request is idempotent across restarts. Receipts live in
  the vault's private index directory under `mobile-receipts`; preserve them
  if a device has requests awaiting acknowledgment.
- New Markdown and HTML use the existing PDC 2 writer. Unknown envelope
  fields and source constructs survive updates. Legacy `.md`, `.html`, and
  PDC 1 `.djot` remain visible, with read-only source fallback and diagnostics.
  Queries are read-only. No source is converted or normalized by a pull.
- Canonical tombstones appear in **휴지통**, separate from the default list;
  recovery is performed on the PC. Deletion and asset upload are not exposed
  by this first mobile client.

Markdown notes open in a sanitized reading view with CommonMark/GFM headings,
lists, tables, code, and disabled task checkboxes. **편집** switches to the
lossless Markdown source editor; **미리보기** previews the current draft without
saving or changing its source. New notes start in the editor. Plain legacy
Markdown can be previewed read-only; HTML, Djot, queries, and invalid or
unsupported documents retain their source fallback. **문서 정보 → 파일 원문**
still exposes the exact downloaded file, including its envelope.

Raw Markdown HTML remains inert, visible source text. Link labels and image
attachment labels remain readable without navigation or resource loading.
The viewer reports unresolved links and assets from the PC inventory.
Attachment download, link navigation, HTML preview, and a standalone local
mobile vault remain future work. This client does not claim the complete PDC
Full Reader role independently of the PC implementation.

## Mobile navigation and connection status

The library heading keeps **새 메모** at the top right, beside Settings. Search,
the note/draft selector and folder selector scroll with the list. There is no
bottom tab bar or persistent sync footer. **설정 → PC 연결** owns pairing and
manual synchronization; Settings and Connection return through a back stack.
Reading and source editing share exact source snapshots. Saving keeps the note
open, and a session-only native key mapping follows a newly synchronized draft
without matching titles or body text. Normal sync stays quiet; errors remain
visible. iPhone type scales from the system body size, with 44px touch targets.
Input fields keep a minimum 16px font at small system sizes to avoid iOS focus
zoom. Reading scrolls the document; writing scrolls the bounded textarea beneath
the fixed header and reveals appended lines inside that textarea.

Saved credentials are labeled as saved connection information until an actual
sync finishes. A failed request shows **PC 연결 확인 필요**, even when an older
successful timestamp exists. Per-document errors remain visible after a
successful network exchange. Manual address/token setup now immediately
attempts synchronization using **연결하고 확인**. Changing the PC address
requires the new PC's token; an old token is never implicitly reused for a
different endpoint. **PC에서 먼저 준비할 것** explains the server, Tailscale,
default HTTPS endpoint and pairing-code prerequisites.

The October 18 redesign and verification record is in
[`MOBILE-REDESIGN-2026-10-18.md`](MOBILE-REDESIGN-2026-10-18.md).

## Develop and build

Follow the [Tauri mobile prerequisites](https://v2.tauri.app/start/prerequisites/)
for Xcode or Android SDK/NDK installation. The mobile library has its own
`staticlib`, `cdylib`, and `rlib` entry points and no desktop capture/tray
plugins.

```sh
cd apps/mobile
bun install
bun run ios:init
bun run ios:dev
# Unsigned Apple Silicon simulator build:
bun run tauri ios build --debug --target aarch64-sim --no-sign --ci

# With Android SDK/NDK configured:
bun run android:init
bun run android:dev
```

Generated platform projects are ignored under `src-tauri/gen`; regenerate
with `ios:init` / `android:init`. Physical iPhone distribution requires the
owner's Apple signing configuration. Android release distribution requires
its own signing configuration. No App Store or Play Store upload is performed
by these commands.

## Verify

```sh
cargo test -p oximemo-sync
cargo test -p oximemo-cli mobile_server
cargo test -p oximemo-core template
cargo test -p oximemo-core pdc
cargo test -p oxi-frontmatter
cargo clippy -p oximemo-sync -p oximemo-cli -p oximemo-mobile --all-targets -- -D warnings
cargo build -p oximemo-cli
python3 scripts/test-mobile-sync.py
cd apps/mobile && bun test tests && bun run build
```

The HTTP smoke test uses a disposable vault and token on loopback, verifies
actual bearer authentication, guarded writes, receipts, read-only legacy
handling, and containment, then stops the test server. It does not change the
user's vault or Tailscale configuration.

Validation on 2026-10-12: frontend build, native Rust check/lint, client
state/pairing tests, server unit tests, the loopback HTTP smoke test, existing
PDC corpora, and an unsigned Apple Silicon iOS simulator build passed. The
iOS app was installed and launched in the simulator and its initial screen
was inspected. Android initialization could not run because this host has no
Android SDK/NDK. Real-device signing, actual camera scans, and tailnet
connectivity have not been verified here. The QR scanner uses Tauri's official
barcode-scanner plugin pinned to 2.4.3 (compatible with the repository's Rust
minimum), with mobile-only permissions. The persistent `Info.ios.plist`
declares camera use for connection QR scans. Code parsing, expiry, single-use
redemption, retry, regeneration, private QR page generation, and authentication
are covered by unit and HTTP integration tests.

## Current physical connection

On 2026-10-18, authenticated tailnet pairing, iPhone-to-PC creation, guarded
PC-to-iPhone update of the same stable document, and opening an existing PC note
all passed on the real iPhone14. See `MOBILE-SYNC-2026-10-18.md` for evidence and
limits. This supersedes the earlier real-device validation limit above.

The owner's PC now runs `com.oximemo.mobile-sync` as a per-user LaunchAgent. Its
stable executable and private token live below `~/.oxi/oximemo/`; launch logs are
in `~/.oxi/oximemo/mobile-sync/`. Inspect with
`launchctl print gui/$(id -u)/com.oximemo.mobile-sync`. The server binds loopback
9843; Tailscale Serve handles authenticated, tailnet-only HTTPS access. Keep
other Serve routes intact. Token files and generated pairing codes stay private.

The next mobile build adds application-owned edge navigation and a dedicated
search mode. WKWebView's native gesture list is deliberately not used for SPA
routing: its forward behavior was inconsistent in iOS 27 simulator tests.
Buttons, browser history and both edge gestures share the same route history and
unsaved-edit guard. Routes retain identifiers, query/filter and list position;
they never serialize document bodies or drafts into browser history.
