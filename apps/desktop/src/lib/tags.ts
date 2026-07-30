/**
 * Inline `#tag` extraction + highlight, mirroring `crates/oxinot-core/src/tags.rs`.
 * A `#` starts a tag only when NOT preceded by a Unicode letter/digit, so chord
 * symbols (`C#m7`) and markdown headings (`# Title`) never match. Extraction
 * normalizes (NFC + lowercase); highlighting preserves the body's display casing.
 * Keep this algorithm identical to the Rust scanner — the tests in both places
 * assert the same fixtures.
 */

const WORD = /[\p{L}\p{N}_]/u;

/** Normalized, lowercased, de-duplicated inline tags in first-occurrence order. */
export function extractTags(body: string): string[] {
  const chars = [...body]; // unicode code points
  const out: string[] = [];
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === "#") {
      const prevOk = i === 0 || !WORD.test(chars[i - 1]);
      if (prevOk) {
        const start = i + 1;
        let j = start;
        while (j < chars.length && WORD.test(chars[j])) j += 1;
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
      if (prevOk) {
        const start = i + 1;
        let j = start;
        while (j < chars.length && WORD.test(chars[j])) j += 1;
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
