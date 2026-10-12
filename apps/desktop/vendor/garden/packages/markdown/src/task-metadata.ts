/**
 * Text metadata supported on a single Markdown task line.
 *
 * Fields use the Obsidian Tasks Dataview form, for example
 * `- [ ] Review the release [priority:: HIGH] [due:: 2026-09-27]`.
 * The uppercase priority and onCompletion values are a Garden convention;
 * they are not the emoji values used by the default Obsidian Tasks format.
 * Parsing is read-only and keeps every field's source range so editors can
 * render the values without rewriting the author's line.
 */

export const TASK_PRIORITIES = ["HIGHEST", "HIGH", "MEDIUM", "NONE", "LOW", "LOWEST"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_COMPLETION_BEHAVIORS = ["KEEP", "DELETE"] as const;
export type TaskCompletionBehavior = (typeof TASK_COMPLETION_BEHAVIORS)[number];

export const TASK_METADATA_KEYS = [
  "priority",
  "due",
  "start",
  "scheduled",
  "created",
  "completion",
  "cancelled",
  "repeat",
  "id",
  "dependsOn",
  "onCompletion",
] as const;
export type TaskMetadataKey = (typeof TASK_METADATA_KEYS)[number];

export interface TaskMetadataRange {
  /** Inclusive UTF-16 offset, relative to the supplied line. */
  from: number;
  /** Exclusive UTF-16 offset, relative to the supplied line. */
  to: number;
}

export interface TaskMetadataField {
  /** Canonical field name. Field names are parsed case-insensitively. */
  key: TaskMetadataKey;
  /** Field name as it appeared in the source. */
  rawKey: string;
  /** Trimmed value as it appeared in the source, before enum normalization. */
  rawValue: string;
  /** Parsed value, with Garden enum values normalized to uppercase. */
  value: string | null;
  /** Range of the complete `[key:: value]` field. */
  range: TaskMetadataRange;
  /** Range of the trimmed value, useful for source-preserving edits. */
  valueRange: TaskMetadataRange;
  /** False when the field has an empty value or an invalid enum/date value. */
  valid: boolean;
}

export type TaskMetadataIssueCode = "invalid-value" | "duplicate-field";

export interface TaskMetadataIssue {
  code: TaskMetadataIssueCode;
  key: TaskMetadataKey;
  range: TaskMetadataRange;
  message: string;
}

export interface ParsedTaskMetadata {
  fields: TaskMetadataField[];
  issues: TaskMetadataIssue[];
}

const DATE_KEYS = new Set<TaskMetadataKey>(["due", "start", "scheduled", "created", "completion", "cancelled"]);
const PRIORITY_VALUES = new Set<string>(TASK_PRIORITIES);
const COMPLETION_BEHAVIORS = new Set<string>(TASK_COMPLETION_BEHAVIORS);

const KEY_BY_LOWERCASE = new Map<string, TaskMetadataKey>(
  TASK_METADATA_KEYS.map((key) => [key.toLowerCase(), key]),
);

function canonicalKey(value: string): TaskMetadataKey | null {
  return KEY_BY_LOWERCASE.get(value.toLowerCase()) ?? null;
}

function isEscaped(line: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function lineContentEnd(line: string): number {
  const newline = line.indexOf("\n");
  if (newline >= 0) return newline > 0 && line[newline - 1] === "\r" ? newline - 1 : newline;
  if (line.endsWith("\r")) return line.length - 1;
  return line.length;
}

function markRange(mask: Uint8Array, from: number, to: number): void {
  for (let index = from; index < to; index += 1) mask[index] = 1;
}

function codeSpanMask(line: string, end: number): Uint8Array {
  const mask = new Uint8Array(line.length);
  let index = 0;
  while (index < end) {
    if (line[index] !== "`" || isEscaped(line, index)) {
      index += 1;
      continue;
    }

    const runStart = index;
    while (index < end && line[index] === "`") index += 1;
    const runLength = index - runStart;
    let search = index;
    let closingStart = -1;
    let closingEnd = -1;
    while (search < end) {
      const tick = line.indexOf("`", search);
      if (tick < 0 || tick >= end) break;
      let runEnd = tick + 1;
      while (runEnd < end && line[runEnd] === "`") runEnd += 1;
      if (runEnd - tick === runLength) {
        closingStart = tick;
        closingEnd = runEnd;
        break;
      }
      search = runEnd;
    }

    if (closingStart >= 0) {
      markRange(mask, runStart, closingEnd);
      index = closingEnd;
    }
  }
  return mask;
}

function findClosingParenthesis(line: string, open: number, end: number, codeMask: Uint8Array): number | null {
  let depth = 0;
  for (let index = open; index < end; index += 1) {
    if (codeMask[index] || isEscaped(line, index)) continue;
    if (line[index] === "(") depth += 1;
    else if (line[index] === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return null;
}

function linkLabelMask(line: string, end: number, codeMask: Uint8Array): Uint8Array {
  const mask = new Uint8Array(line.length);
  const bracketPairs = new Map<number, number>();
  const openingBrackets: number[] = [];

  for (let index = 0; index < end; index += 1) {
    if (codeMask[index] || isEscaped(line, index)) continue;
    if (line[index] === "[") openingBrackets.push(index);
    else if (line[index] === "]" && openingBrackets.length > 0) {
      bracketPairs.set(openingBrackets.pop()!, index);
    }
  }

  for (const [open, close] of bracketPairs) {
    const next = line[close + 1];
    if (next === "(") {
      const destinationEnd = findClosingParenthesis(line, close + 1, end, codeMask);
      if (destinationEnd !== null) markRange(mask, open, destinationEnd + 1);
    } else if (next === "[") {
      const referenceEnd = bracketPairs.get(close + 1);
      if (referenceEnd !== undefined) markRange(mask, open, referenceEnd + 1);
    } else if (line[open + 1] === "[" && line[close - 1] === "]") {
      // Obsidian wikilinks are links too; don't interpret their label as metadata.
      markRange(mask, open, close + 1);
    }
  }
  return mask;
}

function isRealCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1]!;
}

function normalizeFieldValue(key: TaskMetadataKey, rawValue: string): string | null {
  if (rawValue.length === 0 || rawValue.includes("[") || rawValue.includes("]")) return null;
  if (key === "priority") {
    const normalized = rawValue.toUpperCase();
    return PRIORITY_VALUES.has(normalized) ? normalized : null;
  }
  if (key === "onCompletion") {
    const normalized = rawValue.toUpperCase();
    return COMPLETION_BEHAVIORS.has(normalized) ? normalized : null;
  }
  if (DATE_KEYS.has(key)) return isRealCalendarDate(rawValue) ? rawValue : null;
  return rawValue;
}

/**
 * Parse the supported `[key:: value]` properties from one task line.
 * Unknown properties, Markdown links/images, escaped brackets, and inline
 * code remain ordinary source text and are left untouched.
 */
export function parseTaskMetadata(line: string): ParsedTaskMetadata {
  const contentEnd = lineContentEnd(line);
  // A caller should provide one line. For defensive parsing, ignore text after
  // the first newline while keeping all ranges relative to the original input.
  const codeMask = codeSpanMask(line, contentEnd);
  const linkMask = linkLabelMask(line, contentEnd, codeMask);
  const fields: TaskMetadataField[] = [];
  const issues: TaskMetadataIssue[] = [];

  let index = 0;
  while (index < contentEnd) {
    if (line[index] !== "[" || codeMask[index] || linkMask[index] || isEscaped(line, index)) {
      index += 1;
      continue;
    }

    let close = index + 1;
    while (close < contentEnd && (line[close] !== "]" || isEscaped(line, close))) close += 1;
    if (close >= contentEnd) {
      index += 1;
      continue;
    }
    const delimiter = line.indexOf("::", index + 1);
    if (delimiter < 0 || delimiter >= close) {
      index = close + 1;
      continue;
    }

    const rawKey = line.slice(index + 1, delimiter).trim();
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(rawKey)) {
      index = close + 1;
      continue;
    }
    const key = canonicalKey(rawKey);
    if (!key) {
      index = close + 1;
      continue;
    }

    let valueFrom = delimiter + 2;
    let valueTo = close;
    while (valueFrom < valueTo && /\s/.test(line[valueFrom]!)) valueFrom += 1;
    while (valueTo > valueFrom && /\s/.test(line[valueTo - 1]!)) valueTo -= 1;
    const rawValue = line.slice(valueFrom, valueTo);
    const value = normalizeFieldValue(key, rawValue);
    const range = { from: index, to: close + 1 };
    const field: TaskMetadataField = {
      key,
      rawKey,
      rawValue,
      value,
      range,
      valueRange: { from: valueFrom, to: valueTo },
      valid: value !== null,
    };
    fields.push(field);
    if (!field.valid) {
      issues.push({
        code: "invalid-value",
        key,
        range,
        message: `Invalid value for task metadata field "${key}".`,
      });
    }
    index = close + 1;
  }

  const seen = new Set<TaskMetadataKey>();
  for (const field of fields) {
    if (seen.has(field.key)) {
      issues.push({
        code: "duplicate-field",
        key: field.key,
        range: field.range,
        message: `Task metadata field "${field.key}" occurs more than once.`,
      });
    }
    seen.add(field.key);
  }

  return { fields, issues };
}

function isValidPatchValue(key: TaskMetadataKey, value: string): boolean {
  if (!value || /[\r\n]/.test(value) || value.includes("[") || value.includes("]")) return false;
  return normalizeFieldValue(key, value) !== null;
}

function isHorizontalWhitespace(value: string | undefined): boolean {
  return value === " " || value === "\t";
}

/**
 * Set or remove one task property while preserving unrelated source text.
 *
 * `null` means the line is ambiguous (duplicate field), the key/value is not
 * supported, or the supplied value is invalid; in those cases no edit is made.
 * Removing a field consumes one adjacent horizontal separator when present,
 * avoiding a doubled gap while retaining all other spacing and line endings.
 */
export function patchTaskMetadata(line: string, key: TaskMetadataKey, value: string | null): string | null {
  if (!TASK_METADATA_KEYS.includes(key)) return null;
  if (value !== null && !isValidPatchValue(key, value)) return null;
  const firstNewline = line.indexOf("\n");
  if (firstNewline >= 0 && firstNewline < line.length - 1) return null;
  const contentEnd = lineContentEnd(line);

  const matchingFields = parseTaskMetadata(line).fields.filter((field) => field.key === key);
  if (matchingFields.length > 1) return null;
  const existing = matchingFields[0];

  if (existing) {
    if (value === null) {
      let from = existing.range.from;
      let to = existing.range.to;
      let hasSeparator = false;
      if (from > 0 && isHorizontalWhitespace(line[from - 1])) {
        from -= 1;
        hasSeparator = true;
      }
      if (to < contentEnd && isHorizontalWhitespace(line[to])) {
        to += 1;
        hasSeparator = true;
      }
      const hasTextOnBothSides = from > 0 && to < contentEnd;
      const separator = hasSeparator && hasTextOnBothSides ? " " : "";
      return line.slice(0, from) + separator + line.slice(to);
    }
    const normalizedValue = normalizeFieldValue(key, value)!;
    if (existing.value === normalizedValue) return line;
    return line.slice(0, existing.valueRange.from) + normalizedValue + line.slice(existing.valueRange.to);
  }

  if (value === null) return line;
  let insertionAt = contentEnd;
  while (insertionAt > 0 && isHorizontalWhitespace(line[insertionAt - 1])) insertionAt -= 1;
  const prefix = line.slice(0, insertionAt);
  const needsSeparator = prefix.length > 0 && !isHorizontalWhitespace(prefix[prefix.length - 1]);
  const normalizedValue = normalizeFieldValue(key, value)!;
  const appended = `${needsSeparator ? " " : ""}[${key}:: ${normalizedValue}]`;
  return prefix + appended + line.slice(insertionAt);
}
