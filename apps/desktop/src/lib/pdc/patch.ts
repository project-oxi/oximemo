/**
 * Metadata-only patching for PDC documents (Mutator surface, PDC 10.1).
 *
 * Replaces the lines of patched top-level envelope keys in place,
 * leaving every other byte — body, unknown fields, extension maps, and
 * line endings — untouched. Missing keys are appended at the end of the
 * envelope. When no value would actually change, the input bytes are
 * returned unchanged.
 */

/** Strip a single trailing `\r` so LF and CRLF parse equivalently. */
function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * Line-index bounds [firstEnvelopeLine, closeLine) of the PDC envelope,
 * or null for a malformed transport.
 */
function envelopeBounds(
  ext: "djot" | "html" | "markdown",
  lines: string[],
): [number, number] | null {
  const at = (i: number, value: string) => i < lines.length && stripCr(lines[i]) === value;
  if (ext === "djot" || ext === "markdown") {
    if (!at(0, "---")) return null;
    for (let i = 1; i < lines.length; i++) if (at(i, "---")) return [1, i];
    return null;
  }
  if (!at(0, "<!--") || !at(1, "---")) return null;
  for (let i = 2; i < lines.length; i++) {
    if (at(i, "---")) return at(i + 1, "-->") ? [2, i] : null;
  }
  return null;
}

export function patchMetadata(
  ext: "djot" | "html" | "markdown",
  bytes: Uint8Array,
  patch: Record<string, string>,
): Uint8Array {
  if (Object.keys(patch).length === 0) return bytes;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return bytes; // not decodable text, nothing patchable
  }
  const lines = text.split("\n");
  const bounds = envelopeBounds(ext, lines);
  if (!bounds) return bytes; // malformed transport: nothing to patch

  const [first, close] = bounds;
  const crlf = close > 0 && lines[close - 1].endsWith("\r");
  const replacements = new Map<number, string>();
  const appended: string[] = [];

  for (const [key, value] of Object.entries(patch)) {
    const keyRe = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:(.*)$`);
    let found = -1;
    for (let i = first; i < close; i++) {
      if (keyRe.test(lines[i])) {
        found = i;
        break;
      }
    }
    const replacement = `${key}: ${value}`;
    if (found === -1) {
      appended.push(replacement);
      continue;
    }
    if (stripCr(lines[found]) === replacement) continue;
    replacements.set(found, lines[found].endsWith("\r") ? `${replacement}\r` : replacement);
  }

  if (replacements.size === 0 && appended.length === 0) return bytes;

  const out = lines.slice();
  for (const [index, line] of replacements) out[index] = line;
  if (appended.length > 0) {
    out.splice(close, 0, ...appended.map((line) => (crlf ? `${line}\r` : line)));
  }
  return new TextEncoder().encode(out.join("\n"));
}
