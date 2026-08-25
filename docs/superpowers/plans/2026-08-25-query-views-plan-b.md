# Query Views — Plan B (Table View + In-Place Editing) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship spec §4 (`docs/superpowers/specs/2026-08-25-query-views-design.md`): `ViewMode::Table`, a shared `TableView` (virtualized rows, sticky header, frozen `file.name` column, column drag, group sections, summary footer), PropertyPanel editor extraction, per-row cross-schema editor selection, cell editing with returned-`NoteDto` reconciliation and focus-frozen row order — demonstrated on normal folders and the query-mode smart collection, with no `.query` UI (that is Plan C+).

**Architecture:** All display/editing logic is pure TypeScript in a new `lib/tableModel.ts` (column model, editability matrix, group/summary math, row freeze, DTO reconcile) plus an extracted `components/propEditors.tsx` shared by PropertyPanel and TableView. `views/TableView.tsx` renders `MemoSummary[]` rows (the same `items` array every view consumes, `CardGrid.tsx:329-356`) against per-folder schemas batched through the existing `useSchemaInfo` (`lib/folders.ts:84`). When Plan C lands query collections, a `BaseRow → TableRow` adapter feeds the same component — the column kinds below are deliberately a subset of the identifiers the expression engine resolves (`file.*`, bare prop keys). Editing reuses `updateMemo` (`api.ts:84-91`), which already returns the post-transition `NoteDto` (`src-tauri/src/lib.rs:799-815`).

**Tech Stack:** React 19 + Zustand + TanStack Query/virtual (`useVirtualizer` already used at `CardGrid.tsx:454-459`), `@base-ui-components/react` Popover, bun:test, Rust config enum.

## Global Constraints

- Spec of record: `docs/superpowers/specs/2026-08-25-query-views-design.md` §4 + §8. Spec wins over this plan; flag conflicts in the task report.
- Conventional commits, English. No `unsafe`. **No new dependencies** (`@tanstack/react-virtual`, `@base-ui-components/react`, `lucide-react` already present).
- **No repo-wide formatter/clippy runs** — the mainline has pre-existing fmt/clippy debt; format only files this plan touches.
- Rust tasks end green: `cargo test -p oximemo-core` (baseline @185d680: **320 passed, 0 failed, 0 warnings**). TS tasks end green: `cd apps/desktop && bun run build` (= `tsc -b && vite build`) and `bun test` for the new test files.
- UI copy Korean (ko.ts is source of truth, en.ts mirrors via `Record<keyof typeof ko, string>`); code comments English.
- Line numbers were accurate at planning time (@185d680); re-locate by symbol name.
- **Calendar rebase note:** the approved Calendar spec (2026-08-25, branch `feat/calendar-view`, NOT merged to this branch's base) also extends `ViewMode`. Plan B adds `Table` as the 5th switcher icon; the ≥6-mode dropdown collapse (spec §5) belongs to Calendar, which lands second and rebases. Do not implement the dropdown here.

## Reference: current code this plan modifies

| Anchor | What |
|---|---|
| `crates/oximemo-core/src/config.rs:241-249` | `pub enum ViewMode { Grid, List, Timeline, Graph }` (serde `rename_all = "lowercase"`) |
| `crates/oximemo-core/src/vault.rs:1752` | `set_folder_view(&self, path: &str, view: Option<ViewMode>)` |
| `crates/oximemo-core/src/vault.rs:4087` | test `set_folder_view_persists_and_unlocks` (mirror this) |
| `apps/desktop/src/lib/types.ts:217` | `export type ViewMode = "grid" \| "list" \| "timeline" \| "graph" \| "shelf";` |
| `apps/desktop/src/stores/ui.ts:171-175` | `loadQueryView()` accepts only `list/timeline/graph` |
| `apps/desktop/src/components/CardGrid.tsx:196-198` | listing `immediate:` direct-only set = `grid/list/shelf` |
| `apps/desktop/src/components/CardGrid.tsx:454-459` | `useVirtualizer({ count, getScrollElement, estimateSize: () => ROW_H, overscan: 4 })` |
| `apps/desktop/src/components/CardGrid.tsx:468-485` | `memos:changed` listener → invalidates `["memos"],["search"],…` |
| `apps/desktop/src/components/CardGrid.tsx:1135-1199` | `viewSwitcher` JSX (mode array + conditional shelf button) |
| `apps/desktop/src/components/CardGrid.tsx:1240-1259` | `viewProps` object |
| `apps/desktop/src/components/CardGrid.tsx:1596-1640` | view dispatch chain (shelf → grid → list → timeline → graph fallback) |
| `apps/desktop/src/components/PropertyPanel.tsx:95-310` | `SelectEditor`, `ChipsEditor` |
| `apps/desktop/src/components/PropertyPanel.tsx:312-504` | `PropertyRow` incl. `valueEditor()` (date/bool/text inline), `onBool` fork at :329-344 |
| `apps/desktop/src/components/PropertyPanel.tsx:43-64` | `members`, `toValue`, `inferredType` helpers |
| `apps/desktop/src/components/PropertyPanel.tsx:774-801` | `commit()` — `updateMemo(memo.id, null, null, mutation)`, `qc.setQueryData(["memo", memo.id], n)` |
| `apps/desktop/src/lib/folders.ts:84-108` | `useSchemaInfo(paths): Record<string, FolderSchema \| null>` |
| `apps/desktop/src/lib/propDisplay.ts` | `propKeyLabel`, `propValueLabel(key, value, t, preset?)`, `badgeTone(token)` |
| `apps/desktop/src/lib/api.ts:84-91` | `updateMemo(id, body, favorite, props)` → `Promise<Memo>` |
| `apps/desktop/src/lib/dates.ts` | `isoToLocalDate` |

Future Plan C contract (already landed in core @185d680 / landing as Plan A Task 9-11) — design for it, do not implement: `BaseRow { summary, folder, format, cells }`, `BasePage { rows, total, group_counts, summaries, clock, result_key, warnings }` (wire camelCase), `run_base(source, req) -> BasePage`. Spec §4: "`memos:changed` invalidates `["base"]`; `bases:changed` alone invalidates `["bases"]`."

---

### Task 1: `ViewMode::Table` — Rust enum variant + persistence test

**Files:**
- Modify: `crates/oximemo-core/src/config.rs` (`enum ViewMode`)
- Test: `crates/oximemo-core/src/vault.rs` (inline tests module)

**Interfaces:**
- Produces (Tasks 2-5 and Calendar rebase rely on this): `ViewMode::Table`, serialized `"table"` (serde `rename_all = "lowercase"` already on the enum). `set_folder_view` accepts it with no signature change.
- Rationale: the TS union already carries `"shelf"` with no Rust variant — persisting it through `set_folder_view` fails IPC deserialization (latent trap documented in the Calendar spec §1). `Table` must land in the Rust enum first so the per-folder pin round-trips.

- [ ] **Step 1: Write the failing test**

In `vault.rs` tests module, next to `set_folder_view_persists_and_unlocks` (:4087):

```rust
#[test]
fn set_folder_view_table_round_trips() {
    let (_t, v) = tmp_vault();
    v.set_folder_view("book", Some(crate::config::ViewMode::Table))
        .unwrap();
    let json = v.config_json();
    let folders = json["folders"].as_array().unwrap();
    let entry = folders
        .iter()
        .find(|f| f["path"] == "book")
        .expect("folder entry exists");
    assert_eq!(entry["view"], "table"); // serde lowercase wire form
    // Round-trip: config reload resolves the same variant.
    let cfg = v.with_config(|c| c.folders.items.clone());
    assert_eq!(
        cfg.first().and_then(|f| f.view),
        Some(crate::config::ViewMode::Table)
    );
    // Unlock drops the pin (same entry-drop semantics as List).
    v.set_folder_view("book", None).unwrap();
    assert!(v
        .with_config(|c| c.folders.items.clone())
        .iter()
        .all(|f| f.path != "book"));
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p oximemo-core set_folder_view_table`
Expected: compile error `no variant named Table found for enum ViewMode`.

- [ ] **Step 3: Implement**

`config.rs`, in `enum ViewMode` (keep `Grid`'s `#[default]`):

```rust
pub enum ViewMode {
    #[default]
    Grid,
    List,
    Timeline,
    Graph,
    /// Spreadsheet-style property table (query views spec §4). Shared by
    /// folder browse and query collections.
    Table,
}
```

- [ ] **Step 4: Run tests** — `cargo test -p oximemo-core` → all PASS (321 now).
- [ ] **Step 5: Commit** — `feat(core): ViewMode::Table for folder view pins`

---

### Task 2: `lib/tableModel.ts` — pure table model + tests

**Files:**
- Create: `apps/desktop/src/lib/tableModel.ts`
- Test: `apps/desktop/src/lib/tableModel.test.ts`

**Interfaces (consumed by Tasks 3-5; Plan C's BaseRow adapter consumes them too):**

```ts
import type { FolderSchema, Memo, MemoSummary, PropValue, SchemaPropertyDef } from "./types";

export type SummaryFn =
  | "all" | "checked" | "unchecked" | "empty" | "filled" | "unique"
  | "average" | "sum" | "min" | "max" | "median";

export type TableColumn =
  | { kind: "name" }      // file.name — frozen first column, read-only, opens note
  | { kind: "tags" }      // derived tags — read-only chips
  | { kind: "updated" }   // file.updated — read-only date
  | { kind: "prop"; key: string }; // note.<key> — typed editor

export function buildColumns(
  schemas: Record<string, FolderSchema | null>,
  folderOrder: string[],
): TableColumn[];
export function columnEditable(col: TableColumn): boolean;
export function inferredType(v: PropValue | undefined): "text" | "multiselect" | "date" | "bool";
export function summarize(vals: PropValue[], fn: SummaryFn): string | null;
export function defaultSummaryFn(def: SchemaPropertyDef | undefined): SummaryFn;
export function groupKeyOf(row: MemoSummary, key: string): string; // "" = 그룹 없음; List → first member
export function groupRows(rows: MemoSummary[], key: string | null): { key: string; rows: MemoSummary[] }[];
export function applyFrozenOrder<T extends { id: string }>(fresh: T[], frozenIds: string[] | null): T[];
export function reconcileRow(row: MemoSummary, dto: Memo): MemoSummary;
```

- [ ] **Step 1: Write the failing tests** (`tableModel.test.ts`, bun:test — see `metadataRegion.test.ts` for the house style):

```ts
import { describe, expect, test } from "bun:test";
import {
  applyFrozenOrder, buildColumns, columnEditable, defaultSummaryFn,
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
```

- [ ] **Step 2: Run** — `cd apps/desktop && bun test src/lib/tableModel.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** `tableModel.ts`:

```ts
/** Pure table model for TableView (query views spec §4). Rendering-agnostic:
 * column shape, editability, group/summary math, focus-frozen row order, and
 * NoteDto reconciliation. Plan C feeds BaseRow-derived rows through the same
 * functions. No React here — everything is unit-testable. */
import type { FolderSchema, Memo, MemoSummary, PropValue, SchemaPropertyDef } from "./types";

export type SummaryFn =
  | "all" | "checked" | "unchecked" | "empty" | "filled" | "unique"
  | "average" | "sum" | "min" | "max" | "median";

export type TableColumn =
  | { kind: "name" }
  | { kind: "tags" }
  | { kind: "updated" }
  | { kind: "prop"; key: string };

/** Columns for a set of folders: frozen name, the union of schema prop keys
 * (each folder's schema order, first occurrence wins), then updated. All
 * folders schema-less → the spec §4 default trio [name, tags, updated]. */
export function buildColumns(
  schemas: Record<string, FolderSchema | null>,
  folderOrder: string[],
): TableColumn[] {
  const keys: string[] = [];
  for (const f of folderOrder) {
    for (const k of Object.keys(schemas[f]?.properties ?? {})) {
      if (!keys.includes(k)) keys.push(k);
    }
  }
  const cols: TableColumn[] = [{ kind: "name" }, ...keys.map((key): TableColumn => ({ kind: "prop", key }))];
  if (keys.length === 0) cols.push({ kind: "tags" });
  cols.push({ kind: "updated" });
  return cols;
}

/** Spec §4 editable matrix: note props typed-editable; file.name, tags,
 * created/updated, path/folder/format are derived data — read-only. */
export function columnEditable(col: TableColumn): boolean {
  return col.kind === "prop";
}

/** Editor type for a schema-less key, inferred from the stored envelope.
 * (Moved verbatim from PropertyPanel.tsx:58 so panel and table agree.) */
export function inferredType(v: PropValue | undefined): "text" | "multiselect" | "date" | "bool" {
  if (!v) return "text";
  if ("Bool" in v) return "bool";
  if ("List" in v) return "multiselect";
  if ("Str" in v && /^\d{4}-\d{2}-\d{2}$/.test(v.Str)) return "date";
  return "text";
}

const num = (s: string): number | null => {
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/** Spec §1 summary functions over a column's PropValue values (undefined =
 * absent cell). Returns a display string; null hides the footer cell. */
export function summarize(vals: PropValue[], fn: SummaryFn): string | null {
  const members = vals.flatMap((v) => (!v ? [] : "List" in v ? v.List : "Str" in v ? [v.Str] : [String(v.Bool)]));
  switch (fn) {
    case "all": return String(vals.length);
    case "checked": return String(vals.filter((v) => v && "Bool" in v && v.Bool).length);
    case "unchecked": return String(vals.filter((v) => !v || !("Bool" in v && v.Bool)).length);
    case "empty": return String(vals.filter((v) => !v || membersOf(v).length === 0).length);
    case "filled": return String(vals.filter((v) => v && membersOf(v).length > 0).length);
    case "unique": return String(new Set(members).size);
  }
  const nums = vals.flatMap((v) => (!v ? [] : membersOf(v))).map(num).filter((n): n is number => n !== null);
  if (!nums.length) return null;
  switch (fn) {
    case "sum": return fmt(nums.reduce((a, b) => a + b, 0));
    case "average": return fmt(nums.reduce((a, b) => a + b, 0) / nums.length);
    case "min": return fmt(Math.min(...nums));
    case "max": return fmt(Math.max(...nums));
    case "median": {
      const s = [...nums].sort((a, b) => a - b);
      const mid = s.length >> 1;
      return fmt(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
    }
  }
}

function membersOf(v: PropValue): string[] {
  if ("List" in v) return v.List;
  if ("Str" in v) return [v.Str];
  if ("Bool" in v) return [String(v.Bool)];
  return [];
}

/** Footer default per column type (spec §4 sticky summary footer; Plan C
 * replaces defaults with the view def's declared summaries). */
export function defaultSummaryFn(def: SchemaPropertyDef | undefined): SummaryFn {
  const t = def?.prop_type;
  if (t === "bool") return "checked";
  if (t === "select" || t === "multiselect") return "unique";
  return "filled";
}

/** Group key of a row for a prop: first member of a List, scalar string of
 * Str/Bool, "" (그룹 없음) when absent. */
export function groupKeyOf(row: MemoSummary, key: string): string {
  const v = row.props?.[key];
  if (!v) return "";
  return membersOf(v)[0] ?? "";
}

/** Group rows by a prop key; groups keep first-appearance order except the
 * "" (그룹 없음) bucket, which sorts last. key === null → single flat group. */
export function groupRows(rows: MemoSummary[], key: string | null): { key: string; rows: MemoSummary[] }[] {
  if (key === null) return [{ key: "", rows }];
  const map = new Map<string, MemoSummary[]>();
  for (const r of rows) {
    const g = groupKeyOf(r, key);
    (map.get(g) ?? map.set(g, []).get(g)!).push(r);
  }
  const out = [...map.entries()].map(([k, rs]) => ({ key: k, rows: rs }));
  out.sort((a, b) => (a.key === "" ? 1 : b.key === "" ? -1 : 0));
  return out;
}

/** Spec §4 focus freeze: while a cell editor is focused the displayed row id
 * order is frozen. Re-render with fresh data keeps the frozen ids first (in
 * snapshot order), drops ids that vanished, appends rows that appeared. */
export function applyFrozenOrder<T extends { id: string }>(fresh: T[], frozenIds: string[] | null): T[] {
  if (!frozenIds) return fresh;
  const byId = new Map(fresh.map((r) => [r.id, r]));
  const head = frozenIds.map((id) => byId.get(id)).filter((r): r is T => r !== undefined);
  const seen = new Set(frozenIds);
  return [...head, ...fresh.filter((r) => !seen.has(r.id))];
}

/** Reconcile a table row from the post-transition NoteDto `update_memo`
 * returns (spec §4): transitions/status stamps appear immediately. */
export function reconcileRow(row: MemoSummary, dto: Memo): MemoSummary {
  return {
    ...row,
    updated_at: dto.updated_at,
    hash: dto.hash,
    favorite: dto.favorite,
    folder: dto.folder,
    path: dto.path,
    title: dto.title,
    tags: dto.tags,
    props: dto.props,
  };
}
```

- [ ] **Step 4: Run** — `bun test src/lib/tableModel.test.ts` → PASS.
- [ ] **Step 5: Commit** — `feat(desktop): table model — columns, editability, summaries, row freeze, reconcile`

---

### Task 3: `components/propEditors.tsx` — editor extraction from PropertyPanel

**Files:**
- Create: `apps/desktop/src/components/propEditors.tsx`
- Modify: `apps/desktop/src/components/PropertyPanel.tsx`
- Test: none new (pure move; behavior verified by build + Task 2's `inferredType` tests + existing flows). `bun run build` type-checks every consumer.

**Interfaces:**
- Consumes: `SelectEditor`/`ChipsEditor` bodies and the `valueEditor()` branch chain from `PropertyPanel.tsx:95-403`; `inferredType` from Task 2.
- Produces (Tasks 4-5; also the Plan D filter builder's value inputs):

```tsx
export interface PropCellEditorProps {
  propKey: string;
  def: SchemaPropertyDef | undefined;
  stored: PropValue | undefined;
  /** Folder preset id for propValueLabel's first-party vocabulary. */
  preset?: string;
  /** String-list commits (select/multiselect/date/text); null clears. */
  onCommit: (next: string[] | null) => void;
  /** Bool commits bypass the string[] contract via a dedicated setter
   *  (the preserved BoolEditor fork, PropertyPanel.tsx:329-344). */
  onBool: (b: boolean) => void;
}
export function PropCellEditor(props: PropCellEditorProps): JSX.Element;
```

- [ ] **Step 1: Create `propEditors.tsx`** — move, do not rewrite:
  1. Copy `SelectEditor` (:95-179) and `ChipsEditor` (:185-310) verbatim, `export` both, imports trimmed to what they use (`Popover` from `@base-ui-components/react`, lucide icons, `useI18n`, `propValueLabel`).
  2. Add `PropCellEditor` = `PropertyRow`'s `valueEditor()` (:346-403) as a component: computes `type = def?.prop_type ?? inferredType(stored)`, `options = def?.options ?? []`, `values = members(stored)` (copy the two helpers `members`/`toValue` — PropertyPanel keeps its own copies; they are 8 lines and shared-state-free), and renders the same branch chain: select → `SelectEditor`, multiselect → `ChipsEditor`, date → `<input type="date">`, bool → the toggle button calling `onBool` directly, text → the `<input>` with `datalist`. Props pass through unchanged (`propKey`, `preset`, `onChange={(v) => onCommit(...)}` wrappers identical to :354, :360, :368, :398).
  3. Bool branch must call `onBool(!(stored && "Bool" in stored ? stored.Bool : false))` — same expression as :379.

- [ ] **Step 2: Rewire PropertyPanel**
  1. Delete the local `SelectEditor`, `ChipsEditor`, and `inferredType` definitions; import `PropCellEditor` from `./propEditors` and `inferredType` from `../lib/tableModel`.
  2. `PropertyRow`'s `valueEditor()` body becomes `return <PropCellEditor propKey={propKey} def={def} stored={stored} preset={preset} onCommit={onCommit} onBool={(b) => onBool?.(b)} />;` — keep `PropertyRow`'s label/rename/violation chrome exactly as is. (Do not touch the `onCommitBool` wrapper's comment — it documents the fork.)
  3. In `commit()` (:774-801), after `qc.setQueryData(["memo", memo.id], n);` add:

```ts
      // Query-view result caches key on the index generation; a prop write
      // bumps it. Forward-compat for run_base queries (spec §4).
      void qc.invalidateQueries({ queryKey: ["base"] });
```

- [ ] **Step 3: Verify** — `cd apps/desktop && bun run build` → PASS (tsc catches any missed consumer). `bun test` (whole suite) → PASS.
- [ ] **Step 4: Commit** — `refactor(desktop): extract PropCellEditor from PropertyPanel; invalidate base queries on commit`

---

### Task 4: `views/TableView.tsx` — the component

**Files:**
- Create: `apps/desktop/src/components/views/TableView.tsx`
- Modify: `apps/desktop/src/lib/locales/ko.ts`, `en.ts`

**Interfaces:**
- Consumes: Task 2's tableModel, Task 3's `PropCellEditor`, `useVirtualizer` pattern from `CardGrid.tsx:454-459`, `propValueLabel`/`badgeTone`/`propKeyLabel` from `propDisplay.ts`, `isoToLocalDate` from `lib/dates`, `updateMemo` from `lib/api`.
- Produces (Task 5 wires it; Plan C reuses it with `BaseRow` adapters):

```tsx
export interface TableViewProps {
  /** Latest listing rows (CardGrid `items`). */
  items: MemoSummary[];
  /** Folder → schema map (useSchemaInfo). Drives columns + per-row editors. */
  schemas: Record<string, FolderSchema | null>;
  /** Folder appearance order for column building (encounter order). */
  folderOrder: string[];
  /** Preset id when every row shares one schema folder, else undefined. */
  preset?: string;
  onSelect: (id: string) => void;
  onToggleFavorite: (m: MemoSummary) => void;
}
export function TableView(props: TableViewProps): JSX.Element;
```

Component shape (implement exactly; ~300 lines):

1. **State**: `cols` (`TableColumn[]`, re-initialized via `useEffect` when `schemas`/`folderOrder` identity change — column drag reorders this array; **not persisted** in folder mode per spec §4), `groupBy: string | null` (default `null`), `collapsed: Set<string>`, `frozenIds: string[] | null`, `focusedRow: string | null`, `patched: Record<string, MemoSummary>` (row patches from committed NoteDtos, cleared on blur).
2. **Row pipeline** (pure calls, no inline math): `rows = applyFrozenOrder(Object.values({ ...byId(items), ...patched }), frozenIds)` — merge patched over items by id; then `groups = groupRows(rows, groupBy)`; flatten to virtual entries `{ type: "group", key, count } | { type: "note", row }`, skipping rows inside collapsed groups; `useVirtualizer({ count: entries.length, getScrollElement, estimateSize: (i) => entries[i].type === "group" ? 28 : 34, overscan: 8 })`.
3. **Freeze semantics** (spec §4): onFocusCapture of a row sets `focusedRow` and, if `frozenIds === null`, snapshots `rows.map(r => r.id)`; onBlurCapture (focus left the table body — check `!e.currentTarget.contains(e.relatedTarget)`) clears `focusedRow`, `frozenIds`, `patched`. External `memos:changed` refetches arrive as new `items`; `applyFrozenOrder` keeps display stable until blur. Never suppress the query invalidation itself.
4. **Header**: sticky `top-0 z-10` row; first cell `sticky left-0 z-20 bg-surface` showing `file.name` (i18n `table_col_name`); prop headers show `propKeyLabel(key, t)`; every cell except the frozen first and last is `draggable` with HTML5 DnD reorder (`onDragStart` remember index, `onDragOver` preventDefault + set drop-index indicator, `onDrop` reorder `cols`) — pointer cursor + 2px inset ring on the drop target edge.
5. **Group selector**: header-left popover button (base-ui `Popover`, same markup as `SelectEditor`'s popup) labeled `t.table_group` + current key or `t.table_group_none`; options = scalar schema props (`prop_type` of `select`/`bool`, falling back to `text` when no scalar select exists) across `folderOrder` schemas + a `t.table_group_none` entry setting `groupBy = null`. Changing group resets `collapsed`.
6. **Body rows**: absolute-positioned per `virtualizer.getVirtualItems()` (copy GridView's transform pattern); first cell frozen (`sticky left-0 bg-surface`) rendering title (`row.title ?? filename stem`) as a button → `onSelect(row.id)`, with a hover star toggle (`onToggleFavorite(row)`, `e.stopPropagation()`); `tags` cell renders read-only chips; `updated` cell renders `isoToLocalDate(row.updated_at)`; prop cells render `PropCellEditor` with **that row's folder** schema: `def = schemas[row.folder]?.properties?.[key]`, `preset = schemaPresetOf(schemas[row.folder])` (read `meta?.preset`), `stored = row.props?.[key]`. Read-only display when the column is not `columnEditable` — prop cells with a missing def still edit (free-property mode via `inferredType`).
7. **Commit path**: build `PropMutation` exactly like PropertyPanel (:822-829): `onCommit(null)` → `{ sets: [], removes: [key] }`; `onCommit(list)` → `{ sets: [[key, list.length === 1 ? { Str: list[0] } : { List: list }]], removes: [] }`; `onBool(b)` → `{ sets: [[key, { Bool: b }]], removes: [] }`. Call `updateMemo(row.id, null, null, mutation)`; on success `setPatched(p => ({ ...p, [row.id]: reconcileRow(p[row.id] ?? row, dto) }))` and `qc.invalidateQueries({ queryKey: ["base"] })`; on failure `useUI.getState().setToast(...)` (first line of the error).
8. **Summary footer**: sticky `bottom-0` row; per column `summarize(colValues, defaultSummaryFn(def))` over all loaded (non-collapsed-hidden excluded is fine — use `rows`) values, rendered as tabular-nums muted text; leading cell shows `t.table_rows_n.replace("{n}", String(rows.length))`. `summarize` returning null renders an empty cell.
9. **Empty group label**: `""` bucket header renders `t.group_none` + count; other headers `propValueLabel(groupBy, key, t, preset)`.

**i18n keys** (add to ko.ts near `query_all_notes` (:401); en.ts mirrors — spec §8 names `view_table`, `group_none`, `summary_*`; the `table_*` labels are this plan's additions):

```ts
// ko.ts
view_table: "테이블",
group_none: "그룹 없음",
table_col_name: "이름",
table_group: "그룹",
table_group_none: "없음",
table_rows_n: "{n}행",
summary_all: "전체", summary_checked: "체크", summary_unchecked: "미체크",
summary_empty: "빈 값", summary_filled: "채워짐", summary_unique: "고유",
summary_average: "평균", summary_sum: "합계", summary_min: "최소", summary_max: "최대", summary_median: "중앙값",
// en.ts
view_table: "Table",
group_none: "No group",
table_col_name: "Name",
table_group: "Group",
table_group_none: "None",
table_rows_n: "{n} rows",
summary_all: "All", summary_checked: "Checked", summary_unchecked: "Unchecked",
summary_empty: "Empty", summary_filled: "Filled", summary_unique: "Unique",
summary_average: "Average", summary_sum: "Sum", summary_min: "Min", summary_max: "Max", summary_median: "Median",
```

- [ ] **Step 1: Implement the component** (shape above; no test-first — the logic is Task 2's tested pure functions; this task is rendering).
- [ ] **Step 2: Verify** — `bun run build` → PASS; `bun test` → PASS (locales: a missing key is a `Record<keyof typeof ko, string>` type error, so tsc covers mirroring).
- [ ] **Step 3: Commit** — `feat(desktop): TableView with virtualized grouped rows and summary footer`

---

### Task 5: Wire into CardGrid + view switcher + `["base"]` invalidation

**Files:**
- Modify: `apps/desktop/src/lib/types.ts` (:217), `apps/desktop/src/stores/ui.ts` (:171-175), `apps/desktop/src/components/CardGrid.tsx`
- Test: `bun run build` + manual browser-mode E2E checklist below.

**Interfaces:**
- Consumes: Task 4's `TableViewProps`; `useSchemaInfo` (`lib/folders.ts:84`).

- [ ] **Step 1: TS literal + query-mode persistence**

`types.ts:217`:
```ts
export type ViewMode = "grid" | "list" | "timeline" | "graph" | "shelf" | "table";
```
`ui.ts` `loadQueryView` — accept `table` (table is available in query mode: the vault-wide cross-schema table is the point of per-row schema selection):
```ts
  return v === "list" || v === "timeline" || v === "graph" || v === "table" ? v : "grid";
```
(The `setFolderView` browser fallback at `tauri.ts:1137+` stores the raw string and needs no change — verify while there.)

- [ ] **Step 2: CardGrid wiring**

1. Listing scope (:196-198): add `table` to the direct-only set —
```ts
        immediate:
          folderFilter !== null &&
          (noteView === "grid" || noteView === "list" || noteView === "shelf" || noteView === "table"),
```
2. Schema batching — near the `items` memo (:329):
```ts
  // Per-row schema selection (spec §4): a table can cross folders whose
  // schemas type the same key differently, so editors resolve per row.
  const tableFolders = useMemo(
    () => [...new Set(items.map((n) => n.folder))],
    [items],
  );
  const tableSchemas = useSchemaInfo(tableFolders);
  const tablePreset = useMemo(() => {
    const presets = new Set(
      tableFolders.map((f) => tableSchemas[f]?.meta?.preset ?? undefined),
    );
    return presets.size === 1 ? [...presets][0] : undefined;
  }, [tableFolders, tableSchemas]);
```
3. `memos:changed` listener (:468-485): add after the `["prop-query"]` line —
```ts
      qc.invalidateQueries({ queryKey: ["base"] });
```
with the comment `// Query-view result caches key on index generation (spec §4).`
4. View switcher (:1141-1146): add `{ v: "table", Icon: Table }` to the mode array and `Table` to the lucide import. Five fixed icons — do NOT add the ≥6 dropdown (Calendar owns it, see Global Constraints).
5. Dispatch (:1596-1640): insert before the GraphView fallback arm —
```tsx
            ) : noteView === "table" ? (
              <TableView
                items={items}
                schemas={tableSchemas}
                folderOrder={tableFolders}
                preset={tablePreset}
                onSelect={select}
                onToggleFavorite={onToggleFavorite}
              />
```
6. `showFolders`/`browseFoldersQ` (:366-394): intentionally unchanged — table is notes-only like shelf; subfolder navigation stays on the breadcrumb/chip surfaces. Note this in the code if a future task asks.

- [ ] **Step 3: Verify**
  - `cd apps/desktop && bun run build` → PASS. `bun test` → PASS. `cargo test -p oximemo-core` → PASS (unchanged, sanity).
  - Manual browser-mode E2E (`bun run dev` — the localStorage fallback exercises the full flow): open a schema folder (e.g. book) → switch to 테이블 → columns = schema props in order; edit a select cell → value commits, row stays in place while focused, reorder applies after blur; toggle the star; group by status → collapsible sections + 그룹 없음 last; schema-less folder → name/tags/updated trio; query mode 전체 메모 → cross-folder union columns, per-row editors from each row's own schema; drag a column header → order changes, survives folder switch within the session, resets on remount.

- [ ] **Step 4: Commit** — `feat(desktop): wire table view mode into folder browse`

---

## Self-Review (done at planning time)

1. **Spec §4 coverage:** ViewMode::Table (Task 1/5) ✓; TableView with row virtualization/sticky header/frozen name/drag/groups/footer (Task 4) ✓; per-row schema batching via useSchemaInfo (Task 5.2) ✓; editable matrix (Task 2 `columnEditable` + Task 4 prop cells; favorite via name-cell star; tags/name/updated read-only) ✓; editor extraction with Bool fork (Task 3) ✓; `["base"]` invalidation in commit + memos:changed (Tasks 3.2.3/5.2.3) ✓; NoteDto reconciliation (Task 2 `reconcileRow` + Task 4.7) ✓; row-order freeze on edit, swap on blur (Task 2 `applyFrozenOrder` + Task 4.3) ✓; folder columns schema-order / schema-less trio (Task 2 `buildColumns`) ✓; YAML write-back of column order is query-view-only → Plan C (spec: "writes back to YAML in query views; not persisted for folders in v1" — folder mode keeps session-local order, Task 4.1) ✓. Formula read-only cells arrive with Plan C's BaseRow columns (`formula.*` is not a folder column kind — the Task 2 `columnEditable` matrix already returns false for every non-prop kind, which is the contract Plan C relies on).
2. **Placeholders:** none — every step carries code or an exact mechanical instruction; the two "manual verify" steps name their commands and checklists.
3. **Type consistency:** `TableColumn`/`SummaryFn` names identical in Tasks 2/4/5; `PropCellEditorProps.onBool` is non-optional (PropertyPanel's `onBool?` is optional at the `PropertyRow` layer — the wrapper at Task 3.2.2 adapts); `TableViewProps` fields match the Task 5 dispatch JSX; `inferredType` single source in tableModel.ts after Task 3 removes PropertyPanel's copy; i18n keys added in both locales (type-enforced mirror).
4. **Known deliberate scope notes (flagged, not silent):** (a) group selector + `table_*` labels are minimal folder-mode affordances so group sections are demonstrable before Plan C — spec §8 didn't name them; (b) mixed schema-less + schema folders in query mode show union columns where schema-less rows render empty prop cells; (c) footer summaries are type-derived defaults until Plan C passes view-declared `summaries`.
