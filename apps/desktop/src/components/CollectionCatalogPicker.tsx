/**
 * Collection catalog picker (spec 2026-08-23 §2.1): a centered dialog
 * listing the *uninstalled* collection presets with a one-line pitch
 * and a folder-name input (defaulting to the localized name). Install
 * runs the shared `installCollection` IPC — the same surface ⌘K and
 * the settings rail "+ 컬렉션 추가" row route through. Hosted by
 * CardGrid; open state lives in the ui store.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog } from "@base-ui-components/react";
import { useState } from "react";
import { Check, FolderInput, X } from "lucide-react";

import { installCollection, listFolders } from "../lib/api";
import { COLLECTION_CATALOG } from "../lib/collectionCatalog";
import { useI18n } from "../lib/i18n";
import { useUI } from "../stores/ui";

export function CollectionCatalogPicker() {
  const { t, locale } = useI18n();
  const open = useUI((s) => s.collectionPickerOpen);
  const setOpen = useUI((s) => s.setCollectionPickerOpen);
  const qc = useQueryClient();
  const folders = useQuery({ queryKey: ["folders"], queryFn: listFolders });
  const [selected, setSelected] = useState<string | null>(null);
  const [folderName, setFolderName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["folders"] });
    void qc.invalidateQueries({ queryKey: ["folder-schema"] });
    void qc.invalidateQueries({ queryKey: ["folderChildren"] });
  };

  // Installed detection is deliberately coarse here: a folder sharing
  // the suggested name hides the suggestion (the settings rail does
  // exact `[meta] preset` matching).
  const installedNames = new Set((folders.data ?? []).map((f) => f.path));
  const available = COLLECTION_CATALOG.filter(
    (c) => !installedNames.has(c.defaultFolder[locale]) || selected === c.id,
  );

  const pick = (id: string) => {
    const info = COLLECTION_CATALOG.find((c) => c.id === id);
    setSelected(id);
    setFolderName(info ? info.defaultFolder[locale] : "");
    setError(null);
  };

  const install = async () => {
    if (!selected || !folderName.trim()) return;
    setBusy(true);
    try {
      await installCollection(selected, folderName.trim());
      invalidate();
      setOpen(false);
      setSelected(null);
      setFolderName("");
    } catch (e) {
      setError(String(e).split("\n")[0]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm transition-opacity duration-200 ease-out data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 w-[min(520px,92vw)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[var(--dialog-radius)] border border-line bg-surface-raised shadow-lg transition-[opacity,translate,scale] duration-200 ease-out data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0 data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0">
          <Dialog.Title className="sr-only">{t.collection_add_title}</Dialog.Title>
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <h1 className="text-sm font-semibold text-text">{t.collection_add_title}</h1>
            <Dialog.Close
              aria-label={t.close}
              className="rounded-lg p-1 text-text-subtle transition-colors hover:bg-surface-muted hover:text-text-muted"
            >
              <X size={15} />
            </Dialog.Close>
          </div>
          <div className="max-h-[60vh] overflow-y-auto p-3">
            {available.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-text-subtle">
                {t.collection_all_installed}
              </p>
            ) : (
              <div className="space-y-1.5">
                {available.map((c) => {
                  const Icon = c.icon;
                  const active = selected === c.id;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => pick(c.id)}
                      className={
                        "flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors " +
                        (active
                          ? "border-interactive-primary bg-surface-muted"
                          : "border-line hover:bg-surface-muted/50")
                      }
                    >
                      <Icon size={16} className="mt-0.5 shrink-0 text-text-muted" />
                      <span className="min-w-0">
                        <span className="block text-xs font-medium text-text">{t[c.nameKey]}</span>
                        <span className="mt-0.5 block text-[11px] leading-snug text-text-subtle">
                          {t[c.descKey]}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          {selected && (
            <div className="border-t border-line px-4 py-3">
              <div className="flex items-center gap-2">
                <FolderInput size={13} className="shrink-0 text-text-subtle" />
                <input
                  value={folderName}
                  onChange={(e) => setFolderName(e.target.value)}
                  placeholder={t.collection_folder_name}
                  // eslint-disable-next-line jsx-a11y/no-autofocus -- modal flow: the name field is the next input after picking a preset
                  autoFocus
                  className="min-w-0 flex-1 rounded-md bg-surface-sunken px-2.5 py-1.5 text-xs text-text outline-none placeholder:text-text-subtle focus:ring-1 focus:ring-line"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) void install();
                  }}
                />
                <button
                  type="button"
                  disabled={busy || !folderName.trim()}
                  onClick={() => void install()}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg bg-interactive-primary px-3 py-1.5 text-xs font-medium text-interactive-primary-foreground transition-colors hover:bg-interactive-primary-hover disabled:opacity-50"
                >
                  <Check size={13} />
                  {busy ? "…" : t.collection_install}
                </button>
              </div>
              {error && <p className="mt-1.5 text-[11px] text-status-error">{error}</p>}
            </div>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
