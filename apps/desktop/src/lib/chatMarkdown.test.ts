import { expect, test } from "bun:test";

import DOMPurify from "dompurify";
import { renderChatMarkdown, renderChatMarkdownHtml } from "./chatMarkdown";

test("renders markdown and wraps code blocks with copy chrome", () => {
  const html = renderChatMarkdownHtml("# 제목\n\n- a\n- b\n\n```rust\nfn x() {}\n```", "복사");
  expect(html).toContain("<h1>제목</h1>");
  expect(html).toContain("<li>a</li>");
  expect(html).toContain('class="chat-code"');
  expect(html).toContain('data-lang="rust"');
  expect(html).toContain("fn x() {}");
  expect(html).toContain("복사");
});

test("escapes html inside code blocks", () => {
  const html = renderChatMarkdownHtml("```\n<b>bold</b>\n```", "Copy");
  expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
});

test("does not hard-break single newlines (chat semantics)", () => {
  const html = renderChatMarkdownHtml("line one\nline two", "Copy");
  expect(html).not.toContain("<br>");
});

// DOMPurify needs a real DOM; bun's test runtime has none. The sanitize
// boundary runs in the browser (smoke) and matches markdownPreview's config.
const canSanitize = typeof DOMPurify.sanitize === "function";

(test.skipIf(!canSanitize))("strips scripts and event handlers", () => {
  const html = renderChatMarkdown(
    '<script>alert(1)</script>\n\nx <img src=x onerror=alert(1)>',
    "Copy",
  );
  expect(html).not.toContain("<script");
  expect(html).not.toContain("onerror");
});
