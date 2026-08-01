/**
 * Gallery: every image across all memos in one grid.
 *
 * Assets live content-addressed in the vault (see `lib/assets.ts`); this view
 * lists them via `list_assets` and renders each thumbnail from its `oximg://`
 * URL (native in Tauri, blob-swapped in browser-dev). Click opens a lightbox;
 * the header has a "clean unused" action that GCs assets no memo references.
 *
 * Refreshes on `memos:changed` so an image pasted into a memo surfaces here.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Images, Trash2, X } from "lucide-react";

import { gcAssets, listAssets, resolveImageUrl, type AssetInfo } from "../lib/assets";
import { useI18n } from "../lib/i18n";
import { listen } from "../lib/tauri";
import { useUI } from "../stores/ui";

/** One thumbnail; resolves its oximg URL to a loadable src on mount. */
function Thumb({ asset, onOpen }: { asset: AssetInfo; onOpen: (a: AssetInfo) => void }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    void resolveImageUrl(asset.url).then(setSrc);
  }, [asset.url]);
  return (
    <button
      type="button"
      onClick={() => onOpen(asset)}
      className="group/img relative aspect-square w-full overflow-hidden rounded-lg border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900"
    >
      {src ? (
        <img
          src={src}
          alt={asset.name}
          loading="lazy"
          className="h-full w-full object-cover transition-transform group-hover/img:scale-[1.03]"
        />
      ) : (
        <div className="h-full w-full animate-pulse bg-zinc-200 dark:bg-zinc-800" />
      )}
    </button>
  );
}

export function GalleryView() {
  const { t } = useI18n();
  const setView = useUI((s) => s.setView);
  const setToast = useUI((s) => s.setToast);
  const qc = useQueryClient();
  const [lightbox, setLightbox] = useState<AssetInfo | null>(null);
  const [cleaning, setCleaning] = useState(false);

  const assets = useQuery({ queryKey: ["assets"], queryFn: listAssets });

  useEffect(() => {
    let un: (() => void) | undefined;
    void listen("memos:changed", () => qc.invalidateQueries({ queryKey: ["assets"] })).then((u) => {
      un = u;
    });
    return () => un?.();
  }, [qc]);

  const onClean = () => {
    setCleaning(true);
    gcAssets()
      .then((n) => {
        setToast(t.cleaned_n.replace("{n}", String(n)));
        return qc.invalidateQueries({ queryKey: ["assets"] });
      })
      .catch(() => {})
      .finally(() => setCleaning(false));
  };

  const items = assets.data ?? [];

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
        <div className="flex items-center gap-2 text-sm font-semibold text-zinc-700 dark:text-zinc-200">
          <Images size={15} /> {t.gallery}
          {items.length > 0 && (
            <span className="text-[11px] font-normal text-zinc-400">
              {t.gallery_count.replace("{n}", String(items.length))}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onClean}
            disabled={cleaning || items.length === 0}
            className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-2.5 py-1 text-[11px] text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <Trash2 size={12} /> {t.clean_unused}
          </button>
          <button
            type="button"
            onClick={() => setView("memos")}
            className="inline-flex items-center rounded-full border border-zinc-200 px-2.5 py-1 text-[11px] text-zinc-500 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            {t.all_memos}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {assets.isLoading ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="aspect-square animate-pulse rounded-lg bg-zinc-200 dark:bg-zinc-800" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="mt-24 flex flex-col items-center gap-2 text-center">
            <Images size={28} className="text-zinc-300 dark:text-zinc-700" />
            <p className="max-w-sm text-sm text-zinc-400">{t.gallery_empty}</p>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3">
            {items.map((a) => (
              <Thumb key={a.name} asset={a} onOpen={setLightbox} />
            ))}
          </div>
        )}
      </div>

      {lightbox && <Lightbox asset={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}

function Lightbox({ asset, onClose }: { asset: AssetInfo; onClose: () => void }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    void resolveImageUrl(asset.url).then(setSrc);
  }, [asset.url]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-8 backdrop-blur-sm"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="close"
        className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
      >
        <X size={18} />
      </button>
      {src && (
        <img
          src={src}
          alt={asset.name}
          className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        />
      )}
    </div>
  );
}
