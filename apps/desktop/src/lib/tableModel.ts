/** Pure table model for TableView (query views spec §4). Rendering-agnostic:
 * column shape, editability, group/summary math, focus-frozen row order, and
 * NoteDto reconciliation. Plan C feeds BaseRow-derived rows through the same
 * functions. No React here — everything is unit-testable. */
import type { BaseValue, FolderSchema, Memo, MemoSummary, PropValue, SchemaPropertyDef } from "./types";

export type SummaryFn =
  | "all" | "checked" | "unchecked" | "empty" | "filled" | "unique"
  | "average" | "sum" | "min" | "max" | "median";

export type TableColumn =
  | { kind: "name" }      // file.name — frozen first column, read-only, opens note
  | { kind: "tags" }      // derived tags — read-only chips
  | { kind: "updated" }   // file.updated — read-only date
  | { kind: "prop"; key: string } // note.<key> — typed editor
  // formula.<key> — engine-computed, read-only (query views only)
  | { kind: "formula"; key: string };

/** Columns for a set of folders: frozen name, the union of schema prop keys
 * (each folder's schema order, first occurrence wins), then updated. All
 * folders schema-less → the spec §4 default trio [name, tags, updated]. */
export function buildColumns(
  schemas: Record<string, FolderSchema | null>,
  folderOrder: string[],
): TableColumn[] {
  const keys: string[] = [];
  for (const f of folderOrder) {
    for (const k of Object.keys(schemas[f]?.properties ?? {})) {
      if (!keys.includes(k)) keys.push(k);
    }
  }
  const cols: TableColumn[] = [{ kind: "name" }, ...keys.map((key): TableColumn => ({ kind: "prop", key }))];
  if (keys.length === 0) cols.push({ kind: "tags" });
  cols.push({ kind: "updated" });
  return cols;
}

/** Spec §4 editable matrix: note props typed-editable; file.name, tags,
 * created/updated, path/folder/format are derived data — read-only. */
export function columnEditable(col: TableColumn): boolean {
  return col.kind === "prop";
}

/** Editor type for a schema-less key, inferred from the stored envelope.
 * (Moved verbatim from PropertyPanel.tsx so panel and table agree.) */
export function inferredType(v: PropValue | undefined): "text" | "multiselect" | "date" | "bool" {
  if (!v) return "text";
  if ("Bool" in v) return "bool";
  if ("List" in v) return "multiselect";
  if ("Str" in v && /^\d{4}-\d{2}-\d{2}$/.test(v.Str)) return "date";
  return "text";
}

const num = (s: string): number | null => {
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

function membersOf(v: PropValue): string[] {
  if ("List" in v) return v.List;
  if ("Str" in v) return [v.Str];
  if ("Bool" in v) return [String(v.Bool)];
  return [];
}

/** Spec §1 summary functions over a column's PropValue values (undefined =
 * absent cell). Returns a display string; null hides the footer cell.
 * checked/unchecked are checkbox-column semantics: they count explicit
 * Bool values only, so non-boolean cells are neither. */
export function summarize(vals: PropValue[], fn: SummaryFn): string | null {
  const members = vals.flatMap((v) => (!v ? [] : membersOf(v)));
  switch (fn) {
    case "all": return String(vals.length);
    case "checked": return String(vals.filter((v) => v && "Bool" in v && v.Bool).length);
    case "unchecked": return String(vals.filter((v) => v && "Bool" in v && !v.Bool).length);
    case "empty": return String(vals.filter((v) => !v || membersOf(v).length === 0).length);
    case "filled": return String(vals.filter((v) => v && membersOf(v).length > 0).length);
    case "unique": return String(new Set(members).size);
  }
  const nums = members.map(num).filter((n): n is number => n !== null);
  if (!nums.length) return null;
  switch (fn) {
    case "sum": return fmt(nums.reduce((a, b) => a + b, 0));
    case "average": return fmt(nums.reduce((a, b) => a + b, 0) / nums.length);
    case "min": return fmt(Math.min(...nums));
    case "max": return fmt(Math.max(...nums));
    case "median": {
      const s = [...nums].sort((a, b) => a - b);
      const mid = s.length >> 1;
      return fmt(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
    }
  }
}

/** Footer default per column type (spec §4 sticky summary footer; Plan C
 * replaces defaults with the view def's declared summaries). */
export function defaultSummaryFn(def: SchemaPropertyDef | undefined): SummaryFn {
  const t = def?.prop_type;
  if (t === "bool") return "checked";
  if (t === "select" || t === "multiselect") return "unique";
  return "filled";
}

/** Group key of a row for a prop: first member of a List, scalar string of
 * Str/Bool, "" (그룹 없음) when absent. */
export function groupKeyOf(row: MemoSummary, key: string): string {
  const v = row.props?.[key];
  if (!v) return "";
  return membersOf(v)[0] ?? "";
}

/** Group rows by a prop key; groups keep first-appearance order except the
 * "" (그룹 없음) bucket, which sorts last. key === null → single flat group. */
export function groupRows(rows: MemoSummary[], key: string | null): { key: string; rows: MemoSummary[] }[] {
  if (key === null) return [{ key: "", rows }];
  const map = new Map<string, MemoSummary[]>();
  for (const r of rows) {
    const g = groupKeyOf(r, key);
    const bucket = map.get(g);
    if (bucket) bucket.push(r);
    else map.set(g, [r]);
  }
  const out = [...map.entries()].map(([k, rs]) => ({ key: k, rows: rs }));
  out.sort((a, b) => (a.key === "" ? 1 : b.key === "" ? -1 : 0));
  return out;
}

/** Spec §4 focus freeze: while a cell editor is focused the displayed row id
 * order is frozen. Re-render with fresh data keeps the frozen ids first (in
 * snapshot order), drops ids that vanished, appends rows that appeared. */
export function applyFrozenOrder<T extends { id: string }>(fresh: T[], frozenIds: string[] | null): T[] {
  if (!frozenIds) return fresh;
  const byId = new Map(fresh.map((r) => [r.id, r]));
  const head = frozenIds.map((id) => byId.get(id)).filter((r): r is T => r !== undefined);
  const seen = new Set(frozenIds);
  return [...head, ...fresh.filter((r) => !seen.has(r.id))];
}

/** Reconcile a table row from the post-transition NoteDto `update_memo`
 * returns (spec §4): transitions/status stamps appear immediately. */
export function reconcileRow(row: MemoSummary, dto: Memo): MemoSummary {
  return {
    ...row,
    updated_at: dto.updated_at,
    hash: dto.hash,
    favorite: dto.favorite,
    folder: dto.folder,
    path: dto.path,
    title: dto.title,
    tags: dto.tags,
    props: dto.props,
  };
}

/** Read-only display for an engine cell value (formula columns, spec §4).
 *  `Null`/null render as an em dash; Dates as the local calendar date;
 *  Lists join members with ", "; Num rounds float noise away. */
export function formatBaseValue(v: BaseValue | null): string {
  if (v === null || v === "Null") return "—";
  if ("Bool" in v) return String(v.Bool);
  if ("Num" in v) return fmt(v.Num);
  if ("Str" in v) return v.Str;
  if ("List" in v) return v.List.map(formatBaseValue).join(", ");
  if ("Date" in v) return v.Date.slice(0, 10);
  if ("Duration" in v) {
    const d = v.Duration;
    const parts: string[] = [];
    if (d.calendar_months) parts.push(`${d.calendar_months}mo`);
    if (d.fixed_millis) parts.push(`${d.fixed_millis}ms`);
    return parts.join("+") || "0ms";
  }
  return "—";
}
