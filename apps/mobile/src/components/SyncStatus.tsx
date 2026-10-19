import { CircleAlert, RefreshCw } from "lucide-react";
import type { View } from "../types";
import { connectionStatus, type SyncState } from "../lib/connection";

export function SyncStatus({ view, sync, busy, count, onConnection }: { view?: View; sync: SyncState; busy: boolean; count: number; onConnection: () => void; onSync: () => void }) {
  const status = connectionStatus(view, sync);
  const attention = status.state === "error" || status.state === "warning";
  if (!attention && sync.phase !== "syncing") return null;
  return <button className={`library-summary sync-overview sync-${status.state}`} onClick={onConnection} disabled={busy} aria-label={`메모 ${count}개. PC 연결 상태: ${status.label}. ${status.detail}`}>
    {sync.phase === "syncing" ? <RefreshCw aria-hidden="true" size={16} className="spinning"/> : attention && <CircleAlert aria-hidden="true" size={17}/>}
    <span>{sync.phase === "syncing" ? "동기화 중…" : attention ? "전송 상태 확인" : `메모 ${count}개`}</span>
  </button>;
}
