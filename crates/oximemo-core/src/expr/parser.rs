//! Pratt (precedence-climbing) parser for the Bases-compatible expression
//! engine (spec 2026-08-25 §2). Consumes the [`crate::expr::lexer`] token
//! stream and produces the [`Expr`] AST consumed by `expr::eval`.
//!
//! Grammar shape:
//!
//! - Precedence (low→high): `||` < `&&` < comparisons < `+ -` < `* / %` <
//!   unary `! -` < postfix (`.` member, `(` call, `[` index). All binary
//!   operators are left-associative.
//! - A leading identifier stream folds greedily into a [`Expr::Path`].
//!   At a `(` postfix, a length-1 path whose head is a known global
//!   function name becomes a [`Expr::Call`]; a longer path becomes a
//!   [`Expr::Method`] whose target is the path minus its last segment and
//!   whose name is that last segment (`file.hasTag("x")`). A `(` after
//!   any other expression is a parse error ("not callable").
//! - `.` after a non-path expression allows exactly one form: a method
//!   call on a computed value, `(now() - file.created).days()` (spec
//!   §1's example formula). `"x".contains("y")` (literal target) and a
//!   name without a following `(` remain parse errors.
//!
//! - Recursion is bounded by [`MAX_PARSE_DEPTH`]: over-deep input is a
//!   positioned parse error, never a stack-overflow abort.
//! Parse errors carry the physical 1-based line/col of the offending
//! token (or the end-of-input position) via [`CoreError::Expr`].

use crate::error::CoreError;
use crate::expr::lexer::{tokenize, Lexed, Span, Tok};
use crate::expr::value::{format_num, group_string, Value};

/// Maximum recursion depth the parser may descend before erroring
/// (spec §7 never-a-crash). Every nested construct — parens, call
/// args, indexes, method targets — re-enters through
/// [`Parser::parse_binary`], so one counter bounds the descent; without
/// it a few hundred nested parens (pasted into `save_base`, or synced
/// into a `.query` `run_base`) overflow the stack and abort
/// the process with an uncatchable SIGSEGV. Mirrors eval's
/// `MAX_EVAL_DEPTH = 64`; the parse cap is looser because it guards
/// only parser frames, and evaluation still applies its own cap.
const MAX_PARSE_DEPTH: u32 = 200;

/// Global function names recognized in call position (`name(...)`).
/// Kept in one place because `expr::funcs` dispatches on the same set;
/// a bare `foo(...)` whose head is not in this list is a parse error.
const GLOBALS: &[&str] = &[
    "now", "today", "date", "list", "if", "isEmpty", "isBlank", "typeof", "length",
    "contains", "startsWith", "endsWith", "lower", "upper", "trim", "replace", "split",
    "join", "includes", "first", "last", "unique", "sort", "round", "floor", "ceil",
    "abs", "min", "max", "sum", "mean", "format", "hasTag", "inFolder",
];

fn is_global(name: &str) -> bool {
    GLOBALS.contains(&name)
}

/// Parsed expression tree. Literals are restricted to the Bool/Num/Str
/// variants of [`Value`]; dates come from `date(...)` and durations from
/// string arithmetic at eval time, never from the syntax itself.
#[derive(Debug, Clone, PartialEq)]
pub enum Expr {
    /// `true`, `false`, a number, or a quoted string.
    Lit(Value),
    /// Dot-joined identifier chain, e.g. `note.tags`.
    Path(Vec<String>),
    /// Global function call, e.g. `length(note.tags)`.
    Call {
        name: String,
        args: Vec<Expr>,
    },
    /// Method call on a path, e.g. `file.hasTag("x")`; the method name is
    /// the final path segment and `target` is the rest of the path.
    Method {
        target: Box<Expr>,
        name: String,
        args: Vec<Expr>,
    },
    /// Postfix indexing, e.g. `note.tags[0]`.
    Index {
        target: Box<Expr>,
        index: Box<Expr>,
    },
    /// Unary `!` or `-`.
    Unary {
        op: &'static str,
        expr: Box<Expr>,
    },
    /// Left-associative binary operation.
    Binary {
        op: &'static str,
        lhs: Box<Expr>,
        rhs: Box<Expr>,
    },
}

fn err(message: impl Into<String>, span: Span) -> CoreError {
    CoreError::Expr {
        message: message.into(),
        line: span.line,
        col: span.col,
    }
}

/// Parse `src` into an [`Expr`], or return a [`CoreError::Expr`] carrying
/// the position of the offending token.
pub fn parse_expr(src: &str) -> Result<Expr, CoreError> {
    let mut p = Parser {
        toks: tokenize(src)?,
        pos: 0,
        eof: eof_span(src),
        depth: 0,
    };
    let e = p.parse_binary(1)?;
    if let Some(t) = p.peek().cloned() {
        return Err(err("unexpected token", t.span));
    }
    Ok(e)
}

struct Parser {
    toks: Vec<Lexed>,
    pos: usize,
    /// Physical position one past the last character, used for
    /// end-of-input errors (the lexer drops trailing whitespace).
    eof: Span,
    /// Current recursion depth; see [`MAX_PARSE_DEPTH`].
    depth: u32,
}

impl Parser {
    fn peek(&self) -> Option<&Lexed> {
        self.toks.get(self.pos)
    }


    fn next(&mut self) -> Option<Lexed> {
        let t = self.toks.get(self.pos).cloned();
        if t.is_some() {
            self.pos += 1;
        }
        t
    }

    /// Depth-tracked entry point; the cap check lives inside so both
    /// the Ok and Err exits of the inner walk decrement on unwind.
    fn parse_binary(&mut self, min_prec: u8) -> Result<Expr, CoreError> {
        self.depth += 1;
        let out = self.parse_binary_impl(min_prec);
        self.depth -= 1;
        out
    }

    fn parse_binary_impl(&mut self, min_prec: u8) -> Result<Expr, CoreError> {
        if self.depth > MAX_PARSE_DEPTH {
            let span = self.peek().map(|t| t.span).unwrap_or(self.eof);
            return Err(err("expression nesting too deep", span));
        }
        let mut lhs = self.parse_unary()?;
        loop {
            let Some(t) = self.peek() else { break };
            let prec = match &t.tok {
                Tok::Op("||") => 1,
                Tok::Op("&&") => 2,
                Tok::Op("==" | "!=" | "<" | ">" | "<=" | ">=") => 3,
                Tok::Op("+" | "-") => 4,
                Tok::Op("*" | "/" | "%") => 5,
                _ => break,
            };
            if prec < min_prec {
                break;
            }
            let Tok::Op(op) = &t.tok else { unreachable!("matched Op above") };
            let op: &'static str = op;
            self.next();
            // prec + 1 makes same-precedence operators left-associative.
            let rhs = self.parse_binary(prec + 1)?;
            lhs = Expr::Binary {
                op,
                lhs: Box::new(lhs),
                rhs: Box::new(rhs),
            };
        }
        Ok(lhs)
    }

    fn parse_unary(&mut self) -> Result<Expr, CoreError> {
        if let Some(t) = self.peek() {
            if let Tok::Op(op @ ("!" | "-")) = &t.tok {
                let op: &'static str = op;
                let op_span = t.span;
                // Unary chains self-recurse without re-entering
                // parse_binary, so the shared depth counter must be
                // applied here too — `!!!!!…x` is as deep as parens.
                self.depth += 1;
                let over = self.depth > MAX_PARSE_DEPTH;
                if over {
                    self.depth -= 1;
                    return Err(err("expression nesting too deep", op_span));
                }
                self.next();
                let inner = self.parse_unary();
                self.depth -= 1;
                let expr = Box::new(inner?);
                return Ok(Expr::Unary { op, expr });
            }
        }
        self.parse_postfix()
    }

    fn parse_postfix(&mut self) -> Result<Expr, CoreError> {
        let mut e = self.parse_primary()?;
        loop {
            match self.peek().map(|t| &t.tok) {
                Some(Tok::Op("(")) => e = self.parse_call_or_method(e)?,
                Some(Tok::Op("[")) => {
                    self.next();
                    let index = Box::new(self.parse_binary(1)?);
                    self.expect_op("]")?;
                    e = Expr::Index {
                        target: Box::new(e),
                        index,
                    };
                }
                // A `.` surviving path folding sits after a non-path
                // expression. The one supported form is a method call
                // on a computed value — spec §1's example formula
                // `(now() - file.created).days()`. Literals keep the
                // "no method form" rule (`"x".contains("y")` is a
                // parse error), and a name without a following `(` is
                // still rejected.
                Some(Tok::Op(".")) => {
                    let span = self.peek().unwrap().span;
                    if matches!(e, Expr::Lit(_)) {
                        return Err(err("`.` is only valid inside an identifier path", span));
                    }
                    self.next(); // `.`
                    let name = match self.next() {
                        Some(Lexed {
                            tok: Tok::Ident(id),
                            ..
                        }) => id,
                        Some(bad) => {
                            return Err(err("expected identifier after `.`", bad.span))
                        }
                        None => return Err(err("expected identifier after `.`", self.eof)),
                    };
                    if !matches!(self.peek().map(|t| &t.tok), Some(Tok::Op("("))) {
                        let span =
                            self.peek().map(|t| t.span).unwrap_or(self.eof);
                        return Err(err("expected `(` after method name", span));
                    }
                    let args = self.parse_args()?;
                    e = Expr::Method {
                        target: Box::new(e),
                        name,
                        args,
                    };
                }
                _ => break,
            }
        }
        Ok(e)
    }

    /// Consume a `(`-introduced argument list already peeked by the
    /// caller.
    fn parse_args(&mut self) -> Result<Vec<Expr>, CoreError> {
        self.next(); // `(`
        let mut args = Vec::new();
        if !matches!(self.peek().map(|t| &t.tok), Some(Tok::Op(")"))) {
            loop {
                args.push(self.parse_binary(1)?);
                match self.peek().map(|t| &t.tok) {
                    Some(Tok::Op(",")) => {
                        self.next();
                    }
                    _ => break,
                }
            }
        }
        self.expect_op(")")?;
        Ok(args)
    }

    /// Combine an already-consumed `(`-argument list with `target` as a
    /// Call or Method.
    fn parse_call_or_method(&mut self, target: Expr) -> Result<Expr, CoreError> {
        let open = self.peek().unwrap().span;
        let args = self.parse_args()?;

        match target {
            // Length-1 path with a global head is the function-call form.
            Expr::Path(mut segs) if segs.len() == 1 && is_global(&segs[0]) => {
                Ok(Expr::Call {
                    name: segs.remove(0),
                    args,
                })
            }
            // Longer path: the last segment names the method, the rest is
            // its target (`file.hasTag("x")`).
            Expr::Path(mut segs) if segs.len() >= 2 => {
                let name = segs.pop().expect("len checked >= 2");
                Ok(Expr::Method {
                    target: Box::new(Expr::Path(segs)),
                    name,
                    args,
                })
            }
            // A single non-global identifier cannot be called.
            Expr::Path(segs) => Err(err(format!("unknown function `{}`", segs[0]), open)),
            _ => Err(err("expression is not callable", open)),
        }
    }

    fn parse_primary(&mut self) -> Result<Expr, CoreError> {
        let Some(t) = self.peek().cloned() else {
            return Err(err("unexpected end of input", self.eof));
        };
        match t.tok {
            Tok::Num(n) => {
                self.next();
                Ok(Expr::Lit(Value::Num(n)))
            }
            Tok::Str(s) => {
                self.next();
                Ok(Expr::Lit(Value::Str(s)))
            }
            Tok::Ident(id) => {
                self.next();
                if id == "true" {
                    return Ok(Expr::Lit(Value::Bool(true)));
                }
                if id == "false" {
                    return Ok(Expr::Lit(Value::Bool(false)));
                }
                let mut segs = vec![id];
                // Fold `.` `Ident` pairs greedily; the postfix stage
                // decides call vs. method when it meets a `(`.
                while matches!(self.peek().map(|t| &t.tok), Some(Tok::Op("."))) {
                    self.next(); // `.`
                    match self.next() {
                        Some(Lexed {
                            tok: Tok::Ident(seg),
                            ..
                        }) => segs.push(seg),
                        Some(bad) => {
                            return Err(err("expected identifier after `.`", bad.span));
                        }
                        None => return Err(err("expected identifier after `.`", self.eof)),
                    }
                }
                Ok(Expr::Path(segs))
            }
            Tok::Op("(") => {
                self.next();
                let e = self.parse_binary(1)?;
                self.expect_op(")")?;
                Ok(e)
            }
            other => Err(err(format!("expected expression, found {}", describe(&other)), t.span)),
        }
    }

    fn expect_op(&mut self, op: &str) -> Result<(), CoreError> {
        match self.next() {
            Some(Lexed { tok: Tok::Op(o), .. }) if o == op => Ok(()),
            Some(bad) => Err(
                err(
                    format!("expected `{op}`, found {}", describe(&bad.tok)),
                    bad.span,
                ),
            ),
            None => Err(err(format!("expected `{op}` before end of input"), self.eof)),
        }
    }
}

/// Human name of a token for error messages.
fn describe(tok: &Tok) -> String {
    match tok {
        Tok::Ident(s) => format!("identifier `{s}`"),
        Tok::Num(n) => format!("number {}", format_num(*n)),
        Tok::Str(_) => "string".into(),
        Tok::Op(o) => format!("`{o}`"),
    }
}

/// Position one past the last character of `src` (1-based, chars).
fn eof_span(src: &str) -> Span {
    let mut line = 1;
    let mut col = 1;
    for c in src.chars() {
        if c == '\n' {
            line += 1;
            col = 1;
        } else {
            col += 1;
        }
    }
    Span { line, col }
}

/// Binding strength used by the canonical printer to decide parens.
/// Mirrors the parser precedence table; postfix forms and atoms share
/// the top level.
fn prec(e: &Expr) -> u8 {
    match e {
        Expr::Lit(_) | Expr::Path(_) | Expr::Call { .. } | Expr::Index { .. }
        | Expr::Method { .. } => 7,
        Expr::Unary { .. } => 6,
        Expr::Binary { op, .. } => binary_prec(op).unwrap_or(6),
    }
}

fn binary_prec(op: &str) -> Option<u8> {
    Some(match op {
        "||" => 1,
        "&&" => 2,
        "==" | "!=" | "<" | ">" | "<=" | ">=" => 3,
        "+" | "-" => 4,
        "*" | "/" | "%" => 5,
        _ => return None,
    })
}

/// Canonical printed form of an [`Expr`]: paths joined with `.`, strings
/// re-quoted with `"` (escaping `\` and `"`), binary chains
/// parenthesized as a left-associative tree, and minimal parentheses
/// wherever child precedence would otherwise re-associate. Printing then
/// reparsing always yields an equal AST.
pub fn expr_to_string(e: &Expr) -> String {
    match e {
        Expr::Lit(v) => match v {
            Value::Bool(true) => "true".into(),
            Value::Bool(false) => "false".into(),
            Value::Num(n) => format_num(*n),
            Value::Str(s) => format!("\"{}\"", escape_str(s)),
            // Literal position only ever holds Bool|Num|Str (see
            // `parse_primary`); defensive catch-all for hand-built ASTs.
            _ => group_string(v),
        },
        Expr::Path(segs) => segs.join("."),
        Expr::Call { name, args } => format!("{}({})", name, fmt_args(args)),
        Expr::Method { target, name, args } => {
            format!("{}.{}({})", child(target, 7), name, fmt_args(args))
        }
        Expr::Index { target, index } => {
            format!("{}[{}]", child(target, 7), expr_to_string(index))
        }
        Expr::Unary { op, expr } => format!("{}{}", op, child(expr, 6)),
        Expr::Binary { op, lhs, rhs } => {
            let p = binary_prec(op).unwrap_or(6);
            // Right child needs parens at equal precedence so the
            // left-associative tree re-parses identically (`a - (b - c)`).
            format!("{} {} {}", child(lhs, p), op, child(rhs, p + 1))
        }
    }
}

fn child(e: &Expr, min_prec: u8) -> String {
    if prec(e) < min_prec {
        format!("({})", expr_to_string(e))
    } else {
        expr_to_string(e)
    }
}

fn fmt_args(args: &[Expr]) -> String {
    args.iter().map(expr_to_string).collect::<Vec<_>>().join(", ")
}

fn escape_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            _ => out.push(c),
        }
    }
    out
}

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

    /// Nested parens must hit a catchable parse error, never a stack
    /// overflow: without the depth cap ~400-800 nested parens abort the
    /// whole process (SIGSEGV → exit 134), reachable from a pasted
    /// `save_base` or a synced `.query` `run_base` (spec §7
    /// never-a-crash). Depth is built programmatically — the suite
    /// must never probe stack-overflow scale.
    #[test]
    fn parse_depth_is_capped_not_fatal() {
        // 199 nested parens → parser depth exactly MAX_PARSE_DEPTH: OK.
        let ok = format!("{}1{}", "(".repeat(199), ")".repeat(199));
        assert!(parse_expr(&ok).is_ok(), "depth 199 must parse");
        // 201 nested parens → one past twice over: Err with a span,
        // not a process abort.
        let deep = format!("{}1{}", "(".repeat(201), ")".repeat(201));
        match parse_expr(&deep) {
            Err(CoreError::Expr { message, line, col }) => {
                assert!(message.contains("nesting too deep"), "got: {message}");
                assert_eq!((line, col), (1, 201), "span points at the over-deep paren");
            }
            other => panic!("expected depth error, got {other:?}"),
        }
    }

    /// Unary `!`/`-` chains recurse without re-entering
    /// `parse_binary`, so they share the depth counter too —
    /// `-----…x` is capped, never a stack-overflow abort.
    #[test]
    fn unary_chain_depth_is_capped_not_fatal() {
        let ok = format!("{}1", "-".repeat(199));
        assert!(parse_expr(&ok).is_ok(), "199 unary ops must parse");
        let deep = format!("{}1", "-".repeat(201));
        match parse_expr(&deep) {
            Err(CoreError::Expr { message, line, col }) => {
                assert!(message.contains("nesting too deep"), "got: {message}");
                // parse_binary holds depth 1, so unary #200 (the one
                // past the cap) trips the counter — column 200.
                assert_eq!((line, col), (1, 200), "span points at the over-deep operator");
            }
            other => panic!("expected depth error, got {other:?}"),
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

    // --- Supplementary coverage (beyond the task brief) ---

    #[test]
    fn call_method_and_unknown_function() {
        // Length-1 global-head path in call position → Call.
        let c = parse_expr("length(note.tags)").unwrap();
        assert!(matches!(&c, Expr::Call { name, args } if name == "length" && args.len() == 1));
        // Longer path before `(` → Method with the last segment as name.
        let m = parse_expr("file.hasTag(\"work\")").unwrap();
        match &m {
            Expr::Method { target, name, args } => {
                assert!(matches!(&**target, Expr::Path(segs) if segs == &vec!["file"]));
                assert_eq!(name, "hasTag");
                assert_eq!(args.len(), 1);
            }
            other => panic!("expected Method, got {other:?}"),
        }
        // Bare non-global identifier in call position → parse error.
        match parse_expr("frobnicate(x)") {
            Err(CoreError::Expr { message, line, col }) => {
                assert!(message.contains("unknown function `frobnicate`"));
                // Span points at the call's `(`.
                assert_eq!((line, col), (1, 11));
            }
            other => panic!("expected error, got {other:?}"),
        }
        // `(` after a parenthesized (non-path) expression is not callable.
        assert!(parse_expr("(a + b)(x)").is_err());
    }

    #[test]
    fn method_call_on_computed_value() {
        // Spec §1's example formula: `(now() - file.created).days()`
        // is a Method whose target is the parenthesized expression.
        let e = parse_expr("(now() - file.created).days()").unwrap();
        match &e {
            Expr::Method { target, name, args } => {
                assert_eq!(name, "days");
                assert!(matches!(target.as_ref(), Expr::Binary { op: "-", .. }));
                assert!(args.is_empty());
            }
            other => panic!("expected a method on a computed target, got {other:?}"),
        }
        // A method name without a call is still rejected.
        assert!(parse_expr("(a + b).days").is_err());
        // A method on an index postfix parses too; the value table
        // answers it at eval time.
        assert!(parse_expr("note.tags[0].contains(\"x\")").is_ok());
    }

    #[test]
    fn dot_rules() {
        // `.` after a string literal has no method form in the grammar.
        match parse_expr("\"x\".contains(\"y\")") {
            Err(CoreError::Expr { message, line, col }) => {
                assert!(message.contains("`.` is only valid"));
                assert_eq!((line, col), (1, 4));
            }
            other => panic!("expected error, got {other:?}"),
        }
        // `.` after an index postfix is equally rejected.
        assert!(parse_expr("note.tags[0].title").is_err());
        // `.` without a following identifier.
        match parse_expr("a.") {
            Err(CoreError::Expr { message, line, col }) => {
                assert!(message.contains("expected identifier"));
                assert_eq!((line, col), (1, 3));
            }
            other => panic!("expected error, got {other:?}"),
        }
        // Trailing tokens after a complete expression.
        assert!(parse_expr("a b").is_err());
        assert!(parse_expr("").is_err());
    }

    #[test]
    fn printer_minimal_parens() {
        let roundtrip_eq = |src: &str| {
            let e = parse_expr(src).unwrap();
            let printed = expr_to_string(&e);
            let reparsed = parse_expr(&printed).unwrap();
            assert_eq!(reparsed, e, "src={src} printed={printed}");
            printed
        };
        // Left-assoc chains print without parens…
        assert_eq!(roundtrip_eq("a + b + c"), "a + b + c");
        assert_eq!(roundtrip_eq("a * b + c"), "a * b + c");
        // …but right-nesting keeps them.
        assert_eq!(roundtrip_eq("a - (b - c)"), "a - (b - c)");
        assert_eq!(roundtrip_eq("(a + b) * c"), "(a + b) * c");
        assert_eq!(roundtrip_eq("!(a && b) || c"), "!(a && b) || c");
        // Unary printing.
        assert_eq!(roundtrip_eq("- -x"), "--x");
        assert_eq!(roundtrip_eq("!favorite"), "!favorite");
        // Strings re-quoted with escapes preserved.
        let esc = parse_expr(r#""a\"b\\c""#).unwrap();
        assert!(matches!(&esc, Expr::Lit(Value::Str(s)) if s == "a\"b\\c"));
        assert_eq!(expr_to_string(&esc), r#""a\"b\\c""#);
        // Nested index and mixed forms.
        assert_eq!(roundtrip_eq("note.tags[i + 1][0]"), "note.tags[i + 1][0]");
        assert_eq!(
            roundtrip_eq("if(x > 1, \"a\", \"b\")"),
            "if(x > 1, \"a\", \"b\")"
        );
        assert_eq!(roundtrip_eq("now() - \"1w\""), "now() - \"1w\"");
        assert_eq!(roundtrip_eq("file.hasTag(\"work\")"), "file.hasTag(\"work\")");
        // Numbers print canonically.
        let n = Expr::Lit(Value::Num(4.0));
        assert_eq!(expr_to_string(&n), "4");
    }

    #[test]
    fn spans_are_physical_multiline() {
        // Error on line 2 reports line 2, col of the offending token.
        let src = "a &&\n  b +";
        match parse_expr(src) {
            Err(CoreError::Expr { line, col, .. }) => assert_eq!((line, col), (2, 6)),
            other => panic!("expected error, got {other:?}"),
        }
        // EOF position after a newline resets the column.
        match parse_expr("a +\n") {
            Err(CoreError::Expr { line, col, .. }) => assert_eq!((line, col), (2, 1)),
            other => panic!("expected error, got {other:?}"),
        }
    }
}
