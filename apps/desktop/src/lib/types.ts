/** Shared types mirroring the Rust core. */
import type { TaskLineChange as MirrorLineChange, WireTaskEdit } from "./taskLine";

export type MemoId = string;

export type NoteFormat = "markdown" | "html";

/** Property value: scalar, boolean, or string list (design 2026-08-23 §5.1). */
export type PropValue = { Str: string } | { Bool: boolean } | { List: string[] };

/** Property map: key → value. Serialized as a JSON object keyed by prop
 *  name whose values are externally-tagged PropValue envelopes. */
export type Props = Record<string, PropValue>;

export interface Memo {
  id: MemoId;
  created_at: string;
  updated_at: string;
  hash: string;
  favorite: boolean;
  /** Vault-relative folder path. "" = root. */
  folder: string;
  /** Vault-relative file path, e.g. "novel/장.html". */
  path: string;
  /** Serialization format, derived from the path extension. */
  format: NoteFormat;
  /** Derived title (from H1/<h1> or timestamp); null when untitled. */
  title: string | null;
  tags: string[];
  body: string;
  /** Frontmatter properties beyond the core five keys. */
  props: Props;
  deleted_at: string | null;
}

/** `open_daily_note` payload: the note plus whether this call minted it.
 *  A freshly created daily note is discardable on close-untouched;
 *  adopted/visited ones never are. */
export interface DailyOpen {
  memo: Memo;
  created: boolean;
}

export interface BrainStatus {
  online: boolean;
  disabled?: boolean;
  server_version?: string;
  episodes?: number | null;
  entities?: number | null;
  statements?: number | null;
  contradictions?: number | null;
}

export interface BrainLayer {
  kind: string;
  text: string;
}

export interface MemoSummary {
  id: MemoId;
  created_at: string;
  updated_at: string;
  hash: string;
  favorite: boolean;
  folder: string;
  /** Vault-relative file path. */
  path: string;
  /** Derived title; null when untitled (Rust omits the key when None). */
  title: string | null;
  tags: string[];
  props: Props;
  preview: string;
  deleted: boolean;
}

// --- Property engine & folder schema (design 2026-08-23) --------------------

/** A minimal set/remove property diff for `update_memo`. */
export interface PropMutation {
  sets: [string, PropValue][];
  removes: string[];
}

export interface PropPredicate {
  key: string;
  op: "Eq" | "In" | "Contains";
  values: string[];
}

export type SortSpec =
  | "UpdatedDesc"
  | "UpdatedAsc"
  | { PropAsc: string };

/** Offset query payload; `folder` mirrors the list filter's semantics. */
export interface NoteQueryInput {
  folder?: string | null;
  favorites_only?: boolean;
  props?: PropPredicate[];
  sort?: SortSpec;
  offset?: number;
  limit?: number;
}

export interface QueryPage {
  items: MemoSummary[];
  total: number;
}

export type SchemaPropType = "text" | "select" | "multiselect" | "date" | "bool";

export interface SchemaPropertyDef {
  prop_type?: SchemaPropType;
  options?: string[];
  required?: boolean;
  badge?: boolean;
  colors?: Record<string, string>;
  /** Provider field this property auto-fills from (spec §3.1). */
  metadata?: string | null;
}

export interface SchemaTransitionRule {
  key: string;
  from?: string[];
  to: string[];
  on?: "Change" | "Write";
  copy_from?: string | null;
  into?: string | null;
  merge?: "Replace" | "Max" | null;
  stamp_date?: string | null;
}

/** `[review.promote]` — schema-declared promotion (ideas → knowledge). */
export interface SchemaPromoteDef {
  into: string;
  kind: string;
  start_status?: string | null;
}

export interface SchemaReviewDef {
  property: string;
  due_values: string[];
  order_by?: string | null;
  decay_to: string;
  promote?: SchemaPromoteDef | null;
}

export interface FolderSchema {
  workspace?: { name?: string | null };
  /** `[meta]` — preset provenance marker (spec §2.1). */
  meta?: { preset?: string | null };
  properties?: Record<string, SchemaPropertyDef>;
  transitions?: SchemaTransitionRule[];
  review?: SchemaReviewDef | null;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export interface IndexStats {
  memos: number;
  trashed_memos: number;
  added: number;
  updated: number;
  unchanged: number;
  failed: number;
}

export interface DoctorReport {
  corrupt_frontmatter: [string, string][];
  /** Both the old and the new default vault exist; a manual merge is pending. */
  merge_required: boolean;
  orphan_index_records: string[];
  orphan_files: string[];
  hash_mismatches: string[];
  hash_repair_failed: number;
  index_locked: boolean;
  trash_expiring: number;
  vault_ok: boolean;
}

export interface MemoStats {
  memos: number;
  favorites: number;
}

export interface Facets {
  tags: [string, number][];
  folders: [string, number][];
}

export interface FolderEntry {
  /** Vault-relative path. "" = root. */
  path: string;
  note_count: number;
}

export interface FolderRecent {
  id: MemoId;
  title: string | null;
  updated_at: string;
}

export interface FolderCard {
  path: string;
  /** Direct note count as `list_folders` reports it. */
  note_count: number;
  /** Recursive note count (notes anywhere under this folder). */
  note_count_deep: number;
  /** Direct subfolder count. */
  subfolder_count: number;
  /** Up to 3 newest notes attributed to this folder (newest-first). */
  recent: FolderRecent[];
}

export type ViewMode =
  | "grid"
  | "list"
  | "timeline"
  | "graph"
  | "shelf"
  | "table"
  | "calendar";

export interface FolderDef {
  path: string;
  view?: ViewMode;
  color?: string;
  pinned?: boolean;
  calendar_date_field?: string;
}

export interface Config {
  schema_version: number;
  general?: { trash_retention_days?: number };
  capture?: { double_tap_threshold_ms?: number; overlay_max_height?: number };
  appearance?: { theme?: "system" | "light" | "dark"; show_dock_icon?: boolean };
  folders?: FolderDef[];
  brain?: { enabled?: boolean; socket?: string; space?: string };
  daily?: { enabled?: boolean; folder?: string };
  git?: { auto_commit?: boolean; adopt_foreign_repo?: boolean };
  copilot?: {
    enabled?: boolean;
    agent?: string;
    executable?: string;
    timeout_secs?: number;
  };
  metadata?: {
    enabled?: boolean;
    region?: string;
    google_books_key?: string;
    aladin_key?: string;
    tmdb_key?: string;
    omdb_key?: string;
    kmdb_key?: string;
  };
  index?: { watcher_debounce_ms?: number };
  /** `[tasks]` vault config (spec §11) as `get_config` serializes it —
   *  serde defaults applied, so every field is present once loaded. */
  tasks?: TasksWireConfig;
}

/** One `[[tasks.statuses]]` row on the config wire. `type` is
 * SCREAMING_SNAKE_CASE like every StatusType on the READ side;
 * `name` is the optional per-status display override. */
export interface TaskStatusWireDef {
  symbol: string;
  name?: string;
  next: string;
  type: string;
}

/** The `[tasks]` table. Field spellings match the Rust serde
 * serialization; `cfgFromJson` (lib/taskLine.ts) adapts it into the
 * mirror's `TaskLineCfg`, merging the builtin status table. */
export interface TasksWireConfig {
  enabled: boolean;
  write_format: "emoji" | "dataview";
  global_filter: string;
  recurrence_insert: "above" | "below";
  default_section: string;
  capture_target: "daily" | "inbox";
  statuses: TaskStatusWireDef[];
}

export interface GraphData {
  nodes: Array<{
    id: string;
    title: string;
    folder: string;
    connections: number;
    /** oklch() color string keyed off the folder */
    color: string;
  }>;
  edges: Array<{ source: string; target: string }>;
}

export interface BacklinkInfo {
  id: string;
  title: string;
  preview: string;
}

// --- Query views (design 2026-08-25) ----------------------------------------
// Wire mirrors the core DTOs: the base/req DTO structs carry serde
// rename_all = "camelCase" (Plan A Task 12), but serde casing does NOT
// propagate into nested types — `Duration` (expr::value::DurationSpec) and
// `BaseClock` (EvalClockDto) serialize their fields snake_case as declared
// in Plan A Task 9, like MemoSummary's created_at. Enums are externally
// tagged like every Rust enum on this wire. Rust command wrappers land with
// Plan A Task 12 — until then these are desktop-only.

/** Expr engine value (`expr::value::Value`), externally tagged. `Date` is an
 * RFC 3339 string; `Duration` carries the calendar/fixed split. */
export type BaseValue =
  | "Null"
  | { Bool: boolean }
  | { Num: number }
  | { Str: string }
  | { List: BaseValue[] }
  | { Date: string }
  | { Duration: { calendar_months: number; fixed_millis: number } };

export interface BaseCell {
  value: BaseValue | null;
  error: string | null;
}

export interface BaseRow {
  /** Generation-scoped row identity (spec §4): `n:<memo_id>` for note
   *  rows, `t:<memo_id>:<line>` for task rows. NOT stable across
   *  external edits — consumers clear derived state when
   *  `BasePage.result_key` changes. Wire field (snake_case; mirrors
   *  the Rust `BaseRow` derive). */
  row_id: string;
  summary: MemoSummary;
  folder: string;
  format: NoteFormat;
  /** Present only for `source: tasks` rows; null for note rows. */
  task: TaskDto | null;
  cells: BaseCell[];
}

export interface GroupCount {
  key: string;
  count: number;
}

export interface SummaryValue {
  name: string;
  /** Absent aggregates arrive as the "Null" variant, never JSON null. */
  value: BaseValue;
}

export interface BaseClock {
  now_utc: string;
  local_offset_seconds: number;
}

export interface BasePage {
  rows: BaseRow[];
  total: number;
  groupCounts: GroupCount[] | null;
  /** Column path → summary; keys use dot identifiers (`note.rating`). */
  summaries: Record<string, SummaryValue> | null;
  clock: BaseClock;
  resultKey: string;
  warnings: string[];
}

/** `run_base` source. `Inline` carries raw YAML so the wire stays plain
 * strings; `Path` is vault-relative. */
export type BaseSource = { Inline: { yaml: string } } | { Path: string };

export interface RunBaseReq {
  viewIndex: number;
  offset: number;
  limit: number;
  /** Canonical group key for board column paging; null = full dataset. */
  group: string | null;
  nowMs: number | null;
  localOffsetSeconds: number | null;
  includeGroupCounts: boolean;
  includeSummaries: boolean;
  thisId: MemoId | null;
}

export interface BaseInfo {
  path: string;
  name: string;
  mtimeMs: number;
  /** False when the file fails the parse smoke test (sidebar ⚠). */
  loadable: boolean;
}

export interface LoadBaseDto {
  yaml: string;
  mtimeMs: number;
}

/** Parsed `.query` def shapes for the frontend surfaces (spec §1).
 *  Unknown keys are preserved on round-trip by editing raw YAML (code
 *  mode); these interfaces describe only what the UI reads. */
export interface BaseViewDef {
  /** String, not a closed enum — unknown types render an errored tab
   *  instead of failing the file (spec §1). */
  type: string;
  name?: string;
  filters?: unknown;
  order?: { property: string; direction?: string }[];
  columns?: string[];
  groupBy?: { property: string; direction?: string } | null;
  summaries?: Record<string, string>;
  limit?: number | null;
}

export interface BaseDef {
  filters?: unknown;
  formulas?: Record<string, string>;
  properties?: Record<string, { displayName?: string } & Record<string, unknown>>;
  views?: BaseViewDef[];
}

/** Observed property catalog for the filter builder (spec §3). The
 * wire field is `observedTypes` (spec §3 name; core's Rust field is
 * `kinds` — the Tauri DTO maps it). */
export interface PropInfo {
  key: string;
  observedTypes: string[];
  options: string[];
}

// --- Tasks (spec 2026-08-27) --------------------------------------------------
// Wire mirrors of `crates/oximemo-core/src/tasks.rs` as serialized by the
// Tauri commands in `src-tauri/src/lib.rs`. Two spelling rules hold:
//  • READ side (TaskDto & friends): the serde attributes on the core
//    types — snake_case fields, camelCase enum words (Priority,
//    TaskWarning), SCREAMING_SNAKE_CASE StatusType, dates as
//    "YYYY-MM-DD" strings, MemoId/MemoHash as bare strings.
//  • WRITE side (TaskEdit, TaskSelector, AddTarget, TaskFields,
//    MoveTasksRequest, TaskDraftTransform): the kernel types carry no
//    serde derives (Task 1 decision), so the command layer owns these
//    shapes — externally tagged PascalCase variant names, and the
//    SetDate/SetPriority words PascalCase, byte-identical to the golden
//    fixture corpus (taskFixtures.json) that taskLine.ts's adapters read.

/** BLAKE3-derived 16-hex digest of one raw task line (spec §5
 *  optimistic-lock key). Branded so it is never confused with a note
 *  hash; values always originate from Rust. */
export type TaskLineHash = string & { readonly __taskLineHash: never };

/** Identifies one task line for `patch_task`, carrying the stale-write
 *  guard (spec §5): `line_hash` is the target line's hash as the caller
 *  last saw it. */
export interface TaskRef {
  memo_id: MemoId;
  line: number;
  line_hash: TaskLineHash;
}

/** How `patch_task` locates the target line (spec §5): `Exact` rejects
 *  on drift from `line_hash`; `CurrentLine` targets whatever line is
 *  there now (CM6 unsaved-buffer path). */
export type TaskSelector =
  | { Exact: TaskRef }
  | { CurrentLine: { memo_id: MemoId; line: number } };

/** Date-field word on the WRITE side — PascalCase per the fixture
 *  corpus. (Parsed dates on the READ side are plain "YYYY-MM-DD"
 *  strings instead; there is no lowercase date-word on this wire.) */
export type TaskDateField =
  | "Created"
  | "Start"
  | "Scheduled"
  | "Due"
  | "Done"
  | "Cancelled";

/** Priority word on the WRITE side — PascalCase per the fixture corpus.
 *  NOTE the deliberate asymmetry: `TaskDto.priority` READS camelCase
 *  ("high"); only edit/add inputs write PascalCase ("High"). */
export type TaskPriorityWord =
  | "Highest"
  | "High"
  | "Medium"
  | "Low"
  | "Lowest"
  | "None";

/** One edit to a task line — externally tagged (fixture-corpus form;
 *  dates are "YYYY-MM-DD" or null). */
export type TaskEdit =
  | "Toggle"
  | { SetStatus: string }
  | { SetDate: { field: TaskDateField; value: string | null } }
  | { SetPriority: TaskPriorityWord }
  | { SetText: string }
  | { SetRecurrence: string | null }
  | "Delete";

/** Fields for a brand-new task line (`add_task` input), snake_case.
 *  `priority` follows the WRITE-side PascalCase word. */
export interface TaskFields {
  created: string | null;
  start: string | null;
  scheduled: string | null;
  due: string | null;
  priority: TaskPriorityWord;
  recurrence: string | null;
  tags: string[];
}

/** Where `add_task` appends (spec §6/§7): a note, the daily note for a
 *  "YYYY-MM-DD" date, or the Inbox. */
export type AddTarget = { Note: MemoId } | { Daily: string } | "Inbox";

/** Atomic task-subtree move request (spec §7). `expected_destination_hash`
 *  ("b3:<hex>", or null) guards the destination against stale views. */
export interface MoveTasksRequest {
  source: MemoId;
  tasks: TaskRef[];
  destination: AddTarget;
  expected_destination_hash: string | null;
}

/** Parsed-field word on the READ side — camelCase (TaskField's serde
 *  rename), as it appears inside `TaskWarning`. */
export type TaskWarningField =
  | "created"
  | "start"
  | "scheduled"
  | "due"
  | "done"
  | "cancelled"
  | "priority"
  | "recurrence";

/** An offending raw token recorded verbatim for UI repair (spec §1). */
export interface TaskWarning {
  field: TaskWarningField | null;
  raw: string;
  kind: "invalidValue" | "duplicate" | "unsupportedRule";
}

/** Indexed task row plus the ref needed to patch it again (spec §3/§10).
 *  Dates are "YYYY-MM-DD" strings; `priority` reads camelCase. */
export interface TaskDto {
  task_ref: TaskRef;
  symbol: string;
  status_type:
    | "TODO"
    | "IN_PROGRESS"
    | "ON_HOLD"
    | "DONE"
    | "CANCELLED"
    | "NON_TASK";
  text: string;
  tags: string[];
  section: string | null;
  created: string | null;
  start: string | null;
  scheduled: string | null;
  due: string | null;
  done: string | null;
  cancelled: string | null;
  priority: "highest" | "high" | "medium" | "none" | "low" | "lowest";
  recurrence: string | null;
  warnings: TaskWarning[];
}

/** Successful `patch_task`/`add_task` (spec §5/§6): `note_hash` is the
 *  whole-note hash right after the write; `spawned` is the recurrence
 *  occurrence the edit created, when it created one.
 *  `daily_recurrence_warning` is `add_task`-only (spec §9): the appended
 *  task carries a recurrence rule AND the target was a daily note — the
 *  documented anti-pattern. Advisory: surface as a
 *  `task_daily_recurrence_warning` toast, never block. */
export interface PatchTaskResult {
  note_hash: string;
  task: TaskDto;
  spawned: TaskDto | null;
  daily_recurrence_warning: boolean;
}

/** Proof of a successful `move_tasks` (spec §7) — sufficient for the
 *  guarded undo (proceeds only while both post-move hashes still
 *  match). */
export interface MoveTasksReceipt {
  source: MemoId;
  destination: MemoId;
  source_pre_hash: string;
  source_post_hash: string;
  destination_pre_hash: string | null;
  destination_post_hash: string;
  moved_lines: string[];
}

/** One non-overlapping splice: delete `delete_lines` lines starting at
 *  `start_line` (0-based) and insert `insert_lines` in their place.
 *  Empty `insert_lines` with `delete_lines: 0` is a pure insertion. */
export interface TaskLineChange {
  start_line: number;
  delete_lines: number;
  insert_lines: string[];
}

/** Pure kernel result (`transform_task_draft`): `spawned_line_hint` is
 *  the 0-based line, in the body AFTER applying `changes`, where a
 *  spawned recurrence occurrence landed — null when the edit spawned
 *  none (browser-mirror dispatches always report null; the mirror does
 *  not track the hint). */
export interface TaskDraftTransform {
  changes: TaskLineChange[];
  spawned_line_hint: number | null;
}

// --- Wire/mirror lockstep pins (compile-time only) ---------------------------
// types.ts owns the wire contract; taskLine.ts owns the browser mirror.
// Exported (not private) so `noUnusedLocals` never flags them; nothing
// should import these. If either side drifts, these assertions fail the
// build: every wire edit must stay acceptable input for the mirror's
// `editFromJson` adapter, and every TaskLineChange must keep the exact
// splice shape the mirror emits.

/** Asserts `U ⊆ T` at compile time. */
export type AssertSubset<T, U extends T> = U;

/** `TaskEdit` (wire) must remain assignable to what `editFromJson`
 *  accepts (`string | WireTaskEdit`). */
export type WireEditFeedsMirror = AssertSubset<string | WireTaskEdit, TaskEdit>;

/** `TaskLineChange` (wire) must accept the mirror's identical change
 *  shape — same field names, same primitives. */
export type LineChangeMatchesMirror = AssertSubset<MirrorLineChange, TaskLineChange>;
