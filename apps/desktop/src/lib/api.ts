/**
 * Type-safe adapter for the Tauri IPC commands defined in `src-tauri/src/lib.rs`.
 * Falls back to a no-op implementation when running in plain browser mode
 * (e.g. `vite dev` without the Tauri shell) so the UI can be developed
 * standalone.
 */
import { invoke } from "./tauri";
import type {
  AddTarget,
  BacklinkInfo,
  BaseInfo,
  BasePage,
  BaseSource,
  BrainLayer,
  BrainStatus,
  Config,
  DailyOpen,
  FolderCard,
  FolderDef,
  FolderEntry,
  FolderSchema,
  GraphData,
  LoadBaseDto,
  Memo,
  MemoSummary,
  MemoStats,
  IndexStats,
  DoctorReport,
  Facets,
  MoveTasksReceipt,
  MoveTasksRequest,
  NoteQueryInput,
  PatchTaskResult,
  PropInfo,
  PropMutation,
  QueryPage,
  RunBaseReq,
  TaskDraftTransform,
  TaskDto,
  TaskEdit,
  TaskFields,
  TaskSelector,
  TasksWireConfig,
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

/** Quick-capture: writes to the Inbox (`idea` preset) folder.
 *  Backend resolves the destination — no `folder`/`format` args. */
export async function createCapture(body: string): Promise<Memo> {
  return invoke<Memo>("create_capture", { body });
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

/** Envelope the `recall` op returns. `layers` stays optional — the
 * panel defends against shape drift between brain versions. `meta.dropped`
 * reports what truncation discarded (an empty result is not "nothing
 * exists" until `dropped` agrees). */
export interface BrainRecall {
  layers?: BrainLayer[];
  meta?: { dropped?: unknown };
}

/** Recall layers for a query; throws when the daemon is offline. */
export async function brainGather(
  query: string,
  budget = 4000,
): Promise<BrainRecall> {
  return invoke<BrainRecall>("brain_gather", { query, budget });
}

/** One synced revision of a note from the documents plane (brain 0.10
 *  `document_history`; supersedes the occurrence-chain episodes).
 *  Oldest-first when listed. */
export interface HistoryEpisode {
  revision: string;
  content: string;
  /** Unix milliseconds. */
  committed_at_ms: number;
}

/** Revision history of one vault-relative note path; throws when the
 *  daemon is offline — callers hide the surface (C1), never error. */
export async function brainHistory(path: string): Promise<HistoryEpisode[]> {
  return invoke<HistoryEpisode[]>("brain_history", { path });
}


// --- spaces (spec 2026-08-28) ----------------------------------------------

export interface SpaceInfo {
  name: string;
  current: boolean;
}

/** Space vaults under ~/.oxi/spaces/<name>/vault. Filesystem-backed; brain not required. */
export async function spaceList(): Promise<SpaceInfo[]> {
  return invoke<SpaceInfo[]>("space_list");
}

/** Create + scaffold; invalid names surface the backend error string. */
export async function spaceCreate(name: string): Promise<SpaceInfo> {
  return invoke<SpaceInfo>("space_create", { name });
}

/** Persist last_space and restart the app into the new space. */
export async function spaceSwitch(name: string): Promise<void> {
  return invoke("space_switch", { name });
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

/** `[tasks]` section setter — core validates the status table and the
 * fingerprint forces reindex for extraction-affecting changes. */
export async function setTasksConfig(tasks: TasksWireConfig): Promise<void> {
  return invoke("set_tasks_config", { tasks });
}

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
  /** Poster/cover image URL (core MetaHit.cover_url) — stamped into a
   *  schema-declared `cover_url` prop like source_url. */
  cover_url?: string | null;
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

// --- copilot (spec 2026-08-23) ----------------------------------------------

export interface CopilotStatus {
  enabled: boolean;
  activated: boolean;
  agent: string;
  agent_name: string;
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
  /** Signal that killed the agent (user cancel / external kill). */
  signal: number | null;
  stderr: string;
  timed_out: boolean;
  changed: ChangedNote[];
  duration_ms: number;
  /** Model/provider actually used this turn, when the agent's output
   * discloses it (omp's JSONL stream and claude's modelUsage do). */
  model: string | null;
  provider: string | null;
  /** Tool requests the agent's OWN permission policy denied this turn
   * (claude's result JSON discloses them). null = not measurable. */
  denials: string[] | null;
 }

export interface ActiveMemoRef {
  id: string;
  title: string;
  path: string;
  /** Text currently selected in the note editor, if any. */
  selection?: string | null;
}

/** A memo the user @-referenced in the composer. Facts for the turn's
 * `referenced_memos` context section (deduped against the active memo and
 * capped at 8 on the Rust side). */
export interface MemoRef {
  id: string;
  title: string;
  path: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  context_window: number | null;
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

export function copilotModels(): Promise<ModelInfo[]> {
  return invoke<ModelInfo[]>("copilot_models");
}

/** oxios only: its `run` has no per-turn model flag, so the picker edits
 * the durable `engine.default_model` via oxios's own `config set`. */
export function copilotSetModel(model: string): Promise<Disclosure> {
  return invoke<Disclosure>("copilot_set_model", { model });
}

export function copilotSend(
  message: string,
  activeMemo: ActiveMemoRef | null,
  referenced: MemoRef[] | null,
  session: string | null,
  model: string | null,
): Promise<TurnResult> {
  return invoke<TurnResult>("copilot_send", { message, activeMemo, referenced, session, model });
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

export async function setFolderCalendarField(
  path: string,
  field: string | null,
): Promise<void> {
  await invoke<void>("set_folder_calendar_field", { path, field });
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

/** The folder's TEMPLATE.md body, or null when it has none — the slash
 * 템플릿 command hides on null (Plan D Task 2). Desktop-only: browser
 * mode has no vault file reads and the fallback answers null. */
export function folderTemplate(folder: string): Promise<string | null> {
  return invoke<string | null>("folder_template", { folder });
}

/** Install a collection preset (TEMPLATE.md + SCHEMA.toml) into a
 *  folder — the generalized surface behind every managed collection
 *  (knowledge/daily included). Clean cutover from the old
 *  applyKnowledgePreset IPC (spec 2026-08-23 §2). */
export function installCollection(presetId: string, folder: string): Promise<void> {
  return invoke<void>("install_collection", { presetId, folder });
}

// --- Query views (design 2026-08-25) ----------------------------------------
// Thin `invoke` wrappers over the base commands (queryNotes pattern).
// Desktop-only: the tauri.ts browser fallback throws for every one of
// these — there is deliberately no second query engine (spec §Decision).

export function runBase(source: BaseSource, req: RunBaseReq): Promise<BasePage> {
  return invoke<BasePage>("run_base", { source, req });
}

export function listBases(): Promise<BaseInfo[]> {
  return invoke<BaseInfo[]>("list_bases");
}

export function loadBase(path: string): Promise<LoadBaseDto> {
  return invoke<LoadBaseDto>("load_base", { path });
}

/** Save raw YAML; `expectedMtimeMs` guards against external edits (a
 * mismatch is a reload conflict). Returns the fresh mtime for the next
 * save. */
export function saveBase(
  path: string,
  yaml: string,
  expectedMtimeMs?: number,
): Promise<LoadBaseDto> {
  return invoke<LoadBaseDto>("save_base", {
    path,
    yaml,
    expectedMtimeMs: expectedMtimeMs ?? null,
  });
}

export function renameBase(
  from: string,
  to: string,
  expectedMtimeMs?: number,
): Promise<void> {
  return invoke<void>("rename_base", {
    from,
    to,
    expectedMtimeMs: expectedMtimeMs ?? null,
  });
}

/** Moves the `.query` into `.trash/_queries/`; resolves the restore token. */
export function trashBase(path: string): Promise<string> {
  return invoke<string>("trash_base", { path });
}

/** Resolves the restored vault-relative path. */
export function restoreBase(token: string): Promise<string> {
  return invoke<string>("restore_base", { token });
}

export function baseProps(): Promise<PropInfo[]> {
  return invoke<PropInfo[]>("base_props");
}

// --- Tasks (spec 2026-08-27) --------------------------------------------------
// Wire-shape passthroughs: `edit`/`selector`/`target`/`fields`/`request`
// use the externally-tagged forms documented in types.ts (PascalCase
// words, fixture-corpus compatible). `today` is always "YYYY-MM-DD".

/** All indexed task rows across live notes; `noteId` narrows to one
 *  note. Browser mode: desktop-only rejection. */
export function listTasks(noteId: string | null): Promise<TaskDto[]> {
  return invoke<TaskDto[]>("list_tasks", { noteId });
}

/** Hash-repair lookup for openTask: returns `line` itself when its bytes
 *  still hash to `lineHash`, else the unique line that does; null when
 *  absent or ambiguous. */
export function resolveTaskLine(
  noteId: string,
  line: number,
  lineHash: string,
): Promise<number | null> {
  return invoke<number | null>("resolve_task_line", { noteId, line, lineHash });
}

/** Apply one guarded edit to a persisted task line (spec §5). Emits
 *  `memos:changed` on success. */
export function patchTask(
  selector: TaskSelector,
  edit: TaskEdit,
  today: string,
): Promise<PatchTaskResult> {
  return invoke<PatchTaskResult>("patch_task", { selector, edit, today });
}

/** Append a new task line under the target's configured section
 *  (spec §6/§7). Emits `memos:changed` on success. */
export function addTask(
  target: AddTarget,
  text: string,
  fields: TaskFields,
  today: string,
): Promise<PatchTaskResult> {
  return invoke<PatchTaskResult>("add_task", { target, text, fields, today });
}

/** Atomically move task subtrees between notes (spec §7). Emits
 *  `memos:changed` on success. */
export function moveTasks(
  request: MoveTasksRequest,
  today: string,
): Promise<MoveTasksReceipt> {
  return invoke<MoveTasksReceipt>("move_tasks", { request, today });
}

/** Guarded inverse of `moveTasks` (spec §7): proceeds only while both
 *  notes still match the receipt's post-move hashes — an intervening
 *  edit wins and undo refuses to erase it. Emits `memos:changed` on
 *  success. */
export function undoMoveTasks(receipt: MoveTasksReceipt): Promise<void> {
  return invoke<void>("undo_move_tasks", { receipt });
}

/** Pure task-edit kernel on an arbitrary body — no lock, no disk. The
 *  CM6 editor uses it on the unsaved buffer; `patchTask` runs the same
 *  kernel under the vault's lock. Browser mode dispatches to the
 *  taskLine mirror with the default tasks config. */
export function transformTaskDraft(
  body: string,
  line: number,
  edit: TaskEdit,
  today: string,
): Promise<TaskDraftTransform> {
  return invoke<TaskDraftTransform>("transform_task_draft", { body, line, edit, today });
}
