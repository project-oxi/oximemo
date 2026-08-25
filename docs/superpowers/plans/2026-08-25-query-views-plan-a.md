# Query Views — Plan A (Query Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the query foundation from the approved spec (`docs/superpowers/specs/2026-08-25-query-views-design.md`): the `expr` expression engine, the `.query` file model + guarded CRUD, the snapshot + result caches, `run_base`/`base_props` execution, eight Tauri commands with `bases:changed`, and the `oximemo base` CLI.

**Architecture:** All logic lands in `oximemo-core` (`expr/` module, `base.rs`, `Vault` additions); the Tauri app and CLI stay thin adapters, exactly like `query_notes` today. The snapshot cache is keyed by the redb file's `(mtime, size)` stat — the existing flock + transient-open concurrency model (`vault.rs:1-15`) rules out an in-process write counter, and a stat is a valid cross-process generation proxy. The evaluated-result cache is an in-process bounded LRU whose key embeds that generation, the query content fingerprint, view index, clock, and aggregate flags.

**Tech Stack:** Rust (workspace edition), `time` (already a dep), new deps `serde_yaml_ng = "0.10"` and dev-dep `proptest = "1"`, redb/tantivy unchanged, Tauri 2 commands, clap derive CLI.

## Global Constraints

- Spec of record: `docs/superpowers/specs/2026-08-25-query-views-design.md`. Where this plan and the spec disagree, the spec wins; flag it in the task's report.
- No `unsafe`. No new workspace dependencies beyond `serde_yaml_ng`; dev-dep `proptest` allowed.
- Cache budgets (spec §3): snapshot cap 50,000 records (above → bypass cache); result LRU ≤16 keys; target warm page slice <30 ms at ≤20k notes (benchmark, not CI).
- Engine invariants (spec §2): no loops/assignment/recursion in the language; call depth cap 64; division by zero and non-finite numerics are expression errors; every sort ends with `MemoId` ascending tie-break.
- Soft-deleted records never enter any base pipeline (spec §1).
- Runtime eval errors use `CoreError::Expr { message, line: 0, col: 0 }`; parse errors carry real line/col (spec §2 allows this split — ⚠ tooltips show the message).
- CLI output and code comments are English; UI copy (later plans) is Korean.
- Conventional commits (`feat:`, `test:`, `chore:`). Every task ends green: `cargo test -p oximemo-core` and, for Tasks 12–13, `cargo check` in the affected crate.
- Reference files: `crates/oximemo-core/src/{props.rs,memo.rs,store/index.rs,vault.rs,watcher.rs,error.rs}`, `crates/oximemo-cli/src/{main.rs,commands.rs,format.rs}`, `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src/lib/{api.ts,tauri.ts,types.ts}`.
- Line numbers in "Modify:" hints were accurate at planning time; re-locate by symbol name, not line.

---

### Task 1: `expr::value` — value model, duration/date parsing, promotion, total order

**Files:**
- Modify: `crates/oximemo-core/Cargo.toml` (add `serde_yaml_ng = "0.10"` to `[dependencies]`, `proptest = "1"` to `[dev-dependencies]`)
- Modify: `crates/oximemo-core/src/error.rs` (add `Expr` variant)
- Modify: `crates/oximemo-core/src/lib.rs` (add `pub mod expr; pub mod base;` — `base` created in Task 6; add an empty `crates/oximemo-core/src/base.rs` with just the module doc-comment here so the crate builds)
- Create: `crates/oximemo-core/src/expr/mod.rs`, `crates/oximemo-core/src/expr/value.rs`
- Test: inline `#[cfg(test)] mod tests` in `value.rs`

**Interfaces:**
- Produces (later tasks + Plans B–F rely on these exact names):
  - `pub enum Value { Null, Bool(bool), Num(f64), Str(String), List(Vec<Value>), Date(time::OffsetDateTime), Duration(DurationSpec) }` (derives `Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize` — Task 9's DTOs serialize it)
  - `pub struct DurationSpec { pub calendar_months: i32, pub fixed_millis: i64 }`
  - `pub fn parse_duration_lit(s: &str) -> Option<DurationSpec>` — `"1w"`, `"2M"`, `"1y"`, `"3d"`, `"12h"`, `"30m"`, `"10s"` (units `y M w d h m s`; single segment; case-sensitive `M`=months vs `m`=minutes)
  - `pub fn parse_date_ish(s: &str) -> Option<time::OffsetDateTime>` — tries `YYYY-MM-DD`, `YYYY-MM-DD HH:MM`, `YYYY-MM-DD HH:MM:SS`, RFC 3339; assumes UTC when no offset
  - `pub fn promote_num(v: &Value) -> Option<f64>` — `Num→n`, `Str→parse`, `Bool→None`, `Date→None`
  - `pub fn promote_date(v: &Value) -> Option<time::OffsetDateTime>` — `Date→d`, `Str→parse_date_ish`
  - `pub fn date_add(d: OffsetDateTime, dur: &DurationSpec, sign: i32, local: time::UtcOffset) -> OffsetDateTime` — calendar months first with end-of-month clamping (Jan 31 + 1M = Feb 28/29), then fixed millis

- [ ] **Step 1: Write the failing tests**

```rust
// expr/value.rs
#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::datetime;

    #[test]
    fn duration_literals() {
        assert_eq!(parse_duration_lit("1w"), Some(DurationSpec { calendar_months: 0, fixed_millis: 7 * 86_400_000 }));
        assert_eq!(parse_duration_lit("2M"), Some(DurationSpec { calendar_months: 2, fixed_millis: 0 }));
        assert_eq!(parse_duration_lit("1y"), Some(DurationSpec { calendar_months: 12, fixed_millis: 0 }));
        assert_eq!(parse_duration_lit("30m"), Some(DurationSpec { calendar_months: 0, fixed_millis: 1_800_000 }));
        assert_eq!(parse_duration_lit("1x"), None);
        assert_eq!(parse_duration_lit("w"), None);
    }

    #[test]
    fn month_arithmetic_clamps() {
        let jan31 = datetime!(2025-01-31 0:00 UTC);
        let feb = date_add(jan31, &parse_duration_lit("1M").unwrap(), 1, time::UtcOffset::UTC);
        assert_eq!(feb, datetime!(2025-02-28 0:00 UTC)); // 2025 not a leap year
        let leap = date_add(datetime!(2024-01-31 0:00 UTC), &parse_duration_lit("1M").unwrap(), 1, time::UtcOffset::UTC);
        assert_eq!(leap, datetime!(2024-02-29 0:00 UTC));
    }

    #[test]
    fn promotion() {
        assert_eq!(promote_num(&Value::Str("12.5".into())), Some(12.5));
        assert_eq!(promote_num(&Value::Bool(true)), None);
        assert!(promote_date(&Value::Str("2025-04-01".into())).is_some());
        assert!(promote_date(&Value::Str("책".into())).is_none());
    }

    #[test]
    fn total_order_ranking() {
        let mut v = vec![Value::Null, Value::Str("b".into()), Value::List(vec![]),
                         Value::Num(9.0), Value::Bool(false), Value::Bool(true)];
        v.sort_by(total_order);
        assert!(matches!(v[0], Value::Bool(false)));
        assert!(matches!(v[5], Value::Null));
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p oximemo-core expr::value`
Expected: compile error (module missing).

- [ ] **Step 3: Implement**

Add to `error.rs` (inside `enum CoreError`, before `Other`):

```rust
#[error("expression error at {line}:{col}: {message}")]
Expr { message: String, line: u32, col: u32 },
```

Create `expr/mod.rs`:

```rust
//! Bases-compatible expression engine (spec 2026-08-25 §2).
pub mod value;
pub mod lexer;
pub mod parser;
pub mod eval;
pub mod funcs;
```

(create empty `lexer.rs`/`parser.rs`/`eval.rs`/`funcs.rs` placeholder modules now so the crate builds; they gain content in Tasks 2–5).

Implement `value.rs`: `Value`, `DurationSpec`, the five functions above. `format_num`: if `n.fract() == 0.0 { format!("{}", *n as i64) } else { format!("{n}") }`. `parse_date_ish` uses `time::Date::parse` / `time::PrimitiveDateTime::parse` with `time::format_description::well_known::Rfc3339` last. `date_add`: convert to local `Date`, add months (`year + months/12`, `month = months%12+1`, clamp day to `days_in_month`), rebuild `PrimitiveDateTime`, then `replace_offset` back and `+ sign * fixed_millis` via `time::Duration::milliseconds`.

- [ ] **Step 4: Run tests** — `cargo test -p oximemo-core expr::value` → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(core): expr value model with calendar-aware durations and total ordering"`

---

### Task 2: `expr::lexer`

**Files:**
- Create: `crates/oximemo-core/src/expr/lexer.rs` (content; tests inline)

**Interfaces:**
- Produces: `pub(crate) struct Span { pub line: u32, pub col: u32 }`; `pub(crate) enum Tok { Ident(String), Num(f64), Str(String), Op(&'static str) /* + - * / % == != > < >= <= ! && || . , ( ) [ ] */ }`; `pub(crate) struct Lexed { pub tok: Tok, pub span: Span }`; `pub(crate) fn tokenize(src: &str) -> Result<Vec<Lexed>, CoreError>` — skips whitespace; `//` line comments are NOT supported (YAML strings are single-line); strings in `"…"`/`'…'` with `\\` and `\"` escapes; numbers `[0-9]+(\.[0-9]+)?` (no leading sign — unary minus is an operator); identifiers `[A-Za-z_][A-Za-z0-9_]*` (Korean property names arrive via `note["이름"]`, never bare idents); unknown char → `CoreError::Expr { message: "unexpected character", line, col }`.

- [ ] **Step 1: Failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::CoreError;

    fn err_at(src: &str) -> (u32, u32) {
        match tokenize(src) { Err(CoreError::Expr { line, col, .. }) => (line, col), _ => panic!("expected error") }
    }

    #[test]
    fn tokens_and_spans() {
        let toks = tokenize("status != \"done\"").unwrap();
        assert!(matches!(&toks[0].tok, Tok::Ident(s) if s == "status"));
        assert!(matches!(&toks[1].tok, Tok::Op(o) if *o == "!="));
        assert_eq!((toks[2].span.line, toks[2].span.col), (1, 10));
    }

    #[test]
    fn strings_numbers_ops() {
        assert!(tokenize(r#""a \"b\" c""#).is_ok());
        assert!(matches!(tokenize("3.14").unwrap()[0].tok, Tok::Num(n) if (n - 3.14).abs() < 1e-9));
        assert!(matches!(tokenize("a && !b || c").unwrap()[1].tok, Tok::Op(o) if *o == "&&"));
    }

    #[test]
    fn error_position_is_line_col() {
        assert_eq!(err_at("a $ b"), (1, 3));
        assert_eq!(err_at("ok\n  @"), (2, 3));
    }
}
```

- [ ] **Step 2: Run** — `cargo test -p oximemo-core expr::lexer` → FAIL (missing impl)
- [ ] **Step 3: Implement** — hand-rolled char scanner over `src.chars().enumerate()` tracking line/col (col = 1-based char count). Multi-char operators checked longest-first (`==` before `=`, `&&`, `||`, `!=`, `>=`, `<=`).
- [ ] **Step 4: Run** — PASS
- [ ] **Step 5: Commit** — `feat(core): expr lexer with span tracking`

---

### Task 3: `expr::parser` — AST + Pratt parser + proptest round-trip

**Files:**
- Create: `crates/oximemo-core/src/expr/parser.rs`

**Interfaces:**
- Produces:
  - `pub enum Expr { Lit(crate::expr::value::Value /* Bool|Num|Str only */), Path(Vec<String>), Call { name: String, args: Vec<Expr> }, Method { target: Box<Expr>, name: String, args: Vec<Expr> }, Index { target: Box<Expr>, index: Box<Expr> }, Unary { op: &'static str /* "!" "-" */, expr: Box<Expr> }, Binary { op: &'static str, lhs: Box<Expr>, rhs: Box<Expr> } }`
  - `pub fn parse_expr(src: &str) -> Result<Expr, CoreError>`
  - `pub fn expr_to_string(e: &Expr) -> String` (canonical printer: `Path` joined with `.`, strings re-quoted with `"`, binary ops parenthesized left-assoc)
- Precedence (low→high): `||` < `&&` < (`==` `!=` `<` `>` `<=` `>=`) < (`+` `-`) < (`*` `/` `%`) < unary `!` `-` < postfix (`.` member, `(` call, `[` index).
- Postfix rules: `Ident` followed by `.` + `Ident` chains fold into `Path` (parser builds path greedily from a leading ident stream); a `(` after a `Path` of length 1 whose head is a known global function name (`now today date list if isEmpty isBlank typeof length contains startsWith endsWith lower upper trim replace split join includes first last unique sort round floor ceil abs min max sum mean format hasTag inFolder`) produces `Call`; `(` after any other expr produces `Method`; `.` after a non-path expr is a parse error (`"x".contains("y")` must lex as Str then `.` → error: Bases method-on-literal syntax is not required by the spec examples — string ops are global functions `contains(s, sub)`).

**IMPORTANT correction baked into tests:** the spec's function table lists method *forms*; the parser supports only global call form. `d.format("…")` from spec §2 becomes `format(d, "…")`. Record this divergence in the task report (spec §2 table note), do not silently support both.

- [ ] **Step 1: Failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::CoreError;

    #[test]
    fn precedence_and_paths() {
        let e = parse_expr("note.rating >= 4 && status != \"done\"").unwrap();
        assert!(matches!(e, Expr::Binary { op: "&&", .. }));
        let e2 = parse_expr("(now() - \"1w\") < file.updated").unwrap();
        assert!(matches!(e2, Expr::Binary { op: "<", .. }));
        let p = parse_expr("formula.age").unwrap();
        assert!(matches!(p, Expr::Path(segs) if segs == vec!["formula", "age"]));
    }

    #[test]
    fn unary_index_call() {
        assert!(matches!(parse_expr("!favorite").unwrap(), Expr::Unary { op: "!", .. }));
        assert!(matches!(parse_expr("note.tags[0]").unwrap(), Expr::Index { .. }));
        assert!(matches!(parse_expr("if(x > 1, \"a\", \"b\")").unwrap(), Expr::Call { name, .. } if name == "if"));
    }

    #[test]
    fn errors_carry_spans() {
        match parse_expr("a +") {
            Err(CoreError::Expr { line, col, .. }) => assert_eq!((line, col), (1, 4)),
            _ => panic!("expected parse error"),
        }
    }

    proptest::proptest! {
        #[test]
        fn roundtrip(s in r#"(note|file|formula|this)\.([a-z_][a-z0-9_]*)( (==|!=|<|>|>=|<=) [0-9]+)?"#) {
            if let Ok(e) = parse_expr(&s) {
                let printed = expr_to_string(&e);
                let reparsed = parse_expr(&printed).unwrap();
                assert_eq!(expr_to_string(&reparsed), printed);
            }
        }
    }
}
```

- [ ] **Step 2: Run** — `cargo test -p oximemo-core expr::parser` → FAIL
- [ ] **Step 3: Implement** — token-vector cursor + precedence-climbing loop exactly per the table; path folding: when the primary parser sees `Ident`, it consumes `.` `Ident` pairs while the accumulated path is not callable in `Call` position (decide at the `(` postfix: `Path.len() == 1 && GLOBALS.contains(head)` → `Call`, else `Method { target: Path }`).
- [ ] **Step 4: Run** — PASS (including the proptest)
- [ ] **Step 5: Commit** — `feat(core): expr pratt parser with canonical printer`

---

### Task 4: `expr::eval` — context, resolution, operators, promotion semantics

**Files:**
- Create: `crates/oximemo-core/src/expr/eval.rs`

**Interfaces (consumed by Task 9's executor):**
- `pub struct EvalClock { pub now_utc: time::OffsetDateTime, pub local: time::UtcOffset }`
- `pub struct EvalCtx<'a> { pub clock: &'a EvalClock, pub depth: std::cell::Cell<u32> }`
- `pub struct RowData<'a>` — per-row resolution scope:
  - `pub fn from_record(rec: &'a crate::store::index::IndexRecord, formulas: &'a std::collections::HashMap<String, Result<Value, CoreError>>, this: Option<&'a RowData<'a>>) -> Self`
  - Internally stores `rec`, `formulas`, `this`; derives `folder` (path up to last `/`, `""` at root), `format` (`"markdown"|"html"` from extension), `name` (`rec.title` else filename stem).
- `pub fn resolve(path: &[String], row: &RowData) -> Result<Value, CoreError>`:
  - `["file", f]`: `created|updated` → `Date(rec.*_at)`, `favorite` → `Bool`, `tags` → `List<Str>`, `path|folder|name|format` → `Str`. Unknown → `Ok(Value::Null)`.
  - `["note", k]` or single-segment `[k]`: `rec.props.get(k)` → PropValue→Value; miss + `k ∈ {created, updated, favorite}` (CORE_KEYS minus id/deleted, `props.rs:19`) → file fallback; else `Null`.
  - `["formula", n]`: lookup `formulas` (Ok→value, Err→re-raise as cell error).
  - `["this", rest…]`: `this` row's `resolve`, or `Null` when absent.
  - `["id"]` → `Str(rec.id.to_string())`.
- `pub fn eval(e: &Expr, row: &RowData, ctx: &EvalCtx) -> Result<Value, CoreError>`:
  - `Lit` → clone. `Path` → `resolve`. `Index` → eval target+index; `List` + `Num` integral → element (OOB → `Null`); `List` + `Str` → property-style lookup not supported → error; else error.
  - `Unary !` → truthiness (`Null`→true, `Bool`→!b, `Num≠0`, `Str` non-empty → error — keep strict: only Bool/Null invertible, else error). `Unary -` → `promote_num` else error.
  - `Binary` per spec §2: `+ - * / %` with Num/Date/Duration promotion (`Date ± Duration` via `date_add`; `Date - Date` → Num ms; `Str` promoted to `Duration` only when the other operand is a Date and `parse_duration_lit` succeeds; `/` by 0.0 and any non-finite result → error); `==`/`!=` per the equality rules (cross-type Str↔Num/Str↔Date parse attempts; list membership when either side is a List of the other's members); `< > <= >=` with `promote_num`/`promote_date`, same-kind compare (`Str` lexicographic, `Bool` false<true), mismatched non-promotable kinds → error; `&&`/`||` short-circuit on strict Bool (Null treated as false, non-Bool non-Null → error).
  - Depth cap: `ctx.depth` incremented on entry to `eval`, `Cell::set` back on exit; > 64 → error `"expression nesting too deep"` (also guards `formula.*` fan-in; formula graph itself is cycle-checked at load in Task 6).
- `fn truthy(v: &Value) -> Result<bool, CoreError>` helper (Bool→b, Null→false, else error).

- [ ] **Step 1: Failing tests** (build a `RowData` from a hand-built `IndexRecord`; helper `fn rec(props: &[(&str, PropValue)]) -> IndexRecord` fills required fields `id/created_at/updated_at/hash/favorite/path/tags/props/deleted/preview`)

```rust
#[test]
fn core_key_fallback_and_null() {
    let r = rec(&[]); let row = RowData::from_record(&r, &HashMap::new(), None);
    assert_eq!(resolve(&["favorite".into()], &row).unwrap(), Value::Bool(false));   // bare → core fallback
    assert_eq!(resolve(&["nope".into()], &row).unwrap(), Value::Null);             // unknown → Null
    assert_eq!(resolve(&["file".into(), "folder".into()], &row).unwrap(), Value::Str("book".into())); // from path "book/x.md"
}

#[test]
fn arithmetic_promotion_and_duration() {
    let row = empty_row();
    let e = |s: &str| eval(&parse_expr(s).unwrap(), &row, &test_ctx()).unwrap();
    assert!(matches!(e("2 + \"3\""), Value::Num(n) if n == 5.0));
    let jan = e("date(\"2025-01-31\") + \"1M\"");
    assert!(matches!(jan, Value::Date(d) if d.date() == time::Date::from_calendar_date(2025, time::Month::February, 28).unwrap()));
    assert!(eval(&parse_expr("1 / 0").unwrap(), &row, &test_ctx()).is_err());
}

#[test]
fn equality_membership_and_dates() {
    let row = row_with_props(&[("genre", PropValue::List(vec!["SF".into(), "Essay".into()]))]);
    let e = |s: &str| eval(&parse_expr(s).unwrap(), &row, &test_ctx()).unwrap();
    assert_eq!(e("genre == \"SF\""), Value::Bool(true));
    assert_eq!(e("\"2025-04-01\" == date(\"2025-04-01\")"), Value::Bool(true));
    assert_eq!(e("note.missing == 1"), Value::Bool(false)); // Null vs Num: simply unequal
}

#[test]
fn strict_boolean_logic() {
    let row = empty_row();
    assert!(eval(&parse_expr("1 && true").unwrap(), &row, &test_ctx()).is_err());
    assert_eq!(eval(&parse_expr("!null").unwrap(), &row, &test_ctx()).unwrap(), Value::Bool(true));
}
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat(core): expr evaluator with contextual promotion and core-key fallback`

---

### Task 5: `expr::funcs` — function library

**Files:**
- Create: `crates/oximemo-core/src/expr/funcs.rs`

**Interfaces:**
- `pub fn call_function(name: &str, args: Vec<Value>, ctx: &EvalClock, ctx2: &EvalCtx) -> Result<Value, CoreError>` — arity/type errors are `CoreError::Expr` with the message naming the function.
- Signatures (global form only, per Task 3):
  - `now() → Date(clock.now_utc)`, `today() → Date(midnight in clock.local)`, `date(s) → Date` (via `parse_date_ish`), `list(...) → List`, `if(c, a, b) → a|b` (strict-Bool c), `isEmpty(v) → Bool` (Null|Str ""|List []), `isBlank(v) → Bool` (isEmpty or whitespace-only Str), `typeof(v) → Str` (`"null|bool|number|string|list|date|duration"`), `length(v) → Num` (Str chars | List len; else error)
  - String: `contains(s, sub)` (Str only), `startsWith`, `endsWith`, `lower`, `upper`, `trim`, `replace(s, from, to)` (all occurrences), `split(s, sep) → List<Str>`, `join(list, sep) → Str` (members stringified via `group_string`)
  - List: `includes(list, v)` (equality semantics == `Binary ==`), `first`, `last` (empty → Null), `unique`, `sort` (via `total_order`)
  - Numeric: `round(n)` (half away from zero), `floor`, `ceil`, `abs`, `min(...)`, `max(...)`, `sum(list)` (Num members; Str members promoted, failure → error), `mean(list)`
  - Date: `format(d, fmt) → Str` with the literal substitutions `YYYY MM DD HH mm ss` (hand-rolled token replace; document that strftime syntax is not supported), `days(duration_or_ms_num) → Num` (`DurationSpec` → whole-day count of `calendar_months*30.44*864e5 + fixed_millis`; a `Date - Date` result is already Num ms — `days(x)` on Num divides by 86_400_000), fields `.year .month .day …` — **these are Path members, not functions**: extend Task 4's `resolve` so `["file","created","year"]`-style trailing segments resolve on Date/Duration values (three-segment paths with a Date-valued head member: `year → Num, month → Num(1-12), day → Num, hour, minute, second, weekday → Num(0=Sun)`). This is implemented in `eval.rs`'s `Path` arm: resolve the first two segments, then apply trailing segments as member access.
- `Method` eval: `eval`'s `Method { target, name, args }` arm calls `call_function(name, [target_val, args…])` — i.e. methods and globals share one table; `"2025-01-01".contains` style is still a parse error (Task 3), but `formula.age.days()` and `file.tags.includes("x")` parse (`Path` head + call) and route here. Update Task 3's parser if needed so `Path.len() > 1` followed by `(` produces `Method` — it already does; only the single-segment global names route to `Call`. `days` with zero user args arrives as `Method` with `args=[]` → `call_function("days", vec![target])`.

- [ ] **Step 1: Failing tests** — table-driven: `(src, expected)` pairs covering every function above plus date fields (`"file.updated.year"`, `"formula.age.days()"`) and two arity errors.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS. **Step 5: Commit** — `feat(core): expr function library and date member access`

---

### Task 6: `base.rs` — `BaseDef` model, YAML round-trip, validation

**Files:**
- Create: `crates/oximemo-core/src/base.rs` (replacing the Task-1 placeholder)

**Interfaces:**
- `#[derive(Debug, Clone, Serialize, Deserialize)] #[serde(rename_all = "camelCase")] pub struct BaseDef { pub filters: Option<FilterSpec>, pub formulas: Option<BTreeMap<String, String>>, pub properties: Option<BTreeMap<String, ColumnMeta>>, pub views: Vec<BaseViewDef>, #[serde(flatten)] pub extra: serde_yaml_ng::Mapping }`
- `pub struct ColumnMeta { pub display_name: Option<String> }` (serde camelCase)
- `#[serde(untagged)] pub enum FilterSpec { Expr(String), Group(FilterGroup) }`; `#[serde(rename_all = "lowercase")] pub enum FilterGroup { And(Vec<FilterSpec>), Or(Vec<FilterSpec>), Not(Vec<FilterSpec>) }` (single-element list under `not`)
- `#[serde(rename_all = "camelCase")] pub struct BaseViewDef { pub r#type: String /* string, not enum — unknown types preserved (spec §1) */, pub name: Option<String>, pub filters: Option<FilterSpec>, pub order: Option<Vec<OrderSpec>>, pub columns: Option<Vec<String>>, pub group_by: Option<GroupBySpec>, pub summaries: Option<BTreeMap<String, String>>, pub limit: Option<u32>, #[serde(flatten)] pub extra: serde_yaml_ng::Mapping }`
- `pub struct OrderSpec { pub property: String, pub direction: Option<String> /* "asc"|"desc", default asc */ }`, `pub struct GroupBySpec { pub property: String, pub direction: Option<String> }`
- `pub fn parse_base(yaml: &str) -> Result<BaseDef, CoreError>` — serde_yaml_ng, error mapped to `CoreError::Expr { message, line, col }` where the crate exposes a location (else 0/0)
- `pub fn write_base(def: &BaseDef) -> Result<String, CoreError>`
- `pub fn validate(def: &BaseDef) -> Result<Vec<String>, CoreError>` — returns warnings; hard errors are `Err`:
  - formula cycles (build graph over `formula.x` references extracted by `parse_expr` + `Path` scan) → Err
  - `columns`/`order`/`groupBy`/`summaries` referencing `formula.<n>` not in `formulas` → Err
  - `views: []` or missing → materialize one default table view **in `parse_base`** (`name: "Table"`, no filters) so downstream never sees an empty vec; this is a normalization, not a warning
  - filter referencing `this.` while `this` will be absent → warning string (surfaced later via `BasePage.warnings`)
  - unknown `views[].type` → warning (frontend renders the skipped tab)
- `pub const KNOWN_VIEW_TYPES: [&str; 4] = ["table", "board", "cards", "list"];`

- [ ] **Step 1: Failing tests** — round-trip the spec §1 example YAML verbatim (embed it as a `const SPEC_EXAMPLE: &str`); assert `views[0].group_by.as_ref().unwrap().property == "status"` (camelCase key works); assert `extra` preserves an unknown top-level key `future: 1` through `write_base→parse_base`; assert cycle error on `formulas: {a: 'formula.b == 1', b: 'formula.a == 1'}`; assert unresolved `columns: [formula.nope]` → Err; assert `views: []` materializes; assert unknown type `gantt` parses + warns.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS. **Step 5: Commit** — `feat(core): .query YAML model with validation and forward-compat round-trip`

---

### Task 7: `base.rs` — guarded file CRUD (`load/save/rename/trash/restore/list`)

**Files:**
- Modify: `crates/oximemo-core/src/base.rs`; Modify: `crates/oximemo-core/src/vault.rs` (Vault methods + a `bases: RwLock<HashMap<String, (SystemTime, BaseDef)>>` cache mirroring `schemas` at `vault.rs:79`)

**Interfaces (Vault methods; `paths()` is the existing accessor):**
- `fn query_rel_path(&self, rel: &str) -> Result<PathBuf>` — guard: reject empty, absolute, any `..` component, extension != `query`; canonicalize parent under `paths().vault` (symlink escape → the joined path's `canonicalize` prefix must equal the vault root's); reject paths under `.trash`/`_assets`/any component starting with `.` or `_` except the literal `queries` directory. All violations → `CoreError::other("invalid query path: …")`.
- `pub fn load_base(&self, rel: &str) -> Result<BaseDef>` — mtime-cached like `folder_schema` (`vault.rs:169-197`).
- `pub fn load_base_raw(&self, rel: &str) -> Result<(String /*yaml*/, SystemTime /*mtime*/)>`
- `pub fn save_base(&self, rel: &str, yaml: &str, expected_mtime: Option<SystemTime>) -> Result<()>` — parse-validate first (never persist a file that won't load); mtime mismatch → `CoreError::other("query modified elsewhere; reload")`; write via temp-file + rename in the same directory.
- `pub fn rename_base(&self, from: &str, to: &str, expected_mtime: Option<SystemTime>) -> Result<()>` — validates `to`, refuses existing destination.
- `pub fn trash_base(&self, rel: &str) -> Result<String /*token*/>` — moves to `.trash/_queries/<unix_millis>-<filename>` (create dir), returns the trash-relative token.
- `pub fn restore_base(&self, token: &str) -> Result<String /*restored rel path*/>` — token guard (`..`/absolute/separators rejected; must be a single filename), refuses if destination exists.
- `pub fn list_bases(&self) -> Result<Vec<BaseInfo>>` — recursive walk of the vault root skipping `.trash`, `_assets`, hidden dirs; collects `*.query`; `pub struct BaseInfo { pub path: String /*vault-relative*/, pub name: String /*stem*/, pub mtime: SystemTime, pub loadable: bool /*parse smoke-test*/ }`; sorted by path; duplicate stems remain listed (ambiguity is the caller's to surface — spec §6).
- `pub fn invalidate_base_caches(&self)` — clears the mtime cache (watcher hook point).

- [ ] **Step 1: Failing tests** (`tmp_vault()` fixture, `vault.rs:2573`): save→load round-trip; save with stale mtime → conflict error; save of invalid YAML → error and original file untouched; `../escape.query` and `/abs.query` and `notes/x.md` rejected; rename refuses existing; trash→`list_bases` hides it→restore round-trips; `.trash/x.query` rejected as a load path; unknown top-level key survives save.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat(core): guarded .query file CRUD with rename/trash/restore`

---

### Task 8: snapshot cache

**Files:**
- Modify: `crates/oximemo-core/src/vault.rs` — add field `snapshot: RwLock<Option<SnapshotState>>` to `Vault` (init `None` in `open`, `vault.rs:121-127`); modify `query_notes` (`vault.rs:1504-1508`)

**Interfaces:**
- `struct SnapshotState { gen: (std::time::SystemTime, u64 /*len*/), recs: std::sync::Arc<Vec<IndexRecord>> }`
- `pub fn snapshot(&self) -> Result<std::sync::Arc<Vec<IndexRecord>>>`:
  1. `let meta = std::fs::metadata(self.paths.meta_db_path())?;` `let gen = (meta.modified()?, meta.len());`
  2. cache hit on `gen` → return Arc clone (no lock, no redb open)
  3. miss → `let recs = self.with_redb(|idx| idx.export_since(None))?;` — if `recs.len() > 50_000` return `Arc::new(recs)` **without caching** (budget); else store + return
- `query_notes` becomes:
  ```rust
  pub fn query_notes(&self, query: &crate::props::NoteQuery) -> Result<crate::props::QueryPage> {
      let recs = self.snapshot()?;
      let summaries: Vec<MemoSummary> = recs.iter().map(|r| r.to_summary()).collect();
      let (items, total) = query.apply(summaries);
      Ok(crate::props::QueryPage { items, total })
  }
  ```
- Rationale comment in code: redb is opened transiently under an fs2 flock (vault.rs:1-15) so an in-process counter cannot see CLI writes; the file stat is the cross-process generation.

- [ ] **Step 1: Failing tests** — seed 3 notes; `v.snapshot()` twice → `Arc::ptr_eq` true; create a note (bumps meta.redb) → `Arc::ptr_eq` false and the new snapshot contains it; `query_notes` still passes its existing tests (`vault.rs:4119`).

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run — full crate suite** (`cargo test -p oximemo-core`) → PASS.
- [ ] **Step 5: Commit** — `perf(core): generation-keyed snapshot cache shared by query_notes`

---

### Task 9: `run_base` executor — pipeline, DTOs, clock, group paging

**Files:**
- Modify: `crates/oximemo-core/src/base.rs` (executor lives here, `pub mod` re-export in lib.rs unchanged)

**Interfaces:**
- `#[derive(Debug, Clone, Serialize)] pub struct BaseCell { pub value: Option<Value>, pub error: Option<String> }` (`Value` gets `Serialize/Deserialize` in Task 1 — add the derives there)
- `#[derive(Debug, Clone, Serialize)] pub struct BaseRow { pub summary: MemoSummary, pub folder: String, pub format: String, pub cells: Vec<BaseCell> }`
- `#[derive(Debug, Clone, Serialize)] pub struct GroupCount { pub key: String, pub count: usize }`
- `#[derive(Debug, Clone, Serialize)] pub struct BasePage { pub rows: Vec<BaseRow>, pub total: usize, pub group_counts: Option<Vec<GroupCount>>, pub summaries: Option<BTreeMap<String, SummaryValue>>, pub clock: EvalClockDto { pub now_utc: String /*rfc3339*/, pub local_offset_seconds: i32 }, pub result_key: String, pub warnings: Vec<String> }`
- `pub struct SummaryValue { pub name: String, pub value: Value }`
- `pub enum BaseSource { Inline(BaseDef), Path(String) }`
- `pub struct RunBaseReq { pub view_index: usize, pub offset: usize, pub limit: u32, pub group: Option<String>, pub now_ms: Option<i64>, pub local_offset_seconds: Option<i32>, pub include_group_counts: bool, pub include_summaries: bool, pub this_id: Option<MemoId> }`
- `impl Vault { pub fn run_base(&self, source: &BaseSource, req: &RunBaseReq) -> Result<BasePage> }`:
  1. def = match source (Path → `load_base`; Inline → as-is); `validate` → hard errors bubble, warnings collected.
  2. view = `def.views.get(req.view_index).ok_or(CoreError::other("view index out of range"))?`.
  3. clock = `now_ms`/offset or system (`UtcOffset::current_local_offset().unwrap_or(UTC)`).
  4. Compile: filter exprs (base + view `FilterSpec` → Vec<Expr>, ANDed); formulas map name→Expr; columns = view.columns or default `[file.name]`; order specs; groupBy.
  5. snapshot → for each record with `!rec.deleted`: build `RowData::from_record(rec, &formula_values, this_row)` where `formula_values` is computed per row first (each formula evaluated once, memoized, errors stored); evaluate filters → keep rows that are `Ok(Bool(true))` (an `Ok(non-Bool)` filter or Err filter is **query-fatal**: return `Err` — spec §2).
  6. Sort keys: group key (if groupBy) then order specs then `rec.id` ascending. Each key = `Option<Value>` (resolve error / Null → `None` = last, regardless of direction; group key `None` → 그룹 없음). Direction: invert `total_order` result for `desc`.
  7. Apply `view.limit` (hard cap) → dataset. `total` = dataset len.
  8. `group_counts` (when `include_group_counts` and groupBy): count per `group_string`, ordered by groupBy direction; include the 그룹 없음 bucket last.
  9. `summaries` (when `include_summaries`): for each `(path, fnname)` collect resolved `Ok` values over the dataset → `All/Checked/Unchecked/Empty/Filled/Unique/Average/Sum/Min/Max/Median` (Num aggregation promotes Str members; any promotion failure → summary value = Null with the error recorded in `warnings`).
  10. `req.group == Some(k)`: page slice = dataset rows whose `group_string == k` (k = `""` for 그룹 없음), offset/limit within that slice. Else slice the whole dataset.
  11. Cells: per row, resolve each column path → `BaseCell` (Err → `error: Some(msg)`).
  12. `result_key` = Task 10's fingerprint (return `String::new()` placeholder in this task; Task 10 replaces it — **do not** ship this task without Task 10 landing in the same branch; the plan's commit order enforces it).
- `pub fn default_columns(view: &BaseViewDef) -> Vec<String>` — `view.columns.clone().unwrap_or_else(|| vec!["file.name".into()])`

- [ ] **Step 1: Failing tests** (`tmp_vault` + a helper writing a `.query` via `save_base`): seed 6 notes across `book/` and `film/` with `status`/`rating` props + 1 trashed note:
  - filters narrow correctly (nested and/or/not from the spec example)
  - soft-deleted note absent; `file.folder` never starts with `.trash`
  - `order: [note.rating desc]` numeric (rating `"9"` > `"10"` as numbers), ties broken by id asc across two pages (`offset 0/3` disjoint, union = full set)
  - groupBy `status`: rows arrive group-major; `group_counts` sums to `total`; `group=Some("읽는중")` returns only that group
  - `limit: 2` caps `total` and `group_counts`
  - formula `(now() - file.created).days()` ≥ 0 in cells; a formula erroring on one row yields `cells[i].error` and the row stays
  - filter referencing `this.` with `this_id: None` → `warnings` non-empty
  - `view_index` 99 → error
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat(core): run_base executor with group-major stable paging and aggregates`

---

### Task 10: `BaseResultCache` — fingerprint + bounded LRU

**Files:**
- Modify: `crates/oximemo-core/src/base.rs`, `crates/oximemo-core/src/vault.rs` (Vault field `base_results: parking_lot::Mutex<BaseResultCache>`)

**Interfaces:**
- `#[derive(PartialEq, Eq, Hash, Clone)] pub struct ResultKey { pub source_hash: u64 /*blake3 of canonical YAML (Path: file bytes at load; Inline: write_base output)*/, pub view_index: usize, pub gen: (SystemTime, u64) /*snapshot generation*/, pub clock_ms: i64, pub local_offset_seconds: i32, pub group_counts: bool, pub summaries: bool }` — `group` is NOT in the key: the cached `BaseResult` stores the full dataset + counts, and `group` pages slice it.
- `pub struct BaseResult { pub row_indices: Vec<usize> /*into a shared row vec*/, pub rows: Vec<BaseRow> /*full dataset, cells included*/, pub total: usize, pub group_counts: Option<Vec<GroupCount>>, pub summaries: Option<BTreeMap<String, SummaryValue>> }`
- `pub struct BaseResultCache { map: HashMap<ResultKey, Arc<BaseResult>>, order: VecDeque<ResultKey> }` — `get`, `put` (evict LRU beyond 16), `clear_source(source_hash)` (watcher hook), `clear_all()`.
- `run_base` rewires: build key → cache hit: slice page from `Arc<BaseResult>` (zero re-evaluation) and fill `result_key` with a stable rendering (`format!("{source_hash:016x}-{view}-{gen:?}")`); miss: execute Task 9's pipeline into `BaseResult`, `put`, slice.
- Snapshot-gen coupling guarantees: index writes change `gen`, query edits change `source_hash`, clock changes key — no stale slices possible.

- [ ] **Step 1: Failing tests** — same seeded vault: call `run_base` twice with the same key → second call returns identical rows and does not re-evaluate (assert via a counter is impractical; instead assert `result_key` equality + insert an instrumentation `pub fn cache_len(&self) -> usize` on Vault and assert it stays 1 across paging offsets 0/3/6, grows per distinct view_index, resets to 0 after `invalidate_base_caches` + snapshot bump); edit the `.query` (save_base) → new key; create a note → new key.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `perf(core): bounded evaluated-result cache for run_base pages`

---

### Task 11: `base_props` — property catalog for builders

**Files:**
- Modify: `crates/oximemo-core/src/base.rs` (executor helper + Vault method)

**Interfaces:**
- `#[derive(Serialize)] pub struct PropInfo { pub key: String, pub kinds: Vec<String> /*"text"|"select"|"multiselect"|"bool"|"date" observed*/, pub options: Vec<String> /*top ≤50 by frequency, then alpha*/ }`
- `impl Vault { pub fn base_props(&self) -> Result<Vec<PropInfo>> }` — one snapshot pass over non-deleted records: for each `(key, PropValue)` accumulate kind + value frequency (`BTreeMap<String, u32>`); Str with ≤20 distinct observed values → kind `select` else `text`; `List` → `multiselect`; `Bool` → `bool`; Str matching `parse_date_ish` for ≥80% of observed values → `date`. Sorted by key. Cached in the result cache under a fixed synthetic key that embeds `gen` (reuse `BaseResultCache` with a reserved `source_hash: 0`).

- [ ] **Step 1: Failing tests** — mixed props: select with 3 values → options sorted by frequency; long-cardinality Str → `text` with empty options; ISO strings → `date`; List → `multiselect`; second call with unchanged index does not grow `cache_len` beyond +1.
- [ ] **Step 2–5:** FAIL → implement → PASS → `feat(core): base_props observed property catalog`.

---

### Task 12: Tauri commands, watcher widening, `bases:changed`

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs` (commands module ~line 670+, `invoke_handler` list at line 246, `spawn_watcher` at line 359)
- Modify: `crates/oximemo-core/src/watcher.rs` (`is_user_content` ~line 106)
- Modify: `apps/desktop/src/lib/types.ts`, `apps/desktop/src/lib/api.ts`, `apps/desktop/src/lib/tauri.ts`

**Interfaces:**
- `watcher.rs`: `is_user_content` gains `.query` in the extension match (the `matches!` arm at line 107-110).
- `lib.rs` `spawn_watcher` `on_change` (line 365-375): first branch —
  ```rust
  if path.extension().is_some_and(|e| e == "query") {
      if let Ok(v) = oximemo_core::Vault::open(Some(&vault_path)) {
          v.invalidate_base_caches();
      }
      let _ = emit_handle.emit("bases:changed", ());
      return; // no reindex, no git enqueue: .query is not note content
  }
  ```
- Commands (all in `commands`, registered in `generate_handler`, mirroring `query_notes` at line 820):
  - `run_base(state, source: BaseSourceDto, req: RunBaseReqDto) -> Result<BasePage, String>` (DTOs serde-transparent over the core types; `BaseSourceDto::{ Inline { def: serde_yaml_ng via String? } }` — **use `Inline { yaml: String }`** and parse in the command so the wire type is plain strings, not nested YAML values)
  - `list_bases(state) -> Result<Vec<BaseInfo>, String>`
  - `load_base(state, path: String) -> Result<LoadBaseDto { yaml: String, mtime_ms: u64 }, String>`
  - `save_base(state, path: String, yaml: String, expected_mtime_ms: Option<u64>) -> Result<LoadBaseDto, String>` (returns fresh mtime for the next save)
  - `rename_base(state, from: String, to: String, expected_mtime_ms: Option<u64>) -> Result<(), String>` + `app.emit("bases:changed")`
  - `trash_base(state, path: String) -> Result<String, String>` + emit; `restore_base(state, token: String) -> Result<String, String>` + emit
  - `base_props(state) -> Result<Vec<PropInfo>, String>`
- `types.ts`: mirror `BaseCell/BaseRow/BasePage/GroupCount/SummaryValue/PropInfo/BaseInfo/RunBaseReq/BaseSource` (snake_case JSON as serialized by serde default — **add `#[serde(rename_all = "camelCase")]` on the DTO structs in Rust instead** and use camelCase in TS, matching `MemoSummary`'s existing wire style).
- `api.ts`: `runBase(source: BaseSource, req: RunBaseReq)`, `listBases()`, `loadBase(path)`, `saveBase(path, yaml, expectedMtimeMs?)`, `renameBase(from, to, expectedMtimeMs?)`, `trashBase(path)`, `restoreBase(token)`, `baseProps()` — typed `invoke` wrappers exactly like `queryNotes` (`api.ts` pattern).
- `tauri.ts` browser fallback: each new command throws `Error("query views are desktop-only")` (spec decision); add a `bases:changed` listener registration stub (no-op).

- [ ] **Step 1: Write the failing check** — `cd apps/desktop && bun run build` fails: unknown TS types. **Step 2: confirm.** **Step 3: Implement all of the above;** Rust DTO structs get `#[derive(Serialize)] #[serde(rename_all = "camelCase")]`.
- [ ] **Step 4: Verify** — `cargo check -p oximemo-core` and `cargo check` in `apps/desktop/src-tauri`, `bun run build` in `apps/desktop` → all PASS.
- [ ] **Step 5: Commit** — `feat: run_base/list_bases/load/save/rename/trash/restore/base_props commands with bases:changed`

---

### Task 13: CLI — `oximemo base` subcommands

**Files:**
- Modify: `crates/oximemo-cli/src/main.rs` (Cmd enum, line 34), `crates/oximemo-cli/src/commands.rs`, `crates/oximemo-cli/src/format.rs`

**Interfaces:**
- `Cmd::Base { #[command(subcommand)] sub: BaseCmd }`; `enum BaseCmd { List { #[arg(long, default_value = "table")] format: String }, Run { path: String, #[arg(long)] view: Option<usize>, #[arg(long, default_value_t = 30)] limit: u32, #[arg(long, default_value_t = 0)] offset: usize }, Rename { from: String, to: String }, Trash { path: String }, Restore { token: String } }`
- `commands.rs::cmd_base_list(vault, format)` — table: `PATH  NAME  MODIFIED  STATUS(⚠ when !loadable)`; json/ndjson like existing commands.
- `cmd_base_run(vault, path, view, limit, offset)` — `run_base(Path(path), RunBaseReq { view_index: view.unwrap_or(0), offset, limit, group: None, now/offset: None, include_group_counts: true, include_summaries: false, this_id: None })`; output: header `path · view-name · N rows`; then a fixed-width table of `file.name` + up to 4 columns (`group_string(cell.value)` cell text, `⚠` on error); then group counts line. Prints `warnings` to stderr.
- Wire in `main.rs` dispatch (match arm alongside the existing commands) — no domain logic in the binary (`main.rs:1-4`).

- [ ] **Step 1: Failing test** — none of the CLI has unit tests today (thin adapter); write one in `commands.rs` for the pure formatter: `format_base_table(&BasePage) -> String` renders header + N rows + `⚠` markers. TDD the formatter, hand-verify the command wiring manually.
- [ ] **Step 2: Run formatter test** — FAIL. **Step 3: Implement formatter + subcommands.** **Step 4:** formatter test PASS + manual: against the dev vault `oximemo base list` then `oximemo base run` on a scratch `.query` (create via `oximemo` later plans; for now write one by hand in the vault) prints the expected table.
- [ ] **Step 5: Commit** — `feat(cli): oximemo base list/run/rename/trash/restore`

---

## Self-Review (done at planning time)

- **Spec coverage vs Plan A scope** (§2 engine → Tasks 1–5; §1 model → Task 6; §3 caches/pipeline/CRUD/commands/watcher/CLI → Tasks 7–13; §9 Rust tests → every task; budgets → Task 8/10 caps; `bases:changed` → Task 12): covered. §4–§6 (Table/board/builder/embeds/location union) are Plans B–F by the spec's own "Implementation plans" section — not gaps.
- **Placeholders:** Task 9 Step 12's `result_key: String::new()` is explicitly resolved by Task 10 in the same branch; no other TBDs.
- **Type consistency:** `Value` derives Serialize added in Task 1 note of Task 9 (`BaseCell` needs it — Task 1 code block lists derives `Debug, Clone, PartialEq`; Task 9 step says add `Serialize, Deserialize` — resolved: Task 1 must derive all four; implementers of Task 1: include `serde::Serialize, serde::Deserialize`). `ResultKey.gen` matches `SnapshotState.gen`. `RunBaseReq` field names identical in Tasks 9/12/13.
- **Known deliberate divergence:** method-call syntax (`d.format(...)`) parses only on `Path` heads (Task 3/5); the spec §2 table's "(+ method forms)" note is satisfied through the shared function table, and string-literal method calls are parse errors. Flagged in Task 3.
