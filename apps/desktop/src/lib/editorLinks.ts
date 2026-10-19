import { invoke } from "./tauri";
import type { PdcInventory } from "./pdcInventory";

export type EditorLinkTarget =
  | { kind: "external"; url: string }
  | { kind: "memo"; id: string; fragment: string | null }
  | { kind: "source"; path: string; fragment: string | null };

function vaultPath(sourcePath: string, href: string): string {
  const parts = href.startsWith("/") ? [] : sourcePath.split("/").slice(0, -1);
  for (const part of href.replace(/^\/+/, "").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!parts.length) throw new Error("링크가 문서 보관함 밖을 가리킵니다.");
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

export async function resolveEditorLink(url: string, sourcePath: string): Promise<EditorLinkTarget> {
  const raw = url.trim();
  if (/^https?:\/\//i.test(raw)) return { kind: "external", url: raw };
  const hash = raw.indexOf("#");
  const fragment = hash < 0 ? null : decodeURIComponent(raw.slice(hash + 1));
  const pathPart = hash < 0 ? raw : raw.slice(0, hash);
  const inventory = await invoke<PdcInventory>("pdc_inventory");
  if (pathPart.startsWith("pdc://document/")) {
    const id = pathPart.slice("pdc://document/".length);
    const matches = inventory.items.filter((item) => item.document_id === id);
    if (matches.length !== 1) throw new Error(matches.length ? "중복된 문서 ID입니다." : "연결된 문서를 찾을 수 없습니다.");
    return { kind: "memo", id, fragment };
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(pathPart) || pathPart.startsWith("//")) throw new Error("지원하지 않는 링크입니다.");
  const path = pathPart ? vaultPath(sourcePath, decodeURIComponent(pathPart)) : sourcePath;
  const item = inventory.items.find((entry) => entry.path === path);
  if (!item) throw new Error("연결된 문서를 찾을 수 없습니다.");
  if (item.document_id && item.class === "document") return { kind: "memo", id: item.document_id, fragment };
  return { kind: "source", path, fragment };
}
