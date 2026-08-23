/** Shared types mirroring the Rust core. */

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

export type ViewMode = "grid" | "list" | "timeline" | "graph" | "shelf";

export interface FolderDef {
  path: string;
  view?: ViewMode;
  color?: string;
  pinned?: boolean;
}

export interface Config {
  schema_version: number;
  general?: { trash_retention_days?: number };
  capture?: { double_tap_threshold_ms?: number; overlay_max_height?: number };
  appearance?: { theme?: "system" | "light" | "dark"; show_dock_icon?: boolean };
  folders?: FolderDef[];
  brain?: { enabled?: boolean; socket?: string; space?: string };
  daily?: { enabled?: boolean; folder?: string };
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
