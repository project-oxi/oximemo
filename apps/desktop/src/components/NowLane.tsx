/**
 * NowLane 공용 조각 (2026-11-11) — 할 일 화면(TasksView)과 사이드바(TasksPanel)가 같이 쓴다.
 *
 * 같은 데이터는 같은 모양으로: 지금 선(NowRule) 위는 늦은 것, 아래는 남은 것.
 * 늦은 정도는 계단 막대 칸 수(로그 · 최대 8칸)와 「N일 지남」 글자로, 남은 날은 행 사이 간격으로 말한다.
 * 색을 쓰지 않는다 — 앱 색이 무채색이라 색 톤은 실제 화면에서 구분되지 않는다.
 * 날짜 셈은 lib/nowLane.ts 에 있다.
 */
import { useId, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import { daysBetween } from "../lib/dates";
import type { Dict, Locale } from "../lib/i18n";
import { LATENESS_MAX_STEPS } from "../lib/nowLane";
import { relativeDayLabel } from "../lib/relativeDay";
import { NowRule } from "./shapes";
import "./nowLane.css";

/** 「11/11 화」 · 「Wed 11/11」 — 지금 선 글자. 연도는 뺀다: 지금 선은 늘 올해 오늘이다. */
function shortDay(iso: string, locale: Locale): string {
  const [y, m, d] = iso.split("-").map(Number);
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short" }).format(new Date(y, m - 1, d));
  return locale === "ko" ? `${m}/${d} ${weekday}` : `${weekday} ${m}/${d}`;
}

/** 지금 선. 위아래 목록 사이에 하나만 긋는다. */
export function LaneNowRule({ todayISO, locale, t }: { todayISO: string; locale: Locale; t: Dict }) {
  return <NowRule label={t.task_lane_now.replace("{date}", shortDay(todayISO, locale))} />;
}

/** 선 아래 행 끝 날짜: 오늘 · 내일 · 이번 주 안은 요일 · 그 뒤는 월일.
 *  요일이 「11월 13일」보다 짧고 이번 주 계획에는 요일이 먼저 떠오른다. */
export function laneDayLabel(iso: string, todayISO: string, locale: Locale): string {
  const diff = daysBetween(iso, todayISO);
  if (diff >= 2 && diff <= 6) {
    const [y, m, d] = iso.split("-").map(Number);
    return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(new Date(y, m - 1, d));
  }
  return relativeDayLabel(iso, todayISO, locale);
}

/** 늦음 계단 막대. 칸이 늘수록 조금씩 높아져 「더 늦음」이 길이와 높이 둘로 읽힌다.
 *  뜻은 옆 글자(「N일 지남」)가 전하므로 낭독기에서는 숨긴다. */
export function LatenessBar({ steps }: { steps: number }) {
  return (
    <span className="lateness-bar" aria-hidden>
      {Array.from({ length: LATENESS_MAX_STEPS }, (_, i) => (
        <i key={i} data-on={i < steps ? "" : undefined} style={{ height: 3 + i }} />
      ))}
    </span>
  );
}

/** 날짜 없음 접힌 한 줄 「날짜 없음 N」 — 그 자리에서 펼친다. */
export function UndatedFold({
  count,
  t,
  compact,
  children,
}: {
  count: number;
  t: Dict;
  compact?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  if (count === 0) return null;
  return (
    <div className="now-lane-fold">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((o) => !o)}
        className={`flex w-full items-center gap-1.5 rounded-md text-left text-text-subtle transition-colors duration-150 hover:bg-surface-muted/60 hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
          compact ? "px-2 py-1 text-[11px]" : "px-4 py-1.5 text-[12px]"
        }`}
      >
        <ChevronRight size={12} aria-hidden className="now-lane-chevron shrink-0" />
        <span>{t.task_group_no_date}</span>
        <span className="tabular-nums">{count}</span>
      </button>
      <div id={bodyId} hidden={!open}>
        {open && children}
      </div>
    </div>
  );
}
