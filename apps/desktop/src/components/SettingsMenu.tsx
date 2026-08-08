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
  DownloadCloud,
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
  Terminal,
  Trash2,
  X,
} from "lucide-react";

import {
  cliStatus,
  installCli,
  uninstallCli,
  type CliState,
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
import { relaunch } from "@tauri-apps/plugin-process";
import { checkForUpdate, type UpdateAvailable } from "../lib/updater";

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
    <div className="flex rounded-lg bg-surface-muted p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={
            "flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors " +
            (o.value === value
              ? "bg-surface-raised text-text shadow-sm"
              : "text-text-muted hover:text-text")
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
      <h2 className="mb-2.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-subtle">
        <span className="text-text-subtle">{icon}</span>
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
        <p className="rounded-lg bg-surface-sunken px-3 py-2 text-[11px] text-text-subtle">
          …
        </p>
      )}
      {list.map((c) => {
        const isInbox = c.id === "inbox";
        const isEditing = editingId === c.id;
        return (
          <div
            key={c.id}
            className="group flex items-center gap-2 rounded-lg bg-surface-sunken px-2.5 py-1.5"
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
                className="min-w-0 flex-1 rounded-md bg-surface-raised px-2 py-1 text-xs text-text outline-none shadow-[var(--input-shadow)] focus-visible:shadow-[var(--input-shadow-focus)] focus-visible:outline-none"
              />
            ) : (
              <button
                type="button"
                disabled={isInbox}
                onClick={() => startRename(c)}
                title={isInbox ? "Inbox is immutable" : "Rename"}
                className="min-w-0 flex-1 truncate text-left text-xs text-text-muted disabled:cursor-not-allowed disabled:text-text-subtle"
              >
                {c.id}
                {c.builtin && !isInbox && (
                  <span className="ml-1.5 text-[10px] uppercase tracking-wider text-text-subtle">
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
                className="rounded-md p-1 text-text-subtle transition-colors hover:bg-surface-muted hover:text-text disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
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
              className="rounded-md p-1 text-text-subtle transition-colors hover:bg-status-error-subtle hover:text-status-error disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent"
            >
              <Trash2 size={12} />
            </button>
          </div>
        );
      })}

      {/* New-category row */}
      <div className="flex items-center gap-2 rounded-lg border border-dashed border-line px-2.5 py-1.5">
        <CategorySwatch color={newColor} onPick={setNewColor} />
        <input
          ref={newInputRef}
          value={newId}
          onChange={(e) => setNewId(e.target.value)}
          onKeyDown={onNewKey}
          placeholder="New category id"
          className="min-w-0 flex-1 rounded-md bg-transparent px-1 py-1 text-xs text-text outline-none placeholder:text-text-subtle"
        />
        <button
          type="button"
          onClick={() => void onAdd()}
          disabled={creating || newId.trim().length === 0}
          className="flex items-center gap-1 rounded-md bg-interactive-primary px-2 py-1 text-[11px] font-medium text-interactive-primary-foreground transition-colors hover:bg-interactive-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
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
        className="block h-5 w-5 shrink-0 rounded-full border border-line transition-transform hover:scale-110"
        style={swatchStyle}
      />
      <Popover.Portal>
        <Popover.Positioner side="left" align="center" sideOffset={6} className="z-[60]">
          <Popover.Popup className="w-56 rounded-lg border border-line bg-surface-raised p-2.5 shadow-lg">
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
                      (active ? "border-text" : "border-line")
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
              className="w-full rounded-md bg-surface-sunken px-2 py-1 font-mono text-[11px] text-text-muted outline-none shadow-[var(--input-shadow)] focus-visible:shadow-[var(--input-shadow-focus)] focus-visible:outline-none"
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Command-line tool install section. Surfaces the bundled `oximemo` CLI on
 *  PATH via a one-time macOS admin prompt. */
function CliSection() {
  const { t } = useI18n();
  const setToast = useUI((s) => s.setToast);
  const setError = useUI((s) => s.setError);
  const [busy, setBusy] = useState(false);

  const status = useQuery({
    queryKey: ["cli-status"],
    queryFn: cliStatus,
    staleTime: Infinity,
  });

  const onInstall = () => {
    setBusy(true);
    installCli()
      .then(() => {
        setToast(t.cli_install_done);
        void status.refetch();
      })
      .catch(() => setError(t.cli_install_failed))
      .finally(() => setBusy(false));
  };

  const onUninstall = () => {
    setBusy(true);
    uninstallCli()
      .then(() => {
        setToast(t.cli_uninstall_done);
        void status.refetch();
      })
      .catch((e) => setError(String(e).split("\n")[0]))
      .finally(() => setBusy(false));
  };

  const state: CliState = status.data ?? "not-installed";

  return (
    <div className="space-y-2.5">
      <p className="text-[11px] leading-relaxed text-text-subtle">{t.cli_desc}</p>
      <div className="flex items-center justify-between rounded-lg bg-surface-sunken px-3 py-2">
        <span className="flex items-center gap-1.5 text-xs text-text-muted">
          {state === "installed" && (
            <Check size={13} className="text-status-success" />
          )}
          {state === "installed" ? t.cli_installed : t.cli_not_installed}
        </span>
        {state === "installed" ? (
          <button
            type="button"
            onClick={onUninstall}
            disabled={busy}
            className="rounded-lg border border-line px-2 py-1 text-xs font-medium text-text-muted transition-colors hover:bg-surface-muted disabled:opacity-50"
          >
            {busy ? "…" : t.cli_uninstall}
          </button>
        ) : (
          <button
            type="button"
            onClick={onInstall}
            disabled={busy}
            className="rounded-lg border border-line px-2 py-1 text-xs font-medium text-text-muted transition-colors hover:bg-surface-muted disabled:opacity-50"
          >
            {busy
              ? t.cli_installing
              : state === "stale"
                ? t.cli_reinstall
                : t.cli_install}
          </button>
        )}
      </div>
    </div>
  );
}
/** Auto-update section. Checks GitHub Releases for a newer signed build and
 * installs it in place (verify → swap → relaunch). No-ops outside the Tauri
 * shell; auto-checks once on mount so the version is fresh when opened. */
function UpdaterSection() {
  const { t } = useI18n();
  const setError = useUI((s) => s.setError);
  const [status, setStatus] = useState<
    | "idle"
    | "checking"
    | "available"
    | "downloading"
    | "installing"
    | "ready"
    | "up-to-date"
    | "error"
  >("idle");
  const [update, setUpdate] = useState<UpdateAvailable | null>(null);
  const [pct, setPct] = useState(0);

  const inTauri = "__TAURI_INTERNALS__" in window;

  useEffect(() => {
    if (!inTauri) return;
    setStatus("checking");
    checkForUpdate().then((u) => {
      setUpdate(u);
      setStatus(u ? "available" : "up-to-date");
    });
  }, [inTauri]);

  const onCheck = () => {
    setStatus("checking");
    checkForUpdate()
      .then((u) => {
        setUpdate(u);
        setStatus(u ? "available" : "up-to-date");
      })
      .catch(() => setStatus("error"));
  };

  const onInstall = () => {
    if (!update) return;
    setStatus("downloading");
    setPct(0);
    update
      .downloadAndInstall((f) => {
        setPct(f);
        if (f >= 1) setStatus("installing");
      })
      .then(() => setStatus("ready"))
      .catch(() => {
        setStatus("error");
        setError(t.update_failed);
      });
  };

  if (!inTauri) return null;

  return (
    <div className="space-y-2">
      {status === "available" && update && (
        <div className="rounded-lg border border-status-success/40 bg-status-success-subtle px-3 py-2">
          <p className="text-xs font-medium text-status-success">
            {t.update_available.replace("{v}", update.version)}
          </p>
        </div>
      )}
      {(status === "downloading" || status === "installing") && (
        <div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-sunken">
            <div
              className="h-full rounded-full bg-interactive-primary transition-[width] duration-150"
              style={{ width: `${status === "installing" ? 100 : Math.round(pct * 100)}%` }}
            />
          </div>
          <p className="mt-1 text-[11px] text-text-subtle">
            {status === "downloading"
              ? `${t.update_downloading} ${Math.round(pct * 100)}%`
              : t.update_installing}
          </p>
        </div>
      )}
      {status === "ready" && (
        <button
          type="button"
          onClick={() => void relaunch()}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-interactive-primary px-2 py-2 text-xs font-medium text-interactive-primary-foreground transition-colors hover:bg-interactive-primary/90"
        >
          <RefreshCw size={13} />
          {t.update_relaunch}
        </button>
      )}
      {status === "checking" && (
        <p className="flex items-center gap-1 text-xs text-text-subtle">
          <RefreshCw size={13} className="animate-spin" />
          {t.update_checking}
        </p>
      )}
      {status === "up-to-date" && (
        <p className="flex items-center gap-1 text-xs text-status-success">
          <Check size={13} />
          {t.update_up_to_date}
        </p>
      )}
      {status === "error" && (
        <p className="flex items-center gap-1 text-xs text-status-error">
          <ShieldCheck size={13} />
          {t.update_failed}
        </p>
      )}
      {status === "available" && (
        <button
          type="button"
          onClick={onInstall}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-line px-2 py-2 text-xs font-medium text-text-muted transition-colors hover:bg-surface-muted"
        >
          <DownloadCloud size={13} />
          {t.update_download}
        </button>
      )}
      {(status === "up-to-date" || status === "error") && (
        <button
          type="button"
          onClick={onCheck}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-line px-2 py-2 text-xs font-medium text-text-muted transition-colors hover:bg-surface-muted"
        >
          <RefreshCw size={13} />
          {t.update_check}
        </button>
      )}
    </div>
  );
}
export function SettingsMenu() {
  const { t, locale, setLocale } = useI18n();
  const theme = useUI((s) => s.theme);
  const setTheme = useUI((s) => s.setTheme);
  const setToast = useUI((s) => s.setToast);
  const setError = useUI((s) => s.setError);
  const updateAvailable = useUI((s) => s.updateAvailable);
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
        className="relative rounded-full p-1.5 text-text-muted transition-colors hover:bg-surface-muted hover:text-text"
      >
        <Settings size={15} />
        {updateAvailable && (
          <span className="absolute right-1 top-1 size-1.5 rounded-full bg-status-info ring-2 ring-surface" />
        )}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 backdrop-blur-sm" />
        <Dialog.Popup
          className="fixed right-0 top-0 z-50 flex h-full w-[380px] max-w-[92vw] translate-x-full flex-col overflow-hidden border-l border-line bg-surface shadow-lg transition-transform duration-200 ease-out data-[open]:translate-x-0"
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
            <h1 className="text-sm font-semibold text-text">
              {t.settings}
            </h1>
            <Dialog.Close
              aria-label={t.close}
              className="rounded-lg p-1 text-text-subtle transition-colors hover:bg-surface-muted hover:text-text-muted"
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
                  <p className="mb-1 text-[11px] text-text-subtle">
                    {t.vault_location}
                  </p>
                  <div className="flex items-center gap-1.5">
                    <code
                      title={vault.data ?? ""}
                      className="min-w-0 flex-1 truncate rounded-lg bg-surface-sunken px-2.5 py-1.5 font-mono text-[11px] text-text-muted"
                    >
                      {vault.data ?? "…"}
                    </code>
                    <button
                      type="button"
                      onClick={() => void copyVault()}
                      aria-label={t.copy}
                      className="shrink-0 rounded-lg p-1.5 text-text-subtle transition-colors hover:bg-surface-muted hover:text-text"
                    >
                      {copied ? <Check size={13} className="text-status-success" /> : <Copy size={13} />}
                    </button>
                  </div>
                </div>
                <div className="flex items-center justify-between rounded-lg bg-surface-sunken px-3 py-2 text-xs text-text-muted">
                  <span>{t.memo_count.replace("{n}", String(stats.data?.memos ?? 0))}</span>
                  <span>{t.favorites_count.replace("{n}", String(stats.data?.favorites ?? 0))}</span>
                </div>
                <div className="flex gap-2 pt-0.5">
                  <button
                    type="button"
                    onClick={onReindex}
                    disabled={busy !== null}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-line px-2 py-2 text-xs font-medium text-text-muted transition-colors hover:bg-surface-muted disabled:opacity-50"
                  >
                    <RefreshCw size={13} className={busy === "reindex" ? "animate-spin" : ""} />
                    {busy === "reindex" ? t.reindexing : t.reindex}
                  </button>
                  <button
                    type="button"
                    onClick={onDoctor}
                    disabled={busy !== null}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-line px-2 py-2 text-xs font-medium text-text-muted transition-colors hover:bg-surface-muted disabled:opacity-50"
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
                        ? "text-status-success"
                        : "text-status-warning")
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
                      ? "border-status-error bg-status-error text-interactive-primary-foreground hover:bg-status-error/90"
                      : "border-status-error text-status-error hover:bg-status-error-subtle")
                  }
                >
                  <Trash2 size={13} />
                  {busy === "reset" ? "…" : confirmReset ? t.reset_confirm : t.reset}
                </button>
              </div>
            </Section>

            <Section icon={<Terminal size={12} />} title={t.section_cli}>
              <CliSection />
            </Section>

            <Section icon={<DownloadCloud size={12} />} title={t.section_updates}>
              <UpdaterSection />
            </Section>

            <Section icon={<Info size={12} />} title={t.section_about}>
              <div className="flex items-center justify-between rounded-lg bg-surface-sunken px-3 py-2">
                <span className="text-xs text-text-muted">oximemo</span>
                <span className="font-mono text-xs text-text-subtle">v{APP_VERSION}</span>
              </div>
              <div className="mt-1.5 flex items-center justify-between rounded-lg bg-surface-sunken px-3 py-2">
                <span className="text-xs text-text-muted">{t.capture_shortcut}</span>
                <kbd className="font-mono text-xs text-text-subtle">⌘⇧N</kbd>
              </div>
            </Section>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
