import { describe, expect, test } from "bun:test";
import { MAX_CELLS, pendingIds, reviewProgress } from "./reviewProgress";

describe("pendingIds", () => {
  test("판정한 id 와 중복을 빼고 서버 순서를 지킨다", () => {
    expect(pendingIds(["a", "b", "c", "b"], new Set(["a"]))).toEqual(["b", "c"]);
  });
});

describe("reviewProgress", () => {
  test("처음엔 1번째 장이 현재 칸이다", () => {
    const p = reviewProgress(["a", "b", "c"], new Set(), 3);
    expect(p).toMatchObject({ done: 0, total: 3, position: 1 });
    expect(p.cells).toEqual(["current", "rest", "rest"]);
  });

  test("같은 값을 다시 써서 대기열에 남은 메모는 두 번 세지 않는다", () => {
    // 「설명 가능함」은 값이 그대로라 서버 목록 끝에 다시 나온다.
    const p = reviewProgress(["b", "c", "a"], new Set(["a"]), 3);
    expect(p).toMatchObject({ done: 1, total: 3, position: 2 });
    expect(p.cells).toEqual(["done", "current", "rest"]);
  });

  test("대기열에서 빠진 메모(막힘 → 다른 값 · 승격)도 전체 수를 유지한다", () => {
    const p = reviewProgress(["b", "c"], new Set(["a"]), 2);
    expect(p).toMatchObject({ done: 1, total: 3, position: 2 });
  });

  test("받지 않은 페이지도 남은 수에 든다", () => {
    const p = reviewProgress(["a", "b"], new Set(), 80);
    expect(p.total).toBe(80);
    expect(p.cells).toBeNull();
  });

  test(`${MAX_CELLS}개까지는 칸으로 그린다`, () => {
    const ids = Array.from({ length: MAX_CELLS }, (_, i) => String(i));
    expect(reviewProgress(ids, new Set(), MAX_CELLS).cells).toHaveLength(MAX_CELLS);
  });

  test("다 끝나면 순번은 판정 수와 같다", () => {
    const p = reviewProgress(["a", "b"], new Set(["a", "b"]), 2);
    expect(p).toMatchObject({ done: 2, total: 2, position: 2 });
    expect(p.cells).toEqual(["done", "done"]);
  });
});
