/**
 * Single tag row for the note's top property area (§4.2): the stored
 * envelope tags united with the tags the current draft body derives,
 * deduplicated without touching storage — the backend owns persistence
 * on save. While the user types, derived extraction follows the deferred
 * body so the chips settle one frame behind the caret instead of
 * competing with it.
 *
 * Renders nothing while the union is empty. Click-to-filter is
 * intentionally not wired (the sidebar owns filtering); `onTagClick` is
 * provided as an escape hatch.
 */
import { useDeferredValue, useMemo } from "react";
import { Tags } from "lucide-react";

import { useI18n } from "../lib/i18n";
import { bodyTags, mergeTags } from "../lib/tags";

interface TagChipRowProps {
  /** Current draft body (markdown source, or the HTML note's body). */
  body: string;
  /** Stored envelope tags; spelling and order preserved verbatim. */
  storedTags?: readonly string[];
  /** How tags derive from `body`. */
  format?: "markdown" | "html";
  onTagClick?: (tag: string) => void;
}

export function TagChipRow({ body, storedTags, format = "markdown", onTagClick }: TagChipRowProps) {
  const { t } = useI18n();
  const deferredBody = useDeferredValue(body);
  const tags = useMemo(
    () => mergeTags(storedTags ?? [], bodyTags(deferredBody, format)),
    [storedTags, deferredBody, format],
  );
  if (tags.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-text-subtle">
        <Tags size={11} aria-hidden />
        {t.tags_section}
      </span>
      {tags.map((tag) => (
        <button
          key={tag}
          type="button"
          onClick={() => onTagClick?.(tag)}
          disabled={!onTagClick}
          className="rounded-[var(--tag-radius)] bg-surface-muted px-2 py-0.5 text-[10px] font-medium text-text-muted disabled:cursor-default"
        >
          #{tag}
        </button>
      ))}
    </div>
  );
}
