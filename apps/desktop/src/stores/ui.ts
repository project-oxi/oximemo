/** UI state store (Zustand). Server data lives in TanStack Query; this
 *  holds only ephemeral UI state per §7.4. */
import { create } from "zustand";
import type { Locale } from "../lib/i18n";
import type { Theme } from "../lib/theme";

interface UIState {
  search: string;
  setSearch: (s: string) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  locale: Locale | null;
  setLocale: (l: Locale) => void;
  selectedId: string | null;
  select: (id: string | null) => void;
}

export const useUI = create<UIState>((set) => ({
  search: "",
  setSearch: (s) => set({ search: s }),
  theme: "system",
  setTheme: (t) => set({ theme: t }),
  locale: null,
  setLocale: (l) => set({ locale: l }),
  selectedId: null,
  select: (id) => set({ selectedId: id }),
}));
