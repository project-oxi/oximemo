/**
 * CalendarView — Notion-style month grid for any folder or smart collection.
 * Buckets notes by `dateField` (created_at / updated_at / schema date prop).
 * Per-day cells render up to 3 titles as direct-open buttons + a "+N더"
 * popover for the rest. Notes missing the bucket date surface in a
 * collapsible "날짜 없음" strip — never silently dropped.
 *
 * Scope: recursive (matches Timeline/Graph). Data is pre-fetched by the
 * parent via a dedicated bounded query — see CardGrid's
 * "memos.calendar" query key (§5).
 */
import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { addMonths, isoToLocalDate, monthGrid, monthTitle, weekdayLabels } from "../../lib/dates";
import { useI18n } from "../../lib/i18n";
import { Popover } from "@base-ui-components/react";

import type { FolderDef, MemoSummary } from "../../lib/types";

const MAX_VISIBLE_PER_DAY = 3;

interface Props {
  memos: MemoSummary[];
  dateField: string;
  folders: FolderDef[];
  onSelect: (id: string) => void;
  today: string;
  locale: string;
  dailyFolder: string | null;
  dailyEnabled: boolean;
  onOpenDailyNote: (date: string) => void;
}

/** Resolved label for a memo row in the grid + popovers. Three call sites
 *  share the exact same fallback chain — extracted to keep them in lockstep. */
function memoLabel(m: MemoSummary): string {
  return m.title ?? m.path.split("/").pop() ?? "(untitled)";
}

function bucketKey(memo: MemoSummary, dateField: string): string | null {
  if (dateField === "created_at") return isoToLocalDate(memo.created_at);
  if (dateField === "updated_at") return isoToLocalDate(memo.updated_at);
  const v = memo.props?.[dateField];
  // PropValue is externally tagged: only the { Str } variant carries text.
  // `in` narrows without a cast, so the access is type-checked.
  if (v && typeof v === "object" && "Str" in v) {
    const s = v.Str;
    return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  }
  return null;
}

export function CalendarView({
  memos,
  dateField,
  folders,
  onSelect,
  today,
  locale,
  dailyFolder,
  dailyEnabled,
  onOpenDailyNote,
}: Props) {
  const { t, locale: i18nLocale } = useI18n();
  const effectiveLocale = locale || i18nLocale || "ko";
  const todayLabel = t.calendar_today;
  const moreLabel = (n: number) => t.calendar_more.replace("{n}", String(n));
  const noDateLabel = (n: number) => t.calendar_no_date.replace("{n}", String(n));

  const [ty, tm] = today.split("-").map(Number);
  const todayMonth = { year: ty, month: tm };
  const [viewed, setViewed] = useState(todayMonth);

  // `byDate` is a dynamic string→list map built at runtime from incoming
  // memos, so a Map is the right shape (not a Record).
  const { byDate, noDate } = useMemo(() => {
    const byDate = new Map<string, MemoSummary[]>();
    const noDate: MemoSummary[] = [];
    for (const m of memos) {
      const key = bucketKey(m, dateField);
      if (!key) {
        noDate.push(m);
        continue;
      }
      const arr = byDate.get(key);
      if (arr) arr.push(m);
      else byDate.set(key, [m]);
    }
    return { byDate, noDate };
  }, [memos, dateField]);

  const cells = monthGrid(viewed.year, viewed.month);
  const atToday = viewed.year === todayMonth.year && viewed.month === todayMonth.month;
  const weekdayHeader = weekdayLabels(effectiveLocale);

  const handlePrev = () => setViewed(addMonths(viewed.year, viewed.month, -1));
  const handleNext = () => setViewed(addMonths(viewed.year, viewed.month, 1));
  const handleJumpToday = () => setViewed(todayMonth);

  const onEmptyDay = dailyEnabled && dailyFolder
    ? (date: string) => onOpenDailyNote(date)
    : null;

  return (
    <div data-calendar-view className="flex h-full flex-col gap-2 p-3">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-1 text-sm">
          <button type="button" onClick={handlePrev} aria-label="previous month"
            className="inline-flex h-6 w-6 items-center justify-center rounded-[var(--tag-radius)] text-text-subtle hover:bg-surface-muted hover:text-text">
            <ChevronLeft size={14} strokeWidth={2} />
          </button>
          <span className="min-w-32 text-center font-medium">
            {monthTitle(viewed.year, viewed.month, effectiveLocale)}
          </span>
          <button type="button" onClick={handleNext} aria-label="next month"
            className="inline-flex h-6 w-6 items-center justify-center rounded-[var(--tag-radius)] text-text-subtle hover:bg-surface-muted hover:text-text">
            <ChevronRight size={14} strokeWidth={2} />
          </button>
        </div>
        {!atToday && (
          <button type="button" onClick={handleJumpToday}
            className="text-xs text-text-subtle hover:text-text">
            {todayLabel}
          </button>
        )}
      </header>

      <div className="grid grid-cols-7 gap-px text-[10px] uppercase text-text-subtle">
        {weekdayHeader.map((wd, i) => (
          <div key={i} className="px-1 py-1 text-center">{wd}</div>
        ))}
      </div>

      <div className="grid flex-1 grid-cols-7 gap-px overflow-hidden rounded-[var(--card-radius)] border border-line bg-line">
        {cells.map((cell) => {
          const day = byDate.get(cell.date) ?? [];
          const isToday = cell.date === today;
          const isCurrentMonth = cell.inMonth;
          const visible = day.slice(0, MAX_VISIBLE_PER_DAY);
          const overflow = day.length - visible.length;
          const empty = day.length === 0;
          return (
            <div
              key={cell.date}
              data-calendar-cell
              data-today={isToday || undefined}
              data-empty={empty || undefined}
              onClick={empty && onEmptyDay ? () => onEmptyDay(cell.date) : undefined}
              className={`flex min-h-[88px] flex-col gap-0.5 bg-surface p-1 text-xs ${
                isCurrentMonth ? "" : "opacity-40"
              } ${empty && onEmptyDay ? "cursor-pointer hover:bg-surface-muted" : ""}`}
            >
              <div className={`text-right text-[11px] ${
                isToday ? "font-semibold text-text" : "text-text-subtle"
              }`}>
                {cell.day}
              </div>
              {visible.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onSelect(m.id); }}
                  title={m.title ?? m.path}
                  className="truncate rounded-[var(--tag-radius)] px-1 text-left text-[11px] text-text hover:bg-surface-muted"
                >
                  {memoLabel(m)}
                </button>
              ))}
              {overflow > 0 && (
                <OverflowPopover
                  memos={day.slice(MAX_VISIBLE_PER_DAY)}
                  folders={folders}
                  onSelect={onSelect}
                  label={moreLabel(overflow)}
                />
              )}
            </div>
          );
        })}
      </div>

      {noDate.length > 0 && (
        <NoDateStrip
          memos={noDate}
          folders={folders}
          onSelect={onSelect}
          label={noDateLabel(noDate.length)}
        />
      )}
    </div>
  );
}

function OverflowPopover({
  memos, folders, onSelect, label,
}: {
  memos: MemoSummary[];
  folders: FolderDef[];
  onSelect: (id: string) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <button
            type="button"
            onClick={(e) => e.stopPropagation()}
            className="self-start rounded-[var(--tag-radius)] px-1 text-[10px] text-text-subtle hover:bg-surface-muted hover:text-text"
          >
            {label}
          </button>
        }
      />
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={2} className="z-50">
          <Popover.Popup className="min-w-48 max-h-72 overflow-y-auto rounded-[var(--popover-radius)] border border-line bg-surface-raised p-1 shadow-lg animate-popover-in">
            <ul role="list" className="flex flex-col gap-0.5">
              {memos.map((m) => {
                const folder = folders.find((f) => f.path === m.folder);
                const color = folder?.color;
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => { setOpen(false); onSelect(m.id); }}
                      className="flex w-full items-center gap-1.5 rounded-[var(--tag-radius)] px-2 py-1 text-left text-xs text-text hover:bg-surface-muted"
                    >
                      {color && (
                        <span
                          aria-hidden
                          className="inline-block h-2 w-2 shrink-0 rounded-full"
                          style={{ background: color }}
                        />
                      )}
                      <span className="truncate">{memoLabel(m)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function NoDateStrip({
  memos, folders, onSelect, label,
}: {
  memos: MemoSummary[];
  folders: FolderDef[];
  onSelect: (id: string) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-line/70 pt-1">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          render={
            <button
              type="button"
              className="text-xs text-text-subtle hover:text-text"
            >
              {label}
            </button>
          }
        />
        <Popover.Portal>
          <Popover.Positioner side="top" align="start" sideOffset={4} className="z-50">
            <Popover.Popup className="min-w-64 max-h-72 overflow-y-auto rounded-[var(--popover-radius)] border border-line bg-surface-raised p-1 shadow-lg animate-popover-in">
              <ul role="list" className="flex flex-col gap-0.5">
                {memos.map((m) => {
                  const folder = folders.find((f) => f.path === m.folder);
                  const color = folder?.color;
                  return (
                    <li key={m.id}>
                      <button
                        type="button"
                        onClick={() => { setOpen(false); onSelect(m.id); }}
                        className="flex w-full items-center gap-1.5 rounded-[var(--tag-radius)] px-2 py-1 text-left text-xs text-text hover:bg-surface-muted"
                      >
                        {color && (
                          <span
                            aria-hidden
                            className="inline-block h-2 w-2 shrink-0 rounded-full"
                            style={{ background: color }}
                          />
                        )}
                        <span className="truncate">{memoLabel(m)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
