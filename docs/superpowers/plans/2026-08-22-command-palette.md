# Command Palette (⌘K) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A global ⌘K command palette for the oximemo desktop app — commands (navigation, views, actions) + BM25 note search + recents, replacing the ⌘⇧O FolderPalette.

**Architecture:** Pure logic in `lib/paletteCommands.ts` (build/rank/suggest + recency log, unit-tested via `bun test`), a `CommandPalette.tsx` Base UI Dialog host (generalizes FolderPalette's markup), store flags in `stores/ui.ts`, and CardGrid wiring (⌘K branch, guards, FolderPalette removal, new-folder effect, search-all bridge). One new Rust IPC command `show_capture_window`.

**Tech Stack:** React 19, Base UI Dialog, TanStack Query, Zustand, Tailwind v4 (semantic tokens), lucide-react, bun test, Tauri v2.

**Spec:** `docs/superpowers/specs/2026-08-22-command-palette-design.md`

## Global Constraints

- ko.ts (`apps/desktop/src/lib/locales/ko.ts`) is the i18n source of truth; en.ts mirrors it via `Record<keyof typeof ko, string>` — every new ko key MUST get an en twin in the same task.
- No new npm/cargo dependencies. Icons: `lucide-react` only.
- Styling: semantic Tailwind tokens only (`bg-surface-raised`, `text-text-subtle`, `border-line`, …) — never raw palette utilities (`bg-zinc-100`) or hardcoded hex.
- Overlay conventions: backdrop `z-40` `bg-black/40 backdrop-blur-sm`, popup `z-50`, `rounded-[var(--dialog-radius)]`, `bg-surface-raised`, `border-line`, `shadow-lg`, scale/fade `data-[starting-style]` entrance (copy FolderPalette.tsx:83-84 verbatim style strings).
- Tauri IPC: JS sends camelCase keys; `show_capture_window` takes no args (no casing pitfall).
- Shortcut predicates (exact): ⌘K = `(e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k"`; ⌘⇧O alias = `(e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "o"`.
- Keyboard nav must ignore `e.nativeEvent.isComposing` (Korean IME confirm-Enter).
- Every task ends with: `cd apps/desktop && bunx tsc --noEmit` clean, plus its own test/verify command, then a conventional-commit (`feat:`/`test:`/`refactor:`), English message.
- Working branch: `feat/command-palette` (already checked out). Do NOT touch main.

---

### Task 1: Rust `show_capture_window` + api adapter + store flags

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs` (commands module + handler registration)
- Modify: `apps/desktop/src/lib/api.ts` (append near window helpers)
- Modify: `apps/desktop/src/stores/ui.ts` (3 new state fields)

**Interfaces:**
- Consumes: existing private `fn show_capture(&AppHandle)` at `lib.rs:310`.
- Produces (later tasks rely on exactly these):
  - `api.ts`: `export function showCaptureWindow(): Promise<void>` — `invoke("show_capture_window")`
  - store: `cmdPaletteOpen: boolean` + `setCmdPaletteOpen(b: boolean): void` (init `false`)
  - store: `settingsOpen: boolean` + `setSettingsOpen(b: boolean): void` (init `false`)
  - store: `requestNewFolder: boolean` + `requestFolderCreate(): void` (sets true) + `consumeFolderCreate(): void` (sets false)

- [ ] **Step 1: Add the Rust command**

In `apps/desktop/src-tauri/src/lib.rs`, inside `mod commands` (starts line 496; it already has `use tauri::{AppHandle, Emitter, State};` at 498), append this command (e.g. after `uninstall_cli` at the module tail):

```rust
    /// Show (or dismiss, when already visible) the quick-capture overlay.
    /// Same toggle path as the ⌘⇧N global shortcut and the tray item —
    /// exposed as a command so the renderer's ⌘K palette can trigger it.
    #[tauri::command]
    pub fn show_capture_window(app: AppHandle) {
        crate::show_capture(&app);
    }
```

Then register it in the `invoke_handler(tauri::generate_handler![...])` list (lib.rs:204-248) — add `commands::show_capture_window,` after `commands::uninstall_cli,` (last entry, line 247).

- [ ] **Step 2: Verify Rust compiles**

Run: `cd apps/desktop/src-tauri && cargo check -p oximemo-desktop 2>&1 | tail -5`
Expected: `Finished` with no errors (dist/ already exists, so `generate_context!` resolves).

- [ ] **Step 3: Add the api.ts adapter**

In `apps/desktop/src/lib/api.ts`, after `uninstallCli` (line ~268):

```ts
/** Toggle the quick-capture overlay (same path as the ⌘⇧N shortcut). */
export function showCaptureWindow(): Promise<void> {
  return invoke<void>("show_capture_window");
}
```

- [ ] **Step 4: Add store flags**

In `apps/desktop/src/stores/ui.ts`:

(a) Extend the `UIState` interface (inside the `interface UIState { ... }` block, after the `updateAvailable` pair at lines 78-80):

```ts
  /** ⌘K command palette open? Transient overlay state. */
  cmdPaletteOpen: boolean;
  setCmdPaletteOpen: (b: boolean) => void;
  /** Settings drawer open — store-owned so the palette (and the gear)
   * share one source of truth. */
  settingsOpen: boolean;
  setSettingsOpen: (b: boolean) => void;
  /** One-shot request from the palette: create a folder in the main
   * area. CardGrid consumes it; query mode first falls back to the
   * vault root (creation never lands in an ambiguous location). */
  requestNewFolder: boolean;
  requestFolderCreate: () => void;
  consumeFolderCreate: () => void;
```

(b) Add implementations in `useUI = create<UIState>((set) => ({ ... }))` (after `setUpdateAvailable` at line 178):

```ts
  cmdPaletteOpen: false,
  setCmdPaletteOpen: (b) => set({ cmdPaletteOpen: b }),
  settingsOpen: false,
  setSettingsOpen: (b) => set({ settingsOpen: b }),
  requestNewFolder: false,
  requestFolderCreate: () => set({ requestNewFolder: true }),
  consumeFolderCreate: () => set({ requestNewFolder: false }),
```

- [ ] **Step 5: Typecheck + commit**

Run: `cd apps/desktop && bunx tsc --noEmit`
Expected: exit 0.

```bash
git add apps/desktop/src-tauri/src/lib.rs apps/desktop/src/lib/api.ts apps/desktop/src/stores/ui.ts
git commit -m "feat(desktop): show_capture_window IPC + palette/settings/new-folder store flags"
```

---

### Task 2: `lib/paletteCommands.ts` — pure palette logic (TDD)

**Files:**
- Create: `apps/desktop/src/lib/paletteCommands.ts`
- Test: `apps/desktop/src/lib/paletteCommands.test.ts`

**Interfaces:**
- Consumes: `FolderEntry` (`lib/types.ts`: `{ path: string; note_count: number; ... }`), `ViewMode` (`"grid" | "list" | "timeline" | "graph"`), `Theme` (`lib/theme.ts`: `"system" | "light" | "dark"`), locale dicts `ko`/`en` + `DictKey`.
- Produces (Task 3 relies on exactly these):
  - `type PaletteIcon` (string union)
  - `interface PaletteCommand { id; icon; title; alias?; hint?; count?; group: "nav"|"view"|"action"; order: number; run(): void | Promise<void> }`
  - `interface CommandCallbacks` (13 methods — see code)
  - `interface CommandDeps { locale; noteView; theme; folders; tags; dailyEnabled; callbacks }`
  - `buildCommands(deps: CommandDeps): PaletteCommand[]`
  - `matchScore(labels: string[], query: string): number`
  - `rankCommands(commands, query, recency): PaletteCommand[]`
  - `class RecencyLog { load(ids); snapshot(); record(id); boost(id) }`
  - `buildSuggestions(commands, recency, limit?): PaletteCommand[]`
  - `const CURATED_SUGGESTION_IDS: readonly string[]`

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src/lib/paletteCommands.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd apps/desktop && bun test src/lib/paletteCommands.test.ts`
Expected: FAIL — `Cannot resolve module './paletteCommands'`.

- [ ] **Step 3: Implement `paletteCommands.ts`**

Create `apps/desktop/src/lib/paletteCommands.ts`:

```ts
/**
 * Command-palette core (⌘K): pure, React-free logic for building,
 * matching, and ranking palette commands, plus the selection-recency
 * log. CommandPalette.tsx owns rendering/IPC; everything here is
 * deterministic and unit-tested (bun test).
 *
 * Simplified from the oxios federated registry (see
 * docs/superpowers/specs/2026-08-22-command-palette-design.md): no verb
 * grammar, no providers. buildCommands() mints an id-stable catalog from
 * current app state; rankCommands() filters + scores it per keystroke
 * (exact > prefix > word-boundary > substring > subsequence, plus a
 * decaying recency boost); the host persists the recency log.
 */
import { dict as en } from "./locales/en";
import { dict as ko, type DictKey } from "./locales/ko";
import type { Theme } from "./theme";
import type { FolderEntry, ViewMode } from "./types";

/** Icon name — resolved to a lucide component by CommandPalette.tsx. */
export type PaletteIcon =
  | "layers" | "star" | "images" | "archive" | "calendar" | "folder"
  | "hash" | "grid" | "list" | "timeline" | "graph" | "sidebar"
  | "note-md" | "note-html" | "folder-plus" | "zap" | "settings"
  | "sun" | "moon" | "monitor";

export interface PaletteCommand {
  /** Stable identity for the recency log (e.g. "folder:work/2026"). */
  id: string;
  icon: PaletteIcon;
  /** Displayed (current-locale) title. */
  title: string;
  /** Other-locale title — matched, never displayed. */
  alias?: string;
  /** Right-aligned keyboard hint, e.g. "⌘N". */
  hint?: string;
  /** Right-aligned count chip (folders/tags); hint wins when both set. */
  count?: number;
  group: "nav" | "view" | "action";
  /** Curated base order — rankCommands tiebreaks on this. */
  order: number;
  run: () => void | Promise<void>;
}

/** Everything the palette can DO — injected by CardGrid, never imported. */
export interface CommandCallbacks {
  /** Browse a folder (drops search; the jumpToFolder convention). */
  jumpToFolder: (path: string) => void;
  /** Smart collections: all-memos query mode / favorites. */
  openCollection: (kind: "all" | "favorites") => void;
  openGallery: () => void;
  /** Open (create if missing) today's daily note. */
  openToday: () => void;
  /** Sidebar tag convention: vault-wide tag filter. */
  selectTag: (tag: string) => void;
  /** Switch note view mode (also leaves gallery). */
  setViewMode: (v: ViewMode) => void;
  toggleSidebar: () => void;
  newNote: (format: "markdown" | "html") => void;
  /** Request folder creation in the main area (CardGrid effect). */
  newFolder: () => void;
  quickCapture: () => void;
  openSettings: () => void;
  setTheme: (t: Theme) => void;
}

export interface CommandDeps {
  locale: "ko" | "en";
  noteView: ViewMode;
  theme: Theme;
  folders: FolderEntry[];
  tags: [string, number][];
  dailyEnabled: boolean;
  callbacks: CommandCallbacks;
}

const tr = (locale: "ko" | "en", key: DictKey) => (locale === "ko" ? ko[key] : en[key]);
/** Display title in `locale`, alias in the other locale. */
const pair = (locale: "ko" | "en", key: DictKey): { title: string; alias: string } =>
  locale === "ko" ? { title: ko[key], alias: en[key] } : { title: en[key], alias: ko[key] };

const VIEW_KEYS = {
  grid: "palette_view_grid",
  list: "palette_view_list",
  timeline: "palette_view_timeline",
  graph: "palette_view_graph",
} as const satisfies Record<ViewMode, DictKey>;

const THEME_KEYS = {
  system: "theme_system",
  light: "theme_light",
  dark: "theme_dark",
} as const satisfies Record<Theme, DictKey>;

/** Curated home-state fill order (recency entries come first). */
export const CURATED_SUGGESTION_IDS = [
  "nav.today",
  "action.new_md",
  "action.capture",
  "nav.all",
  "nav.favorites",
  "nav.gallery",
] as const;

export function buildCommands(deps: CommandDeps): PaletteCommand[] {
  const { locale, noteView, theme, folders, tags, dailyEnabled, callbacks } = deps;
  const out: PaletteCommand[] = [];
  let order = 0;
  const add = (
    id: string,
    icon: PaletteIcon,
    title: string,
    alias: string,
    group: PaletteCommand["group"],
    run: () => void,
    extra?: Partial<Pick<PaletteCommand, "hint" | "count">>,
  ) => out.push({ id, icon, title, alias, group, run, order: order++, ...extra });

  const p = pair(locale, "all_memos");
  add("nav.all", "layers", p.title, p.alias, "nav", () => callbacks.openCollection("all"));
  const f = pair(locale, "favorite");
  add("nav.favorites", "star", f.title, f.alias, "nav", () => callbacks.openCollection("favorites"));
  const g = pair(locale, "gallery");
  add("nav.gallery", "images", g.title, g.alias, "nav", callbacks.openGallery);
  const v = pair(locale, "vault_root");
  add("nav.vault_root", "archive", v.title, v.alias, "nav", () => callbacks.jumpToFolder(""));
  if (dailyEnabled) {
    const d = pair(locale, "today_note");
    add("nav.today", "calendar", d.title, d.alias, "nav", callbacks.openToday);
  }
  // Folders — full path as the title (nested match via substring, "a/b"),
  // exactly like the FolderPalette this palette replaces. Root ("") is
  // never listed: nav.vault_root covers it.
  for (const folder of folders) {
    if (folder.path === "") continue;
    add(
      `folder:${folder.path}`,
      "folder",
      folder.path,
      folder.path,
      "nav",
      () => callbacks.jumpToFolder(folder.path),
      folder.note_count > 0 ? { count: folder.note_count } : undefined,
    );
  }
  for (const [tag, count] of tags) {
    add(`tag:${tag}`, "hash", `#${tag}`, `#${tag}`, "nav", () => callbacks.selectTag(tag), {
      count,
    });
  }

  // View-mode switches exclude the active mode (no-op noise).
  for (const mode of ["grid", "list", "timeline", "graph"] as ViewMode[]) {
    if (mode === noteView) continue;
    const k = pair(locale, VIEW_KEYS[mode]);
    add(`view.${mode}`, mode === "grid" ? "grid" : mode === "list" ? "list" : mode, k.title, k.alias, "view", () => callbacks.setViewMode(mode));
  }
  const sb = pair(locale, "palette_sidebar_toggle");
  add("view.sidebar", "sidebar", sb.title, sb.alias, "view", callbacks.toggleSidebar);

  const md = pair(locale, "new_note_md");
  add("action.new_md", "note-md", md.title, md.alias, "action", () => callbacks.newNote("markdown"), { hint: "⌘N" });
  const html = pair(locale, "new_note_html");
  add("action.new_html", "note-html", html.title, html.alias, "action", () => callbacks.newNote("html"));
  const nf = pair(locale, "folder_new");
  add("action.new_folder", "folder-plus", nf.title, nf.alias, "action", callbacks.newFolder);
  const qc = pair(locale, "palette_quick_capture");
  add("action.capture", "zap", qc.title, qc.alias, "action", callbacks.quickCapture, { hint: "⌘⇧N" });
  const st = pair(locale, "settings");
  add("action.settings", "settings", st.title, st.alias, "action", callbacks.openSettings);
  // Theme trio excludes the active theme; title "테마: 다크" style.
  for (const t of ["system", "light", "dark"] as Theme[]) {
    if (t === theme) continue;
    const label = `${tr(locale, "theme")}: ${tr(locale, THEME_KEYS[t])}`;
    const other = locale === "ko" ? "en" : "ko";
    const labelAlias = `${tr(other, "theme")}: ${tr(other, THEME_KEYS[t])}`;
    add(`theme:${t}`, t === "light" ? "sun" : t === "dark" ? "moon" : "monitor", label, labelAlias, "action", () => callbacks.setTheme(t));
  }
  return out;
}

/** True when `q` starts at a word boundary of `l` (after ' ' or '/'). */
function boundaryStart(l: string, q: string): boolean {
  let i = l.indexOf(q);
  while (i !== -1) {
    if (i > 0 && (l[i - 1] === " " || l[i - 1] === "/")) return true;
    i = l.indexOf(q, i + 1);
  }
  return false;
}

/** Subsequence match score in [60, 80]; 0 when `q` is not a subsequence. */
function subsequence(l: string, q: string): number {
  let li = 0;
  let spans = 0;
  let prev = -2;
  for (const ch of q) {
    const idx = l.indexOf(ch, li);
    if (idx === -1) return 0;
    if (idx !== prev + 1) spans++;
    prev = idx;
    li = idx + 1;
  }
  return 60 + Math.max(0, 20 - (spans - 1) * 5);
}

/** Deterministic match ladder. Best rung across `labels` wins. */
export function matchScore(labels: string[], query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  let best = 0;
  for (const raw of labels) {
    const l = raw.toLowerCase();
    if (l === q) best = Math.max(best, 1000);
    else if (l.startsWith(q)) best = Math.max(best, 500);
    else if (boundaryStart(l, q)) best = Math.max(best, 300);
    else if (l.includes(q)) best = Math.max(best, 200);
    else best = Math.max(best, subsequence(l, q));
  }
  return best;
}

const MAX_RECENTS = 20;
const RECENCY_BOOST_MAX = 25;

/** Last-N selection log. The host persists `snapshot()`; the class itself
 *  is storage-free so tests stay pure. */
export class RecencyLog {
  private ids: string[] = [];
  load(ids: string[]) {
    this.ids = ids.slice(-MAX_RECENTS);
  }
  snapshot(): string[] {
    return [...this.ids];
  }
  record(id: string) {
    this.ids = [id, ...this.ids.filter((x) => x !== id)].slice(0, MAX_RECENTS);
  }
  /** Decaying boost: most recent → 25, oldest slot → ~0, absent → 0. */
  boost(id: string): number {
    const i = this.ids.indexOf(id);
    return i === -1 ? 0 : RECENCY_BOOST_MAX * (1 - i / MAX_RECENTS);
  }
}

/** Filter + score + sort. Empty query → [] (home state is built separately). */
export function rankCommands(
  commands: PaletteCommand[],
  query: string,
  recency: RecencyLog,
): PaletteCommand[] {
  const q = query.trim();
  if (!q) return [];
  const scored = commands
    .map((c) => ({
      c,
      s: matchScore(c.alias ? [c.title, c.alias] : [c.title], q) + recency.boost(c.id),
    }))
    .filter(({ s }) => s > 0);
  scored.sort((a, b) => b.s - a.s || a.c.order - b.c.order);
  return scored.map(({ c }) => c);
}

/** Home state: recency order first, curated fill, deduped, capped. */
export function buildSuggestions(
  commands: PaletteCommand[],
  recency: RecencyLog,
  limit = 6,
): PaletteCommand[] {
  const byId = new Map(commands.map((c) => [c.id, c]));
  const out: PaletteCommand[] = [];
  for (const id of recency.snapshot()) {
    if (out.length >= limit) break;
    const c = byId.get(id);
    if (c) out.push(c);
  }
  for (const id of CURATED_SUGGESTION_IDS) {
    if (out.length >= limit) break;
    const c = byId.get(id);
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `cd apps/desktop && bun test src/lib/paletteCommands.test.ts`
Expected: all PASS. If a ladder number is off (e.g. "보기" expectation), re-check the rung math before changing tests — the ladder constants are spec.

- [ ] **Step 5: Typecheck + commit**

Run: `cd apps/desktop && bunx tsc --noEmit`
Expected: exit 0.

```bash
git add apps/desktop/src/lib/paletteCommands.ts apps/desktop/src/lib/paletteCommands.test.ts
git commit -m "feat(desktop): pure command-palette catalog, ranking, recency log"
```

---

### Task 3: Locale keys + `CommandPalette.tsx` component

**Files:**
- Modify: `apps/desktop/src/lib/locales/ko.ts`, `apps/desktop/src/lib/locales/en.ts`
- Create: `apps/desktop/src/components/CommandPalette.tsx`

**Interfaces:**
- Consumes: Task 1 store flags; Task 2 exports (`buildCommands`, `buildSuggestions`, `rankCommands`, `RecencyLog`, `CommandCallbacks`, `PaletteCommand`, `PaletteIcon`); api `listMemos`, `searchMemos`, `listFacets`, `getConfig`; `colorForFolder`, `relativeTime`, `useI18n`.
- Produces (Task 4 relies on exactly this):
  - `export function CommandPalette(props: { open: boolean; onClose: () => void; folders: FolderEntry[]; folderDefs: FolderDef[]; callbacks: CommandCallbacks; onSearchAll: (q: string) => void }): JSX.Element`
  - New dict keys (both locales): `command_palette_title`, `palette_placeholder`, `palette_section_suggestions`, `palette_section_commands`, `palette_section_notes`, `palette_section_recent_notes`, `palette_search_all`, `palette_no_results`, `palette_view_grid`, `palette_view_list`, `palette_view_timeline`, `palette_view_graph`, `palette_sidebar_toggle`, `palette_quick_capture`, `palette_footer_hint`.

- [ ] **Step 1: Add locale keys**

In `ko.ts` (before the closing `} as const satisfies ...` line 196-197 — keep alphabetical-ish grouping at the tail like the existing `jump_to_folder`/`show_all_folders` block):

```ts
  command_palette_title: "명령 팔레트",
  palette_placeholder: "명령이나 노트를 검색해 보세요…",
  palette_section_suggestions: "제안",
  palette_section_commands: "명령",
  palette_section_notes: "노트",
  palette_section_recent_notes: "최근 노트",
  palette_search_all: "'{q}' 전체에서 검색",
  palette_no_results: "일치하는 결과가 없어요",
  palette_view_grid: "그리드 보기",
  palette_view_list: "리스트 보기",
  palette_view_timeline: "타임라인 보기",
  palette_view_graph: "그래프 보기",
  palette_sidebar_toggle: "사이드바 전환",
  palette_quick_capture: "빠른 캡처",
  palette_footer_hint: "↑↓ 선택 · ⏎ 실행 · esc 닫기",
```

In `en.ts` (same position, same keys):

```ts
  command_palette_title: "Command Palette",
  palette_placeholder: "Search commands or notes…",
  palette_section_suggestions: "Suggestions",
  palette_section_commands: "Commands",
  palette_section_notes: "Notes",
  palette_section_recent_notes: "Recent Notes",
  palette_search_all: "Search all notes for '{q}'",
  palette_no_results: "No matching results",
  palette_view_grid: "Grid view",
  palette_view_list: "List view",
  palette_view_timeline: "Timeline view",
  palette_view_graph: "Graph view",
  palette_sidebar_toggle: "Toggle sidebar",
  palette_quick_capture: "Quick Capture",
  palette_footer_hint: "↑↓ navigate · ⏎ run · esc close",
```

- [ ] **Step 2: Create the component**

Create `apps/desktop/src/components/CommandPalette.tsx`:

```tsx
/**
 * CommandPalette — the ⌘K global intent surface (subsumes the old ⌘⇧O
 * FolderPalette). Base UI Dialog following FolderPalette's conventions:
 * Portal + Backdrop + top-center Popup, sr-only title, Escape closes.
 * Two result sources: commands (lib/paletteCommands — navigation/views/
 * actions, deterministic score ladder + recency boost) and notes (BM25
 * via search_memos when a query is present; the shared ["memos",
 * "recents"] cache when it is not). A trailing bridge row graduates the
 * query into the persistent header search.
 *
 * Keyboard: ↓/↑ move the selection (clamped), ⏎ runs, Home/End jump,
 * click/hover select. Enter during IME composition is ignored — Korean
 * confirm-Enter must not run a command.
 */
import { Dialog } from "@base-ui-components/react";
import { useQuery } from "@tanstack/react-query";
import {
  Archive,
  CalendarDays,
  Clock,
  CodeXml,
  CornerDownLeft,
  FilePlus2,
  Folder,
  FolderPlus,
  Hash,
  Images,
  Layers,
  LayoutGrid,
  List,
  Monitor,
  Moon,
  Network,
  PanelLeft,
  Search,
  Settings,
  Star,
  Sun,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { getConfig, listFacets, listMemos, searchMemos } from "../lib/api";
import { colorForFolder } from "../lib/color";
import { useI18n } from "../lib/i18n";
import {
  buildCommands,
  buildSuggestions,
  rankCommands,
  RecencyLog,
  type CommandCallbacks,
  type PaletteCommand,
  type PaletteIcon,
} from "../lib/paletteCommands";
import { relativeTime } from "../lib/time";
import { useUI } from "../stores/ui";
import type { FolderDef, FolderEntry, MemoSummary } from "../lib/types";

const RECENCY_KEY = "oximemo.paletteRecency";
const SEARCH_DEBOUNCE_MS = 150;
const NOTE_RESULTS_LIMIT = 8;
const RECENT_NOTES_SHOWN = 5;
const SUGGESTION_LIMIT = 6;

const ICONS: Record<PaletteIcon, typeof Layers> = {
  layers: Layers,
  star: Star,
  images: Images,
  archive: Archive,
  calendar: CalendarDays,
  folder: Folder,
  hash: Hash,
  grid: LayoutGrid,
  list: List,
  timeline: Clock,
  graph: Network,
  sidebar: PanelLeft,
  "note-md": FilePlus2,
  "note-html": CodeXml,
  "folder-plus": FolderPlus,
  zap: Zap,
  settings: Settings,
  sun: Sun,
  moon: Moon,
  monitor: Monitor,
};

interface Props {
  open: boolean;
  onClose: () => void;
  /** All folders (list_folders) — folder jump commands. */
  folders: FolderEntry[];
  /** Config folder defs (color dots for note/folder rows). */
  folderDefs: FolderDef[];
  callbacks: CommandCallbacks;
  /** Bridge row: write the query into the persistent header search. */
  onSearchAll: (q: string) => void;
}

type Row =
  | { kind: "header"; label: string }
  | { kind: "command"; cmd: PaletteCommand }
  | { kind: "note"; note: MemoSummary }
  | { kind: "bridge" }
  | { kind: "empty"; label: string }
  | { kind: "error"; label: string };

export function CommandPalette({ open, onClose, folders, folderDefs, callbacks, onSearchAll }: Props) {
  const { t, locale } = useI18n();
  const noteView = useUI((s) => s.noteView);
  const theme = useUI((s) => s.theme);
  const setView = useUI((s) => s.setView);
  const select = useUI((s) => s.select);
  const facets = useQuery({ queryKey: ["facets"], queryFn: listFacets });
  const configQ = useQuery({ queryKey: ["config"], queryFn: getConfig });
  // Shares the Sidebar's recents cache — ["memos"] prefix invalidation
  // from the memos:changed listener refreshes both.
  const recentsQ = useQuery({
    queryKey: ["memos", "recents"],
    queryFn: () => listMemos(null, 7),
  });

  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLUListElement | null>(null);
  const recencyRef = useRef(new RecencyLog());

  // Restore the persisted recency log once per mount; a corrupt entry
  // just starts fresh.
  useEffect(() => {
    try {
      recencyRef.current.load(JSON.parse(localStorage.getItem(RECENCY_KEY) ?? "[]"));
    } catch {
      recencyRef.current.load([]);
    }
  }, []);

  useEffect(() => {
    const h = window.setTimeout(() => setDebounced(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(h);
  }, [query]);

  // Fresh query + selection each time the palette opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setDebounced("");
      setSel(0);
    }
  }, [open]);

  const dailyEnabled = configQ.data?.daily?.enabled !== false;
  const commands = useMemo(
    () =>
      buildCommands({
        locale,
        noteView,
        theme,
        folders,
        tags: facets.data?.tags ?? [],
        dailyEnabled,
        callbacks,
      }),
    [locale, noteView, theme, folders, facets.data, dailyEnabled, callbacks],
  );

  const q = query.trim();
  const matched = useMemo(
    () => rankCommands(commands, q, recencyRef.current),
    [commands, q],
  );
  // Keyed separately from CardGrid's infinite ["search", q] cache — the
  // shapes differ and must never collide.
  const searchQ = useQuery({
    queryKey: ["palette-search", debounced],
    queryFn: () => searchMemos(debounced, NOTE_RESULTS_LIMIT),
    enabled: open && debounced.length > 0,
  });
  const recentNotes = recentsQ.data?.items ?? [];

  const rows = useMemo<Row[]>(() => {
    if (!q) {
      const out: Row[] = [{ kind: "header", label: t.palette_section_suggestions }];
      for (const c of buildSuggestions(commands, recencyRef.current, SUGGESTION_LIMIT)) {
        out.push({ kind: "command", cmd: c });
      }
      if (recentNotes.length > 0) {
        out.push({ kind: "header", label: t.palette_section_recent_notes });
        for (const n of recentNotes.slice(0, RECENT_NOTES_SHOWN)) out.push({ kind: "note", note: n });
      }
      if (out.length === 1) out.push({ kind: "empty", label: t.palette_no_results });
      return out;
    }
    const out: Row[] = [];
    if (matched.length > 0) {
      out.push({ kind: "header", label: t.palette_section_commands });
      for (const c of matched) out.push({ kind: "command", cmd: c });
    }
    if (searchQ.isError) {
      out.push({ kind: "header", label: t.palette_section_notes });
      out.push({ kind: "error", label: String(searchQ.error).split("\n")[0] });
    } else {
      const notes = searchQ.data ?? [];
      if (notes.length > 0) {
        out.push({ kind: "header", label: t.palette_section_notes });
        for (const n of notes) out.push({ kind: "note", note: n });
      }
    }
    // Bridge always present under a query — a transient query can always
    // graduate into the persistent header search.
    out.push({ kind: "bridge" });
    if (out.length === 1) out.unshift({ kind: "empty", label: t.palette_no_results });
    return out;
  }, [q, matched, searchQ.data, searchQ.isError, searchQ.error, recentNotes, commands, t]);

  const selectable = rows.filter((r) => r.kind !== "header" && r.kind !== "empty");
  // Clamp so Enter can never fire a stale index after the filter narrows.
  const selIdx = Math.min(sel, Math.max(0, selectable.length - 1));

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-sel="${selIdx}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selIdx]);

  const activate = (row: Row) => {
    if (row.kind === "command") {
      recencyRef.current.record(row.cmd.id);
      try {
        localStorage.setItem(RECENCY_KEY, JSON.stringify(recencyRef.current.snapshot()));
      } catch {
        // Storage full/blocked — ranking just loses the boost.
      }
      onClose();
      void row.cmd.run();
    } else if (row.kind === "note") {
      onClose();
      setView("memos");
      select(row.note.id);
    } else if (row.kind === "bridge") {
      const qq = q;
      onClose();
      if (qq) onSearchAll(qq);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm transition-opacity duration-200 ease-out data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup className="fixed left-1/2 top-20 z-50 w-[min(560px,92vw)] -translate-x-1/2 overflow-hidden rounded-[var(--dialog-radius)] border border-line bg-surface-raised shadow-lg transition-[opacity,translate,scale] duration-200 ease-out data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0 data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0">
          <Dialog.Title className="sr-only">{t.command_palette_title}</Dialog.Title>
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <Search size={14} className="shrink-0 text-text-subtle" />
            {/* eslint-disable-next-line jsx-a11y/no-autofocus -- palette is a modal; focus must start in the input */}
            <input
              autoFocus
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls="command-palette-listbox"
              aria-autocomplete="list"
              aria-label={t.command_palette_title}
              placeholder={t.palette_placeholder}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSel(0);
              }}
              onKeyDown={(e) => {
                // Korean IME: confirm-Enter (and arrows during
                // composition) must not move/run anything.
                if (e.nativeEvent.isComposing) return;
                if (selectable.length === 0) return;
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSel((s) => Math.min(s + 1, selectable.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSel((s) => Math.max(s - 1, 0));
                } else if (e.key === "Home") {
                  e.preventDefault();
                  setSel(0);
                } else if (e.key === "End") {
                  e.preventDefault();
                  setSel(selectable.length - 1);
                } else if (e.key === "Enter") {
                  const r = selectable[selIdx];
                  if (r) {
                    e.preventDefault();
                    activate(r);
                  }
                }
              }}
              className="w-full bg-transparent py-1.5 text-sm placeholder:text-text-subtle outline-none"
            />
          </div>
          <ul
            id="command-palette-listbox"
            ref={listRef}
            role="listbox"
            aria-label={t.command_palette_title}
            className="max-h-[60vh] overflow-y-auto p-1"
          >
            {rows.map((row, i) => {
              if (row.kind === "header") {
                return (
                  <li
                    key={`h-${i}`}
                    role="presentation"
                    className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-text-subtle"
                  >
                    {row.label}
                  </li>
                );
              }
              if (row.kind === "empty") {
                return (
                  <li key={`e-${i}`} role="presentation" className="px-2 py-3 text-center text-[13px] text-text-subtle">
                    {row.label}
                  </li>
                );
              }
              if (row.kind === "error") {
                return (
                  <li key={`x-${i}`} role="presentation" className="px-2 py-2 text-center text-xs text-status-error">
                    {row.label}
                  </li>
                );
              }
              if (row.kind === "bridge") {
                const selNow = selectable.indexOf(row) === selIdx;
                return (
                  <li key="bridge">
                    <button
                      type="button"
                      role="option"
                      aria-selected={selNow}
                      data-sel={selectable.indexOf(row)}
                      onClick={() => activate(row)}
                      onMouseMove={() => setSel(selectable.indexOf(row))}
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors duration-150 ${
                        selNow ? "bg-surface-muted text-text" : "text-text-muted hover:bg-surface-muted"
                      }`}
                    >
                      <Search size={14} className="shrink-0 text-text-muted" />
                      <span className="min-w-0 flex-1 truncate">
                        {t.palette_search_all.replace("{q}", q)}
                      </span>
                      {selNow && <CornerDownLeft size={12} aria-hidden className="shrink-0 text-text-subtle" />}
                    </button>
                  </li>
                );
              }
              if (row.kind === "note") {
                const idx = selectable.indexOf(row);
                const selNow = idx === selIdx;
                return (
                  <li key={row.note.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={selNow}
                      data-sel={idx}
                      onClick={() => activate(row)}
                      onMouseMove={() => setSel(idx)}
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors duration-150 ${
                        selNow ? "bg-surface-muted text-text" : "text-text-muted hover:bg-surface-muted"
                      }`}
                    >
                      <span
                        aria-hidden
                        className="inline-block size-2 shrink-0 rounded-full"
                        style={{ background: colorForFolder(row.note.folder, folderDefs) || "var(--color-text-subtle)" }}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {row.note.title ?? t.empty_memo}
                      </span>
                      <span className="ml-auto shrink-0 text-[11px] text-text-subtle">
                        {relativeTime(row.note.updated_at, locale)}
                      </span>
                      {selNow && <CornerDownLeft size={12} aria-hidden className="shrink-0 text-text-subtle" />}
                    </button>
                  </li>
                );
              }
              // row.kind === "command"
              const idx = selectable.indexOf(row);
              const selNow = idx === selIdx;
              const Icon = ICONS[row.cmd.icon];
              return (
                <li key={row.cmd.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selNow}
                    data-sel={idx}
                    onClick={() => activate(row)}
                    onMouseMove={() => setSel(idx)}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors duration-150 ${
                      selNow ? "bg-surface-muted text-text" : "text-text-muted hover:bg-surface-muted"
                    }`}
                  >
                    <Icon size={14} className="shrink-0 text-text-muted" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{row.cmd.title}</span>
                    {row.cmd.hint ? (
                      <kbd className="ml-auto shrink-0 font-mono text-[10px] text-text-subtle">{row.cmd.hint}</kbd>
                    ) : row.cmd.count != null ? (
                      <span className="ml-auto shrink-0 text-[11px] tabular-nums text-text-subtle">{row.cmd.count}</span>
                    ) : null}
                    {selNow && <CornerDownLeft size={12} aria-hidden className="shrink-0 text-text-subtle" />}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="border-t border-line px-3 py-1.5 text-[10px] text-text-subtle">
            {t.palette_footer_hint}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

Note: `selectable.indexOf(row)` is O(n) per row but n ≤ ~20 — fine. If `bunx tsc` complains about unused `selNow` shadowing patterns or `typeof Layers` icon typing, use `type LucideIcon` from `lucide-react` instead of `typeof Layers`.

- [ ] **Step 3: Typecheck + lint the new file**

Run: `cd apps/desktop && bunx tsc --noEmit`
Expected: exit 0 (en.ts parity compile-enforced — a missing key is a hard error here).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/lib/locales/ko.ts apps/desktop/src/lib/locales/en.ts apps/desktop/src/components/CommandPalette.tsx
git commit -m "feat(desktop): CommandPalette component — ⌘K host with commands, notes, recents"
```

---

### Task 4: CardGrid wiring + SettingsMenu control + FolderPalette removal

**Files:**
- Modify: `apps/desktop/src/components/CardGrid.tsx`
- Modify: `apps/desktop/src/components/SettingsMenu.tsx:872` (Dialog.Root control)
- Delete: `apps/desktop/src/components/FolderPalette.tsx`

**Interfaces:**
- Consumes: Task 1 (`showCaptureWindow`, store flags), Task 2 (`CommandCallbacks`), Task 3 (`CommandPalette`).
- Produces: final behavior — ⌘K toggle, ⌘⇧O alias, palette-guarded existing shortcuts, folder-create effect, search-all bridge, store-controlled settings drawer.

- [ ] **Step 1: CardGrid imports**

In `apps/desktop/src/components/CardGrid.tsx`:

(a) In the api import block (lines 29-48): add `openDailyNote,` and `showCaptureWindow,` to the named imports (alphabetical-ish placement alongside the others).

(b) Replace `import { FolderPalette } from "./FolderPalette";` (line 57) with `import { CommandPalette } from "./CommandPalette";`.

(c) Add after the `useI18n` import (line 49):

```ts
import { applyTheme } from "../lib/theme";
import { todayLocalISO } from "../lib/dates";
```

(d) Add `setAppearanceConfig,` to the api named imports (it is not currently imported by CardGrid).

(e) Extend the lucide import is NOT needed — no new icons in CardGrid.

- [ ] **Step 2: Store selectors**

After the existing `useUI` selector block (near lines 74-94), add:

```ts
  const cmdPaletteOpen = useUI((s) => s.cmdPaletteOpen);
  const setCmdPaletteOpen = useUI((s) => s.setCmdPaletteOpen);
  const requestNewFolder = useUI((s) => s.requestNewFolder);
  const consumeFolderCreate = useUI((s) => s.consumeFolderCreate);
```

- [ ] **Step 3: Remove FolderPalette state; rewrite the keydown listener**

Delete `const [paletteOpen, setPaletteOpen] = useState(false);` (line 663) and its comment block (lines 661-662).

Replace the whole `useEffect` keydown listener (lines 664-715) with:

```ts
  // ⌘K command palette + friends. Session state — the palette is a
  // transient overlay, so open/close never persists.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmdOpen = useUI.getState().cmdPaletteOpen;
      // ⌘N / CtrlN — new note in current folder. Inert while the palette
      // modal is open (opening MemoDetail underneath would stack two
      // focus traps).
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "n") {
        if (cmdOpen) return;
        e.preventDefault();
        onNewNote();
        return;
      }
      // ⌘K / CtrlK — command palette toggle. ⌘⇧O stays as an alias: the
      // palette subsumed FolderPalette, and the old muscle memory keeps
      // working. Guarded while the memo dialog is open (selectedId):
      // its own key handling wins. Works in gallery too — the palette
      // mounts outside the view branches. The capture overlay lives in
      // its own window/document, so it never sees this listener.
      const key = e.key.toLowerCase();
      const wantsPalette =
        ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && key === "k") ||
        ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && key === "o");
      if (wantsPalette) {
        if (useUI.getState().selectedId) return;
        e.preventDefault();
        setCmdPaletteOpen(!useUI.getState().cmdPaletteOpen);
        return;
      }
      // ⌘↑ / Ctrl↑ — navigate up one folder (no-op in query mode or at
      // root; inert under the palette modal). Mirrors the ⌘K branch: a
      // memo dialog open (selectedId) wins; without this guard the
      // editor loses key focus to the parent-folder jump while the user
      // is reading a note.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === "ArrowUp") {
        if (useUI.getState().selectedId) return;
        if (cmdOpen) return;
        e.preventDefault();
        useUI.getState().navigateUp();
        return;
      }
      // Escape — clear the current search box only. Does NOT navigate; the
      // dialog/palette handlers manage their own Escape behaviour.
      if (e.key === "Escape") {
        if (useUI.getState().selectedId) return;
        if (cmdOpen) return;
        if (localSearch === "") return;
        e.preventDefault();
        setLocalSearch("");
        setDebounced("");
        setSearch("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onNewNote, localSearch, setSearch, setCmdPaletteOpen]);
```

- [ ] **Step 4: Update jumpToFolder + add palette callbacks**

In `jumpToFolder` (lines 727-738): replace `setPaletteOpen(false);` with `setCmdPaletteOpen(false);` and add `setCmdPaletteOpen` to its dep array.

After `jumpToFolder`, add:

```ts
  // Palette callbacks (CommandCallbacks contract, lib/paletteCommands).
  // Navigation ones mirror the sidebar/openFolder conventions exactly.
  const openToday = useCallback(() => {
    if (configQ.data?.daily?.enabled === false) return;
    openDailyNote(todayLocalISO())
      .then(({ memo, created }) => {
        setView("memos");
        select(memo.id);
        // Fresh daily note: closing it untouched discards it (Sidebar's
        // openDaily flow).
        if (created) setDraftId(memo.id, memo.body);
      })
      .catch((e) => setError(String(e).split("\n")[0]));
  }, [configQ.data, setView, select, setDraftId, setError]);

  // Bridge row: graduate the palette's transient query into the
  // persistent header search, in global query mode.
  const onSearchAll = useCallback(
    (q: string) => {
      setView("memos");
      setFavoritesOnly(false);
      setFolderFilter(null);
      setLocalSearch(q);
      setDebounced(q);
      setSearch(q);
    },
    [setView, setFavoritesOnly, setFolderFilter, setSearch],
  );

  const paletteCallbacks = useMemo(
    () => ({
      jumpToFolder,
      openCollection: (kind: "all" | "favorites") => {
        setView("memos");
        setFavoritesOnly(false);
        setFolderFilter(null);
        if (kind === "favorites") setFavoritesOnly(true);
      },
      openGallery: () => setView("gallery"),
      openToday,
      selectTag: (tag: string) => {
        // Sidebar tag convention: vault-wide intent — drop folder and
        // favorite scope, then cycle the tag in.
        setView("memos");
        setFavoritesOnly(false);
        setFolderFilter(null);
        cycleTag(tag);
      },
      setViewMode: (v: ViewMode) => {
        setView("memos");
        setNoteView(v);
      },
      toggleSidebar,
      newNote: (format: "markdown" | "html") => (format === "html" ? onNewHtmlNote() : onNewNote()),
      newFolder: () => useUI.getState().requestFolderCreate(),
      quickCapture: () => {
        void showCaptureWindow().catch((e) => setError(String(e).split("\n")[0]));
      },
      openSettings: () => useUI.getState().setSettingsOpen(true),
      // SettingsMenu's onTheme flow, verbatim: instant apply + TOML parity.
      setTheme: (v: Theme) => {
        useUI.getState().setTheme(v);
        applyTheme(v);
        void setAppearanceConfig({
          theme: v,
          show_dock_icon: configQ.data?.appearance?.show_dock_icon ?? true,
        })
          .then(() => qc.invalidateQueries({ queryKey: ["config"] }))
          .catch((e) => setError(String(e).split("\n")[0]));
      },
    }),
    [
      jumpToFolder, openToday, setView, setFavoritesOnly, setFolderFilter,
      cycleTag, setNoteView, toggleSidebar, onNewNote, onNewHtmlNote,
      setError, configQ.data, qc,
    ],
  );
```

You will also need `const cycleTag = useUI((s) => s.cycleTag);` — check the selector block: CardGrid reads `tagFilter` but not `cycleTag`; add the selector alongside Step 2's additions. Also add `import type { Theme } from "../lib/theme";` (or combine with the `applyTheme` import line: `import { applyTheme, type Theme } from "../lib/theme";`).

- [ ] **Step 5: New-folder request effect**

Add after the paletteCallbacks memo (needs `startFolderCreate`, defined later in the component — verify its definition site and place the effect AFTER it; if `startFolderCreate` is a `useCallback`, keep it in the dep array):

```ts
  // The palette's "새 폴더" lands in the main area (never in the
  // palette): consume the one-shot flag and start the inline naming
  // flow. Query mode has no definite location, so fall back to the
  // vault root first — the flag stays set and this effect re-runs once
  // folderFilter commits.
  useEffect(() => {
    if (!requestNewFolder) return;
    if (folderFilter === null) {
      setView("memos");
      setFavoritesOnly(false);
      setFolderFilter("");
      return;
    }
    consumeFolderCreate();
    startFolderCreate();
  }, [requestNewFolder, folderFilter, setView, setFavoritesOnly, setFolderFilter, consumeFolderCreate, startFolderCreate]);
```

Read `startFolderCreate`'s actual definition first; if it is a plain function (not memoized), omit it from deps and add an eslint-disable comment if the project lints deps (it does not appear to run eslint in CI — tsc only).

- [ ] **Step 6: Mount CommandPalette in both view trees; delete FolderPalette**

(a) Remove the `<FolderPalette ... />` mount (lines 1072-1078).

(b) Define once before the gallery early-return (before line 814's `if (view === "gallery")`):

```ts
  // Mounted once and included in BOTH view trees (gallery early-returns
  // its own JSX) — ⌘K works everywhere except over the memo dialog.
  const commandPalette = (
    <CommandPalette
      open={cmdPaletteOpen}
      onClose={() => setCmdPaletteOpen(false)}
      folders={folderEntries}
      folderDefs={folders}
      callbacks={paletteCallbacks}
      onSearchAll={onSearchAll}
    />
  );
```

(c) In the gallery return (lines 816-832): add `{commandPalette}` after `<MemoDetail />`.

(d) In the main return: add `{commandPalette}` where `<FolderPalette />` used to be (after `<MemoDetail />`, line 1071).

(e) `git rm apps/desktop/src/components/FolderPalette.tsx` (or `rm` + `git add -A` on that path).

- [ ] **Step 7: SettingsMenu store control**

In `apps/desktop/src/components/SettingsMenu.tsx`:

In the `SettingsMenu` component body (near line 771's selector block), add:

```ts
  const settingsOpen = useUI((s) => s.settingsOpen);
  const setSettingsOpen = useUI((s) => s.setSettingsOpen);
```

Replace `<Dialog.Root>` (line 872) with:

```tsx
    <Dialog.Root open={settingsOpen} onOpenChange={setSettingsOpen}>
```

(The gear `Dialog.Trigger` stays — Base UI triggers route through `onOpenChange` on a controlled root.)

- [ ] **Step 8: Typecheck, test, build**

Run:
```bash
cd apps/desktop && bunx tsc --noEmit && bun test && bun run build
```
Expected: tsc exit 0, all tests pass, vite build succeeds. Also grep-verify no FolderPalette references remain: `grep -rn "FolderPalette" apps/desktop/src` → no matches.

- [ ] **Step 9: Commit**

```bash
git add -A apps/desktop/src
git commit -m "feat(desktop): wire ⌘K command palette; FolderPalette folded in

- ⌘K toggles the palette; ⌘⇧O kept as an alias (subsumed FolderPalette removed)
- existing ⌘N/⌘↑/Esc branches inert while the palette modal is open
- palette new-folder lands in the main area via a one-shot store flag
- settings drawer store-controlled so the palette can open it
- bridge row graduates a palette query into the persistent header search"
```

---

### Task 5: Verification (controller-owned — not dispatched)

- `cd apps/desktop && bunx tsc --noEmit && bun test && bun run build` — all green.
- `cargo check -p oximemo-desktop` clean.
- Browser run of the vite dev server with `window.__TAURI_INTERNALS__` mocked (tauri-v2-pitfalls §5): ⌘K opens/closes, empty-state shows 제안 + 최근 노트, typing filters commands, notes section renders BM25 rows, ⏎ runs navigation (view switches), ⌘⇧O alias opens, gallery ⌘K works, MemoDetail-open guard inert, footer hint visible. Screenshot evidence.
- Final whole-branch review on the merge-base diff.
