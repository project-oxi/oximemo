/**
 * Backlink context line for the immersive margin (2026-11-11 «MarginLinks»).
 *
 * 백링크 미리보기는 그 노트 본문 앞부분이라, 제목 아래에 그대로 두면 「왜 이 노트가
 * 나를 가리키는지」가 안 보인다. 미리보기 안에 이 노트로 가는 위키 링크가 있으면
 * 그 줄을 맥락으로 쓰고, 없으면(링크가 미리보기 범위 밖) 호출부가 첫 줄로 물러선다.
 *
 * DOM 없이 도는 순수 함수로 둔다 — markdown → 글자 변환(previewText)은 호출부가 한다.
 */

const WIKI_LINK_RE = /!?\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g;

/** `Title#heading` · `Title^block` → `title` (대소문자 무시 비교용). */
function linkKey(target: string): string {
  return target.split(/[#^]/, 1)[0].trim().toLowerCase();
}

/**
 * First line of `preview` that wiki-links to one of `targets`, with every
 * wiki link rewritten to its visible text (label, else target) so the
 * preview renderer does not collapse it to a bare glyph. `null` when no
 * line links here.
 */
export function backlinkContextLine(preview: string, targets: readonly string[]): string | null {
  const keys = new Set(targets.map(linkKey).filter(Boolean));
  if (keys.size === 0) return null;
  for (const line of preview.split("\n")) {
    let hit = false;
    for (const m of line.matchAll(WIKI_LINK_RE)) {
      if (keys.has(linkKey(m[1]))) {
        hit = true;
        break;
      }
    }
    if (!hit) continue;
    const text = line.replace(WIKI_LINK_RE, (_m, target: string, label?: string) => (label ?? target).trim()).trim();
    if (text) return text;
  }
  return null;
}

/** Frontmatter `aliases` as a list — Obsidian accepts a list or one string. */
export function aliasList(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) => (typeof v === "string" && v.trim() ? [v.trim()] : []));
}
