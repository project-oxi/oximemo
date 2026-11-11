/**
 * 코파일럿 「변경 영수증」 ChangeReceipt (2026-11-11).
 *
 * 한 턴 동안 볼트에서 관찰된 노트 변경을 공통 어휘 ChangeGlyph(+ ~ − →)로 적는다.
 * 예전 색 점(success · error · info)은 무채색 앱에서 같은 회색으로 보여 생성과 삭제를
 * 가를 수 없었다. 정렬은 CHANGE_ORDER — 되돌리기 어려운 것(삭제 · 이동)이 위로 온다.
 *
 * 원칙(§9.4): 볼트는 공유되고 다른 작성자가 있다. 그래서 이 목록은 「관찰」만 말하고
 * 에이전트가 바꿨다고 단정하지 않는다 — 아래 캡션이 그 원칙을 화면 글자로 옮긴 것이다.
 */
import { useQuery } from "@tanstack/react-query";

import { listChanges, type ChangeEntry } from "../lib/api";
import { CHANGES_KEY } from "../lib/changes";
import { ChangeRow, TurnRevertButton } from "./ChangeRow";
import { CHANGE_ORDER, ChangeGlyph, changeKindOf, type ChangeKind } from "./shapes";
import "./ChangeReceipt.css";

export type ReceiptItem = {
  id: string;
  kind: string;
  /** 바뀐 크기(글자 · 바이트 등). 백엔드가 아직 주지 않으면 막대를 그리지 않는다. */
  size?: number | null;
};

/** 행 제목 칸. 갈래를 이른 반환으로 둔다(프로젝트 규칙: 중첩 삼항 금지). */
function TitleCell({
  title,
  deleted,
  trashed,
  trashLabel,
  onOpen,
  onOpenTrash,
}: {
  title: string;
  deleted: boolean;
  trashed: boolean;
  trashLabel: string;
  onOpen: () => void;
  onOpenTrash: () => void;
}) {
  if (!deleted) {
    return (
      <button type="button" onClick={onOpen} className="change-receipt-title">
        {title}
      </button>
    );
  }
  if (trashed) {
    return (
      <button type="button" onClick={onOpenTrash} title={trashLabel} className="change-receipt-title">
        {title}
      </button>
    );
  }
  return <span className="change-receipt-title" data-static="">{title}</span>;
}

/**
 * 변경 장부에 이 턴의 항목이 있으면 장부와 같은 줄(ChangeRow)로 그린다 — 같은 데이터는 같은 모양.
 * 장부가 없거나(브라우저 미리보기 · 장부 꺼짐) 비어 있으면 예전 영수증이 대신 선다.
 */
function JournalReceipt({ turnId, entries, listLabel, caption }: { turnId: string; entries: ChangeEntry[]; listLabel: string; caption: string }) {
  const rows = entries
    .map((e) => ({ e, k: changeKindOf(e.kind) }))
    // 영수증의 정렬 규칙(되돌리기 어려운 것이 위)을 그대로 따르고, 같은 종류 안에서는 새것이 위.
    .sort((a, b) => CHANGE_ORDER[a.k] - CHANGE_ORDER[b.k] || b.e.seq - a.e.seq);
  return (
    <div className="change-receipt">
      <ul className="change-receipt-list" aria-label={listLabel}>
        {rows.map(({ e }) => <ChangeRow key={e.seq} entry={e} />)}
      </ul>
      <div className="change-receipt-foot">
        <p className="change-receipt-caption">{caption}</p>
        <TurnRevertButton turnId={turnId} count={rows.length} />
      </div>
    </div>
  );
}

export function ChangeReceipt(props: Parameters<typeof LegacyReceipt>[0] & { turnId?: string | null }) {
  const { turnId, ...rest } = props;
  const journal = useQuery({
    queryKey: [...CHANGES_KEY, "turn", turnId ?? ""],
    queryFn: () => listChanges({ turn: turnId ?? "" }),
    enabled: !!turnId,
    retry: false,
  });
  const entries = journal.data ?? [];
  if (turnId && entries.length > 0) {
    return <JournalReceipt turnId={turnId} entries={entries} listLabel={rest.listLabel} caption={rest.caption} />;
  }
  if (rest.items.length === 0) return null;
  return <LegacyReceipt {...rest} />;
}

function LegacyReceipt({
  items,
  titleFor,
  kindLabel,
  listLabel,
  caption,
  trashLabel,
  isTrashed,
  onOpen,
  onOpenTrash,
}: {
  items: ReceiptItem[];
  titleFor: (id: string) => string;
  kindLabel: (kind: ChangeKind) => string;
  listLabel: string;
  caption: string;
  trashLabel: string;
  /** 삭제 항목이 앱 휴지통에 있는지. 없으면(에이전트가 파일을 직접 지움) 열 곳이 없어 글자만 둔다. */
  isTrashed: (id: string) => boolean;
  onOpen: (id: string) => void;
  onOpenTrash: () => void;
}) {
  const rows = items
    .map((item, index) => ({ ...item, k: changeKindOf(item.kind), index }))
    // 같은 종류 안에서는 백엔드가 준 순서를 지킨다 — sort 안정성에만 기대지 않게 index 를 둘째 키로.
    .sort((a, b) => CHANGE_ORDER[a.k] - CHANGE_ORDER[b.k] || a.index - b.index);
  const sizes = rows.map((r) => r.size).filter((s): s is number => typeof s === "number" && s > 0);
  // 막대는 같은 턴 안의 상대 크기다. 크기 정보가 하나도 없으면 빈 막대 대신 칸 자체를 뺀다.
  const maxSize = sizes.length > 0 ? Math.max(...sizes) : 0;

  return (
    <div className="change-receipt">
      <ul className="change-receipt-list" aria-label={listLabel}>
        {rows.map((r) => {
          const title = titleFor(r.id);
          const word = kindLabel(r.k);
          return (
            <li key={r.id} className="change-receipt-row">
              <ChangeGlyph kind={r.k} label={word} />
              <TitleCell
                title={title}
                deleted={r.k === "deleted"}
                trashed={r.k === "deleted" && isTrashed(r.id)}
                trashLabel={trashLabel}
                onOpen={() => onOpen(r.id)}
                onOpenTrash={onOpenTrash}
              />
              {maxSize > 0 && typeof r.size === "number" && r.size > 0 && (
                <span
                  className="change-receipt-size"
                  aria-hidden
                  style={{ width: `${Math.max(4, Math.round((r.size / maxSize) * 56))}px` }}
                />
              )}
            </li>
          );
        })}
      </ul>
      <p className="change-receipt-caption">{caption}</p>
    </div>
  );
}
