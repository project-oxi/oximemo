import { Database } from "bun:sqlite";

export type HealAction = "heal" | "notify" | "ok";
export interface HealDecision {
  action: HealAction;
  pid: number | null;
  reason: "heartbeat_missing" | "fresh" | "process_missing" | "cooldown" | "stale";
}

/** Pure policy: a missing first heartbeat is not evidence of a hung process. */
export function healDecision(
  heartbeatAgeMs: number | null,
  pid: number | null,
  lastHealAtMs: number | null,
  nowMs: number,
  staleAfterMs = 15 * 60_000,
  cooldownMs = 60 * 60_000,
): HealDecision {
  if (heartbeatAgeMs === null) return { action: "notify", pid, reason: "heartbeat_missing" };
  if (heartbeatAgeMs <= staleAfterMs) return { action: "ok", pid, reason: "fresh" };
  if (pid === null) return { action: "notify", pid: null, reason: "process_missing" };
  if (lastHealAtMs !== null && nowMs - lastHealAtMs < cooldownMs) {
    return { action: "notify", pid, reason: "cooldown" };
  }
  return { action: "heal", pid, reason: "stale" };
}

export interface CooldownStore {
  lastHealAt(target: string): number | null;
  recordHeal(target: string, atMs?: number): void;
  close(): void;
}

/** Persist per-target cooldown timestamps in the daemon's SQLite database. */
export function createCooldownStore(db: Database): CooldownStore {
  db.exec(`CREATE TABLE IF NOT EXISTS garden_heal_cooldown (
    target TEXT PRIMARY KEY,
    last_heal_at INTEGER NOT NULL
  )`);
  const read = db.query("SELECT last_heal_at FROM garden_heal_cooldown WHERE target = ?");
  const write = db.query(`INSERT INTO garden_heal_cooldown(target,last_heal_at) VALUES(?,?)
    ON CONFLICT(target) DO UPDATE SET last_heal_at=excluded.last_heal_at`);
  return {
    lastHealAt(target) {
      const row = read.get(target) as { last_heal_at: number } | null;
      return row?.last_heal_at ?? null;
    },
    recordHeal(target, atMs = Date.now()) {
      if (!target.trim() || !Number.isSafeInteger(atMs) || atMs < 0) throw new Error("invalid cooldown record");
      write.run(target, atMs);
    },
    close() {},
  };
}
