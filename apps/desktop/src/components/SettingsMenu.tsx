/**
 * Settings drawer: a right-anchored Dialog panel that slides in from the
 * right edge. Stacks vertical sections — Appearance, Categories (CRUD UI),
 * Storage/Vault, and About. Every action maps onto an existing IPC command
 * (theme/locale are local state; category management + reindex/doctor hit
 * the vault). Triggered by the gear button in the CardGrid header.
 */
import { Dialog, Popover } from "@base-ui-components/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Check,
  Copy,
  FolderTree,
  HardDrive,
  Info,
  Palette,
  Pencil,
  Plus,
  RefreshCw,
  Settings,
  ShieldCheck,
  Stethoscope,
  Trash2,
  X,
} from "lucide-react";

import {
  createCategory,
  deleteCategory,
  doctor,
  listCategories,
  memoStats,
  reindex,
  resetVault,
  renameCategory,
  updateCategory,
  vaultPath,
} from "../lib/api";
import { COLOR_PRESETS, isValidOklch, presetToString, paperFor } from "../lib/color";
import { applyTheme, type Theme } from "../lib/theme";
import { useI18n } from "../lib/i18n";
import { useUI } from "../stores/ui";
import type { CategoryDef } from "../lib/types";

const APP_VERSION = __APP_VERSION__;

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={
            "flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors " +
            (o.value === value
              ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-100"
              : "text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200")
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-2.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
        <span className="text-zinc-400 dark:text-zinc-500">{icon}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * Categories management section. Reads the category list via TanStack Query
 * and wires mutations (create / update color / rename / delete) to the IPC
 * bridge defined in `lib/api.ts`. Every mutation invalidates the three
 * downstream caches (categories, facets, memos) so the sidebar chips and
 * grid recolor / move without a manual refresh.
 */
function CategoriesSection() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const setToast = useUI((s) => s.setToast);
  const setError = useUI((s) => s.setError);

  const cats = useQuery({ queryKey: ["categories"], queryFn: listCategories });
  const list = cats.data ?? [];

  // ----- New-category row state -----
  const [newId, setNewId] = useState("");
  const [newColor, setNewColor] = useState<string>(presetToString(COLOR_PRESETS[0]));
  const [creating, setCreating] = useState(false);
  const newInputRef = useRef<HTMLInputElement>(null);

  // ----- Per-row rename state -----
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState("");

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["categories"] });
    qc.invalidateQueries({ queryKey: ["facets"] });
    qc.invalidateQueries({ queryKey: ["memos"] });
  };

  const onAdd = async () => {
    const id = newId.trim();
    if (!id || creating) return;
    if (list.some((c) => c.id === id)) {
      setError(`"${id}" already exists`);
      return;
    }
    setCreating(true);
    try {
      await createCategory(id, newColor || null);
      setNewId("");
      setNewColor(presetToString(COLOR_PRESETS[0]));
      newInputRef.current?.focus();
      invalidateAll();
    } catch (e) {
      setError(String(e).split("\n")[0]);
    } finally {
      setCreating(false);
    }
  };

  const onNewKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void onAdd();
    } else if (e.key === "Escape") {
      setNewId("");
    }
  };

  const onCommitRename = async (oldId: string) => {
    // Escape sets this flag so the blur that follows unmounting the input
    // does not also commit.
    if (cancelRenameRef.current) {
      cancelRenameRef.current = false;
      setEditingId(null);
      return;
    }
    const next = editingDraft.trim();
    setEditingId(null);
    if (!next || next === oldId) return;
    if (list.some((c) => c.id === next)) {
      setError(`"${next}" already exists`);
      return;
    }
    try {
      const moved = await renameCategory(oldId, next);
      setToast(`${moved} ${moved === 1 ? "memo moved" : "memos moved"}`);
      invalidateAll();
    } catch (e) {
      setError(String(e).split("\n")[0]);
    }
  };

  // Single commit path: Enter blurs the input, the input's onBlur fires
  // `onCommitRename`. Escape cancels. Without this, both Enter and Escape
  // would also fire onBlur (because setting `editingId = null` unmounts
  // the focused input), double-invoking renameCategory.
  const cancelRenameRef = useRef(false);
  const onRenameKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      (e.currentTarget as HTMLInputElement).blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelRenameRef.current = true;
      (e.currentTarget as HTMLInputElement).blur();
    }
  };

  const onPickColor = async (id: string, color: string) => {
    try {
      await updateCategory(id, color);
      invalidateAll();
    } catch (e) {
      setError(String(e).split("\n")[0]);
    }
  };

  const onDelete = async (id: string) => {
    try {
      await deleteCategory(id);
      invalidateAll();
    } catch (e) {
      setError(String(e).split("\n")[0]);
    }
  };

  const startRename = (c: CategoryDef) => {
    setEditingId(c.id);
    setEditingDraft(c.id);
  };

  return (
    <div className="space-y-1.5">
      {cats.isLoading && (
        <p className="rounded-lg bg-zinc-50 px-3 py-2 text-[11px] text-zinc-400 dark:bg-zinc-800/50 dark:text-zinc-500">
          …
        </p>
      )}
      {list.map((c) => {
        const isInbox = c.id === "inbox";
        const isEditing = editingId === c.id;
        return (
          <div
            key={c.id}
            className="group flex items-center gap-2 rounded-lg bg-zinc-50 px-2.5 py-1.5 dark:bg-zinc-800/50"
          >
            <CategorySwatch
              color={c.color}
              onPick={(color) => void onPickColor(c.id, color)}
            />
            {isEditing ? (
              <input
                autoFocus
                value={editingDraft}
                onChange={(e) => setEditingDraft(e.target.value)}
                onBlur={() => void onCommitRename(c.id)}
                onKeyDown={onRenameKey}
                className="min-w-0 flex-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-800 outline-none focus:border-blue-400 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100"
              />
            ) : (
              <button
                type="button"
                disabled={isInbox}
                onClick={() => startRename(c)}
                title={isInbox ? "Inbox is immutable" : "Rename"}
                className="min-w-0 flex-1 truncate text-left text-xs text-zinc-700 disabled:cursor-not-allowed disabled:text-zinc-400 dark:text-zinc-200 dark:disabled:text-zinc-500"
              >
                {c.id}
                {c.builtin && !isInbox && (
                  <span className="ml-1.5 text-[10px] uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                    built-in
                  </span>
                )}
              </button>
            )}
            {!isEditing && (
              <button
                type="button"
                onClick={() => startRename(c)}
                disabled={isInbox}
                aria-label="Rename"
                className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-zinc-200 hover:text-zinc-700 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
              >
                <Pencil size={12} />
              </button>
            )}
            <button
              type="button"
              onClick={() => void onDelete(c.id)}
              disabled={isInbox}
              aria-label={t.action_delete}
              title={isInbox ? "Inbox is immutable" : t.action_delete}
              className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-red-100 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-red-900/40 dark:hover:text-red-300"
            >
              <Trash2 size={12} />
            </button>
          </div>
        );
      })}

      {/* New-category row */}
      <div className="flex items-center gap-2 rounded-lg border border-dashed border-zinc-300 px-2.5 py-1.5 dark:border-zinc-700">
        <CategorySwatch color={newColor} onPick={setNewColor} />
        <input
          ref={newInputRef}
          value={newId}
          onChange={(e) => setNewId(e.target.value)}
          onKeyDown={onNewKey}
          placeholder="New category id"
          className="min-w-0 flex-1 rounded-md bg-transparent px-1 py-1 text-xs text-zinc-800 outline-none placeholder:text-zinc-400 dark:text-zinc-100 dark:placeholder:text-zinc-500"
        />
        <button
          type="button"
          onClick={() => void onAdd()}
          disabled={creating || newId.trim().length === 0}
          className="flex items-center gap-1 rounded-md bg-zinc-900 px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          <Plus size={12} />
          Add
        </button>
      </div>
    </div>
  );
}

/**
 * Color swatch that opens a Popover of COLOR_PRESETS plus an OKLCH text
 * input for custom values. Used both as the editor for existing rows and
 * as the picker on the new-category row.
 *
 * Popover renders via Portal so its z-index must exceed the dialog's z-50
 * surface to stay visible above the drawer.
 */
function CategorySwatch({
  color,
  onPick,
}: {
  color: string;
  onPick: (color: string) => void;
}) {
  const [draft, setDraft] = useState(color);

  // Keep the input in sync when the underlying color changes (e.g. after
  // a remote mutation invalidates and refetches the list).
  useEffect(() => {
    setDraft(color);
  }, [color]);

  const swatchStyle = color
    ? { backgroundColor: paperFor(color) }
    : undefined;

  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label="Edit color"
        className="block h-5 w-5 shrink-0 rounded-full border border-zinc-200 transition-transform hover:scale-110 dark:border-zinc-600"
        style={swatchStyle}
      />
      <Popover.Portal>
        <Popover.Positioner side="left" align="center" sideOffset={6} className="z-[60]">
          <Popover.Popup className="w-56 rounded-lg border border-zinc-200 bg-white p-2.5 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
            <div className="mb-2 grid grid-cols-6 gap-1.5">
              {COLOR_PRESETS.map((p) => {
                const v = presetToString(p);
                const active = v === color;
                return (
                  <Popover.Close
                    key={p.id}
                    onClick={() => onPick(v)}
                    aria-label={p.id}
                    title={p.id}
                    className={
                      "h-6 w-6 rounded-full border transition-transform hover:scale-110 " +
                      (active ? "border-zinc-900 dark:border-zinc-100" : "border-zinc-200 dark:border-zinc-600")
                    }
                    style={{ backgroundColor: v }}
                  />
                );
              })}
            </div>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => {
                const v = draft.trim();
                if (v && v !== color && isValidOklch(v)) onPick(v);
                else if (v && !isValidOklch(v)) setDraft(color); // revert invalid
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  const v = draft.trim();
                  if (v && v !== color && isValidOklch(v)) onPick(v);
                  else if (v && !isValidOklch(v)) setDraft(color); // revert invalid
                  (e.currentTarget as HTMLInputElement).blur();
                }
              }}
              placeholder="oklch(0.75 0.15 25)"
              className="w-full rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 font-mono text-[11px] text-zinc-700 outline-none focus:border-blue-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function SettingsMenu() {
  const { t, locale, setLocale } = useI18n();
  const theme = useUI((s) => s.theme);
  const setTheme = useUI((s) => s.setTheme);
  const setToast = useUI((s) => s.setToast);
  const setError = useUI((s) => s.setError);
  const qc = useQueryClient();

  const [busy, setBusy] = useState<"reindex" | "doctor" | "reset" | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const resetTimer = useRef<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [issues, setIssues] = useState<number | null>(null);

  const vault = useQuery({
    queryKey: ["vault-path"],
    queryFn: vaultPath,
    staleTime: Infinity,
  });

  const stats = useQuery({ queryKey: ["stats"], queryFn: memoStats });

  const onTheme = (v: Theme) => {
    setTheme(v);
    applyTheme(v);
  };

  const copyVault = async () => {
    if (!vault.data) return;
    try {
      await navigator.clipboard.writeText(vault.data);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError(t.copy_failed);
    }
  };

  const onReindex = () => {
    setBusy("reindex");
    reindex()
      .then((s) => {
        setToast(`${t.reindex_done} · ${s.memos}`);
        qc.invalidateQueries({ queryKey: ["stats"] });
        qc.invalidateQueries({ queryKey: ["memos"] });
      })
      .catch((e) => setError(String(e).split("\n")[0]))
      .finally(() => setBusy(null));
  };

  const onDoctor = () => {
    setBusy("doctor");
    doctor(false)
      .then((r) => {
        const n =
          r.corrupt_frontmatter.length +
          r.orphan_index_records.length +
          r.orphan_files.length +
          r.hash_mismatches.length +
          r.hash_repair_failed;
        setIssues(n);
        setToast(n === 0 ? t.vault_ok : `${t.vault_issues}: ${n}`);
      })
      .catch((e) => setError(String(e).split("\n")[0]))
      .finally(() => setBusy(null));
  };

  const onResetClick = () => {
    if (!confirmReset) {
      // Two-click confirm: first click arms, second within 4s commits.
      // window.confirm is unreliable in Tauri's WKWebView, so we inline it.
      setConfirmReset(true);
      if (resetTimer.current) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setConfirmReset(false), 4000);
      return;
    }
    setConfirmReset(false);
    if (resetTimer.current) window.clearTimeout(resetTimer.current);
    setBusy("reset");
    resetVault()
      .then(() => {
        setToast(t.reset_done);
        qc.invalidateQueries({ queryKey: ["stats"] });
        qc.invalidateQueries({ queryKey: ["memos"] });
        qc.invalidateQueries({ queryKey: ["facets"] });
      })
      .catch((e) => setError(String(e).split("\n")[0]))
      .finally(() => setBusy(null));
  };

  return (
    <Dialog.Root>
      <Dialog.Trigger
        aria-label={t.settings}
        className="rounded-full p-1.5 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
      >
        <Settings size={15} />
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm" />
        <Dialog.Popup
          className="fixed right-0 top-0 z-50 flex h-full w-[380px] max-w-[92vw] translate-x-full flex-col overflow-hidden border-l border-zinc-200 bg-white shadow-xl transition-transform duration-200 ease-out data-[open]:translate-x-0 dark:border-zinc-800 dark:bg-zinc-950"
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3.5 dark:border-zinc-800">
            <h1 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
              {t.settings}
            </h1>
            <Dialog.Close
              aria-label={t.close}
              className="rounded-lg p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            >
              <X size={16} />
            </Dialog.Close>
          </div>

          {/* Body */}
          <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
            <Section icon={<Palette size={12} />} title={t.section_appearance}>
              <Segmented
                value={theme}
                onChange={onTheme}
                options={[
                  { value: "system", label: t.theme_system },
                  { value: "light", label: t.theme_light },
                  { value: "dark", label: t.theme_dark },
                ]}
              />
              <div className="mt-2.5">
                <Segmented
                  value={locale}
                  onChange={setLocale}
                  options={[
                    { value: "ko", label: t.locale_ko },
                    { value: "en", label: t.locale_en },
                  ]}
                />
              </div>
            </Section>

            <Section icon={<FolderTree size={12} />} title="Categories">
              <CategoriesSection />
            </Section>

            <Section icon={<HardDrive size={12} />} title={t.section_storage}>
              <div className="space-y-2.5">
                <div>
                  <p className="mb-1 text-[11px] text-zinc-400 dark:text-zinc-500">
                    {t.vault_location}
                  </p>
                  <div className="flex items-center gap-1.5">
                    <code
                      title={vault.data ?? ""}
                      className="min-w-0 flex-1 truncate rounded-lg bg-zinc-50 px-2.5 py-1.5 font-mono text-[11px] text-zinc-600 dark:bg-zinc-800/50 dark:text-zinc-300"
                    >
                      {vault.data ?? "…"}
                    </code>
                    <button
                      type="button"
                      onClick={() => void copyVault()}
                      aria-label={t.copy}
                      className="shrink-0 rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                    >
                      {copied ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />}
                    </button>
                  </div>
                </div>
                <div className="flex items-center justify-between rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-500 dark:bg-zinc-800/50 dark:text-zinc-400">
                  <span>{t.memo_count.replace("{n}", String(stats.data?.memos ?? 0))}</span>
                  <span>{t.favorites_count.replace("{n}", String(stats.data?.favorites ?? 0))}</span>
                </div>
                <div className="flex gap-2 pt-0.5">
                  <button
                    type="button"
                    onClick={onReindex}
                    disabled={busy !== null}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-zinc-200 px-2 py-2 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  >
                    <RefreshCw size={13} className={busy === "reindex" ? "animate-spin" : ""} />
                    {busy === "reindex" ? t.reindexing : t.reindex}
                  </button>
                  <button
                    type="button"
                    onClick={onDoctor}
                    disabled={busy !== null}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-zinc-200 px-2 py-2 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                  >
                    <Stethoscope size={13} />
                    {busy === "doctor" ? t.checking : t.doctor}
                  </button>
                </div>
                {issues !== null && busy === null && (
                  <p
                    className={
                      "flex items-center gap-1 text-xs " +
                      (issues === 0
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-amber-600 dark:text-amber-400")
                    }
                  >
                    <ShieldCheck size={13} />
                    {issues === 0 ? t.vault_ok : `${t.vault_issues}: ${issues}`}
                  </p>
                )}
                <button
                  type="button"
                  onClick={onResetClick}
                  disabled={busy !== null}
                  className={
                    "mt-1 flex w-full items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-xs font-medium transition-colors disabled:opacity-50 " +
                    (confirmReset
                      ? "border-red-500 bg-red-500 text-white hover:bg-red-600 dark:border-red-500 dark:bg-red-500 dark:hover:bg-red-600"
                      : "border-red-200 text-red-600 hover:bg-red-50 dark:border-red-900/50 dark:text-red-400 dark:hover:bg-red-950/30")
                  }
                >
                  <Trash2 size={13} />
                  {busy === "reset" ? "…" : confirmReset ? t.reset_confirm : t.reset}
                </button>
              </div>
            </Section>

            <Section icon={<Info size={12} />} title={t.section_about}>
              <div className="flex items-center justify-between rounded-lg bg-zinc-50 px-3 py-2 dark:bg-zinc-800/50">
                <span className="text-xs text-zinc-500 dark:text-zinc-400">oximemo</span>
                <span className="font-mono text-xs text-zinc-400">v{APP_VERSION}</span>
              </div>
              <div className="mt-1.5 flex items-center justify-between rounded-lg bg-zinc-50 px-3 py-2 dark:bg-zinc-800/50">
                <span className="text-xs text-zinc-500 dark:text-zinc-400">{t.capture_shortcut}</span>
                <kbd className="font-mono text-xs text-zinc-400">⌘⇧N</kbd>
              </div>
            </Section>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
