/**
 * `pdc-query/1` classification for `.base` files — the TypeScript mirror
 * of `crates/oxi-frontmatter/src/pdc/query.rs` (PDC-QUERY-1.0).
 *
 * Stage 0 gate only: safe general YAML under the same restrictions as a
 * `pdc-document/2` envelope, plus enough portable-Bases structure
 * checking to separate executable-shape queries from unknown-but-
 * preserved ones. Queries are read-only projections; there is no
 * evaluation engine and no authorization semantics here.
 */

import { isMap, mapGet, parseSafeYaml } from "./yamlSafe";

export type QueryClassification =
  | { kind: "valid" }
  | { kind: "valid_unexecuted" }
  | { kind: "invalid"; diagnostic: "invalid_query"; message: string };

/** Top-level keys the portable subset defines; anything else is
 * preserved and displayed but marks the query unexecuted. */
const KNOWN_TOP_LEVEL: Record<string, true> = {
  filters: true,
  formulas: true,
  properties: true,
  summaries: true,
  views: true,
};

/** Keys defined inside a view mapping; anything else marks the whole
 * view an unknown view. */
const KNOWN_VIEW_KEYS: Record<string, true> = {
  type: true,
  name: true,
  limit: true,
  groupBy: true,
  filters: true,
  order: true,
  summaries: true,
};

/** 1 MiB `.base` transport limit (PDC-QUERY-1.0 §3.1). */
const MAX_QUERY_BYTES = 1024 * 1024;

export function classifyQuery(bytes: Uint8Array): QueryClassification {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return invalid("byte-order mark present; queries are UTF-8 without a BOM");
  }
  if (bytes.length > MAX_QUERY_BYTES) {
    return invalid("query exceeds the 1 MiB `.base` limit");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const parsed = parseSafeYaml(text);
  if (!parsed.ok) return invalid(parsed.error.reason);
  const root = parsed.root;

  let unexecuted = false;
  for (const [key, value] of root) {
    if (!KNOWN_TOP_LEVEL[key]) {
      unexecuted = true;
      continue;
    }
    switch (key) {
      case "filters": {
        const problem = checkFilter(value);
        if (problem) return invalid(problem);
        break;
      }
      case "formulas":
      case "summaries": {
        if (!isMap(value)) {
          return invalid(`\`${key}\` must be a mapping of name → expression`);
        }
        for (const [name, expr] of value) {
          if (typeof expr !== "string") {
            return invalid(`\`${key}.${name}\` must be a string expression`);
          }
          const problem = checkExpression(expr);
          if (problem) return invalid(`${key}.${name}: ${problem}`);
        }
        break;
      }
      case "properties": {
        if (!isMap(value)) {
          return invalid("`properties` must be a mapping of property reference → display metadata");
        }
        for (const [property, meta] of value) {
          if (!isMap(meta)) {
            return invalid(`\`properties.${property}\` must be a display-metadata mapping`);
          }
        }
        break;
      }
      case "views": {
        if (!Array.isArray(value)) {
          return invalid("`views` must be a sequence of view mappings");
        }
        for (const [index, view] of value.entries()) {
          const result = checkView(view);
          if (result === true) continue;
          if (result === false) {
            unexecuted = true;
          } else {
            return invalid(`views[${index}]: ${result}`);
          }
        }
        break;
      }
    }
  }
  return unexecuted ? { kind: "valid_unexecuted" } : { kind: "valid" };
}

/** `true` portable view, `false` unknown view (preserve, never execute),
 * string = malformed (invalid_query). */
function checkView(view: unknown): boolean | string {
  if (!isMap(view)) return "view must be a mapping";
  for (const key of view.keys()) {
    if (!KNOWN_VIEW_KEYS[key]) return false; // unknown view key
  }
  const viewType = mapGet(view, "type");
  if (viewType !== "table" && viewType !== "list") return false; // unknown view type
  if (typeof mapGet(view, "name") !== "string") return "view requires a string `name`";
  const order = mapGet(view, "order");
  if (order !== undefined) {
    if (!Array.isArray(order)) {
      return "`order` must be a sequence of property references";
    }
    if (order.some((item) => typeof item !== "string")) {
      return "`order` entries must be property-reference strings, not mappings";
    }
  }
  const summaries = mapGet(view, "summaries");
  if (summaries !== undefined) {
    if (!isMap(summaries)) {
      return "view `summaries` must be a mapping of property reference → summary name";
    }
    for (const summaryName of summaries.values()) {
      if (typeof summaryName !== "string") {
        return "view `summaries` values must be summary-name strings";
      }
    }
  }
  // `limit` is a YAML number: keep the type (PDC 2 §5.3); a quoted
  // "50" string is rejected just like the Rust `Yaml::Str` path.
  const limit = mapGet(view, "limit");
  if (
    limit !== undefined &&
    !(typeof limit === "number" && Number.isInteger(limit) && limit >= 0)
  ) {
    return "`limit` must be a non-negative integer";
  }
  const groupBy = mapGet(view, "groupBy");
  if (groupBy !== undefined && !isMap(groupBy)) {
    return "`groupBy` must be a `{property, direction}` mapping";
  }
  const filters = mapGet(view, "filters");
  if (filters !== undefined) {
    const problem = checkFilter(filters);
    if (problem) return problem;
  }
  return true;
}

/** A filter expression is a string, or a recursive mapping with exactly
 * one of `and` / `or` / `not` holding a heterogeneous sequence. */
function checkFilter(value: unknown): string | null {
  if (typeof value === "string") return checkExpression(value);
  if (isMap(value)) {
    let combinator: string | null = null;
    for (const key of value.keys()) {
      if (key !== "and" && key !== "or" && key !== "not") {
        return `filter mapping key \`${key}\` is not \`and\`/\`or\`/\`not\``;
      }
      if (combinator !== null) {
        return "filter mapping must contain exactly one of `and`/`or`/`not`";
      }
      combinator = key;
    }
    if (combinator === null) {
      return "filter mapping must contain exactly one of `and`/`or`/`not`";
    }
    const items = mapGet(value, combinator);
    if (!Array.isArray(items)) {
      return `\`${combinator}\` must be a sequence of filter expressions`;
    }
    for (const item of items) {
      const problem = checkFilter(item);
      if (problem) return problem;
    }
    return null;
  }
  return "filter expression must be a string or `and`/`or`/`not` mapping";
}

/** Light expression gate, not an engine: equality must be spelled `==`;
 * a lone `=` (not part of `==`, `!=`, `<=`, `>=`) is rejected instead of
 * being compatibly interpreted. */
function checkExpression(expr: string): string | null {
  for (let i = 0; i < expr.length; i++) {
    if (expr[i] !== "=") continue;
    const prev = i === 0 ? "" : expr[i - 1];
    const next = expr[i + 1] ?? "";
    const paired = next === "=" || prev === "=" || prev === "!" || prev === "<" || prev === ">";
    if (!paired) {
      return `expression uses a lone \`=\`; equality must be spelled \`==\`: ${JSON.stringify(expr)}`;
    }
  }
  return null;
}

function invalid(message: string): QueryClassification {
  return { kind: "invalid", diagnostic: "invalid_query", message };
}
