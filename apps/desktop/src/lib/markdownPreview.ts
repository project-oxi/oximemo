/**
 * Markdown → preview surfaces (§5).
 *
 * The card receives `memo.preview` from the Rust `make_preview` helper
 * (non-empty trimmed lines joined by "\n", bounded by PREVIEW_MAX chars).
 * Two consumers:
 *  - renderPreviewMarkdown: grid Card HTML (headings, lists, code spans),
 *    DOMPurify-sanitized before `dangerouslySetInnerHTML` in Card.tsx —
 *    marked passes raw HTML through, and html notes can put arbitrary
 *    markup (incl. event handlers) into a preview line.
 *  - previewText: plain text with markers stripped and "\n" kept, for
 *    list/timeline/backlink rows rendered as text nodes.
 */
import DOMPurify from "dompurify";
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
  return DOMPurify.sanitize(marked.parse(collapseWikiLinks(raw), { async: false }) as string, {
    FORBID_TAGS: ["script", "iframe", "object", "embed", "style"],
    FORBID_ATTR: ["onerror", "onclick", "onload", "onmouseover", "onfocus"],
  });
}

/** Plain-text preview for list/timeline/backlink rows: markdown markers
 *  resolved away (headings, emphasis, code spans, list bullets) while the
 *  line breaks the user typed survive as real "\n" — rendered by the caller
 *  with `whitespace-pre-line`. */
export function previewText(body: string, maxLen = 200): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  const html = DOMPurify.sanitize(
    marked.parse(collapseWikiLinks(collapseQueryBlocks(trimmed)), { async: false }) as string,
    {
      FORBID_TAGS: ["script", "iframe", "object", "embed", "style"],
      FORBID_ATTR: ["onerror", "onclick", "onload", "onmouseover", "onfocus"],
    },
  );
  const doc = new DOMParser().parseFromString(html, "text/html");
  const text = elementText(doc.body)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
  const chars = [...text];
  if (chars.length <= maxLen) return text;
  return chars.slice(0, maxLen - 1).join("").trimEnd() + "\u2026";
}

/** Collapse ```query fenced blocks to a compact placeholder (spec §6). */
function collapseQueryBlocks(text: string): string {
  return text.replace(/```query[\s\S]*?```/g, "[쿼리]").replace(/```query[\s\S]*$/g, "[쿼리]");
}

/** Collapse wiki-link / embed syntax so a preview never shows raw memo
 *  UUIDs. Embed first (it contains a link), then bare, then labeled —
 *  shared by the HTML card renderer and the plain-text row renderer. */
function collapseWikiLinks(text: string): string {
  return text
    .replace(/!\[\[([^\]\n|]+)(?:\|[^\]\n|]+)?\]\]/g, "\u25A2 \uC784\uBCA0\uB4DC")
    .replace(/\[\[([^\]\n|]+)\]\]/g, "\u25C6")
    .replace(/\[\[([^\]\n|]+)\|([^\]\n|]+)\]\]/g, "$2");
}

/** Element → text with `<br>` and block boundaries as "\n". */
const BLOCK_TAGS = new Set([
  "P", "H1", "H2", "H3", "H4", "H5", "H6",
  "LI", "UL", "OL", "BLOCKQUOTE", "PRE", "DIV", "TABLE", "TR", "HR",
]);

function elementText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as Element;
  if (el.tagName === "BR") return "\n";
  let out = "";
  for (const child of el.childNodes) out += elementText(child);
  if (BLOCK_TAGS.has(el.tagName)) out += "\n";
  return out;
}
