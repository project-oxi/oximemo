import { useMemo } from "react";
import { renderMarkdown } from "../lib/markdown";

export function MarkdownPreview({ body, title }: { body: string; title?: string }) {
  const html = useMemo(() => {
    // Suppress only an exact repeated leading H1 in this derived view.
    const heading = body.match(/^\s*#\s+(.+?)(?:\s+#+)?\r?\n/);
    const visible = title && heading?.[1].trim() === title.trim() ? body.slice(heading[0].length) : body;
    return renderMarkdown(visible);
  }, [body, title]);
  return body.trim()
    ? <article className="markdown-body" aria-label="메모 본문" dangerouslySetInnerHTML={{ __html: html }}/>
    : <p className="markdown-empty">내용 없음</p>;
}
