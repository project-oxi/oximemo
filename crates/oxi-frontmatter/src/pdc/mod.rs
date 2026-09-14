//! Portable Document Contract classification and guarded metadata writes.
//!
//! Implements both major document planes:
//!
//! - **`pdc-document/2`** (current, Markdown-first): canonical
//!   `pdc-markdown/1` under lowercase `.md` and `pdc-html/1` under the
//!   comment transport, over a safe general-YAML 1.2 Core envelope
//!   ([`yaml`]) with a read-only `pdc-query/1` gate for `.base` files
//!   ([`query`]).
//! - **`pdc-document/1`** (frozen legacy): `pdc-djot/1` and `pdc-html/1`
//!   over the crate's constrained-YAML grammar. v1 documents stay
//!   readable legacy classification ([`PdcDocument::legacy`]); they are
//!   never converted, rewritten, or re-emitted by this module.
//!
//! This is the Stage 0 slice of `docs/PDC-MIGRATION.md`: classification
//! with diagnostics, the corpus pins, and byte-preserving metadata
//! patches. Vault scanning and body rendering are later stages.
//!
//! The canonical external specification lives in the
//! `portable-document-contract` repository (commit `0ee51ea`, tag
//! `v2.0.0-draft.2`) and wins over this code; the vendored conformance
//! corpora under `tests/fixtures/` pin the revisions exercised here.

mod markdown;
pub mod query;
pub mod yaml;

pub use query::{QueryClassification, classify_query};
pub use yaml::{Yaml, YamlError};

use crate::parse::parse_block;
use crate::parse::{Table, Value};

/// Conformance corpus revision of the frozen legacy v1 corpus
/// (`tests/fixtures/pdc-corpus-r3`).
///
/// Every change to v1 classification behavior must land in the contract
/// repository first and bump this pin together with the vendored
/// fixtures.
pub const CORPUS_REVISION: u64 = 3;

/// Conformance format identifier of the Markdown-first v2 corpus
/// (`tests/fixtures/pdc-corpus-v2-r2`).
pub const CORPUS_V2_FORMAT: &str = "pdc-document-conformance/2";

/// Conformance corpus revision the v2 classifier is pinned to
/// (upstream commit `0ee51ea`, tag `v2.0.0-draft.2`).
pub const CORPUS_V2_REVISION: u64 = 2;

/// Maximum canonical document size in bytes, including transport and
/// body (PDC §4.1).
pub const MAX_DOCUMENT_BYTES: usize = 4 * 1024 * 1024;

/// Maximum simultaneously open block containers / open HTML elements
/// (PDC §4.2–4.3).
pub const MAX_TARGET_DEPTH: usize = 256;

/// UTF-8 byte-order mark; its presence is `invalid_transport`.
const BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

/// The file extension a PDC document was discovered under.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocumentExt {
    /// Legacy Djot document (`.djot`), readable under `pdc-document/1`.
    Djot,
    /// Canonical or legacy HTML document (`.html`).
    Html,
    /// Canonical Markdown document (`.md`, lowercase).
    Markdown,
}

/// Diagnosable outcome classes, named exactly as PDC §13 requires.
///
/// `missing_asset`, `asset_digest_mismatch`, `unsupported_lossless_edit`,
/// and `duplicate_document_id` are omitted here: they need asset
/// resolution, edit tooling, or multi-document sets, none of which are
/// visible to single-file classification. Set-level duplicate IDs are
/// detected by callers via [`PdcDocument::id`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiagnosticKind {
    /// Transport-level malformation (BOM, missing/mangled envelope).
    InvalidTransport,
    /// Envelope failed the constrained grammar or semantic validation.
    InvalidEnvelope,
    /// `format` is not a recognized major version for this transport.
    UnsupportedDocumentVersion,
    /// `body` names an unknown version of a known profile.
    UnsupportedBodyVersion,
    /// `id` is not a canonical lowercase hyphenated UUID.
    InvalidDocumentId,
    /// Two targets share one `b-<uuid>` within a single document.
    DuplicateBlockId,
    /// Document exceeds [`MAX_DOCUMENT_BYTES`].
    DocumentTooLarge,
    /// Body nesting exceeds [`MAX_TARGET_DEPTH`].
    DocumentTooComplex,
    /// Body contains executable or otherwise nonconforming constructs.
    UnsafeContent,
    /// A `.base` query failed `pdc-query/1` validation (PDC 2 §13).
    InvalidQuery,
    /// Detected an external modification against the edit snapshot.
    ExternalChangeConflict,
}

impl DiagnosticKind {
    /// Stable snake_case name used in machine-readable diagnostics.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidTransport => "invalid_transport",
            Self::InvalidEnvelope => "invalid_envelope",
            Self::UnsupportedDocumentVersion => "unsupported_document_version",
            Self::UnsupportedBodyVersion => "unsupported_body_version",
            Self::InvalidDocumentId => "invalid_document_id",
            Self::DuplicateBlockId => "duplicate_block_id",
            Self::DocumentTooLarge => "document_too_large",
            Self::DocumentTooComplex => "document_too_complex",
            Self::UnsafeContent => "unsafe_content",
            Self::InvalidQuery => "invalid_query",
            Self::ExternalChangeConflict => "external_change_conflict",
        }
    }
}

/// A single classification failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PdcDiagnostic {
    /// Outcome class.
    pub kind: DiagnosticKind,
    /// 1-indexed line when the failure has a location.
    pub line: Option<usize>,
    /// Human-readable reason.
    pub message: String,
}

impl PdcDiagnostic {
    fn new(kind: DiagnosticKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            line: None,
            message: message.into(),
        }
    }

    fn at(kind: DiagnosticKind, line: usize, message: impl Into<String>) -> Self {
        Self {
            kind,
            line: Some(line),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for PdcDiagnostic {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.line {
            Some(line) => write!(
                f,
                "{} at line {}: {}",
                self.kind.as_str(),
                line,
                self.message
            ),
            None => write!(f, "{}: {}", self.kind.as_str(), self.message),
        }
    }
}

/// Canonical body profile declared by the `body` envelope field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyProfile {
    /// `pdc-djot/1` — legacy, valid only under `pdc-document/1`.
    Djot,
    /// `pdc-html/1`
    Html,
    /// `pdc-markdown/1` — canonical, valid only under `pdc-document/2`.
    Markdown,
}

impl BodyProfile {
    /// Exact contract identifier string.
    pub fn id_str(self) -> &'static str {
        match self {
            Self::Djot => "pdc-djot/1",
            Self::Html => "pdc-html/1",
            Self::Markdown => "pdc-markdown/1",
        }
    }
}

/// A successfully classified PDC document (canonical v2 or readable
/// legacy v1).
///
/// The document is a projection over the original bytes; nothing here
/// authorizes a rewrite. `body_range` locates the untouched body slice
/// inside the source for preservation rules.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PdcDocument {
    /// Profile declared by the envelope.
    pub profile: BodyProfile,
    /// Parsed envelope; unknown user properties are preserved in
    /// source order.
    pub envelope: Yaml,
    /// Canonical document UUID (copy of the validated `id` field).
    pub id: String,
    /// Byte range of the body slice within the classified input.
    pub body_range: std::ops::Range<usize>,
    /// Block targets collected from the body (caret IDs for Markdown,
    /// `b-<uuid>` targets for HTML; PDC 2 §7.2).
    pub block_ids: Vec<String>,
    /// Markdown only: benign raw HTML is present — preserved in source,
    /// inert in preview (PDC 2 §6.1).
    pub has_raw_html: bool,
    /// `true` for readable `pdc-document/1` legacy documents
    /// (`legacy_document_version` in PDC 2 §13).
    pub legacy: bool,
}

/// Outcome of classifying one discovered file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Classification {
    /// Canonical v2 document, or a readable legacy v1 document
    /// ([`PdcDocument::legacy`]).
    Valid(PdcDocument),
    /// `.html` file without the exact PDC opening transport.
    ///
    /// Legacy HTML is a visible classification, not an error; it never
    /// authorizes rewriting the file.
    LegacyHtml,
    /// `.md` file without the exact `---` frontmatter transport.
    ///
    /// Plain Markdown is a visible legacy item, not an error; it never
    /// authorizes rewriting the file (PDC 2 §4.2).
    LegacyMarkdown,
    /// Canonical-transport document that failed validation.
    Invalid(PdcDiagnostic),
}

/// One physical line of the source, tracked by byte span so body slices
/// and metadata patches never re-serialize untouched bytes.
struct Line<'a> {
    /// Byte offset of the first content byte.
    start: usize,
    /// Byte offset one past the last content byte (terminator excluded).
    end: usize,
    /// Byte offset one past the line terminator.
    next: usize,
    /// Content slice (may still carry a trailing `\r`).
    raw: &'a str,
}

impl<'a> Line<'a> {
    /// Content with a single trailing `\r` removed (CRLF tolerance,
    /// PDC §4.1).
    fn normalized(&self) -> &'a str {
        self.raw.strip_suffix('\r').unwrap_or(self.raw)
    }
}

fn split_lines(text: &str) -> Vec<Line<'_>> {
    let mut out = Vec::new();
    let mut start = 0;
    for (i, b) in text.bytes().enumerate() {
        if b == b'\n' {
            out.push(Line {
                start,
                end: i,
                next: i + 1,
                raw: &text[start..i],
            });
            start = i + 1;
        }
    }
    if start < text.len() {
        out.push(Line {
            start,
            end: text.len(),
            next: text.len(),
            raw: &text[start..],
        });
    }
    out
}

/// Result of locating the envelope inside a document.
struct EnvelopeSpan {
    /// First envelope-content line index (inside `lines`).
    first: usize,
    /// One past the last envelope-content line index. The closing fence
    /// sits at `last` for Djot and at `last` followed by `-->` for HTML.
    last: usize,
    /// Body starts at this byte offset.
    body_start: usize,
}

/// Locate the envelope lines for a Djot-transport document.
///
/// The first line must be exactly `---`, the next exact `---` line
/// closes the envelope; the remainder is the body.
fn envelope_span_djot(lines: &[Line<'_>]) -> Result<EnvelopeSpan, PdcDiagnostic> {
    if lines.first().map(Line::normalized) != Some("---") {
        return Err(PdcDiagnostic::new(
            DiagnosticKind::InvalidTransport,
            "frontmatter-free .djot is valid upstream Djot but invalid PDC transport",
        ));
    }
    let close = lines
        .iter()
        .position(|l| l.start > 0 && l.normalized() == "---")
        .ok_or_else(|| {
            PdcDiagnostic::new(
                DiagnosticKind::InvalidTransport,
                "envelope is never closed; expected a second `---` line",
            )
        })?;
    Ok(EnvelopeSpan {
        first: 1,
        last: close,
        body_start: lines[close].next,
    })
}

/// Locate the envelope lines for an HTML-transport document.
///
/// The caller has already verified the exact opening transport (`<!--`
/// then `---`); this finds the closing `---`, requires the following
/// line to be exactly `-->`, and rejects earlier `-->`/`--!>` sequences
/// inside the envelope (PDC §4.3).
fn envelope_span_html(lines: &[Line<'_>]) -> Result<EnvelopeSpan, PdcDiagnostic> {
    let close = lines
        .iter()
        .position(|l| l.start > lines[1].start && l.normalized() == "---")
        .ok_or_else(|| {
            PdcDiagnostic::new(
                DiagnosticKind::InvalidTransport,
                "envelope is never closed; expected `---` and `-->` lines",
            )
        })?;
    if lines.get(close + 1).map(Line::normalized) != Some("-->") {
        return Err(PdcDiagnostic::at(
            DiagnosticKind::InvalidTransport,
            close + 2,
            "the `---` envelope closer must be immediately followed by `-->`",
        ));
    }
    // An earlier `-->` or `--!>` would let an HTML parser terminate the
    // comment before the PDC parser does (PDC §4.3).
    for line in &lines[2..close] {
        if line.normalized().contains("-->") || line.normalized().contains("--!>") {
            return Err(PdcDiagnostic::at(
                DiagnosticKind::InvalidTransport,
                close + 2,
                "envelope contains an earlier `-->`/`--!>` sequence that would \
                 terminate the HTML comment prematurely",
            ));
        }
    }
    Ok(EnvelopeSpan {
        first: 2,
        last: close,
        body_start: lines[close + 1].next,
    })
}

/// Extract a string value from the envelope, mapping a wrong type to an
/// envelope diagnostic.
fn str_field(envelope: &Table, key: &str) -> Result<String, PdcDiagnostic> {
    match envelope.get(key) {
        Some(Value::Str(s)) => Ok(s.clone()),
        Some(_) => Err(PdcDiagnostic::new(
            DiagnosticKind::InvalidEnvelope,
            format!("`{key}` must be a string"),
        )),
        None => Err(PdcDiagnostic::new(
            DiagnosticKind::InvalidEnvelope,
            format!("required field `{key}` is missing"),
        )),
    }
}

fn check_bool(envelope: &Table, key: &str) -> Result<(), PdcDiagnostic> {
    match envelope.get(key) {
        Some(Value::Bool(_)) | None => Ok(()),
        Some(_) => Err(PdcDiagnostic::new(
            DiagnosticKind::InvalidEnvelope,
            format!("`{key}` must be a Boolean"),
        )),
    }
}

fn check_str(envelope: &Table, key: &str) -> Result<(), PdcDiagnostic> {
    match envelope.get(key) {
        Some(Value::Str(_)) | None => Ok(()),
        Some(_) => Err(PdcDiagnostic::new(
            DiagnosticKind::InvalidEnvelope,
            format!("`{key}` must be a string"),
        )),
    }
}

fn check_string_seq(envelope: &Table, key: &str) -> Result<(), PdcDiagnostic> {
    match envelope.get(key) {
        Some(Value::Array(_)) | None => Ok(()),
        Some(_) => Err(PdcDiagnostic::new(
            DiagnosticKind::InvalidEnvelope,
            format!("`{key}` must be a string sequence"),
        )),
    }
}

/// Canonical lowercase hyphenated UUID: version nibble `1`-`8`, variant
/// nibble in `89ab` (PDC §7.1 / envelope schema).
fn canonical_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 36 {
        return false;
    }
    for (i, c) in b.iter().enumerate() {
        match i {
            8 | 13 | 18 | 23 => {
                if *c != b'-' {
                    return false;
                }
            }
            14 => {
                if !((*c).is_ascii_digit() && (b'1'..=b'8').contains(c)) {
                    return false;
                }
            }
            19 => {
                if !matches!(c, b'8' | b'9' | b'a' | b'b') {
                    return false;
                }
            }
            _ => {
                if !(c.is_ascii_digit() || (b'a'..=b'f').contains(c)) {
                    return false;
                }
            }
        }
    }
    true
}

/// Exact canonical timestamp: `YYYY-MM-DDTHH:MM:SS.sssZ` with a real
/// Gregorian date (PDC §5.1). Returns the parsed instant.
fn parse_canonical_timestamp(s: &str) -> Result<time::OffsetDateTime, time::error::Parse> {
    let fmt = time::macros::format_description!(
        "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
    );
    time::PrimitiveDateTime::parse(s, &fmt).map(|dt| dt.assume_utc())
}

/// Collect `b-<uuid>` block-target IDs declared by the body profile and
/// report duplicates (PDC §7.2).
fn duplicate_block_id(ids: &[String]) -> bool {
    let mut seen = std::collections::HashSet::new();
    ids.iter().any(|id| !seen.insert(id.as_str()))
}

/// Djot block-target IDs: `{#b-<uuid>}` block attributes.
fn djot_block_ids(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = body;
    while let Some(pos) = rest.find("{#b-") {
        let after = &rest[pos + 4..];
        if let Some(close) = after.find('}') {
            let candidate = &after[..close];
            if canonical_uuid(candidate) {
                out.push(candidate.to_string());
            }
            rest = &after[close..];
        } else {
            break;
        }
    }
    out
}

/// Maximum Djot block-quote nesting depth of the body.
fn djot_quote_depth(body: &str) -> usize {
    body.lines()
        .map(|line| {
            let mut depth = 0;
            let mut rest = line;
            loop {
                let trimmed = rest.trim_start_matches(' ');
                if let Some(after) = trimmed.strip_prefix('>') {
                    depth += 1;
                    rest = after.strip_prefix(' ').unwrap_or(after);
                } else {
                    return depth;
                }
            }
        })
        .max()
        .unwrap_or(0)
}

/// Scan a Djot body for raw HTML constructs, which are nonconforming
/// (PDC §6.1).
///
/// Recognized raw forms: fenced code blocks with an `=html` info string
/// (raw blocks) and tag-like `<` sequences outside code fences and
/// inline code spans (raw inline). Autolinks such as `<https://…>` are
/// not raw. This is a lexical scanner, not a Djot parser; the conformance
/// corpus is the authority for its behavior at Stage 0.
fn djot_has_raw_html(body: &str) -> bool {
    let mut fence: Option<char> = None;
    for line in body.lines() {
        let trimmed = line.trim_start();
        let fence_char = trimmed.chars().next().filter(|c| *c == '`' || *c == '~');
        if let Some(c) = fence_char {
            let runs = trimmed.chars().take_while(|x| *x == c).count();
            if runs >= 3 {
                match fence {
                    None => {
                        let info = trimmed.trim_start_matches(c);
                        let info = info.trim();
                        if info == "=html" || info.starts_with("=html ") {
                            return true;
                        }
                        fence = Some(c);
                        continue;
                    }
                    Some(open) if open == c => {
                        fence = None;
                        continue;
                    }
                    _ => continue,
                }
            }
        }
        if fence.is_some() {
            continue;
        }
        if inline_raw_html(line) {
            return true;
        }
    }
    false
}

/// Raw inline HTML detection for one line, skipping inline code spans.
fn inline_raw_html(line: &str) -> bool {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'`' => {
                let run_len = bytes[i..].iter().take_while(|b| **b == b'`').count();
                // Skip to the matching run; if absent, the rest is code.
                let close = find_backtick_run(bytes, i + run_len, run_len);
                match close {
                    Some(next) => i = next,
                    None => return false,
                }
            }
            b'<' => {
                let rest = &line[i + 1..];
                let mut chars = rest.chars();
                match chars.next() {
                    Some('/') | Some('!') => return true,
                    Some(c) if c.is_ascii_alphabetic() => {
                        // An autolink is `<scheme:` with no space before
                        // the colon; anything else tag-like is raw.
                        let scheme_len = rest
                            .chars()
                            .take_while(|x| {
                                x.is_ascii_alphanumeric() || *x == '-' || *x == '.' || *x == '+'
                            })
                            .count();
                        let is_autolink = rest.as_bytes().get(scheme_len) == Some(&b':');
                        if !is_autolink {
                            return true;
                        }
                        i += 1;
                    }
                    _ => i += 1,
                }
                i += 1;
            }
            _ => i += 1,
        }
    }
    false
}

fn find_backtick_run(bytes: &[u8], from: usize, len: usize) -> Option<usize> {
    let mut i = from;
    while i + len <= bytes.len() {
        if bytes[i..].iter().take(len).all(|b| *b == b'`') && bytes.get(i + len) != Some(&b'`') {
            return Some(i + len);
        }
        i += 1;
    }
    None
}

/// HTML constructs that make a `pdc-html/1` body nonconforming
/// (executable content, PDC §6.2/§11.3).
const HTML_UNSAFE_ELEMENTS: [&str; 7] = [
    "script", "iframe", "object", "embed", "applet", "base", "link",
];

const HTML_NAV_ATTRS: [&str; 5] = ["href", "src", "action", "formaction", "xlink:href"];

/// Outcome of the HTML body scan.
#[derive(Debug, Default, PartialEq, Eq)]
struct HtmlScan {
    unsafe_found: bool,
    block_ids: Vec<String>,
}

/// Scan an authored HTML body for nonconforming constructs and stable
/// `b-<uuid>` block targets.
///
/// Lexical scan per the HTML parsing model: comments are skipped, tags
/// are read with quote-aware attribute splitting. Text outside tags is
/// inert. The conformance corpus is the authority for Stage 0 behavior;
/// a full HTML5 parser arrives with the Stage 1 Reader.
fn scan_html_body(body: &str) -> HtmlScan {
    let mut scan = HtmlScan::default();
    let bytes = body.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i..].starts_with(b"<!--") {
            match find_sub(bytes, i + 4, b"-->") {
                Some(end) => i = end + 3,
                None => break,
            }
            continue;
        }
        if bytes[i] == b'<' {
            // `<` is ASCII, so `i + 1` is always a char boundary.
            let rest = &body[i + 1..];
            match rest.bytes().next() {
                Some(b'!') | Some(b'?') => {
                    // doctype / processing junk: skip past the next `>`
                    i = match find_sub(bytes, i + 1, b">") {
                        Some(p) => p + 1,
                        None => bytes.len(),
                    };
                    continue;
                }
                Some(b'/') => i += 1,
                Some(c) if c.is_ascii_alphabetic() => {
                    let end = tag_end(bytes, i);
                    let tag = &body[i + 1..end];
                    scan_tag(tag, &mut scan);
                    i = end + 1;
                    continue;
                }
                _ => {}
            }
        }
        i += 1;
    }
    scan
}

/// Byte offset of the `>` closing the tag opening at `open`, or the
/// slice length when the tag is unterminated.
fn tag_end(bytes: &[u8], open: usize) -> usize {
    let mut quote: Option<u8> = None;
    for (off, b) in bytes[open..].iter().enumerate() {
        match (quote, b) {
            (Some(q), b) if *b == q => quote = None,
            (None, b'"' | b'\'') => quote = Some(*b),
            (None, b'>') => return open + off,
            _ => {}
        }
    }
    bytes.len()
}

/// First byte offset of `needle` in `bytes` at or after `from`.
fn find_sub(bytes: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || bytes.len() < needle.len() {
        return None;
    }
    (from..=bytes.len() - needle.len()).find(|i| &bytes[*i..i + needle.len()] == needle)
}

/// Classify one tag's element name and attributes.
fn scan_tag(tag: &str, scan: &mut HtmlScan) {
    let name_end = tag
        .find(|c: char| c.is_whitespace() || c == '>' || c == '/')
        .unwrap_or(tag.len());
    let name = tag[..name_end].to_ascii_lowercase();
    if HTML_UNSAFE_ELEMENTS.contains(&name.as_str()) {
        scan.unsafe_found = true;
    }
    let mut rest = &tag[name_end..];
    while !rest.is_empty() {
        rest = rest.trim_start();
        if rest.is_empty() {
            break;
        }
        let attr_end = rest
            .find(|c: char| c.is_whitespace() || c == '=')
            .unwrap_or(rest.len());
        let attr = rest[..attr_end].to_ascii_lowercase();
        rest = &rest[attr_end..];
        let value: &str = if let Some(after) = rest.strip_prefix('=') {
            let after = after.trim_start();
            let (raw, consumed) = if let Some(q) = after.chars().next() {
                if q == '"' || q == '\'' {
                    match after[1..].find(q) {
                        Some(p) => (&after[1..1 + p], p + 2),
                        None => (&after[1..], after.len()),
                    }
                } else {
                    let p = after
                        .find(|c: char| c.is_whitespace())
                        .unwrap_or(after.len());
                    (&after[..p], p)
                }
            } else {
                ("", 0)
            };
            rest = &after[consumed.min(after.len())..];
            raw
        } else {
            ""
        };
        if attr == "id" && is_block_target(value) {
            scan.block_ids.push(value[2..].to_string());
        }
        if attr.len() > 2
            && attr.starts_with("on")
            && attr[2..].chars().all(|c| c.is_ascii_alphabetic())
        {
            scan.unsafe_found = true;
        }
        if HTML_NAV_ATTRS.contains(&attr.as_str()) {
            let lower = value.trim().to_ascii_lowercase();
            if lower.starts_with("javascript:") || lower.starts_with("vbscript:") {
                scan.unsafe_found = true;
            }
        }
        if name == "meta" && attr == "http-equiv" {
            scan.unsafe_found = true;
        }
    }
}

/// `id="b-<uuid>"` marks a stable block target (PDC §7.2).
fn is_block_target(value: &str) -> bool {
    value.len() == 38 && value.starts_with("b-") && canonical_uuid(&value[2..])
}

/// Classify one discovered file against the PDC contract.
///
/// Classification never mutates the input and never authorizes a
/// rewrite; it is the Stage 0 gate used by discovery, CLI, and tests.
pub fn classify(ext: DocumentExt, bytes: &[u8]) -> Classification {
    if bytes.starts_with(BOM) {
        return Classification::Invalid(PdcDiagnostic::new(
            DiagnosticKind::InvalidTransport,
            "byte-order mark present; canonical documents are UTF-8 without a BOM",
        ));
    }
    if bytes.len() > MAX_DOCUMENT_BYTES {
        return Classification::Invalid(PdcDiagnostic::new(
            DiagnosticKind::DocumentTooLarge,
            format!("document exceeds the {MAX_DOCUMENT_BYTES}-byte limit"),
        ));
    }
    let text = match std::str::from_utf8(bytes) {
        Ok(t) => t,
        Err(e) => {
            return Classification::Invalid(PdcDiagnostic::new(
                DiagnosticKind::InvalidTransport,
                format!("document is not valid UTF-8: {e}"),
            ));
        }
    };
    let lines = split_lines(text);
    match ext {
        DocumentExt::Djot => match envelope_span_djot(&lines) {
            Ok(span) => classify_v1(ext, text, &lines, span),
            Err(d) => Classification::Invalid(d),
        },
        DocumentExt::Html => {
            // A `.html` file without the exact opening transport is
            // legacy HTML: visible classification, not an error. A file
            // that opens correctly but fails later is invalid.
            let opens = lines.len() >= 2
                && lines[0].normalized() == "<!--"
                && lines[1].normalized() == "---";
            if !opens {
                return Classification::LegacyHtml;
            }
            match envelope_span_html(&lines) {
                Ok(span) => {
                    if envelope_declares_v2(&lines[span.first..span.last]) {
                        classify_v2(ext, text, &lines, span)
                    } else {
                        classify_v1(ext, text, &lines, span)
                    }
                }
                Err(d) => Classification::Invalid(d),
            }
        }
        DocumentExt::Markdown => match envelope_span_markdown(&lines) {
            Ok(Some(span)) => classify_v2(ext, text, &lines, span),
            Ok(None) => Classification::LegacyMarkdown,
            Err(d) => Classification::Invalid(d),
        },
    }
}

/// v1 pipeline: constrained grammar plus v1 semantics, producing a
/// readable legacy document (PDC 2 §4.4).
fn classify_v1(
    ext: DocumentExt,
    text: &str,
    lines: &[Line<'_>],
    span: EnvelopeSpan,
) -> Classification {
    let envelope_texts: Vec<&str> = lines[span.first..span.last].iter().map(|l| l.raw).collect();
    let table = match parse_block(&envelope_texts, span.first + 1) {
        Ok(t) => t,
        Err(e) => {
            return Classification::Invalid(PdcDiagnostic::at(
                DiagnosticKind::InvalidEnvelope,
                e.line,
                e.reason,
            ));
        }
    };
    if let Err(d) = validate_semantics(ext, &table) {
        return Classification::Invalid(d);
    }
    let body = &text[span.body_start..];
    let (block_ids, has_raw_html) = match validate_body(ext, body) {
        Ok(found) => found,
        Err(d) => return Classification::Invalid(d),
    };
    let id = match table.get("id") {
        Some(Value::Str(id)) => id.clone(),
        _ => unreachable!("validate_semantics checked a string id"),
    };
    let profile = match ext {
        DocumentExt::Djot => BodyProfile::Djot,
        DocumentExt::Html => BodyProfile::Html,
        DocumentExt::Markdown => unreachable!("markdown is a v2-only transport"),
    };
    Classification::Valid(PdcDocument {
        profile,
        envelope: yaml_from_table(&table),
        id,
        body_range: span.body_start..text.len(),
        block_ids,
        has_raw_html,
        legacy: true,
    })
}

/// v2 pipeline: safe general-YAML envelope plus v2 semantics, shared by
/// the Markdown and HTML transports (PDC 2 §4.2–§5).
fn classify_v2(
    ext: DocumentExt,
    text: &str,
    lines: &[Line<'_>],
    span: EnvelopeSpan,
) -> Classification {
    let expected = match ext {
        DocumentExt::Markdown => BodyProfile::Markdown,
        DocumentExt::Html => BodyProfile::Html,
        DocumentExt::Djot => unreachable!("djot is a v1-only transport"),
    };
    let mut envelope_text = String::new();
    for line in &lines[span.first..span.last] {
        envelope_text.push_str(line.raw);
        envelope_text.push('\n');
    }
    let root = match yaml::parse_document(&envelope_text) {
        Ok(root) => root,
        Err(e) => {
            return Classification::Invalid(PdcDiagnostic {
                kind: match e.kind {
                    yaml::YamlErrorKind::Malformed => DiagnosticKind::InvalidEnvelope,
                    yaml::YamlErrorKind::TooComplex => DiagnosticKind::DocumentTooComplex,
                },
                line: e.line,
                message: e.reason,
            });
        }
    };

    // Version routing: `pdc-document/2` proceeds; `pdc-document/1`
    // never existed for this transport (invalid_transport, PDC 2 §2);
    // any other major version is unsupported, not malformed.
    match root.get("format").and_then(Yaml::as_str) {
        Some("pdc-document/2") => {}
        Some("pdc-document/1") => {
            return Classification::Invalid(PdcDiagnostic::new(
                DiagnosticKind::InvalidTransport,
                "`pdc-document/1` is legacy and predates this transport",
            ));
        }
        Some(_) => {
            return Classification::Invalid(PdcDiagnostic::new(
                DiagnosticKind::UnsupportedDocumentVersion,
                "`format` names an unsupported major version",
            ));
        }
        None => {
            return Classification::Invalid(PdcDiagnostic::new(
                DiagnosticKind::InvalidEnvelope,
                "required field `format` is missing or not a string",
            ));
        }
    }
    // The transport pins the body profile exactly (PDC 2 §4.2–4.3).
    match root.get("body").and_then(Yaml::as_str) {
        Some(profile) if profile == expected.id_str() => {}
        Some(_) => {
            return Classification::Invalid(PdcDiagnostic::new(
                DiagnosticKind::InvalidTransport,
                format!(
                    "`body` must be exactly `{}` in this transport",
                    expected.id_str()
                ),
            ));
        }
        None => {
            return Classification::Invalid(PdcDiagnostic::new(
                DiagnosticKind::InvalidEnvelope,
                "required field `body` is missing or not a string",
            ));
        }
    }

    if let Err(d) = validate_semantics_v2(&root) {
        return Classification::Invalid(d);
    }
    let id = root
        .get("id")
        .and_then(Yaml::as_str)
        .expect("validate_semantics_v2 checked a string id")
        .to_string();

    let body = &text[span.body_start..];
    let (block_ids, has_raw_html) = match ext {
        DocumentExt::Markdown => {
            let scan = markdown::scan_markdown_body(body);
            if scan.unsafe_found {
                return Classification::Invalid(PdcDiagnostic::new(
                    DiagnosticKind::UnsafeContent,
                    "Markdown body contains active raw HTML (script, event handler, or \
                     unsafe URL); the source is preserved and preview must stay inert",
                ));
            }
            if duplicate_block_id(&scan.block_ids) {
                return Classification::Invalid(PdcDiagnostic::new(
                    DiagnosticKind::DuplicateBlockId,
                    "two targets share one caret or `b-<uuid>` block ID",
                ));
            }
            (scan.block_ids, scan.has_raw_html)
        }
        DocumentExt::Html => {
            let scan = scan_html_body(body);
            if scan.unsafe_found {
                return Classification::Invalid(PdcDiagnostic::new(
                    DiagnosticKind::UnsafeContent,
                    "HTML body contains executable or otherwise nonconforming constructs",
                ));
            }
            if duplicate_block_id(&scan.block_ids) {
                return Classification::Invalid(PdcDiagnostic::new(
                    DiagnosticKind::DuplicateBlockId,
                    "two elements share one `b-<uuid>` id",
                ));
            }
            (scan.block_ids, false)
        }
        DocumentExt::Djot => unreachable!("djot is a v1-only transport"),
    };

    Classification::Valid(PdcDocument {
        profile: expected,
        envelope: root,
        id,
        body_range: span.body_start..text.len(),
        block_ids,
        has_raw_html,
        legacy: false,
    })
}

/// Lexical sniff: does this HTML envelope declare
/// `format: pdc-document/2`? Only a top-level plain/quoted scalar
/// routes the document to the v2 pipeline; anything else — including a
/// missing or oddly shaped `format` — stays on the v1 path so v1
/// diagnostics remain unchanged.
fn envelope_declares_v2(envelope_lines: &[Line<'_>]) -> bool {
    for line in envelope_lines {
        let content = line.normalized();
        let trimmed = content.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') || content.len() != trimmed.len() {
            continue; // blank, comment, or indented: never a top-level key
        }
        let Some((key, rest)) = content.split_once(':') else {
            continue;
        };
        if key.trim() != "format" {
            continue;
        }
        let value = rest.trim();
        let value = value.split(" #").next().unwrap_or(value).trim();
        return value.trim_matches('"').trim_matches('\'') == "pdc-document/2";
    }
    false
}

/// Markdown transport: `---` at byte 0, closed by the next exact `---`
/// line (PDC 2 §4.2). A file that does not start with the delimiter is
/// plain Markdown (`Ok(None)`); an unclosed delimiter is
/// `invalid_transport`.
fn envelope_span_markdown(lines: &[Line<'_>]) -> Result<Option<EnvelopeSpan>, PdcDiagnostic> {
    if lines.first().map(Line::normalized) != Some("---") {
        return Ok(None);
    }
    let close = lines
        .iter()
        .position(|l| l.start > 0 && l.normalized() == "---")
        .ok_or_else(|| {
            PdcDiagnostic::new(
                DiagnosticKind::InvalidTransport,
                "frontmatter delimiter is never closed; expected a second `---` line",
            )
        })?;
    Ok(Some(EnvelopeSpan {
        first: 1,
        last: close,
        body_start: lines[close].next,
    }))
}

/// v2 envelope semantic validation shared by both transports
/// (PDC 2 §5.1–5.3). Unknown user properties are never inspected here:
/// any safe-YAML value is preserved.
fn validate_semantics_v2(root: &Yaml) -> Result<(), PdcDiagnostic> {
    let required_str = |key: &str| -> Result<&str, PdcDiagnostic> {
        match root.get(key) {
            Some(Yaml::Str(s)) => Ok(s),
            Some(_) => Err(PdcDiagnostic::new(
                DiagnosticKind::InvalidEnvelope,
                format!("`{key}` must be a string"),
            )),
            None => Err(PdcDiagnostic::new(
                DiagnosticKind::InvalidEnvelope,
                format!("required field `{key}` is missing"),
            )),
        }
    };

    let id = required_str("id")?;
    if !canonical_uuid(id) {
        return Err(PdcDiagnostic::new(
            DiagnosticKind::InvalidDocumentId,
            "`id` must be a canonical lowercase hyphenated UUID",
        ));
    }
    let created = parse_canonical_timestamp(required_str("created")?).map_err(|_| {
        PdcDiagnostic::new(
            DiagnosticKind::InvalidEnvelope,
            "`created` must be a canonical UTC millisecond timestamp with a real calendar date",
        )
    })?;
    let updated = parse_canonical_timestamp(required_str("updated")?).map_err(|_| {
        PdcDiagnostic::new(
            DiagnosticKind::InvalidEnvelope,
            "`updated` must be a canonical UTC millisecond timestamp with a real calendar date",
        )
    })?;
    if updated < created {
        return Err(PdcDiagnostic::new(
            DiagnosticKind::InvalidEnvelope,
            "`updated` must not be earlier than `created`",
        ));
    }
    // The stored title is authoritative and may be empty (PDC 2 §5.1).
    required_str("title")?;

    for key in ["profile", "lang"] {
        if let Some(value) = root.get(key)
            && !matches!(value, Yaml::Str(_))
        {
            return Err(PdcDiagnostic::new(
                DiagnosticKind::InvalidEnvelope,
                format!("`{key}` must be a string"),
            ));
        }
    }
    for key in ["tags", "aliases", "cssclasses"] {
        match root.get(key) {
            Some(Yaml::Seq(items)) => {
                if items.iter().any(|item| !matches!(item, Yaml::Str(_))) {
                    return Err(PdcDiagnostic::new(
                        DiagnosticKind::InvalidEnvelope,
                        format!("`{key}` entries must be strings"),
                    ));
                }
            }
            Some(_) => {
                return Err(PdcDiagnostic::new(
                    DiagnosticKind::InvalidEnvelope,
                    format!("`{key}` must be a string sequence"),
                ));
            }
            None => {}
        }
    }
    for key in ["favorite", "deleted"] {
        if let Some(value) = root.get(key)
            && !matches!(value, Yaml::Bool(_))
        {
            return Err(PdcDiagnostic::new(
                DiagnosticKind::InvalidEnvelope,
                format!("`{key}` must be a Boolean"),
            ));
        }
    }

    let deleted = root.get("deleted").and_then(Yaml::as_bool);
    let deleted_at = match root.get("deleted_at") {
        Some(Yaml::Str(ts)) => Some(ts.as_str()),
        Some(_) => {
            return Err(PdcDiagnostic::new(
                DiagnosticKind::InvalidEnvelope,
                "`deleted_at` must be a string timestamp",
            ));
        }
        None => None,
    };
    match (deleted, deleted_at) {
        (None | Some(false), None) => Ok(()),
        (None | Some(false), Some(_)) => Err(PdcDiagnostic::new(
            DiagnosticKind::InvalidEnvelope,
            "`deleted_at` must be absent unless `deleted` is true",
        )),
        (Some(true), Some(ts)) => parse_canonical_timestamp(ts).map(|_| ()).map_err(|_| {
            PdcDiagnostic::new(
                DiagnosticKind::InvalidEnvelope,
                "`deleted_at` must be a canonical UTC millisecond timestamp",
            )
        }),
        (Some(true), None) => Err(PdcDiagnostic::new(
            DiagnosticKind::InvalidEnvelope,
            "`deleted: true` requires a matching `deleted_at` timestamp",
        )),
    }
}

/// Convert a v1 constrained-grammar table into the general [`Yaml`]
/// projection so both document generations share one envelope type.
fn yaml_from_table(table: &Table) -> Yaml {
    Yaml::Map(
        table
            .iter()
            .map(|(k, v)| (k.clone(), yaml_from_value(v)))
            .collect(),
    )
}

fn yaml_from_value(value: &Value) -> Yaml {
    match value {
        Value::Bool(b) => Yaml::Bool(*b),
        Value::Str(s) => Yaml::Str(s.clone()),
        Value::Array(items) => Yaml::Seq(items.iter().map(|s| Yaml::Str(s.clone())).collect()),
        Value::Map(map) => yaml_from_table(map),
    }
}

/// Envelope-level semantic validation (PDC §5).
fn validate_semantics(ext: DocumentExt, table: &Table) -> Result<(), PdcDiagnostic> {
    match table.get("format").and_then(Value::as_str_lit) {
        Some("pdc-document/1") => {}
        Some(_) => {
            return Err(PdcDiagnostic::new(
                DiagnosticKind::UnsupportedDocumentVersion,
                "`format` must be exactly `pdc-document/1`",
            ));
        }
        None => {
            return Err(PdcDiagnostic::new(
                DiagnosticKind::InvalidEnvelope,
                "required field `format` is missing or not a string",
            ));
        }
    }

    let expected = match ext {
        DocumentExt::Djot => BodyProfile::Djot,
        DocumentExt::Html => BodyProfile::Html,
        DocumentExt::Markdown => unreachable!("markdown is a v2-only transport"),
    };
    match table.get("body").and_then(Value::as_str_lit) {
        Some(id) if id == expected.id_str() => {}
        Some(other)
            if other == BodyProfile::Djot.id_str() || other == BodyProfile::Html.id_str() =>
        {
            return Err(PdcDiagnostic::new(
                DiagnosticKind::InvalidTransport,
                format!("body profile `{other}` disagrees with this file transport"),
            ));
        }
        Some(_) => {
            return Err(PdcDiagnostic::new(
                DiagnosticKind::UnsupportedBodyVersion,
                "`body` names an unsupported profile version",
            ));
        }
        None => {
            return Err(PdcDiagnostic::new(
                DiagnosticKind::InvalidEnvelope,
                "required field `body` is missing or not a string",
            ));
        }
    }

    let id = str_field(table, "id")?;
    if !canonical_uuid(&id) {
        return Err(PdcDiagnostic::new(
            DiagnosticKind::InvalidDocumentId,
            "`id` must be a canonical lowercase hyphenated UUID",
        ));
    }

    let created = parse_canonical_timestamp(&str_field(table, "created")?).map_err(|_| {
        PdcDiagnostic::new(
            DiagnosticKind::InvalidEnvelope,
            "`created` must be a canonical UTC millisecond timestamp with a real calendar date",
        )
    })?;
    let updated = parse_canonical_timestamp(&str_field(table, "updated")?).map_err(|_| {
        PdcDiagnostic::new(
            DiagnosticKind::InvalidEnvelope,
            "`updated` must be a canonical UTC millisecond timestamp with a real calendar date",
        )
    })?;
    if updated < created {
        return Err(PdcDiagnostic::new(
            DiagnosticKind::InvalidEnvelope,
            "`updated` must not be earlier than `created`",
        ));
    }

    str_field(table, "title")?;
    check_str(table, "profile")?;
    check_str(table, "lang")?;
    check_string_seq(table, "tags")?;
    check_string_seq(table, "aliases")?;
    check_bool(table, "favorite")?;
    let deleted = match table.get("deleted") {
        Some(Value::Bool(b)) => *b,
        Some(_) => {
            return Err(PdcDiagnostic::new(
                DiagnosticKind::InvalidEnvelope,
                "`deleted` must be a Boolean",
            ));
        }
        None => false,
    };
    let deleted_at = match table.get("deleted_at") {
        Some(Value::Str(ts)) => Some(ts.as_str()),
        Some(_) => {
            return Err(PdcDiagnostic::new(
                DiagnosticKind::InvalidEnvelope,
                "`deleted_at` must be a string timestamp",
            ));
        }
        None => None,
    };
    match (deleted, deleted_at) {
        (false, None) => {}
        (true, Some(ts)) => {
            if parse_canonical_timestamp(ts).is_err() {
                return Err(PdcDiagnostic::new(
                    DiagnosticKind::InvalidEnvelope,
                    "`deleted_at` must be a canonical UTC millisecond timestamp",
                ));
            }
        }
        (true, None) => {
            return Err(PdcDiagnostic::new(
                DiagnosticKind::InvalidEnvelope,
                "`deleted: true` requires a matching `deleted_at` timestamp",
            ));
        }
        (false, Some(_)) => {
            return Err(PdcDiagnostic::new(
                DiagnosticKind::InvalidEnvelope,
                "`deleted_at` must be absent when `deleted` is false",
            ));
        }
    }
    Ok(())
}

/// Body-level validation for a v1 profile; returns the collected block
/// targets. Markdown bodies are validated by [`classify_v2`].
fn validate_body(ext: DocumentExt, body: &str) -> Result<(Vec<String>, bool), PdcDiagnostic> {
    match ext {
        DocumentExt::Djot => {
            if djot_has_raw_html(body) {
                return Err(PdcDiagnostic::new(
                    DiagnosticKind::UnsafeContent,
                    "Djot bodies must not contain raw HTML constructs",
                ));
            }
            let ids = djot_block_ids(body);
            if duplicate_block_id(&ids) {
                return Err(PdcDiagnostic::new(
                    DiagnosticKind::DuplicateBlockId,
                    "two targets share one `b-<uuid>` block ID",
                ));
            }
            if djot_quote_depth(body) > MAX_TARGET_DEPTH {
                return Err(PdcDiagnostic::new(
                    DiagnosticKind::DocumentTooComplex,
                    format!("block nesting exceeds the {MAX_TARGET_DEPTH}-container limit"),
                ));
            }
            Ok((ids, false))
        }
        DocumentExt::Html => {
            let scan = scan_html_body(body);
            if scan.unsafe_found {
                return Err(PdcDiagnostic::new(
                    DiagnosticKind::UnsafeContent,
                    "HTML body contains executable or otherwise nonconforming constructs",
                ));
            }
            if duplicate_block_id(&scan.block_ids) {
                return Err(PdcDiagnostic::new(
                    DiagnosticKind::DuplicateBlockId,
                    "two elements share one `b-<uuid>` id",
                ));
            }
            Ok((scan.block_ids, false))
        }
        DocumentExt::Markdown => unreachable!("markdown bodies are validated by classify_v2"),
    }
}

/// Guarded save: refuse to overwrite bytes that changed externally
/// since editing began (PDC §10.3).
///
/// Returns `next` on success so callers persist exactly the approved
/// bytes, or an [`DiagnosticKind::ExternalChangeConflict`] diagnostic.
pub fn save_guarded(
    snapshot: &[u8],
    current: &[u8],
    next: Vec<u8>,
) -> Result<Vec<u8>, PdcDiagnostic> {
    if snapshot != current {
        return Err(PdcDiagnostic::new(
            DiagnosticKind::ExternalChangeConflict,
            "source bytes changed externally since editing began",
        ));
    }
    Ok(next)
}

/// Render one scalar envelope value with minimal quoting.
///
/// The quoting rule mirrors the emitter's: anything that would re-parse
/// as a different shape or carries structural characters is wrapped in
/// double quotes. SPEC.md remains normative for full rules.
fn render_value(value: &str) -> String {
    let needs_quote = value.is_empty()
        || value.trim() != value
        || value == "true"
        || value == "false"
        || value.contains(": ")
        || value.contains(" #")
        || value
            .chars()
            .any(|c| matches!(c, '[' | ']' | '{' | '}' | '"' | '\'' | ',' | '|'));
    if needs_quote {
        let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
        format!("\"{escaped}\"")
    } else {
        value.to_string()
    }
}

/// Patch envelope metadata in place, preserving body bytes and every
/// untouched envelope byte (PDC §10.1).
///
/// Existing keys are rewritten on their original lines, preserving the
/// key spelling and the whitespace run after the colon; missing keys are
/// appended at the end of the envelope. A patch that changes nothing
/// returns the input unchanged (no-op writes are byte-identical).
pub fn patch_metadata(
    ext: DocumentExt,
    bytes: &[u8],
    patch: &[(&str, &str)],
) -> Result<Vec<u8>, PdcDiagnostic> {
    let text = std::str::from_utf8(bytes).map_err(|_| {
        PdcDiagnostic::new(
            DiagnosticKind::InvalidTransport,
            "document is not valid UTF-8",
        )
    })?;
    // Validate first: patching an invalid document is refused.
    match classify(ext, bytes) {
        Classification::Valid(_) => {}
        Classification::LegacyHtml => {
            return Err(PdcDiagnostic::new(
                DiagnosticKind::InvalidTransport,
                "legacy HTML has no PDC envelope to patch",
            ));
        }
        Classification::LegacyMarkdown => {
            return Err(PdcDiagnostic::new(
                DiagnosticKind::InvalidTransport,
                "plain Markdown has no PDC envelope to patch",
            ));
        }
        Classification::Invalid(d) => return Err(d),
    }
    let lines = split_lines(text);
    let span = match ext {
        DocumentExt::Djot => envelope_span_djot(&lines)?,
        DocumentExt::Html => envelope_span_html(&lines)?,
        DocumentExt::Markdown => envelope_span_markdown(&lines)?.ok_or_else(|| {
            PdcDiagnostic::new(
                DiagnosticKind::InvalidTransport,
                "plain Markdown has no PDC envelope to patch",
            )
        })?,
    };

    // Map existing envelope keys to line indices (first occurrence wins;
    // duplicates were rejected by classification).
    let mut key_lines: Vec<(String, usize)> = Vec::new();
    for (i, line) in lines[span.first..span.last].iter().enumerate() {
        let content = line.normalized();
        if let Some(colon) = content.find(':') {
            key_lines.push((content[..colon].to_string(), span.first + i));
        }
    }

    let mut edits: Vec<(usize, String)> = Vec::new();
    let mut append_missing: Vec<String> = Vec::new();
    for (key, value) in patch {
        let rendered = render_value(value);
        match key_lines.iter().find(|(k, _)| k == key) {
            Some((_, line_idx)) => {
                let line = &lines[*line_idx];
                let content = line.normalized();
                let colon = content.find(':').expect("colon found during scan");
                // Preserve key spelling and the whitespace run after the
                // colon; replace only the value.
                let ws_end = content[colon + 1..]
                    .char_indices()
                    .take_while(|(_, c)| c.is_whitespace())
                    .map(|(i, c)| i + c.len_utf8())
                    .last()
                    .unwrap_or(0);
                let new_content = format!(
                    "{}{}{}",
                    &content[..=colon],
                    &content[colon + 1..colon + 1 + ws_end],
                    rendered
                );
                if new_content != content {
                    edits.push((*line_idx, new_content));
                }
            }
            None => append_missing.push(format!("{key}: {rendered}")),
        }
    }

    // Rebuild in file order even when the patch arrives unordered.
    edits.sort_by_key(|(idx, _)| *idx);

    if edits.is_empty() && append_missing.is_empty() {
        // No-op: byte-identical (PDC §10.1).
        return Ok(bytes.to_vec());
    }

    let mut out = Vec::with_capacity(bytes.len());
    let mut cursor = 0usize;
    for (line_idx, new_content) in &edits {
        let line = &lines[*line_idx];
        out.extend_from_slice(&bytes[cursor..line.start]);
        out.extend_from_slice(new_content.as_bytes());
        cursor = line.end;
    }
    if !append_missing.is_empty() {
        let close_line = &lines[span.last];
        out.extend_from_slice(&bytes[cursor..close_line.start]);
        let mut block = String::new();
        for item in &append_missing {
            block.push_str(item);
            block.push('\n');
        }
        out.extend_from_slice(block.as_bytes());
        cursor = close_line.start;
    }
    out.extend_from_slice(&bytes[cursor..]);
    Ok(out)
}
impl Classification {
    /// Diagnostic kind of an invalid classification, for tests and
    /// diagnostics plumbing.
    pub fn invalid_kind(&self) -> Option<DiagnosticKind> {
        match self {
            Classification::Invalid(d) => Some(d.kind),
            _ => None,
        }
    }
}

impl Value {
    /// String literal content of a [`Value::Str`].
    fn as_str_lit(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s),
            _ => None,
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL: &str = "---\nformat: pdc-document/1\nbody: pdc-djot/1\nid: 018f47c6-4a77-7c52-9db8-0e5f9bcb17db\ncreated: 2026-09-13T12:34:56.789Z\nupdated: 2026-09-13T12:34:56.789Z\ntitle: Minimal\n---\n# Minimal\n";

    #[test]
    fn minimal_djot_classifies_valid() {
        let out = classify(DocumentExt::Djot, MINIMAL.as_bytes());
        let Classification::Valid(doc) = out else {
            panic!("expected valid: {out:?}");
        };
        assert_eq!(doc.profile, BodyProfile::Djot);
        assert_eq!(
            doc.body_range,
            MINIMAL.find("# Minimal").unwrap()..MINIMAL.len()
        );
    }

    #[test]
    fn bom_is_invalid_transport() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(MINIMAL.as_bytes());
        assert_eq!(
            classify(DocumentExt::Djot, &bytes),
            Classification::Invalid(PdcDiagnostic::new(
                DiagnosticKind::InvalidTransport,
                "byte-order mark present; canonical documents are UTF-8 without a BOM"
            ))
        );
    }

    #[test]
    fn html_transport_valid_and_legacy() {
        let doc = "<!--\n---\nformat: pdc-document/1\nbody: pdc-html/1\nid: 018f47c6-4a77-7c52-9db8-0e5f9bcb1701\ncreated: 2026-09-13T12:34:56.789Z\nupdated: 2026-09-13T12:34:56.789Z\ntitle: H\n---\n-->\n<h1>H</h1>\n";
        assert!(matches!(
            classify(DocumentExt::Html, doc.as_bytes()),
            Classification::Valid(_)
        ));
        assert_eq!(
            classify(DocumentExt::Html, b"<h1>legacy</h1>\n"),
            Classification::LegacyHtml
        );
    }

    #[test]
    fn deleted_pairing_and_timestamps() {
        let bad = MINIMAL.replace("title: Minimal\n---", "title: Minimal\ndeleted: true\n---");
        assert_eq!(
            classify(DocumentExt::Djot, bad.as_bytes())
                .invalid_kind()
                .unwrap(),
            DiagnosticKind::InvalidEnvelope
        );
        let feb30 = MINIMAL
            .replace(
                "created: 2026-09-13T12:34:56.789Z",
                "created: 2026-02-30T12:34:56.789Z",
            )
            .replace(
                "updated: 2026-09-13T12:34:56.789Z",
                "updated: 2026-03-30T12:34:56.789Z",
            );
        assert_eq!(
            classify(DocumentExt::Djot, feb30.as_bytes())
                .invalid_kind()
                .unwrap(),
            DiagnosticKind::InvalidEnvelope
        );
    }

    #[test]
    fn metadata_patch_is_envelope_only_and_noop_safe() {
        let patched =
            patch_metadata(DocumentExt::Djot, MINIMAL.as_bytes(), &[("title", "After")]).unwrap();
        let expected = MINIMAL.replace("title: Minimal", "title: After");
        assert_eq!(patched, expected.as_bytes());
        let noop = patch_metadata(
            DocumentExt::Djot,
            MINIMAL.as_bytes(),
            &[("title", "Minimal")],
        )
        .unwrap();
        assert_eq!(noop, MINIMAL.as_bytes());
    }

    #[test]
    fn guarded_save_blocks_external_change() {
        let changed = MINIMAL.replace("# Minimal", "# Changed");
        let err = save_guarded(MINIMAL.as_bytes(), changed.as_bytes(), Vec::new())
            .err()
            .unwrap();
        assert_eq!(err.kind, DiagnosticKind::ExternalChangeConflict);
        assert!(save_guarded(MINIMAL.as_bytes(), MINIMAL.as_bytes(), b"x".to_vec()).is_ok());
    }

    #[test]
    fn html_unsafe_and_duplicate_ids() {
        let mk = |body: &str| {
            format!(
                "<!--\n---\nformat: pdc-document/1\nbody: pdc-html/1\nid: 018f47c6-4a77-7c52-9db8-0e5f9bcb1706\ncreated: 2026-09-13T12:34:56.789Z\nupdated: 2026-09-13T12:34:56.789Z\ntitle: T\n---\n-->\n{body}"
            )
        };
        let unsafe_doc = mk("<script>a</script><p onclick=\"x()\">y</p>\n");
        assert_eq!(
            classify(DocumentExt::Html, unsafe_doc.as_bytes())
                .invalid_kind()
                .unwrap(),
            DiagnosticKind::UnsafeContent
        );
        let dup = mk(
            "<h1 id=\"b-018f47c6-7dbe-7a14-9f67-6f89a5e3c171\">A</h1>\n<p id=\"b-018f47c6-7dbe-7a14-9f67-6f89a5e3c171\">B</p>\n",
        );
        assert_eq!(
            classify(DocumentExt::Html, dup.as_bytes())
                .invalid_kind()
                .unwrap(),
            DiagnosticKind::DuplicateBlockId
        );
    }
}
