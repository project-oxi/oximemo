/**
 * Clipboard read for the text context menu (spec 2026-08-22 D2).
 * Tauri: official clipboard-manager plugin (WKWebView has no scriptable
 * paste). Browser-dev: async clipboard API. Text only — images keep the
 * native ⌘V trusted-event path (cm6Images).
 */
import { readText } from "@tauri-apps/plugin-clipboard-manager";

const inTauri = "__TAURI_INTERNALS__" in window;

export function clipboardReadText(): Promise<string> {
  if (inTauri) return readText();
  return navigator.clipboard.readText();
}
