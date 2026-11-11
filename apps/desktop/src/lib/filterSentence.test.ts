import { describe, expect, test } from "bun:test";
import {
  appendCond, buildSentence, columnIdOfIdent, conditionTag, conditionTagsByColumn, fieldLabelOf,
  josa, jongOf, phraseClause, replaceAt, type CondNode, type SentenceStrings, type TagStrings,
} from "./filterSentence";
import { parseFilters, type FilterNode } from "./filterTree";

const ko: SentenceStrings = {
  eq: "{field}{이/가} {value}",
  ne: "{field}{이/가} {value} 아님",
  gt: "{field}{이/가} {value} 초과",
  gte: "{field}{이/가} {value} 이상",
  lt: "{field}{이/가} {value} 미만",
  lte: "{field}{이/가} {value} 이하",
  contains: "{field}에 {value}",
  startsWith: "{field}{이/가} {value}{으로/로} 시작",
  endsWith: "{field}{이/가} {value}{으로/로} 끝남",
  empty: "비어 있음",
  notEmpty: "비어 있지 않음",
  yes: "예",
  no: "아니오",
};
const en: SentenceStrings = {
  eq: "{field} is {value}",
  ne: "{field} is not {value}",
  gt: "{field} > {value}",
  gte: "{field} ≥ {value}",
  lt: "{field} < {value}",
  lte: "{field} ≤ {value}",
  contains: "{field} has {value}",
  startsWith: "{field} starts with {value}",
  endsWith: "{field} ends with {value}",
  empty: "empty",
  notEmpty: "not empty",
  yes: "yes",
  no: "no",
};
const tags: TagStrings & { yes: string; no: string } = {
  "==": "= {value}", "!=": "≠ {value}", ">": "> {value}", ">=": "≥ {value}", "<": "< {value}", "<=": "≤ {value}",
  contains: "포함 {value}", startsWith: "{value}…", endsWith: "…{value}",
  empty: "비어 있음", notEmpty: "비어 있지 않음", yes: "예", no: "아니오",
};

const cond = (ident: string, op: CondNode["op"], value: CondNode["value"]): CondNode => ({ kind: "cond", ident, op, value });
const text = (parts: { text: string }[]) => parts.map((p) => p.text).join("");

describe("josa (받침으로 조사 고르기)", () => {
  test("한글 · ㄹ 받침 · 숫자 · 로마자", () => {
    expect(josa("폴더", "이/가")).toBe("가");
    expect(josa("상태", "이/가")).toBe("가");
    expect(josa("이름", "이/가")).toBe("이");
    expect(josa("파일", "으로/로")).toBe("로");
    expect(josa("책", "으로/로")).toBe("으로");
    expect(josa("2026", "이/가")).toBe("이");
    expect(josa("2025", "이/가")).toBe("가");
    expect(josa("status", "이/가")).toBe("가");
    expect(jongOf("rating")).toBe("other");
    expect(jongOf("name")).toBe("none");
    expect(jongOf("item")).toBe("other");
    expect(jongOf("")).toBe("none");
  });
});

describe("phraseClause", () => {
  test("목업 문장: 폴더가 책 · 상태가 완료 아님 · 태그에 #2026", () => {
    expect(text(phraseClause(cond("file.folder", "==", "책"), ko, "폴더"))).toBe("폴더가 책");
    expect(text(phraseClause(cond("status", "!=", "완료"), ko, "상태"))).toBe("상태가 완료 아님");
    expect(text(phraseClause(cond("file.tags", "contains", "2026"), ko, "태그"))).toBe("태그에 #2026");
  });

  test("값만 값 조각이고 나머지는 하나의 글 조각으로 붙는다", () => {
    expect(phraseClause(cond("status", "!=", "완료"), ko, "상태")).toEqual([
      { kind: "text", text: "상태가 " },
      { kind: "value", text: "완료" },
      { kind: "text", text: " 아님" },
    ]);
  });

  test("값 뒤 조사는 값 글자로 고른다", () => {
    expect(text(phraseClause(cond("file.name", "startsWith", "회의"), ko, "이름"))).toBe("이름이 회의로 시작");
    expect(text(phraseClause(cond("file.name", "endsWith", "책"), ko, "이름"))).toBe("이름이 책으로 끝남");
  });

  test("빈 값 · 참거짓 · 숫자", () => {
    expect(text(phraseClause(cond("due", "==", null), ko, "기한"))).toBe("기한이 비어 있음");
    expect(text(phraseClause(cond("due", "!=", null), ko, "기한"))).toBe("기한이 비어 있지 않음");
    expect(text(phraseClause(cond("file.favorite", "==", true), ko, "즐겨찾기"))).toBe("즐겨찾기가 예");
    expect(text(phraseClause(cond("rating", ">=", 4), ko, "rating"))).toBe("rating이 4 이상");
  });

  test("영어 템플릿", () => {
    expect(text(phraseClause(cond("status", "!=", "done"), en, "status"))).toBe("status is not done");
    expect(text(phraseClause(cond("due", "==", null), en, "due"))).toBe("due is empty");
  });
});

describe("buildSentence (범위별 맨 위 AND 만 문장으로)", () => {
  test("쿼리 전체 다음 이 뷰 순서, 범위와 경로를 기억한다", () => {
    const base = parseFilters({ and: ['file.folder == "책"', 'status != "완료"'] });
    const view = parseFilters('contains(file.tags, "2026")');
    const m = buildSentence(base, view);
    expect(m.clauses.map((c) => [c.scope, c.path, c.node.ident])).toEqual([
      ["base", [0], "file.folder"],
      ["base", [1], "status"],
      ["view", [], "file.tags"],
    ]);
    expect(m.advanced).toEqual([]);
  });

  test("OR · NOT · 고급 식은 고급 조건으로 접힌다", () => {
    const view = parseFilters({
      and: ['status == "a"', { or: ['x == 1', 'y == 2'] }, { not: 'z == 3' }, "(now() - file.created).days() > 7"],
    });
    const m = buildSentence(null, view);
    expect(m.clauses.length).toBe(1);
    expect(m.advanced.map((a) => a.path)).toEqual([[1], [2], [3]]);
    // 뿌리가 OR 이면 통째로 고급 조건 하나.
    expect(buildSentence(parseFilters({ or: ["a == 1", "b == 2"] }), null).advanced.length).toBe(1);
  });

  test("필터가 없으면 빈 문장", () => {
    expect(buildSentence(null, null)).toEqual({ clauses: [], advanced: [] });
  });
});

describe("replaceAt / appendCond", () => {
  const a = cond("a", "==", 1);
  const b = cond("b", "==", 2);
  const c = cond("c", "==", 3);
  const and: FilterNode = { kind: "and", children: [a, b] };

  test("바꾸기 · 지우기 · 하나 남으면 접기", () => {
    expect(replaceAt(and, [1], c)).toEqual({ kind: "and", children: [a, c] });
    expect(replaceAt(and, [0], null)).toEqual(b);
    expect(replaceAt(a, [], null)).toBeNull();
    expect(replaceAt(a, [], c)).toEqual(c);
  });

  test("더하기", () => {
    expect(appendCond(null, a)).toEqual(a);
    expect(appendCond(a, b)).toEqual(and);
    expect(appendCond(and, c)).toEqual({ kind: "and", children: [a, b, c] });
    const or: FilterNode = { kind: "or", children: [a, b] };
    expect(appendCond(or, c)).toEqual({ kind: "and", children: [or, c] });
  });
});

describe("열 머리 꼬리표", () => {
  test("식별자 → 열 id", () => {
    expect(columnIdOfIdent("file.name")).toBe("name");
    expect(columnIdOfIdent("file.tags")).toBe("tags");
    expect(columnIdOfIdent("tags")).toBe("tags");
    expect(columnIdOfIdent("file.updated")).toBe("updated");
    expect(columnIdOfIdent("note.status")).toBe("status");
    expect(columnIdOfIdent("formula.age")).toBe("formula.age");
    expect(columnIdOfIdent("file.folder")).toBeNull();
  });

  test("꼬리표 글자와 같은 열 두 조건", () => {
    expect(conditionTag(cond("status", "!=", "완료"), tags)).toBe("≠ 완료");
    expect(conditionTag(cond("file.tags", "contains", "2026"), tags)).toBe("포함 #2026");
    expect(conditionTag(cond("due", "==", null), tags)).toBe("비어 있음");
    const m = buildSentence(parseFilters({ and: ["rating >= 3", "rating <= 5", 'file.folder == "책"'] }), null);
    const map = conditionTagsByColumn(m.clauses, tags);
    expect(map.get("rating")).toBe("≥ 3 · ≤ 5");
    expect(map.size).toBe(1);
  });
});

describe("fieldLabelOf", () => {
  const core = { "file.folder": "폴더", "file.tags": "태그" };
  test("핵심 필드 · 표시 이름 · 키", () => {
    expect(fieldLabelOf("file.folder", core, {})).toBe("폴더");
    expect(fieldLabelOf("tags", core, {})).toBe("태그");
    expect(fieldLabelOf("note.status", core, { status: "상태" })).toBe("상태");
    expect(fieldLabelOf("formula.age", core, { age: "나이" })).toBe("나이");
    expect(fieldLabelOf("rating", core, {})).toBe("rating");
  });
});
