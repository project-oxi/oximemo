/**
 * OKLCH utilities (§7.7). We only manipulate the OKLCH color string here —
 * the renderer just emits it as a CSS variable. Validation is permissive
 * (`isValidOklch`) and clamping keeps user-picked colors in a perceptually
 * safe range.
 */

import type { FolderDef } from "./types";

/** Inbox and root deliberately have no folder hue marker. */
const INBOX_NEUTRAL = "";

/** Neutral app marker. The registry retains saved colors for color settings. */
export function colorForFolder(
  path: string,
  _folders: FolderDef[] = [],
): string {
  if (path === "" || path === "inbox") return INBOX_NEUTRAL;
  return "var(--color-folder-marker)";
}

/** Backwards-compat: same shape as colorForCategory so existing callers compile. */
export function colorForCategory(id: string, cats: FolderDef[]): string {
  return colorForFolder(id === "inbox" ? "" : id, cats);
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
