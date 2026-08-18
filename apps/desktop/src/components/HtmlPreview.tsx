/**
 * Sandboxed HTML note preview (§D6).
 *
 * Pipeline: `[[wiki links]]` → anchors → DOMPurify → `<iframe
 * sandbox="allow-same-origin" srcdoc=…>`. Scripts are stripped by DOMPurify
 * AND blocked by the sandbox (allow-scripts is never set), so note content
 * cannot execute. `allow-same-origin` alone lets the parent read
 * `contentDocument` for auto-height — nothing more.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";

interface Props {
  body: string;
  className?: string;
}

/** Rewrite `[[Target]]` / `[[Target|label]]` wiki links into clickable
 * anchors the sandboxed frame can surface (navigation is blocked by the
 * sandbox itself; the data attribute carries the target for the parent). */
function wikiLinksToAnchors(html: string): string {
  return html.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, label?: string) => {
    const safe = target.replace(/"/g, "&quot;");
    return `<a class="oximemo-wikilink" data-wikilink="${safe}" href="#">${label ?? target}</a>`;
  });
}

/** Full-document bodies keep their <head> (user styles apply); fragments
 * are wrapped in our base doc. Both paths get preview styles injected and
 * scripts stripped (DOMPurify) plus blocked (sandbox without allow-scripts).
 */
function sanitize(body: string): string {
  const prepared = wikiLinksToAnchors(body);
  const config = {
    FORBID_TAGS: ["script"],
    FORBID_ATTR: ["onerror", "onclick", "onload", "onmouseover"],
    ADD_ATTR: ["data-wikilink", "target"],
  };
  const whole = /<(!doctype\s+html|html[\s>])/i.test(prepared);
  if (whole) {
    const doc = DOMPurify.sanitize(prepared, { ...config, WHOLE_DOCUMENT: true });
    return doc.replace("</head>", `<style>${FRAME_STYLES}</style></head>`);
  }
  const fragment = DOMPurify.sanitize(prepared, config);
  return `<!doctype html><html><head><meta charset="utf-8"><style>${FRAME_STYLES}</style></head><body>${fragment}</body></html>`;
}

const FRAME_STYLES = `
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 1rem 1.25rem; font: 14px/1.7 -apple-system, "Segoe UI", sans-serif; }
  .oximemo-wikilink { color: #4c7ad0; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
  img { max-width: 100%; height: auto; }
`;

export function HtmlPreview({ body, className }: Props) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(160);
  const doc = useMemo(() => sanitize(body), [body]);

  // Measure the content and grow the frame. Runs on every doc change; the
  // sandbox's allow-same-origin makes contentDocument readable.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const measure = () => {
      const doc = frame.contentDocument;
      const h = doc?.body?.scrollHeight;
      if (h && Math.abs(h - height) > 4) setHeight(h + 16);
    };
    frame.addEventListener("load", measure);
    measure();
    return () => frame.removeEventListener("load", measure);
  }, [doc, height]);

  return (
    <iframe
      ref={frameRef}
      title="HTML note preview"
      sandbox="allow-same-origin"
      srcDoc={doc}
      style={{ height }}
      className={className}
    />
  );
}

/** Exported for unit-style checks in the browser console during dev. */
export const __internals = { sanitize, wikiLinksToAnchors, FRAME_STYLES };
