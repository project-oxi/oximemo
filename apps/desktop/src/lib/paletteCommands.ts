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
import { dict as ko } from "./locales/ko";
import type { DictKey } from "./collectionCatalog";
import type { Theme } from "./theme";
import { folderDisplayName } from "./folders";
import type { FolderEntry, ViewMode } from "./types";

/** Icon name — resolved to a lucide component by CommandPalette.tsx. */
export type PaletteIcon =
  | "layers" | "star" | "images" | "archive" | "calendar" | "folder"
  | "hash" | "grid" | "list" | "timeline" | "graph" | "sidebar"
  | "note-md" | "note-html" | "folder-plus" | "zap" | "settings"
  | "sun" | "moon" | "monitor" | "library" | "table";

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
  /** Open the review queue in a `[review]`-declared folder (§7.3). Absent
   *  when no folder declares one — the catalog is state-driven. */
  openReviewQueue?: (folder: string) => void;
  /** Rollover command (spec §7): carry yesterday's not-done daily
   *  tasks into today, with a confirm toast + guarded undo. Present
   *  only when daily notes are enabled. */
  rolloverTasks?: () => void;
  /** New folder preloaded with the knowledge preset (§6.3). */
  newKnowledgeFolder?: () => void;
  /** Open settings on the collections pane (⌘K 컬렉션 관리). */
  openCollectionsSettings: () => void;
  /** Query views (spec §5): create + open a new .query; open a listed one. */
  newQuery?: () => void;
  openQuery?: (path: string) => void;
  openSettings: () => void;
  /** ⌘K space 전환 — opens the sidebar picker popover. */
  openSpacePicker?: () => void;
  /** ⌘K space 생성 — opens the picker straight into name input. */
  createSpace?: () => void;
  setTheme: (t: Theme) => void;
}

export interface CommandDeps {
  locale: "ko" | "en";
  noteView: ViewMode;
  theme: Theme;
  folders: FolderEntry[];
  tags: [string, number][];
  dailyEnabled: boolean;
  /** The daily folder's physical path (config `[daily] folder`). */
  dailyFolder?: string;
  /** Folders whose SCHEMA.toml declares [review] — drives the review
   *  command's existence (design §7.3: the catalog is state-driven). */
  reviewFolders?: string[];
  /** Saved query collections (spec §5 쿼리 열기). */
  bases?: { path: string; name: string }[];
  callbacks: CommandCallbacks;
}

const tr = (locale: "ko" | "en", key: DictKey): string => (locale === "ko" ? ko[key] : en[key]) as string;
/** Display title in `locale`, alias in the other locale. */
const pair = (locale: "ko" | "en", key: DictKey): { title: string; alias: string } => {
  const dict = locale === "ko" ? ko : en;
  const other = locale === "ko" ? en : ko;
  return { title: dict[key], alias: other[key] };
};


const VIEW_KEYS = {
  grid: "palette_view_grid",
  list: "palette_view_list",
  timeline: "palette_view_timeline",
  graph: "palette_view_graph",
  table: "palette_view_table",
  shelf: "palette_view_shelf",
  calendar: "palette_view_calendar",
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
  const { locale, noteView, theme, folders, tags, dailyEnabled, callbacks, bases } = deps;
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
  // Folders — localized display title for the system folders (macOS
  // ~/Desktop → "데스크톱" convention), physical path in the alias so
  // both spellings match. Root ("") is never listed: nav.vault_root
  // covers it.
  const dict = locale === "ko" ? ko : en;
  for (const folder of folders) {
    if (folder.path === "") continue;
    const display = folderDisplayName(folder.path, dict, deps.dailyFolder);
    add(
      `folder:${folder.path}`,
      "folder",
      display,
      `${display} ${folder.path}`,
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
  // Review queue: one command per `[review]`-declaring folder, plus the
  // unified first entry when several exist (design §7.3). The commands
  // exist only when the state does — no folder-name special cases.
  for (const folder of deps.reviewFolders ?? []) {
    const r = pair(locale, "palette_review_queue");
    add(
      `review:${folder}`,
      "zap",
      deps.reviewFolders && deps.reviewFolders.length > 1
        ? `${r.title} — ${folder}`
        : r.title,
      r.alias,
      "action",
      () => callbacks.openReviewQueue?.(folder),
    );
  }
  if (callbacks.newKnowledgeFolder) {
    const k = pair(locale, "palette_knowledge_folder");
    add("action.new_knowledge_folder", "folder-plus", k.title, k.alias, "action", callbacks.newKnowledgeFolder);
  }
  if (callbacks.openCollectionsSettings) {
    const c = pair(locale, "palette_manage_collections");
    add("action.manage_collections", "library", c.title, c.alias, "action", callbacks.openCollectionsSettings);
  }

  // View-mode switches exclude the active mode (no-op noise).
  for (const mode of ["grid", "list", "table", "timeline", "graph", "shelf", "calendar"] as ViewMode[]) {
    if (mode === noteView) continue;
    const k = pair(locale, VIEW_KEYS[mode]);
    const icon =
      mode === "grid" ? "grid" : mode === "list" ? "list" : mode === "shelf" ? "library"
      : mode === "table" ? "table" : mode;
    add(`view.${mode}`, icon, k.title, k.alias, "view", () => callbacks.setViewMode(mode));
  }
  const sb = pair(locale, "palette_sidebar_toggle");
  add("view.sidebar", "sidebar", sb.title, sb.alias, "view", callbacks.toggleSidebar);

  // Query collections (spec §5 creation paths).
  if (callbacks.newQuery) {
    const nq = pair(locale, "query_new");
    add("action.new_query", "table", nq.title, nq.alias, "action", callbacks.newQuery);
  }
  if (callbacks.openQuery) {
    for (const b of bases ?? []) {
      const alias = locale === "ko" ? b.name : b.name;
      add(`query:${b.path}`, "table", `${b.name}`, alias, "nav", () => callbacks.openQuery?.(b.path));
    }
  }

  const md = pair(locale, "new_note_md");
  add("action.new_md", "note-md", md.title, md.alias, "action", () => callbacks.newNote("markdown"), { hint: "⌘N" });
  const html = pair(locale, "new_note_html");
  add("action.new_html", "note-html", html.title, html.alias, "action", () => callbacks.newNote("html"));
  // Rollover (spec §7): yesterday's not-done daily tasks → today.
  // Daily-gated like nav.today; the callback owns the confirm/undo
  // toast flow (lib/taskRollover).
  if (dailyEnabled && callbacks.rolloverTasks) {
    const ro = pair(locale, "task_rollover");
    add("task.rollover", "calendar", ro.title, ro.alias, "action", callbacks.rolloverTasks);
  }
  const nf = pair(locale, "folder_new");
  add("action.new_folder", "folder-plus", nf.title, nf.alias, "action", callbacks.newFolder);
  const st = pair(locale, "settings");
  add("action.settings", "settings", st.title, st.alias, "action", callbacks.openSettings);
  if (callbacks.openSpacePicker) {
    const sp = pair(locale, "palette_space_switch");
    add("action.space_switch", "layers", sp.title, sp.alias, "action", callbacks.openSpacePicker);
  }
  if (callbacks.createSpace) {
    const sn = pair(locale, "palette_space_new");
    add("action.space_new", "folder-plus", sn.title, sn.alias, "action", callbacks.createSpace);
  }
  const qc = pair(locale, "palette_quick_capture");
  add("action.capture", "zap", qc.title, qc.alias, "action", callbacks.quickCapture, { hint: "⌘⇧N" });
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

/** Home state: recency order first (at most 5 entries — spec), curated
 * fill to `limit`, deduped, capped. */
export function buildSuggestions(
  commands: PaletteCommand[],
  recency: RecencyLog,
  limit = 6,
): PaletteCommand[] {
  const byId = new Map(commands.map((c) => [c.id, c]));
  const out: PaletteCommand[] = [];
  // Spec: recency contributes at most 5 entries so curated always
  // gets at least one slot (with the default limit of 6).
  const recencyMax = Math.min(limit, 5);
  for (const id of recency.snapshot()) {
    if (out.length >= recencyMax) break;
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
