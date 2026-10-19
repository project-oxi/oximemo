import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import {
  createMarkdownDocument,
  evaluateQuery,
  MarkdownContractError,
  parseMarkdownDocument,
  parseQuery,
  patchMarkdownEnvelope,
  type QueryDocument,
} from "../src/index.js";

const directory = dirname(fileURLToPath(import.meta.url));
const corpusDirectory = resolve(directory, "../../../contracts/markdown/conformance");
const corpus = JSON.parse(readFileSync(resolve(corpusDirectory, "corpus.json"), "utf8")) as {
  cases: Array<Record<string, unknown> & { id: string; kind: string; expect: string }>;
};

function fixture(relativePath: string): string {
  return readFileSync(resolve(corpusDirectory, relativePath), "utf8");
}

function diagnosticCode(source: string, fileName?: string): string | undefined {
  const parsed = parseMarkdownDocument(source, { fileName });
  return parsed.kind === "invalid" ? parsed.diagnostic.code : undefined;
}

function querySource(path: string): { source: string; inline: boolean } {
  const source = fixture(path);
  if (!path.endsWith(".md")) return { source, inline: false };
  const document = parseMarkdownDocument(source, { fileName: path });
  if (document.kind !== "markdown") throw new Error(`Expected a Markdown document in ${path}`);
  const block = document.body.match(/(?:^|\n)```base\n([\s\S]*?)\n```(?=\n|$)/);
  if (!block) throw new Error(`Expected an exact base fence in ${path}`);
  return { source: block[1], inline: true };
}

describe("vendored PDC conformance corpus", () => {
  for (const item of corpus.cases.filter((entry) => entry.kind === "file")) {
    test(item.id, () => {
      const path = String(item.path);
      if (path.endsWith(".base") || path.includes("fenced-base")) {
        const { source, inline } = querySource(path);
        const result = parseQuery(source, { inline });
        if (item.expect === "valid") expect(result.status).toBe("valid");
        else if (item.expect === "valid_unexecuted") expect(result.status).toBe("valid_unexecuted");
        else {
          expect(result.status).toBe("invalid_query");
          expect(result.diagnostic?.code).toBe("invalid_query");
        }
        return;
      }

      const parsed = parseMarkdownDocument(fixture(path), { fileName: path });
      if (item.expect === "valid") {
        expect(["markdown", "read_only"]).toContain(parsed.kind);
        if (path.endsWith(".md")) expect(parsed.kind).toBe("markdown");
        if (path.includes("v2-") && path.endsWith(".html")) expect(parsed.kind).toBe("read_only");
      } else if (item.expect === "legacy_valid") {
        expect(parsed.kind).toBe("read_only");
        if (parsed.kind === "read_only") expect(parsed.version).toBe(1);
      } else if (item.expect === "legacy_html" || item.expect === "legacy_markdown") {
        expect(parsed.kind).toBe("legacy");
        if (parsed.kind === "legacy") expect(parsed.diagnostic.code).toBe(item.expect);
      } else {
        expect(parsed.kind).toBe("invalid");
        if (parsed.kind === "invalid") expect(parsed.diagnostic.code).toBe(item.expect);
      }
    });
  }
});

describe("applicable PDC source-preservation operations", () => {
  for (const item of corpus.cases.filter((entry) => entry.kind === "operation")) {
    const operation = String(item.operation);
    const inputPath = String(item.input);

    // This package only edits canonical PDC 2 Markdown. HTML is a readable
    // source fallback, and legacy Djot is deliberately read-only.
    if (operation === "metadata-patch" && !inputPath.endsWith(".md")) continue;

    test(item.id, () => {
      const original = fixture(inputPath);
      if (operation === "no-op-round-trip") {
        const parsed = parseMarkdownDocument(original, { fileName: inputPath });
        expect(parsed.kind).not.toBe("invalid");
        if (parsed.kind !== "invalid") expect(parsed.source).toBe(original);
        return;
      }
      if (operation === "metadata-patch") {
        const output = patchMarkdownEnvelope(original, item.patch as Record<string, string>);
        expect(output).toBe(fixture(String(item.expected)));
        return;
      }
      if (operation === "external-change-before-save") {
        const changed = fixture(String(item.external));
        expect(() => patchMarkdownEnvelope(original, {}, changed)).toThrow(MarkdownContractError);
        try { patchMarkdownEnvelope(original, {}, changed); }
        catch (error) {
          expect((error as MarkdownContractError).diagnostic.code).toBe("external_change_conflict");
        }
        return;
      }
      if (operation === "prefix-source-bytes") {
        const prefixed = `\uFEFF${original}`;
        expect(diagnosticCode(prefixed, inputPath)).toBe(item.expect);
        return;
      }
      if (operation === "pad-body-to-total-bytes") {
        const paddingBytes = Number(item.totalBytes) - new TextEncoder().encode(original).length;
        const padded = `${original}${"x".repeat(Math.max(0, paddingBytes))}`;
        expect(diagnosticCode(padded, inputPath)).toBe(item.expect);
        return;
      }
      if (operation === "replace-envelope-with-yaml-mapping-depth") {
        const close = original.indexOf("\n---\n", 4);
        expect(close).toBeGreaterThan(0);
        const depth = Number(item.depth);
        const nested = `deep:\n${Array.from({ length: depth }, (_, index) => `${"  ".repeat(index + 1)}level${index}:\n`).join("")}${"  ".repeat(depth + 1)}value: leaf\n`;
        const deepSource = `${original.slice(0, close + 1)}${nested}${original.slice(close + 1)}`;
        expect(diagnosticCode(deepSource, inputPath)).toBe(item.expect);
        return;
      }
      if (operation === "replace-body-with-nested-block-quotes") {
        const close = original.indexOf("\n---\n", 4);
        expect(close).toBeGreaterThan(0);
        const bodyStart = close + "\n---\n".length;
        const nested = `${"> ".repeat(Number(item.containerDepth))}Nested quote\n`;
        const deepSource = `${original.slice(0, bodyStart)}${nested}`;
        expect(diagnosticCode(deepSource, inputPath)).toBe(item.expect);
        return;
      }
      throw new Error(`Unhandled shared operation ${operation}`);
    });
  }
});

describe("Garden document and query primitives", () => {
  test("creates canonical Markdown and normalizes only newly authored content", () => {
    const source = createMarkdownDocument({
      id: "018f47c6-8c21-7d44-9e55-1a2b3c4d5e6f",
      created: "2026-09-14T12:40:00.000Z",
      updated: "2026-09-14T12:40:00.000Z",
      title: "Garden note",
      body: "First line\r\n\r\nSecond line\r\n",
      properties: { priority: 2 },
    });
    const parsed = parseMarkdownDocument(source);
    expect(parsed.kind).toBe("markdown");
    if (parsed.kind === "markdown") expect(parsed.body).toBe("First line\n\nSecond line\n");
  });

  test("evaluates the portable query fixture against in-memory note values", () => {
    const { source } = querySource("fixtures/query/notes.base");
    const query = parseQuery(source);
    const documents: QueryDocument[] = [
      {
        id: "doc-standard",
        path: "work/standard.md",
        envelope: { title: "Standard", tags: ["standard"], priority: 3, deleted: false },
        body: "Links to [[other]].",
      },
      {
        id: "doc-deleted",
        path: "work/deleted.md",
        envelope: { title: "Deleted", tags: ["standard"], priority: 9, deleted: true },
        body: "No result.",
      },
    ];
    const result = evaluateQuery(query, documents);
    expect(result.status).toBe("evaluated");
    expect(result.views[0]?.rows.map((row) => row.id)).toEqual(["doc-standard"]);
    expect(result.views[0]?.rows[0]?.values["note.priority"]).toBe(3);
    expect(result.views[0]?.summaries["note.priority"]).toBe(3);
  });

  test("does not execute unknown query views or function calls", () => {
    const { source } = querySource("fixtures/query/unknown-view.base");
    expect(parseQuery(source).status).toBe("valid_unexecuted");
    const hostile = parseQuery('filters: "false && system(\\"touch /tmp/garden-query\\")"');
    expect(hostile.status).toBe("valid_unexecuted");
    const result = evaluateQuery(hostile, [{
      id: "doc",
      path: "doc.md",
      envelope: { title: "Doc" },
    }]);
    expect(result.status).toBe("valid_unexecuted");
    expect(parseQuery(`views:\n  - type: table\n    name: Grouped\n    groupBy:\n      property: note.status\n      direction: ASC`).status).toBe("valid_unexecuted");
  });

  test("resolves value fields, string length, subtraction, and summary values without source evaluation", () => {
    const query = parseQuery(`formulas:\n  score: "priority * 2"\n  count: "values.length"\nfilters: "formula.score - 1 == 1 && title.length == 1"\nviews:\n  - type: table\n    name: Results\n    order: [note.title, formula.score]\n    summaries:\n      note.priority: Count\nsummaries:\n  Count: "values.length"`);
    expect(query.status).toBe("valid");
    const result = evaluateQuery(query, [{
      id: "one",
      path: "one.md",
      envelope: { title: "A", priority: 1 },
    }, {
      id: "two",
      path: "two.md",
      envelope: { title: "B", priority: 2 },
    }]);
    expect(result.status).toBe("evaluated");
    expect(result.views[0]?.rows.map((row) => row.id)).toEqual(["one"]);
    expect(result.views[0]?.summaries["note.priority"]).toBe(1);
  });

  test("rejects YAML mapping-key features and integers that JavaScript would round", () => {
    const canonical = fixture("fixtures/valid/minimal.md");
    const close = canonical.indexOf("\n---\n", 4);
    const addMetadata = (line: string) => `${canonical.slice(0, close + 1)}${line}\n${canonical.slice(close + 1)}`;
    expect(diagnosticCode(addMetadata("!!str custom: value"), "note.md")).toBe("invalid_envelope");
    expect(diagnosticCode(addMetadata("custom: 9007199254740993"), "note.md")).toBe("invalid_envelope");
    expect(diagnosticCode(addMetadata("&custom custom: value"), "note.md")).toBe("invalid_envelope");
  });

  test("fails closed when removing multiline YAML instead of consuming a sibling property", () => {
    const canonical = fixture("fixtures/valid/minimal.md");
    const close = canonical.indexOf("\n---\n", 4);
    const source = `${canonical.slice(0, close + 1)}note: |\n  retained text\nnext: preserve\n${canonical.slice(close + 1)}`;
    expect(() => patchMarkdownEnvelope(source, { note: undefined })).toThrow(MarkdownContractError);
    const parsed = parseMarkdownDocument(source);
    expect(parsed.kind).toBe("markdown");
    if (parsed.kind === "markdown") {
      expect(parsed.envelope.note).toBe("retained text\n");
      expect(parsed.envelope.next).toBe("preserve");
    }
  });
});
