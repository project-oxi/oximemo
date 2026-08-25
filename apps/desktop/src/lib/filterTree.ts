/** Filter builder tree model (query views spec §5): the builder edits the
 *  parsed expression tree; serialization prints it back to the YAML
 *  filters union. A condition that doesn't fit `<identifier> <op>
 *  <literal>` is preserved as an advanced (raw text) row. */

export type CondOp =
  | "==" | "!=" | ">" | ">=" | "<" | "<=" | "contains" | "startsWith" | "endsWith";

export type CondValue = string | number | boolean | null;

export type FilterNode =
  | { kind: "cond"; ident: string; op: CondOp; value: CondValue }
  | { kind: "expr"; text: string }
  | { kind: "and"; children: FilterNode[] }
  | { kind: "or"; children: FilterNode[] }
  | { kind: "not"; child: FilterNode };

const COND_RE = /^([\w.]+)\s*(==|!=|>=|<=|>|<)\s*(.+)$/;
const FN_RE = /^(contains|startsWith|endsWith)\(\s*([\w.]+)\s*,\s*(.+)\)$/;
const EMPTY_RE = /^isEmpty\(\s*([\w.]+)\s*\)$/;

/** `'status != "done"'`-style string → cond; function forms → cond;
 * anything else → an advanced expr row (never a silent parse failure). */
export function parseCondString(text: string): FilterNode {
  const t = text.trim();
  let m = COND_RE.exec(t);
  if (m) return { kind: "cond", ident: m[1], op: m[2] as CondOp, value: parseLiteral(m[3]) };
  m = FN_RE.exec(t);
  if (m) return { kind: "cond", ident: m[2], op: m[1] as CondOp, value: parseLiteral(m[3]) };
  m = EMPTY_RE.exec(t);
  if (m) return { kind: "cond", ident: m[1], op: "==", value: null };
  return { kind: "expr", text: t };
}

function parseLiteral(raw: string): CondValue {
  const t = raw.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null" || t === "") return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
    return t.slice(1, -1);
  return t;
}

/** The YAML filters union (spec §1): a string or a nested and/or/not map. */
export function parseFilters(raw: unknown): FilterNode | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") return parseCondString(raw);
  if (typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj.and))
    return { kind: "and", children: obj.and.map(parseFilters).filter((n): n is FilterNode => n !== null) };
  if (Array.isArray(obj.or))
    return { kind: "or", children: obj.or.map(parseFilters).filter((n): n is FilterNode => n !== null) };
  if ("not" in obj) {
    const child = parseFilters(obj.not);
    if (child) return { kind: "not", child };
  }
  return null;
}

function literalSource(v: CondValue): string {
  if (v === null) return "null";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return String(v);
  const escaped = v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/** Cond → expression string; null value emits `isEmpty(ident)` (there is
 *  no null literal in the engine — absence is the check). */
export function condString(ident: string, op: CondOp, value: CondValue): string {
  if (value === null && (op === "==" || op === "!=")) return op === "==" ? `isEmpty(${ident})` : `!isEmpty(${ident})`;
  if (op === "contains" || op === "startsWith" || op === "endsWith")
    return `${op}(${ident}, ${literalSource(value)})`;
  return `${ident} ${op} ${literalSource(value)}`;
}

/** Serialize back to the YAML union value. Strings carry single quotes at
 *  the YAML layer (the `yaml` package handles quoting). */
export function serializeFilters(node: FilterNode): unknown {
  switch (node.kind) {
    case "expr":
      return node.text;
    case "cond":
      return condString(node.ident, node.op, node.value);
    case "not":
      return { not: serializeFilters(node.child) };
    case "and":
    case "or":
      return { [node.kind]: node.children.map(serializeFilters) };
  }
}

/** Operators offered for an observed-type set (spec §3): numeric/date
 *  types get ordering, everything else equality+text; a conflicting type
 *  set degrades to equality/contains only. */
export function opsForTypes(types: string[] | undefined): CondOp[] {
  if (!types || types.length === 0)
    return ["==", "!=", "contains", "startsWith", "endsWith"];
  if (types.length > 1) return ["==", "!=", "contains"];
  const t = types[0];
  if (t === "Num" || t === "number") return ["==", "!=", ">", ">=", "<", "<="];
  if (t === "Date" || t === "Bool" || t === "boolean") return ["==", "!="];
  return ["==", "!=", "contains", "startsWith", "endsWith"];
}

/** `file.*` identifiers the property dropdown offers beyond base_props. */
export const CORE_IDENTS: { ident: string; type: string }[] = [
  { ident: "file.name", type: "Str" },
  { ident: "file.folder", type: "Str" },
  { ident: "file.path", type: "Str" },
  { ident: "file.format", type: "Str" },
  { ident: "file.tags", type: "List" },
  { ident: "file.favorite", type: "Bool" },
  { ident: "file.created", type: "Date" },
  { ident: "file.updated", type: "Date" },
];
