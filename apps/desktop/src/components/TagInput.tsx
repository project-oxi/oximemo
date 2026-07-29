/**
 * Inline tag editor: type + Enter/comma to add, backspace on empty to remove
 * the last, click × to remove a chip. Tags are normalized to lowercase and
 * de-duplicated.
 */
import { useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";

interface Props {
  tags: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
}

export function TagInput({ tags, onChange, placeholder }: Props) {
  const [draft, setDraft] = useState("");

  const commit = () => {
    const v = draft.trim().toLowerCase().replace(/^#/, "");
    if (v && !tags.includes(v)) onChange([...tags, v]);
    setDraft("");
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit();
    } else if (e.key === "Backspace" && !draft && tags.length) {
      onChange(tags.slice(0, -1));
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-zinc-200 px-2 py-1.5 dark:border-zinc-700">
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
        >
          {tag}
          <button
            type="button"
            aria-label={`remove ${tag}`}
            onClick={() => onChange(tags.filter((t) => t !== tag))}
            className="text-zinc-400 transition-colors hover:text-zinc-700 dark:hover:text-zinc-200"
          >
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        onBlur={commit}
        placeholder={tags.length ? "" : placeholder}
        className="min-w-[80px] flex-1 bg-transparent text-xs text-zinc-700 placeholder:text-zinc-400 focus:outline-none dark:text-zinc-200"
      />
    </div>
  );
}
