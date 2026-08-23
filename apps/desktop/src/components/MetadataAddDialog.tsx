/**
 * Search-to-add dialog (user prompt 2026-08-24): the first-party add
 * flow for metadata-backed collections (book/movie, or any custom
 * schema declaring mapped fields). Opens INSTEAD of the blank-note
 * creator — search a title, pick a hit, and the note is born with its
 * H1 plus every schema-declared descriptive prop (author/isbn/
 * director/… + source_url + cover_url) stamped in one shot. "직접
 * 추가" keeps the offline path (a blank template note).
 *
 * Stamps ride the backend contract unchanged: createMemo("# title")
 * keeps the body but still inherits the template's frontmatter stamps
 * (e.g. movie `watched_at`); stampMetadata fills only EMPTY props, so
 * template-stamped values win and nothing user-written is touched.
 * The created note is deliberately NOT marked as a draft — it carries
 * real content, closing it must not discard it.
 */
import { Dialog } from "@base-ui-components/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { BookOpen, Clapperboard, Search, X } from "lucide-react";

import {
  createMemo,
  getConfig,
  searchBookMetadata,
  searchMovieMetadata,
  stampMetadata,
  type MetaHit,
} from "../lib/api";
import { effectiveRegion, metadataDomainOf } from "../lib/metadataRegion";
import { schemaDisplayName } from "../lib/folders";
import { useI18n } from "../lib/i18n";
import { useUI } from "../stores/ui";
import type { FolderSchema } from "../lib/types";

const DOMAIN_ICON = { book: BookOpen, movie: Clapperboard } as const;

export function MetadataAddDialog({
  open,
  onOpenChange,
  folder,
  schema,
  /** Blank-note fallback (the pre-dialog behavior). */
  onManual,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folder: string;
  schema: FolderSchema | null;
  onManual: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const select = useUI((s) => s.select);
  const setError = useUI((s) => s.setError);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<MetaHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);

  const domain = metadataDomainOf(schema);
  const config = useQuery({
    queryKey: ["config"],
    queryFn: getConfig,
    staleTime: 60_000,
    enabled: open,
  });
  // Auto ("") region resolves through Intl here; an explicit stored
  // choice rides the config into the backend (same rule as the fill
  // popover in PropertyPanel).
  const region = config.data?.metadata?.region
    ? undefined
    : effectiveRegion("") || undefined;

  const name = schema
    ? schemaDisplayName(folder, schema, t)
    : "";
  const Icon = domain ? DOMAIN_ICON[domain] : BookOpen;

  const reset = () => {
    setQ("");
    setHits(null);
    setBusy(false);
    setAdding(null);
  };

  const close = () => {
    onOpenChange(false);
    reset();
  };

  const run = async () => {
    if (!q.trim() || !domain) return;
    setBusy(true);
    try {
      const list =
        domain === "book"
          ? await searchBookMetadata(q, region)
          : await searchMovieMetadata(q, region);
      setHits(list);
    } catch {
      setHits([]);
    } finally {
      setBusy(false);
    }
  };

  const pick = async (hit: MetaHit) => {
    setAdding(hit.url ?? hit.title);
    try {
      const memo = await createMemo(`# ${hit.title}`, folder);
      // Browser fallback returns null from stamp — the note (with its
      // H1) is still created; only the cache set is skipped.
      const dto = await stampMetadata(memo.id, hit).catch(() => null);
      if (dto) qc.setQueryData(["memo", memo.id], dto);
      select(memo.id);
      void qc.invalidateQueries({ queryKey: ["memos"] });
      void qc.invalidateQueries({ queryKey: ["facets"] });
      close();
    } catch (e) {
      setError(String(e).split("\n")[0]);
      setAdding(null);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm transition-opacity duration-200 ease-out data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup
          autoFocus
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(560px,80vh)] w-[min(520px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[var(--dialog-radius)] border border-line bg-surface shadow-lg transition-[opacity,scale] duration-200 ease-out data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0 data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0"
        >
          {/* Header: collection identity + close */}
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
            <Icon size={15} className="shrink-0 text-text-subtle" aria-hidden />
            <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-text">
              {t.metadata_add_title.replace("{name}", name)}
            </h2>
            <Dialog.Close
              aria-label={t.close}
              className="rounded-lg p-1 text-text-subtle transition-colors hover:bg-surface-muted hover:text-text-muted"
            >
              <X size={15} />
            </Dialog.Close>
          </div>

          {/* Search form */}
          <form
            className="flex shrink-0 gap-1.5 px-4 pt-3"
            onSubmit={(e) => {
              e.preventDefault();
              void run();
            }}
          >
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t.metadata_fill_query}
              className="min-w-0 flex-1 rounded-[var(--button-radius)] border border-line bg-surface-sunken px-3 py-1.5 text-[13px] text-text outline-none placeholder:text-text-subtle focus:ring-1 focus:ring-line"
            />
            <button
              type="submit"
              disabled={busy || !q.trim()}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-[var(--button-radius)] bg-interactive-primary px-3 py-1.5 text-[12px] font-medium text-interactive-primary-foreground transition-colors hover:bg-interactive-primary-hover disabled:opacity-50"
            >
              <Search size={13} aria-hidden />
              {busy ? "…" : t.metadata_fill_search}
            </button>
          </form>

          {/* Results */}
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {hits === null ? (
              <p className="py-6 text-center text-xs leading-relaxed text-text-subtle">
                {t.schema_empty_sub_search}
              </p>
            ) : hits.length === 0 ? (
              <p className="py-6 text-center text-xs leading-relaxed text-text-subtle">
                {t.metadata_fill_empty}
              </p>
            ) : (
              <ul role="listbox" className="space-y-1">
                {hits.map((h) => (
                  <li key={`${h.provider}:${h.url ?? h.title}:${h.subtitle ?? ""}`}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={false}
                      disabled={adding !== null}
                      onClick={() => void pick(h)}
                      className="flex w-full items-center gap-3 rounded-[var(--button-radius)] border border-line bg-surface-sunken px-2.5 py-2 text-left transition-colors hover:bg-surface-muted disabled:opacity-50"
                    >
                      {/* Cover thumb — poster ratio like the shelf; a
                          typographic stand-in keeps rows aligned. */}
                      {h.cover_url ? (
                        <img
                          src={h.cover_url}
                          alt=""
                          loading="lazy"
                          className="h-14 w-10 shrink-0 rounded-[4px] object-cover"
                        />
                      ) : (
                        <span className="grid h-14 w-10 shrink-0 place-items-center rounded-[4px] bg-surface-muted text-text-subtle">
                          <Icon size={14} aria-hidden />
                        </span>
                      )}
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="line-clamp-1 text-[13px] font-medium text-text">
                          {h.title}
                        </span>
                        {h.subtitle && (
                          <span className="line-clamp-1 text-[11px] text-text-subtle">
                            {h.subtitle}
                          </span>
                        )}
                        <span className="text-[10px] uppercase tracking-wide text-text-subtle/80">
                          {t.metadata_fill_provider}: {h.provider}
                        </span>
                      </span>
                      {adding === (h.url ?? h.title) && (
                        <span className="shrink-0 text-[11px] font-medium text-interactive-primary">
                          {t.metadata_add_creating}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {/* Manual fallback */}
          <div className="shrink-0 border-t border-line px-4 py-3">
            <button
              type="button"
              onClick={() => {
                close();
                onManual();
              }}
              className="w-full rounded-[var(--button-radius)] border border-line px-3 py-1.5 text-[12px] font-medium text-text-muted transition-colors hover:bg-surface-muted"
            >
              {t.metadata_add_manual}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
