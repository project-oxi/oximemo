/**
 * Settings popover: theme + language segmented controls, the capture
 * shortcut, the vault path with copy, and vault maintenance (rebuild index,
 * run doctor). Anchored to the gear button in the CardGrid header; every
 * action maps onto an existing IPC command.
 */
import { Popover } from "@base-ui-components/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Check, Copy, RefreshCw, Settings, ShieldCheck, Stethoscope } from "lucide-react";

import { doctor, reindex, vaultPath } from "../lib/api";
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
            "flex-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors " +
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
    <Popover.Root>
      <Popover.Trigger
        aria-label={t.settings}
        className="rounded-full p-1.5 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
      >
        <Settings size={15} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8} className="z-50">
          <Popover.Popup
            className="w-72 animate-popover-in rounded-xl border border-zinc-200 bg-white p-3 shadow-xl dark:border-zinc-800 dark:bg-zinc-900"
          >
          <div className="mb-3">
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
              {t.theme}
            </p>
            <Segmented
              value={theme}
              onChange={onTheme}
              options={[
                { value: "system", label: t.theme_system },
                { value: "light", label: t.theme_light },
                { value: "dark", label: t.theme_dark },
              ]}
            />
          </div>
          <div className="mb-3">
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
              {t.language}
            </p>
            <Segmented
              value={locale}
              onChange={setLocale}
              options={[
                { value: "ko", label: t.locale_ko },
                { value: "en", label: t.locale_en },
              ]}
            />
          </div>
          <div className="mb-1 flex items-center justify-between rounded-lg bg-zinc-50 px-2.5 py-2 dark:bg-zinc-800/50">
            <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
              {t.capture_shortcut}
            </span>
            <kbd className="rounded-md border border-zinc-200 bg-white px-1.5 py-0.5 font-mono text-[10px] text-zinc-600 shadow-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
              ⌘⇧N
            </kbd>
          </div>

          <div className="my-2.5 border-t border-zinc-100 dark:border-zinc-800" />

          <div className="mb-3">
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
              {t.vault}
            </p>
            <div className="flex items-center gap-1.5">
              <code
                title={vault.data ?? ""}
                className="min-w-0 flex-1 truncate rounded-lg bg-zinc-50 px-2.5 py-1.5 font-mono text-[10px] text-zinc-600 dark:bg-zinc-800/50 dark:text-zinc-300"
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

          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={onReindex}
              disabled={busy !== null}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-zinc-200 px-2 py-1.5 text-[11px] font-medium text-zinc-600 transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              <RefreshCw size={12} className={busy === "reindex" ? "animate-spin" : ""} />
              {busy === "reindex" ? t.reindexing : t.reindex}
            </button>
            <button
              type="button"
              onClick={onDoctor}
              disabled={busy !== null}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-zinc-200 px-2 py-1.5 text-[11px] font-medium text-zinc-600 transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              <Stethoscope size={12} />
              {busy === "doctor" ? t.checking : t.doctor}
            </button>
          </div>
          {issues !== null && busy === null && (
            <p
              className={
                "mt-2 flex items-center gap-1 text-[11px] " +
                (issues === 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-amber-600 dark:text-amber-400")
              }
            >
              <ShieldCheck size={12} />
              {issues === 0 ? t.vault_ok : `${t.vault_issues}: ${issues}`}
            </p>
          )}

          <div className="my-2.5 border-t border-zinc-100 dark:border-zinc-800" />
          <p className="text-center text-[10px] text-zinc-400 dark:text-zinc-500">
            oxinot v{APP_VERSION}
          </p>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
