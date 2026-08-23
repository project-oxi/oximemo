import { describe, expect, test } from "bun:test";

import { localeToRegion, metadataDomainOf } from "./metadataRegion";
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
