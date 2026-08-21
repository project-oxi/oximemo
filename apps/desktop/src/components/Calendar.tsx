/**
 * Mini month calendar for daily notes (spec 2026-08-21 §3): dots on
 * days that have a note, today highlighted, click = open-or-create.
 * Pure presentational + local viewed-month state; data comes in via
 * the `dates` set.
 */
import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { addMonths, monthGrid, monthTitle, weekdayLabels } from "../lib/dates";

export function Calendar({
  dates,
  today,
  locale,
  onSelect,
}: {
  /** ISO dates that have a daily note. */
  dates: Set<string>;
  /** Today's ISO date (local). */
  today: string;
  locale: string;
  onSelect: (date: string) => void;
}) {
  const t = new Date();
  const [viewed, setViewed] = useState({ year: t.getFullYear(), month: t.getMonth() + 1 });
  const cells = monthGrid(viewed.year, viewed.month);
  const todayMonth = { year: t.getFullYear(), month: t.getMonth() + 1 };
  const atToday =
    viewed.year === todayMonth.year && viewed.month === todayMonth.month;

  return (
    <div data-daily-calendar className="px-1 pb-1 pt-0.5 select-none">
      <div className="flex items-center justify-between px-1 pb-1">
        <span data-daily-title className="text-[11px] font-semibold text-text">
          {monthTitle(viewed.year, viewed.month, locale)}
        </span>
        <span className="flex items-center gap-0.5">
          <button
            type="button"
            data-daily-prev
            aria-label="previous month"
            onClick={() => setViewed(addMonths(viewed.year, viewed.month, -1))}
            className="grid size-5 place-items-center rounded-[var(--button-radius)] text-text-subtle transition-colors duration-150 hover:bg-surface-muted hover:text-text"
          >
            <ChevronLeft size={12} />
          </button>
          <button
            type="button"
            data-daily-next
            aria-label="next month"
            onClick={() => setViewed(addMonths(viewed.year, viewed.month, 1))}
            className="grid size-5 place-items-center rounded-[var(--button-radius)] text-text-subtle transition-colors duration-150 hover:bg-surface-muted hover:text-text"
          >
            <ChevronRight size={12} />
          </button>
        </span>
      </div>
      <div className="grid grid-cols-7">
        {weekdayLabels(locale).map((w) => (
          <span key={w} className="pb-0.5 text-center text-[9px] text-text-subtle">
            {w}
          </span>
        ))}
        {cells.map((c) => {
          const isToday = c.date === today;
          const has = dates.has(c.date);
          return (
            <button
              key={c.date}
              type="button"
              data-daily-day={c.date}
              onClick={() => onSelect(c.date)}
              className={`relative mx-auto grid size-[22px] place-items-center rounded-[var(--button-radius)] text-[11px] transition-colors duration-150 ${
                isToday
                  ? "bg-interactive-primary font-semibold text-interactive-primary-foreground"
                  : c.inMonth
                    ? "text-text-muted hover:bg-surface-muted hover:text-text"
                    : "text-text-subtle/50 hover:bg-surface-muted"
              }`}
            >
              {c.day}
              {has && (
                <i
                  data-daily-dot
                  aria-hidden
                  className={`absolute bottom-[1px] left-1/2 size-[3px] -translate-x-1/2 rounded-full ${
                    isToday ? "bg-interactive-primary-foreground" : "bg-text-subtle"
                  }`}
                />
              )}
            </button>
          );
        })}
      </div>
      {!atToday && (
        <button
          type="button"
          onClick={() => setViewed(todayMonth)}
          className="mt-1 w-full rounded-[var(--button-radius)] px-1 py-0.5 text-[10px] text-text-subtle transition-colors duration-150 hover:bg-surface-muted hover:text-text"
        >
          ← Today
        </button>
      )}
    </div>
  );
}
