/**
 * TextCtxMenu — the shared edit menu (cut/copy/paste/select-all) for
 * every editable surface (spec 2026-08-22 D2). The native webview menu
 * is blocked globally (see main.tsx), so editables ship this instead.
 *
 * ARCHITECTURE: Base UI's `Trigger render` injects the menu as CHILDREN
 * of the render element — illegal on void elements (`<input>`). So the
 * trigger is a `display: contents` span (invisible to layout) that
 * wraps the editable; right-clicks anywhere on the editable open the
 * menu. The editable is resolved from the wrapper at action time:
 * `input`/`textarea` get setRangeText paste, CM6 `.cm-content` gets a
 * synthetic ClipboardEvent (the editor's own paste pipeline, incl.
 * cm6Images, does the insert).
 *
 * The right-clicked wrapper is captured on pointerdown(button 2) —
 * right-click does not move focus, but the menu popup may.
 */
import { useRef, type ReactElement } from "react";
import { Scissors, Copy, ClipboardPaste, TextSelect } from "lucide-react";

import { useI18n } from "../lib/i18n";
import { clipboardReadText } from "../lib/clipboard";

import { CtxRoot, CtxTrigger, CtxMenu, CtxItem, CtxSeparator } from "./ContextMenu";

type Editable = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

function findEditable(host: HTMLElement | null): Editable | null {
  if (!host) return null;
  if (host instanceof HTMLInputElement || host instanceof HTMLTextAreaElement) return host;
  return host.querySelector<Editable>("input, textarea, .cm-content");
}

export function TextCtxMenu({
  render,
}: {
  /** The editable's own element (input/textarea/CM6 host div). Layout
   *  classes (flex sizing, scroll) must land on this element — it is the
   *  flex item its parent sees. */
  render: ReactElement;
}) {
  const { t } = useI18n();
  const hostRef = useRef<HTMLElement | null>(null);

  const focusEditable = () => {
    const el = findEditable(hostRef.current);
    el?.focus();
    return el;
  };

  const paste = async () => {
    const el = findEditable(hostRef.current);
    if (!el) return;
    let text: string;
    try {
      text = await clipboardReadText();
    } catch {
      return; // permission denied / empty — silent, ⌘V still works
    }
    if (el.classList.contains("cm-content")) {
      // Reuse the editor's own paste pipeline: CM6 reads clipboardData
      // off the event, trusted or not.
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      el.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
      );
      return;
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const s = el.selectionStart ?? el.value.length;
      const e2 = el.selectionEnd ?? s;
      el.setRangeText(text, s, e2, "end");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    // contenteditable fallback
    el.focus();
    document.execCommand("insertText", false, text);
  };

  return (
    <CtxRoot>
      <CtxTrigger
        render={
          <span
            className="contents"
            onPointerDown={(e) => {
              if (e.button === 2) hostRef.current = e.currentTarget;
            }}
          />
        }
      >
        {render}
        <CtxMenu>
          <CtxItem
            icon={Scissors}
            label={t.text_cut}
            onClick={() => {
              focusEditable();
              document.execCommand("cut");
            }}
          />
          <CtxItem
            icon={Copy}
            label={t.text_copy}
            onClick={() => {
              focusEditable();
              document.execCommand("copy");
            }}
          />
          <CtxItem icon={ClipboardPaste} label={t.text_paste} onClick={() => void paste()} />
          <CtxSeparator />
          <CtxItem
            icon={TextSelect}
            label={t.text_select_all}
            onClick={() => {
              focusEditable();
              document.execCommand("selectAll");
            }}
          />
        </CtxMenu>
      </CtxTrigger>
    </CtxRoot>
  );
}
