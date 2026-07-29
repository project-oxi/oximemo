/**
 * Settings modal: a full Dialog (not a popover) with grouped sections —
 * appearance, language, capture, storage/vault, and about. Every action maps
 * onto an existing IPC command (theme/locale are local state; reindex/doctor
 * hit the vault). Anchored to the gear button in the CardGrid header.
 */
import { Dialog } from "@base-ui-components/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import {
  Check,
  Copy,
  Globe,
  HardDrive,
  Info,
  Languages,
  Palette,
  RefreshCw,
  Settings,
  ShieldCheck,
  Stethoscope,
  X,
} from "lucide-react";

import { doctor, noteStats, reindex, vaultPath } from "../lib/api";
import { applyTheme, type Theme } from "../lib/theme";
import { useI18n } from "../lib/i18n";
import { useUI } from "../stores/ui";

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

export function SettingsMenu() {
  const { t, locale, setLocale } = useI18n();
  const theme = useUI((s) => s.theme);
  const setTheme = useUI((s) => s.setTheme);
  const setToast = useUI((s) => s.setToast);
  const setError = useUI((s) => s.setError);
  const qc = useQueryClient();

  const [busy, setBusy] = useState<"reindex" | "doctor" | null>(null);
  const [copied, setCopied] = useState(false);
  const [issues, setIssues] = useState<number | null>(null);

  const vault = useQuery({
    queryKey: ["vault-path"],
    queryFn: vaultPath,
    staleTime: Infinity,
  });

  const stats = useQuery({ queryKey: ["stats"], queryFn: noteStats });

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
        setToast(`${t.reindex_done} · ${s.notes}`);
        qc.invalidateQueries({ queryKey: ["stats"] });
        qc.invalidateQueries({ queryKey: ["notes"] });
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
          r.invalid_colors.length;
        setIssues(n);
        setToast(n === 0 ? t.vault_ok : `${t.vault_issues}: ${n}`);
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
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[82vh] w-[min(600px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-900"
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
            </Section>

            <Section icon={<Languages size={12} />} title={t.language}>
              <Segmented
                value={locale}
                onChange={setLocale}
                options={[
                  { value: "ko", label: t.locale_ko },
                  { value: "en", label: t.locale_en },
                ]}
              />
            </Section>

            <Section icon={<Globe size={12} />} title={t.section_capture}>
              <div className="flex items-center justify-between rounded-lg bg-zinc-50 px-3 py-2 dark:bg-zinc-800/50">
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  {t.capture_shortcut}
                </span>
                <kbd className="rounded-md border border-zinc-200 bg-white px-2 py-1 font-mono text-[11px] text-zinc-600 shadow-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                  ⌘⇧N
                </kbd>
              </div>
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
                  <span>{t.note_count.replace("{n}", String(stats.data?.notes ?? 0))}</span>
                  <span>{t.pinned_count.replace("{n}", String(stats.data?.pinned ?? 0))}</span>
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
              </div>
            </Section>

            <Section icon={<Info size={12} />} title={t.section_about}>
              <div className="flex items-center justify-between rounded-lg bg-zinc-50 px-3 py-2 dark:bg-zinc-800/50">
                <span className="text-xs text-zinc-500 dark:text-zinc-400">oxinot</span>
                <span className="font-mono text-xs text-zinc-400">v{APP_VERSION}</span>
              </div>
            </Section>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
