/**
 * Copilot floating window (spec 2026-08-23, revised 2026-08-24): delegates
 * vault tasks to the user-activated terminal-agent CLI. One turn = one
 * subprocess; results arrive whole (no token streaming — the only uniform
 * denominator across agents). The "changed notes" list claims observation,
 * never causality (§9.4): the vault is shared, other writers exist.
 *
 * Layering: the note editor is a z-50 dialog — this window sits at z-[60]
 * so the copilot stays usable WHILE a note is open, exactly like the
 * selection-context flow it serves (§7 selection block). The entry points
 * are the bottom-right FAB and ⌘⇧C, both above every dialog layer.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  Bot,
  ChevronDown,
  Loader2,
  MessageSquarePlus,
  Send,
  Square,
  TextSelect,
  X,
} from "lucide-react";
import { useI18n } from "../lib/i18n";
import { useUI } from "../stores/ui";
import {
  copilotCancel,
  copilotStatus,
  copilotDisclosure,
  copilotModels,
  copilotSetModel,
  copilotSend,
  getMemo,
  type ModelInfo,
  type TurnResult,
  type ActiveMemoRef,
} from "../lib/api";

type Entry =
  | { role: "user"; text: string }
  | { role: "agent"; result: TurnResult }
  | { role: "error"; text: string };

export function CopilotPanel() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const setCopilotOpen = useUI((s) => s.setCopilotOpen);
  const selectedId = useUI((s) => s.selectedId);
  const selection = useUI((s) => s.copilotSelection);
  const setCopilotSelection = useUI((s) => s.setCopilotSelection);
  const setError = useUI((s) => s.setError);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [session, setSession] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [activeMemo, setActiveMemo] = useState<ActiveMemoRef | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [switchingModel, setSwitchingModel] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const status = useQuery({ queryKey: ["copilot-status"], queryFn: copilotStatus });
  const agentId = status.data?.agent ?? "";
  const agentName = status.data?.agent_name ?? agentId;
  const disclosure = useQuery({
    queryKey: ["copilot-disclosure", agentId],
    queryFn: () => copilotDisclosure(agentId),
    staleTime: 60_000,
    enabled: agentId !== "",
  });
  const models = useQuery({
    queryKey: ["copilot-models", agentId],
    queryFn: copilotModels,
    enabled: pickerOpen && agentId !== "",
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    let cancelled = false;
    if (!selectedId) {
      setActiveMemo(null);
      return;
    }
    getMemo(selectedId)
      .then((m) => {
        if (cancelled) return;
        setActiveMemo({
          id: m.id,
          title: m.title ?? "",
          path: m.path,
        });
      })
      .catch(() => setActiveMemo(null));
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  // Agent identity change = new conversation (spec §15): session ids are
  // not portable across activations, let alone adapters. Neither is a
  // per-conversation model choice.
  useEffect(() => {
    setEntries([]);
    setSession(null);
    setModel(null);
  }, [agentId]);

  // The selection belongs to the memo it was made in; never attach a
  // stale selection from a previously open note.
  const attachedSelection =
    selection && activeMemo && selection.memoId === activeMemo.id ? selection.text : null;

  const send = async () => {
    const message = draft.trim();
    if (!message || busy) return;
    setDraft("");
    setEntries((es) => [...es, { role: "user", text: message }]);
    setBusy(true);
    try {
      const memo: ActiveMemoRef | null = activeMemo
        ? { ...activeMemo, selection: attachedSelection }
        : null;
      const result = await copilotSend(message, memo, session, model);
      if (result.session_id) setSession(result.session_id);
      setEntries((es) => [...es, { role: "agent", result }]);
      if (result.changed.length > 0) {
        void qc.invalidateQueries({ queryKey: ["memos"] });
      }
    } catch (e) {
      setEntries((es) => [...es, { role: "error", text: String(e).split("\n")[0] }]);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    try {
      await copilotCancel();
    } catch (e) {
      setError(String(e).split("\n")[0]);
    }
  };

  // oxios has no per-turn model flag: picking a model rewrites its durable
  // `engine.default_model` via its own `config set`, and the disclosure
  // (header) follows. omp models ride each turn as `--model`.
  const pickModel = (m: ModelInfo) => {
    if (agentId === "oxios") {
      setSwitchingModel(true);
      copilotSetModel(m.id)
        .then(() => {
          setPickerOpen(false);
          void qc.invalidateQueries({ queryKey: ["copilot-disclosure"] });
        })
        .catch((e) => setError(String(e).split("\n")[0]))
        .finally(() => setSwitchingModel(false));
    } else {
      setModel(m.id);
      setPickerOpen(false);
    }
  };

  const provider =
    disclosure.data?.provider ?? t.copilot_consent_unknown_provider;
  const currentModelLabel =
    agentId === "oxios"
      ? disclosure.data?.model ?? t.copilot_model_auto
      : model ?? t.copilot_model_auto;

  return (
    <aside
      aria-label={t.copilot_panel_title}
      className="fixed bottom-6 right-6 z-[60] flex h-[min(72vh,580px)] w-[min(92vw,380px)] flex-col overflow-hidden rounded-[var(--dialog-radius)] border border-line bg-surface-raised shadow-2xl"
    >
      {/* Header: agent + provider are always visible (§12) — the user
          should never have to wonder where their data is going. */}
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Bot size={14} className="shrink-0 text-text-subtle" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold text-text">
            {t.copilot_panel_title} · {agentName}
          </p>
          <p className="truncate text-[10px] text-text-subtle">
            {currentModelLabel.split("/").pop()} · {provider}
          </p>
        </div>
        <div className="relative">
          <button
            type="button"
            aria-label={t.copilot_model}
            title={
              agentId === "oxios" ? t.copilot_model_global_hint : t.copilot_model
            }
            disabled={switchingModel}
            onClick={() => setPickerOpen((v) => !v)}
            className="flex max-w-[140px] items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-text-muted transition-colors hover:bg-surface-muted hover:text-text disabled:opacity-50"
          >
            {switchingModel ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <ChevronDown size={11} />
            )}
            <span className="truncate">{currentModelLabel.split("/").pop()}</span>
          </button>
          {pickerOpen && (
            <div className="absolute right-0 top-full z-[61] mt-1 max-h-[280px] w-[300px] overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-lg">
              {agentId === "oxios" && (
                <p className="px-2 py-1.5 text-[10px] leading-snug text-text-subtle">
                  {t.copilot_model_global_hint}
                </p>
              )}
              {models.isLoading && (
                <p className="flex items-center gap-2 px-2 py-2 text-[11px] text-text-subtle">
                  <Loader2 size={11} className="animate-spin" />
                  {t.copilot_detecting}
                </p>
              )}
              {models.isError && (
                <p className="px-2 py-2 text-[11px] text-red-500">
                  {t.copilot_model_none}
                </p>
              )}
              {models.data?.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => pickModel(m)}
                  className={`flex w-full items-baseline justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-surface-muted ${
                    m.id === currentModelLabel ? "text-text font-medium" : "text-text-muted"
                  }`}
                >
                  <span className="truncate">{m.name}</span>
                  <span className="shrink-0 font-mono text-[9px] text-text-subtle">
                    {m.provider}
                    {m.context_window ? ` · ${Math.round(m.context_window / 1000)}K` : ""}
                  </span>
                </button>
              ))}
              {agentId !== "oxios" && model !== null && (
                <button
                  type="button"
                  onClick={() => {
                    setModel(null);
                    setPickerOpen(false);
                  }}
                  className="w-full rounded-md px-2 py-1.5 text-left text-[11px] text-text-muted transition-colors hover:bg-surface-muted"
                >
                  {t.copilot_model_auto}
                </button>
              )}
            </div>
          )}
        </div>
        <button
          type="button"
          aria-label={t.copilot_new_chat}
          title={t.copilot_new_chat}
          onClick={() => {
            setEntries([]);
            setSession(null);
            setModel(null);
          }}
          className="rounded-md p-1.5 text-text-subtle transition-colors hover:bg-surface-muted hover:text-text"
        >
          <MessageSquarePlus size={14} />
        </button>
        <button
          type="button"
          aria-label="close"
          onClick={() => setCopilotOpen(false)}
          className="rounded-md p-1.5 text-text-subtle transition-colors hover:bg-surface-muted hover:text-text"
        >
          <X size={14} />
        </button>
      </div>

      {activeMemo && (
        <p className="border-b border-line bg-surface-sunken px-3 py-1.5 text-[10px] text-text-subtle">
          {activeMemo.title || activeMemo.path}
        </p>
      )}
      {attachedSelection && (
        <div className="flex items-start gap-1.5 border-b border-line bg-surface-sunken px-3 py-1.5">
          <TextSelect size={11} className="mt-0.5 shrink-0 text-text-subtle" />
          <p className="min-w-0 flex-1 truncate text-[10px] text-text-muted" title={attachedSelection}>
            {t.copilot_selection_chip}: {attachedSelection.split("\n")[0].slice(0, 80)}
          </p>
          <button
            type="button"
            aria-label={t.copilot_selection_detach}
            title={t.copilot_selection_detach}
            onClick={() => setCopilotSelection(null)}
            className="shrink-0 rounded p-0.5 text-text-subtle transition-colors hover:text-text"
          >
            <X size={11} />
          </button>
        </div>
      )}

      <div ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {entries.length === 0 && !busy && (
          <p className="mt-4 text-center text-[11px] text-text-subtle">
            {t.copilot_placeholder}
          </p>
        )}
        {entries.map((e, i) =>
          e.role === "user" ? (
            <div key={i} className="ml-8 rounded-lg bg-interactive-primary/10 px-3 py-2 text-xs text-text">
              {e.text}
            </div>
          ) : e.role === "error" ? (
            <div key={i} className="rounded-lg bg-surface-sunken px-3 py-2 text-xs text-red-500">
              {t.copilot_details}: {e.text}
            </div>
          ) : (
            <AgentMessage key={i} result={e.result} />
          ),
        )}
        {busy && (
          <div className="flex items-center gap-2 px-1 py-2 text-[11px] text-text-subtle">
            <Loader2 size={12} className="animate-spin" />
            {t.copilot_running}
            <button
              type="button"
              onClick={cancel}
              className="ml-auto flex items-center gap-1 rounded-md bg-surface-muted px-2 py-1 text-[10px] text-text-muted transition-colors hover:text-text"
            >
              <Square size={9} />
              {t.copilot_cancel_turn}
            </button>
          </div>
        )}
      </div>

      <div className="border-t border-line p-2">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={t.copilot_placeholder}
            rows={2}
            className="min-h-0 flex-1 resize-none rounded-lg bg-surface-sunken px-2.5 py-2 text-xs text-text outline-none placeholder:text-text-subtle focus:ring-1 focus:ring-line"
          />
          <button
            type="button"
            aria-label={t.copilot_send}
            disabled={!draft.trim() || busy}
            onClick={() => void send()}
            className="rounded-lg bg-interactive-primary p-2 text-interactive-primary-foreground transition-colors hover:bg-interactive-primary/90 disabled:opacity-40"
          >
            <Send size={13} />
          </button>
        </div>
      </div>
    </aside>
  );
}

/** One finished agent turn: response, observed changes, and diagnostics. */
function AgentMessage({ result }: { result: TurnResult }) {
  const { t } = useI18n();
  const setDraftId = useUI((s) => s.setDraftId);
  const [open, setOpen] = useState(false);
  const kindLabel = (k: string) =>
    k === "created"
      ? t.copilot_changed_created
      : k === "deleted"
        ? t.copilot_changed_deleted
        : t.copilot_changed_changed;

  return (
    <div className="mr-4 space-y-1.5 rounded-lg bg-surface-sunken px-3 py-2 text-xs text-text">
      {result.timed_out ? (
        <p className="text-text-subtle">{t.copilot_timed_out}</p>
      ) : result.signal != null && !result.response ? (
        <p className="text-text-subtle">
          {t.copilot_killed.replace("{signal}", String(result.signal))}
        </p>
      ) : (
        <p className="whitespace-pre-wrap">{result.response}</p>
      )}
      {result.model && (
        <p className="font-mono text-[9px] text-text-subtle">
          {result.provider}/{result.model}
        </p>
      )}

      {result.changed.length > 0 && (
        <div>
          <p className="text-[10px] font-medium text-text-subtle">
            {t.copilot_changed_notes}
          </p>
          <ul className="mt-0.5 space-y-0.5">
            {result.changed.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => {
                    // Mirror PropertyPanel's close semantics: only clear
                    // the draft marker when the clicked note IS the open
                    // pristine draft — clearing it for other notes would
                    // make that blank draft permanently non-discardable.
                    setDraftId(useUI.getState().draftId === c.id ? null : useUI.getState().draftId);
                    useUI.setState({ selectedId: c.id });
                  }}
                  className="font-mono text-[10px] text-text-muted underline decoration-line underline-offset-2 hover:text-text"
                >
                  {c.id.slice(0, 8)}… · {kindLabel(c.kind)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(result.stderr.trim() !== "" || result.exit_code === null) && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-[10px] text-text-subtle underline underline-offset-2"
        >
          {t.copilot_details}
        </button>
      )}
      {open && (
        <div className="rounded-md bg-surface-raised p-2 font-mono text-[10px] text-text-subtle">
          <p>
            {t.copilot_exit_code}: {result.exit_code ?? "—"}
          </p>
          {result.stderr.trim() !== "" && (
            <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap">
              {result.stderr}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
