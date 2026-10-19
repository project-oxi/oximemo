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

describe("space picker visibility", () => {
  afterEach(() => {
    useUI.setState({ sidebarCollapsed: false, spacePickerOpen: false, spacePickerCreate: false });
  });

  test("switch command reveals a collapsed sidebar and opens the picker", () => {
    useUI.setState({ sidebarCollapsed: true, spacePickerOpen: false });
    useUI.getState().setSpacePickerOpen(true);
    const s = useUI.getState();
    expect(s.sidebarCollapsed).toBe(false);
    expect(s.spacePickerOpen).toBe(true);
    expect(s.spacePickerCreate).toBe(false);
  });

  test("create command opens its form even when the sidebar was collapsed", () => {
    useUI.setState({ sidebarCollapsed: true, spacePickerOpen: false });
    useUI.getState().requestSpaceCreate();
    const s = useUI.getState();
    expect(s.sidebarCollapsed).toBe(false);
    expect(s.spacePickerOpen).toBe(true);
    expect(s.spacePickerCreate).toBe(true);
  });

  test("dismissal clears the form so reopening returns to the space list", () => {
    useUI.getState().requestSpaceCreate();
    useUI.getState().setSpacePickerOpen(false);
    expect(useUI.getState().spacePickerCreate).toBe(false);
    useUI.getState().setSpacePickerOpen(true);
    expect(useUI.getState().spacePickerCreate).toBe(false);
  });

  test("collapsing the sidebar dismisses the popup and its creation request", () => {
    useUI.getState().requestSpaceCreate();
    useUI.getState().toggleSidebar();
    let s = useUI.getState();
    expect(s.sidebarCollapsed).toBe(true);
    expect(s.spacePickerOpen).toBe(false);
    expect(s.spacePickerCreate).toBe(false);
    useUI.getState().toggleSidebar();
    s = useUI.getState();
    expect(s.sidebarCollapsed).toBe(false);
    expect(s.spacePickerOpen).toBe(false);
  });
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

  test("openPdc records return location, clears search; typing a search leaves PDC", () => {
    useUI.getState().setFolderFilter("book");
    useUI.getState().openPdc();
    let s = useUI.getState();
    expect(s.location).toEqual({ kind: "pdc" });
    expect(s.folderFilter).toBeNull();
    expect(s.favoritesOnly).toBe(false);
    expect(s.lastNonBaseLocation).toEqual({ kind: "folder", path: "book" });
    expect(s.search).toBe("");

    // The inventory never consumes the global search: typing must leave
    // PDC instead of stashing an invisible query in state.
    useUI.getState().setSearch("단어");
    s = useUI.getState();
    expect(s.location).toEqual({ kind: "folder", path: "book" });
    expect(s.search).toBe("단어");
  });

  test("empty search does not leave PDC", () => {
    useUI.getState().openPdc();
    useUI.getState().setSearch("");
    expect(useUI.getState().location.kind).toBe("pdc");
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
