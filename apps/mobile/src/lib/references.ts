import type { Document } from "../types";
export function resolveNote(reference: string, sourcePath: string, documents: Document[]): Document | undefined {
  const raw = reference.split("#")[0];
  let target: string;
  try { target = decodeURIComponent(raw); } catch { return; }
  const available = documents.filter(d => !d.entry?.deleted);
  if (target.startsWith("wiki:")) {
    const wiki = target.slice(5);
    if (!wiki || wiki.split("/").includes("..") || /[:\\]/.test(wiki) || wiki.startsWith("/")) return;
    const matches = available.filter(d => {
      const path = d.entry?.path || d.source?.path || "";
      const withoutExtension = path.replace(/\.(md|html|djot)$/, "");
      return path === wiki || withoutExtension === wiki || path.endsWith(`/${wiki}`) || withoutExtension.endsWith(`/${wiki}`);
    });
    return matches.length === 1 ? matches[0] : undefined;
  }
  if (target.startsWith("pdc://document/")) {
    const id = target.slice(15);
    const matches = available.filter(d => d.source?.document_id === id);
    return matches.length === 1 ? matches[0] : undefined;
  }
  if (/^[a-z][\w+.-]*:/i.test(target) || target.startsWith("/") || target.includes("\\")) return;
  const parts = sourcePath.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "..") { if (!parts.length) return; parts.pop(); }
    else if (part && part !== ".") parts.push(part);
  }
  const path = parts.join("/");
  const matches = available.filter(d => (d.entry?.path || d.source?.path) === path);
  return matches.length === 1 ? matches[0] : undefined;
}
export function imageMime(bytes: number[]): string | undefined {
  const prefix = String.fromCharCode(...bytes.slice(0, 12));
  if (bytes.slice(0, 8).join() === "137,80,78,71,13,10,26,10") return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (prefix.startsWith("GIF87a") || prefix.startsWith("GIF89a")) return "image/gif";
  if (prefix.startsWith("RIFF") && prefix.slice(8) === "WEBP") return "image/webp";
}
