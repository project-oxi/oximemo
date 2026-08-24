/**
 * Agent-response markdown for the copilot panel (revision 2026-08-24).
 *
 * oxios/omp answers are markdown; until now they rendered as flat
 * whitespace-pre-wrap text. This module reuses the app's marked+DOMPurify
 * pipeline (markdownPreview.ts) with chat semantics:
 *  - `breaks: false` — agents emit proper markdown; hard-wrapping single
 *    newlines into <br> would mangle their paragraphs.
 *  - fenced code blocks get a language bar with a copy button; the button
 *    is styled/labelled by the caller's CSS and locale, and copying reads
 *    the sibling <code> textContent at click time (no payload duplication
 *    into attributes).
 *  - sanitize config matches markdownPreview (FORBID script/iframe/…).
 *
 * A fresh `Marked` instance per call keeps the shared preview options
 * (breaks:true) untouched and captures the locale-dependent copy label in
 * the renderer closure.
 */
import DOMPurify from "dompurify";
import { Marked } from "marked";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Marked render with the code-block chrome, unsanitized. Exported for
 * unit tests (bun's test runtime has no DOM, so the DOMPurify wrapper
 * cannot execute there); production callers use `renderChatMarkdown`. */
export function renderChatMarkdownHtml(text: string, copyLabel: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const marked = new Marked({
    gfm: true,
    breaks: false,
    renderer: {
      code({ text, lang }: { text: string; lang?: string }): string {
        const language = (lang ?? "").trim().split(/\s+/)[0] ?? "";
        return (
          `<div class="chat-code"${language ? ` data-lang="${escapeHtml(language)}"` : ""}>` +
          `<div class="chat-code-bar"><span>${escapeHtml(language || "text")}</span>` +
          `<button type="button" class="chat-code-copy">${escapeHtml(copyLabel)}</button>` +
          `</div><pre><code>${escapeHtml(text)}</code></pre></div>`
        );
      },
    },
  });
  return marked.parse(trimmed, { async: false }) as string;
}

/** Sanitized chat markdown — the only production entry point. */
export function renderChatMarkdown(text: string, copyLabel: string): string {
  const html = renderChatMarkdownHtml(text, copyLabel);
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ["script", "iframe", "object", "embed", "style"],
    FORBID_ATTR: ["onerror", "onclick", "onload", "onmouseover", "onfocus"],
  });
}
