//! Canonical emitter for oxi ecosystem frontmatter.
//!
//! The emitter is the canonical counterpart of the parser: given a
//! [`Table`] and a body, it produces a string in the on-disk format
//! described in `SPEC.md` (grammar v2). The order of entries is
//! deterministic so that two semantically equal tables serialize to
//! byte-equal strings, and round-tripping through [`crate::parse`]
//! preserves every observable bit of metadata.
//!
//! ## Canonical order
//!
//! 1. The five core schema keys in fixed order:
//!    `id, created, updated, favorite, deleted`.
//!    Each is emitted if and only if it is present in the table;
//!    `id` and `created` are required to be present in practice but
//!    the emitter does not enforce that — `write_document` does.
//! 2. Any remaining **scalar / array** keys (non-`Map` values) in
//!    the table's own insertion order, skipping the five core keys
//!    that were already emitted. Insertion order is preserved by
//!    [`crate::Table`] (an `IndexMap`), so round-tripping preserves
//!    the order the parser saw.
//! 3. Any remaining **`Map`** sub-tables, sorted by key (Unicode
//!    lexicographic byte order). This is the only place the emitter
//!    diverges from "preserve observed order" — Map sub-tables are
//!    the extension surface (e.g. `oxios:`, `custom:`), and a stable
//!    ordering keeps diffs and NoOp checks meaningful.
//!
//! ## Quoting
//!
//! [`Value::Str`] is emitted bare unless it would round-trip
//! incorrectly. The rules are spelled out in `needs_quotes_str`.
//! [`Value::Bool`] is emitted as `true` / `false`. Timestamps,
//! integers, floats, and dates are kept as [`Value::Str`] (schema
//! validation is a separate concern — see Task 11), but the emitter
//! must **not** quote things the parser would re-parse as the same
//! string. RFC3339 timestamps and pure integers therefore go out
//! bare.
//!
//! [`Value::Array`] uses the flow form `[a, b]`. Block-sequence form
//! is **not** emitted; if the user wants that style they can use a
//! different tool, but on re-read we'll produce flow form. (We are
//! the only writer in the ecosystem.)
//!
//! Multi-line strings emit the literal block-scalar form `|`, one
//! line at a time, indented by two spaces.

use crate::parse::{NoteFormat, Table, Value};

/// Emit a canonical string for the given frontmatter table + body.
///
/// The output uses LF line endings. The transport wrapping
/// (`---\n...\n---\n` for Markdown, `<!--\n---\n...\n---\n-->\n`
/// for HTML) is added here.
///
/// The body is appended verbatim after the closing fence; no
/// normalization is applied.
pub fn emit(table: &Table, body: &str, fmt: NoteFormat) -> String {
    let mut out = String::new();
    let (open_prefix, open_fence, close_fence, close_suffix) = match fmt {
        NoteFormat::Markdown => (None, "---\n", "---\n", None),
        NoteFormat::Html => (Some("<!--\n"), "---\n", "---\n", Some("-->\n")),
    };
    if let Some(p) = open_prefix {
        out.push_str(p);
    }
    out.push_str(open_fence);

    emit_entries(&mut out, table, "");

    out.push_str(close_fence);
    if let Some(s) = close_suffix {
        out.push_str(s);
    }
    out.push_str(body);
    out
}

/// Core schema keys in canonical order. Any of these that is present
/// in the table is emitted first, in this order, before the rest of
/// the table is walked.
const CORE_KEYS: &[&str] = &["id", "created", "updated", "favorite", "deleted"];

/// Emit the body of the frontmatter block (everything between the
/// opening and closing fences). `prefix` is a string of indentation
/// spaces prepended to every non-empty line we write — used at
/// depth 1 for `Map` sub-tables. (`write_document` builds depth-0
/// flat tables, so for the typical path `prefix` is `""`.)
fn emit_entries(out: &mut String, table: &Table, prefix: &str) {
    let mut emitted: std::collections::HashSet<&str> = std::collections::HashSet::new();

    // 1) Core keys, fixed order.
    for &k in CORE_KEYS {
        if let Some(v) = table.get(k) {
            emit_entry(out, k, v, prefix);
            emitted.insert(k);
        }
    }

    // 2) Non-Map extras in insertion order, skipping core + already-emitted.
    let mut extras_scalar: Vec<(&str, &Value)> = Vec::new();
    let mut extras_map: Vec<(&str, &Table)> = Vec::new();
    for (k, v) in table {
        if emitted.contains(k.as_str()) {
            continue;
        }
        match v {
            Value::Map(m) => extras_map.push((k.as_str(), m)),
            _ => extras_scalar.push((k.as_str(), v)),
        }
    }
    // Stable order for scalar/array keys matches insertion order.
    for (k, v) in extras_scalar {
        emit_entry(out, k, v, prefix);
    }

    // 3) Map sub-tables, sorted by key (byte order, deterministic).
    extras_map.sort_by(|a, b| a.0.cmp(b.0));
    for (k, sub) in extras_map {
        // Emit the level-0 key on its own line.
        out.push_str(prefix);
        out.push_str(k);
        out.push_str(":\n");
        emit_entries(out, sub, "  ");
    }
}

/// Emit one key: value line at the given indent prefix. Multiline
/// block-scalar strings emit multiple lines.
fn emit_entry(out: &mut String, key: &str, value: &Value, prefix: &str) {
    match value {
        Value::Bool(b) => {
            out.push_str(prefix);
            out.push_str(key);
            out.push_str(": ");
            out.push_str(if *b { "true" } else { "false" });
            out.push('\n');
        }
        Value::Str(s) => {
            // Multi-line: block scalar `|` form.
            if s.contains('\n') {
                out.push_str(prefix);
                out.push_str(key);
                out.push_str(": |\n");
                for line in s.split('\n') {
                    out.push_str(prefix);
                    out.push_str("  ");
                    out.push_str(line);
                    out.push('\n');
                }
            } else {
                out.push_str(prefix);
                out.push_str(key);
                out.push_str(": ");
                let s_quoted = needs_quotes_str(s);
                if s_quoted {
                    out.push('"');
                    out.push_str(s);
                    out.push('"');
                } else {
                    out.push_str(s);
                }
                out.push('\n');
            }
        }
        Value::Array(items) => {
            out.push_str(prefix);
            out.push_str(key);
            out.push_str(": [");
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                if needs_quotes_str(item) {
                    out.push('"');
                    out.push_str(item);
                    out.push('"');
                } else {
                    out.push_str(item);
                }
            }
            out.push_str("]\n");
        }
        Value::Map(_) => {
            // Handled by emit_entries; we shouldn't reach here.
            // Defensive: emit an empty map so we don't lose data.
            out.push_str(prefix);
            out.push_str(key);
            out.push_str(":\n");
        }
    }
}

/// Decide whether a `Value::Str` payload must be wrapped in double
/// quotes on emit. The rule is the parser's forbidden-character list
/// (SPEC §5) plus the only token that would re-parse as a *different*
/// [`Value`] variant: `true` / `false` (the parser maps those to
/// [`Value::Bool`]; everything else — integers, dates, floats,
/// RFC3339 timestamps — stays as `Value::Str`, so a bare round-trip
/// is faithful). Quoting an integer or timestamp would silently
/// change the on-disk representation, which is exactly what the
/// canonical-roundtrip test rejects.
fn needs_quotes_str(s: &str) -> bool {
    if s.is_empty() {
        return true;
    }
    if s != s.trim() {
        return true;
    }
    if s.contains('\t') {
        return true;
    }
    // Reject `: ` (colon-space) — that is the YAML key/value separator
    // and would split the value across the fence.
    if s.contains(": ") {
        return true;
    }
    for c in s.chars() {
        if matches!(
            c,
            '#' | '\''
                | '"'
                | ','
                | '['
                | ']'
                | '{'
                | '}'
                | '&'
                | '*'
                | '!'
                | '|'
                | '>'
                | '%'
                | '@'
                | '`'
        ) {
            return true;
        }
        if c.is_control() {
            return true;
        }
    }
    // The parser maps ONLY lowercase `true` / `false` to
    // [`Value::Bool`]. Uppercase variants are kept as `Value::Str`,
    // so emitting them bare is faithful.
    if s == "true" || s == "false" {
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse::{Parsed, Value, parse};

    #[test]
    fn canonical_order_and_roundtrip() {
        let src = "---\nzz: 1\nid: abc\nupdated: 2026-08-20T13:40:00+09:00\noxios:\n  author: agent\n---\nb";
        let Parsed::Memo { table, body } = parse(src, NoteFormat::Markdown).unwrap() else {
            panic!("expected Memo");
        };
        let out = emit(&table, &body, NoteFormat::Markdown);
        assert!(
            out.starts_with(
                "---\nid: abc\nupdated: 2026-08-20T13:40:00+09:00\nzz: 1\noxios:\n  author: agent\n---\n"
            ),
            "actual: {out:?}"
        );
        // round-trip law: parse(emit(parse(x))) == parse(x)
        let Parsed::Memo {
            table: t2,
            body: b2,
        } = parse(&out, NoteFormat::Markdown).unwrap()
        else {
            panic!("expected Memo after emit");
        };
        assert_eq!(table, t2);
        assert_eq!(body, b2);
    }

    #[test]
    fn quotes_strings_that_would_misparse() {
        let mut t = Table::new();
        t.insert("k".into(), Value::Str("true".into()));
        let out = emit(&t, "b", NoteFormat::Markdown);
        assert!(out.contains("k: \"true\""), "actual: {out:?}");
    }

    #[test]
    fn emits_block_scalar_for_multiline_and_flow_for_arrays() {
        let mut t = Table::new();
        t.insert("notes".into(), Value::Str("l1\nl2".into()));
        t.insert("tags".into(), Value::Array(vec!["a".into(), "b".into()]));
        let out = emit(&t, "b", NoteFormat::Markdown);
        assert!(out.contains("notes: |\n  l1\n  l2\n"), "actual: {out:?}");
        assert!(out.contains("tags: [a, b]"), "actual: {out:?}");
        // round-trip: parse(emit(x)) == x
        let Parsed::Memo { table: t2, .. } = parse(&out, NoteFormat::Markdown).unwrap() else {
            panic!("expected Memo");
        };
        assert_eq!(t, t2);
    }

    /// Finding 1: a `Str` containing a literal `"` must round-trip
    /// through `parse(emit(...))` without corruption. We use a
    /// single-quoted source scalar so the parser sees the raw `"`
    /// characters in the value.
    #[test]
    fn roundtrips_double_quote_in_value() {
        let src = "---\nk: 'He said \"hi\"'\n---\nb";
        let Parsed::Memo { table, body } = parse(src, NoteFormat::Markdown).unwrap() else {
            panic!("expected Memo");
        };
        assert_eq!(table["k"], Value::Str("He said \"hi\"".into()));
        let out = emit(&table, &body, NoteFormat::Markdown);
        let Parsed::Memo {
            table: t2,
            body: b2,
        } = parse(&out, NoteFormat::Markdown).unwrap()
        else {
            panic!("expected Memo after emit");
        };
        assert_eq!(table, t2);
        assert_eq!(body, b2);
    }

    /// Finding 4: the parser only maps lowercase `true` / `false`
    /// to `Value::Bool`. Uppercase variants are kept as `Value::Str`,
    /// so emitting them bare preserves the round-trip.
    #[test]
    fn uppercase_bool_token_emits_bare() {
        let mut t = Table::new();
        t.insert("k".into(), Value::Str("True".into()));
        let out = emit(&t, "b", NoteFormat::Markdown);
        assert!(out.contains("\nk: True\n"), "actual: {out:?}");
    }
}
