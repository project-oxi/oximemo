# Garden service

This Bun service template uses the vendored `@garden/daemon-kit` package. A generated service owns one SQLite writer and exposes a local Unix socket using `garden-daemon/1`.

```sh
bun install
bun run build
bun run start
```

`GARDEN_DATA_DIR` selects the default database and socket directory. `GARDEN_DATABASE_PATH` and `GARDEN_SOCKET_PATH` can override them independently. The example registers `app.echo`; replace it with application RPC handlers. Built-in handshake, health, and queue methods are documented in `contracts/daemon-protocol/README.md` and copied alongside the vendored contracts.

This app adopts `garden-personal/1` and the daemon contract. See [the complete framework standard](vendor/garden/contracts/framework/README.md) for stack and exception rules. UI/document rules apply only when those capabilities are adopted.
