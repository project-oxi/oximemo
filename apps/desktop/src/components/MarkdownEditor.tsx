/**
 * React wrapper around `@atomic-editor/editor` (§4.1).
 *
 * The wrapper:
 *  - forces a `documentId` prop so swapping notes remounts the CM6 view
 *    (undo/cursor state from the previous note never leaks into the next)
 *  - forwards link clicks to the optional handler, falling back to a plain
 *    `window.open` so external links work in both browser-dev and Tauri.
 *  - optionally exposes the editor's imperative handle upward so a parent
 *    can call `focus()` (e.g. to return focus after a category pick).
 *  - injects the image-insertion CM6 extension (paste/drop) and exposes the
 *    captured `EditorView` so a parent toolbar button can insert at the cursor.
 *  - renders `oximg://` images: applies `#w=` width hints, swaps the scheme for
 *    a blob URL in browser-dev (Tauri resolves it natively), and supports
 *    Alt+drag resize that commits the width back into the markdown.
 */
import { useEffect, useRef, type MutableRefObject } from "react";
import {
  AtomicCodeMirrorEditor,
  type AtomicCodeMirrorEditorHandle,
} from "@atomic-editor/editor";
import "@atomic-editor/editor/styles.css";
import type { EditorView } from "@codemirror/view";

import { resolveImageUrl, widthOfUrl } from "../lib/assets";
import { imageInsertionExtension, type ImageViewHandle } from "../lib/cm6Images";
import { TextCtxMenu } from "./TextCtxMenu";
import type { Extension } from "@codemirror/state";

interface Props {
  body: string;
  onChange: (v: string) => void;
  /** Note identity — change it to swap documents (forces remount). */
  documentId: string;
  className?: string;
  onLinkClick?: (url: string) => void;
  /** Optional external ref to the editor's imperative handle. When
   *  omitted, an internal fallback is used (preserves prior behavior). */
  editorHandleRef?: MutableRefObject<AtomicCodeMirrorEditorHandle | null>;
  /** Receives the raw CM6 EditorView so a parent can dispatch image inserts
   *  from a toolbar button. Required for image insertion to be reachable. */
  viewHandleRef?: MutableRefObject<ImageViewHandle | null>;
  /** Extra CM6 extensions to layer in alongside the built-in image-insertion
   *  extension (e.g. wiki-links, embeds). */
  extensions?: readonly Extension[];
}

function defaultOpenLink(url: string): void {
  try {
    window.open(url, "_blank", "noopener,noreferrer");
  } catch {
    // window.open can throw in sandboxed contexts; nothing we can do.
  }
}

/** Commit a resized width back into the markdown as a `#w=<px>` hint on the
 *  image's oximg URL. The content hash makes the URL unique, so the regex finds
 *  exactly the right line. `width <= 0` strips the hint (back to auto-fit). */
function commitWidth(view: EditorView, name: string, width: number) {
  const doc = view.state.doc.toString();
  const escaped = name.replace(/[.]/g, "\\.");
  const re = new RegExp(`(!\\[[^\\]]*\\]\\(oximg://localhost/${escaped})(?:#w=\\d+)?(\\))`);
  const m = re.exec(doc);
  if (!m) return;
  const from = m.index + m[1].length;
  const to = m.index + m[0].length - m[2].length;
  view.dispatch({ changes: { from, to, insert: width > 0 ? `#w=${Math.round(width)}` : "" } });
}

const OXIMG_PREFIX = "oximg://localhost/";

export function MarkdownEditor({
  body,
  onChange,
  documentId,
  className,
  onLinkClick,
  editorHandleRef,
  viewHandleRef,
  extensions,
}: Props) {
  const fallback = useRef<AtomicCodeMirrorEditorHandle | null>(null);
  const handleRef = editorHandleRef ?? fallback;
  const viewFallback = useRef<ImageViewHandle | null>(null);
  const viewRef = viewHandleRef ?? viewFallback;
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Render oximg images: width hint, browser-dev blob swap, Alt+drag resize.
  // Re-scans whenever the document swaps (images are torn down + rebuilt).
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const cap = (x: number) => Math.max(40, Math.min(x, 2000));
    const process = (img: HTMLImageElement) => {
      const src = img.getAttribute("src") ?? "";
      if (!src.includes(OXIMG_PREFIX) || img.dataset.oxDone) return;
      const name = src.slice(src.indexOf(OXIMG_PREFIX) + OXIMG_PREFIX.length).split(/[#?]/)[0];
      img.dataset.oxName = name;
      const w = widthOfUrl(src);
      if (w) img.style.maxWidth = `${w}px`;
      img.dataset.oxDone = "1";
      img.title = w ? `${name} · ${w}px` : `${name} · ⌥drag to resize`;
      // Alt+drag resizes live; the final width is committed on mouseup.
      if (!img.dataset.oxResize) {
        img.dataset.oxResize = "1";
        img.style.cursor = "ew-resize";
        img.addEventListener("mousedown", (e: MouseEvent) => {
          if (!e.altKey) return;
          e.preventDefault();
          const startX = e.clientX;
          const startW = img.clientWidth;
          const move = (ev: MouseEvent) => {
            img.style.maxWidth = `${cap(startW + (ev.clientX - startX))}px`;
          };
          const up = () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
            const view = viewRef.current?.view;
            const finalW = parseInt(img.style.maxWidth, 10);
            if (view && Number.isFinite(finalW)) commitWidth(view, name, finalW);
            img.title = `${name} · ${finalW}px`;
          };
          window.addEventListener("mousemove", move);
          window.addEventListener("mouseup", up);
        });
      }
      void resolveImageUrl(src).then((resolved) => {
        if (resolved && resolved !== src) img.src = resolved;
      });
    };
    const scan = () => root.querySelectorAll<HTMLImageElement>("img").forEach(process);
    scan();
    const mo = new MutationObserver(scan);
    mo.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });
    return () => mo.disconnect();
  }, [documentId]);

  return (
    <TextCtxMenu render={<div className={className} ref={rootRef} />}>
      <AtomicCodeMirrorEditor
        documentId={documentId}
        markdownSource={body}
        onMarkdownChange={onChange}
        editorHandleRef={handleRef}
        onLinkClick={onLinkClick ?? defaultOpenLink}
        extensions={[imageInsertionExtension(viewRef), ...(extensions ?? [])]}
      />
    </TextCtxMenu>
  );
}
