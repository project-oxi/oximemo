/**
 * DateAxis — 할 일 편집 팝오버의 「날짜 한 축」 (2026-11-11).
 *
 * 예전에는 시작 · 예정 · 기한을 날짜 입력 세 줄로 받아, 셋의 앞뒤를 머릿속에서 맞춰야 했다.
 * 이제 한 축 위 손잡이 셋(● 시작 · ■ 예정 · ◆ 기한)과 오늘 눈금으로 앞뒤가 바로 보인다.
 *
 * - 손잡이는 진짜 버튼이다. 끌면 하루 단위로 옮기고, ← → 는 하루(Shift 는 일주일), Delete 는 지운다.
 * - 손잡이를 누르면(Enter) 그 날짜의 기본 date input 이 축 아래 열린다 — 정확한 날짜 입력과 오늘/내일/지우기를 그대로 둔다.
 * - 빠진 날짜는 아래 「+ 시작」 같은 버튼으로 더한다(오늘 기준, 다른 날짜와 앞뒤가 맞게).
 * - 앞뒤가 어긋나면(기한 < 시작 등) 두 손잡이 사이를 빗금으로 칠하고 짧은 글을 단다.
 * - 축 범위는 날짜들 + 오늘에 여백을 두고 맞춘다. 끄는 동안에는 범위를 얼려 손잡이가 손가락 밑에서 도망가지 않게 한다.
 *
 * 날짜 셈은 lib/nowLane.ts (axisRange · axisDateAt · axisOrderIssues · defaultDateFor).
 */
import { useEffect, useId, useRef, useState } from "react";

import { daysBetween, shiftISODate } from "../lib/dates";
import type { Dict, Locale } from "../lib/i18n";
import {
  axisDateAt,
  axisOrderIssues,
  axisPosition,
  axisRange,
  defaultDateFor,
  type AxisDates,
  type AxisField,
  type AxisRange,
} from "../lib/nowLane";
import { relativeDayLabel } from "../lib/relativeDay";
import "./dateAxis.css";

const FIELDS: AxisField[] = ["start", "scheduled", "due"];

/** 모양 = 날짜 종류. 색을 쓰지 않으므로 모양이 유일한 구분이다. */
const SHAPE: Record<AxisField, string> = { start: "●", scheduled: "■", due: "◆" };

/** 끌기로 볼 최소 이동(px). 이보다 작으면 누름(= 날짜 입력 열기)으로 본다. */
const DRAG_THRESHOLD = 3;

function fieldLabel(field: AxisField, t: Dict): string {
  return field === "start" ? t.task_field_start : field === "scheduled" ? t.task_field_scheduled : t.task_field_due;
}

function monthDay(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${m}/${d}`;
}

function fullDay(iso: string, locale: Locale): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", day: "numeric", weekday: "short" }).format(
    new Date(y, m - 1, d),
  );
}

export interface DateAxisProps extends AxisDates {
  today: string;
  locale: Locale;
  t: Dict;
  onChange: (field: AxisField, value: string | null) => void;
}

export function DateAxis({ start, scheduled, due, today, locale, t, onChange }: DateAxisProps) {
  const dates: AxisDates = { start, scheduled, due };
  const labelId = useId();
  const keysId = useId();
  const trackRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // 끄는 동안 얼린 범위. null 이면 날짜에 맞춰 다시 잰다.
  const [dragRange, setDragRange] = useState<AxisRange | null>(null);
  const [dragField, setDragField] = useState<AxisField | null>(null);
  const drag = useRef<{ field: AxisField; x: number; moved: boolean; range: AxisRange } | null>(null);
  // 끌기를 마친 직후 따라오는 click 은 「날짜 입력 열기」가 아니다.
  const suppressClick = useRef(false);
  const [editing, setEditing] = useState<AxisField | null>(null);
  // 지우거나 더한 뒤 초점을 둘 곳 — 손잡이가 사라지거나 새로 생기면 초점이 body 로 빠지지 않게.
  const [focusTarget, setFocusTarget] = useState<string | null>(null);

  const range = dragRange ?? axisRange(dates, today);
  const issues = axisOrderIssues(dates);
  const badFields = new Set(issues.flat());

  useEffect(() => {
    if (!focusTarget) return;
    rootRef.current?.querySelector<HTMLElement>(`[data-focus-key="${focusTarget}"]`)?.focus();
    setFocusTarget(null);
  }, [focusTarget]);

  const set = (field: AxisField, value: string | null) => {
    onChange(field, value);
    if (value === null) {
      if (editing === field) setEditing(null);
      setFocusTarget(`add-${field}`);
    }
  };

  const onPointerDown = (field: AxisField) => (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { field, x: e.clientX, moved: false, range };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    const track = trackRef.current;
    if (!d || !track) return;
    if (!d.moved) {
      if (Math.abs(e.clientX - d.x) < DRAG_THRESHOLD) return;
      d.moved = true;
      setDragRange(d.range);
      setDragField(d.field);
    }
    const rect = track.getBoundingClientRect();
    const next = axisDateAt((e.clientX - rect.left) / rect.width, d.range);
    if (next !== dates[d.field]) onChange(d.field, next);
  };
  const endDrag = () => {
    if (drag.current?.moved) suppressClick.current = true;
    drag.current = null;
    setDragRange(null);
    setDragField(null);
  };

  const onHandleKey = (field: AxisField, value: string) => (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const step = e.shiftKey ? 7 : 1;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      onChange(field, shiftISODate(value, e.key === "ArrowLeft" ? -step : step));
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      set(field, null);
    }
  };

  // 같은 날 손잡이끼리 완전히 덮이지 않게 옆으로 조금씩 민다 — 그래도 같은 날임은 읽힌다.
  const nudge: Partial<Record<AxisField, number>> = {};
  FIELDS.forEach((f, i) => {
    const v = dates[f];
    if (!v) return;
    const before = FIELDS.slice(0, i).filter((g) => dates[g] === v).length;
    nudge[f] = before * 7;
  });

  // 시작 ~ 기한(없으면 있는 날짜 중 처음 ~ 끝) 사이를 굵게 — 일의 「기간」이 길이로 보인다.
  const present = FIELDS.map((f) => dates[f]).filter((v): v is string => v !== null);
  let spanFrom: number | null = null;
  let spanTo: number | null = null;
  if (present.length >= 2) {
    const ps = present.map((v) => axisPosition(v, range));
    spanFrom = Math.min(...ps);
    spanTo = Math.max(...ps);
  }
  const todayPct = axisPosition(today, range) * 100;
  const endDate = shiftISODate(range.from, range.span);

  const summary =
    present.length === 0
      ? t.task_axis_empty
      : FIELDS.filter((f) => dates[f])
          .map((f) => `${fieldLabel(f, t)} ${fullDay(dates[f]!, locale)}`)
          .join(" · ");

  return (
    <div ref={rootRef} className="flex flex-col gap-1" role="group" aria-labelledby={labelId}>
      <span id={labelId} className="text-[10px] font-semibold uppercase tracking-wide text-text-subtle">
        {t.task_axis_label}
      </span>
      <span id={keysId} className="sr-only">{t.task_axis_keys}</span>
      <div ref={trackRef} className="date-axis" data-dragging={dragField ? "" : undefined}>
        <div className="date-axis-line" aria-hidden />
        {spanFrom !== null && spanTo !== null && (
          <div
            className="date-axis-span"
            data-bad={issues.length > 0 ? "" : undefined}
            aria-hidden
            style={{ left: `${spanFrom * 100}%`, width: `${(spanTo - spanFrom) * 100}%` }}
          />
        )}
        <div className="date-axis-today" aria-hidden style={{ left: `${todayPct}%` }} />
        {FIELDS.map((field) => {
          const value = dates[field];
          if (!value) return null;
          const label = fieldLabel(field, t);
          const rel = relativeDayLabel(value, today, locale);
          return (
            <button
              key={field}
              type="button"
              data-focus-key={`handle-${field}`}
              data-shape={field}
              data-active={editing === field || dragField === field ? "" : undefined}
              data-bad={badFields.has(field) ? "" : undefined}
              className="date-axis-handle"
              style={{ left: `calc(${axisPosition(value, range) * 100}% + ${nudge[field] ?? 0}px)` }}
              aria-label={`${label} ${fullDay(value, locale)} (${rel})`}
              aria-describedby={keysId}
              aria-expanded={editing === field}
              title={`${SHAPE[field]} ${label} · ${rel}`}
              onPointerDown={onPointerDown(field)}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onKeyDown={onHandleKey(field, value)}
              onClick={() => {
                if (suppressClick.current) {
                  suppressClick.current = false;
                  return;
                }
                setEditing((cur) => (cur === field ? null : field));
              }}
            />
          );
        })}
      </div>
      <div className="date-axis-scale" aria-hidden>
        {todayPct > 14 && <span style={{ left: 0 }}>{monthDay(range.from)}</span>}
        <span className="date-axis-scale-today" style={{ left: `${todayPct}%` }}>{t.today}</span>
        {todayPct < 86 && <span style={{ right: 0 }}>{monthDay(endDate)}</span>}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        {FIELDS.map((field) => {
          const value = dates[field];
          const label = fieldLabel(field, t);
          if (value) {
            // 손잡이와 같은 모양 · 같은 순서 — 축만 보고 어느 게 무엇인지 헷갈리지 않게 범례를 겸한다.
            return (
              <span key={field} aria-hidden className={badFields.has(field) ? "font-semibold text-text" : "text-text-subtle"}>
                <span className="date-axis-glyph">{SHAPE[field]}</span> {label} {monthDay(value)}
              </span>
            );
          }
          return (
            <button
              key={field}
              type="button"
              data-focus-key={`add-${field}`}
              onClick={() => {
                const v = defaultDateFor(field, dates, today);
                onChange(field, v);
                setEditing(field);
              }}
              className="rounded-[var(--tag-radius)] px-1 text-text-subtle transition-colors duration-150 hover:bg-surface-muted hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            >
              <span aria-hidden className="date-axis-glyph">{SHAPE[field]}</span> {t.task_axis_add.replace("{field}", label)}
            </button>
          );
        })}
      </div>

      {issues.length > 0 && (
        <p className="text-[11px] font-semibold text-text">
          {issues
            .map(([a, b]) => t.task_axis_order.replace("{a}", fieldLabel(a, t)).replace("{b}", fieldLabel(b, t)))
            .join(" · ")}
        </p>
      )}

      {editing && dates[editing] && (
        <ExactDate
          label={fieldLabel(editing, t)}
          value={dates[editing]!}
          today={today}
          locale={locale}
          t={t}
          onChange={(v) => set(editing, v)}
          onDone={() => {
            const f = editing;
            setEditing(null);
            setFocusTarget(`handle-${f}`);
          }}
        />
      )}

      {/* 끌거나 화살표로 옮길 때 손잡이 이름표만 바뀌면 낭독기가 다시 읽지 않는다 — 요약을 따로 알린다. */}
      <span className="sr-only" aria-live="polite">{summary}</span>
    </div>
  );
}

/** 손잡이를 누르면 열리는 정확한 날짜 입력 — 예전 날짜 줄의 입력과 오늘/내일/지우기 버튼 그대로. */
function ExactDate({
  label,
  value,
  today,
  locale,
  t,
  onChange,
  onDone,
}: {
  label: string;
  value: string;
  today: string;
  locale: Locale;
  t: Dict;
  onChange: (v: string | null) => void;
  onDone: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    // 누른 손길이 아직 살아 있을 때 달력도 연다. 막힌 환경이면 입력칸 초점만으로 충분하다.
    try {
      input.showPicker?.();
    } catch {
      /* 사용자 활성화가 없으면 막힌다 — 무시 */
    }
  }, []);
  const btn =
    "rounded-[var(--tag-radius)] bg-surface px-2 py-1 text-[11px] text-text-subtle shadow-[var(--input-shadow)] transition-colors duration-150 hover:bg-surface-muted";
  const diff = daysBetween(value, today);
  return (
    <div className="flex flex-col gap-1 pt-1">
      <div className="flex items-center gap-1.5">
        <input
          ref={inputRef}
          type="date"
          aria-label={label}
          value={value}
          onChange={(e) => onChange(e.target.value.length > 0 ? e.target.value : null)}
          onKeyDown={(e) => {
            // Enter 는 입력을 마치고 손잡이로 돌아간다. ⌘⏎ 는 팝오버가 받아 저장한다.
            if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              onDone();
            }
          }}
          className="min-w-0 flex-1 rounded-[var(--input-radius)] bg-surface px-2 py-1 text-[12px] shadow-[var(--input-shadow)] focus-visible:outline-none focus-visible:shadow-[var(--input-shadow-focus)]"
        />
        <button type="button" onClick={() => onChange(today)} className={btn}>
          {t.today}
        </button>
        <button type="button" onClick={() => onChange(shiftISODate(today, 1))} className={btn}>
          {t.tomorrow}
        </button>
        <button type="button" onClick={() => onChange(null)} aria-label={`${label} ${t.clear}`} title={t.clear} className={btn}>
          {t.clear}
        </button>
      </div>
      <span className="pl-0.5 text-[10px] text-text-subtle">
        {label} · {relativeDayLabel(value, today, locale)}
        {diff !== 0 && ` · ${monthDay(value)}`}
      </span>
    </div>
  );
}
