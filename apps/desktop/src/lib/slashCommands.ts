/**
 * Slash-command system core (tasks spec §8, Plan D Tasks 1+3).
 *
 * Two halves:
 * - Types + ranking (Task 1): `SlashCommand` mirrors `PaletteCommand`
 *   minus the palette-only fields, so `rankSlashCommands` is a thin
 *   adapter over the palette's proven ladder — `matchScore` (exact >
 *   prefix > boundary > substring > subsequence) plus the decaying
 *   `RecencyLog` boost. One ranking algorithm across both surfaces.
 * - The v1 CATALOG (Task 3): the 24 spec-§8 commands across the six
 *   groups (할 일 · 날짜 · 서식 · 링크 · 쿼리 · 템플릿). Every command
 *   carries a pure `patch(doc, from, to, deps, choice)` — the exact
 *   doc mutation a pick performs, computed from the doc string alone
 *   so the apply path is unit-testable without an `EditorView`
 *   (`lib/slashExtension.ts` only wires it into CM6).
 *
 * The 할 일 group routes through `transformTaskDraft` — the SAME
 * browser mirror the checkbox/popover path uses — so slash-inserted
 * metadata is byte-identical to GUI-entered metadata and the §7.1
 * widgets decorate it on the same doc change.
 */
import { shiftISODate, todayLocalISO } from "./dates";
import { dict as enDict } from "./locales/en";
import { dict as koDict } from "./locales/ko";
import type { DictKey } from "./collectionCatalog";
import { rankCommands, type PaletteCommand, type RecencyLog } from "./paletteCommands";
import {
  codeBlockInsertion,
  dailyTasksBlockInsertion,
  dateInsertion,
  headingInsertion,
  imageEmbedInsertion,
  memoEmbedInsertion,
  memoLinkInsertion,
  queryBlockInsertion,
  quoteInsertion,
  ruleInsertion,
  tableInsertion,
  templateInsertion,
  timeInsertion,
  type Insertion,
} from "./slashInsertions";
import {
  formatDateFieldToken,
  formatPriorityToken,
  formatRecurrenceToken,
  parseTaskLine,
  symbolForStatusType,
  transformTaskDraft,
  type DateField,
  type Priority,
  type StatusType,
  type TaskEdit,
  type TaskLineCfg,
} from "./taskLine";

const tr = (locale: "ko" | "en", key: DictKey): string =>
  (locale === "ko" ? koDict[key] : enDict[key]) as string;
/** Display title in `locale`, alias in the other locale (matched,
 *  never displayed — the palette `pair` convention). */
const pair = (locale: "ko" | "en", key: DictKey): { title: string; alias: string } => ({
  title: tr(locale, key),
  alias: tr(locale === "ko" ? "en" : "ko", key),
});

// --- Types + ranking (Plan D Task 1, refined by the catalog) ------------

/** Row glyph — a `SLASH_ICONS` key. Slash rows are plain CM6 DOM (no
 *  React surface in v1), so the icon renders from inline lucide SVG
 *  markup instead of a `lucide-react` component. */
export type SlashIcon = keyof typeof SLASH_ICONS;

/** One slash-menu command. `id` is the stable recency-log identity
 *  (e.g. "slash.due"); `title` is the current-locale label and `alias`
 *  the other-locale one — matched, never displayed; `order` is the
 *  curated tiebreak. The palette-only `run` is dropped: `patch` IS the
 *  action, and it needs the doc + trigger range, not `() => void`. */
export interface SlashCommand extends Omit<PaletteCommand, "group" | "icon" | "run"> {
  icon: SlashIcon;
}

/** Everything the catalog builder and command appliers need, injected
 *  by the editor host — keeps this lib pure and unit-testable. `cfg`
 *  is null while the vault config is in flight: the catalog then mints
 *  only the 17 commands that need no task-line knowledge. */
export interface SlashDeps {
  cfg: TaskLineCfg | null;
  locale: "ko" | "en";
  recency: RecencyLog;
  /** Today's local ISO date; defaults to the wall clock. The host
   *  passes the shared midnight-rolling key so date options rollover. */
  todayISO?: string;
  /** Wall clock for 현재 시각; injectable for tests. */
  now?: () => Date;
  /** The current folder's TEMPLATE.md body, or null/empty when the
   *  folder has none — the 템플릿 command hides rather than no-op. */
  templateBody?: () => string | null;
}

/** Filter + score + sort slash commands with the palette's ladder.
 *  Empty query → [] (the menu opens on the first query character).
 *  Generic over the entry type so catalog callers keep their
 *  group/choices/patch payload; returns the caller's own objects,
 *  order-only mutation. */
export function rankSlashCommands<C extends SlashCommand>(
  commands: C[],
  query: string,
  recency: RecencyLog,
): C[] {
  // Field-mapping only: the vestigial palette fields are re-added to
  // satisfy the shared shape (rankCommands scores id/title/alias/order
  // only); `group` is synthesized and resolved back to the caller's
  // own objects on the way out.
  const original = new Map<PaletteCommand, C>();
  const mapped = commands.map((c): PaletteCommand => {
    const m: PaletteCommand = { ...c, icon: "zap", run: () => {}, group: "action" };
    original.set(m, c);
    return m;
  });
  return rankCommands(mapped, query, recency).map((m) => original.get(m)!) as C[];
}
// --- Icon markup ---------------------------------------------------------

/** Inline lucide SVG element markup (the children of the 24×24 root;
 *  root attrs — viewBox/stroke/fill — are set by the row renderer).
 *  Copied verbatim from lucide-react 0.460.0, the version taskIcons'
 *  app.css masks pin — same glyphs, third render mechanism only
 *  because app.css mask classes are frozen for v1 (Plan D scope). */
export const SLASH_ICONS = {
  // 할 일 (task-field glyphs mirror TASK_FIELD_ICONS so menu and chips
  // show the same shapes for the same fields).
  task: `<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 12 2 2 4-4"/>`, // SquareCheck
  progress: `<path d="M10.1 2.182a10 10 0 0 1 3.8 0"/><path d="M13.9 21.818a10 10 0 0 1-3.8 0"/><path d="M17.609 3.721a10 10 0 0 1 2.69 2.7"/><path d="M2.182 13.9a10 10 0 0 1 0-3.8"/><path d="M20.279 17.609a10 10 0 0 1-2.7 2.69"/><path d="M21.818 10.1a10 10 0 0 1 0 3.8"/><path d="M3.721 6.391a10 10 0 0 1 2.7-2.69"/><path d="M6.391 20.279a10 10 0 0 1-2.69-2.7"/>`, // CircleDashed
  due: `<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="M8 14h.01"/><path d="M12 14h.01"/><path d="M16 14h.01"/><path d="M8 18h.01"/><path d="M12 18h.01"/><path d="M16 18h.01"/>`, // CalendarDays
  scheduled: `<path d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h5"/><path d="M17.5 17.5 16 16.3V14"/><circle cx="16" cy="16" r="6"/>`, // CalendarClock
  start: `<polygon points="6 3 20 12 6 21 6 3"/>`, // Play
  recurrence: `<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>`, // Repeat
  "priority-highest": `<path d="m17 11-5-5-5 5"/><path d="m17 18-5-5-5 5"/>`, // ChevronsUp
  "priority-high": `<path d="m18 15-6-6-6 6"/>`, // ChevronUp
  "priority-medium": `<line x1="5" x2="19" y1="9" y2="9"/><line x1="5" x2="19" y1="15" y2="15"/>`, // Equal
  "priority-low": `<path d="m6 9 6 6 6-6"/>`, // ChevronDown
  "priority-lowest": `<path d="m7 6 5 5 5-5"/><path d="m7 13 5 5 5-5"/>`, // ChevronsDown
  // 날짜
  today: `<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>`, // Calendar
  tomorrow: `<path d="M8 2v4"/><path d="M16 2v4"/><path d="M21 13V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8"/><path d="M3 10h18"/><path d="M16 19h6"/><path d="M19 16v6"/>`, // CalendarPlus
  yesterday: `<path d="M16 19h6"/><path d="M16 2v4"/><path d="M21 15V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8.5"/><path d="M3 10h18"/><path d="M8 2v4"/>`, // CalendarMinus
  time: `<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>`, // Clock
  // 서식
  h1: `<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="m17 12 3-2v8"/>`, // Heading1
  h2: `<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="M21 18h-4c0-4 4-3 4-6 0-1.5-2-2.5-4-1"/>`, // Heading2
  h3: `<path d="M4 12h8"/><path d="M4 18V6"/><path d="M12 18V6"/><path d="M17.5 10.5c1.7-1 3.5 0 3.5 1.5a2 2 0 0 1-2 2"/><path d="M17 17.5c2 1.5 4 .3 4-1.5a2 2 0 0 0-2-2"/>`, // Heading3
  table: `<path d="M12 3v18"/><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/>`, // Table
  code: `<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>`, // Code
  quote: `<path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/>`, // Quote
  rule: `<path d="M5 12h14"/>`, // Minus
  // 링크
  wlink: `<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>`, // Link
  wembed: `<line x1="22" x2="2" y1="6" y2="6"/><line x1="22" x2="2" y1="18" y2="18"/><line x1="6" x2="6" y1="2" y2="22"/><line x1="18" x2="18" y1="2" y2="22"/>`, // Frame
  image: `<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>`, // Image
  // 쿼리
  query: `<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>`, // ListChecks
  daily: `<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="m9 16 2 2 4-4"/>`, // CalendarCheck
  // 템플릿
  template: `<rect width="18" height="7" x="3" y="3" rx="1"/><rect width="9" height="7" x="3" y="14" rx="1"/><rect width="5" height="7" x="16" y="14" rx="1"/>`, // LayoutTemplate
} as const;

// --- Catalog shape -------------------------------------------------------

/** The six v1 groups, in spec §8's curated order (also the menu's
 *  section order — `SLASH_GROUP_RANK`). */
export type SlashGroupId = "task" | "date" | "format" | "link" | "query" | "template";

export const SLASH_GROUP_RANK: Record<SlashGroupId, number> = {
  task: 1,
  date: 2,
  format: 3,
  link: 4,
  query: 5,
  template: 6,
};

/** One selectable row a command expands to: most commands are single
 *  bare rows; the date commands offer 오늘/내일 and 우선순위 offers
 *  the five levels (the popover stays the editor for other values). */
export interface SlashChoice {
  /** Stable suffix ("today"|"tomorrow"|"high"|…|""). */
  id: string;
  /** Locale key of the row suffix (null → the bare command label). */
  labelKey: DictKey | null;
  /** Row glyph override; falls back to the command's icon when unset
   *  (bare rows) — only 우선순위's level rows need their own glyph. */
  icon?: SlashIcon;
}

const BARE: SlashChoice = { id: "", labelKey: null };

/** The exact doc mutation one pick performs: `changes` are CM6 specs
 *  against the ORIGINAL doc (sorted, non-overlapping), `caret` the
 *  post-change anchor. */
export interface SlashPatch {
  changes: { from: number; to: number; insert: string }[];
  caret?: number;
}

export type SlashPatchFn = (
  doc: string,
  from: number,
  to: number,
  deps: SlashDeps,
  choice: SlashChoice,
) => SlashPatch;

export interface SlashCatalogEntry extends SlashCommand {
  group: SlashGroupId;
  /** `slash_cmd_*` label key (both locales). */
  labelKey: DictKey;
  /** `slash_group_*` key for the menu section header. */
  groupKey: DictKey;
  choices: SlashChoice[];
  /** Right-aligned hint: a compact preview of what the pick writes
   *  (token previews for the task group, literal prefixes elsewhere). */
  detail: (choice: SlashChoice, deps: SlashDeps) => string;
  patch: SlashPatchFn;
}

// --- Doc geometry helpers ------------------------------------------------

/** The line containing `pos`: [start, end) spans the line's text with
 *  the terminator (and a CRLF '\r') left outside the span. */
function lineSpanOf(doc: string, pos: number): { start: number; end: number; text: string } {
  const start = doc.lastIndexOf("\n", pos - 1) + 1;
  let nl = doc.indexOf("\n", pos);
  if (nl === -1) nl = doc.length;
  let end = nl;
  let text = doc.slice(start, nl);
  if (text.endsWith("\r")) {
    text = text.slice(0, -1);
    end -= 1;
  }
  return { start, end, text };
}

const leadingIndent = (line: string): string => line.match(/^[ \t]*/)![0];
/** Replace the "/query" span with a builder's Insertion (non-task
 *  groups). The trigger line's own indent precedes `from` in the doc,
 *  so the insertion's FIRST line drops the builder's indent (it would
 *  double-indent "  /표") while later lines keep it for alignment;
 *  the caret rides along. Builders read day/clock from `deps` at
 *  patch time, never a stale catalog-time closure. */
function insertionPatch(
  build: (indent: string, deps: SlashDeps) => Insertion,
): SlashPatchFn {
  return (doc, from, to, deps, _choice) => {
    const indent = leadingIndent(lineSpanOf(doc, from).text);
    const ins = build(indent, deps);
    const text = ins.text.startsWith(indent) ? ins.text.slice(indent.length) : ins.text;
    const caret = ins.caret >= indent.length ? ins.caret - indent.length : ins.caret;
    return { changes: [{ from, to, insert: text }], caret: from + caret };
  };
}

/** Shared apply for the 할 일 group. Deletes the "/query" span from
 *  its line first, then:
 *  - ON a task line — re-splices the line through `transformTaskDraft`
 *    (the popover/checkbox mirror), so an existing field token is
 *    REPLACED in place and an absent one appended; 할 일/진행 중
 *    become plain status edits.
 *  - OFF a task line — the line is PROMOTED: indent kept, checkbox
 *    prefix in the vault's own symbols, content trimmed (a leading
 *    list marker is absorbed), `global_filter` appended when missing;
 *    the field edit (if any) then runs on the promoted line. */
function taskGroupPatch(
  promoteType: StatusType,
  editFor: (choice: SlashChoice, cfg: TaskLineCfg, today: string) => TaskEdit | null,
): SlashPatchFn {
  return (doc, from, to, deps, choice) => {
    // Task commands are minted only under a resolved cfg (see
    // buildSlashCatalog), so the closure's deps always carries one.
    const cfg = deps.cfg!;
    const today = deps.todayISO ?? todayLocalISO();
    const line = lineSpanOf(doc, from);
    // The line as it reads once the "/query" span is gone. Trailing
    // whitespace is a deletion artifact (the space before the '/'),
    // not user content — trimEnd restores the line the mirror (and
    // the kernel) would have seen.
    const rawAfter = (
      line.text.slice(0, from - line.start) + line.text.slice(to - line.start)
    ).trimEnd();
    const fieldEdit = editFor(choice, cfg, today);
    let base: string;
    let edit: TaskEdit | null;
    if (parseTaskLine(rawAfter, cfg)) {
      base = rawAfter;
      edit = fieldEdit ?? { kind: "status", symbol: symbolForStatusType(cfg, promoteType) };
    } else {
      const indent = leadingIndent(rawAfter);
      const rest = rawAfter
        .slice(indent.length)
        .trim()
        .replace(/^(?:[-*+]|\d{1,9}[.)])[ \t]+/, "");
      const parts = [`- [${symbolForStatusType(cfg, promoteType)}]`, rest];
      if (cfg.globalFilter.length > 0 && !rest.includes(cfg.globalFilter)) {
        parts.push(cfg.globalFilter);
      }
      base = indent + parts.join(" ");
      edit = fieldEdit;
    }
    const newLine = edit
      ? transformTaskDraft(base, 0, edit, today, cfg).changes[0]!.insert_lines[0]!
      : base;
    return {
      changes: [{ from: line.start, to: line.end, insert: newLine }],
      caret: line.start + newLine.length,
    };
  };
}

/** ISO value for a date command's 오늘/내일 choice. */
function dateChoiceISO(choiceId: string, today: string): string {
  return choiceId === "tomorrow" ? shiftISODate(today, 1) : today;
}

const PRIORITY_LEVELS: Array<{ choice: SlashChoice; value: Exclude<Priority, null> }> = [
  { choice: { id: "highest", labelKey: "task_priority_highest", icon: "priority-highest" }, value: "highest" },
  { choice: { id: "high", labelKey: "task_priority_high", icon: "priority-high" }, value: "high" },
  { choice: { id: "medium", labelKey: "task_priority_medium", icon: "priority-medium" }, value: "medium" },
  { choice: { id: "low", labelKey: "task_priority_low", icon: "priority-low" }, value: "low" },
  { choice: { id: "lowest", labelKey: "task_priority_lowest", icon: "priority-lowest" }, value: "lowest" },
];

/** The most common default recurrence — a plain weekly. v1 opens no
 *  rule editor from the menu: the Plan C popover is the editor for
 *  non-default rules, and the inserted token is immediately decorated
 *  and editable through it. */
const RECURRENCE_DEFAULT = "every week";

// --- The catalog ---------------------------------------------------------

/** Mint the v1 catalog: the 할 일 group first (needs cfg), then 날짜 ·
 *  서식 · 링크 · 쿼리 · 템플릿. 24 commands when `deps.templateBody()`
 *  yields a non-blank body, 23 otherwise (the 템플릿 command hides
 *  rather than silently inserting nothing), and 17 while `cfg` is
 *  unresolved (the 할 일 group needs write_format/statuses/
 *  global_filter). */
export function buildSlashCatalog(deps: SlashDeps): SlashCatalogEntry[] {
  const out: SlashCatalogEntry[] = [];
  const mint = (e: Omit<SlashCatalogEntry, "title" | "alias" | "order">) => {
    const { title, alias } = pair(deps.locale, e.labelKey);
    out.push({ ...e, title, alias, order: out.length });
  };

  if (deps.cfg) {
    mint({
      id: "slash.task",
      group: "task",
      labelKey: "slash_cmd_task",
      groupKey: "slash_group_task",
      icon: "task",
      choices: [BARE],
      detail: () => "",
      patch: taskGroupPatch("TODO", () => null),
    });
    mint({
      id: "slash.progress",
      group: "task",
      labelKey: "slash_cmd_progress",
      groupKey: "slash_group_task",
      icon: "progress",
      choices: [BARE],
      detail: () => "",
      patch: taskGroupPatch("IN_PROGRESS", () => null),
    });
    const dateCmd = (id: string, field: DateField, labelKey: DictKey, icon: SlashIcon) =>
      mint({
        id,
        group: "task",
        labelKey,
        groupKey: "slash_group_task",
        icon,
        choices: [
          { id: "today", labelKey: "today", icon },
          { id: "tomorrow", labelKey: "tomorrow", icon },
        ],
        detail: (choice, deps2) =>
          formatDateFieldToken(
            field,
            dateChoiceISO(choice.id, deps2.todayISO ?? todayLocalISO()),
            deps2.cfg!.writeFormat,
          ),
        patch: taskGroupPatch("TODO", (choice, _cfg, t) => ({
          kind: "date",
          field,
          value: dateChoiceISO(choice.id, t),
        })),
      });
    dateCmd("slash.due", "due", "slash_cmd_due", "due");
    dateCmd("slash.scheduled", "scheduled", "slash_cmd_scheduled", "scheduled");
    dateCmd("slash.start", "start", "slash_cmd_start", "start");
    mint({
      id: "slash.priority",
      group: "task",
      labelKey: "slash_cmd_priority",
      groupKey: "slash_group_task",
      icon: "priority-highest",
      choices: PRIORITY_LEVELS.map((l) => l.choice),
      detail: (choice, deps2) =>
        formatPriorityToken(
          PRIORITY_LEVELS.find((l) => l.choice.id === choice.id)?.value ?? null,
          deps2.cfg!.writeFormat,
        ) ?? "",
      patch: taskGroupPatch("TODO", (choice) => ({
        kind: "priority",
        value: PRIORITY_LEVELS.find((l) => l.choice.id === choice.id)?.value ?? null,
      })),
    });
    mint({
      id: "slash.recurrence",
      group: "task",
      labelKey: "slash_cmd_recurrence",
      groupKey: "slash_group_task",
      icon: "recurrence",
      choices: [BARE],
      detail: (_choice, deps2) =>
        formatRecurrenceToken(RECURRENCE_DEFAULT, deps2.cfg!.writeFormat),
      patch: taskGroupPatch("TODO", () => ({ kind: "recurrence", value: RECURRENCE_DEFAULT })),
    });
  }

  const dateIns = (id: string, labelKey: DictKey, icon: SlashIcon, delta: 0 | 1 | -1) =>
    mint({
      id,
      group: "date",
      labelKey,
      groupKey: "slash_group_date",
      icon,
      choices: [BARE],
      detail: (_c, deps2) => shiftISODate(deps2.todayISO ?? todayLocalISO(), delta),
      patch: insertionPatch((indent, deps2) =>
        dateInsertion(indent, deps2.todayISO ?? todayLocalISO(), delta),
      ),
    });
  dateIns("slash.today", "slash_cmd_today", "today", 0);
  dateIns("slash.tomorrow", "slash_cmd_tomorrow", "tomorrow", 1);
  dateIns("slash.yesterday", "slash_cmd_yesterday", "yesterday", -1);
  mint({
    id: "slash.time",
    group: "date",
    labelKey: "slash_cmd_time",
    groupKey: "slash_group_date",
    icon: "time",
    choices: [BARE],
    detail: (_c, deps2) => {
      const d = deps2.now?.() ?? new Date();
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    },
    patch: insertionPatch((indent, deps2) => timeInsertion(indent, deps2.now?.() ?? new Date())),
  });

  const heading = (level: 1 | 2 | 3) =>
    mint({
      id: `slash.h${level}`,
      group: "format",
      labelKey: (`slash_cmd_h${level}` as DictKey),
      groupKey: "slash_group_format",
      icon: (`h${level}` as SlashIcon),
      choices: [BARE],
      detail: () => "#".repeat(level),
      patch: insertionPatch((indent) => headingInsertion(indent, level)),
    });
  heading(1);
  heading(2);
  heading(3);
  mint({
    id: "slash.table",
    group: "format",
    labelKey: "slash_cmd_table",
    groupKey: "slash_group_format",
    icon: "table",
    choices: [BARE],
    detail: () => "|—|",
    patch: insertionPatch(tableInsertion),
  });
  mint({
    id: "slash.code",
    group: "format",
    labelKey: "slash_cmd_code",
    groupKey: "slash_group_format",
    icon: "code",
    choices: [BARE],
    detail: () => "```",
    patch: insertionPatch(codeBlockInsertion),
  });
  mint({
    id: "slash.quote",
    group: "format",
    labelKey: "slash_cmd_quote",
    groupKey: "slash_group_format",
    icon: "quote",
    choices: [BARE],
    detail: () => ">",
    patch: insertionPatch(quoteInsertion),
  });
  mint({
    id: "slash.rule",
    group: "format",
    labelKey: "slash_cmd_rule",
    groupKey: "slash_group_format",
    icon: "rule",
    choices: [BARE],
    detail: () => "---",
    patch: insertionPatch(ruleInsertion),
  });

  mint({
    id: "slash.wlink",
    group: "link",
    labelKey: "slash_cmd_wlink",
    groupKey: "slash_group_link",
    icon: "wlink",
    choices: [BARE],
    detail: () => "[[ ]]",
    patch: insertionPatch(memoLinkInsertion),
  });
  mint({
    id: "slash.wembed",
    group: "link",
    labelKey: "slash_cmd_wembed",
    groupKey: "slash_group_link",
    icon: "wembed",
    choices: [BARE],
    detail: () => "![[ ]]",
    patch: insertionPatch(memoEmbedInsertion),
  });
  mint({
    id: "slash.image",
    group: "link",
    labelKey: "slash_cmd_image",
    groupKey: "slash_group_link",
    icon: "image",
    choices: [BARE],
    detail: () => "![[.png]]",
    patch: insertionPatch(imageEmbedInsertion),
  });

  mint({
    id: "slash.query",
    group: "query",
    labelKey: "slash_cmd_query",
    groupKey: "slash_group_query",
    icon: "query",
    choices: [BARE],
    detail: () => "```query",
    patch: insertionPatch(queryBlockInsertion),
  });
  mint({
    id: "slash.daily",
    group: "query",
    labelKey: "slash_cmd_daily",
    groupKey: "slash_group_query",
    icon: "daily",
    choices: [BARE],
    detail: () => "```query",
    patch: insertionPatch(dailyTasksBlockInsertion),
  });

  const body = deps.templateBody?.() ?? null;
  // A blank TEMPLATE.md yields an empty Insertion — hide the command
  // instead of no-oping behind a menu row (Plan D Task 2 review).
  if (body !== null && body.trim() !== "") {
    mint({
      id: "slash.template",
      group: "template",
      labelKey: "slash_cmd_template",
      groupKey: "slash_group_template",
      icon: "template",
      choices: [BARE],
      detail: () => body.trim().split("\n")[0]!.slice(0, 24),
      patch: insertionPatch((indent) => templateInsertion(indent, body)),
    });
  }
  return out;
}

// --- Option expansion ----------------------------------------------------

/** One menu row: the base command (recency identity + patch) plus the
 *  concrete choice, with localized label and hint. */
export interface SlashOption {
  command: SlashCatalogEntry;
  choice: SlashChoice;
  label: string;
  detail: string;
}

/** Expand a (ranked) command into its selectable rows — bare rows for
 *  most commands, 오늘/내일 for the date fields, the five levels for
 *  우선순위 — in curated order. */
export function slashOptionsFor(command: SlashCatalogEntry, deps: SlashDeps): SlashOption[] {
  const base = tr(deps.locale, command.labelKey);
  return command.choices.map((choice) => ({
    command,
    choice,
    label: choice.labelKey ? `${base} · ${tr(deps.locale, choice.labelKey)}` : base,
    detail: command.detail(choice, deps),
  }));
}
