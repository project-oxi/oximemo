/**
 * 조건 문장 (FilterSentence, 2026-11-11) — 쿼리 뷰에 걸린 필터를 결과 바로 위에
 * 한 문장으로 읽히게 만드는 순수 함수 모음. 화면(components/FilterSentence.tsx)과
 * 열 머리 꼬리표(TableView)가 같은 문장 조각을 쓴다.
 *
 * - 문장이 되는 것은 각 범위(쿼리 전체 · 이 뷰)의 맨 위 AND 아래에 있는 단순 조건
 *   (`cond`)뿐이다. 중첩 OR · NOT · 고급 식(`expr`)은 한 마디로 풀면 뜻이 틀어지기
 *   쉬워 「고급 조건 N」으로 접고, 지금 FilterBuilder 가 그대로 연다.
 * - 조건마다 범위와 경로를 들고 다닌다 — 문장에서 고친 조건은 그 조건이 온 범위에
 *   저장해야 한다. 다른 범위에 쓰면 「이 뷰」를 고쳤는데 다른 뷰까지 바뀐다.
 * - 문구는 템플릿(i18n)으로 받는다. 한국어 조사(이/가 · 으로/로 …)는 앞 글자의
 *   받침으로 고른다.
 */
import type { CondOp, FilterNode } from "./filterTree";

export type Scope = "base" | "view";
export type CondNode = Extract<FilterNode, { kind: "cond" }>;

export interface Clause {
  scope: Scope;
  /** 범위 뿌리 안의 자리: [] = 뿌리 자체가 조건, [i] = 맨 위 AND 의 i 번째. */
  path: number[];
  node: CondNode;
}

export interface AdvancedPart {
  scope: Scope;
  path: number[];
  node: FilterNode;
}

export interface SentenceModel {
  clauses: Clause[];
  advanced: AdvancedPart[];
}

/** 범위 뿌리를 맨 위 AND 기준 조각으로 편다. 뿌리가 AND 가 아니면 그 하나가 조각이다. */
export function topLevelParts(root: FilterNode | null): { path: number[]; node: FilterNode }[] {
  if (!root) return [];
  if (root.kind === "and") return root.children.map((node, i) => ({ path: [i], node }));
  return [{ path: [], node: root }];
}

/** 엔진이 실제로 거는 순서(쿼리 전체 AND 이 뷰)대로 문장 조각을 만든다. */
export function buildSentence(base: FilterNode | null, view: FilterNode | null): SentenceModel {
  const clauses: Clause[] = [];
  const advanced: AdvancedPart[] = [];
  for (const [scope, root] of [["base", base], ["view", view]] as const) {
    for (const { path, node } of topLevelParts(root)) {
      if (node.kind === "cond") clauses.push({ scope, path, node });
      else advanced.push({ scope, path, node });
    }
  }
  return { clauses, advanced };
}

/** 경로 자리의 조각을 바꾸거나(null 이면 지운다) 새 뿌리를 돌려준다. 하나만 남은
 *  AND 는 그 조각으로 접는다 — FilterBuilder 의 그룹 편집과 같은 규칙이라 두 편집기가
 *  같은 YAML 을 쓴다. */
export function replaceAt(root: FilterNode | null, path: number[], next: FilterNode | null): FilterNode | null {
  if (path.length === 0) return next;
  if (!root || root.kind !== "and") return root;
  const i = path[0];
  const children = root.children
    .map((c, idx) => (idx === i ? next : c))
    .filter((c): c is FilterNode => c !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return { kind: "and", children };
}

/** 맨 위 AND 에 조건 하나를 더한다. 뿌리가 AND 가 아니면 둘을 AND 로 묶는다. */
export function appendCond(root: FilterNode | null, cond: FilterNode): FilterNode {
  if (!root) return cond;
  if (root.kind === "and") return { kind: "and", children: [...root.children, cond] };
  return { kind: "and", children: [root, cond] };
}

// ---------------------------------------------------------------- 문구

/** 문장 템플릿. `{field}` · `{value}` 자리표와 조사 자리표(`{이/가}` 등)를 쓴다. */
export interface SentenceStrings {
  eq: string;
  ne: string;
  gt: string;
  gte: string;
  lt: string;
  lte: string;
  contains: string;
  startsWith: string;
  endsWith: string;
  empty: string;
  notEmpty: string;
  yes: string;
  no: string;
}

/** 열 머리 꼬리표 템플릿 (`{value}` 하나). */
export type TagStrings = Record<CondOp, string> & { empty: string; notEmpty: string };

export type PhrasePart = { kind: "text"; text: string } | { kind: "value"; text: string };

const OP_KEY: Record<CondOp, keyof SentenceStrings> = {
  "==": "eq", "!=": "ne", ">": "gt", ">=": "gte", "<": "lt", "<=": "lte",
  contains: "contains", startsWith: "startsWith", endsWith: "endsWith",
};

type Jong = "none" | "rieul" | "other";

/** 낱말 끝 글자의 받침 종류. 한글은 음절에서, 숫자는 읽는 소리(일 · 칠 · 팔 = ㄹ)에서,
 *  로마자는 l · m · n · ng 로 끝나면 받침으로 친다(「rating → 레이팅」 같은 읽기 어림 —
 *  「name → 네임」처럼 빗나가는 낱말도 있지만 조사 하나가 어색할 뿐 뜻은 그대로다). */
export function jongOf(word: string): Jong {
  const s = word.replace(/[\s"'”’)\]]+$/u, "");
  const ch = s.at(-1);
  if (!ch) return "none";
  const code = ch.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) {
    const jong = (code - 0xac00) % 28;
    return jong === 0 ? "none" : jong === 8 ? "rieul" : "other";
  }
  if (/[178]/.test(ch)) return "rieul";
  if (/[036]/.test(ch)) return "other";
  if (/[2459]/.test(ch)) return "none";
  const lower = ch.toLowerCase();
  if (lower === "l") return "rieul";
  if (lower === "m" || lower === "n" || /ng$/i.test(s)) return "other";
  return "none";
}

/** `이/가` 꼴 조사 짝에서 앞 낱말에 맞는 쪽. `으로/로` 는 ㄹ 받침에서도 「로」다. */
export function josa(word: string, pair: string): string {
  const [withJong, without] = pair.split("/");
  const jong = jongOf(word);
  if (withJong === "으로") return jong === "other" ? withJong : without;
  return jong === "none" ? without : withJong;
}

/** 조건 값의 화면 글자. 빈 값은 「비어 있음」, 참/거짓은 예/아니오, 태그는 # 를 붙인다. */
export function valueLabel(node: CondNode, s: Pick<SentenceStrings, "empty" | "notEmpty" | "yes" | "no">): string {
  const v = node.value;
  if (v === null) return node.op === "!=" ? s.notEmpty : s.empty;
  if (typeof v === "boolean") return v ? s.yes : s.no;
  const text = String(v);
  if (isTagIdent(node.ident) && text && !text.startsWith("#")) return `#${text}`;
  return text;
}

const isTagIdent = (ident: string) => ident === "tags" || ident === "file.tags" || ident === "note.tags";

const TOKEN_RE = /\{(field|value|[가-힣]+\/[가-힣]+)\}/g;

/** 템플릿을 글 조각과 값 조각으로 편다. 값 조각만 화면에서 누를 수 있는 단추가 된다. */
export function phraseClause(node: CondNode, s: SentenceStrings, field: string): PhrasePart[] {
  // 빈 값 검사는 연산자와 상관없이 「X가 비어 있음」 한 꼴이다 — 값 글자가 부정을 품는다.
  const template = node.value === null ? s.eq : s[OP_KEY[node.op]];
  const value = valueLabel(node, s);
  const parts: PhrasePart[] = [];
  let prev = "";
  const pushText = (text: string) => {
    if (!text) return;
    const last = parts.at(-1);
    if (last && last.kind === "text") last.text += text;
    else parts.push({ kind: "text", text });
  };
  let at = 0;
  for (const m of template.matchAll(TOKEN_RE)) {
    const lit = template.slice(at, m.index);
    pushText(lit);
    if (lit) prev = lit;
    const tok = m[1];
    if (tok === "field") {
      pushText(field);
      prev = field;
    } else if (tok === "value") {
      parts.push({ kind: "value", text: value });
      prev = value;
    } else {
      pushText(josa(prev, tok));
    }
    at = (m.index ?? 0) + m[0].length;
  }
  pushText(template.slice(at));
  return parts;
}

/** 열 머리 꼬리표 한 줄(예: 「≠ 완료」). */
export function conditionTag(node: CondNode, s: TagStrings & Pick<SentenceStrings, "yes" | "no">): string {
  if (node.value === null) return node.op === "!=" ? s.notEmpty : s.empty;
  return s[node.op].replace("{value}", valueLabel(node, s));
}

/** 조건 식별자 → TableView 열 id (BaseView 의 columnId 와 같은 꼴). 열로 보이지 않는
 *  `file.*` 핵심 필드는 null. */
export function columnIdOfIdent(ident: string): string | null {
  if (ident === "file.name") return "name";
  if (isTagIdent(ident)) return "tags";
  if (ident === "file.updated") return "updated";
  if (ident.startsWith("formula.") || ident.startsWith("task.")) return ident;
  if (ident.startsWith("file.")) return null;
  return ident.startsWith("note.") ? ident.slice("note.".length) : ident;
}

/** 열 id → 그 열에 걸린 조건 꼬리표들(「·」로 잇는다). 같은 열에 조건이 둘이면 둘 다 보인다. */
export function conditionTagsByColumn(
  clauses: Clause[],
  s: TagStrings & Pick<SentenceStrings, "yes" | "no">,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of clauses) {
    const id = columnIdOfIdent(c.node.ident);
    if (id === null) continue;
    const tag = conditionTag(c.node, s);
    out.set(id, out.has(id) ? `${out.get(id)} · ${tag}` : tag);
  }
  return out;
}

/** 필드 이름. 핵심 필드는 주어진 이름표로, 속성은 표시 이름(displayName) → 키 순서다. */
export function fieldLabelOf(
  ident: string,
  core: Record<string, string>,
  displayNames: Record<string, string | undefined>,
): string {
  if (core[ident]) return core[ident];
  if (ident === "tags" || ident === "note.tags") return core["file.tags"] ?? ident;
  const key = ident.startsWith("note.") ? ident.slice("note.".length) : ident;
  if (key.startsWith("formula.")) return displayNames[key.slice("formula.".length)] ?? key;
  return displayNames[key] ?? key;
}
