/** Locate one authored image reference near the clicked CodeMirror position. */
export function imageReferenceAt(doc: string, name: string, anchor: number, ordinal = 0) {
  const re = /!\[[^\]\n]*\]\(oximg:\/\/localhost\/([^\s)#]+)(?:#w=\d+)?\)/g;
  const matches = [...doc.matchAll(re)]
    .filter((m) => m[1] === name)
    .map((m) => ({ from: m.index, to: m.index + m[0].length, text: m[0] }));
  if (!matches.length) return null;
  const lineStart = doc.lastIndexOf("\n", Math.max(0, anchor - 1)) + 1;
  const sameLine = matches.filter((m) => m.from >= lineStart && m.to <= anchor);
  if (sameLine.length > 1 && sameLine[ordinal]) return sameLine[ordinal];
  return matches.find((m) => anchor >= m.from && anchor <= m.to)
    ?? matches.reduce((best, m) => Math.abs(m.from - anchor) < Math.abs(best.from - anchor) ? m : best);
}

export function resizedImageReference(reference: string, width: number) {
  return reference.replace(/(?:#w=\d+)?\)$/, `${width > 0 ? `#w=${Math.round(width)}` : ""})`);
}
