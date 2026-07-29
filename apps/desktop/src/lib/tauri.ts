/**
 * `invoke` shim. In a Tauri shell it calls the native bridge; in plain
 * browser dev (e.g. `vite dev` without `tauri dev`) it returns a sane
 * placeholder so the UI renders.
 */
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";

const inTauri = "__TAURI_INTERNALS__" in window;

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!inTauri) {
    return browserFallback(cmd, args) as Promise<T>;
  }
  return tauriInvoke<T>(cmd, args);
}

export async function listen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  if (!inTauri) {
    return async () => {};
  }
  return tauriListen<T>(event, (e) => handler(e.payload));
}

async function browserFallback(_cmd: string, _args?: Record<string, unknown>): Promise<unknown> {
  switch (_cmd) {
    case "list_notes":
      return { items: [], next_cursor: null };
    case "search_notes":
      return [];
    case "vault_path":
      return "(browser preview)";
    case "reindex":
      return { notes: 0, trashed: 0, added: 0, updated: 0, unchanged: 0, failed: 0 };
    case "doctor":
      return {
        corrupt_frontmatter: [],
        orphan_index_records: [],
        orphan_files: [],
        hash_mismatches: [],
        invalid_colors: [],
        index_locked: false,
        trash_expiring: 0,
        vault_ok: true,
      };
    case "create_note":
    case "get_note":
    case "update_note": {
      const now = new Date().toISOString();
      return {
        id: String(_args?.id ?? crypto.randomUUID()),
        created_at: now,
        updated_at: now,
        hash: "b3:0000000000000000",
        pinned: false,
        color: "",
        tags: [],
        body: "",
        deleted_at: null,
      };
    }
    case "note_stats":
      return { notes: 0, pinned: 0 };
    default:
      return null;
  }
}
