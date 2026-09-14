//! Oximemo's PDC document-plane constants and the machine-readable
//! migration-report contract.
//!
//! Stage 0 of `docs/PDC-MIGRATION.md` freezes the `x_oximemo` extension
//! namespace (see `docs/pdc/X-OXIMEMO-v1.md`) and the per-document
//! migration report schema (`docs/pdc/migration-report-v1.schema.json`)
//! before any converter exists. The types here are the executable form
//! of that freeze: envelope grammar lives in `oxi-frontmatter::pdc`,
//! and the importer stages build on these types without redefining
//! field names.

use serde::{Deserialize, Serialize};

/// `schema` literal every report carries.
pub const REPORT_SCHEMA: &str = "oximemo-pdc-migration-report/1";

/// `pdc-query/1` — the vault-level query contract (PDC-QUERY-1.0),
/// declared via `query` in `.pdc/vault.json` and carried by `.base`
/// files and `base`-fenced blocks in `pdc-markdown/1` bodies. It is
/// read-only: queries are never executed as part of migration and
/// carry no authorization semantics.
pub const QUERY_SCHEMA: &str = "pdc-query/1";

/// Registry document this module mirrors.
pub const REGISTRY_DOC: &str = "docs/pdc/X-OXIMEMO-v1.md";

/// Envelope extension map namespace (PDC §5.3); Oximemo is its only
/// Writer.
pub const X_NAMESPACE: &str = "x_oximemo";

/// `x_oximemo` key holding the original identifier of a legacy memo
/// whose canonical ID had to be freshly allocated.
pub const KEY_LEGACY_ID: &str = "legacy_id";

/// `data-x-oximemo-*` attribute prefix for body semantics.
pub const ATTR_PREFIX: &str = "data-x-oximemo-";

/// One finding of the dry-run importer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Finding {
    /// Finding category.
    pub kind: FindingKind,
    /// Line reference or selector inside the source; `None` when the
    /// finding is document-level.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    /// Human-readable explanation.
    pub detail: String,
    /// What the importer did or proposes to do; optional. The schema
    /// allows omission but not explicit `null`.
    #[serde(
        default,
        deserialize_with = "require_optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub action: Option<String>,
}

/// Classification of a single migration finding.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FindingKind {
    /// Lossless mapping exists.
    Safe,
    /// More than one target interpretation exists; the importer did not
    /// pick one silently.
    Ambiguous,
    /// Construct fails the transport/profile safety checks.
    Unsafe,
    /// Value moved to a managed asset or extension map.
    Externalized,
    /// Construct cannot survive conversion; the source stays readable.
    Unsupported,
}

/// User decision on replacing a source document.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    /// Report produced, awaiting review.
    Pending,
    /// User authorized replacement of the source.
    Approved,
    /// User declined conversion.
    Rejected,
    /// Candidate target written and source replaced per authorization.
    Converted,
}

/// Machine-readable migration report for exactly one source document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MigrationReport {
    /// Always [`REPORT_SCHEMA`]; any other value is rejected on
    /// deserialization to prevent contract-version confusion.
    #[serde(deserialize_with = "require_report_schema")]
    pub schema: String,
    /// Vault-relative source path; the schema pins `minLength: 1`.
    #[serde(deserialize_with = "require_non_empty")]
    pub source: String,
    /// SHA-256 of the exact source bytes the findings describe.
    #[serde(deserialize_with = "require_sha256_hex")]
    pub source_sha256: String,
    /// Source dialect identifier.
    pub source_format: SourceFormat,
    /// Vault-relative candidate path; `None` while the mapping is
    /// incomplete. The schema allows omission but not explicit `null`.
    #[serde(
        default,
        deserialize_with = "require_optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub target: Option<String>,
    /// Body profile of the candidate target.
    pub target_profile: TargetProfile,
    /// Canonical PDC UUID: preserved legacy UUID or allocated UUIDv7.
    #[serde(deserialize_with = "require_canonical_uuid")]
    pub document_id: String,
    /// Every finding the importer produced.
    pub findings: Vec<Finding>,
    /// User decision; conversion requires an explicit approval record.
    pub decision: Decision,
    /// Canonical UTC millisecond timestamp of report generation.
    #[serde(deserialize_with = "require_utc_millis")]
    pub generated_at: String,
}

/// Legacy source dialect the importer read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SourceFormat {
    /// Constrained-YAML Markdown memo.
    #[serde(rename = "oximemo-markdown/1")]
    Markdown,
    /// Comment-wrapped HTML memo without the PDC transport.
    #[serde(rename = "oximemo-html-legacy/1")]
    LegacyHtml,
    /// Legacy `pdc-djot/1` document under a `pdc-document/1` envelope.
    #[serde(rename = "pdc-djot-legacy/1")]
    Djot,
}

/// Canonical body profile a conversion targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TargetProfile {
    /// Canonical Markdown profile (`pdc-markdown/1`, lowercase `.md`).
    #[serde(rename = "pdc-markdown/1")]
    Markdown,
    /// Authored HTML profile.
    #[serde(rename = "pdc-html/1")]
    Html,
    /// Legacy Djot profile; only produced when the user explicitly
    /// authorizes conversion toward a v1 target (kept for v1 report
    /// compatibility).
    #[serde(rename = "pdc-djot/1")]
    Djot,
}

/// Deserialization guards mirroring the frozen schema's format
/// constraints (`docs/pdc/migration-report-v1.schema.json`): a report
/// is rejected at the boundary unless its format-sensitive fields
/// carry exactly the canonical wire spelling, so importer stages
/// never see an off-contract value.
fn require_report_schema<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if value == REPORT_SCHEMA {
        Ok(value)
    } else {
        Err(serde::de::Error::invalid_value(
            serde::de::Unexpected::Str(&value),
            &REPORT_SCHEMA,
        ))
    }
}

/// 64 lowercase hex digits — the schema's `^[0-9a-f]{64}$`.
fn require_sha256_hex<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if value.len() == 64
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        Ok(value)
    } else {
        Err(serde::de::Error::invalid_value(
            serde::de::Unexpected::Str(&value),
            &"64 lowercase hex digits",
        ))
    }
}

/// Canonical lowercase hyphenated UUID, version 1–8, RFC 4122
/// variant — the schema's `document_id` pattern.
fn require_canonical_uuid<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use uuid::Uuid;
    let value = String::deserialize(deserializer)?;
    let parsed = Uuid::parse_str(&value).map_err(|_| {
        serde::de::Error::invalid_value(
            serde::de::Unexpected::Str(&value),
            &"canonical lowercase hyphenated UUID (version 1–8)",
        )
    })?;
    let version_ok = (1..=8).contains(&parsed.get_version_num());
    let variant_ok = matches!(parsed.get_variant(), uuid::Variant::RFC4122);
    if version_ok && variant_ok && parsed.as_hyphenated().to_string() == value {
        Ok(value)
    } else {
        Err(serde::de::Error::invalid_value(
            serde::de::Unexpected::Str(&value),
            &"canonical lowercase hyphenated UUID (version 1–8)",
        ))
    }
}

/// Strict `YYYY-MM-DDTHH:MM:SS.mmmZ` — the schema's `generated_at`
/// pattern (RFC 3339, UTC, exactly millisecond precision). The shape
/// check pins the spelling; the calendar parse rejects impossible
/// dates the regex alone would admit.
fn require_utc_millis<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    let b = value.as_bytes();
    let digit = |i: usize| b[i].is_ascii_digit();
    let shape = b.len() == 24
        && digit(0)
        && digit(1)
        && digit(2)
        && digit(3)
        && b[4] == b'-'
        && digit(5)
        && digit(6)
        && b[7] == b'-'
        && digit(8)
        && digit(9)
        && b[10] == b'T'
        && digit(11)
        && digit(12)
        && b[13] == b':'
        && digit(14)
        && digit(15)
        && b[16] == b':'
        // 00–59 only: `time`'s RFC 3339 parser tolerates the leap
        // second `ss = 60`, which the frozen schema rejects.
        && (b'0'..=b'5').contains(&b[17])
        && digit(18)
        && b[19] == b'.'
        && digit(20)
        && digit(21)
        && digit(22)
        && b[23] == b'Z';
    if !shape {
        return Err(serde::de::Error::invalid_value(
            serde::de::Unexpected::Str(&value),
            &"YYYY-MM-DDTHH:MM:SS.mmmZ UTC timestamp",
        ));
    }
    time::OffsetDateTime::parse(&value, &time::format_description::well_known::Rfc3339).map_err(
        |_| {
            serde::de::Error::invalid_value(
                serde::de::Unexpected::Str(&value),
                &"valid UTC calendar date",
            )
        },
    )?;
    Ok(value)
}

/// Non-empty string — the schema's `source` `minLength: 1`.
fn require_non_empty<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if value.is_empty() {
        Err(serde::de::Error::invalid_value(
            serde::de::Unexpected::Str(&value),
            &"a non-empty string",
        ))
    } else {
        Ok(value)
    }
}

/// Optional string that rejects explicit `null`: the frozen schema
/// types `action`/`target` as `"string"` only — omit the key instead.
fn require_optional_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    match Option::<String>::deserialize(deserializer)? {
        Some(value) => Ok(Some(value)),
        None => Err(serde::de::Error::invalid_type(
            serde::de::Unexpected::Unit,
            &"a string, or omit the key",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCHEMA_PATH: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../docs/pdc/migration-report-v1.schema.json"
    );

    fn sample() -> MigrationReport {
        MigrationReport {
            schema: REPORT_SCHEMA.to_string(),
            source: "notes/아이디어.md".to_string(),
            source_sha256: "ab".repeat(32),
            source_format: SourceFormat::Markdown,
            target: Some("notes/아이디어.djot".to_string()),
            target_profile: TargetProfile::Djot,
            document_id: "018f47c6-4a77-7c52-9db8-0e5f9bcb17db".to_string(),
            findings: vec![
                Finding {
                    kind: FindingKind::Safe,
                    location: Some("L1-L8".to_string()),
                    detail: "frontmatter maps to the PDC envelope".to_string(),
                    action: None,
                },
                Finding {
                    kind: FindingKind::Ambiguous,
                    location: Some("L12".to_string()),
                    detail: "[[회의]] matches two notes by title".to_string(),
                    action: Some("keep as legacy wiki link".to_string()),
                },
                Finding {
                    kind: FindingKind::Externalized,
                    location: None,
                    detail: "image moved to a managed SHA-256 asset".to_string(),
                    action: Some("rewrite reference after asset copy".to_string()),
                },
            ],
            decision: Decision::Pending,
            generated_at: "2026-09-14T12:00:00.000Z".to_string(),
        }
    }

    /// The report type and the frozen schema file must not drift: the
    /// schema's `properties.schema.const` pins [`REPORT_SCHEMA`], and
    /// every field, finding kind, and decision value must appear in
    /// the schema document.
    #[test]
    fn schema_file_matches_types() {
        let raw = match std::fs::read_to_string(SCHEMA_PATH) {
            Ok(raw) => raw,
            // `docs/` lives outside the crate root and is not shipped
            // in the published package, so a packaged test tree cannot
            // see it. Only that case skips; any other read error must
            // not silently disable the drift guarantee.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                eprintln!("skipping schema drift check: {SCHEMA_PATH} not found");
                return;
            }
            Err(e) => panic!("failed to read frozen schema {SCHEMA_PATH}: {e}"),
        };
        let schema: serde_json::Value = serde_json::from_str(&raw).expect("schema parses");

        assert_eq!(
            schema["properties"]["schema"]["const"],
            serde_json::Value::String(REPORT_SCHEMA.to_string())
        );
        let required: Vec<&str> = schema["required"]
            .as_array()
            .expect("required array")
            .iter()
            .map(|v| v.as_str().expect("string"))
            .collect();
        for field in [
            "schema",
            "source",
            "source_sha256",
            "source_format",
            "target_profile",
            "document_id",
            "findings",
            "decision",
            "generated_at",
        ] {
            assert!(required.contains(&field), "schema must require `{field}`");
        }

        assert_eq!(
            schema["properties"]["source"]["minLength"],
            serde_json::Value::Number(1.into()),
            "source must keep `minLength: 1`"
        );
        // Nullability is frozen: only `location` may be `null`;
        // `action` and `target` must be a string or absent.
        assert_eq!(
            schema["$defs"]["finding"]["properties"]["location"]["type"],
            serde_json::json!(["string", "null"])
        );
        for field in ["action", "target"] {
            let prop = if field == "action" {
                &schema["$defs"]["finding"]["properties"][field]
            } else {
                &schema["properties"][field]
            };
            assert_eq!(
                prop["type"],
                serde_json::Value::String("string".into()),
                "`{field}` must stay non-nullable"
            );
        }

        let finding_kinds: Vec<&str> = schema["$defs"]["finding"]["properties"]["kind"]["enum"]
            .as_array()
            .expect("finding kinds")
            .iter()
            .map(|v| v.as_str().expect("string"))
            .collect();
        for kind in [
            FindingKind::Safe,
            FindingKind::Ambiguous,
            FindingKind::Unsafe,
            FindingKind::Externalized,
            FindingKind::Unsupported,
        ] {
            let json = serde_json::to_value(kind).unwrap();
            assert!(
                finding_kinds.contains(&json.as_str().expect("string")),
                "schema must list finding kind {json}"
            );
        }

        let source_formats: Vec<&str> = schema["properties"]["source_format"]["enum"]
            .as_array()
            .expect("source format enum")
            .iter()
            .map(|v| v.as_str().expect("string"))
            .collect();
        for format in [SourceFormat::Markdown, SourceFormat::LegacyHtml] {
            let json = serde_json::to_value(format).unwrap();
            assert!(
                source_formats.contains(&json.as_str().expect("string")),
                "schema must list source format {json}"
            );
        }

        let target_profiles: Vec<&str> = schema["properties"]["target_profile"]["enum"]
            .as_array()
            .expect("target profile enum")
            .iter()
            .map(|v| v.as_str().expect("string"))
            .collect();
        for profile in [TargetProfile::Djot, TargetProfile::Html] {
            let json = serde_json::to_value(profile).unwrap();
            assert!(
                target_profiles.contains(&json.as_str().expect("string")),
                "schema must list target profile {json}"
            );
        }

        let finding_required: Vec<&str> = schema["$defs"]["finding"]["required"]
            .as_array()
            .expect("finding required array")
            .iter()
            .map(|v| v.as_str().expect("string"))
            .collect();
        for field in ["kind", "detail"] {
            assert!(
                finding_required.contains(&field),
                "finding must require `{field}`"
            );
        }
        let finding_properties = schema["$defs"]["finding"]["properties"]
            .as_object()
            .expect("finding properties object");
        for field in ["kind", "location", "detail", "action"] {
            assert!(
                finding_properties.contains_key(field),
                "finding must define `{field}`"
            );
        }

        let decisions: Vec<&str> = schema["properties"]["decision"]["enum"]
            .as_array()
            .expect("decision enum")
            .iter()
            .map(|v| v.as_str().expect("string"))
            .collect();
        for decision in [
            Decision::Pending,
            Decision::Approved,
            Decision::Rejected,
            Decision::Converted,
        ] {
            let json = serde_json::to_value(decision).unwrap();
            assert!(
                decisions.contains(&json.as_str().expect("string")),
                "schema must list decision {json}"
            );
        }
    }

    #[test]
    fn report_round_trips_with_wire_field_names() {
        let report = sample();
        let json = serde_json::to_value(&report).unwrap();
        assert_eq!(json["schema"], REPORT_SCHEMA);
        assert_eq!(json["source_format"], "oximemo-markdown/1");
        assert_eq!(json["target_profile"], "pdc-djot/1");
        assert_eq!(json["findings"][1]["kind"], "ambiguous");
        assert_eq!(json["decision"], "pending");
        // Optional fields are omitted, never null on the wire.
        assert!(json["findings"][0].get("action").is_none());

        let back: MigrationReport = serde_json::from_value(json).unwrap();
        assert_eq!(back, report);
    }

    /// Off-contract values must fail at the deserialization boundary:
    /// the guards mirror the frozen schema's `const`/`pattern` rules.
    #[test]
    fn report_rejects_off_contract_values() {
        let base = serde_json::to_value(sample()).unwrap();

        let mut json = base.clone();
        json["schema"] = "oximemo-pdc-migration-report/0".into();
        assert!(serde_json::from_value::<MigrationReport>(json).is_err());

        let mut json = base.clone();
        json["source_sha256"] = "AB".repeat(32).into();
        assert!(serde_json::from_value::<MigrationReport>(json).is_err());

        let mut json = base.clone();
        json["document_id"] = "018F47C6-4A77-7C52-9DB8-0E5F9BCB17DB".into();
        assert!(serde_json::from_value::<MigrationReport>(json).is_err());

        let mut json = base.clone();
        json["generated_at"] = "2026-09-14T12:00:00Z".into();
        assert!(serde_json::from_value::<MigrationReport>(json).is_err());

        let mut json = base.clone();
        json["source"] = "".into();
        assert!(serde_json::from_value::<MigrationReport>(json).is_err());

        let mut json = base.clone();
        json["target"] = serde_json::Value::Null;
        assert!(serde_json::from_value::<MigrationReport>(json).is_err());

        let mut json = base.clone();
        json["findings"][1]["action"] = serde_json::Value::Null;
        assert!(serde_json::from_value::<MigrationReport>(json).is_err());

        // `time` tolerates leap second 60; the frozen schema does not.
        let mut json = base.clone();
        json["generated_at"] = "2026-06-30T23:59:60.000Z".into();
        assert!(serde_json::from_value::<MigrationReport>(json).is_err());

        let mut json = base.clone();
        json["generated_at"] = "2026-02-31T12:00:00.000Z".into();
        assert!(serde_json::from_value::<MigrationReport>(json).is_err());

        // The canonical sample itself still passes every guard.
        assert!(serde_json::from_value::<MigrationReport>(base).is_ok());
    }

    #[test]
    fn registry_constants_are_stable() {
        // These strings are frozen contract surface; a rename is a
        // migration, not an edit.
        assert_eq!(X_NAMESPACE, "x_oximemo");
        assert_eq!(KEY_LEGACY_ID, "legacy_id");
        assert_eq!(ATTR_PREFIX, "data-x-oximemo-");
    }
}
