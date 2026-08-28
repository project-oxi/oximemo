/**
 * Preview chip derivation for raw task lines (Plan C §4).
 *
 * The browser-side preview surfaces (hover tooltips, CM6 widget overlays,
 * Task 8 widgets, Task 9 popovers) only have the raw line bytes to work
 * with — not the parsed `TaskDto` from the Rust kernel that the table /
 * board / list views consume. `previewTaskLine` turns a raw line (or a
 * pre-parsed `ParsedLine`) into an inert, typed `Chip[]` that those
 * surfaces can map onto `TaskCheckbox` / `TaskFieldChip` (or their CM6
 * widget equivalents).
 *
 * INERT by design: this module never imports React, never calls into
 * the relative-day hook, never carries click handlers. The chips carry
 * raw line content (so they survive `previewText` style truncation and
 * work in CM6 widget DOM); the consumer decides how to render them —
 * locale-aware labels, click handlers, tone classes, etc.
 *
 * Single source of truth: chip derivation reuses `parseTaskLine` and
 * `tagSpansOf` from `lib/taskLine.ts` — no re-scanning of the line, no
 * emoji lookup tables duplicated here. When the kernel grows a new
 * field kind, this module follows automatically.
 */
import {
  parseTaskLine,
  tagSpansOf,
  type ParsedLine,
  type Priority,
  type Range,
  type StatusType,
  type TaskField,
  type TaskLineCfg,
} from "./taskLine";

/** A single inert chip. The kind narrows the chip's metadata. */
export type Chip =
  | StatusChip
  | TextChip
  | FieldChip
  | TagChip
  | SpacerChip;

export interface StatusChip {
  kind: "status";
  /** Original checkbox bytes, e.g. `[x]`, `[/]`, `[-]`, `[ ]`. */
  text: string;
  statusType: StatusType;
}

export interface TextChip {
  kind: "text";
  /** Body text with recognised metadata tokens stripped. Tags are
   * emitted as separate `tag` chips, so this is just the plain words. */
  text: string;
}

export interface FieldChip {
  kind: "field";
  /** Original token text from the line, e.g. `📅 2026-08-30`,
   * `[due:: 2026-08-30]`, `⏫`, `🔁 every week`. */
  text: string;
  field: TaskField;
  /** Only set when `field === "priority"`; the parsed Priority value
   * so the consumer can pick the right `TaskIconField` (e.g. "high" →
   * `"priority-high"`) without re-tokenising. `null` means the line
   * contained a priority token whose value wasn't a recognised word
   * (the kernel records the span but can't classify it). */
  priority?: Priority;
}

export interface TagChip {
  kind: "tag";
  /** The full `#tag` bytes including the leading `#`. */
  text: string;
}

export interface SpacerChip {
  kind: "spacer";
  /** The original line bytes (empty string for a blank line). Used
   * when the input wasn't a recognised task checkbox prefix. */
  text: string;
}

/** Turn a raw task line into an inert chip sequence for preview
 * surfaces. See module header for the inert contract.
 *
 * @param raw  One line of markdown (no trailing newline). If the line
 *             isn't a recognised task checkbox, the result is a single
 *             `spacer` chip carrying the raw bytes.
 * @param cfg  Task-line configuration (statuses table + write format).
 *             The kernel-side preview path is the same as the table /
 *             board view path, so the cfg should already be available
 *             at the call site.
 */
export function previewTaskLine(raw: string, cfg: TaskLineCfg): Chip[];

/** Same as above, but the caller has already paid the parse cost (for
 * example, the renderer also wants `parsed.text` for a tooltip title).
 * `raw` is reused here only to slice field/tag text out of the original
 * bytes — `parsed` is the source of truth for `symbol`, `statusType`,
 * and field spans. */
export function previewTaskLine(parsed: ParsedLine, raw: string, cfg: TaskLineCfg): Chip[];

export function previewTaskLine(
  input: string | ParsedLine,
  rawOrCfg: string | TaskLineCfg,
  _maybeCfg?: TaskLineCfg,
): Chip[] {
  let raw: string;
  let parsed: ParsedLine | null;
  if (typeof input === "string") {
    raw = input;
    parsed = parseTaskLine(input, rawOrCfg as TaskLineCfg);
  } else {
    raw = rawOrCfg as string;
    parsed = input;
  }

  if (parsed === null) {
    return [{ kind: "spacer", text: raw }];
  }

  // Tag spans live in the content after the checkbox prefix. The parser
  // already stripped them from `parsed.text`, but the preview needs the
  // original byte ranges inside `raw` to emit tag chips with their
  // original `#tag` text. Re-derive here from the parser's contentBase.
  const contentBase = parsed.spans.checkbox.end;
  const content = raw.slice(contentBase);
  const tagSpansContent: Range[] = tagSpansOf(content);

  // Build field chips from parsed.spans.fields. Priority chips carry
  // the parsed Priority value so the consumer can pick the right icon
  // (priority-high / priority-lowest / ...) without re-tokenising.
  const fieldChips: FieldChip[] = parsed.spans.fields.map((f) => ({
    kind: "field",
    text: raw.slice(f.start, f.end),
    field: f.field,
    ...(f.field === "priority"
      ? { priority: priorityFromFieldText(raw.slice(f.start, f.end)) }
      : {}),
  }));

  // Tag chips from the re-derived tag spans. Tags whose range falls
  // entirely inside a field range are ignored (they were part of the
  // field token, not a real tag).
  const fieldRanges = parsed.spans.fields;
  const tagChips: TagChip[] = [];
  for (const t of tagSpansContent) {
    const start = contentBase + t.start;
    const end = contentBase + t.end;
    if (fieldRanges.some((r) => start >= r.start && end <= r.end)) continue;
    tagChips.push({ kind: "tag", text: raw.slice(start, end) });
  }

  // Compose the chip list: status first, then the body text, then
  // fields and tags in their line order. The status chip carries the
  // bracketed symbol ("[x]", "[/]", "[X]") — the raw checkbox bytes —
  // not the whole prefix span: the markdown list marker "- " and the
  // trailing separator belong to layout, not to the status control.
  // `recognizeCheckboxPrefix` guarantees exactly `[<sym>]` (one UTF-16
  // unit between the brackets) inside the span, and the original byte
  // is preserved (uppercase "X" stays "X" even though `parsed.symbol`
  // normalizes it).
  const bracketStart = raw.indexOf("[", parsed.spans.checkbox.start);
  const statusChip: StatusChip = {
    kind: "status",
    text: bracketStart >= 0 ? raw.slice(bracketStart, bracketStart + 3) : raw.slice(parsed.spans.checkbox.start, parsed.spans.checkbox.end),
    statusType: parsed.statusType,
  };
  const textChip: TextChip = { kind: "text", text: parsed.text };

  return [statusChip, textChip, ...fieldChips, ...tagChips];
}

/** Recover the Priority value from the original emoji/dataview token.
 * The kernel's scanner records the parsed Priority in its state, but
 * doesn't surface it through `FieldSpan`. Re-derive locally so the
 * consumer doesn't have to. Returns `null` for unrecognised values
 * (e.g. `[priority:: none]` collapses to "no priority"). */
function priorityFromFieldText(text: string): Priority {
  // Dataview form: [priority:: <word>]. Strip the wrapper and look up
  // the inner word. Tried before the emoji branch because the dataview
  // form is a superset (any text in brackets would not match an emoji).
  const m = /^\[\s*priority\s*::\s*([^\]]+?)\s*\]$/i.exec(text);
  if (m) {
    const word = (m[1] ?? "").toLowerCase();
    const WORDS: Record<string, Priority> = {
      highest: "highest",
      high: "high",
      medium: "medium",
      low: "low",
      lowest: "lowest",
    };
    if (word === "none") return null;
    if (WORDS[word] !== undefined) return WORDS[word];
    return null;
  }
  // Emoji form: a single priority emoji (possibly + variation
  // selector). The variation selector is the U+FE0F that some editors
  // insert after the emoji; strip it before lookup.
  const stripped = text.replace(/️/g, "");
  const EMOJI: Record<string, Priority> = {
    "🔺": "highest",
    "⏫": "high",
    "🔼": "medium",
    "🔽": "low",
    "⏬": "lowest",
  };
  if (EMOJI[stripped] !== undefined) return EMOJI[stripped];
  return null;
}

// --- Markdown preview preprocessor (card / chat surfaces) -----------
//
// `previewTaskLine` above serves surfaces that render chips themselves
// (Task 8 widgets, Task 9 popovers). Card and chat previews instead
// render whole markdown documents through marked, so they need a
// string-in/string-out transform: `preprocessTaskMarkdown` rewrites the
// recognized tokens to inert `<span>` markup that marked passes
// through and `.ox-task-*` CSS styles. `stripTaskMetadata` is the
// plain-text counterpart used by `previewText` (list / timeline rows)
// where even the values are noise.
//
// Both reuse `parseTaskLine` for recognition — the scanner already
// handles NBSP / VS-16 separators, skips inline code and markdown link
// targets, and orders spans — so this section only maps spans to HTML.

/** Previews have no settings context: builtin status table only. */
const PREVIEW_CFG: TaskLineCfg = {
  writeFormat: "emoji",
  globalFilter: "",
  recurrenceInsert: "above",
  statuses: [],
};

/** Only the four canonical symbols get a box glyph; exotic markers
 * (`[?]`, `[^]`, …) stay verbatim so previews never invent a state
 * the editor wouldn't recognize. */
const CANONICAL_SYMBOLS: Record<string, true> = {
  " ": true,
  x: true,
  "/": true,
  "-": true,
};

function boxClass(statusType: StatusType): string | null {
  switch (statusType) {
    case "TODO":
      return "ox-task-todo";
    case "IN_PROGRESS":
      return "ox-task-in-progress";
    case "DONE":
      return "ox-task-done";
    case "CANCELLED":
      return "ox-task-cancelled";
    default:
      return null; // ON_HOLD / NON_TASK: not producible from builtins
  }
}

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Value shown inside a field chip: the ISO for date fields, the rule
 * for recurrence, nothing for priority (icon-only). Returns null when
 * the token carries no valid value — e.g. `📅 oops` chips as a bare
 * icon rather than a fake date.
 *
 * Raw (unescaped) so DOM-building consumers (CM6 task widgets,
 * `lib/taskCheckboxes.ts`) can feed `textContent` directly; the HTML
 * string path below wraps it with `chipValue`'s escaping. */
export function chipRawValue(field: TaskField, token: string): string | null {
  if (field === "priority") return null;
  if (field === "recurrence") {
    const dv = /^\[\s*repeat\s*::\s*([^\]]+?)\s*\]$/i.exec(token);
    if (dv) return dv[1] ?? "";
    const stripped = token.replace(/^🔁️?[\s\u00A0]+/, "");
    return stripped.length > 0 ? stripped : null;
  }
  const m = /\d{4}-\d{2}-\d{2}/.exec(token);
  return m ? m[0] : null;
}

/** HTML-escaped `chipRawValue` for the string-splicing paths below. */
function chipValue(field: TaskField, token: string): string | null {
  const raw = chipRawValue(field, token);
  return raw === null ? null : escapeHtmlText(raw);
}

function fieldChipHtml(field: TaskField, token: string): string {
  if (field === "priority") {
    const level = priorityFromFieldText(token);
    const icon = level
      ? `<span class="ox-task-ic-priority-${level}" aria-hidden="true"></span>`
      : "";
    return `<span class="ox-task-field ox-task-priority">${icon}</span>`;
  }
  const icon = `<span class="ox-task-ic-${field}" aria-hidden="true"></span>`;
  return `<span class="ox-task-field ox-task-${field}">${icon}${chipValue(field, token) ?? ""}</span>`;
}

interface Splice {
  start: number;
  end: number;
  text: string;
}

/** Apply non-overlapping replacements to `s` (highest offset first so
 * earlier spans keep their positions). */
function spliceAll(s: string, edits: Splice[]): string {
  let out = s;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

/** Byte range of the `[<sym>]` bytes inside the checkbox prefix
 * (`recognizeCheckboxPrefix` guarantees exactly one UTF-16 unit
 * between the brackets), or null when absent. */
function checkboxBracket(line: string, parsed: ParsedLine): Splice | null {
  const bracketStart = line.indexOf("[", parsed.spans.checkbox.start);
  if (bracketStart < 0) return null;
  return { start: bracketStart, end: bracketStart + 3, text: "" };
}

/** One prose line → inert-chip markup. Non-task lines and unknown
 * checkbox markers round-trip verbatim; field tokens on any task line
 * are chipped regardless of the marker's canonicity. */
function chipLine(line: string): string {
  const parsed = parseTaskLine(line, PREVIEW_CFG);
  if (parsed === null) return line;
  const edits: Splice[] = parsed.spans.fields.map((f) => ({
    start: f.start,
    end: f.end,
    text: fieldChipHtml(f.field, line.slice(f.start, f.end)),
  }));
  if (CANONICAL_SYMBOLS[parsed.symbol] !== undefined) {
    const box = boxClass(parsed.statusType);
    const bracket = checkboxBracket(line, parsed);
    if (box !== null && bracket !== null) {
      edits.push({ ...bracket, text: `<span class="ox-task-box ${box}" aria-hidden="true"></span>` });
    }
  }
  return edits.length > 0 ? spliceAll(line, edits) : line;
}

/** One prose line → metadata-free text (checkbox bytes and field
 * tokens removed). Matches the kernel's `parsed.text` notion of the
 * body: metadata, including its values, is not prose. */
function stripLine(line: string): string {
  const parsed = parseTaskLine(line, PREVIEW_CFG);
  if (parsed === null) return line;
  const edits: Splice[] = parsed.spans.fields.map((f) => ({
    start: f.start,
    end: f.end,
    text: "",
  }));
  if (CANONICAL_SYMBOLS[parsed.symbol] !== undefined) {
    const bracket = checkboxBracket(line, parsed);
    if (bracket !== null) edits.push(bracket);
  }
  if (edits.length === 0) return line;
  const stripped = spliceAll(line, edits);
  // Collapse the whitespace runs the removals left behind, preserving
  // the leading indent — markdown list nesting lives there.
  const indent = /^[ \t]*/.exec(stripped)?.[0] ?? "";
  const body = stripped
    .slice(indent.length)
    .replace(/\s{2,}/g, " ")
    .replace(/\s+$/, "");
  return indent + body;
}

/** Split `text` into fenced-code / prose segments. Fence recognition is
 * line-based (opener ` ``` `/`~~~` indented ≤3 spaces); everything
 * between opener and closer — including task syntax — is code and
 * passes through untouched. Segment texts joined with "\n" reproduce
 * the input byte-for-byte. */
export function splitFences(text: string): Array<{ code: boolean; text: string }> {
  const segments: Array<{ code: boolean; text: string }> = [];
  let code = false;
  let buf: string[] = [];
  const flush = () => {
    if (buf.length > 0) segments.push({ code, text: buf.join("\n") });
    buf = [];
  };
  for (const line of text.split("\n")) {
    const fenceMarker = /^[ \t]{0,3}(```|~~~)/.test(line);
    if (code) {
      buf.push(line);
      if (fenceMarker) {
        flush();
        code = false;
      }
    } else if (fenceMarker) {
      flush();
      code = true;
      buf.push(line);
    } else {
      buf.push(line);
    }
  }
  flush();
  return segments;
}

function perProseLine(text: string, fn: (line: string) => string): string {
  return text
    .split("\n")
    .map(fn)
    .join("\n");
}

/** Rewrite recognized task tokens in a markdown document to inert chip
 * markup (before `marked`). See the section header above. */
export function preprocessTaskMarkdown(md: string): string {
  if (!md) return md;
  return splitFences(md)
    .map((seg) => (seg.code ? seg.text : perProseLine(seg.text, chipLine)))
    .join("\n");
}

/** Remove recognized task tokens from a markdown document, leaving the
 * body prose (plain-text rows). See the section header above. */
export function stripTaskMetadata(md: string): string {
  if (!md) return md;
  return splitFences(md)
    .map((seg) => (seg.code ? seg.text : perProseLine(seg.text, stripLine)))
    .join("\n");
}
