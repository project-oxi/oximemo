import { isMap, isScalar, isSeq, type Node, type Pair } from "yaml";
import { getNodeRange, getYamlTopLevelPairs, parseSafeYamlObject, stringifyYamlScalar } from "./safe-yaml.js";
import { envelopeSchema } from "./generated/envelope-schema.js";
import { gardenMarkdownParser } from "./syntax.js";
import {
  MarkdownContractError,
  type JsonObject,
  type JsonValue,
  type MarkdownDiagnostic,
  type MarkdownEnvelope,
  type MarkdownReadResult,
} from "./types.js";

const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMESTAMP_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;
const PDC2_KNOWN_FIELDS = Object.keys(envelopeSchema.properties);
const PDC2_REQUIRED_FIELDS = envelopeSchema.required;
type JsonSchema = { [key: string]: unknown };

function resolveSchemaRef(reference: string): JsonSchema | null {
  if (!reference.startsWith("#/")) return null;
  let current: unknown = envelopeSchema;
  for (const part of reference.slice(2).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[key];
  }
  return current && typeof current === "object" ? current as JsonSchema : null;
}

function schemaTypeMatches(value: unknown, type: string): boolean {
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "array") return Array.isArray(value);
  if (type === "null") return value === null;
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function schemaFailure(value: unknown, schema: JsonSchema, path = "$", depth = 0): string | null {
  if (depth > 40) return `${path} exceeds the schema validation depth limit`;
  if (typeof schema.$ref === "string") {
    const resolved = resolveSchemaRef(schema.$ref);
    return resolved ? schemaFailure(value, resolved, path, depth + 1) : `${path} uses an unresolved schema reference`;
  }
  if (typeof schema.type === "string" && !schemaTypeMatches(value, schema.type)) return `${path} must be ${schema.type}`;
  if ("const" in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) return `${path} has an unsupported value`;
  if (Array.isArray(schema.enum) && !schema.enum.some((allowed) => JSON.stringify(value) === JSON.stringify(allowed))) return `${path} has an unsupported value`;
  if (typeof value === "string") {
    const length = [...value].length;
    if (typeof schema.minLength === "number" && length < schema.minLength) return `${path} is too short`;
    if (typeof schema.maxLength === "number" && length > schema.maxLength) return `${path} is too long`;
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) return `${path} has an invalid format`;
  }
  if (Array.isArray(value)) {
    if (schema.uniqueItems === true && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) return `${path} contains duplicate values`;
    if (schema.items && typeof schema.items === "object") {
      for (let index = 0; index < value.length; index += 1) {
        const issue = schemaFailure(value[index], schema.items as JsonSchema, `${path}[${index}]`, depth + 1);
        if (issue) return issue;
      }
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    if (Array.isArray(schema.required)) {
      const missing = (schema.required as unknown[]).find((key) => typeof key === "string" && !Object.prototype.hasOwnProperty.call(object, key));
      if (typeof missing === "string") return `${path}.${missing} is required`;
    }
    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties as Record<string, JsonSchema> : {};
    for (const [key, item] of Object.entries(object)) {
      const propertySchema = properties[key];
      if (propertySchema) {
        const issue = schemaFailure(item, propertySchema, `${path}.${key}`, depth + 1);
        if (issue) return issue;
        continue;
      }
      if (schema.additionalProperties === false) return `${path}.${key} is not permitted`;
      if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        const issue = schemaFailure(item, schema.additionalProperties as JsonSchema, `${path}.${key}`, depth + 1);
        if (issue) return issue;
      }
    }
    if (schema.propertyNames && typeof schema.propertyNames === "object") {
      for (const key of Object.keys(object)) {
        const issue = schemaFailure(key, schema.propertyNames as JsonSchema, `${path} key`, depth + 1);
        if (issue) return issue;
      }
    }
  }
  if (Array.isArray(schema.allOf)) {
    for (const part of schema.allOf as JsonSchema[]) {
      const issue = schemaFailure(value, part, path, depth + 1);
      if (issue) return issue;
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const passing = (schema.oneOf as JsonSchema[]).filter((part) => schemaFailure(value, part, path, depth + 1) === null).length;
    if (passing !== 1) return `${path} does not match exactly one allowed value shape`;
  }
  if (schema.if && typeof schema.if === "object" && schemaFailure(value, schema.if as JsonSchema, path, depth + 1) === null && schema.then && typeof schema.then === "object") {
    const issue = schemaFailure(value, schema.then as JsonSchema, path, depth + 1);
    if (issue) return issue;
  }
  return null;
}

interface Line {
  text: string;
  start: number;
  contentEnd: number;
  end: number;
}

interface Transport {
  type: "markdown" | "html" | "djot";
  version: 1 | 2;
  yamlStart: number;
  yamlEnd: number;
  bodyStart: number;
  newline: "\n" | "\r\n";
}

export interface ParseMarkdownOptions {
  fileName?: string;
}

export interface CreateMarkdownInput {
  title: string;
  body?: string;
  id?: string;
  created?: string;
  updated?: string;
  properties?: Record<string, JsonValue>;
}

function lineAt(source: string, start: number): Line {
  const lf = source.indexOf("\n", start);
  const end = lf < 0 ? source.length : lf + 1;
  const contentEnd = lf < 0 ? source.length : lf;
  const text = source.slice(start, contentEnd).replace(/\r$/, "");
  return { text, start, contentEnd, end };
}

function fail(code: MarkdownDiagnostic["code"], message: string): never {
  throw new MarkdownContractError({ code, message });
}

function bytes(source: string): number {
  return new TextEncoder().encode(source).length;
}

function extractTransport(source: string, type: Transport["type"]): Transport | "not-transport" {
  const first = lineAt(source, 0);
  if (type === "markdown") {
    if (first.text !== "---") return "not-transport";
    let cursor = first.end;
    const newline = source.slice(first.start, first.end).endsWith("\r\n") ? "\r\n" : "\n";
    while (cursor <= source.length) {
      const line = lineAt(source, cursor);
      if (line.text === "---") {
        return { type, version: 2, yamlStart: first.end, yamlEnd: line.start, bodyStart: line.end, newline };
      }
      if (line.end === source.length) break;
      cursor = line.end;
    }
    fail("invalid_transport", "Markdown PDC frontmatter is not closed by an exact `---` line.");
  }

  if (type === "html") {
    if (first.text !== "<!--") return "not-transport";
    const second = lineAt(source, first.end);
    if (second.text !== "---") return "not-transport";
    const newline = source.slice(first.start, first.end).endsWith("\r\n") ? "\r\n" : "\n";
    let cursor = second.end;
    while (cursor <= source.length) {
      const line = lineAt(source, cursor);
      if (line.text === "---") {
        const closing = lineAt(source, line.end);
        if (closing.text !== "-->") fail("invalid_transport", "HTML PDC envelope must be followed immediately by an exact `-->` line.");
        const yaml = source.slice(second.end, line.start);
        if (yaml.includes("-->") || yaml.includes("--!>")) fail("invalid_transport", "HTML PDC envelope contains a premature comment terminator.");
        return { type, version: 1, yamlStart: second.end, yamlEnd: line.start, bodyStart: closing.end, newline };
      }
      if (line.end === source.length) break;
      cursor = line.end;
    }
    fail("invalid_transport", "HTML PDC envelope is not closed.");
  }

  if (first.text !== "---") return "not-transport";
  let cursor = first.end;
  const newline = source.slice(first.start, first.end).endsWith("\r\n") ? "\r\n" : "\n";
  while (cursor <= source.length) {
    const line = lineAt(source, cursor);
    if (line.text === "---") {
      return { type: "djot", version: 1, yamlStart: first.end, yamlEnd: line.start, bodyStart: line.end, newline };
    }
    if (line.end === source.length) break;
    cursor = line.end;
  }
  fail("invalid_transport", "Legacy Djot PDC frontmatter is not closed.");
}

function isRealTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function validUserValue(value: JsonValue, depth = 1, seen = new Set<object>()): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => validUserValue(item, depth + 1, seen))
    : Object.entries(value).every(([key, item]) => key.length > 0 && validUserValue(item, depth + 1, seen));
  seen.delete(value);
  return valid;
}

function validateEnvelope(value: JsonObject, version: 1 | 2): void {
  const required: readonly string[] = version === 2 ? PDC2_REQUIRED_FIELDS : ["format", "body", "id", "created", "updated", "title"];
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    fail("invalid_envelope", "PDC envelope is missing a required field.");
  }
  const expectedFormat = `pdc-document/${version}`;
  if (value.format !== expectedFormat) {
    if (typeof value.format === "string" && /^pdc-document\/\d+$/.test(value.format)) {
      fail("unsupported_document_version", `Document format ${value.format} is not supported here.`);
    }
    fail("invalid_envelope", `PDC format must be ${expectedFormat}.`);
  }
  // Recognize each published body profile before checking transport agreement.
  // A known profile attached to the wrong document version/extension is a
  // transport mismatch; only an unknown profile version is unsupported.
  const allowedBody = ["pdc-markdown/1", "pdc-html/1", "pdc-djot/1"];
  if (typeof value.body !== "string") fail("invalid_envelope", "PDC body must be a string.");
  if (!allowedBody.includes(value.body)) {
    if (/^pdc-[a-z-]+\/\d+$/.test(value.body)) fail("unsupported_body_version", `Document body profile ${value.body} is not supported here.`);
    fail("invalid_envelope", "PDC body profile is invalid for its document version.");
  }
  if (typeof value.id === "string" && !ID_PATTERN.test(value.id)) {
    fail("invalid_document_id", "PDC document id must be a canonical lowercase UUID.");
  }
  if (typeof value.id !== "string") fail("invalid_envelope", "PDC document id must be a string.");
  if (!isRealTimestamp(value.created) || !isRealTimestamp(value.updated)) {
    fail("invalid_envelope", "PDC timestamps must be real UTC timestamps with millisecond precision.");
  }
  if (value.updated < value.created) fail("invalid_envelope", "PDC updated time must not be earlier than created time.");
  if (typeof value.title !== "string") fail("invalid_envelope", "PDC title must be a string.");
  if (version === 2) {
    const issue = schemaFailure(value, envelopeSchema as unknown as JsonSchema);
    if (issue) fail("invalid_envelope", `Envelope does not satisfy the vendored PDC schema: ${issue}.`);
    const lang = value.lang;
    if (typeof lang === "string") {
      try {
        if (Intl.getCanonicalLocales(lang).length !== 1) fail("invalid_envelope", "lang must be a valid BCP 47 language tag.");
      } catch {
        fail("invalid_envelope", "lang must be a valid BCP 47 language tag.");
      }
    }
    return;
  }
  for (const field of ["profile", "lang"]) {
    if (value[field] !== undefined && typeof value[field] !== "string") fail("invalid_envelope", `${field} must be a string.`);
  }
  for (const field of ["tags", "aliases"]) {
    const list = value[field];
    if (list !== undefined && (!Array.isArray(list) || list.some((item) => typeof item !== "string") || new Set(list).size !== list.length)) {
      fail("invalid_envelope", `${field} must be a duplicate-free sequence of strings.`);
    }
  }
  for (const field of ["favorite", "deleted"]) if (value[field] !== undefined && typeof value[field] !== "boolean") fail("invalid_envelope", `${field} must be a Boolean.`);
  if ((value.deleted === true) !== (typeof value.deleted_at === "string")) fail("invalid_envelope", "deleted_at must be present exactly when deleted is true.");
  if (value.deleted_at !== undefined && !isRealTimestamp(value.deleted_at)) fail("invalid_envelope", "deleted_at must be a canonical UTC timestamp.");
  for (const [key, property] of Object.entries(value)) {
    if (!key || !validUserValue(property)) fail("invalid_envelope", `Envelope property ${JSON.stringify(key)} is not a JSON-compatible value.`);
  }
}

function hasUnsafeContent(body: string): boolean {
  return /<\s*(?:script|iframe|object|embed|applet|base)\b/i.test(body)
    || /<\s*meta\b[^>]*\bhttp-equiv\s*=\s*(["']?refresh\b)/i.test(body)
    || /<\s*link\b[^>]*\brel\s*=\s*(["']?stylesheet\b)/i.test(body)
    || /\son[a-z][\w:-]*\s*=/i.test(body)
    || /(?:href|src|xlink:href)\s*=\s*(?:"\s*|'\s*|\s*)(?:javascript|vbscript|data|file):/i.test(body)
    || /url\(\s*['"]?\s*(?:javascript|vbscript|data|file):/i.test(body);
}

function htmlStableIds(source: string): string[] {
  const ids: string[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    const open = source.indexOf("<", cursor);
    if (open < 0) break;
    if (source.startsWith("<!--", open)) {
      const close = source.indexOf("-->", open + 4);
      cursor = close < 0 ? source.length : close + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", open)) {
      const close = source.indexOf("]]>", open + 9);
      cursor = close < 0 ? source.length : close + 3;
      continue;
    }
    if (source.startsWith("<!", open) || source.startsWith("<?", open) || source.startsWith("</", open)) {
      cursor = skipHtmlTag(source, open);
      continue;
    }

    if (!/[A-Za-z]/.test(source[open + 1] ?? "")) {
      cursor = open + 1;
      continue;
    }

    let index = open + 1;
    while (/[A-Za-z0-9:_-]/.test(source[index] ?? "")) index += 1;
    const tagName = source.slice(open + 1, index).toLowerCase();
    let tagEnd = source.length;
    while (index < source.length) {
      while (/[\t\n\f\r ]/.test(source[index] ?? "")) index += 1;
      if (source[index] === ">") {
        tagEnd = index + 1;
        break;
      }
      if (source[index] === "/" && source[index + 1] === ">") {
        tagEnd = index + 2;
        break;
      }
      if (index >= source.length) break;

      const nameStart = index;
      while (index < source.length && !/[\t\n\f\r />=]/.test(source[index]!)) index += 1;
      if (index === nameStart) {
        index += 1;
        continue;
      }
      const name = source.slice(nameStart, index).toLowerCase();
      while (/[\t\n\f\r ]/.test(source[index] ?? "")) index += 1;
      if (source[index] !== "=") continue;

      index += 1;
      while (/[\t\n\f\r ]/.test(source[index] ?? "")) index += 1;
      const quote = source[index] === "\"" || source[index] === "'" ? source[index]! : "";
      let value = "";
      if (quote) {
        const valueStart = ++index;
        while (index < source.length && source[index] !== quote) index += 1;
        value = source.slice(valueStart, index);
        if (index < source.length) index += 1;
      } else {
        const valueStart = index;
        while (index < source.length && !/[\t\n\f\r >]/.test(source[index]!)) index += 1;
        value = source.slice(valueStart, index);
      }
      if (name === "id" && quote && /^b-[0-9a-f-]{36}$/i.test(value)) ids.push(`b-${value.slice(2).toLowerCase()}`);
    }

    cursor = tagEnd;
    if (["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript", "plaintext"].includes(tagName)) {
      const close = tagName === "plaintext" ? -1 : source.slice(cursor).search(new RegExp(`</\\s*${tagName}(?=[\\s/>])`, "i"));
      if (close < 0) break;
      cursor += close;
      cursor = skipHtmlTag(source, cursor);
    }
  }

  return ids;
}

function skipHtmlTag(source: string, from: number): number {
  let quote = "";
  for (let index = from + 1; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === "\"" || char === "'") {
      quote = char;
    } else if (char === ">") {
      return index + 1;
    }
  }
  return source.length;
}

function hasDuplicateBlockIds(body: string, profile: string): boolean {
  const ids: string[] = [];
  if (profile === "pdc-markdown/1") {
    gardenMarkdownParser.parse(body).iterate({ enter(node) {
      if (node.name === "GardenBlockId") ids.push(body.slice(node.from + 1, node.to));
      if (node.name === "HTMLBlock" || node.name === "HTMLTag") {
        ids.push(...htmlStableIds(body.slice(node.from, node.to)));
        return false;
      }
    }});
  } else if (profile === "pdc-djot/1") {
    let fence: string | null = null;
    for (const line of body.split(/\r?\n/)) {
      const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (fenceMatch) {
        const marker = fenceMatch[1][0];
        if (!fence) fence = marker;
        else if (fence === marker) fence = null;
        continue;
      }
      if (fence) continue;
      const match = line.match(/(?:\s)\^([A-Za-z0-9-]+)\s*$/);
      if (match) ids.push(match[1]);
    }
    if (profile === "pdc-djot/1") {
      for (const match of body.matchAll(/\{#(b-[0-9a-f-]{36})\}/gi)) ids.push(match[1].toLowerCase());
    }
    for (const match of body.matchAll(/\bid\s*=\s*(["'])b-([0-9a-f-]{36})\1/gi)) ids.push(`b-${match[2].toLowerCase()}`);
  } else {
    for (const match of body.matchAll(/\bid\s*=\s*(["'])b-([0-9a-f-]{36})\1/gi)) ids.push(`b-${match[2].toLowerCase()}`);
  }
  return new Set(ids).size !== ids.length;
}

function validateBody(body: string, profile: string): void {
  if (hasDuplicateBlockIds(body, profile)) fail("duplicate_block_id", "Document contains duplicate stable block ids.");
  if (hasUnsafeContent(body)) fail("unsafe_content", "Document contains active HTML or an unsafe URL; keep the source and show an inert preview.");
  if (profile === "pdc-djot/1" && /<\/?[A-Za-z][^>]*>/.test(body)) fail("unsafe_content", "Raw HTML is not permitted in the legacy Djot body profile.");
  if (profile === "pdc-markdown/1") {
    for (const line of body.split(/\r?\n/)) {
      // Nested block quotes repeat the marker on one source line (`> > >`).
      // Count those markers instead of matching the anchored prefix repeatedly.
      const quotePrefix = line.match(/^(?: {0,3}>[ \t]?)+/)?.[0] ?? "";
      const depth = (quotePrefix.match(/>/g) ?? []).length;
      if (depth > 256) fail("document_too_complex", "Markdown block nesting exceeds the PDC limit.");
    }
  }
  if (profile === "pdc-djot/1") {
    for (const line of body.split(/\r?\n/)) {
      const quotePrefix = line.match(/^(?: {0,3}>[ \t]?)+/)?.[0] ?? "";
      const depth = (quotePrefix.match(/>/g) ?? []).length;
      if (depth > 256) fail("document_too_complex", "Djot block nesting exceeds the PDC limit.");
    }
  }
}

function diagnostic(code: MarkdownDiagnostic["code"], message: string): MarkdownDiagnostic {
  return { code, message };
}

function invalid(source: string, error: unknown): MarkdownReadResult {
  if (error instanceof MarkdownContractError) return { kind: "invalid", source, editable: false, diagnostic: error.diagnostic };
  return { kind: "invalid", source, editable: false, diagnostic: diagnostic("invalid_envelope", error instanceof Error ? error.message : "Invalid PDC document.") };
}

function readPdc(source: string, transport: Transport, options: ParseMarkdownOptions): MarkdownReadResult {
  if (bytes(source) > MAX_DOCUMENT_BYTES) fail("document_too_large", "PDC documents are limited to 4 MiB.");
  const yamlSource = source.slice(transport.yamlStart, transport.yamlEnd);
  const parsed = parseSafeYamlObject(yamlSource);
  if (Object.keys(parsed.value).length === 0) fail("invalid_envelope", "PDC envelope cannot be empty.");
  const knownProfiles = ["pdc-markdown/1", "pdc-html/1", "pdc-djot/1"];
  const declaredVersion = parsed.value.format;
  const declaredBody = parsed.value.body;
  const expectedProfile = transport.type === "markdown" ? "pdc-markdown/1" : transport.type === "html" ? "pdc-html/1" : "pdc-djot/1";
  const transportMatches = transport.type === "markdown"
    ? declaredVersion === "pdc-document/2" && declaredBody === "pdc-markdown/1"
    : transport.type === "html"
      ? (declaredVersion === "pdc-document/1" || declaredVersion === "pdc-document/2") && declaredBody === expectedProfile
      : declaredVersion === "pdc-document/1" && declaredBody === expectedProfile;
  if ((declaredVersion === "pdc-document/1" || declaredVersion === "pdc-document/2")
    && typeof declaredBody === "string" && knownProfiles.includes(declaredBody) && !transportMatches) {
    fail("invalid_transport", "PDC envelope format or body profile does not match the file transport.");
  }
  const version = parsed.value.format === "pdc-document/1" ? 1 : 2;
  if (version === 1 && (parsed.document.comment || parsed.document.commentBefore || valueHasComments(parsed.document.contents))) {
    fail("invalid_envelope", "PDC 1 envelopes do not permit YAML comments.");
  }
  validateEnvelope(parsed.value, version);
  if (parsed.value.body !== expectedProfile || (transport.type === "markdown" && version !== 2) || (transport.type !== "markdown" && transport.type === "djot" && version !== 1)) {
    fail("invalid_transport", "PDC envelope format or body profile does not match the file transport.");
  }
  const body = source.slice(transport.bodyStart);
  validateBody(body, parsed.value.body as string);
  const fileName = options.fileName ?? "";
  if (parsed.value.body === "pdc-markdown/1") {
    return {
      kind: "markdown",
      profile: "pdc-markdown/1",
      version: 2,
      envelope: parsed.value as MarkdownEnvelope,
      body,
      source,
      editable: true,
    };
  }
  return {
    kind: "read_only",
    profile: parsed.value.body as "pdc-html/1" | "pdc-djot/1",
    version,
    envelope: parsed.value,
    body,
    source,
    editable: false,
    diagnostic: diagnostic(version === 1 ? "legacy_document_version" : "unsupported_lossless_edit", fileName ? `${fileName} opens as read-only source under ${parsed.value.format}.` : `This document opens as read-only source under ${parsed.value.format}.`),
  };
}

function parseMode(fileName: string | undefined, source: string): Transport["type"] {
  const extension = fileName?.split(".").at(-1)?.toLowerCase();
  if (extension === "html" || source.startsWith("<!--\n---") || source.startsWith("<!--\r\n---")) return "html";
  if (extension === "djot") return "djot";
  return "markdown";
}

export function parseMarkdownDocument(source: string, options: ParseMarkdownOptions = {}): MarkdownReadResult {
  try {
    if (source.startsWith("\uFEFF")) fail("invalid_transport", "PDC documents cannot start with a UTF-8 byte-order mark.");
    const type = parseMode(options.fileName, source);
    const transport = extractTransport(source, type);
    if (transport === "not-transport") {
      if (type === "html") return { kind: "legacy", profile: null, version: null, body: source, source, editable: false, diagnostic: diagnostic("legacy_html", "Unmarked HTML remains visible as a read-only legacy document.") };
      if (type === "djot") return invalid(source, new MarkdownContractError(diagnostic("invalid_transport", "Legacy PDC Djot requires an envelope.")));
      return { kind: "legacy", profile: null, version: null, body: source, source, editable: false, diagnostic: diagnostic("legacy_markdown", "Plain Markdown remains visible as a read-only legacy document.") };
    }
    return readPdc(source, transport, options);
  } catch (error) {
    return invalid(source, error);
  }
}

export const parsePdcDocument = parseMarkdownDocument;

function uuidV7(now: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const timestamp = BigInt(Math.max(0, Math.floor(now)));
  for (let index = 5; index >= 0; index -= 1) bytes[index] = Number((timestamp >> BigInt((5 - index) * 8)) & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function assertNewProperties(properties: Record<string, JsonValue>): void {
  for (const [key, value] of Object.entries(properties)) {
    if (!key || PDC2_KNOWN_FIELDS.includes(key) || !validUserValue(value)) {
      fail("invalid_envelope", `New user property ${JSON.stringify(key)} is reserved or is not JSON-compatible.`);
    }
  }
}

export function createMarkdownDocument(input: CreateMarkdownInput): string {
  const milliseconds = Date.now();
  const timestamp = new Date(milliseconds).toISOString();
  const id = input.id ?? uuidV7(milliseconds);
  const created = input.created ?? timestamp;
  const updated = input.updated ?? created;
  const envelope: JsonObject = {
    format: "pdc-document/2",
    body: "pdc-markdown/1",
    id,
    created,
    updated,
    title: input.title,
  };
  if (input.properties) {
    assertNewProperties(input.properties);
    Object.assign(envelope, input.properties);
  }
  validateEnvelope(envelope, 2);
  const header = stringifyYamlScalar(envelope);
  const body = (input.body ?? "").replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  const content = body ? `${body}\n` : "";
  const source = `---\n${header}\n---\n${content}`;
  const parsed = parseMarkdownDocument(source);
  if (parsed.kind !== "markdown") throw new MarkdownContractError(parsed.kind === "invalid" ? parsed.diagnostic : diagnostic("invalid_envelope", "Generated Markdown did not validate."));
  return source;
}

function valueHasComments(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const candidate = node as { comment?: string; commentBefore?: string; items?: unknown[]; key?: unknown; value?: unknown };
  if (candidate.comment || candidate.commentBefore) return true;
  if (Array.isArray(candidate.items) && candidate.items.some(valueHasComments)) return true;
  return valueHasComments(candidate.key) || valueHasComments(candidate.value);
}

function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function patchMarkdownEnvelope(
  source: string,
  patch: Record<string, JsonValue | undefined>,
  expectedSource?: string,
): string {
  if (expectedSource !== undefined && source !== expectedSource) {
    fail("external_change_conflict", "The source changed after editing began; reload or merge before saving.");
  }
  const document = parseMarkdownDocument(source);
  if (document.kind !== "markdown") {
    if (document.kind === "invalid") throw new MarkdownContractError(document.diagnostic);
    fail("unsupported_lossless_edit", "Only canonical PDC 2 Markdown can receive metadata patches.");
  }
  const transport = extractTransport(source, "markdown");
  if (transport === "not-transport") fail("invalid_transport", "Expected canonical PDC Markdown.");
  const parsed = parseSafeYamlObject(source.slice(transport.yamlStart, transport.yamlEnd));
  const pairs = getYamlTopLevelPairs(parsed);
  const byKey = new Map<string, Pair<Node, Node>>();
  for (const pair of pairs) if (isScalar(pair.key) && typeof pair.key.value === "string") byKey.set(pair.key.value, pair);
  const edits: Array<{ from: number; to: number; text: string }> = [];
  let changed = false;
  const next = { ...document.envelope } as JsonObject;

  for (const [key, value] of Object.entries(patch)) {
    const pair = byKey.get(key);
    if (value === undefined) {
      if ((PDC2_REQUIRED_FIELDS as readonly string[]).includes(key)) fail("invalid_envelope", `Required property ${key} cannot be removed.`);
      if (!pair) continue;
      const removableList = isSeq(pair.value) && pair.value.flow === true
        && pair.value.items.every(item => isScalar(item) && typeof item.value === "string");
      if ((!isScalar(pair.value) && !removableList) || valueHasComments(pair)) fail("unsupported_lossless_edit", `Removing ${key} cannot preserve its YAML structure and comments.`);
      const keyRange = getNodeRange(pair.key);
      const valueRange = getNodeRange(pair.value);
      if (!keyRange || !valueRange) fail("unsupported_lossless_edit", `Could not locate the source range for ${key}.`);
      const keyStart = transport.yamlStart + keyRange[0];
      const valueStart = transport.yamlStart + valueRange[0];
      const valueEnd = transport.yamlStart + valueRange[1];
      const lineStart = source.lastIndexOf("\n", keyStart) + 1;
      const lineBreak = source.indexOf("\n", lineStart);
      if (source.slice(lineStart, keyStart).trim() || lineBreak < 0 || valueStart >= lineBreak || valueEnd > lineBreak) {
        fail("unsupported_lossless_edit", `Removing multiline or complex property ${key} is not supported.`);
      }
      const lineEnd = Math.min(lineBreak + 1, transport.yamlEnd);
      edits.push({ from: lineStart, to: lineEnd, text: "" });
      delete next[key];
      changed = true;
      continue;
    }
    if (!validUserValue(value)) fail("invalid_envelope", `Patch value for ${key} is not JSON-compatible.`);
    if (pair && jsonEqual(document.envelope[key], value)) continue;
    next[key] = value;
    changed = true;
    if (!pair) {
      const keyText = /[\r\n]/.test(key) ? JSON.stringify(key) : stringifyYamlScalar(key);
      const valueText = Array.isArray(value) || (typeof value === "string" && /[\r\n]/.test(value)) ? JSON.stringify(value) : stringifyYamlScalar(value);
      const pairText = value !== null && typeof value === "object" && !Array.isArray(value)
        ? `${keyText}:${transport.newline}${valueText.split("\n").map((line) => `  ${line}`).join(transport.newline)}${transport.newline}`
        : `${keyText}: ${valueText}${transport.newline}`;
      edits.push({ from: transport.yamlEnd, to: transport.yamlEnd, text: pairText });
      continue;
    }
    // A collection's own trailing comment lies outside its value range. Only
    // comments inside its items would be discarded by replacing that range.
    const hasNestedComments = isSeq(pair.value)
      ? pair.value.items.some(valueHasComments)
      : isMap(pair.value) ? valueHasComments(pair.value) : false;
    if (hasNestedComments) fail("unsupported_lossless_edit", `Patching ${key} would discard comments nested in its YAML value.`);
    const range = getNodeRange(pair.value);
    if (!range) fail("unsupported_lossless_edit", `Could not locate the source range for ${key}.`);
    const valueText = Array.isArray(value) || (typeof value === "string" && /[\r\n]/.test(value)) ? JSON.stringify(value) : stringifyYamlScalar(value);
    if (isMap(pair.value) || isSeq(pair.value)) {
      if (!isSeq(pair.value) || !source.slice(transport.yamlStart + range[0], transport.yamlStart + range[1]).trimStart().startsWith("[")) {
        fail("unsupported_lossless_edit", `Patching structured property ${key} requires an explicit editor migration.`);
      }
    }
    edits.push({ from: transport.yamlStart + range[0], to: transport.yamlStart + range[1], text: valueText });
  }
  if (!changed) return source;
  validateEnvelope(next, 2);
  let updated = source;
  // Apply equal-offset insertions in reverse so their final source order matches the patch.
  for (const edit of edits.reverse().sort((a, b) => b.from - a.from)) updated = `${updated.slice(0, edit.from)}${edit.text}${updated.slice(edit.to)}`;
  const result = parseMarkdownDocument(updated);
  if (result.kind !== "markdown") throw new MarkdownContractError(result.kind === "invalid" ? result.diagnostic : diagnostic("invalid_envelope", "Metadata patch produced an invalid document."));
  if (JSON.stringify(result.envelope) !== JSON.stringify(next)) {
    fail("unsupported_lossless_edit", "Metadata patch changed the parsed envelope beyond the requested values.");
  }
  return updated;
}
