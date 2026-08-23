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
  FolderSchema,
  GraphData,
  Memo,
  MemoSummary,
  MemoStats,
  IndexStats,
  DoctorReport,
  Facets,
  NoteQueryInput,
  PropMutation,
  QueryPage,
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
  props?: PropMutation | null,
) {
  return invoke<Memo>("update_memo", { id, body, favorite, props: props ?? null });
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

/** One synced revision of a note from the brain's occurrence chain
 *  (Consumption Contract 1.3). Oldest-first when listed. */
export interface HistoryEpisode {
  id: string;
  seq: number;
  content: string;
  /** Unix milliseconds. */
  occurred_at: number;
  ingested_at: number;
}

/** Revision history of one vault-relative note path; throws when the
 *  daemon is offline — callers hide the surface (C1), never error. */
export async function brainHistory(path: string): Promise<HistoryEpisode[]> {
  return invoke<HistoryEpisode[]>("brain_history", { path });
}

// --- TOML ⇄ GUI parity: config section setters ---------------------------

export type BrainSection = NonNullable<Config["brain"]>;

export async function setBrainConfig(brain: BrainSection): Promise<void> {
  return invoke("set_brain_config", { brain });
}

export async function setDailyConfig(daily: {
  enabled: boolean;
  folder: string;
}): Promise<void> {
  return invoke("set_daily_config", { daily });
}

export type GitSection = NonNullable<Config["git"]>;

export async function setGitConfig(git: GitSection): Promise<void> {
  return invoke("set_git_config", { git });
}

export interface MetadataConfig {
  enabled: boolean;
  region: string;
  google_books_key: string;
  aladin_key: string;
  tmdb_key: string;
  omdb_key: string;
  kmdb_key: string;
}

export async function setMetadataConfig(metadata: MetadataConfig): Promise<void> {
  return invoke("set_metadata_config", { metadata });
}

export interface MetaHit {
  provider: string;
  title: string;
  subtitle?: string | null;
  url?: string | null;
  fields: Record<string, string>;
}

export async function searchBookMetadata(query: string, region?: string): Promise<MetaHit[]> {
  return invoke<MetaHit[]>("search_book_metadata", { query, region: region ?? null });
}

export async function searchMovieMetadata(query: string, region?: string): Promise<MetaHit[]> {
  return invoke<MetaHit[]>("search_movie_metadata", { query, region: region ?? null });
}

/**
 * Stamp a chosen hit onto a note: the backend fills only empty
 * schema-declared props (+ source_url); it never overwrites.
 */
export async function stampMetadata(id: string, hit: MetaHit): Promise<Memo> {
  return invoke<Memo>("stamp_metadata", { id, hit });
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

// --- copilot (spec 2026-08-23) ----------------------------------------------

export interface CopilotStatus {
  enabled: boolean;
  activated: boolean;
  agent: string;
  busy: boolean;
}

export interface AgentCandidate {
  id: string;
  display_name: string;
  executable: string;
  version: string | null;
  supported: boolean;
}

export interface Disclosure {
  agent: string;
  model: string | null;
  provider: string | null;
}

export interface ChangedNote {
  id: string;
  kind: "created" | "changed" | "deleted";
}

export interface TurnResult {
  response: string;
  session_id: string | null;
  exit_code: number | null;
  stderr: string;
  timed_out: boolean;
  changed: ChangedNote[];
  duration_ms: number;
}

export interface ActiveMemoRef {
  id: string;
  title: string;
  path: string;
}

export function copilotStatus(): Promise<CopilotStatus> {
  return invoke<CopilotStatus>("copilot_status");
}

export function copilotProbeAgents(): Promise<AgentCandidate[]> {
  return invoke<AgentCandidate[]>("copilot_probe_agents");
}

export function copilotDisclosure(agent: string): Promise<Disclosure> {
  return invoke<Disclosure>("copilot_disclosure", { agent });
}

export function setCopilotConfig(copilot: {
  enabled: boolean;
  agent: string;
  executable: string;
  timeout_secs: number;
}): Promise<void> {
  return invoke<void>("set_copilot_config", { copilot });
}

export function copilotActivate(agent: string, executable: string): Promise<Disclosure> {
  return invoke<Disclosure>("copilot_activate", { agent, executable });
}

export function copilotSend(
  message: string,
  activeMemo: ActiveMemoRef | null,
  session: string | null,
): Promise<TurnResult> {
  return invoke<TurnResult>("copilot_send", { message, activeMemo, session });
}

export function copilotCancel(): Promise<boolean> {
  return invoke<boolean>("copilot_cancel");
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

/** Reorder sidebar pins (vault-wide, persists to oximemo.toml). */
export async function setPinOrder(order: string[]): Promise<void> {
  return invoke("set_pin_order", { order });
}

/** Vault-wide `#old` → `#new` body rewrite. Returns changed-note count. */
export async function renameTag(old: string, to: string): Promise<number> {
  return invoke<number>("rename_tag", { old, new: to });
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

/** Toggle the quick-capture overlay (same path as the ⌘⇧N shortcut). */
export function showCaptureWindow(): Promise<void> {
  return invoke<void>("show_capture_window");
}

// --- Property engine & folder schema (design 2026-08-23) --------------------

/** Offset-paginated property query (§5.2). Used whenever property
 *  predicates or sorts are present; default browsing stays on the
 *  cursor path. */
export function queryNotes(q: NoteQueryInput): Promise<QueryPage> {
  const filter = {
    folder: q.folder === undefined ? null : q.folder,
    favorites_only: q.favorites_only ?? false,
  };
  return invoke<QueryPage>("query_notes", {
    filter: q.folder === undefined && !q.favorites_only ? null : filter,
    props: q.props ?? null,
    sort: q.sort ?? null,
    offset: q.offset ?? 0,
    limit: q.limit ?? 50,
  });
}

/** The folder's property schema; null in free-property mode. */
export function folderSchema(folder: string): Promise<FolderSchema | null> {
  return invoke<FolderSchema | null>("folder_schema", { folder });
}

/** Install a collection preset (TEMPLATE.md + SCHEMA.toml) into a
 *  folder — the generalized surface behind every managed collection
 *  (knowledge/daily included). Clean cutover from the old
 *  applyKnowledgePreset IPC (spec 2026-08-23 §2). */
export function installCollection(presetId: string, folder: string): Promise<void> {
  return invoke<void>("install_collection", { presetId, folder });
}
