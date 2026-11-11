/**
 * 「안 본 변경」 표시 (2026-11-11) — 메모 목록(카드 · 시간 지층 · 목록 · 표)에서 같은 꼴로 쓴다.
 *
 *   ↗ 3분 전   앱 밖에서 바뀌었고 아직 열어 보지 않았다
 *   ◇ 3분 전   코파일럿 턴이 도는 동안 바뀌었고 아직 열어 보지 않았다
 *
 * 배지 · 알약을 두르지 않는다 — 앱은 무채색이라 색 대신 기호 모양과 글자 굵기로만 상태를 말한다.
 * 시각은 메모 수정 시각이 아니라 <바뀐 시각>이다. 둘이 같아 보여도 앱 밖 변경은 파일 시각과 관찰 시각이 어긋날 수 있다.
 *
 * 목록마다 useUnseenChanges() 를 한 번 부르고 unseenFor() 로 행마다 찾아 내려 준다.
 * 행마다 훅을 부르면 가상 스크롤로 행이 붙었다 떨어질 때마다 구독이 생기고 사라진다.
 */
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { markChangesSeen, type ChangeEntry } from "../lib/api";
import { CHANGES_KEY, useUnseenChanges, type UnseenIndex } from "../lib/changes";
import { useI18n } from "../lib/i18n";
import { relativeTime } from "../lib/time";
import { useChangedSinceMount } from "../lib/workspaceMotion";
import { SourceMark } from "./shapes";
import "./UnseenStamp.css";

/** 메모 하나의 안 본 변경. memo_id 가 없는 항목(백엔드가 id 를 못 읽은 파일)은 경로로 찾는다. */
export function unseenFor(index: UnseenIndex, memo: { id: string; path: string }): ChangeEntry | undefined {
  if (index.count === 0) return undefined;
  const e = index.byMemoId.get(memo.id) ?? index.byPath.get(memo.path);
  // 앱이 직접 쓴 것은 표시하지 않는다 — 넘겨 받은 쪽이 시각 자리를 비워 버리지 않게 여기서 거른다.
  return e && e.source !== "app" ? e : undefined;
}

/** 기호 + 바뀐 시각. 낭독기에는 기호 · 시각 대신 「앱 밖에서 3분 전 바뀜 · 아직 안 봄」 한 문장으로 읽힌다. */
export function UnseenStamp({ change, className }: { change: ChangeEntry; className?: string }) {
  const { t, locale } = useI18n();
  if (change.source === "app") return null;
  const when = relativeTime(change.at, locale);
  const label = (change.source === "copilot" ? t.unseen_change_copilot : t.unseen_change_external).replace("{time}", when);
  const markLabel = change.source === "copilot" ? t.unseen_source_copilot : t.unseen_source_external;
  return (
    <span className={`unseen-stamp${className ? ` ${className}` : ""}`} title={label}>
      <span aria-hidden className="contents">
        <SourceMark source={change.source} label={markLabel} />
        <time dateTime={change.at}>{when}</time>
      </span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * 보이는 동안 새로 「안 본 변경」이 붙었는지. 붙은 순간에만 한 번 밝히려고 쓴다 (data-fresh 와 같은 애니메이션).
 * 처음 그릴 때부터 붙어 있던 표시는 밝히지 않는다 — 가상 스크롤로 다시 붙는 행마다 번쩍이면 소음이다.
 */
export function useChangeArrived(change: ChangeEntry | undefined): boolean {
  const changed = useChangedSinceMount(change?.seq);
  return change !== undefined && changed;
}

/**
 * 메모를 시트에서 열면 그 경로의 안 본 변경을 본 것으로 돌린다 — 한 번 열 때 한 번.
 * 목록 · 검토 대기열 · 명령 팔레트 · 링크 모두 selectedId 를 거쳐 MemoDetail 이 열므로 여기 한 곳이면 된다.
 * 연 채로 새 변경이 또 들어와도 다시 부르지 않는다 — 다른 메모로 옮기거나 닫았다 열면 다시 본다.
 */
export function useMarkSeenOnOpen(path: string | null): void {
  const qc = useQueryClient();
  const unseen = useUnseenChanges();
  const done = useRef<string | null>(null);
  const pending = path !== null && unseen.byPath.has(path);
  useEffect(() => {
    // 다른 메모로 옮기거나 닫으면 앞 메모의 「한 번」을 잊는다 — A → B → A 로 돌아와도 다시 본 것으로 돌린다.
    if (path !== done.current) done.current = null;
    if (path === null || done.current === path || !pending) return;
    done.current = path;
    markChangesSeen([path])
      .then(() => qc.invalidateQueries({ queryKey: CHANGES_KEY }))
      .catch(() => {
        // 실패하면 다음에 열 때 다시 시도하도록 표시를 풀어 둔다. 본 표시는 놓쳐도 잃는 것이 없어 알리지 않는다.
        if (done.current === path) done.current = null;
      });
  }, [path, pending, qc]);
}
