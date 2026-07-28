/**
 * Card grid: virtualized (tanstack/react-virtual) responsive grid backed by
 * TanStack Query. The grid is CSS Grid with auto-fill; virtualization keeps
 * the DOM bounded even with thousands of notes (§5.6, §7.2).
 */
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";

import { listNotes, searchNotes, deleteNote, updateNote } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useUI } from "../stores/ui";
import type { NoteSummary } from "../lib/types";
import { Card } from "./Card";

const PAGE_SIZE = 50;

export function CardGrid() {
  const { t } = useI18n();
  const search = useUI((s) => s.search);
  const setSearch = useUI((s) => s.setSearch);
  const select = useUI((s) => s.select);
  const [debounced, setDebounced] = useState(search);
  const [localSearch, setLocalSearch] = useState(search);
  const qc = useQueryClient();

  // 200ms debounce on the search field (§7.5).
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(localSearch), 200);
    return () => window.clearTimeout(id);
  }, [localSearch]);

  const listing = useInfiniteQuery({
    queryKey: ["notes", debounced],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => listNotes(pageParam, PAGE_SIZE, null),
    getNextPageParam: (last) => last.next_cursor,
  });

  const searching = useInfiniteQuery({
    queryKey: ["search", debounced],
    initialPageParam: null as string | null,
    enabled: debounced.length > 0,
    queryFn: () => searchNotes(debounced, 100),
    getNextPageParam: () => null,
  });

  const items: NoteSummary[] = useMemo(() => {
    if (debounced) return searching.data?.pages.flat() ?? [];
    return listing.data?.pages.flatMap((p) => p.items) ?? [];
  }, [debounced, listing.data, searching.data]);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => 200,
    overscan: 6,
  });

  // Fetch next listing page when the virtualizer's last item is in view.
  useEffect(() => {
    const last = virtualizer.getVirtualItems().at(-1);
    if (!last) return;
    if (last.index >= items.length - 8 && listing.hasNextPage) {
      void listing.fetchNextPage();
    }
  }, [virtualizer, items.length, listing]);

  const onDelete = (id: string) => {
    void deleteNote(id).then(() => {
      void qc.invalidateQueries({ queryKey: ["notes"] });
      void qc.invalidateQueries({ queryKey: ["search"] });
    });
  };

  const onTogglePin = (id: string) => {
    void updateNote(id, null, null, true, null).then(() => {
      void qc.invalidateQueries({ queryKey: ["notes"] });
    });
  };

  return (
    <div className="flex h-full flex-col">
      <header
        data-tauri-drag-region
        className="flex h-12 items-center gap-3 border-b border-zinc-200 bg-white/80 px-4 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/80"
      >
        <div className="relative w-72">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400"
          />
          <input
            type="text"
            value={localSearch}
            onChange={(e) => {
              setLocalSearch(e.target.value);
              setSearch(e.target.value);
            }}
            placeholder={t.search_placeholder}
            className="w-full rounded-full border border-zinc-200 bg-transparent py-1.5 pl-8 pr-3 text-sm placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none dark:border-zinc-700 dark:focus:border-zinc-500"
          />
        </div>
      </header>
      <div ref={scrollerRef} className="flex-1 overflow-y-auto p-4">
        {items.length === 0 ? (
          <div className="mt-20 text-center text-sm text-zinc-400">{t.empty_hint}</div>
        ) : (
          <div
            style={{ height: virtualizer.getTotalSize() }}
            className="relative w-full"
          >
            {virtualizer.getVirtualItems().map((v) => {
              const n = items[v.index];
              if (!n) return null;
              return (
                <div
                  key={n.id}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    transform: `translateY(${v.start}px)`,
                    width: "100%",
                    padding: "6px",
                  }}
                >
                  <Card
                    note={n}
                    onSelect={select}
                    onTogglePin={onTogglePin}
                    onDelete={onDelete}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
