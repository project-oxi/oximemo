import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const project = resolve(process.argv[2] ?? ".verification/service-final");
const nativeProbePath = resolve(process.argv[3] ?? "templates/desktop/src-tauri/target/debug/garden-desktop-app");
const runtimeDir = resolve(project, ".verification/runtime");
mkdirSync(runtimeDir, { recursive: true });
const socketPath = `/tmp/garden-service-e2e-${process.pid}.sock`;
const databasePath = join(runtimeDir, "service.sqlite");
const itemId = `service-e2e-item-${process.pid}`;
const child = spawn("bun", ["run", "start"], {
  cwd: project,
  env: {
    ...process.env,
    GARDEN_DATA_DIR: runtimeDir,
    GARDEN_SOCKET_PATH: socketPath,
    GARDEN_DATABASE_PATH: databasePath,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });

const request = <T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
  new Promise<T>((resolveResult, rejectResult) => {
    const id = `verify-${method}-${Math.random().toString(16).slice(2)}`;
    const socket = createConnection(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      rejectResult(new Error(`${method} timed out`));
    }, 5_000);
    socket.once("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      socket.destroy();
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        assert.equal(response.id, id);
        if (!response.ok) rejectResult(new Error(`${response.error.code}: ${response.error.message}`));
        else resolveResult(response.result as T);
      } catch (error) {
        rejectResult(error);
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      rejectResult(error);
    });
  });

const waitForExit = async (timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null } | null> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(null), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
};

try {
  let handshake: { protocol: string; name: string; runtime: { name: string }; capabilities: string[] } | undefined;
  let startError: unknown;
  for (let attempt = 0; attempt < 100 && !handshake; attempt += 1) {
    try {
      handshake = await request<typeof handshake>("handshake");
    } catch (error) {
      startError = error;
      await delay(50);
    }
    if (child.exitCode !== null) break;
  }
  if (!handshake) throw new Error(`service did not start: ${String(startError)}\nstdout=${stdout}\nstderr=${stderr}`);

  assert.equal(handshake.protocol, "garden-daemon/1");
  assert.equal(handshake.name, "garden-service");
  assert.equal(handshake.runtime.name, "bun");
  assert.ok(handshake.capabilities.includes("queue.claim"));
  const healthBefore = await request<{ status: string; queue: unknown }>("health");
  assert.equal(healthBefore.status, "ok");
  const echo = await request<{ echoed: string }>("app.echo", { message: "verification" });
  assert.deepEqual(echo, { echoed: "verification" });

  const enqueued = await request<{ created: boolean; item: { id: string; status: string } }>("queue.enqueue", {
    id: itemId,
    payload: { work: "verify transition" },
  });
  assert.equal(enqueued.created, true);
  assert.equal(enqueued.item.status, "queued");
  const listedQueued = await request<Array<{ id: string; status: string }>>("queue.list", { statuses: ["queued"] });
  assert.equal(listedQueued.find((item) => item.id === itemId)?.status, "queued");

  const lease = await request<{ leaseId: string; itemId: string }>("queue.claim", {
    runnerId: "verification-runner",
    requestId: `service-e2e-claim-${process.pid}`,
    leaseMs: 10_000,
  });
  assert.equal(lease.itemId, itemId);
  const listedLeased = await request<Array<{ id: string; status: string }>>("queue.list", { statuses: ["leased"] });
  assert.equal(listedLeased.find((item) => item.id === itemId)?.status, "leased");
  const heartbeat = await request<boolean>("queue.heartbeat", { leaseId: lease.leaseId, leaseMs: 10_000 });
  assert.equal(heartbeat, true);

  const report = await request<{ status: string; outcome: string; itemId: string }>("queue.report", {
    leaseId: lease.leaseId,
    ok: true,
    result: { completed: true },
  });
  assert.deepEqual(report, { status: "succeeded", outcome: "applied", itemId });
  const repeatedReport = await request<{ outcome: string }>("queue.report", {
    leaseId: lease.leaseId,
    ok: true,
    result: { completed: true },
  });
  assert.equal(repeatedReport.outcome, "idempotent");
  const listedSucceeded = await request<Array<{ id: string; status: string }>>("queue.list", { statuses: ["succeeded"] });
  assert.equal(listedSucceeded.find((item) => item.id === itemId)?.status, "succeeded");
  const healthAfter = await request<{ queue: { queued: number; leased: number; draining: boolean } }>("health");
  assert.deepEqual(healthAfter.queue, { queued: 0, leased: 0, draining: false });

  const nativeProbe = spawnSync(nativeProbePath, ["--daemon-probe"], {
    cwd: process.cwd(),
    env: { ...process.env, GARDEN_DAEMON_SOCKET: socketPath },
    encoding: "utf8",
  });
  if (nativeProbe.error) throw nativeProbe.error;
  assert.equal(nativeProbe.status, 0, nativeProbe.stderr);
  const nativeHealth = JSON.parse(nativeProbe.stdout.trim());
  assert.equal(nativeHealth.status, "ok");
  assert.deepEqual(nativeHealth.queue, { queued: 0, leased: 0, draining: false });

  const socketMode = (statSync(socketPath).mode & 0o777).toString(8);
  assert.equal(socketMode, "600");
  child.kill("SIGTERM");
  const exit = await waitForExit(8_000);
  if (!exit) {
    child.kill("SIGKILL");
    throw new Error("service did not stop after SIGTERM");
  }
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.equal(existsSync(socketPath), false);

  console.log(JSON.stringify({
    handshake: { protocol: handshake.protocol, name: handshake.name, runtime: handshake.runtime },
    healthBefore: healthBefore.queue,
    echo,
    enqueue: { created: enqueued.created, status: enqueued.item.status },
    queueStates: {
      queued: listedQueued.find((item) => item.id === itemId)?.status,
      leased: listedLeased.find((item) => item.id === itemId)?.status,
      succeeded: listedSucceeded.find((item) => item.id === itemId)?.status,
    },
    heartbeat,
    report,
    repeatedReport: repeatedReport.outcome,
    healthAfter: healthAfter.queue,
    nativeProbe: { binary: nativeProbePath, status: nativeProbe.status, health: nativeHealth, stderr: nativeProbe.stderr.trim() },
    socketMode,
    exit,
    socketRemoved: !existsSync(socketPath),
    databasePath,
    stdout: stdout.trim().split("\n"),
    stderr: stderr.trim(),
  }, null, 2));
} catch (error) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    if (!await waitForExit(3_000)) child.kill("SIGKILL");
  }
  console.error(error instanceof Error ? error.stack : String(error));
  console.error(`stdout=${stdout}`);
  console.error(`stderr=${stderr}`);
  process.exitCode = 1;
}
