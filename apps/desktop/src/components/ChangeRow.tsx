/**
 * 변경 장부의 한 줄 ChangeRow 와 그 부품 (2026-11-11).
 *
 * 사용자가 내리는 판단은 하나다 — 「밖에서 바뀐 이것을 그대로 둘까, 되돌릴까」.
 * 그래서 줄은 접힌 채로 무엇이 · 어디서 · 언제를 말하고, 펼치면 그 자리에서 차이와 되돌리기를 준다.
 * 같은 데이터는 같은 모양이어야 해서 장부 · 코파일럿 영수증 · 메모 시트 머리가 모두 이 파일의 부품을 쓴다.
 *
 * 목차
 * - useChangeDiff      : 차이 조회 (장부 키 아래 — 새 변경이 오면 이후 변경 수도 다시 센다)
 * - useArm             : 두 번 눌러야 하는 파괴 동작의 4초 대기
 * - ChangeDiffView     : 줄 차이 (바뀐 덩어리 + 앞뒤 2줄)
 * - RevertControl      : 되돌리기 / 되돌릴 수 없는 까닭
 * - TurnRevertButton   : 코파일럿 턴 하나 되돌리기
 * - ChangeRow          : 한 줄 (펼치면 차이 + 열기 + 되돌리기)
 */
import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { changeDiff, markChangesSeen, revertChange, revertTurn, type ChangeEntry } from "../lib/api";
import { CHANGES_KEY } from "../lib/changes";
import { useI18n } from "../lib/i18n";
import { diffHunks } from "../lib/lineDiff";
import { relativeTime } from "../lib/time";
import { useUI } from "../stores/ui";
import { ChangeGlyph, SourceMark, changeKindOf, type ChangeKind } from "./shapes";
import "./ChangeRow.css";

/** 차이 화면이 그리는 줄 상한. 새로 만든 긴 노트 하나가 장부를 멈추지 않게 한다. */
const MAX_DIFF_LINES = 400;

export function useChangeDiff(seq: number, enabled = true) {
  return useQuery({
    queryKey: [...CHANGES_KEY, "diff", seq],
    queryFn: () => changeDiff(seq),
    enabled,
    // 브라우저 미리보기에서는 늘 실패한다 — 다시 시도해도 같다.
    retry: false,
    staleTime: 30_000,
  });
}

/** 되돌린 뒤 장부 · 카드 · 열린 노트가 모두 새 상태를 보게 한다. */
async function afterRevert(qc: QueryClient, memoId: string | null) {
  await Promise.all([
    qc.invalidateQueries({ queryKey: CHANGES_KEY }),
    qc.invalidateQueries({ queryKey: ["memos"] }),
    memoId ? qc.invalidateQueries({ queryKey: ["memo", memoId] }) : Promise.resolve(),
  ]);
}

function errText(e: unknown): string {
  return String(e).split("\n")[0];
}

/** 펼침 · 확인은 장부의 「확인하지 않음」을 지운다. 실패해도 화면 동작은 막지 않는다(미리보기에는 장부가 없다). */
export function markSeen(qc: QueryClient, paths: string[]) {
  if (paths.length === 0) return;
  void markChangesSeen(paths)
    .then(() => qc.invalidateQueries({ queryKey: CHANGES_KEY }))
    .catch(() => {});
}

/** 노트 열기 — CopilotPanel 영수증과 같은 규칙: 열린 빈 초안이 바로 그 노트일 때만 초안 표시를 지운다. */
export function openChangedMemo(id: string) {
  const ui = useUI.getState();
  ui.setDraftId(ui.draftId === id ? null : ui.draftId);
  ui.select(id);
}

/** 앱의 다른 파괴 동작(대화 지우기 · 뷰 삭제)과 같은 두 번 누르기 — 첫 누름 뒤 4초 안에 다시 눌러야 한다. */
function useArm(): [boolean, () => void, () => void] {
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | null>(null);
  const disarm = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    setArmed(false);
  };
  const arm = () => {
    setArmed(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(disarm, 4000);
  };
  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);
  return [armed, arm, disarm];
}

const GUTTER = { same: " ", add: "+", del: "−" } as const;

/** 바뀐 덩어리만 보인다. 색 대신 칸 기호(+ −)와 취소선이 더함 · 지움을 말한다. */
export function ChangeDiffView({ seq }: { seq: number }) {
  const { t } = useI18n();
  const q = useChangeDiff(seq);
  const hunks = useMemo(() => (q.data ? diffHunks(q.data.before, q.data.after, 2) : []), [q.data]);

  if (q.isLoading) return <p className="change-diff-note">{t.changes_diff_loading}</p>;
  if (q.isError || !q.data) return <p className="change-diff-note">{t.changes_diff_failed}</p>;
  if (hunks.length === 0) return <p className="change-diff-note">{t.changes_diff_none}</p>;

  let budget = MAX_DIFF_LINES;
  let hidden = 0;
  return (
    <div className="change-diff" role="group" aria-label={t.changes_diff_label}>
      {hunks.map((h, i) => {
        const shown = h.lines.slice(0, Math.max(0, budget));
        hidden += h.lines.length - shown.length;
        budget -= shown.length;
        if (shown.length === 0) return null;
        return (
          <Fragment key={i}>
            {i > 0 && <div className="change-diff-gap" aria-hidden>⋯</div>}
            {shown.map((l, k) => (
              <div key={k} className="change-diff-line" data-op={l.op}>
                <span className="change-diff-gutter" aria-hidden>{GUTTER[l.op]}</span>
                {l.op === "del" && <del className="change-diff-text"><span className="sr-only">{t.changes_diff_removed}: </span>{l.text || " "}</del>}
                {l.op === "add" && <ins className="change-diff-text"><span className="sr-only">{t.changes_diff_added}: </span>{l.text || " "}</ins>}
                {l.op === "same" && <span className="change-diff-text">{l.text || " "}</span>}
              </div>
            ))}
          </Fragment>
        );
      })}
      {hidden > 0 && <p className="change-diff-note">{t.changes_diff_more.replace("{n}", String(hidden))}</p>}
    </div>
  );
}

/** 휴지통 · 버전 기록은 설정 「저장소」 판에 있다 — ChangeReceipt 의 휴지통 열기와 같은 길. */
function openStorageSettings() {
  useUI.getState().setSettingsTab("storage");
  useUI.getState().setSettingsOpen(true);
}

/**
 * 되돌리기. 이후 변경이 있으면 그것도 함께 사라지므로 수를 보여 주고 두 번 눌러야 한다.
 * 되돌릴 수 없으면 버튼 대신 까닭을 적는다 — 눌러 봐야 실패하는 버튼은 두지 않는다.
 */
export function RevertControl({ entry, onReverted }: { entry: ChangeEntry; onReverted?: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const setToast = useUI((s) => s.setToast);
  const q = useChangeDiff(entry.seq);
  const [armed, arm, disarm] = useArm();
  const [busy, setBusy] = useState(false);

  if (!q.data) return null;
  const d = q.data;
  if (!d.revertible) {
    return (
      <span className="change-reason">
        {d.reason === "git_off" ? t.changes_reason_git_off : t.changes_reason_no_history}
        {d.reason === "git_off" && (
          <button type="button" className="change-action" onClick={openStorageSettings}>{t.changes_open_storage}</button>
        )}
      </span>
    );
  }

  const run = async () => {
    disarm();
    setBusy(true);
    try {
      await revertChange(entry.seq);
      setToast(t.changes_reverted);
      onReverted?.();
      await afterRevert(qc, entry.memo_id);
    } catch (e) {
      setToast(`${t.changes_revert_failed} ${errText(e)}`);
    } finally {
      setBusy(false);
    }
  };
  const needsArm = d.later_changes > 0;
  return (
    <button
      type="button"
      className="change-action"
      data-armed={armed || undefined}
      disabled={busy}
      onBlur={disarm}
      onClick={() => {
        if (needsArm && !armed) arm();
        else void run();
      }}
    >
      {armed ? t.changes_revert_arm.replace("{n}", String(d.later_changes)) : t.changes_revert}
    </button>
  );
}

/** 코파일럿 턴 하나를 통째로 되돌린다. 여러 노트에 걸치므로 늘 두 번 누른다. */
export function TurnRevertButton({ turnId, count }: { turnId: string; count: number }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const setToast = useUI((s) => s.setToast);
  const [armed, arm, disarm] = useArm();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    disarm();
    setBusy(true);
    try {
      const r = await revertTurn(turnId);
      setToast(t.changes_reverted_turn.replace("{n}", String(r.reverted)).replace("{m}", String(r.skipped)));
      await afterRevert(qc, null);
    } catch (e) {
      setToast(`${t.changes_revert_failed} ${errText(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      className="change-action"
      data-armed={armed || undefined}
      disabled={busy}
      onBlur={disarm}
      onClick={() => (armed ? void run() : arm())}
    >
      {armed ? t.changes_revert_turn_arm.replace("{n}", String(count)) : t.changes_revert_turn}
    </button>
  );
}

export function useKindLabel(): (k: ChangeKind) => string {
  const { t } = useI18n();
  const labels: Record<ChangeKind, string> = {
    created: t.copilot_changed_created,
    modified: t.copilot_changed_changed,
    deleted: t.copilot_changed_deleted,
    moved: t.copilot_changed_moved,
  };
  return (k) => labels[k];
}

export function useSourceLabel(): (source: ChangeEntry["source"]) => string {
  const { t } = useI18n();
  return (source) => (source === "copilot" ? t.changes_source_copilot : t.changes_source_external);
}

/** 한 변경. 버튼 하나가 줄 전체이고, 누르면 그 자리에서 펼친다(aria-expanded). */
export function ChangeRow({ entry }: { entry: ChangeEntry }) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const kindLabel = useKindLabel();
  const sourceLabel = useSourceLabel();
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const kind = changeKindOf(entry.kind);
  const title = entry.title || entry.path;
  const unseen = !entry.seen;
  const deleted = kind === "deleted";

  const toggle = () => {
    const next = !open;
    setOpen(next);
    // 펼쳐 본 것은 확인한 것이다 — 접힌 줄을 훑기만 한 것은 아니다.
    if (next && unseen) markSeen(qc, [entry.path]);
  };

  return (
    <li className="change-row" data-unseen={unseen || undefined} data-open={open || undefined}>
      <button type="button" className="change-row-toggle" aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={toggle}>
        <span className="change-row-dot" aria-hidden />
        {unseen && <span className="sr-only">{t.changes_unseen}, </span>}
        <ChangeGlyph kind={kind} label={kindLabel(kind)} />
        <span className="change-row-source">
          <SourceMark source={entry.source} label={sourceLabel(entry.source)} />
        </span>
        <span className="change-row-title">{title}</span>
        <time className="change-row-time" dateTime={entry.at} title={new Date(entry.at).toLocaleString(locale)}>
          {relativeTime(entry.at, locale)}
        </time>
      </button>
      {open && (
        <div id={bodyId} className="change-row-body">
          <ChangeDiffView seq={entry.seq} />
          <div className="change-actions">
            <button
              type="button"
              className="change-action"
              disabled={deleted || !entry.memo_id}
              title={deleted ? t.changes_open_deleted : undefined}
              onClick={() => entry.memo_id && openChangedMemo(entry.memo_id)}
            >
              {t.changes_open}
            </button>
            <RevertControl entry={entry} />
          </div>
        </div>
      )}
    </li>
  );
}
