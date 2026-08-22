//! Line-based scanner for the oxi ecosystem frontmatter grammar (v2).
//!
//! Markdown notes are wrapped in `---` fences; HTML notes are wrapped in
//! an HTML comment (`<!-- ... -->`) with the same `---` markers inside.
//! The accepted subset is a small, deterministic YAML subset (see
//! `SPEC.md`) — anything outside it is a hard parse error.

use indexmap::IndexMap;

/// Source format for a note passed to [`parse`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoteFormat {
    /// Plain Markdown / Obsidian-flavored Markdown.
    Markdown,
    /// HTML with frontmatter wrapped in an HTML comment.
    Html,
}

/// Ordered key → value map. Iteration order matches insertion order, so
/// serialization is stable and round-trippable.
pub type Table = IndexMap<String, Value>;

/// Scalar / container values produced by the parser.
///
/// The enum is intentionally small: every shape outside it is rejected
/// at parse time. Timestamps, dates, floats, integers, and other
/// YAML-friendly scalar types are kept as [`Value::Str`] — schema
/// validation is a separate concern (Task 11).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Value {
    /// `true` or `false`.
    Bool(bool),
    /// Bare or quoted string. Holds timestamps, dates, floats, ints,
    /// and any other non-boolean scalar.
    Str(String),
    /// Homogeneous sequence of strings (flow `[a, b]` or block
    /// `key:\n  - a\n  - b`).
    Array(Vec<String>),
    /// Nested table (depth ≤ 2).
    Map(Table),
}

/// Result of parsing a note.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Parsed {
    /// Note had a frontmatter block. `body` is everything after the
    /// closing fence, reconstructed from the **original input** so
    /// line endings and other characters survive intact. See
    /// [`Parsed::BodyOnly`] for the rationale.
    Memo {
        /// Parsed frontmatter table.
        table: Table,
        /// Body content following the frontmatter block.
        body: String,
    },
    /// No frontmatter block was found. `body` is the original input,
    /// **unchanged** — line endings, BOM-absent shape, and all other
    /// characters are preserved verbatim so a Task 2 write-back does
    /// not silently rewrite untouched notes.
    BodyOnly {
        /// The whole input, verbatim.
        body: String,
    },
}

/// Parse error with a 1-indexed line number (counted in the
/// normalized LF view, after the opening fence) and an actionable
/// reason.
///
/// For unclosed fences the reason contains the literal
/// `"horizontal rule"` so error messages can point at the likely
/// cause.
#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
#[error("frontmatter parse error at line {line}: {reason}")]
pub struct ParseError {
    /// 1-indexed line number in the normalized (LF) view.
    pub line: usize,
    /// Human-readable reason.
    pub reason: String,
}

impl ParseError {
    /// Convenience constructor used by the parser internals.
    fn new(line: usize, reason: impl Into<String>) -> Self {
        Self {
            line,
            reason: reason.into(),
        }
    }
}

/// Parse a note's content into a [`Parsed`] value.
///
/// # Errors
///
/// Returns [`ParseError`] for any malformed frontmatter block. Notes
/// without a recognizable fence pair succeed with [`Parsed::BodyOnly`].
pub fn parse(content: &str, fmt: NoteFormat) -> Result<Parsed, ParseError> {
    // BOM check — applied before any other inspection. The brief is
    // explicit: a BOM is a hard error, not a silent strip.
    if content.starts_with('\u{feff}') {
        return Err(ParseError::new(
            1,
            "BOM (U+FEFF) at start of input; strip it before writing",
        ));
    }

    // Normalize CRLF → LF on the input boundary so the rest of the
    // parser sees LF-only text. We keep the original around for
    // BodyOnly passthrough.
    let normalized = content.replace("\r\n", "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();

    match fmt {
        NoteFormat::Markdown => parse_markdown(content, &lines),
        NoteFormat::Html => parse_html(content, &lines),
    }
}

/// Returns true if `line`, trimmed of trailing whitespace, equals
/// `target`. Used for fence detection so `--- ` (trailing space) is
/// still a fence.
fn fence_line(line: &str, target: &str) -> bool {
    line.trim_end() == target
}

/// Find the next line whose trimmed form equals `target`.
fn find_fence(lines: &[&str], from: usize, target: &str) -> Option<usize> {
    lines
        .iter()
        .enumerate()
        .skip(from)
        .find(|(_, l)| fence_line(l, target))
        .map(|(i, _)| i)
}

/// Find the byte offset in `original` immediately after the end of
/// the `line_idx`-th LF-normalized line. We scan the normalized view
/// to locate the position. This assumes `original` was already
/// normalized (or that we just want the same offset in the original
/// as long as no CRLF→LF shift changes line breaks — which is true
/// because both `\r\n` and `\n` collapse to `\n` in the normalized
/// view; the byte index of line N within the normalized string
/// corresponds to the same logical position in the original modulo
/// CRLF stripping).
fn original_byte_offset_after_line(original: &str, line_idx: usize) -> usize {
    // Walk the original and the normalized view side by side.
    let mut oi = 0usize; // byte offset in original
    let mut li = 0usize; // line index in normalized
    let bytes = original.as_bytes();
    while li < line_idx && oi < bytes.len() {
        // Skip until the line terminator.
        while oi < bytes.len() && bytes[oi] != b'\n' {
            oi += 1;
        }
        if oi < bytes.len() {
            // In the original, the terminator may be CRLF; the
            // normalized view dropped the CR. Move past the LF.
            oi += 1;
            li += 1;
        }
    }
    oi
}

fn parse_markdown(original: &str, lines: &[&str]) -> Result<Parsed, ParseError> {
    // First line must be exactly `---` (modulo whitespace trimming).
    let first = lines.first().copied().unwrap_or("");
    if !fence_line(first, "---") {
        // No frontmatter — return the original input untouched.
        return Ok(Parsed::BodyOnly {
            body: original.to_string(),
        });
    }

    // Find closing fence starting from line 1.
    let close_idx = match find_fence(lines, 1, "---") {
        Some(i) => i,
        None => {
            return Err(ParseError::new(
                lines.len(),
                "unclosed frontmatter fence (note: three dashes also render as a Markdown \
                 horizontal rule; did you forget the closing `---`?)",
            ));
        }
    };

    // Lines between (1..close_idx) are the block body.
    if close_idx == 1 {
        return Err(ParseError::new(
            2,
            "empty frontmatter block; remove the block or add at least one entry",
        ));
    }

    let block_lines: Vec<&str> = lines[1..close_idx].to_vec();
    // Markdown block: opening fence is line 1, so first block line
    // sits at line index 0 in `block_lines`, original line 2.
    let table = parse_block(&block_lines, 2)?;

    // Body is reconstructed from the original input to preserve
    // line endings (Finding #5). We slice the original after the
    // first character of the closing fence; the closing fence in the
    // normalized view ends at offset `close_idx_offset`, then we
    // skip its trailing newline if any.
    let body_start = original_byte_offset_after_line(original, close_idx + 1);
    let body = if body_start >= original.len() {
        String::new()
    } else {
        original[body_start..].to_string()
    };

    Ok(Parsed::Memo { table, body })
}

fn parse_html(original: &str, lines: &[&str]) -> Result<Parsed, ParseError> {
    // First line must be `<!--`; second line must be `---`.
    let first = lines.first().copied().unwrap_or("");
    let second = lines.get(1).copied().unwrap_or("");
    if !fence_line(first, "<!--") || !fence_line(second, "---") {
        // No frontmatter — return the original input untouched so a
        // Task 2 write-back does not silently rewrite it.
        return Ok(Parsed::BodyOnly {
            body: original.to_string(),
        });
    }

    // Find closing `---` from index 2.
    let close_idx = match find_fence(lines, 2, "---") {
        Some(i) => i,
        None => {
            return Err(ParseError::new(
                lines.len(),
                "unclosed frontmatter fence (note: three dashes also render as a Markdown \
                 horizontal rule; did you forget the closing `---`?)",
            ));
        }
    };

    // The line after the closing `---` must be `-->`.
    let after = lines.get(close_idx + 1).copied().unwrap_or("");
    if !fence_line(after, "-->") {
        return Err(ParseError::new(
            close_idx + 2,
            "HTML fence: expected `-->` immediately after closing `---`",
        ));
    }

    if close_idx == 2 {
        return Err(ParseError::new(
            3,
            "empty frontmatter block; remove the block or add at least one entry",
        ));
    }

    let block_lines: Vec<&str> = lines[2..close_idx].to_vec();
    // HTML block: opening `<!--` is line 1, opening `---` is line 2,
    // so first block line sits at line index 0 in `block_lines`,
    // original line 3.
    let table = parse_block(&block_lines, 3)?;

    // Reconstruct body from the original input to preserve line
    // endings (Finding #5). We slice past the closing `-->` line.
    let body_start = original_byte_offset_after_line(original, close_idx + 2);
    let body = if body_start >= original.len() {
        String::new()
    } else {
        original[body_start..].to_string()
    };

    Ok(Parsed::Memo { table, body })
}

/// Parse the lines inside a fence into a [`Table`]. Enforces depth ≤ 2,
/// indentation 0 or 2, and the value forms described in `SPEC.md`.
///
/// `line_offset` is the 1-indexed number of the first line in
/// `block_lines` in the original (LF-normalized) note, so error
/// messages report the right line.
fn parse_block(lines: &[&str], line_offset: usize) -> Result<Table, ParseError> {
    let mut table: Table = IndexMap::new();

    let mut i = 0;
    while i < lines.len() {
        let raw = lines[i];
        let line = raw.trim_end_matches('\r');
        let line_no = i + line_offset;

        // Reject tabs outright (SPEC §4).
        if line.contains('\t') {
            return Err(ParseError::new(
                line_no,
                "tab character in indentation is not allowed; use spaces",
            ));
        }

        // Full-line comments are rejected before any key parsing
        // (Finding #4).
        if line.trim_start().starts_with('#') {
            return Err(ParseError::new(line_no, "comments (# ...) are not allowed"));
        }

        // Skip blank lines — strict SPEC §4 would reject, but stray
        // blanks are tolerated as in the first report.
        if line.trim().is_empty() {
            i += 1;
            continue;
        }

        // Indentation must be exactly 0 or 2 spaces.
        let indent = indent_of(line);
        if indent == IndentKind::Other {
            return Err(ParseError::new(
                line_no,
                "indentation must be 0 or 2 spaces (no tabs)",
            ));
        }
        if indent == IndentKind::Two {
            return Err(ParseError::new(
                line_no,
                "unexpected indentation; map children must follow a `key:` line at level 0",
            ));
        }

        // Reject forbidden YAML characters at the start of a value:
        // anchors (&), aliases (*), tags (!).
        let content = line;
        if content.starts_with('&') {
            return Err(ParseError::new(line_no, "anchors (&name) are not allowed"));
        }
        if content.starts_with('*') {
            return Err(ParseError::new(line_no, "aliases (*name) are not allowed"));
        }
        if content.starts_with('!') {
            return Err(ParseError::new(line_no, "tags (!tag) are not allowed"));
        }

        // Must be `key:` with no leading whitespace.
        let Some(colon_idx) = content.find(':') else {
            return Err(ParseError::new(
                line_no,
                "expected `key: value` entry; missing colon",
            ));
        };

        let key = &content[..colon_idx];
        let after_colon_raw = &content[colon_idx + 1..];
        // Trim the value before any further inspection (Finding #10).
        let after_colon = after_colon_raw.trim();

        if key.is_empty() {
            return Err(ParseError::new(line_no, "key must not be empty"));
        }

        // Reject duplicates (same key at the same level).
        if table.contains_key(key) {
            return Err(ParseError::new(line_no, format!("duplicate key `{key}`")));
        }

        // Sub-shapes:
        //  1. `key:` followed by level-1 children (map or block sequence)
        //  2. `key: value` (scalar or flow sequence on this line)
        //  3. `key: |` (block scalar)
        if after_colon.is_empty() {
            // Look ahead for level-1 children.
            let mut j = i + 1;
            let mut children: Vec<(usize, &str)> = Vec::new();
            while j < lines.len() {
                let child_raw = lines[j];
                let child = child_raw.trim_end_matches('\r');
                if child.trim().is_empty() {
                    j += 1;
                    continue;
                }
                match indent_of(child) {
                    IndentKind::Two => children.push((j, child)),
                    _ => break,
                }
                j += 1;
            }

            if children.is_empty() {
                return Err(ParseError::new(
                    line_no,
                    "empty value (`key:` with no continuation)",
                ));
            }

            let is_block_seq = children
                .iter()
                .all(|(_, c)| c.trim_start().starts_with("- "));
            let is_map = children
                .iter()
                .all(|(_, c)| !c.trim_start().starts_with("- ") && c.contains(':'));

            if is_block_seq {
                let mut items: Vec<String> = Vec::with_capacity(children.len());
                for (jdx, c) in &children {
                    let item_no = jdx + line_offset;
                    let trimmed = c.trim_start();
                    let item = match trimmed.strip_prefix("- ") {
                        Some(rest) => rest.trim(),
                        None => {
                            return Err(ParseError::new(
                                item_no,
                                "block sequence item must start with `- `",
                            ));
                        }
                    };
                    // A nested sequence marker (e.g. `- - a` or
                    // literal `-`) is rejected per SPEC §3.4: only
                    // flat string sequences are allowed. Bare values
                    // that happen to start with `-` (e.g. `-3.5`)
                    // remain legal.
                    if item == "-" || item.starts_with("- ") {
                        return Err(ParseError::new(
                            item_no,
                            "nested sequence marker is not allowed in a block sequence item",
                        ));
                    }
                    if item.is_empty() {
                        return Err(ParseError::new(
                            item_no,
                            "block sequence item must not be empty",
                        ));
                    }
                    if item.contains('\t') {
                        return Err(ParseError::new(
                            item_no,
                            "tab character in block sequence item",
                        ));
                    }
                    // Block-seq items must satisfy the same bare-scalar
                    // forbidden-char rules as inline scalars (Finding #6).
                    // Quoted items are exempt (Finding #3, round 2) —
                    // strip_quotes first, only validate when bare.
                    let stored = match strip_quotes(item) {
                        Some(inner) => inner.to_string(),
                        None => {
                            validate_bare_scalar(item, item_no)?;
                            item.to_string()
                        }
                    };
                    items.push(stored);
                }
                table.insert(key.to_string(), Value::Array(items));
                i = j;
                continue;
            } else if is_map {
                let mut inner: Table = IndexMap::new();
                for (jdx, c) in &children {
                    let child_line_no = jdx + line_offset;
                    let child_content = c.trim_start();
                    let Some(child_colon) = child_content.find(':') else {
                        return Err(ParseError::new(
                            child_line_no,
                            "expected `key: value` entry; missing colon",
                        ));
                    };
                    let child_key = &child_content[..child_colon];
                    let child_after_raw = &child_content[child_colon + 1..];
                    let child_after = child_after_raw.trim();
                    if child_key.is_empty() {
                        return Err(ParseError::new(child_line_no, "key must not be empty"));
                    }
                    if inner.contains_key(child_key) {
                        return Err(ParseError::new(
                            child_line_no,
                            format!("duplicate key `{child_key}`"),
                        ));
                    }
                    let value = parse_scalar(child_line_no, child_after)?;
                    inner.insert(child_key.to_string(), value);
                }
                table.insert(key.to_string(), Value::Map(inner));
                i = j;
                continue;
            } else {
                return Err(ParseError::new(
                    line_no,
                    "children must be uniformly a map (`key: value`) or a block sequence (`- item`)",
                ));
            }
        } else if after_colon.starts_with('|') {
            // Block scalar `|`. The marker must be the entire value;
            // we don't accept chomping indicators.
            if after_colon != "|" {
                return Err(ParseError::new(
                    line_no,
                    "block scalar marker must be `|` (no extra text after the colon)",
                ));
            }
            // Collect lines at indentation ≥ 2 spaces (Finding #7:
            // real Obsidian multi-line properties indent more than 2;
            // we strip the leading 2-space base and preserve any extra
            // indent in the resulting lines).
            let mut j = i + 1;
            let mut buf: Vec<String> = Vec::new();
            while j < lines.len() {
                let child_raw = lines[j];
                let child = child_raw.trim_end_matches('\r');
                if child.trim().is_empty() {
                    buf.push(String::new());
                    j += 1;
                    continue;
                }
                let leading = leading_spaces(child);
                match leading {
                    0 => break,
                    1 => {
                        return Err(ParseError::new(
                            j + line_offset,
                            "invalid block-scalar indentation: expected at least 2 spaces",
                        ));
                    }
                    _ => {
                        // Block-scalar base indent is 2 spaces (SPEC §3.5);
                        // anything deeper is preserved relative to that
                        // base. Byte-index 2 is always a char boundary
                        // because the two preceding chars are ASCII
                        // spaces.
                        buf.push(child[2..].to_string());
                        j += 1;
                    }
                }
            }
            // Trim trailing blank lines.
            while buf.last().is_some_and(|s| s.is_empty()) {
                buf.pop();
            }
            let joined = buf.join("\n");
            table.insert(key.to_string(), Value::Str(joined));
            i = j;
            continue;
        } else {
            // Scalar or flow sequence on this line.
            let value = parse_scalar(line_no, after_colon)?;
            table.insert(key.to_string(), value);
            i += 1;
        }
    }

    Ok(table)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IndentKind {
    Zero,
    Two,
    Other,
}

fn leading_spaces(line: &str) -> usize {
    let mut n = 0usize;
    for ch in line.chars() {
        if ch == ' ' {
            n += 1;
        } else {
            break;
        }
    }
    n
}

fn indent_kind_of(line: &str) -> IndentKind {
    match leading_spaces(line) {
        0 => IndentKind::Zero,
        2 => IndentKind::Two,
        _ => IndentKind::Other,
    }
}

/// Indentation at the front of a line. 0/2 spaces map to
/// [`IndentKind::Zero`]/[`IndentKind::Two`]; any other count is
/// [`IndentKind::Other`].
fn indent_of(line: &str) -> IndentKind {
    indent_kind_of(line)
}

/// Reject bare scalars that contain characters SPEC §5 forbids.
///
/// Returns the `ParseError` describing what went wrong, or
/// `Ok(())` on success.
fn validate_bare_scalar(s: &str, line_no: usize) -> Result<(), ParseError> {
    if s.is_empty() {
        return Err(ParseError::new(line_no, "empty value"));
    }
    // Forbidden characters per SPEC §5. `:` is allowed in
    // scalar-internal positions (RFC3339 timestamps contain it) but
    // `: ` (colon-space) is the YAML key/value separator and is
    // rejected separately below.
    const FORBIDDEN: &[char] = &[
        '\'', '"', ',', '{', '}', '[', ']', '&', '*', '!', '|', '>', '%', '@', '`',
    ];
    for ch in FORBIDDEN {
        if s.contains(*ch) {
            return Err(ParseError::new(
                line_no,
                format!("forbidden character in bare scalar ({ch:?}); quote the value"),
            ));
        }
    }
    if s.contains(": ") {
        return Err(ParseError::new(
            line_no,
            "forbidden character in bare scalar (': '); quote the value",
        ));
    }
    // Unquoted `#` is always rejected (comments are forbidden).
    // Full-line `#` is already rejected earlier in `parse_block`.
    if s.contains('#') {
        return Err(ParseError::new(
            line_no,
            "forbidden `#` in bare scalar; quote the value",
        ));
    }
    // Control characters (incl. newlines, which should not appear
    // here because the line was split by `\n`, but be defensive).
    for ch in s.chars() {
        if ch.is_control() {
            return Err(ParseError::new(
                line_no,
                format!("control character in bare scalar ({ch:?}); quote the value"),
            ));
        }
    }
    Ok(())
}

fn parse_scalar(line_no: usize, raw: &str) -> Result<Value, ParseError> {
    // `raw` has already been trimmed by the caller.
    if raw.is_empty() {
        return Err(ParseError::new(line_no, "empty value"));
    }
    // Booleans.
    if raw == "true" {
        return Ok(Value::Bool(true));
    }
    if raw == "false" {
        return Ok(Value::Bool(false));
    }
    // Quoted string.
    if let Some(inner) = strip_quotes(raw) {
        if inner.contains('\n') {
            return Err(ParseError::new(
                line_no,
                "quoted scalars must not span multiple lines",
            ));
        }
        return Ok(Value::Str(inner.to_string()));
    }
    // Flow sequence: must be single-line.
    if raw.starts_with('[') {
        if !raw.ends_with(']') {
            return Err(ParseError::new(
                line_no,
                "flow sequence must be closed on the same line",
            ));
        }
        let inner = &raw[1..raw.len() - 1];
        if inner.contains('\n') {
            return Err(ParseError::new(
                line_no,
                "multi-line flow collections are not allowed",
            ));
        }
        // Quote-aware split (Finding #5).
        let parts = split_flow_seq(inner).map_err(|e| ParseError::new(line_no, e))?;
        let mut items: Vec<String> = Vec::new();
        for raw_item in parts {
            let item = raw_item.trim();
            if item.is_empty() {
                return Err(ParseError::new(
                    line_no,
                    "flow sequence item must not be empty",
                ));
            }
            // Quoted items are exempt from bare-scalar validation
            // (Finding #3 / #6, round 2). Only validate when bare.
            let stored = match strip_quotes(item) {
                Some(inner) => inner.to_string(),
                None => {
                    validate_bare_scalar(item, line_no)?;
                    item.to_string()
                }
            };
            items.push(stored);
        }
        return Ok(Value::Array(items));
    }
    // Bare scalar — reject forbidden characters per SPEC §5.
    validate_bare_scalar(raw, line_no)?;
    Ok(Value::Str(raw.to_string()))
}

/// Split a flow-sequence inner by `,`, respecting single and double
/// quotes (Finding #5). Returns an error if quotes are unbalanced.
fn split_flow_seq(inner: &str) -> Result<Vec<String>, String> {
    let mut parts: Vec<String> = Vec::new();
    let mut buf = String::new();
    let mut quote: Option<char> = None;
    for ch in inner.chars() {
        match quote {
            Some(q) => {
                buf.push(ch);
                if ch == q {
                    quote = None;
                }
            }
            None => {
                if ch == '"' || ch == '\'' {
                    quote = Some(ch);
                    buf.push(ch);
                } else if ch == ',' {
                    parts.push(std::mem::take(&mut buf));
                } else {
                    buf.push(ch);
                }
            }
        }
    }
    if quote.is_some() {
        return Err("unbalanced quotes in flow sequence".into());
    }
    parts.push(buf);
    Ok(parts)
}

fn strip_quotes(s: &str) -> Option<&str> {
    if s.len() >= 2 {
        let bytes = s.as_bytes();
        let first = bytes[0];
        let last = bytes[s.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return Some(&s[1..s.len() - 1]);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- Brief-mandated tests (verbatim) ----

    #[test]
    fn parses_flat_and_nested() {
        let md = "---\nid: abc\ncreated: 2026-07-28T10:15:03+09:00\nfavorite: false\noxios:\n  author: agent\n  needs_review: true\ntags: [a, b]\n---\nbody";
        let p = parse(md, NoteFormat::Markdown).unwrap();
        let Parsed::Memo { table, body } = p else {
            panic!("memo")
        };
        assert_eq!(table["id"], Value::Str("abc".into()));
        assert_eq!(
            table["created"],
            Value::Str("2026-07-28T10:15:03+09:00".into())
        ); // schema layer validates RFC3339
        assert_eq!(table["favorite"], Value::Bool(false));
        assert_eq!(table["tags"], Value::Array(vec!["a".into(), "b".into()]));
        let Value::Map(ox) = &table["oxios"] else {
            panic!()
        };
        assert_eq!(ox["author"], Value::Str("agent".into()));
        assert_eq!(body, "body");
    }

    #[test]
    fn parses_obsidian_shapes() {
        // block sequences (Obsidian list properties), block scalars (multiline text),
        // fractional-second timestamps, floats and dates as strings
        let md = "---\ntags:\n  - projects\n  - work\nnotes: |\n  line one\n  line two\nwhen: 2026-08-20T13:40:00.000Z\nday: 2026-08-20\nweight: 3.5\n---\nb";
        let p = parse(md, NoteFormat::Markdown).unwrap();
        let Parsed::Memo { table, .. } = p else {
            panic!()
        };
        assert_eq!(
            table["tags"],
            Value::Array(vec!["projects".into(), "work".into()])
        );
        assert_eq!(table["notes"], Value::Str("line one\nline two".into()));
        assert_eq!(table["when"], Value::Str("2026-08-20T13:40:00.000Z".into()));
        assert_eq!(table["day"], Value::Str("2026-08-20".into()));
        assert_eq!(table["weight"], Value::Str("3.5".into()));
    }

    #[test]
    fn edge_policies() {
        assert!(parse("---\nid: a\nid: b\n---\nx", NoteFormat::Markdown).is_err()); // duplicate key
        assert!(parse("---\nx: has # hash\n---\nb", NoteFormat::Markdown).is_err()); // unquoted #
        let crlf = "---\r\nid: a\r\n---\r\nb";
        assert!(matches!(
            parse(crlf, NoteFormat::Markdown).unwrap(),
            Parsed::Memo { .. }
        )); // CRLF tolerated
        assert!(parse("\u{feff}---\nid: a\n---\nb", NoteFormat::Markdown).is_err()); // BOM ⇒ error, not BodyOnly
        assert!(parse("---\nkey:\n---\nb", NoteFormat::Markdown).is_err()); // empty value
        let err = parse("---\nid: a\n", NoteFormat::Markdown).unwrap_err(); // unclosed fence
        assert!(err.reason.contains("horizontal rule")); // actionable guidance
    }

    #[test]
    fn body_only_when_no_fence() {
        assert!(matches!(
            parse("just text", NoteFormat::Markdown).unwrap(),
            Parsed::BodyOnly { .. }
        ));
    }

    #[test]
    fn html_comment_wrapped() {
        let html = "<!--\n---\nid: abc\n---\n-->\n<p>hi</p>";
        let p = parse(html, NoteFormat::Html).unwrap();
        assert!(matches!(p, Parsed::Memo { .. }));
    }

    #[test]
    fn rejects_subset_violations() {
        for bad in [
            "---\nx: &a 1\n---\nb",     // anchor
            "---\nx: *a\n---\nb",       // alias
            "---\nx: !tag 1\n---\nb",   // tag
            "---\nx: 1\ny\n---\nb",     // no colon
            "---\nx: [a,\n b]\n---\nb", // multi-line flow collection
        ] {
            assert!(
                parse(bad, NoteFormat::Markdown).is_err(),
                "should reject: {bad:?}"
            );
        }
    }

    #[test]
    fn rejects_unclosed_fence() {
        assert!(parse("---\nid: a\n", NoteFormat::Markdown).is_err());
    }

    #[test]
    fn rejects_depth_three() {
        assert!(parse("---\na:\n  b:\n    c: 1\n---\nx", NoteFormat::Markdown).is_err());
    }

    // ---- Reviewer-finding covering tests ----

    // Finding #1: `title: "a # b"` must be accepted (quoted scalar).
    #[test]
    fn finding1_quoted_hash_is_allowed() {
        let md = "---\ntitle: \"a # b\"\n---\nbody";
        let p = parse(md, NoteFormat::Markdown).unwrap();
        let Parsed::Memo { table, .. } = p else {
            panic!("memo")
        };
        assert_eq!(table["title"], Value::Str("a # b".into()));
    }

    // Finding #1 follow-up: pre-check parity between depth 0 and
    // nested maps. Both must accept the same quoted form.
    #[test]
    fn finding1_quoted_hash_in_nested_map() {
        let md = "---\noxios:\n  note: \"looks # like # comment\"\n---\nbody";
        let p = parse(md, NoteFormat::Markdown).unwrap();
        let Parsed::Memo { table, .. } = p else {
            panic!()
        };
        let Value::Map(ox) = &table["oxios"] else {
            panic!()
        };
        assert_eq!(ox["note"], Value::Str("looks # like # comment".into()));
    }

    // Finding #2: HTML error lines must point at the right line.
    #[test]
    fn finding2_html_error_line_offsets() {
        // The malformed entry sits on original line 4 (<!-- + --- + entry).
        let html = "<!--\n---\nx: a\n  bad: !tag 1\n---\n-->\nbody";
        let err = parse(html, NoteFormat::Html).unwrap_err();
        assert_eq!(err.line, 4, "HTML error must point at the offending line");
    }

    // Finding #3: forbidden bare-scalar characters.
    #[test]
    fn finding3_unterminated_quote_is_error() {
        // `x: "abc` is unterminated; must be rejected, not silently
        // turned into Str("\"abc").
        let md = "---\nx: \"abc\n---\nbody";
        assert!(parse(md, NoteFormat::Markdown).is_err());
    }

    #[test]
    fn finding3_comma_in_bare_scalar_is_error() {
        // `x: a, b` is a bare scalar containing a comma — rejected.
        let md = "---\nx: a, b\n---\nbody";
        assert!(parse(md, NoteFormat::Markdown).is_err());
    }

    #[test]
    fn finding3_single_quote_in_bare_scalar_is_error() {
        let md = "---\nx: it's fine\n---\nbody";
        assert!(parse(md, NoteFormat::Markdown).is_err());
    }

    // Finding #4: full-line comment rejected.
    #[test]
    fn finding4_full_line_comment_rejected() {
        let md = "---\n# TODO: fix\n---\nbody";
        let err = parse(md, NoteFormat::Markdown).unwrap_err();
        assert!(err.reason.contains("comments"));
    }

    // Finding #5: quote-aware flow-sequence split.
    #[test]
    fn finding5_flow_seq_quote_aware() {
        let md = "---\ntags: [a, \"b, c\", d]\n---\nbody";
        let p = parse(md, NoteFormat::Markdown).unwrap();
        let Parsed::Memo { table, .. } = p else {
            panic!()
        };
        assert_eq!(
            table["tags"],
            Value::Array(vec!["a".into(), "b, c".into(), "d".into()])
        );
    }

    #[test]
    fn finding5_flow_seq_unbalanced_quote_is_error() {
        let md = "---\ntags: [a, \"b, c, d]\n---\nbody";
        assert!(parse(md, NoteFormat::Markdown).is_err());
    }

    // Finding #6: block-seq item forbidden chars.
    #[test]
    fn finding6_block_seq_item_forbidden_chars() {
        // `- a: b` is a bare scalar containing `:` (a forbidden char
        // per SPEC §5: `: `). Must be rejected.
        let md = "---\ntags:\n  - a: b\n---\nbody";
        assert!(parse(md, NoteFormat::Markdown).is_err());
    }

    // Finding #7: block-scalar deeper indentation accepted.
    #[test]
    fn finding7_block_scalar_deeper_indent_accepted() {
        // 6-space-indented lines under `notes: |` keep 4 spaces of
        // content indent (the 2-space base is stripped; anything
        // beyond is preserved).
        let md = "---\nnotes: |\n      deeply indented\n      still inside\n---\nbody";
        let p = parse(md, NoteFormat::Markdown).unwrap();
        let Parsed::Memo { table, .. } = p else {
            panic!()
        };
        assert_eq!(
            table["notes"],
            Value::Str("    deeply indented\n    still inside".into())
        );
    }

    // Finding #8: fence matches even with trailing whitespace.
    #[test]
    fn finding8_fence_with_trailing_space() {
        // Both open and close have a trailing space.
        let md = "---\nid: a\n--- \nbody";
        let p = parse(md, NoteFormat::Markdown).unwrap();
        assert!(matches!(p, Parsed::Memo { .. }));
    }

    // Finding #9: BodyOnly returns the original input verbatim
    // (including CRLF).
    #[test]
    fn finding9_body_only_preserves_original() {
        let crlf = "just\r\ntext\r\nhere";
        let p = parse(crlf, NoteFormat::Markdown).unwrap();
        let Parsed::BodyOnly { body } = p else {
            panic!()
        };
        assert_eq!(
            body, crlf,
            "BodyOnly must return the original input verbatim"
        );
    }

    // Finding #10: trailing whitespace in scalar doesn't break bool.
    #[test]
    fn finding10_trailing_whitespace_bool() {
        let md = "---\nfavorite: true \n---\nbody";
        let p = parse(md, NoteFormat::Markdown).unwrap();
        let Parsed::Memo { table, .. } = p else {
            panic!()
        };
        assert_eq!(table["favorite"], Value::Bool(true));
    }

    #[test]
    fn finding10_trailing_whitespace_string() {
        let md = "---\nid: abc \n---\nbody";
        let p = parse(md, NoteFormat::Markdown).unwrap();
        let Parsed::Memo { table, .. } = p else {
            panic!()
        };
        assert_eq!(table["id"], Value::Str("abc".into()));
    }

    // ---- Round-2 covering tests ----

    // Round-2 Finding #1: HTML BodyOnly returns the original verbatim.
    #[test]
    fn r2_finding1_html_body_only_preserves_crlf() {
        let html = "<!-- not a fence -->\r\njust\r\ntext";
        let p = parse(html, NoteFormat::Html).unwrap();
        let Parsed::BodyOnly { body } = p else {
            panic!()
        };
        assert_eq!(body, html, "HTML BodyOnly must return original verbatim");
    }

    // Round-2 Finding #3: quoted block-seq items are accepted.
    #[test]
    fn r2_finding3_quoted_block_seq_item_accepted() {
        let md = "---\ntags:\n  - \"b, c\"\n  - \"hello\"\n---\nbody";
        let p = parse(md, NoteFormat::Markdown).unwrap();
        let Parsed::Memo { table, .. } = p else {
            panic!()
        };
        assert_eq!(
            table["tags"],
            Value::Array(vec!["b, c".into(), "hello".into()])
        );
    }

    // Round-2 Finding #4: trailing whitespace on block-seq item is
    // trimmed; whitespace-only item is an error.
    #[test]
    fn r2_finding4_block_seq_item_trimmed() {
        let md = "---\ntags:\n  - projects \n  - work\n---\nbody";
        let p = parse(md, NoteFormat::Markdown).unwrap();
        let Parsed::Memo { table, .. } = p else {
            panic!()
        };
        assert_eq!(
            table["tags"],
            Value::Array(vec!["projects".into(), "work".into()])
        );
    }

    #[test]
    fn r2_finding4_whitespace_only_block_seq_item_is_error() {
        let md = "---\ntags:\n  -   \n---\nbody";
        assert!(parse(md, NoteFormat::Markdown).is_err());
    }

    // Round-2 Finding #5: Memo body keeps original line endings.
    #[test]
    fn r2_finding5_memo_body_preserves_crlf() {
        // Body is sliced from the original input after the closing
        // fence; CRLF survives.
        let crlf = "---\r\nid: a\r\n---\r\nline1\r\nline2";
        let p = parse(crlf, NoteFormat::Markdown).unwrap();
        let Parsed::Memo { body, .. } = p else {
            panic!()
        };
        assert_eq!(body, "line1\r\nline2");
        assert!(body.contains("\r\n"));
    }

    // Round-2 Finding #6: flow-seq bare items still validate.
    #[test]
    fn r2_finding6_flow_seq_bare_item_with_forbidden_char() {
        // `a: b` is forbidden (": ") inside a bare flow-seq item.
        let md = "---\ntags: [a: b]\n---\nbody";
        assert!(parse(md, NoteFormat::Markdown).is_err());
    }

    // Round-2 Finding #6 (positive): quoted flow-seq items with
    // commas are accepted.
    #[test]
    fn r2_finding6_flow_seq_quoted_item_with_comma() {
        let md = "---\ntags: [a, \"b, c\", d]\n---\nbody";
        let p = parse(md, NoteFormat::Markdown).unwrap();
        let Parsed::Memo { table, .. } = p else {
            panic!()
        };
        assert_eq!(
            table["tags"],
            Value::Array(vec!["a".into(), "b, c".into(), "d".into()])
        );
    }

    // Round-2 Finding #7: nested sequence marker rejected.
    #[test]
    fn r2_finding7_nested_sequence_marker_rejected() {
        // `- - a` should not silently yield "a".
        let md = "---\ntags:\n  - - a\n---\nbody";
        assert!(parse(md, NoteFormat::Markdown).is_err());
    }

    // ---- Round-3 covering tests ----

    // Round-3 Finding #1: 1-space block-scalar line errors.
    #[test]
    fn r3_finding1_block_scalar_one_space_is_error() {
        let md = "---\nnotes: |\n ab\n---\nbody";
        let err = parse(md, NoteFormat::Markdown).unwrap_err();
        assert!(
            err.reason.contains("at least 2 spaces"),
            "reason was: {}",
            err.reason
        );
    }

    // Round-3 Finding #1: multibyte boundary case must not panic.
    #[test]
    fn r3_finding1_block_scalar_multibyte_one_space_is_error() {
        // 1 ASCII space + multibyte char: a naive child[2..] slice
        // would land inside the multibyte sequence. The guard rejects
        // the line cleanly.
        let md = "---\nnotes: |\n \u{00e1}\n---\nbody";
        let err = parse(md, NoteFormat::Markdown).unwrap_err();
        assert!(
            err.reason.contains("at least 2 spaces"),
            "reason was: {}",
            err.reason
        );
    }

    // Round-3 Finding #2: `- -3.5` is a legal bare value, not a
    // nested sequence marker.
    #[test]
    fn r3_finding2_dash_dash_number_is_not_nested_seq() {
        let md = "---\nweights:\n  - -3.5\n  - 0\n---\nbody";
        let p = parse(md, NoteFormat::Markdown).unwrap();
        let Parsed::Memo { table, .. } = p else {
            panic!()
        };
        assert_eq!(
            table["weights"],
            Value::Array(vec!["-3.5".into(), "0".into()])
        );
    }

    // Round-3 Finding #2: `- - a` (with space) is still rejected.
    #[test]
    fn r3_finding2_dash_space_a_still_rejected() {
        let md = "---\ntags:\n  - - a\n---\nbody";
        assert!(parse(md, NoteFormat::Markdown).is_err());
    }
}
