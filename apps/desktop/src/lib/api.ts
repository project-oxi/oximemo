/**
 * Type-safe adapter for the Tauri IPC commands defined in `src-tauri/src/lib.rs`.
 * Falls back to a no-op implementation when running in plain browser mode
 * (e.g. `vite dev` without the Tauri shell) so the UI can be developed
 * standalone.
 */
import { invoke } from "./tauri";
import type { Memo, MemoSummary, IndexStats, DoctorReport, MemoStats, Facets, CategoryDef } from "./types";

export async function listMemos(
  after: string | null,
  limit = 50,
  filter: {
    include_tags?: string[];
    exclude_tags?: string[];
    match_all?: boolean;
    categories?: string[];
    favorites_only?: boolean;
  } = {},
) {
  return invoke<{ items: MemoSummary[]; next_cursor: string | null }>("list_memos", {
    after,
    limit,
    // Tauri v2 binds invoke args by Rust param name in camelCase by default.
    includeTags: filter.include_tags ?? [],
    excludeTags: filter.exclude_tags ?? [],
    matchAll: filter.match_all ?? false,
    categories: filter.categories ?? [],
    favoritesOnly: filter.favorites_only ?? false,
  });
}

export async function getMemo(id: string) {
  return invoke<Memo>("get_memo", { id });
}

/** First memo whose body references an asset (gallery "open containing memo"). */
export async function memoForAsset(name: string): Promise<string | null> {
  return invoke<string | null>("memo_for_asset", { name });
}

export async function createMemo(body: string, category: string | null) {
  return invoke<Memo>("create_memo", { body, category });
}

export async function updateMemo(
  id: string,
  body: string | null,
  favorite: boolean | null,
  category: string | null,
) {
  return invoke<Memo>("update_memo", { id, body, favorite, category });
}

export async function listFacets() {
  return invoke<Facets>("list_facets");
}

export async function deleteMemo(id: string) {
  return invoke<void>("delete_memo", { id });
}

export async function resetVault() {
  return invoke<null>("reset_vault");
}

export async function searchMemos(query: string, limit = 20) {
  return invoke<MemoSummary[]>("search_memos", { query, limit });
}

export async function exportManifest(since: string | null) {
  return invoke<unknown[]>("export_manifest", { since });
}

export async function reindex() {
  return invoke<IndexStats>("reindex");
}

export async function doctor(fix: boolean) {
  return invoke<DoctorReport>("doctor", { fix });
}

export async function vaultPath() {
  return invoke<string>("vault_path");
}

export async function memoStats() {
  return invoke<MemoStats>("memo_stats");
}

export async function listCategories(): Promise<CategoryDef[]> {
  return invoke<CategoryDef[]>("list_categories");
}

/** Create a persistent category. Persists in core config (survives restarts).
 *  Duplicate IDs (builtin or user-created) return an error. */
export async function createCategory(id: string, color: string | null): Promise<CategoryDef> {
  return invoke<CategoryDef>("create_category", { id, color });
}

export async function updateCategory(id: string, color: string) {
  return invoke<void>("update_category", { id, color });
}

export async function renameCategory(oldId: string, newId: string) {
  return invoke<number>("rename_category", { old: oldId, new: newId });
}

export async function deleteCategory(id: string) {
  return invoke<void>("delete_category", { id });
}
