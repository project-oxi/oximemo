// English strings. Keys must match `ko.ts` (compile-time enforced via
// `Record<keyof typeof ko, string>`).
import type { dict as ko } from "./ko";

export const dict: Record<keyof typeof ko, string> = {
  app_title: "oxinot",
  search_placeholder: "Search",
  empty_hint: "No notes yet. Start a capture.",
  new_note: "New note",
  capture_placeholder: "Jot down a thought…",
  capture_save: "Save",
  capture_cancel: "Cancel",
  pinned: "Pinned",
  color: "Color",
  language: "Language",
  theme_system: "System",
  theme_light: "Light",
  theme_dark: "Dark",
  locale_ko: "한국어",
  locale_en: "English",
};
