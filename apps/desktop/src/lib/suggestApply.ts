/**
 * Pure append helpers for the AI suggestion strip (goal 2026-10-25). Both
 * add exactly one final line so applies stay readable diffs through the
 * editor's guarded autosave, and both return `null` when the suggestion is
 * already in the body — the strip renders null results as applied instead
 * of writing a duplicate.
 */
import { extractTags } from "./tags";

/** Append `#tag` on its own final line (`bodies are LF-normalized`).
 *  `null` when the body already carries that tag token — checked via
 *  `extractTags`, so the match uses the same NFC + lowercase normalization
 *  the app applies when reading tags back out of a note. */
export function appendTag(body: string, tag: string): string | null {
  const clean = tag.trim();
  if (!clean) return null;
  if (extractTags(body).includes(clean.normalize("NFC").toLowerCase())) return null;
  return `${body.replace(/\n*$/, "")}\n#${clean}`;
}

/** Append a `[[title]]` final line; `null` when that exact link text is
 *  already present anywhere in the body. */
export function appendLink(body: string, title: string): string | null {
  const clean = title.trim();
  if (!clean) return null;
  const link = `[[${clean}]]`;
  if (body.includes(link)) return null;
  return `${body.replace(/\n*$/, "")}\n${link}`;
}
