/**
 * Brain context panel (§D9–D11). Sits below the backlinks panel in
 * MemoDetail and bridges oximemo ↔ the oxibrain daemon:
 *
 *  - mount: one `brain_status` probe → status dot + counts (offline is a
 *    normal state, shown as one line; note editing is never affected)
 *  - "컨텍스트 수집": `brain_gather` = recall(query = title + tags, budget)
 *    → renders the returned layers with per-kind labels
 *  - "새 노트로 정리": distills the gathered layers into a markdown note
 *    with a reference list
 *
 * Hidden entirely when `config.brain.enabled === false` (§D13).
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Brain, ChevronDown, ChevronRight, Sparkles } from "lucide-react";
import { useI18n, type Dict } from "../lib/i18n";
import { brainGather, brainStatus, createMemo, getConfig } from "../lib/api";
import { useUI } from "../stores/ui";
import type { BrainLayer } from "../lib/types";

interface Props {
  noteId: string;
  title: string | null;
  tags: string[];
}

const LAYER_LABEL_KEYS: Partial<
  Record<string, "brain_layer_recent_episodes" | "brain_layer_query_neighborhood" | "brain_layer_high_salience_beliefs" | "brain_layer_summaries">
> = {
  recent_episodes: "brain_layer_recent_episodes",
  query_neighborhood: "brain_layer_query_neighborhood",
  high_salience_beliefs: "brain_layer_high_salience_beliefs",
  summaries: "brain_layer_summaries",
};

function layerLabel(t: Dict, kind: string): string {
  const key = LAYER_LABEL_KEYS[kind] ?? "brain_layer_other";
  return t[key];
}

/** recall() returns `{layers: [{kind, text}, ...]}`; be defensive about
 * shape drift between daemon versions. */
function layersOf(value: unknown): BrainLayer[] {
  if (!value || typeof value !== "object") return [];
  const raw = (value as { layers?: unknown }).layers;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((l) => {
    if (!l || typeof l !== "object") return [];
    const { kind, text } = l as { kind?: unknown; text?: unknown };
    if (typeof kind !== "string" || typeof text !== "string") return [];
    return [{ kind, text }];
  });
}

export function BrainPanel({ noteId, title, tags }: Props) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const select = useUI((s) => s.select);
  const setDraftId = useUI((s) => s.setDraftId);
  const setError = useUI((s) => s.setError);
  const [collapsed, setCollapsed] = useState(false);
  const [layers, setLayers] = useState<BrainLayer[] | null>(null);
  const [gathering, setGathering] = useState(false);
  const [offline, setOffline] = useState(false);

  const config = useQuery({ queryKey: ["config"], queryFn: getConfig });
  const status = useQuery({
    queryKey: ["brain-status"],
    queryFn: brainStatus,
    staleTime: 60_000,
  });

  if (config.data?.brain?.enabled === false) return null;

  const query = [title, ...tags].filter(Boolean).join(" ") || "최근 노트";

  const gather = () => {
    setGathering(true);
    setOffline(false);
    brainGather(query, 4000)
      .then((v) => setLayers(layersOf(v)))
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
      ...layers.map((l) => {
        const label = layerLabel(t, l.kind);
        return `## ${label}\n\n${l.text.trim()}\n`;
      }),
      "---",
      `출처: Brain 컨텍스트 수집 (노트 ${noteId.slice(0, 8)})`,
    ].join("\n");
    createMemo(body, null)
      .then((n) => {
        setDraftId(n.id);
        select(n.id);
      })
      .catch((e) => setError(String(e).split("\n")[0]));
  };

  const online = status.data?.online === true;

  return (
    <div className="border-t border-line">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-xs font-medium text-text-subtle hover:text-text"
      >
        {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        <Brain size={12} />
        {t.brain_title}
        <span
          aria-label={online ? "online" : "offline"}
          title={
            online
              ? t.brain_episodes
                  .replace("{n}", String(status.data?.episodes ?? 0))
                  .replace("{e}", String(status.data?.entities ?? 0))
              : t.brain_offline
          }
          className={`ml-1 inline-block h-1.5 w-1.5 rounded-full ${
            online ? "bg-status-ok" : "bg-text-subtle/40"
          }`}
        />
      </button>
      {!collapsed && (
        <div className="px-3 pb-2">
          {!online ? (
            <div className="flex items-center gap-2 py-1 text-xs text-text-subtle">
              {t.brain_offline}
              <button
                type="button"
                onClick={() => void status.refetch()}
                className="rounded-md px-1.5 py-0.5 text-xs hover:bg-surface-muted hover:text-text"
              >
                {t.brain_retry}
              </button>
            </div>
          ) : layers === null ? (
            <button
              type="button"
              onClick={gather}
              disabled={gathering}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2 py-1 text-xs text-text-subtle transition-colors hover:bg-surface-muted hover:text-text disabled:opacity-50"
            >
              <Sparkles size={12} />
              {gathering ? t.brain_gathering : t.brain_gather}
            </button>
          ) : (
            <div className="space-y-2">
              {layers.length === 0 && (
                <p className="py-1 text-xs text-text-subtle">{t.brain_layer_other}</p>
              )}
              {layers.map((l, i) => (
                <div key={`${l.kind}-${i}`} className="rounded-md bg-surface-muted/60 px-2 py-1.5">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-text-subtle">
                    {layerLabel(t, l.kind)}
                  </p>
                  <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-text">
                    {l.text.trim()}
                  </pre>
                </div>
              ))}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={gather}
                  disabled={gathering}
                  className="rounded-lg border border-line px-2 py-1 text-xs text-text-subtle hover:bg-surface-muted hover:text-text disabled:opacity-50"
                >
                  {gathering ? t.brain_gathering : t.brain_gather}
                </button>
                <button
                  type="button"
                  onClick={distill}
                  disabled={layers.length === 0}
                  className="rounded-lg bg-interactive-primary px-2 py-1 text-xs text-interactive-primary-foreground hover:bg-interactive-primary/90 disabled:opacity-40"
                >
                  {t.brain_distill}
                </button>
              </div>
            </div>
          )}
          {offline && online && (
            <p className="pt-1 text-[10px] text-text-subtle">{t.brain_offline}</p>
          )}
        </div>
      )}
    </div>
  );
}
