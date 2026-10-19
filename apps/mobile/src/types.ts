export type Change = { kind: "create"; title: string; body: string; body_profile: string } | { kind: "update"; title: string; body: string; document_id: string; expected_sha256: string };
export interface Source { path: string; content: string; sha256: string; document_id?: string; editable_body?: string; title?: string; body_profile?: string }
export interface Document { key: string; entry?: { path: string; class: string; deleted: boolean; title?: string; diagnostic?: { code: string; message: string }; broken_document_links: string[]; missing_assets: string[] }; source?: Source; pending?: { operation_id: string; change: Change }; error?: string; attempted: boolean }
export interface View { endpoint: string; paired: boolean; key_updates?: Record<string, string>; cache: { documents: Document[]; last_sync?: string; diagnostics: unknown[]; vault_id?: string } }
export const editorTitle = (d: Document) => d.pending?.change.title ?? d.source?.title ?? "";
export const titleOf = (d: Document) => {
  const body = bodyOf(d);
  const fallback = d.source?.body_profile === "pdc-html/1"
    ? (body.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1])?.replace(/<[^>]*>/g, "")
    : body.match(/^#\s+(.+?)(?:\s+#+)?\s*$/m)?.[1];
  return editorTitle(d) || d.entry?.title || fallback || d.entry?.path.split("/").pop()?.replace(/\.[^.]+$/, "") || "새 메모";
};
export const bodyOf = (d: Document) => d.pending?.change.body ?? d.source?.editable_body ?? d.source?.content ?? "원문을 가져오려면 PC와 동기화해 주세요.";
