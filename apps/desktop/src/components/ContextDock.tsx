/**
 * Context Dock (§3.1, docs/superpowers/specs/2026-08-20-note-detail-context-cards-design.md).
 * Bottom status bar for the note detail dialog. Owns the backlinks query,
 * the brain status/gather/distill state, and which context card (if any)
 * is open — only one card open at a time, per the interaction contract (§3.4).
 * Replaces the former BacklinksPanel + BrainPanel accordion stack.
 *
 * 2026-11-11 «MarginLinks»: immersive 시트가 넓으면 MemoDetail 이 본문 양옆에 빈
 * 여백 상자(marginLeft · marginRight)를 깔고, 이 독이 그 안으로 백링크 · 함께 보기 ·
 * Brain 요약을 portal 한다. 여백이 실어 나르는 버튼은 꼬리 줄에서 뺀다(같은 것이 두 번
 * 보이지 않게). Brain 팝오버는 그대로 하나 — 여백 줄이 그 팝오버를 연다.
 * 저장 상태 글자는 시트 머리의 SaveRing 으로 옮겼다.
 */
import { Popover } from "@base-ui-components/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { memo as reactMemo, useEffect, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { Brain, Link2 } from "lucide-react";

import { brainContradictions, brainGather, brainStatus, createMemo, getConfig } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useUI } from "../stores/ui";
import type { BrainLayer } from "../lib/types";
import { BrainCard, layerLabel } from "./BrainCard";
import { LinksCard, useNoteLinks } from "./LinksCard";
import { MarginBacklinks, MarginRelated } from "./MarginLinks";

export interface ContextDockProps {
  noteId: string;
  title: string | null;
  tags: string[];
  /** Note aliases — extra link targets when picking a backlink's context line. */
  aliases?: string[];
  /** Immersive margin boxes from MemoDetail; null when the sheet is too narrow. */
  marginLeft?: HTMLElement | null;
  marginRight?: HTMLElement | null;
  onNavigateMemo: (id: string) => void;
}

type OpenCard = "links" | "brain" | null;

/** recall() returns `{layers: [{kind, text}, ...]}`; be defensive about
 * shape drift between daemon versions (mirrors the check BrainPanel used). */
function layersOf(value: unknown): BrainLayer[] {
  if (!value || typeof value !== "object") return [];
  const raw = (value as { layers?: unknown }).layers;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((l) =>
    l &&
    typeof l === "object" &&
    typeof (l as BrainLayer).kind === "string" &&
    typeof (l as BrainLayer).text === "string"
      ? [l as BrainLayer]
      : [],
  );
}

/** Count what the brain's `meta.dropped` reports as discarded. The shape
 *  is intentionally opaque (array / record / number across versions);
 *  anything non-empty counts, and an unknown shape yields null — the
 *  notice is informational, never load-bearing. */
function droppedCount(value: unknown): number | null {
  if (!value || typeof value !== "object" || !("meta" in value)) return null;
  const meta = value.meta;
  if (!meta || typeof meta !== "object" || !("dropped" in meta)) return null;
  const raw: unknown = meta.dropped;
  if (typeof raw === "number") return raw > 0 ? raw : null;
  if (Array.isArray(raw)) return raw.length > 0 ? raw.length : null;
  if (raw && typeof raw === "object") {
    const entries = Object.values(raw).filter((v) => v !== 0 && v !== "" && v !== false);
    return entries.length > 0 ? entries.length : null;
  }
  return null;
}

export const ContextDock = reactMemo(function ContextDock({ noteId, title, tags, aliases, marginLeft, marginRight, onNavigateMemo }: ContextDockProps) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const setDraftId = useUI((s) => s.setDraftId);
  const setError = useUI((s) => s.setError);

  const [open, setOpen] = useState<OpenCard>(null);
  const [layers, setLayers] = useState<BrainLayer[] | null>(null);
  const [gathering, setGathering] = useState(false);
  const [offline, setOffline] = useState(false);
  const [dropped, setDropped] = useState<number | null>(null);
  const config = useQuery({ queryKey: ["config"], queryFn: getConfig });
  const brainEnabled = config.data?.brain?.enabled !== false;

  const { backlinks, related } = useNoteLinks(noteId);

  const status = useQuery({
    queryKey: ["brain-status"],
    queryFn: brainStatus,
    staleTime: 60_000,
    enabled: brainEnabled,
  });

  // 여백이 무엇을 실어 나르는지. 왼쪽만 보일 때 함께 보기가 갈 곳이 없으면 백링크
  // 버튼(카드 안에 함께 보기가 있다)을 꼬리 줄에 남긴다 — 접힌 여백 때문에 잃는 것이 없게.
  const brainInMargin = brainEnabled && !!marginRight;
  const linksInMargin = !!marginLeft && (!!marginRight || !related.data?.length);

  // See-also section (§3.2): undefined while loading → LinksCard hides it.
  // Contradictions fetch only while the brain card is open (or the right
  // margin shows its count) and online; an error leaves data undefined and
  // the card renders nothing (C1).
  const contradictions = useQuery({
    queryKey: ["brain-contradictions"],
    queryFn: brainContradictions,
    retry: false,
    staleTime: 60_000,
    enabled: (open === "brain" || brainInMargin) && status.data?.online === true,
  });

  // The dialog swaps `noteId` in place when navigating (backlink click, wiki
  // link, distill). Gathered layers and the open card must not leak across
  // notes.
  useEffect(() => {
    setLayers(null);
    setOffline(false);
    setDropped(null);
    setOpen(null);
  }, [noteId]);

  const query = [title, ...tags].filter(Boolean).join(" ") || "최근 노트";

  const gather = () => {
    setGathering(true);
    setOffline(false);
    setDropped(null);
    brainGather(query, 4000)
      .then((v) => {
        setLayers(layersOf(v));
        setDropped(droppedCount(v));
      })
      .catch(() => {
        setOffline(true);
        setLayers(null);
      })
      .finally(() => {
        setGathering(false);
        qc.invalidateQueries({ queryKey: ["brain-status"] });
      });
  };

  const distill = () => {
    if (!layers?.length) return;
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const body = [
      title ? `# ${title} — Brain 컨텍스트` : "# Brain 컨텍스트",
      "",
      `> ${stamp} · oxibrain recall ("${query}")`,
      "",
      ...layers.map((l) => `## ${layerLabel(t, l.kind)}\n\n${l.text.trim()}\n`),
      "---",
      `출처: Brain 컨텍스트 수집 (노트 ${noteId.slice(0, 8)})`,
    ].join("\n");
    createMemo(body, null)
      .then((n) => {
        setOpen(null);
        setDraftId(n.id);
        qc.setQueryData(["memo", n.id], n);
        onNavigateMemo(n.id);
      })
      .catch((e) => setError(String(e).split("\n")[0]));
  };

  const navigateToBacklink = (id: string) => {
    setOpen(null);
    onNavigateMemo(id);
  };

  // 한 줄 Brain 요약 — 꼬리 줄 버튼의 색 점 대신 글자로 상태를 말한다(무채색 앱).
  const contradictionCount = contradictions.data?.length ?? 0;
  const brainSummary = !status.data
    ? t.brain_title
    : !status.data.online
      ? t.brain_offline
      : contradictionCount > 0
        ? `${t.brain_title} · ${t.brain_contradictions} ${contradictionCount}`
        : t.brain_title;

  /** The one Brain popover, anchored to whichever trigger carries it
   *  (footer button, or the right-margin summary line). */
  const brainPopover = (trigger: ReactElement<Record<string, unknown>>, side: "top" | "left") => (
    <Popover.Root open={open === "brain"} onOpenChange={(o) => setOpen(o ? "brain" : null)}>
      <Popover.Trigger render={trigger} />
      <Popover.Portal>
        <Popover.Positioner side={side} align="start" sideOffset={side === "left" ? 8 : 4} collisionPadding={12} className="z-[80]">
          <Popover.Popup className="viewport-popup animate-popover-in rounded-[var(--popover-radius)] border border-line bg-surface-raised shadow-lg">
            <BrainCard
              status={status.data}
              layers={layers}
              gathering={gathering}
              offline={offline}
              dropped={dropped}
              contradictions={contradictions.data}
              onGather={gather}
              onRetryStatus={() => void status.refetch()}
              onDistill={distill}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );

  return (
    <div className="context-dock flex items-center gap-1 border-t border-line px-1 py-1 text-xs text-text-subtle">
      {!linksInMargin && (
      <Popover.Root open={open === "links"} onOpenChange={(o) => setOpen(o ? "links" : null)}>
        <Popover.Trigger
          render={
            <button
              type="button"
              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 transition-colors duration-150 ${
                open === "links" ? "bg-surface-muted text-text" : "hover:bg-surface-muted hover:text-text"
              }`}
            >
              <Link2 size={12} />
              {t.backlinks_title.replace("{n}", String(backlinks.data?.length ?? 0))}
            </button>
          }
        />
        <Popover.Portal>
          <Popover.Positioner side="top" align="start" sideOffset={4} collisionPadding={12} className="z-[80]">
            <Popover.Popup className="viewport-popup animate-popover-in rounded-[var(--popover-radius)] border border-line bg-surface-raised shadow-lg">
              <LinksCard
                backlinks={backlinks.data ?? []}
                seeAlso={related.data}
                isLoading={backlinks.isLoading}
                onNavigate={navigateToBacklink}
              />
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      )}

      {brainEnabled && !brainInMargin && brainPopover(
        <button
          type="button"
          className={`inline-flex items-center gap-1 rounded-md px-2 py-1 transition-colors duration-150 ${
            open === "brain" ? "bg-surface-muted text-text" : "hover:bg-surface-muted hover:text-text"
          }`}
        >
          <Brain size={12} />
          {t.brain_title}
          <span
            aria-label={status.data?.online ? "online" : "offline"}
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              status.data?.online ? "bg-status-success" : "bg-text-subtle/40"
            }`}
          />
        </button>,
        "top",
      )}

      {marginLeft &&
        createPortal(
          <MarginBacklinks
            backlinks={backlinks.data ?? []}
            targets={[title ?? "", ...(aliases ?? [])]}
            onNavigate={navigateToBacklink}
          />,
          marginLeft,
        )}
      {marginRight &&
        createPortal(
          <MarginRelated
            items={related.data}
            onNavigate={navigateToBacklink}
            brain={brainInMargin ? brainPopover(
              <button type="button" className="memo-margin-item">
                <span className="memo-margin-title">{brainSummary}</span>
              </button>,
              "left",
            ) : undefined}
          />,
          marginRight,
        )}
    </div>
  );
});
