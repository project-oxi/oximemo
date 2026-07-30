/**
 * Markdown → HTML for card previews (§5).
 *
 * The card receives `note.preview` from the Rust `make_preview` helper
 * (already trimmed to a non-empty first 160 chars). We re-parse it here as
 * markdown and render the first block (up to `maxLen` chars) to HTML so
 * users see headings, lists, code spans, etc. in the grid.
 *
 * External input never reaches this function — note bodies are the user's
 * own typing — so `dangerouslySetInnerHTML` in Card.tsx is safe given
 * marked's default HTML escaping.
 */
import { marked } from "marked";

marked.setOptions({
  breaks: false,
  gfm: true,
});

/** Card preview HTML. First block only; truncated at `maxLen` chars. */
export function renderPreviewMarkdown(body: string, maxLen = 200): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  // First block: everything up to the first blank line.
  const firstBlock = trimmed.split(/\n\s*\n/, 1)[0];
  const head =
    firstBlock.length <= maxLen
      ? firstBlock
      : firstBlock.slice(0, maxLen).trimEnd() + "\u2026";
  return marked.parse(head, { async: false }) as string;
}
