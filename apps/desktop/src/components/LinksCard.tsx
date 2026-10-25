/**
 * Links context card (§3.2, docs/superpowers/specs/2026-08-20-note-detail-context-cards-design.md).
 * Presentational only — data fetching and open/close state live in ContextDock.
 * Renders inside a Popover.Popup, sized per the spec: 320px wide, 360px max height.
 */
import { FileText, Link2 } from "lucide-react";
import { useSyncExternalStore } from "react";

import { useI18n } from "../lib/i18n";
import { previewExcerpt, previewText } from "../lib/markdownPreview";
import { queryCountVersion, subscribeQueryCounts } from "../lib/queryPreviewCounts";
import type { BacklinkInfo, MemoSummary } from "../lib/types";

import { CtxRoot, CtxTrigger, CtxMenu, CtxItem } from "./ContextMenu";

export interface LinksCardProps {
  backlinks: BacklinkInfo[];
  /** Related-note candidates (BM25 see-also); undefined while loading/idle. */
  seeAlso?: MemoSummary[];
  isLoading: boolean;
  onNavigate: (id: string) => void;
}

export function LinksCard({ backlinks, seeAlso, isLoading, onNavigate }: LinksCardProps) {
  const { t } = useI18n();
  useSyncExternalStore(subscribeQueryCounts, queryCountVersion);

  return (
    <div className="flex max-h-[360px] w-80 flex-col overflow-hidden">
      <div className="border-b border-line px-3 py-2 text-xs font-medium text-text-subtle">
        {t.backlinks_title.replace("{n}", String(backlinks.length))}
      </div>
      <div className="overflow-y-auto px-1 py-1">
        {isLoading ? (
          <p className="px-2 py-2 text-xs text-text-subtle">…</p>
        ) : backlinks.length === 0 ? (
          <p className="px-2 py-2 text-xs text-text-subtle">{t.backlinks_empty}</p>
        ) : (
          <ul className="space-y-0.5">
            {backlinks.map((bl) => (
              <li key={bl.id}>
                <CtxRoot>
                  <CtxTrigger
                    render={
                      <button
                        type="button"
                        onClick={() => onNavigate(bl.id)}
                        className="block w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-surface-muted"
                      />
                    }
                  >
                    <span className="block truncate font-medium text-text">{bl.title}</span>
                    <span className="mt-0.5 line-clamp-2 whitespace-pre-line text-text-subtle">
                      {previewText(previewExcerpt(bl.preview, bl.title), 200, { thisId: bl.id, resultsN: t.query_embed_results_n }) || ""}
                    </span>
                    <CtxMenu>
                      <CtxItem
                        icon={FileText}
                        label={t.link_open_note}
                        onClick={() => onNavigate(bl.id)}
                      />
                      <CtxItem
                        icon={Link2}
                        label={t.link_copy_wikilink}
                        onClick={() => {
                          void navigator.clipboard.writeText(`[[${bl.title}]]`);
                        }}
                      />
                    </CtxMenu>
                  </CtxTrigger>
                </CtxRoot>
              </li>
            ))}
          </ul>
        )}
        {seeAlso && seeAlso.length > 0 && (
          <div className="mt-1 border-t border-line px-1 pt-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-text-subtle">{t.see_also}</p>
            <ul className="mt-0.5 space-y-0.5">
              {seeAlso.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => onNavigate(m.id)}
                    className="block w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-surface-muted"
                  >
                    <span className="block truncate font-medium text-text">{m.title || m.folder || m.path}</span>
                    <span className="mt-0.5 line-clamp-2 whitespace-pre-line text-text-subtle">
                      {previewText(previewExcerpt(m.preview, m.title, m.path), 200) || ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
