/**
 * Platform-aware shortcut labels. Product copy is written in macOS notation
 * (⌘ ⇧ ⌥ ⏎); off macOS it is rewritten here so labels match the keys the
 * handlers actually accept (`metaKey || ctrlKey` → Ctrl). The global capture
 * shortcut is registered as SUPER+Shift+N, which is Win+Shift+N on Windows.
 */

export const IS_MAC: boolean =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

/** macOS-only phrases with no off-mac equivalent (Option double-tap capture). */
const PHRASES: [RegExp, string][] = [
  [/Option 키를 두 번 누르거나 /g, ""],
  [/Press Option twice or /g, "Press "],
  [/Return으로/g, "Enter로"],
  [/Return saves/g, "Enter saves"],
];

/** Rewrite a macOS-notation label for the running platform. */
export function keyLabel(label: string): string {
  if (IS_MAC || !/[⌘⇧⌥⏎↵]|Option|Return/.test(label)) return label;
  let s = label;
  for (const [re, to] of PHRASES) s = s.replace(re, to);
  return s
    .replace(/⌘⇧N/g, "Win+Shift+N")
    .replace(/⌘/g, "Ctrl+")
    .replace(/⌥/g, "Alt+")
    .replace(/⇧/g, "Shift+")
    .replace(/[⏎↵]/g, "Enter");
}

/** Off-mac wording for keys whose subject differs (Dock → taskbar). */
const OVERRIDES: Record<string, Record<string, string>> = {
  ko: { dock_icon: "작업 표시줄 아이콘 표시" },
  en: { dock_icon: "Show taskbar icon" },
};

/** Apply `keyLabel` and the off-mac overrides to a whole locale dictionary. */
export function platformDict<T extends object>(dict: T, locale: string): T {
  if (IS_MAC) return dict;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(dict)) out[k] = typeof v === "string" ? keyLabel(v) : v;
  return { ...out, ...OVERRIDES[locale] } as T;
}
