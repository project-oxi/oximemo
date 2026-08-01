/**
 * Markdown → HTML for card previews (§5).
 *
 * The card receives `memo.preview` from the Rust `make_preview` helper
 * (already trimmed to a non-empty first 160 chars). We re-parse it here as
 * markdown and render the first block (up to `maxLen` chars) to HTML so
 * users see headings, lists, code spans, etc. in the grid.
 *
 * External input never reaches this function — memo bodies are the user's
 * own typing — so `dangerouslySetInnerHTML` in Card.tsx is safe given
 * marked's default HTML escaping.
 */
import { marked } from "marked";

marked.setOptions({
  // Render single newlines as <br> so the card preview keeps the line breaks
  // the user typed (make_preview now preserves them as "\n").
  breaks: true,
  gfm: true,
});

/** Card preview HTML. First block only; truncated at `maxLen` chars. */
export function renderPreviewMarkdown(body: string, maxLen = 200): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  // First block: everything up to the first blank line.
  const firstBlock = trimmed.split(/\n\s*\n/, 1)[0];
  const raw =
    firstBlock.length <= maxLen
      ? firstBlock
      : firstBlock.slice(0, maxLen).trimEnd() + "\u2026";
  // Collapse wiki-link / embed syntax so the card preview never shows raw
  // memo UUIDs. Embed first (it contains a link), then labeled, then bare.
  const head = raw
    .replace(/!\[\[([^\]\n|]+)(?:\|[^\]\n|]+)?\]\]/g, "▢ 임베드")
    .replace(/\[\[([^\]\n|]+)\|([^\]\n|]+)\]\]/g, "$2")
    .replace(/\[\[([^\]\n|]+)\]\]/g, "◆");
  return marked.parse(head, { async: false }) as string;
}
