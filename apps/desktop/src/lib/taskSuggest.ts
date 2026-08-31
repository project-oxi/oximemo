/**
 * Task field auto-suggest (tasks spec §7.3, Plan C Task 10).
 *
 * A CM6 completion source that activates only on recognized task lines
 * and offers fields NOT already present on the line. Date fields come
 * as three options each — {today} / {tomorrow} / {pick} — and every
 * selection writes a real token in the vault's `writeFormat`
 * (`📅 2026-08-27` / `[due:: 2026-08-27]`), NEVER a literal label, so
 * the Task-8 widget paints the chip the moment the doc change
 * re-runs its decoration pass.
 *
 * Integration constraint (discovered empirically): CM6 allows exactly
 * ONE `autocompletion()` extension with `override` — two different
 * override arrays throw "Config merge conflict for field override" at
 * state creation, and any `override` disables all languageData
 * sources. `@atomic-editor/editor`'s `wikiLinks()` mounts its own
 * `autocompletion({override})` whenever the config carries `suggest`.
 * The mount contract here is therefore: the host suppresses the
 * wiki-links internal completer (`wikiLinks({...cfg, suggest:
 * undefined})`) and `taskSuggestExtension` mounts the single
 * autocompletion whose override carries BOTH sources — a faithful
 * replica of the wiki-links completer (`wikiLinkCompletionSource`,
 * pinned to @atomic-editor/editor 0.6.2) plus the task suggest.
 *
 * IME safety (project doctrine): the source refuses to fire while
 * `view.composing` is true; CM6's own autocomplete re-queries on
 * compositionend (the ChangedAndMoved branch dispatches a delayed
 * startCompletion), which re-invokes this source with composing
 * === false — the explicit re-eval requirement is satisfied by that
 * machinery, not by a separate DOM listener.
 */
import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import type { WikiLinkSuggestion, WikiLinksConfig } from "@atomic-editor/editor";

import { shiftISODate, todayLocalISO } from "./dates";
import type { Dict } from "./i18n";
import {
  formatDateFieldToken,
  parseTaskLine,
  type DateField,
  type TaskField,
  type TaskLineCfg,
} from "./taskLine";
import { TASK_FIELD_ICONS, type TaskIconField } from "./taskIcons";

// --- Localized labels --------------------------------------------------

/** Localized strings for the option rows. The full i18n dict is
 *  acceptable (only a handful of keys are read: `task_field_*`,
 *  `task_recurrence`, `today`, `tomorrow`, `task_pick_date`) so the
 *  host hands its `useI18n().t` object over verbatim — the
 *  `EmbedLabels` precedent. */
export type TaskSuggestLabels = Dict;

// --- Options taxonomy --------------------------------------------------

/** Every field this suggest can offer. Date fields expand to three
 *  options each ({today}/{tomorrow}/{pick}); priority and recurrence
 *  get one bare option (a sensible default token). */
type SuggestField = DateField | "priority" | "recurrence";

const SUGGEST_FIELDS: readonly SuggestField[] = [
  "created",
  "start",
  "scheduled",
  "due",
  "done",
  "cancelled",
  "priority",
  "recurrence",
];

const FIELD_LABEL_KEY: Record<SuggestField, keyof Dict> = {
  created: "task_field_created",
  start: "task_field_start",
  scheduled: "task_field_scheduled",
  due: "task_field_due",
  done: "task_field_done",
  cancelled: "task_field_cancelled",
  priority: "task_field_priority",
  recurrence: "task_recurrence",
};

const FIELD_ICON: Record<SuggestField, TaskIconField> = {
  created: "created",
  start: "start",
  scheduled: "scheduled",
  due: "due",
  done: "done",
  cancelled: "cancelled",
  priority: "priority-medium",
  recurrence: "recurrence",
};

/** A Completion carrying a row glyph for the merged autocompletion:
 *  either a task-field mask key (`icon`, this module — the Task-3
 *  `.ox-task-ic-*` classes) or inline lucide SVG markup (`iconSvg`,
 *  the §8 slash menu, whose general editor glyphs have no mask classes
 *  — v1 keeps app.css frozen). CM6 rows are plain DOM, no React. */
export type TaskCompletion = Completion & { icon?: TaskIconField; iconSvg?: string };

function isDateFieldLocal(field: SuggestField): field is DateField {
  return field !== "priority" && field !== "recurrence";
}

// Marker tables for the {pick} option — the prefix the user completes
// with a typed ISO date. These mirror taskLine's private
// DATE_FIELD_EMOJI / DATE_FIELD_DATAVIEW_KEY tables (the same wire
// vocabulary formatDateFieldToken emits).
const EMOJI_FOR_FIELD: Record<DateField, string> = {
  created: "➕",
  start: "🛫",
  scheduled: "⏳",
  due: "📅",
  done: "✅",
  cancelled: "❌",
};

const DATAVIEW_KEY_FOR_FIELD: Record<DateField, string> = {
  created: "created",
  start: "start",
  scheduled: "scheduled",
  due: "due",
  done: "completion",
  cancelled: "cancelled",
};

/** Bare-option tokens for the non-date fields. Same defaults the
 *  popover seeds a fresh field with; the widget decorates them
 *  immediately on doc change. */
function formatNonDateToken(field: "priority" | "recurrence", cfg: TaskLineCfg): string {
  if (field === "priority") {
    return cfg.writeFormat === "emoji" ? "🔼" : "[priority:: medium]";
  }
  return cfg.writeFormat === "emoji" ? "🔁 every day" : "[repeat:: every day]";
}

// --- Pure helper -------------------------------------------------------

export interface SuggestOptionsArgs {
  /** ISO date anchoring the {today}/{tomorrow} emit. Default =
   *  `todayLocalISO()`. Host-injected so tests stay deterministic. */
  todayISO?: string;
}

export interface SuggestOptionsResult {
  /** Start of the partial token the selection replaces (line-local). */
  from: number;
  to: number;
  options: TaskCompletion[];
}

/** True when `caret` sits inside a backtick-delimited inline-code span
 *  on this line — the same single-backtick toggle `scanContent` uses,
 *  so a field typed inside `…` never suggests (and never chips). */
export function caretInsideInlineCode(line: string, caret: number): boolean {
  let inCode = false;
  for (let i = 0; i < caret && i < line.length; i++) {
    if (line[i] === "`") inCode = !inCode;
  }
  return inCode;
}

/** Pure: build the completion options for a caret position on one
 *  line. Returns null when the line is not a recognized task line
 *  (including the §7.3 global-filter containment gate the widget's
 *  `lineIsTask` and the kernel's `parse_tasks` apply), the caret is
 *  inside an inline-code span, the caret is not at a token boundary
 *  (line start, after whitespace, or end of line), or every field is
 *  already present. `from` walks back to the start of the current
 *  (whitespace-bounded) token — never into the checkbox structure and
 *  never over a complete field token already parsed on the line
 *  (existing tokens are preserved: the range degrades to a pure
 *  insertion at the caret); at end-of-line after a space `from ===
 *  to` (pure insertion). */
export function suggestOptionsFor(
  line: string,
  cfg: TaskLineCfg,
  caret: number,
  labels: TaskSuggestLabels,
  args: SuggestOptionsArgs = {},
): SuggestOptionsResult | null {
  if (!Number.isInteger(caret) || caret < 0 || caret > line.length) return null;
  const parsed = parseTaskLine(line, cfg);
  if (!parsed) return null;
  // §7.3 contract — suggest, checkbox widget, and kernel parse_tasks
  // must agree on what a task line is: with a global filter
  // configured, the line has to CONTAIN it (substring, not
  // starts-with; an empty filter passes everything). Same rule as
  // `lineIsTask` and tasks.rs's `raw_line.contains(...)`.
  if (cfg.globalFilter !== "" && !line.includes(cfg.globalFilter)) return null;
  if (caretInsideInlineCode(line, caret)) return null;
  const prev = caret > 0 ? line[caret - 1] : "";
  const atBoundary = caret === 0 || caret === line.length || /\s/.test(prev);
  if (!atBoundary) return null;
  const checkboxEnd = parsed.spans.checkbox.end;
  let from = caret;
  while (from > checkboxEnd && !/\s/.test(line[from - 1]!)) from--;
  // A complete field token already on the line is not the partial
  // trigger being typed — the apply range must not replace it.
  if (parsed.spans.fields.some((f) => f.start < caret && f.end > from)) {
    from = caret;
  }
  // The apply range never reaches into (or before) the checkbox
  // structure: a caret at/before the checkbox end becomes a pure
  // insertion at its end.
  if (from < checkboxEnd) from = checkboxEnd;
  const present = new Set<TaskField>(parsed.spans.fields.map((f) => f.field));
  const absent = SUGGEST_FIELDS.filter((f) => !present.has(f));
  if (absent.length === 0) return null;
  const today = args.todayISO ?? todayLocalISO();
  const tomorrow = shiftISODate(today, 1);
  const todayLabel = labels.today ?? "today";
  const tomorrowLabel = labels.tomorrow ?? "tomorrow";
  const pickLabel = labels.task_pick_date ?? "pick";
  const options: TaskCompletion[] = [];
  for (const field of absent) {
    const label = labels[FIELD_LABEL_KEY[field]] ?? FIELD_LABEL_KEY[field];
    if (isDateFieldLocal(field)) {
      options.push(buildDateOption(field, label, todayLabel, today, cfg));
      options.push(buildDateOption(field, label, tomorrowLabel, tomorrow, cfg));
      options.push(buildPickOption(field, label, pickLabel, cfg));
    } else {
      options.push(buildBareOption(field, label, cfg));
    }
  }
  return { from, to: Math.max(caret, from), options };
}

// --- Per-option builders -----------------------------------------------

function buildDateOption(
  field: DateField,
  fieldLabel: string,
  suffixLabel: string,
  iso: string,
  cfg: TaskLineCfg,
): TaskCompletion {
  const insert = formatDateFieldToken(field, iso, cfg.writeFormat);
  return {
    label: `${fieldLabel} ${suffixLabel}`,
    detail: insert,
    type: "text",
    icon: FIELD_ICON[field],
    apply: (view, _completion, from, to) => {
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length },
      });
    },
  };
}

function buildPickOption(
  field: DateField,
  fieldLabel: string,
  pickLabel: string,
  cfg: TaskLineCfg,
): TaskCompletion {
  const insert = cfg.writeFormat === "emoji"
    ? `${EMOJI_FOR_FIELD[field]} `
    : `[${DATAVIEW_KEY_FOR_FIELD[field]}:: `;
  return {
    label: `${fieldLabel} ${pickLabel}`,
    detail: insert.trimEnd(),
    type: "text",
    icon: FIELD_ICON[field],
    apply: (view, _completion, from, to) => {
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length },
      });
    },
  };
}

function buildBareOption(
  field: "priority" | "recurrence",
  label: string,
  cfg: TaskLineCfg,
): TaskCompletion {
  const insert = formatNonDateToken(field, cfg);
  return {
    label,
    detail: insert,
    type: "text",
    icon: FIELD_ICON[field],
    apply: (view, _completion, from, to) => {
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length },
      });
    },
  };
}

export interface TaskSuggestOpts {
  /** Vault task-line config; null while the ["config"] query is in
   *  flight — the source then stays silent (the wiki source in the
   *  same override keeps working). */
  cfg: TaskLineCfg | null;
  labels: TaskSuggestLabels;
  /** The SAME WikiLinksConfig the host passes to `wikiLinks()`; the
   *  replica completer reads suggest/serializeSuggestion/debounce
   *  from it, so both surfaces share one configuration object. */
  wiki: WikiLinksConfig;
  /** Overrides `todayLocalISO()` (tests; the host passes the shared
   *  midnight-rolling `todayKey`). */
  todayISO?: string;
  /** Extra sources merged into the SAME override (CM6 allows exactly
   *  one `autocompletion({override})` — see module doc). The §8 slash
   *  menu rides in here; its `/query` trigger is disjoint from this
   *  module's task-line tokens. */
  extraSources?: CompletionSource[];
 }

/** True when `pos` sits on a line inside a fenced code block —
 *  fence parity walked line-by-line over `docText` (the doc sliced up
 *  to `pos`; the same ```/~~~ recognition as `splitFences`). The
 *  opener and closer lines count as code. */
export function caretInFencedCodeBlock(docText: string, pos: number): boolean {
  let inFence = false;
  let cursor = 0;
  for (const line of docText.split("\n")) {
    const lineEnd = cursor + line.length;
    const fenceMarker = /^[ \t]{0,3}(```|~~~)/.test(line);
    if (inFence) {
      if (pos >= cursor && pos <= lineEnd) return true;
      if (fenceMarker) inFence = false;
    } else if (fenceMarker) {
      inFence = true;
      if (pos >= cursor && pos <= lineEnd) return true;
    }
    cursor = lineEnd + 1;
  }
  return false;
}

/** The §7.3 CompletionSource: recognized task lines only, code spans
 *  excluded (fence walk + inline-code toggle), IME-composition-gated,
 *  and — unless invoked explicitly — requiring a non-empty partial
 *  token so the picker only opens once the user has typed the start
 *  of a field trigger (CM6's fuzzy filter then hides non-matching
 *  labels, e.g. ordinary task text). */
export function taskSuggestSource(
  opts: TaskSuggestOpts,
): (context: CompletionContext) => CompletionResult | null {
  return (context: CompletionContext): CompletionResult | null => {
    // IME gate (project doctrine): never fire mid-composition. The
    // compositionend re-query is CM6's own ChangedAndMoved machinery
    // (see module doc) — no extra listener needed.
    if (context.view?.composing) return null;
    if (!opts.cfg) return null;
    const state = context.state;
    const pos = context.pos;
    if (pos > state.doc.length) return null;
    const lineObj = state.doc.lineAt(pos);
    if (caretInFencedCodeBlock(state.doc.sliceString(0, pos), pos)) return null;
    const result = suggestOptionsFor(
      lineObj.text,
      opts.cfg,
      pos - lineObj.from,
      opts.labels,
      { todayISO: opts.todayISO },
    );
    if (!result) return null;
    if (result.from === result.to && !context.explicit) return null;
    return {
      from: lineObj.from + result.from,
      to: lineObj.from + result.to,
      options: result.options,
      validFor: /^\S*$/,
    };
  };
}

// --- Wiki-links completer replica --------------------------------------
//
// Byte-faithful port of @atomic-editor/editor 0.6.2's internal
// `completionSource`/`toCompletion` (wiki-links.js): matchBefore on
// the open `[[`, 120ms default debounce with abort checks, dedupe by
// target, default serialization `[[target|label]]`, and an apply that
// consumes a following `]]` when present. Exists ONLY because the
// package does not export the source and CM6 forbids a second
// autocompletion override — if the upstream export appears, replace
// this wholesale.

const WIKI_LINK_QUERY_RE = /\[\[[^\]\n|]*$/;

function escapeWikiLabel(label: string): string {
  return label.replace(/[\]\|]/g, " ").replace(/\s+/g, " ").trim();
}

function dedupeByTarget(suggestions: WikiLinkSuggestion[]): WikiLinkSuggestion[] {
  const seen = new Set<string>();
  const deduped: WikiLinkSuggestion[] = [];
  for (const suggestion of suggestions) {
    if (seen.has(suggestion.target)) continue;
    seen.add(suggestion.target);
    deduped.push(suggestion);
  }
  return deduped;
}

function wikiToCompletion(
  suggestion: WikiLinkSuggestion,
  config: WikiLinksConfig,
): Completion & { suggestion: WikiLinkSuggestion } {
  return {
    label: suggestion.label,
    detail: suggestion.detail,
    type: "text",
    boost: suggestion.boost,
    apply: (view, completion, from, to) => {
      const selected = (completion as Completion & { suggestion: WikiLinkSuggestion }).suggestion;
      const serialize = config.serializeSuggestion ??
        ((s: WikiLinkSuggestion) => `${s.target}|${escapeWikiLabel(s.label)}]]`);
      const insert = serialize(selected);
      const replaceTo = view.state.doc.sliceString(to, to + 2) === "]]" ? to + 2 : to;
      view.dispatch({
        changes: { from, to: replaceTo, insert },
        selection: { anchor: from + insert.length },
      });
    },
    suggestion,
  };
}

export function wikiLinkCompletionSource(config: WikiLinksConfig): CompletionSource {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    if (!config.suggest) return null;
    const match = context.matchBefore(WIKI_LINK_QUERY_RE);
    if (!match || (match.from === match.to && !context.explicit)) return null;
    const query = match.text.slice(2);
    const debounceMs = config.debounceMs ?? 120;
    if (debounceMs > 0) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, debounceMs);
      await promise;
      if (context.aborted) return null;
    }
    const suggestions = dedupeByTarget(await config.suggest(query)).slice(
      0,
      config.maxSuggestions ?? 12,
    );
    if (context.aborted) return null;
    return {
      from: match.from + 2,
      to: context.pos,
      options: suggestions.map((s) => wikiToCompletion(s, config)),
      validFor: /^[^\]\n|]*$/,
    };
  };
}

// --- Extension assembly ------------------------------------------------

/** An inline lucide glyph for plain-DOM completion rows: the §8 slash
 *  menu's general editor icons, which have no app.css mask classes.
 *  Root attrs mirror lucide's defaults; SIZING lives in app.css's
 *  tooltip-row rules (slash-notion spec) so svg glyphs and the
 *  `.ox-task-ic-*` masks share one 20px row geometry — no inline
 *  styles, they would outrank the stylesheet. */
function inlineSvg(markup: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = markup;
  return svg;
}

/** addToOptions glyph painter for the merged autocompletion's rows:
 *  a task-field mask class (`icon`, this module) or inline lucide SVG
 *  markup (`iconSvg`, the §8 slash menu). Exported so a standalone
 *  `autocompletion` mount (e.g. `slashExtension`) paints identically. */
export function completionIconRenderer(completion: Completion): Node | null {
  const tc = completion as TaskCompletion;
  if (tc.icon) {
    const span = document.createElement("span");
    span.className = TASK_FIELD_ICONS[tc.icon].maskClass;
    span.setAttribute("aria-hidden", "true");
    return span;
  }
  if (tc.iconSvg) return inlineSvg(tc.iconSvg);
  return null;
}

/** Mount the single merged autocompletion: wiki `[[` completions +
 *  §7.3 task-field suggest + any `extraSources` (the §8 slash menu),
 *  one override array (CM6 rejects a second `autocompletion
 *  ({override})` — see module doc). Option rows lead with the lucide
 *  glyph — mask catalog or inline SVG via `completionIconRenderer`;
 *  `icons: false` turns CM6's type icons off so that renderer is the
 *  only glyph. */
export function taskSuggestExtension(opts: TaskSuggestOpts): Extension[] {
  return [
    autocompletion({
      activateOnTyping: true,
      icons: false,
      override: [
        wikiLinkCompletionSource(opts.wiki),
        taskSuggestSource(opts),
        ...(opts.extraSources ?? []),
      ],
      addToOptions: [{ position: 20, render: completionIconRenderer }],
    }),
  ];
}