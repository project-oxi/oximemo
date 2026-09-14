/**
 * PDC Reader classification for the Oximemo frontend.
 *
 * Mirrors the normative rules of Portable Document Contract 1
 * (`portable-document-contract/references/PDC-1.0.md`): transport
 * validation (section 4), the constrained envelope grammar (section 5),
 * identity (section 7), and profile-specific body safety checks
 * (sections 6 and 11). The implementation is intentionally
 * self-contained: the vendored conformance corpus in `./corpus/` is the
 * exact behavioral gate.
 */

/** Revision of the vendored conformance corpus in `./corpus/`. The
 * classifier is pinned to this revision; bumping the corpus requires
 * revisiting this file. */
export const CORPUS_REVISION = 3;

/** Diagnostics a Reader must distinguish (PDC section 13). */
export type DiagnosticKind =
  | "invalid_transport"
  | "invalid_envelope"
  | "unsupported_document_version"
  | "unsupported_body_version"
  | "invalid_document_id"
  | "duplicate_block_id"
  | "document_too_large"
  | "document_too_complex"
  | "unsafe_content"
  | "external_change_conflict"
  | "legacy_html";

export type Classification =
  | {
      kind: "valid";
      profile: "pdc-djot/1" | "pdc-html/1";
      id: string;
      envelope: Record<string, unknown>;
    }
  | { kind: "legacy_html" }
  | { kind: "invalid"; diagnostic: DiagnosticKind; message: string };

/** 4 MiB including envelope transport and body (PDC 4.1). */
const MAX_DOCUMENT_BYTES = 4_194_304;
/** Maximum simultaneously open block containers in a Djot body (PDC 4.2). */
const MAX_DJOT_CONTAINER_DEPTH = 256;

const PROFILE_DJOT = "pdc-djot/1";
const PROFILE_HTML = "pdc-html/1";
const DOCUMENT_FORMAT = "pdc-document/1";

/** Canonical lowercase hyphenated UUID, version nibble 1-8, variant [89ab]. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;

type EnvelopeScalar = string | boolean;
type EnvelopeChild = EnvelopeScalar | EnvelopeScalar[];
type EnvelopeValue = EnvelopeChild | Map<string, EnvelopeChild>;

/** Sentinel for envelope-grammar violations (PDC 5). */
class EnvelopeError extends Error {}

function invalid(diagnostic: DiagnosticKind, message: string): Classification {
  return { kind: "invalid", diagnostic, message };
}

/** Strip a single trailing `\r` so LF and CRLF parse equivalently. */
function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

type TransportParse =
  | { ok: true; envelopeLines: string[]; firstBodyLine: number }
  | { ok: false; diagnostic: "invalid_transport"; message: string }
  | { legacy: true };

/**
 * Validate the profile-specific transport over raw lines and locate the
 * envelope slice. Envelope lines are compared after stripping one
 * trailing `\r` (CRLF tolerated, PDC 4.1).
 */
function parseTransport(ext: "djot" | "html", lines: string[]): TransportParse {
  const stripped = lines.map(stripCr);
  if (ext === "djot") {
    if (stripped[0] !== "---") {
      return {
        ok: false,
        diagnostic: "invalid_transport",
        message: "djot transport must open with an exact `---` line",
      };
    }
    const close = stripped.indexOf("---", 1);
    if (close === -1) {
      return {
        ok: false,
        diagnostic: "invalid_transport",
        message: "djot envelope is never closed by a second `---` line",
      };
    }
    return { ok: true, envelopeLines: stripped.slice(1, close), firstBodyLine: close + 1 };
  }
  if (stripped[0] !== "<!--" || stripped[1] !== "---") {
    return { legacy: true };
  }
  const close = stripped.indexOf("---", 2);
  if (close === -1) {
    return {
      ok: false,
      diagnostic: "invalid_transport",
      message: "html envelope is never closed by a second `---` line",
    };
  }
  if (stripped[close + 1] !== "-->") {
    return {
      ok: false,
      diagnostic: "invalid_transport",
      message: "html envelope wrapper is not closed by an exact `-->` line",
    };
  }
  for (let i = 2; i < close; i++) {
    if (stripped[i].includes("-->") || stripped[i].includes("--!>")) {
      return {
        ok: false,
        diagnostic: "invalid_transport",
        message: `envelope line ${i + 1} would close the html comment prematurely`,
      };
    }
  }
  return { ok: true, envelopeLines: stripped.slice(2, close), firstBodyLine: close + 2 };
}

/** Parse one scalar or flow-sequence value; `rest` is everything after `key:`. */
function parseScalar(key: string, rest: string, lineNo: number): EnvelopeChild {
  const raw = rest.replace(/^ +/, "");
  if (raw === "") throw new EnvelopeError(`"${key}" on line ${lineNo} has an empty value`);
  if (raw.length >= 2 && raw[0] === raw[raw.length - 1] && (raw[0] === '"' || raw[0] === "'")) {
    return raw.slice(1, -1);
  }
  if (/(^|\s)#/.test(raw)) {
    throw new EnvelopeError(
      `comment marker in the value of "${key}" on line ${lineNo}; comments are forbidden`,
    );
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw.startsWith("[")) {
    if (!raw.endsWith("]")) {
      throw new EnvelopeError(`unterminated flow sequence for "${key}" on line ${lineNo}`);
    }
    const inner = raw.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((item) => {
      const value = item.trim();
      if (value === "" || value.startsWith("[") || value.startsWith("{")) {
        throw new EnvelopeError(
          `flow sequence for "${key}" accepts only flat string items (line ${lineNo})`,
        );
      }
      if (
        value.length >= 2 &&
        value[0] === value[value.length - 1] &&
        (value[0] === '"' || value[0] === "'")
      ) {
        return value.slice(1, -1);
      }
      return value;
    });
  }
  return raw;
}

/**
 * Parse the constrained envelope grammar (PDC 5): keys at indentation
 * zero, booleans / single-line strings / flow string lists / one nested
 * two-space map. Duplicate keys, comments, tabs, empty values, and
 * deeper indentation are forbidden.
 */
function parseEnvelope(lines: string[]): Map<string, EnvelopeValue> {
  const top = new Map<string, EnvelopeValue>();
  let nested: { key: string; children: Map<string, EnvelopeChild> } | null = null;

  const finishNested = () => {
    if (nested) {
      if (nested.children.size === 0) throw new EnvelopeError(`"${nested.key}" has an empty value`);
      top.set(nested.key, nested.children);
      nested = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === "") continue;
    if (line.includes("\t")) throw new EnvelopeError(`envelope line ${i + 1} contains a tab`);
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      finishNested();
      if (line.startsWith("#")) {
        throw new EnvelopeError(`comments are forbidden in the envelope (line ${i + 1})`);
      }
      const match = /^([^:\s]+):(.*)$/.exec(line);
      if (!match) {
        throw new EnvelopeError(`envelope line ${i + 1} is not a "key: value" entry`);
      }
      const key = match[1];
      if (top.has(key)) throw new EnvelopeError(`duplicate envelope key "${key}"`);
      const rest = match[2];
      if (rest.trim() === "") {
        nested = { key, children: new Map() };
        continue;
      }
      top.set(key, parseScalar(key, rest, i + 1));
    } else if (indent === 2) {
      if (!nested) {
        throw new EnvelopeError(`envelope line ${i + 1} is indented without an enclosing nested map`);
      }
      const match = /^  ([^:\s]+):(.*)$/.exec(line);
      if (!match) {
        throw new EnvelopeError(`envelope line ${i + 1} is not a nested "key: value" entry`);
      }
      if (nested.children.has(match[1])) {
        throw new EnvelopeError(`duplicate key "${match[1]}" in "${nested.key}"`);
      }
      nested.children.set(match[1], parseScalar(match[1], match[2], i + 1));
    } else {
      throw new EnvelopeError(`envelope line ${i + 1} has invalid indentation (${indent} spaces)`);
    }
  }
  finishNested();
  return top;
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
    default:
      return 31;
  }
}

/** Exactly `YYYY-MM-DDTHH:MM:SS.sssZ` with a real Gregorian date/time. */
function isCanonicalTimestamp(value: string): boolean {
  const match = TIMESTAMP_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  return Number(match[4]) <= 23 && Number(match[5]) <= 59 && Number(match[6]) <= 59;
}

function envelopeToObject(map: Map<string, EnvelopeValue>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of map) {
    if (value instanceof Map) {
      const nestedOut: Record<string, unknown> = {};
      for (const [childKey, childValue] of value) nestedOut[childKey] = childValue;
      out[key] = nestedOut;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Depth of leading `>` quote prefixes on one line. */
function quotePrefixDepth(line: string): number {
  let depth = 0;
  let i = 0;
  while (line[i] === ">") {
    depth++;
    i++;
    if (line[i] === " ") i++;
  }
  return depth;
}

/**
 * True when the line contains a raw inline HTML tag outside inline code
 * spans: `<` immediately followed by a letter or `/`, except autolinks
 * whose scheme name is immediately followed by `:`.
 */
function hasRawInlineHtml(line: string): boolean {
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === "`") {
      let run = 0;
      while (line[i + run] === "`") run++;
      const close = line.indexOf("`".repeat(run), i + run);
      i = close === -1 ? i + run : close + run;
      continue;
    }
    if (ch === "<") {
      const next = line[i + 1];
      if (next === "/") return true;
      if (next !== undefined && /[A-Za-z]/.test(next)) {
        let j = i + 1;
        while (j < line.length && /[A-Za-z0-9+.-]/.test(line[j])) j++;
        if (line[j] !== ":") return true;
        i = j + 1;
        continue;
      }
    }
    i++;
  }
  return false;
}

function checkDjotBody(body: string): DiagnosticKind | null {
  const blockIds = new Set<string>();
  let fenceTicks = 0;
  for (const rawLine of body.split("\n")) {
    const line = stripCr(rawLine);
    if (fenceTicks > 0) {
      const closing = /^(`+)\s*$/.exec(line);
      if (closing && closing[1].length >= fenceTicks) fenceTicks = 0;
      continue;
    }
    if (quotePrefixDepth(line) > MAX_DJOT_CONTAINER_DEPTH) return "document_too_complex";
    const fence = /^(`{3,})(.*)$/.exec(line);
    if (fence) {
      fenceTicks = fence[1].length;
      if (fence[2].trim().startsWith("=html")) return "unsafe_content";
      continue;
    }
    for (const match of line.matchAll(/\{#(b-[^}\s]+)\}/g)) {
      if (blockIds.has(match[1])) return "duplicate_block_id";
      blockIds.add(match[1]);
    }
    if (hasRawInlineHtml(line)) return "unsafe_content";
  }
  return null;
}

const FORBIDDEN_HTML_ELEMENTS: Record<string, true> = {
  script: true,
  iframe: true,
  object: true,
  embed: true,
  applet: true,
  base: true,
  link: true,
};
const URL_ATTRS: Record<string, true> = {
  href: true,
  src: true,
  action: true,
  formaction: true,
  "xlink:href": true,
};
const UNSAFE_URL_RE = /^(?:javascript|vbscript):/i;
const EVENT_ATTR_RE = /^on[a-z]+$/i;

interface HtmlAttr {
  name: string;
  value: string;
}

/** Scan one tag's attributes up to the closing `>`, honoring quoted values. */
function scanHtmlAttributes(body: string, start: number): { list: HtmlAttr[]; nextIndex: number } {
  const list: HtmlAttr[] = [];
  let i = start;
  while (i < body.length) {
    while (i < body.length && /[\s/]/.test(body[i])) i++;
    if (i >= body.length || body[i] === ">") return { list, nextIndex: i + 1 };
    const nameMatch = /^[^\s=/>]+/.exec(body.slice(i));
    if (!nameMatch) {
      i++;
      continue;
    }
    const name = nameMatch[0].toLowerCase();
    i += name.length;
    let value = "";
    let j = i;
    while (j < body.length && /\s/.test(body[j])) j++;
    if (body[j] === "=") {
      j++;
      while (j < body.length && /\s/.test(body[j])) j++;
      const quote = body[j];
      if (quote === '"' || quote === "'") {
        const end = body.indexOf(quote, j + 1);
        value = end === -1 ? body.slice(j + 1) : body.slice(j + 1, end);
        j = end === -1 ? body.length : end + 1;
      } else {
        const valueMatch = /^[^\s>]*/.exec(body.slice(j));
        value = valueMatch ? valueMatch[0] : "";
        j += value.length;
      }
    }
    i = j;
    list.push({ name, value });
  }
  return { list, nextIndex: i };
}

function checkHtmlBody(body: string): DiagnosticKind | null {
  const blockIds = new Set<string>();
  let i = 0;
  while (i < body.length) {
    if (body.startsWith("<!--", i)) {
      const end = body.indexOf("-->", i + 4);
      i = end === -1 ? body.length : end + 3;
      continue;
    }
    if (body[i] !== "<") {
      i++;
      continue;
    }
    if (body[i + 1] === "!" || body[i + 1] === "?") {
      const end = body.indexOf(">", i);
      i = end === -1 ? body.length : end + 1;
      continue;
    }
    const isClosing = body[i + 1] === "/";
    const nameStart = i + (isClosing ? 2 : 1);
    const name = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(body.slice(nameStart))?.[0];
    if (!name) {
      i++;
      continue;
    }
    const tag = name.toLowerCase();
    const attrs = scanHtmlAttributes(body, nameStart + name.length);
    i = attrs.nextIndex;
    if (isClosing) continue;
    if (tag in FORBIDDEN_HTML_ELEMENTS) return "unsafe_content";
    if (tag === "meta" && attrs.list.some((a) => a.name === "http-equiv")) return "unsafe_content";
    for (const attr of attrs.list) {
      if (EVENT_ATTR_RE.test(attr.name)) return "unsafe_content";
      if (attr.name in URL_ATTRS && UNSAFE_URL_RE.test(attr.value.trim())) return "unsafe_content";
      if (attr.name === "id" && attr.value.startsWith("b-")) {
        if (blockIds.has(attr.value)) return "duplicate_block_id";
        blockIds.add(attr.value);
      }
    }
  }
  return null;
}

export function classify(ext: "djot" | "html", bytes: Uint8Array): Classification {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return invalid("invalid_transport", "document begins with a UTF-8 byte-order mark");
  }
  if (bytes.length > MAX_DOCUMENT_BYTES) {
    return invalid(
      "document_too_large",
      `document is ${bytes.length} bytes; the limit is ${MAX_DOCUMENT_BYTES}`,
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return invalid("invalid_transport", "document is not valid UTF-8");
  }

  const lines = text.split("\n");
  const transport = parseTransport(ext, lines);
  if ("legacy" in transport) return { kind: "legacy_html" };
  if (!transport.ok) return invalid(transport.diagnostic, transport.message);

  let envelope: Map<string, EnvelopeValue>;
  try {
    envelope = parseEnvelope(transport.envelopeLines);
  } catch (error) {
    if (error instanceof EnvelopeError) return invalid("invalid_envelope", error.message);
    throw error;
  }

  const profile = ext === "djot" ? PROFILE_DJOT : PROFILE_HTML;

  if (envelope.get("format") !== DOCUMENT_FORMAT) {
    return invalid(
      "unsupported_document_version",
      `unsupported format ${JSON.stringify(envelope.get("format") ?? null)}; expected "${DOCUMENT_FORMAT}"`,
    );
  }
  const declaredBody = envelope.get("body");
  if (declaredBody === (ext === "djot" ? PROFILE_HTML : PROFILE_DJOT)) {
    return invalid(
      "invalid_transport",
      `envelope body profile "${String(declaredBody)}" contradicts the ${ext} transport`,
    );
  }
  if (declaredBody !== profile) {
    return invalid(
      "unsupported_body_version",
      `unsupported body profile ${JSON.stringify(declaredBody ?? null)}`,
    );
  }

  for (const field of ["id", "created", "updated", "title"] as const) {
    if (!envelope.has(field)) return invalid("invalid_envelope", `missing required field "${field}"`);
  }

  const id = envelope.get("id");
  if (typeof id !== "string" || !UUID_RE.test(id)) {
    return invalid(
      "invalid_document_id",
      `document id ${JSON.stringify(id ?? null)} is not a canonical lowercase hyphenated UUID`,
    );
  }

  const created = envelope.get("created");
  if (typeof created !== "string" || !isCanonicalTimestamp(created)) {
    return invalid(
      "invalid_envelope",
      `created ${JSON.stringify(created ?? null)} is not a canonical UTC timestamp`,
    );
  }
  const updated = envelope.get("updated");
  if (typeof updated !== "string" || !isCanonicalTimestamp(updated)) {
    return invalid(
      "invalid_envelope",
      `updated ${JSON.stringify(updated ?? null)} is not a canonical UTC timestamp`,
    );
  }
  if (updated < created) {
    return invalid("invalid_envelope", `updated ${updated} precedes created ${created}`);
  }

  const deleted = envelope.get("deleted");
  if (deleted !== undefined && typeof deleted !== "boolean") {
    return invalid("invalid_envelope", '"deleted" must be a Boolean');
  }
  const deletedAt = envelope.get("deleted_at");
  if ((deleted === true) !== (deletedAt !== undefined)) {
    return invalid("invalid_envelope", '"deleted" and "deleted_at" must be present exactly together');
  }
  if (typeof deletedAt === "string" && !isCanonicalTimestamp(deletedAt)) {
    return invalid(
      "invalid_envelope",
      `deleted_at ${JSON.stringify(deletedAt)} is not a canonical UTC timestamp`,
    );
  }

  const body = lines.slice(transport.firstBodyLine).join("\n");
  const bodyDiagnostic = ext === "djot" ? checkDjotBody(body) : checkHtmlBody(body);
  if (bodyDiagnostic) {
    return invalid(bodyDiagnostic, `${bodyDiagnostic} in the ${ext} body`);
  }

  return { kind: "valid", profile, id, envelope: envelopeToObject(envelope) };
}
