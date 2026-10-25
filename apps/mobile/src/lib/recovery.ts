import type { Document } from "../types";

export interface Recovery {
  version: 1;
  vault?: string;
  original: Document | "new";
  title: string;
  body: string;
  profile: string;
}
const key = "oximemo.unsaved.v1";
// WKWebView's persistent app storage is private to this app. Synchronous writes
// avoid a debounce window when iOS suspends the web view immediately after input.
export function readRecovery(): Recovery | undefined {
  const raw = window.localStorage.getItem(key);
  if (!raw) return;
  const value = JSON.parse(raw) as Recovery;
  if (value.version !== 1 || typeof value.title !== "string" || typeof value.body !== "string" || !["pdc-markdown/1", "pdc-html/1"].includes(value.profile) || !(value.original === "new" || typeof value.original?.key === "string")) throw new Error("저장된 작성 내용을 읽을 수 없습니다. 앱 데이터를 지우지 말아 주세요.");
  return value;
}
export function writeRecovery(value: Recovery) { window.localStorage.setItem(key, JSON.stringify(value)); }
export function clearRecovery() { window.localStorage.removeItem(key); }
export function editSnapshot(document?: Document) {
  return document ? { source: document.source ?? null, pending: document.pending ?? null } : null;
}
