/** Shared types mirroring the Rust core. */

export type MemoId = string;

export type NoteFormat = "markdown" | "html";

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
  deleted_at: string | null;
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
  preview: string;
  deleted: boolean;
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

export type ViewMode = "grid" | "list" | "timeline" | "graph";

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
