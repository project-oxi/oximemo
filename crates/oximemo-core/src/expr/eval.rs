//! Tree-walking evaluator for the expression engine (spec 2026-08-25 §2).
//!
//! [`eval`] is the entry point used by filters and row pipelines; it walks
//! the [`Expr`] AST against one [`RowData`] scope and produces a [`Value`].
//! The design keeps evaluation total and terminating:
//!
//! - No assignment, loops, or recursion in the language itself; the only
//!   recursion is the AST walk, capped by [`MAX_EVAL_DEPTH`] via
//!   [`EvalCtx::depth`].
//! - Runtime errors are [`CoreError::Expr`] with `line: 0, col: 0` (parse
//!   errors carry real positions; the split is spec §2's error taxonomy).
//! - Function calls are injected through [`eval_with_calls`]. [`eval`]
//!   itself uses a default resolver that rejects every name ("unknown
//!   function"); `expr::funcs` (Task 5) installs the real table by
//!   delegating to [`eval_with_calls`]. Method calls (`file.hasTag("x")`)
//!   route through the same resolver with the evaluated target as the
//!   first argument, so both call forms share one dispatch path.

use std::cell::Cell;
use std::cmp::Ordering;
use std::collections::HashMap;

use time::{OffsetDateTime, UtcOffset};

use crate::error::CoreError;
use crate::expr::parser::Expr;
use crate::expr::value::{
    DurationSpec, Value, date_add, parse_duration_lit, promote_date, promote_num, total_order,
    type_name,
};
use crate::memo::NoteFormat;
use crate::props::PropValue;
use crate::store::index::IndexRecord;
use crate::tasks::{Priority, StatusType, TaskRow, TaskWarningKind};

/// Maximum AST depth one evaluation may descend before erroring (spec §2:
/// "call depth capped"). Also bounds `formula.*` fan-in re-entry; the
/// formula graph itself is cycle-checked at load time.
pub const MAX_EVAL_DEPTH: u32 = 64;

/// Pinned per-view-session clock (spec §2: `now()` is pinned once per view
/// session, not per page). `date_add` uses `local` for calendar-month
/// arithmetic; `now_utc` feeds `now()`/`today()` in `expr::funcs`.
pub struct EvalClock {
    pub now_utc: OffsetDateTime,
    pub local: UtcOffset,
}

/// Shared, re-entrant evaluation state. `depth` counts nested
/// [`eval_with_calls`] frames; a single context may be reused across rows.
pub struct EvalCtx<'a> {
    pub clock: &'a EvalClock,
    pub depth: Cell<u32>,
}

/// What one row of a base dataset is (spec §4): a whole note, or a
/// single indexed task inside one. `file.*`/`note.*` always serve the
/// parent note record; only `task.*` depends on the subject.
pub enum RowSubject<'a> {
    Note,
    Task(&'a TaskRow),
}

/// Per-row resolution scope (spec §1 "Identifier resolution"). Borrows the
/// indexed record, the pre-computed formula results, and — for embeds —
/// the embedding note's scope. `folder`/`format`/`name` are derived once
/// at construction because every row lookup would otherwise re-derive
/// them from `path`.
pub struct RowData<'a> {
    rec: &'a IndexRecord,
    formulas: &'a HashMap<String, Result<Value, CoreError>>,
    this: Option<&'a RowData<'a>>,
    folder: String,
    format: &'static str,
    name: String,
    /// Full-screen `.query` scope (spec §1): the row is the query file
    /// itself, not a note — `file.*` serves only the five synthesized
    /// keys and every note-ish namespace resolves Null.
    query_file: bool,
    /// What this row is (spec §4): the whole note, or one indexed task
    /// inside it. Only the `task.*` namespace consults it.
    subject: RowSubject<'a>,
}
impl<'a> RowData<'a> {
    /// Build a row scope. `formulas` holds the memoized results for the
    /// `formula.*` namespace (`Err` entries are re-raised as cell errors
    /// on lookup); `this` chains the embedding note's scope for `this.*`.
    pub fn from_record(
        rec: &'a IndexRecord,
        formulas: &'a HashMap<String, Result<Value, CoreError>>,
        this: Option<&'a RowData<'a>>,
    ) -> Self {
        let folder = rec
            .path
            .rsplit_once('/')
            .map(|(dir, _)| dir.to_string())
            .unwrap_or_default();
        let format = match NoteFormat::from_rel(&rec.path) {
            NoteFormat::Markdown => "markdown",
            NoteFormat::Html => "html",
        };
        let name = rec.title.clone().unwrap_or_else(|| file_stem(&rec.path));
        Self {
            rec,
            formulas,
            this,
            folder,
            format,
            name,
            query_file: false,
            subject: RowSubject::Note,
        }
    }

    /// Full-screen `.query` scope (spec §1): the row is the query file
    /// itself, so `file.*` serves exactly the five synthesized keys —
    /// `path`, `folder`, `name` (from the rel path) and `created`/
    /// `updated` (both from the file's mtime; fs creation time is not
    /// portable), supplied via `rec` by the caller. Every note-ish
    /// namespace — `note.*`/bare props, `id`, `favorite`, `tags`,
    /// `format` — resolves Null: a `.query` file is not a note.
    pub fn from_query_file(
        rec: &'a IndexRecord,
        formulas: &'a HashMap<String, Result<Value, CoreError>>,
    ) -> Self {
        Self {
            query_file: true,
            ..Self::from_record(rec, formulas, None)
        }
    }

    /// Task-subject row scope (spec §4): `file.*`/`note.*` resolve
    /// against the parent note record; `task.*` against `task`.
    pub fn from_task(
        rec: &'a IndexRecord,
        task: &'a TaskRow,
        formulas: &'a HashMap<String, Result<Value, CoreError>>,
        this: Option<&'a RowData<'a>>,
    ) -> Self {
        Self {
            subject: RowSubject::Task(task),
            ..Self::from_record(rec, formulas, this)
        }
    }

    /// Tag list for the row (consumed by `file.hasTag(t)`).
    pub fn tags(&self) -> &[String] {
        &self.rec.tags
    }

    /// Folder portion of the row path (consumed by `file.inFolder(p)`).
    pub fn folder(&self) -> &str {
        &self.folder
    }
}

/// Filename stem (extension stripped) used for `file.name` when the record
/// carries no H1-derived title. A leading dot (`.hidden`) is kept whole.
fn file_stem(path: &str) -> String {
    let file_name = path.rsplit_once('/').map(|(_, f)| f).unwrap_or(path);
    match file_name.rsplit_once('.') {
        Some((stem, _)) if !stem.is_empty() => stem.to_string(),
        _ => file_name.to_string(),
    }
}

/// Resolve a dot-path against a row (spec §1 identifier table). Unknown
/// keys resolve to [`Value::Null`], never an error; the only error path is
/// re-raising a stored formula error.
///
/// Trailing segments after a Date- or Duration-valued head resolve as
/// field accessors (`year`, `month`, `day`, `hour`, `minute`, `second`,
/// `weekday`). `file.created.year` and `formula.<date>.weekday` arrive
/// here as `Path(["file","created","year"])` /
/// `Path(["formula","x","weekday"])`.
///
/// `local` is the pinned per-view-session UTC offset (spec §2); date
/// fields are extracted from `dt.to_offset(local)` so a stored-UTC
/// timestamp at the day boundary renders the same day/weekday the
/// caller sees in `today()`/`format(...)`. Stored timestamps remain
/// UTC; the offset is applied at extraction time only.
pub fn resolve(path: &[String], row: &RowData, local: UtcOffset) -> Result<Value, CoreError> {
    if let Some(v) = resolve_standard(path, row, local)? {
        return Ok(v);
    }
    // Date-member fallback: try progressively shorter prefixes and apply
    // date-field extraction when a prefix resolves to a Date/Duration.
    // Longest prefix wins so `file.created.year` (head `file.created`)
    // overrides a hypothetical single-segment `file.year`.
    for split in (1..path.len()).rev() {
        let head = match resolve_standard(&path[..split], row, local)? {
            Some(v) => v,
            None => continue,
        };
        match head {
            Value::Date(_) | Value::Duration(_) => {
                let mut v = head;
                for seg in &path[split..] {
                    v = date_member(&v, seg, local)?;
                }
                return Ok(v);
            }
            _ => continue,
        }
    }
    Ok(Value::Null)
}

/// Standard identifier walk: `id`, `file.*`, `note.*`, `formula.*`,
/// `task.*`, bare props, and `this.*`. Returns `Ok(None)` when the path
/// cannot be resolved through any namespace — a signal to try the
/// date-member fallback in [`resolve`]. The only `Err` path is a stored
/// formula error. `local` feeds `task.*` date lifting.
fn resolve_standard(
    path: &[String],
    row: &RowData,
    local: UtcOffset,
) -> Result<Option<Value>, CoreError> {
    match path {
        [k] if k == "id" => Ok(Some(if row.query_file {
            Value::Null
        } else {
            Value::Str(row.rec.id.to_string())
        })),
        [ns, rest @ ..] => match ns.as_str() {
            "file" if rest.len() <= 1 => Ok(Some(resolve_file(rest, row)?)),
            "note" if rest.len() <= 1 => Ok(Some(resolve_note(rest, row)?)),
            "formula" if rest.len() <= 1 => Ok(Some(resolve_formula(rest, row)?)),
            "task" if rest.len() <= 1 => Ok(Some(resolve_task(rest, row, local)?)),
            "this" => match (row.this, rest.is_empty()) {
                (Some(this), false) => resolve_standard(rest, this, local),
                _ => Ok(Some(Value::Null)),
            },
            _ if path.len() == 1 => Ok(Some(resolve_note(path, row)?)),
            _ => Ok(None),
        },
        _ => Ok(Some(Value::Null)),
    }
}

/// Date/Duration field accessor. `weekday` is 0 = Sunday. Unknown fields
/// error so a typo surfaces instead of silently producing Null.
///
/// `local` is the pinned system-local UTC offset; the underlying date
/// is converted via `dt.to_offset(local)` before extracting year/
/// month/day/hour/minute/second/weekday. A stored-UTC timestamp at
/// midnight rolls to the previous day in a negative-offset zone, and
/// that day/weekday is what callers see.
fn date_member(v: &Value, field: &str, local: UtcOffset) -> Result<Value, CoreError> {
    let n: i32 = match v {
        Value::Date(dt) => {
            let dt = dt.to_offset(local);
            match field {
                "year" => dt.year(),
                "month" => dt.month() as i32,
                "day" => dt.day() as i32,
                "hour" => dt.hour() as i32,
                "minute" => dt.minute() as i32,
                "second" => dt.second() as i32,
                "weekday" => dt.weekday().number_days_from_sunday() as i32,
                other => {
                    return Err(rt_err(format!(
                        "date has no field `{other}` (expected year, month, day, hour, minute, second, weekday)"
                    )));
                }
            }
        }
        Value::Duration(_) => {
            return Err(rt_err(format!(
                "duration has no field `{field}` (use `days()` instead)"
            )));
        }
        _ => {
            return Err(rt_err(format!(
                "cannot read field `{field}` from {}",
                type_name(v)
            )));
        }
    };
    Ok(Value::Num(n as f64))
}

/// `file.*`: the indexed core fields plus the derived path values. In a
/// full-screen query scope only the five synthesized keys (spec §1)
/// resolve; `favorite`/`tags`/`format` are Null there because a
/// `.query` file has none of them.
fn resolve_file(rest: &[String], row: &RowData) -> Result<Value, CoreError> {
    let rec = row.rec;
    let v = match rest {
        [f] => match f.as_str() {
            "created" => Value::Date(rec.created_at),
            "updated" => Value::Date(rec.updated_at),
            "favorite" if !row.query_file => Value::Bool(rec.favorite),
            "tags" if !row.query_file => {
                Value::List(rec.tags.iter().map(|t| Value::Str(t.clone())).collect())
            }
            "path" => Value::Str(rec.path.clone()),
            "folder" => Value::Str(row.folder.clone()),
            "name" => Value::Str(row.name.clone()),
            "format" if !row.query_file => Value::Str(row.format.to_string()),
            _ => Value::Null,
        },
        _ => Value::Null,
    };
    Ok(v)
}

/// `note.<k>` and bare `<k>`: frontmatter props first; on a miss the core
/// fields `created`/`updated`/`favorite` fall back to their `file.*`
/// values (CORE_KEYS minus `id`/`deleted` — those two have no fallback:
/// `id` is handled above, `deleted` is not part of the dataset). In a
/// full-screen query scope every `note.*` is Null (spec §1: a `.query`
/// file is not a note).
fn resolve_note(rest: &[String], row: &RowData) -> Result<Value, CoreError> {
    if row.query_file {
        return Ok(Value::Null);
    }
    if let [k] = rest {
        if let Some(pv) = row.rec.props.get(k) {
            return Ok(prop_to_value(pv));
        }
        return Ok(match k.as_str() {
            "created" => Value::Date(row.rec.created_at),
            "updated" => Value::Date(row.rec.updated_at),
            "favorite" => Value::Bool(row.rec.favorite),
            _ => Value::Null,
        });
    }
    Ok(Value::Null)
}

/// `formula.<n>`: memoized result, error re-raise, or `Null` for names the
/// load-time closure did not compute (load-time validation rejects
/// unresolved references before evaluation ever runs).
fn resolve_formula(rest: &[String], row: &RowData) -> Result<Value, CoreError> {
    match rest {
        [n] => match row.formulas.get(n) {
            Some(Ok(v)) => Ok(v.clone()),
            // CoreError is not Clone; re-raise the display form as a
            // runtime (line 0/col 0) cell error with the formula's name.
            Some(Err(e)) => Err(rt_err(format!("formula `{n}`: {e}"))),
            None => Ok(Value::Null),
        },
        _ => Ok(Value::Null),
    }
}

/// `task.*` (Tasks spec §4 identifier table). Only resolves on a task
/// subject; a note subject yields Null for every key so shared filters
/// stay valid across sources. Dates lift to local midnight in the
/// pinned offset; `Priority::None` maps to Null (absent, not zero).
fn resolve_task(rest: &[String], row: &RowData, local: UtcOffset) -> Result<Value, CoreError> {
    let RowSubject::Task(t) = &row.subject else {
        return Ok(Value::Null);
    };
    let date = |d: Option<time::Date>| {
        d.map(|d| Value::Date(d.midnight().assume_offset(local)))
            .unwrap_or(Value::Null)
    };
    let v = match rest {
        [k] => match k.as_str() {
            "status" => Value::Str(t.symbol.to_string()),
            "type" => Value::Str(status_type_name(t.status_type).into()),
            "text" => Value::Str(t.text.clone()),
            "tags" => Value::List(t.tags.iter().map(|s| Value::Str(s.clone())).collect()),
            "section" => t.section.clone().map(Value::Str).unwrap_or(Value::Null),
            "line" => Value::Num(t.line as f64),
            "created" => date(t.created),
            "start" => date(t.start),
            "scheduled" => date(t.scheduled),
            "due" => date(t.due),
            "done" => date(t.done),
            "cancelled" => date(t.cancelled),
            "priority" => priority_num(t.priority),
            "recurring" => Value::Bool(t.recurrence.is_some()),
            "invalid" => Value::Bool(!t.warnings.is_empty()),
            "warnings" => Value::List(
                t.warnings
                    .iter()
                    .map(|w| Value::Str(format!("{}: {}", warning_kind_name(w.kind), w.raw)))
                    .collect(),
            ),
            _ => Value::Null,
        },
        _ => Value::Null,
    };
    Ok(v)
}

/// SCREAMING_SNAKE variant names, matching `StatusType`'s serde rename.
/// `NON_TASK` cannot appear on an indexed `TaskRow` (spec §2 excludes
/// those lines), but the mapping stays total.
fn status_type_name(t: StatusType) -> &'static str {
    match t {
        StatusType::Todo => "TODO",
        StatusType::InProgress => "IN_PROGRESS",
        StatusType::OnHold => "ON_HOLD",
        StatusType::Done => "DONE",
        StatusType::Cancelled => "CANCELLED",
        StatusType::NonTask => "NON_TASK",
    }
}

/// 5-level priority scale → −2…2. `Priority::None` maps to Null
/// (absent, not zero) so `task.priority == 0` still means "Medium".
fn priority_num(p: Priority) -> Value {
    match p {
        Priority::Lowest => Value::Num(-2.0),
        Priority::Low => Value::Num(-1.0),
        Priority::None => Value::Null,
        Priority::Medium => Value::Num(0.0),
        Priority::High => Value::Num(1.0),
        Priority::Highest => Value::Num(2.0),
    }
}

/// camelCase warning-kind names, matching `TaskWarningKind`'s serde
/// rename.
fn warning_kind_name(k: TaskWarningKind) -> &'static str {
    match k {
        TaskWarningKind::InvalidValue => "invalidValue",
        TaskWarningKind::Duplicate => "duplicate",
        TaskWarningKind::UnsupportedRule => "unsupportedRule",
    }
}

/// Lossless `PropValue` → `Value` (spec §2: Str|Bool|List convert 1:1).
fn prop_to_value(pv: &PropValue) -> Value {
    match pv {
        PropValue::Str(s) => Value::Str(s.clone()),
        PropValue::Bool(b) => Value::Bool(*b),
        PropValue::List(items) => {
            Value::List(items.iter().map(|s| Value::Str(s.clone())).collect())
        }
    }
}

/// Evaluate `e` against `row`. Installs the [`crate::expr::funcs`]
/// table as the default resolver; row-aware methods (`file.hasTag(t)`,
/// `file.inFolder(p)`) are intercepted earlier in [`eval_node`]'s
/// `Method` arm and read [`RowData`] directly so they do not depend on
/// the value of `file` (which is `Null` by design).
pub fn eval(e: &Expr, row: &RowData, ctx: &EvalCtx) -> Result<Value, CoreError> {
    let resolve = |name: &str, args: Vec<Value>| -> Result<Value, CoreError> {
        crate::expr::funcs::call_function(name, args, ctx.clock, ctx)
    };
    eval_with_calls(e, row, ctx, &resolve)
}

/// Injected function-call resolver: receives the callee name and its
/// already-evaluated arguments; for method calls the first argument is
/// the evaluated target. The lifetime captures any references the
/// resolver borrows (e.g. the active [`EvalCtx`] inside [`eval`]).
pub type CallResolver<'a> = dyn Fn(&str, Vec<Value>) -> Result<Value, CoreError> + 'a;

/// Evaluate with an injected [`CallResolver`] (see the alias for the
/// calling convention).
pub fn eval_with_calls<'a>(
    e: &Expr,
    row: &RowData,
    ctx: &EvalCtx,
    calls: &CallResolver<'a>,
) -> Result<Value, CoreError> {
    let depth = ctx.depth.get() + 1;
    if depth > MAX_EVAL_DEPTH {
        return Err(rt_err("expression nesting too deep"));
    }
    ctx.depth.set(depth);
    let out = eval_node(e, row, ctx, calls);
    ctx.depth.set(depth - 1);
    out
}

fn eval_node<'a>(
    e: &Expr,
    row: &RowData,
    ctx: &EvalCtx,
    calls: &CallResolver<'a>,
) -> Result<Value, CoreError> {
    match e {
        Expr::Lit(v) => Ok(v.clone()),
        Expr::Path(path) => resolve(path, row, ctx.clock.local),
        Expr::Call { name, args } => {
            let mut vals = Vec::with_capacity(args.len());
            for a in args {
                vals.push(eval_with_calls(a, row, ctx, calls)?);
            }
            calls(name, vals)
        }
        Expr::Method { target, name, args } => {
            // Row-aware file methods: their target resolves to Null
            // (`file` alone is not a value) but they read RowData
            // directly. Detect the AST shape before evaluating the
            // target so the resolver never sees them.
            if let Expr::Path(segs) = target.as_ref()
                && segs.len() == 1
                && segs[0] == "file"
            {
                return dispatch_file_method(row, args, name, ctx, calls);
            }
            let mut vals = Vec::with_capacity(args.len() + 1);
            vals.push(eval_with_calls(target, row, ctx, calls)?);
            for a in args {
                vals.push(eval_with_calls(a, row, ctx, calls)?);
            }
            calls(name, vals)
        }
        Expr::Index { target, index } => {
            let t = eval_with_calls(target, row, ctx, calls)?;
            let i = eval_with_calls(index, row, ctx, calls)?;
            index_value(&t, &i)
        }
        Expr::Unary { op, expr } => {
            let v = eval_with_calls(expr, row, ctx, calls)?;
            match *op {
                // Strict inversion: only Bool and Null are invertible.
                "!" => Ok(Value::Bool(!truthy(&v)?)),
                "-" => match promote_num(&v) {
                    Some(n) if n.is_finite() => Ok(Value::Num(-n)),
                    Some(_) => Err(rt_err("numeric overflow: result is not finite")),
                    None => Err(rt_err(format!(
                        "unary `-` requires a number, got {}",
                        type_name(&v)
                    ))),
                },
                other => Err(rt_err(format!("unknown unary operator `{other}`"))),
            }
        }
        Expr::Binary { op, lhs, rhs } => eval_binary(op, lhs, rhs, row, ctx, calls),
    }
}

/// Row-aware `file.hasTag(t)` / `file.inFolder(p)`: the value table
/// cannot answer them (`file` alone is `Null`), so the `Method` arm
/// routes here before evaluating the target. Plain `hasTag`/`inFolder`
/// calls (`Expr::Call`) still hit the function table and error
/// "unknown function", matching the spec's grammar (file methods only).
fn dispatch_file_method<'a>(
    row: &RowData,
    args: &[Expr],
    name: &str,
    ctx: &EvalCtx,
    calls: &CallResolver<'a>,
) -> Result<Value, CoreError> {
    let eval_arg = |a: &Expr| eval_with_calls(a, row, ctx, calls);
    match name {
        "hasTag" => {
            if args.len() != 1 {
                return Err(rt_err(format!(
                    "hasTag(): expected exactly one argument, got {}",
                    args.len()
                )));
            }
            match eval_arg(&args[0])? {
                Value::Str(t) => Ok(Value::Bool(row.tags().iter().any(|tag| tag == &t))),
                _ => Err(rt_err("hasTag(): expected a string argument")),
            }
        }
        "inFolder" => {
            if args.len() != 1 {
                return Err(rt_err(format!(
                    "inFolder(): expected exactly one argument, got {}",
                    args.len()
                )));
            }
            match eval_arg(&args[0])? {
                Value::Str(p) => Ok(Value::Bool(in_folder(row.folder(), &p))),
                _ => Err(rt_err("inFolder(): expected a string argument")),
            }
        }
        other => Err(rt_err(format!(
            "file has no method `{other}` (expected hasTag, inFolder)"
        ))),
    }
}

/// Recursive prefix match per spec §1: `p` exact, `p/...` recursive.
fn in_folder(folder: &str, prefix: &str) -> bool {
    folder == prefix
        || (folder.len() > prefix.len()
            && folder.starts_with(prefix)
            && folder.as_bytes().get(prefix.len()) == Some(&b'/'))
}
fn eval_binary(
    op: &'static str,
    lhs: &Expr,
    rhs: &Expr,
    row: &RowData,
    ctx: &EvalCtx,
    calls: &CallResolver,
) -> Result<Value, CoreError> {
    match op {
        // Short-circuit: the rhs is not evaluated once the lhs decides.
        "&&" => {
            if !truthy(&eval_with_calls(lhs, row, ctx, calls)?)? {
                return Ok(Value::Bool(false));
            }
            Ok(Value::Bool(truthy(&eval_with_calls(
                rhs, row, ctx, calls,
            )?)?))
        }
        "||" => {
            if truthy(&eval_with_calls(lhs, row, ctx, calls)?)? {
                return Ok(Value::Bool(true));
            }
            Ok(Value::Bool(truthy(&eval_with_calls(
                rhs, row, ctx, calls,
            )?)?))
        }
        "==" | "!=" => {
            let l = eval_with_calls(lhs, row, ctx, calls)?;
            let r = eval_with_calls(rhs, row, ctx, calls)?;
            let eq = value_eq(&l, &r);
            Ok(Value::Bool(if op == "==" { eq } else { !eq }))
        }
        "<" | ">" | "<=" | ">=" => {
            let l = eval_with_calls(lhs, row, ctx, calls)?;
            let r = eval_with_calls(rhs, row, ctx, calls)?;
            let ord = compare(&l, &r)?;
            Ok(Value::Bool(match op {
                "<" => ord == Ordering::Less,
                ">" => ord == Ordering::Greater,
                "<=" => ord != Ordering::Greater,
                _ => ord != Ordering::Less,
            }))
        }
        _ => {
            let l = eval_with_calls(lhs, row, ctx, calls)?;
            let r = eval_with_calls(rhs, row, ctx, calls)?;
            arith(op, &l, &r, ctx.clock.local)
        }
    }
}

/// Postfix `target[index]`: integral list indexing only. Out-of-bounds
/// (including negative) is `Null`; string keys ("property-style" lookup)
/// and indexing non-lists are errors.
fn index_value(target: &Value, index: &Value) -> Result<Value, CoreError> {
    match (target, index) {
        (Value::List(items), Value::Num(n)) => {
            if !n.is_finite() || n.fract() != 0.0 {
                return Err(rt_err("list index must be an integer"));
            }
            if *n < 0.0 {
                return Ok(Value::Null);
            }
            Ok(items.get(*n as usize).cloned().unwrap_or(Value::Null))
        }
        (Value::List(_), Value::Str(_)) => {
            Err(rt_err("string indexing into a list is not supported"))
        }
        _ => Err(rt_err(format!("cannot index a {}", type_name(target)))),
    }
}

/// Strict boolean interpretation: `Bool` passes through, `Null` is false,
/// anything else is a type error (used by `!`, `&&`, `||`).
fn truthy(v: &Value) -> Result<bool, CoreError> {
    match v {
        Value::Bool(b) => Ok(*b),
        Value::Null => Ok(false),
        _ => Err(rt_err(format!("expected a boolean, got {}", type_name(v)))),
    }
}

/// Equality per spec §2: same-kind values compare structurally; Str↔Num
/// and Str↔Date attempt contextual parses (failure = simply unequal, not
/// an error); when exactly one side is a list, equality is membership of
/// the other side among its members (`note.<multiselect> == "x"`).
fn value_eq(l: &Value, r: &Value) -> bool {
    match (l, r) {
        (Value::List(xs), Value::List(ys)) => {
            xs.len() == ys.len() && xs.iter().zip(ys).all(|(x, y)| value_eq(x, y))
        }
        (Value::List(xs), other) | (other, Value::List(xs)) => {
            xs.iter().any(|m| scalar_eq(m, other))
        }
        _ => scalar_eq(l, r),
    }
}

fn scalar_eq(l: &Value, r: &Value) -> bool {
    match (l, r) {
        (Value::Str(_), Value::Num(_)) | (Value::Num(_), Value::Str(_)) => {
            matches!((promote_num(l), promote_num(r)), (Some(a), Some(b)) if a == b)
        }
        (Value::Str(_), Value::Date(_)) | (Value::Date(_), Value::Str(_)) => {
            matches!((promote_date(l), promote_date(r)), (Some(a), Some(b)) if a == b)
        }
        _ => l == r,
    }
}

/// Ordering comparison per spec §2: contextual promotion to a common kind
/// first (Date, then Num — an ISO string never parses as a number, so the
/// orders cannot conflict), then same-kind comparison (`Str` Unicode
/// scalar order, `Bool` false<true, lists by first member via
/// [`total_order`]). Mismatched non-promotable kinds are errors.
pub(crate) fn compare(l: &Value, r: &Value) -> Result<Ordering, CoreError> {
    if let (Some(a), Some(b)) = (promote_date(l), promote_date(r)) {
        return Ok(a.cmp(&b));
    }
    if let (Some(a), Some(b)) = (promote_num(l), promote_num(r)) {
        return Ok(a.total_cmp(&b));
    }
    if std::mem::discriminant(l) == std::mem::discriminant(r) {
        return Ok(total_order(l, r));
    }
    Err(rt_err(format!(
        "cannot compare {} with {}",
        type_name(l),
        type_name(r)
    )))
}

/// Arithmetic per spec §2: `+ - * / %` with contextual promotion.
/// Date/duration rules: `Date ± Duration → Date` (via saturating
/// `date_add`), `Duration + Date → Date`, `Date - Date → Num` (ms). A
/// `Str` promotes to `Duration` only in date context. Division by zero
/// and any non-finite result are errors.
fn arith(op: &'static str, l: &Value, r: &Value, local: UtcOffset) -> Result<Value, CoreError> {
    // Spec §2: only `+` and `-` combine dates with durations or two dates
    // (yielding a Num in ms). Any other operator against a date operand
    // is a type error, even if a duration operand is present — guarding
    // here keeps `Date * "1w"` from silently producing a Date via the
    // subtract path.
    let date_op = op == "+" || op == "-";
    // Date on the left.
    if let Some(d) = promote_date(l) {
        if date_op && let Some(dur) = duration_in_date_context(r) {
            let sign = if op == "+" { 1 } else { -1 };
            return Ok(Value::Date(date_add(d, &dur, sign, local)));
        }
        if op == "-"
            && let Some(d2) = promote_date(r)
        {
            return Ok(Value::Num((d - d2).whole_milliseconds() as f64));
        }
        return Err(rt_err(format!(
            "invalid operands for `{op}`: {} and {}",
            type_name(l),
            type_name(r)
        )));
    }
    // Date on the right with `+` (duration + date is commutative).
    if op == "+"
        && let Some(d2) = promote_date(r)
    {
        if let Some(dur) = duration_in_date_context(l) {
            return Ok(Value::Date(date_add(d2, &dur, 1, local)));
        }
        return Err(rt_err(format!(
            "invalid operands for `+`: {} and {}",
            type_name(l),
            type_name(r)
        )));
    }
    // Duration values combine component-wise (saturating, never panics).
    if let (Value::Duration(a), Value::Duration(b)) = (l, r) {
        if !date_op {
            return Err(rt_err(format!(
                "invalid operands for `{op}`: {} and {}",
                type_name(l),
                type_name(r)
            )));
        }
        let (months, millis) = if op == "+" {
            (
                a.calendar_months.saturating_add(b.calendar_months),
                a.fixed_millis.saturating_add(b.fixed_millis),
            )
        } else {
            (
                a.calendar_months.saturating_sub(b.calendar_months),
                a.fixed_millis.saturating_sub(b.fixed_millis),
            )
        };
        return Ok(Value::Duration(DurationSpec {
            calendar_months: months,
            fixed_millis: millis,
        }));
    }
    num_arith(op, l, r)
}

/// Duration operand in date context: a `Duration` value, or a string that
/// parses as a duration literal. Strings promote only here — `"1w" + 1`
/// and `"1w" + "1w"` stay numeric-domain errors.
fn duration_in_date_context(v: &Value) -> Option<DurationSpec> {
    match v {
        Value::Duration(d) => Some(d.clone()),
        Value::Str(s) => parse_duration_lit(s),
        _ => None,
    }
}

fn num_arith(op: &'static str, l: &Value, r: &Value) -> Result<Value, CoreError> {
    let type_error = || {
        rt_err(format!(
            "invalid operands for `{op}`: {} and {}",
            type_name(l),
            type_name(r)
        ))
    };
    let a = promote_num(l).ok_or_else(type_error)?;
    let b = promote_num(r).ok_or_else(type_error)?;
    let n = match op {
        "+" => a + b,
        "-" => a - b,
        "*" => a * b,
        "/" | "%" => {
            if b == 0.0 {
                return Err(rt_err(if op == "/" {
                    "division by zero"
                } else {
                    "modulo by zero"
                }));
            }
            if op == "/" { a / b } else { a % b }
        }
        other => return Err(rt_err(format!("unknown operator `{other}`"))),
    };
    if !n.is_finite() {
        return Err(rt_err("numeric overflow: result is not finite"));
    }
    Ok(Value::Num(n))
}

/// Runtime (evaluation-time) error: line/col are zero because the AST no
/// longer carries source positions (spec §2's parse/runtime split).
fn rt_err(message: impl Into<String>) -> CoreError {
    CoreError::Expr {
        message: message.into(),
        line: 0,
        col: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::expr::parser::parse_expr;
    use crate::expr::value::parse_date_ish;
    use crate::memo::{MemoHash, MemoId};
    use std::cell::Cell;
    use std::collections::HashMap;
    use std::sync::LazyLock;
    use time::macros::datetime;
    use time::{Date, Month, UtcOffset};
    use uuid::Uuid;

    static NO_FORMULAS: LazyLock<HashMap<String, Result<Value, CoreError>>> =
        LazyLock::new(HashMap::new);
    static EMPTY_REC: LazyLock<IndexRecord> = LazyLock::new(|| rec(&[]));

    fn rec(props: &[(&str, PropValue)]) -> IndexRecord {
        IndexRecord {
            id: MemoId(Uuid::nil()),
            created_at: datetime!(2025-01-01 00:00 UTC),
            updated_at: datetime!(2025-06-15 12:00 UTC),
            hash: MemoHash("b3-test".into()),
            favorite: false,
            path: "book/x.md".into(),
            title: None,
            tags: vec!["소설".into(), "wip".into()],
            props: props
                .iter()
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect(),
            deleted: false,
            deleted_at: None,
            preview: String::new(),
            tasks: Vec::new(),
            tasks_truncated: false,
        }
    }

    fn row_of<'r>(r: &'r IndexRecord) -> RowData<'r> {
        RowData::from_record(r, &NO_FORMULAS, None)
    }

    fn empty_row() -> RowData<'static> {
        row_of(&EMPTY_REC)
    }

    fn test_ctx() -> EvalCtx<'static> {
        static CLOCK: LazyLock<EvalClock> = LazyLock::new(|| EvalClock {
            now_utc: datetime!(2026-08-25 00:00 UTC),
            local: UtcOffset::UTC,
        });
        EvalCtx {
            clock: &CLOCK,
            depth: Cell::new(0),
        }
    }

    /// Test-only call resolver providing `date()` so date semantics can be
    /// exercised before the function library (Task 5) exists.
    fn eval_date(e: &Expr, row: &RowData, ctx: &EvalCtx) -> Result<Value, CoreError> {
        eval_with_calls(e, row, ctx, &|name, args| {
            if name == "date" {
                match args.as_slice() {
                    [Value::Str(s)] => parse_date_ish(s)
                        .map(Value::Date)
                        .ok_or_else(|| rt_err(format!("invalid date literal: {s}"))),
                    _ => Err(rt_err("date() takes exactly one string argument")),
                }
            } else {
                Err(rt_err(format!("unknown function: {name}")))
            }
        })
    }

    // ---- Resolution (brief Step 1) --------------------------------------

    #[test]
    fn core_key_fallback_and_null() {
        let r = rec(&[]);
        let no_formulas = HashMap::new();
        let row = RowData::from_record(&r, &no_formulas, None);
        assert_eq!(
            resolve(&["favorite".into()], &row, time::UtcOffset::UTC).unwrap(),
            Value::Bool(false)
        ); // bare → core fallback
        assert_eq!(
            resolve(&["nope".into()], &row, time::UtcOffset::UTC).unwrap(),
            Value::Null
        ); // unknown → Null
        assert_eq!(
            resolve(
                &["file".into(), "folder".into()],
                &row,
                time::UtcOffset::UTC
            )
            .unwrap(),
            Value::Str("book".into())
        ); // from path "book/x.md"
    }

    #[test]
    fn arithmetic_promotion_and_duration() {
        let row = empty_row();
        let e = |s: &str| eval_date(&parse_expr(s).unwrap(), &row, &test_ctx()).unwrap();
        assert!(matches!(e("2 + \"3\""), Value::Num(n) if n == 5.0));
        let jan = e("date(\"2025-01-31\") + \"1M\"");
        assert!(matches!(jan, Value::Date(d)
            if d.date() == Date::from_calendar_date(2025, Month::February, 28).unwrap()));
        assert!(eval(&parse_expr("1 / 0").unwrap(), &row, &test_ctx()).is_err());
    }

    #[test]
    fn equality_membership_and_dates() {
        let r = rec(&[("genre", PropValue::List(vec!["SF".into(), "Essay".into()]))]);
        let no_formulas = HashMap::new();
        let row = RowData::from_record(&r, &no_formulas, None);
        let e = |s: &str| eval_date(&parse_expr(s).unwrap(), &row, &test_ctx()).unwrap();
        assert_eq!(e("genre == \"SF\""), Value::Bool(true));
        assert_eq!(
            e("\"2025-04-01\" == date(\"2025-04-01\")"),
            Value::Bool(true)
        );
        assert_eq!(e("note.missing == 1"), Value::Bool(false)); // Null vs Num: simply unequal
    }

    #[test]
    fn strict_boolean_logic() {
        let row = empty_row();
        assert!(eval(&parse_expr("1 && true").unwrap(), &row, &test_ctx()).is_err());
        assert_eq!(
            eval(&parse_expr("!null").unwrap(), &row, &test_ctx()).unwrap(),
            Value::Bool(true)
        );
    }

    // ---- Resolution details ---------------------------------------------

    #[test]
    fn file_namespace_fields() {
        let row = empty_row();
        assert_eq!(
            resolve(&["file".into(), "tags".into()], &row, time::UtcOffset::UTC).unwrap(),
            Value::List(vec![Value::Str("소설".into()), Value::Str("wip".into())])
        );
        assert_eq!(
            resolve(
                &["file".into(), "created".into()],
                &row,
                time::UtcOffset::UTC
            )
            .unwrap(),
            Value::Date(datetime!(2025-01-01 00:00 UTC))
        );
        assert_eq!(
            resolve(
                &["file".into(), "updated".into()],
                &row,
                time::UtcOffset::UTC
            )
            .unwrap(),
            Value::Date(datetime!(2025-06-15 12:00 UTC))
        );
        assert_eq!(
            resolve(
                &["file".into(), "favorite".into()],
                &row,
                time::UtcOffset::UTC
            )
            .unwrap(),
            Value::Bool(false)
        );
        assert_eq!(
            resolve(&["file".into(), "path".into()], &row, time::UtcOffset::UTC).unwrap(),
            Value::Str("book/x.md".into())
        );
        assert_eq!(
            resolve(&["file".into(), "bogus".into()], &row, time::UtcOffset::UTC).unwrap(),
            Value::Null
        );
        // Bare `id` stringifies the MemoId.
        assert_eq!(
            resolve(&["id".into()], &row, time::UtcOffset::UTC).unwrap(),
            Value::Str(Uuid::nil().hyphenated().to_string())
        );
    }

    #[test]
    fn row_derived_fields() {
        let mut r = rec(&[]);
        // No title: name = filename stem; markdown extension.
        let row = row_of(&r);
        assert_eq!(
            resolve(&["file".into(), "name".into()], &row, time::UtcOffset::UTC).unwrap(),
            Value::Str("x".into())
        );
        assert_eq!(
            resolve(
                &["file".into(), "format".into()],
                &row,
                time::UtcOffset::UTC
            )
            .unwrap(),
            Value::Str("markdown".into())
        );
        // Title wins over the stem.
        r.title = Some("제목".into());
        let row = row_of(&r);
        assert_eq!(
            resolve(&["file".into(), "name".into()], &row, time::UtcOffset::UTC).unwrap(),
            Value::Str("제목".into())
        );
        // Root file: folder is ""; html extension maps through NoteFormat.
        r.title = None;
        r.path = "root.md".into();
        let row = row_of(&r);
        assert_eq!(
            resolve(
                &["file".into(), "folder".into()],
                &row,
                time::UtcOffset::UTC
            )
            .unwrap(),
            Value::Str(String::new())
        );
        r.path = "a/b/page.html".into();
        let row = row_of(&r);
        assert_eq!(
            resolve(
                &["file".into(), "format".into()],
                &row,
                time::UtcOffset::UTC
            )
            .unwrap(),
            Value::Str("html".into())
        );
        assert_eq!(
            resolve(&["file".into(), "name".into()], &row, time::UtcOffset::UTC).unwrap(),
            Value::Str("page".into())
        );
        // Bare namespace names and extra path segments are Null, not errors.
        assert_eq!(
            resolve(&["file".into()], &row, time::UtcOffset::UTC).unwrap(),
            Value::Null
        );
        assert_eq!(
            resolve(
                &["file".into(), "folder".into(), "deep".into()],
                &row,
                time::UtcOffset::UTC
            )
            .unwrap(),
            Value::Null
        );
    }

    #[test]
    fn prop_precedence_over_core_fallback() {
        let r = rec(&[("created", PropValue::Str("2020-01-01".into()))]);
        let row = row_of(&r);
        // A stored prop shadows the core fallback for the same key.
        assert_eq!(
            resolve(&["created".into()], &row, time::UtcOffset::UTC).unwrap(),
            Value::Str("2020-01-01".into())
        );
        assert_eq!(
            resolve(
                &["note".into(), "created".into()],
                &row,
                time::UtcOffset::UTC
            )
            .unwrap(),
            Value::Str("2020-01-01".into())
        );
        // `tags` and `deleted` are not fallback keys.
        let plain = empty_row();
        assert_eq!(
            resolve(&["tags".into()], &plain, time::UtcOffset::UTC).unwrap(),
            Value::Null
        );
        assert_eq!(
            resolve(&["deleted".into()], &plain, time::UtcOffset::UTC).unwrap(),
            Value::Null
        );
        assert_eq!(
            resolve(&["note".into()], &plain, time::UtcOffset::UTC).unwrap(),
            Value::Null
        );
    }

    #[test]
    fn formula_resolution_and_cell_error() {
        let r = rec(&[]);
        let mut formulas = HashMap::new();
        formulas.insert("age".to_string(), Ok(Value::Num(3.0)));
        formulas.insert(
            "bad".to_string(),
            Err(CoreError::Expr {
                message: "boom".into(),
                line: 7,
                col: 9,
            }),
        );
        let row = RowData::from_record(&r, &formulas, None);
        assert_eq!(
            resolve(
                &["formula".into(), "age".into()],
                &row,
                time::UtcOffset::UTC
            )
            .unwrap(),
            Value::Num(3.0)
        );
        // Stored errors are re-raised as runtime cell errors (0/0 position).
        let err = resolve(
            &["formula".into(), "bad".into()],
            &row,
            time::UtcOffset::UTC,
        )
        .unwrap_err();
        assert!(matches!(err, CoreError::Expr { message, line: 0, col: 0 }
            if message.contains("bad") && message.contains("boom")));
        assert_eq!(
            resolve(
                &["formula".into(), "nope".into()],
                &row,
                time::UtcOffset::UTC
            )
            .unwrap(),
            Value::Null
        );
    }

    #[test]
    fn this_resolution() {
        let outer_rec = rec(&[("genre", PropValue::Str("SF".into()))]);
        let outer = row_of(&outer_rec);
        let inner_rec = rec(&[]);
        let inner = RowData::from_record(&inner_rec, &NO_FORMULAS, Some(&outer));
        // `this.*` resolves through the embedding row's scope.
        assert_eq!(
            resolve(
                &["this".into(), "genre".into()],
                &inner,
                time::UtcOffset::UTC
            )
            .unwrap(),
            Value::Str("SF".into())
        );
        // Without a `this` row (or with an empty path) the namespace is Null.
        assert_eq!(
            resolve(
                &["this".into(), "genre".into()],
                &outer,
                time::UtcOffset::UTC
            )
            .unwrap(),
            Value::Null
        );
        assert_eq!(
            resolve(&["this".into()], &inner, time::UtcOffset::UTC).unwrap(),
            Value::Null
        );
    }

    // ---- task.* namespace (Tasks spec §4) --------------------------------

    #[test]
    fn task_namespace_resolves_every_spec_field() {
        let mut r = rec(&[]);
        r.path = "daily/2026-08-27.md".into();
        let task = crate::tasks::TaskRow {
            line: 4,
            indent_columns: 0,
            parent: None,
            symbol: '/',
            status_type: crate::tasks::StatusType::InProgress,
            text: "ship plan b".into(),
            tags: vec!["oss".into()],
            section: Some("Today".into()),
            created: Some(time::macros::date!(2026 - 08 - 20)),
            start: None,
            scheduled: None,
            due: Some(time::macros::date!(2026 - 08 - 30)),
            done: None,
            cancelled: None,
            priority: crate::tasks::Priority::High,
            recurrence: Some("every week".into()),
            warnings: vec![],
            line_hash: crate::tasks::TaskLineHash::of_line("- [/] ship plan b"),
        };
        let row = RowData::from_task(&r, &task, &NO_FORMULAS, None);
        let v = |p: &str| eval(&parse_expr(p).unwrap(), &row, &test_ctx()).unwrap();
        assert_eq!(v("task.status"), Value::Str("/".into()));
        assert_eq!(v("task.type"), Value::Str("IN_PROGRESS".into()));
        assert_eq!(v("task.text"), Value::Str("ship plan b".into()));
        assert_eq!(v("task.tags"), Value::List(vec![Value::Str("oss".into())]));
        assert_eq!(v("task.line"), Value::Num(4.0));
        assert_eq!(
            v("task.priority"),
            Value::Num(1.0),
            "High is +1 on the -2..2 scale"
        );
        assert_eq!(v("task.recurring"), Value::Bool(true));
        assert_eq!(v("task.invalid"), Value::Bool(false));
        assert_eq!(v("task.warnings"), Value::List(vec![]));
        assert_eq!(
            v("task.due"),
            Value::Date(datetime!(2026-08-30 0:00).assume_utc())
        );
        assert_eq!(
            v("task.created"),
            Value::Date(datetime!(2026-08-20 0:00).assume_utc())
        );
        // Dates lift to midnight in the pinned local offset, not UTC.
        let kst_clock = EvalClock {
            now_utc: OffsetDateTime::UNIX_EPOCH,
            local: UtcOffset::from_hms(9, 0, 0).unwrap(),
        };
        let kst_ctx = EvalCtx {
            clock: &kst_clock,
            depth: Cell::new(0),
        };
        assert_eq!(
            eval(&parse_expr("task.due").unwrap(), &row, &kst_ctx).unwrap(),
            Value::Date(datetime!(2026-08-30 0:00 +9))
        );
        assert_eq!(v("task.start"), Value::Null);
        assert_eq!(v("task.scheduled"), Value::Null);
        assert_eq!(v("task.done"), Value::Null);
        assert_eq!(v("task.cancelled"), Value::Null);
        assert_eq!(v("task.section"), Value::Str("Today".into()));
        assert_eq!(v("task.bogus"), Value::Null);
        // Parent-note namespaces still serve the parent record.
        assert_eq!(v("file.folder"), Value::Str("daily".into()));
        assert_eq!(v("file.path"), Value::Str("daily/2026-08-27.md".into()));

        // Warnings render as "<kind>: <raw>" with camelCase kinds, and a
        // missing section is Null.
        let mut warned = task.clone();
        warned.section = None;
        warned.warnings = vec![
            crate::tasks::TaskWarning {
                field: Some(crate::tasks::TaskField::Due),
                raw: "bogus-date".into(),
                kind: crate::tasks::TaskWarningKind::InvalidValue,
            },
            crate::tasks::TaskWarning {
                field: None,
                raw: "every fortnight".into(),
                kind: crate::tasks::TaskWarningKind::UnsupportedRule,
            },
        ];
        let warned_row = RowData::from_task(&r, &warned, &NO_FORMULAS, None);
        let w = |p: &str| eval(&parse_expr(p).unwrap(), &warned_row, &test_ctx()).unwrap();
        assert_eq!(
            w("task.warnings"),
            Value::List(vec![
                Value::Str("invalidValue: bogus-date".into()),
                Value::Str("unsupportedRule: every fortnight".into()),
            ])
        );
        assert_eq!(w("task.invalid"), Value::Bool(true));
        assert_eq!(w("task.section"), Value::Null);
    }

    #[test]
    fn task_priority_scale_maps_none_to_null() {
        // Lowest -2, Low -1, None -> Null, Medium 0, High 1, Highest 2.
        let mut r = rec(&[]);
        r.path = "daily/2026-08-27.md".into();
        let mut task = crate::tasks::TaskRow {
            line: 0,
            indent_columns: 0,
            parent: None,
            symbol: ' ',
            status_type: crate::tasks::StatusType::Todo,
            text: "t".into(),
            tags: vec![],
            section: None,
            created: None,
            start: None,
            scheduled: None,
            due: None,
            done: None,
            cancelled: None,
            priority: crate::tasks::Priority::None,
            recurrence: None,
            warnings: vec![],
            line_hash: crate::tasks::TaskLineHash::of_line("- [ ] t"),
        };
        let cases = [
            (crate::tasks::Priority::Lowest, Value::Num(-2.0)),
            (crate::tasks::Priority::Low, Value::Num(-1.0)),
            (crate::tasks::Priority::None, Value::Null),
            (crate::tasks::Priority::Medium, Value::Num(0.0)),
            (crate::tasks::Priority::High, Value::Num(1.0)),
            (crate::tasks::Priority::Highest, Value::Num(2.0)),
        ];
        for (p, want) in cases {
            task.priority = p;
            let row = RowData::from_task(&r, &task, &NO_FORMULAS, None);
            assert_eq!(
                resolve(&["task".into(), "priority".into()], &row, UtcOffset::UTC).unwrap(),
                want,
                "{p:?}"
            );
        }
    }

    #[test]
    fn task_namespace_is_null_for_note_subjects() {
        let r = rec(&[]);
        let row = RowData::from_record(&r, &NO_FORMULAS, None);
        assert_eq!(
            resolve(&["task".into(), "text".into()], &row, UtcOffset::UTC).unwrap(),
            Value::Null
        );
        // Through the full eval path too: Null, never an error.
        assert_eq!(
            eval(&parse_expr("task.text").unwrap(), &row, &test_ctx()).unwrap(),
            Value::Null
        );
    }

    #[test]
    fn query_file_scope_resolution() {
        // Full-screen `.query` scope (spec §1): the five synthesized
        // keys resolve; every note-ish namespace is Null.
        let mut q = rec(&[]);
        q.path = "queries/book-view.query".into();
        q.created_at = datetime!(2026-01-02 3:04:05 UTC);
        q.updated_at = datetime!(2026-01-02 3:04:05 UTC);
        let query_row = RowData::from_query_file(&q, &NO_FORMULAS);
        let row_rec = rec(&[("status", PropValue::Str("읽는중".into()))]);
        let row = RowData::from_record(&row_rec, &NO_FORMULAS, Some(&query_row));
        let r = |p: &[&str]| {
            resolve(
                &p.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
                &row,
                time::UtcOffset::UTC,
            )
            .unwrap()
        };
        // The five synthesized keys.
        assert_eq!(
            r(&["this", "file", "path"]),
            Value::Str("queries/book-view.query".into())
        );
        assert_eq!(r(&["this", "file", "folder"]), Value::Str("queries".into()));
        assert_eq!(r(&["this", "file", "name"]), Value::Str("book-view".into()));
        assert_eq!(
            r(&["this", "file", "created"]),
            Value::Date(datetime!(2026-01-02 3:04:05 UTC))
        );
        assert_eq!(
            r(&["this", "file", "updated"]),
            Value::Date(datetime!(2026-01-02 3:04:05 UTC))
        );
        // Date-member chaining still works through the synthesized date.
        assert_eq!(r(&["this", "file", "created", "year"]), Value::Num(2026.0));
        // Everything else in the scope is Null.
        for p in [
            &["this", "note", "status"][..],
            &["this", "file", "favorite"][..],
            &["this", "file", "tags"][..],
            &["this", "file", "format"][..],
            &["this", "id"][..],
        ] {
            assert_eq!(r(p), Value::Null, "{p:?}");
        }
        // The outer row's own namespaces are untouched.
        assert_eq!(r(&["status"]), Value::Str("읽는중".into()));
    }

    // ---- Operators -------------------------------------------------------

    #[test]
    fn index_access() {
        let row = empty_row();
        let e = |s: &str| eval(&parse_expr(s).unwrap(), &row, &test_ctx()).unwrap();
        assert_eq!(e("file.tags[0]"), Value::Str("소설".into()));
        assert_eq!(e("file.tags[9]"), Value::Null); // out of bounds
        assert_eq!(e("file.tags[-1]"), Value::Null); // negative = out of bounds
        assert!(eval(&parse_expr("file.tags[0.5]").unwrap(), &row, &test_ctx()).is_err());
        assert!(eval(&parse_expr("file.tags[\"a\"]").unwrap(), &row, &test_ctx()).is_err());
        assert!(eval(&parse_expr("1[0]").unwrap(), &row, &test_ctx()).is_err());
    }

    #[test]
    fn boolean_short_circuit() {
        let row = empty_row();
        assert_eq!(
            eval(&parse_expr("false && 1 / 0").unwrap(), &row, &test_ctx()).unwrap(),
            Value::Bool(false)
        );
        assert_eq!(
            eval(&parse_expr("true || 1 / 0").unwrap(), &row, &test_ctx()).unwrap(),
            Value::Bool(true)
        );
        assert_eq!(
            eval(&parse_expr("null && true").unwrap(), &row, &test_ctx()).unwrap(),
            Value::Bool(false)
        );
        assert_eq!(
            eval(&parse_expr("null || true").unwrap(), &row, &test_ctx()).unwrap(),
            Value::Bool(true)
        );
        // Non-Bool, non-Null operands are errors even on the deciding side.
        assert!(eval(&parse_expr("false || 1").unwrap(), &row, &test_ctx()).is_err());
        assert!(eval(&parse_expr("!5").unwrap(), &row, &test_ctx()).is_err());
        assert!(eval(&parse_expr("-true").unwrap(), &row, &test_ctx()).is_err());
        assert!(matches!(
            eval(&parse_expr("-\"5\"").unwrap(), &row, &test_ctx()).unwrap(),
            Value::Num(n) if n == -5.0
        ));
    }

    #[test]
    fn comparison_promotion_and_kind_errors() {
        let row = empty_row();
        let e = |s: &str| eval(&parse_expr(s).unwrap(), &row, &test_ctx()).unwrap();
        assert_eq!(e("\"b\" > \"a\""), Value::Bool(true));
        assert_eq!(e("10 >= 10"), Value::Bool(true));
        assert_eq!(e("3 < \"2\""), Value::Bool(false)); // numeric string promotion
        assert_eq!(e("true > false"), Value::Bool(true));
        assert_eq!(e("file.created < file.updated"), Value::Bool(true));
        assert_eq!(e("file.updated > \"2025-01-01\""), Value::Bool(true)); // date-string promotion
        // Mismatched non-promotable kinds are errors.
        assert!(eval(&parse_expr("true < \"a\"").unwrap(), &row, &test_ctx()).is_err());
        assert!(eval(&parse_expr("note.missing < 1").unwrap(), &row, &test_ctx()).is_err());
        assert!(eval(&parse_expr("file.created < 1").unwrap(), &row, &test_ctx()).is_err());
    }

    #[test]
    fn date_arithmetic() {
        let row = empty_row();
        let e = |s: &str| eval_date(&parse_expr(s).unwrap(), &row, &test_ctx()).unwrap();
        assert!(matches!(e("date(\"2025-01-02\") - date(\"2025-01-01\")"),
            Value::Num(n) if n == 86_400_000.0));
        // A date-string operand promotes for subtraction too.
        assert!(
            matches!(e("date(\"2025-01-02\") - \"2025-01-01\""), Value::Num(n) if n == 86_400_000.0)
        );
        // Duration + Date is commutative; a date-string left operand works.
        assert!(matches!(e("\"1w\" + date(\"2025-01-01\")"), Value::Date(_)));
        assert!(matches!(e("\"2025-01-08\" - \"1w\""), Value::Date(_)));
        let d = e("date(\"2025-01-08\") - \"1w\"");
        assert!(matches!(d, Value::Date(x)
            if x.date() == Date::from_calendar_date(2025, Month::January, 1).unwrap()));
        // Numbers are not durations; date + date is meaningless.
        assert!(
            eval_date(
                &parse_expr("date(\"2025-01-01\") + 1").unwrap(),
                &row,
                &test_ctx()
            )
            .is_err()
        );
        assert!(
            eval_date(
                &parse_expr("date(\"2025-01-01\") + date(\"2025-01-02\")").unwrap(),
                &row,
                &test_ctx()
            )
            .is_err()
        );
        // Spec §2: only `+`/`-` combine dates with durations or two dates.
        // `*`, `/`, `%` against any date operand must error, even if the
        // other operand parses as a duration literal.
        assert!(
            eval_date(
                &parse_expr("file.created * \"1w\"").unwrap(),
                &row,
                &test_ctx()
            )
            .is_err()
        );
        assert!(
            eval_date(
                &parse_expr("date(\"2025-01-01\") / \"1d\"").unwrap(),
                &row,
                &test_ctx()
            )
            .is_err()
        );
        assert!(
            eval_date(
                &parse_expr("date(\"2025-01-01\") % \"1d\"").unwrap(),
                &row,
                &test_ctx()
            )
            .is_err()
        );
        // The `+`/`-` date tracks still work after the op guard.
        assert!(matches!(e("file.created + \"1w\""), Value::Date(_)));
        assert!(matches!(e("file.created - \"1w\""), Value::Date(_)));
    }

    #[test]
    fn numeric_edges() {
        let row = empty_row();
        let e = |s: &str| eval(&parse_expr(s).unwrap(), &row, &test_ctx()).unwrap();
        assert!(matches!(e("2 - \"3\""), Value::Num(n) if n == -1.0));
        assert!(matches!(e("\"7\" % \"2\""), Value::Num(n) if n == 1.0));
        assert!(eval(&parse_expr("1 % 0").unwrap(), &row, &test_ctx()).is_err());
        assert!(eval(&parse_expr("1.0 / 0.0").unwrap(), &row, &test_ctx()).is_err());
        // Non-finite results (including "inf"-parsing strings) are errors.
        assert!(
            eval(
                &parse_expr("\"1e300\" * \"1e300\"").unwrap(),
                &row,
                &test_ctx()
            )
            .is_err()
        );
        assert!(eval(&parse_expr("\"inf\" + 1").unwrap(), &row, &test_ctx()).is_err());
        // Promotion failure on either operand is a type error.
        assert!(eval(&parse_expr("\"a\" + 1").unwrap(), &row, &test_ctx()).is_err());
    }

    #[test]
    fn equality_cross_type_and_lists() {
        let row = empty_row();
        let e = |s: &str| eval(&parse_expr(s).unwrap(), &row, &test_ctx()).unwrap();
        assert_eq!(e("\"5\" == 5"), Value::Bool(true));
        assert_eq!(e("\"x\" == 5"), Value::Bool(false)); // parse failure: unequal, not an error
        assert_eq!(e("1 != \"1\""), Value::Bool(false));
        assert_eq!(e("null == null"), Value::Bool(true));
        assert_eq!(
            eval_date(
                &parse_expr("1 == date(\"2025-01-01\")").unwrap(),
                &row,
                &test_ctx()
            )
            .unwrap(),
            Value::Bool(false)
        ); // no Num↔Date coercion

        let r = rec(&[
            ("genre", PropValue::List(vec!["SF".into(), "Essay".into()])),
            ("same", PropValue::List(vec!["SF".into()])),
            ("other", PropValue::List(vec!["SF".into(), "Sci-Fi".into()])),
        ]);
        let row = row_of(&r);
        let e = |s: &str| eval(&parse_expr(s).unwrap(), &row, &test_ctx()).unwrap();
        assert_eq!(e("\"SF\" == genre"), Value::Bool(true)); // membership, reversed sides
        assert_eq!(e("genre != \"Noir\""), Value::Bool(true));
        assert_eq!(e("same == other"), Value::Bool(false)); // list vs list: structural
    }

    // ---- Call routing and depth ------------------------------------------

    #[test]
    fn eval_dispatches_through_call_function() {
        let row = empty_row();
        // Globals now succeed: `date()` is the function table entry.
        assert!(matches!(
            eval(
                &parse_expr("date(\"2025-01-01\")").unwrap(),
                &row,
                &test_ctx()
            )
            .unwrap(),
            Value::Date(_)
        ));
        // Method calls route through the same table; the evaluated
        // target is the first argument.
        assert!(matches!(
            eval(&parse_expr("file.tags.length()").unwrap(), &row, &test_ctx()).unwrap(),
            Value::Num(n) if n == 2.0
        ));
        // `file.hasTag(...)` is row-aware and reads RowData directly.
        assert_eq!(
            eval(
                &parse_expr("file.hasTag(\"소설\")").unwrap(),
                &row,
                &test_ctx()
            )
            .unwrap(),
            Value::Bool(true)
        );
        assert_eq!(
            eval(
                &parse_expr("file.hasTag(\"nope\")").unwrap(),
                &row,
                &test_ctx()
            )
            .unwrap(),
            Value::Bool(false)
        );
        // `file.inFolder(p)` is a recursive prefix match.
        assert_eq!(
            eval(
                &parse_expr("file.inFolder(\"book\")").unwrap(),
                &row,
                &test_ctx()
            )
            .unwrap(),
            Value::Bool(true)
        );
        assert_eq!(
            eval(
                &parse_expr("file.inFolder(\"book/sub\")").unwrap(),
                &row,
                &test_ctx()
            )
            .unwrap(),
            Value::Bool(false)
        );
        // Unknown names are caught at parse time (`frobnicate()` is a
        // parse error) — the dispatch table itself is exhaustive over
        // the parser's GLOBALS list. Spot-check one here by going
        // through the table directly.
        let ctx = test_ctx();
        assert!(
            crate::expr::funcs::call_function("totally_made_up", vec![], ctx.clock, &ctx,).is_err()
        );
        // Plain expressions evaluate normally.
        assert!(matches!(
            eval(&parse_expr("1 + 2").unwrap(), &row, &test_ctx()).unwrap(),
            Value::Num(n) if n == 3.0
        ));
    }

    #[test]
    fn date_field_path_members() {
        let row = empty_row();
        // created_at = 2025-01-01 00:00 UTC (Wednesday → weekday 3).
        assert_eq!(
            eval(&parse_expr("file.created.year").unwrap(), &row, &test_ctx()).unwrap(),
            Value::Num(2025.0)
        );
        assert_eq!(
            eval(
                &parse_expr("file.created.month").unwrap(),
                &row,
                &test_ctx()
            )
            .unwrap(),
            Value::Num(1.0)
        );
        assert_eq!(
            eval(&parse_expr("file.created.day").unwrap(), &row, &test_ctx()).unwrap(),
            Value::Num(1.0)
        );
        assert_eq!(
            eval(
                &parse_expr("file.created.weekday").unwrap(),
                &row,
                &test_ctx()
            )
            .unwrap(),
            Value::Num(3.0)
        );
        // updated_at = 2025-06-15 12:00 UTC → hour/minute/second.
        assert_eq!(
            eval(&parse_expr("file.updated.hour").unwrap(), &row, &test_ctx()).unwrap(),
            Value::Num(12.0)
        );
        assert_eq!(
            eval(
                &parse_expr("file.updated.minute").unwrap(),
                &row,
                &test_ctx()
            )
            .unwrap(),
            Value::Num(0.0)
        );
        assert_eq!(
            eval(
                &parse_expr("file.updated.second").unwrap(),
                &row,
                &test_ctx()
            )
            .unwrap(),
            Value::Num(0.0)
        );
        // Unknown fields error rather than silently returning Null.
        assert!(eval(&parse_expr("file.created.yeer").unwrap(), &row, &test_ctx()).is_err());
        // Date arithmetic result (Date − Date → Num) gets the day count
        // through the `days()` function, not as a Path member.
        // `days()` works on a Path whose head resolves to a Date
        // (e.g. a formula returning a duration would route through the
        // table; this exercises the same `days()` row through the
        // Method arm).
        let r = rec(&[]);
        let mut formulas = HashMap::new();
        formulas.insert("age".to_string(), Ok(Value::Num(86_400_000.0 * 5.0)));
        let row = RowData::from_record(&r, &formulas, None);
        assert!(matches!(
            eval(&parse_expr("formula.age.days()").unwrap(), &row, &test_ctx()).unwrap(),
            Value::Num(n) if (n - 5.0).abs() < 0.001
        ));
    }

    #[test]
    fn date_field_path_members_use_local_offset() {
        // Pinned per-session clock; spec §2 says date fields read in
        // the system-local UTC offset even though stored timestamps
        // remain UTC. We construct a +9h context so that 18:00Z
        let mut r = rec(&[]);
        r.created_at = time::macros::datetime!(2025-01-01 18:00 UTC);
        r.updated_at = time::macros::datetime!(2025-01-01 18:00 UTC);
        let row = row_of(&r);
        static CLOCK_KST: std::sync::LazyLock<EvalClock> = std::sync::LazyLock::new(|| EvalClock {
            now_utc: time::macros::datetime!(2026-08-25 0:00 UTC),
            local: time::UtcOffset::from_hms(9, 0, 0).unwrap(),
        });
        let ctx = EvalCtx {
            clock: &CLOCK_KST,
            depth: std::cell::Cell::new(0),
        };
        // 18:00Z on 2025-01-01 is 03:00 on 2025-01-02 in +09:00.
        assert_eq!(
            eval(&parse_expr("file.created.hour").unwrap(), &row, &ctx).unwrap(),
            Value::Num(3.0)
        );
        assert_eq!(
            eval(&parse_expr("file.created.day").unwrap(), &row, &ctx).unwrap(),
            Value::Num(2.0)
        );
        // Jan 2, 2025 is a Thursday → weekday 4 (Sun=0).
        assert_eq!(
            eval(&parse_expr("file.created.weekday").unwrap(), &row, &ctx).unwrap(),
            Value::Num(4.0)
        );
        // `format(d, fmt)` also renders in the pinned local offset.
        assert_eq!(
            eval(
                &parse_expr("format(file.created, \"YYYY-MM-DD HH:mm\")").unwrap(),
                &row,
                &ctx
            )
            .unwrap(),
            Value::Str("2025-01-02 03:00".into())
        );
        // Negative offset shifts the other way: 02:00Z on Jan 2 is
        // still Jan 1 in -05:00.
        let mut r2 = rec(&[]);
        r2.created_at = time::macros::datetime!(2025-01-02 02:00 UTC);
        let row2 = row_of(&r2);
        static CLOCK_NYC: std::sync::LazyLock<EvalClock> = std::sync::LazyLock::new(|| EvalClock {
            now_utc: time::macros::datetime!(2026-08-25 0:00 UTC),
            local: time::UtcOffset::from_hms(-5, 0, 0).unwrap(),
        });
        let ctx2 = EvalCtx {
            clock: &CLOCK_NYC,
            depth: std::cell::Cell::new(0),
        };
        assert_eq!(
            eval(&parse_expr("file.created.day").unwrap(), &row2, &ctx2).unwrap(),
            Value::Num(1.0)
        );
        // UTC rendering stays the day it was stored on, for reference.
        assert_eq!(
            eval(&parse_expr("file.created.day").unwrap(), &row2, &test_ctx()).unwrap(),
            Value::Num(2.0)
        );
    }
    #[test]
    fn method_passes_target_first() {
        let row = empty_row();
        let ctx = test_ctx();
        // The method's target path is everything but the last segment, so
        // `file.tags.contains(..)` arrives as ("contains", [tags, arg]).
        // (`file.hasTag(..)` targets the bare `file` namespace, which is
        // Null by design — Task 5's function table reads the row for it.)
        let out = eval_with_calls(
            &parse_expr("file.tags.contains(\"소설\")").unwrap(),
            &row,
            &ctx,
            &|name, args| {
                assert_eq!(name, "contains");
                match args.as_slice() {
                    [Value::List(items), Value::Str(t)] => Ok(Value::Bool(
                        items.iter().any(|i| *i == Value::Str(t.clone())),
                    )),
                    _ => Err(rt_err("contains() takes a list and a string")),
                }
            },
        )
        .unwrap();
        assert_eq!(out, Value::Bool(true));
    }

    #[test]
    fn depth_cap_and_restore() {
        let row = empty_row();
        let ctx = test_ctx();
        let mut deep = Expr::Lit(Value::Num(1.0));
        for _ in 0..65 {
            deep = Expr::Unary {
                op: "-",
                expr: Box::new(deep),
            };
        }
        let err = eval(&deep, &row, &ctx).unwrap_err();
        assert!(
            matches!(err, CoreError::Expr { message, .. } if message.contains("nesting too deep"))
        );
        // Every node frame counts, including the innermost literal:
        // 63 unary frames + 1 literal frame = 64, exactly at the cap.
        let mut ok = Expr::Lit(Value::Num(1.0));
        for _ in 0..63 {
            ok = Expr::Unary {
                op: "-",
                expr: Box::new(ok),
            };
        }
        assert!(matches!(eval(&ok, &row, &ctx).unwrap(), Value::Num(n) if n == -1.0));
    }
}
