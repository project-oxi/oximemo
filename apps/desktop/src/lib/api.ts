/**
 * Type-safe adapter for the Tauri IPC commands defined in `src-tauri/src/lib.rs`.
 * Falls back to a no-op implementation when running in plain browser mode
 * (e.g. `vite dev` without the Tauri shell) so the UI can be developed
 * standalone.
 */
import { invoke } from "./tauri";
import type { Note, NoteSummary, IndexStats, DoctorReport, NoteStats, Facets, CategoryDef } from "./types";

export async function listNotes(
  after: string | null,
  limit = 50,
  filter: {
    include_tags?: string[];
    exclude_tags?: string[];
    match_all?: boolean;
    categories?: string[];
    pinned_only?: boolean;
  } = {},
) {
  return invoke<{ items: NoteSummary[]; next_cursor: string | null }>("list_notes", {
    after,
    limit,
    include_tags: filter.include_tags ?? [],
    exclude_tags: filter.exclude_tags ?? [],
    match_all: filter.match_all ?? false,
    categories: filter.categories ?? [],
    pinned_only: filter.pinned_only ?? false,
  });
}

export async function getNote(id: string) {
  return invoke<Note>("get_note", { id });
}

export async function createNote(body: string, category: string | null) {
  return invoke<Note>("create_note", { body, category });
}

export async function updateNote(
  id: string,
  body: string | null,
  pinned: boolean | null,
  category: string | null,
) {
  return invoke<Note>("update_note", { id, body, pinned, category });
}

export async function listFacets() {
  return invoke<Facets>("list_facets");
}

export async function deleteNote(id: string) {
  return invoke<void>("delete_note", { id });
}

export async function searchNotes(query: string, limit = 20) {
  return invoke<NoteSummary[]>("search_notes", { query, limit });
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

export async function noteStats() {
  return invoke<NoteStats>("note_stats");
}

export async function listCategories() {
  return invoke<CategoryDef[]>("list_categories");
}

/** NOTE: `create_category` only works in browser dev mode (mock).
 *  The real Tauri backend lacks `VaultConfig::save` — this command is blocked
 *  until core supports durable category mutation. */
export async function createCategory(id: string, color: string | null) {
  return invoke<CategoryDef>("create_category", { id, color });
}
