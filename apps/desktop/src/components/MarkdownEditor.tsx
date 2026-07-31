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
 *
 * Read-only mode, code-language highlighting, and wiki-links are
 * intentionally NOT exposed — they're deferred to v2 to keep the wrapper
 * small and the bundle slim. Per spec §2, this is a deliberate scope cut.
 */
import { useRef, type MutableRefObject } from "react";
import {
  AtomicCodeMirrorEditor,
  type AtomicCodeMirrorEditorHandle,
} from "@atomic-editor/editor";
import "@atomic-editor/editor/styles.css";

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
}

function defaultOpenLink(url: string): void {
  try {
    window.open(url, "_blank", "noopener,noreferrer");
  } catch {
    // window.open can throw in sandboxed contexts; nothing we can do.
  }
}

export function MarkdownEditor({
  body,
  onChange,
  documentId,
  className,
  onLinkClick,
  editorHandleRef,
}: Props) {
  const fallback = useRef<AtomicCodeMirrorEditorHandle | null>(null);
  const handleRef = editorHandleRef ?? fallback;
  return (
    <div className={className}>
      <AtomicCodeMirrorEditor
        documentId={documentId}
        markdownSource={body}
        onMarkdownChange={onChange}
        editorHandleRef={handleRef}
        onLinkClick={onLinkClick ?? defaultOpenLink}
      />
    </div>
  );
}
