/**
 * System-folder display names — macOS convention: physical paths stay
 * stable (`~/Desktop` on disk) while the UI shows a localized name
 * ("데스크톱"). Applied to the vault's default folders: the daily folder
 * (name from config) and the knowledge folder shipped by `Vault::migrate`
 * (user prompt 2026-08-23). Only the leading path segment is mapped —
 * nested folders keep their physical names.
 */
import { useQueries, useQuery } from "@tanstack/react-query";

import { folderSchema, getConfig } from "./api";
import { useI18n } from "./i18n";
import type { FolderSchema } from "./types";
import { useMemo, useRef } from "react";

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

/** Locale-aware display name for a schema-declaring folder: the default
 *  knowledge folder follows the UI language, custom schemas use their
 *  declared workspace name. */
export function schemaDisplayName(
  path: string,
  s: FolderSchema | null | undefined,
  t: FolderNames,
): string {
  if (path === DEFAULT_KNOWLEDGE_FOLDER) return t.sysfolder_knowledge;
  return s?.workspace?.name || path.split("/").at(-1) || path;
}

/** Schemas for a set of folder paths (one cached query each) — drives
 *  folder-tile add labels and the no-subfolders rule in schema folders. */
export function useSchemaInfo(paths: string[]): Record<string, FolderSchema | null> {
  const key = paths.join("\n");
  const list = key === "" ? [] : key.split("\n");
  const qs = useQueries({
    queries: list.map((p) => ({
      queryKey: ["folder-schema", p],
      queryFn: () => folderSchema(p),
      staleTime: 30_000,
    })),
  });
  const ready = qs.every((q) => !q.isPending);
  const stamp = ready ? key : `${key}#pending`;
  const cache = useRef<Record<string, FolderSchema | null>>({});
  return useMemo(() => {
    if (!ready) return cache.current;
    const out: Record<string, FolderSchema | null> = {};
    qs.forEach((q, i) => {
      out[list[i]] = (q.data as FolderSchema | null) ?? null;
    });
    cache.current = out;
    return out;
    // `stamp` pins the memo until every query has settled for this path set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp]);
}
