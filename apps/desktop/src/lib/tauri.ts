/**
 * `invoke`/`listen` shim. In a Tauri shell it calls the native bridge; in plain
 * browser dev (e.g. `vite dev` without `tauri dev`) it falls back to a
 * localStorage-backed store so the full note flow (create → list → edit →
 * delete → search) is exercisable standalone. The browser store is a dev
 * convenience only — it never touches the real vault and is single-user.
 */
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Note, NoteSummary } from "./types";

const inTauri = "__TAURI_INTERNALS__" in window;

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!inTauri) {
    return browserFallback(cmd, args) as Promise<T>;
  }
  return tauriInvoke<T>(cmd, args);
}

// --- Browser-mode event bus ------------------------------------------------
// Mirrors the Rust `app.emit("notes:changed")` → JS `listen` path so the grid
// refreshes after a create/update/delete even without the Tauri shell.
const browserListeners = new Map<string, Set<(payload: unknown) => void>>();

function emitBrowser(event: string, payload?: unknown): void {
  browserListeners.get(event)?.forEach((h) => {
    try {
      h(payload);
    } catch {
      /* a faulty listener must not break its siblings */
    }
  });
}

export async function listen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  if (!inTauri) {
    let set = browserListeners.get(event);
    if (!set) {
      set = new Set();
      browserListeners.set(event, set);
    }
    const wrapped = (p: unknown) => handler(p as T);
    set.add(wrapped);
    return async () => {
      browserListeners.get(event)?.delete(wrapped);
    };
  }
  return tauriListen<T>(event, (e) => handler(e.payload));
}

// --- Browser-mode localStorage store --------------------------------------
const STORE_KEY = "oxinot:notes:v1";
const PREVIEW_MAX = 160;

function loadStore(): Record<string, Note> {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}") as Record<string, Note>;
  } catch {
    return {};
  }
}

function saveStore(notes: Record<string, Note>): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(notes));
}

/** Match core's `make_preview`: non-empty trimmed lines joined by one space,
 *  truncated on a char boundary with an ellipsis. */
function makePreview(body: string): string {
  const joined = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join(" ");
  const chars = [...joined];
  if (chars.length <= PREVIEW_MAX) return joined;
  return chars.slice(0, PREVIEW_MAX - 1).join("") + "\u2026";
}

function summaryOf(n: Note): NoteSummary {
  return {
    id: n.id,
    created_at: n.created_at,
    updated_at: n.updated_at,
    hash: n.hash,
    pinned: n.pinned,
    color: n.color,
    tags: n.tags,
    preview: makePreview(n.body),
    deleted: n.deleted_at !== null,
  };
}

function fakeHash(): string {
  const hex = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return "b3:" + hex;
}

/** Live notes, newest-first (updated_at desc, id desc as a stable tie-break). */
function liveSorted(notes: Record<string, Note>): Note[] {
  return Object.values(notes)
    .filter((n) => n.deleted_at === null)
    .sort(
      (a, b) => b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id),
    );
}

async function browserFallback(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  switch (cmd) {
    case "list_notes": {
      const after = (args?.after as string | null | undefined) ?? null;
      const limit = (args?.limit as number | undefined) ?? 50;
      const tag = (args?.tag as string | null | undefined) ?? null;
      const pinnedOnly = (args?.pinned_only as boolean | undefined) ?? false;
      const notes = liveSorted(loadStore()).filter(
        (n) => (!tag || n.tags.includes(tag)) && (!pinnedOnly || n.pinned),
      );
      let start = 0;
      if (after) {
        const sep = after.indexOf("|");
        const t = sep === -1 ? after : after.slice(0, sep);
        const id = sep === -1 ? "" : after.slice(sep + 1);
        const idx = notes.findIndex((n) => n.updated_at === t && n.id === id);
        start = idx === -1 ? notes.length : idx + 1;
      }
      const page = notes.slice(start, start + limit);
      const last = page.at(-1);
      const next_cursor =
        page.length > 0 && start + limit < notes.length && last
          ? `${last.updated_at}|${last.id}`
          : null;
      return { items: page.map(summaryOf), next_cursor };
    }

    case "search_notes": {
      const q = ((args?.query as string | undefined) ?? "").toLowerCase();
      const limit = (args?.limit as number | undefined) ?? 20;
      const notes = liveSorted(loadStore()).filter((n) =>
        n.body.toLowerCase().includes(q),
      );
      return notes.slice(0, limit).map(summaryOf);
    }

    case "get_note": {
      const id = args?.id as string;
      const n = loadStore()[id];
      if (!n) throw new Error(`note not found: ${id}`);
      return n;
    }

    case "create_note": {
      const now = new Date().toISOString();
      const note: Note = {
        id: crypto.randomUUID(),
        created_at: now,
        updated_at: now,
        hash: fakeHash(),
        pinned: false,
        color: (args?.color as string | null | undefined) ?? "",
        tags: (args?.tags as string[] | undefined) ?? [],
        body: (args?.body as string | undefined) ?? "",
        deleted_at: null,
      };
      const store = loadStore();
      store[note.id] = note;
      saveStore(store);
      emitBrowser("notes:changed");
      return note;
    }

    case "update_note": {
      const id = args?.id as string;
      const store = loadStore();
      const n = store[id];
      if (!n) throw new Error(`note not found: ${id}`);
      if (typeof args?.body === "string") n.body = args.body;
      if (Array.isArray(args?.tags)) n.tags = args.tags as string[];
      if (typeof args?.pinned === "boolean") n.pinned = args.pinned;
      if (typeof args?.color === "string") n.color = args.color;
      n.updated_at = new Date().toISOString();
      n.hash = fakeHash();
      store[id] = n;
      saveStore(store);
      emitBrowser("notes:changed");
      return n;
    }

    case "delete_note": {
      const id = args?.id as string;
      const store = loadStore();
      if (store[id]) {
        store[id].deleted_at = new Date().toISOString();
        saveStore(store);
        emitBrowser("notes:changed");
      }
      return null;
    }

    case "note_stats": {
      const live = liveSorted(loadStore());
      return { notes: live.length, pinned: live.filter((n) => n.pinned).length };
    }

    case "vault_path":
      return "(browser preview · localStorage)";

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

    default:
      return null;
  }
}
