/**
 * Backlinks panel (§4.3). Shows notes that link to the currently open note
 * via `[[Title]]`. Fetches via `get_backlinks` Tauri command. Collapsible.
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ChevronDown, ChevronRight, Link2 } from "lucide-react";

import { getBacklinks } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useUI } from "../stores/ui";

interface Props {
  noteId: string;
}

export function BacklinksPanel({ noteId }: Props) {
  const { t } = useI18n();
  const select = useUI((s) => s.select);
  const [collapsed, setCollapsed] = useState(false);

  const q = useQuery({
    queryKey: ["backlinks", noteId],
    queryFn: () => getBacklinks(noteId),
    enabled: !!noteId,
  });

  const backlinks = q.data ?? [];

  return (
    <div className="border-t border-line">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-xs font-medium text-text-subtle hover:text-text"
      >
        {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        <Link2 size={12} />
        {t.backlinks_title.replace("{n}", String(backlinks.length))}
      </button>
      {!collapsed && (
        <div className="max-h-48 overflow-y-auto px-3 pb-2">
          {backlinks.length === 0 ? (
            <p className="py-2 text-xs text-text-subtle">{t.backlinks_empty}</p>
          ) : (
            <ul className="space-y-1">
              {backlinks.map((bl) => (
                <li key={bl.id}>
                  <button
                    type="button"
                    onClick={() => select(bl.id)}
                    className="block w-full truncate rounded-md px-2 py-1.5 text-left text-xs hover:bg-surface-muted"
                  >
                    <span className="font-medium text-text">{bl.title}</span>
                    <span className="mt-0.5 block truncate text-text-subtle">
                      {bl.preview}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
