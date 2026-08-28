/**
 * Slash-command trigger predicate (tasks spec §8, Plan D Task 1).
 *
 * Pure `slashTriggerAt(doc, pos)`: is the caret inside a live "/query"
 * token, and if so where does it start? One implementation of the
 * code-context guards — the fence walk and the inline-code toggle are
 * imported from `lib/taskSuggest.ts` (Plan C) so task auto-suggest and
 * the slash menu go silent in exactly the same places.
 *
 * The menu itself (catalog, rendering, apply) lives in later Plan D
 * tasks; this module only decides WHEN the menu is armed.
 */
import { caretInFencedCodeBlock, caretInsideInlineCode } from "./taskSuggest";

/** A live trigger: `from` is the doc offset of the '/' itself — pickers
 *  replace `[from, caret)` with the chosen command — and `query` is the
 *  text between the '/' and the caret (same line, no whitespace). */
export interface SlashTrigger {
  from: number;
  query: string;
}

/** Leading indent width in columns: spaces count 1, tabs 4 (the same
 *  convention as `taskCheckboxes`' widget padding and CommonMark's
 *  indented-code-block rule). */
function leadingIndentColumns(raw: string): number {
  let col = 0;
  for (const ch of raw) {
    if (ch === " ") col += 1;
    else if (ch === "\t") col += 4;
    else break;
  }
  return col;
}

/** Active iff, walking the caret's line left from the caret:
 *  - the first non-whitespace-hit character is a '/' whose predecessor
 *    is line-start or whitespace (a '/' mid-word never triggers, and a
 *    '/' followed by whitespace — a dismissed menu — is skipped past),
 *  - the text from that '/' to the caret is whitespace-free (so a query
 *    spanning a newline or containing a space disarms), and
 *  - the caret is not in fenced code (```/~~~, opener and closer lines
 *    count), on an indented-code line (≥4 leading columns), or inside
 *    an inline-code span on the line.
 *
 * CRLF-aware: the raw line is trimmed of its trailing '\r' before the
 * scans, and a caret parked on the line terminator is treated as
 * end-of-line. */
export function slashTriggerAt(doc: string, pos: number): SlashTrigger | null {
  if (!Number.isInteger(pos) || pos < 0 || pos > doc.length) return null;
  // The line containing pos. A caret sitting ON the '\n' is still on
  // that line (end-of-line); a '\r' just before it is line text only
  // for the scans below, never part of the query.
  const lineStart = doc.lastIndexOf("\n", pos - 1) + 1;
  const nl = doc.indexOf("\n", pos);
  const rawLine = doc.slice(lineStart, nl === -1 ? doc.length : nl);
  const caret = pos - lineStart;
  // Find the nearest '/' with an unbroken run to the caret.
  let slash = -1;
  for (let i = caret - 1; i >= 0; i--) {
    const ch = rawLine[i]!;
    if (/\s/.test(ch)) return null; // whitespace first: dismissed or spanning
    if (ch === "/") {
      slash = i;
      break;
    }
  }
  if (slash === -1) return null;
  // The '/' must open a word: line start or after whitespace.
  if (slash > 0 && !/\s/.test(rawLine[slash - 1]!)) return null;
  // Code contexts — the same guards the task auto-suggest uses.
  if (caretInFencedCodeBlock(doc.slice(0, pos), pos)) return null;
  if (leadingIndentColumns(rawLine) >= 4) return null;
  if (caretInsideInlineCode(rawLine, caret)) return null;
  return { from: lineStart + slash, query: rawLine.slice(slash + 1, caret) };
}
