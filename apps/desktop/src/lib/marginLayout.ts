/**
 * Immersive margin geometry (2026-11-11 «MarginLinks»).
 *
 * immersive 시트는 본문을 가운데 읽기 폭(--memo-reading-width)에 두고 양옆을 비운다.
 * 그 여백에 연결(왼쪽 = 백링크 · 오른쪽 = 함께 보기 · Brain)을 놓는데, 여백 폭은
 * 창이 아니라 스크롤 틀의 내용 폭에서 잰다 — 코파일럿이 열리면 오른쪽 padding 이
 * 커져 같은 창 폭에서도 여백이 줄기 때문이다.
 *
 * 좁아질 때는 오른쪽을 먼저 접고 왼쪽을 나중에 접는다. 그래서 오른쪽 문턱이 더 높다.
 */

/** 본문과 여백 글 사이 간격. 이보다 붙으면 여백 글이 본문의 일부처럼 읽힌다. */
export const MARGIN_GAP = 32;
/** 2026.11.11 : 왼쪽 여백 최소 폭. 프레임 ≈ 1160px 부터 보인다. 제목 한 줄이 12자 안팎은 들어가야 쓸모가 있다. */
export const MARGIN_LEFT_MIN = 144;
/** 2026.11.11 : 오른쪽 여백 최소 폭. 프레임 ≈ 1224px 부터 보인다 — 왼쪽보다 늦게 나타나고 먼저 접힌다. */
export const MARGIN_RIGHT_MIN = 176;
/** 여백이 넓어도 이 폭까지만 쓴다. 더 넓으면 여백 글이 본문과 무게를 다툰다. */
export const MARGIN_MAX = 240;

export interface MarginBox {
  /** Distance from the stage's own edge (left edge for the left box, right edge for the right box). */
  inset: number;
  width: number;
}

export interface MarginLayout {
  left: MarginBox | null;
  right: MarginBox | null;
}

export interface MarginMeasure {
  /** Scroll frame border-box width (includes a vertical scrollbar). */
  outerWidth: number;
  /** Scroll frame client width (excludes the scrollbar). */
  clientWidth: number;
  padLeft: number;
  padRight: number;
  readingWidth: number;
}

export const NO_MARGINS: MarginLayout = { left: null, right: null };

export function marginLayout({ outerWidth, clientWidth, padLeft, padRight, readingWidth }: MarginMeasure): MarginLayout {
  const content = clientWidth - padLeft - padRight;
  if (!(content > 0) || !(readingWidth > 0)) return NO_MARGINS;
  const gutter = (content - Math.min(content, readingWidth)) / 2;
  const width = Math.min(MARGIN_MAX, gutter - MARGIN_GAP);
  // 여백 상자는 본문 쪽에 붙인다 — 창 가장자리에 붙으면 「어느 글의 여백인지」가 흐려진다.
  const slack = gutter - MARGIN_GAP - width;
  const scrollbar = Math.max(0, outerWidth - clientWidth);
  return {
    left: width >= MARGIN_LEFT_MIN ? { inset: padLeft + slack, width } : null,
    right: width >= MARGIN_RIGHT_MIN ? { inset: scrollbar + padRight + slack, width } : null,
  };
}

function sameBox(a: MarginBox | null, b: MarginBox | null): boolean {
  return a === b || (!!a && !!b && a.inset === b.inset && a.width === b.width);
}

/** Equal layouts — lets a ResizeObserver callback skip a no-op state update. */
export function sameMarginLayout(a: MarginLayout, b: MarginLayout): boolean {
  return sameBox(a.left, b.left) && sameBox(a.right, b.right);
}
