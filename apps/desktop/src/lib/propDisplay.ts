/**
 * First-party vocabulary for the shipped property system. The mechanism
 * is generic (any SCHEMA.toml), but the DEFAULT preset's well-known keys
 * and values get localized display names — the macOS convention of
 * translating known file kinds while custom kinds show as-is. Custom
 * schemas fall back to raw keys/values.
 */
import type { Dict } from "./i18n";

type Vocab = { [K in keyof Dict as K extends `prop_${string}` ? K : never]: Dict[K] };
type VocabMap = Record<string, string>;

const KEY_LABEL: Record<string, string> = {
  status: "prop_key_status",
  peak_status: "prop_key_peak_status",
  status_changed: "prop_key_status_changed",
  domain: "prop_key_domain",
  subdomain: "prop_key_subdomain",
  aliases: "prop_key_aliases",
  related: "prop_key_related",
  source: "prop_key_source",
};

/** Status values that carry localized display names. */
const STATUS_VALUES = new Set(["stub", "vague", "understood", "mastered", "decayed"]);
/** Keys whose values draw from the status vocabulary. */
const STATUS_KEYS = new Set(["status", "peak_status"]);
export function propKeyLabel(key: string, t: Vocab): string {
  const k = KEY_LABEL[key];
  // Well-known keys resolve to dict entries; everything else keeps the
  // raw key (custom schemas are their author's language).
  return k ? (t as VocabMap)[k] ?? key : key;
}

export function propValueLabel(key: string, value: string, t: Vocab): string {
  if (STATUS_KEYS.has(key) && STATUS_VALUES.has(value)) {
    return (t as VocabMap)[`prop_val_${value}`] ?? value;
  }
  return value;
}

/** Schema color token → badge tone classes (shared by cards, the status
 *  distribution bar, and the review queue). */
export function badgeTone(token: string | undefined): string {
  switch (token) {
    case "success":
      return "bg-hue-green/15 text-hue-green";
    case "warning":
      return "bg-hue-amber/15 text-hue-amber";
    case "info":
      return "bg-hue-blue/15 text-hue-blue";
    case "error":
      return "bg-hue-red/15 text-hue-red";
    case "muted":
      return "bg-surface-muted text-text-subtle";
    default:
      return "bg-surface-muted text-text-subtle";
  }
}
