import { describe, expect, test } from "bun:test";

import {
  buildCommands,
  buildSuggestions,
  matchScore,
  rankCommands,
  RecencyLog,
  type CommandCallbacks,
} from "./paletteCommands";
import type { FolderEntry } from "./types";

const cbs = (): CommandCallbacks => ({
  jumpToFolder: () => {},
  openCollection: () => {},
  openGallery: () => {},
  openToday: () => {},
  selectTag: () => {},
  setViewMode: () => {},
  toggleSidebar: () => {},
  newNote: () => {},
  newFolder: () => {},
  quickCapture: () => {},
  openSettings: () => {},
  openCollectionsSettings: () => {},
  setTheme: () => {},
});

const folders: FolderEntry[] = [
  { path: "", note_count: 9 },
  { path: "work", note_count: 3 },
  { path: "work/2026", note_count: 1 },
] as FolderEntry[];

const deps = (over: Partial<Parameters<typeof buildCommands>[0]> = {}) => ({
  locale: "ko" as const,
  noteView: "grid" as const,
  theme: "system" as const,
  folders,
  tags: [["dev", 4], ["rust", 2]] as [string, number][],
  dailyEnabled: true,
  callbacks: cbs(),
  ...over,
});

describe("matchScore ladder", () => {
  test("exact > prefix > boundary > substring > subsequence", () => {
    expect(matchScore(["즐겨찾기"], "즐겨찾기")).toBe(1000);
    expect(matchScore(["즐겨찾기"], "즐겨")).toBe(500);
    expect(matchScore(["볼트 루트"], "루트")).toBe(300);
    expect(matchScore(["work/2026"], "2026")).toBe(300); // after '/'
    expect(matchScore(["그래프 보기"], "보기")).toBe(300);
    expect(matchScore(["오늘의 노트"], "노트")).toBe(300);
    expect(matchScore(["테마: 다크"], "다크")).toBe(300);
    expect(matchScore(["빠른 캡처"], "캡처")).toBe(300);
    expect(matchScore(["hello world"], "llo w")).toBe(200);
    expect(matchScore(["hello world"], "hwd")).toBeGreaterThan(59);
    expect(matchScore(["hello world"], "hwd")).toBeLessThanOrEqual(80);
    expect(matchScore(["hello world"], "xyz")).toBe(0);
  });

  test("empty query never matches", () => {
    expect(matchScore(["anything"], "")).toBe(0);
    expect(matchScore(["anything"], "   ")).toBe(0);
  });

  test("case-insensitive", () => {
    expect(matchScore(["Quick Capture"], "quick")).toBe(500);
  });
});

describe("system-folder display names", () => {
  test("default folders get localized titles; physical paths stay matchable", () => {
    const sysFolders: FolderEntry[] = [
      { path: "knowledge", note_count: 4 },
      { path: "daily", note_count: 2 },
      { path: "knowledge/ai", note_count: 1 },
    ];
    const cmds = buildCommands(
      deps({ folders: sysFolders, dailyFolder: "daily" }),
    );
    const byTitle = (t: string) => cmds.find((c) => c.title === t);
    expect(byTitle("지식")).toBeDefined();
    expect(byTitle("데일리")).toBeDefined();
    // Nested system folders localize the leading segment: "knowledge/ai"
    // → "지식/ai" (palette titles are full paths).
    expect(byTitle("지식/ai")).toBeDefined();
    // matches even though the title is localized.
    const k = byTitle("지식")!;
    expect(k.alias).toContain("knowledge");
  });
});

describe("rankCommands", () => {
  const cmds = buildCommands(deps());

  test("filters non-matches and ranks exact over substring", () => {
    const ranked = rankCommands(cmds, "즐겨찾기", new RecencyLog());
    expect(ranked[0].id).toBe("nav.favorites");
    expect(ranked.every((c) => c.id !== "nav.all")).toBe(true);
  });

  test("matches the other-locale alias (ko UI, en query)", () => {
    const ranked = rankCommands(cmds, "favor", new RecencyLog());
    expect(ranked.some((c) => c.id === "nav.favorites")).toBe(true);
  });

  test("empty query returns []", () => {
    expect(rankCommands(cmds, "", new RecencyLog())).toEqual([]);
  });

  test("recency boost lifts an equal-rung tie", () => {
    // Both folder paths prefix-match "w" (500 each, curated order puts
    // "work" first); the recorded one gets +25 and wins.
    const plain = rankCommands(cmds, "w", new RecencyLog());
    expect(plain[0].id).toBe("folder:work");
    const rec = new RecencyLog();
    rec.record("folder:work/2026");
    const ranked = rankCommands(cmds, "w", rec);
    expect(ranked[0].id).toBe("folder:work/2026");
  });

  test("ties keep curated order", () => {
    // The remaining view commands all boundary-match "보기" (300 each);
    // ties fall back to build order. ("사이드바 전환" has no "보기" and
    // grid is excluded as the active mode.)
    const ranked = rankCommands(cmds, "보기", new RecencyLog());
    const ids = ranked.filter((c) => c.id.startsWith("view.")).map((c) => c.id);
    expect(ids).toEqual(["view.list", "view.timeline", "view.graph"]);
  });
});

describe("RecencyLog", () => {
  test("record moves to front, dedups, caps at 20", () => {
    const r = new RecencyLog();
    for (let i = 0; i < 25; i++) r.record(`c${i}`);
    r.record("c10");
    const snap = r.snapshot();
    expect(snap[0]).toBe("c10");
    expect(snap.filter((x) => x === "c10")).toHaveLength(1);
    expect(snap).toHaveLength(20);
  });

  test("boost decays with rank, 0 when absent", () => {
    const r = new RecencyLog();
    r.record("a"); r.record("b");
    expect(r.boost("b")).toBeGreaterThan(r.boost("a"));
    expect(r.boost("zzz")).toBe(0);
    expect(r.boost("b")).toBeLessThanOrEqual(25);
  });
});

describe("buildCommands", () => {
  test("excludes current view mode and current theme", () => {
    const cmds = buildCommands(deps());
    expect(cmds.some((c) => c.id === "view.grid")).toBe(false);
    expect(cmds.some((c) => c.id === "view.list")).toBe(true);
    expect(cmds.some((c) => c.id === "theme:system")).toBe(false);
    expect(cmds.some((c) => c.id === "theme:dark")).toBe(true);
  });

  test("daily command gated on dailyEnabled", () => {
    expect(buildCommands(deps()).some((c) => c.id === "nav.today")).toBe(true);
    expect(buildCommands(deps({ dailyEnabled: false })).some((c) => c.id === "nav.today")).toBe(false);
  });

  test("folders: root skipped, full-path commands with counts", () => {
    const cmds = buildCommands(deps());
    const w = cmds.find((c) => c.id === "folder:work/2026");
    expect(w).toBeDefined();
    expect(w!.title).toBe("work/2026");
    expect(w!.count).toBe(1);
    expect(cmds.some((c) => c.id === "folder:")).toBe(false);
  });

  test("tags become #tag commands", () => {
    const cmds = buildCommands(deps());
    expect(cmds.find((c) => c.id === "tag:dev")?.title).toBe("#dev");
  });

  test("ids are unique and stable across rebuilds", () => {
    const a = buildCommands(deps());
    const b = buildCommands(deps());
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
    expect(new Set(a.map((c) => c.id)).size).toBe(a.length);
  });
});

describe("buildSuggestions", () => {
  test("recency first, curated fill to 6, no duplicates", () => {
    const cmds = buildCommands(deps());
    const rec = new RecencyLog();
    rec.record("folder:work");
    const s = buildSuggestions(cmds, rec);
    expect(s).toHaveLength(6);
    expect(s[0].id).toBe("folder:work");
    expect(new Set(s.map((c) => c.id)).size).toBe(6);
  });

  test("stale recency ids (since-removed folders) are skipped", () => {
    const cmds = buildCommands(deps({ folders: [] }));
    const rec = new RecencyLog();
    rec.load(["folder:gone"]);
    const s = buildSuggestions(cmds, rec);
    expect(s.every((c) => c.id !== "folder:gone")).toBe(true);
    expect(s).toHaveLength(6);
  });

  test("recency contributes at most 5 entries — curated still gets a slot", () => {
    const cmds = buildCommands(deps());
    const rec = new RecencyLog();
    const ids = [
      "folder:work",
      "folder:work/2026",
      "view.sidebar",
      "action.new_html",
      "action.new_folder",
      "tag:dev",
      "tag:rust",
    ];
    rec.load(ids);
    const s = buildSuggestions(cmds, rec);
    expect(s).toHaveLength(6);
    const recencyIds = new Set(ids);
    expect(s.filter((c) => recencyIds.has(c.id))).toHaveLength(5);
    // Recency order preserved for the admitted entries…
    expect(s.slice(0, 5).map((c) => c.id)).toEqual(ids.slice(0, 5));
    // …and the 6th slot is curated (first curated id not already used).
    expect(s[5].id).toBe("nav.today");
  });
});
