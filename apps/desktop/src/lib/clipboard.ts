/**
 * Clipboard read for the text context menu (spec 2026-08-22 D2).
 * Tauri: official clipboard-manager plugin (WKWebView has no scriptable
 * paste). Browser-dev: async clipboard API. Text only — images keep the
 * native ⌘V trusted-event path (cm6Images).
 *
 * `clipboardWriteText` (copilot revision 2026-08-24) mirrors the split for
 * copy buttons: response copy + per-codeblock copy.
 */
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

const inTauri = "__TAURI_INTERNALS__" in window;

export function clipboardReadText(): Promise<string> {
  if (inTauri) return readText();
  return navigator.clipboard.readText();
}

export async function clipboardWriteText(text: string): Promise<void> {
  if (inTauri) {
    await writeText(text);
    return;
  }
  await navigator.clipboard.writeText(text);
}
