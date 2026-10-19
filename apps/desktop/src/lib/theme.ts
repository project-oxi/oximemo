/**
 * Theme: respects the OS preference by default, with an explicit override.
 * Applies the `dark` class on `<html>` based on the resolved mode.
 */
export type Theme = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "oxi-theme";

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
  document.documentElement.style.colorScheme = mode;
}

/** One observer per window; manual choices never track OS changes. */
export function followTheme(theme: Theme): () => void {
  applyTheme(theme);
  if (theme !== "system" || typeof window === "undefined") return () => {};
  const preference = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => applyTheme("system");
  preference.addEventListener("change", onChange);
  return () => preference.removeEventListener("change", onChange);
}

export function loadTheme(): Theme {
  if (typeof window === "undefined") return "system";
  try {
    const v = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    // A blocked preferences store still follows the system.
  }
  return "system";
}

export function saveTheme(t: Theme) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, t);
  } catch {
    // The current window can still use the selected theme.
  }
}
