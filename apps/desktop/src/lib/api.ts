/**
 * Type-safe adapter for the Tauri IPC commands defined in `src-tauri/src/lib.rs`.
 * Falls back to a no-op implementation when running in plain browser mode
 * (e.g. `vite dev` without the Tauri shell) so the UI can be developed
 * standalone.
 */
import { invoke } from "./tauri";
import type {
  BacklinkInfo,
  BrainStatus,
  Config,
  FolderDef,
  FolderEntry,
  GraphData,
  Memo,
  MemoSummary,
  MemoStats,
  IndexStats,
  DoctorReport,
  Facets,
  ViewMode,
} from "./types";

export async function listMemos(
  after: string | null,
  limit = 50,
  filter: {
    include_tags?: string[];
    exclude_tags?: string[];
    match_all?: boolean;
    folder?: string | null;
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
    folder: filter.folder ?? null,
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

export async function createMemo(
  body: string,
  folder: string | null,
  format?: "markdown" | "html",
) {
  return invoke<Memo>("create_memo", { body, folder, format: format ?? null });
}

export async function updateMemo(
  id: string,
  body: string | null,
  favorite: boolean | null,
) {
  return invoke<Memo>("update_memo", { id, body, favorite });
}

export async function brainStatus(): Promise<BrainStatus> {
  return invoke<BrainStatus>("brain_status");
}

/** Recall layers for a query; throws when the daemon is offline. */
export async function brainGather(query: string, budget = 4000): Promise<unknown> {
  return invoke<unknown>("brain_gather", { query, budget });
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

// --- folders --------------------------------------------------------------

export async function listFolders(): Promise<FolderEntry[]> {
  return invoke<FolderEntry[]>("list_folders");
}

export async function createFolder(path: string): Promise<void> {
  await invoke<void>("create_folder", { path });
}

export async function deleteFolder(path: string): Promise<void> {
  await invoke<void>("delete_folder", { path });
}

export async function moveNote(id: string, folder: string): Promise<void> {
  await invoke<void>("move_note", { id, folder });
}

export async function getBacklinks(id: string): Promise<BacklinkInfo[]> {
  return invoke<BacklinkInfo[]>("get_backlinks", { id });
}

// --- config & graph -------------------------------------------------------

export async function getConfig(): Promise<Config> {
  return invoke<Config>("get_config");
}

export async function setFolderView(path: string, view: ViewMode | null): Promise<void> {
  await invoke<void>("set_folder_view", { path, view });
}

export async function graphData(): Promise<GraphData> {
  return invoke<GraphData>("graph_data");
}

export function getFolderDef(config: Config, path: string): FolderDef | null {
  return config.folders?.find((f) => f.path === path) ?? null;
}

// --- CLI command install (Settings → "Install command") -------------------

export type CliState = "installed" | "not-installed" | "stale";

export async function cliStatus(): Promise<CliState> {
  return invoke<CliState>("cli_status");
}

/** Symlink the bundled CLI onto /usr/local/bin via a macOS admin prompt. */
export async function installCli(): Promise<void> {
  await invoke<null>("install_cli");
}

export async function uninstallCli(): Promise<void> {
  await invoke<null>("uninstall_cli");
}