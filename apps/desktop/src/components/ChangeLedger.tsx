/**
 * 「변경」 장부 ChangeLedger (2026-11-11).
 *
 * 사람과 코딩 에이전트가 한 볼트를 같이 쓴다. 이 화면은 「앱 밖에서 무엇이 바뀌었고, 그대로 둘까 되돌릴까」에
 * 답하는 곳이다. 출처는 관찰이다 — 앱 밖 변경은 CLI 에이전트일 수도, 다른 편집기의 사람일 수도 있어
 * 「에이전트」라고 부르지 않고 「앱 밖에서」라고만 쓴다.
 *
 * 시간 축은 새것이 위. 줄은 판단 단위(코파일럿 턴 하나 · 2분 안의 앱 밖 저장 묶음)로 묶이고,
 * 묶음 머리의 시각이 왼쪽 축에 선다. 200줄 남짓은 가상화 없이 그린다.
 */
import { useMemo, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";

import { listChanges, type ChangeEntry } from "../lib/api";
import { CHANGES_KEY, useUnseenChanges } from "../lib/changes";
import { groupChanges, type ChangeGroup } from "../lib/changeGroups";
import { isoToLocalDate } from "../lib/dates";
import { useI18n } from "../lib/i18n";
import { relativeDayLabel, useTodayKey } from "../lib/relativeDay";
import { ChangeRow, TurnRevertButton, markSeen } from "./ChangeRow";
import { SourceMark } from "./shapes";
import "./ChangeLedger.css";

const PAGE = 100;

function clock(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

/** 머리 글 길이 상한 — 프롬프트 전체는 title 로 남긴다. */
function shortPrompt(p: string): string {
  const one = p.replace(/\s+/g, " ").trim();
  return one.length > 40 ? `${one.slice(0, 40)}…` : one;
}

function GroupHead({ group }: { group: ChangeGroup }) {
  const { t } = useI18n();
  const n = group.entries.length;
  const count = t.changes_count.replace("{n}", String(n));
  if (group.kind === "turn" && group.turn) {
    return (
      <div className="change-group-head">
        <SourceMark source="copilot" label={t.changes_source_copilot} />
        <span className="change-group-label" title={group.turn.prompt}>
          {t.changes_group_turn.replace("{prompt}", shortPrompt(group.turn.prompt))}
        </span>
        <span className="change-group-count">{count}</span>
        <span className="change-group-tail">
          <TurnRevertButton turnId={group.turn.id} count={n} />
        </span>
      </div>
    );
  }
  const external = group.kind === "external";
  return (
    <div className="change-group-head">
      {external && <SourceMark source="external" label={t.changes_source_external} />}
      <span className="change-group-label">{external ? t.changes_group_external : t.changes_group_app}</span>
      <span className="change-group-count">{count}</span>
    </div>
  );
}

export function ChangeLedger() {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const today = useTodayKey();
  const unseen = useUnseenChanges();
  const [includeApp, setIncludeApp] = useState(false);

  const q = useInfiniteQuery({
    queryKey: [...CHANGES_KEY, "ledger", includeApp],
    queryFn: ({ pageParam }) => listChanges({ limit: PAGE, include_app: includeApp, before_seq: pageParam }),
    initialPageParam: undefined as number | undefined,
    // 꽉 차지 않은 쪽이 오면 더 오래된 것이 없다는 뜻이다.
    getNextPageParam: (last: ChangeEntry[]) => (last.length < PAGE ? undefined : Math.min(...last.map((e) => e.seq))),
  });

  const groups = useMemo(() => {
    const seen = new Set<number>();
    const all: ChangeEntry[] = [];
    for (const page of q.data?.pages ?? []) {
      for (const e of page) {
        if (seen.has(e.seq)) continue;
        seen.add(e.seq);
        all.push(e);
      }
    }
    all.sort((a, b) => b.seq - a.seq);
    return groupChanges(all);
  }, [q.data]);

  const markAll = () => markSeen(qc, [...unseen.byPath.keys()]);

  let lastDay = "";
  return (
    <div className="change-ledger">
      <header className="change-ledger-head">
        <h1 className="change-ledger-title">{t.changes_nav}</h1>
        <p className="change-ledger-count" aria-live="polite">
          {unseen.count > 0 ? t.changes_unseen_count.replace("{n}", String(unseen.count)) : t.changes_all_seen}
        </p>
        <div className="change-ledger-tools">
          <label className="change-ledger-toggle">
            <input type="checkbox" checked={includeApp} onChange={(e) => setIncludeApp(e.target.checked)} />
            {t.changes_include_app}
          </label>
          <button type="button" className="change-action" disabled={unseen.count === 0} onClick={markAll}>
            {t.changes_mark_all_seen}
          </button>
        </div>
      </header>

      {q.isError && <p className="change-ledger-empty">{t.changes_load_failed}</p>}
      {q.isSuccess && groups.length === 0 && <p className="change-ledger-empty">{t.changes_empty}</p>}

      {groups.length > 0 && (
        <div className="change-ledger-axis" role="list" aria-label={t.changes_list_label}>
          {groups.map((g) => {
            const newest = g.entries[0];
            const day = isoToLocalDate(newest.at);
            const dayBreak = day !== lastDay;
            lastDay = day;
            return (
              <div key={g.key} role="listitem" className="change-group-wrap">
                {dayBreak && <p className="change-day">{relativeDayLabel(day, today, locale)}</p>}
                <section className="change-group">
                  <time className="change-group-time" dateTime={newest.at}>{clock(newest.at, locale)}</time>
                  <div className="change-group-main">
                    <GroupHead group={g} />
                    <ul className="change-group-rows">
                      {g.entries.map((e) => <ChangeRow key={e.seq} entry={e} />)}
                    </ul>
                  </div>
                </section>
              </div>
            );
          })}
        </div>
      )}

      {q.hasNextPage && (
        <button
          type="button"
          className="change-action change-ledger-more"
          disabled={q.isFetchingNextPage}
          onClick={() => void q.fetchNextPage()}
        >
          {t.changes_load_more}
        </button>
      )}
    </div>
  );
}
