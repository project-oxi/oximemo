import type { View } from "../types";
import { syncTime } from "./presentation";

export type SyncState = { phase: "idle" | "syncing" | "success" | "error"; error?: string };

/** A stored token is pairing, never proof that the PC is currently reachable. */
export function connectionStatus(view: View | undefined, sync: SyncState) {
  const pending = view?.cache.documents.filter(document => document.pending).length ?? 0;
  const issues = view?.cache.documents.filter(document => document.error).length ?? 0;
  if (sync.phase === "syncing") return { label: "PC와 동기화 중", detail: "메모와 전송 결과를 확인하고 있어요.", state: "working" };
  if (!view?.paired) return { label: "PC를 연결해 주세요", detail: "QR 코드로 연결하고 PC의 메모를 가져오세요.", state: "unpaired" };
  if (sync.phase === "error") return { label: "PC 연결 확인 필요", detail: sync.error || "PC와 Tailscale이 켜져 있는지 확인하세요.", state: "error" };
  if (issues) return { label: `메모 ${issues}개 확인 필요`, detail: "초안에서 전송 상태와 원문 충돌을 확인하세요.", state: "warning" };
  if (sync.phase === "success") return { label: pending ? `초안 ${pending}개 전송 대기` : "PC와 동기화했어요", detail: `마지막 동기화 · ${syncTime(view.cache.last_sync)}`, state: "success" };
  return { label: "PC 연결 정보가 저장되어 있어요", detail: view.cache.last_sync ? `마지막 동기화 · ${syncTime(view.cache.last_sync)}` : "동기화로 연결을 확인하세요.", state: "saved" };
}

export function connectionError(error: unknown): string {
  const text = String(error).replace(/^Error:\s*/, "");
  if (/401|403|unauthorized|forbidden/i.test(text)) return "PC 인증에 실패했어요. PC에서 새 연결 코드를 만들어 다시 연결하세요.";
  if (/404|not found/i.test(text)) return "주소에서 OxiMemo 서버를 찾지 못했어요. PC의 동기화 서버와 Tailscale Serve 설정을 확인하세요.";
  if (/timed?\s*out|timeout|error sending request|connection refused|dns|connect error/i.test(text)) return "PC에 연결하지 못했어요. PC의 동기화 서버와 두 기기의 Tailscale을 확인하세요.";
  return text;
}
