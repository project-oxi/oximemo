import { ChevronDown, ChevronRight, Laptop, Moon, Trash2 } from "lucide-react";
import type { View } from "../types";
import { pcName } from "../lib/presentation";
import { version } from "../../package.json";
import { connectionStatus, type SyncState } from "../lib/connection";

interface Props {
  view?: View;
  pending: number;
  sync: SyncState;
  onConnection: () => void;
  onTrash: () => void;
}

export function Settings({ view, pending, sync, onConnection, onTrash }: Props) {
  const status = connectionStatus(view, sync);
  return <main className="scroll-region settings-scroll route-enter" aria-label="설정">
    <div className="settings-page">
      <h2 className="settings-section-title">동기화</h2>
      <div className="settings-group"><button className="settings-row" aria-label="PC 연결" onClick={onConnection}><span className="settings-icon"><Laptop aria-hidden="true" size={17}/></span><span><strong>PC 연결</strong><small>{view?.paired ? `${pcName(view.endpoint)} · ${status.label}` : "QR 코드로 PC 등록"}</small></span><ChevronRight aria-hidden="true" size={15}/></button><div className="settings-fact"><span>전송 대기</span><strong>{pending ? `초안 ${pending}개` : "없음"}</strong></div></div>
      <h2 className="settings-section-title">보관함</h2>
      <div className="settings-group"><button className="settings-row" onClick={onTrash}><span className="settings-icon"><Trash2 aria-hidden="true" size={17}/></span><span><strong>휴지통</strong><small>삭제한 메모 확인 · 복원은 PC에서</small></span><ChevronRight aria-hidden="true" size={15}/></button></div>
      <h2 className="settings-section-title">앱</h2>
      <div className="settings-group"><div className="settings-appearance"><Moon aria-hidden="true" size={17}/><span>화면 모드</span><span>시스템 설정</span></div></div>
      <details className="settings-about"><summary>저장 및 문서 정보<ChevronDown aria-hidden="true" size={14}/></summary><p>마크다운 원문을 그대로 저장하고 읽기 화면만 렌더링해요.</p><p>초안은 이 기기에 먼저 저장돼요. 앱을 삭제하기 전에 PC와 동기화하세요.</p></details>
      <p className="settings-version">OxiMemo <span>{version}</span></p>
    </div>
  </main>;
}
