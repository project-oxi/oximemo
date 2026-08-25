import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useUI } from "./ui";

/** Reset the store's location trio between tests (zustand keeps one
 *  global instance per module graph). */
beforeEach(() => {
  useUI.getState().setFolderFilter("");
});
afterEach(() => {
  useUI.getState().exitBase();
  useUI.setState({ search: "" });
});

describe("location mapping (query views spec §5)", () => {
  test("folderFilter/favoritesOnly mirror the location", () => {
    useUI.getState().setFolderFilter("book");
    let s = useUI.getState();
    expect(s.location).toEqual({ kind: "folder", path: "book" });
    expect(s.folderFilter).toBe("book");
    expect(s.favoritesOnly).toBe(false);

    useUI.getState().clearFolderFilter();
    s = useUI.getState();
    expect(s.location).toEqual({ kind: "all" });
    expect(s.folderFilter).toBeNull();
    expect(s.favoritesOnly).toBe(false);

    useUI.getState().setFavoritesOnly(true);
    s = useUI.getState();
    expect(s.location).toEqual({ kind: "favorites" });
    expect(s.favoritesOnly).toBe(true);
    expect(s.folderFilter).toBeNull();
  });

  test("sidebar's paired calls land on the final location", () => {
    // setFavoritesOnly(false); setFolderFilter(null) → all
    useUI.getState().setFavoritesOnly(false);
    useUI.getState().setFolderFilter(null);
    expect(useUI.getState().location).toEqual({ kind: "all" });
    // setFolderFilter(null); setFavoritesOnly(true) → favorites
    useUI.getState().setFolderFilter(null);
    useUI.getState().setFavoritesOnly(true);
    expect(useUI.getState().location).toEqual({ kind: "favorites" });
    // setFavoritesOnly(false); setFolderFilter(path) → folder
    useUI.getState().setFavoritesOnly(false);
    useUI.getState().setFolderFilter("work/2026");
    expect(useUI.getState().location).toEqual({ kind: "folder", path: "work/2026" });
  });

  test("openBase records previous location, clears search; exitBase restores", () => {
    useUI.getState().setFolderFilter("book");
    useUI.getState().setSearch("찾기");
    useUI.getState().openBase({ path: "queries/독서.query" });
    let s = useUI.getState();
    expect(s.location).toEqual({ kind: "base", source: { path: "queries/독서.query" } });
    expect(s.folderFilter).toBeNull();
    expect(s.favoritesOnly).toBe(false);
    expect(s.lastNonBaseLocation).toEqual({ kind: "folder", path: "book" });
    expect(s.search).toBe("");

    useUI.getState().exitBase();
    s = useUI.getState();
    expect(s.location).toEqual({ kind: "folder", path: "book" });
    expect(s.folderFilter).toBe("book");
  });

  test("starting a search exits a base; empty search does not", () => {
    useUI.getState().setFolderFilter("book");
    useUI.getState().openBase({ inline: "views: []" });
    useUI.getState().setSearch("");
    expect(useUI.getState().location.kind).toBe("base");
    useUI.getState().setSearch("단어");
    const s = useUI.getState();
    expect(s.location).toEqual({ kind: "folder", path: "book" });
    expect(s.search).toBe("단어");
  });

  test("navigateUp: base exits, favorites falls to root, nested folder climbs", () => {
    useUI.getState().setFolderFilter("book");
    useUI.getState().openBase({ path: "queries/a.query" });
    useUI.getState().navigateUp();
    expect(useUI.getState().location).toEqual({ kind: "folder", path: "book" });

    useUI.getState().setFavoritesOnly(true);
    useUI.getState().navigateUp();
    expect(useUI.getState().location).toEqual({ kind: "folder", path: "" });

    useUI.getState().setFolderFilter("a/b/c");
    useUI.getState().navigateUp();
    expect(useUI.getState().location).toEqual({ kind: "folder", path: "a/b" });
    useUI.getState().navigateUp();
    expect(useUI.getState().location).toEqual({ kind: "folder", path: "a" });
    useUI.getState().navigateUp();
    expect(useUI.getState().location).toEqual({ kind: "folder", path: "" });
  });
});
