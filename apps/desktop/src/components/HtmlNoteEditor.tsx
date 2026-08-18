/**
 * HTML note editing surface (§D6/D8): toolbar with three modes —
 * 편집 (source only) · 분할 (source + live preview) · 미리보기 (rendered
 * only). The preview is the sandboxed `HtmlPreview`; the editor is the
 * CM6 `HtmlEditor`. Mode defaults to 분할.
 */
import { useEffect, useState } from "react";
import { useI18n } from "../lib/i18n";
import { HtmlEditor } from "./HtmlEditor";
import { HtmlPreview } from "./HtmlPreview";

type Mode = "edit" | "split" | "preview";

interface Props {
  body: string;
  onChange: (v: string) => void;
  /** Unique per note; changing it remounts the editor. */
  documentId: string;
  className?: string;
}

export function HtmlNoteEditor({ body, onChange, documentId, className }: Props) {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>("split");

  // Swapping notes resets to the default mode so opening a note always
  // starts from the same place.
  useEffect(() => setMode("split"), [documentId]);

  const modes: Array<{ id: Mode; label: string }> = [
    { id: "edit", label: t.html_mode_edit },
    { id: "split", label: t.html_mode_split },
    { id: "preview", label: t.html_mode_preview },
  ];

  return (
    <div className={`flex min-h-0 flex-1 flex-col gap-2 ${className ?? ""}`}>
      <div
        role="tablist"
        aria-label="HTML editor mode"
        className="flex w-fit items-center gap-0.5 rounded-lg border border-line bg-surface p-0.5"
      >
        {modes.map((m) => (
          <button
            key={m.id}
            type="button"
            role="tab"
            aria-selected={mode === m.id}
            onClick={() => setMode(m.id)}
            className={`h-7 rounded-md px-2.5 text-xs font-medium transition-colors ${
              mode === m.id
                ? "bg-interactive-primary text-interactive-primary-foreground shadow-sm"
                : "text-text-subtle hover:bg-surface-muted hover:text-text"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 gap-2">
        {mode !== "preview" && (
          <HtmlEditor
            body={body}
            onChange={onChange}
            documentId={documentId}
            autoFocus={mode === "edit"}
            className={`min-h-0 overflow-y-auto ${mode === "split" ? "w-1/2" : "flex-1"}`}
          />
        )}
        {mode !== "edit" && (
          <HtmlPreview
            body={body}
            className={`min-h-0 flex-1 rounded-lg border border-line bg-surface ${
              mode === "split" ? "w-1/2 overflow-y-auto" : "overflow-y-auto"
            }`}
          />
        )}
      </div>
    </div>
  );
}
