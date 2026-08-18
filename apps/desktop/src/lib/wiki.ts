/** Wiki-link helpers — parses `[[Title]]` and `[[Title|alias]]` syntax. */

const WIKI_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

export interface WikiLink {
  target: string;
  label: string;
}

/** Extract all wiki links from a markdown body. */
export function extractLinks(body: string): WikiLink[] {
  const out: WikiLink[] = [];
  for (const m of body.matchAll(WIKI_RE)) {
    out.push({ target: m[1].trim(), label: (m[2] ?? m[1]).trim() });
  }
  return out;
}

/** True if the body contains any wiki links. */
export function hasLinks(body: string): boolean {
  return WIKI_RE.test(body);
}