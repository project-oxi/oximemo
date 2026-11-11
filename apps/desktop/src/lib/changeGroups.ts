/**
 * Change journal grouping for the 「변경」 ledger (2026-11-11).
 *
 * 사용자가 판단하는 단위는 파일 하나가 아니라 「한 번의 일」이다 — 코파일럿 턴 하나,
 * 또는 앱 밖에서 잇달아 일어난 저장 묶음. 그래서 장부는 줄을 이 단위로 묶어 머리 하나에 둔다.
 * 입력은 새것이 위(seq 내림차순)여야 한다.
 */
import type { ChangeEntry } from "./api";

export type ChangeGroupKind = "turn" | "external" | "app";

export interface ChangeGroup {
  key: string;
  kind: ChangeGroupKind;
  turn: { id: string; prompt: string } | null;
  /** Newest first. */
  entries: ChangeEntry[];
}

/** 앱 밖 저장이 이 간격 안에 이어지면 한 묶음이다. 2026.11.11 : 2분 — CLI 에이전트 한 번의 작업이 보통 이 안에 끝난다. */
export const EXTERNAL_GAP_MS = 2 * 60_000;

function kindOf(e: ChangeEntry): ChangeGroupKind {
  if (e.turn) return "turn";
  // 턴 표시가 없는 copilot 항목은 출처를 단정할 근거가 약하다 — 앱 밖 묶음에 둔다.
  return e.source === "app" ? "app" : "external";
}

export function groupChanges(entries: ChangeEntry[], gapMs = EXTERNAL_GAP_MS): ChangeGroup[] {
  const groups: ChangeGroup[] = [];
  for (const e of entries) {
    const kind = kindOf(e);
    const prev = groups[groups.length - 1];
    if (prev && prev.kind === kind) {
      const last = prev.entries[prev.entries.length - 1];
      const joins = kind === "turn"
        ? prev.turn?.id === e.turn?.id
        : Date.parse(last.at) - Date.parse(e.at) <= gapMs;
      if (joins) {
        prev.entries.push(e);
        continue;
      }
    }
    groups.push({ key: `${kind}:${e.turn?.id ?? e.seq}`, kind, turn: e.turn, entries: [e] });
  }
  return groups;
}
