/**
 * Relative time formatting ("3분 전" / "3 minutes ago") via Intl, no date
 * dependency. Used on cards (§7.3) in place of a raw timestamp.
 */

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
  ["second", 1],
];

function formatter(locale: string): Intl.RelativeTimeFormat {
  try {
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  } catch {
    return new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  }
}

export function relativeTime(iso: string, locale = "ko"): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const diff = (then - Date.now()) / 1000; // negative ⇒ past
  const abs = Math.abs(diff);
  for (const [unit, secs] of UNITS) {
    if (abs >= secs || unit === "second") {
      return formatter(locale).format(Math.round(diff / secs), unit);
    }
  }
  return "";
}
