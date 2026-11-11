/**
 * 리뷰 큐 「한 장 넘기기」(RecallCard) 진행 계산 (2026-11-11).
 *
 * 「설명 가능함」은 같은 값을 다시 쓰므로 판정한 메모가 대기열에서 빠지지 않고
 * 날짜순 뒤로 밀려 다시 나타난다. 그래서 서버 목록의 순번으로 진행을 세면
 * 같은 메모가 두 번 나오거나 칸이 줄었다 늘었다 한다 — 이번 판에 판정한 id 를
 * 따로 모아 두고 그것을 뺀 나머지로 센다.
 */

/** 30개를 넘으면 칸이 너무 가늘어져 한 칸이 무엇인지 읽히지 않는다 — 비율 띠로 바꾼다. */
export const MAX_CELLS = 30;

export type CellState = "done" | "current" | "rest";

export interface ReviewProgress {
  /** 이번 판에 판정을 마친 수. */
  done: number;
  /** 이번 판 전체 수 (판정함 + 남음). */
  total: number;
  /** 지금 보는 장의 순번 (1부터). 다 끝났으면 done 과 같다. */
  position: number;
  /** total ≤ MAX_CELLS 일 때 칸마다 상태, 넘으면 null (비율 띠). */
  cells: CellState[] | null;
}

/** 아직 판정하지 않은 id — 서버 순서를 지키고 중복을 걷는다. */
export function pendingIds(loadedIds: readonly string[], doneIds: ReadonlySet<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of loadedIds) {
    // 페이지 사이에서 순서가 바뀌면 같은 id 가 두 페이지에 걸칠 수 있다.
    if (doneIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * @param loadedIds   지금까지 받은 페이지의 id (서버 순서)
 * @param doneIds     이번 판에 판정한 id
 * @param serverTotal 서버가 알려 준 대기열 전체 수
 */
export function reviewProgress(
  loadedIds: readonly string[],
  doneIds: ReadonlySet<string>,
  serverTotal: number,
): ReviewProgress {
  const pending = pendingIds(loadedIds, doneIds).length;
  const unloaded = Math.max(0, serverTotal - new Set(loadedIds).size);
  const done = doneIds.size;
  const total = done + pending + unloaded;
  const position = pending + unloaded > 0 ? done + 1 : done;
  const cells: CellState[] | null =
    total > MAX_CELLS
      ? null
      : Array.from({ length: total }, (_, i) => (i < done ? "done" : i === done ? "current" : "rest"));
  return { done, total, position, cells };
}
