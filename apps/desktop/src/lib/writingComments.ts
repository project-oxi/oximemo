import { markdownLanguage } from "@codemirror/lang-markdown";

const CODE_NODES = new Set(["InlineCode", "FencedCode", "CodeBlock"]);

// Older editors could append the planning heading inside an open code fence.
export function hasFencedWritingNotes(source: string): boolean {
  if (!/집필 노트|writing notes/iu.test(source)) return false;
  let found = false;
  markdownLanguage.parser.parse(source).iterate({
    enter(node) {
      if (found) return false;
      if (node.name !== "FencedCode") return;
      if (node.node.getChildren("CodeMark").length === 1) {
        found = /^[ \t]*##[ \t]+(?:집필 노트|writing notes)[ \t]*#*[ \t]*$/imu.test(source.slice(node.from, node.to));
      }
      return false;
    },
  });
  return found;
}

function escapedAt(source: string, index: number): boolean {
  let slashes = 0;
  while (source[index - slashes - 1] === "\\") slashes++;
  return slashes % 2 === 1;
}

/** Omit source-only comments from a publication projection. Keep physical
 * lines for editor navigation, and preserve delimiters inside literal code. */
export function projectWritingComments(source: string): { text: string; unclosed: boolean } {
  if (!source.includes("%%") && !source.includes("<!--")) return { text: source, unclosed: false };
  const code: { from: number; to: number }[] = [];
  markdownLanguage.parser.parse(source).iterate({
    enter(node) {
      if (!CODE_NODES.has(node.name)) return;
      code.push({ from: node.from, to: node.to });
      return false;
    },
  });

  let previous = 0;
  let codeIndex = 0;
  let unclosed = false;
  const chunks: string[] = [];
  const markers = /%%|<!--/gu;
  for (let match = markers.exec(source); match; match = markers.exec(source)) {
    const from = match.index;
    if (escapedAt(source, from)) continue;
    while (code[codeIndex] && code[codeIndex].to <= from) codeIndex++;
    if (code[codeIndex]?.from <= from && from < code[codeIndex].to) continue;
    const markdown = match[0] === "%%";
    const closer = markdown ? /%%/gu : /--!?>/gu;
    closer.lastIndex = markers.lastIndex;
    let closingMarker = closer.exec(source);
    while (markdown && closingMarker && escapedAt(source, closingMarker.index)) {
      closingMarker = closer.exec(source);
    }
    const to = closingMarker ? closer.lastIndex : source.length;
    unclosed = closingMarker === null;
    chunks.push(source.slice(previous, from), source.slice(from, to).replace(/[^\n]/g, ""));
    previous = to;
    markers.lastIndex = to;
    // Fences opened inside a removed comment cannot protect later text.
    while (code[codeIndex] && code[codeIndex].from < to) codeIndex++;
  }
  if (!previous) return { text: source, unclosed: false };
  return { text: chunks.join("") + source.slice(previous), unclosed };
}
