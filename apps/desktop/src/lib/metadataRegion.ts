/**
 * Region resolution + domain inference for the metadata layer
 * (spec 2026-08-23 §3.3/§3.5).
 *
 * The stored `[metadata] region` is either an explicit ISO choice
 * ("KR"/"JP"/"DE"/"US") or "" (auto). Auto means: resolve the system
 * locale through Intl at read time — the Rust side has no locale to
 * consult, so the renderer owns detection and passes the effective
 * region to the search commands as an override.
 */
import type { FolderSchema } from "./types";

/** Regions with a dedicated provider-priority table in the core. */
export const SUPPORTED_REGIONS = ["KR", "JP", "DE"] as const;

/** Map a BCP-47 tag ("ko-KR") to a supported region, "" when none. */
export function localeToRegion(locale: string): string {
  const region = locale.split("-")[1]?.toUpperCase() ?? "";
  return (SUPPORTED_REGIONS as readonly string[]).includes(region) ? region : "";
}

/**
 * Best-effort system region: first navigator locale that maps to a
 * supported region wins, "" when nothing matches (global order).
 */
export function detectRegion(): string {
  const candidates =
    typeof navigator !== "undefined"
      ? [navigator.language, ...navigator.languages]
      : [];
  for (const c of candidates) {
    const r = localeToRegion(c);
    if (r) return r;
  }
  return "";
}

/**
 * The region actually used for provider priority: an explicit stored
 * choice wins; "" resolves through Intl detection; unknown stored
 * values (future tables) fall back to detection, not to "".
 */
export function effectiveRegion(stored: string): string {
  if (stored) return stored;
  return detectRegion();
}

const MOVIE_FIELDS = ["director", "release_date", "runtime_min", "original_title"];
const BOOK_FIELDS = ["author", "isbn", "page_count", "published_date"];

/**
 * Which search domain a folder's schema targets: the preset marker
 * decides outright; marker-less schemas (user-custom, or installed
 * before [meta] existed) infer from which metadata fields they
 * declare. `null` hides the 채우기 affordance entirely.
 */
export function metadataDomainOf(schema: FolderSchema | null | undefined): "book" | "movie" | null {
  const preset = schema?.meta?.preset;
  if (preset === "book" || preset === "movie") return preset;
  const declared = Object.values(schema?.properties ?? {})
    .map((d) => d.metadata)
    .filter((m): m is string => !!m);
  if (!declared.length) return null;
  if (declared.some((m) => MOVIE_FIELDS.includes(m))) return "movie";
  if (declared.some((m) => BOOK_FIELDS.includes(m))) return "book";
  return null;
}
