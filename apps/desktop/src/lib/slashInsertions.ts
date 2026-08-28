/**
 * Slash-command insertion builders for the non-task groups — 날짜 /
 * 서식 / 링크 / 쿼리 / 템플릿 (tasks spec §8, Plan D Task 2).
 *
 * Every builder is pure: it takes the trigger line's indentation plus
 * whatever the command needs (today's ISO date, the clock, the folder
 * template body — all injected, never read from the environment) and
 * returns the exact text to insert with the indent applied to EVERY
 * line, and the caret offset inside that text. The catalog (Plan D
 * Task 3) closes over these builders; the 할 일 group is deliberately
 * absent here — its line transforms splice through `lib/taskLine.ts`
 * so there is exactly one task-line writer.
 *
 * Link builders mirror the app's real wiki grammar, not a generic
 * markdown guess: links are `[[Title]]` / `[[Title|label]]`
 * (`lib/wiki.ts` WIKI_RE; `lib/taskSuggest.ts` serializes completions
 * as `[[target|label]]`) and block embeds are `![[memo-id]]`
 * (`lib/embeds.ts`). The skeletons are the EMPTY forms of exactly
 * those shapes — the alias `|` is optional in the grammar, so nothing
 * is pre-typed; the caret sits inside the braces where the target
 * goes.
 *
 * Template bodies can legitimately contain fenced code blocks. A body
 * with a backtick run of 3+ is wrapped in a fence one longer than its
 * longest run (CommonMark's long-fence rule), so an inserted template
 * can never swallow or break the note's fence structure.
 */
import { shiftISODate } from "./dates";

/** What one slash command inserts: `text` is the exact replacement
 * for the `/query` token (each line prefixed with the trigger line's
 * indent) and `caret` the offset within `text` where the cursor lands
 * once inserted — e.g. inside the `[[ ]]` braces for link skeletons. */
export interface Insertion {
  text: string;
  caret: number;
}

/** Join `lines` with the indent on every line, placing the caret at
 * [line, column] translated into final-text coordinates. */
function build(
  indent: string,
  lines: string[],
  caretLine: number,
  caretCol: number,
): Insertion {
  const text = lines.map((l) => indent + l).join("\n");
  let caret = indent.length + caretCol;
  for (let i = 0; i < caretLine; i++) caret += indent.length + lines[i]!.length + 1;
  return { text, caret };
}

// --- 날짜 ---------------------------------------------------------------

/** 오늘/내일/어제: the local ISO date shifted by `deltaDays` (0/1/−1).
 * `today` is injected by the host (`todayLocalISO()`), keeping the
 * builder pure and midnight-stable. */
export function dateInsertion(indent: string, today: string, deltaDays: number): Insertion {
  return build(indent, [shiftISODate(today, deltaDays)], 0, 10);
}

/** 현재 시각: local `HH:mm` (24-hour, wall clock — never UTC). */
export function timeInsertion(indent: string, now: Date): Insertion {
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return build(indent, [hhmm], 0, hhmm.length);
}

// --- 서식 ---------------------------------------------------------------

/** 제목 1-3: `# `…`### ` with the caret after the space — the title
 * is typed next, no placeholder text (repo taste). */
export function headingInsertion(indent: string, level: 1 | 2 | 3): Insertion {
  const prefix = "#".repeat(level) + " ";
  return build(indent, [prefix], 0, prefix.length);
}

/** 표: a 2×2 GFM skeleton with the alignment row; the caret lands in
 * the first header cell, where typing continues. */
export function tableInsertion(indent: string): Insertion {
  return build(indent, ["|  |  |", "| --- | --- |", "|  |  |"], 0, 2);
}

/** 코드 블록: a bare ``` fence pair (no language, no placeholder)
 * with the caret on the empty line inside. */
export function codeBlockInsertion(indent: string): Insertion {
  return build(indent, ["```", "", "```"], 1, 0);
}

/** 인용: `> `. */
export function quoteInsertion(indent: string): Insertion {
  return build(indent, ["> "], 0, 2);
}

/** 구분선: `---`. */
export function ruleInsertion(indent: string): Insertion {
  return build(indent, ["---"], 0, 3);
}

// --- 링크 ---------------------------------------------------------------

/** 메모 링크: the empty `[[Title]]` form with the caret inside the
 * braces — the optional `|label` alias is typed, never pre-inserted
 * (`lib/wiki.ts` grammar; completions serialize `[[target|label]]`). */
export function memoLinkInsertion(indent: string): Insertion {
  return build(indent, ["[[]]"], 0, 2);
}

/** 메모 임베드: the empty `![[memo-id]]` block-embed form
 * (`lib/embeds.ts` grammar), caret inside the braces. */
export function memoEmbedInsertion(indent: string): Insertion {
  return build(indent, ["![[]]"], 0, 3);
}

/** 이미지: an image-embed skeleton with `.png` pre-suggested after
 * the caret — typing just the filename completes the wiki form. */
export function imageEmbedInsertion(indent: string): Insertion {
  return build(indent, ["![[.png]]"], 0, 3);
}

// --- 쿼리 ---------------------------------------------------------------

/** 쿼리 블록: a minimal ```query fence — one table view stub the user
 * edits into a real query. */
export function queryBlockInsertion(indent: string): Insertion {
  return build(indent, ["```query", "views:", "  - type: table", "```"], 3, 3);
}

/** 오늘의 할 일 블록: the spec §9 daily fence, byte-for-byte —
 * `this.file.name` (the daily note's ISO date) scopes due/scheduled,
 * open tasks only, one `오늘` tasks view. */
export function dailyTasksBlockInsertion(indent: string): Insertion {
  return build(
    indent,
    [
      "```query",
      "source: tasks",
      "filters:",
      "  and:",
      "    - 'task.type != \"DONE\" && task.type != \"CANCELLED\"'",
      "    - '(task.due != null && task.due <= this.file.name) || (task.scheduled != null && task.scheduled <= this.file.name)'",
      "views:",
      "  - { type: tasks, name: 오늘 }",
      "```",
    ],
    8,
    3,
  );
}

// --- 템플릿 -------------------------------------------------------------

/** Longest backtick run anywhere in `s` (0 when none). */
function longestBacktickRun(s: string): number {
  let best = 0;
  let run = 0;
  for (const ch of s) {
    run = ch === "`" ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

/** 폴더 템플릿 삽입: the folder's TEMPLATE.md body verbatim (trailing
 * newlines stripped), indent on every line, caret at the end. A body
 * containing a fence run (3+ backticks) is wrapped in a fence one
 * longer than its longest run so the inserted block cannot break the
 * note's fence structure; inline code (shorter runs) never triggers
 * wrapping. A `null` body hides the command upstream — the builder
 * itself is total on strings. */
export function templateInsertion(indent: string, body: string): Insertion {
  const content = body.replace(/\n+$/, "");
  if (content === "") return { text: "", caret: 0 };
  const run = longestBacktickRun(content);
  const lines =
    run >= 3
      ? ["`".repeat(run + 1), ...content.split("\n"), "`".repeat(run + 1)]
      : content.split("\n");
  return build(indent, lines, lines.length - 1, lines[lines.length - 1]!.length);
}
