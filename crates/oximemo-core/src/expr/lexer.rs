//! Tokenizer for the Bases-compatible expression engine (spec 2026-08-25 §2).
//!
//! Produces tokens with 1-based line/col spans (col counts characters, not
//! bytes) suitable for error reporting. Skips whitespace, recognizes
//! identifiers, numbers, double- and single-quoted strings with `\\` and
//! quote escapes, and a fixed set of operators and punctuation. `//` line
//! comments are intentionally NOT supported: YAML strings are single-line
//! and comment-like content inside them must not silently disappear.


use crate::error::CoreError;

/// 1-based source position of a token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Span {
    pub line: u32,
    pub col: u32,
}

/// Lexer token. Operators and punctuation carry their static spelling so
/// downstream stages match the exact operator without losing source form
/// (e.g. distinguishing `==` from a lone `=`, which is not an operator).
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Tok {
    Ident(String),
    Num(f64),
    Str(String),
    Op(&'static str),
}

/// A token with the source position where it begins.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Lexed {
    pub tok: Tok,
    pub span: Span,
}

fn err(message: impl Into<String>, line: u32, col: u32) -> CoreError {
    CoreError::Expr {
        message: message.into(),
        line,
        col,
    }
}

/// Tokenize `src` into tokens with spans, or return a [`CoreError::Expr`]
/// pointing at the offending character.
pub(crate) fn tokenize(src: &str) -> Result<Vec<Lexed>, CoreError> {
    let mut out = Vec::new();
    let mut line: u32 = 1;
    let mut col: u32 = 1;
    let mut chars = src.chars().peekable();

    while let Some(&c) = chars.peek() {
        // Whitespace: skip, but track line/col.
        if c.is_whitespace() {
            if c == '\n' {
                line += 1;
                col = 1;
            } else {
                col += 1;
            }
            chars.next();
            continue;
        }

        let start_line = line;
        let start_col = col;

        // Identifiers: [A-Za-z_][A-Za-z0-9_]* (Korean property names arrive
        // via note["이름"], never as bare idents).
        if c.is_ascii_alphabetic() || c == '_' {
            let mut ident = String::new();
            while let Some(&nc) = chars.peek() {
                if nc.is_ascii_alphanumeric() || nc == '_' {
                    ident.push(nc);
                    col += 1;
                    chars.next();
                } else {
                    break;
                }
            }
            out.push(Lexed {
                tok: Tok::Ident(ident),
                span: Span {
                    line: start_line,
                    col: start_col,
                },
            });
            continue;
        }

        // Numbers: [0-9]+(\.[0-9]+)? — no leading sign, no exponent (unary
        // minus is an operator; scientific notation is not in the grammar).
        if c.is_ascii_digit() {
            let mut num = String::new();
            let mut seen_point = false;
            while let Some(&nc) = chars.peek() {
                if nc.is_ascii_digit() {
                    num.push(nc);
                    col += 1;
                    chars.next();
                } else if nc == '.'
                    && !seen_point
                    && next_after_current(&chars, 1).is_ascii_digit()
                {
                    seen_point = true;
                    num.push(nc);
                    col += 1;
                    chars.next();
                } else {
                    break;
                }
            }
            let value: f64 = num.parse().map_err(|_| {
                err(format!("invalid numeric literal `{num}`"), start_line, start_col)
            })?;
            // Spec §2: non-finite numerics are expression errors. A literal
            // long enough to overflow f64 is rejected here rather than
            // leaking `inf` into evaluation.
            if !value.is_finite() {
                return Err(err(
                    format!("numeric literal `{num}` out of range"),
                    start_line,
                    start_col,
                ));
            }
            out.push(Lexed {
                tok: Tok::Num(value),
                span: Span {
                    line: start_line,
                    col: start_col,
                },
            });
            continue;
        }

        // Strings: "…" or '…' with `\\` and the quote character as the only
        // escapes. Anything else after a backslash is an error (so e.g.
        // Windows-ish paths like "C:\notes" fail loudly instead of silently
        // mangling into a newline).
        if c == '"' || c == '\'' {
            chars.next();
            col += 1;
            let mut value = String::new();
            let mut closed = false;
            while let Some(nc) = chars.next() {
                col += 1;
                if nc == '\n' {
                    line += 1;
                    col = 1;
                }
                if nc == '\\' {
                    match chars.next() {
                        Some(e) if e == '\\' || e == c => {
                            value.push(e);
                            col += 1;
                        }
                        Some(e) => {
                            return Err(err(
                                format!("invalid escape `\\{e}`"),
                                start_line,
                                start_col,
                            ));
                        }
                        None => {
                            return Err(err("unterminated string", start_line, start_col));
                        }
                    }
                    continue;
                }
                if nc == c {
                    closed = true;
                    break;
                }
                value.push(nc);
            }
            if !closed {
                return Err(err("unterminated string", start_line, start_col));
            }
            out.push(Lexed {
                tok: Tok::Str(value),
                span: Span {
                    line: start_line,
                    col: start_col,
                },
            });
            continue;
        }

        // Operators and punctuation. Two-char operators are matched before
        // their one-char prefixes (longest match wins). A cloned Peekable
        // replays the buffered peek char first, so step past the current
        // char before looking at what follows it.
        let peek1 = next_after_current(&chars, 1);
        let op = match (c, peek1) {
            ('=', '=') => Some("=="),
            ('!', '=') => Some("!="),
            ('>', '=') => Some(">="),
            ('<', '=') => Some("<="),
            ('&', '&') => Some("&&"),
            ('|', '|') => Some("||"),
            _ => match_one(c),
        };
        if let Some(op) = op {
            for _ in 0..op.len() {
                chars.next();
            }
            col += op.len() as u32;
            out.push(Lexed {
                tok: Tok::Op(op),
                span: Span {
                    line: start_line,
                    col: start_col,
                },
            });
            continue;
        }

        return Err(err("unexpected character", start_line, start_col));
    }

    Ok(out)
}

/// The character `n` positions after the current peeked char ('\0' at end
/// of input). Never consumes from `chars`.
fn next_after_current<I: Iterator<Item = char> + Clone>(
    chars: &std::iter::Peekable<I>,
    n: usize,
) -> char {
    let mut probe = chars.clone();
    probe.next();
    probe.nth(n - 1).unwrap_or('\0')
}

/// One-character operators and punctuation. A lone `=`, `&`, or `|` is
/// deliberately absent: only their doubled forms exist in the grammar.
fn match_one(c: char) -> Option<&'static str> {
    match c {
        '+' => Some("+"),
        '-' => Some("-"),
        '*' => Some("*"),
        '/' => Some("/"),
        '%' => Some("%"),
        '!' => Some("!"),
        '>' => Some(">"),
        '<' => Some("<"),
        '.' => Some("."),
        ',' => Some(","),
        '(' => Some("("),
        ')' => Some(")"),
        '[' => Some("["),
        ']' => Some("]"),
        _ => None,
    }
}

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
        // Brief expected (1, 10), but the opening quote of "done" is
        // physically at col 11 (s1 t2 a3 t4 u5 s6 sp7 !8 =9 sp10 "11).
        // The brief's own Step 3 ("col = 1-based char count") and its
        // error-position tests ($ at col 3 of "a $ b") pin physical
        // 1-based columns, so the expected value is corrected to 11.
        assert_eq!((toks[2].span.line, toks[2].span.col), (1, 11));
        assert!(matches!(&toks[2].tok, Tok::Str(s) if s == "done"));
    }

    #[test]
    fn strings_numbers_ops() {
        assert!(tokenize(r#""a \"b\" c""#).is_ok());
        assert!(matches!(tokenize("3.14").unwrap()[0].tok, Tok::Num(n) if (n - 3.14).abs() < 1e-9));
        // Brief wrote `[1].tok` (no `&`); `Tok::Op(o) if *o == "&&"` only
        // typechecks when matching through a reference, so `&` is added.
        // The `Op(&'static str)` interface from the brief is unchanged.
        assert!(matches!(&tokenize("a && !b || c").unwrap()[1].tok, Tok::Op(o) if *o == "&&"));
    }

    #[test]
    fn error_position_is_line_col() {
        assert_eq!(err_at("a $ b"), (1, 3));
        assert_eq!(err_at("ok\n  @"), (2, 3));
    }

    #[test]
    fn operator_set_longest_match_first() {
        // Every operator from the brief's interface round-trips, and
        // two-char operators never split into their one-char prefixes.
        let toks = tokenize("== != >= <= && || + - * / % ! > < . , ( ) [ ]").unwrap();
        let ops: Vec<&str> = toks
            .iter()
            .map(|t| match &t.tok {
                Tok::Op(o) => *o,
                other => panic!("expected op, got {other:?}"),
            })
            .collect();
        assert_eq!(
            ops,
            vec![
                "==", "!=", ">=", "<=", "&&", "||", "+", "-", "*", "/", "%", "!", ">", "<", ".",
                ",", "(", ")", "[", "]",
            ]
        );
    }

    #[test]
    fn lone_equals_ampersand_pipe_are_errors() {
        // `=` only exists as `==`; single `&`/`|` only as `&&`/`||`.
        assert_eq!(err_at("a = b"), (1, 3));
        assert_eq!(err_at("a & b"), (1, 3));
        assert_eq!(err_at("a | b"), (1, 3));
    }

    #[test]
    fn numbers_no_sign_no_trailing_dot() {
        // Unary minus is an operator; `-5` lexes as Op("-") then Num(5).
        let toks = tokenize("-5").unwrap();
        assert!(matches!(&toks[0].tok, Tok::Op(o) if *o == "-"));
        assert!(matches!(&toks[1].tok, Tok::Num(n) if *n == 5.0));
        // `1.` is Num(1) followed by Op(".") — member access is the
        // parser's call, not the lexer's.
        let toks = tokenize("1.").unwrap();
        assert!(matches!(&toks[0].tok, Tok::Num(n) if *n == 1.0));
        assert!(matches!(&toks[1].tok, Tok::Op(o) if *o == "."));
        // A digit must follow the decimal point for it to join the number.
        let toks = tokenize("12.34.56").unwrap();
        assert!(matches!(&toks[0].tok, Tok::Num(n) if (n - 12.34).abs() < 1e-9));
        assert!(matches!(&toks[1].tok, Tok::Op(o) if *o == "."));
        assert!(matches!(&toks[2].tok, Tok::Num(n) if (n - 56.0).abs() < 1e-9));
    }

    #[test]
    fn string_escapes_and_quotes() {
        // Only \\ and the active quote are escapable.
        let toks = tokenize(r#""a \"b\" c\\d""#).unwrap();
        assert!(matches!(&toks[0].tok, Tok::Str(s) if s == r#"a "b" c\d"#));
        let toks = tokenize(r#"'it\'s'"#).unwrap();
        assert!(matches!(&toks[0].tok, Tok::Str(s) if s == "it's"));
        // A double quote inside single quotes needs no escape.
        let toks = tokenize(r#"'say "hi"'"#).unwrap();
        assert!(matches!(&toks[0].tok, Tok::Str(s) if s == r#"say "hi""#));
        // Unknown escapes are errors at the string's position.
        assert_eq!(err_at(r#""C:\notes""#), (1, 1));
        // Unterminated strings are errors.
        assert!(matches!(
            tokenize(r#""open"#),
            Err(CoreError::Expr { message, .. }) if message == "unterminated string"
        ));
    }

    #[test]
    fn korean_property_names_via_strings_not_idents() {
        // Korean text can't be a bare ident; it arrives inside strings.
        assert!(matches!(
            &tokenize("note[\"이름\"]").unwrap()[2].tok,
            Tok::Str(s) if s == "이름"
        ));
        assert_eq!(err_at("이름 == 1"), (1, 1));
    }

    #[test]
    fn overflowing_literal_is_error() {
        let huge = "9".repeat(400);
        assert!(matches!(
            tokenize(&huge),
            Err(CoreError::Expr { message, .. }) if message.contains("out of range")
        ));
    }

    #[test]
    fn multiline_positions_stay_physical() {
        // Positions after a newline and after multi-char operators remain
        // physical 1-based char counts (no drift).
        let toks = tokenize("a >= 1\n&& b").unwrap();
        assert_eq!((toks[1].span.line, toks[1].span.col), (1, 3));
        assert_eq!((toks[2].span.line, toks[2].span.col), (1, 6));
        assert_eq!((toks[3].span.line, toks[3].span.col), (2, 1));
        assert_eq!((toks[4].span.line, toks[4].span.col), (2, 4));
    }
}
