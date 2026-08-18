/**
 * `invoke`/`listen` shim. In a Tauri shell it calls the native bridge; in plain
 * browser dev (e.g. `vite dev` without `tauri dev`) it falls back to a
 * localStorage-backed store so the full note flow (create → list → edit →
 * delete → search) is exercisable standalone. The browser store is a dev
 * convenience only — it never touches the real vault and is single-user.
 */
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";
import type { FolderEntry, Memo, MemoSummary } from "./types";
import { extractTags } from "./tags";

const inTauri = "__TAURI_INTERNALS__" in window;

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!inTauri) {
    return browserFallback(cmd, args) as Promise<T>;
  }
  return tauriInvoke<T>(cmd, args);
}

// --- Browser-mode event bus ------------------------------------------------
// Mirrors the Rust `app.emit("memos:changed")` → JS `listen` path so the grid
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
const STORE_KEY = "oximemo:memos:v3";
const PREVIEW_MAX = 160;

function loadStore(): Record<string, Memo> {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}") as Record<string, Memo>;
  } catch {
    return {};
  }
}

function saveStore(memos: Record<string, Memo>): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(memos));
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

/** Extract first `# ...` H1 (md) or `<h1>` (html); null when untitled. */
function deriveTitle(body: string, format: "markdown" | "html" = "markdown"): string | null {
  if (format === "html") {
    const m = body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) ?? body.match(/<title>([\s\S]*?)<\/title>/i);
    return m ? m[1].replace(/<[^>]+>/g, "").trim() || null : null;
  }
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (t.startsWith("# ")) return t.slice(2).trim();
  }
  return null;
}

function summaryOf(n: Memo): MemoSummary {
  return {
    id: n.id,
    created_at: n.created_at,
    updated_at: n.updated_at,
    hash: n.hash,
    favorite: n.favorite,
    folder: n.folder,
    path: n.path,
    title: n.title,
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
function liveSorted(memos: Record<string, Memo>): Memo[] {
  return Object.values(memos)
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
    case "list_memos": {
      const after = (args?.after as string | null | undefined) ?? null;
      const limit = (args?.limit as number | undefined) ?? 50;
      const include = (args?.includeTags as string[] | undefined) ?? [];
      const exclude = (args?.excludeTags as string[] | undefined) ?? [];
      const matchAll = (args?.matchAll as boolean | undefined) ?? false;
      const folder = (args?.folder as string | null | undefined) ?? null;
      const favoritesOnly = (args?.favoritesOnly as boolean | undefined) ?? false;
      const has = (n: Memo, t: string) =>
        n.tags.some((x) => x.toLowerCase() === t.toLowerCase());
      const memos = liveSorted(loadStore()).filter((n) => {
        if (favoritesOnly && !n.favorite) return false;
        if (folder !== null && folder !== undefined && n.folder !== folder) return false;
        if (exclude.some((t) => has(n, t))) return false;
        if (include.length) {
          const ok = matchAll
            ? include.every((t) => has(n, t))
            : include.some((t) => has(n, t));
          if (!ok) return false;
        }
        return true;
      });
      let start = 0;
      if (after) {
        const sep = after.indexOf("|");
        const t = sep === -1 ? after : after.slice(0, sep);
        const id = sep === -1 ? "" : after.slice(sep + 1);
        const idx = memos.findIndex((n) => n.updated_at === t && n.id === id);
        start = idx === -1 ? memos.length : idx + 1;
      }
      const page = memos.slice(start, start + limit);
      const last = page.at(-1);
      const next_cursor =
        page.length > 0 && start + limit < memos.length && last
          ? `${last.updated_at}|${last.id}`
          : null;
      return { items: page.map(summaryOf), next_cursor };
    }

    case "search_memos": {
      const q = ((args?.query as string | undefined) ?? "").toLowerCase();
      const limit = (args?.limit as number | undefined) ?? 20;
      const memos = liveSorted(loadStore()).filter((n) =>
        n.body.toLowerCase().includes(q),
      );
      return memos.slice(0, limit).map(summaryOf);
    }

    case "get_memo": {
      const id = args?.id as string;
      const n = loadStore()[id];
      if (!n) throw new Error(`memo not found: ${id}`);
      return n;
    }

    case "create_memo": {
      const now = new Date().toISOString();
      const body = (args?.body as string | undefined) ?? "";
      const folder = (args?.folder as string | null | undefined) ?? "";
      const format = (args?.format as "markdown" | "html" | undefined) ?? "markdown";
      const title = deriveTitle(body, format);
      const ext = format === "html" ? ".html" : ".md";
      const base = (title ?? `note-${Date.now()}`).replace(/[^\p{L}\p{N}]+/gu, "-");
      const memo: Memo = {
        id: crypto.randomUUID(),
        created_at: now,
        updated_at: now,
        hash: fakeHash(),
        favorite: false,
        folder,
        path: `${folder ? `${folder}/` : ""}${base}${ext}`,
        format,
        title,
        tags: extractTags(body),
        body,
        deleted_at: null,
      };
      const store = loadStore();
      store[memo.id] = memo;
      saveStore(store);
      emitBrowser("memos:changed");
      return memo;
    }

    case "update_memo": {
      const id = args?.id as string;
      const store = loadStore();
      const n = store[id];
      if (!n) throw new Error(`memo not found: ${id}`);
      if (typeof args?.body === "string") {
        n.body = args.body;
        n.title = deriveTitle(n.body, n.format);
        n.tags = extractTags(n.body);
      }
      if (typeof args?.favorite === "boolean") n.favorite = args.favorite;
      n.updated_at = new Date().toISOString();
      n.hash = fakeHash();
      store[id] = n;
      saveStore(store);
      emitBrowser("memos:changed");
      return n;
    }

    case "delete_memo": {
      const id = args?.id as string;
      const store = loadStore();
      if (store[id]) {
        store[id].deleted_at = new Date().toISOString();
        saveStore(store);
        emitBrowser("memos:changed");
      }
      return null;
    }

    case "memo_stats": {
      const live = liveSorted(loadStore());
      return { memos: live.length, favorites: live.filter((n) => n.favorite).length };
    }
    case "list_facets": {
      const live = liveSorted(loadStore());
      const tagMap = new Map<string, number>();
      const folderMap = new Map<string, number>();
      for (const n of live) {
        for (const t of n.tags) tagMap.set(t, (tagMap.get(t) ?? 0) + 1);
        folderMap.set(n.folder, (folderMap.get(n.folder) ?? 0) + 1);
      }
      return {
        tags: [...tagMap.entries()].sort((a, b) => a[0].localeCompare(b[0])),
        folders: [...folderMap.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      };
    }

    case "vault_path":
      return "(browser preview · localStorage)";

    case "reindex":
      return { memos: 0, trashed_memos: 0, added: 0, updated: 0, unchanged: 0, failed: 0 };

    case "doctor":
      return {
        corrupt_frontmatter: [],
        orphan_index_records: [],
        orphan_files: [],
        hash_mismatches: [],
        hash_repair_failed: 0,
        index_locked: false,
        trash_expiring: 0,
        vault_ok: true,
      };

    case "list_folders": {
      const live = liveSorted(loadStore());
      const folderMap = new Map<string, number>();
      for (const n of live) {
        folderMap.set(n.folder, (folderMap.get(n.folder) ?? 0) + 1);
      }
      return [...folderMap.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([path, note_count]): FolderEntry => ({ path, note_count }));
    }

    case "create_folder":
      return null;
    case "delete_folder":
      emitBrowser("memos:changed");
      return null;

    case "move_note":
      emitBrowser("memos:changed");
      return null;

    case "graph_data":
      return { nodes: [], edges: [] };

    case "get_config":
      return { schema_version: 3, folders: [] };

    case "set_folder_view":
      return null;

    case "brain_status":
      // Browser preview has no daemon: offline is a normal state.
      return { online: false };
    case "brain_gather":
      throw new Error("Brain is offline");

    case "install_cli":
    case "uninstall_cli":
      throw new Error("CLI setup is only available in the desktop app");

    case "cli_status":
      return "not-installed";
    case "install_cli":
    case "uninstall_cli":
      throw new Error("CLI setup is only available in the desktop app");

    default:
      return null;
  }
}