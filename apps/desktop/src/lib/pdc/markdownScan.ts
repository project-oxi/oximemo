/**
 * `pdc-markdown/1` body scanning — the TypeScript mirror of
 * `crates/oxi-frontmatter/src/pdc/markdown.rs` (PDC 2 §6.1, §7.2, §11).
 *
 * Lexical Stage 0 gate: caret block IDs (`^` + `[A-Za-z0-9-]+`) and
 * raw-HTML `id="b-<uuid>"` targets are collected for duplicate
 * detection, active constructs (`<script>`, event handlers,
 * `javascript:`/`vbscript:` URLs) are `unsafe_content`, and any other
 * raw HTML only flags preview-unsafety while the source stays
 * canonical. Fenced code blocks are opaque; a fence whose info string
 * is exactly `base` carries a `pdc-query/1` block this scanner never
 * interprets.
 */

export interface MarkdownScan {
  blockIds: string[];
  hasRawHtml: boolean;
  unsafeFound: boolean;
  queryFences: number;
}

/** Unsafe elements shared with the HTML body scan (PDC 2 §11). */
const UNSAFE_ELEMENTS: Record<string, true> = {
  script: true,
  iframe: true,
  object: true,
  embed: true,
  applet: true,
  base: true,
  link: true,
};

const UNSAFE_URL_RE = /^(?:javascript|vbscript):/i;
const EVENT_ATTR_RE = /^on[a-z]+$/i;

export function scanMarkdownBody(body: string): MarkdownScan {
  const scan: MarkdownScan = { blockIds: [], hasRawHtml: false, unsafeFound: false, queryFences: 0 };
  let fence: { char: string; len: number } | null = null;
  for (const line of body.split("\n")) {
    if (fence) {
      if (isFenceClose(line, fence.char, fence.len)) fence = null;
      continue; // fence contents are opaque, including `base` queries
    }
    const open = fenceOpen(line);
    if (open) {
      if (open.info === "base") scan.queryFences += 1;
      fence = { char: open.char, len: open.len };
      continue;
    }
    scanLine(line, scan);
  }
  return scan;
}

/** Opening fenced code block: up to three spaces of indentation, at
 * least three fence characters, no backtick in a backtick info string. */
function fenceOpen(line: string): { char: string; len: number; info: string } | null {
  const indent = line.length - line.trimStart().length;
  if (indent > 3) return null;
  const rest = line.slice(indent);
  const char = rest[0];
  if (char !== "`" && char !== "~") return null;
  let run = 0;
  while (rest[run] === char) run += 1;
  if (run < 3) return null;
  const info = rest.slice(run).trim();
  if (char === "`" && info.includes("`")) return null;
  return { char, len: run, info };
}

/** Closing fence: same character, at least the opening run length. */
function isFenceClose(line: string, char: string, openLen: number): boolean {
  const indent = line.length - line.trimStart().length;
  if (indent > 3) return false;
  const rest = line.slice(indent);
  let run = 0;
  while (rest[run] === char) run += 1;
  return run >= openLen && rest.slice(run).trim().length === 0;
}

function scanLine(line: string, scan: MarkdownScan): void {
  const visible = stripInlineCode(line);
  const caretId = caretIdOfLine(visible);
  if (caretId) scan.blockIds.push(caretId);
  scanRawHtml(visible, scan);
}

/** Remove inline code span contents so code samples never contribute
 * block IDs or raw HTML (unmatched backtick runs are literal text). */
function stripInlineCode(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] === "`") {
      let run = 0;
      while (line[i + run] === "`") run += 1;
      const close = findBacktickRun(line, i + run, run);
      if (close === -1) {
        out += line.slice(i);
        break;
      }
      i = close;
    } else {
      out += line[i];
      i += 1;
    }
  }
  return out;
}

function findBacktickRun(text: string, from: number, len: number): number {
  let i = from;
  while (i + len <= text.length) {
    if (text.slice(i, i + len) === "`".repeat(len) && text[i + len] !== "`") return i + len;
    i += 1;
  }
  return -1;
}

/** The trailing caret block ID of a line, `^` + `[A-Za-z0-9-]+`
 * (PDC 2 §7.2), when the last whitespace-separated token is one. */
function caretIdOfLine(visible: string): string | null {
  const tokens = visible.trimEnd().split(/\s+/);
  const token = tokens[tokens.length - 1];
  if (!token || !token.startsWith("^")) return null;
  const id = token.slice(1);
  if (id.length === 0 || !/^[A-Za-z0-9-]+$/.test(id)) return null;
  return id;
}

function scanRawHtml(visible: string, scan: MarkdownScan): void {
  let i = 0;
  while (i < visible.length) {
    if (visible[i] !== "<") {
      i += 1;
      continue;
    }
    const next = visible[i + 1];
    if (next === undefined) return;
    if (next !== "/" && next !== "!" && !/[a-zA-Z]/.test(next)) {
      i += 1;
      continue;
    }
    if (/[a-zA-Z]/.test(next)) {
      // An autolink is `<scheme:` with no space before the colon;
      // consume it whole so its `>` is not treated as a tag end.
      let schemeLen = 0;
      while (schemeLen < next.length + 1) {
        const ch = visible[i + 1 + schemeLen];
        if (ch === undefined || !/[A-Za-z0-9.+-]/.test(ch)) break;
        schemeLen += 1;
      }
      if (visible[i + 1 + schemeLen] === ":") {
        const close = visible.indexOf(">", i + 1);
        if (close === -1) return;
        i = close + 1;
        continue;
      }
    }
    // Tag-like raw HTML: classify up to the closing `>` of this tag.
    scan.hasRawHtml = true;
    const end = tagEnd(visible, i);
    scanMarkdownTag(visible.slice(i + 1, Math.min(end, visible.length)), scan);
    if (end >= visible.length) return;
    i = end + 1;
  }
}

function tagEnd(text: string, open: number): number {
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  return text.length;
}

/** Classify one raw tag's inner text: unsafe elements, event handlers,
 * unsafe URL schemes, and `id="b-<uuid>"` targets. */
function scanMarkdownTag(tag: string, scan: MarkdownScan): void {
  const nameEnd = tag.search(/[\s/>]/) === -1 ? tag.length : tag.search(/[\s/>]/);
  const name = tag.slice(0, nameEnd).toLowerCase();
  if (UNSAFE_ELEMENTS[name]) scan.unsafeFound = true;
  let rest = tag.slice(nameEnd);
  while (rest.length > 0) {
    rest = rest.trimStart();
    if (rest.length === 0) break;
    const attrEnd = rest.search(/[\s=]/) === -1 ? rest.length : rest.search(/[\s=]/);
    const attr = rest.slice(0, attrEnd).toLowerCase();
    rest = rest.slice(attrEnd);
    let value = "";
    if (rest.startsWith("=")) {
      rest = rest.slice(1).trimStart();
      const quote = rest[0];
      if (quote === '"' || quote === "'") {
        const close = rest.indexOf(quote, 1);
        value = close === -1 ? rest.slice(1) : rest.slice(1, close);
        rest = close === -1 ? "" : rest.slice(close + 1);
      } else {
        const end = rest.search(/\s/) === -1 ? rest.length : rest.search(/\s/);
        value = rest.slice(0, end);
        rest = rest.slice(end);
      }
    }
    if (attr === "id" && /^b-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
      scan.blockIds.push(value.slice(2));
    }
    if (EVENT_ATTR_RE.test(attr)) scan.unsafeFound = true;
    if (["href", "src", "action", "formaction", "xlink:href"].includes(attr) && UNSAFE_URL_RE.test(value.trim())) {
      scan.unsafeFound = true;
    }
  }
}
