/**
 * Links context card (§3.2, docs/superpowers/specs/2026-08-20-note-detail-context-cards-design.md).
 * Presentational only — data fetching and open/close state live in ContextDock.
 * Renders inside a Popover.Popup, sized per the spec: 320px wide, 360px max height.
 */
import { useI18n } from "../lib/i18n";
import { previewText } from "../lib/markdownPreview";
import type { BacklinkInfo } from "../lib/types";

export interface LinksCardProps {
  backlinks: BacklinkInfo[];
  isLoading: boolean;
  onNavigate: (id: string) => void;
}

export function LinksCard({ backlinks, isLoading, onNavigate }: LinksCardProps) {
  const { t } = useI18n();

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
                <button
                  type="button"
                  onClick={() => onNavigate(bl.id)}
                  className="block w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-surface-muted"
                >
                  <span className="block truncate font-medium text-text">{bl.title}</span>
                  <span className="mt-0.5 line-clamp-2 whitespace-pre-line text-text-subtle">
                    {previewText(bl.preview) || ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
