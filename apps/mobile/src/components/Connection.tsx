import { useEffect, useRef } from "react";
import { Check, ChevronDown, ChevronRight, CircleAlert, Clock3, KeyRound, Laptop, Link2, QrCode, RefreshCw, ShieldCheck, WifiOff } from "lucide-react";
import type { View } from "../types";
import { pcName, syncTime } from "../lib/presentation";
import { connectionStatus, type SyncState } from "../lib/connection";

interface Props {
  view?: View;
  sync: SyncState;
  pending: number;
  endpoint: string;
  token: string;
  code: string;
  pairEndpoint: string;
  scanning: boolean;
  busy: boolean;
  onEndpoint: (value: string) => void;
  onToken: (value: string) => void;
  onCode: (value: string) => void;
  onScan: () => void;
  onCancelScan: () => void;
  onPreview: () => void;
  onConnectPair: () => void;
  onConnectManual: () => void;
  onSync: () => void;
}

export function Connection(props: Props) {
  const paired = props.view?.paired;
  const status = connectionStatus(props.view, props.sync);
  const confirmRef = useRef<HTMLDivElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (props.pairEndpoint && !props.busy) {
      confirmRef.current?.scrollIntoView({ block: "nearest" });
      confirmButtonRef.current?.focus({ preventScroll: true });
    }
  }, [props.pairEndpoint, props.busy]);
  return <main className="scroll-region connection-scroll route-enter" aria-label="PC 연결 설정">
    <div className="connection-page">
      <section className="pc-status" aria-label="연결 상태">
        <div className="pc-status-heading"><span className="pc-icon"><Laptop aria-hidden="true" size={19}/></span><div><h2>{paired ? pcName(props.view!.endpoint) : "등록된 PC 없음"}</h2><p>{paired ? "등록된 PC" : "QR 코드 또는 연결 코드로 등록하세요."}</p></div></div>
        {paired ? <><p className="pc-address">{props.view!.endpoint}</p><div className={`connection-result result-${status.state}`} role="status">{status.state === "success" ? <Check aria-hidden="true" size={17}/> : status.state === "error" || status.state === "warning" ? <CircleAlert aria-hidden="true" size={17}/> : <RefreshCw aria-hidden="true" size={17} className={status.state === "working" ? "spinning" : ""}/>}<div><strong>{status.label}</strong>{status.state !== "success" && <p>{status.detail}</p>}</div></div><div className="sync-facts"><div><span><Clock3 aria-hidden="true" size={14}/>마지막 동기화</span><strong>{syncTime(props.view?.cache.last_sync)}</strong></div><div><span>전송 대기</span><strong>{props.pending ? `초안 ${props.pending}개` : "없음"}</strong></div></div><button className="button primary full-width" onClick={props.onSync} disabled={props.busy}><RefreshCw aria-hidden="true" size={18} className={props.sync.phase === "syncing" ? "spinning" : ""}/>{props.sync.phase === "syncing" ? "동기화 중…" : "지금 동기화"}</button></> : <p className="connection-description">같은 Tailscale 계정으로 연결한 뒤, PC에서 만든 QR 코드를 스캔하세요. 메모는 이 기기에서도 읽고 편집할 수 있어요.</p>}
      </section>
      <section className="pairing-section" aria-label="PC 연결 방법">
        <h2 className="section-heading">{paired ? "PC 다시 연결" : "PC 연결하기"}</h2>
        <button className="connection-scan-row" onClick={props.onScan} disabled={props.busy}><QrCode aria-hidden="true" size={18}/><span>QR 코드 스캔</span><ChevronRight aria-hidden="true" size={14}/></button>
        {props.scanning && <button className="text-button full-width" onClick={props.onCancelScan}>스캔 취소</button>}
        {props.pairEndpoint && <div className="pair-confirm" ref={confirmRef} role="region" aria-label="연결할 PC 확인"><span className="eyebrow">연결할 PC</span><strong>{pcName(props.pairEndpoint)}</strong><p>{props.pairEndpoint}</p><button className="button primary full-width" ref={confirmButtonRef} onClick={props.onConnectPair} disabled={props.busy}>이 PC 연결</button></div>}
        <div className="connection-methods">
          <details className="connection-method"><summary><Link2 aria-hidden="true" size={18}/><span>연결 코드 입력</span><ChevronDown aria-hidden="true" size={16}/></summary><form onSubmit={event => { event.preventDefault(); props.onPreview(); }}><p className="field-help">PC에서 복사한 연결 코드를 붙여넣으세요.</p><label htmlFor="pair-code">연결 코드</label><textarea id="pair-code" className="pair-code" placeholder="OM1:으로 시작하는 코드" value={props.code} onChange={event => props.onCode(event.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={props.busy} required/>{!props.pairEndpoint && <button className="button secondary full-width" type="submit" disabled={props.busy || !props.code.trim()}>코드 확인</button>}</form></details>
          <details className="connection-method"><summary><KeyRound aria-hidden="true" size={18}/><span>주소와 토큰으로 연결</span><ChevronDown aria-hidden="true" size={16}/></summary><form onSubmit={event => { event.preventDefault(); props.onConnectManual(); }}><label htmlFor="pc-address">PC 주소</label><input id="pc-address" type="url" placeholder="https://my-pc.tail123.ts.net" autoCapitalize="none" autoCorrect="off" autoComplete="url" value={props.endpoint} onChange={event => props.onEndpoint(event.target.value)} required disabled={props.busy}/><label htmlFor="pc-token">연결 토큰</label><input id="pc-token" type="password" autoComplete="off" placeholder={paired ? "같은 PC의 토큰은 생략 가능" : "PC에서 만든 토큰"} value={props.token} onChange={event => props.onToken(event.target.value)} required={!paired || props.endpoint.replace(/\/$/, "") !== props.view?.endpoint.replace(/\/$/, "")} disabled={props.busy}/><button className="button secondary full-width" type="submit" disabled={props.busy}>연결하고 확인</button></form></details>
        </div>
      </section>
      <details className="connection-help" open={props.sync.phase === "error" || undefined}><summary><CircleAlert aria-hidden="true" size={17}/><span>{props.sync.phase === "error" ? "연결이 안 되면 확인하세요" : "PC에서 먼저 준비할 것"}</span><ChevronDown aria-hidden="true" size={16}/></summary><ol><li><strong>PC와 휴대폰의 Tailscale 켜기</strong><p>두 기기를 같은 계정으로 연결하세요.</p></li><li><strong>PC 동기화 서버 실행하기</strong><p>PC에서 OxiMemo의 <code>mobile-serve</code> 서버가 실행 중이어야 해요. PC가 잠자기 상태면 연결되지 않아요.</p></li><li><strong>기본 HTTPS 주소 확인하기</strong><p>Tailscale Serve로 서버의 9843 포트를 기본 HTTPS 주소에 연결하세요. 다른 포트의 주소는 사용할 수 없어요.</p></li><li><strong>새 QR 코드로 연결하기</strong><p>PC의 <code>mobile-pair</code>로 만든 코드는 10분 동안 유효해요.</p></li></ol></details>
      <details className="connection-notes"><summary>저장 및 전송 안내<ChevronDown aria-hidden="true" size={14}/></summary><p className="connection-privacy"><ShieldCheck aria-hidden="true" size={14}/><span>연결 토큰은 기기의 전용 저장소에 보관돼요.</span></p><p className="offline-note"><WifiOff aria-hidden="true" size={14}/><span>메모는 먼저 이 기기에 저장돼요. PC와 Tailscale이 켜져 있을 때 동기화할 수 있어요.</span></p></details>
    </div>
  </main>;
}
