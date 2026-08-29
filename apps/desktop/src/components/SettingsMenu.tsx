/**
 * Settings window: a centered modal with a left category rail and a
 * content pane (macOS System Settings / Obsidian pattern). Rail groups —
 * 일반(외관/동작/캡처), 연동(브레인; 메타데이터 and the installed-
 * collections group join later), 폴더 관리, 시스템(저장소/고급/CLI/
 * 업데이트/정보). Section bodies are plain components carried over
 * from the old drawer verbatim. Triggered by the gear button in the
 * CardGrid header.
 */
import { Dialog } from "@base-ui-components/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import type { LucideIcon } from "lucide-react";
import {
  Bot,
  Brain,
  Check,
  ChevronDown,
  Copy,
  DownloadCloud,
  Folder,
  FolderTree,
  Library,
  ListChecks,
  HardDrive,
  Pin,
  PinOff,
  RefreshCw,
  Settings,
  ShieldCheck,
  Stethoscope,
  Terminal,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import {
  cliStatus,
  copilotStatus,
  copilotProbeAgents,
  copilotActivate,
  copilotDisclosure,
  setCopilotConfig,
  type AgentCandidate,
  installCli,
  uninstallCli,
  type CliState,
  createFolder,
  deleteFolder,
  doctor,
  getConfig,
  listFolders,
  memoStats,
  reindex,
  resetVault,
  restoreNotes,
  setAppearanceConfig,
  setFolderPinned,
  setBrainConfig,
  setCaptureConfig,
  setFolderView,
  installCollection,
  setIndexConfig,
  setGeneralConfig,
  setDailyConfig,
  setGitConfig,
  vaultPath,
} from "../lib/api";

import { useI18n } from "../lib/i18n";
import { useFolderNames } from "../lib/folders";
import { useUI } from "../stores/ui";
import { relaunch } from "@tauri-apps/plugin-process";
import { checkForUpdate, type UpdateAvailable } from "../lib/updater";
import { COLLECTION_CATALOG, SYSTEM_COLLECTIONS, type DictKey } from "../lib/collectionCatalog";
import { MetadataRegionSelect, ProviderKeys } from "./ProviderKeys";
import { useSchemaInfo } from "../lib/folders";
import { applyTheme, type Theme } from "../lib/theme";
import type { FolderEntry } from "../lib/types";
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

/** Content-pane title. The rail already carries the icon; panes repeat
 *  only the label so the active section stays self-evident. */
function PaneHeader({ title }: { title: string }) {
  return <h2 className="mb-3 text-sm font-semibold text-text">{title}</h2>;
}

/** In-pane subheading for merged panes (일반 groups several
 * formerly-separate tabs — the label keeps them scannable). */
function SectionLabel({ title }: { title: string }) {
  return (
    <p className="mb-1.5 mt-4 text-[10px] font-medium uppercase tracking-wide text-text-subtle first:mt-0">
      {title}
    </p>
  );
}



/** Boolean setting row with a switch. Commits immediately. */
export function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg bg-surface-sunken px-3 py-2">
      <span className="text-xs text-text-muted">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={
          "relative h-5 w-9 shrink-0 rounded-full transition-colors " +
          (checked ? "bg-interactive-primary" : "bg-line")
        }
      >
        <span
          className={
            "absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-surface-raised shadow transition-transform " +
            (checked ? "translate-x-[18px]" : "translate-x-0")
          }
        />
      </button>
    </div>
  );
}

/** Numeric setting row; commits on blur/Enter, clamped to [min, max]. */
function NumberRow({
  label,
  value,
  min,
  max,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Number.parseInt(draft, 10);
    if (Number.isNaN(n)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, n));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-surface-sunken px-3 py-2">
      <span className="min-w-0 truncate text-xs text-text-muted">{label}</span>
      <input
        type="number"
        value={draft}
        min={min}
        max={max}
        inputMode="numeric"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className="w-16 shrink-0 rounded-md bg-surface-raised px-2 py-1 text-right font-mono text-xs text-text outline-none focus:ring-1 focus:ring-line"
      />
    </div>
  );
}

/** Text setting row; commits on blur/Enter. */
function TextRow({
  label,
  value,
  placeholder,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const v = draft.trim();
    if (v !== value) onCommit(v);
  };
  return (
    <div className="rounded-lg bg-surface-sunken px-3 py-2">
      <p className="mb-1 text-[11px] text-text-subtle">{label}</p>
      <input
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") setDraft(value);
        }}
        className="w-full rounded-md bg-surface-raised px-2 py-1 font-mono text-xs text-text outline-none placeholder:text-text-subtle focus:ring-1 focus:ring-line"
      />
    </div>
  );
}

/** Shared config-section plumbing: load once, save a section, invalidate. */
function useConfigSection() {
  const qc = useQueryClient();
  const setError = useUI((s) => s.setError);
  const config = useQuery({ queryKey: ["config"], queryFn: getConfig });
  const save = (op: Promise<void>, alsoInvalidate?: string[]) => {
    op
      .then(() => {
        qc.invalidateQueries({ queryKey: ["config"] });
        for (const key of alsoInvalidate ?? [])
          qc.invalidateQueries({ queryKey: [key] });
      })
      .catch((e) => setError(String(e).split("\n")[0]));
  };
  return { config, save };
}

/** `[brain]` — oxibrain integration. oxibrain is a CLI invocation, not
 *  a daemon: the binary resolves via PATH unless overridden (brain 0.10
 *  cutover §3). */
function BrainSection() {
  const { t } = useI18n();
  const { config, save } = useConfigSection();
  const brain = config.data?.brain;

  const patch = (p: Partial<NonNullable<typeof brain>>) =>
    save(
      setBrainConfig({
        enabled: brain?.enabled ?? true,
        executable: brain?.executable ?? "",
        ...p,
      }),
      ["brain-status"],
    );

  if (!brain && config.isLoading) {
    return <p className="rounded-lg bg-surface-sunken px-3 py-2 text-[11px] text-text-subtle">…</p>;
  }

  return (
    <div className="space-y-1.5">
      <ToggleRow
        label={t.brain_enabled}
        checked={brain?.enabled ?? true}
        onChange={(v) => patch({ enabled: v })}
      />
      <TextRow
        label={t.brain_executable}
        value={brain?.executable ?? ""}
        placeholder={t.brain_executable_ph}
        onCommit={(v) => patch({ executable: v })}
      />
    </div>
  );
}

/** `[copilot]` — agent delegation (spec 2026-08-23). Detection is
 *  pane-local: probing never runs at app startup (§6). Activation is
 *  explicit and gated by a one-time provider-consent dialog (§12). */
function CopilotSection() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const setError = useUI((s) => s.setError);
  const { config, save } = useConfigSection();
  const setToast = useUI((s) => s.setToast);
  const setCopilotOpen = useUI((s) => s.setCopilotOpen);
  const setSettingsOpen = useUI((s) => s.setSettingsOpen);
  const status = useQuery({ queryKey: ["copilot-status"], queryFn: copilotStatus });
  const copilot = config.data?.copilot;
  const [candidates, setCandidates] = useState<AgentCandidate[] | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [activating, setActivating] = useState(false);
  const [pending, setPending] = useState<AgentCandidate | null>(null);

  const pendingDisclosure = useQuery({
    queryKey: ["copilot-disclosure", pending?.id ?? ""],
    queryFn: () => copilotDisclosure(pending!.id),
    enabled: pending !== null,
    staleTime: 60_000,
  });

  const detect = () => {
    setDetecting(true);
    copilotProbeAgents()
      .then(setCandidates)
      .catch((e) => setError(String(e).split("\n")[0]))
      .finally(() => setDetecting(false));
  };

  const activate = (c: AgentCandidate) => {
    setActivating(true);
    copilotActivate(c.id, c.executable)
      .then(() => {
        qc.invalidateQueries({ queryKey: ["config"] });
        qc.invalidateQueries({ queryKey: ["copilot-status"] });
        qc.invalidateQueries({ queryKey: ["copilot-disclosure"] });
        // Activation must VISIBLY do something: name the agent and offer
        // the one action that proves it (the FAB sits behind this modal).
        setToast(t.copilot_activated_toast.replace("{agent}", c.display_name), {
          label: t.copilot_open_panel,
          onClick: () => { setSettingsOpen(false); setCopilotOpen(true); },
        });
      })
      .catch((e) => setError(String(e).split("\n")[0]))
      .finally(() => {
        setActivating(false);
        setPending(null);
      });
  };

  const patch = (p: Partial<NonNullable<typeof copilot>>) =>
    save(
      setCopilotConfig({
        enabled: copilot?.enabled ?? true,
        agent: copilot?.agent ?? "",
        executable: copilot?.executable ?? "",
        timeout_secs: copilot?.timeout_secs ?? 300,
        ...p,
      }),
      ["copilot-status"],
    );

  const activeAgent = copilot?.agent ?? "";
  const disclosure = useQuery({
    queryKey: ["copilot-disclosure", activeAgent],
    queryFn: () => copilotDisclosure(activeAgent),
    enabled: activeAgent !== "",
    staleTime: 60_000,
  });

  return (
    <div className="space-y-2">
      <ToggleRow
        label={t.copilot_enabled}
        checked={copilot?.enabled ?? true}
        onChange={(v) => patch({ enabled: v })}
      />

      {activeAgent !== "" ? (
        <div className="rounded-lg bg-surface-sunken px-3 py-2">
          <div className="flex items-center justify-between">
            <p className="text-[11px] text-text-subtle">{t.copilot_active_agent}</p>
            <button
              type="button"
              onClick={() => {
                patch({ agent: "", executable: "" });
                qc.invalidateQueries({ queryKey: ["copilot-status"] });
              }}
              className="text-[10px] text-text-muted underline underline-offset-2 hover:text-text"
            >
              {t.copilot_deactivate}
            </button>
          </div>
          <p className="mt-0.5 text-xs font-medium text-text">
            {status.data?.agent_name ?? activeAgent}
          </p>
          <p className="truncate font-mono text-[10px] text-text-subtle">
            {activeAgent} · {copilot?.executable}
          </p>
          <p className="mt-1 text-[10px] text-text-subtle">
            {disclosure.data?.provider
              ? `${disclosure.data.provider}${disclosure.data.model ? ` · ${disclosure.data.model}` : ""}`
              : t.copilot_consent_unknown_provider}
          </p>
          {/* Verified read-only defaults (claude -p denies writes, codex
              exec sandbox is read-only unless the user configured
              otherwise): say so — the fix lives in the agent's own
              settings (spec §11), not here. */}
          {(activeAgent === "claude" || activeAgent === "codex") && (
            <p className="mt-1 text-[10px] leading-snug text-text-subtle">
              {t.copilot_policy_readonly}
            </p>
          )}
        </div>
      ) : (
        <button
          type="button"
          disabled={detecting}
          onClick={detect}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-interactive-primary px-2 py-2 text-xs font-medium text-interactive-primary-foreground transition-colors hover:bg-interactive-primary/90 disabled:opacity-50"
        >
          <RefreshCw size={12} className={detecting ? "animate-spin" : ""} />
          {detecting ? t.copilot_detecting : t.copilot_detect}
        </button>
      )}

      {activeAgent === "" && candidates !== null && (
        <div className="space-y-1.5">
          {candidates.length === 0 && (
            <p className="rounded-lg bg-surface-sunken px-3 py-2 text-[11px] text-text-subtle">
              {t.copilot_none_found}
            </p>
          )}
          {candidates.map((c) => (
            <div key={c.id} className="rounded-lg bg-surface-sunken px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs text-text">{c.display_name}</p>
                  <p className="truncate font-mono text-[10px] text-text-subtle">
                    {c.executable}
                  </p>
                </div>
                {c.supported ? (
                  <button
                    type="button"
                    disabled={activating}
                    onClick={() => setPending(c)}
                    className="shrink-0 rounded-md bg-surface-raised px-2 py-1 text-[10px] font-medium text-text transition-colors hover:bg-surface-muted"
                  >
                    {activating ? t.copilot_activating : t.copilot_activate}
                  </button>
                ) : (
                  <span className="shrink-0 text-[10px] text-text-subtle">
                    {t.copilot_unsupported}
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-[10px] text-text-subtle">
                {c.version ?? t.copilot_version_unknown}
              </p>
            </div>
          ))}
        </div>
      )}

      {activeAgent !== "" && (
        <NumberRow
          label={t.copilot_timeout}
          value={copilot?.timeout_secs ?? 300}
          min={10}
          max={3600}
          onCommit={(v) => patch({ timeout_secs: v })}
        />
      )}

      {/* Consent dialog (§12): shown at activation. The text names the
          agent and where data may travel — an honest "unknown provider"
          when the agent's config is unreadable. */}
      {pending && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="w-[380px] rounded-[var(--dialog-radius)] border border-line bg-surface p-4 shadow-lg">
            <p className="text-sm font-semibold text-text">{t.copilot_consent_title}</p>
            <p className="mt-2 text-xs leading-relaxed text-text-muted">
              {t.copilot_consent_body
                .replace("{agent}", pending.display_name)
                .replace(
                  "{provider}",
                  pendingDisclosure.data?.provider ?? t.copilot_consent_unknown_provider,
                )}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPending(null)}
                className="rounded-lg bg-surface-muted px-3 py-1.5 text-xs text-text-muted transition-colors hover:text-text"
              >
                {t.copilot_consent_cancel}
              </button>
              <button
                type="button"
                disabled={activating}
                onClick={() => activate(pending)}
                className="rounded-lg bg-interactive-primary px-3 py-1.5 text-xs font-medium text-interactive-primary-foreground transition-colors hover:bg-interactive-primary/90 disabled:opacity-50"
              >
                {activating ? t.copilot_activating : t.copilot_consent_accept}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** `[general]` — behavior knobs. */
function GeneralSection() {
  const { t } = useI18n();
  const { config, save } = useConfigSection();
  return (
    <NumberRow
      label={t.general_trash_days}
      value={config.data?.general?.trash_retention_days ?? 30}
      min={1}
      max={365}
      onCommit={(v) => save(setGeneralConfig({ trash_retention_days: v }))}
    />
  );
}

/** `[capture]` — overlay and trigger tuning. */
function CaptureSection() {
  const { t } = useI18n();
  const { config, save } = useConfigSection();
  const capture = config.data?.capture;
  return (
    <div className="space-y-1.5">
      <NumberRow
        label={t.capture_threshold}
        value={capture?.double_tap_threshold_ms ?? 350}
        min={100}
        max={1000}
        onCommit={(v) =>
          save(
            setCaptureConfig({
              double_tap_threshold_ms: v,
              overlay_max_height: capture?.overlay_max_height ?? 400,
            }),
          )
        }
      />
      <NumberRow
        label={t.capture_overlay_height}
        value={capture?.overlay_max_height ?? 400}
        min={120}
        max={600}
        onCommit={(v) =>
          save(
            setCaptureConfig({
              double_tap_threshold_ms: capture?.double_tap_threshold_ms ?? 350,
              overlay_max_height: v,
            }),
          )
        }
      />
    </div>
  );
}

/** `[index]` — power-user watcher tuning. */
function AdvancedSection() {
  const { t } = useI18n();
  const { config, save } = useConfigSection();
  return (
    <NumberRow
      label={t.advanced_debounce}
      value={config.data?.index?.watcher_debounce_ms ?? 300}
      min={50}
      max={2000}
      onCommit={(v) => save(setIndexConfig({ watcher_debounce_ms: v }))}
    />
  );
}

/** Folder management section: list, create, pin, delete folders from the
 *  vault. Wired to the IPC bridge defined in `lib/api.ts`. Delete trashes
 *  the folder's live notes (no more note_count guard) and offers undo via
 *  restoreNotes; the button uses the same two-click arm as the reset row
 *  because window.confirm no-ops in Tauri's WKWebView. */
function FoldersSection() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const setError = useUI((s) => s.setError);
  const setToast = useUI((s) => s.setToast);
  const setFolderFilter = useUI((s) => s.setFolderFilter);

  const foldersQ = useQuery({ queryKey: ["folders"], queryFn: listFolders });
  const configQ = useQuery({ queryKey: ["config"], queryFn: getConfig });
  const { displayName: displayFolder } = useFolderNames();
  // and can neither be deleted nor filtered meaningfully.
  const list = (foldersQ.data ?? []).filter((f) => f.path !== "");

  const [armedPath, setArmedPath] = useState<string | null>(null);
  const armTimer = useRef<number | null>(null);

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["folders"] });
    qc.invalidateQueries({ queryKey: ["folderChildren"] });
    qc.invalidateQueries({ queryKey: ["config"] });
    qc.invalidateQueries({ queryKey: ["facets"] });
    qc.invalidateQueries({ queryKey: ["memos"] });
  };


  const disarm = () => {
    setArmedPath(null);
    if (armTimer.current) {
      window.clearTimeout(armTimer.current);
      armTimer.current = null;
    }
  };

  const onDeleteClick = (path: string) => {
    if (armedPath !== path) {
      // Two-click confirm: first click arms (red, confirm label), second
      // within 4s commits — window.confirm is unreliable in the WKWebView.
      disarm();
      setArmedPath(path);
      armTimer.current = window.setTimeout(disarm, 4000);
      return;
    }
    disarm();
    void deleteFolder(path)
      .then((ids) => {
        invalidateAll();
        setToast(
          t.folder_deleted.replace("{folder}", path.split("/").at(-1) ?? path),
          {
            label: t.undo,
            onClick: () => {
              void restoreNotes(ids)
                .then(() => {
                  if (ids.length === 0) void createFolder(path); // folder had no notes
                  qc.invalidateQueries({ queryKey: ["folderChildren"] });
                  qc.invalidateQueries({ queryKey: ["folders"] });
                })
                .catch((e) => setError(String(e).split("\n")[0]));
            },
          },
        );
      })
      .catch((e) => setError(String(e).split("\n")[0]));
  };

  const onTogglePin = (path: string, pinned: boolean) => {
    void setFolderPinned(path, pinned)
      .then(() => qc.invalidateQueries({ queryKey: ["config"] }))
      .catch((e) => setError(String(e).split("\n")[0]));
  };

  return (
    <div className="space-y-1.5">
      {foldersQ.isLoading && (
        <p className="rounded-lg bg-surface-sunken px-3 py-2 text-[11px] text-text-subtle">
          …
        </p>
      )}
      {list.map((f: FolderEntry) => {
        const pinned = configQ.data?.folders?.find((d) => d.path === f.path)?.pinned ?? false;
        const armed = armedPath === f.path;
        return (
          <div
            key={f.path}
            className="group flex items-center gap-2 rounded-lg bg-surface-sunken px-2.5 py-1.5"
          >
            <Folder size={14} className="shrink-0 text-text-subtle" />
            <button
              type="button"
              onClick={() => setFolderFilter(f.path)}
              className="min-w-0 flex-1 truncate text-left text-xs text-text-muted hover:text-text"
            >
              {displayFolder(f.path)}
            </button>
            <span className="text-[10px] text-text-subtle">{f.note_count}</span>
            <button
              type="button"
              onClick={() => onTogglePin(f.path, !pinned)}
              aria-label={pinned ? t.unpin_from_sidebar : t.pin_to_sidebar}
              title={pinned ? t.unpin_from_sidebar : t.pin_to_sidebar}
              className={`rounded-md p-1 transition-colors ${
                pinned
                  ? "text-hue-amber hover:bg-surface-muted"
                  : "text-text-subtle hover:bg-surface-muted hover:text-text"
              }`}
            >
              {pinned ? <Pin size={12} className="fill-hue-amber" /> : <PinOff size={12} />}
            </button>
            <button
              type="button"
              onClick={() => onDeleteClick(f.path)}
              aria-label={armed ? t.delete_confirm_arm : t.action_delete}
              title={
                armed
                  ? t.delete_folder_confirm
                      .replace("{folder}", f.path)
                      // Recursive count (entry + descendants from the flat
                      // list) — the delete trashes nested notes too, so the
                      // confirm must state the full scope, not note_count.
                      .replace(
                        "{n}",
                        String(
                          list
                            .filter((e) => e.path === f.path || e.path.startsWith(`${f.path}/`))
                            .reduce((sum, e) => sum + e.note_count, 0),
                        ),
                      )
                  : t.action_delete
              }
              className={`rounded-md p-1 transition-colors ${
                armed
                  ? "bg-status-error-subtle text-status-error"
                  : "text-text-subtle hover:bg-status-error-subtle hover:text-status-error"
              }`}
            >
              <Trash2 size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
/**
 * The single collections pane: every preset — system pair + the five
 * installables — in one place. Each row is install/uninstall by
 * switch; an installed row expands into that collection's own
 * settings (path + goto always; 데일리 노트 표시 for daily, 복습 큐
 * for knowledge, provider keys for book/movie). Collections accrue
 * settings independently — the expand area is the per-collection
 * home, so the pane scales without new rail tabs.
 */
function CollectionsSection() {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const setError = useUI((s) => s.setError);
  const setFolderFilter = useUI((s) => s.setFolderFilter);
  const setSettingsOpen = useUI((s) => s.setSettingsOpen);
  const setFavoritesOnly = useUI((s) => s.setFavoritesOnly);
  const setReviewMode = useUI((s) => s.setReviewMode);
  const config = useQuery({ queryKey: ["config"], queryFn: getConfig });
  const folders = useQuery({ queryKey: ["folders"], queryFn: listFolders });
  const schemaInfo = useSchemaInfo((folders.data ?? []).map((f) => f.path));
  const dailyFolder = config.data?.daily?.folder ?? "daily";
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const armTimer = useRef<number | null>(null);

  interface Row {
    id: string;
    icon: LucideIcon;
    nameKey: DictKey;
    descKey?: DictKey;
    system: boolean;
  }
  const rows: Row[] = [
    ...SYSTEM_COLLECTIONS.map((s) => ({ ...s, system: true })),
    ...COLLECTION_CATALOG.map((c) => ({
      id: c.id,
      icon: c.icon,
      nameKey: c.nameKey,
      descKey: c.descKey,
      system: false,
    })),
  ];

  /** Installed folder path or null — [meta].preset marker first, then
   * the system-path fallback (pre-marker folders, spec §2.1). */
  const installedFolder = (id: string): string | null => {
    const marked = (folders.data ?? []).find(
      (f) => schemaInfo[f.path]?.meta?.preset === id,
    );
    if (marked) return marked.path;
    if (id === "knowledge" || id === "daily") {
      const fallback = id === "daily" ? dailyFolder : "knowledge";
      return (folders.data ?? []).some((f) => f.path === fallback) ? fallback : null;
    }
    return null;
  };

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["folders"] });
    void qc.invalidateQueries({ queryKey: ["folder-schema"] });
    void qc.invalidateQueries({ queryKey: ["folderChildren"] });
    // Pins/views live in config — the sidebar's 위치 rows and this pane's
    // default-view segments read it, so installs/uninstalls must refresh it.
    void qc.invalidateQueries({ queryKey: ["config"] });
  };
  const disarm = () => {
    setArmed(null);
    if (armTimer.current) {
      window.clearTimeout(armTimer.current);
      armTimer.current = null;
    }
  };

  const install = (row: Row) => {
    if (busy) return;
    const existing = installedFolder(row.id);
    const folder =
      existing ??
      (row.system
        ? row.id === "daily"
          ? dailyFolder
          : "knowledge"
        : COLLECTION_CATALOG.find((c) => c.id === row.id)!.defaultFolder[locale]);
    setBusy(row.id);
    // Installing means the user wants the collection at hand: pin it to the
    // sidebar's 위치 section so it appears immediately (user report
    // 2026-08-23 — installed collections were only reachable via 볼트 tiles).
    // Uninstalling deletes the folder, which prunes the pin with it.
    void installCollection(row.id, folder)
      .then(() => setFolderPinned(folder, true))
      .then(() => {
        invalidate();
        setExpanded(row.id);
      })
      .catch((e) => setError(String(e).split("\n")[0]))
      .finally(() => setBusy(null));
  };

  const uninstall = (row: Row, folder: string) => {
    if (busy) return;
    // Two-click confirm: first click arms (red warning + confirm label),
    // second within 4s commits — window.confirm is unreliable inside the
    // WKWebView. Disarming explicitly on install, on a different row, and on
    // timer expiry keeps the second click unambiguously aimed at commit
    // rather than "the row is gone but still armed".
    if (armed !== row.id) {
      disarm();
      setArmed(row.id);
      armTimer.current = window.setTimeout(disarm, 4000);
      return;
    }
    if (!window.confirm(t.collection_remove_confirm)) {
      disarm();
      return;
    }
    disarm();
    setBusy(row.id);
    setExpanded((e) => (e === row.id ? null : e));
    void deleteFolder(folder)
      .then(invalidate)
      .catch((e) => setError(String(e).split("\n")[0]))
      .finally(() => setBusy(null));
  };

  const gotoFolder = (folder: string) => {
    setSettingsOpen(false);
    setFavoritesOnly(false);
    setFolderFilter(folder);
  };

  return (
    <section>
      <PaneHeader title={t.section_collections} />
      <div className="space-y-1.5">
        {rows.map((row) => {
          const folder = installedFolder(row.id);
          const Icon = row.icon;
          const isArmed = armed === row.id;
          const isOpen = expanded === row.id && !!folder;
          return (
            <div
              key={row.id}
              className={
                "rounded-lg border px-3 py-2 transition-colors " +
                (isArmed ? "border-status-error bg-status-error-subtle" : "border-line bg-surface-sunken")
              }
            >
              <div className="flex items-center gap-2.5">
                <Icon size={15} className="shrink-0 text-text-subtle" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-text">{t[row.nameKey]}</p>
                  {!folder && (
                    <p className="mt-0.5 line-clamp-1 text-[10px] leading-snug text-text-subtle">
                      {(row.descKey && t[row.descKey]) || t.collection_not_installed}
                    </p>
                  )}
                </div>
                {folder && (
                  <button
                    type="button"
                    onClick={() => setExpanded((e) => (e === row.id ? null : row.id))}
                    aria-expanded={isOpen}
                    aria-label={t.collection_settings}
                    className="shrink-0 rounded-md p-1 text-text-subtle transition-colors hover:bg-surface-muted hover:text-text"
                  >
                    <ChevronDown
                      size={13}
                      className={"transition-transform duration-150 " + (isOpen ? "" : "rotate-180")}
                    />
                  </button>
                )}
                <button
                  type="button"
                  role="switch"
                  aria-checked={!!folder}
                  aria-label={t[row.nameKey]}
                  onClick={() => {
                    // Always read installedFolder fresh — uninstall may be
                    // mid-flight and the closure value would lag by one render.
                    const f = installedFolder(row.id);
                    if (f) uninstall(row, f);
                    else {
                      disarm(); // hitting install also clears any stale arm
                      install(row);
                    }
                  }}
                  className={
                    "relative h-5 w-9 shrink-0 rounded-full transition-colors " +
                    (folder ? "bg-interactive-primary" : "bg-line")
                  }
                >
                  <span
                    className={
                      "absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-surface-raised shadow transition-transform " +
                      (folder ? "translate-x-[18px]" : "translate-x-0")
                    }
                  />
                </button>
              </div>
              {isArmed && (
                <p className="mt-1.5 text-[10px] leading-snug text-status-error">
                  {row.system ? t.collection_system_note : t.collection_uninstall_note}
                  {" · "}
                  {t.collection_remove_confirm}
                </p>
              )}
              {isOpen && (
                <div className="mt-2 space-y-1.5 border-t border-line pt-2">
                  <div className="flex items-center gap-1.5">
                    <code className="min-w-0 flex-1 truncate rounded-md bg-surface px-2 py-1 font-mono text-[10px] text-text-muted">
                      {folder}
                    </code>
                    <button
                      type="button"
                      onClick={() => gotoFolder(folder)}
                      className="flex shrink-0 items-center gap-1 rounded-md border border-line px-2 py-1 text-[10px] font-medium text-text-muted transition-colors hover:bg-surface-muted"
                    >
                      <FolderTree size={11} />
                      {t.collection_goto_folder}
                    </button>
                  </div>
                  {row.id === "daily" && (
                    <ToggleRow
                      label={t.collection_daily_enabled}
                      checked={config.data?.daily?.enabled ?? true}
                      onChange={(v) =>
                        setDailyConfig({ enabled: v, folder: dailyFolder })
                          .then(() => qc.invalidateQueries({ queryKey: ["config"] }))
                          .catch((e) => setError(String(e).split("\n")[0]))
                      }
                    />
                  )}
                  {schemaInfo[folder]?.review != null && (
                    <button
                      type="button"
                      onClick={() => {
                        gotoFolder(folder);
                        setReviewMode(true);
                      }}
                      className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-line px-2 py-1.5 text-[11px] font-medium text-text-muted transition-colors hover:bg-surface-muted"
                    >
                      <ListChecks size={12} />
                      {t.palette_review_queue}
                    </button>
                  )}
                  {(row.id === "book" || row.id === "movie") && (
                    <MetadataRegionSelect />
                  )}
                  {(row.id === "book" || row.id === "movie") && (
                    <ProviderKeys domain={row.id} />
                  )}
                  <div>
                    <p className="mb-1 text-[11px] text-text-subtle">{t.collection_default_view}</p>
                    <Segmented
                      value={config.data?.folders?.find((f) => f.path === folder)?.view ?? "grid"}
                      onChange={(v) => {
                        void setFolderView(folder, v === "grid" ? null : v)
                          .then(() => qc.invalidateQueries({ queryKey: ["config"] }))
                          .catch((e) => setError(String(e).split("\n")[0]));
                      }}
                      options={
                        row.id === "book" || row.id === "movie"
                          ? [
                              { value: "grid", label: t.view_label_grid },
                              { value: "shelf", label: t.view_label_shelf },
                            ]
                          : [
                              { value: "grid", label: t.view_label_grid },
                              { value: "list", label: t.view_label_list },
                            ]
                      }
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-[10px] leading-relaxed text-text-subtle">
        {t.collection_rename_hint}
      </p>
    </section>
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
          {status === "error" ? t.update_check : t.update_check}
        </button>
      )}
    </div>
  );
}
export function SettingsMenu() {
  const { t, locale, setLocale } = useI18n();
  const theme = useUI((s) => s.theme);
  const setTheme = useUI((s) => s.setTheme);
  const settingsOpen = useUI((s) => s.settingsOpen);
  const setSettingsOpen = useUI((s) => s.setSettingsOpen);
  const settingsTab = useUI((s) => s.settingsTab);
  const setSettingsTab = useUI((s) => s.setSettingsTab);
  const qc = useQueryClient();
  const setError = useUI((s) => s.setError);
  const setToast = useUI((s) => s.setToast);
  const updateAvailable = useUI((s) => s.updateAvailable);

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

  const config = useQuery({ queryKey: ["config"], queryFn: getConfig });

  const onTheme = (v: Theme) => {
    setTheme(v);
    applyTheme(v);
    // TOML ⇄ GUI parity: the theme Segmented writes through to
    // `appearance.theme` (localStorage keeps its role as the instant cache).
    setAppearanceConfig({
      theme: v,
      show_dock_icon: config.data?.appearance?.show_dock_icon ?? true,
    })
      .then(() => qc.invalidateQueries({ queryKey: ["config"] }))
      .catch(() => {});
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
          r.hash_repair_failed +
          (r.merge_required ? 1 : 0);
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

  const [activeTab, setActiveTab] = useState<string>("general");
  // One-shot tab request (⌘K 컬렉션 관리): adopt on open, then clear.
  useEffect(() => {
    if (settingsOpen && settingsTab) {
      setActiveTab(settingsTab);
      setSettingsTab(null);
    }
  }, [settingsOpen, settingsTab, setSettingsTab]);
  const rail: { group: string; items: { id: string; label: string; icon: ReactNode }[] }[] = [
    {
      group: t.settings_group_general,
      items: [
        { id: "general", label: t.settings_group_general, icon: <Settings size={13} /> },
        { id: "capture", label: t.section_capture, icon: <Zap size={13} /> },
      ],
    },
    {
      group: t.settings_group_integrations,
      items: [
        { id: "brain", label: t.section_brain, icon: <Brain size={13} /> },
        { id: "copilot", label: t.section_copilot, icon: <Bot size={13} /> },
      ],
    },
    {
      // Collections are special folders — vault-scoped management
      // (installed presets, folder tree) lives together.
      group: t.settings_group_vault,
      items: [
        { id: "collections", label: t.section_collections, icon: <Library size={13} /> },
        { id: "folders", label: t.section_folders, icon: <FolderTree size={13} /> },
      ],
    },
    {
      group: t.settings_group_system,
      items: [
        { id: "storage", label: t.section_storage, icon: <HardDrive size={13} /> },
        { id: "updates", label: t.section_updates, icon: <DownloadCloud size={13} /> },
        { id: "cli", label: t.section_cli, icon: <Terminal size={13} /> },
      ],
    },
  ];

  return (
    <Dialog.Root open={settingsOpen} onOpenChange={setSettingsOpen}>
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
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm transition-opacity duration-200 ease-out data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <Dialog.Popup
          className="fixed left-1/2 top-1/2 z-50 flex h-[min(640px,85vh)] w-[min(880px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[var(--dialog-radius)] border border-line bg-surface shadow-lg transition-[opacity,scale] duration-200 ease-out data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0 data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0"
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
            <h1 className="text-sm font-semibold text-text">{t.settings}</h1>
            <Dialog.Close
              aria-label={t.close}
              className="rounded-lg p-1 text-text-subtle transition-colors hover:bg-surface-muted hover:text-text-muted"
            >
              <X size={16} />
            </Dialog.Close>
          </div>

          {/* Body: category rail + active pane */}
          <div className="flex min-h-0 flex-1">
            <nav
              aria-label={t.settings}
              className="w-[200px] shrink-0 overflow-y-auto border-r border-line py-2"
            >
              {rail.map((group, gi) => (
                <div key={group.group || `g${gi}`} className="mb-1">
                  {group.group && (
                    <p className="px-3 pb-1 pt-2.5 text-[10px] font-medium uppercase tracking-wide text-text-subtle">
                      {group.group}
                    </p>
                  )}
                  {group.items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setActiveTab(item.id)}
                      aria-current={activeTab === item.id ? "page" : undefined}
                      className={
                        "flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs transition-colors " +
                        (activeTab === item.id
                          ? "bg-surface-muted font-medium text-text"
                          : "text-text-muted hover:bg-surface-muted/50 hover:text-text")
                      }
                    >
                      {item.icon}
                      {item.label}
                    </button>
                  ))}
                </div>
              ))}
            </nav>
            <div className="min-w-0 flex-1 overflow-y-auto px-6 py-4">
              {activeTab === "general" && (
                <section>
                  <PaneHeader title={t.settings_group_general} />
                  <SectionLabel title={t.section_appearance} />
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
                  <div className="mt-2.5">
                    <ToggleRow
                      label={t.dock_icon}
                      checked={config.data?.appearance?.show_dock_icon ?? true}
                      onChange={(v) =>
                        setAppearanceConfig({
                          theme: theme,
                          show_dock_icon: v,
                        })
                          .then(() => qc.invalidateQueries({ queryKey: ["config"] }))
                          .catch((e) => setError(String(e).split("\n")[0]))
                      }
                    />
                  </div>
                  <SectionLabel title={t.section_general} />
                  <GeneralSection />
                  <SectionLabel title={t.section_advanced} />
                  <AdvancedSection />
                </section>
              )}
              {activeTab === "capture" && (
                <section>
                  <PaneHeader title={t.section_capture} />
                  <CaptureSection />
                  <div className="mt-2 flex items-center justify-between rounded-lg bg-surface-sunken px-3 py-2">
                    <span className="text-xs text-text-muted">{t.capture_shortcut}</span>
                    <kbd className="font-mono text-xs text-text-subtle">⌘⇧N</kbd>
                  </div>
                </section>
              )}
              {activeTab === "brain" && (
                <section>
                  <PaneHeader title={t.section_brain} />
                  <BrainSection />
                </section>
              )}

              {activeTab === "copilot" && (
                <section>
                  <PaneHeader title={t.section_copilot} />
                  <CopilotSection />
                </section>
              )}
              {activeTab === "folders" && (
                <section>
                  <PaneHeader title={t.section_folders} />
                  <FoldersSection />
                </section>
              )}
              {activeTab === "storage" && (
                <section>
                  <PaneHeader title={t.section_storage} />
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
                    <div>
                      <ToggleRow
                        label={t.git_autocommit}
                        checked={config.data?.git?.auto_commit ?? true}
                        onChange={(v) =>
                          setGitConfig({
                            auto_commit: v,
                            adopt_foreign_repo:
                              config.data?.git?.adopt_foreign_repo ?? false,
                          })
                            .then(() => qc.invalidateQueries({ queryKey: ["config"] }))
                            .catch((e) => setError(String(e).split("\n")[0]))
                        }
                      />
                      <p className="mt-1 px-3 text-[11px] leading-relaxed text-text-subtle">
                        {t.git_autocommit_hint}
                      </p>
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
                </section>
              )}
              {activeTab === "cli" && (
                <section>
                  <PaneHeader title={t.section_cli} />
                  <CliSection />
                </section>
              )}
              {activeTab === "updates" && (
                <section>
                  <PaneHeader title={t.section_updates} />
                  <UpdaterSection />
                  <SectionLabel title={t.section_about} />
                  <div className="flex items-center justify-between rounded-lg bg-surface-sunken px-3 py-2">
                    <span className="text-xs text-text-muted">oximemo</span>
                    <span className="font-mono text-xs text-text-subtle">v{APP_VERSION}</span>
                  </div>
                  <div className="mt-1.5 space-y-1.5">
                    {(
                      [
                        [t.shortcut_palette, "⌘K"],
                        [t.shortcut_new_note, "⌘N"],
                        [t.capture_shortcut, "⌘⇧N"],
                        [t.shortcut_goto_root, "⌘↑"],
                      ] as const
                    ).map(([label, keys]) => (
                      <div
                        key={keys}
                        className="flex items-center justify-between rounded-lg bg-surface-sunken px-3 py-2"
                      >
                        <span className="text-xs text-text-muted">{label}</span>
                        <kbd className="font-mono text-xs text-text-subtle">{keys}</kbd>
                      </div>
                    ))}
                  </div>
                </section>
              )}
              {activeTab === "collections" && <CollectionsSection />}
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
