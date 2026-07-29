/** Shared types mirroring the Rust core. */

export type NoteId = string;

export interface Note {
  id: NoteId;
  created_at: string;
  updated_at: string;
  hash: string;
  pinned: boolean;
  color: string;
  tags: string[];
  body: string;
  deleted_at: string | null;
}

export interface NoteSummary {
  id: NoteId;
  created_at: string;
  updated_at: string;
  hash: string;
  pinned: boolean;
  color: string;
  tags: string[];
  preview: string;
  deleted: boolean;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export interface IndexStats {
  notes: number;
  trashed: number;
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
  invalid_colors: string[];
  index_locked: boolean;
  trash_expiring: number;
  vault_ok: boolean;
}

export interface NoteStats {
  notes: number;
  pinned: number;
}
