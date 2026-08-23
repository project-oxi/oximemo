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
  kind: "prop_key_kind",
  mood: "prop_key_mood",
  energy: "prop_key_energy",
  status: "prop_key_status",
  peak_status: "prop_key_peak_status",
  status_changed: "prop_key_status_changed",
  domain: "prop_key_domain",
  subdomain: "prop_key_subdomain",
  aliases: "prop_key_aliases",
  related: "prop_key_related",
  source: "prop_key_source",
};

/** Well-known values per key. `low` is mood-저조 on mood and energy-낮음
 *  on energy, so the vocabulary is keyed per property, not flat. */
const VALUE_LABEL: Record<string, Record<string, string>> = {
  kind: { note: "prop_val_note", knowledge: "prop_val_knowledge", daily: "prop_val_daily" },
  mood: {
    great: "prop_val_great",
    good: "prop_val_good",
    okay: "prop_val_okay",
    low: "prop_val_low_mood",
    bad: "prop_val_bad",
  },
  energy: { high: "prop_val_high", medium: "prop_val_medium", low: "prop_val_low" },
  status: {
    stub: "prop_val_stub",
    vague: "prop_val_vague",
    understood: "prop_val_understood",
    mastered: "prop_val_mastered",
    decayed: "prop_val_decayed",
  },
  peak_status: {
    understood: "prop_val_understood",
    mastered: "prop_val_mastered",
  },
};

export function propKeyLabel(key: string, t: Vocab): string {
  const k = KEY_LABEL[key];
  // Well-known keys resolve to dict entries; everything else keeps the
  // raw key (custom schemas are their author's language).
  return k ? (t as VocabMap)[k] ?? key : key;
}

export function propValueLabel(key: string, value: string, t: Vocab): string {
  const v = VALUE_LABEL[key]?.[value];
  return v ? (t as VocabMap)[v] ?? value : value;
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

/** Schema color token → calendar-dot background class. Neutral/muted
 *  tokens return null so the caller keeps its default dot color. */
export function toneBg(token: string | undefined): string | null {
  switch (token) {
    case "success":
      return "bg-hue-green";
    case "warning":
      return "bg-hue-amber";
    case "info":
      return "bg-hue-blue";
    case "error":
      return "bg-hue-red";
    default:
      return null;
  }
}
