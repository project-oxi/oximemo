/**
 * Local-time date math for the daily-notes calendar (spec 2026-08-21 §3).
 * Never uses UTC — "today" must match the user's wall clock.
 */

/** Local ISO date (YYYY-MM-DD) for now. */
export function todayLocalISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Month arithmetic on {year, month(1-12)}, wrapping across years. */
export function addMonths(y: number, m: number, delta: number): { year: number; month: number } {
  const zero = y * 12 + (m - 1) + delta;
  return { year: Math.floor(zero / 12), month: (zero % 12) + 1 };
}

/** Sunday-first grid of days covering month `m`, exactly the weeks
 * needed (4–6 rows). Out-of-month cells carry inMonth: false. */
export function monthGrid(y: number, m: number): { date: string; day: number; inMonth: boolean }[] {
  const first = new Date(y, m - 1, 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay()); // back to Sunday
  const daysInMonth = new Date(y, m, 0).getDate();
  const cells = Math.ceil((first.getDay() + daysInMonth) / 7) * 7;
  const out: { date: string; day: number; inMonth: boolean }[] = [];
  for (let i = 0; i < cells; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    out.push({
      date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      day: d.getDate(),
      inMonth: d.getMonth() === m - 1,
    });
  }
  return out;
}

/** Short weekday labels starting Sunday, via Intl. */
export function weekdayLabels(locale: string): string[] {
  // 2023-01-01 is a Sunday.
  const fmt = new Intl.DateTimeFormat(locale, { weekday: "short" });
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2023, 0, 1 + i)));
}

/** Month title like "2026년 8월" (ko) / "August 2026" (en). */
export function monthTitle(y: number, m: number, locale: string): string {
  const fmt = new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" });
  return fmt.format(new Date(y, m - 1, 1));
}

/** Local date subtitle like "8월 22일 (토)" (ko) / "Aug 22 (Fri)" (en). */
export function dayLabel(iso: string, locale: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { month: "long", day: "numeric", weekday: "short" }).format(
    new Date(y, m - 1, d),
  );
}
