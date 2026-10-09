//! Explicit assistant-session export ingestion for Oximemo.
//!
//! Inputs are user-selected `cassette-session-export/1` files only. Queue and
//! receipt state lives outside the vault; accepted summaries are canonical PDC
//! 2 documents in `sessions/` and never enter Oximemo's memo index.

mod activity;
mod error;
mod export;
mod provider;
mod records;
mod source;
mod state;
pub use activity::{
    ActivityCaptureReceipt, ActivityEvent, GitScanItem, GitScanReport, GitSourceRegistration,
};

pub use error::{SessionError, SessionErrorKind};
pub use export::{EXPORT_FORMAT, ExportMessage, SessionExport};
pub use provider::ProviderConfig;
pub use records::{RecordStatus, Revision};
pub use source::{
    SourceCollectionReport, SourcePreviewItem, SourcePreviewReport, SourcePreviewSelection,
    SourceRegistration, SourceScanItem, SourceScanReport,
};

use crate::export::{ValidatedExport, contains_secret, parse_export};
use crate::provider::{
    ChunkAnalysis, chunk_digest, combine_analyses, plan_chunks, summarize_chunk,
};
use crate::records::SessionRow;
use crate::state::State;
use oximemo_core::Paths;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::PathBuf;
use time::OffsetDateTime;
use uuid::Uuid;

const MAX_ATTEMPTS: i64 = 5;
const LEASE_SECS: i64 = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionPolicy {
    Automatic,
    Review,
    CaptureOnly,
}

impl SessionPolicy {
    fn as_str(self) -> &'static str {
        match self {
            Self::Automatic => "automatic",
            Self::Review => "review",
            Self::CaptureOnly => "capture_only",
        }
    }

    fn parse(value: &str) -> Result<Self, SessionError> {
        match value {
            "automatic" => Ok(Self::Automatic),
            "review" => Ok(Self::Review),
            "capture_only" => Ok(Self::CaptureOnly),
            _ => Err(SessionError::storage()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionPolicyState {
    pub mode: SessionPolicy,
    pub retention_days: Option<u32>,
    /// Retention records operator intent only; this recorder never prunes data.
    pub retention_applied: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ImportReceipt {
    pub session_id: String,
    pub source_kind: String,
    pub external_id: String,
    pub source_revision: String,
    pub state: String,
    pub duplicate: bool,
    pub payload_digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionStatus {
    pub session_id: String,
    pub source_kind: String,
    pub external_id: String,
    pub title: String,
    pub occurred_at: String,
    pub source_revision: String,
    pub complete: bool,
    pub state: String,
    pub message_count: usize,
    pub payload_digest: String,
    pub attempts: u32,
    pub last_error: Option<String>,
    pub created_at: String,
    pub records: Vec<RecordStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProcessResult {
    pub session_id: String,
    pub state: String,
    pub records: Vec<RecordStatus>,
    pub skipped: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProcessReport {
    pub mode: SessionPolicy,
    pub processed: Vec<ProcessResult>,
    pub remaining: usize,
    pub skipped: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionRunReport {
    pub collection: Option<SourceCollectionReport>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_scan: Option<GitScanReport>,
    #[serde(flatten)]
    pub processing: ProcessReport,
}

/// Metadata-only view of a quarantined export. The payload and its file path
/// are deliberately never included.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct QuarantineEntry {
    pub session_id: String,
    pub source_kind: String,
    pub external_id: String,
    pub title: String,
    pub source_revision: String,
    pub payload_digest: String,
    pub created_at: String,
    pub reason: String,
}

/// Bounded source export store, processing queue, provider and PDC writer.
pub struct SessionRecorder {
    pub(crate) paths: Paths,
    pub(crate) state: State,
    pub(crate) provider: ProviderConfig,
}

impl SessionRecorder {
    pub fn new(paths: Paths, provider: ProviderConfig) -> Result<Self, SessionError> {
        let state = State::new(&paths)?;
        Ok(Self {
            paths,
            state,
            provider,
        })
    }

    #[cfg(test)]
    fn from_state_root(
        paths: Paths,
        provider: ProviderConfig,
        root: PathBuf,
    ) -> Result<Self, SessionError> {
        let state = State::from_root(root)?;
        Ok(Self {
            paths,
            state,
            provider,
        })
    }

    pub fn import_export_bytes(&self, bytes: &[u8]) -> Result<ImportReceipt, SessionError> {
        let validated = parse_export(bytes)?;
        let _lock = self.state.acquire_lock()?;
        let mut connection = self.state.connect()?;
        self.insert_export(&mut connection, validated)
    }

    fn insert_export(
        &self,
        connection: &mut Connection,
        validated: ValidatedExport,
    ) -> Result<ImportReceipt, SessionError> {
        let export = &validated.export;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| SessionError::storage())?;
        let existing = transaction
            .query_row(
                "SELECT session_id,payload_digest,state FROM recorder_sessions WHERE source_kind=?1 AND external_id=?2 AND source_revision=?3",
                params![export.source_kind, export.session_id, export.source_revision],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
            )
            .optional()
            .map_err(|_| SessionError::storage())?;
        if let Some((existing_id, digest, state)) = existing {
            if digest != validated.digest {
                return Err(SessionError::idempotency_conflict(
                    "same source identity and revision have different content",
                ));
            }
            transaction.commit().map_err(|_| SessionError::storage())?;
            return Ok(ImportReceipt {
                session_id: existing_id,
                source_kind: export.source_kind.clone(),
                external_id: export.session_id.clone(),
                source_revision: export.source_revision.clone(),
                state,
                duplicate: true,
                payload_digest: digest,
            });
        }

        let state = if validated.secret_suspected {
            "quarantined"
        } else if export.complete {
            "queued"
        } else {
            "capture_only"
        };
        let mut quarantine_path = None;
        let payload_ref = if validated.secret_suspected {
            let path = self
                .state
                .write_quarantine(&validated.session_id, validated.canonical_json.as_bytes())?;
            quarantine_path = Some(path.clone());
            Some(path.to_string_lossy().into_owned())
        } else {
            None
        };
        let export_json = if validated.secret_suspected {
            None
        } else {
            Some(validated.canonical_json.as_str())
        };
        let now = now_rfc3339();
        let inserted = transaction.execute(
            "INSERT INTO recorder_sessions(session_id,source_group,source_kind,external_id,title,occurred_at,source_revision,complete,state,message_count,payload_digest,export_json,payload_ref,attempts,last_error,secret_suspected,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,0,NULL,?14,?15,?15)",
            params![
                validated.session_id,
                validated.logical_source_id,
                export.source_kind,
                export.session_id,
                export.title,
                export.occurred_at,
                export.source_revision,
                export.complete as i64,
                state,
                export.messages.len() as i64,
                validated.digest,
                export_json,
                payload_ref,
                validated.secret_suspected as i64,
                now,
            ],
        );
        if inserted.is_err() {
            drop(transaction);
            if let Some(path) = &quarantine_path {
                let _ = self.state.remove_quarantine(path);
            }
            return Err(SessionError::storage());
        }
        if transaction.commit().is_err() {
            if let Some(path) = &quarantine_path {
                let _ = self.state.remove_quarantine(path);
            }
            return Err(SessionError::storage());
        }
        Ok(ImportReceipt {
            session_id: validated.session_id,
            source_kind: export.source_kind.clone(),
            external_id: export.session_id.clone(),
            source_revision: export.source_revision.clone(),
            state: state.to_string(),
            duplicate: false,
            payload_digest: validated.digest,
        })
    }

    pub fn list_sessions(&self, limit: usize) -> Result<Vec<SessionStatus>, SessionError> {
        if limit == 0 || limit > 1000 {
            return Err(SessionError::invalid(
                "session list limit must be in 1..=1000",
            ));
        }
        let connection = self.state.connect()?;
        let mut statement = connection
            .prepare("SELECT session_id,source_kind,external_id,title,occurred_at,source_revision,complete,state,message_count,payload_digest,attempts,last_error,created_at FROM recorder_sessions ORDER BY created_at DESC,session_id DESC LIMIT ?1")
            .map_err(|_| SessionError::storage())?;
        let rows = statement
            .query_map([limit as i64], |row| {
                Ok(SessionStatus {
                    session_id: row.get(0)?,
                    source_kind: row.get(1)?,
                    external_id: row.get(2)?,
                    title: row.get(3)?,
                    occurred_at: row.get(4)?,
                    source_revision: row.get(5)?,
                    complete: row.get::<_, i64>(6)? != 0,
                    state: row.get(7)?,
                    message_count: row.get::<_, i64>(8)? as usize,
                    payload_digest: row.get(9)?,
                    attempts: row.get::<_, i64>(10)? as u32,
                    last_error: row.get(11)?,
                    created_at: row.get(12)?,
                    records: Vec::new(),
                })
            })
            .map_err(|_| SessionError::storage())?;
        let mut sessions = rows
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| SessionError::storage())?;
        drop(statement);
        for session in &mut sessions {
            session.records = records_for_session(&connection, &session.session_id)?;
        }
        Ok(sessions)
    }

    /// Review-queue listing. Pending-review records are filtered in the query
    /// before the limit is applied, so older review items are not displaced by
    /// newer sessions or non-review records. Ordering matches the documented
    /// session ordering (newest sessions first, records by created time).
    pub fn list_review_records(&self, limit: usize) -> Result<Vec<RecordStatus>, SessionError> {
        if limit == 0 || limit > 1000 {
            return Err(SessionError::invalid(
                "session list limit must be in 1..=1000",
            ));
        }
        let connection = self.state.connect()?;
        let mut statement = connection
            .prepare(
                "SELECT r.record_id,r.kind,r.title,r.path,r.intent,r.revision,r.status,r.created_at,r.updated_at,s.session_id FROM recorder_records r JOIN recorder_record_sources s ON s.record_id=r.record_id JOIN recorder_sessions se ON se.session_id=s.session_id WHERE r.status='review' ORDER BY se.created_at DESC,se.session_id DESC,r.created_at,r.kind,s.session_id",
            )
            .map_err(|_| SessionError::storage())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    RecordStatus {
                        record_id: row.get(0)?,
                        kind: row.get(1)?,
                        title: row.get(2)?,
                        path: row.get(3)?,
                        intent: row.get(4)?,
                        revision: row.get(5)?,
                        status: row.get(6)?,
                        created_at: row.get(7)?,
                        updated_at: row.get(8)?,
                        source_ids: vec![row.get::<_, String>(9)?],
                    },
                    row.get::<_, String>(0)?,
                ))
            })
            .map_err(|_| SessionError::storage())?;
        let mut seen = std::collections::HashSet::new();
        let mut records = Vec::new();
        for row in rows {
            let (record, record_id) = row.map_err(|_| SessionError::storage())?;
            if seen.insert(record_id) {
                records.push(record);
            }
        }
        records.truncate(limit);
        Ok(records)
    }

    pub fn policy(&self) -> Result<SessionPolicyState, SessionError> {
        let connection = self.state.connect()?;
        read_policy(&connection)
    }

    pub fn set_policy(
        &self,
        mode: SessionPolicy,
        retention_days: Option<u32>,
    ) -> Result<SessionPolicyState, SessionError> {
        if retention_days.is_some_and(|days| days == 0 || days > 36_500) {
            return Err(SessionError::invalid(
                "retention_days must be in 1..=36500 or absent",
            ));
        }
        let _lock = self.state.acquire_lock()?;
        let connection = self.state.connect()?;
        connection
            .execute(
                "UPDATE recorder_policy SET mode=?1,retention_days=?2,updated_at=?3 WHERE id=1",
                params![mode.as_str(), retention_days, now_rfc3339()],
            )
            .map_err(|_| SessionError::storage())?;
        read_policy(&connection)
    }

    pub fn list_quarantine(&self) -> Result<Vec<QuarantineEntry>, SessionError> {
        let connection = self.state.connect()?;
        let mut statement = connection
            .prepare("SELECT session_id,source_kind,external_id,title,source_revision,payload_digest,created_at FROM recorder_sessions WHERE state='quarantined' ORDER BY created_at DESC")
            .map_err(|_| SessionError::storage())?;
        let rows = statement
            .query_map([], |row| {
                Ok(QuarantineEntry {
                    session_id: row.get(0)?,
                    source_kind: row.get(1)?,
                    external_id: row.get(2)?,
                    title: row.get(3)?,
                    source_revision: row.get(4)?,
                    payload_digest: row.get(5)?,
                    created_at: row.get(6)?,
                    reason: "secret pattern heuristic; no payload shown".into(),
                })
            })
            .map_err(|_| SessionError::storage())?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| SessionError::storage())
    }

    /// Replace a quarantined payload with a user-redacted export. Identity and
    /// revision must match exactly; content is revalidated and the secret gate
    /// must clear before it enters SQLite or the provider queue.
    pub fn apply_quarantine(
        &self,
        session_id: &str,
        sanitized_export: &[u8],
    ) -> Result<ImportReceipt, SessionError> {
        let replacement = parse_export(sanitized_export)?;
        if replacement.secret_suspected {
            return Err(SessionError::invalid(
                "redacted export still matches a secret-detection pattern",
            ));
        }
        let _lock = self.state.acquire_lock()?;
        let mut connection = self.state.connect()?;
        let existing = connection
            .query_row(
                "SELECT source_kind,external_id,source_revision,payload_ref,state FROM recorder_sessions WHERE session_id=?1",
                [session_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, Option<String>>(3)?, row.get::<_, String>(4)?)),
            )
            .optional()
            .map_err(|_| SessionError::storage())?
            .ok_or_else(|| SessionError::not_found("quarantined session not found"))?;
        let export = &replacement.export;
        if existing.4 != "quarantined"
            || export.source_kind != existing.0
            || export.session_id != existing.1
            || export.source_revision != existing.2
        {
            return Err(SessionError::external_change(
                "redacted export does not match quarantined identity",
            ));
        }
        let next_state = if export.complete {
            "queued"
        } else {
            "capture_only"
        };
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| SessionError::storage())?;
        transaction
            .execute(
                "UPDATE recorder_sessions SET title=?2,occurred_at=?3,complete=?4,state=?5,payload_digest=?6,export_json=?7,payload_ref=NULL,secret_suspected=0,last_error=NULL,updated_at=?8 WHERE session_id=?1 AND state='quarantined'",
                params![session_id, export.title, export.occurred_at, export.complete as i64, next_state, replacement.digest, replacement.canonical_json, now_rfc3339()],
            )
            .map_err(|_| SessionError::storage())?;
        transaction.commit().map_err(|_| SessionError::storage())?;
        if let Some(path) = existing.3 {
            let _ = self.state.remove_quarantine(&PathBuf::from(path));
        }
        Ok(ImportReceipt {
            session_id: session_id.to_string(),
            source_kind: export.source_kind.clone(),
            external_id: export.session_id.clone(),
            source_revision: export.source_revision.clone(),
            state: next_state.to_string(),
            duplicate: false,
            payload_digest: replacement.digest,
        })
    }

    pub fn discard_quarantine(&self, session_id: &str) -> Result<(), SessionError> {
        let _lock = self.state.acquire_lock()?;
        let mut connection = self.state.connect()?;
        let path = connection
            .query_row(
                "SELECT payload_ref FROM recorder_sessions WHERE session_id=?1 AND state='quarantined'",
                [session_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|_| SessionError::storage())?
            .ok_or_else(|| SessionError::not_found("quarantined session not found"))?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| SessionError::storage())?;
        let deleted = transaction
            .execute(
                "DELETE FROM recorder_sessions WHERE session_id=?1 AND state='quarantined'",
                [session_id],
            )
            .map_err(|_| SessionError::storage())?;
        if deleted != 1 {
            return Err(SessionError::not_found("quarantined session not found"));
        }
        transaction.commit().map_err(|_| SessionError::storage())?;
        if let Some(path) = path {
            let _ = self.state.remove_quarantine(&PathBuf::from(path));
        }
        Ok(())
    }

    /// Run the collection/processing pipeline. Collection is local-only and
    /// opt-in; remote-provider consent is checked before source collection.
    pub fn run_with_consent(
        &self,
        limit: usize,
        confirm_external: bool,
        auto_import_sources: bool,
        auto_scan_git_sources: bool,
    ) -> Result<SessionRunReport, SessionError> {
        if limit == 0 || limit > 1000 {
            return Err(SessionError::invalid(
                "processing limit must be in 1..=1000",
            ));
        }
        if !auto_import_sources && !auto_scan_git_sources {
            return Ok(SessionRunReport {
                collection: None,
                git_scan: None,
                processing: self.process_pending_with_consent(limit, confirm_external)?,
            });
        }
        if self.provider.is_configured() {
            self.provider.validate()?;
            if self.provider.requires_external_confirmation()? && !confirm_external {
                return Ok(SessionRunReport {
                    collection: None,
                    git_scan: None,
                    processing: self.process_pending_with_consent(limit, false)?,
                });
            }
        }
        let collection = auto_import_sources
            .then(|| self.collect_registered_sources())
            .transpose()?;
        let git_scan = auto_scan_git_sources
            .then(|| self.scan_registered_git_sources(100))
            .transpose()?;
        let processing = self.process_pending_with_consent(limit, confirm_external)?;
        Ok(SessionRunReport {
            collection,
            git_scan,
            processing,
        })
    }

    pub fn process_pending(&self, limit: usize) -> Result<ProcessReport, SessionError> {
        self.process_pending_with_consent(limit, false)
    }

    pub fn process_pending_with_consent(
        &self,
        limit: usize,
        confirm_external: bool,
    ) -> Result<ProcessReport, SessionError> {
        if limit == 0 || limit > 1000 {
            return Err(SessionError::invalid(
                "processing limit must be in 1..=1000",
            ));
        }
        let _processing_lock = self.state.try_processing_lock()?;
        let mut connection = self.state.connect()?;
        let policy = read_policy(&connection)?;
        let remaining = count_eligible(&connection)?;
        if policy.mode == SessionPolicy::CaptureOnly {
            return Ok(ProcessReport {
                mode: policy.mode,
                processed: Vec::new(),
                remaining,
                skipped: Some("capture_only".into()),
            });
        }
        if !self.provider.is_configured() {
            return Ok(ProcessReport {
                mode: policy.mode,
                processed: Vec::new(),
                remaining,
                skipped: Some("provider_not_configured".into()),
            });
        }
        self.provider.validate()?;
        if self.provider.requires_external_confirmation()? && !confirm_external {
            return Ok(ProcessReport {
                mode: policy.mode,
                processed: Vec::new(),
                remaining,
                skipped: Some("external_provider_confirmation_required".into()),
            });
        }
        {
            let _lock = self.state.acquire_lock()?;
            connection
                .execute(
                    "UPDATE recorder_sessions SET state='queued',lease_until=NULL,lease_token=NULL WHERE state='processing'",
                    [],
                )
                .map_err(|_| SessionError::storage())?;
        }
        let policy = read_policy(&connection)?;
        let remaining = count_eligible(&connection)?;
        if policy.mode == SessionPolicy::CaptureOnly {
            return Ok(ProcessReport {
                mode: policy.mode,
                processed: Vec::new(),
                remaining,
                skipped: Some("capture_only".into()),
            });
        }
        let mut processed = Vec::new();
        let mut seen = HashSet::new();
        for _ in 0..limit {
            if read_policy(&connection)?.mode == SessionPolicy::CaptureOnly {
                break;
            }
            let Some((session_id, lease_token)) = claim_next(&mut connection, &seen)? else {
                break;
            };
            seen.insert(session_id.clone());
            match self.process_claimed(&mut connection, &session_id, &lease_token) {
                Ok(result) => processed.push(result),
                Err(error) => {
                    let message = error.to_string();
                    let _ = finalize_session(
                        &connection,
                        &session_id,
                        &lease_token,
                        "failed",
                        Some(&message),
                    );
                    processed.push(ProcessResult {
                        session_id,
                        state: "failed".into(),
                        records: Vec::new(),
                        skipped: None,
                        error: Some(message),
                    });
                }
            }
        }
        Ok(ProcessReport {
            mode: read_policy(&connection)?.mode,
            processed,
            remaining: count_eligible(&connection)?,
            skipped: None,
        })
    }

    fn process_claimed(
        &self,
        connection: &mut Connection,
        session_id: &str,
        lease_token: &str,
    ) -> Result<ProcessResult, SessionError> {
        let stored = connection
            .query_row(
                "SELECT source_kind,external_id,title,occurred_at,source_revision,complete,message_count,payload_digest,export_json,state FROM recorder_sessions WHERE session_id=?1 AND lease_token=?2 AND state='processing'",
                params![session_id, lease_token],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, i64>(5)? != 0,
                        row.get::<_, i64>(6)? as usize,
                        row.get::<_, String>(7)?,
                        row.get::<_, Option<String>>(8)?,
                        row.get::<_, String>(9)?,
                    ))
                },
            )
            .optional()
            .map_err(|_| SessionError::storage())?
            .ok_or_else(|| SessionError::external_change("processing lease ownership changed"))?;
        let Some(export_json) = stored.8 else {
            return Err(SessionError::external_change(
                "queued session payload is not available",
            ));
        };
        let validated = parse_export(export_json.as_bytes())?;
        if validated.session_id != session_id || validated.digest != stored.7 {
            return Err(SessionError::external_change(
                "queued session payload identity changed",
            ));
        }
        if validated.secret_suspected || contains_secret(&validated.canonical_json) {
            let _lock = self.state.acquire_lock()?;
            let path = self
                .state
                .write_quarantine(session_id, validated.canonical_json.as_bytes())?;
            let changed = match connection.execute(
                "UPDATE recorder_sessions SET state='quarantined',export_json=NULL,payload_ref=?3,secret_suspected=1,lease_until=NULL,lease_token=NULL,last_error='secret_suspected',updated_at=?4 WHERE session_id=?1 AND lease_token=?2 AND state='processing'",
                params![session_id, lease_token, path.to_string_lossy(), now_rfc3339()],
            ) {
                Ok(changed) => changed,
                Err(_) => {
                    let _ = self.state.remove_quarantine(&path);
                    return Err(SessionError::storage());
                }
            };
            if changed != 1 {
                let _ = self.state.remove_quarantine(&path);
                return Err(SessionError::external_change(
                    "processing lease ownership changed",
                ));
            }
            return Ok(ProcessResult {
                session_id: session_id.to_string(),
                state: "quarantined".into(),
                records: Vec::new(),
                skipped: Some("secret_suspected".into()),
                error: None,
            });
        }
        if !stored.5 {
            finalize_session(connection, session_id, lease_token, "capture_only", None)?;
            return Ok(ProcessResult {
                session_id: session_id.to_string(),
                state: "capture_only".into(),
                records: Vec::new(),
                skipped: Some("incomplete_export".into()),
                error: None,
            });
        }

        let chunks = plan_chunks(&validated.export);
        let mut analyses = Vec::with_capacity(chunks.len());
        for (index, chunk) in chunks.iter().enumerate() {
            if read_policy(connection)?.mode == SessionPolicy::CaptureOnly {
                finalize_session(connection, session_id, lease_token, "queued", None)?;
                return Ok(ProcessResult {
                    session_id: session_id.to_string(),
                    state: "queued".into(),
                    records: Vec::new(),
                    skipped: Some("policy_changed_to_capture_only".into()),
                    error: None,
                });
            }
            let digest = chunk_digest(chunk);
            if let Some(cached) = cached_chunk(connection, session_id, index, &digest)? {
                analyses.push(cached);
                continue;
            }
            refresh_lease(connection, session_id, lease_token)?;
            let result = summarize_chunk(&self.provider, chunk);
            let refreshed = refresh_lease(connection, session_id, lease_token);
            refreshed?;
            let analysis = result?;
            if contains_secret(&serde_json::to_string(&analysis).unwrap_or_default()) {
                return Err(SessionError::provider(
                    "provider summary matched a secret pattern",
                ));
            }
            store_chunk(connection, session_id, index, &digest, &analysis)?;
            analyses.push(analysis);
        }
        let combined = combine_analyses(&validated.export.title, &analyses)?;
        let status = match read_policy(connection)?.mode {
            SessionPolicy::Automatic => "recorded",
            SessionPolicy::Review => "review",
            SessionPolicy::CaptureOnly => {
                finalize_session(connection, session_id, lease_token, "queued", None)?;
                return Ok(ProcessResult {
                    session_id: session_id.to_string(),
                    state: "queued".into(),
                    records: Vec::new(),
                    skipped: Some("policy_changed_to_capture_only".into()),
                    error: None,
                });
            }
        };
        let session = SessionRow {
            session_id: session_id.to_string(),
            source_kind: stored.0,
            external_id: stored.1,
            title: stored.2,
            occurred_at: stored.3,
            source_revision: stored.4,
            complete: stored.5,
            message_count: stored.6,
            payload_digest: stored.7,
        };
        let records = records::persist_generated(
            &self.paths,
            &self.state,
            connection,
            &session,
            &combined,
            status,
        )?;
        finalize_session(connection, session_id, lease_token, "processed", None)?;
        Ok(ProcessResult {
            session_id: session_id.to_string(),
            state: "processed".into(),
            records,
            skipped: None,
            error: None,
        })
    }

    pub fn accept_record(
        &self,
        record_id: &str,
        expected_sha256: &str,
    ) -> Result<RecordStatus, SessionError> {
        let _lock = self.state.acquire_lock()?;
        let mut connection = self.state.connect()?;
        records::accept_record(
            &self.paths,
            &self.state,
            &mut connection,
            record_id,
            expected_sha256,
        )
    }

    pub fn rollback_record(
        &self,
        record_id: &str,
        target_revision: &str,
        base_revision: &str,
        request_key: &str,
    ) -> Result<RecordStatus, SessionError> {
        let _lock = self.state.acquire_lock()?;
        let mut connection = self.state.connect()?;
        records::rollback_record(
            &self.paths,
            &self.state,
            &mut connection,
            record_id,
            target_revision,
            base_revision,
            request_key,
        )
    }

    pub fn history(&self, record_id: &str) -> Result<Vec<Revision>, SessionError> {
        let connection = self.state.connect()?;
        records::list_history(&connection, record_id)
    }
}

fn read_policy(connection: &Connection) -> Result<SessionPolicyState, SessionError> {
    let (mode, retention_days): (String, Option<i64>) = connection
        .query_row(
            "SELECT mode,retention_days FROM recorder_policy WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| SessionError::storage())?;
    Ok(SessionPolicyState {
        mode: SessionPolicy::parse(&mode)?,
        retention_days: retention_days.map(|value| value as u32),
        retention_applied: false,
    })
}

fn count_eligible(connection: &Connection) -> Result<usize, SessionError> {
    connection
        .query_row(
            "SELECT COUNT(*) FROM recorder_sessions WHERE state='queued' OR (state='failed' AND attempts<?1)",
            [MAX_ATTEMPTS],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count as usize)
        .map_err(|_| SessionError::storage())
}

fn claim_next(
    connection: &mut Connection,
    seen: &HashSet<String>,
) -> Result<Option<(String, String)>, SessionError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| SessionError::storage())?;
    let session_id = {
        let mut statement = transaction
            .prepare(
                "SELECT session_id FROM recorder_sessions WHERE (state='queued' OR (state='failed' AND attempts<?1)) ORDER BY created_at,session_id LIMIT ?2",
            )
            .map_err(|_| SessionError::storage())?;
        let mut rows = statement
            .query(params![MAX_ATTEMPTS, seen.len() as i64 + 1])
            .map_err(|_| SessionError::storage())?;
        let mut candidate = None;
        while let Some(row) = rows.next().map_err(|_| SessionError::storage())? {
            let session_id = row
                .get::<_, String>(0)
                .map_err(|_| SessionError::storage())?;
            if !seen.contains(&session_id) {
                candidate = Some(session_id);
                break;
            }
        }
        candidate
    };
    let Some(session_id) = session_id else {
        transaction.commit().map_err(|_| SessionError::storage())?;
        return Ok(None);
    };
    let token = Uuid::now_v7().to_string();
    transaction
        .execute(
            "UPDATE recorder_sessions SET state='processing',lease_token=?2,lease_until=?3,attempts=attempts+1,updated_at=?4 WHERE session_id=?1",
            params![session_id, token, lease_deadline(), now_rfc3339()],
        )
        .map_err(|_| SessionError::storage())?;
    transaction.commit().map_err(|_| SessionError::storage())?;
    Ok(Some((session_id, token)))
}

fn refresh_lease(
    connection: &Connection,
    session_id: &str,
    token: &str,
) -> Result<(), SessionError> {
    let changed = connection
        .execute(
            "UPDATE recorder_sessions SET lease_until=?3,updated_at=?4 WHERE session_id=?1 AND lease_token=?2 AND state='processing'",
            params![session_id, token, lease_deadline(), now_rfc3339()],
        )
        .map_err(|_| SessionError::storage())?;
    if changed != 1 {
        return Err(SessionError::external_change(
            "processing lease ownership changed",
        ));
    }
    Ok(())
}

fn finalize_session(
    connection: &Connection,
    session_id: &str,
    token: &str,
    state: &str,
    error: Option<&str>,
) -> Result<(), SessionError> {
    let bounded = error.map(|value| value.chars().take(240).collect::<String>());
    let changed = connection
        .execute(
            "UPDATE recorder_sessions SET state=?3,lease_until=NULL,lease_token=NULL,last_error=?4,updated_at=?5 WHERE session_id=?1 AND lease_token=?2 AND state='processing'",
            params![session_id, token, state, bounded, now_rfc3339()],
        )
        .map_err(|_| SessionError::storage())?;
    if changed != 1 {
        return Err(SessionError::external_change(
            "processing lease ownership changed",
        ));
    }
    Ok(())
}

fn cached_chunk(
    connection: &Connection,
    session_id: &str,
    index: usize,
    digest: &str,
) -> Result<Option<ChunkAnalysis>, SessionError> {
    let cached = connection
        .query_row(
            "SELECT result_json FROM recorder_chunks WHERE session_id=?1 AND chunk_index=?2 AND chunk_digest=?3",
            params![session_id, index as i64, digest],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| SessionError::storage())?;
    cached
        .map(|json| serde_json::from_str(&json).map_err(|_| SessionError::storage()))
        .transpose()
}

fn store_chunk(
    connection: &Connection,
    session_id: &str,
    index: usize,
    digest: &str,
    analysis: &ChunkAnalysis,
) -> Result<(), SessionError> {
    let json = serde_json::to_string(analysis).map_err(|_| SessionError::storage())?;
    connection
        .execute(
            "INSERT INTO recorder_chunks(session_id,chunk_index,chunk_digest,result_json,updated_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(session_id,chunk_index) DO UPDATE SET chunk_digest=excluded.chunk_digest,result_json=excluded.result_json,updated_at=excluded.updated_at",
            params![session_id, index as i64, digest, json, now_rfc3339()],
        )
        .map_err(|_| SessionError::storage())?;
    Ok(())
}

fn records_for_session(
    connection: &Connection,
    session_id: &str,
) -> Result<Vec<RecordStatus>, SessionError> {
    let mut statement = connection
        .prepare("SELECT r.record_id,r.kind,r.title,r.path,r.intent,r.revision,r.status,r.created_at,r.updated_at FROM recorder_records r JOIN recorder_record_sources s ON s.record_id=r.record_id WHERE s.session_id=?1 ORDER BY r.created_at,r.kind")
        .map_err(|_| SessionError::storage())?;
    let rows = statement
        .query_map([session_id], |row| {
            Ok(RecordStatus {
                record_id: row.get(0)?,
                kind: row.get(1)?,
                title: row.get(2)?,
                path: row.get(3)?,
                intent: row.get(4)?,
                revision: row.get(5)?,
                status: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
                source_ids: vec![session_id.to_string()],
            })
        })
        .map_err(|_| SessionError::storage())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| SessionError::storage())
}

fn now_rfc3339() -> String {
    let format = time::macros::format_description!(
        "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
    );
    OffsetDateTime::now_utc().format(format).unwrap_or_default()
}

fn lease_deadline() -> String {
    let format = time::macros::format_description!(
        "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
    );
    (OffsetDateTime::now_utc() + time::Duration::seconds(LEASE_SECS))
        .format(format)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;
    use tempfile::TempDir;

    fn test_recorder() -> (SessionRecorder, TempDir, TempDir) {
        test_recorder_with_provider(ProviderConfig::default())
    }

    fn test_recorder_with_provider(
        provider: ProviderConfig,
    ) -> (SessionRecorder, TempDir, TempDir) {
        let root = tempfile::tempdir().unwrap();
        let state_root = tempfile::tempdir().unwrap();
        let paths = Paths {
            vault: root.path().join("vault"),
            index_dir: root.path().join("index"),
        };
        fs::create_dir_all(&paths.vault).unwrap();
        let recorder =
            SessionRecorder::from_state_root(paths, provider, state_root.path().join("recorder"))
                .unwrap();
        (recorder, root, state_root)
    }

    fn export(text: &str, revision: &str) -> Vec<u8> {
        serde_json::json!({
            "format": EXPORT_FORMAT,
            "source_kind": "assistant",
            "session_id": "source-1",
            "title": "Imported session",
            "occurred_at": "2026-10-01T12:30:00.000Z",
            "source_revision": revision,
            "complete": true,
            "messages": [{"id":"m1","role":"user","text":text,"occurred_at":null}]
        })
        .to_string()
        .into_bytes()
    }

    #[test]
    fn import_is_idempotent_and_conflicting_revision_never_overwrites() {
        let (recorder, _vault, _state) = test_recorder();
        let bytes = export("hello", "r1");
        let first = recorder.import_export_bytes(&bytes).unwrap();
        let duplicate = recorder.import_export_bytes(&bytes).unwrap();
        assert!(!first.duplicate);
        assert!(duplicate.duplicate);
        assert_eq!(first.session_id, duplicate.session_id);
        assert_eq!(recorder.list_sessions(10).unwrap().len(), 1);

        assert_eq!(
            recorder
                .import_export_bytes(&export("changed", "r1"))
                .unwrap_err()
                .kind,
            SessionErrorKind::IdempotencyConflict
        );
        let revised = recorder
            .import_export_bytes(&export("changed", "r2"))
            .unwrap();
        assert_ne!(revised.session_id, first.session_id);
    }

    #[test]
    fn registered_source_preview_is_read_only_hidden_files_are_ignored_and_import_is_digest_bound()
    {
        let (recorder, _vault, _state) = test_recorder();
        let source = tempfile::tempdir().unwrap();
        let file_name = "session.cassette-session.json";
        let file = source.path().join(file_name);
        fs::write(&file, export("private conversation text", "r1")).unwrap();
        fs::write(
            source.path().join(".hidden.cassette-session.json"),
            export("hidden conversation text", "r2"),
        )
        .unwrap();
        let registration = recorder.register_source_dir(source.path(), true).unwrap();

        let preview = recorder.preview_registered_sources().unwrap();
        assert_eq!(preview.scanned, 1);
        assert_eq!(preview.ready, 1);
        assert_eq!(preview.items[0].state, "ready");
        assert!(
            !serde_json::to_string(&preview)
                .unwrap()
                .contains("private conversation text")
        );
        assert!(recorder.list_sessions(10).unwrap().is_empty());
        let seen_count: i64 = recorder
            .state
            .connect()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM recorder_scan_seen", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(seen_count, 0);

        let item = &preview.items[0];
        let selection = SourcePreviewSelection {
            source_id: registration.id.clone(),
            file_name: item.file_name.clone(),
            source_digest: item.source_digest.clone().unwrap(),
        };
        fs::write(&file, export("changed after preview", "r2")).unwrap();
        let rejected = recorder.import_source_preview(&[selection]).unwrap();
        assert_eq!(rejected.failed, 1);
        assert!(recorder.list_sessions(10).unwrap().is_empty());

        let refreshed = recorder.preview_registered_sources().unwrap();
        let item = refreshed
            .items
            .iter()
            .find(|item| item.state == "ready")
            .unwrap();
        let imported = recorder
            .import_source_preview(&[SourcePreviewSelection {
                source_id: registration.id,
                file_name: item.file_name.clone(),
                source_digest: item.source_digest.clone().unwrap(),
            }])
            .unwrap();
        assert_eq!(imported.imported, 1);
        assert_eq!(recorder.list_sessions(10).unwrap().len(), 1);
        let after_import = recorder.preview_registered_sources().unwrap();
        assert_eq!(after_import.unchanged, 1);
        assert_eq!(after_import.ready, 0);
    }

    #[test]
    fn registered_source_error_clears_after_recovered_import() {
        let (recorder, _vault, _state) = test_recorder();
        let parent = tempfile::tempdir().unwrap();
        let source_path = parent.path().join("exports");
        let offline_path = parent.path().join("offline");
        fs::create_dir(&source_path).unwrap();
        let file_name = "session.cassette-session.json";
        fs::write(source_path.join(file_name), export("session body", "r1")).unwrap();
        let registration = recorder.register_source_dir(&source_path, true).unwrap();
        let preview = recorder.preview_registered_sources().unwrap();
        let selection = SourcePreviewSelection {
            source_id: registration.id.clone(),
            file_name: file_name.into(),
            source_digest: preview.items[0].source_digest.clone().unwrap(),
        };

        fs::rename(&source_path, &offline_path).unwrap();
        let failed = recorder
            .import_source_preview(std::slice::from_ref(&selection))
            .unwrap();
        assert_eq!(failed.failed, 1);
        assert!(recorder.list_sources().unwrap()[0].last_error.is_some());

        fs::rename(&offline_path, &source_path).unwrap();
        let recovered = recorder
            .import_source_preview(std::slice::from_ref(&selection))
            .unwrap();
        assert_eq!(recovered.imported, 1);
        assert_eq!(recorder.list_sources().unwrap()[0].last_error, None);
    }

    #[test]
    fn registered_source_controls_toggle_and_remove_registration_without_removing_sessions() {
        let (recorder, _vault, _state) = test_recorder();
        let source = tempfile::tempdir().unwrap();
        fs::write(
            source.path().join("session.cassette-session.json"),
            export("session body", "r1"),
        )
        .unwrap();
        let registration = recorder.register_source_dir(source.path(), true).unwrap();
        let collected = recorder.collect_registered_sources().unwrap();
        assert_eq!(collected.import.imported, 1);

        let disabled = recorder
            .set_source_enabled(&registration.id, false)
            .unwrap();
        assert!(!disabled.enabled);
        assert_eq!(recorder.preview_registered_sources().unwrap().scanned, 0);
        let enabled = recorder.set_source_enabled(&registration.id, true).unwrap();
        assert!(enabled.enabled);

        assert!(recorder.remove_source(&registration.id).unwrap());
        assert!(recorder.list_sources().unwrap().is_empty());
        assert_eq!(recorder.list_sessions(10).unwrap().len(), 1);
        let seen_count: i64 = recorder
            .state
            .connect()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM recorder_scan_seen", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(seen_count, 0);
        assert!(!recorder.remove_source(&registration.id).unwrap());
    }

    #[test]
    fn registered_source_preview_reports_identity_conflicts_without_importing_them() {
        let (recorder, _vault, _state) = test_recorder();
        recorder
            .import_export_bytes(&export("original content", "r1"))
            .unwrap();
        let source = tempfile::tempdir().unwrap();
        fs::write(
            source.path().join("conflict.cassette-session.json"),
            export("different content", "r1"),
        )
        .unwrap();
        recorder.register_source_dir(source.path(), true).unwrap();

        let preview = recorder.preview_registered_sources().unwrap();
        assert_eq!(preview.conflicts, 1);
        assert_eq!(preview.ready, 0);
        assert_eq!(preview.items[0].state, "conflict");
        assert_eq!(recorder.list_sessions(10).unwrap().len(), 1);
    }

    #[test]
    fn auto_collection_imports_only_registered_visible_exports_without_processing() {
        let (recorder, _vault, _state) = test_recorder();
        let source = tempfile::tempdir().unwrap();
        let unregistered = tempfile::tempdir().unwrap();
        fs::write(
            source.path().join("session.cassette-session.json"),
            export("private conversation text", "r1"),
        )
        .unwrap();
        fs::write(
            source.path().join(".hidden.cassette-session.json"),
            export("hidden conversation text", "r2"),
        )
        .unwrap();
        fs::write(
            unregistered
                .path()
                .join("unregistered.cassette-session.json"),
            export("unregistered content", "r3"),
        )
        .unwrap();
        recorder.register_source_dir(source.path(), true).unwrap();

        let report = recorder.run_with_consent(10, false, true, false).unwrap();
        let wire = serde_json::to_value(&report).unwrap();
        assert_eq!(wire["collection"]["import"]["imported"], 1);
        assert_eq!(wire["skipped"], "provider_not_configured");
        assert!(wire.get("processing").is_none());
        let collection = report.collection.unwrap();
        assert_eq!(collection.preview.scanned, 1);
        assert_eq!(collection.import.imported, 1);
        assert_eq!(
            report.processing.skipped.as_deref(),
            Some("provider_not_configured")
        );
        assert_eq!(report.processing.remaining, 1);
        let sessions = recorder.list_sessions(10).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].state, "queued");
        assert_eq!(sessions[0].title, "Imported session");
    }

    #[test]
    fn remote_provider_consent_blocks_auto_collection_before_import() {
        let provider = ProviderConfig {
            endpoint: "https://api.example.test/v1".into(),
            model: "test-model".into(),
            api_key_env: String::new(),
            allow_external: true,
        };
        let (recorder, _vault, _state) = test_recorder_with_provider(provider);
        let source = tempfile::tempdir().unwrap();
        fs::write(
            source.path().join("session.cassette-session.json"),
            export("unimported content", "r1"),
        )
        .unwrap();
        recorder.register_source_dir(source.path(), true).unwrap();
        recorder
            .import_export_bytes(&export("already queued", "r2"))
            .unwrap();

        let report = recorder.run_with_consent(10, false, true, false).unwrap();
        assert!(report.collection.is_none());
        assert_eq!(
            report.processing.skipped.as_deref(),
            Some("external_provider_confirmation_required")
        );
        assert_eq!(recorder.list_sessions(10).unwrap().len(), 1);
        assert_eq!(recorder.list_sessions(10).unwrap()[0].state, "queued");
        let preview = recorder.preview_registered_sources().unwrap();
        assert_eq!(preview.ready, 1);
    }

    #[test]
    fn secret_payload_is_quarantined_outside_sqlite_and_listing_is_metadata_only() {
        let (recorder, _vault, _state) = test_recorder();
        let bytes = export("api_key=supersecretvalue123", "r1");
        let receipt = recorder.import_export_bytes(&bytes).unwrap();
        assert_eq!(receipt.state, "quarantined");
        let entries = recorder.list_quarantine().unwrap();
        assert_eq!(entries.len(), 1);
        assert!(
            !serde_json::to_string(&entries)
                .unwrap()
                .contains("supersecret")
        );
        let connection = recorder.state.connect().unwrap();
        let export_json: Option<String> = connection
            .query_row(
                "SELECT export_json FROM recorder_sessions WHERE session_id=?1",
                [&receipt.session_id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(export_json.is_none());
        let path: String = connection
            .query_row(
                "SELECT payload_ref FROM recorder_sessions WHERE session_id=?1",
                [&receipt.session_id],
                |row| row.get(0),
            )
            .unwrap();
        let metadata = fs::metadata(path).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn review_listing_filters_before_limit_in_session_order() {
        let (recorder, _vault, _state) = test_recorder();
        let connection = recorder.state.connect().unwrap();
        for index in 0..3 {
            let day = format!("2025-01-0{}", index + 1);
            connection
                .execute(
                    "INSERT INTO recorder_sessions(session_id,source_group,source_kind,external_id,title,occurred_at,source_revision,complete,state,message_count,payload_digest,created_at) VALUES(?1,'g','test',?1,'t','2025-01-01T00:00:00Z','r',0,'queued',0,'d',?2)",
                    rusqlite::params![format!("session-{index}"), format!("{day}T00:00:00.000Z")],
                )
                .unwrap();
            for (kind, status) in [("note", "recorded"), ("summary", "review")] {
                let record_id = format!("record-{index}-{kind}");
                connection
                    .execute(
                        "INSERT INTO recorder_records(record_id,kind,title,path,intent,revision,status,created_at,updated_at) VALUES(?1,?2,'t','p','i','r1',?3,?4,?4)",
                        rusqlite::params![record_id, kind, status, format!("{day}T00:00:01.000Z")],
                    )
                    .unwrap();
                connection
                    .execute(
                        "INSERT INTO recorder_record_sources(record_id,session_id) VALUES(?1,?2)",
                        rusqlite::params![record_id, format!("session-{index}")],
                    )
                    .unwrap();
            }
        }
        let records = recorder.list_review_records(2).unwrap();
        assert_eq!(records.len(), 2);
        // Newest sessions first; non-review records never consume limit slots.
        assert_eq!(records[0].record_id, "record-2-summary");
        assert_eq!(records[1].record_id, "record-1-summary");
        assert_eq!(records[0].source_ids, vec!["session-2".to_string()]);
        assert!(
            records
                .iter()
                .all(|record| record.status == "review" && record.kind == "summary")
        );
        assert!(recorder.list_review_records(0).is_err());
        assert!(recorder.list_review_records(1001).is_err());
    }

    #[test]
    fn no_provider_keeps_complete_import_queued_and_incomplete_is_capture_only() {
        let (recorder, _vault, _state) = test_recorder();
        let queued = recorder
            .import_export_bytes(&export("hello", "r1"))
            .unwrap();
        let report = recorder.process_pending(10).unwrap();
        assert_eq!(report.skipped.as_deref(), Some("provider_not_configured"));
        assert_eq!(report.remaining, 1);
        assert_eq!(recorder.list_sessions(10).unwrap()[0].state, "queued");

        let mut incomplete: serde_json::Value =
            serde_json::from_slice(&export("partial", "r2")).unwrap();
        incomplete["complete"] = serde_json::Value::Bool(false);
        let result = recorder
            .import_export_bytes(&serde_json::to_vec(&incomplete).unwrap())
            .unwrap();
        assert_eq!(result.state, "capture_only");
        assert!(!queued.session_id.is_empty());
    }

    #[test]
    fn remote_provider_processing_requires_call_specific_consent() {
        let provider = ProviderConfig {
            endpoint: "https://api.example.test/v1".into(),
            model: "test-model".into(),
            api_key_env: String::new(),
            allow_external: true,
        };
        let (recorder, _vault, _state) = test_recorder_with_provider(provider);
        recorder
            .import_export_bytes(&export("private transcript", "r1"))
            .unwrap();

        let report = recorder.process_pending(1).unwrap();
        assert_eq!(
            report.skipped.as_deref(),
            Some("external_provider_confirmation_required")
        );
        assert_eq!(report.remaining, 1);
        assert_eq!(recorder.list_sessions(10).unwrap()[0].state, "queued");
    }

    #[test]
    fn redacted_quarantine_replacement_requires_same_identity_and_clears_secret_gate() {
        let (recorder, _vault, _state) = test_recorder();
        let original = recorder
            .import_export_bytes(&export("password=topsecretvalue123", "r1"))
            .unwrap();
        let replacement = recorder
            .apply_quarantine(&original.session_id, &export("redacted", "r1"))
            .unwrap();
        assert_eq!(replacement.state, "queued");
        assert_eq!(recorder.list_quarantine().unwrap().len(), 0);
    }

    #[test]
    fn provider_processing_writes_review_pdc_and_guarded_history_rollback() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let response_content = serde_json::json!({
            "title": "Grounded session",
            "summary_markdown": "The user requested an explicit import.",
            "decisions": ["Keep collection user-selected"],
            "tasks": ["Review the generated record"]
        })
        .to_string();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut body_start = None;
            let mut content_length = None;
            loop {
                let mut buffer = [0u8; 8192];
                let count = stream.read(&mut buffer).unwrap();
                assert!(count > 0, "provider closed before request body completed");
                request.extend_from_slice(&buffer[..count]);
                if body_start.is_none()
                    && let Some(end) = request.windows(4).position(|window| window == b"\r\n\r\n")
                {
                    body_start = Some(end + 4);
                    let headers = String::from_utf8_lossy(&request[..end]);
                    content_length = headers.lines().find_map(|line| {
                        let (key, value) = line.split_once(':')?;
                        key.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())
                            .flatten()
                    });
                }
                if body_start
                    .zip(content_length)
                    .is_some_and(|(start, length)| request.len() >= start + length)
                {
                    break;
                }
            }
            let completion = serde_json::json!({
                "choices": [{"message": {"content": response_content}}]
            })
            .to_string();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                completion.len(),
                completion,
            )
            .unwrap();
            stream.flush().unwrap();
            String::from_utf8(request).unwrap()
        });
        let provider = ProviderConfig {
            endpoint: format!("http://{address}/v1/chat/completions"),
            model: "test-model".into(),
            api_key_env: String::new(),
            allow_external: false,
        };
        let (recorder, _vault, _state) = test_recorder_with_provider(provider);
        recorder.set_policy(SessionPolicy::Review, None).unwrap();
        let input = export("explicit evidence phrase", "r1");
        let receipt = recorder.import_export_bytes(&input).unwrap();
        let report = recorder.process_pending(1).unwrap();
        let request = server.join().unwrap();
        assert!(request.contains("explicit evidence phrase"));
        assert_eq!(report.processed[0].state, "processed");

        let session = recorder.list_sessions(10).unwrap().remove(0);
        assert_eq!(session.state, "processed");
        let summary = session
            .records
            .iter()
            .find(|record| record.kind == "summary")
            .unwrap();
        assert_eq!(summary.status, "review");
        assert_eq!(summary.source_ids, vec![receipt.session_id]);
        let created =
            oximemo_core::pdc_documents::read_document(&recorder.paths, &summary.path).unwrap();
        let original_body = created.editable_body.clone().unwrap();
        assert!(original_body.contains("The user requested an explicit import."));
        assert!(!original_body.contains("explicit evidence phrase"));
        assert!(created.content.contains("cassette_source_ids"));

        let accepted = recorder
            .accept_record(&summary.record_id, &summary.revision)
            .unwrap();
        assert_eq!(accepted.status, "recorded");
        assert_ne!(accepted.revision, summary.revision);
        let before_rollback = recorder.history(&summary.record_id).unwrap();
        assert_eq!(before_rollback.len(), 2);
        let original_revision = before_rollback
            .iter()
            .find(|revision| revision.reason == "session_summary")
            .unwrap();
        let restored = recorder
            .rollback_record(
                &summary.record_id,
                &original_revision.revision,
                &accepted.revision,
                "rollback-session-test-1",
            )
            .unwrap();
        assert_eq!(restored.status, "recorded");
        assert_ne!(restored.revision, accepted.revision);
        let rolled_back =
            oximemo_core::pdc_documents::read_document(&recorder.paths, &summary.path).unwrap();
        assert_eq!(rolled_back.document_id, created.document_id);
        assert_eq!(rolled_back.editable_body, Some(original_body));
        let replay_conflict = recorder.rollback_record(
            &summary.record_id,
            &accepted.revision,
            &accepted.revision,
            "rollback-session-test-1",
        );
        assert_eq!(
            replay_conflict.unwrap_err().kind,
            SessionErrorKind::IdempotencyConflict
        );
        let current = recorder
            .list_sessions(10)
            .unwrap()
            .remove(0)
            .records
            .into_iter()
            .find(|record| record.record_id == summary.record_id)
            .unwrap();
        assert_eq!(current.revision, restored.revision);
        assert!(recorder.history(&summary.record_id).unwrap().len() >= 3);
    }
}
