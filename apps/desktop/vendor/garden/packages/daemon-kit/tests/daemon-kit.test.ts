import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import {
  beginShutdown,
  bootReconcile,
  claim,
  enqueue,
  finishShutdown,
  heartbeat,
  healDecision,
  listQueue,
  openDaemonDb,
  report,
  setDrain,
  startDaemon,
} from "../src/index.ts";
import { requestDaemon } from "../src/server.ts";

const tempDirs: string[] = [];
const tempDir = (): string => {
  const root = resolve(import.meta.dir, "../../../.build/daemon-kit-tests");
  mkdirSync(root, { recursive: true });
  const path = mkdtempSync(join(root, "run-"));
  tempDirs.push(path);
  return path;
};

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("heal policy", () => {
  test("protects the boot window and applies a cooldown only to stale live processes", () => {
    expect(healDecision(null, 7, null, 50_000)).toEqual({ action: "notify", pid: 7, reason: "heartbeat_missing" });
    expect(healDecision(2_000, 7, null, 50_000, 10_000)).toEqual({ action: "ok", pid: 7, reason: "fresh" });
    expect(healDecision(11_000, null, null, 50_000, 10_000).reason).toBe("process_missing");
    expect(healDecision(11_000, 7, 45_000, 50_000, 10_000, 10_000).action).toBe("notify");
    expect(healDecision(11_000, 7, 39_000, 50_000, 10_000, 10_000).action).toBe("heal");
  });
});

describe("SQLite queue", () => {
  test("claim and report retries are idempotent, and boot requeues a live lease without adding an attempt", () => {
    const db = openDaemonDb(":memory:");
    try {
      enqueue(db, { id: "doc-1", payload: { title: "one" } }, { now: () => 100_000 });
      const first = claim(db, { runnerId: "worker-1", requestId: "request-1", leaseMs: 5_000 }, { now: () => 100_000 });
      expect(first).not.toBeNull();
      expect(claim(db, { runnerId: "worker-1", requestId: "request-1" }, { now: () => 101_000 })).toEqual(first);
      expect(report(db, first!.leaseId, { ok: true, result: { saved: true } }, { now: () => 102_000 }))
        .toEqual({ status: "succeeded", outcome: "applied", itemId: "doc-1" });
      expect(report(db, first!.leaseId, { ok: true, result: { saved: true } }, { now: () => 103_000 }))
        .toEqual({ status: "succeeded", outcome: "idempotent", itemId: "doc-1" });

      enqueue(db, { id: "doc-2", payload: "pending" }, { now: () => 110_000 });
      const second = claim(db, { runnerId: "worker-1", requestId: "request-2" }, { now: () => 110_000 });
      expect(second?.attempt).toBe(1);
      const reconciled = bootReconcile(db, 120_000);
      expect(reconciled.reconciled).toEqual(["doc-2"]);
      expect(listQueue(db).find((item) => item.id === "doc-2")).toMatchObject({ status: "queued", attempt: 1 });
      expect(report(db, second!.leaseId, { ok: true }, { now: () => 121_000 }).outcome).toBe("superseded");
    } finally {
      db.close();
    }
  });

  test("expired leases cannot be extended or reported after the deadline", () => {
    const db = openDaemonDb(":memory:");
    try {
      enqueue(db, { id: "heartbeat-expired", payload: 1 }, { now: () => 100_000 });
      const expiredHeartbeatLease = claim(db, { runnerId: "runner", requestId: "expired-heartbeat", leaseMs: 1_000 }, { now: () => 100_000 })!;
      expect(heartbeat(db, expiredHeartbeatLease.leaseId, { leaseMs: 5_000, now: () => 101_000 })).toBe(false);
      expect(listQueue(db).find((item) => item.id === "heartbeat-expired")?.status).toBe("queued");
      const resumedLease = claim(db, { runnerId: "runner", requestId: "resume-heartbeat", leaseMs: 1_000 }, { now: () => 101_001 })!;
      expect(report(db, resumedLease.leaseId, { ok: true }, { now: () => 101_002 }).status).toBe("succeeded");

      enqueue(db, { id: "report-expired", payload: 2 }, { now: () => 103_000 });
      const expiredReportLease = claim(db, { runnerId: "runner", requestId: "expired-report", leaseMs: 1_000 }, { now: () => 103_000 })!;
      expect(report(db, expiredReportLease.leaseId, { ok: true }, { now: () => 104_000 }))
        .toEqual({ status: "queued", outcome: "superseded", itemId: "report-expired" });
      expect(listQueue(db).find((item) => item.id === "report-expired")?.status).toBe("queued");
    } finally {
      db.close();
    }
  });

  test("rolls back a state transition if the outbox insert fails", () => {
    const db = openDaemonDb(":memory:");
    try {
      db.exec(`CREATE TRIGGER reject_outbox BEFORE INSERT ON garden_outbox
        BEGIN SELECT RAISE(ABORT, 'simulated outbox failure'); END`);
      expect(() => enqueue(db, { id: "atomic", payload: null }, { now: () => 1_000 })).toThrow("simulated outbox failure");
      expect(db.query("SELECT COUNT(*) AS count FROM garden_queue").get()).toEqual({ count: 0 });
      expect(db.query("SELECT COUNT(*) AS count FROM garden_audit").get()).toEqual({ count: 0 });

      db.exec("DROP TRIGGER reject_outbox");
      enqueue(db, { id: "atomic-report", payload: null }, { now: () => 2_000 });
      const lease = claim(db, { runnerId: "writer", requestId: "atomic-claim" }, { now: () => 2_000 })!;
      db.exec(`CREATE TRIGGER reject_outbox BEFORE INSERT ON garden_outbox
        BEGIN SELECT RAISE(ABORT, 'simulated outbox failure'); END`);
      const auditCount = db.query("SELECT COUNT(*) AS count FROM garden_audit").get();
      expect(() => report(db, lease.leaseId, { ok: true, result: "done" }, { now: () => 2_001 }))
        .toThrow("simulated outbox failure");
      expect(listQueue(db).find((item) => item.id === "atomic-report")?.status).toBe("leased");
      expect(db.query("SELECT COUNT(*) AS count FROM garden_audit").get()).toEqual(auditCount);
    } finally {
      db.close();
    }
  });

  test("preserves drain after an unclean stop and restores it only after a clean receipt", () => {
    const db = openDaemonDb(":memory:");
    try {
      const cleanId = beginShutdown(db, 10_000, 12);
      finishShutdown(db, cleanId, "completed", 10_100);
      expect(bootReconcile(db, 10_200).shutdown).toBe("restored");

      setDrain(db, true, "test", 11_000);
      const uncleanId = beginShutdown(db, 11_100, 12);
      expect(uncleanId).toBeTruthy();
      expect(bootReconcile(db, 11_200).shutdown).toBe("unclean");
      expect(db.query("SELECT value FROM garden_meta WHERE key='garden:drain'").get()).toEqual({ value: "1" });
    } finally {
      db.close();
    }
  });
});

describe("daemon process", () => {
  test("enforces one writer per SQLite file even with different socket paths", async () => {
    const dir = tempDir();
    const first = await startDaemon({ name: "one", version: "1", socketPath: join(dir, "one.sock"), databasePath: join(dir, "shared.sqlite") });
    try {
      await expect(startDaemon({ name: "two", version: "1", socketPath: join(dir, "two.sock"), databasePath: join(dir, "shared.sqlite") }))
        .rejects.toThrow("already has a live writer");
    } finally {
      await first.close();
    }
  });

  test("serializes recovery of a stale writer lock", async () => {
    const dir = tempDir();
    const databasePath = join(dir, "stale.sqlite");
    writeFileSync(`${databasePath}.writer.lock`, JSON.stringify({ pid: 999_999_999, token: "dead-owner" }));
    const starts = await Promise.allSettled([
      startDaemon({ name: "one", version: "1", socketPath: join(dir, "one.sock"), databasePath }),
      startDaemon({ name: "two", version: "1", socketPath: join(dir, "two.sock"), databasePath }),
    ]);
    const running = starts.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof startDaemon>>> => item.status === "fulfilled");
    expect(running).toHaveLength(1);
    const rejected = starts.find((item): item is PromiseRejectedResult => item.status === "rejected");
    expect(rejected).toBeDefined();
    await running[0]!.value.close();
  });

  test("drains accepted leases while preserving report access, then times out with drain still set", async () => {
    const dir = tempDir();
    const databasePath = join(dir, "drain.sqlite");
    const daemon = await startDaemon({ name: "drain-test", version: "1", socketPath: join(dir, "drain.sock"), databasePath });
    await requestDaemon(daemon.socketPath, "queue.enqueue", { id: "during-drain", payload: 1 });
    const lease = await requestDaemon<{ leaseId: string }>(daemon.socketPath, "queue.claim", { runnerId: "worker", requestId: "drain-claim" });
    const closing = daemon.close({ deadlineMs: 1_000 });
    await Bun.sleep(10);
    await expect(requestDaemon(daemon.socketPath, "queue.claim", { runnerId: "worker", requestId: "late-claim" }))
      .rejects.toMatchObject({ code: "draining" });
    expect(await requestDaemon(daemon.socketPath, "queue.report", { leaseId: lease.leaseId, ok: true })).toMatchObject({ status: "succeeded" });
    await closing;

    const timeoutDaemon = await startDaemon({ name: "timeout-test", version: "1", socketPath: join(dir, "timeout.sock"), databasePath });
    await requestDaemon(timeoutDaemon.socketPath, "queue.enqueue", { id: "will-time-out", payload: 2 });
    await requestDaemon(timeoutDaemon.socketPath, "queue.claim", { runnerId: "worker", requestId: "timeout-claim" });
    await timeoutDaemon.close({ deadlineMs: 20 });
    const db = openDaemonDb(databasePath);
    try {
      expect(bootReconcile(db).shutdown).toBe("unclean");
      expect(listQueue(db).find((item) => item.id === "will-time-out")?.status).toBe("queued");
      expect(db.query("SELECT value FROM garden_meta WHERE key='garden:drain'").get()).toEqual({ value: "1" });
    } finally {
      db.close();
    }
  });

  test("runs the service template over its real Unix socket and finishes reports through RPC", async () => {
    const dir = tempDir();
    const templateEntry = resolve(import.meta.dir, "../../../templates/service/src/index.ts");
    const fixture = tempDir();
    const fixtureEntry = join(fixture, "src", "index.ts");
    mkdirSync(join(fixture, "src"), { recursive: true });
    copyFileSync(templateEntry, fixtureEntry);
    mkdirSync(join(fixture, "node_modules", "@garden"), { recursive: true });
    symlinkSync(resolve(import.meta.dir, ".."), join(fixture, "node_modules", "@garden", "daemon-kit"), "dir");
    const child = Bun.spawn([process.execPath, "run", fixtureEntry], {
      cwd: fixture,
      env: {
        ...process.env,
        GARDEN_DATA_DIR: dir,
        GARDEN_SOCKET_PATH: join(dir, "service.sock"),
        GARDEN_DATABASE_PATH: join(dir, "service.sqlite"),
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    const socketPath = join(dir, "service.sock");
    try {
      let handshake: { protocol: string; name: string; runtime: { name: string }; capabilities: string[] } | undefined;
      let lastError: unknown;
      for (let attempt = 0; attempt < 100 && !handshake; attempt += 1) {
        try {
          handshake = await requestDaemon<typeof handshake>(socketPath, "handshake");
        } catch (error) {
          lastError = error;
          await Bun.sleep(50);
        }
      }
      if (!handshake) {
        const stderr = await new Response(child.stderr).text();
        throw new Error(`service template failed to start: ${String(lastError)}\n${stderr}`);
      }
      expect(handshake).toMatchObject({ protocol: "garden-daemon/1", name: "garden-service", runtime: { name: "bun" } });
      expect(handshake.capabilities).toContain("queue.claim");
      expect(handshake.capabilities).toContain("app.echo");
      const echo = await requestDaemon<{ echoed: string }>(socketPath, "app.echo", { message: "hello" });
      expect(echo).toEqual({ echoed: "hello" });
      await requestDaemon(socketPath, "queue.enqueue", { id: "rpc-item", payload: { work: 1 } });
      const lease = await requestDaemon<{ leaseId: string; itemId: string }>(socketPath, "queue.claim", { runnerId: "rust-supervisor", requestId: "claim-1" });
      expect(lease.itemId).toBe("rpc-item");
      const repeatedLease = await requestDaemon<{ leaseId: string; itemId: string }>(socketPath, "queue.claim", { runnerId: "rust-supervisor", requestId: "claim-1" });
      expect(repeatedLease).toEqual(lease);
      expect(await requestDaemon(socketPath, "queue.report", { leaseId: lease.leaseId, ok: true, result: "done" }))
        .toMatchObject({ status: "succeeded", outcome: "applied" });
      expect(await requestDaemon(socketPath, "queue.report", { leaseId: lease.leaseId, ok: true, result: "done" }))
        .toMatchObject({ status: "succeeded", outcome: "idempotent" });
      expect(await requestDaemon(socketPath, "health")).toMatchObject({ status: "ok", queue: { queued: 0, leased: 0, draining: false } });
    } finally {
      child.kill("SIGTERM");
      await Promise.race([child.exited, Bun.sleep(7_000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }, 15_000);

  test("client decodes a multibyte character split across socket chunks", async () => {
    const dir = tempDir();
    const socketPath = join(dir, "split.sock");
    const fakeServer = createServer((socket) => {
      socket.once("data", (data) => {
        const request = JSON.parse(data.toString("utf8")) as { id: string };
        const response = Buffer.from(JSON.stringify({ id: request.id, ok: true, result: "한국어 🌱" }) + "\n");
        const split = response.indexOf(Buffer.from("한")) + 1;
        socket.write(response.subarray(0, split));
        setTimeout(() => socket.end(response.subarray(split)), 5);
      });
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      fakeServer.once("error", rejectListen);
      fakeServer.listen(socketPath, resolveListen);
    });
    try {
      const response = await requestDaemon<string>(socketPath, "test.split");
      expect(response).toBe("한국어 🌱");
    } finally {
      await new Promise<void>((resolveClose) => fakeServer.close(() => resolveClose()));
    }
  });
});
