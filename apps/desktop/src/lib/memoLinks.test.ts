import { describe, expect, test } from "bun:test";
import type { Memo } from "./types";
import { openOrCreateWikiTarget, wikiDocumentTarget } from "./memoLinks";

const note = { id: "018f47c6-1199-72b3-87de-344e5a493e27", title: "청계천 길치", deleted_at: null } as Memo;

describe("wiki link opening", () => {
  test("opens an existing title without creating a duplicate", async () => {
    let created = false;
    const result = await openOrCreateWikiTarget("청계천 길치", "일기", {
      get: async () => note,
      create: async () => { created = true; return note; },
    });
    expect(result).toEqual({ memo: note, created: false });
    expect(created).toBe(false);
  });

  test("creates a missing title in the source folder and opens it", async () => {
    const requests: [string, string][] = [];
    const result = await openOrCreateWikiTarget("청계천 길치", "일기", {
      get: async () => { throw new Error("not found: 청계천 길치"); },
      create: async (body, folder) => { requests.push([body, folder ?? ""]); return note; },
    });
    expect(requests).toEqual([["# 청계천 길치\n", "일기"]]);
    expect(result).toEqual({ memo: note, created: true });
  });

  test("an anchor selects its document instead of creating an anchor-named note", async () => {
    expect(wikiDocumentTarget("청계천 길치#장면")).toBe("청계천 길치");
    const result = await openOrCreateWikiTarget("청계천 길치#장면", "", {
      get: async (target) => { expect(target).toBe("청계천 길치"); return note; },
      create: async () => { throw new Error("must not create"); },
    });
    expect(result.created).toBe(false);
  });

  test("does not create a note when lookup fails for another reason", async () => {
    let created = false;
    expect(openOrCreateWikiTarget("청계천 길치", "", {
      get: async () => { throw new Error("index unavailable"); },
      create: async () => { created = true; return note; },
    })).rejects.toThrow("index unavailable");
    expect(created).toBe(false);
  });
});
