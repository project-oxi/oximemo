/**
 * Safe general-YAML 1.2 Core parsing for `pdc-document/2` envelopes and
 * `pdc-query/1` sources — the TypeScript mirror of
 * `crates/oxi-frontmatter/src/pdc/yaml.rs` (PDC 2 §5).
 *
 * Accepts exactly one YAML document whose root is a mapping with
 * nonempty unique string keys and JSON-compatible values. Anchors,
 * aliases, tags, complex/numeric keys, multi-document streams, and
 * non-finite values are rejected; nesting is capped at 32 combined
 * levels and the document at 10 000 nodes (`too_complex`). Finite
 * numbers are kept as their source spelling so classification parity
 * with the Rust walker is exact.
 */

import {
  Alias,
  parseAllDocuments,
  Scalar,
  YAMLMap,
  YAMLSeq,
  type Document,
  type Node,
} from "yaml";

export const MAX_YAML_DEPTH = 32;
export const MAX_YAML_NODES = 10_000;

export type YamlErrorKind = "malformed" | "too_complex";

export interface YamlError {
  kind: YamlErrorKind;
  line: number | null;
  reason: string;
}

/** Maps are `Map<string, unknown>`; seqs `unknown[]`; scalars
 * `null | boolean | string` (finite numbers stringified). */
export type YamlMap = Map<string, unknown>;

export type SafeParse = { ok: true; root: YamlMap } | { ok: false; error: YamlError };

// Many call sites construct this exact error shape (lockstep with the
// Rust `YamlError`), so the named constructor is a durable contract.
function malformed(reason: string, line: number | null = null): YamlError {
  return { kind: "malformed", line, reason };
}

function tooComplex(reason: string): YamlError {
  return { kind: "too_complex", line: null, reason };
}

export function parseSafeYaml(text: string): SafeParse {
  let docs: Document[];
  try {
    docs = parseAllDocuments(text, { schema: "core" });
  } catch (error) {
    return { ok: false, error: malformed(`invalid YAML: ${String(error)}`) };
  }
  for (const doc of docs) {
    const problem = doc.errors[0];
    if (problem) return { ok: false, error: malformed(`invalid YAML: ${problem.message}`) };
  }
  if (docs.length !== 1) {
    return {
      ok: false,
      error: malformed(
        "multi-document streams are forbidden; exactly one YAML document is allowed",
      ),
    };
  }
  const doc = docs[0];
  if (doc.contents == null) return { ok: false, error: malformed("document is empty") };

  let nodes = 0;
  const walk = (node: Node, depth: number): unknown => {
    if (node instanceof Alias) {
      throw malformed("aliases are forbidden; every value must be written out");
    }
    const props = node as { anchor?: string; tag?: string };
    if (props.anchor) {
      throw malformed("anchors are forbidden; every value must be written out");
    }
    if (props.tag) {
      throw malformed("explicit or custom tags are forbidden in safe general YAML");
    }
    if (node instanceof Scalar) {
      nodes += 1;
      if (nodes > MAX_YAML_NODES) throw tooComplex(`document exceeds the ${MAX_YAML_NODES}-node limit`);
      const value = (node as Scalar).value;
      if (typeof value === "boolean") return value;
      if (typeof value === "number") {
        if (!Number.isFinite(value)) {
          throw malformed("`.nan`/`.inf` resolve to non-finite values, which are forbidden");
        }
        // PDC 2 §5.3: user-property values keep their type — finite
        // numbers stay numbers (mirrors `Yaml::Number`).
        return value;
      }
      if (typeof value === "string") return value;
      if (value === null || value === undefined) return null;
      throw malformed("scalar resolves to a forbidden type");
    }
    if (node instanceof YAMLSeq || node instanceof YAMLMap) {
      nodes += 1;
      if (nodes > MAX_YAML_NODES) throw tooComplex(`document exceeds the ${MAX_YAML_NODES}-node limit`);
      depth += 1;
      if (depth > MAX_YAML_DEPTH) throw tooComplex(`nesting exceeds the ${MAX_YAML_DEPTH}-level limit`);
      if (node instanceof YAMLSeq) {
        return node.items.map((item) => walk(item as Node, depth));
      }
      const map: YamlMap = new Map();
      const seen = new Set<string>();
      for (const pair of node.items) {
        if (pair.key instanceof Alias) {
          throw malformed("aliases are forbidden; every value must be written out");
        }
        const keyNode = pair.key as Scalar;
        const key = keyNode.value;
        if (typeof key !== "string" || key === "") {
          throw malformed("mapping keys must be nonempty strings");
        }
        if (seen.has(key)) throw malformed(`duplicate key \`${key}\``);
        seen.add(key);
        map.set(key, pair.value == null ? null : walk(pair.value as Node, depth));
      }
      return map;
    }
    throw malformed("unsupported YAML construct");
  };

  try {
    const root = walk(doc.contents, 0);
    if (!(root instanceof Map)) {
      return { ok: false, error: malformed("document root must be a mapping") };
    }
    return { ok: true, root };
  } catch (error) {
    if ((error as YamlError).kind) return { ok: false, error: error as YamlError };
    throw error;
  }
}

/** Mapping lookup on a walked value; `undefined` when absent. Shared
 * accessor for every consumer of the walked tree. */
export function mapGet(value: unknown, key: string): unknown {
  return value instanceof Map ? value.get(key) : undefined;
}

export function isMap(value: unknown): value is YamlMap {
  return value instanceof Map;
}

/** Convert a walked tree into JSON-ish plain values for diagnostics. */
export function toPlain(value: unknown): unknown {
  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of value) out[key] = toPlain(item);
    return out;
  }
  if (Array.isArray(value)) return value.map(toPlain);
  return value;
}
