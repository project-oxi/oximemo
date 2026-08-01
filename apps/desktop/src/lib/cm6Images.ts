/**
 * CodeMirror 6 extension: image insertion via paste / drag-drop, plus an
 * imperative view handle for the editor toolbar's file-picker button.
 *
 * Integration point is `AtomicCodeMirrorEditor`'s `extensions` prop: we hand it
 * a `domEventHandlers` extension so each handler receives BOTH the DOM event
 * (to pull image `File`s off the clipboard / dataTransfer) AND the `EditorView`
 * (to dispatch an insert at the right position). The editor remains the source
 * of truth — we never call `onChange`/`setBody` directly.
 *
 * Non-image paste/drop returns `false`, so CodeMirror's normal text handling
 * (and the atomic-editor's own decorations) keep working untouched.
 */
import { EditorView, ViewPlugin } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { type MutableRefObject } from "react";

import { markdownForImage, saveImageFromFile } from "./assets";

export interface ImageViewHandle {
  view: EditorView | null;
}

/** Pull image files off a clipboard event (screenshots, copied images). */
function clipboardImageFiles(e: ClipboardEvent): File[] {
  const dt = e.clipboardData;
  if (!dt) return [];
  const files: File[] = [];
  for (let i = 0; i < dt.items.length; i++) {
    const it = dt.items[i];
    if (it.kind === "file" && it.type.startsWith("image/")) {
      const f = it.getAsFile();
      if (f) files.push(f);
    }
  }
  return files;
}

/** Pull image files off a drag event. */
function dragImageFiles(e: DragEvent): File[] {
  const dt = e.dataTransfer;
  if (!dt) return [];
  const files: File[] = [];
  for (let i = 0; i < dt.files.length; i++) {
    const f = dt.files[i];
    if (f.type.startsWith("image/")) files.push(f);
  }
  return files;
}

/**
 * Upload each image and dispatch an `![alt](oximg://…)` line per image at
 * `pos`. Uploads run sequentially so the dispatch order matches the input.
 * Failures are skipped (a corrupt item must not abort the rest of a batch).
 */
export async function insertImagesAt(
  files: File[],
  pos: number,
  view: EditorView,
): Promise<void> {
  const lines: string[] = [];
  for (const f of files) {
    try {
      const ref = await saveImageFromFile(f);
      const alt = f.name.replace(/\.[^.]+$/, "") || "image";
      lines.push(markdownForImage(ref.url, alt));
    } catch {
      // skip unreadable item
    }
  }
  if (!lines.length) return;
  view.dispatch({ changes: { from: pos, insert: `${lines.join("\n")}\n` } });
}

/**
 * @param handle receives the editor's `EditorView` (captured on mount) so the
 *              toolbar file-picker button can insert at the live cursor.
 */
export function imageInsertionExtension(handle: MutableRefObject<ImageViewHandle | null>): Extension {
  return [
    EditorView.domEventHandlers({
      paste(e, view) {
        const files = clipboardImageFiles(e);
        if (!files.length) return false;
        e.preventDefault();
        void insertImagesAt(files, view.state.selection.main.from, view);
        return true;
      },
      dragover(e) {
        // `preventDefault` on dragover is required for drop to fire at all.
        if (e.dataTransfer?.types.includes("Files")) {
          e.preventDefault();
          return true;
        }
        return false;
      },
      drop(e, view) {
        const files = dragImageFiles(e);
        if (!files.length) return false;
        e.preventDefault();
        const at =
          view.posAtCoords({ x: e.x, y: e.y }) ?? view.state.selection.main.from;
        void insertImagesAt(files, at, view);
        return true;
      },
    }),
    ViewPlugin.fromClass(
      class {
        constructor(v: EditorView) {
          handle.current = { view: v };
        }
      },
    ),
  ];
}
