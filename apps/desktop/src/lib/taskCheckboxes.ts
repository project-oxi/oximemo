/**
 * CM6 task-line widgets (tasks spec §7.1, Plan C Task 8).
 *
 * Live preview for task lines in the memo editor: every recognized task
 * line outside fenced code is replaced by a plain-DOM widget — an
 * interactive checkbox (TaskCheckbox's visual via the §7.0 icon-mask
 * path: no React rides inside a CM6 widget) followed by the body text,
 * field chips, and tags. A caret inside a decorated line reveals the
 * raw bytes, so any field can always be hand-edited or deleted.
 *
 * Structure follows `lib/embeds.ts`: a `StateField` owns the
 * `DecorationSet`, a `ViewPlugin` rebuilds on doc/viewport/selection
 * changes, and widgets never own the view. Clicking the checkbox (or
 * `⌘⇧Enter` on the caret's line) sends the FULL draft through
 * `transform_task_draft` (Tauri command on desktop, the golden-tested
 * `taskLine.ts` mirror in browser mode) and applies every returned
 * line change in ONE transaction with the selection mapped through.
 * No disk-based `patch_task` runs here — the editor owns the unsaved
 * buffer and the existing 500 ms autosave persists it.
 */
import {
  type EditorState,
  type Extension,
  Prec,
  type Range,
  RangeSet,
  StateEffect,
  StateField,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

import { transformTaskDraft } from "./api";
import { todayLocalISO } from "./dates";
import { chipRawValue, previewTaskLine, splitFences, type Chip, type FieldChip } from "./taskPreview";
import {
  parseTaskLine,
  type DateField,
  type ParsedLine,
  type StatusType,
  type TaskEdit,
  type TaskField,
  type TaskLineCfg,
  type TaskLineChange,
} from "./taskLine";
import { TASK_FIELD_ICONS, type TaskIconField } from "./taskIcons";
import type { DayTone } from "./relativeDay";
import type { TaskDateField, TaskEdit as WireTaskEdit, TaskPriorityWord } from "./types";

// --- Labels -------------------------------------------------------------

/** Localized strings/closures the task widgets render. Passed in from
 *  the editor host (which owns the i18n dict) — this is a pure lib, no
 *  React (the `EmbedLabels` precedent). `status` maps a StatusType to
 *  its localized label for the checkbox's aria-label/title. `dayLabel`
 *  and `dayTone` carry the §7.0 rule that dates never render as raw
 *  ISO: the host closes over its locale and the shared midnight-
 *  updating today key (`lib/relativeDay.ts`). */
export interface TaskCheckboxLabels {
  status: Record<string, string>;
  dayLabel?: (iso: string) => string;
  dayTone?: (iso: string) => DayTone;
}

export interface TaskCheckboxOpts {
  cfg: TaskLineCfg;
  labels: TaskCheckboxLabels;
  /** Fired when a transform cannot apply — the kernel rejected the
   *  line, or the buffer moved between the click and the reply. The
   *  decorations rebuild either way; the host decides how to surface. */
  onConflict?: () => void;
  /** Right-click on the checkbox (spec §7.2). The popover itself is
   *  Task 9; this hook fires with the 0-based line. */
  onPopoverRequest?: (line: number) => void;
}

// --- Pure helpers -------------------------------------------------------

/** True when `raw` opens a recognized task checkbox prefix under `cfg`
 * — and, when the vault configures a `global_filter` token, contains
 * it (the same containment gate the kernel's `parse_tasks` applies). */
export function lineIsTask(raw: string, cfg: TaskLineCfg): boolean {
  if (cfg.globalFilter.length > 0 && !raw.includes(cfg.globalFilter)) return false;
  return parseTaskLine(raw, cfg) !== null;
}

/** One decorated task line: char offsets into the doc text plus the
 * parsed spans (checkbox + field tokens) the widget renders. */
export interface TaskLineWidgetRange {
  /** 0-based line index. */
  line: number;
  /** The line's raw bytes (also the WidgetType.eq key). */
  raw: string;
  /** Whole-line char range, line separator excluded. A CRLF line's
   * trailing "\r" is line content — CM6 keeps it in the line. */
  from: number;
  to: number;
  /** Caret sits inside [from, to]: the raw bytes must stay visible. */
  revealed: boolean;
  parsed: ParsedLine;
}

/** Per-line decorate-or-reveal plan for a whole document. Pure — the
 * StateField and the ViewPlugin both derive their DecorationSet from
 * this, and the test suite drives it without a CM6 editor. Task lines
 * inside fenced code blocks are skipped (fences are code, not tasks). */
export function widgetRangesFor(
  text: string,
  selectionHead: number,
  cfg: TaskLineCfg,
): TaskLineWidgetRange[] {
  const lines = text.split("\n");
  const fence = fenceLineMask(text, lines.length);
  const out: TaskLineWidgetRange[] = [];
  let from = 0;
  for (let i = 0; i < lines.length; i++, from += lines[i - 1]!.length + 1) {
    const raw = lines[i]!;
    if (fence[i]) continue;
    if (!lineIsTask(raw, cfg)) continue;
    const parsed = parseTaskLine(raw, cfg);
    if (!parsed) continue;
    const to = from + raw.length;
    out.push({ line: i, raw, from, to, revealed: selectionHead >= from && selectionHead <= to, parsed });
  }
  return out;
}

/** 1 for every line index inside a fenced code block — the same fence
 * recognition as the markdown preview path (`splitFences`). */
function fenceLineMask(text: string, lineCount: number): Uint8Array {
  const mask = new Uint8Array(lineCount);
  let idx = 0;
  for (const seg of splitFences(text)) {
    const n = seg.text.split("\n").length;
    if (seg.code) mask.fill(1, idx, idx + n);
    idx += n;
  }
  return mask;
}

/** Extra mark class per status type — mirrors TaskCheckbox's mark
 *  choice (Check / Minus / half fill) with plain CSS instead of
 *  lucide React. Open states keep the bare `.ox-taskline-box` look
 *  (empty box), so they emit no extra token — there is no
 *  `.ox-taskline-box-open` rule to hang one on. */
const BOX_MARK_CLASS: Partial<Record<StatusType, string>> = {
  IN_PROGRESS: "ox-taskline-box-progress",
  DONE: "ox-taskline-box-done",
  CANCELLED: "ox-taskline-box-cancelled",
};

/** Inner mark glyph (lucide Check/Minus as CSS masks — see app.css).
 * IN_PROGRESS paints the box's half-fill background instead; open
 * states stay empty. */
const BOX_MARK_ICON: Partial<Record<StatusType, string>> = {
  DONE: "ox-task-ic-check",
  CANCELLED: "ox-task-ic-minus",
};

/** aria-checked semantics, kept in lockstep with TaskCheckbox's
 * identical mapping (done-family → "true", in-progress → "mixed"). */
function ariaChecked(statusType: StatusType): "true" | "mixed" | "false" {
  if (statusType === "DONE" || statusType === "CANCELLED") return "true";
  if (statusType === "IN_PROGRESS") return "mixed";
  return "false";
}

/** Leading indent width in columns: spaces count 1, tabs 4 (CM6's
 * default tab size). Cosmetic only — drives the widget's left padding
 * so nested tasks keep their visual nesting. */
function indentColumns(raw: string): number {
  let cols = 0;
  for (const c of raw) {
    if (c === " ") cols += 1;
    else if (c === "\t") cols += 4;
    else break;
  }
  return cols;
}

const DATE_FIELDS: Record<string, true> = {
  created: true,
  start: true,
  scheduled: true,
  due: true,
  done: true,
  cancelled: true,
};

function isDateField(field: TaskField): field is DateField {
  return DATE_FIELDS[field] === true;
}

/** Field icon for a chip: date/created/done/cancelled/recurrence map
 *  to their catalog glyph, priority to its level. `null` = an
 *  unrecognized priority token (renders its raw bytes as text instead
 *  of inventing a state — the preview path's rule). */
function iconFieldOf(chip: FieldChip): TaskIconField | null {
  if (chip.field === "priority") {
    return chip.priority ? (`priority-${chip.priority}` as TaskIconField) : null;
  }
  return chip.field;
}

/** §7.0 tones map to the inert chip classes already shipped with the
 *  preview path (`.ox-task-field-overdue/-today`); "future" keeps the
 *  chip's default subtle color, like TaskFieldChip's text-text-subtle. */
const TONE_CLASS: Record<DayTone, string> = {
  overdue: "ox-task-field-overdue",
  today: "ox-task-field-today",
  future: "",
};

type ToggleFn = (view: EditorView, line: number) => void;

export class TaskLineWidget extends WidgetType {
  constructor(
    readonly line: number,
    readonly lineText: string,
    readonly symbol: string,
    readonly statusType: StatusType,
    readonly chips: Chip[],
    readonly indent: number,
    readonly labels: TaskCheckboxLabels,
    readonly onToggle: ToggleFn,
    readonly onContextMenu: ((line: number) => void) | undefined,
  ) {
    super();
  }

  /** Recreate when the line index, line bytes, or checkbox symbol
   *  change. Everything else the DOM shows (chips, marks, labels)
   *  derives from the bytes — the cfg and label closures are fixed
   *  per extension instance. The line index is identity even though
   *  the bytes don't show it: CM6 keeps the existing DOM (and its
   *  listener closures) while eq holds, so a widget reused after a
   *  line-count change above it would fire a stale line. */
  eq(other: TaskLineWidget) {
    return other.line === this.line && other.lineText === this.lineText && other.symbol === this.symbol;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "ox-taskline";
    if (this.indent > 0) wrap.style.paddingLeft = `${this.indent}ch`;

    const statusLabel = this.labels.status[this.statusType] ?? this.symbol;
    const body = this.chips.find((c): c is Extract<Chip, { kind: "text" }> => c.kind === "text")?.text ?? "";
    const box = document.createElement("button");
    box.type = "button";
    box.setAttribute("role", "checkbox");
    box.setAttribute("aria-checked", ariaChecked(this.statusType));
    box.setAttribute("aria-label", `${statusLabel}: ${body}`.trim());
    box.title = statusLabel;
    const boxMark = BOX_MARK_CLASS[this.statusType];
    box.className = boxMark ? `ox-taskline-box ${boxMark}` : "ox-taskline-box";
    const markIcon = BOX_MARK_ICON[this.statusType];
    if (markIcon) {
      const mark = document.createElement("span");
      mark.className = markIcon;
      mark.setAttribute("aria-hidden", "true");
      box.append(mark);
    }
    // §7.1: button handlers prevent the editor's default mousedown
    // selection before applying their transaction, so clicking never
    // drags the caret off the current line.
    box.addEventListener("mousedown", (e) => e.preventDefault());
    // Resolve the line at event time from the widget's live position:
    // eq may keep this DOM (and its closures) across rebuilds, so the
    // captured `this.line` can go stale when lines shift above.
    box.addEventListener("click", () => this.onToggle(view, view.state.doc.lineAt(view.posAtDOM(box)).number - 1));
    if (this.onContextMenu) {
      box.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.onContextMenu!(view.state.doc.lineAt(view.posAtDOM(box)).number - 1);
      });
    }
    wrap.append(box);

    for (const chip of this.chips) {
      if (chip.kind === "status") continue; // the box above IS the status chip
      if (chip.kind === "text") {
        if (!chip.text) continue;
        const text = document.createElement("span");
        text.className = "ox-taskline-text";
        text.textContent = chip.text;
        wrap.append(text);
      } else if (chip.kind === "tag") {
        const tag = document.createElement("span");
        tag.className = "ox-taskline-tag";
        tag.textContent = chip.text;
        wrap.append(tag);
      } else if (chip.kind === "field") {
        wrap.append(this.fieldChipDom(chip));
      }
    }
    return wrap;
  }

  private fieldChipDom(chip: FieldChip): HTMLSpanElement {
    const el = document.createElement("span");
    el.dataset.field = chip.field;
    const tone = this.fieldTone(chip);
    el.className = `ox-task-field${tone ? ` ${tone}` : ""}`;
    const iconField = iconFieldOf(chip);
    if (iconField) {
      const icon = document.createElement("span");
      icon.className = TASK_FIELD_ICONS[iconField].maskClass;
      icon.setAttribute("aria-hidden", "true");
      el.append(icon);
    }
    const value = this.fieldValue(chip);
    if (value) {
      const label = document.createElement("span");
      label.textContent = value;
      el.append(label);
    }
    return el;
  }

  /** Chip text: date fields render the host's relative label (§7.0 —
   *  never a raw ISO), recurrence the rule, priority nothing (icon
   *  only). An invalid date keeps the icon with no text; an
   *  unrecognized priority token falls back to its raw bytes so
   *  nothing silently vanishes. */
  private fieldValue(chip: FieldChip): string | null {
    if (chip.field === "priority") return chip.priority ? null : chip.text;
    const raw = chipRawValue(chip.field, chip.text);
    if (raw === null) return null;
    return isDateField(chip.field) && this.labels.dayLabel ? this.labels.dayLabel(raw) : raw;
  }

  private fieldTone(chip: FieldChip): string | null {
    if (!isDateField(chip.field) || !this.labels.dayTone) return null;
    const raw = chipRawValue(chip.field, chip.text);
    if (raw === null) return null;
    return TONE_CLASS[this.labels.dayTone(raw)] || null;
  }

  ignoreEvent() {
    return false;
  }
}

// --- Transform application ----------------------------------------------

/** camelCase mirror edit → externally tagged PascalCase wire edit
 * (the api layer's TaskEdit; identical to the golden fixture corpus). */
const DATE_FIELD_WIRE: Record<DateField, TaskDateField> = {
  created: "Created",
  start: "Start",
  scheduled: "Scheduled",
  due: "Due",
  done: "Done",
  cancelled: "Cancelled",
};

function toWireEdit(edit: TaskEdit): WireTaskEdit {
  switch (edit.kind) {
    case "toggle":
      return "Toggle";
    case "status":
      return { SetStatus: edit.symbol };
    case "date":
      return { SetDate: { field: DATE_FIELD_WIRE[edit.field], value: edit.value } };
    case "priority":
      return {
        SetPriority: (edit.value === null
          ? "None"
          : edit.value[0]!.toUpperCase() + edit.value.slice(1)) as TaskPriorityWord,
      };
    case "text":
      return { SetText: edit.value };
    case "recurrence":
      return { SetRecurrence: edit.value };
  }
}

/** Map kernel line changes to CM6 offsets against `doc` (the same doc
 * the transform ran on — offsets were validated against it). Line
 * indices are 0-based against "\n"-split lines; CM6 lines are 1-based.
 * `delete_lines: 0` is a pure insertion anchored at the start of
 * `start_line`, so both ends collapse to its `from`. */
function changeSpecs(doc: Text, changes: TaskLineChange[]) {
  return changes.map((c) => {
    const from = doc.line(c.start_line + 1).from;
    const to = c.delete_lines > 0 ? doc.line(c.start_line + c.delete_lines).to : from;
    return { from, to, insert: c.insert_lines.join("\n") };
  });
}

/** Apply one task edit to the draft buffer: FULL doc → kernel → ONE
 * transaction (the selection maps through automatically). Async — the
 * desktop IPC round-trip resolves later, so the doc is re-checked
 * against the pre-call snapshot before dispatching; drift (or any
 * kernel rejection) reports through `onConflict` instead of splicing
 * shifted offsets. A reply with no changes is a no-op (the line
 * already matches — a racing update got there first) and returns
 * silently. Exported for the Task 9 popover, which commits the
 * same way. */
export async function applyTaskTransform(
  view: EditorView,
  line: number,
  edit: TaskEdit,
  opts: TaskCheckboxOpts,
): Promise<void> {
  const before = view.state.doc;
  let changes: TaskLineChange[];
  try {
    ({ changes } = await transformTaskDraft(before.toString(), line, toWireEdit(edit), todayLocalISO()));
  } catch {
    opts.onConflict?.();
    return;
  }
  if (changes.length === 0) return; // no-op: state already matches
  if (view.state.doc !== before) {
    opts.onConflict?.();
    return;
  }
  view.dispatch({ changes: changeSpecs(before, changes) });
}

// --- Extension assembly -------------------------------------------------

/** Effect the ViewPlugin dispatches to force a decoration rebuild
 * (the §7.1 doc/viewport/selection rebuild contract). */
const rebuildDecorations = StateEffect.define<null>();

function buildDecorations(
  state: EditorState,
  opts: TaskCheckboxOpts,
  apply: ToggleFn,
): DecorationSet {
  const decos: Range<Decoration>[] = [];
  for (const r of widgetRangesFor(state.doc.toString(), state.selection.main.head, opts.cfg)) {
    if (r.revealed) continue; // caret on the line: raw bytes stay visible
    decos.push(
      Decoration.replace({
        block: true,
        widget: new TaskLineWidget(
          r.line,
          r.raw,
          r.parsed.symbol,
          r.parsed.statusType,
          previewTaskLine(r.parsed, r.raw, opts.cfg),
          indentColumns(r.raw),
          opts.labels,
          apply,
          opts.onPopoverRequest,
        ),
      }).range(r.from, r.to),
    );
  }
  return Decoration.set(decos, true);
}

/** CM6 task checkbox + field-chip widgets (spec §7.1). Returns
 *  `[field, keymap, viewPlugin]`; mount the spread array in the
 *  editor's extension assembly (`MemoEditorForm`), like
 *  `embedExtension`. */
export function taskCheckboxExtension(opts: TaskCheckboxOpts): Extension[] {
  const apply: ToggleFn = (view, line) => {
    void applyTaskTransform(view, line, { kind: "toggle" }, opts);
  };

  const field = StateField.define<DecorationSet>({
    create: (state) => buildDecorations(state, opts, apply),
    update: (value, tr) => {
      // Selection-triggered rebuild IS the caret-reveal mechanism:
      // merely mapping the decorations through `tr.changes` would keep
      // a widget over the line the caret just entered.
      if (tr.docChanged || tr.selection || tr.effects.some((e) => e.is(rebuildDecorations))) {
        return buildDecorations(tr.state, opts, apply);
      }
      return value.map(tr.changes);
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v),
  });

  // ⌘⇧Enter toggles the caret's task line. Prec.highest so it outranks
  // the atomic-editor base bindings (imagePickerKeymap precedent);
  // MemoDetail's document-level ⌘Enter save-and-close listener guards
  // itself with !shiftKey (§7.1 required cutover).
  const toggleKeymap = Prec.highest(
    keymap.of([
      {
        key: "Mod-Shift-Enter",
        preventDefault: true,
        run: (view) => {
          const line = view.state.doc.lineAt(view.state.selection.main.head);
          if (!lineIsTask(line.text, opts.cfg)) return false;
          apply(view, line.number - 1);
          return true;
        },
      },
      // ⌘⇧E opens the popover on the caret's task line (spec §7.2).
      // Fires the same `onPopoverRequest` hook right-click uses, so
      // the host wires one path for both surfaces. Returns `false`
      // when the caret isn't on a task line — lets the editor's
        // default behavior win (otherwise we'd swallow the key combo
        // everywhere else).
      {
        key: "Mod-Shift-e",
        preventDefault: true,
        run: (view) => {
          if (!opts.onPopoverRequest) return false;
          const line = view.state.doc.lineAt(view.state.selection.main.head);
          if (!lineIsTask(line.text, opts.cfg)) return false;
          opts.onPopoverRequest(line.number - 1);
          return true;
        },
      },
    ]),
  );

  const plugin = ViewPlugin.define((view: EditorView) => ({
    update(u: ViewUpdate) {
      // §7.1: rebuild on doc/viewport/selection changes. Doc and
      // selection rebuilds already happened inside the field's own
      // transaction; this covers the viewport case (and self-heals any
      // missed rebuild) without looping — it only dispatches when the
      // freshly built set actually differs from the stored one.
      if (!(u.docChanged || u.viewportChanged || u.selectionSet)) return;
      if (RangeSet.eq([view.state.field(field)], [buildDecorations(view.state, opts, apply)])) return;
      view.dispatch({ effects: rebuildDecorations.of(null) });
    },
  }));

  return [field, toggleKeymap, plugin];
}
