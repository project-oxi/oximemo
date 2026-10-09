//! Read-only PDC vault inventory (Stage 1 of `docs/PDC-MIGRATION.md`).
//!
//! [`scan`] walks a vault root and classifies every visible PDC-plane
//! file (lowercase `.md`, `.html`, `.djot`, `.base`) through the Stage 0
//! gates in `oxi_frontmatter::pdc`, resolving `pdc://document/<uuid>`
//! references within the inventory and `pdc://asset/sha256/<digest>`
//! references against the canonical `.pdc/assets/sha256/<first2>/`
//! layout and the actual SHA-256 of the stored bytes.
//!
//! The scan is strictly read-only: no file is rewritten, converted,
//! normalized, or executed (`.base` queries are classified, never run),
//! and `.pdc/vault.json` is read, never modified. The module is
//! independent of [`crate::Vault`] so memo/index behavior is untouched;
//! the desktop layer consumes the serde DTOs directly.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use oxi_frontmatter::pdc::{
    Classification, DiagnosticKind, DocumentExt, PdcDiagnostic, QueryClassification, classify,
    classify_query,
};
use serde::{Deserialize, Serialize};

use crate::paths::Paths;
use crate::{CoreError, Result};

/// PDC control directory at the vault root.
const PDC_DIR: &str = ".pdc";
/// Vault-level manifest declaring the enabled document-plane contracts.
const MANIFEST_NAME: &str = "vault.json";
/// Vault-level query contract identifier (PDC-QUERY-1.0).
const QUERY_CONTRACT: &str = "pdc-query/1";
/// PDC vault manifest transport cap; manifests are small control files.
const MAX_MANIFEST_BYTES: usize = 64 * 1024;
const MAX_QUERY_BYTES: usize = 1024 * 1024;
const MAX_MANAGED_ASSET_BYTES: u64 = 64 * 1024 * 1024;

/// Diagnostic code for a malformed or unreadable `.pdc/vault.json`.
const DIAG_INVALID_MANIFEST: &str = "invalid_manifest";
/// Diagnostic code for a `.pdc` directory without a readable manifest.
const DIAG_MISSING_MANIFEST: &str = "missing_manifest";

/// One inventory diagnostic in machine-readable form.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PdcDiagnosticDto {
    /// Stable snake_case outcome class (PDC §13 or inventory-local).
    pub code: String,
    /// Human-readable explanation.
    pub message: String,
    /// 1-indexed source line when the failure has a location.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
}

impl PdcDiagnosticDto {
    fn from_pdc(d: &PdcDiagnostic) -> Self {
        Self {
            code: d.kind.as_str().to_string(),
            message: d.message.clone(),
            line: d.line,
        }
    }
}

/// One duplicate canonical document ID and every path claiming it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PdcDuplicateId {
    /// The duplicated canonical lowercase hyphenated UUID.
    pub document_id: String,
    /// Vault-relative paths, sorted.
    pub paths: Vec<String>,
}

/// A single discovered PDC-plane file and its read-only outcome.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PdcInventoryEntry {
    /// Path relative to the vault root, `/`-separated.
    pub path: String,
    /// Outcome class (snake_case).
    pub class: PdcEntryClass,
    /// Canonical document UUID (valid documents only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document_id: Option<String>,
    /// Envelope `title` (valid documents with a title only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Exact contract identifier of the declared body profile.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_profile: Option<String>,
    /// File size in bytes.
    pub size_bytes: u64,
    /// Classification or inventory failure, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<PdcDiagnosticDto>,
    /// `pdc://document/<uuid>` targets not present in this inventory.
    pub broken_document_links: Vec<String>,
    /// `pdc://asset/sha256/<digest>` references whose canonical asset is
    /// missing, has a non-canonical digest, or whose stored bytes do not
    /// hash to the promised digest.
    pub missing_assets: Vec<String>,
}

/// Outcome class of one inventory entry (snake_case in JSON).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PdcEntryClass {
    /// Canonical `pdc-document/2` document.
    Document,
    /// Readable legacy `pdc-document/1` document.
    LegacyDocument,
    /// `.md` without the exact frontmatter transport (plain Markdown).
    LegacyMarkdown,
    /// `.html` without the exact opening transport.
    LegacyHtml,
    /// Canonical-transport document that failed validation.
    Invalid,
    /// Canonical-transport document declaring an unsupported version.
    Unsupported,
    /// `.base` query that fully conforms to `pdc-query/1`.
    Query,
    /// `.base` query that parses but carries unknown-but-preserved
    /// constructs: visible, never executed.
    QueryValidUnexecuted,
    /// `.base` query that failed `pdc-query/1` validation.
    InvalidQuery,
}

impl PdcEntryClass {
    /// Stable snake_case name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Document => "document",
            Self::LegacyDocument => "legacy_document",
            Self::LegacyMarkdown => "legacy_markdown",
            Self::LegacyHtml => "legacy_html",
            Self::Invalid => "invalid",
            Self::Unsupported => "unsupported",
            Self::Query => "query",
            Self::QueryValidUnexecuted => "query_valid_unexecuted",
            Self::InvalidQuery => "invalid_query",
        }
    }
}

/// Read-only inventory of one vault's PDC document plane.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PdcInventory {
    /// Whether `.pdc/vault.json` declares `query: pdc-query/1`.
    pub query_enabled: bool,
    /// Manifest problem, when `.pdc` exists but the manifest is
    /// missing, malformed, or misshapen.
    pub manifest_diagnostic: Option<PdcDiagnosticDto>,
    /// Canonical IDs claimed by more than one visible document.
    pub duplicate_ids: Vec<PdcDuplicateId>,
    /// Every visible PDC-plane file, sorted by path.
    pub items: Vec<PdcInventoryEntry>,
}

/// A guarded source read for one UTF-8 inventory file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PdcSource {
    /// The requested vault-relative path.
    pub path: String,
    /// Exact UTF-8 file content; the vault file is the source of truth.
    pub content: String,
    /// SHA-256 of the exact source bytes (`sha256:<hex>`), used for guarded writes.
    pub sha256: String,
    /// Canonical document UUID, when this is a valid PDC 2 document.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub document_id: Option<String>,
    /// Parsed source body for canonical PDC 2 Markdown/HTML only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub editable_body: Option<String>,
    /// Parsed envelope title for canonical PDC 2 Markdown/HTML only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Canonical body profile, when this is a valid PDC 2 document.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_profile: Option<String>,
}

/// Read and validate the read-only PDC vault manifest.
fn read_manifest(vault: &Path) -> (bool, Option<PdcDiagnosticDto>) {
    let invalid = |message: String| {
        (
            false,
            Some(PdcDiagnosticDto {
                code: DIAG_INVALID_MANIFEST.to_string(),
                message,
                line: None,
            }),
        )
    };
    let missing = || {
        (
            false,
            Some(PdcDiagnosticDto {
                code: DIAG_MISSING_MANIFEST.to_string(),
                message: format!("{PDC_DIR} exists but {MANIFEST_NAME} is missing"),
                line: None,
            }),
        )
    };

    match fs::symlink_metadata(vault) {
        Ok(meta) if !meta.is_symlink() && meta.is_dir() => {}
        Ok(_) => return invalid("vault root is not a regular directory".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (false, None),
        Err(e) => return invalid(format!("vault root is unreadable: {e}")),
    }

    let pdc_dir = vault.join(PDC_DIR);
    match fs::symlink_metadata(&pdc_dir) {
        Ok(meta) if !meta.is_symlink() && meta.is_dir() => {}
        Ok(_) => return invalid(format!("{PDC_DIR} is not a regular directory")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (false, None),
        Err(e) => return invalid(format!("{PDC_DIR} is unreadable: {e}")),
    }

    let manifest = pdc_dir.join(MANIFEST_NAME);
    let manifest_meta = match fs::symlink_metadata(&manifest) {
        Ok(meta) if !meta.is_symlink() && meta.is_file() => meta,
        Ok(_) => return invalid(format!("{MANIFEST_NAME} is not a regular file")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return missing(),
        Err(e) => return invalid(format!("{MANIFEST_NAME} is unreadable: {e}")),
    };
    if manifest_meta.len() > MAX_MANIFEST_BYTES as u64 {
        return invalid(format!(
            "{MANIFEST_NAME} exceeds the {MAX_MANIFEST_BYTES}-byte limit"
        ));
    }
    let mut bytes = Vec::with_capacity(manifest_meta.len() as usize);
    if let Err(e) = fs::File::open(&manifest).and_then(|file| {
        use std::io::Read;
        file.take((MAX_MANIFEST_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
    }) {
        return invalid(format!("{MANIFEST_NAME} is unreadable: {e}"));
    }
    if bytes.len() > MAX_MANIFEST_BYTES {
        return invalid(format!(
            "{MANIFEST_NAME} exceeds the {MAX_MANIFEST_BYTES}-byte limit"
        ));
    }
    let text = match std::str::from_utf8(&bytes) {
        Ok(t) => t,
        Err(e) => {
            return invalid(format!("{MANIFEST_NAME} is not valid UTF-8: {e}"));
        }
    };
    let root: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(e) => return invalid(format!("{MANIFEST_NAME} is not valid JSON: {e}")),
    };
    let Some(obj) = root.as_object() else {
        return invalid(format!("{MANIFEST_NAME} root must be a JSON object"));
    };
    if obj.get("format").and_then(serde_json::Value::as_str) != Some("pdc-vault/1") {
        return invalid("manifest `format` must be `pdc-vault/1`".into());
    }
    let Some(id) = obj.get("id").and_then(serde_json::Value::as_str) else {
        return invalid("manifest `id` must be a canonical lowercase UUID".into());
    };
    if !is_canonical_uuid(id) {
        return invalid("manifest `id` must be a canonical lowercase UUID".into());
    }
    let Some(created) = obj.get("created").and_then(serde_json::Value::as_str) else {
        return invalid("manifest `created` must be a canonical UTC timestamp".into());
    };
    if !is_canonical_timestamp(created) {
        return invalid("manifest `created` must be a canonical UTC millisecond timestamp".into());
    }

    match obj.get("query") {
        None => (false, None),
        Some(v) if v.as_str() == Some(QUERY_CONTRACT) => (true, None),
        Some(other) => invalid(format!(
            "manifest `query` must be the string {QUERY_CONTRACT:?}; got {other}"
        )),
    }
}

/// `true` when a path component must be excluded from discovery.
fn excluded_component(name: &std::ffi::OsStr) -> bool {
    let Some(name) = name.to_str() else {
        return true; // non-UTF-8 names are outside the document plane
    };
    name.starts_with('.')
}

/// Recursively collect visible regular files, sorted for determinism.
///
/// Dot-prefixed path components (including `.pdc` and `.trash`) are
/// excluded, and symlinks are never followed: a symlinked file or
/// directory is simply invisible to the inventory.
fn walk(dir: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
    let metadata = fs::symlink_metadata(dir)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(CoreError::other(format!(
            "vault path is not a regular directory: {}",
            dir.display()
        )));
    }
    let mut entries: Vec<_> = fs::read_dir(dir)
        .map_err(|e| CoreError::other(format!("cannot read {}: {e}", dir.display())))?
        .collect::<std::io::Result<Vec<_>>>()
        .map_err(CoreError::Io)?;
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = entry.file_name();
        if excluded_component(&name) {
            continue;
        }
        let path = dir.join(&name);
        // `symlink_metadata` inspects the link itself: symlinked files
        // and directories are never followed (PDC exclusions).
        let meta = fs::symlink_metadata(&path)?;
        if meta.is_symlink() {
            continue;
        }
        if meta.is_dir() {
            walk(&path, out)?;
        } else if meta.is_file() && is_inventory_extension(&name) {
            out.push(path);
        }
    }
    Ok(())
}

/// Exact lowercase extensions; filename stems may use any Unicode case.
fn is_inventory_extension(name: &std::ffi::OsStr) -> bool {
    matches!(
        Path::new(name).extension().and_then(|ext| ext.to_str()),
        Some("md" | "html" | "djot" | "base")
    )
}

/// Remove opaque code/comment regions before extracting links. Links in
/// examples are source text, not references from the document.
fn reference_source(text: &str) -> String {
    static HTML_COMMENTS: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?s)<!--.*?-->").expect("valid HTML comment regex")
    });
    static HTML_OPAQUE: std::sync::LazyLock<[regex::Regex; 4]> = std::sync::LazyLock::new(|| {
        [
            regex::Regex::new(r"(?is)<pre\b[^>]*>.*?</pre\s*>").expect("valid pre regex"),
            regex::Regex::new(r"(?is)<code\b[^>]*>.*?</code\s*>").expect("valid code regex"),
            regex::Regex::new(r"(?is)<script\b[^>]*>.*?</script\s*>").expect("valid script regex"),
            regex::Regex::new(r"(?is)<style\b[^>]*>.*?</style\s*>").expect("valid style regex"),
        ]
    });

    let mut source = strip_markdown_code(text);
    source = HTML_COMMENTS.replace_all(&source, " ").into_owned();
    for pattern in HTML_OPAQUE.iter() {
        source = pattern.replace_all(&source, " ").into_owned();
    }
    source
}

/// Strip fenced and inline Markdown code without changing non-code text.
fn strip_markdown_code(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut fence: Option<(u8, usize)> = None;
    for line in text.split_inclusive('\n') {
        let content = line.strip_suffix('\n').unwrap_or(line);
        if let Some((character, length)) = fence {
            if closes_fence(content, character, length) {
                fence = None;
            }
        } else if let Some(open) = opens_fence(content) {
            fence = Some(open);
        } else {
            output.push_str(&strip_inline_code(content));
        }
        if line.ends_with('\n') {
            output.push('\n');
        }
    }
    output
}

fn opens_fence(line: &str) -> Option<(u8, usize)> {
    let indent = line.bytes().take_while(|b| *b == b' ').count();
    if indent > 3 {
        return None;
    }
    let bytes = line.as_bytes();
    let character = *bytes.get(indent)?;
    if character != b'`' && character != b'~' {
        return None;
    }
    let length = bytes[indent..]
        .iter()
        .take_while(|b| **b == character)
        .count();
    (length >= 3).then_some((character, length))
}

fn closes_fence(line: &str, character: u8, length: usize) -> bool {
    let indent = line.bytes().take_while(|b| *b == b' ').count();
    if indent > 3 {
        return false;
    }
    let bytes = line.as_bytes();
    let count = bytes[indent..]
        .iter()
        .take_while(|b| **b == character)
        .count();
    count >= length && bytes[indent + count..].iter().all(u8::is_ascii_whitespace)
}

fn strip_inline_code(line: &str) -> String {
    let bytes = line.as_bytes();
    let mut output = String::with_capacity(line.len());
    let mut cursor = 0;
    while let Some(offset) = bytes[cursor..].iter().position(|b| *b == b'`') {
        let start = cursor + offset;
        output.push_str(&line[cursor..start]);
        let run_end = start + bytes[start..].iter().take_while(|b| **b == b'`').count();
        let run_length = run_end - start;
        let mut probe = run_end;
        let mut closing = None;
        while probe < bytes.len() {
            let Some(offset) = bytes[probe..].iter().position(|b| *b == b'`') else {
                break;
            };
            let candidate = probe + offset;
            let candidate_end = candidate
                + bytes[candidate..]
                    .iter()
                    .take_while(|b| **b == b'`')
                    .count();
            if candidate_end - candidate == run_length {
                closing = Some(candidate_end);
                break;
            }
            probe = candidate_end;
        }
        if let Some(end) = closing {
            cursor = end;
        } else {
            output.push_str(&line[start..run_end]);
            cursor = run_end;
        }
    }
    output.push_str(&line[cursor..]);
    output
}

/// Extract document URI tokens so malformed UUIDs and fragments remain
/// visible as broken-link diagnostics rather than disappearing.
fn document_refs(text: &str) -> Vec<String> {
    const PREFIX: &str = "pdc://document/";
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(i) = rest.find(PREFIX) {
        let after = &rest[i + PREFIX.len()..];
        let token = after
            .split([
                ')', '>', '"', '\'', ' ', '\t', '\n', '\r', '<', '`', ']', '}',
            ])
            .next()
            .unwrap_or("")
            .trim_end_matches(['.', ',', ';', ':', '!']);
        let uri = format!("{PREFIX}{token}");
        if !out.contains(&uri) {
            out.push(uri);
        }
        rest = after;
    }
    out
}

/// Split a `pdc://document/<uuid>[#b-<uuid>]` token into its UUID and
/// fragment parts.
fn split_uuid_fragment(token: &str) -> Option<(&str, Option<&str>)> {
    match token.split_once('#') {
        Some((uuid, fragment)) => Some((uuid, Some(fragment))),
        None => Some((token, None)),
    }
}

fn is_canonical_block_fragment(fragment: &str) -> bool {
    fragment.strip_prefix("b-").is_some_and(is_canonical_uuid)
}

/// One relative or noncanonical reference found in a document body.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RelativeRef {
    /// Target as written (fragment/query preserved).
    raw: String,
    /// Decoded vault-relative path, or empty for forbidden absolute/scheme targets.
    path: String,
    /// Whether the target looks like a document path rather than an asset.
    is_document: bool,
    /// Optional block fragment used by local document links.
    fragment: Option<String>,
}

/// Extract Markdown/Djot inline links and HTML navigation/embed attributes.
/// HTTP(S) and mailto targets are external; file/data/other schemes and
/// absolute paths are retained as noncanonical references.
fn relative_refs(text: &str) -> Vec<RelativeRef> {
    let mut refs = Vec::new();
    for raw in markdown_link_targets(text)
        .into_iter()
        .chain(html_reference_targets(text))
    {
        let raw = raw.trim().to_string();
        if raw.is_empty()
            || raw.starts_with("pdc://document/")
            || raw.starts_with("pdc://asset/sha256/")
            || raw
                .get(..7)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("http://"))
            || raw
                .get(..8)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("https://"))
            || raw
                .get(..7)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("mailto:"))
        {
            continue;
        }
        let fragment = raw
            .split_once('#')
            .map(|(_, fragment)| fragment.to_string());
        if raw.starts_with('#') {
            if fragment
                .as_deref()
                .is_some_and(|value| value.starts_with('^') || value.starts_with("b-"))
            {
                refs.push(RelativeRef {
                    raw,
                    path: String::new(),
                    is_document: true,
                    fragment,
                });
            }
            continue;
        }
        let path_end = raw.find(['#', '?']).unwrap_or(raw.len());
        let encoded_path = &raw[..path_end];
        if encoded_path.is_empty() {
            continue;
        }
        let is_document = is_document_path(encoded_path);
        let forbidden_target = has_scheme(&raw)
            || raw.starts_with('/')
            || raw.starts_with('\\')
            || raw.starts_with('~');
        let path = if forbidden_target {
            String::new()
        } else {
            percent_decode_path(encoded_path).unwrap_or_default()
        };
        if !refs.iter().any(|item: &RelativeRef| item.raw == raw) {
            refs.push(RelativeRef {
                raw,
                path,
                is_document,
                fragment,
            });
        }
    }
    refs
}

fn markdown_link_targets(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut cursor = 0;
    while cursor + 1 < bytes.len() {
        let Some(offset) = text[cursor..].find("](") else {
            break;
        };
        let open = cursor + offset + 2;
        let mut start = open;
        while bytes.get(start).is_some_and(u8::is_ascii_whitespace) {
            start += 1;
        }
        let target = if bytes.get(start) == Some(&b'<') {
            let target_start = start + 1;
            let close = bytes[target_start..]
                .iter()
                .position(|b| *b == b'>')
                .map(|offset| target_start + offset);
            close.map(|end| (text[target_start..end].to_string(), end + 1))
        } else {
            let mut index = start;
            let mut nested = 0usize;
            while index < bytes.len() {
                match bytes[index] {
                    b'(' => nested += 1,
                    b')' if nested == 0 => break,
                    b')' => nested -= 1,
                    byte if byte.is_ascii_whitespace() && nested == 0 => break,
                    _ => {}
                }
                index += 1;
            }
            (index > start).then(|| (text[start..index].to_string(), index))
        };
        if let Some((target, end)) = target {
            if !target.is_empty() {
                out.push(target);
            }
            cursor = end;
        } else {
            cursor = open;
        }
    }
    out
}

fn html_reference_targets(text: &str) -> Vec<String> {
    static ATTRIBUTE_RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(
            r#"(?i)\b(?:href|src|xlink:href|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))"#,
        )
        .expect("valid HTML reference attribute regex")
    });
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut cursor = 0;
    while let Some(offset) = bytes[cursor..].iter().position(|b| *b == b'<') {
        let start = cursor + offset;
        let mut quote = None;
        let mut end = start + 1;
        while end < bytes.len() {
            let byte = bytes[end];
            if let Some(open) = quote {
                if byte == open {
                    quote = None;
                }
            } else if byte == b'\'' || byte == b'"' {
                quote = Some(byte);
            } else if byte == b'>' {
                break;
            }
            end += 1;
        }
        if end == bytes.len() {
            break;
        }
        let tag = &text[start + 1..end];
        if !tag.starts_with('/') && !tag.starts_with('!') && !tag.starts_with('?') {
            for captures in ATTRIBUTE_RE.captures_iter(tag) {
                if let Some(value) = captures
                    .get(1)
                    .or_else(|| captures.get(2))
                    .or_else(|| captures.get(3))
                {
                    out.push(value.as_str().to_string());
                }
            }
        }
        cursor = end + 1;
    }
    out
}

fn is_document_path(path: &str) -> bool {
    matches!(
        Path::new(path)
            .extension()
            .and_then(|extension| extension.to_str()),
        Some("md" | "html" | "djot")
    )
}

fn percent_decode_path(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut cursor = 0;
    while cursor < bytes.len() {
        if bytes[cursor] == b'%' {
            let high = *bytes.get(cursor + 1)?;
            let low = *bytes.get(cursor + 2)?;
            decoded.push((hex_value(high)? << 4) | hex_value(low)?);
            cursor += 3;
        } else {
            decoded.push(bytes[cursor]);
            cursor += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Return `true` for any URI-scheme prefix, not only `scheme://`.
fn has_scheme(target: &str) -> bool {
    let Some((scheme, _)) = target.split_once(':') else {
        return false;
    };
    let mut chars = scheme.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
}

/// Extract canonical `pdc://asset/sha256/<digest>` references, paired
/// with their promised digest (when the digest is well-formed).
fn asset_refs(text: &str) -> Vec<(String, Option<String>)> {
    const PREFIX: &str = "pdc://asset/sha256/";
    let mut out: Vec<(String, Option<String>)> = Vec::new();
    let mut rest = text;
    while let Some(i) = rest.find(PREFIX) {
        let after = &rest[i + PREFIX.len()..];
        let token = after
            .split([
                ')', '>', '"', '\'', ' ', '\t', '\n', '\r', '<', '`', ']', '}',
            ])
            .next()
            .unwrap_or("")
            .trim_end_matches(['.', ',', ';', ':', '!'])
            .to_string();
        let uri = format!("{PREFIX}{token}");
        let digest = if token.len() == 64
            && token
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            Some(token.clone())
        } else {
            None
        };
        if !out.iter().any(|(u, _)| *u == uri) {
            out.push((uri, digest));
        }
        rest = after;
    }
    out
}

/// Canonical lowercase UUID spelling, version 1–8 and RFC 4122 variant.
/// Shared with the manifest writer in [`crate::pdc_documents`] so
/// writer-created manifests are never rejected by the inventory reader.
pub(crate) fn is_canonical_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 36 {
        return false;
    }
    for (i, c) in b.iter().enumerate() {
        match i {
            8 | 13 | 18 | 23 if *c == b'-' => {}
            14 if (b'1'..=b'8').contains(c) => {}
            19 if matches!(c, b'8' | b'9' | b'a' | b'b') => {}
            8 | 13 | 18 | 23 | 14 | 19 => return false,
            _ if c.is_ascii_digit() || (b'a'..=b'f').contains(c) => {}
            _ => return false,
        }
    }
    true
}

/// Canonical PDC timestamp: UTC, exact milliseconds, and real calendar time.
fn is_canonical_timestamp(s: &str) -> bool {
    let fmt = time::macros::format_description!(
        "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
    );
    time::PrimitiveDateTime::parse(s, &fmt).is_ok()
}

/// Canonical on-disk path of a SHA-256-addressed asset.
fn canonical_asset_path(vault: &Path, digest: &str) -> PathBuf {
    vault
        .join(PDC_DIR)
        .join("assets")
        .join("sha256")
        .join(&digest[..2])
        .join(digest)
}

/// Resolve a vault-relative regular file without following symlinked
/// components. Hidden components are allowed only for internal callers
/// such as managed-asset verification; user-facing reads validate them
/// separately.
fn regular_file_without_symlinks(vault: &Path, relative: &Path) -> Option<PathBuf> {
    let root_meta = fs::symlink_metadata(vault).ok()?;
    if root_meta.is_symlink() || !root_meta.is_dir() {
        return None;
    }
    let components: Vec<_> = relative.components().collect();
    if components.is_empty() {
        return None;
    }
    let mut path = vault.to_path_buf();
    for (index, component) in components.iter().enumerate() {
        let std::path::Component::Normal(name) = component else {
            return None;
        };
        path.push(name);
        let meta = fs::symlink_metadata(&path).ok()?;
        if meta.file_type().is_symlink() {
            return None;
        }
        if index + 1 == components.len() {
            if !meta.is_file() {
                return None;
            }
        } else if !meta.is_dir() {
            return None;
        }
    }
    Some(path)
}

/// Resolve managed assets against the canonical layout and verify each
/// digest without loading asset bytes into memory. `verified` memoizes the
/// verdict per digest for the duration of one `scan`, so an asset shared
/// across many documents is read and hashed once per scan.
fn missing_assets(vault: &Path, text: &str, verified: &mut BTreeMap<String, bool>) -> Vec<String> {
    let mut broken = Vec::new();
    for (uri, digest) in asset_refs(text) {
        let Some(digest) = digest else {
            broken.push(uri);
            continue;
        };
        if let Some(&intact) = verified.get(&digest) {
            if !intact {
                broken.push(uri);
            }
            continue;
        }
        let intact = verify_asset(vault, &digest);
        verified.insert(digest, intact);
        if !intact {
            broken.push(uri);
        }
    }
    broken
}

/// Verify one SHA-256-addressed managed asset: canonical path, size, and
/// stored digest. Returns `false` when any check fails.
fn verify_asset(vault: &Path, digest: &str) -> bool {
    use sha2::{Digest, Sha256};
    use std::io::Read;

    let abs_path = canonical_asset_path(vault, digest);
    let Some(relative) = abs_path.strip_prefix(vault).ok() else {
        return false;
    };
    let Some(path) = regular_file_without_symlinks(vault, relative) else {
        return false;
    };
    let Ok(meta) = fs::symlink_metadata(&path) else {
        return false;
    };
    if meta.len() > MAX_MANAGED_ASSET_BYTES {
        return false;
    }
    let Ok(mut file) = fs::File::open(&path) else {
        return false;
    };
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 32 * 1024];
    let mut size = 0u64;
    loop {
        match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                size += count as u64;
                if size > MAX_MANAGED_ASSET_BYTES {
                    return false;
                }
                hasher.update(&buffer[..count]);
            }
            Err(_) => return false,
        }
    }
    format!("{:x}", hasher.finalize()) == digest
}

/// Read only enough bytes to classify one inventory file, retaining the
/// actual file size for diagnostics and the desktop listing.
fn read_bounded_source(path: &Path, max_bytes: usize) -> Result<(u64, Vec<u8>)> {
    use std::io::Read;

    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(CoreError::other("inventory source is not a regular file"));
    }
    let mut bytes = Vec::with_capacity(metadata.len().min((max_bytes + 1) as u64) as usize);
    fs::File::open(path)?
        .take((max_bytes + 1) as u64)
        .read_to_end(&mut bytes)?;
    Ok((metadata.len(), bytes))
}
/// Classify one discovered non-query file and preserve parsed target IDs.
///
/// Returns the inventory entry, text scanned for references, and parsed
/// block targets for resolution after all target paths are known.
fn classify_entry(
    rel_path: &str,
    bytes: &[u8],
    ext: DocumentExt,
    size_bytes: u64,
) -> (PdcInventoryEntry, Option<String>, Vec<String>) {
    let base = PdcInventoryEntry {
        path: rel_path.to_string(),
        class: PdcEntryClass::Invalid,
        document_id: None,
        title: None,
        body_profile: None,
        size_bytes,
        diagnostic: None,
        broken_document_links: Vec::new(),
        missing_assets: Vec::new(),
    };
    let text = std::str::from_utf8(bytes).ok();
    let (class, doc, diagnostic) = match classify(ext, bytes) {
        Classification::Valid(d) => {
            let class = if d.legacy {
                PdcEntryClass::LegacyDocument
            } else {
                PdcEntryClass::Document
            };
            (class, Some(d), None)
        }
        Classification::LegacyHtml => (PdcEntryClass::LegacyHtml, None, None),
        Classification::LegacyMarkdown => (PdcEntryClass::LegacyMarkdown, None, None),
        Classification::Invalid(d) => {
            let class = match d.kind {
                DiagnosticKind::UnsupportedDocumentVersion
                | DiagnosticKind::UnsupportedBodyVersion => PdcEntryClass::Unsupported,
                _ => PdcEntryClass::Invalid,
            };
            (class, None, Some(d))
        }
    };
    let scan_text = if matches!(class, PdcEntryClass::Invalid | PdcEntryClass::Unsupported) {
        None
    } else {
        text.map(|t| match &doc {
            Some(d) => t[d.body_range.clone()].to_string(),
            None => t.to_string(),
        })
    };
    let block_ids = doc
        .as_ref()
        .map(|document| document.block_ids.clone())
        .unwrap_or_default();
    let entry = PdcInventoryEntry {
        class,
        document_id: doc.as_ref().map(|d| d.id.clone()),
        title: doc
            .as_ref()
            .and_then(|d| d.envelope.get("title"))
            .and_then(|v| v.as_str())
            .map(str::to_string),
        body_profile: doc.as_ref().map(|d| d.profile.id_str().to_string()),
        diagnostic: diagnostic.as_ref().map(PdcDiagnosticDto::from_pdc),
        ..base
    };
    (entry, scan_text, block_ids)
}

struct LinkResolutionContext<'a> {
    vault: &'a Path,
    known_ids: &'a BTreeMap<String, BTreeSet<String>>,
    known_paths: &'a KnownPaths,
    known_path_blocks: &'a BTreeMap<String, BTreeSet<String>>,
    verified_assets: BTreeMap<String, bool>,
}

/// Resolve every reference class in one document's scanned text
/// (Full Reader §12.1, read-only): managed `pdc://document/<uuid>`
/// targets (fragment allowed), managed `pdc://asset/sha256/<digest>`
/// assets, vault-contained relative references, and wiki links.
/// HTTP(S)/`mailto` targets stay external. Other schemes, absolute
/// paths, symlink paths, and vault escapes are visible broken references.
fn resolve_links(
    entry: &mut PdcInventoryEntry,
    text: &str,
    doc_dir: &Path,
    context: &mut LinkResolutionContext<'_>,
) {
    let vault = context.vault;
    let known_ids = context.known_ids;
    let known_paths = context.known_paths;
    let known_path_blocks = context.known_path_blocks;
    let verified_assets = &mut context.verified_assets;
    let source = reference_source(text);

    for uri in document_refs(&source) {
        let token = uri.strip_prefix("pdc://document/").unwrap_or("");
        let valid = split_uuid_fragment(token).is_some_and(|(uuid, fragment)| {
            let Some(blocks) = known_ids.get(uuid) else {
                return false;
            };
            if !is_canonical_uuid(uuid) {
                return false;
            }
            match fragment {
                None => true,
                Some(fragment) if is_canonical_block_fragment(fragment) => {
                    blocks.contains(fragment)
                }
                Some(_) => false,
            }
        });
        if !valid {
            push_unique(&mut entry.broken_document_links, uri);
        }
    }

    // Managed assets: verify canonical path, size, and stored digest.
    entry
        .missing_assets
        .extend(missing_assets(vault, &source, verified_assets));

    for reference in relative_refs(&source) {
        if reference.path.is_empty() {
            if !(reference.raw.starts_with('#')
                && block_fragment_exists(
                    &entry.path,
                    reference.fragment.as_deref(),
                    known_path_blocks,
                ))
            {
                add_broken_reference(entry, &reference);
            }
            continue;
        }
        let Some(target) = resolve_relative(vault, doc_dir, &reference.path) else {
            add_broken_reference(entry, &reference);
            continue;
        };
        let Some(relative_target) = target.strip_prefix(vault).ok() else {
            add_broken_reference(entry, &reference);
            continue;
        };
        if !is_visible_path(relative_target)
            || regular_file_without_symlinks(vault, relative_target).is_none()
        {
            add_broken_reference(entry, &reference);
            continue;
        }
        if reference.is_document {
            let target_path = relative_target.to_string_lossy();
            if !known_paths.set.contains(target_path.as_ref())
                || !block_fragment_exists(
                    &target_path,
                    reference.fragment.as_deref(),
                    known_path_blocks,
                )
            {
                add_broken_reference(entry, &reference);
            }
        }
    }

    for link in crate::wiki::extract_links(&source) {
        let target = link.target.split('#').next().unwrap_or(&link.target);
        let is_document = is_wiki_document_target(target);
        if let Some(target_path) = resolve_wiki_document(&link.target, known_paths) {
            if !block_fragment_exists_from_wiki(&target_path, &link.target, known_path_blocks) {
                push_unique(
                    &mut entry.broken_document_links,
                    format!("[[{}]]", link.target),
                );
            }
        } else if link.is_embed
            && !is_document
            && resolve_relative(vault, vault, target)
                .and_then(|asset| asset.strip_prefix(vault).ok().map(Path::to_path_buf))
                .is_some_and(|relative| {
                    is_visible_path(&relative)
                        && regular_file_without_symlinks(vault, &relative).is_some()
                })
        {
            // A vault-local wiki image embed resolved as an asset.
        } else if link.is_embed && !is_document {
            push_unique(&mut entry.missing_assets, format!("[[{}]]", link.target));
        } else {
            push_unique(
                &mut entry.broken_document_links,
                format!("[[{}]]", link.target),
            );
        }
    }
}

fn add_broken_reference(entry: &mut PdcInventoryEntry, reference: &RelativeRef) {
    if reference.is_document {
        push_unique(&mut entry.broken_document_links, reference.raw.clone());
    } else {
        push_unique(&mut entry.missing_assets, reference.raw.clone());
    }
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !values.contains(&value) {
        values.push(value);
    }
}

fn is_visible_path(path: &Path) -> bool {
    path.components().all(|component| match component {
        std::path::Component::Normal(name) => !excluded_component(name),
        _ => false,
    })
}

fn is_wiki_document_target(target: &str) -> bool {
    match Path::new(target)
        .extension()
        .and_then(|extension| extension.to_str())
    {
        None | Some("md" | "html" | "djot") => true,
        Some(_) => false,
    }
}

/// Precomputed per-scan lookup structures over the vault's known document
/// paths: a set for exact path membership and a table of
/// `(lowercased stem, extension, depth, path)` rows for wiki-link
/// resolution, so reference resolution avoids per-link linear rescan and
/// per-candidate lowercasing allocations.
struct KnownPaths {
    set: BTreeSet<String>,
    wiki: Vec<(String, &'static str, usize, String)>,
}

impl KnownPaths {
    /// Build from the sorted list of visible document paths.
    fn new(sorted_paths: &[String]) -> Self {
        let mut wiki = Vec::with_capacity(sorted_paths.len());
        for candidate in sorted_paths {
            let Some((base, extension)) = candidate.rsplit_once('.') else {
                continue;
            };
            let extension = match extension {
                "md" => "md",
                "html" => "html",
                "djot" => "djot",
                _ => continue,
            };
            let depth = candidate.matches('/').count();
            wiki.push((
                base.to_ascii_lowercase(),
                extension,
                depth,
                candidate.clone(),
            ));
        }
        Self {
            set: sorted_paths.iter().cloned().collect(),
            wiki,
        }
    }
}

/// `candidate_base` equals `target_base` or ends with `/target_base`,
/// matching a wiki link against any trailing path segment.
fn wiki_base_matches(candidate_base: &str, target_base: &str) -> bool {
    candidate_base == target_base
        || (candidate_base.len() > target_base.len()
            && candidate_base.ends_with(target_base)
            && candidate_base.as_bytes()[candidate_base.len() - target_base.len() - 1] == b'/')
}

fn resolve_wiki_document(target: &str, known: &KnownPaths) -> Option<String> {
    let path = target.split('#').next().unwrap_or(target);
    if path.is_empty() || path.starts_with('/') || path.contains('\\') || has_scheme(path) {
        return None;
    }
    let explicit_extension = Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str());
    if explicit_extension.is_some_and(|extension| !matches!(extension, "md" | "html" | "djot")) {
        return None;
    }
    let target_base = match explicit_extension {
        Some("md") => path.strip_suffix(".md")?,
        Some("html") => path.strip_suffix(".html")?,
        Some("djot") => path.strip_suffix(".djot")?,
        _ => path,
    }
    .to_ascii_lowercase();

    let mut matches = Vec::new();
    for (base, extension, depth, candidate) in &known.wiki {
        if explicit_extension.is_some_and(|expected| expected != *extension) {
            continue;
        }
        if wiki_base_matches(base, &target_base) {
            matches.push((*depth, candidate));
        }
    }
    let shortest = matches.iter().map(|(depth, _)| *depth).min()?;
    let mut shortest_matches = matches
        .into_iter()
        .filter(|(depth, _)| *depth == shortest)
        .map(|(_, path)| path);
    let result = shortest_matches.next()?.clone();
    shortest_matches.next().is_none().then_some(result)
}

fn block_fragment_exists(
    path: &str,
    fragment: Option<&str>,
    known_path_blocks: &BTreeMap<String, BTreeSet<String>>,
) -> bool {
    let Some(fragment) = fragment else {
        return true;
    };
    let target_id = if let Some(id) = fragment.strip_prefix('^') {
        id
    } else if fragment.starts_with("b-") {
        fragment
    } else {
        return true;
    };
    known_path_blocks
        .get(path)
        .is_some_and(|block_ids| block_ids.contains(target_id))
}

fn block_fragment_exists_from_wiki(
    path: &str,
    target: &str,
    known_path_blocks: &BTreeMap<String, BTreeSet<String>>,
) -> bool {
    let Some((_, fragment)) = target.split_once('#') else {
        return true;
    };
    block_fragment_exists(path, Some(fragment), known_path_blocks)
}

/// Lexically resolve a document-relative path inside the vault.
///
/// Returns `None` when the resolved path escapes the vault root; the
/// path is never normalized via the filesystem, so `..` handling is
/// purely lexical and cannot traverse symlinks.
fn resolve_relative(vault: &Path, doc_dir: &Path, target: &str) -> Option<PathBuf> {
    let mut resolved = doc_dir.to_path_buf();
    for component in Path::new(target).components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if !resolved.pop() {
                    return None;
                }
            }
            std::path::Component::Normal(c) => resolved.push(c),
            _ => return None, // Root/Prefix: absolute or drive path
        }
    }
    if resolved.strip_prefix(vault).is_ok() {
        Some(resolved)
    } else {
        None
    }
}

/// Classify one discovered `.base` file. The query is parsed and
/// validated read-only; it is never executed here regardless of the
/// vault-level gate.
fn classify_query_entry(bytes: &[u8], rel_path: &str, size_bytes: u64) -> PdcInventoryEntry {
    let base = PdcInventoryEntry {
        path: rel_path.to_string(),
        class: PdcEntryClass::Query,
        document_id: None,
        title: None,
        body_profile: None,
        size_bytes,
        diagnostic: None,
        broken_document_links: Vec::new(),
        missing_assets: Vec::new(),
    };
    match classify_query(bytes) {
        QueryClassification::Valid => base,
        QueryClassification::ValidUnexecuted => PdcInventoryEntry {
            class: PdcEntryClass::QueryValidUnexecuted,
            ..base
        },
        QueryClassification::Invalid(d) => PdcInventoryEntry {
            class: PdcEntryClass::InvalidQuery,
            diagnostic: Some(PdcDiagnosticDto::from_pdc(&d)),
            ..base
        },
    }
}

/// Scan the vault's PDC document plane. Strictly read-only.
pub fn scan(paths: &Paths) -> Result<PdcInventory> {
    let vault = &paths.vault;
    let (query_enabled, manifest_diagnostic) = read_manifest(vault);

    let mut files = Vec::new();
    if vault.is_dir() {
        walk(vault, &mut files)?;
    }

    // First pass: classify documents and collect target IDs and paths so
    // reference resolution can see every readable target in the vault.
    struct Pending {
        entry: PdcInventoryEntry,
        dir: PathBuf,
        scan_text: Option<String>,
    }
    let mut pending = Vec::new();
    let mut known_ids: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut known_paths = Vec::new();
    let mut known_path_blocks: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for path in &files {
        let relative = path
            .strip_prefix(vault)
            .expect("walk yields paths under the vault");
        let Some(rel) = paths.relative_path(path) else {
            continue;
        };
        let rel_dir = relative.parent().unwrap_or_else(|| Path::new(""));
        let Some(safe_path) = regular_file_without_symlinks(vault, relative) else {
            continue;
        };
        let Some(extension) = path.extension().and_then(|e| e.to_str()) else {
            continue;
        };
        let (max_bytes, is_query) = if extension == "base" {
            (MAX_QUERY_BYTES, true)
        } else {
            (oxi_frontmatter::pdc::MAX_DOCUMENT_BYTES, false)
        };
        let (entry, scan_text, block_ids) = match read_bounded_source(&safe_path, max_bytes) {
            Ok((size_bytes, bytes))
                if size_bytes <= max_bytes as u64 && bytes.len() <= max_bytes =>
            {
                match extension {
                    "base" => (
                        classify_query_entry(&bytes, &rel, size_bytes),
                        None,
                        Vec::new(),
                    ),
                    "md" => classify_entry(&rel, &bytes, DocumentExt::Markdown, size_bytes),
                    "html" => classify_entry(&rel, &bytes, DocumentExt::Html, size_bytes),
                    "djot" => classify_entry(&rel, &bytes, DocumentExt::Djot, size_bytes),
                    _ => continue,
                }
            }
            Ok((size_bytes, _)) => (
                PdcInventoryEntry {
                    path: rel.clone(),
                    class: if is_query {
                        PdcEntryClass::InvalidQuery
                    } else {
                        PdcEntryClass::Invalid
                    },
                    document_id: None,
                    title: None,
                    body_profile: None,
                    size_bytes,
                    diagnostic: Some(PdcDiagnosticDto {
                        code: "file_too_large".to_string(),
                        message: format!("inventory source exceeds the {max_bytes}-byte limit"),
                        line: None,
                    }),
                    broken_document_links: Vec::new(),
                    missing_assets: Vec::new(),
                },
                None,
                Vec::new(),
            ),
            Err(error) => {
                let size_bytes = fs::symlink_metadata(&safe_path)
                    .map(|metadata| metadata.len())
                    .unwrap_or(0);
                (
                    PdcInventoryEntry {
                        path: rel.clone(),
                        class: if is_query {
                            PdcEntryClass::InvalidQuery
                        } else {
                            PdcEntryClass::Invalid
                        },
                        document_id: None,
                        title: None,
                        body_profile: None,
                        size_bytes,
                        diagnostic: Some(PdcDiagnosticDto {
                            code: "unreadable_file".to_string(),
                            message: error.to_string(),
                            line: None,
                        }),
                        broken_document_links: Vec::new(),
                        missing_assets: Vec::new(),
                    },
                    None,
                    Vec::new(),
                )
            }
        };
        if let Some(id) = &entry.document_id {
            known_ids
                .entry(id.clone())
                .or_default()
                .extend(block_ids.iter().cloned());
        }
        if matches!(
            entry.class,
            PdcEntryClass::Document
                | PdcEntryClass::LegacyDocument
                | PdcEntryClass::LegacyMarkdown
                | PdcEntryClass::LegacyHtml
        ) {
            known_paths.push(rel.clone());
            known_path_blocks.insert(rel, block_ids.into_iter().collect());
        }
        pending.push(Pending {
            entry,
            dir: rel_dir.to_path_buf(),
            scan_text,
        });
    }
    known_paths.sort();
    let known_paths = KnownPaths::new(&known_paths);
    let mut link_context = LinkResolutionContext {
        vault,
        known_ids: &known_ids,
        known_paths: &known_paths,
        known_path_blocks: &known_path_blocks,
        verified_assets: BTreeMap::new(),
    };

    // Second pass: resolve every reference class once all targets are
    // known.
    let mut items = Vec::new();
    let mut by_id: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for mut p in pending {
        if let Some(text) = &p.scan_text {
            let doc_dir = vault.join(&p.dir);
            resolve_links(&mut p.entry, text, &doc_dir, &mut link_context);
        }
        if let Some(id) = &p.entry.document_id {
            by_id
                .entry(id.clone())
                .or_default()
                .push(p.entry.path.clone());
        }
        items.push(p.entry);
    }
    items.sort_by(|a, b| a.path.cmp(&b.path));

    let duplicate_ids = by_id
        .into_iter()
        .filter(|(_, paths)| paths.len() > 1)
        .map(|(document_id, mut paths)| {
            paths.sort();
            PdcDuplicateId { document_id, paths }
        })
        .collect();

    Ok(PdcInventory {
        query_enabled,
        manifest_diagnostic,
        duplicate_ids,
        items,
    })
}

/// `true` when file content explicitly declares a PDC document format
/// (`format: pdc-document/*`, any version) in its frontmatter
/// transport.
///
/// This is the memo-plane guard: the full classifier treats any
/// opening `---` transport as a PDC candidate, but ordinary Oximemo
/// notes also use `---` frontmatter. Only an explicit `pdc-document/`
/// marker makes a file PDC — including unsupported future versions, so
/// a document the classifier would reject still never enters the
/// legacy memo/index/editor path. The detection is transport-lexical
/// and never mutates the input.
pub fn is_pdc_document(content: &str) -> bool {
    let mut lines = content.lines().map(|l| l.trim_end_matches('\r'));
    let opens_markdown = matches!(lines.next(), Some("---"));
    if !opens_markdown {
        // HTML transport: `<!--` / `---` … `---` / `-->`.
        let mut lines = content.lines().map(|l| l.trim_end_matches('\r'));
        if lines.next() != Some("<!--") || lines.next() != Some("---") {
            return false;
        }
        return envelope_declares_pdc(lines, Some("-->"));
    }
    envelope_declares_pdc(lines, None)
}

/// Scan top-level envelope lines for an explicit `format` field, accepting
/// quoted YAML keys while ignoring indented nested properties.
fn envelope_declares_pdc<'a>(
    lines: impl Iterator<Item = &'a str>,
    terminator: Option<&str>,
) -> bool {
    for line in lines {
        if let Some(term) = terminator {
            if line == term {
                return false;
            }
        } else if line == "---" {
            return false;
        }
        if line.trim_start() != line {
            continue;
        }
        let Some((key, rest)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim_end();
        let key = key
            .strip_prefix('"')
            .and_then(|key| key.strip_suffix('"'))
            .or_else(|| {
                key.strip_prefix('\'')
                    .and_then(|key| key.strip_suffix('\''))
            })
            .unwrap_or(key);
        if key != "format" {
            continue;
        }
        let value = rest.trim().trim_matches(['"', '\'']);
        if value.starts_with("pdc-document/") {
            return true;
        }
    }
    false
}

/// Guarded read-only source read for one visible PDC-plane file.
///
/// Only the inventory's regular document/query extensions are eligible.
/// Hidden paths, traversal, absolute paths, symlinks, and oversized source
/// files are rejected before their contents are returned.
pub fn read_source(paths: &Paths, relative_path: &str) -> Result<PdcSource> {
    use std::io::Read;

    let vault = &paths.vault;
    let rel = Path::new(relative_path);
    let components: Vec<&str> = relative_path.split('/').collect();
    let extension = rel.extension().and_then(|ext| ext.to_str());
    if relative_path.is_empty()
        || relative_path.contains('\\')
        || rel.is_absolute()
        || components
            .iter()
            .any(|part| part.is_empty() || *part == "." || *part == ".." || part.starts_with('.'))
        || !matches!(extension, Some("md" | "html" | "djot" | "base"))
    {
        return Err(CoreError::other(format!(
            "invalid inventory path {relative_path:?}"
        )));
    }
    let Some(source_path) = regular_file_without_symlinks(vault, rel) else {
        return Err(CoreError::other(format!(
            "inventory path {relative_path:?} is not a visible regular file"
        )));
    };
    let max_bytes = if extension == Some("base") {
        MAX_QUERY_BYTES
    } else {
        oxi_frontmatter::pdc::MAX_DOCUMENT_BYTES
    };
    let metadata = fs::symlink_metadata(&source_path)?;
    if metadata.len() > max_bytes as u64 {
        return Err(CoreError::other(format!(
            "inventory file exceeds the {max_bytes}-byte limit"
        )));
    }
    let mut bytes = Vec::new();
    fs::File::open(&source_path)?
        .take((max_bytes + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > max_bytes {
        return Err(CoreError::other(format!(
            "inventory file exceeds the {max_bytes}-byte limit"
        )));
    }
    let content = std::str::from_utf8(&bytes)
        .map_err(|_| CoreError::other(format!("inventory file {relative_path:?} is not UTF-8")))?
        .to_string();
    let sha256 = {
        use sha2::{Digest, Sha256};
        format!("sha256:{:x}", Sha256::digest(&bytes))
    };
    let editable = match extension {
        Some("md") => Some(DocumentExt::Markdown),
        Some("html") => Some(DocumentExt::Html),
        _ => None,
    }
    .and_then(|ext| match classify(ext, &bytes) {
        Classification::Valid(document) if !document.legacy => Some((
            document.profile.id_str().to_string(),
            document.id,
            document
                .envelope
                .get("title")
                .and_then(|value| value.as_str())
                .map(str::to_string),
            content[document.body_range].to_string(),
        )),
        _ => None,
    });
    Ok(PdcSource {
        path: relative_path.to_string(),
        content,
        sha256,
        document_id: editable.as_ref().map(|(_, id, _, _)| id.clone()),
        editable_body: editable.as_ref().map(|(_, _, _, body)| body.clone()),
        title: editable.as_ref().and_then(|(_, _, title, _)| title.clone()),
        body_profile: editable.map(|(profile, _, _, _)| profile),
    })
}

#[cfg(test)]
mod tests;
