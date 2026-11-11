/**
 * 메모 시트 머리 아래 「앱 밖에서 바뀜」 한 줄 ChangeNoteLine (2026-11-11).
 *
 * 노트를 열었을 때 그 노트가 앱 밖(또는 코파일럿 턴 중)에서 바뀐 채 확인되지 않았으면
 * 바로 그 자리에서 차이를 보고 되돌릴 수 있게 한다 — 장부까지 가지 않아도 판단이 끝나게.
 *
 * 노트를 여는 순간 다른 쪽(MemoDetail)이 그 노트를 「확인함」으로 표시한다. 그래서 확인 안 함 목록을
 * 매번 다시 읽으면 줄이 열리자마자 사라진다. 열 때 본 항목을 이 컴포넌트 상태에 잡아 두고,
 * 사용자가 「확인」 · 되돌리기 · 직접 편집으로 끝낼 때까지 남긴다. 노트가 바뀌면 key 로 새로 시작한다.
 */
import { useEffect, useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type { ChangeEntry } from "../lib/api";
import { useUnseenChanges } from "../lib/changes";
import { useI18n } from "../lib/i18n";
import { relativeTime } from "../lib/time";
import { ChangeDiffView, RevertControl, markSeen, useSourceLabel } from "./ChangeRow";
import { SourceMark } from "./shapes";
import "./ChangeNoteLine.css";

export function ChangeNoteLine({ memoId, dirty }: { memoId: string; dirty: boolean }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const sourceLabel = useSourceLabel();
  const live = useUnseenChanges().byMemoId.get(memoId) ?? null;
  const [entry, setEntry] = useState<ChangeEntry | null>(null);
  // 끝낸 항목보다 새 변경이 오면 다시 보인다 — 열어 둔 사이 밖에서 또 바뀐 경우.
  const [doneSeq, setDoneSeq] = useState(0);
  const [diffOpen, setDiffOpen] = useState(false);
  const diffId = useId();

  useEffect(() => {
    if (!live || live.source === "app" || live.seq <= doneSeq) return;
    if (!entry || live.seq > entry.seq) setEntry(live);
  }, [live, entry, doneSeq]);

  const finish = () => {
    if (!entry) return;
    setDoneSeq(entry.seq);
    setEntry(null);
    setDiffOpen(false);
  };

  // 사용자가 직접 고치기 시작하면 그 변경을 받아들인 것으로 본다 — 되돌리기가 방금 쓴 글까지 덮을 수 있다.
  useEffect(() => {
    if (!dirty || !entry) return;
    setDoneSeq(entry.seq);
    setEntry(null);
    setDiffOpen(false);
  }, [dirty, entry]);

  if (!entry) return null;
  const when = relativeTime(entry.at, locale);
  const text = (entry.source === "copilot" ? t.changes_note_copilot : t.changes_note_external).replace("{time}", when);

  return (
    <div className="change-note-line" role="status">
      <div className="change-note-row">
        <SourceMark source={entry.source} label={sourceLabel(entry.source)} />
        <span className="change-note-text">{text}</span>
        <span className="change-actions">
          <button
            type="button"
            className="change-action"
            aria-expanded={diffOpen}
            aria-controls={diffOpen ? diffId : undefined}
            onClick={() => setDiffOpen((v) => !v)}
          >
            {t.changes_diff}
          </button>
          <RevertControl entry={entry} onReverted={finish} />
          <button
            type="button"
            className="change-action"
            onClick={() => {
              markSeen(qc, [entry.path]);
              finish();
            }}
          >
            {t.changes_dismiss}
          </button>
        </span>
      </div>
      {diffOpen && (
        <div id={diffId} className="change-note-diff">
          <ChangeDiffView seq={entry.seq} />
        </div>
      )}
    </div>
  );
}
