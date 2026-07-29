/** UI state store (Zustand). Server data lives in TanStack Query; this
 *  holds only ephemeral UI state per §7.4. */
import { create } from "zustand";
import type { Theme } from "../lib/theme";

interface UIState {
  search: string;
  setSearch: (s: string) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  selectedId: string | null;
  select: (id: string | null) => void;
  activeTag: string | null;
  setActiveTag: (t: string | null) => void;
  pinnedOnly: boolean;
  setPinnedOnly: (b: boolean) => void;
  /** Transient error message surfaced as a toast (H4). `null` = none. */
  error: string | null;
  setError: (msg: string | null) => void;
}

export const useUI = create<UIState>((set) => ({
  search: "",
  setSearch: (s) => set({ search: s }),
  theme: "system",
  setTheme: (t) => set({ theme: t }),
  selectedId: null,
  select: (id) => set({ selectedId: id }),
  activeTag: null,
  setActiveTag: (t) => set({ activeTag: t }),
  pinnedOnly: false,
  setPinnedOnly: (b) => set({ pinnedOnly: b }),
  error: null,
  setError: (msg) => set({ error: msg }),
}));
