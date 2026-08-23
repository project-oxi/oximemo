/**
 * Copilot side panel (spec 2026-08-23): delegates vault tasks to the
 * user-activated terminal-agent CLI. One turn = one subprocess; results
 * arrive whole (no token streaming — the only uniform denominator across
 * agents). The "changed notes" list claims observation, never causality
 * (§9.4): the vault is shared, other writers exist.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Bot, Loader2, MessageSquarePlus, Send, Square, X } from "lucide-react";
import { useI18n } from "../lib/i18n";
import { useUI } from "../stores/ui";
import {
  copilotCancel,
  copilotStatus,
  copilotDisclosure,
  copilotSend,
  getMemo,
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
  const setError = useUI((s) => s.setError);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [session, setSession] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [activeMemo, setActiveMemo] = useState<ActiveMemoRef | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const status = useQuery({ queryKey: ["copilot-status"], queryFn: copilotStatus });
  const agentId = status.data?.agent ?? "";
  const disclosure = useQuery({
    queryKey: ["copilot-disclosure", agentId],
    queryFn: () => copilotDisclosure(agentId),
    staleTime: 60_000,
    enabled: agentId !== "",
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

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [entries, busy]);

  const send = async () => {
    const message = draft.trim();
    if (!message || busy) return;
    setDraft("");
    try {
      const result = await copilotSend(message, activeMemo, session);
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

  const agent = agentId;
  const provider =
    disclosure.data?.provider ?? t.copilot_consent_unknown_provider;

  return (
    <aside
      aria-label={t.copilot_panel_title}
      className="fixed right-0 top-0 z-40 flex h-full w-[360px] flex-col border-l border-line bg-surface shadow-xl"
    >
      {/* Header: agent + provider are always visible (§12) — the user
          should never have to wonder where their data is going. */}
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 pt-11">
        <Bot size={14} className="shrink-0 text-text-subtle" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold text-text">
            {t.copilot_panel_title}
          </p>
          <p className="truncate text-[10px] text-text-subtle">
            {agent} · {provider}
          </p>
        </div>
        <button
          type="button"
          aria-label={t.copilot_new_chat}
          title={t.copilot_new_chat}
          onClick={() => {
            setEntries([]);
            setSession(null);
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
      ) : (
        <p className="whitespace-pre-wrap">{result.response}</p>
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
                    // Opening the note is the read path; draftId is only
                    // for minted drafts, so clear it here.
                    setDraftId(null);
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
