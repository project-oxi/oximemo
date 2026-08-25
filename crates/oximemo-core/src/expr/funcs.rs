//! Function library for the expression engine (spec 2026-08-25 §2).
//!
//! One [`call_function`] table dispatches every global name and every
//! method call (method invocations arrive with the evaluated target as
//! the first argument; the parser already folded `s.contains(...)` etc.
//! into plain `Call`s for global names, so `length`/`contains`/... share
//! the same `length`/`contains`/... rows). Arithmetic / boolean /
//! comparison / index operators live in [`crate::expr::eval`] because
//! they have grammar-level special forms; this module only owns the
//! named functions.
//!
//! Date/duration member fields (`.year`, `.month`, `.day`, `.hour`,
//! `.minute`, `.second`, `.weekday`) are not functions — they are
//! resolved as Path members in [`crate::expr::eval::resolve`] so that
//! `file.created.year` parses identically to `file.created`. The
//! `days(...)` function lives here so that `formula.age.days()` and
//! `(now() - file.created).days()` route through the same call table
//! as globals.
//!
//! Two name-only methods bypass the value table because their semantics
//! refer to the row itself, not the value of `file` (which is `Null`):
//! `file.hasTag(t)` and `file.inFolder(prefix)` are dispatched by
//! [`crate::expr::eval`] before the target is evaluated, so they can
//! read [`crate::expr::eval::RowData`] directly. They are still
//! registered below as documentation of the call surface.

use crate::error::CoreError;
use crate::expr::eval::{EvalClock, EvalCtx};
use crate::expr::value::{group_string, parse_date_ish, type_name, Value};

/// Dispatch a global function or method call.
///
/// `args[0]` is the evaluated method target for `name(args...)` of
/// method form; for plain `name(args...)` it is the first positional
/// argument. The brief's signature uses two context references so that
/// `now()`/`today()` reach `EvalClock::{now_utc, local}` while a future
/// caller (Task 9's DTO layer) can still pass an [`EvalCtx`] for
/// evaluation-scoped state. Today's table reads only the clock; `ctx`
/// is accepted for interface stability.
///
/// Errors are `CoreError::Expr` with `line: 0, col: 0` (runtime split
/// per spec §2). Arity and type errors name the function in the
/// message.
pub fn call_function(
    name: &str,
    args: Vec<Value>,
    ctx: &EvalClock,
    ctx2: &EvalCtx,
) -> Result<Value, CoreError> {
    let _ = ctx2; // reserved for future context-scoped state
    match name {
        // ---- Globals -------------------------------------------------
        "now" => arity(name, 0, &args).map(|_| Value::Date(ctx.now_utc)),
        "today" => arity(name, 0, &args).map(|_| {
            let local = ctx.local;
            let n = ctx.now_utc.to_offset(local);
            let d = n.date();
            Value::Date(d.with_hms(0, 0, 0).expect("midnight is valid").assume_offset(local))
        }),
        "date" => match args.as_slice() {
            [Value::Str(s)] => parse_date_ish(s)
                .map(Value::Date)
                .ok_or_else(|| expr_err(format!("date(): invalid date literal: {s}"))),
            _ => Err(arity_msg(name, "exactly one string", args.len())),
        },
        "list" => Ok(Value::List(args)),
        "if" => match args.as_slice() {
            [c, a, b] => {
                let cond = strict_bool(name, c)?;
                Ok(if cond { a.clone() } else { b.clone() })
            }
            _ => Err(arity_msg(name, "exactly three arguments", args.len())),
        },
        "isEmpty" => one_arg(name, &args).map(|v| match v {
            Value::Null | Value::Str(_) | Value::List(_) => {
                Value::Bool(match v {
                    Value::Null => true,
                    Value::Str(s) => s.is_empty(),
                    Value::List(items) => items.is_empty(),
                    _ => unreachable!(),
                })
            }
            _ => Value::Bool(false),
        }),
        "isBlank" => one_arg(name, &args).map(|v| match v {
            Value::Null | Value::Str(_) | Value::List(_) => {
                Value::Bool(match v {
                    Value::Null => true,
                    Value::Str(s) => s.trim().is_empty(),
                    Value::List(items) => items.is_empty(),
                    _ => unreachable!(),
                })
            }
            _ => Value::Bool(false),
        }),
        "typeof" => one_arg(name, &args).map(|v| Value::Str(type_name(&v).into())),
        "length" => one_arg(name, &args).and_then(|v| match v {
            Value::Str(s) => Ok(Value::Num(s.chars().count() as f64)),
            Value::List(items) => Ok(Value::Num(items.len() as f64)),
            other => Err(expr_err(format!(
                "length(): expected string or list, got {}",
                type_name(&other)
            ))),
        }),

        // ---- String --------------------------------------------------
        "contains" => two_args(name, &args).and_then(|(a, b)| match (a, b) {
            (Value::Str(s), Value::Str(sub)) => Ok(Value::Bool(s.contains(sub.as_str()))),
            _ => Err(expr_err("contains(): expected (string, string)")),
        }),
        "startsWith" => two_args(name, &args).and_then(|(a, b)| match (a, b) {
            (Value::Str(s), Value::Str(pre)) => Ok(Value::Bool(s.starts_with(pre.as_str()))),
            _ => Err(expr_err("startsWith(): expected (string, string)")),
        }),
        "endsWith" => two_args(name, &args).and_then(|(a, b)| match (a, b) {
            (Value::Str(s), Value::Str(suf)) => Ok(Value::Bool(s.ends_with(suf.as_str()))),
            _ => Err(expr_err("endsWith(): expected (string, string)")),
        }),
        "lower" => one_str(name, &args).map(|s| Value::Str(s.to_lowercase())),
        "upper" => one_str(name, &args).map(|s| Value::Str(s.to_uppercase())),
        "trim" => one_str(name, &args).map(|s| Value::Str(s.trim().to_string())),
        "replace" => three_args(name, &args).and_then(|(s, from, to)| match (s, from, to) {
            (Value::Str(s), Value::Str(from), Value::Str(to)) => {
                Ok(Value::Str(s.replace(from.as_str(), to.as_str())))
            }
            _ => Err(expr_err("replace(): expected (string, string, string)")),
        }),
        "split" => two_args(name, &args).and_then(|(s, sep)| match (s, sep) {
            (Value::Str(s), Value::Str(sep)) => Ok(Value::List(
                s.split(sep.as_str()).map(|p| Value::Str(p.to_string())).collect(),
            )),
            _ => Err(expr_err("split(): expected (string, string)")),
        }),
        "join" => two_args(name, &args).and_then(|(list, sep)| match (list, sep) {
            (Value::List(items), Value::Str(sep)) => {
                let parts: Vec<String> = items.iter().map(group_string).collect();
                Ok(Value::Str(parts.join(sep.as_str())))
            }
            _ => Err(expr_err("join(): expected (list, string)")),
        }),

        // ---- List ----------------------------------------------------
        "includes" => two_args(name, &args).and_then(|(list, v)| match list {
            Value::List(items) => Ok(Value::Bool(items.iter().any(|m| eq_for_includes(m, v)))),
            _ => Err(expr_err("includes(): first argument must be a list")),
        }),
        "first" => one_arg(name, &args).map(|v| match v {
            Value::List(items) => items.first().cloned().unwrap_or(Value::Null),
            other => other.clone(),
        }),
        "last" => one_arg(name, &args).map(|v| match v {
            Value::List(items) => items.last().cloned().unwrap_or(Value::Null),
            other => other.clone(),
        }),
        "unique" => one_arg(name, &args).and_then(|v| match v {
            Value::List(items) => {
                let mut out: Vec<Value> = Vec::with_capacity(items.len());
                for it in items {
                    if !out.iter().any(|m| eq_for_includes(m, &it)) {
                        out.push(it.clone());
                    }
                }
                Ok(Value::List(out))
            }
            _ => Err(expr_err("unique(): expected a list")),
        }),
        "sort" => one_arg(name, &args).and_then(|v| match v {
            Value::List(items) => {
                let mut sorted = items.clone();
                sorted.sort_by(crate::expr::value::total_order);
                Ok(Value::List(sorted))
            }
            _ => Err(expr_err("sort(): expected a list")),
        }),

        // ---- Numeric -------------------------------------------------
        "round" => one_num(name, &args).map(|n| Value::Num(round_half_away_from_zero(n))),
        "floor" => one_num(name, &args).map(|n| Value::Num(n.floor())),
        "ceil" => one_num(name, &args).map(|n| Value::Num(n.ceil())),
        "abs" => one_num(name, &args).map(|n| Value::Num(n.abs())),
        "min" | "max" => variadic_num_promoted(name, &args).map(|mut ns| {
            ns.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            if name == "min" {
                Value::Num(*ns.first().expect("variadic guards non-empty"))
            } else {
                Value::Num(*ns.last().expect("variadic guards non-empty"))
            }
        }),
        "sum" => match args.as_slice() {
            [Value::List(items)] => {
                let mut acc = 0.0_f64;
                for it in items {
                    let n = promote_number(name, it)?;
                    acc += n;
                }
                Ok(Value::Num(acc))
            }
            _ => Err(expr_err("sum(): expected a list")),
        },
        "mean" => match args.as_slice() {
            [Value::List(items)] => {
                if items.is_empty() {
                    Err(expr_err("mean(): empty list"))
                } else {
                    let mut acc = 0.0_f64;
                    for it in items {
                        acc += promote_number(name, it)?;
                    }
                    Ok(Value::Num(acc / items.len() as f64))
                }
            }
            _ => Err(expr_err("mean(): expected a list")),
        },

        // ---- Date ----------------------------------------------------
        "format" => two_args(name, &args).and_then(|(d, fmt)| match (d, fmt) {
            (Value::Date(dt), Value::Str(fmt)) => Ok(Value::Str(format_date(*dt, fmt, ctx.local))),
            _ => Err(expr_err("format(): expected (date, string)")),
        }),
        "days" => one_arg(name, &args).and_then(|v| match v {
            Value::Duration(d) => {
                let total_ms = (d.calendar_months as f64) * 30.44 * 86_400_000.0
                    + (d.fixed_millis as f64);
                Ok(Value::Num(total_ms / 86_400_000.0))
            }
            Value::Num(n) => {
                if !n.is_finite() {
                    Err(expr_err("days(): numeric operand is not finite"))
                } else {
                    Ok(Value::Num(n / 86_400_000.0))
                }
            }
            _ => Err(expr_err("days(): expected a duration or a number (ms)")),
        }),

        // ---- File row methods (row-aware dispatch happens in eval) --
        // These names never reach this table: `file.hasTag(t)` and
        // `file.inFolder(p)` are intercepted by the Method arm in
        // eval.rs and routed to RowData directly. Listed here so that
        // a stray plain `hasTag("x")` produces the documented
        // "unknown function" rather than silently succeeding.
        _ => Err(expr_err(format!("unknown function: {name}"))),
    }
}

// ---- Internal helpers ---------------------------------------------------

fn arity(name: &str, expected: usize, args: &[Value]) -> Result<(), CoreError> {
    if args.len() != expected {
        Err(arity_msg(name, &format!("exactly {expected}"), args.len()))
    } else {
        Ok(())
    }
}

fn arity_msg(name: &str, expected: &str, got: usize) -> CoreError {
    expr_err(format!(
        "{name}(): expected {expected} argument{}, got {got}",
        if got == 1 { "" } else { "s" }
    ))
}

fn one_arg<'a>(name: &str, args: &'a [Value]) -> Result<&'a Value, CoreError> {
    if args.len() != 1 {
        Err(arity_msg(name, "exactly one", args.len()))
    } else {
        Ok(&args[0])
    }
}

fn two_args<'a>(
    name: &str,
    args: &'a [Value],
) -> Result<(&'a Value, &'a Value), CoreError> {
    if args.len() != 2 {
        Err(arity_msg(name, "exactly two", args.len()))
    } else {
        Ok((&args[0], &args[1]))
    }
}

fn three_args<'a>(
    name: &str,
    args: &'a [Value],
) -> Result<(&'a Value, &'a Value, &'a Value), CoreError> {
    if args.len() != 3 {
        Err(arity_msg(name, "exactly three", args.len()))
    } else {
        Ok((&args[0], &args[1], &args[2]))
    }
}

fn one_str<'a>(name: &str, args: &'a [Value]) -> Result<&'a str, CoreError> {
    one_arg(name, args).and_then(|v| match v {
        Value::Str(s) => Ok(s.as_str()),
        _ => Err(expr_err(format!(
            "{name}(): expected a string, got {}",
            type_name(v)
        ))),
    })
}

fn one_num<'a>(name: &str, args: &'a [Value]) -> Result<f64, CoreError> {
    one_arg(name, args).and_then(|v| promote_number(name, v))
}

fn variadic_num_promoted(name: &str, args: &[Value]) -> Result<Vec<f64>, CoreError> {
    if args.is_empty() {
        return Err(arity_msg(name, "at least one", 0));
    }
    let mut out = Vec::with_capacity(args.len());
    for a in args {
        out.push(promote_number(name, a)?);
    }
    Ok(out)
}

fn promote_number(name: &str, v: &Value) -> Result<f64, CoreError> {
    match v {
        Value::Num(n) => {
            if n.is_finite() {
                Ok(*n)
            } else {
                Err(expr_err(format!("{name}(): numeric operand is not finite")))
            }
        }
        Value::Str(s) => s
            .parse::<f64>()
            .ok()
            .filter(|n| n.is_finite())
            .ok_or_else(|| expr_err(format!("{name}(): expected a number, got string `{s}`"))),
        _ => Err(expr_err(format!(
            "{name}(): expected a number, got {}",
            type_name(v)
        ))),
    }
}

fn strict_bool(name: &str, v: &Value) -> Result<bool, CoreError> {
    match v {
        Value::Bool(b) => Ok(*b),
        Value::Null => Ok(false),
        _ => Err(expr_err(format!(
            "{name}(): expected a boolean, got {}",
            type_name(v)
        ))),
    }
}

fn eq_for_includes(a: &Value, b: &Value) -> bool {
    // Mirrors eval's `value_eq` semantics for the `includes` membership
    // test (numeric/date string promotion). A list member should not
    // promote to a different kind than the haystack itself.
    match (a, b) {
        (Value::Num(x), Value::Str(y)) | (Value::Str(y), Value::Num(x)) => y
            .parse::<f64>()
            .ok()
            .map(|n| n == *x)
            .unwrap_or(false),
        (Value::Date(_), Value::Str(_)) | (Value::Str(_), Value::Date(_)) => {
            matches!(
                (crate::expr::value::promote_date(a), crate::expr::value::promote_date(b)),
                (Some(p), Some(q)) if p == q
            )
        }
        _ => a == b,
    }
}

fn round_half_away_from_zero(n: f64) -> f64 {
    if n >= 0.0 {
        (n + 0.5).floor()
    } else {
        -((-n + 0.5).floor())
    }
}

/// Render a date using the literal token substitutions `YYYY MM DD HH mm ss`.
/// get exactly the seven tokens above and pass everything else through
/// unchanged. The date is rendered in `local` (per spec §2's "pinned
/// system-local UTC offset" semantics) so that `format(file.created,
/// "YYYY년 MM월")` shows the same calendar day/hour as `file.created.day`
/// / `.hour`. Stored timestamps remain UTC; the offset is only applied
/// for display.
///
/// The format string is iterated as Unicode scalars (`chars()`) so
/// non-ASCII literals like `년`/`월` (3-byte UTF-8 sequences) pass
/// through verbatim instead of being silently reinterpreted as Latin-1.
fn format_date(dt: time::OffsetDateTime, fmt: &str, local: time::UtcOffset) -> String {
    let dt = dt.to_offset(local);
    let date = dt.date();
    let (y, m, d) = date.to_calendar_date();
    let h = dt.hour();
    let mi = dt.minute();
    let s = dt.second();
    let mut out = String::with_capacity(fmt.len());
    let mut chars = fmt.chars().peekable();
    while let Some(c) = chars.next() {
        // Token match only on ASCII scalars; non-ASCII literals pass
        // through verbatim (a 4-byte `YYYY` sequence never appears in
        // non-ASCII text, so ASCII-prefix matching is safe).
        match c {
            'Y' if chars.peek() == Some(&'Y')
                && chars.clone().nth(1) == Some('Y')
                && chars.clone().nth(2) == Some('Y') =>
            {
                out.push_str(&format!("{y:04}"));
                chars.next();
                chars.next();
                chars.next();
            }
            'M' if chars.peek() == Some(&'M') => {
                out.push_str(&format!("{:02}", m as u8));
                chars.next();
            }
            'D' if chars.peek() == Some(&'D') => {
                out.push_str(&format!("{d:02}"));
                chars.next();
            }
            'H' if chars.peek() == Some(&'H') => {
                out.push_str(&format!("{h:02}"));
                chars.next();
            }
            'm' if chars.peek() == Some(&'m') => {
                out.push_str(&format!("{mi:02}"));
                chars.next();
            }
            's' if chars.peek() == Some(&'s') => {
                out.push_str(&format!("{s:02}"));
                chars.next();
            }
            _ => out.push(c),
        }
    }
    out
}
fn expr_err(message: impl Into<String>) -> CoreError {
    CoreError::Expr {
        message: message.into(),
        line: 0,
        col: 0,
    }
}

// ---- Tests --------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::expr::value::DurationSpec;
    use std::cell::Cell;
    use std::sync::LazyLock;
    use time::macros::datetime;
    use time::UtcOffset;

    /// Pre-computed shared clock.
    static CLOCK: LazyLock<EvalClock> = LazyLock::new(|| EvalClock {
        now_utc: datetime!(2026-08-25 14:30:45 UTC),
        local: UtcOffset::UTC,
    });

    /// Run `call_function` with the shared test clock and a fresh
    /// per-call `EvalCtx` (`depth` lives in `Cell` which is not `Sync`
    /// so a static `EvalCtx` is impossible).
    fn call(name: &str, args: Vec<Value>) -> Result<Value, CoreError> {
        let ctx = EvalCtx {
            clock: &CLOCK,
            depth: Cell::new(0),
        };
        call_function(name, args, &CLOCK, &ctx)
    }

    /// Table-driven driver: each row is `(name, args, expected)`.
    /// `Err(_)` is matched as any `CoreError::Expr` regardless of message.
    macro_rules! rows {
        ($($name:literal, $args:expr, $expected:expr);* $(;)?) => {
            vec![
                $((
                    $name,
                    $args,
                    $expected,
                )),*
            ]
        };
    }

    fn run(rows: Vec<(&'static str, Vec<Value>, Result<Value, CoreError>)>) {
        for (name, args, expected) in rows {
            let got = call(name, args);
            match (&got, &expected) {
                (Ok(g), Ok(e)) => assert_eq!(g, e, "mismatch in `{name}`"),
                (Err(_), Err(_)) => {}
                _ => panic!("mismatch in `{name}`: got {got:?}, expected {expected:?}"),
            }
        }
    }

    #[test]
    fn global_clock_and_collection() {
        run(rows! {
            "now", vec![], Ok(Value::Date(datetime!(2026-08-25 14:30:45 UTC)));
            "today", vec![], Ok(Value::Date(datetime!(2026-08-25 0:00 UTC)));
            "date", vec![Value::Str("2025-04-01".into())], Ok(Value::Date(datetime!(2025-04-01 0:00 UTC)));
            "date", vec![Value::Str("bogus".into())], Err(expr_err(""));
            "list", vec![Value::Num(1.0), Value::Num(2.0), Value::Num(3.0)],
                Ok(Value::List(vec![Value::Num(1.0), Value::Num(2.0), Value::Num(3.0)]));
            "list", vec![], Ok(Value::List(vec![]));
            "if", vec![Value::Bool(true), Value::Str("a".into()), Value::Str("b".into())],
                Ok(Value::Str("a".into()));
            "if", vec![Value::Bool(false), Value::Str("a".into()), Value::Str("b".into())],
                Ok(Value::Str("b".into()));
            "if", vec![Value::Null, Value::Num(1.0), Value::Num(2.0)], Ok(Value::Num(2.0));
            "if", vec![Value::Num(1.0), Value::Num(1.0), Value::Num(2.0)], Err(expr_err(""));
            "isEmpty", vec![Value::Null], Ok(Value::Bool(true));
            "isEmpty", vec![Value::Str("".into())], Ok(Value::Bool(true));
            "isEmpty", vec![Value::Str("x".into())], Ok(Value::Bool(false));
            "isEmpty", vec![Value::List(vec![])], Ok(Value::Bool(true));
            "isEmpty", vec![Value::List(vec![Value::Num(1.0)])], Ok(Value::Bool(false));
            "isEmpty", vec![Value::Num(0.0)], Ok(Value::Bool(false));
            "isBlank", vec![Value::Str("  \t\n".into())], Ok(Value::Bool(true));
            "isBlank", vec![Value::Str("x".into())], Ok(Value::Bool(false));
            "isBlank", vec![Value::Str("".into())], Ok(Value::Bool(true));
            "isBlank", vec![Value::Null], Ok(Value::Bool(true));
            "isBlank", vec![Value::Num(0.0)], Ok(Value::Bool(false));
            "typeof", vec![Value::Null], Ok(Value::Str("null".into()));
            "typeof", vec![Value::Bool(true)], Ok(Value::Str("bool".into()));
            "typeof", vec![Value::Num(1.0)], Ok(Value::Str("number".into()));
            "typeof", vec![Value::Str("x".into())], Ok(Value::Str("string".into()));
            "typeof", vec![Value::List(vec![])], Ok(Value::Str("list".into()));
            "typeof", vec![Value::Date(datetime!(2025-01-01 0:00 UTC))],
                Ok(Value::Str("date".into()));
            "typeof", vec![Value::Duration(DurationSpec { calendar_months: 0, fixed_millis: 0 })],
                Ok(Value::Str("duration".into()));
            "length", vec![Value::Str("hello".into())], Ok(Value::Num(5.0));
            "length", vec![Value::List(vec![Value::Num(1.0), Value::Num(2.0)])], Ok(Value::Num(2.0));
            "length", vec![Value::Str("".into())], Ok(Value::Num(0.0));
            "length", vec![Value::Num(1.0)], Err(expr_err(""));
        });
    }

    #[test]
    fn string_functions() {
        run(rows! {
            "contains", vec![Value::Str("hello world".into()), Value::Str("world".into())],
                Ok(Value::Bool(true));
            "contains", vec![Value::Str("abc".into()), Value::Str("z".into())],
                Ok(Value::Bool(false));
            "contains", vec![Value::Num(1.0), Value::Str("x".into())], Err(expr_err(""));
            "startsWith", vec![Value::Str("hello".into()), Value::Str("he".into())],
                Ok(Value::Bool(true));
            "startsWith", vec![Value::Str("hello".into()), Value::Str("lo".into())],
                Ok(Value::Bool(false));
            "endsWith", vec![Value::Str("hello".into()), Value::Str("lo".into())],
                Ok(Value::Bool(true));
            "lower", vec![Value::Str("Hello".into())], Ok(Value::Str("hello".into()));
            "upper", vec![Value::Str("Hello".into())], Ok(Value::Str("HELLO".into()));
            "trim", vec![Value::Str("  hi  ".into())], Ok(Value::Str("hi".into()));
            "replace", vec![Value::Str("a-b-c".into()), Value::Str("-".into()), Value::Str("/".into())],
                Ok(Value::Str("a/b/c".into()));
            "replace", vec![Value::Str("aaaa".into()), Value::Str("a".into()), Value::Str("".into())],
                Ok(Value::Str("".into()));
            "split", vec![Value::Str("a,b,c".into()), Value::Str(",".into())],
                Ok(Value::List(vec![Value::Str("a".into()), Value::Str("b".into()), Value::Str("c".into())]));
            "split", vec![Value::Str("hello".into()), Value::Str(",".into())],
                Ok(Value::List(vec![Value::Str("hello".into())]));
            "join", vec![Value::List(vec![Value::Str("a".into()), Value::Str("b".into())]),
                         Value::Str(",".into())],
                Ok(Value::Str("a,b".into()));
            "join", vec![Value::List(vec![Value::Num(1.0), Value::Num(2.0)]),
                         Value::Str("-".into())],
                Ok(Value::Str("1-2".into()));
            "join", vec![Value::List(vec![]), Value::Str(",".into())], Ok(Value::Str("".into()));
        });
    }

    #[test]
    fn list_functions() {
        run(rows! {
            "includes", vec![Value::List(vec![Value::Str("a".into()), Value::Str("b".into())]),
                             Value::Str("b".into())], Ok(Value::Bool(true));
            "includes", vec![Value::List(vec![Value::Str("a".into())]), Value::Str("z".into())],
                Ok(Value::Bool(false));
            "includes", vec![Value::List(vec![Value::Num(1.0), Value::Num(2.0)]),
                             Value::Num(2.0)], Ok(Value::Bool(true));
            "includes", vec![Value::Num(1.0), Value::Num(1.0)], Err(expr_err(""));
            "first", vec![Value::List(vec![Value::Num(1.0), Value::Num(2.0)])], Ok(Value::Num(1.0));
            "first", vec![Value::List(vec![])], Ok(Value::Null);
            "first", vec![Value::Str("ab".into())], Ok(Value::Str("ab".into()));
            "last", vec![Value::List(vec![Value::Num(1.0), Value::Num(2.0)])], Ok(Value::Num(2.0));
            "last", vec![Value::List(vec![])], Ok(Value::Null);
            "unique", vec![Value::List(vec![Value::Num(1.0), Value::Num(2.0), Value::Num(1.0)])],
                Ok(Value::List(vec![Value::Num(1.0), Value::Num(2.0)]));
            "unique", vec![Value::List(vec![Value::Str("a".into()), Value::Str("a".into()),
                                            Value::Str("b".into())])],
                Ok(Value::List(vec![Value::Str("a".into()), Value::Str("b".into())]));
            "unique", vec![Value::Str("x".into())], Err(expr_err(""));
            "sort", vec![Value::List(vec![Value::Num(3.0), Value::Num(1.0), Value::Num(2.0)])],
                Ok(Value::List(vec![Value::Num(1.0), Value::Num(2.0), Value::Num(3.0)]));
            "sort", vec![Value::List(vec![Value::Str("b".into()), Value::Str("a".into())])],
                Ok(Value::List(vec![Value::Str("a".into()), Value::Str("b".into())]));
            "sort", vec![Value::Str("x".into())], Err(expr_err(""));
        });
    }

    #[test]
    fn numeric_functions() {
        run(rows! {
            "round", vec![Value::Num(1.4)], Ok(Value::Num(1.0));
            "round", vec![Value::Num(1.5)], Ok(Value::Num(2.0));
            "round", vec![Value::Num(1.6)], Ok(Value::Num(2.0));
            "round", vec![Value::Num(-1.5)], Ok(Value::Num(-2.0));
            "round", vec![Value::Num(-1.4)], Ok(Value::Num(-1.0));
            "floor", vec![Value::Num(1.9)], Ok(Value::Num(1.0));
            "floor", vec![Value::Num(-1.1)], Ok(Value::Num(-2.0));
            "ceil", vec![Value::Num(1.1)], Ok(Value::Num(2.0));
            "ceil", vec![Value::Num(-1.9)], Ok(Value::Num(-1.0));
            "abs", vec![Value::Num(-3.5)], Ok(Value::Num(3.5));
            "abs", vec![Value::Num(3.5)], Ok(Value::Num(3.5));
            "min", vec![Value::Num(3.0), Value::Num(1.0), Value::Num(2.0)], Ok(Value::Num(1.0));
            "min", vec![Value::Num(3.0)], Ok(Value::Num(3.0));
            "max", vec![Value::Num(3.0), Value::Num(1.0), Value::Num(2.0)], Ok(Value::Num(3.0));
            "max", vec![Value::Num(3.0)], Ok(Value::Num(3.0));
            "min", vec![], Err(expr_err(""));
            "sum", vec![Value::List(vec![Value::Num(1.0), Value::Num(2.0), Value::Num(3.0)])],
                Ok(Value::Num(6.0));
            "sum", vec![Value::List(vec![Value::Num(1.0), Value::Str("2".into()), Value::Num(3.0)])],
                Ok(Value::Num(6.0));
            "sum", vec![Value::List(vec![Value::Str("x".into())])], Err(expr_err(""));
            "sum", vec![Value::List(vec![])], Ok(Value::Num(0.0));
            "mean", vec![Value::List(vec![Value::Num(1.0), Value::Num(2.0), Value::Num(3.0)])],
                Ok(Value::Num(2.0));
            "mean", vec![Value::List(vec![])], Err(expr_err(""));
        });
    }

    #[test]
    fn date_format_and_days() {
        run(rows! {
            "format", vec![Value::Date(datetime!(2025-04-01 13:05:09 UTC)),
                           Value::Str("YYYY-MM-DD".into())],
                Ok(Value::Str("2025-04-01".into()));
            "format", vec![Value::Date(datetime!(2025-04-01 13:05:09 UTC)),
                           Value::Str("YYYY/MM/DD HH:mm:ss".into())],
                Ok(Value::Str("2025/04/01 13:05:09".into()));
            "format", vec![Value::Date(datetime!(2025-04-01 13:05:09 UTC)),
                           Value::Str("raw".into())],
                Ok(Value::Str("raw".into()));
            // Non-ASCII literals (Korean `년`/`월`/etc.) pass through
            // verbatim without byte-level reinterpretation. With UTC
            // the local offset is a no-op; the test exercises the
            // chars() iterator end-to-end.
            "format", vec![Value::Date(datetime!(2025-04-01 0:00 UTC)),
                           Value::Str("YYYY년 MM월 DD일".into())],
                Ok(Value::Str("2025년 04월 01일".into()));
            // Mixed tokens + non-ASCII literal (the spec example).
            "format", vec![Value::Date(datetime!(2026-08-25 14:30 UTC)),
                           Value::Str("YYYY-MM-DD (요일)".into())],
                Ok(Value::Str("2026-08-25 (요일)".into()));
            "days", vec![Value::Duration(DurationSpec { calendar_months: 0, fixed_millis: 86_400_000 })],
                Ok(Value::Num(1.0));
            "days", vec![Value::Duration(DurationSpec { calendar_months: 1, fixed_millis: 0 })],
                Ok(Value::Num(30.44));
            "days", vec![Value::Num(86_400_000.0)], Ok(Value::Num(1.0));
            "days", vec![Value::Num(0.0)], Ok(Value::Num(0.0));
            "days", vec![Value::Num(86_400_000.0 / 2.0)], Ok(Value::Num(0.5));
            "days", vec![Value::Str("x".into())], Err(expr_err(""));
        });
    }

    #[test]
    fn arity_errors() {
        // Two arity errors. Error message must mention the function name
        // (spec §2 / global rule: arity/type errors name the function).
        let err = call("date", vec![]).unwrap_err();
        let CoreError::Expr { message: msg, .. } = err else {
            panic!("expected CoreError::Expr");
        };
        assert!(msg.contains("date"), "got `{msg}`");
        let err = call("replace", vec![Value::Str("a".into()), Value::Str("b".into())]).unwrap_err();
        let CoreError::Expr { message: msg, .. } = err else {
            panic!("expected CoreError::Expr");
        };
        assert!(msg.contains("replace"), "got `{msg}`");
    }

    #[test]
    fn unknown_function_names() {
        // The plain `eval(...)` resolver should no longer reject every
        // function call once the function table is wired in. This test
        // exercises `call_function` directly to keep it independent of
        // the wiring (covered by `eval_dispatches_through_call_function`
        // in eval.rs).
        let err = call("nope", vec![]).unwrap_err();
        assert!(matches!(err, CoreError::Expr { line: 0, col: 0, .. }));
    }
}