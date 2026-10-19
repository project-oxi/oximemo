# Daemon protocol

Garden daemons speak `garden-daemon/1` over a Unix domain socket. A client sends one UTF-8 JSON object followed by `\n`, then reads one JSON response followed by `\n`. Each connection carries one request. The default maximum frame is 1 MiB (configurable up to 8 MiB); sockets are created with mode `0600`.

```json
{"id":"boot-1","method":"handshake","params":{}}
```

Success responses are `{ "id": "…", "ok": true, "result": … }`. Failures are `{ "id": "…", "ok": false, "error": { "code": "…", "message": "…" } }`. Invalid JSON uses a null response id. Method names are stable identifiers; parameters and results are objects.

`handshake` returns `protocol`, `name`, `version`, `pid`, `startedAt`, `runtime`, and `capabilities`. `startedAt` is Unix epoch milliseconds. `runtime` is `{ "name": "bun", "version": "…" }`. `health` returns `status`, `pid`, `startedAt`, `uptimeMs`, and `queue`; `queue` contains integer `queued` and `leased` counts plus boolean `draining`.

The built-in queue methods are `queue.enqueue`, `queue.claim`, `queue.heartbeat`, `queue.report`, and `queue.list`. Application methods can use their own names and are registered by the service. The Rust desktop supervisor only needs `handshake` and `health`; it may forward application method calls without interpreting their payloads.

The protocol deliberately has no authentication field. Local access is limited by the socket's owner-only filesystem mode. It has no streaming, batching, or multi-request connections in v1.
