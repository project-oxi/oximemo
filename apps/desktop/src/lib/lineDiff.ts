/**
 * Line diff for the change journal (2026-11-11).
 *
 * 「변경 장부」에서 바뀌기 전 · 뒤 글을 줄 단위로 견준다. 노트 하나는 수백 줄이라
 * 공통 앞 · 뒤 줄을 먼저 떼고 가운데만 LCS 표로 푼다. 가운데가 너무 크면(표 칸 수 상한)
 * 통째로 「지움 + 더함」으로 내놓는다 — 정확한 최소 차이보다 화면이 멈추지 않는 쪽이 중요하다.
 */

export type DiffOp = "same" | "add" | "del";

export interface DiffLine {
  op: DiffOp;
  text: string;
  /** 1-based line number in `before` (same · del). */
  a?: number;
  /** 1-based line number in `after` (same · add). */
  b?: number;
}

export interface DiffHunk {
  lines: DiffLine[];
}

/** 이보다 큰 가운데 구간은 LCS 표를 만들지 않는다 (2000 × 2000 줄 = 4M 칸 ≈ 16MB). */
const MAX_CELLS = 4_000_000;

/** null(파일 없음)과 빈 글을 같은 「줄 없음」으로 본다. 끝 줄바꿈 하나는 빈 줄로 세지 않는다. */
export function splitLines(text: string | null): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Full line diff, in document order. */
export function diffLines(before: string | null, after: string | null): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;

  const out: DiffLine[] = [];
  for (let i = 0; i < pre; i++) out.push({ op: "same", text: a[i], a: i + 1, b: i + 1 });

  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  if (am.length * bm.length > MAX_CELLS || am.length === 0 || bm.length === 0) {
    am.forEach((text, i) => out.push({ op: "del", text, a: pre + i + 1 }));
    bm.forEach((text, j) => out.push({ op: "add", text, b: pre + j + 1 }));
  } else {
    out.push(...lcsMiddle(am, bm, pre));
  }

  for (let k = suf; k > 0; k--) {
    const ai = a.length - k;
    const bi = b.length - k;
    out.push({ op: "same", text: a[ai], a: ai + 1, b: bi + 1 });
  }
  return out;
}

function lcsMiddle(a: string[], b: string[], offset: number): DiffLine[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = a[i..] 와 b[j..] 의 LCS 길이. 뒤에서부터 채워 앞에서 순서대로 걸어 나간다.
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: "same", text: a[i], a: offset + i + 1, b: offset + j + 1 });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      // 지움을 더함보다 먼저 둔다 — 「− 옛 줄 / + 새 줄」 순서가 읽기 쉽다.
      out.push({ op: "del", text: a[i], a: offset + i + 1 });
      i++;
    } else {
      out.push({ op: "add", text: b[j], b: offset + j + 1 });
      j++;
    }
  }
  for (; i < n; i++) out.push({ op: "del", text: a[i], a: offset + i + 1 });
  for (; j < m; j++) out.push({ op: "add", text: b[j], b: offset + j + 1 });
  return out;
}

/**
 * Changed hunks only, each padded with `context` unchanged lines on both sides.
 * 바뀐 곳 사이 같은 줄이 context × 2 이하이면 한 덩어리로 잇는다 — 끊긴 「⋯」가 한 줄을 가리는 일이 없게.
 */
export function diffHunks(before: string | null, after: string | null, context = 2): DiffHunk[] {
  const lines = diffLines(before, after);
  const hunks: DiffHunk[] = [];
  let start = -1;
  let end = -1;
  const flush = () => {
    if (start < 0) return;
    hunks.push({ lines: lines.slice(start, end + 1) });
    start = -1;
  };
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].op === "same") continue;
    const lo = Math.max(0, k - context);
    const hi = Math.min(lines.length - 1, k + context);
    if (start >= 0 && lo <= end + 1) {
      end = Math.max(end, hi);
    } else {
      flush();
      start = lo;
      end = hi;
    }
  }
  flush();
  return hunks;
}
