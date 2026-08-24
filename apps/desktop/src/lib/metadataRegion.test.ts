import { describe, expect, test } from "bun:test";

import { hasSearchProvider, localeToRegion, metadataDomainOf } from "./metadataRegion";
import type { FolderSchema } from "./types";

describe("localeToRegion", () => {
  test("maps BCP-47 tags to supported region tables", () => {
    expect(localeToRegion("ko-KR")).toBe("KR");
    expect(localeToRegion("ja-JP")).toBe("JP");
    expect(localeToRegion("de-DE")).toBe("DE");
  });

  test("unsupported and malformed locales resolve to the global order", () => {
    expect(localeToRegion("en-US")).toBe("");
    expect(localeToRegion("fr")).toBe("");
    expect(localeToRegion("")).toBe("");
  });
});

describe("metadataDomainOf", () => {
  const schema = (preset: string | null | undefined, fields: string[]): FolderSchema => ({
    meta: preset ? { preset } : undefined,
    properties: Object.fromEntries(
      fields.map((f) => [f, { prop_type: "text", metadata: f }]),
    ),
  });

  test("preset marker decides outright", () => {
    expect(metadataDomainOf(schema("book", []))).toBe("book");
    expect(metadataDomainOf(schema("movie", []))).toBe("movie");
  });

  test("marker-less schemas infer from the declared field vocabulary", () => {
    expect(metadataDomainOf(schema(null, ["author"]))).toBe("book");
    expect(metadataDomainOf(schema(null, ["director", "runtime_min"]))).toBe("movie");
  });

  test("no metadata declarations hide the affordance", () => {
    expect(metadataDomainOf(schema("blog", []))).toBeNull();
    expect(metadataDomainOf(schema(null, []))).toBeNull();
    expect(metadataDomainOf(null)).toBeNull();
  });
});

describe("hasSearchProvider", () => {
  test("book is always searchable — open_library is keyless", () => {
    expect(hasSearchProvider("book", undefined)).toBe(true);
    expect(hasSearchProvider("book", {})).toBe(true);
  });

  test("movie needs at least one provider key (all movie providers are keyed)", () => {
    expect(hasSearchProvider("movie", undefined)).toBe(false);
    expect(hasSearchProvider("movie", {})).toBe(false);
    expect(hasSearchProvider("movie", { tmdb_key: "" })).toBe(false);
    expect(hasSearchProvider("movie", { omdb_key: "k" })).toBe(true);
    expect(hasSearchProvider("movie", { kmdb_key: "k" })).toBe(true);
    // Book keys never unlock the movie domain.
    expect(hasSearchProvider("movie", { google_books_key: "k" })).toBe(false);
  });
});
