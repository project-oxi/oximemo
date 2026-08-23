/**
 * Installable collection catalog (spec 2026-08-23 §2.2) — the frontend
 * metadata layer over core's preset registry: localized names, one-line
 * pitches, suggested folder names, and icons. knowledge/daily are
 * intentionally absent: they ship with every vault and never install.
 */
import {
  BookOpen,
  Calendar,
  Clapperboard,
  FileText,
  Library,
  Lightbulb,
  PenLine,
  type LucideIcon,
} from "lucide-react";

import { dict as koDict } from "./locales/ko";

/** Locale dictionary key — drives compile-time parity with the
 *  `as const` locale tables. */
export type DictKey = keyof typeof koDict;

export interface CollectionPresetInfo {
  id: string;
  icon: LucideIcon;
  /** i18n keys for the picker card + settings rail. */
  nameKey: DictKey;
  descKey: DictKey;
  /** Suggested folder name per locale (the picker's input default). */
  defaultFolder: { ko: string; en: string };
  /** Collections whose notes auto-fill from metadata providers. */
  hasMetadata: boolean;
}

export const COLLECTION_CATALOG: CollectionPresetInfo[] = [
  {
    id: "book",
    icon: BookOpen,
    nameKey: "collection_name_book",
    descKey: "collection_desc_book",
    defaultFolder: { ko: "책", en: "books" },
    hasMetadata: true,
  },
  {
    id: "movie",
    icon: Clapperboard,
    nameKey: "collection_name_movie",
    descKey: "collection_desc_movie",
    defaultFolder: { ko: "영화", en: "movies" },
    hasMetadata: true,
  },
  {
    id: "blog",
    icon: FileText,
    nameKey: "collection_name_blog",
    descKey: "collection_desc_blog",
    defaultFolder: { ko: "블로그", en: "blog" },
    hasMetadata: false,
  },
  {
    id: "novel",
    icon: PenLine,
    nameKey: "collection_name_novel",
    descKey: "collection_desc_novel",
    defaultFolder: { ko: "집필", en: "writing" },
    hasMetadata: false,
  },
  {
    id: "idea",
    icon: Lightbulb,
    nameKey: "collection_name_idea",
    descKey: "collection_desc_idea",
    defaultFolder: { ko: "아이디어", en: "ideas" },
    hasMetadata: false,
  },
];

/** Rail/picker entry for a system collection (knowledge/daily): same
 *  shape as catalog entries but always present and never uninstallable
 *  (deleting = system-folder reset, recreated on next migrate). */
export interface SystemCollectionInfo {
  id: "knowledge" | "daily";
  icon: LucideIcon;
  nameKey: DictKey;
}

export const SYSTEM_COLLECTIONS: SystemCollectionInfo[] = [
  { id: "knowledge", icon: Library, nameKey: "collection_name_knowledge" },
  { id: "daily", icon: Calendar, nameKey: "collection_name_daily" },
];
