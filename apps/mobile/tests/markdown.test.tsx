import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { act, useState } from "react";
import { canPreviewMarkdown } from "../src/lib/presentation";
import type { Document } from "../src/types";
import { dom } from "./dom";

const { createRoot } = await import("react-dom/client");
const { renderMarkdown } = await import("../src/lib/markdown");
const { NoteEditor } = await import("../src/components/NoteEditor");

const fragment = (body: string) => JSDOM.fragment(renderMarkdown(body));
const note = (body = "# 제목\n\n**본문**"): Document => ({
  key: "note", attempted: false,
  entry: { path: "note.md", class: "document", deleted: false, broken_document_links: [], missing_assets: [] },
  source: { path: "note.md", content: `exact envelope\n${body}`, editable_body: body, body_profile: "pdc-markdown/1", sha256: "original-digest" },
});

describe("mobile Markdown preview", () => {
  test("renders CommonMark and GFM structure with inert task states", () => {
    const result = fragment('# Heading\n\n**Bold** *emphasis* ~~removed~~ `inline`\n\n> Quote\n\n- Parent\n  - Child\n\n3. Third\n\n- [ ] Open\n- [x] Done\n- [/] Custom\n\n| Column | Value |\n| --- | --- |\n| A | B |\n\n```ts\nconst x = 1;\n```');
    expect(result.querySelector("h1")?.textContent).toBe("Heading");
    expect(result.querySelector("strong")?.textContent).toBe("Bold");
    expect(result.querySelector("em")?.textContent).toBe("emphasis");
    expect(result.querySelector("del")?.textContent).toBe("removed");
    expect(result.querySelector("blockquote")?.textContent).toContain("Quote");
    expect(result.querySelector("ul ul li")?.textContent).toBe("Child");
    expect(result.querySelector("ol")?.getAttribute("start")).toBe("3");
    expect(result.querySelectorAll("th")).toHaveLength(2);
    expect(result.querySelector("pre code.language-ts")?.textContent).toBe("const x = 1;\n");
    const tasks = Array.from(result.querySelectorAll("input"));
    expect(tasks).toHaveLength(2);
    expect(tasks.every(task => task.type === "checkbox" && task.disabled)).toBe(true);
    expect(tasks.map(task => task.checked)).toEqual([false, true]);
    expect(result.textContent).toContain("[/] Custom");
  });

  test("keeps HTML, links, and all resource URLs inert while retaining readable content", () => {
    const source = '<script>window.bad = true</script>\n\n<img src="https://tracker.test/pixel" onerror="alert(1)">\n\n<iframe srcdoc="bad"></iframe><input autofocus><style>body{display:none}</style>\n\n[Bad](javascript:alert%281%29) [Local](file:///private/test) [Note](pdc://document/id) [Relative](../note.md) [Web](https://example.test)\n\n![Diagram](https://tracker.test/image)\n\n![Data](data:image/svg+xml,bad)\n\n<b>raw HTML</b>';
    const result = fragment(source);
    expect(result.querySelector("script, img, iframe, style, input, a, form, svg")).toBeNull();
    expect(result.querySelector("[href], [src], [srcdoc], [style], [onerror], [autofocus]")).toBeNull();
    expect(result.textContent).toContain("window.bad = true");
    for (const label of ["Bad", "Local", "Note", "Relative", "Web"]) expect(result.textContent).toContain(label);
    expect(result.querySelectorAll(".markdown-reference")).toHaveLength(5);
    expect(result.textContent).toContain("첨부 · Diagram");
    expect(result.textContent).toContain("<b>raw HTML</b>");
  });

  test("reads the pinned PDC 2 r2 semantics fixture without changing source or executing queries", () => {
    const corpusRoot = new URL("../../desktop/src/lib/pdc/corpus-v2/", import.meta.url);
    const corpus = JSON.parse(readFileSync(new URL("corpus.json", corpusRoot), "utf8"));
    expect([corpus.format, corpus.revision]).toEqual(["pdc-document-conformance/2", 2]);
    const source = readFileSync(new URL("fixtures/valid/semantics.md", corpusRoot), "utf8");
    const body = source.slice(source.indexOf("\n---\n") + 5);
    const original = body;
    const result = fragment(body);
    expect(result.querySelector("h1")?.textContent).toBe("Semantic v2 document");
    expect(result.querySelector("pre code.language-base")?.textContent).toContain("tags.contains");
    expect(result.querySelectorAll("input:disabled")).toHaveLength(2);
    expect(result.textContent).toContain("Wiki link to the minimal document");
    expect(result.textContent).toContain("%%source comment%%");
    expect(result.textContent).toContain("Inline math $a^2 + b^2 = c^2$");
    expect(result.textContent).toContain("^b-018f47c6-7dbe-7a14-9f67-6f89a5e3cc32");
    expect(result.querySelector("a, img, script")).toBeNull();
    expect(body).toBe(original);
    expect(readFileSync(new URL("fixtures/valid/semantics.md", corpusRoot), "utf8")).toBe(source);
  });

  test("only previews known Markdown and keeps other classifications in source fallback", () => {
    expect(canPreviewMarkdown(note(""))).toBe(true);
    const legacy = note(); legacy.entry!.class = "legacy_markdown";
    legacy.source = { path: "note.md", content: "# Legacy", sha256: "original" };
    expect(canPreviewMarkdown(legacy)).toBe(true);
    for (const classification of ["invalid", "unsupported", "query", "legacy_document", "legacy_html"]) {
      expect(canPreviewMarkdown({ ...legacy, entry: { ...legacy.entry!, class: classification } })).toBe(false);
    }
    const html = note(); html.source!.body_profile = "pdc-html/1";
    expect(canPreviewMarkdown(html)).toBe(false);
  });
});

let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.replaceChildren(); });
const click = async (label: string) => {
  const button = Array.from(document.querySelectorAll("button")).find(button => button.textContent === label)!;
  expect(button).toBeTruthy();
  await act(async () => button.click());
};

describe("mobile reading and editing", () => {
  test("opens in reading mode and preserves exact edits across preview and file-source switches", async () => {
    const original = note("# 제목\n\n**본문**\n\n%% comment %%\n");
    const snapshot = structuredClone(original);
    function Editor() {
      const [body, setBody] = useState(original.source!.editable_body!);
      const [raw, setRaw] = useState(false);
      const [editing, setEditing] = useState(false);
      return <><button onClick={() => setEditing(true)}>편집</button><NoteEditor document={original} isNew={false} editing={editing} onEditing={setEditing} title="제목" body={body} profile="pdc-markdown/1" raw={raw} editable={!raw} busy={false} dirty={body !== original.source!.editable_body} onTitle={() => {}} onBody={setBody} onProfile={() => {}} onRaw={setRaw} onRetry={() => {}} onResolve={() => {}} onFocus={() => {}}/></>;
    }
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(<Editor/>));
    expect(document.querySelector("article strong")?.textContent).toBe("본문");
    expect(document.querySelector('textarea[aria-label="메모 본문"]')).toBeNull();
    await click("파일 원문");
    expect((document.querySelector('textarea[aria-label="파일 원문"]') as HTMLTextAreaElement).value).toBe(original.source!.content);
    await click("본문");
    await click("편집");
    const field = document.querySelector('textarea[aria-label="메모 본문"]') as HTMLTextAreaElement;
    expect(field.value).toBe(original.source!.editable_body!);
    const edited = `${field.value}\n- [x] 수정한 내용\n`;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(field, edited);
      field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await click("미리보기");
    expect(document.querySelector('input[type="checkbox"]:checked:disabled')).not.toBeNull();
    await click("편집");
    expect((document.querySelector('textarea[aria-label="메모 본문"]') as HTMLTextAreaElement).value).toBe(edited);
    expect(original).toEqual(snapshot);
  });

  test("new drafts start in the source editor; read-only notes retain a readable preview", async () => {
    const original = note();
    const props = { initialScroll: 0, onScroll() {}, document: original, isNew: true, editing: true, onEditing() {}, title: "제목", body: "**본문**", profile: "pdc-markdown/1", raw: false, editable: true, busy: false, dirty: false, onTitle() {}, onBody() {}, onProfile() {}, onRaw() {}, onRetry() {}, onResolve() {}, onFocus() {} };
    root = createRoot(document.body.appendChild(document.createElement("div")));
    await act(async () => root!.render(<NoteEditor {...props}/>));
    expect(document.querySelector('textarea[aria-label="메모 본문"]')).not.toBeNull();
    const readOnly = (editing: boolean) => <NoteEditor key="read-only" {...props} isNew={false} editable={false} editing={editing} onEditing={value => { root!.render(readOnly(value)); }}/>;
    await act(async () => root!.render(readOnly(false)));
    expect(document.querySelector("article strong")?.textContent).toBe("본문");
    await click("마크다운 원문");
    expect((document.querySelector('textarea[aria-label="메모 본문"]') as HTMLTextAreaElement).readOnly).toBe(true);
  });
});

describe("mobile reading presentation", () => {
  test("preserves table alignment, code escaping and inert controls", () => {
    const html = fragment('| 왼쪽 | 가운데 | 오른쪽 |\n| :--- | :---: | ---: |\n| A | B | 100 |\n\n```html\n<script>alert(1)</script>\n```');
    expect(html.querySelector('th.align-center')?.textContent).toBe('가운데');
    expect(html.querySelector('td.align-right')?.textContent).toBe('100');
    expect(html.querySelector('.markdown-table')?.getAttribute('tabindex')).toBe('0');
    expect(html.querySelector('pre code')?.textContent).toBe('<script>alert(1)</script>\n');
    expect(html.querySelector('script')).toBeNull();
    expect(html.querySelector('button.markdown-copy')?.getAttribute('type')).toBe('button');
  });

  test("renders callouts and highlights without interpreting code or raw HTML", () => {
    const html = fragment('> [!tip] 작은 팁\n> ==중요한 **내용**==을 읽으세요.\n\n`==코드==`\n\n<script>bad()</script>');
    expect(html.querySelector('.markdown-callout-title')?.textContent).toBe('작은 팁');
    expect(html.querySelector('mark strong')?.textContent).toBe('내용');
    expect(html.querySelector('code')?.textContent).toBe('==코드==');
    expect(html.querySelectorAll('mark')).toHaveLength(1);
    expect(html.querySelector('script')).toBeNull();
  });

  test("only hides a real repeated leading H1, including a final unterminated line", async () => {
    const { MarkdownPreview } = await import('../src/components/MarkdownPreview');
    root = createRoot(document.body.appendChild(document.createElement('div')));
    await act(async () => root!.render(<MarkdownPreview body="# 제목" title="제목"/>));
    expect(document.querySelector('article h1')).toBeNull();
    await act(async () => root!.render(<MarkdownPreview body={"    # 제목\n"} title="제목"/>));
    expect(document.querySelector('pre code')?.textContent).toBe('# 제목\n');
  });

  test("code copy reports clipboard success and failure truthfully", async () => {
    const { MarkdownPreview } = await import('../src/components/MarkdownPreview');
    let copied = '';
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { copied = value; } } });
    root = createRoot(document.body.appendChild(document.createElement('div')));
    await act(async () => root!.render(<MarkdownPreview body={'```ts\nconst value = "<safe>";\n```'}/>));
    await click('복사');
    expect(copied).toBe('const value = "<safe>";\n');
    expect(document.querySelector('[role="status"]')?.textContent).toBe('코드를 복사했어요.');
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied'); } } });
    await click('복사됨');
    expect(document.querySelector('.markdown-copy')?.textContent).toBe('복사 실패');
    expect(document.querySelector('[role="status"]')?.textContent).toContain('복사하지 못했어요');
    Reflect.deleteProperty(window.navigator, 'clipboard');
  });
});
