import { describe, expect, test } from "bun:test";
import {
  CORE_IDENTS, condString, opsForTypes, parseCondString, parseFilters, serializeFilters,
} from "./filterTree";

describe("parseCondString (spec §5: fit → cond, else 고급 row)", () => {
  test("comparison operators with quoted/bare literals", () => {
    expect(parseCondString('status != "done"')).toEqual({
      kind: "cond", ident: "status", op: "!=", value: "done",
    });
    expect(parseCondString("rating >= 4")).toEqual({
      kind: "cond", ident: "rating", op: ">=", value: 4,
    });
    expect(parseCondString("file.favorite == true")).toEqual({
      kind: "cond", ident: "file.favorite", op: "==", value: true,
    });
  });
  test("function forms and isEmpty", () => {
    expect(parseCondString('contains(note.genre, "SF")')).toEqual({
      kind: "cond", ident: "note.genre", op: "contains", value: "SF",
    });
    expect(parseCondString("isEmpty(note.rating)")).toEqual({
      kind: "cond", ident: "note.rating", op: "==", value: null,
    });
  });
  test("anything else is an advanced row", () => {
    expect(parseCondString('(now() - file.created).days() > 7')).toEqual({
      kind: "expr", text: "(now() - file.created).days() > 7",
    });
  });
});

describe("parseFilters / serializeFilters round-trip (spec §9)", () => {
  test("string → cond → string", () => {
    const n = parseFilters('status != "done"');
    expect(n).toEqual({ kind: "cond", ident: "status", op: "!=", value: "done" });
    expect(serializeFilters(n!)).toBe('status != "done"');
  });
  test("nested and/or/not survives", () => {
    const raw = {
      and: ['status != "done"', { or: ['file.inFolder("book")', { not: "file.favorite == true" }] }],
    };
    const n = parseFilters(raw);
    expect(n).toEqual({
      kind: "and",
      children: [
        { kind: "cond", ident: "status", op: "!=", value: "done" },
        {
          kind: "or",
          children: [
            { kind: "expr", text: 'file.inFolder("book")' },
            { kind: "not", child: { kind: "cond", ident: "file.favorite", op: "==", value: true } },
          ],
        },
      ],
    });
    expect(parseFilters(serializeFilters(n!))).toEqual(n);
  });
  test("null passthrough", () => {
    expect(parseFilters(null)).toBeNull();
    expect(parseFilters(undefined)).toBeNull();
  });
});

describe("condString emission", () => {
  test("null value → isEmpty / !isEmpty", () => {
    expect(condString("note.rating", "==", null)).toBe("isEmpty(note.rating)");
    expect(condString("note.rating", "!=", null)).toBe("!isEmpty(note.rating)");
  });
  test("string quoting escapes; numbers/bools bare", () => {
    expect(condString("note.t", "==", 'a"b\\c')).toBe('note.t == "a\\"b\\\\c"');
    expect(condString("rating", "<", 4.5)).toBe("rating < 4.5");
    expect(condString("file.favorite", "==", false)).toBe("file.favorite == false");
  });
});

describe("opsForTypes (spec §3 operator restriction)", () => {
  test("numeric gets ordering, conflicting degrades to equality/contains", () => {
    expect(opsForTypes(["Num"])).toEqual(["==", "!=", ">", ">=", "<", "<="]);
    expect(opsForTypes(["Num", "Str"])).toEqual(["==", "!=", "contains"]);
    expect(opsForTypes(undefined)).toContain("startsWith");
  });
});

describe("CORE_IDENTS", () => {
  test("the eight file.* identifiers exist", () => {
    expect(CORE_IDENTS.length).toBe(8);
  });
});
