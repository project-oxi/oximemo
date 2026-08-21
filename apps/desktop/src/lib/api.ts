/**
 * Type-safe adapter for the Tauri IPC commands defined in `src-tauri/src/lib.rs`.
 * Falls back to a no-op implementation when running in plain browser mode
 * (e.g. `vite dev` without the Tauri shell) so the UI can be developed
 * standalone.
 */
import { invoke } from "./tauri";
import type {
  BacklinkInfo,
  BrainLayer,
  BrainStatus,
  Config,
  DailyOpen,
  FolderCard,
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
    immediate?: boolean;
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
    immediate: filter.immediate ?? null,
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

/** Open (create if missing) the daily note for an ISO date (YYYY-MM-DD).
 *  `created` is true only when this call minted the note. */
export async function openDailyNote(date: string) {
  return invoke<DailyOpen>("open_daily_note", { date });
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

/** Envelope the daemon's `recall` returns. `layers` stays optional — the
 * panel defends against shape drift between daemon versions. */
export interface BrainRecall {
  layers?: BrainLayer[];
}

/** Recall layers for a query; throws when the daemon is offline. */
export async function brainGather(
  query: string,
  budget = 4000,
): Promise<BrainRecall> {
  return invoke<BrainRecall>("brain_gather", { query, budget });
}

// --- TOML ⇄ GUI parity: config section setters ---------------------------

export type BrainSection = NonNullable<Config["brain"]>;

export async function setBrainConfig(brain: BrainSection): Promise<void> {
  return invoke("set_brain_config", { brain });
}

export async function setGeneralConfig(general: {
  trash_retention_days: number;
}): Promise<void> {
  return invoke("set_general_config", { general });
}

export async function setCaptureConfig(capture: {
  double_tap_threshold_ms: number;
  overlay_max_height: number;
}): Promise<void> {
  return invoke("set_capture_config", { capture });
}

export async function setAppearanceConfig(appearance: {
  theme: "system" | "light" | "dark";
  show_dock_icon: boolean;
}): Promise<void> {
  return invoke("set_appearance_config", { appearance });
}

export async function setIndexConfig(index: {
  watcher_debounce_ms: number;
}): Promise<void> {
  return invoke("set_index_config", { index });
}

export interface BrainSpace {
  name: string;
  episodes: number;
}

export interface BrainSpaces {
  online: boolean;
  spaces: BrainSpace[];
}

/** Daemon-exposed spaces for the settings picker. Offline is normal (C1). */
export async function brainListSpaces(): Promise<BrainSpaces> {
  return invoke<BrainSpaces>("brain_list_spaces");
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

/** Folder cards for one browse level: recursive counts + recent titles. */
export async function folderChildren(path: string): Promise<FolderCard[]> {
  return invoke<FolderCard[]>("folder_children", { path });
}

export async function createFolder(path: string): Promise<void> {
  await invoke<void>("create_folder", { path });
}

/** Delete a folder: every live note under it is trashed (structure
 * preserved) and the remaining tree removed. Returns the trashed note
 * ids so the caller can offer undo via `restoreNotes`. */
export async function deleteFolder(path: string): Promise<string[]> {
  return invoke<string[]>("delete_folder", { path });
}

/** Undo for `deleteFolder`: restore the trashed notes (recreating
 * their parent folders). Returns the restored ids. */
export async function restoreNotes(ids: string[]): Promise<string[]> {
  return invoke<string[]>("restore_notes", { ids });
}

export async function renameFolder(from: string, to: string): Promise<void> {
  await invoke<void>("rename_folder", { from, to });
}

/** Move a folder subtree into `dest` ("" = vault top level), keeping its
 * basename. Backend guards cycles/parent no-ops; see vault.rs move_folder. */
export async function moveFolder(path: string, dest: string): Promise<void> {
  await invoke<void>("move_folder", { path, dest });
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

export async function setFolderPinned(path: string, pinned: boolean): Promise<void> {
  await invoke<void>("set_folder_pinned", { path, pinned });
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