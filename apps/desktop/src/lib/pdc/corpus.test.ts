import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import corpusJson from "./corpus/corpus.json";
import {
  classify,
  CORPUS_REVISION,
  type Classification,
  type DiagnosticKind,
} from "./classify";
import { patchMetadata } from "./patch";
import { saveGuarded } from "./guard";
import { classifyQuery, type QueryClassification } from "./query";
import corpusV2Json from "./corpus-v2/corpus.json";

interface CorpusCase {
  id: string;
  kind: "file" | "set" | "operation";
  path?: string;
  paths?: string[];
  expect?: string;
  operation?: string;
  input?: string;
  prefixHex?: string;
  totalBytes?: number;
  containerDepth?: number;
  patch?: Record<string, string>;
  expected?: string;
  external?: string;
  depth?: number;
}

const corpus = corpusJson as unknown as { revision: number; format: string; cases: CorpusCase[] };

const CORPUS_DIR = join(import.meta.dir, "corpus");
const CORPUS_V2_DIR = join(import.meta.dir, "corpus-v2");
const corpusV2 = corpusV2Json as unknown as {
  revision: number;
  format: string;
  queryContract: string;
  cases: CorpusCase[];
};

/** v2 extension mapping: lowercase `.md`, `.html`, `.djot`; `.base`
 * files are query-plane cases. */
function extOfV2(path: string): "markdown" | "html" | "djot" {
  if (path.endsWith(".html")) return "html";
  if (path.endsWith(".md")) return "markdown";
  return "djot";
}

/** Build a Markdown transport document whose envelope is a single YAML
 * mapping chain of exactly `depth` combined levels (root included). */
function yamlMappingEnvelope(depth: number): Uint8Array {
  let text = "---\na:\n";
  for (let level = 1; level <= depth - 2; level++) {
    text += " ".repeat(2 * level) + "b:\n";
  }
  text += " ".repeat(2 * (depth - 1)) + "leaf: 1\n---\n\nbody\n";
  return new TextEncoder().encode(text);
}

function assertQueryExpect(id: string, expected: string, got: QueryClassification): void {
  switch (expected) {
    case "valid":
      expect(got.kind).toBe("valid");
      break;
    case "valid_unexecuted":
      expect(got.kind).toBe("valid_unexecuted");
      break;
    case "invalid_query":
      expect(got).toMatchObject({ kind: "invalid", diagnostic: "invalid_query" });
      break;
    default:
      throw new Error(`${id}: unknown query expectation "${expected}"`);
  }
}

function runCaseV2(c: CorpusCase): void {
  if (c.kind === "file") {
    const path = c.path!;
    const bytes = readFixtureV2(path);
    if (path.endsWith(".base")) {
      assertQueryExpect(c.id!, c.expect!, classifyQuery(bytes));
      return;
    }
    const result = classify(extOfV2(path), bytes);
    switch (c.expect) {
      case "valid":
        expect(result).toMatchObject({ kind: "valid", legacy: false });
        break;
      case "legacy_valid":
        expect(result).toMatchObject({ kind: "valid", legacy: true });
        break;
      case "legacy_html":
        expect(result).toEqual({ kind: "legacy_html" });
        break;
      case "legacy_markdown":
        expect(result).toEqual({ kind: "legacy_markdown" });
        break;
      default:
        expectDiagnostic(result, c.expect! as DiagnosticKind);
    }
    return;
  }
  if (c.kind === "set") {
    const ids: string[] = [];
    for (const path of c.paths!) {
      const result = classify(extOfV2(path), readFixtureV2(path));
      if (result.kind === "valid") ids.push(result.id);
    }
    expect(new Set(ids).size).toBeLessThan(ids.length);
    return;
  }
  const ext = extOfV2(c.input!);
  const input = readFixtureV2(c.input!);
  switch (c.operation) {
    case "prefix-source-bytes": {
      const prefix = hexToBytes(c.prefixHex!);
      const prefixed = new Uint8Array(prefix.length + input.length);
      prefixed.set(prefix, 0);
      prefixed.set(input, prefix.length);
      expectDiagnostic(classify(ext, prefixed), c.expect! as DiagnosticKind);
      return;
    }
    case "pad-body-to-total-bytes": {
      const padded = new Uint8Array(c.totalBytes!);
      padded.set(input, 0);
      padded.fill(0x0a, input.length);
      expectDiagnostic(classify(ext, padded), c.expect! as DiagnosticKind);
      return;
    }
    case "replace-envelope-with-yaml-mapping-depth": {
      const depth = c.depth!;
      expect(c.expect).toBe("document_too_complex");
      expectDiagnostic(classify(ext, yamlMappingEnvelope(depth)), "document_too_complex");
      const legal = classify(ext, yamlMappingEnvelope(depth - 1));
      expect("diagnostic" in legal ? legal.diagnostic : null).not.toBe("document_too_complex");
      return;
    }
    case "replace-body-with-nested-block-quotes": {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(input);
      const lines = text.split("\n");
      const close = djotEnvelopeClose(lines);
      expect(close).toBeGreaterThan(0);
      let prefixChars = 0;
      for (let i = 0; i <= close; i++) prefixChars += lines[i].length + 1;
      const rebuilt = text.slice(0, prefixChars) + "> ".repeat(c.containerDepth!) + "deep\n";
      expectDiagnostic(
        classify(ext, new TextEncoder().encode(rebuilt)),
        c.expect! as DiagnosticKind,
      );
      return;
    }
    case "no-op-round-trip": {
      const result = classify(ext, input);
      expect(result.kind).toBe("valid");
      expect(patchMetadata(ext, input, {})).toEqual(input);
      return;
    }
    case "metadata-patch": {
      expect(patchMetadata(ext, input, c.patch!)).toEqual(readFixtureV2(c.expected!));
      return;
    }
    case "external-change-before-save": {
      const changed = readFixtureV2(c.external!);
      let thrown: unknown;
      try {
        saveGuarded(input, changed, input);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toEqual({ diagnostic: "external_change_conflict" });
      return;
    }
    default:
      throw new Error(`unknown operation "${c.operation}"`);
  }
}

function readFixtureV2(relative: string): Uint8Array {
  return readFileSync(join(CORPUS_V2_DIR, relative));
}

describe("PDC v2 conformance corpus (r2)", () => {
  test("corpus revision pin", () => {
    expect(corpusV2.revision).toBe(2);
    expect(corpusV2.format).toBe("pdc-document-conformance/2");
    expect(corpusV2.queryContract).toBe("pdc-query/1");
  });

  for (const c of corpusV2.cases) {
    test(`v2 case: ${c.id}${c.operation ? ` (${c.operation})` : ""}`, () => {
      runCaseV2(c);
    });
  }
});

function readFixture(relative: string): Uint8Array {
  return readFileSync(join(CORPUS_DIR, relative));
}

function extOf(path: string): "djot" | "html" {
  return path.endsWith(".html") ? "html" : "djot";
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function expectDiagnostic(result: Classification, expected: DiagnosticKind): void {
  expect(result.kind).toBe("invalid");
  if (result.kind === "invalid") {
    expect(result.diagnostic).toBe(expected);
    expect(result.message).not.toBe("");
  }
}

/** One case's body line index of the djot envelope close (`---`). */
function djotEnvelopeClose(lines: string[]): number {
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") return i;
  }
  return -1;
}

function runCase(c: CorpusCase): void {
  if (c.kind === "file") {
    const path = c.path!;
    const result = classify(extOf(path), readFixture(path));
    if (c.expect === "valid") {
      expect(result.kind).toBe("valid");
      if (result.kind === "valid") {
        expect(result.profile).toBe(extOf(path) === "djot" ? "pdc-djot/1" : "pdc-html/1");
        expect(result.id).not.toBe("");
      }
    } else if (c.expect === "legacy_html") {
      expect(result).toEqual({ kind: "legacy_html" });
    } else {
      expectDiagnostic(result, c.expect! as DiagnosticKind);
    }
    return;
  }

  if (c.kind === "set") {
    const ids: string[] = [];
    for (const path of c.paths!) {
      const result = classify(extOf(path), readFixture(path));
      if (result.kind === "valid") ids.push(result.id);
    }
    expect(new Set(ids).size).toBeLessThan(ids.length);
    return;
  }

  const ext = extOf(c.input!);
  const input = readFixture(c.input!);
  switch (c.operation) {
    case "prefix-source-bytes": {
      const prefix = hexToBytes(c.prefixHex!);
      const prefixed = new Uint8Array(prefix.length + input.length);
      prefixed.set(prefix, 0);
      prefixed.set(input, prefix.length);
      expectDiagnostic(classify(ext, prefixed), c.expect! as DiagnosticKind);
      return;
    }
    case "pad-body-to-total-bytes": {
      const padded = new Uint8Array(c.totalBytes!);
      padded.set(input, 0);
      padded.fill(0x0a, input.length);
      expectDiagnostic(classify(ext, padded), c.expect! as DiagnosticKind);
      return;
    }
    case "replace-body-with-nested-block-quotes": {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(input);
      const lines = text.split("\n");
      const close = djotEnvelopeClose(lines);
      expect(close).toBeGreaterThan(0);
      let prefixChars = 0;
      for (let i = 0; i <= close; i++) prefixChars += lines[i].length + 1;
      const rebuilt = text.slice(0, prefixChars) + "> ".repeat(c.containerDepth!) + "deep\n";
      expectDiagnostic(
        classify(ext, new TextEncoder().encode(rebuilt)),
        c.expect! as DiagnosticKind,
      );
      return;
    }
    case "no-op-round-trip": {
      const result = classify(ext, input);
      expect(result.kind).toBe("valid");
      expect(patchMetadata(ext, input, {})).toEqual(input);
      return;
    }
    case "metadata-patch": {
      expect(patchMetadata(ext, input, c.patch!)).toEqual(readFixture(c.expected!));
      return;
    }
    case "external-change-before-save": {
      const changed = readFixture(c.external!);
      let thrown: unknown;
      try {
        saveGuarded(input, changed, input);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toEqual({ diagnostic: "external_change_conflict" });
      return;
    }
    default:
      throw new Error(`unknown operation "${c.operation}"`);
  }
}

describe("PDC conformance corpus", () => {
  test("corpus revision pin", () => {
    expect(corpus.revision).toBe(CORPUS_REVISION);
    expect(corpus.format).toBe("pdc-document-conformance/1");
  });

  for (const c of corpus.cases) {
    test(`case: ${c.id}${c.operation ? ` (${c.operation})` : ""}`, () => {
      runCase(c);
    });
  }
});
