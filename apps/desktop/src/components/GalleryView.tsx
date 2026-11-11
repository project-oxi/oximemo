/**
 * Gallery: every image across all memos in one grid.
 *
 * Assets live content-addressed in the vault (see `lib/assets.ts`); this view
 * lists them via `list_assets` and renders each thumbnail from its `oximg://`
 * URL (native in Tauri, blob-swapped in browser-dev). Click opens the memo
 * that contains the image (lightbox fallback for orphan assets); the header
 * has a "clean unused" action that GCs assets no memo references.
 *
 * Refreshes on `memos:changed` so an image pasted into a memo surfaces here.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Skeleton } from "@garden/ui";
import { useEffect, useState } from "react";
import { FileText, Images, Maximize2, Trash2, X } from "lucide-react";

import { gcAssets, listAssets, resolveImageUrl, unusedAssets, type AssetInfo } from "../lib/assets";
import { memoForAsset } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { listen } from "../lib/tauri";
import { useUI } from "../stores/ui";
import { CtxRoot, CtxTrigger, CtxMenu, CtxItem } from "./ContextMenu";
import "./GalleryView.css";

/** One thumbnail; resolves its oximg URL to a loadable src on mount.
 *  Left-click opens the referencing memo (orphan → lightbox fallback);
 *  right-click offers both paths explicitly. */
function Thumb({
  asset,
  unused,
  onOpen,
  onView,
}: {
  asset: AssetInfo;
  /** 「미사용 이미지 정리」가 지울 이미지. 정리 전에 무엇이 사라질지 보이게 한다. */
  unused: boolean;
  onOpen: (a: AssetInfo) => void;
  onView: (a: AssetInfo) => void;
}) {
  const { t } = useI18n();
  const [src, setSrc] = useState("");
  useEffect(() => {
    void resolveImageUrl(asset.url).then(setSrc);
  }, [asset.url]);
  return (
    <CtxRoot>
      <CtxTrigger
        render={
          <button
            type="button"
            onClick={() => onOpen(asset)}
            aria-label={unused ? t.gallery_unused_thumb.replace("{name}", asset.name) : undefined}
            data-unused={unused || undefined}
            className="group/img relative aspect-square w-full overflow-hidden rounded-lg border border-line bg-surface-muted"
          />
        }
      >
        {/* 무채색 앱이라 색 대신 빗금 모서리로 표시한다 — 정리 단추가 지울 대상과 같은 판정이다. */}
        {unused && <span aria-hidden className="gallery-unused-mark" />}
        {src ? (
          <img
            src={src}
            alt={asset.name}
            loading="lazy"
            className="h-full w-full object-cover transition-transform group-hover/img:scale-[1.03]"
          />
        ) : (
          <Skeleton className="h-full w-full" />
        )}
        <CtxMenu>
          <CtxItem icon={FileText} label={t.gallery_open_note} onClick={() => onOpen(asset)} />
          <CtxItem icon={Maximize2} label={t.gallery_view_large} onClick={() => onView(asset)} />
        </CtxMenu>
      </CtxTrigger>
    </CtxRoot>
  );
}

export function GalleryView() {
  const { t } = useI18n();
  const setView = useUI((s) => s.setView);
  const select = useUI((s) => s.select);
  const setToast = useUI((s) => s.setToast);
  const qc = useQueryClient();
  const [lightbox, setLightbox] = useState<AssetInfo | null>(null);
  const [cleaning, setCleaning] = useState(false);

  const assets = useQuery({ queryKey: ["assets"], queryFn: listAssets });
  // 모든 메모 본문을 읽는 검사라 갤러리를 열 때 한 번만 돈다(썸네일마다 부르지 않는다).
  // ["assets", …] 키라 memos:changed 무효화에 함께 따라온다.
  const unused = useQuery({ queryKey: ["assets", "unused"], queryFn: unusedAssets });
  const unusedSet = new Set(unused.data ?? []);

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

  // Open the memo that references this image; fall back to the lightbox for
  // orphan assets (no live memo references them).
  const openAsset = async (a: AssetInfo) => {
    const id = await memoForAsset(a.name);
    if (id) {
      select(id);
      setView("memos");
    } else {
      setLightbox(a);
    }
  };

  const items = assets.data ?? [];

  return (
    <div className="gallery-workspace flex h-full flex-col">
      <div className="gallery-heading flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-text">
          <Images size={15} /> {t.gallery}
          {items.length > 0 && (
            <span className="text-[11px] font-normal text-text-subtle">
              {t.gallery_count.replace("{n}", String(items.length))}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onClean}
            disabled={cleaning || items.length === 0 || (unused.isSuccess && unusedSet.size === 0)}
            className="inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-[11px] text-text-muted transition-colors hover:bg-surface-muted disabled:opacity-40"
          >
            <Trash2 size={12} /> {t.clean_unused}
            {unusedSet.size > 0 && (
              <span className="text-text-subtle">· {t.gallery_unused_n.replace("{n}", String(unusedSet.size))}</span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setView("memos")}
            className="inline-flex items-center rounded-full border border-line px-2.5 py-1 text-[11px] text-text-muted transition-colors hover:bg-surface-muted"
          >
            {t.all_memos}
          </button>
        </div>
      </div>

      <div className="gallery-content flex-1 overflow-y-auto">
        {assets.isLoading ? (
          <div aria-hidden="true" className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3">
            {Array.from({ length: 12 }).map((_, i) => (
              <Skeleton key={i} className="aspect-square rounded-lg" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="mt-24 flex flex-col items-center gap-2 text-center">
            <Images size={28} className="text-text-subtle" />
            <p className="max-w-sm text-sm text-text-subtle">{t.gallery_empty}</p>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3">
            {items.map((a) => (
              <Thumb key={a.name} asset={a} unused={unusedSet.has(a.name)} onOpen={openAsset} onView={setLightbox} />
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
      className="fixed inset-0 z-[70] flex items-center justify-center bg-surface/70 p-8 backdrop-blur-sm"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="close"
        className="absolute right-4 top-4 rounded-full bg-surface-raised/10 p-2 text-text-inverse transition-colors hover:bg-surface-raised/20"
      >
        <X size={18} />
      </button>
      {src && (
        <img
          src={src}
          alt={asset.name}
          className="max-h-full max-w-full rounded-lg object-contain shadow-lg"
          onClick={(e) => e.stopPropagation()}
        />
      )}
    </div>
  );
}
