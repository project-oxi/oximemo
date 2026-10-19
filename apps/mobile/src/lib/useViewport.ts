import { useEffect, useState, type CSSProperties } from "react";

/** Use the visible WebView, including the space left by the iOS keyboard. */
export function useViewport(): CSSProperties {
  const measure = () => ({ height: window.visualViewport?.height ?? window.innerHeight, top: window.visualViewport?.offsetTop ?? 0 });
  const [viewport, setViewport] = useState(measure);
  useEffect(() => {
    const visual = window.visualViewport;
    let frame = 0;
    const resize = () => {
      if (visual && visual.scale !== 1) return;
      // WKWebView can pan its outer page to reveal a textarea caret. Our
      // reader/editor owns scrolling; the outer page must never carry chrome.
      if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setViewport(measure()));
    };
    window.addEventListener("resize", resize);
    window.addEventListener("scroll", resize);
    visual?.addEventListener("resize", resize);
    visual?.addEventListener("scroll", resize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
      window.removeEventListener("scroll", resize);
      visual?.removeEventListener("resize", resize);
      visual?.removeEventListener("scroll", resize);
    };
  }, []);
  return { "--viewport-height": `${viewport.height}px`, "--viewport-top": `${viewport.top}px` } as CSSProperties;
}
