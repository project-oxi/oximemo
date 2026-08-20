/**
 * TimelineView — a chronological list grouped by day, ideal for diary-style
 * folders. Renders items in descending updated_at order with a sticky day
 * header for each group.
 *
 * Timeline scope is recursive (T5: folder-filtered results include all
 * descendants), so the FolderChipBar above the first group lets the user
 * pivot to a sibling without using the breadcrumb, and each item carries
 * its source folder chip so a note from `작업/회고` shown under the root
 * timeline is clearly attributable.
 */
import { useMemo } from "react";

import { FolderChipBar } from "../FolderChipBar";
import { colorForFolder } from "../../lib/color";
import { relativeTime } from "../../lib/time";
import { useI18n } from "../../lib/i18n";
import type { FolderCard, FolderDef, MemoSummary } from "../../lib/types";

interface Props {
  items: MemoSummary[];
  folders: FolderDef[];
  folderCards: FolderCard[];
  onOpenFolder: (path: string) => void;
  onSelect: (id: string) => void;
  onToggleFavorite: (id: string, favorite: boolean) => void;
  onMoveFolder: (id: string, folder: string) => void;
  onCopyBody: (id: string) => void;
  onDelete: (id: string) => void;
  onNewNote?: () => void;
  onNewFolder: () => void;
}

function dayKey(iso: string): string {
  // YYYY-MM-DD prefix
  return iso.slice(0, 10);
}

export function TimelineView({
  items,
  folders,
  folderCards,
  onOpenFolder,
  onSelect,
  onNewFolder,
}: Props) {
  const { t, locale } = useI18n();
  const groups = useMemo(() => {
    const m = new Map<string, MemoSummary[]>();
    for (const it of items) {
      const k = dayKey(it.updated_at);
      const arr = m.get(k) ?? [];
      arr.push(it);
      m.set(k, arr);
    }
    return [...m.entries()].sort(([a], [b]) => b.localeCompare(a));
  }, [items]);

  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-12">
      <FolderChipBar
        cards={folderCards}
        folderDefs={folders}
        onOpen={onOpenFolder}
        onNewFolder={onNewFolder}
      />
      {groups.map(([day, group]) => (
        <section key={day}>
          <h2 className="sticky top-0 z-10 -mx-2 mb-2 bg-surface-raised/80 px-2 py-1 text-xs font-semibold uppercase tracking-wider text-text-subtle backdrop-blur">
            {day}
          </h2>
          <ul className="space-y-1.5">
            {group.map((n) => (
              <li
                key={n.id}
                onClick={() => onSelect(n.id)}
                className="group cursor-pointer rounded-lg border border-transparent px-3 py-2 transition-colors hover:border-line hover:bg-surface-muted"
              >
                <div className="flex items-baseline justify-between gap-3">
                  {n.title ? (
                    <span className="truncate text-sm font-semibold text-text">{n.title}</span>
                  ) : (
                    <span className="truncate text-sm text-text-subtle">{t.empty_memo}</span>
                  )}
                  <span className="shrink-0 text-[11px] tabular-nums text-text-subtle">
                    {relativeTime(n.updated_at, locale)}
                  </span>
                </div>
                <div className="mt-1 line-clamp-2 text-xs text-text-subtle">{n.preview || ""}</div>
                {n.tags.length > 0 && (
                  <div className="mt-1.5 flex gap-1">
                    {n.tags.slice(0, 4).map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full bg-status-warning-subtle px-1.5 py-0.5 text-[10px] text-hue-amber"
                      >
                        #{tag}
                      </span>
                    ))}
                  </div>
                )}
                {n.folder && (
                  <span
                    data-note-folder={n.folder}
                    className="mt-1.5 inline-flex items-center gap-1 font-mono text-[10px] text-text-subtle"
                  >
                    <i
                      className="size-1.5 rounded-[2px]"
                      style={{ backgroundColor: colorForFolder(n.folder, folders) }}
                    />
                    {n.folder}/
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
