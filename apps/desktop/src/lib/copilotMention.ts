/**
 * @-mention token parsing for the copilot composer (revision 2026-08-24).
 *
 * Value-based, never keydown-based: the trigger decision reads the draft
 * STRING at caret position, so IME composition (Korean ㅂ lives on the `/`
 * and `@` keys) can never half-fire — a token only exists once the composed
 * characters are actually in the value.
 *
 * Token model: `@` at a word start (beginning of text or after whitespace)
 * opens a token that runs to the caret, spaces included (note titles contain
 * spaces). A newline inside the token closes it — mentions are single-line.
 */

export interface MentionToken {
  /** Index of the "@" character in the draft. */
  start: number;
  /** Text between "@" and the caret (may contain spaces, never newlines). */
  query: string;
}

/** The mention token active at `caret`, or null when none is open. */
export function activeMentionToken(draft: string, caret: number): MentionToken | null {
  for (let p = caret - 1; p >= 0; p--) {
    const ch = draft[p];
    if (ch === "\n") return null; // a newline before any @ closes the search
    if (ch !== "@") continue;
    if (p > 0 && !/\s/.test(draft[p - 1])) continue; // mid-word @ (email etc.)
    const query = draft.slice(p + 1, caret);
    if (query.length === 0) return null; // caret right after @ — not open yet
    if (query.includes("\n")) return null;
    return { start: p, query };
  }
  return null;
}

/** Remove the `@token` (including the @) from the draft. */
export function stripMentionToken(draft: string, token: MentionToken): string {
  return draft.slice(0, token.start) + draft.slice(token.start + 1 + token.query.length);
}
