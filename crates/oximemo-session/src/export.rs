use crate::error::SessionError;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::sync::LazyLock;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

pub const EXPORT_FORMAT: &str = "cassette-session-export/1";
pub const MAX_INPUT_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_MESSAGES: usize = 5_000;
pub const MAX_MESSAGE_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionExport {
    pub format: String,
    pub source_kind: String,
    pub session_id: String,
    pub title: String,
    pub occurred_at: String,
    pub source_revision: String,
    pub complete: bool,
    pub messages: Vec<ExportMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExportMessage {
    pub id: String,
    pub role: String,
    pub text: String,
    #[serde(default)]
    pub occurred_at: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct ValidatedExport {
    pub export: SessionExport,
    pub canonical_json: String,
    pub digest: String,
    pub logical_source_id: String,
    pub session_id: String,
    pub secret_suspected: bool,
}

pub(crate) fn parse_export(bytes: &[u8]) -> Result<ValidatedExport, SessionError> {
    if bytes.len() > MAX_INPUT_BYTES {
        return Err(SessionError::invalid(
            "session export exceeds the 4 MiB limit",
        ));
    }
    let export: SessionExport = serde_json::from_slice(bytes).map_err(|_| {
        SessionError::invalid("session export is not valid cassette-session-export/1 JSON")
    })?;
    validate_export(&export)?;

    // Serialization of the strict struct yields one deterministic representation;
    // import identity and replay receipts therefore ignore insignificant JSON whitespace.
    let canonical_json = serde_json::to_string(&export)
        .map_err(|_| SessionError::invalid("session export could not be canonicalized"))?;
    let digest = digest(canonical_json.as_bytes());
    let logical_source_id = logical_source_id(&export.source_kind, &export.session_id);
    let session_id = revision_session_id(
        &export.source_kind,
        &export.session_id,
        &export.source_revision,
    );
    let secret_suspected = contains_secret(&canonical_json);

    Ok(ValidatedExport {
        export,
        canonical_json,
        digest,
        logical_source_id,
        session_id,
        secret_suspected,
    })
}

fn validate_export(export: &SessionExport) -> Result<(), SessionError> {
    if export.format != EXPORT_FORMAT {
        return Err(SessionError::invalid("unsupported session export format"));
    }
    if !valid_identifier(&export.source_kind) {
        return Err(SessionError::invalid("invalid session source kind"));
    }
    if !bounded_chars(&export.session_id, 256) {
        return Err(SessionError::invalid("invalid external session ID"));
    }
    if export.title.chars().count() > 512 {
        return Err(SessionError::invalid(
            "session title exceeds 512 characters",
        ));
    }
    if !valid_rfc3339(&export.occurred_at) {
        return Err(SessionError::invalid("session timestamp must be RFC 3339"));
    }
    if !bounded_chars(&export.source_revision, 128) {
        return Err(SessionError::invalid("invalid source revision"));
    }
    if export.messages.is_empty() || export.messages.len() > MAX_MESSAGES {
        return Err(SessionError::invalid(
            "session message count is out of bounds",
        ));
    }

    let mut ids = HashSet::with_capacity(export.messages.len());
    for message in &export.messages {
        if !ids.insert(&message.id) || !bounded_chars(&message.id, 256) {
            return Err(SessionError::invalid(
                "message IDs must be unique and bounded",
            ));
        }
        if !matches!(message.role.as_str(), "user" | "assistant" | "tool") {
            return Err(SessionError::invalid("unsupported message role"));
        }
        if message.text.len() > MAX_MESSAGE_BYTES {
            return Err(SessionError::invalid("a message exceeds the 512 KiB limit"));
        }
        if message
            .occurred_at
            .as_deref()
            .is_some_and(|timestamp| !valid_rfc3339(timestamp))
        {
            return Err(SessionError::invalid("message timestamp must be RFC 3339"));
        }
    }
    Ok(())
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn bounded_chars(value: &str, max: usize) -> bool {
    !value.is_empty() && value.chars().count() <= max && !value.chars().any(char::is_control)
}

fn valid_rfc3339(value: &str) -> bool {
    value.len() <= 40 && OffsetDateTime::parse(value, &Rfc3339).is_ok()
}

pub(crate) fn logical_source_id(source_kind: &str, external_id: &str) -> String {
    let namespace = Uuid::new_v5(&Uuid::NAMESPACE_URL, b"cassette-recorder-v1");
    Uuid::new_v5(
        &namespace,
        format!("{source_kind}\u{1}{external_id}").as_bytes(),
    )
    .to_string()
}

pub(crate) fn revision_session_id(source_kind: &str, external_id: &str, revision: &str) -> String {
    let namespace = Uuid::new_v5(&Uuid::NAMESPACE_URL, b"cassette-recorder-v1");
    Uuid::new_v5(
        &namespace,
        format!("{source_kind}\u{1}{external_id}\u{1}{revision}").as_bytes(),
    )
    .to_string()
}

pub(crate) fn digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

pub(crate) fn contains_secret(text: &str) -> bool {
    static PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        [
            r#"(?i)(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret)["']?\s*[:=]\s*["']?[^\s"',}]{8,}"#,
            r"\bsk-[A-Za-z0-9]{20,}\b",
            r"\bgh[pousr]_[A-Za-z0-9]{30,}\b",
            r"\bgithub_pat_[A-Za-z0-9_]{30,}\b",
            r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b",
            r"\bAKIA[0-9A-Z]{16}\b",
            r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----",
        ]
        .into_iter()
        .map(|pattern| Regex::new(pattern).expect("static secret detector regex compiles"))
        .collect()
    });
    PATTERNS.iter().any(|pattern| pattern.is_match(text))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn export_json() -> Vec<u8> {
        br#"{"format":"cassette-session-export/1","source_kind":"assistant","session_id":"external-1","title":"Title","occurred_at":"2026-10-01T12:30:00.000Z","source_revision":"r1","complete":true,"messages":[{"id":"m1","role":"user","text":"hello","occurred_at":null}]}"#.to_vec()
    }

    #[test]
    fn parses_and_derives_stable_identity_from_explicit_export() {
        let parsed = parse_export(&export_json()).unwrap();
        let again = parse_export(&export_json()).unwrap();
        assert_eq!(parsed.session_id, again.session_id);
        assert_eq!(parsed.digest, again.digest);
        assert_eq!(parsed.export.messages[0].text, "hello");
        assert!(parsed.session_id.len() == 36);
    }

    #[test]
    fn rejects_unknown_fields_and_invalid_boundaries() {
        let mut unknown = export_json();
        let text = String::from_utf8(unknown.clone()).unwrap();
        unknown = text
            .replace("\"complete\":true", "\"complete\":true,\"extra\":1")
            .into_bytes();
        assert_eq!(
            parse_export(&unknown).unwrap_err().kind,
            crate::error::SessionErrorKind::InvalidInput
        );
        assert_eq!(
            parse_export(&vec![b'a'; MAX_INPUT_BYTES + 1])
                .unwrap_err()
                .kind,
            crate::error::SessionErrorKind::InvalidInput
        );

        let mut bad_role = serde_json::from_slice::<SessionExport>(&export_json()).unwrap();
        bad_role.messages[0].role = "system".into();
        let bytes = serde_json::to_vec(&bad_role).unwrap();
        assert_eq!(
            parse_export(&bytes).unwrap_err().kind,
            crate::error::SessionErrorKind::InvalidInput
        );
    }

    #[test]
    fn secret_detector_matches_credentials_and_private_keys() {
        assert!(contains_secret("api_key = \"abcdefgh1234\""));
        assert!(contains_secret(
            "ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKL"
        ));
        assert!(contains_secret("-----BEGIN PRIVATE KEY-----"));
        assert!(!contains_secret("No credential appears in this sentence."));
    }
}
