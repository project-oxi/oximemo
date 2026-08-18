/**
 * Wiki-links config for `@atomic-editor/editor`'s `wikiLinks()` extension
 * (spec: 2026-08-13-memo-to-notebook-design.md).
 *
 * - suggest: `[[` autocomplete. Empty query → recent memos (favorites first);
 *   else Tantivy BM25 body search via `searchMemos`.
 * - serializeSuggestion: store the note title only (`[[Title]]`), not the ID.
 * - resolve: render a bare `[[Title]]` link as a chip whose label is the
 *   resolved memo's title (or body preview if no title); missing → "삭제된 링크".
 * - onOpen: open the target memo (selectedId → MemoDetail dialog).
 */
import type { WikiLinksConfig, WikiLinkSuggestion } from "@atomic-editor/editor";
import { getMemo, listMemos, searchMemos } from "./api";
import type { MemoSummary } from "./types";
import { relativeTime } from "./time";

/** Normalize a body/preview fragment to a single-line, 60-char chip label. */
function previewLabel(text: string): string {
  return (text || "").replace(/\s+/g, " ").trim().slice(0, 60);
}

export function buildWikiLinksConfig(opts: {
  onOpen: (id: string) => void;
  locale: string;
}): WikiLinksConfig {
  const toSuggestion = (m: MemoSummary): WikiLinkSuggestion => {
    const detail = [
      m.folder ? `📁 ${m.folder}` : null,
      relativeTime(m.updated_at, opts.locale) || null,
      m.favorite ? "★" : null,
    ].filter(Boolean).join(" · ");
    const label = m.title || previewLabel(m.preview) || m.id.slice(0, 8);
    return {
      target: m.title || m.id,
      label,
      detail: detail || undefined,
      boost: m.favorite ? 1 : 0,
    };
  };

  return {
    suggest: async (query: string) => {
      const q = query.trim();
      if (!q) {
        // Empty trigger: recent memos, favorites boosted to the top.
        const page = await listMemos(null, 24);
        const items = [...page.items].sort(
          (a, b) =>
            Number(b.favorite) - Number(a.favorite) ||
            b.updated_at.localeCompare(a.updated_at),
        );
        return items.map(toSuggestion);
      }
      return (await searchMemos(q, 12)).map(toSuggestion);
    },
    // Title only — the `]]` is consumed/appended by the extension's apply handler.
    serializeSuggestion: (s) => `${s.target}]]`,
    resolve: async (target: string) => {
      try {
        const m = await getMemo(target);
        if (m.deleted_at) return { target, label: "삭제된 링크", status: "missing" };
        return {
          target,
          label: m.title || previewLabel(m.body) || target,
          status: "resolved",
        };
      } catch {
        return { target, label: "삭제된 링크", status: "missing" };
      }
    },
    shouldResolve: () => true,
    onOpen: opts.onOpen,
    openOnClick: true,
  };
}