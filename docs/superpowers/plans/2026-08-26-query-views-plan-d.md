# Query Views — Plan D (Filter Builder) Implementation Plan

**Goal:** Spec §5 filter builder: a popover over `base_props` editing the
`filters` union (base level and view level) as a tagged expression tree,
serialized back to YAML on save; conditions that don't fit
`<identifier> <op> <literal>` render as 고급 expression rows.

**Spec:** §1 (filters union), §3 (`base_props` observed types → operator
restriction), §5 (builder), §9 (tagged-AST↔YAML round-trip tests).

## Constraints
Same as Plan C (conventional commits, ko/en i18n, no repo-wide formatting,
`bun run build && bun test` green per task).

## Tasks

### Task 1 — `lib/filterTree.ts` (pure) + tests
- `FilterNode = { kind: "cond"; ident; op; value } | { kind: "expr"; text } |
  { kind: "and"|"or"; children } | { kind: "not"; child }`.
- `parseFilters(raw: unknown): FilterNode | null` — the YAML union (string
  | nested and/or/not maps); a string matching
  `ident (==|!=|>=|<=|>|<) literal` becomes a cond, anything else an expr
  row. `serializeFilters(node): unknown` — inverse; conds print as
  `'ident op "value"'` single-quoted YAML strings (value literal quoting:
  strings quoted, numbers/bools bare, null → `isEmpty(ident)`).
- Round-trip tests: cond ↔ string, expr passthrough, nested and/or/not,
  contains-op emission (`contains(ident, "v")`), not-wrapped conds.

### Task 2 — `components/FilterBuilder.tsx`
- Recursive tree editor: group rows (combinator and/or toggle per group,
  not toggle per group, +condition / +group), condition rows
  (property dropdown = `file.*` identifiers + `base_props` keys, operator
  dropdown restricted by observed types — conflicting types offer only
  equality/contains, spec §3 — value input with option suggestions),
  advanced rows (raw text input, parse-error highlight).
- Popover opens from BaseView 「필터」; header toggle 기본 필터 / 뷰 필터
  (spec §1: builder edits either level); 저장 applies via saveYaml;
  취소 discards. `base_props` via `useQuery(["base-props"], baseProps)`.

### Task 3 — BaseView integration
- Enable the 필터 button; wire state (draft tree initialized from the
  active level, saved back through save_base); unknown-level (no filters)
  starts as an empty and-group.

## Scope note
Parsing supports the full nested union (any hand-written tree renders
correctly); building creates nested groups via +그룹 — full parity except
re-editing a parsed `not` around a *group* (rendered read-only as 고급
row) — flagged, not silent.
