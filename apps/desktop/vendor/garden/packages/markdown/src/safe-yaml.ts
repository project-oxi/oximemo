import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseAllDocuments,
  stringify,
  type Document,
  type Node,
  type Pair,
} from "yaml";
import type { JsonObject, JsonValue, MarkdownDiagnosticCode } from "./types.js";
import { MarkdownContractError } from "./types.js";

export interface ParsedYamlObject {
  value: JsonObject;
  document: Document<Node, true>;
}

function fail(code: MarkdownDiagnosticCode, message: string): never {
  throw new MarkdownContractError({ code, message });
}

function hasIndentationTab(source: string): boolean {
  return source.split(/\r?\n/).some((line) => /^[ ]*\t/.test(line));
}

function nodeRange(node: unknown): [number, number] | null {
  const range = (node as { range?: number[] } | null)?.range;
  return range && range.length >= 2 ? [range[0], range[1]] : null;
}

function safeNodeValue(node: unknown, depth: number, count: { value: number }): JsonValue {
  count.value += 1;
  if (count.value > 10_000 || depth > 32) {
    fail("document_too_complex", "YAML exceeds the PDC node or nesting limit.");
  }
  if (!node || typeof node !== "object") {
    fail("invalid_envelope", "YAML contains a value outside the JSON-compatible subset.");
  }
  if (isAlias(node)) {
    fail("invalid_envelope", "YAML aliases are not permitted.");
  }
  const candidate = node as { anchor?: string; tag?: string };
  if (candidate.anchor || candidate.tag) {
    fail("invalid_envelope", "YAML anchors and explicit tags are not permitted.");
  }
  if (isScalar(node)) {
    const value = node.value;
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "bigint") {
      const number = Number(value);
      if (Number.isSafeInteger(number) && BigInt(number) === value) return number;
      fail("invalid_envelope", "YAML integers outside the exact JavaScript safe-integer range cannot be represented without changing their value.");
    }
    fail("invalid_envelope", "YAML scalar is not a finite JSON-compatible value.");
  }
  if (isSeq(node)) return node.items.map((item) => safeNodeValue(item, depth + 1, count));
  if (isMap(node)) {
    const out: JsonObject = {};
    for (const pair of node.items as Pair<Node, Node>[]) {
      const keyNode = pair.key as Node & { anchor?: string; tag?: string };
      if (isAlias(pair.key) || keyNode.anchor || keyNode.tag) {
        fail("invalid_envelope", "YAML mapping keys cannot use aliases, anchors, or explicit tags.");
      }
      if (!isScalar(pair.key) || typeof pair.key.value !== "string" || pair.key.value.length === 0) {
        fail("invalid_envelope", "YAML mapping keys must be nonempty strings.");
      }
      const key = pair.key.value;
      if (Object.prototype.hasOwnProperty.call(out, key)) {
        fail("invalid_envelope", `YAML contains duplicate key ${JSON.stringify(key)}.`);
      }
      Object.defineProperty(out, key, {
        value: safeNodeValue(pair.value, depth + 1, count),
        enumerable: true,
        configurable: true,
        writable: true,
      });
      count.value += 1;
    }
    return out;
  }
  fail("invalid_envelope", "YAML contains a complex key or unsupported node.");
}

export function parseSafeYamlObject(
  source: string,
  code: MarkdownDiagnosticCode = "invalid_envelope",
): ParsedYamlObject {
  if (hasIndentationTab(source)) fail(code, "Tabs are not allowed in YAML indentation.");
  const documents = parseAllDocuments(source, {
    version: "1.2",
    schema: "core",
    strict: true,
    uniqueKeys: true,
    intAsBigInt: true,
    prettyErrors: false,
  });
  if (documents.length !== 1) fail(code, "YAML must contain exactly one document.");
  const document = documents[0];
  if (document.errors.length > 0) {
    const error = document.errors[0];
    const pos = error.pos?.[0];
    const before = pos === undefined ? "" : source.slice(0, pos);
    const line = pos === undefined ? undefined : before.split("\n").length;
    const column = pos === undefined ? undefined : (before.split("\n").at(-1)?.length ?? 0) + 1;
    throw new MarkdownContractError({
      code,
      message: error.message,
      ...(line ? { line, column } : {}),
    });
  }
  if (!isMap(document.contents)) fail(code, "YAML root must be a mapping.");
  const value = safeNodeValue(document.contents, 1, { value: 0 });
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code, "YAML root must be a mapping.");
  return { value: value as JsonObject, document };
}

export function stringifyYamlScalar(value: JsonValue): string {
  return stringify(value, { lineWidth: 0 }).trimEnd();
}

export function getYamlTopLevelPairs(parsed: ParsedYamlObject): Pair<Node, Node>[] {
  if (!isMap(parsed.document.contents)) return [];
  return parsed.document.contents.items as Pair<Node, Node>[];
}

export function getNodeRange(node: unknown): [number, number] | null {
  return nodeRange(node);
}
