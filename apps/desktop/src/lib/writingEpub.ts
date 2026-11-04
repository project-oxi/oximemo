import { invoke, isTauri } from "@tauri-apps/api/core";
import { strToU8, zipSync, type Zippable } from "fflate";
import { Marked, Tokenizer } from "marked";
import { projectWritingComments } from "./writingComments";
import { dict as en } from "./locales/en";
import { dict as ko } from "./locales/ko";

export type BookChapter = { title: string; markdown: string; sourceId?: string };

type BookLanguage = "ko" | "en";

const EPUB_MIME = "application/epub+zip";
const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';
const INVALID_XML_CHAR = /[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;

const BOOK_COPY = { ko, en };

const STYLES = `
body { margin: 5%; line-height: 1.65; font-family: serif; overflow-wrap: break-word; }
h1, h2, h3, h4, h5, h6 { line-height: 1.3; break-after: avoid; }
h1 { font-size: 1.65em; margin: 0 0 1em; }
p { margin: 0 0 0.85em; orphans: 2; widows: 2; }
blockquote { margin: 1em 0; padding-left: 1em; border-left: 0.15em solid; }
pre { white-space: pre-wrap; }
table { border-collapse: collapse; max-width: 100%; }
th, td { padding: 0.25em 0.4em; border: 0.06em solid; text-align: left; }
.align-center { text-align: center; }
.align-right { text-align: right; }
`;

function xmlText(value: string): string {
  return value.replace(INVALID_XML_CHAR, "\uFFFD")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

// Marked accepts HTML entities. XML recognizes only five named entities,
// and numeric references to forbidden XML characters also need a fallback.
function xmlEntities(html: string): string {
  return html.replace(/&(?:(#(?:[xX][\da-fA-F]+|\d+)|\w+);)?/g, (entity, name?: string) => {
    if (!name) return "&amp;";
    if (["amp", "lt", "gt", "quot", "apos"].includes(name)) return entity;
    if (name.startsWith("#")) {
      const value = Number(name.replace(/^#[xX]/, "0x").replace(/^#/, ""));
      if (value > 0x10ffff) return "\uFFFD";
      return xmlText(String.fromCodePoint(value));
    }
    return `&amp;${name};`;
  });
}

function chapterParser(language: BookLanguage): Marked {
  return new Marked({
    gfm: true,
    breaks: false,
    tokenizer: {
      inlineText(src) {
        // Marked otherwise leaves text inside authored <pre>, <code> and
        // <script> tags unescaped, even with an inert HTML renderer.
        const inRawBlock = this.lexer.state.inRawBlock;
        this.lexer.state.inRawBlock = false;
        const token = Tokenizer.prototype.inlineText.call(this, src);
        this.lexer.state.inRawBlock = inRawBlock;
        return token;
      },
    },
    renderer: {
      html({ text, block }) { return block ? `<pre>${xmlText(text)}</pre>\n` : xmlText(text); },
      code({ text }) { return `<pre><code>${xmlText(text)}</code></pre>\n`; },
      link({ tokens }) { return this.parser.parseInline(tokens); },
      image({ text }) {
        const label = xmlText(BOOK_COPY[language].writing_epub_image);
        return text.trim() ? `[${label}: ${text}]` : `[${label}]`;
      },
      heading({ depth, tokens }) {
        const level = Math.min(depth + 1, 6);
        return `<h${level}>${this.parser.parseInline(tokens)}</h${level}>\n`;
      },
      tablecell({ align, header, tokens }) {
        const tag = header ? "th" : "td";
        const alignment = align === "center" || align === "right" ? ` class="align-${align}"` : "";
        return `<${tag}${alignment}>${this.parser.parseInline(tokens)}</${tag}>\n`;
      },
      checkbox({ checked }) { return checked ? "☑" : "☐"; },
      hr() { return "<hr />\n"; },
      br() { return "<br />"; },
    },
  });
}

function xhtml(title: string, body: string, language: BookLanguage): Uint8Array {
  return strToU8(`${XML_DECL}
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${language}" lang="${language}">
<head><title>${title}</title><link rel="stylesheet" href="book.css" /></head>
<body>${body}</body>
</html>`);
}

function publicationId(): string {
  // getRandomValues also works in webviews without a secure-context UUID API.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function buildEpub(title: string, chapters: readonly BookChapter[], language: BookLanguage): Uint8Array {
  if (!chapters.length) throw new RangeError("An EPUB needs at least one chapter");

  const { writing_epub_untitled: untitled, writing_epub_contents: contentsLabel } = BOOK_COPY[language];
  const bookTitle = xmlText(title.trim() || untitled);
  const contents = xmlText(contentsLabel);
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const parser = chapterParser(language);
  const publications = chapters.map((chapter) => {
    const publication = projectWritingComments(chapter.markdown.replace(/\r\n?/g, "\n"));
    if (publication.unclosed) throw new Error("Unclosed manuscript comment");
    const markdown = publication.text.replace(INVALID_XML_CHAR, "\uFFFD");
    return { sourceId: chapter.sourceId, markdown, tokens: parser.lexer(markdown) };
  });
  const referencesBySource = new Map<string | undefined, ReturnType<Marked["lexer"]>["links"]>();
  for (const publication of publications) {
    let references = referencesBySource.get(publication.sourceId);
    if (!references) {
      references = Object.create(null) as ReturnType<Marked["lexer"]>["links"];
      referencesBySource.set(publication.sourceId, references);
    }
    for (const [label, definition] of Object.entries(publication.tokens.links)) {
      if (!(label in references)) references[label] = definition;
    }
  }
  for (const publication of publications) {
    const lexer = new parser.Lexer(parser.defaults);
    lexer.tokens.links = referencesBySource.get(publication.sourceId)!;
    publication.tokens = lexer.lex(publication.markdown);
  }
  const manifest: string[] = [];
  const spine: string[] = [];
  const toc: string[] = [];
  const files: Zippable = {
    // The EPUB OCF container requires this exact, uncompressed first entry.
    mimetype: [strToU8(EPUB_MIME), { level: 0 }],
    "META-INF/container.xml": strToU8(`${XML_DECL}
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="EPUB/book.opf" media-type="application/oebps-package+xml" /></rootfiles>
</container>`),
    "EPUB/book.css": strToU8(STYLES),
  };

  chapters.forEach((chapter, index) => {
    const id = `chapter-${index + 1}`;
    const href = `${id}.xhtml`;
    const heading = xmlText(chapter.title.trim() || untitled);
    const publication = publications[index];
    const rendered = parser.parser(publication.tokens, { ...parser.defaults, async: false });
    files[`EPUB/${href}`] = xhtml(heading, `<section epub:type="chapter"><h1>${heading}</h1>\n${xmlEntities(rendered)}</section>`, language);
    manifest.push(`<item id="${id}" href="${href}" media-type="application/xhtml+xml" />`);
    spine.push(`<itemref idref="${id}" />`);
    toc.push(`<li><a href="${href}">${heading}</a></li>`);
  });

  files["EPUB/nav.xhtml"] = xhtml(contents, `<nav epub:type="toc"><h1>${contents}</h1><ol>${toc.join("\n")}</ol></nav>`, language);
  files["EPUB/book.opf"] = strToU8(`${XML_DECL}
<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0" unique-identifier="book-id" xml:lang="${language}">
  <metadata>
    <dc:identifier id="book-id">${publicationId()}</dc:identifier>
    <dc:title>${bookTitle}</dc:title>
    <dc:language>${language}</dc:language>
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
    <item id="style" href="book.css" media-type="text/css" />
    ${manifest.join("\n    ")}
  </manifest>
  <spine>${spine.join("\n    ")}</spine>
</package>`);

  return zipSync(files);
}

function epubFileName(title: string): string {
  const cleaned = title.replace(INVALID_XML_CHAR, "\uFFFD")
    .replace(/[<>:"/\\|?*\p{Cc}\s]+/gu, " ").replace(/^[ .]+|[ .]+$/g, "");
  const stem = [...cleaned.replace(/\.epub$/i, "")].slice(0, 55).join("").trimEnd();
  const name = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(stem) ? `_${stem}` : stem;
  return `${name || "book"}.epub`;
}

export async function saveEpub(title: string, chapters: readonly BookChapter[], language: BookLanguage): Promise<boolean> {
  const bytes = buildEpub(title, chapters, language);
  const fileName = epubFileName(title);
  if (isTauri()) {
    // Base64 travels through both Tauri IPC transports, including the
    // WebView postMessage fallback for blocked custom protocols.
    let binary = "";
    for (let start = 0; start < bytes.length; start += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
    }
    return invoke<boolean>("save_writing_epub", { fileName, base64Data: btoa(binary) });
  }

  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: EPUB_MIME }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Safari may start the download after the click handler returns.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
  return true;
}
