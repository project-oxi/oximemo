import { tags as t } from "@lezer/highlight";
import { GFM, parser, type InlineContext, type Line, type MarkdownExtension, type MarkdownParser } from "@lezer/markdown";

// `==highlight==` follows the MIT-licensed Atomic Editor 0.6.2 grammar.
// Keep the established node names so its existing live-preview decorations
// continue to work while the grammar is shared with the document reader.
const HighlightDelim = { resolve: "Highlight", mark: "HighlightMark" };

function delimiterFlags(before: string, after: string) {
  const spacedBefore = /\s|^$/.test(before);
  const spacedAfter = /\s|^$/.test(after);
  const punctuation = /[\p{S}\p{P}]/u;
  const punctBefore = punctuation.test(before);
  const punctAfter = punctuation.test(after);
  return {
    canOpen: !spacedAfter && (!punctAfter || spacedBefore || punctBefore),
    canClose: !spacedBefore && (!punctBefore || spacedAfter || punctAfter),
  };
}

function parseHighlight(cx: InlineContext, next: number, pos: number): number {
  if (next !== 61 || cx.char(pos + 1) !== 61 || cx.char(pos - 1) === 61 || cx.char(pos + 2) === 61) return -1;
  const flags = delimiterFlags(cx.slice(pos - 1, pos), cx.slice(pos + 2, pos + 3));
  return cx.addDelimiter(HighlightDelim, pos, pos + 2, flags.canOpen, flags.canClose);
}

const highlightConfig = {
  defineNodes: [
    { name: "Highlight", style: t.special(t.content) },
    { name: "HighlightMark", style: t.processingInstruction },
  ],
  parseInline: [{ name: "Highlight", parse: parseHighlight, after: "Strikethrough" }],
} satisfies MarkdownExtension;

const gardenNodes = [
  { name: "GardenWikiLink", style: t.link },
  { name: "GardenWikiEmbed", style: t.link },
  { name: "GardenCalloutMarker", style: t.processingInstruction },
  { name: "GardenComment", block: true, style: t.comment },
  { name: "GardenMathInline", style: t.special(t.content) },
  { name: "GardenMathBlock", block: true, style: t.special(t.content) },
  { name: "GardenFootnoteReference", style: t.labelName },
  { name: "GardenFootnoteDefinition", block: true, style: t.labelName },
  { name: "GardenTag", style: t.atom },
  { name: "GardenBlockId", style: t.labelName },
] as const;

function escapedAt(cx: InlineContext, pos: number): boolean {
  let slashes = 0;
  for (let cursor = pos - 1; cursor >= cx.offset && cx.char(cursor) === 92; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function findUnescaped(text: string, needle: string, from: number): number {
  for (let found = text.indexOf(needle, from); found >= 0; found = text.indexOf(needle, found + needle.length)) {
    let slashes = 0;
    for (let cursor = found - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) slashes += 1;
    if (slashes % 2 === 0) return found;
  }
  return -1;
}

function parseGardenBracket(cx: InlineContext, next: number, pos: number): number {
  if (escapedAt(cx, pos)) return -1;

  // Footnotes must precede CommonMark's reference-link parser, which would
  // otherwise classify `[^label]` as an ordinary unresolved link.
  if (next === 91 && cx.char(pos + 1) === 94) {
    const end = cx.text.indexOf("]", pos - cx.offset + 2) + cx.offset;
    if (end > pos + 2 && /^[A-Za-z0-9_-]+$/.test(cx.slice(pos + 2, end))) {
      return cx.addElement(cx.elt("GardenFootnoteReference", pos, end + 1));
    }
  }

  let contentStart = -1;
  let nodeName = "GardenWikiLink";
  if (next === 33 && cx.char(pos + 1) === 91 && cx.char(pos + 2) === 91) {
    contentStart = pos + 3;
    nodeName = "GardenWikiEmbed";
  } else if (next === 91 && cx.char(pos + 1) === 91) {
    // `\![[target]]` is an escaped punctuation sequence followed by two
    // brackets. Do not turn its bracket tail into an embed or wiki link.
    if (cx.char(pos - 1) === 33 && escapedAt(cx, pos - 1)) return -1;
    contentStart = pos + 2;
  }

  if (contentStart >= 0) {
    const text = cx.text.slice(contentStart - cx.offset);
    const close = findUnescaped(text, "]]", 0);
    if (close < 0) return -1;
    const closeAt = contentStart + close;
    const content = cx.slice(contentStart, closeAt);
    if (!content.trim() || /\n/.test(content)) return -1;
    return cx.addElement(cx.elt(nodeName, pos, closeAt + 2));
  }

  // A callout marker is meaningful only under a Blockquote node. The inline
  // parser emits the marker independently; readers can check its parent so
  // `[!note]` in ordinary prose is not treated as a callout block.
  if (next === 91 && cx.char(pos + 1) === 33) {
    const end = cx.text.indexOf("]", pos - cx.offset + 2) + cx.offset;
    if (end > pos + 2 && /^[A-Za-z][A-Za-z0-9_-]*$/.test(cx.slice(pos + 2, end))) {
      return cx.addElement(cx.elt("GardenCalloutMarker", pos, end + 1));
    }
  }
  return -1;
}

function parseGardenInline(cx: InlineContext, next: number, pos: number): number {
  if (escapedAt(cx, pos)) return -1;

  if (next === 37 && cx.char(pos + 1) === 37) {
    const text = cx.text.slice(pos - cx.offset + 2);
    const close = findUnescaped(text, "%%", 0);
    if (close > 0) return cx.addElement(cx.elt("GardenComment", pos, pos + close + 4));
  }

  if (next === 36 && cx.char(pos + 1) !== 36 && cx.char(pos - 1) !== 36) {
    const lineEnd = cx.text.indexOf("\n", pos - cx.offset);
    const endOfLine = lineEnd < 0 ? cx.end : cx.offset + lineEnd;
    const close = findUnescaped(cx.slice(pos, endOfLine), "$", 1);
    if (close > 1) {
      const content = cx.slice(pos + 1, pos + close);
      const nextChar = cx.char(pos + close + 1);
      if (content.trim() && !/^\s|\s$/.test(content) && !/[\p{N}]/u.test(String.fromCharCode(nextChar))) {
        return cx.addElement(cx.elt("GardenMathInline", pos, pos + close + 1));
      }
    }
  }

  if (next === 35 && !escapedAt(cx, pos)) {
    const previous = cx.char(pos - 1);
    if (previous !== 35 && (pos === cx.offset || !/[\p{L}\p{N}_]/u.test(String.fromCharCode(previous)))) {
      const rest = cx.slice(pos + 1, cx.end);
      const match = /^[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*/u.exec(rest);
      if (match && /[\p{L}\p{N}]/u.test(match[0]) && !/[/-]$/.test(match[0])) {
        return cx.addElement(cx.elt("GardenTag", pos, pos + match[0].length + 1));
      }
    }
  }

  if (next === 94 && !escapedAt(cx, pos)) {
    const previous = cx.char(pos - 1);
    const hasBoundary = pos === cx.offset || /\s/.test(String.fromCharCode(previous));
    if (hasBoundary) {
      const match = /^\^([A-Za-z0-9-]+)/.exec(cx.slice(pos, cx.end));
      const end = match ? pos + match[0].length : pos;
      if (match && cx.slice(end, cx.end).trim() === "") {
        return cx.addElement(cx.elt("GardenBlockId", pos, end));
      }
    }
  }
  return -1;
}

function findBlockMathClose(line: string): number {
  const close = findUnescaped(line, "$$", 0);
  return close >= 0 && line.slice(close + 2).trim() === "" ? close : -1;
}

const gardenCompatConfig = {
  defineNodes: gardenNodes,
  parseBlock: [
    {
      name: "GardenFootnoteDefinition",
      before: "LinkReference",
      parse(cx, line) {
        if (cx.parentType().name === "FencedCode" || cx.parentType().name === "CodeBlock") return false;
        const match = /^\[\^([A-Za-z0-9_-]+)\]:/.exec(line.text.slice(line.pos));
        if (!match) return false;
        const from = cx.lineStart + line.pos;
        let to = cx.lineStart + line.text.length;
        while (cx.nextLine()) {
          if (line.text.length === 0) break;
          if (line.indent <= line.baseIndent) break;
          to = cx.lineStart + line.text.length;
        }
        cx.addElement(cx.elt("GardenFootnoteDefinition", from, to));
        return true;
      },
    },
    {
      name: "GardenComment",
      before: "FencedCode",
      parse(cx, line) {
        if (cx.parentType().name === "FencedCode" || cx.parentType().name === "CodeBlock") return false;
        if (line.text.slice(line.pos).trim() !== "%%") return false;
        const from = cx.lineStart + line.pos;
        let to = cx.lineStart + line.text.length;
        while (cx.nextLine()) {
          to = cx.lineStart + line.text.length;
          if (line.text.slice(line.pos).trim() === "%%") {
            cx.nextLine();
            break;
          }
        }
        cx.addElement(cx.elt("GardenComment", from, to));
        return true;
      },
    },
    {
      name: "GardenMathBlock",
      before: "FencedCode",
      parse(cx, line) {
        if (cx.parentType().name === "FencedCode" || cx.parentType().name === "CodeBlock") return false;
        const content = line.text.slice(line.pos);
        if (!content.startsWith("$$")) return false;
        const from = cx.lineStart + line.pos;
        const firstClose = findBlockMathClose(content.slice(2));
        let to = cx.lineStart + line.text.length;
        if (firstClose >= 0) {
          cx.nextLine();
        } else {
          while (cx.nextLine()) {
            to = cx.lineStart + line.text.length;
            const next = line.text.slice(line.pos);
            if (findBlockMathClose(next) >= 0) {
              cx.nextLine();
              break;
            }
          }
        }
        cx.addElement(cx.elt("GardenMathBlock", from, to));
        return true;
      },
    },
  ],
  parseInline: [
    { name: "GardenBracketSyntax", parse: parseGardenBracket, before: "Link" },
    { name: "GardenInlineSyntax", parse: parseGardenInline, before: "Link" },
  ],
} satisfies MarkdownExtension;

/**
 * Shared syntax foundation for Garden's CommonMark + GFM editor and reader.
 * The contract extensions add nodes without converting or normalizing source.
 * Document envelopes remain an editor-level concern and are not included here.
 */
export const gardenMarkdownConfig: MarkdownExtension = [GFM, highlightConfig, gardenCompatConfig];

/** A Lezer parser with the exact same grammar as `gardenMarkdownConfig`. */
export const gardenMarkdownParser: MarkdownParser = parser.configure(gardenMarkdownConfig);

export interface ParsedWikiTarget {
  target: string;
  alias: string | null;
  heading: string | null;
  blockId: string | null;
  embedded: boolean;
}

/** Parse a complete GardenWikiLink/GardenWikiEmbed source node without rewriting it. */
export function parseWikiTarget(rawSource: string): ParsedWikiTarget | null {
  const embedded = rawSource.startsWith("![[");
  const start = embedded ? 3 : rawSource.startsWith("[[") ? 2 : -1;
  if (start < 0 || !rawSource.endsWith("]]")) return null;
  const body = rawSource.slice(start, -2);
  const ordinaryAliasAt = findUnescaped(body, "|", 0);
  // Markdown tables require an escaped pipe in a cell. Treat this spelling
  // as the wiki alias separator when no ordinary separator is present.
  const escapedAliasAt = ordinaryAliasAt < 0 ? findSingleEscapedPipe(body) : -1;
  const aliasAt = ordinaryAliasAt >= 0 ? ordinaryAliasAt : escapedAliasAt;
  const targetEnd = escapedAliasAt >= 0 ? escapedAliasAt - 1 : aliasAt;
  const rawTarget = (aliasAt < 0 ? body : body.slice(0, targetEnd)).trim();
  const rawAlias = aliasAt < 0 ? null : body.slice(aliasAt + 1).trim();
  if (!rawTarget) return null;
  const target = rawTarget.replace(/\\([\\|#])/g, "$1");
  let heading: string | null = null;
  let blockId: string | null = null;
  const anchorAt = target.lastIndexOf("#");
  if (anchorAt >= 0) {
    const anchor = target.slice(anchorAt + 1);
    if (anchor.startsWith("^") && /^[A-Za-z0-9-]+$/.test(anchor.slice(1))) blockId = anchor.slice(1);
    else if (anchor) heading = anchor;
  }
  return {
    target,
    alias: rawAlias == null ? null : rawAlias.replace(/\\([\\|#])/g, "$1"),
    heading,
    blockId,
    embedded,
  };
}

function findSingleEscapedPipe(text: string): number {
  for (let index = text.indexOf("\\|"); index >= 0; index = text.indexOf("\\|", index + 2)) {
    let slashes = 0;
    for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) slashes += 1;
    if (slashes % 2 === 0) return index + 1;
  }
  return -1;
}
