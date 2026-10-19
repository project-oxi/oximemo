import DOMPurify from "dompurify";
import { Marked } from "marked";

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]!);

// This reader has no vault link/asset resolver yet. Keep their labels readable
// without handing URLs to WKWebView or fetching remote resources on open.
const markdown = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    html: ({ text }) => escapeHtml(text),
    link({ tokens }) { return `<span>${this.parser.parseInline(tokens)}</span>`; },
    image: ({ text, href }) => `<span class="markdown-attachment">[첨부: ${escapeHtml(text || href)}]</span>`,
  },
});

/** A derived, inert preview. Never serialize its DOM back into note source. */
export function renderMarkdown(body: string): string {
  return DOMPurify.sanitize(markdown.parse(body, { async: false }), {
    ALLOWED_TAGS: [
      "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6",
      "hr", "input", "li", "ol", "p", "pre", "span", "strong", "table", "tbody", "td", "th", "thead", "tr", "ul",
    ],
    ALLOWED_ATTR: ["class", "checked", "disabled", "type", "start"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
}
