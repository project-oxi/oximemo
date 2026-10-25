/**
 * AI suggestion strip (goal 2026-10-25, F1/F3/F4): a footer row for saved
 * markdown notes that renders one stateless `copilot_suggest("all")` turn —
 * tag chips, wiki-link chips, and task checkbox rows. Applies never write
 * behind the editor's back: tag/link chips go through `onApplyBody` (the
 * note editor's own guarded autosave path) and tasks through `add_task`,
 * which targets the saved note on disk. The automatic trigger fires the
 * same fetch once per dirty→saved transition after a 2.5s idle, and only
 * when the user opted into `suggest_after_save` — note text must never
 * leave for the agent provider without an explicit act (privacy invariant).
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Sparkles, X } from "lucide-react";

import { addTask, copilotSuggest } from "../lib/api";
import type { SuggestResult } from "../lib/api";
import { todayLocalISO } from "../lib/dates";
import { useI18n } from "../lib/i18n";
import { appendLink, appendTag } from "../lib/suggestApply";
import type { TaskFields } from "../lib/types";

const AUTO_SUGGEST_IDLE_MS = 2500;

/** Field-less add: suggested task text carries everything; no structured
 *  fields are invented on the strip's behalf (priority "None" is the
 *  write-side word for absent). */
const EMPTY_TASK_FIELDS: TaskFields = {
  created: null,
  start: null,
  scheduled: null,
  due: null,
  priority: "None",
  recurrence: null,
  tags: [],
};

export interface SuggestionStripProps {
  memoId: string;
  body: string;
  dirty: boolean;
  saving: boolean;
  copilotReady: boolean;
  autoEnabled: boolean;
  onApplyBody: (next: string) => void;
  className?: string;
}

const headerButton =
  "inline-flex items-center gap-1 rounded-md px-2 py-1 text-text-subtle transition-colors duration-150 hover:bg-surface-muted hover:text-text disabled:pointer-events-none disabled:opacity-40";

export function SuggestionStrip({
  memoId,
  body,
  dirty,
  saving,
  copilotReady,
  autoEnabled,
  onApplyBody,
  className,
}: SuggestionStripProps) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [result, setResult] = useState<SuggestResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [appliedTags, setAppliedTags] = useState<string[]>([]);
  const [appliedLinks, setAppliedLinks] = useState<string[]>([]);
  const [appliedTasks, setAppliedTasks] = useState<string[]>([]);
  const [checkedTasks, setCheckedTasks] = useState<string[]>([]);
  const [applyingTasks, setApplyingTasks] = useState(false);
  const requestSeq = useRef(0);
  const fetchRef = useRef<() => void>(() => {});

  // Suggestions are per-note: a note switch drops the previous result and
  // its dismissal (component-local state keyed by memoId).
  useEffect(() => {
    requestSeq.current += 1; // orphan in-flight responses from the old note
    setResult(null);
    setRunning(false);
    setError(null);
    setDismissed(false);
    setAppliedTags([]);
    setAppliedLinks([]);
    setAppliedTasks([]);
    setCheckedTasks([]);
  }, [memoId]);

  const fetchSuggestions = useCallback(() => {
    if (!copilotReady) return;
    const seq = ++requestSeq.current;
    setRunning(true);
    setError(null);
    copilotSuggest("all", memoId)
      .then((r) => {
        if (requestSeq.current !== seq) return;
        setResult(r);
        setError(null);
        setAppliedTags([]);
        setAppliedLinks([]);
        setAppliedTasks([]);
        setCheckedTasks([]);
        setDismissed(false);
      })
      .catch((e) => {
        if (requestSeq.current !== seq) return;
        setResult(null);
        setError(String(e));
      })
      .finally(() => {
        if (requestSeq.current === seq) setRunning(false);
      });
  }, [copilotReady, memoId]);
  fetchRef.current = fetchSuggestions;

  // Automatic trigger: exactly once per dirty→saved transition, after a
  // 2.5s idle. A new edit (dirty again), a note switch, or unmount cancels
  // the pending timer; never fires while autoEnabled is off.
  const wasDirtyRef = useRef(dirty);
  useEffect(() => {
    const wasDirty = wasDirtyRef.current;
    wasDirtyRef.current = dirty;
    if (!autoEnabled || !wasDirty || dirty) return;
    const h = window.setTimeout(() => fetchRef.current(), AUTO_SUGGEST_IDLE_MS);
    return () => window.clearTimeout(h);
  }, [dirty, autoEnabled, memoId]);

  const disabled = dirty || saving;
  const tags = result?.tags ?? [];
  const links = result?.links ?? [];
  const tasks = result?.tasks ?? [];
  const hasSections = tags.length > 0 || links.length > 0 || tasks.length > 0;

  if (dismissed) return null;

  const applySelectedTasks = () => {
    const chosen = tasks.filter(
      (text) => checkedTasks.includes(text) && !appliedTasks.includes(text),
    );
    if (chosen.length === 0 || disabled || applyingTasks) return;
    const today = todayLocalISO();
    setApplyingTasks(true);
    void (async () => {
      for (const text of chosen) {
        await addTask({ Note: memoId }, text, EMPTY_TASK_FIELDS, today);
        setAppliedTasks((prev) => [...prev, text]);
      }
    })()
      .then(() => {
        // CopilotPanel's external-write pattern: refresh the lists AND the
        // open note so the guarded save sees add_task's new source digest.
        void qc.invalidateQueries({ queryKey: ["memos"] });
        void qc.invalidateQueries({ queryKey: ["tasks"] });
        void qc.invalidateQueries({ queryKey: ["memo"] });
      })
      .catch((e) => setError(String(e)))
      .finally(() => setApplyingTasks(false));
  };

  return (
    <div className={`flex flex-col gap-1 py-1 ${className ?? ""}`}>
      <div className="flex min-w-0 items-center gap-1 text-xs text-text-subtle">
        <span className="inline-flex shrink-0 items-center gap-1">
          <Sparkles size={12} aria-hidden />
          {t.suggest_title}
        </span>
        {dirty || saving ? (
          <span className="min-w-0 truncate">{t.suggest_dirty}</span>
        ) : running ? (
          <span className="min-w-0 truncate">{t.suggest_running}</span>
        ) : error !== null ? (
          <span className="min-w-0 truncate text-hue-red" title={error}>
            {t.suggest_failed}: {error.split("\n")[0]}
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          {copilotReady && (
            <button type="button" disabled={running} onClick={() => fetchRef.current()} className={headerButton}>
              {t.suggest_get}
            </button>
          )}
          <button type="button" onClick={() => setDismissed(true)} className={headerButton}>
            <X size={12} aria-hidden />
            {t.suggest_dismiss}
          </button>
        </span>
      </div>
      {running || error !== null ? null : (
        <>
          {(tags.length > 0 || links.length > 0) && (
            <div className="flex flex-col gap-1">
              {tags.length > 0 && (
                <div className="flex flex-wrap items-center gap-1">
                  <span className="shrink-0 text-[10px] text-text-subtle">{t.suggest_tags}</span>
                  {tags.map((tag) => {
                    const applied = appliedTags.includes(tag) || appendTag(body, tag) === null;
                    return (
                      <button
                        key={tag}
                        type="button"
                        disabled={disabled || applied}
                        aria-pressed={applied}
                        onClick={() => {
                          const next = appendTag(body, tag);
                          if (next === null) return;
                          setAppliedTags((prev) => (prev.includes(tag) ? prev : [...prev, tag]));
                          onApplyBody(next);
                        }}
                        className="inline-flex items-center gap-1 rounded-[var(--tag-radius)] bg-surface-muted text-[10px] font-medium text-text-muted transition-colors duration-150 hover:text-text disabled:cursor-default disabled:opacity-60 disabled:hover:text-text-muted"
                      >
                        {applied ? (
                          <>
                            <Check size={10} aria-hidden />
                            {t.suggest_applied}
                          </>
                        ) : (
                          `#${tag}`
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
              {links.length > 0 && (
                <div className="flex flex-wrap items-center gap-1">
                  <span className="shrink-0 text-[10px] text-text-subtle">{t.suggest_links}</span>
                  {links.map((title) => {
                    const applied = appliedLinks.includes(title) || appendLink(body, title) === null;
                    return (
                      <button
                        key={title}
                        type="button"
                        disabled={disabled || applied}
                        aria-pressed={applied}
                        onClick={() => {
                          const next = appendLink(body, title);
                          if (next === null) return;
                          setAppliedLinks((prev) => (prev.includes(title) ? prev : [...prev, title]));
                          onApplyBody(next);
                        }}
                        className="inline-flex items-center gap-1 rounded-[var(--tag-radius)] bg-surface-muted text-[10px] font-medium text-text-muted transition-colors duration-150 hover:text-text disabled:cursor-default disabled:opacity-60 disabled:hover:text-text-muted"
                      >
                        {applied ? (
                          <>
                            <Check size={10} aria-hidden />
                            {t.suggest_applied}
                          </>
                        ) : (
                          `[[${title}]]`
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {tasks.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="shrink-0 text-[10px] text-text-subtle">{t.suggest_tasks}</span>
              {tasks.map((text, i) => {
                const applied = appliedTasks.includes(text);
                const checked = checkedTasks.includes(text);
                return (
                  <span
                    key={i}
                    className={`inline-flex min-w-0 items-center gap-1 text-[11px] ${applied ? "text-text-subtle" : "text-text-muted"}`}
                  >
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      aria-label={text}
                      disabled={disabled || applied || applyingTasks}
                      onClick={() =>
                        setCheckedTasks((prev) =>
                          prev.includes(text) ? prev.filter((x) => x !== text) : [...prev, text],
                        )
                      }
                      className="relative inline-flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border border-line-strong bg-transparent transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:pointer-events-none disabled:opacity-30"
                    >
                      {(checked || applied) && (
                        <Check size={10} strokeWidth={3} aria-hidden className="text-status-success" />
                      )}
                    </button>
                    <span className="max-w-40 truncate" title={text}>
                      {text}
                    </span>
                  </span>
                );
              })}
              <button
                type="button"
                disabled={
                  disabled ||
                  applyingTasks ||
                  !checkedTasks.some((c) => !appliedTasks.includes(c))
                }
                onClick={applySelectedTasks}
                className="ml-auto inline-flex items-center gap-1 rounded-md bg-surface-raised px-2 text-[10px] font-medium text-text transition-colors duration-150 hover:bg-surface-muted disabled:pointer-events-none disabled:opacity-40"
              >
                {applyingTasks ? t.suggest_running : t.suggest_apply_selected}
              </button>
            </div>
          )}
          {result !== null && !hasSections && (
            <p className="text-[11px] text-text-subtle">{t.suggest_empty}</p>
          )}
        </>
      )}
    </div>
  );
}
