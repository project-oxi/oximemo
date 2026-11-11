/**
 * RecencyStrata — 작업 화면의 「시간 지층」 (2026-11-11 승인안 A).
 *
 * 같은 높이 카드 그리드는 오늘 쓴 메모와 석 달 전 메모의 무게가 같다. 이 화면의 주인공 판단은
 * 「어느 메모를 연다」(고르기)이고 데이터는 수정 시각 순이라, 시간에 따라 밀도를 바꾼다.
 *
 *   폴더 선반  — 하위 폴더를 카드 칸에서 빼 머리 위 한 줄로 (이름 + 수)
 *   오늘       — 큰 카드 2열 · 미리보기 4줄 (지금 Card 를 variant="lead" 로 그대로 쓴다)
 *   이번 주    — 작은 카드 3~4열 · 제목만
 *   그 이전 · N — 한 줄 행 (제목 · 날짜)
 *
 * 띠 머리는 글자 하나 + 가는 선 — 상자를 두르지 않는다. 0건인 띠는 그리지 않는다.
 * CardGrid 가 「폴더를 둘러보는 중 · 수정 순 · 검색 없음 · 속성 거르기 없음」일 때만 이 꼴을 고른다.
 * 그 밖에는 지금 GridView 그대로다.
 *
 * 가상 스크롤: 선반 · 머리 · 카드 줄 · 행을 한 줄 목록으로 펴고 한 가상화기에 올린다.
 * 띠마다 따로 가상화하면 띠 사이 좌표를 맞출 수 없어 천 건에서 스크롤이 튄다.
 * 줄 높이는 measureElement 로 잰다 — 제목 줄바꿈 · 폴더 이름 입력칸 때문에 고정 높이가 맞지 않는다.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { Star } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type RefObject } from "react";

import { Card } from "../Card";
import { CtxRoot, CtxTrigger } from "../ContextMenu";
import { FolderShelfItem } from "../FolderTile";
import { NoteCtxMenu } from "../NoteCtxMenu";
import { UnseenStamp, unseenFor, useChangeArrived } from "../UnseenStamp";
import type { ChangeEntry } from "../../lib/api";
import { useUnseenChanges, type UnseenIndex } from "../../lib/changes";
import { useFolderNames } from "../../lib/folders";
import { useI18n } from "../../lib/i18n";
import { splitByRecency } from "../../lib/recencyBands";
import { useTodayKey } from "../../lib/relativeDay";
import { relativeTime } from "../../lib/time";
import type { FolderCard, MemoSummary } from "../../lib/types";
import { useUI } from "../../stores/ui";
import type { GridViewProps } from "./GridView";
import "./RecencyStrata.css";

type StrataProps = Omit<GridViewProps, "virtualizer" | "cols" | "showFolderChip"> & {
  /** CardGrid 의 스크롤 칸 — 가상화기가 이 칸의 스크롤을 따른다. */
  scrollerRef: RefObject<HTMLDivElement | null>;
  /** 둘러보는 폴더. 행의 폴더 이름은 이 폴더와 다를 때만 보인다. null = 「전체 메모」처럼 폴더를 가로지르는 목록 — 늘 보인다. */
  currentFolder: string | null;
  /** 다음 쪽이 남아 있으면 「그 이전」 수에 + 를 단다 — 불러온 수가 전체 수처럼 읽히지 않게. */
  hasMore: boolean;
  /** 목록 끝에 다가가면 다음 쪽을 부른다 (GridView 의 끝 감지와 같은 일). */
  onNearEnd: () => void;
};

type Band = "today" | "week" | "older";
type Item =
  | { k: "shelf" }
  | { k: "head"; band: Band; label: string }
  | { k: "lead"; notes: MemoSummary[] }
  | { k: "compact"; notes: MemoSummary[] }
  | { k: "row"; note: MemoSummary }
  | { k: "noNotes" };

/** 이 폭보다 좁으면 띠마다 1열로 접는다 — 큰 카드 2열이 각 340px 아래로 줄면 미리보기 4줄이 단어 몇 개가 된다. */
const NARROW_W = 700;
/** 이번 주 띠가 4열이 되는 폭. 작은 카드가 220px 아래면 제목 두 줄도 잘린다. */
const WIDE_W = 960;

const ESTIMATE: Record<Item["k"], number> = {
  shelf: 44,
  head: 40,
  lead: 220,
  compact: 64,
  row: 36,
  noNotes: 56,
};

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

function keyOf(it: Item): string {
  switch (it.k) {
    case "shelf":
      return "shelf";
    case "head":
      return `h:${it.band}`;
    case "lead":
    case "compact":
      return `${it.k}:${it.notes[0]?.id ?? ""}`;
    case "row":
      return `r:${it.note.id}`;
    case "noNotes":
      return "noNotes";
  }
}

export function RecencyStrata(props: StrataProps) {
  const { cells, scrollerRef, hasMore, onNearEnd } = props;
  const { t } = useI18n();
  const today = useTodayKey();
  // 안 본 변경은 지층 전체에서 한 번만 듣고 줄마다 찾아 내려 준다 — 가상 스크롤 줄마다 구독하지 않게.
  const unseen = useUnseenChanges();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [margin, setMargin] = useState(0);

  // 폭(열 수)과 스크롤 칸 안에서의 시작 위치를 함께 잰다. 시작 위치가 틀리면 가상화기가 엉뚱한 줄을 그린다.
  useEffect(() => {
    const el = rootRef.current;
    const scroller = scrollerRef.current;
    if (!el || !scroller) return;
    const update = () => {
      setWidth(el.clientWidth);
      setMargin(el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollerRef]);

  const narrow = width > 0 && width < NARROW_W;
  const leadCols = narrow ? 1 : 2;
  const compactCols = narrow ? 1 : width >= WIDE_W ? 4 : 3;

  const folderCards = useMemo(
    () => cells.flatMap((c) => (c.kind === "folder" ? [c.card] : [])),
    [cells],
  );
  const overflow = useMemo(() => {
    const c = cells.find((x) => x.kind === "folderOverflow");
    return c && c.kind === "folderOverflow" ? c.total : 0;
  }, [cells]);
  const notes = useMemo(
    () => cells.flatMap((c) => (c.kind === "note" ? [c.note] : [])),
    [cells],
  );

  const items = useMemo<Item[]>(() => {
    const bands = splitByRecency(notes, today);
    const out: Item[] = [];
    if (folderCards.length > 0) out.push({ k: "shelf" });
    if (bands.today.length > 0) {
      out.push({ k: "head", band: "today", label: t.strata_today });
      for (const row of chunk(bands.today, leadCols)) out.push({ k: "lead", notes: row });
    }
    if (bands.week.length > 0) {
      out.push({ k: "head", band: "week", label: t.strata_week });
      for (const row of chunk(bands.week, compactCols)) out.push({ k: "compact", notes: row });
    }
    if (bands.older.length > 0) {
      const n = `${bands.older.length}${hasMore ? "+" : ""}`;
      out.push({ k: "head", band: "older", label: t.strata_older.replace("{n}", n) });
      for (const note of bands.older) out.push({ k: "row", note });
    }
    // 하위 폴더만 있고 바로 든 메모가 없는 폴더는 선반 아래가 통째로 비어 「안 불러와졌나」로 읽힌다.
    // 그 자리에 다음 동작(새 메모)을 둔다. 폴더도 없으면 CardGrid 의 빈 화면이 맡는다.
    if (notes.length === 0 && !hasMore && folderCards.length > 0 && props.currentFolder !== null) {
      out.push({ k: "noNotes" });
    }
    return out;
  }, [notes, today, folderCards.length, leadCols, compactCols, hasMore, t, props.currentFolder]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: (i) => ESTIMATE[items[i]?.k ?? "row"],
    getItemKey: (i) => keyOf(items[i]),
    scrollMargin: margin,
    overscan: 8,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const lastIndex = virtualItems.at(-1)?.index ?? -1;
  useEffect(() => {
    if (lastIndex >= items.length - 6 && hasMore) onNearEnd();
  }, [lastIndex, items.length, hasMore, onNearEnd]);

  return (
    <div ref={rootRef} className="recency-strata relative w-full" style={{ height: virtualizer.getTotalSize() }}>
      {virtualItems.map((v) => {
        const it = items[v.index];
        return (
          <div
            key={v.key}
            data-index={v.index}
            ref={virtualizer.measureElement}
            className="absolute left-0 top-0 w-full"
            style={{ transform: `translateY(${v.start - margin}px)` }}
          >
            <StrataItem item={it} leadCols={leadCols} compactCols={compactCols} props={props} folderCards={folderCards} overflow={overflow} unseen={unseen} />
          </div>
        );
      })}
    </div>
  );
}

function StrataItem({
  item,
  leadCols,
  compactCols,
  props,
  folderCards,
  overflow,
  unseen,
}: {
  item: Item;
  leadCols: number;
  compactCols: number;
  props: StrataProps;
  folderCards: FolderCard[];
  overflow: number;
  unseen: UnseenIndex;
}) {
  const { t } = useI18n();
  switch (item.k) {
    case "shelf":
      return (
        <nav aria-label={t.folder_shelf_label} className="strata-shelf" data-collapsed={overflow > 0 || undefined}>
          {folderCards.map((card) => (
            <FolderShelfItem
              key={card.path}
              card={card}
              folders={props.folders}
              pinned={props.folders.find((f) => f.path === card.path)?.pinned ?? false}
              onOpen={props.onOpenFolder}
              onRename={props.onRenameFolder}
              onTogglePin={props.onToggleFolderPin}
              onMoveFolder={props.onMoveFolder}
              onMoveFolderTree={props.onMoveFolderTree}
              onDelete={props.onDeleteFolder}
              namingPath={props.namingPath}
              onNameCommit={props.onNameCommit}
            />
          ))}
          {overflow > 0 && (
            <button type="button" onClick={props.onExpandFolders} className="strata-shelf-more">
              {t.show_all_folders.replace("{n}", String(overflow))}
              <span aria-hidden> ›</span>
            </button>
          )}
        </nav>
      );
    case "noNotes":
      return (
        <p className="strata-no-notes">
          <span>{t.strata_no_notes}</span>
          <button type="button" onClick={() => props.onNewNoteIn(props.currentFolder ?? "")}>
            {t.new_memo}
          </button>
        </p>
      );
    case "head":
      // 띠 머리는 낭독기에서 제목으로 읽혀야 띠 사이를 건너뛸 수 있다.
      return (
        <h2 className="strata-head" data-band={item.band}>
          <span>{item.label}</span>
        </h2>
      );
    case "lead":
      return (
        <div className="strata-lead" style={{ gridTemplateColumns: `repeat(${leadCols}, minmax(0, 1fr))` }}>
          {item.notes.map((note) => (
            <Card
              key={note.id}
              variant="lead"
              memo={note}
              change={unseenFor(unseen, note)}
              showFolderChip={props.currentFolder === null}
              folders={props.folders}
              folderEntries={props.folderEntries}
              onOpenFolder={props.onOpenFolder}
              onSelect={props.onSelect}
              onToggleFavorite={props.onToggleFavorite}
              onMoveFolder={props.onMoveFolder}
              onCopyBody={props.onCopyBody}
              onDelete={props.onDelete}
              badges={props.badges}
              preset={props.preset}
            />
          ))}
        </div>
      );
    case "compact":
      return (
        <div className="strata-compact" style={{ gridTemplateColumns: `repeat(${compactCols}, minmax(0, 1fr))` }}>
          {item.notes.map((note) => (
            <StrataNote key={note.id} note={note} shape="compact" props={props} change={unseenFor(unseen, note)} />
          ))}
        </div>
      );
    case "row":
      return <StrataNote note={item.note} shape="row" props={props} change={unseenFor(unseen, item.note)} />;
  }
}

/** 이번 주 작은 카드 · 그 이전 행. 카드와 같은 메뉴 · 끌기 · 열기를 단다 — 꼴만 작다. */
function StrataNote({ note, shape, props, change }: { note: MemoSummary; shape: "compact" | "row"; props: StrataProps; change?: ChangeEntry }) {
  const { t, locale } = useI18n();
  const { displayName } = useFolderNames();
  const setDraggingNote = useUI((s) => s.setDraggingNote);
  const dragging = useUI((s) => s.draggingNote?.id === note.id);
  const fresh = useUI((s) => s.freshId === note.id);
  const changeArrived = useChangeArrived(change);
  const title = note.title || t.empty_memo;
  const showFolder = shape === "row" && (props.currentFolder === null || note.folder !== props.currentFolder);
  const onDragStart = useCallback(
    (e: DragEvent) => {
      setDraggingNote(note);
      e.dataTransfer.setData("application/x-oximemo-notes", JSON.stringify([note.id]));
      e.dataTransfer.effectAllowed = "move";
    },
    [note, setDraggingNote],
  );
  return (
    <CtxRoot>
      <CtxTrigger
        render={
          <button
            type="button"
            draggable
            onDragStart={onDragStart}
            onDragEnd={() => setDraggingNote(null)}
            onClick={() => props.onSelect(note.id)}
            data-fresh={fresh || changeArrived || undefined}
            data-dragging={dragging || undefined}
            className={shape === "compact" ? "strata-note-compact" : "strata-note-row"}
          />
        }
      >
        <span className={shape === "compact" ? "strata-title-2" : "strata-title-1"}>{title}</span>
        {note.favorite && (
          <Star size={11} role="img" aria-label={t.favorite} className="shrink-0 fill-hue-amber text-hue-amber" />
        )}
        {showFolder && <span className="strata-row-folder">{displayName(note.folder)}</span>}
        {/* 안 본 변경은 작은 카드 · 행 모두 같은 「↗ 3분 전」 꼴 — 행에서는 날짜 자리를 대신한다. */}
        {change && <UnseenStamp change={change} />}
        {shape === "row" && !change && (
          <time dateTime={note.updated_at} title={relativeTime(note.updated_at, locale)} className="strata-row-date">
            {shortDate(note.updated_at, locale)}
          </time>
        )}
        <NoteCtxMenu
          memo={note}
          folderEntries={props.folderEntries}
          onToggleFavorite={props.onToggleFavorite}
          onMoveFolder={props.onMoveFolder}
          onCopyBody={props.onCopyBody}
          onDelete={props.onDelete}
        />
      </CtxTrigger>
    </CtxRoot>
  );
}

/** 「10/02」 꼴 · 해가 다르면 「2025. 8. 30.」 꼴. 행은 상대 시각보다 날짜가 줄 맞춤에 낫다. */
function shortDate(iso: string, locale: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const opts: Intl.DateTimeFormatOptions = sameYear
    ? { month: "2-digit", day: "2-digit" }
    : { year: "numeric", month: "numeric", day: "numeric" };
  try {
    return new Intl.DateTimeFormat(locale, opts).format(d);
  } catch {
    return d.toLocaleDateString();
  }
}
