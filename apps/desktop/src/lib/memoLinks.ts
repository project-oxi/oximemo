/**
 * Wiki-links config for `@atomic-editor/editor`'s `wikiLinks()` extension
 * (spec: 2026-08-13-memo-to-notebook-design.md).
 *
 * - suggest: `[[` autocomplete. Empty query → recent memos (favorites first);
 *   else Tantivy BM25 body search via `searchMemos`.
 * - serializeSuggestion: store the note title only (`[[Title]]`), not the ID.
 * - resolve: show the resolved title, or the authored target for a note that
 *   has not been created yet.
 * - onOpen: delegate navigation/creation to the owning note dialog so it can
 *   flush the current draft before changing selectedId.
 */
import type { WikiLinksConfig, WikiLinkSuggestion } from "@atomic-editor/editor";
import { createMemo, getMemo, listMemos, searchMemos } from "./api";
import type { Memo, MemoSummary } from "./types";
import { relativeTime } from "./time";

/** Normalize a body/preview fragment to a single-line, 60-char chip label. */
function previewLabel(text: string): string {
  return (text || "").replace(/\s+/g, " ").trim().slice(0, 60);
}

/** `#heading` and `#^block` select a location inside the note, not a new title. */
export function wikiDocumentTarget(target: string): string {
  return target.split("#", 1)[0].trim();
}

export function isMissingMemo(error: unknown): boolean {
  return String(error).replace(/^Error:\s*/, "").startsWith("not found: ");
}

/** Resolve once more at click time; a missing target becomes a canonical note. */
export async function openOrCreateWikiTarget(
  target: string,
  folder: string,
  api: { get: typeof getMemo; create: typeof createMemo } = { get: getMemo, create: createMemo },
): Promise<{ memo: Memo; created: boolean }> {
  const title = wikiDocumentTarget(target);
  if (!title) throw new Error("위키 링크에 문서 제목이 없습니다.");
  try {
    const memo = await api.get(title);
    if (!memo.deleted_at) return { memo, created: false };
  } catch (error) {
    if (!isMissingMemo(error)) throw error;
  }
  const memo = await api.create(`# ${title}\n`, folder);
  return { memo, created: true };
}

export function buildWikiLinksConfig(opts: {
  onOpen: (target: string) => void;
  locale: string;
}): WikiLinksConfig {
  const toSuggestion = (m: MemoSummary): WikiLinkSuggestion => {
    const detail = [
      m.folder,
      relativeTime(m.updated_at, opts.locale) || null,
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
      const title = wikiDocumentTarget(target);
      if (!title) return { target, label: target, status: "unresolved" };
      try {
        const m = await getMemo(title);
        if (m.deleted_at) return { target, label: target, status: "missing" };
        return {
          target,
          label: m.title || previewLabel(m.body) || title,
          status: "resolved",
        };
      } catch (error) {
        return { target, label: target, status: isMissingMemo(error) ? "missing" : "unresolved" };
      }
    },
    shouldResolve: () => true,
    onOpen: opts.onOpen,
    openOnClick: true,
  };
}
