/** UI state store (Zustand). Server data lives in TanStack Query; this
 * holds only ephemeral UI state per §7.4. */
import { create } from "zustand";
import type { ActiveMemoRef, MemoRef, TurnResult } from "../lib/api";
import { loadTheme, type Theme } from "../lib/theme";
import type { MemoSummary, ViewMode } from "../lib/types";

/** Exact payload of a sent turn — kept on error entries so "retry"
 * resends the identical message+context. */
export type CopilotRetryPayload = {
  message: string;
  memo: ActiveMemoRef | null;
  referenced: MemoRef[];
};

/** One conversation row. `attached` mirrors the composer's context tray at
 * send time so the history explains itself (spec rev 2026-08-24 §3.2). */
export type CopilotEntry =
  | {
      role: "user";
      text: string;
      at: number;
      attached: { active: MemoRef | null; selection: string | null; memos: MemoRef[] };
    }
  | { role: "agent"; result: TurnResult; at: number }
  | { role: "error"; text: string; at: number; retry: CopilotRetryPayload | null };


export type TagState = "off" | "in" | "out";

/** Inline action rendered right of a toast message (e.g. the undo
 * button after a folder delete). */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

/** Browse location (query views spec §5). Exactly one is active; the
 * legacy `folderFilter`/`favoritesOnly` fields are write-through mirrors
 * kept so listing IPC and query keys keep their shape — every mutation
 * goes through `applyLocation`, never the mirrors directly.
 * `{ kind: "base" }` is a full-screen query collection; `inline` carries
 * raw YAML (fenced-block 「전체 열기」, Plan E). */
export type Location =
  | { kind: "folder"; path: string } // "" = vault root
  | { kind: "all" }
  | { kind: "favorites" }
  | { kind: "base"; source: { path: string } | { inline: string } };

interface UIState {
  search: string;
  setSearch: (s: string) => void;
  /** Active top-level view. Gallery shows all images across notes. */
  view: "memos" | "gallery";
  setView: (v: "memos" | "gallery") => void;
  /** Per-folder view mode override (folder sidebar view switcher). */
  noteView: ViewMode;
  setNoteView: (v: ViewMode) => void;
  /** Search scope. "folder" limits results to the active folder; "all"
   * searches the whole vault. */
  searchScope: "folder" | "all";
  setSearchScope: (s: "folder" | "all") => void;
  /** Step up one folder in the browse tree. No-op in query mode or at root. */
  navigateUp: () => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  selectedId: string | null;
  select: (id: string | null) => void;
  /** tag -> filter state (3-state cycle). Absent = "off". */
  tagFilter: Record<string, TagState>;
  cycleTag: (tag: string) => void;
  /** Direct state set (chip context menu); "off" removes the entry. */
  setTagState: (tag: string, state: TagState) => void;
  clearTagFilter: () => void;
  /** AND over the include set when true, OR when false. */
  matchAll: boolean;
  toggleMatchAll: () => void;
  /** Active folder. `null` = query mode (smart collection, "모든 노트");
   * `""` = vault root browse; other strings = folder browse. Derived from
   * `location` — write through the location actions only. */
  folderFilter: string | null;
  setFolderFilter: (f: string | null) => void;
  clearFolderFilter: () => void;
  favoritesOnly: boolean;
  setFavoritesOnly: (b: boolean) => void;
  /** The single browse location (query views spec §5). */
  location: Location;
  /** Previous non-base location — ⌘↑ exits a base back to it. */
  lastNonBaseLocation: Location;
  openBase: (source: { path: string } | { inline: string }) => void;
  exitBase: () => void;
  /** Sidebar collapsed? Persisted to localStorage. */
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  /** Transient error message surfaced as a toast (H4). `null` = none. */
  error: string | null;
  setError: (msg: string | null) => void;
  /** Transient neutral toast. `null` = none. `action` renders an inline
   * button (e.g. 실행 취소) that outlives the 2.6s auto-dismiss a bit
   * longer so it is actually clickable. */
  toast: { msg: string; action?: ToastAction } | null;
  setToast: (msg: string | null, action?: ToastAction) => void;
  /** Id of a note minted this session ("new memo", fresh daily note);
   * discarded on close while still pristine so no orphan notes
   * accumulate. */
  draftId: string | null;
  /** Body the draft was born with (empty for "new memo", template for a
   * fresh daily note). Close discards the draft when the body still
   * equals this (or is blank). `null` pairs with a stale draftId. */
  draftPristine: string | null;
  setDraftId: (id: string | null, pristine?: string) => void;
  /** Note currently being HTML5-dragged (T14). Set by the drag source's
   * dragstart, cleared on dragend; drop targets read it for M16
   * own-folder suppression and the grid's edge auto-scroll gates on it. */
  draggingNote: MemoSummary | null;
  setDraggingNote: (m: MemoSummary | null) => void;
  /** Folder path currently being HTML5-dragged (folder moves). Set by
   * the drag source's dragstart, cleared on dragend; drop targets read
   * it for cycle/parent no-op suppression — see useFolderDrop. */
  draggingFolder: string | null;
  setDraggingFolder: (p: string | null) => void;
  /** Pin-reorder drag (⠿ handle): the dragged pin's path. */
  draggingPin: string | null;
  setDraggingPin: (p: string | null) => void;
  /** Available update version surfaced on the settings gear, or null. */
  updateAvailable: string | null;
  setUpdateAvailable: (v: string | null) => void;
  /** ⌘K command palette open? Transient overlay state. */
  cmdPaletteOpen: boolean;
  setCmdPaletteOpen: (b: boolean) => void;
  /** Settings drawer open — store-owned so the palette (and the gear)
   * share one source of truth. */
  settingsOpen: boolean;
  setSettingsOpen: (b: boolean) => void;
  /** Task quick-add spotlight (⌘⇧T, spec §9) open? Transient overlay
   *  state — a minimal single-line input routed by `capture_target`. */
  quickAddOpen: boolean;
  setQuickAddOpen: (b: boolean) => void;
  /** Copilot floating window open (⌘⇧C / FAB). Transient. */
  copilotOpen: boolean;
  setCopilotOpen: (b: boolean) => void;
  /** Text currently selected in the note editor, paired with the memo it
   * belongs to. Synced by the editor's CM6 update listener; the copilot
   * panel folds it into the turn context (Claude-desktop style). */
  copilotSelection: { memoId: string; text: string } | null;
  setCopilotSelection: (s: { memoId: string; text: string } | null) => void;
  /** Conversation survives panel close/reopen (in-memory only — responses
   * can carry vault text; never persisted to localStorage). Reset by
   * agent change and "new chat". */
  /** Agent the current conversation belongs to (spec §15 — session ids
   * are not portable across agents). Compare-on-change, not mount-time. */
  copilotAgent: string;
  copilotEntries: CopilotEntry[];
  setCopilotEntries: (es: CopilotEntry[] | ((prev: CopilotEntry[]) => CopilotEntry[])) => void;
  copilotSession: string | null;
  setCopilotSession: (s: string | null) => void;
  /** Per-turn model override (omp); null = agent default. */
  copilotModel: string | null;
  setCopilotModel: (m: string | null) => void;
  copilotBusy: boolean;
  setCopilotBusy: (b: boolean) => void;
  /** Turn start epoch ms; drives the elapsed timer across remounts. */
  copilotStartedAt: number | null;
  setCopilotStartedAt: (t: number | null) => void;
  resetCopilotChat: () => void;
  requestFolderCreate: () => void;
  /** One-shot request from the palette: create a folder in the main
   * area. CardGrid consumes it; query mode first falls back to the
   * vault root (creation never lands in an ambiguous location). */
  requestNewFolder: boolean;
  /** One-shot tab request: opens settings focused on a pane (⌘K
   *  "컬렉션 관리" lands on the collections pane). SettingsMenu
   *  consumes it on open and clears it. */
  settingsTab: string | null;
  setSettingsTab: (tab: string | null) => void;
  /** Space picker popover open (sidebar header + ⌘K entry share it). */
  spacePickerOpen: boolean;
  setSpacePickerOpen: (b: boolean) => void;
  /** One-shot: open the picker straight into name-input mode. */
  spacePickerCreate: boolean;
  requestSpaceCreate: () => void;
  consumeSpaceCreate: () => void;
  /** Review-queue mode for the current folder (the badge bar button,
   * ⌘K, and the collections pane all toggle it). Folder changes
   * reset it in CardGrid. */
  reviewMode: boolean;
  setReviewMode: (b: boolean) => void;
  consumeFolderCreate: () => void;
  /** Task-line scroll target queued by `openTask`. When a task link
   * lands on a memo, the editor needs to scroll to the
   * (post-hash-repair) line once it has mounted — but the hash
   * resolution is async, so the anchor is stored here and consumed by
   * MemoDetail's mount effect. `null` = nothing pending. */
  pendingTaskAnchor: { memoId: string; line: number } | null;
  setTaskAnchor: (a: { memoId: string; line: number } | null) => void;
  /** Returns the queued anchor's line and clears it — but only when the
   * caller's memoId matches. A mismatched consume leaves the anchor
   * intact: the note being opened may have changed between the queue
   * and the consume, and we must not let MemoDetail B steal MemoDetail
   * A's scroll target. */
  consumeTaskAnchor: (memoId: string) => number | null;
}

const COLLAPSED_KEY = "oximemo.sidebarCollapsed";
const QUERY_VIEW_KEY = "oximemo.queryView";
const CALENDAR_FIELD_KEY = "oximemo.calendarField";

function loadCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(COLLAPSED_KEY) === "1";
}

/** Persisted view mode for the query-mode ("모든 노트") smart collection.
 * Folder browse reads/writes the per-folder pin from the backend config
 * instead; this only covers the folder-less query case. */
export function loadQueryView(): ViewMode {
  if (typeof window === "undefined") return "grid";
  const v = window.localStorage.getItem(QUERY_VIEW_KEY);
  // table is available in query mode: the vault-wide cross-schema table is
  // the point of per-row schema selection (query views spec §4); calendar
  // mirrors the folder ladder in query mode.
  return v === "list" || v === "timeline" || v === "graph" || v === "table" || v === "calendar"
    ? v
    : "grid";
}

/** Single writer for the location trio: `location` is authoritative;
 * `folderFilter`/`favoritesOnly` are write-through mirrors so listing
 * IPC and query keys keep their shape (spec §5 cutover rule). */
function applyLocation(set: (partial: Partial<UIState>) => void, loc: Location) {
  set({
    location: loc,
    folderFilter: loc.kind === "folder" ? loc.path : null,
    favoritesOnly: loc.kind === "favorites",
  });
}

/** Persisted calendar date-field override for the query-mode smart
 * collection. Folder browse reads/writes the per-folder pin from the
 * backend config (FolderDef.calendar_date_field) instead; this only
 * covers the folder-less query case. Defaults to `"created_at"` — same
 * default as the FolderDef branch — when no value has been persisted yet. */
export function loadCalendarFieldQuery(): string {
  if (typeof window === "undefined") return "created_at";
  return window.localStorage.getItem(CALENDAR_FIELD_KEY) ?? "created_at";
}

/** Persist the calendar date-field override for query mode. Folder mode
 * persists via `setFolderCalendarField` (backend config) and never
 * touches this key. */
export function saveCalendarFieldQuery(value: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(CALENDAR_FIELD_KEY, value);
}

export const useUI = create<UIState>((set) => ({
  search: "",
  setSearch: (s) => {
    // Starting a search first exits a base (spec §5) — the base's own
    // filter model is the query surface there.
    if (s !== "" && useUI.getState().location.kind === "base")
      useUI.getState().exitBase();
    set({ search: s });
  },
  view: "memos",
  setView: (v) => set({ view: v }),
  // Boot in grid — the per-folder view pin (backend config) and the
  // query-mode view preference are loaded lazily by the effect below
  // (folderFilter === null branch) and by the per-folder query under
  // folder browse. Initialising from loadQueryView() here would leak
  // the query-mode preference into root browse on fresh start (H9
  // scope violation — the smart collection must not impose its view
  // on every folder).
  noteView: "grid",
  setNoteView: (v) => {
    set({ noteView: v });
    if (typeof window !== "undefined" && useUI.getState().folderFilter === null) {
      window.localStorage.setItem(QUERY_VIEW_KEY, v);
    }
  },
  searchScope: "folder",
  setSearchScope: (s) => set({ searchScope: s }),
  navigateUp: () => {
    const { location } = useUI.getState();
    // A base exits to the recorded previous non-base location (spec §5).
    if (location.kind === "base") return useUI.getState().exitBase();
    // Query mode (favorites/all-notes) steps INTO root browse so ⌘↑ is
    // always an escape hatch to top-level browsing; at root it's a no-op.
    if (location.kind === "all" || location.kind === "favorites") {
      applyLocation(set, { kind: "folder", path: "" });
      return;
    }
    if (location.path === "") return;
    const next = location.path.includes("/")
      ? location.path.slice(0, location.path.lastIndexOf("/"))
      : "";
    applyLocation(set, { kind: "folder", path: next });
  },
  theme: loadTheme(),
  setTheme: (t) => set({ theme: t }),
  selectedId: null,
  select: (id) => set({ selectedId: id }),
  tagFilter: {},
  cycleTag: (tag) =>
    set((s) => {
      const cur = s.tagFilter[tag] ?? "off";
      const next = cur === "off" ? "in" : cur === "in" ? "out" : "off";
      const tf = { ...s.tagFilter };
      if (next === "off") delete tf[tag];
      else tf[tag] = next;
      return { tagFilter: tf };
    }),
  setTagState: (tag, state) =>
    set((s) => {
      const tf = { ...s.tagFilter };
      if (state === "off") delete tf[tag];
      else tf[tag] = state;
      return { tagFilter: tf };
    }),
  clearTagFilter: () => set({ tagFilter: {} }),
  matchAll: true,
  toggleMatchAll: () => set((s) => ({ matchAll: !s.matchAll })),
  /** Mirrors maintained by applyLocation — see the Location doc. */
  location: { kind: "folder", path: "" },
  lastNonBaseLocation: { kind: "folder", path: "" },
  openBase: (source) => {
    const { location } = useUI.getState();
    if (location.kind !== "base")
      set({ lastNonBaseLocation: location });
    // Entering a base clears search; filtering happens in the base (§5).
    applyLocation(set, { kind: "base", source });
    set({ search: "" });
  },
  exitBase: () => {
    const { lastNonBaseLocation } = useUI.getState();
    applyLocation(set, lastNonBaseLocation);
  },
  folderFilter: "" as string | null,
  setFolderFilter: (f) => applyLocation(set, f === null ? { kind: "all" } : { kind: "folder", path: f }),
  clearFolderFilter: () => applyLocation(set, { kind: "all" }),
  favoritesOnly: false,
  setFavoritesOnly: (b) =>
    applyLocation(set, b ? { kind: "favorites" } : { kind: "all" }),
  sidebarCollapsed: loadCollapsed(),
  toggleSidebar: () =>
    set((s) => {
      const v = !s.sidebarCollapsed;
      if (typeof window !== "undefined")
        window.localStorage.setItem(COLLAPSED_KEY, v ? "1" : "0");
      return { sidebarCollapsed: v };
    }),
  error: null,
  setError: (msg) => set({ error: msg }),
  toast: null,
  setToast: (msg, action) => set({ toast: msg === null ? null : { msg, action } }),
  draftId: null,
  draftPristine: null,
  setDraftId: (id, pristine) =>
    set({ draftId: id, draftPristine: id === null ? null : pristine ?? "" }),
  copilotEntries: [],
  setCopilotEntries: (es) =>
    set((s) => ({ copilotEntries: typeof es === "function" ? es(s.copilotEntries) : es })),
  copilotSession: null,
  setCopilotSession: (s) => set({ copilotSession: s }),
  copilotModel: null,
  setCopilotModel: (m) => set({ copilotModel: m }),
  copilotBusy: false,
  setCopilotBusy: (b) => set({ copilotBusy: b }),
  copilotAgent: "",
  copilotStartedAt: null,
  setCopilotStartedAt: (t) => set({ copilotStartedAt: t }),
  resetCopilotChat: () =>
    set({
      copilotEntries: [],
      copilotSession: null,
      copilotModel: null,
      copilotBusy: false,
      copilotStartedAt: null,
    }),
  draggingNote: null,
  setDraggingNote: (m) => set({ draggingNote: m }),
  draggingFolder: null,
  setDraggingFolder: (p) => set({ draggingFolder: p }),
  setDraggingPin: (p) => set({ draggingPin: p }),
  draggingPin: null,
  updateAvailable: null,
  setUpdateAvailable: (v) => set({ updateAvailable: v }),
  cmdPaletteOpen: false,
  setCmdPaletteOpen: (b) => set({ cmdPaletteOpen: b }),
  settingsOpen: false,
  setSettingsOpen: (b) => set({ settingsOpen: b }),
  quickAddOpen: false,
  setQuickAddOpen: (b) => set({ quickAddOpen: b }),
  reviewMode: false,
  setReviewMode: (b) => set({ reviewMode: b }),
  copilotOpen: false,
  setCopilotOpen: (b) => set({ copilotOpen: b }),
  copilotSelection: null,
  setCopilotSelection: (s) => set({ copilotSelection: s }),
  /** One-shot settings tab request — consumed by SettingsMenu on open
   *  (⌘K 컬렉션 관리 → collections pane). */
  spacePickerOpen: false,
  setSpacePickerOpen: (b) => set({ spacePickerOpen: b }),
  spacePickerCreate: false,
  requestSpaceCreate: () => set({ spacePickerOpen: true, spacePickerCreate: true }),
  consumeSpaceCreate: () => set({ spacePickerCreate: false }),
  settingsTab: null,
  setSettingsTab: (tab) => set({ settingsTab: tab }),
  pendingTaskAnchor: null,
  setTaskAnchor: (a) => set({ pendingTaskAnchor: a }),
  consumeTaskAnchor: (memoId) => {
    let resolved: number | null = null;
    set((s) => {
      const cur = s.pendingTaskAnchor;
      if (cur && cur.memoId === memoId) {
        resolved = cur.line;
        return { pendingTaskAnchor: null };
      }
      return {};
    });
    return resolved;
  },
  requestNewFolder: false,
  requestFolderCreate: () => set({ requestNewFolder: true }),
  consumeFolderCreate: () => set({ requestNewFolder: false }),
}));
