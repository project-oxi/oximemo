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
  /** Transient neutral toast message. `null` = none. */
  toast: string | null;
  setToast: (msg: string | null) => void;
  /** Id of a note minted by "new note" this session; discarded on close
   * while still empty so no orphan notes accumulate. */
  draftId: string | null;
  setDraftId: (id: string | null) => void;
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
  toast: null,
  setToast: (msg) => set({ toast: msg }),
  draftId: null,
  setDraftId: (id) => set({ draftId: id }),
}));
