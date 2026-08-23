/**
 * System-folder display names — macOS convention: physical paths stay
 * stable (`~/Desktop` on disk) while the UI shows a localized name
 * ("데스크톱"). Applied to the vault's default folders: the daily folder
 * (name from config) and the knowledge folder shipped by `Vault::migrate`
 * (user prompt 2026-08-23). Only the leading path segment is mapped —
 * nested folders keep their physical names.
 */
import { useQuery } from "@tanstack/react-query";

import { getConfig } from "./api";
import { useI18n } from "./i18n";

/** Just the two keys this module reads — accepts either locale dict. */
type FolderNames = { sysfolder_daily: string; sysfolder_knowledge: string };


/** Mirrors `oximemo_core::schema::DEFAULT_KNOWLEDGE_FOLDER`. */
export const DEFAULT_KNOWLEDGE_FOLDER = "knowledge";

function mapRoot(path: string, root: string, label: string): string | null {
  if (path === root) return label;
  if (path.startsWith(root + "/")) return label + path.slice(root.length);
  return null;
}

/** Localized full path: "knowledge/ai" → "지식/ai". */
export function folderDisplayName(
  path: string | null | undefined,
  t: FolderNames,
  dailyFolder?: string,
): string {
  if (!path) return "";
  return (
    mapRoot(path, dailyFolder || "daily", t.sysfolder_daily) ??
    mapRoot(path, DEFAULT_KNOWLEDGE_FOLDER, t.sysfolder_knowledge) ??
    path
  );
}

/** Localized leaf for tree rows/tiles: "knowledge" → "지식",
 *  "knowledge/ai" → "ai" (the physical leaf). */
export function folderLeafName(
  path: string,
  t: FolderNames,
  dailyFolder?: string,
): string {
  const root = path.split("/")[0];
  if (path === root) {
    if (root === (dailyFolder || "daily")) return t.sysfolder_daily;
    if (root === DEFAULT_KNOWLEDGE_FOLDER) return t.sysfolder_knowledge;
  }
  return path.split("/").at(-1) ?? path;
}

/** Component hook over the shared ["config"] cache. */
export function useFolderNames() {
  const { t } = useI18n();
  const configQ = useQuery({ queryKey: ["config"], queryFn: getConfig });
  const dailyFolder = configQ.data?.daily?.folder || "daily";
  return {
    dailyFolder,
    displayName: (p: string | null | undefined) => folderDisplayName(p, t, dailyFolder),
    leafName: (p: string) => folderLeafName(p, t, dailyFolder),
  };
}
