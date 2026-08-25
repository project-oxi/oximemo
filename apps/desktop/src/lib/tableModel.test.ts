import { describe, expect, test } from "bun:test";
import {
  applyFrozenOrder, buildColumns, columnEditable, defaultSummaryFn, formatBaseValue,
  groupKeyOf, groupRows, inferredType, reconcileRow, summarize,
} from "./tableModel";
import type { FolderSchema, MemoSummary, PropValue } from "./types";

const sum = (id: string, folder: string, props: Record<string, PropValue> = {}): MemoSummary => ({
  id, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z",
  hash: "h", favorite: false, folder, path: `${folder}/${id}.md`, title: id,
  tags: [], props, preview: "", deleted: false,
});

describe("buildColumns", () => {
  test("schema folder: name + props in schema order + updated", () => {
    const s: FolderSchema = { properties: { status: { prop_type: "select" }, rating: {} } };
    expect(buildColumns({ book: s }, ["book"])).toEqual([
      { kind: "name" }, { kind: "prop", key: "status" }, { kind: "prop", key: "rating" }, { kind: "updated" },
    ]);
  });
  test("schema-less folder: spec default trio name/tags/updated", () => {
    expect(buildColumns({ "": null }, [""])).toEqual([{ kind: "name" }, { kind: "tags" }, { kind: "updated" }]);
  });
  test("cross-folder union dedups keys, first folder's order wins", () => {
    const a: FolderSchema = { properties: { status: {}, mood: {} } };
    const b: FolderSchema = { properties: { mood: {}, rating: {} } };
    const cols = buildColumns({ a, b }, ["a", "b"]);
    expect(cols.map((c) => c.kind === "prop" ? c.key : c.kind)).toEqual([
      "name", "status", "mood", "rating", "updated",
    ]);
  });
});

describe("editability matrix (spec §4)", () => {
  test("core columns read-only; props editable", () => {
    expect(columnEditable({ kind: "name" })).toBe(false);
    expect(columnEditable({ kind: "tags" })).toBe(false);
    expect(columnEditable({ kind: "updated" })).toBe(false);
    expect(columnEditable({ kind: "prop", key: "status" })).toBe(true);
  });
});

describe("inferredType", () => {
  test("Bool → bool, List → multiselect, ISO Str → date, else text", () => {
    expect(inferredType({ Bool: true })).toBe("bool");
    expect(inferredType({ List: ["x"] })).toBe("multiselect");
    expect(inferredType({ Str: "2026-01-02" })).toBe("date");
    expect(inferredType({ Str: "메모" })).toBe("text");
    expect(inferredType(undefined)).toBe("text");
  });
});

describe("summarize (spec §1 functions over PropValue[])", () => {
  const vals: PropValue[] = [
    { Str: "4" }, { Str: "10" }, { Str: "읽는중" }, { Bool: true }, undefined as never,
  ];
  test("count-based", () => {
    expect(summarize(vals, "all")).toBe("5");
    expect(summarize(vals, "checked")).toBe("1");
    expect(summarize(vals, "unchecked")).toBe("0");
    expect(summarize(vals, "filled")).toBe("4");
    expect(summarize(vals, "empty")).toBe("1");
    expect(summarize(vals, "unique")).toBe("4"); // 4,10,읽는중,true
  });
  test("numeric promote Str members, skip non-numeric", () => {
    expect(summarize(vals, "sum")).toBe("14");
    expect(summarize(vals, "average")).toBe("7");
    expect(summarize(vals, "min")).toBe("4");
    expect(summarize(vals, "max")).toBe("10");
    expect(summarize(vals, "median")).toBe("7");
  });
  test("no numeric members → null (hidden)", () => {
    expect(summarize([{ Str: "책" }], "sum")).toBeNull();
    expect(summarize([], "all")).toBe("0");
  });
});

describe("grouping", () => {
  test("missing → 그룹 없음 last; List uses first member", () => {
    const rows = [
      sum("a", "book", { genre: { List: ["SF", "에세이"] } }),
      sum("b", "book", {}),
      sum("c", "book", { genre: { Str: "에세이" } }),
    ];
    expect(groupKeyOf(rows[0], "genre")).toBe("SF");
    expect(groupKeyOf(rows[1], "genre")).toBe("");
    const gs = groupRows(rows, "genre");
    expect(gs.map((g) => g.key)).toEqual(["SF", "에세이", ""]); // "" bucket last
    expect(groupRows(rows, null)).toEqual([{ key: "", rows }]);
  });
});

describe("applyFrozenOrder (spec §4 focus freeze)", () => {
  const r = (id: string) => ({ id });
  test("null snapshot passes through", () => {
    expect(applyFrozenOrder([r("a"), r("b")], null)).toEqual([r("a"), r("b")]);
  });
  test("keeps old order, appends new, drops removed", () => {
    const fresh = [r("c"), r("a"), r("d")]; // b removed, c/d new after reorder
    expect(applyFrozenOrder(fresh, ["b", "a"])).toEqual([r("a"), r("c"), r("d")]);
  });
});

describe("reconcileRow (returned NoteDto, spec §4)", () => {
  test("patches core + props fields from dto, keeps id", () => {
    const row = sum("a", "book");
    const dto = { ...row, body: "", format: "markdown" as const, deleted_at: null,
      updated_at: "2026-02-02T00:00:00Z", favorite: true, title: "새 제목",
      props: { status: { Str: "완독" } }, tags: ["소설"], path: "book/새 제목.md", hash: "h2" };
    const out = reconcileRow(row, dto as never);
    expect(out.updated_at).toBe("2026-02-02T00:00:00Z");
    expect(out.favorite).toBe(true);
    expect(out.title).toBe("새 제목");
    expect(out.props).toEqual({ status: { Str: "완독" } });
    expect(out.id).toBe("a");
  });
});

describe("defaultSummaryFn", () => {
  test("bool → checked, select/multiselect → unique, text/date → filled", () => {
    expect(defaultSummaryFn({ prop_type: "bool" })).toBe("checked");
    expect(defaultSummaryFn({ prop_type: "select" })).toBe("unique");
    expect(defaultSummaryFn({ prop_type: "multiselect" })).toBe("unique");
    expect(defaultSummaryFn({ prop_type: "date" })).toBe("filled");
    expect(defaultSummaryFn(undefined)).toBe("filled");
  });
});

describe("formatBaseValue (query views spec §4 formula cells)", () => {
  test("Num trims float noise, List joins, Date → local date, Null → dash", () => {
    expect(formatBaseValue({ Num: 4.5 })).toBe("4.5");
    expect(formatBaseValue({ Num: 7.0000000001 })).toBe("7");
    expect(formatBaseValue({ Str: "읽는중" })).toBe("읽는중");
    expect(formatBaseValue({ Bool: true })).toBe("true");
    expect(formatBaseValue({ List: [{ Str: "SF" }, { Str: "에세이" }] })).toBe("SF, 에세이");
    expect(formatBaseValue({ Date: "2026-01-02T00:00:00Z" })).toMatch(/^2026-01-0[12]$/);
    expect(formatBaseValue("Null")).toBe("—");
    expect(formatBaseValue(null)).toBe("—");
  });
});
