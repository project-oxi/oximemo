/** UI state store (Zustand). Server data lives in TanStack Query; this
 *  holds only ephemeral UI state per §7.4. */
import { create } from "zustand";
import { loadTheme, type Theme } from "../lib/theme";
import type { MemoSummary, ViewMode } from "../lib/types";

export type TagState = "off" | "in" | "out";

/** Inline action rendered right of a toast message (e.g. the undo
 * button after a folder delete). */
export interface ToastAction {
  label: string;
  onClick: () => void;
}
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
   * `""` = vault root browse; other strings = folder browse. */
  folderFilter: string | null;
  setFolderFilter: (f: string | null) => void;
  clearFolderFilter: () => void;
  favoritesOnly: boolean;
  setFavoritesOnly: (b: boolean) => void;
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
  /** Available update version surfaced on the settings gear, or null. */
  updateAvailable: string | null;
  setUpdateAvailable: (v: string | null) => void;
}

const COLLAPSED_KEY = "oximemo.sidebarCollapsed";
const QUERY_VIEW_KEY = "oximemo.queryView";

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
  return v === "list" || v === "timeline" || v === "graph" ? v : "grid";
}

export const useUI = create<UIState>((set) => ({
  search: "",
  setSearch: (s) => set({ search: s }),
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
    const { folderFilter: cur, favoritesOnly } = useUI.getState();
    // Query mode (favorites/all-notes) steps INTO root browse so ⌘↑ is
    // always an escape hatch to top-level browsing; at root it's a no-op.
    if (cur === null) {
      set({ favoritesOnly: false, folderFilter: "" });
      return;
    }
    if (favoritesOnly) set({ favoritesOnly: false });
    if (cur === "") return;
    const next = cur.includes("/") ? cur.slice(0, cur.lastIndexOf("/")) : "";
    set({ folderFilter: next });
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
  /** `null` = query mode; `""` = vault root browse; path = folder browse. */
  folderFilter: "" as string | null,
  setFolderFilter: (f) => set({ folderFilter: f }),
  clearFolderFilter: () => set({ folderFilter: null }),
  favoritesOnly: false,
  setFavoritesOnly: (b) => set({ favoritesOnly: b }),
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
  draggingNote: null,
  setDraggingNote: (m) => set({ draggingNote: m }),
  draggingFolder: null,
  setDraggingFolder: (p) => set({ draggingFolder: p }),
  updateAvailable: null,
  setUpdateAvailable: (v) => set({ updateAvailable: v }),
}));
