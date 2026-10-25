import { CopilotModelPicker } from "./CopilotModelPicker";
/**
 * Copilot floating window (spec 2026-08-23, revised 2026-08-24): delegates
 * vault tasks to the user-activated terminal-agent CLI. One turn = one
 * subprocess; results arrive whole (no token streaming — the only uniform
 * denominator across agents). The "changed notes" list claims observation,
 * never causality (§9.4): the vault is shared, other writers exist.
 *
 * Layering (bands documented at the top of liquid-glass.css): the memo
 * sheet is a z-50 dialog and this window sits at z-[60] — the only surface
 * the copilot may cover, so it stays usable WHILE a note is open, exactly
 * like the selection-context flow it serves (§7 selection block). System
 * modals (settings, command palette, quick add) and their backdrops own
 * bands 65/70+ and paint above this window. Entry points are the
 * workspace and note toolbars, plus ⌘⇧C.
 *
 * Revision 2026-08-24 (composer UX): conversation state lives in the ui
 * store (survives close/reopen, in-memory only); the composer
 * (@references, /commands, context tray, send↔stop) is CopilotComposer;
 * agent responses render as sanitized markdown with per-block copy
 * (chatMarkdown.ts); busy shows an elapsed timer; changed notes resolve
 * titles; errors offer retry.
 */
import { useQuery, useQueryClient, useQueries } from "@tanstack/react-query";
import { Bot, Check, Copy, Loader2, MessageSquarePlus, RotateCcw, Trash2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, useIsPresent } from "motion/react";
import { useWorkspaceMotion } from "../lib/workspaceMotion";

import { useI18n } from "../lib/i18n";
import { useUI, type CopilotEntry, type CopilotRetryPayload } from "../stores/ui";
import { clipboardWriteText } from "../lib/clipboard";
import { renderChatMarkdown } from "../lib/chatMarkdown";
import { runCopilotTurn } from "../lib/copilotTurn";
import { expandCommand, type CopilotCommandId } from "../lib/copilotCommands";
import { COMMAND_ICONS, CopilotComposer, type ComposerSendPayload } from "./CopilotComposer";
import { CtxItem, CtxMenu, CtxRoot, CtxSeparator, CtxTrigger } from "./ContextMenu";
import {
  copilotCancel,
  copilotStatus,
  copilotDisclosure,
  getMemo,
  type TurnResult,
} from "../lib/api";

/** "42.3s" under a minute, "2m 13s" above. */
function fmtDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

/** "0:07" / "12:41" — live elapsed while a turn runs. */
function fmtElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function CopilotPanel() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const setCopilotOpen = useUI((s) => s.setCopilotOpen);
  const selectedId = useUI((s) => s.selectedId);
  // Keep one portal container so changing note context preserves the
  // composer and its draft. Nest the layer inside an open note dialog's
  // focus boundary; otherwise the modal hides the companion from assistive
  // technology even though it is painted above the backdrop.
  const [layer] = useState(() => document.createElement("div"));
  const present = useIsPresent();
  const timing = useWorkspaceMotion();
  useLayoutEffect(() => {
    if (!present && layer.contains(document.activeElement)) {
      const trigger = document.querySelector<HTMLElement>(".memo-sheet [data-copilot-trigger]")
        ?? document.querySelector<HTMLElement>(".workspace-titlebar [data-copilot-trigger]");
      trigger?.focus({ preventScroll: true });
    }
  }, [present, layer]);
  useLayoutEffect(() => {
    let frame = 0;
    let attempts = 0;
    const attach = () => {
      const sheet = selectedId ? document.querySelector<HTMLElement>(".memo-sheet") : null;
      const target = sheet ?? document.body;
      if (layer.parentElement !== target) {
        const focused = layer.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
        target.appendChild(layer);
        if (sheet) {
          // If focus was already in the composer when the modal opened,
          // Base UI may mark individual siblings before this layer moves.
          // Clear only its managed hiding on the newly inside content;
          // intentional aria-hidden icons remain unchanged.
          if (layer.hasAttribute("data-base-ui-inert")) layer.removeAttribute("aria-hidden");
          layer.querySelectorAll('[data-base-ui-inert][aria-hidden="true"]').forEach((element) => {
            element.removeAttribute("aria-hidden");
          });
        }
        focused?.focus({ preventScroll: true });
      }
      // Base UI mounts its portal in a layout effect. Give that commit a
      // bounded opportunity to install the sheet before attaching to it.
      if (selectedId && !sheet && attempts++ < 3) frame = requestAnimationFrame(attach);
    };
    attach();
    return () => cancelAnimationFrame(frame);
  }, [selectedId, layer]);
  useLayoutEffect(() => () => layer.remove(), [layer]);
  const selection = useUI((s) => s.copilotSelection);
  const setCopilotSelection = useUI((s) => s.setCopilotSelection);
  const setError = useUI((s) => s.setError);
  const entries = useUI((s) => s.copilotEntries);
  const detachedMemoId = useUI((s) => s.copilotDetachedMemoId);
  const busy = useUI((s) => s.copilotBusy);
  const startedAt = useUI((s) => s.copilotStartedAt);
  const resetCopilotChat = useUI((s) => s.resetCopilotChat);
  const draft = useUI((s) => s.copilotDraft);
  const setDraft = useUI((s) => s.setCopilotDraft);
  const [focusSignal, setFocusSignal] = useState(0);
  const [, setTick] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const [showLatest, setShowLatest] = useState(false);

  const status = useQuery({ queryKey: ["copilot-status"], queryFn: copilotStatus });
  const agentId = status.data?.agent ?? "";
  const agentName = status.data?.agent_name ?? agentId;
  const disclosure = useQuery({
    queryKey: ["copilot-disclosure", agentId],
    queryFn: () => copilotDisclosure(agentId),
    staleTime: 60_000,
    enabled: agentId !== "",
  });


  // Keying the read by selection prevents a previous note (or its late
  // rejection) from becoming the next request's implicit attachment.
  const activeNote = useQuery({
    queryKey: ["memo", selectedId],
    queryFn: () => getMemo(selectedId!),
    enabled: selectedId !== null,
  });
  const activeMemo = selectedId && activeNote.data?.id === selectedId
    ? { id: activeNote.data.id, title: activeNote.data.title ?? "", path: activeNote.data.path }
    : null;

  // Agent identity change = new conversation (spec §15): session ids are
  // not portable across activations, let alone adapters. Neither is a
  // per-conversation model choice. The conversation's agent lives in the
  // STORE (not a mount-time ref) so reopening the panel never resets it.
  useEffect(() => {
    if (agentId === "") return;
    if (useUI.getState().copilotAgent !== agentId) {
      useUI.setState({ copilotAgent: agentId });
      resetCopilotChat();
      setDraft("");
    }
  }, [agentId, resetCopilotChat, setDraft]);

  // The selection belongs to the memo it was made in; never attach a
  // stale selection from a previously open note.
  const attachedSelection =
    selection && activeMemo && selection.memoId === activeMemo.id ? selection.text : null;

  const sendTurn = async (payload: ComposerSendPayload | CopilotRetryPayload) => {
    const result = await runCopilotTurn(payload);
    if (result && result.changed.length > 0) {
      void qc.invalidateQueries({ queryKey: ["memos"] });
      void qc.invalidateQueries({ queryKey: ["memo"] });
    }
  };

  const cancel = async () => {
    try {
      await copilotCancel();
    } catch (e) {
      setError(String(e).split("\n")[0]);
    }
  };

  // Elapsed timer tick while busy.
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [busy]);
  // Autoscroll on new entries / busy transitions.
  useEffect(() => {
    if (followRef.current) listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
    else setShowLatest(true);
  }, [entries.length, busy]);

  const provider = disclosure.data?.provider ?? t.copilot_consent_unknown_provider;
  const currentModelLabel = disclosure.data?.model || status.data?.default_model || t.copilot_model_auto;
  const emptyCards: CopilotCommandId[] = ["summary", "tags", "find", "new", "tidy"];

  return createPortal(
    <motion.aside
      inert={!present}
      initial={{ opacity: 0, y: timing.reduce ? 0 : 8 }}
      animate={{ opacity: 1, y: 0, transition: timing.enter }}
      exit={{ opacity: 0, y: timing.reduce ? 0 : 4, transition: timing.exit }}
      aria-label={t.copilot_panel_title}
      onKeyDown={(e) => {
        // Esc outside the textarea (focus on a link/button) closes the
        // panel; the composer runs its own menu → stop → close chain.
        if (e.key === "Escape" && !(e.target instanceof HTMLTextAreaElement)) {
          setCopilotOpen(false);
        }
      }}
      className="glass-copilot fixed bottom-6 right-6 z-[60] flex h-[min(72vh,580px)] w-[min(92vw,380px)] flex-col overflow-hidden"
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
        <CopilotModelPicker agent={agentId} disabled={busy} />
        <button
          type="button"
          aria-label={t.copilot_new_chat}
          title={t.copilot_new_chat}
          disabled={busy}
          onClick={() => {
            resetCopilotChat();
            setDraft("");
          }}
          className="rounded-md p-1.5 text-text-subtle transition-colors hover:bg-surface-muted hover:text-text"
        >
          <MessageSquarePlus size={14} />
        </button>
        <button
          type="button"
          aria-label={t.close}
          onClick={() => setCopilotOpen(false)}
          className="rounded-md p-1.5 text-text-subtle transition-colors hover:bg-surface-muted hover:text-text"
        >
          <X size={14} />
        </button>
      </div>

      <div
        ref={listRef}
        role="log"
        aria-live="polite"
        onScroll={event => { const el = event.currentTarget; followRef.current = el.scrollHeight - el.clientHeight - el.scrollTop < 48; if (followRef.current) setShowLatest(false); }}
        className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3"
      >
        {entries.length === 0 && !busy && (
          <div className="mt-4 space-y-3">
            <p className="text-center text-xs font-medium text-text">
              {t.copilot_empty_greeting}
            </p>
            <p className="text-center text-[10px] leading-snug text-text-subtle">
              {t.copilot_disclosure_short.replace("{provider}", provider)}
            </p>
            <div className="space-y-1">
              {emptyCards.map((id) => {
                const Icon = COMMAND_ICONS[id];
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      setDraft(expandCommand(id, {
                        hasActiveMemo: Boolean(activeMemo && activeMemo.id !== detachedMemoId), t,
                      }));
                      setFocusSignal((n) => n + 1);
                    }}
                    className="flex w-full items-center gap-2 rounded-lg border border-line bg-surface-sunken px-2.5 py-2 text-left transition-colors hover:bg-surface-muted"
                  >
                    <Icon size={13} className="shrink-0 text-text-subtle" />
                    <span className="text-[11px] font-medium text-text">
                      {t[`copilot_cmd_${id}_label`]}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[10px] text-text-subtle">
                      {t[`copilot_cmd_${id}_desc`]}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {entries.map((e, i) => (
          <ConversationEntry
            key={i}
            entry={e}
            agentName={agentName}
            onRetry={busy ? undefined : () => (e.role === "error" || e.role === "agent") && e.retry && void sendTurn(e.retry)}
            onSendRetry={busy ? undefined : (p) => void sendTurn(p)}
            onClearChat={
              busy
                ? undefined
                : () => {
                    resetCopilotChat();
                    setDraft("");
                  }
            }
          />
        ))}
        {busy && (
          <div className="flex items-center gap-2 px-1 py-2 text-[11px] text-text-subtle">
            <Loader2 size={12} className="animate-spin" />
            {t.copilot_running}
            <span className="font-mono text-[10px]">
              {fmtElapsed((startedAt ? Date.now() - startedAt : 0))}
            </span>
          </div>
        )}
      </div>

      {showLatest && <button type="button" className="mx-auto mb-2 rounded-full border border-line bg-surface px-3 py-1 text-xs text-text" onClick={() => { followRef.current = true; listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); setShowLatest(false); }}>{t.copilot_latest}</button>}
      <CopilotComposer
        draft={draft}
        setDraft={setDraft}
        busy={busy}
        onSend={(p) => void sendTurn(p)}
        onStop={() => void cancel()}
        activeMemo={activeMemo}
        attachedSelection={attachedSelection}
        onClearSelection={() => setCopilotSelection(null)}
        focusSignal={focusSignal}
        onEscPanel={() => setCopilotOpen(false)}
      />
    </motion.aside>,
    layer,
  );
}
/** One row: user turn (with its attached-context chips), agent turn, or
 * error (with retry). Right-click: copy / retry (user·error) / armed
 * clear-conversation (design 2026-10-25 §3.4). */
function ConversationEntry({
  entry,
  agentName,
  onRetry,
  onSendRetry,
  onClearChat,
}: {
  entry: CopilotEntry;
  agentName: string;
  onRetry?: () => void;
  /** Right-click "retry" — resends this turn's exact payload; undefined
   *  while a turn runs. */
  onSendRetry?: (payload: CopilotRetryPayload) => void;
  /** Right-click armed "clear conversation"; undefined while busy. */
  onClearChat?: () => void;
}) {
  const { t } = useI18n();
  // Two-click armed clear (FolderMenu rules): arm resets when the menu
  // closes or 4s after arming.
  const [armed, setArmed] = useState(false);
  const armTimer = useRef<number | null>(null);
  const disarm = () => {
    setArmed(false);
    if (armTimer.current) {
      window.clearTimeout(armTimer.current);
      armTimer.current = null;
    }
  };
  useEffect(() => () => disarm(), []);

  const text = entry.role === "agent" ? entry.result.response : entry.text;
  // Retry target (§3.4): user entries rebuild their exact sent payload
  // from the stored attachment snapshot; error entries keep the payload
  // captured at failure. Agent turns retry via their inline button.
  const retryPayload: CopilotRetryPayload | null =
    entry.role === "error"
      ? entry.retry
      : entry.role === "user"
        ? {
            message: entry.text,
            memo: entry.attached.active
              ? { ...entry.attached.active, selection: entry.attached.selection }
              : null,
            referenced: entry.attached.memos,
          }
        : null;

  const chatMenu = (
    <CtxMenu>
      <CtxItem
        icon={Copy}
        label={t.copilot_menu_copy}
        onClick={() => void clipboardWriteText(text)}
      />
      {retryPayload && onSendRetry && (
        <CtxItem
          icon={RotateCcw}
          label={t.copilot_menu_retry}
          onClick={() => onSendRetry(retryPayload)}
        />
      )}
      <CtxSeparator />
      {armed ? (
        <CtxItem
          icon={Trash2}
          label={t.copilot_menu_clear_arm}
          danger
          disabled={!onClearChat}
          onClick={() => {
            disarm();
            onClearChat?.();
          }}
        />
      ) : (
        <CtxItem
          icon={Trash2}
          label={t.copilot_menu_clear}
          danger
          keepOpen
          disabled={!onClearChat}
          onClick={() => {
            setArmed(true);
            if (armTimer.current) window.clearTimeout(armTimer.current);
            armTimer.current = window.setTimeout(disarm, 4000);
          }}
        />
      )}
    </CtxMenu>
  );

  if (entry.role === "user") {
    return (
      <CtxRoot onOpenChange={(open) => !open && disarm()}>
        <CtxTrigger render={<div className="ml-8" />}>
          <div className="rounded-lg bg-interactive-primary/10 px-3 py-2 text-xs text-text">
            {entry.text}
          </div>
          {(entry.attached.active || entry.attached.selection || entry.attached.memos.length > 0) && (
            <div className="mt-1 flex flex-wrap gap-1 px-1">
              {entry.attached.active && (
                <span className="max-w-full truncate rounded-sm bg-surface-sunken px-1.5 py-0.5 text-[9px] text-text-subtle">
                  {t.copilot_at_active}: {entry.attached.active.title || entry.attached.active.path}
                </span>
              )}
              {entry.attached.selection && (
                <span className="max-w-full truncate rounded-sm bg-surface-sunken px-1.5 py-0.5 text-[9px] text-text-subtle">
                  {t.copilot_at_selection}
                </span>
              )}
              {entry.attached.memos.map((m) => (
                <span
                  key={m.id}
                  className="max-w-full truncate rounded-sm bg-surface-sunken px-1.5 py-0.5 text-[9px] text-text-subtle"
                >
                  {m.title || m.path}
                </span>
              ))}
            </div>
          )}
          {chatMenu}
        </CtxTrigger>
      </CtxRoot>
    );
  }
  if (entry.role === "error") {
    return (
      <CtxRoot onOpenChange={(open) => !open && disarm()}>
        <CtxTrigger render={<div className="mr-4 rounded-lg bg-surface-sunken px-3 py-2 text-xs text-red-500" />}>
          <p>{entry.text}</p>
          {entry.retry && onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="mt-1 rounded-md bg-surface-muted px-2 py-1 text-[10px] text-text-muted transition-colors hover:text-text"
            >
              {t.copilot_retry}
            </button>
          )}
          {chatMenu}
        </CtxTrigger>
      </CtxRoot>
    );
  }
  return (
    <CtxRoot onOpenChange={(open) => !open && disarm()}>
      <CtxTrigger render={<div className="space-y-2" />}>
        <AgentMessage result={entry.result} agentName={agentName} />
        {entry.retry && onRetry && <button type="button" className="rounded-md px-2 py-1 text-xs text-text-muted" onClick={onRetry}>{t.copilot_retry}</button>}
        {chatMenu}
      </CtxTrigger>
    </CtxRoot>
  );
}

/** One finished agent turn: markdown response, observed changes, and
 * diagnostics. */
function AgentMessage({ result, agentName }: { result: TurnResult; agentName: string }) {
  const { t } = useI18n();
  const setDraftId = useUI((s) => s.setDraftId);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [codeCopied, setCodeCopied] = useState<string | null>(null);
  const mdRef = useRef<HTMLDivElement>(null);

  // Resolve titles for created/changed notes (deleted ones are gone from
  // the index — fall back to the id).
  const lookups = useQueries({
    queries: result.changed
      .filter((c) => c.kind !== "deleted")
      .map((c) => ({
        queryKey: ["copilot-changed", c.id],
        queryFn: () => getMemo(c.id),
        staleTime: 30_000,
        retry: false,
      })),
  });
  const titleFor = (id: string): string => {
    const hit = lookups.find((q) => q.data?.id === id)?.data;
    return hit?.title || hit?.path || id.slice(0, 8);
  };

  const kindLabel = (k: string) =>
    k === "created"
      ? t.copilot_changed_created
      : k === "deleted"
        ? t.copilot_changed_deleted
        : t.copilot_changed_changed;
  const kindDot = (k: string) =>
    k === "created"
      ? "bg-status-success"
      : k === "deleted"
        ? "bg-status-error"
        : "bg-status-info";

  const copyResponse = async () => {
    await clipboardWriteText(result.response);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Code-copy buttons live inside dangerouslySetInnerHTML — non-fiber DOM.
  // React 19's root delegation does not dispatch this container's onClick
  // for such targets (verified in browser smoke), so the container gets a
  // NATIVE delegated listener instead.
  useEffect(() => {
    const el = mdRef.current;
    if (!el) return;
    const onClick = async (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".chat-code-copy");
      if (!btn) return;
      const code = btn.closest(".chat-code")?.querySelector("code")?.textContent ?? "";
      const lang = (btn.closest(".chat-code") as HTMLElement | null)?.dataset.lang ?? "";
      try {
        await clipboardWriteText(code);
      } catch {
        // Headless/no-permission env — still show the click landed.
      }
      setCodeCopied(lang);
      setTimeout(() => setCodeCopied((cur) => (cur === lang ? null : cur)), 1500);
    };
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  }, [result.response]);

  const html = renderChatMarkdown(result.response, t.copilot_copy);

  return (
    <div className="mr-4 space-y-1.5 rounded-lg bg-surface-sunken px-3 py-2 text-xs text-text">
      {result.exit_code !== null && result.exit_code !== 0 && !result.timed_out && <p role="status" className="text-xs text-text">{t.copilot_failed.replace("{code}", String(result.exit_code))}</p>}
      {result.timed_out ? (
        <p className="text-text-subtle">{t.copilot_timed_out}</p>
      ) : result.signal != null && !result.response ? (
        <p className="text-text-subtle">
          {t.copilot_killed.replace("{signal}", String(result.signal))}
        </p>
      ) : (
        <>
          <div className="flex items-start justify-end gap-1">
            <button
              type="button"
              aria-label={t.copilot_copy}
              title={t.copilot_copy}
              onClick={() => void copyResponse()}
              className="rounded p-1 text-text-subtle transition-colors hover:bg-surface-muted hover:text-text"
            >
              {copied ? <Check size={11} /> : <Copy size={11} />}
            </button>
          </div>
          <div ref={mdRef} className="chat-md">
            <div dangerouslySetInnerHTML={{ __html: html }} />
          </div>
        </>
      )}

      {/* claude discloses tool requests its own policy denied — surface
          that fact so "why didn't it write?" is never a mystery (§11:
          the policy is the agent's, and so is the fix). */}
      {result.denials && result.denials.length > 0 && (
        <p className="text-[10px] leading-snug text-text-subtle">
          {t.copilot_denied_tools
            .replace("{n}", String(result.denials.length))
            .replace("{agent}", agentName)}
        </p>
      )}
      {(result.model || result.duration_ms > 0) && (
        <p className="font-mono text-[9px] text-text-subtle">
          {result.model ? `${result.provider}/${result.model} · ` : ""}
          {fmtDuration(result.duration_ms)}
        </p>
      )}

      {result.changed.length > 0 && (
        <div>
          <p className="text-[10px] font-medium text-text-subtle">{t.copilot_changed_notes}</p>
          <ul className="mt-0.5 space-y-0.5">
            {result.changed.map((c) => (
              <li key={c.id} className="flex items-center gap-1.5">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${kindDot(c.kind)}`} />
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
                  className="min-w-0 truncate text-left text-[10px] text-text-muted underline decoration-line underline-offset-2 hover:text-text"
                >
                  {titleFor(c.id)} · {kindLabel(c.kind)}
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
            <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap">{result.stderr}</pre>
          )}
        </div>
      )}
      {codeCopied !== null && (
        <p className="text-[9px] text-text-subtle">{t.copilot_copied}</p>
      )}
    </div>
  );
}
