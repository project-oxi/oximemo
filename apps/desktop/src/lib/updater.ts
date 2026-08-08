/**
 * Thin wrapper over `@tauri-apps/plugin-updater`. The plugin's `check()`
 * returns an `Update` handle or null; we flatten it to a plain object so the
 * UI never holds the live handle and so this module can no-op outside the
 * Tauri shell (browser/dev mode).
 */
import { check } from "@tauri-apps/plugin-updater";

const inTauri = "__TAURI_INTERNALS__" in window;

export interface UpdateAvailable {
  version: string;
  currentVersion: string;
  date?: string;
  body?: string;
  /** Install the downloaded update. `onProgress` gets a 0..1 fraction. */
  downloadAndInstall(onProgress?: (fraction: number) => void): Promise<void>;
}

/**
 * Poll the configured endpoint for a newer version. Resolves to `null` when
 * up to date, when running outside Tauri, or when the check itself fails
 * (network, parse) — callers should treat null as "nothing to do" silently.
 */
export async function checkForUpdate(): Promise<UpdateAvailable | null> {
  if (!inTauri) return null;
  try {
    const update = await check();
    if (!update) return null;
    return {
      version: update.version,
      currentVersion: update.currentVersion,
      date: update.date,
      body: update.body,
      downloadAndInstall: (onProgress) => {
        let total = 0;
        let downloaded = 0;
        return update.downloadAndInstall((event) => {
          switch (event.event) {
            case "Started":
              total = event.data.contentLength ?? 0;
              break;
            case "Progress":
              downloaded += event.data.chunkLength;
              if (total > 0) onProgress?.(downloaded / total);
              break;
            case "Finished":
              onProgress?.(1);
              break;
          }
        });
      },
    };
  } catch {
    return null;
  }
}
