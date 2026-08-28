/**
 * Relative day labels and the shared local-midnight timer (tasks spec §7.0).
 *
 * Dates never render as raw ISO: `relativeDayLabel` maps a date to
 * 오늘/내일/어제, a locale month-day, or an overdue day count. All math is
 * local-time via `daysBetween` (lib/dates.ts) — no UTC drift.
 *
 * `useTodayKey` subscribes React to a module-singleton store whose timer
 * fires once at the next *local* midnight, so labels invalidate on day
 * rollover instead of relying on render-time `new Date()` calls.
 */
import { useSyncExternalStore } from "react";

import { daysBetween, todayLocalISO } from "./dates";
import { dict as enDict } from "./locales/en";
import { dict as koDict } from "./locales/ko";

export type DayTone = "overdue" | "today" | "future";

/** Tone for a date relative to `todayISO` (§7.0: overdue error, today warning, future subtle). */
export function dayTone(iso: string, todayISO: string): DayTone {
  const diff = daysBetween(iso, todayISO);
  if (diff < 0) return "overdue";
  if (diff === 0) return "today";
  return "future";
}

/** `오늘` / `내일` / `어제` / `8월 30일` / `3일 지남` — never a raw ISO date. */
export function relativeDayLabel(iso: string, todayISO: string, locale: "ko" | "en"): string {
  const t = locale === "ko" ? koDict : enDict;
  const diff = daysBetween(iso, todayISO);
  if (diff === 0) return t.day_today;
  if (diff === 1) return t.day_tomorrow;
  if (diff === -1) return t.day_yesterday;
  if (diff < 0) return t.day_days_ago.replace("{n}", String(-diff));
  return formatDay(iso, todayISO, locale);
}

/** Locale month-day (`8월 30일` / `Aug 30`), with the year when it differs. */
function formatDay(iso: string, todayISO: string, locale: "ko" | "en"): string {
  const [y, m, d] = iso.split("-").map(Number);
  const opts: Intl.DateTimeFormatOptions =
    locale === "ko" ? { month: "long", day: "numeric" } : { month: "short", day: "numeric" };
  if (y !== Number(todayISO.slice(0, 4))) opts.year = "numeric";
  return new Intl.DateTimeFormat(locale, opts).format(new Date(y, m - 1, d));
}

/* ---- Shared midnight timer ------------------------------------------------
 * One setTimeout chain per process, alive only while subscribers exist.
 * `get()` recomputes cheaply so the key can never go stale mid-day. */

const listeners = new Set<() => void>();
let midnightTimer: Timer | null = null;

function msUntilLocalMidnight(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return Math.max(next.getTime() - now.getTime(), 1);
}

function scheduleMidnightTick(): void {
  if (midnightTimer !== null) return;
  midnightTimer = setTimeout(() => {
    midnightTimer = null;
    if (listeners.size > 0) scheduleMidnightTick();
    for (const notify of listeners) notify();
  }, msUntilLocalMidnight(new Date()));
}

export const todayKeyStore = {
  subscribe(notify: () => void): () => void {
    listeners.add(notify);
    scheduleMidnightTick();
    return () => {
      listeners.delete(notify);
      if (listeners.size === 0 && midnightTimer !== null) {
        clearTimeout(midnightTimer);
        midnightTimer = null;
      }
    };
  },
  get(): string {
    return todayLocalISO();
  },
};

/** Current local date key; re-renders after every local midnight. */
export function useTodayKey(): string {
  return useSyncExternalStore(todayKeyStore.subscribe, todayKeyStore.get);
}
