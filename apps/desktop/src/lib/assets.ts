/**
 * Image asset layer: the bridge between the editor and the vault's
 * content-addressed `assets/` store.
 *
 * Markdown references images with the app-relative `oximg://localhost/<name>`
 * scheme. Per RFC 3986 the host must be `localhost` so the name lands in the
 * *path* — Tauri's macOS webview origin is `<scheme>://localhost`, and the
 * protocol handler reads `request.uri().path()`. In the shell the scheme is
 * served natively (see `register_uri_scheme_protocol` in src-tauri). In
 * browser-dev mode (no `__TAURI_INTERNALS__`) the same names resolve to blob
 * URLs backed by IndexedDB, so insertion + rendering work identically without a
 * real filesystem — and without touching the localStorage memo store's
 * ~5–10 MB quota.
 *
 * Insertion flow (drag/drop, paste, file-picker) lands raw bytes here; this
 * module returns an `AssetRef` whose `url` is the exact string to splice into
 * the memo body.
 */
import { invoke } from "./tauri";

export interface AssetRef {
  /** `oximg://localhost/<name>` — drop this verbatim into markdown. */
  url: string;
  /** `<hash>.<ext>` — used by the gallery / GC. */
  name: string;
}

export interface AssetInfo {
  name: string;
  url: string;
  ext: string;
  bytes: number;
  modified: string;
}

const inTauri = "__TAURI_INTERNALS__" in window;
/** Full canonical prefix; `url === OXIMG + name` is an invariant. */
export const OXIMG = "oximg://localhost/";
const HASH_LEN = 16;

/** Matches a markdown image whose src is an oximg URL. Capture: [1]=alt, [2]=name. */
export const OXIMG_IMAGE_RE =
  /!\[([^\]]*)\]\(oximg:\/\/localhost\/([A-Za-z0-9]+\.[a-z]+)(?:#[^)\s]*)?\)/g;

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** Infer a file extension from a MIME type, with a regex fallback. */
export function extForType(type: string): string | null {
  if (MIME_TO_EXT[type]) return MIME_TO_EXT[type];
  const m = /^image\/([\w-]+)$/.exec(type);
  return m ? m[1] : null;
}

/** Build the markdown line for an image. `width` (px) is an optional `#w=` hint. */
export function markdownForImage(url: string, alt: string, width?: number): string {
  const a = alt.replace(/[[\]]/g, "").trim() || "image";
  const frag = width && width > 0 ? `#w=${Math.round(width)}` : "";
  return `![${a}](${url}${frag})`;
}

/** Read a `#w=<px>` width hint from an oximg URL, or null. */
export function widthOfUrl(url: string): number | null {
  const m = /#w=(\d+)/.exec(url);
  return m ? parseInt(m[1], 10) : null;
}

/** Save raw image bytes → oximg:// ref. */
export async function saveImageBytes(bytes: Uint8Array, ext: string): Promise<AssetRef> {
  const e = ext.toLowerCase().replace(/^\./, "");
  if (inTauri) {
    return invoke<AssetRef>("save_image_bytes", { base64Data: bytesToBase64(bytes), ext: e });
  }
  const name = await contentName(bytes, e);
  await idbPut(name, bytes);
  return { url: OXIMG + name, name };
}

/** Save a `File`/`Blob` (drag/drop, paste) → oximg:// ref. */
export async function saveImageFromFile(file: Blob, fallbackExt = "png"): Promise<AssetRef> {
  const m = /\.(\w{2,5})$/.exec((file as File).name ?? "");
  const ext = extForType(file.type) ?? (m ? m[1].toLowerCase() : fallbackExt);
  const bytes = new Uint8Array(await file.arrayBuffer());
  return saveImageBytes(bytes, ext);
}

export function listAssets(): Promise<AssetInfo[]> {
  return inTauri ? invoke<AssetInfo[]>("list_assets") : idbList();
}

export function gcAssets(): Promise<number> {
  return inTauri ? invoke<number>("gc_assets") : Promise.resolve(0);
}

/**
 * Resolve an `oximg://localhost/<name>` URL to something a browser `<img>` can
 * load. In Tauri the scheme loads natively (returned unchanged). In browser-dev
 * it is swapped for a cached blob URL read from IndexedDB.
 */
export async function resolveImageUrl(url: string): Promise<string> {
  if (inTauri) return url;
  return blobUrlFor(url.slice(OXIMG.length));
}

// --- base64 (chunked to dodge the spread call-stack limit on big arrays) -----

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function contentName(bytes: Uint8Array, ext: string): Promise<string> {
  // Browser dev uses SHA-256 (native); Tauri uses blake3. The two stores are
  // separate worlds so a name collision across them is irrelevant — only the
  // `<16hex>.<ext>` shape is shared.
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, HASH_LEN)}.${ext}`;
}

// --- IndexedDB (browser-dev only) --------------------------------------------
// Minimal wrapper. One object store keyed by asset name → Uint8Array. The
// event-based API needs the Promise executor form (and avoids
// `Promise.withResolvers`, which lands only in Safari 17.4+ while the app's
// minimum is macOS 14.0 / Safari 17.0).

const DB_NAME = "oxinot-assets";
const STORE = "kv";
const blobCache = new Map<string, string>();

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(name: string, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    openDb().then((db) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(bytes, name);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    });
  });
}

function idbGet(name: string): Promise<Uint8Array | undefined> {
  return new Promise((resolve, reject) => {
    openDb().then((db) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(name);
      req.onsuccess = () => {
        db.close();
        resolve(req.result as Uint8Array | undefined);
      };
      req.onerror = () => {
        db.close();
        reject(req.error);
      };
    });
  });
}

function idbList(): Promise<AssetInfo[]> {
  return new Promise((resolve, reject) => {
    openDb().then(async (db) => {
      const keys = await new Promise<string[]>((res, rej) => {
        const req = db.transaction(STORE, "readonly").objectStore(STORE).getAllKeys();
        req.onsuccess = () => res(req.result as string[]);
        req.onerror = () => rej(req.error);
      });
      const out: AssetInfo[] = [];
      for (const name of keys) {
        const bytes = await idbGet(name);
        out.push({
          name,
          url: OXIMG + name,
          ext: name.split(".")[1] ?? "",
          bytes: bytes?.byteLength ?? 0,
          modified: new Date().toISOString(),
        });
      }
      db.close();
      resolve(out);
    }, reject);
  });
}

function blobUrlFor(name: string): Promise<string> {
  const cached = blobCache.get(name);
  if (cached) return Promise.resolve(cached);
  return idbGet(name).then((bytes) => {
    if (!bytes) return "";
    const ext = name.split(".")[1] ?? "png";
    const url = URL.createObjectURL(
      new Blob([bytes.buffer as ArrayBuffer], { type: `image/${ext}` }),
    );
    blobCache.set(name, url);
    return url;
  });
}
