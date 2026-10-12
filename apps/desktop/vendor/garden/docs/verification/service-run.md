# Service template verification

Observed on 2026-09-27 with Node 24.20.0 and Bun 1.4.2. A fresh service project was generated at `.verification/v0-service` from the final Garden 0.1.0 source snapshot, including the final Markdown query-capability changes.

The project installed its pinned TypeScript and Bun types and built successfully with `tsc --noEmit`. Its targeted daemon-kit suite passed all 10 tests with 46 assertions, and `garden doctor` reported healthy. These commands record the setup and runtime check from the repository root:

```sh
node cli/garden.mjs new service .verification/v0-service
cd .verification/v0-service
bun install
bun run build
bun test vendor/garden/packages/daemon-kit/tests/daemon-kit.test.ts
bun run doctor
cd ../..
bun scripts/verification/service-e2e.ts .verification/v0-service templates/desktop/src-tauri/target/debug/garden-desktop-app
```

The E2E driver starts the generated `bun run start` as a separate process. It stores SQLite data and the writer lock under `.verification/v0-service/.verification/runtime`; its Unix socket uses a per-run path under `/tmp`. The daemon answered `handshake` with protocol `garden-daemon/1` and runtime Bun 1.4.2, and answered `health` with an empty queue. The generated `app.echo` handler returned its input.

Queue RPCs made a real persisted transition. `queue.enqueue` created an item in `queued`; `queue.list` observed it as `queued`, then `leased` after `queue.claim`, and `succeeded` after `queue.report`. `queue.heartbeat` returned `true`, a repeated report returned `idempotent`, and the final health counts were zero queued and zero leased.

While that same socket was live, the compiled Rust desktop binary at `templates/desktop/src-tauri/target/debug/garden-desktop-app` ran from the repository root with `GARDEN_DAEMON_SOCKET` set to the active socket and `--daemon-probe`. It exited 0 and printed health with `status: ok`, `queued: 0`, `leased: 0`, and `draining: false`. The socket had mode `0600`; after SIGTERM, the Bun service exited 0 and removed it.

The doctor pin check temporarily changed the generated project's `garden.json` version from `0.1.0` to `9.9.9`. Doctor exited 1 with `Unsupported framework version` and `Invalid managed lock metadata`. The original manifest bytes were restored in a `finally` block; the subsequent doctor run exited 0 with `garden doctor: healthy`.

The default sandbox denied Bun's temporary-file write and Unix socket bind with `EPERM`. The public dependency install and live socket runs completed with local execution access enabled. The live E2E covers the normal success path, report idempotency, the Rust supervisor probe, and graceful shutdown. The targeted daemon-kit suite also covers expired leases, boot reconciliation, and unclean shutdown state; this run does not inject a retryable failed report or a process crash.
