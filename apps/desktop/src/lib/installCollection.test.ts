/** Fallback parity for `install_collection` (spec 2026-08-23 §2): the
 *  browser mirror of the core preset registry seeds the schema, marks
 *  the `[meta] preset` provenance, registers the folder, keeps user
 *  schemas on reinstall (skip-if-exists), and rejects unknown ids. */
import { afterEach, describe, expect, test } from "bun:test";

// bun has no DOM — shim an in-memory localStorage so the fallback's
// load/save helpers work (the desktop shell keeps the real one).
const mem = new Map<string, string>();
if (typeof globalThis.localStorage === "undefined") {
  globalThis.localStorage = {
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => void mem.set(k, String(v)),
    removeItem: (k) => void mem.delete(k),
    clear: () => void mem.clear(),
    key: (i) => [...mem.keys()][i] ?? null,
    get length() {
      return mem.size;
    },
  } as Storage;
}

import { installCollection } from "./api";

/** Desktop shell detection mirrors tauri.ts (`__TAURI_INTERNALS__` on
 *  window); under bun there is no window, so the fallback always runs. */
const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const SCHEMAS_KEY = "oximemo:schemas";
const FOLDERS_KEY = "oximemo:folders:v1";

afterEach(() => {
  localStorage.removeItem(SCHEMAS_KEY);
  localStorage.removeItem(FOLDERS_KEY);
});

describe("fallback install_collection", () => {
  test.skipIf(isTauri)("seeds schema with marker and registers folder", async () => {
    localStorage.setItem(SCHEMAS_KEY, "{}");
    localStorage.setItem(FOLDERS_KEY, "[]");
    await installCollection("book", "책");
    const schemas = JSON.parse(localStorage.getItem(SCHEMAS_KEY) ?? "{}");
    expect(schemas["책"].meta?.preset).toBe("book");
    expect(schemas["책"].properties.author.metadata).toBe("author");
    expect(JSON.parse(localStorage.getItem(FOLDERS_KEY) ?? "[]")).toContain("책");
  });

  test.skipIf(isTauri)("never overwrites an existing schema", async () => {
    localStorage.setItem(
      SCHEMAS_KEY,
      JSON.stringify({ 책: { workspace: { name: "내 책" } } }),
    );
    localStorage.setItem(FOLDERS_KEY, "[]");
    await installCollection("book", "책");
    const schemas = JSON.parse(localStorage.getItem(SCHEMAS_KEY) ?? "{}");
    expect(schemas["책"].workspace?.name).toBe("내 책");
    expect(schemas["책"].meta).toBeUndefined();
  });

  test.skipIf(isTauri)("idea preset carries the promote declaration", async () => {
    localStorage.setItem(SCHEMAS_KEY, "{}");
    localStorage.setItem(FOLDERS_KEY, "[]");
    await installCollection("idea", "인박스");
    const schemas = JSON.parse(localStorage.getItem(SCHEMAS_KEY) ?? "{}");
    expect(schemas["인박스"].review.promote).toEqual({
      into: "knowledge",
      kind: "knowledge",
      start_status: "stub",
    });
  });

  test.skipIf(isTauri)("rejects unknown preset ids", async () => {
    localStorage.setItem(SCHEMAS_KEY, "{}");
    localStorage.setItem(FOLDERS_KEY, "[]");
    await expect(installCollection("nope", "x")).rejects.toThrow(
      "unknown collection preset",
    );
  });
});
