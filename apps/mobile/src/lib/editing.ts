/** Textarea offsets are LF-based. Keep untouched source terminators verbatim. */
export const displayBody = (source: string) => source.replace(/\r\n?/g, "\n");
export function sourceOffset(source: string, offset: number): number {
  let index = 0;
  for (let count = 0; count < offset && index < source.length; count++, index++) {
    if (source[index] === "\r" && source[index + 1] === "\n") index++;
  }
  return index;
}
export function preserveInput(source: string, next: string): string {
  const previous = displayBody(source);
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) start++;
  let end = previous.length, nextEnd = next.length;
  while (end > start && nextEnd > start && previous[end - 1] === next[nextEnd - 1]) { end--; nextEnd--; }
  return source.slice(0, sourceOffset(source, start)) + next.slice(start, nextEnd) + source.slice(sourceOffset(source, end));
}
export type Edit = { body: string; start: number; end: number };
export type Format = "bold" | "italic" | "heading" | "bullet" | "checklist" | "quote";
const replace = (source: string, start: number, end: number, replacement: string): string =>
  source.slice(0, sourceOffset(source, start)) + replacement + source.slice(sourceOffset(source, end));

export function formatBody(source: string, start: number, end: number, format: Format): Edit {
  const text = displayBody(source);
  if (format === "bold" || format === "italic") {
    const marker = format === "bold" ? "**" : "*";
    const selected = source.slice(sourceOffset(source, start), sourceOffset(source, end));
    if (start >= marker.length && text.slice(start - marker.length, start) === marker && text.slice(end, end + marker.length) === marker) {
      return { body: replace(source, start - marker.length, end + marker.length, selected), start: start - marker.length, end: end - marker.length };
    }
    return { body: replace(source, start, end, marker + selected + marker), start: start + marker.length, end: end + marker.length };
  }
  const lineStart = (start === 0 ? 0 : text.lastIndexOf("\n", start - 1) + 1);
  // A selection ending at the next line's start does not include that line.
  const last = end > start && text[end - 1] === "\n" ? end - 1 : end;
  const nextBreak = text.indexOf("\n", last);
  const lineEnd = nextBreak < 0 ? text.length : nextBreak;
  const chunk = source.slice(sourceOffset(source, lineStart), sourceOffset(source, lineEnd));
  const prefix = { heading: "## ", bullet: "- ", checklist: "- [ ] ", quote: "> " }[format];
  const lines = chunk.split(/(\r\n|\r|\n)/);
  const remove = lines.filter((_, i) => i % 2 === 0).every(line => line.startsWith(prefix));
  const changed = lines.map((line, i) => i % 2 ? line : remove ? line.slice(prefix.length) : prefix + line).join("");
  const body = replace(source, lineStart, lineEnd, changed);
  const delta = remove ? -prefix.length : prefix.length;
  return start === end
    ? { body, start: Math.max(lineStart, start + delta), end: Math.max(lineStart, end + delta) }
    : { body, start: lineStart, end: lineStart + displayBody(changed).length };
}

/** Explicit Enter action only; never reinterpret custom task states or code. */
export function continueList(source: string, start: number, end: number): Edit | undefined {
  if (start !== end) return;
  const text = displayBody(source);
  const lineStart = (start === 0 ? 0 : text.lastIndexOf("\n", start - 1) + 1);
  if (text.indexOf("\n", start) !== start && start !== text.length) return;
  let fence: { marker: string; length: number } | undefined;
  for (const line of text.slice(0, lineStart).split("\n")) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!match) continue;
    if (!fence) fence = { marker: match[1][0], length: match[1].length };
    else if (match[1][0] === fence.marker && match[1].length >= fence.length && !match[2].trim()) fence = undefined;
  }
  if (fence) return;
  const match = text.slice(lineStart, start).match(/^( {0,3})([-+*]|\d+[.)]) (?:\[([ xX])\] )?(.*)$/);
  if (!match || /^\[[^ xX]\]/.test(match[4])) return;
  const [, indent, marker, task, content] = match;
  if (!content.trim()) return { body: replace(source, lineStart, start, ""), start: lineStart, end: lineStart };
  const nextMarker = /^\d/.test(marker) ? `${Number.parseInt(marker) + 1}${marker.slice(-1)}` : marker;
  const newline = source.slice(sourceOffset(source, start)).startsWith("\r\n") ? "\r\n" : "\n";
  const insert = `${newline}${indent}${nextMarker} ${task === undefined ? "" : "[ ] "}`;
  const cursor = start + displayBody(insert).length;
  return { body: replace(source, start, end, insert), start: cursor, end: cursor };
}
