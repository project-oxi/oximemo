/**
 * Margin links (2026-11-11 «MarginLinks», 시안 「메모 시트 A」).
 *
 * immersive 시트에서 본문 양옆이 통째로 비어 있었다. 그 여백에 이 메모의 연결을
 * 늘 보이게 둔다 — 왼쪽 = 이 메모를 가리키는 노트(백링크), 오른쪽 = 함께 보기 · Brain.
 * 꼬리 줄 팝오버를 열어야 숫자 너머 제목이 보이던 것을 클릭 없이 보게 하려는 것이다.
 *
 * - 여백 글은 11px · 옅은 잉크로 본문보다 늘 약하다. 강조는 본문 하나다.
 * - 0건이면 그 여백은 그냥 빈다 — 안내 문구를 두지 않는다(빈 여백이 곧 「없음」이다).
 * - 데이터 · 열기 동작 · 우클릭 메뉴는 LinksCard 와 같은 것을 쓴다(useNoteLinks · BacklinkCtxMenu).
 *   여백은 그리기만 하고, 언제 보일지는 MemoDetail(폭 재기) · 무엇을 넣을지는 ContextDock 이 정한다.
 *
 * `MarginSlot` 은 MemoDetail 이 스크롤 틀 옆에 까는 빈 상자이고, ContextDock 이
 * 그 안으로 내용을 portal 한다 — Brain 수집 상태가 꼬리 줄과 여백 사이에서 갈리지 않게.
 */
import { type ReactNode, useSyncExternalStore } from "react";

import { backlinkContextLine } from "../lib/backlinkContext";
import { useI18n } from "../lib/i18n";
import type { MarginBox } from "../lib/marginLayout";
import { previewExcerpt, previewText } from "../lib/markdownPreview";
import { queryCountVersion, subscribeQueryCounts } from "../lib/queryPreviewCounts";
import type { BacklinkInfo, MemoSummary } from "../lib/types";

import { CtxRoot, CtxTrigger } from "./ContextMenu";
import { BacklinkCtxMenu } from "./LinksCard";

import "./MarginLinks.css";

/** 여백 한 줄 맥락의 글자 상한. 두 줄을 넘기면 여백이 본문 높이와 다툰다. */
const LINE_MAX = 90;

/** First visible line of a preview — `previewText` keeps block breaks as "\n". */
function firstLine(text: string): string {
  return text.split("\n", 1)[0] ?? "";
}

export function MarginSlot({
  side,
  box,
  label,
  slotRef,
  onWheel,
}: {
  side: "left" | "right";
  box: MarginBox;
  label: string;
  slotRef: (el: HTMLElement | null) => void;
  onWheel?: (e: React.WheelEvent<HTMLElement>) => void;
}) {
  return (
    <aside
      ref={slotRef}
      aria-label={label}
      data-side={side}
      className="memo-margin"
      style={{ [side]: box.inset, width: box.width }}
      onWheel={onWheel}
    />
  );
}

export function MarginBacklinks({
  backlinks,
  targets,
  onNavigate,
}: {
  backlinks: BacklinkInfo[];
  /** This note's title (+ aliases) — the line that links here becomes the context. */
  targets: string[];
  onNavigate: (id: string) => void;
}) {
  const { t } = useI18n();
  useSyncExternalStore(subscribeQueryCounts, queryCountVersion);
  if (backlinks.length === 0) return null;
  return (
    <section className="memo-margin-group">
      <h3 className="memo-margin-heading">{t.margin_backlinks}</h3>
      <ul>
        {backlinks.map((bl) => {
          const context = backlinkContextLine(bl.preview, targets);
          const line = firstLine(
            previewText(context ?? previewExcerpt(bl.preview, bl.title), LINE_MAX, { thisId: bl.id, resultsN: t.query_embed_results_n }),
          );
          return (
            <li key={bl.id}>
              <CtxRoot>
                <CtxTrigger render={<button type="button" onClick={() => onNavigate(bl.id)} className="memo-margin-item" />}>
                  <span className="memo-margin-title">{bl.title}</span>
                  {line && <span className="memo-margin-line">{line}</span>}
                  <BacklinkCtxMenu id={bl.id} title={bl.title} onNavigate={onNavigate} />
                </CtxTrigger>
              </CtxRoot>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function MarginRelated({
  items,
  onNavigate,
  brain,
}: {
  items: MemoSummary[] | undefined;
  onNavigate: (id: string) => void;
  /** Brain summary line (a popover trigger), drawn under the list. */
  brain?: ReactNode;
}) {
  const { t } = useI18n();
  const list = items ?? [];
  if (list.length === 0 && !brain) return null;
  return (
    <>
      {list.length > 0 && (
        <section className="memo-margin-group">
          <h3 className="memo-margin-heading">{t.see_also}</h3>
          <ul>
            {list.map((m) => (
              <li key={m.id}>
                <button type="button" onClick={() => onNavigate(m.id)} className="memo-margin-item">
                  <span className="memo-margin-title">{m.title || m.folder || m.path}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {brain && <div className="memo-margin-group">{brain}</div>}
    </>
  );
}
