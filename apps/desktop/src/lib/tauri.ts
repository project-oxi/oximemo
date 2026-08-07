/**
 * `invoke`/`listen` shim. In a Tauri shell it calls the native bridge; in plain
 * browser dev (e.g. `vite dev` without `tauri dev`) it falls back to a
 * localStorage-backed store so the full memo flow (create → list → edit →
 * delete → search) is exercisable standalone. The browser store is a dev
 * convenience only — it never touches the real vault and is single-user.
 */
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Memo, MemoSummary } from "./types";
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
const STORE_KEY = "oximemo:memos:v1";
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

function summaryOf(n: Memo): MemoSummary {
  return {
    id: n.id,
    created_at: n.created_at,
    updated_at: n.updated_at,
    hash: n.hash,
    favorite: n.favorite,
    category: n.category,
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
      const categories = (args?.categories as string[] | undefined) ?? [];
      const favoritesOnly = (args?.favoritesOnly as boolean | undefined) ?? false;
      const has = (n: Memo, t: string) =>
        n.tags.some((x) => x.toLowerCase() === t.toLowerCase());
      const memos = liveSorted(loadStore()).filter((n) => {
        if (favoritesOnly && !n.favorite) return false;
        if (categories.length && !categories.includes(n.category)) return false;
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
      const memo: Memo = {
        id: crypto.randomUUID(),
        created_at: now,
        updated_at: now,
        hash: fakeHash(),
        favorite: false,
        category: (args?.category as string | null | undefined) ?? "",
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
        n.tags = extractTags(n.body);
      }
      if (typeof args?.favorite === "boolean") n.favorite = args.favorite;
      if (typeof args?.category === "string") n.category = args.category;
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
      const catMap = new Map<string, number>();
      for (const n of live) {
        for (const t of n.tags) tagMap.set(t, (tagMap.get(t) ?? 0) + 1);
        if (n.category) catMap.set(n.category, (catMap.get(n.category) ?? 0) + 1);
      }
      return {
        tags: [...tagMap.entries()].sort((a, b) => a[0].localeCompare(b[0])),
        categories: [...catMap.entries()].sort((a, b) => a[0].localeCompare(b[0])),
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

    case "list_categories":
      return [
        { id: "inbox", color: "oklch(0.78 0.02 250)", builtin: true },
        { id: "todo", color: "oklch(0.78 0.15 75)", builtin: true },
        { id: "idea", color: "oklch(0.72 0.15 310)", builtin: true },
        { id: "bookmark", color: "oklch(0.75 0.12 195)", builtin: true },
        { id: "snippet", color: "oklch(0.75 0.13 145)", builtin: true },
      ];

    case "create_category": {
      const id = String(args?.id ?? "").trim().toLowerCase();
      if (!id) throw new Error("category id must not be empty");
      // Builtins from list_categories
      const builtins: Array<{ id: string }> = [
        { id: "inbox" },
        { id: "todo" },
        { id: "idea" },
        { id: "bookmark" },
        { id: "snippet" },
      ];
      if (builtins.some((c) => c.id === id))
        throw new Error(`category '${id}' already exists`);
      const color = (args?.color as string | null | undefined) ?? "oklch(0.78 0.02 250)";
      return { id, color, builtin: false };
    }

    case "update_category": {
      const id = String(args?.id ?? "").trim().toLowerCase();
      if (!id) throw new Error("category id must not be empty");
      emitBrowser("memos:changed");
      return null;
    }

    case "rename_category": {
      const oldId = String(args?.old ?? "").trim().toLowerCase();
      const newId = String(args?.new ?? "").trim().toLowerCase();
      if (!oldId || !newId) throw new Error("category id must not be empty");
      const store = loadStore();
      let migrated = 0;
      for (const n of Object.values(store)) {
        if (n.category === oldId) {
          n.category = newId;
          n.updated_at = new Date().toISOString();
          n.hash = fakeHash();
          migrated++;
        }
      }
      if (migrated > 0) saveStore(store);
      emitBrowser("memos:changed");
      return migrated;
    }

    case "delete_category": {
      const id = String(args?.id ?? "").trim().toLowerCase();
      if (!id) throw new Error("category id must not be empty");
      emitBrowser("memos:changed");
      return null;
    }

    case "cli_status":
      // CLI is never installed in browser/dev mode.
      return "not-installed";
    case "install_cli":
    case "uninstall_cli":
      throw new Error("CLI setup is only available in the desktop app");

    default:
      return null;
  }
}
