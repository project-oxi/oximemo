/**
 * Change journal — shared React hooks (2026-11-11).
 *
 * 화면 여러 곳(사이드바 수 · 카드 표시 · 변경 장부 · 메모 시트 머리 · 코파일럿 영수증)이 같은 데이터를 보므로
 * 조회 키와 무효화를 여기 한 곳에 둔다. 화면마다 따로 듣고 따로 부르면 수가 서로 어긋난다.
 *
 * 무효화 신호: 백엔드의 `changes:recorded` (새 항목 · seen 변경 · 되돌리기 뒤).
 */
import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { unseenChanges, type ChangeEntry } from "./api";
import { listen } from "./tauri";

/** Query-key root for everything journal-derived. Invalidate this to refresh all views. */
export const CHANGES_KEY = ["changes"] as const;

/** Subscribe once (App level) — invalidates every journal query on `changes:recorded`. */
export function useChangeJournalEvents(): void {
  const qc = useQueryClient();
  useEffect(() => {
    let un: (() => void) | undefined;
    void listen("changes:recorded", () => {
      void qc.invalidateQueries({ queryKey: CHANGES_KEY });
    }).then((u) => {
      un = u;
    });
    return () => un?.();
  }, [qc]);
}

export interface UnseenIndex {
  /** Latest unseen non-app entry per vault-relative path. */
  byPath: Map<string, ChangeEntry>;
  /** Same entries keyed by memo id (entries without an id are skipped). */
  byMemoId: Map<string, ChangeEntry>;
  count: number;
}

const EMPTY: UnseenIndex = { byPath: new Map(), byMemoId: new Map(), count: 0 };

/** Unseen changes made outside the app's editor (copilot turns + external writers). */
export function useUnseenChanges(): UnseenIndex {
  const q = useQuery({ queryKey: [...CHANGES_KEY, "unseen"], queryFn: unseenChanges, staleTime: 5_000 });
  return useMemo(() => {
    const rows = q.data;
    if (!rows || rows.length === 0) return EMPTY;
    const byPath = new Map<string, ChangeEntry>();
    const byMemoId = new Map<string, ChangeEntry>();
    for (const e of rows) {
      byPath.set(e.path, e);
      if (e.memo_id) byMemoId.set(e.memo_id, e);
    }
    return { byPath, byMemoId, count: byPath.size };
  }, [q.data]);
}
