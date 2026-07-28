/**
 * Type-safe adapter for the Tauri IPC commands defined in `src-tauri/src/lib.rs`.
 * Falls back to a no-op implementation when running in plain browser mode
 * (e.g. `vite dev` without the Tauri shell) so the UI can be developed
 * standalone.
 */
import { invoke } from "./tauri";
import type { Note, NoteSummary, IndexStats, DoctorReport } from "./types";

export async function listNotes(after: string | null, limit = 50, tag: string | null = null) {
  return invoke<{ items: NoteSummary[]; next_cursor: string | null }>("list_notes", {
    after,
    limit,
    tag,
  });
}

export async function getNote(id: string) {
  return invoke<Note>("get_note", { id });
}

export async function createNote(body: string, tags: string[], color: string | null) {
  return invoke<Note>("create_note", { body, tags, color });
}

export async function updateNote(
  id: string,
  body: string | null,
  tags: string[] | null,
  pinned: boolean | null,
  color: string | null,
) {
  return invoke<Note>("update_note", { id, body, tags, pinned, color });
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
