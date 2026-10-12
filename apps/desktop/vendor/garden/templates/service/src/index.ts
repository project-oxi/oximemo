import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { startDaemon } from "@garden/daemon-kit";

const dataDir = resolve(process.env.GARDEN_DATA_DIR ?? join(homedir(), ".local", "share", "garden-service"));
const daemon = await startDaemon({
  name: process.env.GARDEN_DAEMON_NAME ?? "garden-service",
  version: process.env.GARDEN_DAEMON_VERSION ?? "0.1.0",
  socketPath: resolve(process.env.GARDEN_SOCKET_PATH ?? join(dataDir, "service.sock")),
  databasePath: resolve(process.env.GARDEN_DATABASE_PATH ?? join(dataDir, "service.sqlite")),
  handlers: {
    "app.echo": (params) => ({ echoed: params.message ?? null }),
  },
});

console.log(JSON.stringify({ event: "ready", ...daemon.ready, protocol: daemon.protocol, socketPath: daemon.socketPath }));

let stopping = false;
const stop = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ event: "stopping", signal }));
  try {
    await daemon.close();
    process.exitCode = 0;
  } catch (error) {
    console.error(JSON.stringify({ event: "shutdown_error", message: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
};

process.on("SIGINT", () => { void stop("SIGINT"); });
process.on("SIGTERM", () => { void stop("SIGTERM"); });
