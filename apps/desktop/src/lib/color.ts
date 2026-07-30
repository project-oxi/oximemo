/**
 * OKLCH utilities (§7.7). We only manipulate the OKLCH color string here —
 * the renderer just emits it as a CSS variable. Validation is permissive
 * (`isValidOklch`) and clamping keeps user-picked colors in a perceptually
 * safe range.
 */

import type { CategoryDef } from "./types";

/** Inbox neutral fallback. */
const INBOX_NEUTRAL = "oklch(0.72 0.01 250)";

/** Look up a category id's color from the registry. Orphan → inbox fallback. */
export function colorForCategory(id: string, cats: CategoryDef[]): string {
  return cats.find((c) => c.id === id)?.color ?? INBOX_NEUTRAL;
}

export const COLOR_PRESETS = [
  { id: "red",    l: 0.75, c: 0.15, h: 25  },
  { id: "amber",  l: 0.75, c: 0.15, h: 75  },
  { id: "green",  l: 0.75, c: 0.13, h: 145 },
  { id: "teal",   l: 0.75, c: 0.12, h: 195 },
  { id: "blue",   l: 0.70, c: 0.14, h: 250 },
  { id: "purple", l: 0.72, c: 0.15, h: 310 },
] as const;

export type ColorPreset = (typeof COLOR_PRESETS)[number];

export function presetToString(p: ColorPreset): string {
  return `oklch(${p.l} ${p.c} ${p.h})`;
}

const SAFE_L: [number, number] = [0.5, 0.9];
const SAFE_C: [number, number] = [0.05, 0.25];

export function clamp(l: number, c: number, h: number): { l: number; c: number; h: number } {
  return {
    l: Math.min(SAFE_L[1], Math.max(SAFE_L[0], l)),
    c: Math.min(SAFE_C[1], Math.max(SAFE_C[0], c)),
    h: ((h % 360) + 360) % 360,
  };
}

export function toString(l: number, c: number, h: number): string {
  const v = clamp(l, c, h);
  return `oklch(${v.l.toFixed(3)} ${v.c.toFixed(3)} ${v.h.toFixed(1)})`;
}

export function isValidOklch(s: string): boolean {
  return s.length === 0 || /^oklch\(/i.test(s);
}

/**
 * Post-it paper fill: the note color mixed toward the card surface so the
 * card reads as colored paper — a clear pastel in light mode, a muted tint
 * in dark. Mixed at 60% (not a faint wash) so the picked color actually
 * reads, and the ColorPicker swatches preview this exact value (WYSIWYG).
 */
export function paperFor(color: string): string {
  if (!color) return "var(--card-surface)";
  return `color-mix(in oklch, ${color} 60%, var(--card-surface))`;
}

/** Card edge: more saturated than the fill (80%) for clear definition. */
export function edgeFor(color: string): string {
  if (!color) return "var(--card-edge)";
  return `color-mix(in oklch, ${color} 80%, var(--card-edge))`;
}
