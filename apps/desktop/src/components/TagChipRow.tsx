/**
 * Visual row of `#태그` chips extracted from the current body (§4.2).
 *
 * Storage is unchanged — `Memo.tags` is still derived from the body on save.
 * This row is a read-only affordance so the user can see what tags their
 * current text would produce. Click-to-filter is intentionally not wired
 * (the sidebar owns filtering); `onTagClick` is provided as an escape hatch.
 *
 * Renders nothing when the body has no tags, so empty state is just an
 * empty row.
 */
import { useMemo } from "react";

import { extractTags } from "../lib/tags";

interface TagChipRowProps {
  body: string;
  onTagClick?: (tag: string) => void;
}

export function TagChipRow({ body, onTagClick }: TagChipRowProps) {
  const tags = useMemo(() => extractTags(body), [body]);
  if (tags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => onTagClick?.(t)}
          disabled={!onTagClick}
          className="rounded-full bg-[var(--tag-bg)] px-2 py-0.5 text-[10px] font-medium text-[var(--tag)] disabled:cursor-default"
        >
          #{t}
        </button>
      ))}
    </div>
  );
}
