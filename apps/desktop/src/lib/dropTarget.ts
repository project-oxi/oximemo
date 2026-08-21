/**
 * useFolderDrop — shared HTML5 drop-target wiring (T14 notes, folder moves).
 *
 * M16 rules (notes): when the dragged note already lives in the target
 * folder the target is inert — no `preventDefault()` on dragover (so the
 * browser never allows the drop in the first place) and no highlight
 * ring. Ancestor drops are allowed. The payload type is
 * `application/x-oximemo-notes` (JSON id array) set by the drag sources
 * (Card article, list note row).
 *
 * Folder drags: payload `application/x-oximemo-folder` (the source folder
 * path). A target that passes `onDropFolder` also accepts folder drops,
 * except: the dragged folder itself (no-op), any descendant of it (cycle),
 * and its current parent (move would be a no-op). Backend `move_folder`
 * re-checks all three authoritatively — these client gates only keep the
 * ring from lying.
 *
 * Destructure and spread onto the target element, appending `dropCls` to
 * its existing className — the hook's ring must not clobber host styling:
 *
 *   const { dropCls, ...dropProps } = useFolderDrop(path, onMove);
 *   <article {...dropProps} className={`base-classes ${dropCls ?? ""}`} />
 */
import { useState } from "react";

import { useUI } from "../stores/ui";

/** Parent folder of a vault path ("" for top level): "a/b" → "a", "a" → "". */
export function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** M16 rules: no-op + no highlight when the dragged note already lives in
 * the target folder. Ancestor drops are allowed. */
export function useFolderDrop(
  folderPath: string,
  onDrop: (id: string) => void,
  onDropFolder?: (path: string) => void,
) {
  const draggingNote = useUI((s) => s.draggingNote);
  const draggingFolder = useUI((s) => s.draggingFolder);
  const [over, setOver] = useState(false);
  const noteActive = !!draggingNote && draggingNote.folder !== folderPath;
  // Cycle + parent no-op guards mirror the backend `move_folder` checks.
  const folderActive =
    !!draggingFolder &&
    !!onDropFolder &&
    folderPath !== draggingFolder &&
    !folderPath.startsWith(`${draggingFolder}/`) &&
    parentOf(draggingFolder) !== folderPath;
  const active = noteActive || folderActive;
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
      if (draggingFolder && folderActive) {
        const p = e.dataTransfer.getData("application/x-oximemo-folder");
        if (p) onDropFolder?.(p);
        return;
      }
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
