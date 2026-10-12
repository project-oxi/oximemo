import type { Text } from "@codemirror/state";

export function fragmentPosition(doc: Text, fragment: string): number | null {
  const target = fragment.replace(/^\^/, "").trim().toLocaleLowerCase();
  if (!target) return 0;
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line.text)?.[1];
    if (fragment.startsWith("^")) {
      if (new RegExp(`\\^${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`, "i").test(line.text)) return line.from;
    } else if (heading) {
      const label = heading.toLocaleLowerCase();
      const slug = label.replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, "-");
      if (label === target || slug === target) return line.from;
    }
  }
  return null;
}
