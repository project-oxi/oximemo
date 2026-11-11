/**
 * 시간 지층 「RecencyStrata」 의 띠 가르기 (2026-11-11).
 *
 * 작업 화면 그리드가 「수정 순」일 때 메모를 오늘 · 이번 주 · 그 이전 세 띠로 나눈다.
 * 경계는 사용자의 <로컬> 날짜다 — UTC 로 자르면 한국 시각 오전 9시 전에 고친 메모가 「어제」로 떨어진다.
 * 주는 dates.ts 와 같은 일요일 시작이다. 할 일 화면의 「이번 주」와 다른 주를 가리키면
 * 같은 낱말이 화면마다 다른 날을 뜻하게 된다.
 *
 * 순수 함수 — `todayISO` 는 호출부가 `useTodayKey()` 로 넘겨 자정에 다시 계산되게 한다.
 */
import { daysBetween } from "./dates";

export type RecencyBand = "today" | "week" | "older";

/** ISO 시각 → 로컬 날짜 키(YYYY-MM-DD). 읽을 수 없으면 null. */
export function localDayKey(iso: string): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** 메모 하나의 띠. 미래 시각(다른 기기 시계가 앞선 경우)은 「오늘」로 둔다 — 맨 위에 있어야 찾는다. */
export function recencyBand(updatedAt: string, todayISO: string): RecencyBand {
  const key = localDayKey(updatedAt);
  if (key === null) return "older";
  const diff = daysBetween(key, todayISO); // key − today
  if (diff >= 0) return "today";
  const [y, m, d] = todayISO.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay(); // 0 = 일요일
  return -diff <= dow ? "week" : "older";
}

export interface RecencyStrataSplit<T> {
  today: T[];
  week: T[];
  older: T[];
}

/** 띠별로 나눈다. 각 띠 안의 순서는 입력 순서(수정 내림차순)를 그대로 지킨다. */
export function splitByRecency<T extends { updated_at: string }>(
  notes: readonly T[],
  todayISO: string,
): RecencyStrataSplit<T> {
  const out: RecencyStrataSplit<T> = { today: [], week: [], older: [] };
  for (const n of notes) out[recencyBand(n.updated_at, todayISO)].push(n);
  return out;
}
