import { createHash, randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";

export type QueueStatus = "queued" | "leased" | "succeeded" | "failed";

export interface QueueItem {
  id: string;
  payload: unknown;
  status: QueueStatus;
  priority: number;
  attempt: number;
  availableAt: number;
  createdAt: number;
  updatedAt: number;
  result?: unknown;
  error?: string;
}

export interface QueueLease {
  leaseId: string;
  itemId: string;
  runnerId: string;
  requestId: string;
  attempt: number;
  payload: unknown;
  expiresAt: number;
}

export interface QueueReport {
  ok: boolean;
  result?: unknown;
  error?: string;
  retryable?: boolean;
}

export interface QueueReportResult {
  status: QueueStatus;
  outcome: "applied" | "idempotent" | "superseded";
  itemId: string;
}

export interface QueueOptions {
  now?: () => number;
  leaseMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
}

export interface OutboxEvent {
  version: 1;
  eventId: string;
  topic: string;
  createdAt: number;
  payload: unknown;
}

interface ItemRow {
  id: string;
  payload: string;
  status: QueueStatus;
  priority: number;
  attempt: number;
  available_at: number;
  created_at: number;
  updated_at: number;
  result: string | null;
  error: string | null;
  lease_id: string | null;
}

interface ClaimRow {
  lease_id: string;
  item_id: string;
  runner_id: string;
  request_id: string;
  attempt: number;
  lease_json: string;
  state: string;
  lease_expires_at: number;
  report_json: string | null;
  report_result_json: string | null;
}

const DEFAULT_LEASE_MS = 5 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 5 * 60_000;

export function openDaemonDb(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA busy_timeout=5000");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode=WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS garden_queue (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','leased','succeeded','failed')),
      priority INTEGER NOT NULL DEFAULT 100,
      attempt INTEGER NOT NULL DEFAULT 0,
      available_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      result TEXT,
      error TEXT,
      lease_id TEXT
    );
    CREATE INDEX IF NOT EXISTS garden_queue_ready ON garden_queue(status, priority, available_at, created_at);
    CREATE TABLE IF NOT EXISTS garden_claim (
      lease_id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      runner_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      lease_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('active','reported','indeterminate')),
      lease_expires_at INTEGER NOT NULL,
      report_json TEXT,
      report_result_json TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(runner_id, request_id)
    );
    CREATE INDEX IF NOT EXISTS garden_claim_expiry ON garden_claim(state, lease_expires_at);
    CREATE TABLE IF NOT EXISTS garden_audit (
      audit_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS garden_outbox (
      event_id TEXT PRIMARY KEY,
      topic TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      dispatched_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS garden_outbox_pending ON garden_outbox(dispatched_at, created_at, event_id);
    CREATE TABLE IF NOT EXISTS garden_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  return db;
}

function nowFrom(options?: QueueOptions): number {
  const at = options?.now?.() ?? Date.now();
  if (!Number.isSafeInteger(at) || at < 0) throw new Error("clock must return a non-negative integer epoch millisecond");
  return at;
}

function serialize(value: unknown, label: string): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error(`${label} must be JSON serializable`);
  return json;
}

function addAuditAndEvent(
  db: Database,
  actor: string,
  action: string,
  payload: unknown,
  topic: string,
  at: number,
): void {
  db.query("INSERT INTO garden_audit(audit_id,created_at,actor,action,payload) VALUES(?,?,?,?,?)")
    .run(randomUUID(), at, actor, action, serialize(payload, "audit payload"));
  db.query("INSERT INTO garden_outbox(event_id,topic,payload,created_at) VALUES(?,?,?,?)")
    .run(randomUUID(), topic, serialize(payload, "outbox payload"), at);
}

function parseItem(row: ItemRow): QueueItem {
  return {
    id: row.id,
    payload: JSON.parse(row.payload),
    status: row.status,
    priority: row.priority,
    attempt: row.attempt,
    availableAt: row.available_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.result === null ? {} : { result: JSON.parse(row.result) }),
    ...(row.error === null ? {} : { error: row.error }),
  };
}

function getMeta(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM garden_meta WHERE key=?").get(key) as { value: string } | null;
  return row?.value ?? null;
}

function setMeta(db: Database, key: string, value: string): void {
  db.query(`INSERT INTO garden_meta(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, value);
}

export function isDraining(db: Database): boolean {
  return getMeta(db, "garden:drain") === "1";
}

export function setDrain(db: Database, draining: boolean, actor = "garden-daemon", at = Date.now()): void {
  db.transaction(() => {
    const prior = isDraining(db);
    setMeta(db, "garden:drain", draining ? "1" : "0");
    if (prior !== draining) {
      const payload = { from: prior, to: draining };
      addAuditAndEvent(db, actor, "queue.drain.changed", payload, "queue.drain", at);
    }
  }).immediate();
}

export interface EnqueueInput {
  id?: string;
  payload: unknown;
  priority?: number;
  availableAt?: number;
}

export function enqueue(db: Database, input: EnqueueInput, options?: QueueOptions): { item: QueueItem; created: boolean } {
  const id = input.id ?? randomUUID();
  if (!id.trim() || id.length > 200) throw new Error("id must contain 1..200 characters");
  const priority = input.priority ?? 100;
  if (!Number.isSafeInteger(priority)) throw new Error("priority must be an integer");
  const at = nowFrom(options);
  const availableAt = input.availableAt ?? at;
  if (!Number.isSafeInteger(availableAt) || availableAt < 0) throw new Error("availableAt must be a non-negative integer");
  const payload = serialize(input.payload, "payload");
  return db.transaction(() => {
    const inserted = db.query(`INSERT OR IGNORE INTO garden_queue
      (id,payload,status,priority,attempt,available_at,created_at,updated_at)
      VALUES(?,?,'queued',?,0,?,?,?)`).run(id, payload, priority, availableAt, at, at);
    const row = db.query("SELECT * FROM garden_queue WHERE id=?").get(id) as ItemRow | null;
    if (!row) throw new Error("queue insert did not produce an item");
    if (inserted.changes > 0) {
      const event = { itemId: id, priority, availableAt };
      addAuditAndEvent(db, "garden-daemon", "queue.enqueued", event, "queue.enqueued", at);
    }
    return { item: parseItem(row), created: inserted.changes > 0 };
  }).immediate();
}

function reclaimExpired(db: Database, at: number): number {
  const rows = db.query(`SELECT c.lease_id,c.item_id,c.runner_id FROM garden_claim c
    JOIN garden_queue q ON q.id=c.item_id
    WHERE c.state='active' AND c.lease_expires_at<=? AND q.status='leased' AND q.lease_id=c.lease_id`)
    .all(at) as Array<{ lease_id: string; item_id: string; runner_id: string }>;
  for (const row of rows) {
    db.query(`UPDATE garden_claim SET state='indeterminate' WHERE lease_id=? AND state='active'`).run(row.lease_id);
    db.query(`UPDATE garden_queue SET status='queued',available_at=?,updated_at=?,lease_id=NULL
      WHERE id=? AND status='leased' AND lease_id=?`).run(at, at, row.item_id, row.lease_id);
    const payload = { itemId: row.item_id, leaseId: row.lease_id, runnerId: row.runner_id, reason: "lease_expired" };
    addAuditAndEvent(db, "garden-daemon", "queue.lease.reclaimed", payload, "queue.reclaimed", at);
  }
  return rows.length;
}

export function reclaimExpiredLeases(db: Database, at = Date.now()): number {
  if (!Number.isSafeInteger(at) || at < 0) throw new Error("reconciliation time must be a non-negative integer");
  return db.transaction(() => reclaimExpired(db, at)).immediate();
}

export interface ClaimInput {
  runnerId: string;
  requestId: string;
  leaseMs?: number;
}

export class QueueDrainingError extends Error {
  readonly code = "draining";
  constructor() {
    super("daemon is draining and does not accept new leases");
  }
}

export function claim(db: Database, input: ClaimInput, options?: QueueOptions): QueueLease | null {
  if (!input.runnerId.trim() || input.runnerId.length > 200) throw new Error("runnerId must contain 1..200 characters");
  if (!input.requestId.trim() || input.requestId.length > 200) throw new Error("requestId must contain 1..200 characters");
  const leaseMs = input.leaseMs ?? options?.leaseMs ?? DEFAULT_LEASE_MS;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 24 * 60 * 60_000) throw new Error("leaseMs must be in 1000..86400000");
  const at = nowFrom(options);
  return db.transaction(() => {
    const prior = db.query("SELECT lease_json FROM garden_claim WHERE runner_id=? AND request_id=?")
      .get(input.runnerId, input.requestId) as { lease_json: string } | null;
    if (prior) return JSON.parse(prior.lease_json) as QueueLease;
    if (isDraining(db)) throw new QueueDrainingError();
    reclaimExpired(db, at);
    const item = db.query(`SELECT * FROM garden_queue WHERE status='queued' AND available_at<=?
      ORDER BY priority ASC,created_at ASC,id ASC LIMIT 1`).get(at) as ItemRow | null;
    if (!item) return null;
    const leaseId = randomUUID();
    const attempt = item.attempt + 1;
    const expiresAt = at + leaseMs;
    const lease: QueueLease = {
      leaseId,
      itemId: item.id,
      runnerId: input.runnerId,
      requestId: input.requestId,
      attempt,
      payload: JSON.parse(item.payload),
      expiresAt,
    };
    const changed = db.query(`UPDATE garden_queue SET status='leased',attempt=?,updated_at=?,lease_id=?
      WHERE id=? AND status='queued'`).run(attempt, at, leaseId, item.id);
    if (changed.changes !== 1) return null;
    db.query(`INSERT INTO garden_claim(lease_id,item_id,runner_id,request_id,attempt,lease_json,state,
      lease_expires_at,created_at) VALUES(?,?,?,?,?,?,'active',?,?)`)
      .run(leaseId, item.id, input.runnerId, input.requestId, attempt, serialize(lease, "lease"), expiresAt, at);
    addAuditAndEvent(db, input.runnerId, "queue.lease.claimed", { itemId: item.id, leaseId, attempt }, "queue.claimed", at);
    return lease;
  }).immediate();
}

export function heartbeat(db: Database, leaseId: string, options?: QueueOptions & { leaseMs?: number }): boolean {
  const leaseMs = options?.leaseMs ?? DEFAULT_LEASE_MS;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 24 * 60 * 60_000) throw new Error("leaseMs must be in 1000..86400000");
  const at = nowFrom(options);
  return db.transaction(() => {
    const claimRow = db.query(`SELECT c.item_id,c.state,c.lease_expires_at,q.lease_id,q.status FROM garden_claim c
      JOIN garden_queue q ON q.id=c.item_id WHERE c.lease_id=?`).get(leaseId) as
      { item_id: string; state: string; lease_expires_at: number; lease_id: string | null; status: string } | null;
    if (claimRow?.state === "active" && claimRow.lease_expires_at <= at) {
      reclaimExpired(db, at);
      return false;
    }
    if (!claimRow || claimRow.state !== "active" || claimRow.status !== "leased" || claimRow.lease_id !== leaseId) return false;
    const expiresAt = at + leaseMs;
    db.query("UPDATE garden_claim SET lease_expires_at=? WHERE lease_id=? AND state='active'").run(expiresAt, leaseId);
    const raw = db.query("SELECT lease_json FROM garden_claim WHERE lease_id=?").get(leaseId) as { lease_json: string };
    const lease = JSON.parse(raw.lease_json) as QueueLease;
    lease.expiresAt = expiresAt;
    db.query("UPDATE garden_claim SET lease_json=? WHERE lease_id=?").run(serialize(lease, "lease"), leaseId);
    return true;
  }).immediate();
}

export function report(
  db: Database,
  leaseId: string,
  input: QueueReport,
  options?: QueueOptions,
): QueueReportResult {
  if (typeof input.ok !== "boolean") throw new Error("report.ok must be boolean");
  if (input.error !== undefined && (typeof input.error !== "string" || input.error.length > 4_000)) {
    throw new Error("report.error must be a string of at most 4000 characters");
  }
  const at = nowFrom(options);
  const reportJson = serialize(input, "report");
  const digest = createHash("sha256").update(reportJson).digest("hex");
  const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryDelayMs = options?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new Error("maxAttempts must be a positive integer");
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) throw new Error("retryDelayMs must be a non-negative integer");
  return db.transaction((): QueueReportResult => {
    const c = db.query("SELECT * FROM garden_claim WHERE lease_id=?").get(leaseId) as ClaimRow | null;
    if (!c) throw new Error(`unknown lease ${leaseId}`);
    const item = db.query("SELECT * FROM garden_queue WHERE id=?").get(c.item_id) as ItemRow | null;
    if (!item) throw new Error(`unknown queue item ${c.item_id}`);
    if (c.report_json !== null && c.report_result_json !== null) {
      if (createHash("sha256").update(c.report_json).digest("hex") === digest) {
        const previous = JSON.parse(c.report_result_json) as QueueReportResult;
        return { ...previous, outcome: "idempotent" };
      }
      return { status: item.status, outcome: "superseded", itemId: item.id };
    }
    if (c.state === "active" && c.lease_expires_at <= at) {
      reclaimExpired(db, at);
      return { status: "queued", outcome: "superseded", itemId: item.id };
    }
    if (c.state !== "active" || item.status !== "leased" || item.lease_id !== leaseId) {
      return { status: item.status, outcome: "superseded", itemId: item.id };
    }
    const retry = !input.ok && input.retryable === true && c.attempt < maxAttempts;
    const status: QueueStatus = input.ok ? "succeeded" : retry ? "queued" : "failed";
    const nextAvailableAt = retry ? at + retryDelayMs : item.available_at;
    db.query(`UPDATE garden_queue SET status=?,available_at=?,updated_at=?,lease_id=NULL,result=?,error=?
      WHERE id=? AND lease_id=?`).run(status, nextAvailableAt, at,
        input.ok ? serialize(input.result ?? null, "report result") : null,
        input.ok ? null : input.error ?? "unspecified failure", item.id, leaseId);
    const result: QueueReportResult = { status, outcome: "applied", itemId: item.id };
    db.query(`UPDATE garden_claim SET state='reported',report_json=?,report_result_json=? WHERE lease_id=?`)
      .run(reportJson, serialize(result, "report result"), leaseId);
    const event = { itemId: item.id, leaseId, attempt: c.attempt, status, reportDigest: digest };
    addAuditAndEvent(db, c.runner_id, "queue.lease.reported", event, "queue.reported", at);
    return result;
  }).immediate();
}

export function listQueue(db: Database, statuses?: QueueStatus[]): QueueItem[] {
  if (statuses && statuses.some((status) => !["queued", "leased", "succeeded", "failed"].includes(status))) {
    throw new Error("invalid queue status");
  }
  const rows = statuses?.length
    ? db.query(`SELECT * FROM garden_queue WHERE status IN (${statuses.map(() => "?").join(",")})
        ORDER BY priority,created_at,id`).all(...statuses)
    : db.query("SELECT * FROM garden_queue ORDER BY priority,created_at,id").all();
  return (rows as ItemRow[]).map(parseItem);
}

export function queueHealth(db: Database): { queued: number; leased: number; draining: boolean } {
  const row = db.query(`SELECT
    SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) AS queued,
    SUM(CASE WHEN status='leased' THEN 1 ELSE 0 END) AS leased
    FROM garden_queue`).get() as { queued: number | null; leased: number | null };
  return { queued: row.queued ?? 0, leased: row.leased ?? 0, draining: isDraining(db) };
}

export async function dispatchOutbox(
  db: Database,
  deliver: (event: OutboxEvent) => void | Promise<void>,
  limit = 100,
  now: () => number = Date.now,
): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error("limit must be in 1..1000");
  const rows = db.query(`SELECT event_id,topic,payload,created_at FROM garden_outbox
    WHERE dispatched_at IS NULL ORDER BY created_at,event_id LIMIT ?`).all(limit) as
    Array<{ event_id: string; topic: string; payload: string; created_at: number }>;
  let count = 0;
  for (const row of rows) {
    const event: OutboxEvent = {
      version: 1,
      eventId: row.event_id,
      topic: row.topic,
      createdAt: row.created_at,
      payload: JSON.parse(row.payload),
    };
    try {
      await deliver(event);
      db.query("UPDATE garden_outbox SET dispatched_at=? WHERE event_id=? AND dispatched_at IS NULL")
        .run(now(), row.event_id);
      count += 1;
    } catch {
      break;
    }
  }
  return count;
}

interface ShutdownReceipt {
  schema: "garden-daemon-shutdown/1";
  id: string;
  pid: number;
  priorDrain: boolean;
  priorPaused: boolean;
  startedAt: number;
  completedAt: number | null;
  state: "stopping" | "completed" | "timed_out";
}

function readShutdownReceipt(raw: string | null): ShutdownReceipt | null {
  try {
    const r = JSON.parse(raw ?? "null") as ShutdownReceipt | null;
    if (!r || r.schema !== "garden-daemon-shutdown/1" || typeof r.id !== "string"
      || !Number.isSafeInteger(r.pid) || r.pid <= 0 || typeof r.priorDrain !== "boolean"
      || typeof r.priorPaused !== "boolean" || !Number.isSafeInteger(r.startedAt) || r.startedAt < 0
      || !["stopping", "completed", "timed_out"].includes(r.state)
      || (r.state === "completed"
        ? !Number.isSafeInteger(r.completedAt) || (r.completedAt as number) < r.startedAt
        : r.completedAt !== null)) return null;
    return r;
  } catch {
    return null;
  }
}

export function beginShutdown(db: Database, at = Date.now(), pid = process.pid): string {
  if (!Number.isSafeInteger(at) || at < 0 || !Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid shutdown identity");
  return db.transaction(() => {
    const priorDrain = isDraining(db);
    const priorPaused = getMeta(db, "garden:paused") === "1";
    const receipt: ShutdownReceipt = {
      schema: "garden-daemon-shutdown/1", id: randomUUID(), pid, priorDrain, priorPaused,
      startedAt: at, completedAt: null, state: "stopping",
    };
    setMeta(db, "garden:shutdown", JSON.stringify(receipt));
    setMeta(db, "garden:drain", "1");
    const payload = { id: receipt.id, pid, priorDrain, startedAt: at };
    addAuditAndEvent(db, "garden-daemon", "daemon.shutdown.started", payload, "daemon.shutdown", at);
    return receipt.id;
  }).immediate();
}

export function finishShutdown(db: Database, id: string, state: "completed" | "timed_out", at = Date.now()): void {
  db.transaction(() => {
    setMeta(db, "garden:drain", "1");
    const receipt = readShutdownReceipt(getMeta(db, "garden:shutdown"));
    const valid = receipt !== null && receipt.id === id && receipt.state === "stopping"
      && Number.isSafeInteger(at) && at >= receipt.startedAt;
    if (valid && receipt) {
      receipt.state = state;
      receipt.completedAt = state === "completed" ? at : null;
      setMeta(db, "garden:shutdown", JSON.stringify(receipt));
      const payload = { id, state, completedAt: receipt.completedAt };
      addAuditAndEvent(db, "garden-daemon", "daemon.shutdown.finished", payload, "daemon.shutdown", at);
      return;
    }
    const corrective: ShutdownReceipt = {
      schema: "garden-daemon-shutdown/1",
      id: receipt?.id ?? id,
      pid: receipt?.pid ?? process.pid,
      priorDrain: receipt?.priorDrain ?? true,
      priorPaused: receipt?.priorPaused ?? false,
      startedAt: receipt?.startedAt ?? at,
      completedAt: null,
      state: "timed_out",
    };
    setMeta(db, "garden:shutdown", JSON.stringify(corrective));
    addAuditAndEvent(db, "garden-daemon", "daemon.shutdown.finish_conflict", { expectedId: id, foundId: receipt?.id ?? null }, "daemon.shutdown", at);
  }).immediate();
}

export interface BootReconcileResult {
  reconciled: string[];
  shutdown: "none" | "restored" | "preserved" | "unclean" | "invalid";
}

/** Requeue interrupted work without claiming it succeeded or consuming an attempt. */
export function bootReconcile(db: Database, at = Date.now()): BootReconcileResult {
  if (!Number.isSafeInteger(at) || at < 0) throw new Error("invalid reconciliation time");
  return db.transaction(() => {
    let shutdown: BootReconcileResult["shutdown"] = "none";
    const raw = getMeta(db, "garden:shutdown");
    if (raw !== null) {
      const receipt = readShutdownReceipt(raw);
      db.query("DELETE FROM garden_meta WHERE key='garden:shutdown'").run();
      if (!receipt || receipt.startedAt > at || (receipt.completedAt !== null && receipt.completedAt > at)) {
        shutdown = "invalid";
      } else if (receipt.state !== "completed") {
        shutdown = "unclean";
      } else if (!receipt.priorDrain && isDraining(db)
        && (getMeta(db, "garden:paused") === "1") === receipt.priorPaused) {
        setMeta(db, "garden:drain", "0");
        shutdown = "restored";
      } else {
        shutdown = "preserved";
      }
      addAuditAndEvent(db, "garden-daemon", "daemon.shutdown.reconciled", {
        outcome: shutdown, shutdownId: receipt?.id ?? null, priorDrain: receipt?.priorDrain ?? null,
      }, "daemon.shutdown.reconciled", at);
    }

    const running = db.query(`SELECT c.lease_id,c.item_id,c.runner_id FROM garden_claim c
      JOIN garden_queue q ON q.id=c.item_id
      WHERE c.state='active' AND q.status='leased' AND q.lease_id=c.lease_id
      ORDER BY c.created_at,c.lease_id`).all() as Array<{ lease_id: string; item_id: string; runner_id: string }>;
    for (const row of running) {
      db.query("UPDATE garden_claim SET state='indeterminate' WHERE lease_id=? AND state='active'").run(row.lease_id);
      db.query(`UPDATE garden_queue SET status='queued',available_at=?,updated_at=?,lease_id=NULL
        WHERE id=? AND status='leased' AND lease_id=?`).run(at, at, row.item_id, row.lease_id);
      const payload = { itemId: row.item_id, leaseId: row.lease_id, runnerId: row.runner_id, reason: "boot_reconciliation" };
      addAuditAndEvent(db, "garden-daemon", "queue.boot.reconciled", payload, "queue.reconciled", at);
    }
    return { reconciled: running.map((row) => row.item_id), shutdown };
  }).immediate();
}
