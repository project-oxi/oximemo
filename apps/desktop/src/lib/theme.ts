/**
 * Theme: respects the OS preference by default, with an explicit override.
 * Applies the `dark` class on `<html>` based on the resolved mode.
 */
export type Theme = "system" | "light" | "dark";

const STORAGE_KEY = "oxinot.theme";

function resolve(theme: Theme): "light" | "dark" {
  if (theme === "system") {
    if (typeof window === "undefined") return "light";
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return theme;
}

export function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  const mode = resolve(theme);
  document.documentElement.classList.toggle("dark", mode === "dark");
}

export function loadTheme(): Theme {
  if (typeof window === "undefined") return "system";
  const v = window.localStorage.getItem(STORAGE_KEY);
  if (v === "light" || v === "dark" || v === "system") return v;
  return "system";
}

export function saveTheme(t: Theme) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, t);
}
