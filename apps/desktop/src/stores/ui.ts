/** UI state store (Zustand). Server data lives in TanStack Query; this
 *  holds only ephemeral UI state per §7.4. */
import { create } from "zustand";
import { loadTheme, type Theme } from "../lib/theme";

export type TagState = "off" | "in" | "out";

interface UIState {
  search: string;
  setSearch: (s: string) => void;
  /** Active top-level view. Gallery shows all images across memos. */
  view: "memos" | "gallery";
  setView: (v: "memos" | "gallery") => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  selectedId: string | null;
  select: (id: string | null) => void;
  /** tag -> filter state (3-state cycle). Absent = "off". */
  tagFilter: Record<string, TagState>;
  cycleTag: (tag: string) => void;
  clearTagFilter: () => void;
  /** AND over the include set when true, OR when false. */
  matchAll: boolean;
  toggleMatchAll: () => void;
  /** Selected category. `null` = all categories. */
  categoryFilter: string | null;
  setCategory: (c: string | null) => void;
  clearCategoryFilter: () => void;
  favoritesOnly: boolean;
  setFavoritesOnly: (b: boolean) => void;
  /** Sidebar collapsed? Persisted to localStorage. */
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  /** Transient error message surfaced as a toast (H4). `null` = none. */
  error: string | null;
  setError: (msg: string | null) => void;
  /** Transient neutral toast message. `null` = none. */
  toast: string | null;
  setToast: (msg: string | null) => void;
  /** Id of a note minted by "new memo" this session; discarded on close
   * while still empty so no orphan memos accumulate. */
  draftId: string | null;
  setDraftId: (id: string | null) => void;
}

const COLLAPSED_KEY = "oximemo.sidebarCollapsed";
function loadCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(COLLAPSED_KEY) === "1";
}

export const useUI = create<UIState>((set) => ({
  search: "",
  setSearch: (s) => set({ search: s }),
  view: "memos",
  setView: (v) => set({ view: v }),
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
  clearTagFilter: () => set({ tagFilter: {} }),
  matchAll: true,
  toggleMatchAll: () => set((s) => ({ matchAll: !s.matchAll })),
  categoryFilter: null,
  setCategory: (c) => set({ categoryFilter: c }),
  clearCategoryFilter: () => set({ categoryFilter: null }),
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
  setToast: (msg) => set({ toast: msg }),
  draftId: null,
  setDraftId: (id) => set({ draftId: id }),
}));
