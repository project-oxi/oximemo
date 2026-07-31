/** Shared types mirroring the Rust core. */

export type MemoId = string;

export interface Memo {
  id: MemoId;
  created_at: string;
  updated_at: string;
  hash: string;
  pinned: boolean;
  category: string;
  tags: string[];
  body: string;
  deleted_at: string | null;
}

export interface MemoSummary {
  id: MemoId;
  created_at: string;
  updated_at: string;
  hash: string;
  pinned: boolean;
  category: string;
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
  hash_repair_failed: number;
  index_locked: boolean;
  trash_expiring: number;
  vault_ok: boolean;
}

export interface MemoStats {
  memos: number;
  pinned: number;
}

export interface Facets {
  tags: [string, number][];
  categories: [string, number][];
}

export interface CategoryDef {
  id: string;
  color: string;
  builtin: boolean;
}
