import { parseSafeYamlObject } from "./safe-yaml.js";
import { MarkdownContractError, type JsonObject, type JsonValue, type MarkdownDiagnostic } from "./types.js";
import { queryCapabilities } from "./generated/query-capabilities.js";

type Expr =
  | { kind: "literal"; value: unknown }
  | { kind: "ref"; namespace: "note" | "file" | "formula" | "values"; path: string[] }
  | { kind: "field"; target: Expr; name: string }
  | { kind: "call"; name: string; args: Expr[] }
  | { kind: "method"; target: Expr; name: string; args: Expr[] }
  | { kind: "unary"; operator: string; value: Expr }
  | { kind: "binary"; operator: string; left: Expr; right: Expr };

type Filter =
  | { kind: "expression"; expression: Expr }
  | { kind: "and" | "or"; items: Filter[] }
  | { kind: "not"; items: Filter[] };

interface QueryView {
  type: "table" | "list";
  name: string;
  limit?: number;
  groupBy?: { property: string; direction: "ASC" | "DESC" };
  filters?: Filter;
  order?: string[];
  summaries?: Record<string, string>;
}

interface QueryPlan {
  source: JsonObject;
  filters?: Filter;
  formulas: Record<string, Expr>;
  summaries: Record<string, Expr>;
  views: QueryView[];
}

export interface ParsedQuery {
  status: "valid" | "valid_unexecuted" | "invalid_query";
  source: string;
  document?: JsonObject;
  plan?: QueryPlan;
  diagnostic?: MarkdownDiagnostic;
}

export interface QueryDocument {
  id: string;
  path: string;
  envelope: JsonObject;
  body?: string;
  size?: number;
  ctime?: string;
  mtime?: string;
}

export interface QueryRow {
  id: string;
  path: string;
  title: string;
  values: Record<string, unknown>;
}

export interface QueryViewResult {
  name: string;
  type: "table" | "list";
  columns: string[];
  rows: QueryRow[];
  summaries: Record<string, unknown>;
}

export interface QueryEvaluation {
  status: "evaluated" | "valid_unexecuted" | "invalid_query";
  views: QueryViewResult[];
  diagnostic?: MarkdownDiagnostic;
}

interface Token {
  type: "identifier" | "number" | "string" | "operator" | "eof";
  value: string;
}

class UnsupportedQuery extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedQuery";
  }
}

function invalidQuery(source: string, error: unknown): ParsedQuery {
  const diagnostic = error instanceof MarkdownContractError
    ? { ...error.diagnostic, code: "invalid_query" as const }
    : { code: "invalid_query" as const, message: error instanceof Error ? error.message : "Query is invalid." };
  return { status: "invalid_query", source, diagnostic };
}

function unsupported(source: string, message: string, document?: JsonObject): ParsedQuery {
  return {
    status: "valid_unexecuted",
    source,
    ...(document ? { document } : {}),
    diagnostic: { code: "unsupported_query_construct", message },
  };
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) { index += 1; continue; }
    const two = source.slice(index, index + 2);
    if (["&&", "||", "==", "!=", "<=", ">="].includes(two)) {
      tokens.push({ type: "operator", value: two }); index += 2; continue;
    }
    if ("()+-*/%!.<>,[]".includes(char)) {
      tokens.push({ type: "operator", value: char }); index += 1; continue;
    }
    if (char === "'" || char === '"') {
      const quote = char;
      let cursor = index + 1;
      let value = "";
      while (cursor < source.length && source[cursor] !== quote) {
        if (source[cursor] === "\\") {
          cursor += 1;
          if (cursor >= source.length) throw new UnsupportedQuery("Expression ends inside a string escape.");
          const escaped = source[cursor++];
          const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
          value += escapes[escaped] ?? escaped;
        } else value += source[cursor++];
      }
      if (source[cursor] !== quote) throw new UnsupportedQuery("Expression contains an unclosed string.");
      tokens.push({ type: "string", value }); index = cursor + 1; continue;
    }
    const number = source.slice(index).match(/^(?:\d+\.\d+|\d+|\.\d+)(?:[eE][+-]?\d+)?/);
    if (number) {
      if (!Number.isFinite(Number(number[0]))) throw new UnsupportedQuery("Only finite numeric literals are supported.");
      tokens.push({ type: "number", value: number[0] }); index += number[0].length; continue;
    }
    const identifier = source.slice(index).match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
    if (identifier) { tokens.push({ type: "identifier", value: identifier[0] }); index += identifier[0].length; continue; }
    throw new UnsupportedQuery(`Unsupported expression character ${JSON.stringify(char)}.`);
  }
  tokens.push({ type: "eof", value: "" });
  return tokens;
}

const PRECEDENCE: Record<string, number> = queryCapabilities.expression.operators;

class ExpressionParser {
  private index = 0;
  private readonly tokens: Token[];

  constructor(source: string) { this.tokens = tokenize(source); }

  private current(): Token { return this.tokens[this.index]; }
  private accept(value: string): boolean {
    if (this.current().value !== value) return false;
    this.index += 1;
    return true;
  }
  private expect(value: string): void {
    if (!this.accept(value)) throw new UnsupportedQuery(`Expected ${JSON.stringify(value)} in Bases expression.`);
  }

  parse(): Expr {
    const result = this.expression(0);
    if (this.current().type !== "eof") throw new UnsupportedQuery(`Unsupported Bases expression near ${JSON.stringify(this.current().value)}.`);
    return result;
  }

  private expression(minimum: number): Expr {
    let left = this.prefix();
    while (true) {
      const operator = this.current().value;
      const precedence = PRECEDENCE[operator];
      if (precedence === undefined || precedence < minimum) break;
      this.index += 1;
      const right = this.expression(precedence + 1);
      left = { kind: "binary", operator, left, right };
    }
    return left;
  }

  private prefix(): Expr {
    const token = this.current();
    if ((queryCapabilities.expression.unaryOperators as readonly string[]).includes(token.value)) {
      this.index += 1;
      return { kind: "unary", operator: token.value, value: this.expression(7) };
    }
    if (this.accept("(")) {
      const inner = this.expression(0);
      this.expect(")");
      return this.postfix(inner);
    }
    if (token.type === "string") { this.index += 1; return { kind: "literal", value: token.value }; }
    if (token.type === "number") { this.index += 1; return { kind: "literal", value: Number(token.value) }; }
    if (token.type !== "identifier") throw new UnsupportedQuery(`Expected a value in Bases expression, received ${JSON.stringify(token.value)}.`);
    this.index += 1;
    if (token.value === "true") return { kind: "literal", value: true };
    if (token.value === "false") return { kind: "literal", value: false };
    if (token.value === "null") return { kind: "literal", value: null };
    if (this.accept("(")) return this.call(token.value, []);
    const namespace = (queryCapabilities.expression.namespaces as readonly string[]).includes(token.value)
      ? token.value as "note" | "file" | "formula" | "values"
      : "note";
    const first = namespace === "note" && token.value !== "note" ? token.value : "";
    const result: Expr = { kind: "ref", namespace, path: first ? [first] : [] };
    return this.postfix(result);
  }

  private postfix(target: Expr): Expr {
    let result = target;
    while (true) {
      if (this.accept(".")) {
        const name = this.current();
        if (name.type !== "identifier") throw new UnsupportedQuery("Expected a field or method name after `.`.");
        this.index += 1;
        if (this.accept("(")) result = this.call(name.value, [result]);
        else if (result.kind === "ref" && result.path.length === 0 && result.namespace !== "values") {
          result = { kind: "ref", namespace: result.namespace, path: [name.value] };
        } else result = { kind: "field", target: result, name: name.value };
        continue;
      }
      if (this.accept("[")) {
        const key = this.current();
        if (key.type !== "string") throw new UnsupportedQuery("Computed property references must use a string literal key.");
        this.index += 1;
        this.expect("]");
        if (result.kind !== "ref" || result.namespace === "values") throw new UnsupportedQuery("Bracket property references must target note, file, or formula properties.");
        result = { kind: "ref", namespace: result.namespace, path: [...result.path, key.value] };
        continue;
      }
      break;
    }
    return result;
  }

  private call(name: string, prefixArgs: Expr[]): Expr {
    const args = [...prefixArgs];
    if (this.current().value !== ")") {
      do { args.push(this.expression(0)); } while (this.accept(","));
    }
    this.expect(")");
    if (prefixArgs.length) return { kind: "method", target: prefixArgs[0], name, args: args.slice(1) };
    return { kind: "call", name, args };
  }
}

function compileExpression(source: string): Expr {
  return new ExpressionParser(source).parse();
}

function compileFilter(value: JsonValue): Filter {
  if (typeof value === "string") return { kind: "expression", expression: compileExpression(value) };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Filter must be an expression string or logical mapping.");
  const keys = Object.keys(value);
  if (keys.length !== 1 || !(queryCapabilities.filterOperators as readonly string[]).includes(keys[0])) throw new UnsupportedQuery("Unknown Bases filter operator.");
  const operator = keys[0] as "and" | "or" | "not";
  const children = value[operator];
  if (!Array.isArray(children)) throw new Error(`Filter ${operator} must contain a sequence.`);
  const items = children.map((item) => compileFilter(item));
  if (operator === "not") return { kind: "not", items };
  return { kind: operator, items };
}

function isObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  return value;
}

function formulaReferences(expression: Expr, out: string[] = []): string[] {
  if (expression.kind === "ref" && expression.namespace === "formula" && expression.path[0]) out.push(expression.path[0]);
  if (expression.kind === "field") formulaReferences(expression.target, out);
  if (expression.kind === "method") { formulaReferences(expression.target, out); expression.args.forEach((item) => formulaReferences(item, out)); }
  if (expression.kind === "call") expression.args.forEach((item) => formulaReferences(item, out));
  if (expression.kind === "unary") formulaReferences(expression.value, out);
  if (expression.kind === "binary") { formulaReferences(expression.left, out); formulaReferences(expression.right, out); }
  return out;
}

function parsePlan(source: string, document: JsonObject): QueryPlan {
  const unknown = Object.keys(document).filter((key) => !(queryCapabilities.topLevelKeys as readonly string[]).includes(key));
  if (unknown.length) throw new UnsupportedQuery(`Unknown query key(s): ${unknown.join(", ")}.`);
  const formulas: Record<string, Expr> = {};
  const summaries: Record<string, Expr> = {};
  let filters: Filter | undefined;
  if (document.filters !== undefined) filters = compileFilter(document.filters);
  if (document.formulas !== undefined) {
    if (!isObject(document.formulas)) throw new Error("formulas must be a mapping of names to expressions.");
    for (const [name, expression] of Object.entries(document.formulas)) formulas[name] = compileExpression(requireString(expression, `formulas.${name}`));
  }
  if (document.summaries !== undefined) {
    if (!isObject(document.summaries)) throw new Error("summaries must be a mapping of names to expressions.");
    for (const [name, expression] of Object.entries(document.summaries)) summaries[name] = compileExpression(requireString(expression, `summaries.${name}`));
  }
  if (document.properties !== undefined) {
    if (!isObject(document.properties)) throw new Error("properties must be a mapping.");
    for (const [key, config] of Object.entries(document.properties)) {
      if (!isObject(config)) throw new Error(`properties.${key} must be a mapping.`);
      if (config.displayName !== undefined && typeof config.displayName !== "string") throw new Error(`properties.${key}.displayName must be a string.`);
    }
  }
  const formulaState = new Map<string, 0 | 1 | 2>();
  const visitFormula = (name: string): void => {
    const state = formulaState.get(name) ?? 0;
    if (state === 1) throw new UnsupportedQuery(`Circular formula dependency includes ${name}.`);
    if (state === 2 || !formulas[name]) return;
    formulaState.set(name, 1);
    for (const dependency of formulaReferences(formulas[name])) visitFormula(dependency);
    formulaState.set(name, 2);
  };
  for (const name of Object.keys(formulas)) visitFormula(name);

  const views: QueryView[] = [];
  if (document.views !== undefined) {
    if (!Array.isArray(document.views)) throw new Error("views must be a sequence.");
    for (const [index, value] of document.views.entries()) {
      if (!isObject(value)) throw new Error(`views[${index}] must be a mapping.`);
      const unknownViewKeys = Object.keys(value).filter((key) => !(queryCapabilities.viewKeys as readonly string[]).includes(key));
      if (unknownViewKeys.length) throw new UnsupportedQuery(`Unknown view key(s): ${unknownViewKeys.join(", ")}.`);
      if (!(queryCapabilities.viewTypes as readonly unknown[]).includes(value.type)) throw new UnsupportedQuery(`View type ${JSON.stringify(value.type)} is not in the portable Bases subset.`);
      const name = requireString(value.name, `views[${index}].name`);
      const view: QueryView = { type: value.type as "table" | "list", name };
      if (value.limit !== undefined) {
        if (typeof value.limit !== "number" || !Number.isInteger(value.limit) || value.limit < 0) throw new Error(`views[${index}].limit must be a non-negative integer.`);
        view.limit = value.limit;
      }
      if (value.filters !== undefined) view.filters = compileFilter(value.filters);
      if (value.order !== undefined) {
        if (!Array.isArray(value.order) || value.order.some((item) => typeof item !== "string")) throw new Error(`views[${index}].order must be a sequence of property references.`);
        view.order = value.order as string[];
      }
      if (value.groupBy !== undefined) {
        if (!isObject(value.groupBy) || typeof value.groupBy.property !== "string" || (value.groupBy.direction !== "ASC" && value.groupBy.direction !== "DESC")) throw new Error(`views[${index}].groupBy must contain property and ASC/DESC direction.`);
        view.groupBy = { property: value.groupBy.property, direction: value.groupBy.direction };
        if ((queryCapabilities.unexecutedViewKeys as readonly string[]).includes("groupBy")) {
          throw new UnsupportedQuery("groupBy is recognized but is outside the current result projection.");
        }
      }
      if (value.summaries !== undefined) {
        if (!isObject(value.summaries) || Object.values(value.summaries).some((item) => typeof item !== "string")) throw new Error(`views[${index}].summaries must map property references to summary names.`);
        view.summaries = value.summaries as Record<string, string>;
        for (const summaryName of Object.values(view.summaries)) {
          if (!summaries[summaryName] && !(queryCapabilities.expression.summaryNames as readonly string[]).includes(summaryName)) {
            throw new UnsupportedQuery(`Summary ${JSON.stringify(summaryName)} is outside the portable Bases subset.`);
          }
        }
      }
      views.push(view);
    }
  }
  for (const expression of [...Object.values(formulas), ...Object.values(summaries)]) assertSupportedExpression(expression);
  if (filters) assertSupportedFilter(filters);
  for (const view of views) if (view.filters) assertSupportedFilter(view.filters);
  return { source: document, filters, formulas, summaries, views };
}

function assertSupportedExpression(expression: Expr): void {
  switch (expression.kind) {
    case "literal": return;
    case "ref":
      if (expression.namespace === "file" && expression.path.length && !(queryCapabilities.expression.fileProperties as readonly string[]).includes(expression.path[0])) {
        throw new UnsupportedQuery(`Unknown file property ${JSON.stringify(expression.path[0])}.`);
      }
      return;
    case "field": assertSupportedExpression(expression.target); return;
    case "unary": assertSupportedExpression(expression.value); return;
    case "binary": assertSupportedExpression(expression.left); assertSupportedExpression(expression.right); return;
    case "call":
      if (!(queryCapabilities.expression.functions as readonly string[]).includes(expression.name)) {
        throw new UnsupportedQuery(`Function ${JSON.stringify(expression.name)} is outside the portable Bases subset.`);
      }
      expression.args.forEach(assertSupportedExpression);
      return;
    case "method": {
      const filePredicate = (queryCapabilities.expression.filePredicates as readonly string[]).includes(expression.name);
      const fileReceiver = expression.target.kind === "ref" && expression.target.namespace === "file" && expression.target.path.length === 0;
      if (!(queryCapabilities.expression.methods as readonly string[]).includes(expression.name) || (filePredicate && !fileReceiver)) {
        throw new UnsupportedQuery(`Method ${JSON.stringify(expression.name)} is outside the portable Bases subset for this receiver.`);
      }
      assertSupportedExpression(expression.target);
      expression.args.forEach(assertSupportedExpression);
    }
  }
}

function assertSupportedFilter(filter: Filter): void {
  switch (filter.kind) {
    case "expression": assertSupportedExpression(filter.expression); return;
    case "and":
    case "or":
    case "not": filter.items.forEach(assertSupportedFilter); return;
  }
}

export function parseQuery(source: string, options: { inline?: boolean } = {}): ParsedQuery {
  try {
    if (source.startsWith("\uFEFF")) throw new MarkdownContractError({ code: "invalid_query", message: "Query cannot start with a UTF-8 byte-order mark." });
    if (new TextEncoder().encode(source).length > 1024 * 1024) throw new MarkdownContractError({ code: "invalid_query", message: "Query exceeds the 1 MiB transport limit." });
    if (!options.inline && source.includes("\r")) throw new MarkdownContractError({ code: "invalid_query", message: "`.base` files must use LF line endings." });
    const document = parseSafeYamlObject(source, "invalid_query").value;
    const plan = parsePlan(source, document);
    return { status: "valid", source, document, plan };
  } catch (error) {
    if (error instanceof UnsupportedQuery) return unsupported(source, error.message);
    return invalidQuery(source, error);
  }
}

interface EvalContext {
  document: QueryDocument;
  formulas: Record<string, Expr>;
  formulaCache: Map<string, unknown>;
  formulaStack: Set<string>;
  values?: unknown[];
}

function basename(path: string): string { return path.split("/").at(-1) ?? path; }
function withoutExtension(name: string): string { return name.replace(/\.[^.]+$/, ""); }

function property(document: QueryDocument, name: string): unknown {
  return document.envelope[name] ?? null;
}

function fileProperty(context: EvalContext, name: string): unknown {
  const { document } = context;
  const nameWithExtension = basename(document.path);
  const folder = document.path.includes("/") ? document.path.slice(0, document.path.lastIndexOf("/")) : "";
  const ext = nameWithExtension.includes(".") ? nameWithExtension.slice(nameWithExtension.lastIndexOf(".") + 1) : "";
  const links = [...(document.body ?? "").matchAll(/\[[^\]]*\]\(([^)]+)\)|\[\[([^\]]+)\]\]/g)].map((match) => match[1] ?? match[2].split(/[|#]/)[0]);
  const embeds = [...(document.body ?? "").matchAll(/!\[\[([^\]]+)\]\]/g)].map((match) => match[1].split(/[|#]/)[0]);
  const fields: Record<string, unknown> = {
    name: withoutExtension(nameWithExtension),
    path: document.path,
    folder,
    ext,
    size: document.size ?? null,
    ctime: document.ctime ?? null,
    mtime: document.mtime ?? null,
    tags: Array.isArray(document.envelope.tags) ? document.envelope.tags : [],
    links,
    embeds,
    properties: document.envelope,
  };
  if (!(name in fields)) throw new UnsupportedQuery(`Unknown file property ${JSON.stringify(name)}.`);
  return fields[name];
}

function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

function evalExpr(expression: Expr, context: EvalContext): unknown {
  switch (expression.kind) {
    case "literal": return expression.value;
    case "ref": {
      let value: unknown;
      if (expression.namespace === "values") value = context.values ?? [];
      else if (expression.namespace === "file") value = expression.path.length ? fileProperty(context, expression.path[0]) : null;
      else if (expression.namespace === "formula") {
        const name = expression.path[0];
        if (!name || !context.formulas[name]) return null;
        if (context.formulaCache.has(name)) value = context.formulaCache.get(name);
        else {
          if (context.formulaStack.has(name)) throw new UnsupportedQuery(`Circular formula evaluation at ${name}.`);
          context.formulaStack.add(name);
          value = evalExpr(context.formulas[name], context);
          context.formulaStack.delete(name);
          context.formulaCache.set(name, value);
        }
      } else value = property(context.document, expression.path[0] ?? "");
      for (const key of expression.path.slice(1)) value = value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] ?? null : null;
      return value;
    }
    case "field": {
      const target = evalExpr(expression.target, context);
      if (expression.name === "length" && (typeof target === "string" || Array.isArray(target))) return target.length;
      if (target !== null && typeof target === "object" && !Array.isArray(target)) return (target as Record<string, unknown>)[expression.name] ?? null;
      return null;
    }
    case "unary": {
      const value = evalExpr(expression.value, context);
      if (expression.operator === "!") return !truthy(value);
      if (typeof value !== "number") return null;
      return expression.operator === "-" ? -value : value;
    }
    case "binary": {
      const left = evalExpr(expression.left, context);
      if (expression.operator === "&&") return truthy(left) && truthy(evalExpr(expression.right, context));
      if (expression.operator === "||") return truthy(left) || truthy(evalExpr(expression.right, context));
      const right = evalExpr(expression.right, context);
      switch (expression.operator) {
        case "==": return equal(left, right);
        case "!=": return !equal(left, right);
        case "+": return typeof left === "number" && typeof right === "number" ? left + right : typeof left === "string" && typeof right === "string" ? left + right : null;
        case "-": return typeof left === "number" && typeof right === "number" ? left - right : null;
        case "*": return typeof left === "number" && typeof right === "number" ? left * right : null;
        case "/": return typeof left === "number" && typeof right === "number" && right !== 0 ? left / right : null;
        case "%": return typeof left === "number" && typeof right === "number" && right !== 0 ? left % right : null;
        case "<": return (typeof left === "number" && typeof right === "number") ? left < right : (typeof left === "string" && typeof right === "string") ? left < right : false;
        case "<=": return (typeof left === "number" && typeof right === "number") ? left <= right : (typeof left === "string" && typeof right === "string") ? left <= right : false;
        case ">": return (typeof left === "number" && typeof right === "number") ? left > right : (typeof left === "string" && typeof right === "string") ? left > right : false;
        case ">=": return (typeof left === "number" && typeof right === "number") ? left >= right : (typeof left === "string" && typeof right === "string") ? left >= right : false;
        default: return null;
      }
    }
    case "call": {
      const args = expression.args.map((item) => evalExpr(item, context));
      switch (expression.name) {
        case "if": return args.length === 3 ? (truthy(args[0]) ? args[1] : args[2]) : null;
        case "list": return args.length === 1 ? (Array.isArray(args[0]) ? args[0] : [args[0]]) : null;
        case "min": return args.length && args.every((item) => typeof item === "number") ? Math.min(...args as number[]) : null;
        case "max": return args.length && args.every((item) => typeof item === "number") ? Math.max(...args as number[]) : null;
        case "number": {
          if (args.length !== 1) return null;
          const number = typeof args[0] === "number" ? args[0] : typeof args[0] === "string" && args[0].trim() ? Number(args[0]) : NaN;
          return Number.isFinite(number) ? number : null;
        }
        default: throw new UnsupportedQuery(`Function ${JSON.stringify(expression.name)} is outside the portable Bases subset.`);
      }
    }
    case "method": {
      const receiver = evalExpr(expression.target, context);
      const args = expression.args.map((item) => evalExpr(item, context));
      const name = expression.name;
      if (expression.target.kind === "ref" && expression.target.namespace === "file") {
        if (name === "hasTag") return Array.isArray(fileProperty(context, "tags")) && (fileProperty(context, "tags") as unknown[]).includes(args[0]);
        if (name === "hasLink") return Array.isArray(fileProperty(context, "links")) && (fileProperty(context, "links") as unknown[]).includes(args[0]);
        if (name === "inFolder") return String(fileProperty(context, "folder") ?? "") === args[0] || String(fileProperty(context, "path") ?? "").startsWith(`${args[0]}/`);
      }
      switch (name) {
        case "isEmpty": return receiver === null || receiver === undefined || receiver === "" || (Array.isArray(receiver) && receiver.length === 0);
        case "isTruthy": return truthy(receiver);
        case "isType": return args.length === 1 && typeof args[0] === "string" && (args[0] === "null" ? receiver === null : args[0] === "array" ? Array.isArray(receiver) : typeof receiver === args[0]);
        case "toString": return receiver === null ? "null" : typeof receiver === "string" ? receiver : JSON.stringify(receiver);
        case "contains": return typeof receiver === "string" && typeof args[0] === "string" ? receiver.includes(args[0]) : Array.isArray(receiver) ? receiver.some((item) => equal(item, args[0])) : false;
        case "containsAll": return Array.isArray(receiver) && Array.isArray(args[0]) ? args[0].every((item) => receiver.some((entry) => equal(entry, item))) : false;
        case "containsAny": return Array.isArray(receiver) && Array.isArray(args[0]) ? args[0].some((item) => receiver.some((entry) => equal(entry, item))) : false;
        case "startsWith": return typeof receiver === "string" && typeof args[0] === "string" && receiver.startsWith(args[0]);
        case "endsWith": return typeof receiver === "string" && typeof args[0] === "string" && receiver.endsWith(args[0]);
        case "lower": return typeof receiver === "string" ? receiver.toLowerCase() : null;
        case "trim": return typeof receiver === "string" ? receiver.trim() : null;
        case "abs": return typeof receiver === "number" ? Math.abs(receiver) : null;
        case "ceil": return typeof receiver === "number" ? Math.ceil(receiver) : null;
        case "floor": return typeof receiver === "number" ? Math.floor(receiver) : null;
        case "round": return typeof receiver === "number" ? Number(receiver.toFixed(typeof args[0] === "number" ? Math.max(0, Math.min(100, Math.trunc(args[0]))) : 0)) : null;
        case "toFixed": return typeof receiver === "number" ? receiver.toFixed(typeof args[0] === "number" ? Math.max(0, Math.min(100, Math.trunc(args[0]))) : 0) : null;
        case "sum": return Array.isArray(receiver) && receiver.every((item) => typeof item === "number") ? receiver.reduce((sum, item) => sum + item, 0) : null;
        case "mean": return Array.isArray(receiver) && receiver.length && receiver.every((item) => typeof item === "number") ? receiver.reduce((sum, item) => sum + item, 0) / receiver.length : null;
        case "min": return Array.isArray(receiver) && receiver.every((item) => typeof item === "number") ? Math.min(...receiver as number[]) : null;
        case "max": return Array.isArray(receiver) && receiver.every((item) => typeof item === "number") ? Math.max(...receiver as number[]) : null;
        case "unique": return Array.isArray(receiver) ? receiver.filter((item, index) => receiver.findIndex((candidate) => equal(candidate, item)) === index) : null;
        default: throw new UnsupportedQuery(`Method ${JSON.stringify(name)} is outside the portable Bases subset.`);
      }
    }
  }
}

function evalFilter(filter: Filter | undefined, context: EvalContext): boolean {
  if (!filter) return true;
  switch (filter.kind) {
    case "expression": return truthy(evalExpr(filter.expression, context));
    case "and": return filter.items.every((item) => evalFilter(item, context));
    case "or": return filter.items.some((item) => evalFilter(item, context));
    case "not": return !filter.items.every((item) => evalFilter(item, context));
  }
}

function referenceValue(reference: string, context: EvalContext): unknown {
  if (reference.startsWith("file.")) return fileProperty(context, reference.slice(5));
  if (reference.startsWith("formula.")) return evalExpr({ kind: "ref", namespace: "formula", path: [reference.slice(8)] }, context);
  if (reference.startsWith("note.")) return property(context.document, reference.slice(5));
  return property(context.document, reference);
}

function summarise(values: unknown[], name: string): unknown {
  const filled = values.filter((item) => item !== null && item !== undefined && item !== "");
  const numbers = values.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
  switch (name) {
    case "Average": return numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : null;
    case "Min": return numbers.length ? Math.min(...numbers) : null;
    case "Max": return numbers.length ? Math.max(...numbers) : null;
    case "Sum": return numbers.reduce((a, b) => a + b, 0);
    case "Range": return numbers.length ? Math.max(...numbers) - Math.min(...numbers) : null;
    case "Median": {
      const sorted = [...numbers].sort((a, b) => a - b);
      if (!sorted.length) return null;
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    }
    case "Stddev": {
      if (!numbers.length) return null;
      const mean = numbers.reduce((a, b) => a + b, 0) / numbers.length;
      return Math.sqrt(numbers.reduce((sum, item) => sum + (item - mean) ** 2, 0) / numbers.length);
    }
    case "Earliest": return values.filter((item) => typeof item === "string").sort()[0] ?? null;
    case "Latest": return values.filter((item) => typeof item === "string").sort().at(-1) ?? null;
    case "Checked": return values.filter((item) => item === true || item === "x" || item === "X").length;
    case "Unchecked": return values.filter((item) => item === false || item === " ").length;
    case "Empty": return values.filter((item) => item === null || item === undefined || item === "").length;
    case "Filled": return filled.length;
    case "Unique": return values.filter((item, index) => values.findIndex((other) => equal(other, item)) === index).length;
    default: return null;
  }
}

export function evaluateQuery(query: ParsedQuery, documents: QueryDocument[]): QueryEvaluation {
  if (query.status === "invalid_query") return { status: "invalid_query", views: [], diagnostic: query.diagnostic };
  if (query.status !== "valid" || !query.plan) return { status: "valid_unexecuted", views: [], diagnostic: query.diagnostic };
  try {
    const { plan } = query;
    const matching = documents.filter((document) => {
      const context: EvalContext = { document, formulas: plan.formulas, formulaCache: new Map(), formulaStack: new Set() };
      return evalFilter(plan.filters, context);
    });
    const views = (plan.views.length ? plan.views : [{ name: "Results", type: "table" as const }]).map((view) => {
      let rows = matching.filter((document) => {
        const context: EvalContext = { document, formulas: plan.formulas, formulaCache: new Map(), formulaStack: new Set() };
        return evalFilter(view.filters, context);
      });
      if (view.limit !== undefined) rows = rows.slice(0, view.limit);
      const columns = view.order ?? ["note.title"];
      const outputRows = rows.map((document) => {
        const context: EvalContext = { document, formulas: plan.formulas, formulaCache: new Map(), formulaStack: new Set() };
        const values = Object.fromEntries(columns.map((column) => [column, referenceValue(column, context)]));
        return { id: document.id, path: document.path, title: String(document.envelope.title ?? ""), values };
      });
      const summaries: Record<string, unknown> = {};
      for (const [propertyName, summaryName] of Object.entries(view.summaries ?? {})) {
        const values = rows.map((document) => referenceValue(propertyName, { document, formulas: plan.formulas, formulaCache: new Map(), formulaStack: new Set() }));
        const custom = plan.summaries[summaryName];
        if (custom) {
          const summaryDocument = rows[0] ?? { id: "", path: "", envelope: {} as QueryDocument["envelope"] };
          summaries[propertyName] = evalExpr(custom, { document: summaryDocument, formulas: plan.formulas, formulaCache: new Map(), formulaStack: new Set(), values });
        }
        else summaries[propertyName] = summarise(values, summaryName);
      }
      return { name: view.name, type: view.type, columns: [...columns], rows: outputRows, summaries };
    });
    return { status: "evaluated", views };
  } catch (error) {
    if (error instanceof UnsupportedQuery) return { status: "valid_unexecuted", views: [], diagnostic: { code: "unsupported_query_construct", message: error.message } };
    return { status: "valid_unexecuted", views: [], diagnostic: { code: "unsupported_query_construct", message: error instanceof Error ? error.message : "Query evaluation was not completed." } };
  }
}
