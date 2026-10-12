"use client";

import { useEffect, useRef, useState } from "react";

/* ─────────────────────────────────────────────────────────
 * STREAM TEXT — word-by-word reveal with a trailing caret.
 *
 * Each word blurs in on arrival rather than popping, which
 * keeps a long line from flickering as it fills. onProgress
 * fires per word so callers can re-anchor anything tracking
 * the text; onDone fires once the last word lands.
 * ───────────────────────────────────────────────────────── */

const WORD_MS = 46;

export function StreamText({
  text,
  onProgress,
  onDone,
}: {
  text: string;
  onProgress?: () => void;
  onDone?: () => void;
}) {
  const words = text.split(" ");
  const [progress, setProgress] = useState({ text, count: 0 });
  const count = progress.text === text ? progress.count : 0;
  const done = count >= words.length;
  const completionRef = useRef({ text, done: false });
  if (completionRef.current.text !== text) {
    completionRef.current = { text, done: false };
  }

  useEffect(() => {
    if (progress.text !== text) setProgress({ text, count: 0 });
  }, [progress.text, text]);

  useEffect(() => {
    if (done) {
      if (!completionRef.current.done) {
        completionRef.current.done = true;
        onDone?.();
      }
      return;
    }
    const t = setTimeout(() => {
      setProgress((current) =>
        current.text === text
          ? { text, count: current.count + 1 }
          : current,
      );
    }, WORD_MS);
    return () => clearTimeout(t);
    // onDone is intentionally uncontrolled — callers pass inline closures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, done, progress.text, text]);

  useEffect(() => {
    onProgress?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, text]);

  return (
    <>
      {words.slice(0, count).map((word, i) => (
        <span
          key={i}
          className="inline [will-change:filter,opacity]"
          style={{
            animation: "stream-in 420ms cubic-bezier(0.22,0.61,0.25,1) both",
          }}
        >
          {word}
          {i < words.length - 1 ? " " : ""}
        </span>
      ))}
      {!done && <span className="stream-caret is-streaming" aria-hidden />}
    </>
  );
}
