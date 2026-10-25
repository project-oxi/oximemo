import { bodyOf, titleOf, type Document } from "../types";

export type LibraryFilter = "all" | "drafts" | "trash";

/** Presentation follows the native immutable-request and legacy read guards. */
export function canEdit(document: Document): boolean {
  return !document.attempted && !document.entry?.deleted && (
    document.pending?.change.kind === "create" ||
    document.entry?.class === "document" && typeof document.source?.editable_body === "string"
  );
}

export function formatOf(document?: Document): string {
  if (document?.pending?.change.kind === "create") return document.pending.change.body_profile;
  return document?.source?.body_profile || (document?.entry?.path.endsWith(".html") ? "pdc-html/1" : "pdc-markdown/1");
}

/** Render only a known Markdown body or explicitly classified plain Markdown.
 * Invalid/unsupported envelopes, queries, HTML and Djot keep source fallback. */
export function canPreviewMarkdown(document?: Document): boolean {
  if (!document) return true; // New Markdown draft; the selected profile gates it.
  if (document.pending?.change.kind === "create") return document.pending.change.body_profile === "pdc-markdown/1";
  if (document.source?.body_profile === "pdc-markdown/1" && typeof document.source.editable_body === "string") return true;
  return document.entry?.class === "legacy_markdown" && !!document.source;
}

export function previewOf(document: Document): string {
  if (!document.source && !document.pending) return "동기화 후 본문을 볼 수 있어요.";
  let text = bodyOf(document).slice(0, 4000);
  if (formatOf(document) === "pdc-html/1") {
    // A text excerpt, never an HTML document or a DOM round trip.
    text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ").replace(/<[^>]*>/g, " ");
  } else {
    text = text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
    text = text.replace(/^\s*#{1,6}\s+([^\n]+)\n*/, (_, heading: string) => heading.trim() === titleOf(document).trim() ? "" : `${heading}\n`);
  }
  return text.replace(/%%[\s\S]*?%%/g, "")
    .replace(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, "첨부 · $1")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target: string, label: string) => label || target)
    .replace(/^\s*[-*+] +\[([ xX])\] +/gm, (_, checked: string) => checked.trim() ? "☑ " : "☐ ")
    .replace(/```[^\n]*\n[\s\S]*?(?:```|$)/g, " [코드] ")
    .replace(/^\s*\|?[ :|-]+\|[ :|-]*$/gm, "")
    .replace(/^\s*\|(.+)\|\s*$/gm, (_, row: string) => row.split("|").map(cell => cell.trim()).join(" · "))
    .replace(/\[![a-z]+\][+-]?\s*/gi, "")
    .replace(/^\s*(?:---+|\*\*\*+|___+)\s*$/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(?:\*\*|__|~~|==|`)/g, "")
    .replace(/([*_])([^\n]+?)\1/g, "$2")
    .replace(/^\s*(?:[-*+]\s+|>\s*|#{1,6}\s+)/gm, "")
    .replace(/[ \t]+/g, " ").replace(/\r\n?/g, "\n").replace(/\n[ \t]*\n+/g, "\n").trim() || "내용 없음";
}

export function filterDocuments(documents: Document[], filter: LibraryFilter, query: string, folder = ""): Document[] {
  const needle = query.trim().toLocaleLowerCase();
  return documents.filter(document => {
    if (!!document.entry?.deleted !== (filter === "trash")) return false;
    if (filter === "drafts" && !document.pending) return false;
    if (folder && !document.entry?.path.startsWith(`${folder}/`)) return false;
    const body = document.source || document.pending ? bodyOf(document) : "";
    return `${titleOf(document)} ${body}`.toLocaleLowerCase().includes(needle);
  });
}

export function foldersOf(documents: Document[]): string[] {
  return [...new Set(documents.filter(document => !document.entry?.deleted).flatMap(document => {
    const folder = document.entry?.path.split("/").slice(0, -1).join("/");
    return folder ? [folder] : [];
  }))].sort((a, b) => a.localeCompare(b, "ko"));
}

export function pcName(endpoint: string): string {
  try { return new URL(endpoint).hostname.split(".")[0]; }
  catch { return "연결된 PC"; }
}

export function syncTime(value?: string): string {
  if (!value) return "아직 동기화하지 않음";
  const date = new Date(Number(value) * 1000);
  if (!Number.isFinite(date.getTime())) return "동기화 시간 확인 필요";
  return date.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
