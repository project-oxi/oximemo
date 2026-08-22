/**
 * TextCtxMenu — the shared edit menu (cut/copy/paste/select-all) for
 * every editable surface (spec 2026-08-22 D2). The native webview menu
 * is blocked globally (see main.tsx), so editables ship this instead.
 *
 * The trigger merges onto the editable's own element (no wrapper div).
 * Which editable was right-clicked is captured on pointerdown(button 2)
 * — right-click does not move focus, and the menu popup may, so the
 * target must be grabbed before the menu opens.
 */
import { cloneElement, useRef, type ReactElement, type ReactNode } from "react";
import { Scissors, Copy, ClipboardPaste, TextSelect } from "lucide-react";

import { useI18n } from "../lib/i18n";
import { clipboardReadText } from "../lib/clipboard";

import { CtxRoot, CtxTrigger, CtxMenu, CtxItem, CtxSeparator } from "./ContextMenu";

type AnyEditable = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

export function TextCtxMenu({
  render,
  children,
  cm6 = false,
}: {
  /** The editable's own element (input/textarea/editor host div).
   *  Props are cloned so our pointer capture composes with yours. */
  render: ReactElement<
    { onPointerDown?: (e: React.PointerEvent) => void } & Record<string, unknown>
  >;
  children?: ReactNode;
  /** CM6 host: paste dispatches a synthetic ClipboardEvent on the
   *  .cm-content so the editor's own paste pipeline inserts. */
  cm6?: boolean;
}) {
  const { t } = useI18n();
  const targetRef = useRef<AnyEditable | null>(null);

  const focusTarget = () => {
    const el = targetRef.current;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.focus();
    else el?.querySelector<HTMLElement>(".cm-content")?.focus();
    return targetRef.current;
  };

  const paste = async () => {
    const el = targetRef.current;
    if (!el) return;
    let text: string;
    try {
      text = await clipboardReadText();
    } catch {
      return; // permission denied / empty — silent, ⌘V still works
    }
    const cm = cm6 ? el.querySelector<HTMLElement>(".cm-content") : null;
    if (cm) {
      // Reuse the editor's own paste pipeline (incl. cm6Images): CM6
      // reads clipboardData off the event, trusted or not.
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      cm.dispatchEvent(
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

  const trigger = cloneElement(render, {
    onPointerDown: (e: React.PointerEvent) => {
      // The trigger element IS the editable — this is the component's
      // contract — so narrow at runtime and remember it for the menu.
      if (e.button === 2 && e.currentTarget instanceof HTMLElement) {
        targetRef.current = e.currentTarget;
      }
      render.props.onPointerDown?.(e);
    },
  });

  return (
    <CtxRoot>
      <CtxTrigger render={trigger}>
        {children}
        <CtxMenu>
          <CtxItem
            icon={Scissors}
            label={t.text_cut}
            onClick={() => {
              focusTarget();
              document.execCommand("cut");
            }}
          />
          <CtxItem
            icon={Copy}
            label={t.text_copy}
            onClick={() => {
              focusTarget();
              document.execCommand("copy");
            }}
          />
          <CtxItem icon={ClipboardPaste} label={t.text_paste} onClick={() => void paste()} />
          <CtxSeparator />
          <CtxItem
            icon={TextSelect}
            label={t.text_select_all}
            onClick={() => {
              focusTarget();
              document.execCommand("selectAll");
            }}
          />
        </CtxMenu>
      </CtxTrigger>
    </CtxRoot>
  );
}
