import DOMPurify from "dompurify";
import { Marked, Renderer } from "marked";

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]!);

const baseRenderer = new Renderer();

// References are inert buttons. Only an explicit click reaches the host resolver.
const markdown = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    html: ({ text }) => escapeHtml(text),
    link({ tokens, href }) { return `<button type="button" class="markdown-reference" title="${escapeHtml(href)}">${this.parser.parseInline(tokens)}<span class="markdown-reference-kind"> · 링크</span></button>`; },
    code({ text, lang }) {
      const language = lang?.split(/\s/)[0] || "";
      return `<figure class="markdown-code"><figcaption><span>${escapeHtml(language || "코드")}</span><button type="button" class="markdown-copy" aria-label="코드 복사">복사</button></figcaption><pre tabindex="0" aria-label="코드 내용"><code${language ? ` class="language-${escapeHtml(language)}"` : ""}>${escapeHtml(text.replace(/\n$/, ""))}\n</code></pre></figure>`;
    },
    table(token) {
      return `<div class="markdown-table" tabindex="0" role="region" aria-label="표, 가로로 스크롤할 수 있음">${baseRenderer.table.call(this, token)}</div>`;
    },
    tablecell({ tokens, header, align }) {
      const tag = header ? "th" : "td";
      return `<${tag}${align ? ` class="align-${align}"` : ""}>${this.parser.parseInline(tokens)}</${tag}>`;
    },
    blockquote({ text, tokens }) {
      const callout = text.match(/^\[!([a-z]+)\][+-]?(?:[ \t]+([^\n]*))?(?:\n|$)/i);
      if (!callout) return `<blockquote>${this.parser.parse(tokens)}</blockquote>`;
      const labels: Record<string, string> = { note: "메모", tip: "팁", info: "안내", warning: "주의", important: "중요" };
      const label = callout[2] || labels[callout[1].toLowerCase()] || callout[1];
      const rest = this.parser.parse(markdown.lexer(text.slice(callout[0].length)));
      return `<blockquote class="markdown-callout"><p class="markdown-callout-title">${escapeHtml(label)}</p>${rest}</blockquote>`;
    },
    image: ({ text, href }) => `<button type="button" class="markdown-attachment" title="${escapeHtml(href)}">첨부 · ${escapeHtml(text || href)}</button>`,
  },
  extensions: [{
    name: "wiki", level: "inline",
    start: source => source.indexOf("[["),
    tokenizer(source) {
      const match = source.match(/^(!?)\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/);
      if (match) return { type: "wiki", raw: match[0], target: match[2], text: match[3] || match[2], embed: !!match[1] };
    },
    renderer(token) {
      const attachment = token.embed && /\.(?!md(?:#|$)|html(?:#|$)|djot(?:#|$))[a-z0-9]+$/i.test(String(token.target));
      return `<button type="button" class="${attachment ? "markdown-attachment" : "markdown-reference"}" title="wiki:${escapeHtml(String(token.target))}">${escapeHtml(token.text)}${token.embed ? " · 첨부" : " · 링크"}</button>`;
    },
  }, {
    name: "highlight", level: "inline",
    start: source => source.indexOf("=="),
    tokenizer(source) {
      const match = source.match(/^==([^=\n](?:[^\n]*?[^=\n])?)==/);
      if (match) return { type: "highlight", raw: match[0], text: match[1], tokens: this.lexer.inlineTokens(match[1]) };
    },
    renderer(token) { return `<mark>${this.parser.parseInline(token.tokens || [])}</mark>`; },
  }],
});

/** A derived, inert preview. Never serialize its DOM back into note source. */
export function renderMarkdown(body: string): string {
  return DOMPurify.sanitize(markdown.parse(body, { async: false }), {
    ALLOWED_TAGS: [
      "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6",
      "hr", "input", "li", "div", "figure", "figcaption", "button", "mark", "ol", "p", "pre", "span", "strong", "table", "tbody", "td", "th", "thead", "tr", "ul",
    ],
    ALLOWED_ATTR: ["class", "checked", "disabled", "type", "start", "title", "tabindex", "role", "aria-label"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
}
