/**
 * Inline `#tag` extraction + highlight, mirroring `crates/oximemo-core/src/tags.rs`.
 * A `#` starts a tag only when NOT preceded by a Unicode letter/digit, so chord
 * symbols (`C#m7`) and markdown headings (`# Title`) never match. Extraction
 * normalizes (NFC + lowercase); highlighting preserves the body's display casing.
 * Keep this algorithm identical to the Rust scanner — the tests in both places
 * assert the same fixtures.
 */

const WORD = /[\p{L}\p{N}_]/u;

export function isTagChar(c: string): boolean {
  return WORD.test(c) || c === "-" || c === "/";
}

/** Normalized, lowercased, de-duplicated inline tags in first-occurrence order. */
export function extractTags(body: string): string[] {
  const chars = [...body]; // unicode code points
  const out: string[] = [];
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === "#") {
      const prevOk = i === 0 || !WORD.test(chars[i - 1]);
      if (prevOk && WORD.test(chars[i + 1] ?? "")) {
        const start = i + 1;
        let j = start;
        while (j < chars.length && isTagChar(chars[j])) j += 1;
        if (j > start) {
          const token = chars.slice(start, j).join("");
          const norm = token.normalize("NFC").toLowerCase();
          if (!out.includes(norm)) out.push(norm);
        }
        i = j;
        continue;
      }
    }
    i += 1;
  }
  return out;
}

export type TagSegment = { text: string; tag: boolean };

/** Split body into plain / `#tag` segments for the mirror highlighter.
 *  `tag` segments carry the raw display text INCLUDING the leading `#`. */
export function highlightTags(body: string): TagSegment[] {
  const chars = [...body];
  const segs: TagSegment[] = [];
  let buf = "";
  const flush = () => {
    if (buf) {
      segs.push({ text: buf, tag: false });
      buf = "";
    }
  };
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === "#") {
      const prevOk = i === 0 || !WORD.test(chars[i - 1]);
      if (prevOk && WORD.test(chars[i + 1] ?? "")) {
        const start = i + 1;
        let j = start;
        while (j < chars.length && isTagChar(chars[j])) j += 1;
        if (j > start) {
          flush();
          segs.push({ text: "#" + chars.slice(start, j).join(""), tag: true });
          i = j;
          continue;
        }
      }
    }
    buf += chars[i];
    i += 1;
  }
  flush();
  return segs;
}

/**
 * Union of stored envelope tags with tags derived from the current draft.
 * Stored entries come first with their spelling and order preserved
 * verbatim; derived entries append in first-occurrence order. Dedupe
 * compares NFC forms case-sensitively — the envelope stores exact labels,
 * so a derived `foo` never absorbs a stored `Foo`.
 */
export function mergeTags(stored: readonly string[], derived: readonly string[]): string[] {
  const out = [...stored];
  const seen = new Set(stored.map((tag) => tag.normalize("NFC")));
  for (const tag of derived) {
    const norm = tag.normalize("NFC");
    if (!seen.has(norm)) {
      seen.add(norm);
      out.push(tag);
    }
  }
  return out;
}

/** Block elements emit a separator so adjacent content never glues two
 *  tags together — the same set markdownPreview's elementText uses. */
const HTML_BLOCK_TAGS: Record<string, true> = {
  P: true, H1: true, H2: true, H3: true, H4: true, H5: true, H6: true,
  LI: true, UL: true, OL: true, BLOCKQUOTE: true, PRE: true, DIV: true,
  TABLE: true, TR: true, HR: true, BR: true,
};

/** textContent with block boundaries as separators (markdownPreview's
 *  elementText pattern). Comments contribute nothing; script/style are
 *  dropped so their contents never masquerade as tags. */
function templateText(node: Node): string {
  let out = "";
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      out += child.textContent ?? "";
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as Element;
      if (el.tagName === "SCRIPT" || el.tagName === "STYLE") continue;
      out += templateText(el);
      if (el.tagName in HTML_BLOCK_TAGS) out += "\n";
    }
  }
  return out;
}

/**
 * Tags derived from a note body, mirroring the backend's `tags_of`:
 * markdown scans the source directly (`extractTags`); HTML parses through
 * an inert `<template>` (parsed contents are never attached to the
 * document) and scans the stripped text, so attribute hashes
 * (`href="#anchor"`, `color:#fff`) never become tags. The HTML path needs
 * a DOM — browser/webview UI only; importing this module stays safe under
 * Bun as long as callers keep to the markdown path.
 */
export function bodyTags(body: string, format: "markdown" | "html" = "markdown"): string[] {
  if (format !== "html") return extractTags(body);
  if (typeof document === "undefined") {
    throw new Error("bodyTags(format: 'html') needs a DOM; Bun callers must stay on the markdown path");
  }
  const template = document.createElement("template");
  template.innerHTML = body;
  return extractTags(templateText(template.content));
}
