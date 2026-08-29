/**
 * Context Dock (§3.1, docs/superpowers/specs/2026-08-20-note-detail-context-cards-design.md).
 * Bottom status bar for the note detail dialog. Owns the backlinks query,
 * the brain status/gather/distill state, and which context card (if any)
 * is open — only one card open at a time, per the interaction contract (§3.4).
 * Replaces the former BacklinksPanel + BrainPanel accordion stack.
 */
import { Popover } from "@base-ui-components/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Brain, Link2 } from "lucide-react";

import { brainGather, brainStatus, createMemo, getBacklinks, getConfig } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useUI } from "../stores/ui";
import type { BrainLayer } from "../lib/types";
import { BrainCard, layerLabel } from "./BrainCard";
import { LinksCard } from "./LinksCard";

export interface ContextDockProps {
  noteId: string;
  title: string | null;
  tags: string[];
  dirty: boolean;
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

export function ContextDock({ noteId, title, tags, dirty }: ContextDockProps) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const select = useUI((s) => s.select);
  const setDraftId = useUI((s) => s.setDraftId);
  const setError = useUI((s) => s.setError);

  const [open, setOpen] = useState<OpenCard>(null);
  const [layers, setLayers] = useState<BrainLayer[] | null>(null);
  const [gathering, setGathering] = useState(false);
  const [offline, setOffline] = useState(false);
  const [dropped, setDropped] = useState<number | null>(null);
  const config = useQuery({ queryKey: ["config"], queryFn: getConfig });
  const brainEnabled = config.data?.brain?.enabled !== false;

  const backlinks = useQuery({
    queryKey: ["backlinks", noteId],
    queryFn: () => getBacklinks(noteId),
    enabled: !!noteId,
  });

  const status = useQuery({
    queryKey: ["brain-status"],
    queryFn: brainStatus,
    staleTime: 60_000,
    enabled: brainEnabled,
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
        select(n.id);
      })
      .catch((e) => setError(String(e).split("\n")[0]));
  };

  const navigateToBacklink = (id: string) => {
    setOpen(null);
    select(id);
  };

  return (
    <div className="flex items-center gap-1 border-t border-line px-1 py-1 text-xs text-text-subtle">
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
          <Popover.Positioner side="top" align="start" sideOffset={4} className="z-[60]">
            <Popover.Popup className="max-w-[calc(100vw-32px)] animate-popover-in rounded-[var(--popover-radius)] border border-line bg-surface-raised shadow-lg">
              <LinksCard
                backlinks={backlinks.data ?? []}
                isLoading={backlinks.isLoading}
                onNavigate={navigateToBacklink}
              />
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>

      {brainEnabled && (
        <Popover.Root open={open === "brain"} onOpenChange={(o) => setOpen(o ? "brain" : null)}>
          <Popover.Trigger
            render={
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
              </button>
            }
          />
          <Popover.Portal>
            <Popover.Positioner side="top" align="start" sideOffset={4} className="z-[60]">
              <Popover.Popup className="max-w-[calc(100vw-32px)] animate-popover-in rounded-[var(--popover-radius)] border border-line bg-surface-raised shadow-lg">
                <BrainCard
                  status={status.data}
                  layers={layers}
                  gathering={gathering}
                  offline={offline}
                  dropped={dropped}
                  onGather={gather}
                  onRetryStatus={() => void status.refetch()}
                  onDistill={distill}
                />
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      )}

      <span className="ml-auto">{dirty ? t.dock_saving : t.dock_saved}</span>
    </div>
  );
}
