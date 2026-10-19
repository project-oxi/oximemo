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
import { EditorView, ViewPlugin, keymap } from "@codemirror/view";
import { Prec, StateEffect, StateField, type Extension } from "@codemirror/state";
import { type MutableRefObject } from "react";

import { markdownForImage, saveImageFromFile } from "./assets";
import { uploadImageFiles } from "./imageUploads";

export interface ImageViewHandle {
  view: EditorView | null;
}

const addInsertion = StateEffect.define<{ id: number; pos: number }>();
const removeInsertion = StateEffect.define<number>();
const pendingInsertions = StateField.define<Map<number, number>>({
  create: () => new Map(),
  update: (positions, tr) => {
    const next = new Map<number, number>();
    for (const [id, pos] of positions) next.set(id, tr.changes.mapPos(pos, 1));
    for (const effect of tr.effects) {
      if (effect.is(addInsertion)) next.set(effect.value.id, effect.value.pos);
      if (effect.is(removeInsertion)) next.delete(effect.value);
    }
    return next;
  },
});
let insertionId = 0;

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
  onError?: (filenames: string[]) => void,
): Promise<void> {
  const id = ++insertionId;
  view.dispatch({ effects: addInsertion.of({ id, pos }) });
  const { uploaded, failed } = await uploadImageFiles(files, saveImageFromFile);
  const lines = uploaded.map(({ file, asset }) =>
    markdownForImage(asset.url, file.name.replace(/\.[^.]+$/, "") || "image"),
  );
  const at = view.state.field(pendingInsertions, false)?.get(id);
  if (at === undefined || !view.dom.isConnected) return;
  onError?.(failed);
  const insert = lines.length ? `${lines.join("\n")}\n` : "";
  const cursor = view.state.selection.main;
  view.dispatch({
    changes: insert ? { from: at, insert } : undefined,
    // Follow the inserted image when the user has kept the cursor here.
    // A cursor moved during the upload must retain its current position.
    selection: insert && cursor.empty && cursor.head === at
      ? { anchor: at + insert.length }
      : undefined,
    effects: removeInsertion.of(id),
  });
}

/**
 * @param handle receives the editor's `EditorView` (captured on mount) so the
 *              toolbar file-picker button can insert at the live cursor.
 */
export function imageInsertionExtension(handle: MutableRefObject<ImageViewHandle | null>, onError?: (filenames: string[]) => void): Extension {
  return [
    pendingInsertions,
    EditorView.domEventHandlers({
      paste(e, view) {
        const files = clipboardImageFiles(e);
        if (!files.length) return false;
        e.preventDefault();
        void insertImagesAt(files, view.state.selection.main.from, view, onError);
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
        void insertImagesAt(files, at, view, onError);
        return true;
      },
      contextmenu(e, view) {
        // Inline-image context menu (spec 2026-08-22 D5): the img is
        // CM6-managed DOM, so React can't wrap it — bridge to a window
        // CustomEvent that MarkdownEditor turns into a PointMenu.
        const img = e.target instanceof HTMLImageElement ? e.target : null;
        const name = img?.dataset.oxName;
        if (!img || !name) return false;
        e.preventDefault();
        e.stopPropagation();
        const anchor = view.posAtDOM(img);
        const ordinal = [...view.dom.querySelectorAll<HTMLImageElement>("img[data-ox-name]")]
          .filter((other) => other.dataset.oxName === name && view.posAtDOM(other) === anchor)
          .indexOf(img);
        window.dispatchEvent(
          new CustomEvent("oximemo:image-menu", {
            detail: { name, anchor, ordinal, x: e.clientX, y: e.clientY },
          }),
        );
        return true;
      },
    }),
    ViewPlugin.fromClass(
      class {
        constructor(v: EditorView) {
          handle.current = { view: v };
        }
        destroy() { handle.current = null; }
      },
    ),
  ];
}

/**
 * CM6 keymap that opens the native file picker on `Mod-i`. Registered as an
 * editor extension (not a parent <div> onKeyDown) so it preempts CM6's own
 * `Mod-i` → `selectParentSyntax` (defaultKeymap) at the keymap layer: a
 * wrapper-DOM handler fires only *after* CM6 has already handled the event,
 * which both expanded the selection and shifted the insertion point. Wrapped
 * in `Prec.highest` so it outranks `defaultKeymap` regardless of how the
 * atomic-editor composes its base extensions.
 */
export function imagePickerKeymap(onPick: () => void): Extension {
  return Prec.highest(
    keymap.of([
      {
        key: "Mod-i",
        preventDefault: true,
        run: () => {
          onPick();
          return true;
        },
      },
    ]),
  );
}
