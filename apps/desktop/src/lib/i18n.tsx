/**
 * Minimal i18n: a small custom hook over plain dictionaries.
 *
 * Two languages per the design (Korean, English), chosen explicitly. No
 * plural/gender forms yet — the surface is tiny. Adding more locales is a
 * matter of dropping a new module into the union below.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { dict as ko } from "./locales/ko";
import { dict as en } from "./locales/en";
import { invoke } from "./tauri";

type KoDict = typeof ko;
export type Dict = KoDict;
export type Locale = "ko" | "en";

const ALL: Record<Locale, Record<string, string>> = { ko, en };

const STORAGE_KEY = "oximemo.locale";

type Ctx = {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: Dict;
};
export type I18nContextValue = Ctx;

const I18nContext = createContext<Ctx | null>(null);

function detectInitial(): Locale {
  if (typeof window === "undefined") return "ko";
  const saved = window.localStorage.getItem(STORAGE_KEY);
  if (saved === "ko" || saved === "en") return saved;
  const nav = navigator.language;
  if (nav.toLowerCase().startsWith("ko")) return "ko";
  return "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(detectInitial);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, locale);
    document.documentElement.lang = locale;
    void invoke("set_menu_locale", { locale }).catch(() => {});
  }, [locale]);

  const t = ALL[locale] as unknown as Dict;
  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>
  );
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside <I18nProvider>");
  return ctx;
}
