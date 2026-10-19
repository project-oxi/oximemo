import { useLayoutEffect, useRef } from "react";
import { X } from "lucide-react";

export function LeaveDialog({ open, busy, onClose, onSave, onDiscard, returnFocus }: { open: boolean; busy: boolean; onClose: () => void; onSave: () => void; onDiscard: () => void; returnFocus: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) { dialog.showModal(); cancelRef.current?.focus(); }
    if (!open && dialog.open) { dialog.close(); returnFocus(); }
  }, [open]);
  return <dialog className="leave-dialog" ref={ref} aria-labelledby="leave-title" aria-describedby="leave-description" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="dialog-content">
      <button className="icon-button dialog-close" aria-label="저장 확인 닫기" onClick={onClose} disabled={busy}><X aria-hidden="true" size={19}/></button>
      <h2 id="leave-title">메모를 저장할까요?</h2>
      <p id="leave-description">저장하면 이 기기에 초안으로 보관돼요.</p>
      <button className="button primary" onClick={onSave} disabled={busy}>저장하고 나가기</button>
      <button className="button secondary" ref={cancelRef} onClick={onClose} disabled={busy}>계속 작성</button>
      <button className="button discard-button" onClick={onDiscard} disabled={busy}>저장하지 않고 나가기</button>
    </div>
  </dialog>;
}
