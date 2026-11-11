/**
 * Shared shape vocabulary (2026-11-11).
 *
 * 앱 색이 무채색이라(DESIGN.md «Material and color») 색 톤에 기대는 상태 표시는
 * 실제 화면에서 거의 구분되지 않는다. 그래서 상태 · 변경 · 시점은 모양과 위치로 말한다.
 * 같은 데이터는 어느 화면에서나 같은 모양을 쓴다 — 화면마다 새로 그리지 않는다.
 *
 * - NowRule     : 시간이 있는 목록에서 「지금」을 긋는 굵은 선. 위 = 지난 것, 아래 = 올 것.
 * - ChangeGlyph : 노트 변경 종류 기호 (+ 생성 · ~ 수정 · − 삭제 · → 이동).
 * - FillRing    : 진행 상태 고리 (빈 · 반 · 꽉 · 점선). TaskCheckbox 의 채움 규칙과 같은 뜻.
 *
 * Styles live in `shapes.css`.
 */
import "./shapes.css";

export type ChangeKind = "created" | "modified" | "deleted" | "moved";

const GLYPH: Record<ChangeKind, string> = {
  created: "+",
  modified: "~",
  deleted: "−",
  moved: "→",
};

/** Map a free-form change kind string onto the shared vocabulary. */
export function changeKindOf(kind: string): ChangeKind {
  const k = kind.toLowerCase();
  if (k.startsWith("creat") || k === "add" || k === "added" || k === "new") return "created";
  if (k.startsWith("delet") || k.startsWith("remov") || k === "trash" || k === "trashed") return "deleted";
  if (k.startsWith("mov") || k.startsWith("renam")) return "moved";
  return "modified";
}

/** Order for listings: what is hardest to undo first. */
export const CHANGE_ORDER: Record<ChangeKind, number> = { deleted: 0, moved: 1, created: 2, modified: 3 };

export function ChangeGlyph({ kind, label }: { kind: ChangeKind; label?: string }) {
  // 기호는 시각용이고 뜻은 label 로 읽힌다 — 화면 낭독기가 「물결표」를 읽지 않게.
  return (
    <span className="change-glyph" data-kind={kind} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {GLYPH[kind]}
    </span>
  );
}

export type FillState = "open" | "partial" | "full" | "held";

export function FillRing({ state, label, size = 10 }: { state: FillState; label?: string; size?: number }) {
  return (
    <span
      className="fill-ring"
      data-state={state}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ width: size, height: size }}
    />
  );
}

/** Horizontal «now» rule with an optional caption (e.g. «지금 · 11/11 화»). */
export function NowRule({ label }: { label?: string }) {
  return (
    <div className="now-rule" role="separator" aria-label={label}>
      {label && <span className="now-rule-label">{label}</span>}
    </div>
  );
}
