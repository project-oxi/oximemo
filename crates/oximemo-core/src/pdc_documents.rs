//! Canonical PDC document creation and digest-guarded body/ title mutation.
//!
//! This module writes only new PDC 2 documents or edits an already-canonical
//! PDC 2 source. Legacy documents remain read-only. The vault files remain the
//! source of truth; Oximemo's metadata and search indexes are not consulted.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use oxi_frontmatter::pdc::{
    BodyProfile, Classification, DiagnosticKind, DocumentExt, PdcDocument, classify,
    patch_metadata, save_guarded,
};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use serde_yaml_ng::{Mapping, Value as YamlValue};
use sha2::{Digest, Sha256};
use time::{Duration as TimeDuration, OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::pdc_inventory::{PdcSource, read_source};
use crate::{CoreError, Paths, Result};

mod patch;

/// One guarded metadata edit. Paths use RFC 6901 JSON Pointer syntax.
/// `Some(null)` sets null; `None` removes the selected property or array item.
#[derive(Debug, Clone, PartialEq)]
pub struct PdcMetadataEdit {
    pub path: String,
    pub value: Option<JsonValue>,
}

/// Escape a literal top-level user-property key as a JSON Pointer.
pub fn property_pointer(key: &str) -> String {
    patch::pointer(key)
}

const PDC_DIR: &str = ".pdc";
const MANIFEST_PATH: &str = ".pdc/vault.json";
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_DOCUMENT_BYTES: usize = oxi_frontmatter::pdc::MAX_DOCUMENT_BYTES;
const LOCK_TIMEOUT: Duration = Duration::from_secs(5);

/// Body profile for newly created PDC documents.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PdcBodyProfile {
    /// Canonical Markdown (`pdc-markdown/1`, `.md`).
    Markdown,
    /// Authored HTML (`pdc-html/1`, `.html`).
    Html,
}

impl PdcBodyProfile {
    fn contract(self) -> &'static str {
        match self {
            Self::Markdown => "pdc-markdown/1",
            Self::Html => "pdc-html/1",
        }
    }

    fn body_profile(self) -> BodyProfile {
        match self {
            Self::Markdown => BodyProfile::Markdown,
            Self::Html => BodyProfile::Html,
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Self::Markdown => "md",
            Self::Html => "html",
        }
    }

    fn document_ext(self) -> DocumentExt {
        match self {
            Self::Markdown => DocumentExt::Markdown,
            Self::Html => DocumentExt::Html,
        }
    }
}

/// User-owned frontmatter property for a newly created document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PdcProperty {
    /// Nonempty, case-sensitive YAML mapping key.
    pub key: String,
    /// JSON-compatible value; arbitrary YAML tags and aliases cannot enter.
    pub value: JsonValue,
}

/// Inputs for creating a new PDC 2 document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PdcCreateRequest {
    /// Optional visible vault-relative folder; hidden components are rejected.
    #[serde(default)]
    pub folder: String,
    /// Stored PDC title. Empty titles use the PDC display fallback.
    pub title: String,
    /// Markdown or HTML body. Newline endings are written as LF.
    pub body: String,
    /// Canonical body profile to create.
    pub body_profile: PdcBodyProfile,
    /// PDC-owned string labels, case-sensitive and duplicate-free.
    #[serde(default)]
    pub tags: Vec<String>,
    /// Ordered user-owned envelope properties.
    #[serde(default)]
    pub properties: Vec<PdcProperty>,
}

/// Receipt for a canonical PDC file write.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PdcWriteReceipt {
    /// Vault-relative path of the created or updated document.
    pub path: String,
    /// Canonical PDC document UUID.
    pub document_id: String,
    /// SHA-256 of the exact resulting source bytes (`sha256:<hex>`).
    pub sha256: String,
}

/// Exact PDC candidate persisted by a higher-level prepared-write receipt.
/// `content` is immutable between preparation and replay.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreparedPdcDocument {
    pub path: String,
    pub document_id: String,
    pub content: String,
    pub sha256: String,
}

/// Prepare a canonical PDC document without writing to the vault.
///
/// The generated identity, timestamp, path, exact source, and digest can be
/// persisted before [`create_prepared_document`] performs the filesystem write.
pub fn prepare_document(paths: &Paths, request: PdcCreateRequest) -> Result<PreparedPdcDocument> {
    let _lock = crate::lock::acquire(
        &paths.meta_lock_path(),
        crate::lock::LockKind::Exclusive,
        LOCK_TIMEOUT,
    )?;
    let folder = safe_folder(&request.folder)?;
    let body = normalize_body(&request.body);
    let document_id = Uuid::now_v7().to_string();
    let timestamp = canonical_now()?;
    let content = serialize_new_document(&request, &body, &document_id, &timestamp)?;
    validate_new_source(request.body_profile, content.as_bytes())?;

    let slug = if request.title.trim().is_empty() {
        crate::memo::timestamp_filename(OffsetDateTime::now_utc())
    } else {
        let slug = crate::memo::slugify(&request.title);
        if slug.is_empty() || slug.starts_with('.') {
            crate::memo::timestamp_filename(OffsetDateTime::now_utc())
        } else {
            slug
        }
    };
    let mut parent = PathBuf::new();
    for component in &folder {
        parent.push(component);
    }
    for suffix in 1..u32::MAX {
        let name = if suffix == 1 {
            format!("{slug}.{}", request.body_profile.extension())
        } else {
            format!("{slug}-{suffix}.{}", request.body_profile.extension())
        };
        let candidate = parent.join(name);
        match fs::symlink_metadata(paths.vault.join(&candidate)) {
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let path = candidate
                    .to_string_lossy()
                    .replace(std::path::MAIN_SEPARATOR, "/");
                return Ok(PreparedPdcDocument {
                    path,
                    document_id,
                    sha256: digest(content.as_bytes()),
                    content,
                });
            }
            Err(error) => return Err(error.into()),
        }
    }
    Err(CoreError::other(
        "could not allocate a unique prepared PDC document path",
    ))
}

/// Write a previously prepared PDC document exactly once, or confirm an
/// identical candidate already landed before a crash.
pub fn create_prepared_document(
    paths: &Paths,
    prepared: &PreparedPdcDocument,
) -> Result<PdcWriteReceipt> {
    let _lock = crate::lock::acquire(
        &paths.meta_lock_path(),
        crate::lock::LockKind::Exclusive,
        LOCK_TIMEOUT,
    )?;
    if prepared.sha256 != digest(prepared.content.as_bytes())
        || prepared.content.len() > MAX_DOCUMENT_BYTES
    {
        return Err(read_only("prepared PDC source digest or size is invalid"));
    }
    let parts = safe_relative_file(&prepared.path)?;
    let ext = document_ext(&prepared.path)?;
    let (profile, document_id) = match classify(ext, prepared.content.as_bytes()) {
        Classification::Valid(document) if !document.legacy => {
            let profile = match document.profile {
                BodyProfile::Markdown => PdcBodyProfile::Markdown,
                BodyProfile::Html => PdcBodyProfile::Html,
                _ => return Err(read_only("prepared PDC profile is not writable")),
            };
            (profile, document.id)
        }
        Classification::Invalid(diagnostic) => return Err(diagnostic_error(diagnostic)),
        _ => return Err(read_only("prepared source is not a canonical PDC document")),
    };
    if document_id != prepared.document_id {
        return Err(read_only("prepared PDC identity does not match its source"));
    }
    validate_new_source(profile, prepared.content.as_bytes())?;

    ensure_manifest(&paths.vault)?;
    let folder = parts[..parts.len() - 1].to_vec();
    let parent = ensure_parent_directories(&paths.vault, &folder)?;
    let target = parent.join(&parts[parts.len() - 1]);
    match fs::symlink_metadata(&target) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err(read_only("prepared PDC destination is not a regular file"));
        }
        Ok(_) => {
            if fs::read(&target)? != prepared.content.as_bytes() {
                return Err(external_change());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match atomic_create(&target, prepared.content.as_bytes()) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let metadata = fs::symlink_metadata(&target)?;
                    if metadata.file_type().is_symlink()
                        || !metadata.is_file()
                        || fs::read(&target)? != prepared.content.as_bytes()
                    {
                        return Err(external_change());
                    }
                }
                Err(error) => return Err(error.into()),
            }
        }
        Err(error) => return Err(error.into()),
    }
    Ok(PdcWriteReceipt {
        path: prepared.path.clone(),
        document_id: prepared.document_id.clone(),
        sha256: prepared.sha256.clone(),
    })
}

/// Create a new canonical PDC 2 Markdown or HTML document.
///
/// The PDC vault manifest is created before the document if absent. Existing
/// manifests and source files are never rewritten by this operation.
pub fn create_document(paths: &Paths, request: PdcCreateRequest) -> Result<PdcWriteReceipt> {
    let _lock = crate::lock::acquire(
        &paths.meta_lock_path(),
        crate::lock::LockKind::Exclusive,
        LOCK_TIMEOUT,
    )?;

    let folder = safe_folder(&request.folder)?;
    let body = normalize_body(&request.body);
    let document_id = Uuid::now_v7().to_string();
    let timestamp = canonical_now()?;
    let source = serialize_new_document(&request, &body, &document_id, &timestamp)?;
    validate_new_source(request.body_profile, source.as_bytes())?;

    ensure_manifest(&paths.vault)?;
    let parent = ensure_parent_directories(&paths.vault, &folder)?;
    let slug = if request.title.trim().is_empty() {
        crate::memo::timestamp_filename(OffsetDateTime::now_utc())
    } else {
        let slug = crate::memo::slugify(&request.title);
        if slug.is_empty() || slug.starts_with('.') {
            crate::memo::timestamp_filename(OffsetDateTime::now_utc())
        } else {
            slug
        }
    };

    for suffix in 1..u32::MAX {
        let name = if suffix == 1 {
            format!("{slug}.{}", request.body_profile.extension())
        } else {
            format!("{slug}-{suffix}.{}", request.body_profile.extension())
        };
        let target = parent.join(name);
        match atomic_create(&target, source.as_bytes()) {
            Ok(()) => {
                let rel = target
                    .strip_prefix(&paths.vault)
                    .map_err(|_| CoreError::other("created PDC path escaped vault root"))?
                    .to_string_lossy()
                    .replace(std::path::MAIN_SEPARATOR, "/");
                return Ok(PdcWriteReceipt {
                    path: rel,
                    document_id,
                    sha256: digest(source.as_bytes()),
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Err(CoreError::other(
        "could not allocate a unique PDC document path",
    ))
}

/// Read one PDC source through the same containment checks as the inventory.
pub fn read_document(paths: &Paths, relative_path: &str) -> Result<PdcSource> {
    read_source(paths, relative_path)
}

/// Save a PDC 2 body's source text and/or title if its source digest still
/// matches the snapshot returned by [`read_document`].
///
/// The exact envelope and all unedited envelope bytes are preserved. Legacy,
/// malformed, unsupported, or query files are read-only. A no-op returns the
/// unchanged source and does not advance `updated`.
pub fn update_document(
    paths: &Paths,
    relative_path: &str,
    expected_sha256: &str,
    title: Option<&str>,
    body: Option<&str>,
) -> Result<PdcSource> {
    update_document_with_metadata(paths, relative_path, expected_sha256, title, body, &[])
}

/// Body-only mutation within an existing exclusive vault transaction.
/// Reuses the canonical source-preserving writer without reacquiring flock.
pub(crate) fn update_body_locked(
    paths: &Paths,
    relative_path: &str,
    expected_sha256: &str,
    body: &str,
    guard: &crate::lock::FileLock,
) -> Result<PdcSource> {
    debug_assert_eq!(guard.kind(), crate::lock::LockKind::Exclusive);
    let source = read_source(paths, relative_path)?;
    if source.sha256 != expected_sha256 {
        return Err(external_change());
    }
    let Some(candidate) = prepare_update_source(&source, None, Some(body), &[])? else {
        return Ok(source);
    };
    update_prepared_document_locked(paths, relative_path, expected_sha256, &candidate, guard)
}

/// Update a canonical PDC source and a bounded set of scalar user properties.
/// This variant supports session provenance while preserving every untouched
/// envelope byte.
pub fn update_document_with_metadata(
    paths: &Paths,
    relative_path: &str,
    expected_sha256: &str,
    title: Option<&str>,
    body: Option<&str>,
    metadata_updates: &[(String, String)],
) -> Result<PdcSource> {
    let source = read_source(paths, relative_path)?;
    if source.sha256 != expected_sha256 {
        return Err(external_change());
    }
    let Some(candidate) = prepare_update_source(&source, title, body, metadata_updates)? else {
        return Ok(source);
    };
    update_prepared_document(paths, relative_path, expected_sha256, &candidate)
}

/// Build exact candidate bytes without writing them. Higher-level durable
/// receipt stores can persist these bytes before calling
/// [`update_prepared_document`].
pub fn prepare_update_source(
    source: &PdcSource,
    title: Option<&str>,
    body: Option<&str>,
    metadata_updates: &[(String, String)],
) -> Result<Option<Vec<u8>>> {
    let ext = document_ext(&source.path)?;
    let document = match classify(ext, source.content.as_bytes()) {
        Classification::Valid(document) if !document.legacy => document,
        Classification::Valid(_) => return Err(read_only("legacy PDC documents are read-only")),
        Classification::LegacyHtml | Classification::LegacyMarkdown => {
            return Err(read_only("unmarked legacy documents are read-only"));
        }
        Classification::Invalid(diagnostic) => return Err(diagnostic_error(diagnostic)),
    };
    if !matches!(document.profile, BodyProfile::Markdown | BodyProfile::Html) {
        return Err(read_only("only canonical Markdown and HTML are writable"));
    }

    let old_title = document
        .envelope
        .get("title")
        .and_then(|value| value.as_str())
        .ok_or_else(|| read_only("canonical PDC document has no string title"))?;
    let title_changed = title.is_some_and(|next| next != old_title);
    if title.is_some_and(|value| value.contains(['\n', '\r'])) {
        return Err(read_only("title updates must be a single line"));
    }
    let old_body = &source.content[document.body_range.clone()];
    let next_body = body;
    let body_changed = next_body.is_some_and(|next| next != old_body);

    let reserved = [
        "format",
        "body",
        "id",
        "created",
        "updated",
        "title",
        "profile",
        "lang",
        "tags",
        "aliases",
        "cssclasses",
        "favorite",
        "deleted",
        "deleted_at",
    ];
    let mut seen = std::collections::HashSet::new();
    for (key, value) in metadata_updates {
        if key.is_empty()
            || reserved.contains(&key.as_str())
            || key.contains(['\n', '\r', ':'])
            || value.contains(['\n', '\r'])
            || !seen.insert(key.as_str())
        {
            return Err(read_only("invalid or duplicate PDC metadata update"));
        }
    }

    let mut next = source.content.as_bytes().to_vec();
    if body_changed {
        let body = next_body.expect("body_changed implies a body");
        let mut replaced = Vec::with_capacity(next.len() - old_body.len() + body.len());
        replaced.extend_from_slice(&next[..document.body_range.start]);
        replaced.extend_from_slice(body.as_bytes());
        replaced.extend_from_slice(&next[document.body_range.end..]);
        next = replaced;
    }

    let mut patch = Vec::with_capacity(metadata_updates.len() + 1);
    if let Some(title) = title.filter(|_| title_changed) {
        patch.push(("title", title));
    }
    for (key, value) in metadata_updates {
        patch.push((key.as_str(), value.as_str()));
    }
    let metadata_changed = if patch.is_empty() {
        false
    } else {
        let patched = patch_metadata(ext, &next, &patch).map_err(diagnostic_error)?;
        let changed = patched != next;
        next = patched;
        changed
    };
    if !body_changed && !metadata_changed {
        return Ok(None);
    }

    let updated = next_timestamp(&document)?;
    next =
        patch_metadata(ext, &next, &[("updated", updated.as_str())]).map_err(diagnostic_error)?;
    validate_update(&document, ext, &next)?;
    Ok(Some(next))
}

/// Atomically apply typed metadata paths with the original whole-source digest.
/// All edits are validated in memory before any source is replaced.
pub fn update_document_with_edits(
    paths: &Paths,
    relative_path: &str,
    expected_sha256: &str,
    title: Option<&str>,
    body: Option<&str>,
    edits: &[PdcMetadataEdit],
) -> Result<PdcSource> {
    let source = read_source(paths, relative_path)?;
    if source.sha256 != expected_sha256 {
        return Err(external_change());
    }
    let prepared = prepare_update_source(&source, title, body, &[])?;
    let mut candidate = prepared.unwrap_or_else(|| source.content.as_bytes().to_vec());
    let text = std::str::from_utf8(&candidate).map_err(|e| read_only(e.to_string()))?;
    let ext = document_ext(relative_path)?;
    let Classification::Valid(document) = classify(ext, &candidate) else {
        return Err(read_only("canonical source required"));
    };
    let start = match ext {
        DocumentExt::Html => text.find("---").unwrap() + 3,
        _ => 3,
    };
    let start = start + text[start..].find('\n').unwrap() + 1;
    let end = text[..document.body_range.start].rfind("---").unwrap();
    let patched = patch::apply(&text[start..end], edits)?;
    if patched != text[start..end] {
        let mut next = candidate[..start].to_vec();
        next.extend_from_slice(patched.as_bytes());
        next.extend_from_slice(&candidate[end..]);
        let updated = next_timestamp(&document)?;
        candidate = patch_metadata(ext, &next, &[("updated", updated.as_str())])
            .map_err(diagnostic_error)?;
    }
    if candidate == source.content.as_bytes() {
        return Ok(source);
    }
    validate_update(&document, ext, &candidate)?;
    update_prepared_document(paths, relative_path, expected_sha256, &candidate)
}

/// Apply exact prepared PDC bytes after comparing the current source digest.
/// If the candidate already landed, return success for crash recovery.
pub fn update_prepared_document(
    paths: &Paths,
    relative_path: &str,
    expected_sha256: &str,
    candidate: &[u8],
) -> Result<PdcSource> {
    let _lock = crate::lock::acquire(
        &paths.meta_lock_path(),
        crate::lock::LockKind::Exclusive,
        LOCK_TIMEOUT,
    )?;
    update_prepared_document_locked(paths, relative_path, expected_sha256, candidate, &_lock)
}

fn update_prepared_document_locked(
    paths: &Paths,
    relative_path: &str,
    expected_sha256: &str,
    candidate: &[u8],
    guard: &crate::lock::FileLock,
) -> Result<PdcSource> {
    debug_assert_eq!(guard.kind(), crate::lock::LockKind::Exclusive);
    if candidate.len() > MAX_DOCUMENT_BYTES {
        return Err(read_only("prepared PDC source exceeds its size limit"));
    }
    let ext = document_ext(relative_path)?;
    let latest = read_source(paths, relative_path)?;
    let candidate_digest = digest(candidate);
    if latest.sha256 == candidate_digest {
        return Ok(latest);
    }
    if latest.sha256 != expected_sha256 {
        return Err(external_change());
    }
    let current_document = match classify(ext, latest.content.as_bytes()) {
        Classification::Valid(document) if !document.legacy => document,
        Classification::Valid(_) => return Err(read_only("legacy PDC documents are read-only")),
        Classification::LegacyHtml | Classification::LegacyMarkdown => {
            return Err(read_only("unmarked legacy documents are read-only"));
        }
        Classification::Invalid(diagnostic) => return Err(diagnostic_error(diagnostic)),
    };
    let candidate_document = match classify(ext, candidate) {
        Classification::Valid(document) if !document.legacy => document,
        Classification::Valid(_) => return Err(read_only("prepared PDC source is legacy")),
        Classification::LegacyHtml | Classification::LegacyMarkdown => {
            return Err(read_only("prepared PDC source lacks a canonical envelope"));
        }
        Classification::Invalid(diagnostic) => return Err(diagnostic_error(diagnostic)),
    };
    let current_created = current_document
        .envelope
        .get("created")
        .and_then(|value| value.as_str());
    let candidate_created = candidate_document
        .envelope
        .get("created")
        .and_then(|value| value.as_str());
    if current_document.id != candidate_document.id
        || current_document.profile != candidate_document.profile
        || current_created != candidate_created
    {
        return Err(read_only(
            "prepared PDC update changed document identity, profile, or creation time",
        ));
    }
    validate_update(&current_document, ext, candidate)?;

    // Re-read immediately before atomic replacement. App writers coordinate
    // with the shared lock; this comparison also detects ordinary external edits.
    let newest = read_source(paths, relative_path)?;
    let guarded = save_guarded(
        latest.content.as_bytes(),
        newest.content.as_bytes(),
        candidate.to_vec(),
    )
    .map_err(diagnostic_error)?;
    let target = safe_existing_path(&paths.vault, relative_path)?;
    oxi_frontmatter::atomic_write(&target, &guarded)?;
    read_source(paths, relative_path)
}

pub(crate) fn serialize_new_document(
    request: &PdcCreateRequest,
    body: &str,
    document_id: &str,
    timestamp: &str,
) -> Result<String> {
    if request.title.contains(['\n', '\r']) {
        return Err(CoreError::other("PDC titles must be a single line"));
    }
    let mut envelope = Mapping::new();
    insert_string(&mut envelope, "format", "pdc-document/2");
    insert_string(&mut envelope, "body", request.body_profile.contract());
    insert_string(&mut envelope, "id", document_id);
    insert_string(&mut envelope, "created", timestamp);
    insert_string(&mut envelope, "updated", timestamp);
    insert_string(&mut envelope, "title", &request.title);
    if !request.tags.is_empty() {
        let mut tags = Vec::with_capacity(request.tags.len());
        for tag in &request.tags {
            tags.push(YamlValue::String(tag.clone()));
        }
        envelope.insert(YamlValue::String("tags".into()), YamlValue::Sequence(tags));
    }

    let reserved = [
        "format",
        "body",
        "id",
        "created",
        "updated",
        "title",
        "profile",
        "lang",
        "tags",
        "aliases",
        "cssclasses",
        "favorite",
        "deleted",
        "deleted_at",
    ];
    let mut property_keys = std::collections::HashSet::new();
    for property in &request.properties {
        if property.key.is_empty()
            || reserved.contains(&property.key.as_str())
            || !property_keys.insert(property.key.as_str())
        {
            return Err(CoreError::other(format!(
                "invalid or duplicate PDC user property {:?}",
                property.key
            )));
        }
        let value = serde_yaml_ng::to_value(&property.value)
            .map_err(|error| CoreError::other(format!("invalid PDC property: {error}")))?;
        envelope.insert(YamlValue::String(property.key.clone()), value);
    }

    let mut yaml = serde_yaml_ng::to_string(&YamlValue::Mapping(envelope))
        .map_err(|error| CoreError::other(format!("PDC YAML serialization failed: {error}")))?;
    if !yaml.ends_with('\n') {
        yaml.push('\n');
    }
    let source = match request.body_profile {
        PdcBodyProfile::Markdown => format!("---\n{yaml}---\n{body}"),
        PdcBodyProfile::Html => format!("<!--\n---\n{yaml}---\n-->\n{body}"),
    };
    if source.len() > MAX_DOCUMENT_BYTES {
        return Err(CoreError::other(format!(
            "PDC document exceeds the {MAX_DOCUMENT_BYTES}-byte limit"
        )));
    }
    Ok(source)
}

fn insert_string(mapping: &mut Mapping, key: &str, value: &str) {
    mapping.insert(
        YamlValue::String(key.to_string()),
        YamlValue::String(value.to_string()),
    );
}

pub(crate) fn validate_new_source(profile: PdcBodyProfile, bytes: &[u8]) -> Result<()> {
    match classify(profile.document_ext(), bytes) {
        Classification::Valid(document)
            if !document.legacy && document.profile == profile.body_profile() =>
        {
            Ok(())
        }
        Classification::Valid(_) => Err(CoreError::other("generated PDC profile mismatch")),
        Classification::Invalid(diagnostic) => Err(diagnostic_error(diagnostic)),
        Classification::LegacyHtml | Classification::LegacyMarkdown => Err(CoreError::other(
            "generated PDC document lacks its canonical envelope",
        )),
    }
}

pub(crate) fn validate_update(
    original: &PdcDocument,
    ext: DocumentExt,
    bytes: &[u8],
) -> Result<()> {
    let updated = match classify(ext, bytes) {
        Classification::Valid(document) if !document.legacy => document,
        Classification::Valid(_) => return Err(read_only("legacy PDC documents are read-only")),
        Classification::LegacyHtml | Classification::LegacyMarkdown => {
            return Err(read_only("mutation removed the canonical PDC envelope"));
        }
        Classification::Invalid(diagnostic) => return Err(diagnostic_error(diagnostic)),
    };
    if let Some(tags) = updated
        .envelope
        .get("tags")
        .and_then(|value| value.as_seq())
    {
        let mut seen = std::collections::HashSet::new();
        if tags.iter().any(|tag| !seen.insert(tag.as_str())) {
            return Err(read_only("tags must be duplicate-free string labels"));
        }
    }
    if updated.id != original.id || updated.profile != original.profile {
        return Err(read_only("mutation changed PDC identity or body profile"));
    }
    Ok(())
}

/// Initialize a writable vault's manifest without rewriting existing notes
/// or changing an existing manifest. Invalid manifests are rejected.
pub fn ensure_manifest(vault: &Path) -> Result<()> {
    match fs::symlink_metadata(vault) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
            return Err(read_only("vault root must be a regular directory"));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => fs::create_dir_all(vault)?,
        Err(error) => return Err(error.into()),
    }

    let pdc_dir = vault.join(PDC_DIR);
    match fs::symlink_metadata(&pdc_dir) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
            return Err(read_only(".pdc must be a regular directory"));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => fs::create_dir(&pdc_dir)?,
        Err(error) => return Err(error.into()),
    }

    let manifest = vault.join(MANIFEST_PATH);
    match fs::symlink_metadata(&manifest) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() => {
            Err(read_only(".pdc/vault.json must be a regular file"))
        }
        Ok(meta) => {
            if meta.len() > MAX_MANIFEST_BYTES {
                return Err(read_only(".pdc/vault.json exceeds its size limit"));
            }
            let bytes = fs::read(&manifest)?;
            let value: JsonValue = serde_json::from_slice(&bytes).map_err(|error| {
                CoreError::other(format!("invalid PDC vault manifest: {error}"))
            })?;
            validate_manifest(&value)?;
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let manifest = serde_json::json!({
                "format": "pdc-vault/1",
                "id": Uuid::now_v7().to_string(),
                "created": canonical_now()?,
            });
            let mut bytes = serde_json::to_vec_pretty(&manifest)?;
            bytes.push(b'\n');
            atomic_create(&vault.join(MANIFEST_PATH), &bytes)?;
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
}

fn validate_manifest(value: &JsonValue) -> Result<()> {
    let object = value
        .as_object()
        .ok_or_else(|| read_only("PDC vault manifest must be a JSON object"))?;
    if object.get("format").and_then(JsonValue::as_str) != Some("pdc-vault/1") {
        return Err(read_only("PDC vault manifest has an unsupported format"));
    }
    let id = object
        .get("id")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| read_only("PDC vault manifest has no canonical UUID"))?;
    if !is_canonical_uuid(id) {
        return Err(read_only("PDC vault manifest has no canonical UUID"));
    }
    let created = object
        .get("created")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| read_only("PDC vault manifest has no canonical timestamp"))?;
    if !is_canonical_timestamp(created) {
        return Err(read_only("PDC vault manifest has no canonical timestamp"));
    }
    if let Some(query) = object.get("query")
        && query.as_str().is_none_or(|value| value != "pdc-query/1")
    {
        return Err(read_only(
            "PDC vault manifest declares an unsupported query contract",
        ));
    }
    Ok(())
}

fn ensure_parent_directories(vault: &Path, folder: &[String]) -> Result<PathBuf> {
    let mut parent = vault.to_path_buf();
    for component in folder {
        parent.push(component);
        match fs::symlink_metadata(&parent) {
            Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
                return Err(read_only(
                    "PDC destination contains a non-directory or symlink",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => fs::create_dir(&parent)?,
            Err(error) => return Err(error.into()),
        }
    }
    Ok(parent)
}

fn safe_folder(folder: &str) -> Result<Vec<String>> {
    if folder.is_empty() {
        return Ok(Vec::new());
    }
    if folder.contains('\\') || folder.starts_with('/') {
        return Err(read_only("PDC destination folder must be vault-relative"));
    }
    let mut parts = Vec::new();
    for component in Path::new(folder).components() {
        match component {
            Component::Normal(name) => {
                let Some(name) = name.to_str() else {
                    return Err(read_only("PDC destination folder must be UTF-8"));
                };
                if name.is_empty() || name.starts_with('.') {
                    return Err(read_only("hidden PDC destination folders are not allowed"));
                }
                parts.push(name.to_string());
            }
            _ => return Err(read_only("PDC destination folder contains traversal")),
        }
    }
    Ok(parts)
}

fn safe_existing_path(vault: &Path, relative_path: &str) -> Result<PathBuf> {
    let parts = safe_relative_file(relative_path)?;
    let mut path = vault.to_path_buf();
    for (index, part) in parts.iter().enumerate() {
        path.push(part);
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink()
            || (index + 1 == parts.len() && !metadata.is_file())
            || (index + 1 < parts.len() && !metadata.is_dir())
        {
            return Err(read_only("PDC source path is not a regular contained file"));
        }
    }
    Ok(path)
}

fn safe_relative_file(relative_path: &str) -> Result<Vec<String>> {
    if relative_path.is_empty()
        || relative_path.contains('\\')
        || relative_path.starts_with('/')
        || !matches!(
            Path::new(relative_path)
                .extension()
                .and_then(|ext| ext.to_str()),
            Some("md" | "html")
        )
    {
        return Err(read_only(
            "PDC source path must be a visible .md or .html file",
        ));
    }
    let mut parts = Vec::new();
    for component in Path::new(relative_path).components() {
        match component {
            Component::Normal(name) => {
                let Some(name) = name.to_str() else {
                    return Err(read_only("PDC source path must be UTF-8"));
                };
                if name.starts_with('.') {
                    return Err(read_only("hidden PDC source paths are not writable"));
                }
                parts.push(name.to_string());
            }
            _ => return Err(read_only("PDC source path contains traversal")),
        }
    }
    Ok(parts)
}

fn document_ext(path: &str) -> Result<DocumentExt> {
    match Path::new(path).extension().and_then(|ext| ext.to_str()) {
        Some("md") => Ok(DocumentExt::Markdown),
        Some("html") => Ok(DocumentExt::Html),
        _ => Err(read_only(
            "only canonical .md and .html documents are writable",
        )),
    }
}

pub(crate) fn atomic_create(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "target has no parent directory",
        )
    })?;
    let temp = parent.join(format!(".pdc-write-{}.tmp", Uuid::now_v7()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)?;
    let write_result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::hard_link(&temp, path)?;
        fs::remove_file(&temp)?;
        crate::store::files::fsync_dir(parent)
            .map_err(|error| std::io::Error::other(error.to_string()))?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    write_result
}

pub(crate) fn normalize_body(body: &str) -> String {
    let mut body = body.replace("\r\n", "\n").replace('\r', "\n");
    if !body.is_empty() && !body.ends_with('\n') {
        body.push('\n');
    }
    body
}

pub(crate) fn canonical_now() -> Result<String> {
    format_timestamp(OffsetDateTime::now_utc())
}

pub(crate) fn next_timestamp(document: &PdcDocument) -> Result<String> {
    let current = document
        .envelope
        .get("updated")
        .and_then(|value| value.as_str())
        .ok_or_else(|| read_only("PDC source has no canonical update timestamp"))?;
    let prior = OffsetDateTime::parse(current, &Rfc3339)?;
    let now = OffsetDateTime::now_utc();
    let candidate = if now > prior {
        now
    } else {
        prior + TimeDuration::milliseconds(1)
    };
    let formatted = format_timestamp(candidate)?;
    if formatted.as_str() <= current {
        format_timestamp(prior + TimeDuration::milliseconds(1))
    } else {
        Ok(formatted)
    }
}

fn format_timestamp(timestamp: OffsetDateTime) -> Result<String> {
    let format = time::macros::format_description!(
        "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
    );
    Ok(timestamp.format(format)?)
}

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn is_canonical_uuid(value: &str) -> bool {
    // Same predicate as the inventory reader (canonical spelling,
    // version 1-8, RFC 4122 variant) so manifests written here always
    // pass `pdc_inventory::scan`'s manifest validation.
    crate::pdc_inventory::is_canonical_uuid(value)
}

fn is_canonical_timestamp(value: &str) -> bool {
    let format = time::macros::format_description!(
        "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
    );
    time::PrimitiveDateTime::parse(value, format).is_ok()
}

fn external_change() -> CoreError {
    CoreError::other(format!(
        "{}: PDC source digest changed since it was read",
        DiagnosticKind::ExternalChangeConflict.as_str()
    ))
}

fn read_only(message: impl AsRef<str>) -> CoreError {
    CoreError::other(format!("unsupported_lossless_edit: {}", message.as_ref()))
}

fn diagnostic_error(diagnostic: oxi_frontmatter::pdc::PdcDiagnostic) -> CoreError {
    CoreError::other(format!(
        "{}: {}",
        diagnostic.kind.as_str(),
        diagnostic.message
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdc_inventory::scan;
    use tempfile::TempDir;

    fn temp_paths() -> (Paths, TempDir) {
        let dir = tempfile::tempdir().expect("temporary vault");
        let paths = Paths {
            vault: dir.path().join("vault"),
            index_dir: dir.path().join("index"),
        };
        fs::create_dir_all(&paths.vault).expect("create vault");
        (paths, dir)
    }

    fn request(profile: PdcBodyProfile) -> PdcCreateRequest {
        PdcCreateRequest {
            folder: "Sessions".into(),
            title: "Captured session".into(),
            body: "# Captured session\r\n\r\nSummary.".into(),
            body_profile: profile,
            tags: vec!["session".into(), "review".into()],
            properties: vec![PdcProperty {
                key: "cassette_source_ids".into(),
                value: serde_json::json!(r#"["source-1","source-2"]"#),
            }],
        }
    }

    fn parsed_pdc(content: &str, profile: PdcBodyProfile) -> PdcDocument {
        match classify(profile.document_ext(), content.as_bytes()) {
            Classification::Valid(document) if !document.legacy => document,
            other => panic!("expected canonical PDC document, got {other:?}"),
        }
    }

    #[test]
    fn creates_canonical_markdown_and_initializes_manifest_first() {
        let (paths, _guard) = temp_paths();
        let receipt = create_document(&paths, request(PdcBodyProfile::Markdown)).unwrap();
        assert_eq!(receipt.path, "Sessions/Captured-session.md");
        assert!(receipt.sha256.starts_with("sha256:"));
        let source = read_document(&paths, &receipt.path).unwrap();
        assert_eq!(source.sha256, receipt.sha256);
        assert!(
            source
                .content
                .starts_with("---\nformat: pdc-document/2\nbody: pdc-markdown/1\nid: ")
        );
        let parsed = parsed_pdc(&source.content, PdcBodyProfile::Markdown);
        let keys: Vec<&str> = match &parsed.envelope {
            oxi_frontmatter::pdc::Yaml::Map(fields) => {
                fields.iter().map(|(key, _)| key.as_str()).collect()
            }
            _ => panic!("PDC envelope is a mapping"),
        };
        assert_eq!(
            &keys[..7],
            &[
                "format", "body", "id", "created", "updated", "title", "tags"
            ]
        );
        assert_eq!(
            parsed.envelope.get("tags").and_then(|value| value.as_seq()),
            Some(
                &[
                    oxi_frontmatter::pdc::Yaml::Str("session".into()),
                    oxi_frontmatter::pdc::Yaml::Str("review".into()),
                ][..]
            )
        );
        assert_eq!(
            parsed
                .envelope
                .get("cassette_source_ids")
                .and_then(|value| value.as_str()),
            Some(r#"["source-1","source-2"]"#)
        );
        assert!(source.content.ends_with("# Captured session\n\nSummary.\n"));
        assert_eq!(
            scan(&paths).unwrap().items[0].class,
            crate::pdc_inventory::PdcEntryClass::Document
        );
        let manifest: JsonValue =
            serde_json::from_slice(&fs::read(paths.vault.join(MANIFEST_PATH)).unwrap()).unwrap();
        assert_eq!(manifest["format"], "pdc-vault/1");
    }

    #[test]
    fn creates_html_and_avoids_existing_paths_without_overwrite() {
        let (paths, _guard) = temp_paths();
        let mut first = request(PdcBodyProfile::Html);
        first.body = "<h1>Captured session</h1><p>Source HTML.</p>".into();
        let one = create_document(&paths, first.clone()).unwrap();
        let first_bytes = fs::read(paths.vault.join(&one.path)).unwrap();
        let two = create_document(&paths, first).unwrap();
        assert_eq!(two.path, "Sessions/Captured-session-2.html");
        assert_eq!(fs::read(paths.vault.join(&one.path)).unwrap(), first_bytes);
        let source = read_document(&paths, &two.path).unwrap();
        assert!(
            source
                .content
                .starts_with("<!--\n---\nformat: pdc-document/2\n")
        );
        assert!(source.content.contains("-->\n<h1>Captured session</h1>"));
    }

    #[test]
    fn preserves_an_existing_vault_manifest_byte_for_byte() {
        let (paths, _guard) = temp_paths();
        fs::create_dir(paths.vault.join(PDC_DIR)).unwrap();
        let manifest = br#"{
  "format": "pdc-vault/1",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "created": "2026-01-02T03:04:05.006Z",
  "owner_extension": {"kept": true}
}
"#;
        fs::write(paths.vault.join(MANIFEST_PATH), manifest).unwrap();

        create_document(&paths, request(PdcBodyProfile::Markdown)).unwrap();

        assert_eq!(fs::read(paths.vault.join(MANIFEST_PATH)).unwrap(), manifest);
    }

    #[test]
    fn body_and_title_updates_are_digest_guarded_and_preserve_envelope() {
        let (paths, _guard) = temp_paths();
        let mut input = request(PdcBodyProfile::Markdown);
        input.properties[0].value = serde_json::json!({"nested": [1, true, "x"]});
        let created = create_document(&paths, input).unwrap();
        let before = read_document(&paths, &created.path).unwrap();
        let original_body = before.editable_body.as_deref().unwrap();
        let no_op = update_document(
            &paths,
            &created.path,
            &before.sha256,
            Some("Captured session"),
            Some(original_body),
        )
        .unwrap();
        assert_eq!(no_op.sha256, before.sha256);
        assert_eq!(no_op.content, before.content);

        let title_only = update_document(
            &paths,
            &created.path,
            &before.sha256,
            Some("Reviewed session"),
            None,
        )
        .unwrap();
        assert!(title_only.content.contains("title: Reviewed session\n"));
        assert_eq!(title_only.editable_body.as_deref(), Some(original_body));
        assert!(title_only.content.contains("cassette_source_ids:"));

        let updated = update_document(
            &paths,
            &created.path,
            &title_only.sha256,
            None,
            Some("# Captured session\n\nEdited body."),
        )
        .unwrap();
        assert_ne!(updated.sha256, before.sha256);
        assert_eq!(
            parsed_pdc(&before.content, PdcBodyProfile::Markdown)
                .envelope
                .get("cassette_source_ids"),
            parsed_pdc(&updated.content, PdcBodyProfile::Markdown)
                .envelope
                .get("cassette_source_ids")
        );
        assert!(
            updated
                .content
                .ends_with("# Captured session\n\nEdited body.")
        );
        assert!(
            update_document(&paths, &created.path, &before.sha256, None, Some("stale"))
                .unwrap_err()
                .to_string()
                .contains("external_change_conflict")
        );

        let file = paths.vault.join(&created.path);
        let after = fs::read(&file).unwrap();
        fs::write(
            &file,
            after
                .iter()
                .copied()
                .chain(b"external\n".iter().copied())
                .collect::<Vec<_>>(),
        )
        .unwrap();
        assert!(
            update_document(
                &paths,
                &created.path,
                &updated.sha256,
                None,
                Some("blocked")
            )
            .unwrap_err()
            .to_string()
            .contains("external_change_conflict")
        );
    }

    #[test]
    fn prepared_create_is_deferred_digest_bound_and_replayable() {
        let (paths, _guard) = temp_paths();
        let prepared = prepare_document(&paths, request(PdcBodyProfile::Markdown)).unwrap();
        let file = paths.vault.join(&prepared.path);
        assert!(!file.exists());
        assert_eq!(prepared.sha256, digest(prepared.content.as_bytes()));

        let first = create_prepared_document(&paths, &prepared).unwrap();
        assert_eq!(first.sha256, prepared.sha256);
        let replay = create_prepared_document(&paths, &prepared).unwrap();
        assert_eq!(replay, first);
        assert_eq!(fs::read_to_string(file).unwrap(), prepared.content);

        let mut altered = prepared.clone();
        altered.content.push_str("external\n");
        assert!(create_prepared_document(&paths, &altered).is_err());
    }

    #[test]
    fn prepared_update_replays_identical_bytes_and_rejects_external_changes() {
        let (paths, _guard) = temp_paths();
        let created = create_document(&paths, request(PdcBodyProfile::Markdown)).unwrap();
        let before = read_document(&paths, &created.path).unwrap();
        let candidate = prepare_update_source(
            &before,
            None,
            None,
            &[("cassette_status".into(), "recorded".into())],
        )
        .unwrap()
        .unwrap();
        let first =
            update_prepared_document(&paths, &created.path, &before.sha256, &candidate).unwrap();
        assert_eq!(first.sha256, digest(&candidate));
        let replay =
            update_prepared_document(&paths, &created.path, &before.sha256, &candidate).unwrap();
        assert_eq!(replay.sha256, first.sha256);
        assert_eq!(replay.editable_body, before.editable_body);
        assert!(replay.content.contains("cassette_status: recorded"));

        let file = paths.vault.join(&created.path);
        fs::write(&file, format!("{}external change\n", replay.content)).unwrap();
        assert!(
            update_prepared_document(&paths, &created.path, &before.sha256, &candidate).is_err()
        );
    }

    #[test]
    fn rejects_unsafe_content_hidden_paths_and_invalid_manifest() {
        let (paths, _guard) = temp_paths();
        let mut unsafe_doc = request(PdcBodyProfile::Markdown);
        unsafe_doc.body = "<script>alert(1)</script>".into();
        assert!(create_document(&paths, unsafe_doc).is_err());
        let mut hidden_folder = request(PdcBodyProfile::Markdown);
        hidden_folder.folder = ".private".into();
        assert!(create_document(&paths, hidden_folder).is_err());

        fs::create_dir_all(paths.vault.join(PDC_DIR)).unwrap();
        fs::write(paths.vault.join(MANIFEST_PATH), "{}\n").unwrap();
        assert!(create_document(&paths, request(PdcBodyProfile::Markdown)).is_err());
    }

    #[test]
    fn creation_rejects_multiline_titles_up_front() {
        let (paths, _guard) = temp_paths();
        let mut multiline = request(PdcBodyProfile::Markdown);
        multiline.title = "Two\nlines".into();
        let error = create_document(&paths, multiline).unwrap_err();
        assert!(error.to_string().contains("single line"));
        // Nothing was written before the validation error.
        assert!(!paths.vault.join("Sessions").join("Two").exists());

        let mut carriage = request(PdcBodyProfile::Markdown);
        carriage.title = "Two\rlines".into();
        assert!(create_document(&paths, carriage).is_err());
    }

    #[test]
    fn metadata_updates_cannot_override_the_envelope_title() {
        let (paths, _guard) = temp_paths();
        let created = create_document(&paths, request(PdcBodyProfile::Markdown)).unwrap();
        let before = read_document(&paths, &created.path).unwrap();
        let prepared =
            prepare_update_source(&before, None, None, &[("title".into(), "Hijacked".into())]);
        assert!(
            prepared.is_err(),
            "reserved envelope title must be rejected as metadata"
        );
        assert!(before.content.contains("title: Captured session"));
    }

    #[test]
    fn writer_and_reader_agree_on_canonical_manifest_uuids() {
        use crate::pdc_inventory as inventory;
        // The shared predicate rejects non-canonical spellings, the nil
        // UUID, and non-RFC variants, so a manifest accepted by the writer
        // can never surface as invalid_manifest in `scan`.
        assert!(inventory::is_canonical_uuid(
            "018f6d2a-39df-7cc1-9f31-ea6a86f5f3b2"
        ));
        assert!(!is_canonical_uuid("018F6D2A-39DF-7CC1-9F31-EA6A86F5F3B2"));
        assert!(!is_canonical_uuid("00000000-0000-0000-0000-000000000000"));
        assert!(!is_canonical_uuid("ffffffff-ffff-4fff-cfff-ffffffffffff"));

        let (paths, _guard) = temp_paths();
        let manifest = r#"{"format":"pdc-vault/1","id":"00000000-0000-0000-0000-000000000000","created":"2026-09-14T12:34:56.789Z"}"#;
        fs::create_dir_all(paths.vault.join(PDC_DIR)).unwrap();
        fs::write(paths.vault.join(MANIFEST_PATH), manifest).unwrap();
        let writer_error = ensure_manifest(&paths.vault)
            .expect_err("nil-UUID manifest must be rejected by the writer");
        assert!(writer_error.to_string().contains("canonical UUID"));
        let scanned = scan(&paths).unwrap();
        assert!(scanned.manifest_diagnostic.is_some());

        let (paths, _guard) = temp_paths();
        let manifest = format!(
            "{{\"format\":\"pdc-vault/1\",\"id\":\"{}\",\"created\":\"2026-01-02T03:04:05.678Z\"}}\n",
            "00000000-0000-0000-0000-000000000000"
        );
        fs::create_dir_all(paths.vault.join(PDC_DIR)).unwrap();
        fs::write(paths.vault.join(MANIFEST_PATH), manifest).unwrap();
        let writer_error = create_document(&paths, request(PdcBodyProfile::Markdown))
            .expect_err("nil-UUID manifest must be rejected by the writer");
        assert!(writer_error.to_string().contains("canonical UUID"));
        let scanned = scan(&paths).unwrap();
        assert!(scanned.manifest_diagnostic.is_some());
    }
}
