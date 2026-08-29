/**
 * Brain context card (§3.3, docs/superpowers/specs/2026-08-20-note-detail-context-cards-design.md).
 * Presentational only — the gather/distill state machine lives in ContextDock
 * so results survive the popover closing and reopening. Renders inside a
 * Popover.Popup, sized per the spec: 360px wide, min(480px, 65vh) max height.
 *
 * Brain 0.10 cutover: "offline" is a failure reason (binary missing, spawn
 * failure, …), not a daemon state; truncation is surfaced via `meta.dropped`.
 */
import { Sparkles } from "lucide-react";
import { useI18n, type Dict } from "../lib/i18n";
import type { BrainLayer, BrainStatus } from "../lib/types";

const LAYER_LABEL_KEYS: Partial<
  Record<
    string,
    | "brain_layer_recent_episodes"
    | "brain_layer_query_neighborhood"
    | "brain_layer_high_salience_beliefs"
    | "brain_layer_summaries"
  >
> = {
  recent_episodes: "brain_layer_recent_episodes",
  query_neighborhood: "brain_layer_query_neighborhood",
  high_salience_beliefs: "brain_layer_high_salience_beliefs",
  summaries: "brain_layer_summaries",
};

export function layerLabel(t: Dict, kind: string): string {
  const key = LAYER_LABEL_KEYS[kind] ?? "brain_layer_other";
  return t[key];
}

/** Localized one-liner for a failure reason; falls back to the generic
 *  offline copy for unknown reasons (forward compatibility). */
function offlineReasonLine(t: Dict, status: BrainStatus | undefined): string {
  const reason = status?.reason;
  if (!reason || reason === "disabled") return t.brain_offline;
  const key = `brain_reason_${reason}` as keyof Dict;
  return (t[key] as string | undefined) ?? t.brain_offline;
}

export interface BrainCardProps {
  status: BrainStatus | undefined;
  layers: BrainLayer[] | null;
  gathering: boolean;
  offline: boolean;
  /** Count of results the brain truncated (`meta.dropped`); null when
   *  nothing was reported. */
  dropped: number | null;
  onGather: () => void;
  onRetryStatus: () => void;
  onDistill: () => void;
}

export function BrainCard({
  status,
  layers,
  gathering,
  offline,
  dropped,
  onGather,
  onRetryStatus,
  onDistill,
}: BrainCardProps) {
  const { t } = useI18n();
  const online = status?.online === true;

  return (
    <div className="flex max-h-[min(480px,65vh)] w-[360px] flex-col overflow-hidden">
      <div className="flex items-center gap-1.5 border-b border-line px-3 py-2 text-xs font-medium text-text">
        <span
          aria-label={online ? "online" : (status?.reason ?? "offline")}
          className={`inline-block h-1.5 w-1.5 rounded-full ${
            online ? "bg-status-success" : "bg-text-subtle/40"
          }`}
        />
        {t.brain_title}
        {online && (
          <span className="ml-1 font-normal text-text-subtle">
            {t.brain_episodes
              .replace("{n}", String(status?.episodes ?? 0))
              .replace("{e}", String(status?.entities ?? 0))}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {!online ? (
          <div className="flex items-center gap-2 py-1 text-xs text-text-subtle">
            {offlineReasonLine(t, status)}
            <button
              type="button"
              onClick={onRetryStatus}
              className="rounded-md px-1.5 py-0.5 text-xs hover:bg-surface-muted hover:text-text"
            >
              {t.brain_retry}
            </button>
          </div>
        ) : layers === null ? (
          <button
            type="button"
            onClick={onGather}
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
            {dropped !== null && dropped > 0 && (
              <p className="pt-1 text-[10px] text-text-subtle">
                {t.brain_dropped.replace("{n}", String(dropped))}
              </p>
            )}
          </div>
        )}
        {offline && online && (
          <p className="pt-1 text-[10px] text-text-subtle">{t.brain_offline}</p>
        )}
      </div>
      {online && layers !== null && (
        <div className="flex gap-2 border-t border-line px-3 py-2">
          <button
            type="button"
            onClick={onGather}
            disabled={gathering}
            className="rounded-lg border border-line px-2 py-1 text-xs text-text-subtle hover:bg-surface-muted hover:text-text disabled:opacity-50"
          >
            {gathering ? t.brain_gathering : t.brain_gather}
          </button>
          <button
            type="button"
            onClick={onDistill}
            disabled={layers.length === 0}
            className="rounded-lg bg-interactive-primary px-2 py-1 text-xs text-interactive-primary-foreground hover:bg-interactive-primary/90 disabled:opacity-40"
          >
            {t.brain_distill}
          </button>
        </div>
      )}
    </div>
  );
}
