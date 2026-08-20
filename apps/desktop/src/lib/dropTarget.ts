/**
 * useFolderDrop — shared HTML5 drop-target wiring for note moves (T14).
 *
 * M16 rules: when the dragged note already lives in the target folder the
 * target is inert — no `preventDefault()` on dragover (so the browser never
 * allows the drop in the first place) and no highlight ring. Ancestor drops
 * are allowed. The payload type is `application/x-oximemo-notes` (JSON id
 * array) set by the drag sources (Card article, list note row).
 *
 * Destructure and spread onto the target element, appending `dropCls` to
 * its existing className — the hook's ring must not clobber host styling:
 *
 *   const { dropCls, ...dropProps } = useFolderDrop(path, onMove);
 *   <article {...dropProps} className={`base-classes ${dropCls ?? ""}`} />
 */
import { useState } from "react";

import { useUI } from "../stores/ui";

/** M16 rules: no-op + no highlight when the dragged note already lives in
 * the target folder. Ancestor drops are allowed. */
export function useFolderDrop(folderPath: string, onDrop: (id: string) => void) {
  const draggingNote = useUI((s) => s.draggingNote);
  const [over, setOver] = useState(false);
  const active = !!draggingNote && draggingNote.folder !== folderPath;
  return {
    "data-drop-folder": folderPath,
    onDragOver: (e: React.DragEvent) => {
      if (!active) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: React.DragEvent) => {
      setOver(false);
      // M16 no-op guard: with native DnD a drop can't fire without a
      // preventDefault()ed dragover, but synthetic dispatch (tests) and
      // mid-drag folder changes can reach here — never move into the
      // note's own current folder.
      if (!active) return;
      e.preventDefault();
      const raw = e.dataTransfer.getData("application/x-oximemo-notes");
      try {
        for (const id of JSON.parse(raw) as string[]) onDrop(id);
      } catch {
        /* not ours */
      }
    },
    dropCls: over ? "ring-2 ring-focus-ring ring-offset-1" : undefined,
  };
}
