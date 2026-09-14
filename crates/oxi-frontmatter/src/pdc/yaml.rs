//! Safe general-YAML 1.2 Core parsing for `pdc-document/2` envelopes and
//! `pdc-query/1` sources (PDC 2 §5, PDC-QUERY-1.0 §3.1).
//!
//! The accepted subset is JSON-compatible YAML: a single document whose
//! root is a mapping, nonempty string keys without duplicates, and null /
//! Boolean / finite-number / string / sequence / mapping values. Anchors,
//! aliases, tags, complex keys, multi-document streams, and tabs in
//! indentation are forbidden; nesting is capped at [`MAX_YAML_DEPTH`]
//! combined levels and the whole document at [`MAX_YAML_NODES`] nodes.
//! Both caps map to `document_too_complex` in the document plane.
//!
//! The walker runs over yaml-rust2's low-level event stream so forbidden
//! presentations are rejected even when the value would resolve
//! harmlessly. The legacy constrained grammar in [`crate::parse`] is
//! untouched: it keeps governing v1 envelopes and all non-PDC Oximemo
//! frontmatter.
//!
//! Finite numeric scalars retain their semantic type and source spelling as
//! [`Yaml::Number`]. Date-like plain scalars remain strings, as required by
//! PDC 2. Byte preservation is a property of the source slice, not of this
//! projection.

use yaml_rust2::parser::{Event, Parser, Tag};
use yaml_rust2::scanner::TScalarStyle;

/// Maximum combined mapping/sequence nesting depth (PDC 2 §5).
pub const MAX_YAML_DEPTH: usize = 32;

/// Maximum number of nodes — scalars plus containers — in one YAML
/// document (PDC 2 §5).
pub const MAX_YAML_NODES: usize = 10_000;

/// A value from a safe general-YAML document.
///
/// Order-preserving: mapping entries keep source order so user-property
/// order survives projections.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Yaml {
    /// `~`, `null`, or an empty scalar.
    Null,
    /// `true` / `false` in any Core spelling.
    Bool(bool),
    /// A finite YAML Core number, preserving its source spelling.
    Number(String),
    /// Any other non-numeric scalar, quoted or plain, with its resolved
    /// text (quoted numerics and date-like plain scalars stay here).
    Str(String),
    /// A sequence of values.
    Seq(Vec<Yaml>),
    /// A mapping of string keys to values, in source order.
    Map(Vec<(String, Yaml)>),
}

impl Yaml {
    /// Mapping lookup by key.
    pub fn get(&self, key: &str) -> Option<&Yaml> {
        match self {
            Yaml::Map(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// String content of a [`Yaml::Str`].
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Yaml::Str(s) => Some(s),
            _ => None,
        }
    }

    /// Boolean content of a [`Yaml::Bool`].
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Yaml::Bool(b) => Some(*b),
            _ => None,
        }
    }

    /// Slice of a [`Yaml::Seq`].
    pub fn as_seq(&self) -> Option<&[Yaml]> {
        match self {
            Yaml::Seq(items) => Some(items),
            _ => None,
        }
    }

    /// `true` for [`Yaml::Map`].
    pub fn is_map(&self) -> bool {
        matches!(self, Yaml::Map(_))
    }
}

/// Which plane-level diagnostic a YAML failure maps to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum YamlErrorKind {
    /// Forbidden or malformed YAML: `invalid_envelope` for documents,
    /// `invalid_query` for queries.
    Malformed,
    /// Depth or node-count cap exceeded: `document_too_complex` for
    /// documents, `invalid_query` for queries.
    TooComplex,
}

/// A safe-YAML rejection with an optional source line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct YamlError {
    /// Failure class; the caller maps it onto its plane's diagnostic.
    pub kind: YamlErrorKind,
    /// 1-indexed source line when the event stream carried a marker.
    pub line: Option<usize>,
    /// Human-readable reason.
    pub reason: String,
}

impl YamlError {
    fn malformed(line: Option<usize>, reason: impl Into<String>) -> Self {
        Self {
            kind: YamlErrorKind::Malformed,
            line,
            reason: reason.into(),
        }
    }

    #[allow(dead_code)] // reserved for direct constructor use in callers
    fn too_complex(line: Option<usize>, reason: impl Into<String>) -> Self {
        Self {
            kind: YamlErrorKind::TooComplex,
            line,
            reason: reason.into(),
        }
    }
}

/// Parse one safe general-YAML document and return its root value.
///
/// The root MUST be a mapping. Every forbidden presentation — anchors,
/// aliases, tags, complex or non-string keys, duplicate keys, multi-doc
/// streams, tabs, cap overruns — is a hard error; nothing is silently
/// resolved away.
pub fn parse_document(text: &str) -> Result<Yaml, YamlError> {
    let mut walker = Walker::default();
    let mut parser = Parser::new_from_str(text);
    loop {
        let (event, marker) = match parser.next_token() {
            Ok(pair) => pair,
            Err(e) => {
                return Err(YamlError::malformed(
                    Some(e.marker().line()),
                    format!("invalid YAML: {e}"),
                ));
            }
        };
        let is_end = matches!(event, Event::StreamEnd);
        walker.event(event).map_err(|(kind, reason)| YamlError {
            kind,
            line: Some(marker.line()),
            reason,
        })?;
        if is_end {
            break;
        }
    }
    walker.finish()
}

#[derive(Default)]
struct Walker {
    stack: Vec<Frame>,
    root: Option<Yaml>,
    depth: usize,
    nodes: usize,
    doc_started: bool,
}

enum Frame {
    Seq(Vec<Yaml>),
    Map {
        entries: Vec<(String, Yaml)>,
        seen: std::collections::HashSet<String>,
        pending_key: Option<String>,
    },
}

type Step = Result<(), (YamlErrorKind, String)>;

fn malformed(reason: impl Into<String>) -> (YamlErrorKind, String) {
    (YamlErrorKind::Malformed, reason.into())
}

fn too_complex(reason: impl Into<String>) -> (YamlErrorKind, String) {
    (YamlErrorKind::TooComplex, reason.into())
}

impl Walker {
    fn event(&mut self, event: Event) -> Step {
        match event {
            Event::StreamStart | Event::Nothing => Ok(()),
            Event::DocumentStart => {
                if self.doc_started {
                    return Err(malformed(
                        "multi-document streams are forbidden; exactly one YAML document is allowed",
                    ));
                }
                self.doc_started = true;
                Ok(())
            }
            Event::DocumentEnd | Event::StreamEnd => self.finalize_root(),
            Event::Alias(_) => Err(malformed(
                "aliases are forbidden; every value must be written out",
            )),
            Event::Scalar(text, style, anchor, tag) => {
                self.reject_presentation(anchor, tag)?;
                self.count_node()?;
                if self.key_position() {
                    let resolved = self.scalar(text.clone(), style)?;
                    let key = match resolved {
                        Yaml::Str(key) => key,
                        _ => {
                            return Err(malformed(format!(
                                "mapping keys must be nonempty strings, found `{text}`"
                            )));
                        }
                    };
                    if let Some(Frame::Map {
                        seen, pending_key, ..
                    }) = self.stack.last_mut()
                    {
                        if !seen.insert(key.clone()) {
                            return Err(malformed(format!("duplicate key `{key}`")));
                        }
                        *pending_key = Some(key);
                    }
                    return Ok(());
                }
                let value = self.scalar(text, style)?;
                self.attach(value)
            }
            Event::SequenceStart(anchor, tag) => {
                self.reject_presentation(anchor, tag)?;
                if self.key_position() {
                    return Err(malformed("sequences may not be mapping keys"));
                }
                self.count_node()?;
                self.enter_container()?;
                self.stack.push(Frame::Seq(Vec::new()));
                Ok(())
            }
            Event::MappingStart(anchor, tag) => {
                self.reject_presentation(anchor, tag)?;
                if self.key_position() {
                    return Err(malformed("mappings may not be mapping keys"));
                }
                self.count_node()?;
                self.enter_container()?;
                self.stack.push(Frame::Map {
                    entries: Vec::new(),
                    seen: std::collections::HashSet::new(),
                    pending_key: None,
                });
                Ok(())
            }
            Event::SequenceEnd => {
                let Frame::Seq(items) = self
                    .stack
                    .pop()
                    .ok_or_else(|| malformed("unbalanced YAML sequence end"))?
                else {
                    return Err(malformed("unbalanced YAML sequence end"));
                };
                self.depth -= 1;
                self.attach(Yaml::Seq(items))
            }
            Event::MappingEnd => {
                let Frame::Map { entries, .. } = self
                    .stack
                    .pop()
                    .ok_or_else(|| malformed("unbalanced YAML mapping end"))?
                else {
                    return Err(malformed("unbalanced YAML mapping end"));
                };
                self.depth -= 1;
                self.attach(Yaml::Map(entries))
            }
        }
    }

    fn reject_presentation(&self, anchor: usize, tag: Option<Tag>) -> Step {
        if anchor != 0 {
            return Err(malformed(
                "anchors are forbidden; every value must be written out",
            ));
        }
        if tag.is_some() {
            return Err(malformed(
                "explicit or custom tags are forbidden in safe general YAML",
            ));
        }
        Ok(())
    }

    fn count_node(&mut self) -> Step {
        self.nodes += 1;
        if self.nodes > MAX_YAML_NODES {
            return Err(too_complex(format!(
                "document exceeds the {MAX_YAML_NODES}-node limit"
            )));
        }
        Ok(())
    }

    fn enter_container(&mut self) -> Step {
        self.depth += 1;
        if self.depth > MAX_YAML_DEPTH {
            return Err(too_complex(format!(
                "nesting exceeds the {MAX_YAML_DEPTH}-level limit"
            )));
        }
        Ok(())
    }

    fn scalar(&self, text: String, style: TScalarStyle) -> Result<Yaml, (YamlErrorKind, String)> {
        if style == TScalarStyle::Plain {
            resolve_plain(&text).map_err(malformed)
        } else {
            // Single/double-quoted and block styles are always strings;
            // the scanner already processed escapes and indentation.
            Ok(Yaml::Str(text))
        }
    }

    fn attach(&mut self, value: Yaml) -> Step {
        match self.stack.last_mut() {
            None => {
                if self.root.is_some() {
                    return Err(malformed("document has more than one root node"));
                }
                self.root = Some(value);
            }
            Some(Frame::Seq(items)) => items.push(value),
            Some(Frame::Map {
                entries,
                pending_key,
                ..
            }) => match pending_key.take() {
                None => return Err(malformed("mapping value arrived without a string key")),
                Some(key) => entries.push((key, value)),
            },
        }
        Ok(())
    }

    /// `true` when the next scalar is a mapping key slot.
    fn key_position(&self) -> bool {
        matches!(
            self.stack.last(),
            Some(Frame::Map {
                pending_key: None,
                ..
            })
        )
    }

    fn finish(&mut self) -> Result<Yaml, YamlError> {
        if self.root.is_none() {
            self.finalize_root().map_err(|(kind, reason)| YamlError {
                kind,
                line: None,
                reason,
            })?;
        }
        match &self.root {
            Some(root @ Yaml::Map(_)) => Ok(root.clone()),
            Some(_) => Err(YamlError::malformed(
                None,
                "document root must be a mapping",
            )),
            None => Err(YamlError::malformed(None, "document is empty")),
        }
    }

    fn finalize_root(&mut self) -> Step {
        if self.root.is_some() {
            return Ok(());
        }
        match self.stack.pop() {
            None => Err(malformed("document contains no YAML node")),
            Some(Frame::Seq(items)) => {
                self.root = Some(Yaml::Seq(items));
                Ok(())
            }
            Some(Frame::Map { entries, .. }) => {
                self.root = Some(Yaml::Map(entries));
                Ok(())
            }
        }
    }
}

/// `true` when a plain scalar resolves to a Core-schema number
/// (`[-+]?[0-9]+`, octal, hex, or decimal float) — such scalars are not
/// valid mapping keys.
fn core_resolves_to_number(text: &str) -> bool {
    let body = text.strip_prefix(['-', '+']).unwrap_or(text);
    if let Some(hex) = body.strip_prefix("0x") {
        return numeric_digits(hex, |c| c.is_ascii_hexdigit());
    }
    if let Some(oct) = body.strip_prefix("0o") {
        return numeric_digits(oct, |c| ('0'..='7').contains(&c));
    }

    let mantissa = match body.find(['e', 'E']) {
        Some(index) if !body[index + 1..].contains(['e', 'E']) => {
            let exponent = body[index + 1..]
                .strip_prefix(['-', '+'])
                .unwrap_or(&body[index + 1..]);
            if !numeric_digits(exponent, |c| c.is_ascii_digit()) {
                return false;
            }
            &body[..index]
        }
        Some(_) => return false,
        None => body,
    };

    let mut parts = mantissa.split('.');
    let integer = parts.next().unwrap_or("");
    let fraction = parts.next();
    if parts.next().is_some() {
        return false;
    }
    let integer_ok = integer.is_empty() || numeric_digits(integer, |c| c.is_ascii_digit());
    let fraction_ok = fraction
        .map(|part| part.is_empty() || numeric_digits(part, |c| c.is_ascii_digit()))
        .unwrap_or(true);
    let has_digit = integer.chars().any(|c| c.is_ascii_digit())
        || fraction.is_some_and(|part| part.chars().any(|c| c.is_ascii_digit()));
    integer_ok && fraction_ok && has_digit
}

fn numeric_digits(text: &str, is_digit: impl Fn(char) -> bool) -> bool {
    let mut saw_digit = false;
    for ch in text.chars() {
        if ch == '_' {
            continue;
        }
        if !is_digit(ch) {
            return false;
        }
        saw_digit = true;
    }
    saw_digit
}

/// Resolve a plain scalar per the YAML 1.2 Core schema, restricted to the
/// JSON-compatible shapes the contract allows.
fn resolve_plain(text: &str) -> Result<Yaml, String> {
    match text {
        "" | "~" | "null" | "Null" | "NULL" => Ok(Yaml::Null),
        "true" | "True" | "TRUE" => Ok(Yaml::Bool(true)),
        "false" | "False" | "FALSE" => Ok(Yaml::Bool(false)),
        ".nan" | ".NaN" | ".NAN" | ".inf" | ".Inf" | ".INF" | "+.inf" | "+.Inf" | "+.INF"
        | "-.inf" | "-.Inf" | "-.INF" => Err(format!(
            "`{text}` resolves to a non-finite value, which is forbidden"
        )),
        _ if core_resolves_to_number(text) => Ok(Yaml::Number(text.to_owned())),
        _ => Ok(Yaml::Str(text.to_owned())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minimal_mapping_parses_with_order() {
        let doc = parse_document("title: First\ntags: [a, b]\n").unwrap();
        let Yaml::Map(entries) = &doc else {
            panic!("root must be a mapping");
        };
        assert_eq!(
            entries.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(),
            vec!["title", "tags"]
        );
        assert_eq!(doc.get("title").and_then(Yaml::as_str), Some("First"));
        assert_eq!(
            doc.get("tags").and_then(Yaml::as_seq).map(<[Yaml]>::len),
            Some(2)
        );
    }

    #[test]
    fn nested_maps_sequences_and_comments_pass() {
        let doc = parse_document(
            "# header comment\nx_app:\n  legacy_id: FDR-001\n  scores: [1, 2, 3]\nowner: null\nflag: true\nreading_time: 4\n",
        )
        .unwrap();
        let nested = doc.get("x_app").expect("nested map");
        assert_eq!(
            nested.get("legacy_id").and_then(Yaml::as_str),
            Some("FDR-001")
        );
        assert_eq!(
            nested
                .get("scores")
                .and_then(Yaml::as_seq)
                .map(<[Yaml]>::len),
            Some(3)
        );
        assert!(matches!(doc.get("owner"), Some(Yaml::Null)));
        assert_eq!(doc.get("flag").and_then(Yaml::as_bool), Some(true));
        assert!(matches!(doc.get("reading_time"), Some(Yaml::Number(value)) if value == "4"));
    }

    #[test]
    fn quoted_escapes_and_literal_blocks_are_strings() {
        let doc = parse_document(
            "a: \"x\\\"y\"\nb: |\n  line one\n  line two\nquoted_number: \"4\"\nscientific: 1.2e3\n",
        )
        .unwrap();
        assert_eq!(doc.get("a").and_then(Yaml::as_str), Some("x\"y"));
        assert!(
            doc.get("b")
                .and_then(Yaml::as_str)
                .unwrap()
                .contains("line two")
        );
        assert_eq!(doc.get("quoted_number").and_then(Yaml::as_str), Some("4"));
        assert!(matches!(doc.get("scientific"), Some(Yaml::Number(value)) if value == "1.2e3"));
    }

    #[test]
    fn forbidden_presentations_rejected() {
        for (text, needle) in [
            ("b: *x\n", "anchor"),
            ("a: &x 1\n", "anchors"),
            ("a: !!binary aGk=\n", "tags"),
            ("a: 1\na: 2\n", "duplicate key"),
            ("1: one\n", "keys must be"),
            ("3.14: pi\n", "keys must be"),
            ("0x1f: hex\n", "keys must be"),
            ("? [a, b]\n: c\n", "mapping keys"),
            ("a: .nan\n", "non-finite"),
            ("a: 1\n---\nb: 2\n", "multi-document"),
        ] {
            let err = parse_document(text).expect_err(text);
            assert_eq!(err.kind, YamlErrorKind::Malformed, "{text}: {}", err.reason);
            assert!(err.reason.contains(needle), "{text}: {}", err.reason);
        }
    }

    #[test]
    fn depth_and_node_caps_are_too_complex() {
        let mut deep = String::from("a:\n");
        for i in 1..33 {
            deep.push_str(&" ".repeat(2 * i));
            deep.push_str("b:\n");
        }
        let err = parse_document(&deep).expect_err("depth");
        assert_eq!(err.kind, YamlErrorKind::TooComplex);

        let mut many = String::from("list: [");
        for i in 0..10_001 {
            many.push_str(&format!("item{i:05},"));
        }
        many.push_str("]\n");
        let err = parse_document(&many).expect_err("nodes");
        assert_eq!(err.kind, YamlErrorKind::TooComplex);
    }

    #[test]
    fn tab_indentation_and_empty_documents_rejected() {
        let err = parse_document("a:\n\tb: 1\n").expect_err("tab");
        assert_eq!(err.kind, YamlErrorKind::Malformed);
        let err = parse_document("").expect_err("empty");
        assert_eq!(err.kind, YamlErrorKind::Malformed);
        let err = parse_document("- just\n- a sequence\n").expect_err("root type");
        assert_eq!(err.kind, YamlErrorKind::Malformed);
    }
}
