//! Canonical creation and source-preserving adapter for the existing note UI.
//! Foreign/legacy PDC documents retain the guarded PDC source-editor path.

use std::path::Path;

use oxi_frontmatter::pdc::{Classification, DocumentExt, Yaml, classify, save_guarded};
use oxi_frontmatter::{
    FrontmatterError, Mutation, NoteFormat, Synthesize, Table, Value, WriteOutcome,
};
use serde_yaml_ng::{Mapping, Value as YamlValue};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;

use crate::pdc_documents::{PdcBodyProfile, PdcCreateRequest, PdcProperty};
use crate::{CoreError, Result};

const INTERNAL: [&str; 5] = ["format", "body", "title", "tags", "oximemo_editor"];

pub(crate) fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn ext(fmt: NoteFormat) -> DocumentExt {
    match fmt {
        NoteFormat::Markdown => DocumentExt::Markdown,
        NoteFormat::Html => DocumentExt::Html,
    }
}

/// Only supported source-preserving Oximemo documents enter the old DTO.
/// Unsupported value shapes stay readable in the PDC source editor.
pub(crate) fn projection(content: &str, fmt: NoteFormat) -> Option<(Table, String)> {
    let Classification::Valid(doc) = classify(ext(fmt), content.as_bytes()) else {
        return None;
    };
    if doc.legacy || doc.envelope.get("oximemo_editor")?.as_str()? != "source" {
        return None;
    }
    let Yaml::Map(entries) = &doc.envelope else {
        return None;
    };
    let mut table = Table::new();
    for (key, value) in entries {
        let value = match value {
            Yaml::Str(s) => Value::Str(s.clone()),
            Yaml::Bool(b) => Value::Bool(*b),
            Yaml::Seq(items) => Value::Array(
                items
                    .iter()
                    .map(|item| item.as_str().map(str::to_string))
                    .collect::<Option<Vec<_>>>()?,
            ),
            _ => return None,
        };
        table.insert(key.clone(), value);
    }
    Some((table, content[doc.body_range].to_string()))
}

pub(crate) fn visible_props(props: &crate::props::Props) -> crate::props::Props {
    if !props.contains_key("oximemo_editor") {
        return props.clone();
    }
    props
        .iter()
        .filter(|(key, _)| !INTERNAL.contains(&key.as_str()) && key.as_str() != "deleted_at")
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

pub(crate) fn title(memo: &crate::Memo, fmt: crate::memo::NoteFormat) -> Option<String> {
    if memo.props.contains_key("oximemo_editor")
        && let Some(crate::props::PropValue::Str(title)) = memo.props.get("title")
        && !title.is_empty()
    {
        return Some(title.clone());
    }
    crate::memo::note_title(fmt, &memo.body)
}

pub(crate) fn create(
    vault: &Path,
    path: &Path,
    body: &str,
    fmt: NoteFormat,
    props: &crate::props::Props,
) -> Result<()> {
    let relative = path
        .strip_prefix(vault)
        .map_err(|_| CoreError::other("PDC destination escapes the vault"))?;
    let mut parent = vault.to_path_buf();
    for component in relative.parent().into_iter().flat_map(Path::components) {
        let std::path::Component::Normal(name) = component else {
            return Err(CoreError::other("PDC destination contains traversal"));
        };
        if name.to_string_lossy().starts_with('.') {
            return Err(CoreError::other("hidden PDC destination"));
        }
        parent.push(name);
        let meta = std::fs::symlink_metadata(&parent)?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err(CoreError::other(
                "PDC destination is not a regular directory",
            ));
        }
    }
    let profile = match fmt {
        NoteFormat::Markdown => PdcBodyProfile::Markdown,
        NoteFormat::Html => PdcBodyProfile::Html,
    };
    let mut properties: Vec<PdcProperty> = props
        .iter()
        .filter(|(key, _)| !INTERNAL.contains(&key.as_str()))
        .map(|(key, value)| PdcProperty {
            key: key.clone(),
            value: match value {
                crate::props::PropValue::Str(s) => serde_json::json!(s),
                crate::props::PropValue::Bool(b) => serde_json::json!(b),
                crate::props::PropValue::List(items) => serde_json::json!(items),
            },
        })
        .collect();
    properties.push(PdcProperty {
        key: "oximemo_editor".into(),
        value: serde_json::json!("source"),
    });
    let body = body.replace("\r\n", "\n").replace('\r', "\n");
    let request = PdcCreateRequest {
        folder: String::new(),
        title: String::new(),
        tags: crate::memo::tags_of(crate::memo::NoteFormat::from_path(path), &body),
        body: body.clone(),
        body_profile: profile,
        properties,
    };
    let source = crate::pdc_documents::serialize_new_document(
        &request,
        &body,
        &uuid::Uuid::now_v7().to_string(),
        &crate::pdc_documents::canonical_now()?,
    )?;
    crate::pdc_documents::validate_new_source(profile, source.as_bytes())?;
    crate::pdc_documents::ensure_manifest(vault)?;
    crate::pdc_documents::atomic_create(path, source.as_bytes())?;
    Ok(())
}

fn yaml_value(value: &Value) -> YamlValue {
    match value {
        Value::Str(s) => YamlValue::String(s.clone()),
        Value::Bool(b) => YamlValue::Bool(*b),
        Value::Array(items) => {
            YamlValue::Sequence(items.iter().cloned().map(YamlValue::String).collect())
        }
        Value::Map(table) => YamlValue::Mapping(
            table
                .iter()
                .map(|(key, value)| (YamlValue::String(key.clone()), yaml_value(value)))
                .collect(),
        ),
    }
}

/// Patch only changed top-level fields; all other envelope/body bytes survive.
pub(crate) fn update(
    path: &Path,
    body: &str,
    fmt: NoteFormat,
    mutation: Mutation,
    expected: Option<&str>,
) -> Result<WriteOutcome> {
    let meta = std::fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err(CoreError::other("PDC source is not a regular file"));
    }
    let snapshot = std::fs::read(path)?;
    if expected.is_some_and(|sha| sha != digest(&snapshot)) {
        return Err(CoreError::other(
            "external_change_conflict: source changed since editing began",
        ));
    }
    let Classification::Valid(doc) = classify(ext(fmt), &snapshot) else {
        return Err(CoreError::other(
            "unsupported_lossless_edit: invalid PDC source",
        ));
    };
    if doc.legacy {
        return Err(CoreError::other(
            "unsupported_lossless_edit: legacy PDC is read-only",
        ));
    }
    let source = std::str::from_utf8(&snapshot).map_err(|e| CoreError::other(e.to_string()))?;
    let (start, end) =
        envelope_range(source, fmt).ok_or_else(|| CoreError::other("invalid_transport"))?;
    let original: Mapping = serde_yaml_ng::from_str(&source[start..end])
        .map_err(|e| CoreError::other(e.to_string()))?;
    let mut changes: Vec<(String, Option<YamlValue>)> = mutation
        .set_props
        .into_iter()
        .filter(|(key, _)| {
            !INTERNAL.contains(&key.as_str()) && !crate::props::CORE_KEYS.contains(&key.as_str())
        })
        .map(|(key, value)| (key, value.as_ref().map(yaml_value)))
        .collect();
    if let Some(favorite) = mutation.favorite {
        changes.push(("favorite".into(), Some(YamlValue::Bool(favorite))));
    }
    if let Some(deleted) = mutation.deleted {
        changes.push(("deleted".into(), Some(YamlValue::Bool(deleted.is_some()))));
        changes.push((
            "deleted_at".into(),
            match deleted {
                Some(_) => Some(YamlValue::String(crate::pdc_documents::canonical_now()?)),
                None => None,
            },
        ));
    }
    let old_body = &source[doc.body_range.clone()];
    let body_changed = body != old_body;
    // Envelope tags are authoritative. A body edit cannot replace them with
    // inferred hashtags; tag metadata requires its own explicit mutation.
    changes.retain(|(key, next)| original.get(YamlValue::String(key.clone())) != next.as_ref());
    if !body_changed && changes.is_empty() {
        return Ok(WriteOutcome::NoOp);
    }
    changes.push((
        "updated".into(),
        Some(YamlValue::String(crate::pdc_documents::next_timestamp(
            &doc,
        )?)),
    ));
    let mut envelope = source[start..end].to_string();
    for (key, next) in changes {
        envelope = patch_field(&envelope, &key, next)?;
    }
    let mut candidate = source.as_bytes()[..start].to_vec();
    candidate.extend_from_slice(envelope.as_bytes());
    candidate.extend_from_slice(&snapshot[end..doc.body_range.start]);
    candidate.extend_from_slice(if body_changed {
        body.as_bytes()
    } else {
        old_body.as_bytes()
    });
    crate::pdc_documents::validate_update(&doc, ext(fmt), &candidate)?;
    let current = std::fs::read(path)?;
    let candidate = save_guarded(&snapshot, &current, candidate)
        .map_err(|e| CoreError::other(e.to_string()))?;
    oxi_frontmatter::atomic_write(path, &candidate)?;
    Ok(WriteOutcome::Written)
}

fn envelope_range(source: &str, fmt: NoteFormat) -> Option<(usize, usize)> {
    let start = match fmt {
        NoteFormat::Markdown => source.find('\n')? + 1,
        NoteFormat::Html => {
            source.find('\n')? + 1 + source[source.find('\n')? + 1..].find('\n')? + 1
        }
    };
    let mut offset = start;
    for line in source[start..].split_inclusive('\n') {
        if line.trim_end_matches(['\r', '\n']) == "---" {
            return Some((start, offset));
        }
        offset += line.len();
    }
    None
}

fn patch_field(envelope: &str, key: &str, next: Option<YamlValue>) -> Result<String> {
    let lines: Vec<&str> = envelope.split_inclusive('\n').collect();
    let mut span = None;
    let mut offset = 0;
    for (i, line) in lines.iter().enumerate() {
        if !line.starts_with([' ', '\t', '#', '\r', '\n']) {
            // Canonical fields use simple keys. Foreign quoted spellings remain
            // readable but require the dedicated source editor for metadata edits.
            if line
                .split_once(':')
                .is_some_and(|(raw, _)| raw.trim_matches(['\'', '"']) == key)
            {
                let mut end = offset + line.len();
                for continuation in &lines[i + 1..] {
                    if continuation.starts_with([' ', '\t', '-'])
                        && !continuation.trim_start().starts_with('#')
                    {
                        end += continuation.len();
                    } else {
                        break;
                    }
                }
                span = Some((offset, end));
                break;
            }
        }
        offset += line.len();
    }
    let replacement = if let Some(value) = next {
        let map: Mapping = [(YamlValue::String(key.into()), value)]
            .into_iter()
            .collect();
        serde_yaml_ng::to_string(&map).map_err(|e| CoreError::other(e.to_string()))?
    } else {
        String::new()
    };
    match span {
        Some((start, end)) => Ok(format!(
            "{}{}{}",
            &envelope[..start],
            replacement,
            &envelope[end..]
        )),
        None => Ok(format!("{envelope}{replacement}")),
    }
}

/// Existing callers retain their legacy adapter; canonical files never pass
/// through the legacy emitter (which would normalize/drop PDC fields).
pub(crate) fn write_document(
    path: &Path,
    body: &str,
    fmt: NoteFormat,
    mutation: Mutation,
    synth: Synthesize,
    now: OffsetDateTime,
) -> std::result::Result<WriteOutcome, FrontmatterError> {
    if std::fs::read_to_string(path)
        .ok()
        .is_some_and(|source| crate::pdc_inventory::is_pdc_document(&source))
    {
        return update(path, body, fmt, mutation, None).map_err(|e| {
            FrontmatterError::Unemittable {
                reason: e.to_string(),
            }
        });
    }
    oxi_frontmatter::write_document(path, body, fmt, mutation, synth, now)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_creation_covers_both_profiles_without_changing_body_bytes() {
        let vault = tempfile::tempdir().unwrap();
        for (name, fmt, body) in [
            (
                "note.md",
                NoteFormat::Markdown,
                "# Title\n\n- [ ] task #work",
            ),
            ("note.html", NoteFormat::Html, "<h1>Title</h1><p>Body</p>"),
        ] {
            let path = vault.path().join(name);
            create(vault.path(), &path, body, fmt, &Default::default()).unwrap();
            let source = std::fs::read(&path).unwrap();
            let Classification::Valid(doc) = classify(ext(fmt), &source) else {
                panic!("new note must be canonical")
            };
            assert!(!doc.legacy);
            assert_eq!(&source[doc.body_range], body.as_bytes());
            assert!(projection(std::str::from_utf8(&source).unwrap(), fmt).is_some());
            assert!(vault.path().join(".pdc/vault.json").is_file());
        }
    }

    #[test]
    fn metadata_patch_preserves_comments_quoting_unknown_fields_and_body_for_both_profiles() {
        let vault = tempfile::tempdir().unwrap();
        for (name, fmt, body) in [
            ("note.md", NoteFormat::Markdown, "# Title\n\nRaw **body**"),
            (
                "note.html",
                NoteFormat::Html,
                "<h1>Title</h1><p style=\"color:blue\">Body</p>",
            ),
        ] {
            let path = vault.path().join(name);
            create(vault.path(), &path, body, fmt, &Default::default()).unwrap();
            let source = std::fs::read_to_string(&path).unwrap().replace(
                "oximemo_editor: source",
                "# Keep this comment\ncustom: 'a: b'\noximemo_editor: source",
            );
            std::fs::write(&path, &source).unwrap();
            let sha = digest(source.as_bytes());
            assert_eq!(
                update(&path, body, fmt, Mutation::default(), Some(&sha)).unwrap(),
                WriteOutcome::NoOp
            );
            assert_eq!(std::fs::read_to_string(&path).unwrap(), source);
            update(
                &path,
                body,
                fmt,
                Mutation {
                    favorite: Some(true),
                    ..Default::default()
                },
                Some(&sha),
            )
            .unwrap();
            let saved = std::fs::read_to_string(&path).unwrap();
            assert!(saved.contains("# Keep this comment\ncustom: 'a: b'\noximemo_editor: source"));
            let Classification::Valid(doc) = classify(ext(fmt), saved.as_bytes()) else {
                panic!("patched source must remain canonical")
            };
            assert_eq!(&saved[doc.body_range], body);
            assert_eq!(
                doc.envelope.get("favorite").and_then(Yaml::as_bool),
                Some(true)
            );
        }
    }

    #[test]
    fn body_edits_preserve_authoritative_tags_and_untouched_envelope_bytes() {
        let vault = tempfile::tempdir().unwrap();
        for (name, fmt, body, replacement) in [
            (
                "note.md",
                NoteFormat::Markdown,
                "# Title\n\nBody",
                "# Title\n\nChanged #inline-only",
            ),
            (
                "note.html",
                NoteFormat::Html,
                "<h1>Title</h1><p>Body</p>",
                "<h1>Title</h1><p>Changed #inline-only</p>",
            ),
        ] {
            let path = vault.path().join(name);
            create(vault.path(), &path, body, fmt, &Default::default()).unwrap();
            let source = std::fs::read_to_string(&path).unwrap().replace(
                "oximemo_editor: source",
                "tags: ['owner-defined'] # Preserve spelling\ncustom: 'keep: this'\noximemo_editor: source",
            );
            std::fs::write(&path, &source).unwrap();
            update(
                &path,
                replacement,
                fmt,
                Mutation::default(),
                Some(&digest(source.as_bytes())),
            )
            .unwrap();
            let saved = std::fs::read_to_string(&path).unwrap();
            let Classification::Valid(doc) = classify(ext(fmt), saved.as_bytes()) else {
                panic!("body edit must remain canonical")
            };
            assert_eq!(&saved[doc.body_range], replacement);
            let (before_start, before_end) = envelope_range(&source, fmt).unwrap();
            let (after_start, after_end) = envelope_range(&saved, fmt).unwrap();
            let unchanged = |text: &str| {
                text.lines()
                    .filter(|line| !line.starts_with("updated:"))
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            };
            assert_eq!(
                unchanged(&source[before_start..before_end]),
                unchanged(&saved[after_start..after_end]),
            );
        }
    }

    #[test]
    fn editor_snapshot_refuses_external_changes_and_preserves_the_external_bytes() {
        let vault = tempfile::tempdir().unwrap();
        let path = vault.path().join("note.md");
        create(
            vault.path(),
            &path,
            "# Title",
            NoteFormat::Markdown,
            &Default::default(),
        )
        .unwrap();
        let source = std::fs::read(&path).unwrap();
        let external = String::from_utf8(source.clone()).unwrap() + "\nExternal edit";
        std::fs::write(&path, &external).unwrap();
        let error = update(
            &path,
            "# Local edit",
            NoteFormat::Markdown,
            Mutation::default(),
            Some(&digest(&source)),
        )
        .unwrap_err();
        assert!(error.to_string().contains("external_change_conflict"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), external);
    }

    #[test]
    fn unsupported_property_shapes_stay_on_the_guarded_source_editor_path() {
        let vault = tempfile::tempdir().unwrap();
        let path = vault.path().join("note.md");
        create(
            vault.path(),
            &path,
            "# Title",
            NoteFormat::Markdown,
            &Default::default(),
        )
        .unwrap();
        let source = std::fs::read_to_string(&path).unwrap().replace(
            "oximemo_editor: source",
            "extra:\n  nested: 7\noximemo_editor: source",
        );
        std::fs::write(&path, &source).unwrap();
        assert!(matches!(
            classify(DocumentExt::Markdown, source.as_bytes()),
            Classification::Valid(_)
        ));
        assert!(projection(&source, NoteFormat::Markdown).is_none());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), source);
    }
}
