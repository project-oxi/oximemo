import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import type { Database } from "bun:sqlite";
import {
  beginShutdown,
  bootReconcile,
  claim,
  enqueue,
  finishShutdown,
  heartbeat,
  listQueue,
  openDaemonDb,
  QueueDrainingError,
  queueHealth,
  reclaimExpiredLeases,
  report,
  type QueueOptions,
  type QueueStatus,
} from "./queue.ts";
import protocolContract from "../../../contracts/daemon-protocol/protocol.schema.json";

const PROTOCOL_VERSION = protocolContract.$defs.handshake.properties.protocol.const as "garden-daemon/1";

export interface RpcContext {
  db: Database;
  requestId: string;
  daemon: { name: string; version: string; pid: number; startedAt: number };
}

export type RpcHandler = (params: Record<string, unknown>, context: RpcContext) => unknown | Promise<unknown>;

export interface DaemonOptions {
  name: string;
  version: string;
  socketPath: string;
  databasePath: string;
  maxFrameBytes?: number;
  requestTimeoutMs?: number;
  shutdownDeadlineMs?: number;
  queue?: QueueOptions;
  handlers?: Record<string, RpcHandler>;
}

export interface DaemonServer {
  socketPath: string;
  databasePath: string;
  db: Database;
  protocol: "garden-daemon/1";
  ready: { name: string; version: string; pid: number; startedAt: number };
  close(options?: { deadlineMs?: number }): Promise<void>;
}

interface RequestFrame {
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

interface SuccessFrame {
  id: string;
  ok: true;
  result: unknown;
}

interface ErrorFrame {
  id: string | null;
  ok: false;
  error: { code: string; message: string };
}

type ResponseFrame = SuccessFrame | ErrorFrame;

const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_DEADLINE_MS = 5_000;

function errorCode(error: unknown): string {
  if (error instanceof QueueDrainingError) return error.code;
  if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code;
  return "internal";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function paramsObject(params: unknown): Record<string, unknown> {
  if (params === undefined) return {};
  if (params === null || typeof params !== "object" || Array.isArray(params)) throw Object.assign(new Error("params must be an object"), { code: "bad_request" });
  return params as Record<string, unknown>;
}

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) throw Object.assign(new Error(`${key} is required`), { code: "bad_request" });
  return value;
}

function optionalInteger(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value)) throw Object.assign(new Error(`${key} must be an integer`), { code: "bad_request" });
  return value as number;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface WriterLock {
  path: string;
  fd: number;
  token: string;
}

function acquireWriterLock(path: string): WriterLock {
  const token = randomUUID();
  const body = JSON.stringify({ pid: process.pid, token, startedAt: Date.now() });
  const create = (): WriterLock => {
    const fd = openSync(path, "wx", 0o600);
    writeSync(fd, body);
    return { path, fd, token };
  };
  try {
    return create();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const readOwner = (): { pid?: unknown; token?: unknown } => {
    try {
      const existing = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; token?: unknown };
      if (!Number.isSafeInteger(existing.pid) || (existing.pid as number) <= 0 || typeof existing.token !== "string") {
        throw new Error(`daemon writer lock ${path} has an invalid owner record; refusing unsafe takeover`);
      }
      return existing;
    } catch (error) {
      if (error instanceof Error && error.message.includes("invalid owner")) throw error;
      throw new Error(`daemon writer lock ${path} exists but is unreadable; refusing unsafe takeover`);
    }
  };

  const existing = readOwner();
  if (alive(existing.pid as number)) throw new Error(`daemon database already has a live writer (pid ${existing.pid})`);

  // Serialize stale-owner recovery. Without this separate exclusive gate, two
  // starters can both observe the dead pid and unlink each other's new lock.
  const recoveryPath = `${path}.recovery`;
  const recoveryToken = randomUUID();
  let recoveryFd: number;
  try {
    recoveryFd = openSync(recoveryPath, "wx", 0o600);
    writeSync(recoveryFd, JSON.stringify({ pid: process.pid, token: recoveryToken }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`daemon lock recovery is already in progress or abandoned at ${recoveryPath}; inspect the recorded pid before removing it`);
    }
    throw error;
  }
  try {
    const current = readOwner();
    if (current.token !== existing.token || alive(current.pid as number)) {
      throw new Error(`daemon writer lock ${path} changed during stale-owner recovery; retry startup`);
    }
    unlinkSync(path);
    try {
      return create();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`a writer acquired ${path} during stale-owner recovery; retry startup`);
      throw error;
    }
  } finally {
    try {
      const recovery = JSON.parse(readFileSync(recoveryPath, "utf8")) as { token?: unknown };
      closeSync(recoveryFd);
      if (recovery.token === recoveryToken) unlinkSync(recoveryPath);
    } catch {
      try { closeSync(recoveryFd); } catch { /* already closed */ }
    }
  }
}

function releaseWriterLock(lock: WriterLock): void {
  try {
    const body = JSON.parse(readFileSync(lock.path, "utf8")) as { token?: unknown };
    closeSync(lock.fd);
    if (body.token === lock.token) unlinkSync(lock.path);
  } catch {
    try { closeSync(lock.fd); } catch { /* already closed */ }
  }
}

async function removeStaleSocket(path: string): Promise<void> {
  if (!existsSync(path)) return;
  if (!statSync(path).isSocket()) throw new Error(`socket path exists and is not a Unix socket: ${path}`);
  const inUse = await new Promise<boolean>((resolveProbe, rejectProbe) => {
    const socket = createConnection(path);
    let settled = false;
    const finish = (value: boolean, error?: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) rejectProbe(error);
      else resolveProbe(value);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") finish(false);
      else finish(false, error);
    });
  });
  if (inUse) throw new Error(`socket path is already served by a live process: ${path}`);
  unlinkSync(path);
}

function sendFrame(socket: Socket, frame: ResponseFrame): void {
  if (!socket.destroyed) socket.end(`${JSON.stringify(frame)}\n`);
}

function isStatus(value: unknown): value is QueueStatus {
  return value === "queued" || value === "leased" || value === "succeeded" || value === "failed";
}

function builtInHandlers(
  options: DaemonOptions,
  db: Database,
  ready: DaemonServer["ready"],
  isClosing: () => boolean,
  capabilities: () => string[],
): Record<string, RpcHandler> {
  const queueOptions = options.queue;
  return {
    handshake: () => ({
      protocol: PROTOCOL_VERSION,
      name: ready.name,
      version: ready.version,
      pid: ready.pid,
      startedAt: ready.startedAt,
      runtime: { name: "bun", version: Bun.version },
      capabilities: capabilities(),
    }),
    health: () => ({
      status: isClosing() || queueHealth(db).draining ? "draining" : "ok",
      pid: ready.pid,
      startedAt: ready.startedAt,
      uptimeMs: Math.max(0, Date.now() - ready.startedAt),
      queue: queueHealth(db),
    }),
    "queue.enqueue": (params, context) => enqueue(db, {
      ...(params.id === undefined ? {} : { id: requiredString(params, "id") }),
      payload: params.payload,
      ...(params.priority === undefined ? {} : { priority: optionalInteger(params, "priority") }),
      ...(params.availableAt === undefined ? {} : { availableAt: optionalInteger(params, "availableAt") }),
    }, queueOptions),
    "queue.claim": (params) => claim(db, {
      runnerId: requiredString(params, "runnerId"),
      requestId: requiredString(params, "requestId"),
      ...(params.leaseMs === undefined ? {} : { leaseMs: optionalInteger(params, "leaseMs") }),
    }, queueOptions),
    "queue.heartbeat": (params) => heartbeat(db, requiredString(params, "leaseId"), {
      ...queueOptions,
      ...(params.leaseMs === undefined ? {} : { leaseMs: optionalInteger(params, "leaseMs") }),
    }),
    "queue.report": (params) => {
      if (typeof params.ok !== "boolean") throw Object.assign(new Error("ok must be boolean"), { code: "bad_request" });
      return report(db, requiredString(params, "leaseId"), {
        ok: params.ok,
        ...(params.result === undefined ? {} : { result: params.result }),
        ...(params.error === undefined ? {} : { error: params.error as string }),
        ...(params.retryable === undefined ? {} : { retryable: params.retryable as boolean }),
      }, queueOptions);
    },
    "queue.list": (params) => {
      let statuses: QueueStatus[] | undefined;
      if (params.statuses !== undefined) {
        if (!Array.isArray(params.statuses) || !params.statuses.every(isStatus)) {
          throw Object.assign(new Error("statuses must contain queue status values"), { code: "bad_request" });
        }
        statuses = params.statuses;
      }
      return listQueue(db, statuses);
    },
  };
}

async function handleLine(
  line: string,
  handlers: Record<string, RpcHandler>,
  db: Database,
  ready: DaemonServer["ready"],
  isClosing: () => boolean,
): Promise<ResponseFrame> {
  let request: RequestFrame;
  try {
    request = JSON.parse(line) as RequestFrame;
  } catch {
    return { id: null, ok: false, error: { code: "bad_request", message: "invalid JSON request frame" } };
  }
  const id = typeof request.id === "string" && request.id.length > 0 && request.id.length <= 200 ? request.id : null;
  if (id === null) return { id: null, ok: false, error: { code: "bad_request", message: "id must contain 1..200 characters" } };
  if (typeof request.method !== "string" || request.method.length === 0 || request.method.length > 200) {
    return { id, ok: false, error: { code: "bad_request", message: "method must contain 1..200 characters" } };
  }
  if (isClosing() && !["handshake", "health", "queue.heartbeat", "queue.report"].includes(request.method)) {
    return { id, ok: false, error: { code: "draining", message: "daemon is draining and does not accept new work" } };
  }
  let params: Record<string, unknown>;
  try {
    params = paramsObject(request.params);
  } catch (error) {
    return { id, ok: false, error: { code: errorCode(error), message: errorMessage(error) } };
  }
  if (!Object.hasOwn(handlers, request.method)) return { id, ok: false, error: { code: "not_found", message: `unknown method: ${request.method}` } };
  const handler = handlers[request.method];
  if (!handler) return { id, ok: false, error: { code: "not_found", message: `unknown method: ${request.method}` } };
  try {
    const result = await handler(params, { db, requestId: id, daemon: ready });
    return { id, ok: true, result: result ?? null };
  } catch (error) {
    return { id, ok: false, error: { code: errorCode(error), message: errorMessage(error) } };
  }
}

export async function startDaemon(options: DaemonOptions): Promise<DaemonServer> {
  if (!options.name.trim() || !options.version.trim()) throw new Error("daemon name and version are required");
  if (!options.socketPath || !options.databasePath) throw new Error("socketPath and databasePath are required");
  const socketPath = resolve(options.socketPath);
  const databasePath = options.databasePath === ":memory:" ? options.databasePath : resolve(options.databasePath);
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1024 || maxFrameBytes > 8 * 1024 * 1024) throw new Error("maxFrameBytes must be in 1024..8388608");
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 120_000) throw new Error("requestTimeoutMs must be in 100..120000");

  mkdirSync(dirname(socketPath), { recursive: true });
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
  const canonicalDatabasePath = databasePath === ":memory:" ? databasePath : (() => {
    try {
      return realpathSync(databasePath);
    } catch {
      return join(realpathSync(dirname(databasePath)), basename(databasePath));
    }
  })();
  const lockPath = databasePath === ":memory:" ? `${socketPath}.writer.lock` : `${canonicalDatabasePath}.writer.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  const writerLock = acquireWriterLock(lockPath);
  let db: Database | null = null;
  let server: Server | null = null;
  try {
    db = openDaemonDb(databasePath);
    bootReconcile(db);
    await removeStaleSocket(socketPath);
    const ready = { name: options.name, version: options.version, pid: process.pid, startedAt: Date.now() };
    let closing = false;
    let capabilities: string[] = [];
    const baseHandlers = builtInHandlers(options, db, ready, () => closing, () => capabilities);
    const customHandlers = options.handlers ?? {};
    for (const reserved of Object.keys(baseHandlers)) {
      if (customHandlers[reserved]) throw new Error(`application handler cannot replace built-in method ${reserved}`);
    }
    const handlers = { ...baseHandlers, ...customHandlers };
    capabilities = Object.keys(handlers).sort();
    const sockets = new Set<Socket>();
    let activeOperations = 0;
    let afterOperation: (() => void) | null = null;
    const socketServer = createServer({ allowHalfOpen: true }, (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.setEncoding("utf8");
      socket.setTimeout(requestTimeoutMs, () => socket.destroy());
      let buffer = "";
      let handled = false;
      const processFrame = (frame: string): void => {
        if (handled) return;
        handled = true;
        if (Buffer.byteLength(frame, "utf8") > maxFrameBytes) {
          sendFrame(socket, { id: null, ok: false, error: { code: "frame_too_large", message: `request exceeds ${maxFrameBytes} bytes` } });
          return;
        }
        activeOperations += 1;
        void handleLine(frame, handlers, db!, ready, () => closing).then((response) => sendFrame(socket, response))
          .catch((error) => sendFrame(socket, { id: null, ok: false, error: { code: "internal", message: errorMessage(error) } }))
          .finally(() => {
            activeOperations -= 1;
            afterOperation?.();
          });
      };
      socket.on("data", (chunk: string) => {
        if (handled) return;
        buffer += chunk;
        if (Buffer.byteLength(buffer, "utf8") > maxFrameBytes) {
          handled = true;
          sendFrame(socket, { id: null, ok: false, error: { code: "frame_too_large", message: `request exceeds ${maxFrameBytes} bytes` } });
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline >= 0) processFrame(buffer.slice(0, newline));
      });
      socket.on("end", () => {
        if (!handled && buffer.trim()) processFrame(buffer);
      });
      socket.on("error", () => socket.destroy());
    });
    server = socketServer;
    const listening = new Promise<void>((resolveListen, rejectListen) => {
      socketServer.once("error", rejectListen);
      socketServer.listen(socketPath, resolveListen);
    });
    await listening;
    const { chmodSync } = await import("node:fs");
    chmodSync(socketPath, 0o600);

    let closePromise: Promise<void> | null = null;
    return {
      socketPath,
      databasePath,
      db,
      protocol: PROTOCOL_VERSION,
      ready,
      close: ({ deadlineMs = options.shutdownDeadlineMs ?? DEFAULT_SHUTDOWN_DEADLINE_MS } = {}) => {
        if (closePromise) return closePromise;
        if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 0 || deadlineMs > 120_000) return Promise.reject(new Error("deadlineMs must be in 0..120000"));
        closing = true;
        closePromise = (async () => {
          const shutdownId = beginShutdown(db!, Date.now(), process.pid);
          const deadline = Date.now() + deadlineMs;
          let operationsDrained = false;
          while (Date.now() < deadline) {
            reclaimExpiredLeases(db!, Date.now());
            if (activeOperations === 0 && queueHealth(db!).leased === 0) {
              operationsDrained = true;
              break;
            }
            await new Promise<void>((resolveWait) => {
              const timeout = setTimeout(() => {
                if (afterOperation === wake) afterOperation = null;
                resolveWait();
              }, Math.min(50, Math.max(1, deadline - Date.now())));
              const wake = (): void => {
                clearTimeout(timeout);
                if (afterOperation === wake) afterOperation = null;
                resolveWait();
              };
              afterOperation = wake;
            });
          }
          try { unlinkSync(socketPath); } catch { /* socket may already be gone */ }
          const serverClosed = new Promise<void>((resolveClose) => socketServer.close(() => resolveClose()));
          const remaining = Math.max(0, deadline - Date.now());
          let timer: ReturnType<typeof setTimeout> | undefined;
          const listenerTimedOut = await Promise.race([
            serverClosed.then(() => false),
            new Promise<boolean>((resolveTimeout) => { timer = setTimeout(() => resolveTimeout(true), remaining); }),
          ]);
          if (timer) clearTimeout(timer);
          const timedOut = !operationsDrained || listenerTimedOut;
          if (timedOut) {
            for (const socket of sockets) socket.destroy();
            finishShutdown(db!, shutdownId, "timed_out");
          } else {
            finishShutdown(db!, shutdownId, "completed");
          }
          const releaseResources = (): void => {
            if (activeOperations !== 0) return;
            try { db!.close(); } finally { releaseWriterLock(writerLock); }
          };
          afterOperation = releaseResources;
          releaseResources();
        })();
        return closePromise;
      },
    };
  } catch (error) {
    try { server?.close(); } catch { /* not listening */ }
    try { db?.close(); } catch { /* not open */ }
    releaseWriterLock(writerLock);
    throw error;
  }
}

export class DaemonRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export async function requestDaemon<T = unknown>(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
  options: { id?: string; timeoutMs?: number } = {},
): Promise<T> {
  const id = options.id ?? randomUUID();
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!id || id.length > 200) throw new Error("id must contain 1..200 characters");
  const frame = `${JSON.stringify({ id, method, params })}\n`;
  return new Promise<T>((resolveResponse, rejectResponse) => {
    const socket = createConnection(socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;
    const finish = (error?: Error, value?: T): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) rejectResponse(error);
      else resolveResponse(value as T);
    };
    socket.setTimeout(timeoutMs, () => finish(new Error(`daemon request timed out after ${timeoutMs}ms`)));
    socket.once("connect", () => socket.write(frame));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > DEFAULT_MAX_FRAME_BYTES) {
        finish(new Error("daemon response exceeds 1 MiB"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as ResponseFrame;
        if (response.id !== id) throw new Error("daemon response id does not match request");
        if (!response.ok) throw new DaemonRequestError(response.error.code, response.error.message);
        finish(undefined, response.result as T);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("error", (error) => finish(error));
    socket.once("end", () => {
      if (!settled) finish(new Error("daemon closed without a complete response frame"));
    });
  });
}
