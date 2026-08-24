/**
 * Copilot composer (revision 2026-08-24): context tray + textarea + trigger
 * menus + send/stop footer.
 *
 * - @ mentions and / commands are VALUE-based (draft string + caret), never
 *   keydown-based — Korean IME composition can never half-fire a trigger.
 * - Enter respects `isComposing` (Cursor's infamous CJK bug is the
 *   counter-example). While a menu is open, Enter/Tab SELECT, never send.
 * - Esc chain: menu → running turn (stop) → panel close (delegated via
 *   `onEscPanel`).
 * - Context tray: the open note (default-attached, × detaches for this
 *   conversation), the editor selection (from the panel, × clears it), and
 *   @-referenced memos (chips; click opens the note, × drops the ref).
 *   Detached contexts re-attach through the @ menu's special row.
 */
import { useQuery } from "@tanstack/react-query";
import {
  CornerDownLeft,
  FileText,
  FilePlus2,
  Loader2,
  Search,
  Send,
  Square,
  Tags,
  TextSelect,
  Wand2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useI18n } from "../lib/i18n";
import {
  commandList,
  expandCommand,
  filterCommands,
  type CopilotCommandId,
} from "../lib/copilotCommands";
import {
  activeMentionToken,
  stripMentionToken,
  type MentionToken,
} from "../lib/copilotMention";
import { searchMemos } from "../lib/api";
import type { ActiveMemoRef, MemoRef } from "../lib/api";
import { useUI } from "../stores/ui";

/** Composer-level icon per command id (catalog itself stays data-only). */
export const COMMAND_ICONS: Record<CopilotCommandId, typeof FileText> = {
  summary: FileText,
  tags: Tags,
  tidy: Wand2,
  find: Search,
  new: FilePlus2,
};

export interface ComposerSendPayload {
  message: string;
  memo: ActiveMemoRef | null;
  referenced: MemoRef[];
}

interface Props {
  draft: string;
  setDraft: (s: string) => void;
  busy: boolean;
  onSend: (payload: ComposerSendPayload) => void;
  onStop: () => void;
  /** Memo currently open behind the panel, if any (default-attached). */
  activeMemo: ActiveMemoRef | null;
  /** Editor selection matched to `activeMemo`, if any. */
  attachedSelection: string | null;
  onClearSelection: () => void;
  /** Bumped by the panel (empty-state cards) to refocus the textarea. */
  focusSignal: number;
  /** Esc pressed with no menu open and no running turn. */
  onEscPanel: () => void;
}

type MenuState =
  | { kind: "none" }
  | { kind: "commands" }
  | { kind: "mention"; token: MentionToken };

const REFERENCE_LIMIT = 8;

export function CopilotComposer({
  draft,
  setDraft,
  busy,
  onSend,
  onStop,
  activeMemo,
  attachedSelection,
  onClearSelection,
  focusSignal,
  onEscPanel,
}: Props) {
  const { t } = useI18n();
  const setDraftId = useUI((s) => s.setDraftId);
  const [refs, setRefs] = useState<MemoRef[]>([]);
  const [attachActive, setAttachActive] = useState(true);
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // New open memo → context resets to the default (attached) state; any
  // draft edit re-arms the trigger menus.
  useEffect(() => setAttachActive(true), [activeMemo?.id]);
  useEffect(() => setDismissed(false), [draft]);

  const slashOpen = draft.startsWith("/") && !draft.includes("\n");
  const mentionToken = activeMentionToken(draft, caret);
  const menu: MenuState = dismissed
    ? { kind: "none" }
    : slashOpen
      ? { kind: "commands" }
      : mentionToken
        ? { kind: "mention", token: mentionToken }
        : { kind: "none" };

  const commands = menu.kind === "commands" ? filterCommands(draft.slice(1), commandList(t)) : [];
  const mentionQuery = menu.kind === "mention" && menu.token ? menu.token.query.trim() : "";
  const notes = useQuery({
    queryKey: ["copilot-mention", mentionQuery],
    queryFn: () => searchMemos(mentionQuery, 8),
    enabled: menu.kind === "mention" && mentionQuery !== "",
    staleTime: 10_000,
  });
  const noteResults =
    menu.kind === "mention"
      ? (notes.data ?? []).filter(
          (m) =>
            !refs.some((r) => r.id === m.id) &&
            !(attachActive && activeMemo && m.id === activeMemo.id),
        )
      : [];
  // Special rows sit above the note rows: the re-attach affordance for a
  // detached open memo.
  const specialCount = menu.kind === "mention" && activeMemo && !attachActive ? 1 : 0;
  const menuRows =
    menu.kind === "commands" ? commands.length : menu.kind === "mention" ? specialCount + noteResults.length : 0;
  useEffect(() => setHighlight(0), [menu.kind, draft, caret]);

  // Autogrow 1→~6 lines.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [draft]);
  useEffect(() => {
    taRef.current?.focus();
  }, [focusSignal]);
  useEffect(() => {
    taRef.current?.focus();
  }, []);

  const focusAndMoveCaretToEnd = () => {
    const el = taRef.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
    setCaret(end);
  };

  const send = () => {
    const message = draft.trim();
    if (!message || busy) return;
    const memo: ActiveMemoRef | null =
      activeMemo && attachActive
        ? { ...activeMemo, selection: attachedSelection ?? null }
        : null;
    onSend({ message, memo, referenced: refs });
    setRefs([]);
    setDraft("");
    requestAnimationFrame(focusAndMoveCaretToEnd);
  };

  const selectCommand = (id: CopilotCommandId) => {
    setDraft(expandCommand(id, { hasActiveMemo: Boolean(activeMemo), t }));
    setDismissed(true);
    requestAnimationFrame(focusAndMoveCaretToEnd);
  };

  const attachNote = (m: MemoRef) => {
    if (refs.length >= REFERENCE_LIMIT || refs.some((r) => r.id === m.id)) return;
    setRefs((rs) => [...rs, m]);
    if (menu.kind === "mention" && menu.token) {
      setDraft(stripMentionToken(draft, menu.token));
    }
    requestAnimationFrame(focusAndMoveCaretToEnd);
  };

  const openMemo = (id: string) => {
    // Same close semantics as AgentMessage's changed-note links: only clear
    // the draft marker when the clicked note IS the pristine draft.
    const cur = useUI.getState().draftId;
    setDraftId(cur === id ? null : cur);
    useUI.setState({ selectedId: id });
  };

  const onTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // IME: Enter during composition must never submit (CJK bug).
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (menu.kind !== "none") {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => (h + 1) % Math.max(menuRows, 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => (h - 1 + Math.max(menuRows, 1)) % Math.max(menuRows, 1));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        if (menuRows === 0) {
          setDismissed(true);
          return;
        }
        if (menu.kind === "commands") {
          selectCommand(commands[highlight]?.id ?? commands[0].id);
        } else if (highlight < specialCount) {
          setAttachActive(true);
          setDismissed(true);
        } else {
          const note = noteResults[highlight - specialCount];
          if (note) attachNote({ id: note.id, title: note.title ?? note.path, path: note.path });
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setDismissed(true);
        return;
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (busy) onStop();
      else onEscPanel();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const trackCaret = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    setCaret(e.currentTarget.selectionEnd ?? 0);
  };

  return (
    <div className="relative border-t border-line p-2">
      {menu.kind !== "none" && (
        <div
          role="listbox"
          aria-label={menu.kind === "commands" ? t.copilot_hint_commands : t.copilot_at_notes}
          className="absolute bottom-full left-2 right-2 mb-1 max-h-[240px] overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-lg"
        >
          {menu.kind === "commands" ? (
            commands.length === 0 ? (
              <p className="px-2 py-2 text-[11px] text-text-subtle">{t.copilot_at_none}</p>
            ) : (
              commands.map((c, i) => {
                const Icon = COMMAND_ICONS[c.id];
                return (
                  <button
                    key={c.id}
                    type="button"
                    role="option"
                    aria-selected={i === highlight}
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => selectCommand(c.id)}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] transition-colors ${
                      i === highlight ? "bg-surface-muted text-text" : "text-text-muted"
                    }`}
                  >
                    <Icon size={13} className="shrink-0 text-text-subtle" />
                    <span className="font-medium">{c.label}</span>
                    <span className="min-w-0 flex-1 truncate text-[10px] text-text-subtle">
                      {c.desc}
                    </span>
                  </button>
                );
              })
            )
          ) : refs.length >= REFERENCE_LIMIT ? (
            <p className="px-2 py-2 text-[11px] text-text-subtle">{t.copilot_at_limit}</p>
          ) : (
            <>
              {specialCount > 0 && (
                <button
                  type="button"
                  role="option"
                  aria-selected={highlight === 0}
                  onMouseEnter={() => setHighlight(0)}
                  onClick={() => {
                    setAttachActive(true);
                    setDismissed(true);
                  }}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] transition-colors ${
                    highlight === 0 ? "bg-surface-muted text-text" : "text-text-muted"
                  }`}
                >
                  <FileText size={13} className="shrink-0 text-text-subtle" />
                  <span className="font-medium">{t.copilot_at_active}</span>
                  <span className="min-w-0 flex-1 truncate text-[10px] text-text-subtle">
                    {activeMemo!.title || activeMemo!.path}
                  </span>
                </button>
              )}
              {mentionQuery !== "" && notes.isLoading && (
                <p className="flex items-center gap-2 px-2 py-2 text-[11px] text-text-subtle">
                  <Loader2 size={11} className="animate-spin" />
                  {t.copilot_detecting}
                </p>
              )}
              {noteResults.map((m, i) => {
                const idx = i + specialCount;
                return (
                  <button
                    key={m.id}
                    type="button"
                    role="option"
                    aria-selected={idx === highlight}
                    onMouseEnter={() => setHighlight(idx)}
                    onClick={() => attachNote({ id: m.id, title: m.title ?? m.path, path: m.path })}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] transition-colors ${
                      idx === highlight ? "bg-surface-muted text-text" : "text-text-muted"
                    }`}
                  >
                    <FileText size={13} className="shrink-0 text-text-subtle" />
                    <span className="min-w-0 flex-1 truncate">{m.title || m.path}</span>
                    <span className="shrink-0 font-mono text-[9px] text-text-subtle">{m.path}</span>
                  </button>
                );
              })}
              {mentionQuery !== "" && !notes.isLoading && noteResults.length === 0 && (
                <p className="px-2 py-2 text-[11px] text-text-subtle">{t.copilot_at_none}</p>
              )}
              {mentionQuery === "" && (
                <p className="px-2 py-1.5 text-[10px] text-text-subtle">{t.copilot_at_notes}</p>
              )}
            </>
          )}
        </div>
      )}

      {/* Context tray: open note + selection + @refs, one chip grammar. */}
      {(activeMemo || attachedSelection || refs.length > 0) && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {activeMemo && attachActive && (
            <span className="flex max-w-full items-center gap-1 rounded-sm bg-surface-sunken px-1.5 py-0.5 text-[10px] text-text-muted">
              <FileText size={10} className="shrink-0 text-text-subtle" />
              <span className="truncate">
                {t.copilot_at_active}: {activeMemo.title || activeMemo.path}
              </span>
              <button
                type="button"
                aria-label={t.copilot_selection_detach}
                title={t.copilot_selection_detach}
                onClick={() => setAttachActive(false)}
                className="shrink-0 rounded p-0.5 text-text-subtle transition-colors hover:text-text"
              >
                <X size={10} />
              </button>
            </span>
          )}
          {attachedSelection && (
            <span className="flex max-w-full items-center gap-1 rounded-sm bg-surface-sunken px-1.5 py-0.5 text-[10px] text-text-muted">
              <TextSelect size={10} className="shrink-0 text-text-subtle" />
              <span className="truncate" title={attachedSelection}>
                {t.copilot_at_selection}
              </span>
              <button
                type="button"
                aria-label={t.copilot_selection_detach}
                title={t.copilot_selection_detach}
                onClick={onClearSelection}
                className="shrink-0 rounded p-0.5 text-text-subtle transition-colors hover:text-text"
              >
                <X size={10} />
              </button>
            </span>
          )}
          {refs.map((r) => (
            <span
              key={r.id}
              className="flex max-w-full items-center gap-1 rounded-sm bg-surface-sunken px-1.5 py-0.5 text-[10px] text-text-muted"
            >
              <button
                type="button"
                onClick={() => openMemo(r.id)}
                title={r.path}
                className="min-w-0 truncate text-text-muted underline decoration-line underline-offset-2 hover:text-text"
              >
                {r.title || t.copilot_memo_untitled}
              </button>
              <button
                type="button"
                aria-label={t.copilot_selection_detach}
                onClick={() => setRefs((rs) => rs.filter((x) => x.id !== r.id))}
                className="shrink-0 rounded p-0.5 text-text-subtle transition-colors hover:text-text"
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}

      <textarea
        ref={taRef}
        value={draft}
        aria-label={t.copilot_placeholder}
        placeholder={t.copilot_placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onInput={trackCaret}
        onSelect={trackCaret}
        onKeyUp={trackCaret}
        onKeyDown={onTextareaKeyDown}
        rows={1}
        className="max-h-[168px] min-h-[40px] w-full resize-none rounded-lg bg-surface-sunken px-2.5 py-2 text-xs leading-relaxed text-text outline-none placeholder:text-text-subtle focus:ring-1 focus:ring-line"
      />

      <div className="mt-1.5 flex items-center gap-2">
        <button
          type="button"
          title={t.copilot_at_notes}
          onClick={() => {
            setDraft(draft === "" || /\s$/.test(draft) ? `${draft}@` : `${draft} @`);
            requestAnimationFrame(focusAndMoveCaretToEnd);
          }}
          className="rounded px-1 py-0.5 font-mono text-[10px] text-text-subtle transition-colors hover:bg-surface-muted hover:text-text"
        >
          @ {t.copilot_hint_context}
        </button>
        <button
          type="button"
          title={t.copilot_hint_commands}
          onClick={() => {
            setDraft("/");
            requestAnimationFrame(focusAndMoveCaretToEnd);
          }}
          className="rounded px-1 py-0.5 font-mono text-[10px] text-text-subtle transition-colors hover:bg-surface-muted hover:text-text"
        >
          / {t.copilot_hint_commands}
        </button>
        <span className="ml-auto flex items-center gap-1 pr-1 text-[10px] text-text-subtle">
          {t.copilot_hint_newline}
          <CornerDownLeft size={10} />
        </span>
        {busy ? (
          <button
            type="button"
            aria-label={t.copilot_stop}
            title={t.copilot_stop}
            onClick={onStop}
            className="flex items-center gap-1.5 rounded-lg bg-surface-muted px-2.5 py-2 text-[11px] text-text transition-colors hover:bg-surface-sunken"
          >
            <Square size={11} />
            {t.copilot_stop}
          </button>
        ) : (
          <button
            type="button"
            aria-label={t.copilot_send}
            title={t.copilot_send}
            disabled={!draft.trim()}
            onClick={send}
            className="rounded-lg bg-interactive-primary p-2 text-interactive-primary-foreground transition-colors hover:bg-interactive-primary/90 disabled:opacity-40"
          >
            <Send size={13} />
          </button>
        )}
      </div>
    </div>
  );
}
