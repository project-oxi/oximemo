/**
 * `invoke`/`listen` shim. In a Tauri shell it calls the native bridge; in plain
 * browser dev (e.g. `vite dev` without `tauri dev`) it falls back to a
 * localStorage-backed store so the full note flow (create → list → edit →
 * delete → search) is exercisable standalone. The browser store is a dev
 * convenience only — it never touches the real vault and is single-user.
 */
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";
import type { FolderCard, FolderEntry, Memo, MemoSummary } from "./types";
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
const VIEW_KEY = "oximemo:folderviews:v1";
const PINS_KEY = "oximemo:folderpins:v1";
const FOLDERS_KEY = "oximemo:folders:v1";
const CONFIG_KEY = "oximemo:config:v1";

/** Deep-merge `patch` into `target` (plain objects recurse; arrays and
 * scalars replace). Backs the localStorage config override below. */
function deepMergeConfig(target: Record<string, unknown>, patch: unknown): void {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return;
  for (const [k, v] of Object.entries(patch)) {
    const cur = target[k];
    if (
      typeof v === "object" && v !== null && !Array.isArray(v) &&
      typeof cur === "object" && cur !== null && !Array.isArray(cur)
    ) {
      deepMergeConfig(cur as Record<string, unknown>, v);
    } else {
      target[k] = v;
    }
  }
}

type FolderViews = Record<string, string>;

function loadViews(): FolderViews {
  try {
    return JSON.parse(localStorage.getItem(VIEW_KEY) ?? "{}") as FolderViews;
  } catch {
    return {};
  }
}

/** Folder paths the user has pinned to the sidebar favorites. */
function loadPins(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(PINS_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((p): p is string => typeof p === "string" && p !== "") : [];
  } catch {
    return [];
  }
}

function savePins(paths: string[]): void {
  localStorage.setItem(PINS_KEY, JSON.stringify(paths));
}

/** Folder paths created in browser mode. The backend derives folders from
 * the filesystem; here an explicit set backs create/delete of empty folders
 * (folders that hold notes are derived from the memo store). */
function loadFolders(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(FOLDERS_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((p): p is string => typeof p === "string" && p !== "") : [];
  } catch {
    return [];
  }
}

function saveFolders(paths: string[]): void {
  localStorage.setItem(FOLDERS_KEY, JSON.stringify(paths));
}

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

    case "open_daily_note": {
      const date = args?.date as string;
      // Round-trip check: `new Date("2026-02-30")` rolls over to a
      // valid Mar 2, so a NaN check never fires — ISO round-trip does.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date).toISOString().slice(0, 10) !== date) {
        throw new Error("invalid date, expected YYYY-MM-DD");
      }
      // Browser fallback: default daily folder, no file template access.
      const folder = "daily";
      const store = loadStore();
      const hit = Object.values(store).find(
        (n) =>
          !n.deleted_at &&
          (n.path === `${folder}/${date}.md` || n.path === `${folder}/${date}.html`),
      );
      if (hit) return hit;
      const now = new Date().toISOString();
      const memo: Memo = {
        id: crypto.randomUUID(),
        created_at: now,
        updated_at: now,
        hash: fakeHash(),
        favorite: false,
        folder,
        path: `${folder}/${date}.md`,
        format: "markdown",
        title: date,
        tags: [],
        body: `# ${date}\n`,
        deleted_at: null,
      };
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
        const folder = n.folder ?? "";
        folderMap.set(folder, (folderMap.get(folder) ?? 0) + 1);
      }
      for (const p of loadFolders()) if (!folderMap.has(p)) folderMap.set(p, 0);
      return [...folderMap.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([path, note_count]): FolderEntry => ({ path, note_count }));
    }

    case "folder_children": {
      const parent = ((args?.path as string | undefined) ?? "").trim();
      const live = liveSorted(loadStore());
      const entries = (await browserFallback("list_folders")) as FolderEntry[];
      const kids = entries.filter(
        (e) =>
          e.path !== "" &&
          (parent === ""
            ? !e.path.includes("/")
            : e.path.startsWith(`${parent}/`) &&
              !e.path.slice(parent.length + 1).includes("/")),
      );
      return kids.map((k): FolderCard => {
        const kp = `${k.path}/`;
        const inDeep = live.filter(
          (n) => (n.folder ?? "") === k.path || (n.folder ?? "").startsWith(kp),
        );
        return {
          path: k.path,
          note_count: k.note_count,
          note_count_deep: inDeep.length,
          subfolder_count: entries.filter(
            (e) => e.path.startsWith(kp) && !e.path.slice(kp.length).includes("/"),
          ).length,
          recent: inDeep.slice(0, 3).map((n) => ({
            id: n.id,
            title: n.title,
            updated_at: n.updated_at,
          })),
        };
      });
    }

    case "create_folder": {
      const path = (args?.path as string | undefined)?.trim();
      if (!path) throw new Error("folder path must not be empty");
      // Existence guard: the optimistic folder-create flow attaches a
      // naming session to the new folder and Esc/empty-commit tears it
      // down. If a folder with this name already exists, the teardown
      // would mass-trash whatever lived there. Backend `create_folder`
      // is authoritative (vault.rs `create_folder`); this browser-mode
      // fallback mirrors the same guard so dev-mode callers get the
      // same surface error string.
      const paths = loadFolders();
      if (paths.includes(path)) {
        throw new Error(`folder '${path}' already exists`);
      }
      const store = loadStore();
      const prefix = `${path}/`;
      const memoClash = Object.values(store).some(
        (n) =>
          (n.deleted_at === null || n.deleted_at === undefined) &&
          (n.folder === path ||
            (n.folder ?? "").startsWith(prefix) ||
            n.path === `${path}.md` ||
            n.path === `${path}.html` ||
            n.path.startsWith(prefix)),
      );
      if (memoClash) {
        throw new Error(`folder '${path}' already exists`);
      }
      paths.push(path);
      saveFolders(paths);
      emitBrowser("memos:changed");
      return null;
    }
    case "delete_folder": {
      const path = args?.path as string;
      if (!path) throw new Error("cannot delete vault root");
      const prefix = `${path}/`;
      const store = loadStore();
      const now = new Date().toISOString();
      const ids: string[] = [];
      for (const n of Object.values(store)) {
        const folder = n.folder ?? "";
        if (n.deleted_at === null && (folder === path || folder.startsWith(prefix))) {
          n.deleted_at = now;
          ids.push(n.id);
        }
      }
      saveStore(store);
      saveFolders(loadFolders().filter((p) => p !== path && !p.startsWith(prefix)));
      // Mirror the backend's FolderDef prune: drop the pin row + any
      // descendant pins for the deleted folder so the sidebar's pinned
      // section does not show ghost rows pointing at a missing path.
      savePins(loadPins().filter((p) => p !== path && !p.startsWith(prefix)));
      emitBrowser("memos:changed");
      return ids;
    }
    case "restore_notes": {
      const ids = (args?.ids as string[] | undefined) ?? [];
      const store = loadStore();
      const paths = loadFolders();
      const restored: string[] = [];
      for (const id of ids) {
        const n = store[id];
        if (!n) continue;
        n.deleted_at = null;
        restored.push(n.id);
        const folder = n.folder ?? "";
        if (folder && !paths.includes(folder)) paths.push(folder);
      }
      saveStore(store);
      saveFolders(paths);
      emitBrowser("memos:changed");
      return restored;
    }
    case "rename_folder": {
      renameFolderFallback(args?.from as string, args?.to as string);
      return null;
    }
    case "move_folder": {
      // Finder-semantics mirror of vault.rs move_folder: keep the
      // basename, guard cycles and parent no-ops client-side, then
      // delegate to the rename machinery for store/folder/view/pin
      // re-pathing (which carries the target-exists guard).
      const path = args?.path as string;
      const dest = ((args?.dest as string | undefined) ?? "").trim();
      if (!path) throw new Error("cannot move the vault root");
      if (dest === path || dest.startsWith(`${path}/`)) {
        throw new Error(`cannot move '${path}' into itself`);
      }
      const base = path.split("/").at(-1) ?? path;
      const to = dest ? `${dest}/${base}` : base;
      if (to === path) return null; // already lives at the destination
      renameFolderFallback(path, to);
      return null;
    }


    case "move_note": {
      const id = args?.id as string;
      const folder = ((args?.folder as string | undefined) ?? "").trim();
      const store = loadStore();
      const n = store[id];
      if (!n) throw new Error(`memo not found: ${id}`);
      const ext = n.format === "html" ? ".html" : ".md";
      const base = (n.title ?? `note-${Date.now()}`).replace(/[^\p{L}\p{N}]+/gu, "-");
      n.folder = folder;
      n.path = `${folder ? `${folder}/` : ""}${base}${ext}`;
      store[id] = n;
      saveStore(store);
      if (folder) {
        const paths = loadFolders();
        if (!paths.includes(folder)) {
          paths.push(folder);
          saveFolders(paths);
        }
      }
      // oldRel is derived; nothing else references it.
      emitBrowser("memos:changed");
      return n;
    }

    case "get_config": {
      const config: Record<string, unknown> = {
        schema_version: 3,
        general: { trash_retention_days: 30 },
        capture: { double_tap_threshold_ms: 350, overlay_max_height: 400 },
        appearance: { theme: "system", show_dock_icon: true },
        folders: [
          ...Object.entries(loadViews()).map(([path, view]) => ({ path, view, color: null,
            pinned: loadPins().includes(path) ? true : null })),
          ...loadPins().filter((p) => !Object.hasOwn(loadViews(), p)).map((path) => ({ path, view: null, color: null, pinned: true })),
        ],
        brain: { enabled: true, socket: "", space: "personal" },
        index: { watcher_debounce_ms: 300 },
      };
      // Dev/E2E override (e.g. { daily: { enabled: false } }) — browser
      // mode has no oximemo.toml, so gating needs a seeded surface.
      try {
        deepMergeConfig(config, JSON.parse(localStorage.getItem(CONFIG_KEY) ?? "null"));
      } catch {
        /* malformed override JSON is ignored */
      }
      return config;
    }
    case "set_brain_config":
    case "set_general_config":
    case "set_capture_config":
    case "set_index_config":
    case "set_appearance_config":
      return null;

    case "brain_list_spaces":
      // Browser preview has no daemon: offline is a normal state (C1).
      return { online: false, spaces: [] };


    case "set_folder_view": {
      const views = loadViews();
      const path = (args?.path as string | undefined) ?? "";
      const view = (args?.view as string | null | undefined) ?? null;
      if (view) views[path] = view;
      else delete views[path];
      localStorage.setItem(VIEW_KEY, JSON.stringify(views));
      return null;
    }

    case "set_folder_pinned": {
      const path = args?.path as string;
      const pinned = args?.pinned as boolean;
      const pins = loadPins();
      savePins(pinned ? (pins.includes(path) ? pins : [...pins, path]) : pins.filter((p) => p !== path));
      emitBrowser("memos:changed");
      return null;
    }


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

    default:
      return null;
  }
}

/** Browser-fallback rename/move core: re-path memo store rows, the
 * folder registry, per-folder views, and pins. Throws on invalid input
 * or when the target folder/memo path already exists (backend parity —
 * vault.rs rename_folder's to_dir.exists() guard). */
function renameFolderFallback(from: string, to: string) {
  if (!from || !to || from === to) throw new Error("invalid rename");
  {
    const paths = loadFolders();
    if (paths.includes(to)) {
      throw new Error(`folder '${to}' already exists`);
    }
    const store0 = loadStore();
    const memoClash = Object.values(store0).some(
      (n) =>
        (n.folder ?? "") === to ||
        (n.folder ?? "").startsWith(`${to}/`) ||
        n.path === `${to}.md` ||
        n.path === `${to}.html` ||
        n.path.startsWith(`${to}/`),
    );
    if (memoClash) {
      throw new Error(`folder '${to}' already exists`);
    }
  }
  const store = loadStore();
  for (const n of Object.values(store)) {
    if (n.folder === from) n.folder = to;
    else if (n.folder.startsWith(`${from}/`)) n.folder = `${to}/${n.folder.slice(from.length + 1)}`;
    if (n.folder === to && !n.path.startsWith(`${to}/`)) {
      n.path = `${to}/${n.path.split("/").pop()}`;
    } else if (n.path.startsWith(`${from}/`)) {
      n.path = `${to}/${n.path.slice(from.length + 1)}`;
    }
  }
  saveStore(store);
  saveFolders(
    loadFolders().map((p) =>
      p === from ? to : p.startsWith(`${from}/`) ? `${to}/${p.slice(from.length + 1)}` : p,
    ),
  );
  const views = loadViews();
  if (Object.hasOwn(views, from)) {
    views[to] = views[from];
    delete views[from];
  }
  localStorage.setItem(VIEW_KEY, JSON.stringify(views));
  savePins(loadPins().map((p) => (p === from ? to : p)));
  emitBrowser("memos:changed");
}