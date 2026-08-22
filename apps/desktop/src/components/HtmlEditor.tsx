/**
 * HTML source editor for `.html` notes (§D1).
 *
 * A minimal CodeMirror 6 view with `@codemirror/lang-html` highlighting,
 * sharing the atomic editor theme so md and html notes feel native to the
 * same app. Like `MarkdownEditor`, the view is keyed by `documentId` via
 * remount so undo/cursor state never leaks across notes.
 */
import { useEffect, useRef } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { html } from "@codemirror/lang-html";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { atomicEditorTheme } from "@atomic-editor/editor";
import "@atomic-editor/editor/styles.css";
import { TextCtxMenu } from "./TextCtxMenu";

interface Props {
  body: string;
  onChange: (v: string) => void;
  /** Unique per note; changing it remounts the editor. */
  documentId: string;
  className?: string;
  autoFocus?: boolean;
}

export function HtmlEditor({ body, onChange, documentId, className, autoFocus = true }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Keep the latest callback without tearing the view down on identity churn.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const extensions: Extension[] = [
      lineNumbers(),
      history(),
      syntaxHighlighting(defaultHighlightStyle),
      indentOnInput(),
      bracketMatching(),
      html(),
      atomicEditorTheme,
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      EditorView.lineWrapping,
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChangeRef.current(u.state.doc.toString());
      }),
    ];
    const view = new EditorView({
      state: EditorState.create({ doc: body, extensions }),
      parent: host,
    });
    viewRef.current = view;
    if (autoFocus) requestAnimationFrame(() => view.focus());
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- body only seeds the doc; documentId drives remounts.
  }, [documentId]);

  return (
    <TextCtxMenu
      cm6
      render={<div ref={hostRef} key={documentId} className={className} data-html-editor />}
    />
  );
}
