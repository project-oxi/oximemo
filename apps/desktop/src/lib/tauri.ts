/**
 * `invoke`/`listen` shim. In a Tauri shell it calls the native bridge; in plain
 * browser dev (e.g. `vite dev` without `tauri dev`) it falls back to a
 * localStorage-backed store so the full note flow (create → list → edit →
 * delete → search) is exercisable standalone. The browser store is a dev
 * convenience only — it never touches the real vault and is single-user.
 */
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";
import type { FolderCard, FolderEntry, FolderSchema, Memo, MemoSummary } from "./types";
import { extractTags } from "./tags";

// `typeof window` guard keeps the module importable outside the browser
// (bun tests): the fallback branch below never runs there.
const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

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

/** `Vault::migrate` parity (browser fallback): the knowledge folder
 *  ships with the vault — macOS system-folder semantics. Recreated
 *  when deleted; user-edited schemas are never overwritten (the
 *  registration below only fills the absent key). */
function ensureDefaultFolders(): void {
  if (typeof localStorage === "undefined") return; // bun/node test env
  try {
    const folders = loadFolders();
    if (!folders.includes("knowledge")) {
      folders.push("knowledge");
      saveFolders(folders);
    }
    const schemas = loadSchemas();
    if (!schemas.knowledge) {
      schemas.knowledge = KNOWLEDGE_PRESET_SCHEMA;
    }
    if (!schemas.daily) {
      schemas.daily = DAILY_PRESET_SCHEMA;
    }
    if (schemas.knowledge || schemas.daily) {
      localStorage.setItem("oximemo:schemas", JSON.stringify(schemas));
    }
  } catch {
    // Corrupt store — skip; the desktop app owns the real migration.
  }
}
const PREVIEW_MAX = 280;

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

function loadSchemas(): Record<string, FolderSchema> {
  try {
    return JSON.parse(localStorage.getItem("oximemo:schemas") ?? "{}") as Record<
      string,
      FolderSchema
    >;
  } catch {
    return {};
  }
}

/** JS mirror of the knowledge preset's SCHEMA.toml (design §6.3) so the
 *  browser fallback can exercise badges, chips, and the review queue. */
const KIND_OPTIONS = ["note", "knowledge", "daily", "book", "movie", "blog", "novel", "idea"];

const KNOWLEDGE_PRESET_SCHEMA: FolderSchema = {
  meta: { preset: "knowledge" },
  workspace: { name: "지식" },
  properties: {
    kind: { prop_type: "select", options: KIND_OPTIONS },
    status: {
      prop_type: "select",
      options: ["stub", "vague", "understood", "mastered", "decayed"],
      required: true,
      badge: true,
      colors: {
        stub: "neutral",
        vague: "muted",
        understood: "info",
        mastered: "success",
        decayed: "warning",
      },
    },
    peak_status: { prop_type: "select", options: ["understood", "mastered"] },
    domain: {
      prop_type: "select",
      options: ["SCI", "MATH", "TECH", "SOC", "CULT", "HIST", "FIN"],
      required: true,
    },
    subdomain: {
      prop_type: "multiselect",
      options: ["SW", "AI", "DATA", "SEC", "HW", "SYS"],
    },
    aliases: { prop_type: "multiselect" },
    related: { prop_type: "multiselect" },
    source: { prop_type: "text" },
    status_changed: { prop_type: "date" },
  },
  transitions: [
    {
      key: "status",
      to: ["understood", "mastered"],
      copy_from: "status",
      into: "peak_status",
      merge: "Max",
    },
    {
      key: "status",
      to: ["stub", "vague", "understood", "mastered", "decayed"],
      on: "Write",
      stamp_date: "status_changed",
    },
  ],
  review: {
    property: "status",
    due_values: ["understood", "mastered"],
    order_by: "status_changed",
    decay_to: "decayed",
  },
};

/** JS mirror of the daily preset's SCHEMA.toml (user prompt 2026-08-23):
 *  kind + mood (badge → calendar dot colors) + energy, all optional. */
const DAILY_PRESET_SCHEMA: FolderSchema = {
  meta: { preset: "daily" },
  workspace: { name: "데일리" },
  properties: {
    kind: { prop_type: "select", options: KIND_OPTIONS },
    mood: {
      prop_type: "select",
      options: ["great", "good", "okay", "low", "bad"],
      badge: true,
      colors: {
        great: "success",
        good: "info",
        okay: "neutral",
        low: "warning",
        bad: "error",
      },
    },
    energy: { prop_type: "select", options: ["high", "medium", "low"] },
  },
};

/** JS mirrors of the five installable collection presets (spec
 *  2026-08-23 §2.2) — schema seeding only; the fallback has no file
 *  templates, so kind/status stamping on creation stays desktop-only. */
const BOOK_PRESET_SCHEMA: FolderSchema = {
  meta: { preset: "book" },
  workspace: { name: "책" },
  properties: {
    kind: { prop_type: "select", options: KIND_OPTIONS },
    status: {
      prop_type: "select",
      options: ["reading", "done", "paused", "abandoned"],
      badge: true,
      colors: { reading: "info", done: "success", paused: "neutral", abandoned: "muted" },
    },
    rating: { prop_type: "select", options: ["1", "2", "3", "4", "5"] },
    author: { prop_type: "text", metadata: "author" },
    isbn: { prop_type: "text", metadata: "isbn" },
    published_date: { prop_type: "text", metadata: "published_date" },
    page_count: { prop_type: "text", metadata: "page_count" },
    source_url: { prop_type: "text" },
    cover_url: { prop_type: "text" },
  },
  review: { property: "status", due_values: ["done"], decay_to: "reading" },
};

const MOVIE_PRESET_SCHEMA: FolderSchema = {
  meta: { preset: "movie" },
  workspace: { name: "영화" },
  properties: {
    kind: { prop_type: "select", options: KIND_OPTIONS },
    watched_at: { prop_type: "date" },
    rating: { prop_type: "select", options: ["1", "2", "3", "4", "5"] },
    series: { prop_type: "bool" },
    director: { prop_type: "text", metadata: "director" },
    release_date: { prop_type: "text", metadata: "release_date" },
    runtime_min: { prop_type: "text", metadata: "runtime_min" },
    original_title: { prop_type: "text", metadata: "original_title" },
    source_url: { prop_type: "text" },
    cover_url: { prop_type: "text" },
  },
};

const BLOG_PRESET_SCHEMA: FolderSchema = {
  meta: { preset: "blog" },
  workspace: { name: "블로그" },
  properties: {
    kind: { prop_type: "select", options: KIND_OPTIONS },
    status: {
      prop_type: "select",
      options: ["draft", "revising", "scheduled", "published"],
      badge: true,
      colors: { draft: "neutral", revising: "warning", scheduled: "info", published: "success" },
    },
    platform: { prop_type: "text" },
    published_at: { prop_type: "date" },
  },
};

const NOVEL_PRESET_SCHEMA: FolderSchema = {
  meta: { preset: "novel" },
  workspace: { name: "집필" },
  properties: {
    kind: { prop_type: "select", options: KIND_OPTIONS },
    status: {
      prop_type: "select",
      options: ["outline", "draft", "rev1", "done"],
      badge: true,
      colors: { outline: "neutral", draft: "info", rev1: "warning", done: "success" },
    },
  },
};

const IDEA_PRESET_SCHEMA: FolderSchema = {
  meta: { preset: "idea" },
  workspace: { name: "아이디어" },
  properties: {
    kind: { prop_type: "select", options: KIND_OPTIONS },
    status: {
      prop_type: "select",
      options: ["fleeting", "archived"],
      badge: true,
      colors: { fleeting: "info", archived: "neutral" },
    },
    source: { prop_type: "text" },
  },
  review: {
    property: "status",
    due_values: ["fleeting"],
    decay_to: "archived",
    promote: { into: "knowledge", kind: "knowledge", start_status: "stub" },
  },
};

/** Fallback mirror of core's `collection_preset` registry (spec §2). */
const COLLECTION_PRESET_SCHEMAS: Record<string, FolderSchema> = {
  knowledge: KNOWLEDGE_PRESET_SCHEMA,
  daily: DAILY_PRESET_SCHEMA,
  book: BOOK_PRESET_SCHEMA,
  movie: MOVIE_PRESET_SCHEMA,
  blog: BLOG_PRESET_SCHEMA,
  novel: NOVEL_PRESET_SCHEMA,
  idea: IDEA_PRESET_SCHEMA,
};
ensureDefaultFolders();

/** Match core's `make_preview`: non-empty trimmed lines joined by newlines
 *  (so previews keep the user's line breaks), truncated on a char boundary. */
function makePreview(body: string): string {
  const joined = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n");
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
    props: n.props ?? {},
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
    // --- copilot (spec 2026-08-23): browser smoke mirrors the activated
    // state so the panel/consent surfaces are exercisable without a
    // Tauri shell. No subprocess ever runs here.
    case "copilot_status":
      return {
        enabled: true,
        activated: true,
        agent: "oxios",
        agent_name: "Oxios",
        busy: false,
      };
    case "copilot_probe_agents":
      return [
        {
          id: "oxios",
          display_name: "Oxios",
          executable: "/opt/homebrew/bin/oxios",
          version: "oxios 0.66.0",
          supported: true,
        },
        {
          id: "omp",
          display_name: "Oh My Pi",
          executable: "/Users/demo/.bun/bin/omp",
          version: "omp/18.0.1",
          supported: true,
        },
        {
          id: "claude",
          display_name: "Claude Code",
          executable: "/usr/local/bin/claude",
          version: "1.0.0",
          supported: false,
        },
      ];
    case "copilot_disclosure":
      return {
        agent: (args?.agent as string) ?? "oxios",
        model: "zai-coding-plan/glm-5-turbo",
        provider: "zai-coding-plan",
      };
    case "copilot_activate":
      return {
        agent: args?.agent ?? "oxios",
        model: "zai-coding-plan/glm-5-turbo",
        provider: "zai-coding-plan",
      };
    case "copilot_models":
      return [
        {
          id: "zai-coding-plan/GLM-5-Turbo",
          name: "GLM-5-Turbo",
          provider: "zai-coding-plan",
          context_window: 200000,
        },
        {
          id: "zai-coding-plan/GLM-5.2",
          name: "GLM-5.2",
          provider: "zai-coding-plan",
          context_window: 1000000,
        },
        {
          id: "zai-coding-plan/GLM-4.5-Air",
          name: "GLM-4.5-Air",
          provider: "zai-coding-plan",
          context_window: 131000,
        },
      ];
    case "copilot_set_model":
      return {
        agent: "oxios",
        model: (args?.model as string) ?? "",
        provider: "zai-coding-plan",
      };
    case "set_copilot_config":
      return null;
    case "copilot_cancel":
      return true;
    case "copilot_send": {
      const msg = (args?.message as string) ?? "";
      const memo = args?.activeMemo as { selection?: string | null } | null;
      const changed = liveSorted(loadStore())[0];
      return {
        response: `(browser fallback) received: ${msg}${memo?.selection ? " +selection" : ""}`,
        session_id: "browser-session",
        exit_code: 0,
        signal: null,
        stderr: "",
        timed_out: false,
        changed: changed
          ? [{ id: changed.id, kind: "changed" as const }]
          : [],
        duration_ms: 42,
        model: "glm-5.2",
        provider: "zai",
      };
    }
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
        props: {},
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
      if (hit) return { memo: hit, created: false };
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
        props: { kind: { Str: "daily" } },
        deleted_at: null,
      };
      store[memo.id] = memo;
      saveStore(store);
      emitBrowser("memos:changed");
      return { memo, created: true };
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
      // Property diff (design §5.1). Browser fallback skips schema
      // transitions — desktop-only surface, same boundary as backlinks.
      const pm = args?.props as { sets?: [string, unknown][]; removes?: string[] } | null | undefined;
      if (pm) {
        n.props = n.props ?? {};
        for (const k of pm.removes ?? []) delete n.props[k];
        for (const [k, v] of pm.sets ?? []) n.props[k] = v as Memo["props"][string];
      }
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

    // --- Property engine (design 2026-08-23 §7.5: minimal fallback) ---------

    case "query_notes": {
      const limit = (args?.limit as number | undefined) ?? 50;
      const offset = (args?.offset as number | undefined) ?? 0;
      const filter = args?.filter as { folder?: string | null; favorites_only?: boolean } | null;
      const preds = (args?.props as {
        key: string;
        op: string;
        values: string[];
      }[]) ?? [];
      const sort = args?.sort as string | { PropAsc: string } | null | undefined;
      const propStr = (v: unknown): string =>
        v == null
          ? ""
          : typeof v === "object" && "Str" in (v as object)
            ? String((v as { Str: string }).Str)
            : typeof v === "object" && "List" in (v as object)
              ? ((v as { List: string[] }).List[0] ?? "")
              : String(v);
      let memos = liveSorted(loadStore());
      if (filter?.folder !== null && filter?.folder !== undefined)
        memos = memos.filter((n) => n.folder === filter.folder);
      if (filter?.favorites_only) memos = memos.filter((n) => n.favorite);
      for (const p of preds) {
        memos = memos.filter((n) => {
          const v = (n.props ?? {})[p.key];
          const members =
            v && typeof v === "object" && "List" in v
              ? (v as { List: string[] }).List
              : v !== undefined
                ? [propStr(v)]
                : [];
          return members.some((m) => p.values.includes(m));
        });
      }
      if (typeof sort === "string" && sort === "UpdatedAsc")
        memos = [...memos].reverse();
      if (typeof sort === "object" && sort !== null && "PropAsc" in sort) {
        const key = sort.PropAsc;
        memos = [...memos].sort((a, b) =>
          propStr((a.props ?? {})[key]).localeCompare(propStr((b.props ?? {})[key])),
        );
      }
      const total = memos.length;
      return { items: memos.slice(offset, offset + limit).map(summaryOf), total };
    }

    case "folder_schema": {
      const folder = args?.folder as string;
      const schemas = loadSchemas();
      return schemas[folder] ?? null;
    }
    case "install_collection": {
      const presetId = (args?.presetId as string) ?? "";
      const folder = (args?.folder as string) ?? "";
      const preset = COLLECTION_PRESET_SCHEMAS[presetId];
      if (!preset) {
        return Promise.reject(new Error(`unknown collection preset: ${presetId}`));
      }
      if (folder && !loadFolders().includes(folder)) {
        saveFolders([...loadFolders(), folder]);
      }
      const schemas = loadSchemas();
      if (!schemas[folder]) {
        schemas[folder] = preset;
        localStorage.setItem("oximemo:schemas", JSON.stringify(schemas));
      }
      emitBrowser("memos:changed");
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
        merge_required: false,
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
      // Drop the folder's cached SCHEMA.toml too — a leftover entry
      // would keep reporting the preset marker for a deleted folder.
      const schemas = loadSchemas();
      delete schemas[path];
      localStorage.setItem("oximemo:schemas", JSON.stringify(schemas));
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
        daily: { enabled: true, folder: "daily" },
        metadata: { enabled: true, region: "", google_books_key: "", aladin_key: "", tmdb_key: "", omdb_key: "", kmdb_key: "" },
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
    // Metadata search/stamp need network + the Rust adapter layer —
    // desktop-only surfaces (backlinks precedent). The panel still
    // renders; searches just come back empty in the browser preview.
    case "search_book_metadata":
    case "search_movie_metadata":
      return [];
    case "stamp_metadata":
      return null;
    case "set_brain_config":
    case "set_daily_config":
    case "set_general_config":
    case "set_capture_config":
    case "set_index_config":
    case "set_appearance_config":
    case "set_metadata_config":
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

    case "set_pin_order": {
      const order = (args?.order ?? []) as string[];
      // Keep any pins missing from `order` at the end (defensive; the
      // UI sends full permutations).
      const known = loadPins();
      savePins([...order.filter((p) => known.includes(p)), ...known.filter((p) => !order.includes(p))]);
      emitBrowser("config:changed");
      return null;
    }

    case "rename_tag": {
      const oldTag = String(args?.old ?? "").normalize("NFC").toLowerCase();
      const newTag = String(args?.new ?? "").trim();
      if (!newTag) throw new Error("new tag must not be empty");
      if (oldTag === newTag.normalize("NFC").toLowerCase()) return 0;
      const WORD = /[\p{L}\p{N}_]/u;
      const store = loadStore();
      let changed = 0;
      for (const n of Object.values(store)) {
        if (n.deleted_at) continue;
        const chars = [...n.body];
        let out = "";
        let i = 0;
        let touched = false;
        while (i < chars.length) {
          if (chars[i] === "#" && (i === 0 || !WORD.test(chars[i - 1]))) {
            let j = i + 1;
            while (j < chars.length && WORD.test(chars[j])) j += 1;
            if (j > i + 1) {
              const norm = chars.slice(i + 1, j).join("").normalize("NFC").toLowerCase();
              if (norm === oldTag) {
                out += "#" + newTag;
                touched = true;
                i = j;
                continue;
              }
            }
          }
          out += chars[i];
          i += 1;
        }
        if (touched) {
          n.body = out;
          n.tags = extractTags(out);
          n.updated_at = new Date().toISOString();
          changed += 1;
        }
      }
      if (changed > 0) saveStore(store);
      emitBrowser("memos:changed");
      return changed;
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