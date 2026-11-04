import { expect, test } from "bun:test";
import { strFromU8, unzipSync } from "fflate";
import { buildEpub } from "./writingEpub";

test("packages ordered EPUB chapters with a stored mimetype and localized navigation", () => {
  const bytes = buildEpub("한글 & 책", [
    { title: "제2장 <도입>", markdown: "첫 문장." },
    { title: "제1장", markdown: "둘째 문장." },
  ], "ko");
  const header = new DataView(bytes.buffer, bytes.byteOffset);
  expect(header.getUint32(0, true)).toBe(0x04034b50);
  expect(header.getUint16(8, true)).toBe(0);
  expect(header.getUint16(26, true)).toBe(8);
  expect(header.getUint16(28, true)).toBe(0);
  expect(strFromU8(bytes.subarray(30, 58))).toBe("mimetypeapplication/epub+zip");

  const files = unzipSync(bytes);
  const read = (path: string) => strFromU8(files[path]);
  expect(read("META-INF/container.xml")).toContain('full-path="EPUB/book.opf"');
  expect(read("EPUB/book.opf")).toContain("<dc:title>한글 &amp; 책</dc:title>");
  expect(read("EPUB/book.opf")).toMatch(/<spine><itemref idref="chapter-1" \/>\s*<itemref idref="chapter-2" \/><\/spine>/);
  const nav = read("EPUB/nav.xhtml");
  expect(nav).toContain('<nav epub:type="toc"><h1>목차</h1>');
  expect(nav).toMatch(/chapter-1\.xhtml">제2장 &lt;도입&gt;<\/a><\/li>\s*<li><a href="chapter-2\.xhtml">제1장/);
  expect(read("EPUB/chapter-1.xhtml")).toContain("<p>첫 문장.</p>");
  expect(read("EPUB/chapter-2.xhtml")).toContain("<p>둘째 문장.</p>");
});

test("emits inert XHTML and readable image, task and code fallbacks", () => {
  const markdown = [
    'Start <code>< & _test_</code> &#0; &nbsp; &_custom; &',
    '![alt <&>](https://example.test/image.png) [link](javascript:alert%281%29)',
    '<script src="https://example.test/script.js">alert(1)</script>',
    '- [x] checked\n- [ ] open',
    '```html\n<img src="https://example.test/code.png">\n```',
    '---',
    'soft  \nline',
  ].join("\n\n");
  const bytes = buildEpub("Book", [{ title: "Chapter", markdown }], "en");
  const chapter = strFromU8(unzipSync(bytes)["EPUB/chapter-1.xhtml"]);
  expect(chapter).toContain("&lt;code&gt;&lt; &amp;");
  expect(chapter).toContain("� &amp;nbsp; &amp;_custom; &amp;");
  expect(chapter).toContain("[Image: alt &lt;&amp;&gt;] link");
  expect(chapter).toContain("☑ checked");
  expect(chapter).toContain("☐ open");
  expect(chapter).toContain("<pre><code>&lt;img");
  expect(chapter).toContain("<hr />");
  expect(chapter).toContain("soft<br />line");
  expect(chapter).not.toMatch(/<(?:script|img|iframe|input|a)\b|\s(?:src|onerror)="/);
});

test("keeps later private comments out when an earlier comment contains a fence", () => {
  const markdown = "%%\n```js\nx\n```%%\n본문.\n\n%% 비공개 %%";
  const bytes = buildEpub("책", [{ title: "장", markdown }], "ko");
  const chapter = strFromU8(unzipSync(bytes)["EPUB/chapter-1.xhtml"]);
  expect(chapter).toContain("본문.");
  expect(chapter).not.toContain("비공개");
  expect(() => buildEpub("책", [{ title: "장", markdown: "본문. %% 비공개" }], "ko")).toThrow("Unclosed manuscript comment");
});

test("resolves reference links across chapters from the same source", () => {
  const bytes = buildEpub("책", [
    { title: "앞 장", sourceId: "novel", markdown: "[자료]: https://example.test/source\n\n[도움][자료]" },
    { title: "뒤 장", sourceId: "novel", markdown: "자세한 내용은 [증언][자료] 참조." },
  ], "ko");
  const files = unzipSync(bytes);
  const read = (path: string) => strFromU8(files[path]);
  expect(read("EPUB/chapter-1.xhtml")).toContain("<p>도움</p>");
  expect(read("EPUB/chapter-2.xhtml")).toContain("<p>자세한 내용은 증언 참조.</p>");
});

test("keeps reference definitions within their source and chapter boundaries", () => {
  const bytes = buildEpub("책", [
    { title: "앞 장", sourceId: "novel-a", markdown: "```md\n[자료]: https://example.test/source" },
    { title: "뒤 장", sourceId: "novel-a", markdown: "[증언][자료]" },
    { title: "다른 작품", sourceId: "novel-b", markdown: "[다른 증언][자료]" },
  ], "ko");
  const files = unzipSync(bytes);
  const read = (path: string) => strFromU8(files[path]);
  expect(read("EPUB/chapter-1.xhtml")).toContain("<pre><code>[자료]: https://example.test/source</code></pre>");
  expect(read("EPUB/chapter-2.xhtml")).toContain("<p>[증언][자료]</p>");
  expect(read("EPUB/chapter-3.xhtml")).toContain("<p>[다른 증언][자료]</p>");
});
