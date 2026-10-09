use crate::error::SessionError;
use crate::provider::CombinedAnalysis;
use crate::state::State;
use oximemo_core::Paths;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::Path;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

const MAX_RECORDS_PER_SESSION: usize = 3;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecordStatus {
    pub record_id: String,
    pub kind: String,
    pub title: String,
    pub path: String,
    pub intent: String,
    pub revision: String,
    pub status: String,
    pub source_ids: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Revision {
    pub record_id: String,
    pub revision: String,
    pub created_at: String,
    pub reason: String,
    pub source: String,
    pub source_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct SessionRow {
    pub session_id: String,
    pub source_kind: String,
    pub external_id: String,
    pub title: String,
    pub occurred_at: String,
    pub source_revision: String,
    pub complete: bool,
    pub message_count: usize,
    pub payload_digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WritePlan {
    request_key: String,
    request_digest: String,
    record_id: String,
    kind: String,
    title: String,
    path: String,
    intent: String,
    status: String,
    stable_key: String,
    is_new: bool,
    candidate: Vec<u8>,
    expected_sha256: Option<String>,
    created_at: String,
    updated_at: String,
    source_ids: Vec<String>,
    reason: String,
}

#[derive(Debug)]
struct Receipt {
    state: String,
    candidate_hash: String,
    meta: String,
}

pub(crate) fn persist_generated(
    paths: &Paths,
    state: &State,
    connection: &mut Connection,
    session: &SessionRow,
    analysis: &CombinedAnalysis,
    status: &str,
) -> Result<Vec<RecordStatus>, SessionError> {
    let source_ids = vec![session.session_id.clone()];
    let source_json = serde_json::to_string(&source_ids).map_err(|_| SessionError::storage())?;
    let footer = format!(
        "\n\n---\n- source: {} / session {} / revision {}\n- occurred: {}\n- messages: {}\n- payload sha256: {}\n",
        session.source_kind,
        session.external_id,
        session.source_revision,
        session.occurred_at,
        session.message_count,
        &session.payload_digest[7..23.min(session.payload_digest.len())]
    );
    let mut specs = vec![(
        "summary",
        analysis.title.clone().or_title(&session.title),
        format!("{}{}", analysis.summary_markdown.trim(), footer),
    )];
    if !analysis.decisions.is_empty() {
        specs.push((
            "decision",
            truncate_chars(&format!("Decisions — {}", session.title), 512),
            format!(
                "## Decisions\n\n{}{}",
                markdown_list(&analysis.decisions, false),
                footer
            ),
        ));
    }
    if !analysis.tasks.is_empty() {
        specs.push((
            "task",
            truncate_chars(&format!("Tasks — {}", session.title), 512),
            format!(
                "## Tasks\n\n{}{}",
                markdown_list(&analysis.tasks, true),
                footer
            ),
        ));
    }
    specs.truncate(MAX_RECORDS_PER_SESSION);

    let mut records = Vec::with_capacity(specs.len());
    for (kind, title, body) in specs {
        let stable_key = format!("session:{}:{kind}", session.session_id);
        let request_key = format!("auto/{}:{kind}", session.session_id);
        let request_digest = hash_request(&json!({
            "operation": "automatic",
            "session_id": session.session_id,
            "payload_digest": session.payload_digest,
            "kind": kind,
        }))?;

        if let Some(receipt) = get_receipt(connection, &request_key)? {
            let plan = serde_json::from_str::<WritePlan>(&receipt.meta)
                .map_err(|_| SessionError::storage())?;
            if plan.request_digest != request_digest {
                return Err(SessionError::idempotency_conflict(
                    "prepared request key belongs to a different input",
                ));
            }
            if receipt.state == "committed" {
                if let Some(record) = get_record_status(connection, &plan.record_id)? {
                    records.push(record);
                }
                continue;
            }
            let result = execute_plan(paths, state, connection, &plan)?;
            records.push(result);
            continue;
        }

        if stable_record_exists(connection, &stable_key)? {
            if let Some(record) = get_record_by_stable_key(connection, &stable_key)? {
                records.push(record);
            }
            continue;
        }

        let prepared = oximemo_core::pdc_documents::prepare_document(
            paths,
            oximemo_core::pdc_documents::PdcCreateRequest {
                folder: "sessions".to_string(),
                title: title.clone(),
                body,
                body_profile: oximemo_core::pdc_documents::PdcBodyProfile::Markdown,
                tags: vec!["session".to_string(), kind.to_string()],
                properties: vec![
                    pdc_property("cassette_kind", kind),
                    pdc_property("cassette_intent", "inferred"),
                    pdc_property("cassette_source_ids", &source_json),
                    pdc_property("cassette_status", status),
                ],
            },
        )
        .map_err(map_pdc_error)?;
        let (created_at, updated_at) = pdc_timestamps(&prepared.path, prepared.content.as_bytes())?;
        let plan = WritePlan {
            request_key: request_key.clone(),
            request_digest,
            record_id: prepared.document_id,
            kind: kind.to_string(),
            title,
            path: prepared.path,
            intent: "inferred".to_string(),
            status: status.to_string(),
            stable_key,
            is_new: true,
            candidate: prepared.content.into_bytes(),
            expected_sha256: None,
            created_at,
            updated_at,
            source_ids: source_ids.clone(),
            reason: "session_summary".to_string(),
        };
        insert_prepared_receipt(connection, &plan)?;
        records.push(execute_plan(paths, state, connection, &plan)?);
    }
    Ok(records)
}

pub(crate) fn list_history(
    connection: &Connection,
    record_id: &str,
) -> Result<Vec<Revision>, SessionError> {
    if !record_exists(connection, record_id)? {
        return Err(SessionError::not_found("session record not found"));
    }
    let mut statement = connection
        .prepare(
            "SELECT revision, created_at, reason, source, source_ids FROM recorder_revisions WHERE record_id=?1 ORDER BY created_at DESC, revision DESC",
        )
        .map_err(|_| SessionError::storage())?;
    let rows = statement
        .query_map([record_id], |row| {
            let source_ids: String = row.get(4)?;
            Ok(Revision {
                record_id: record_id.to_string(),
                revision: row.get(0)?,
                created_at: row.get(1)?,
                reason: row.get(2)?,
                source: row.get(3)?,
                source_ids: serde_json::from_str(&source_ids).unwrap_or_default(),
            })
        })
        .map_err(|_| SessionError::storage())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| SessionError::storage())
}

pub(crate) fn accept_record(
    paths: &Paths,
    state: &State,
    connection: &mut Connection,
    record_id: &str,
    expected_sha256: &str,
) -> Result<RecordStatus, SessionError> {
    let record = get_record_status(connection, record_id)?
        .ok_or_else(|| SessionError::not_found("session record not found"))?;
    if record.status != "review" {
        return Err(SessionError::invalid(
            "only records awaiting review can be accepted",
        ));
    }
    if record.revision != expected_sha256 {
        return Err(SessionError::external_change(
            "record revision changed since it was listed",
        ));
    }
    let source =
        oximemo_core::pdc_documents::read_document(paths, &record.path).map_err(map_pdc_error)?;
    if source.sha256 != expected_sha256 {
        return Err(SessionError::external_change(
            "PDC record changed since it was listed",
        ));
    }
    let candidate = oximemo_core::pdc_documents::prepare_update_source(
        &source,
        None,
        None,
        &[("cassette_status".into(), "recorded".into())],
    )
    .map_err(map_pdc_error)?
    .ok_or_else(|| SessionError::external_change("review state was already changed"))?;
    let source_ids = record_sources(connection, record_id)?;
    let (_, updated_at) = pdc_timestamps(&record.path, &candidate)?;
    let request_key = format!("review/{record_id}:{expected_sha256}");
    let plan = WritePlan {
        request_key: request_key.clone(),
        request_digest: hash_request(&json!({
            "operation": "accept",
            "record_id": record_id,
            "base_revision": expected_sha256,
        }))?,
        record_id: record_id.to_string(),
        kind: record.kind.clone(),
        title: record.title.clone(),
        path: record.path.clone(),
        intent: record.intent.clone(),
        status: "recorded".into(),
        stable_key: stable_key_for_record(connection, record_id)?,
        is_new: false,
        candidate,
        expected_sha256: Some(expected_sha256.to_string()),
        created_at: record.created_at.clone(),
        updated_at,
        source_ids,
        reason: "human_review_accepted".into(),
    };
    insert_prepared_receipt(connection, &plan)?;
    execute_plan(paths, state, connection, &plan)
}

pub(crate) fn rollback_record(
    paths: &Paths,
    state: &State,
    connection: &mut Connection,
    record_id: &str,
    target_revision: &str,
    base_revision: &str,
    request_key: &str,
) -> Result<RecordStatus, SessionError> {
    if !valid_request_key(request_key)
        || !valid_sha256(target_revision)
        || !valid_sha256(base_revision)
    {
        return Err(SessionError::invalid(
            "invalid rollback key or revision digest",
        ));
    }
    if let Some(receipt) = get_receipt(connection, request_key)? {
        let plan = serde_json::from_str::<WritePlan>(&receipt.meta)
            .map_err(|_| SessionError::storage())?;
        if plan.record_id != record_id
            || plan.request_digest
                != hash_request(&json!({
                    "operation": "rollback",
                    "record_id": record_id,
                    "target_revision": target_revision,
                    "base_revision": base_revision,
                }))?
        {
            return Err(SessionError::idempotency_conflict(
                "rollback key belongs to another request",
            ));
        }
        if receipt.state == "committed" {
            return get_record_status(connection, record_id)?
                .ok_or_else(|| SessionError::not_found("session record not found"));
        }
        return execute_plan(paths, state, connection, &plan);
    }

    let current = get_record_status(connection, record_id)?
        .ok_or_else(|| SessionError::not_found("session record not found"))?;
    if current.revision != base_revision {
        return Err(SessionError::external_change(
            "record base revision changed",
        ));
    }
    let (target_source, target_source_ids): (String, String) = connection
        .query_row(
            "SELECT source, source_ids FROM recorder_revisions WHERE record_id=?1 AND revision=?2",
            params![record_id, target_revision],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|_| SessionError::storage())?
        .ok_or_else(|| SessionError::not_found("target revision not found"))?;
    let current_source =
        oximemo_core::pdc_documents::read_document(paths, &current.path).map_err(map_pdc_error)?;
    if current_source.sha256 != base_revision {
        return Err(SessionError::external_change(
            "live PDC record changed since its revision was read",
        ));
    }
    ensure_same_pdc_identity(&current_source.content, &target_source, &current.path)?;
    let ext = document_ext(&current.path)?;
    let target_doc = parse_pdc(&target_source, ext)?;
    let target_updated = target_doc
        .envelope
        .get("updated")
        .and_then(|value| value.as_str())
        .ok_or_else(|| SessionError::invalid("target revision has no update timestamp"))?;
    let current_doc = parse_pdc(&current_source.content, ext)?;
    let current_updated = current_doc
        .envelope
        .get("updated")
        .and_then(|value| value.as_str())
        .ok_or_else(|| SessionError::invalid("current PDC record has no update timestamp"))?;
    let updated = advance_timestamp(current_updated, target_updated)?;
    let candidate = oxi_frontmatter::pdc::patch_metadata(
        ext,
        target_source.as_bytes(),
        &[
            ("cassette_status", current.status.as_str()),
            ("updated", updated.as_str()),
        ],
    )
    .map_err(|_| SessionError::invalid("target revision could not be restored as PDC"))?;
    let source_ids: Vec<String> =
        serde_json::from_str(&target_source_ids).map_err(|_| SessionError::storage())?;
    validate_source_ids(connection, &source_ids)?;
    let digest = hash_request(&json!({
        "operation": "rollback",
        "record_id": record_id,
        "target_revision": target_revision,
        "base_revision": base_revision,
    }))?;
    let plan = WritePlan {
        request_key: request_key.to_string(),
        request_digest: digest,
        record_id: record_id.to_string(),
        kind: current.kind.clone(),
        title: pdc_title(&candidate, ext)?,
        path: current.path.clone(),
        intent: current.intent.clone(),
        status: current.status.clone(),
        stable_key: stable_key_for_record(connection, record_id)?,
        is_new: false,
        candidate,
        expected_sha256: Some(base_revision.to_string()),
        created_at: current.created_at.clone(),
        updated_at: updated,
        source_ids,
        reason: format!("rollback:{target_revision}"),
    };
    insert_prepared_receipt(connection, &plan)?;
    execute_plan(paths, state, connection, &plan)
}

fn insert_prepared_receipt(
    connection: &mut Connection,
    plan: &WritePlan,
) -> Result<(), SessionError> {
    let meta = serde_json::to_string(plan).map_err(|_| SessionError::storage())?;
    let candidate_hash = crate::export::digest(&plan.candidate);
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| SessionError::storage())?;
    let existing = transaction
        .query_row(
            "SELECT state, candidate_hash, meta FROM recorder_receipts WHERE request_key=?1",
            [&plan.request_key],
            |row| {
                Ok(Receipt {
                    state: row.get(0)?,
                    candidate_hash: row.get(1)?,
                    meta: row.get(2)?,
                })
            },
        )
        .optional()
        .map_err(|_| SessionError::storage())?;
    if let Some(existing) = existing {
        let previous = serde_json::from_str::<WritePlan>(&existing.meta)
            .map_err(|_| SessionError::storage())?;
        if existing.candidate_hash != candidate_hash
            || previous.request_digest != plan.request_digest
        {
            return Err(SessionError::idempotency_conflict(
                "request key is already reserved for different candidate bytes",
            ));
        }
        transaction.commit().map_err(|_| SessionError::storage())?;
        return Ok(());
    }
    transaction
        .execute(
            "INSERT INTO recorder_receipts(request_key,record_id,candidate_hash,state,meta) VALUES(?1,?2,?3,'prepared',?4)",
            params![plan.request_key, plan.record_id, candidate_hash, meta],
        )
        .map_err(|_| SessionError::storage())?;
    transaction.commit().map_err(|_| SessionError::storage())
}

fn execute_plan(
    paths: &Paths,
    _state: &State,
    connection: &mut Connection,
    plan: &WritePlan,
) -> Result<RecordStatus, SessionError> {
    let current = if plan.is_new {
        let prepared = oximemo_core::pdc_documents::PreparedPdcDocument {
            path: plan.path.clone(),
            document_id: plan.record_id.clone(),
            sha256: crate::export::digest(&plan.candidate),
            content: String::from_utf8(plan.candidate.clone())
                .map_err(|_| SessionError::invalid("prepared PDC source is not UTF-8"))?,
        };
        oximemo_core::pdc_documents::create_prepared_document(paths, &prepared)
            .map_err(map_pdc_error)?;
        oximemo_core::pdc_documents::read_document(paths, &plan.path).map_err(map_pdc_error)?
    } else {
        let expected = plan
            .expected_sha256
            .as_deref()
            .ok_or_else(SessionError::storage)?;
        oximemo_core::pdc_documents::update_prepared_document(
            paths,
            &plan.path,
            expected,
            &plan.candidate,
        )
        .map_err(map_pdc_error)?
    };
    if current.sha256 != crate::export::digest(&plan.candidate) {
        return Err(SessionError::external_change(
            "PDC writer returned different candidate bytes",
        ));
    }
    let source = current.content;
    let source_ids =
        serde_json::to_string(&plan.source_ids).map_err(|_| SessionError::storage())?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| SessionError::storage())?;
    transaction
        .execute(
            "INSERT INTO recorder_records(record_id,kind,title,path,intent,revision,status,stable_key,request_key,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11) ON CONFLICT(record_id) DO UPDATE SET kind=excluded.kind,title=excluded.title,path=excluded.path,intent=excluded.intent,revision=excluded.revision,status=excluded.status,stable_key=excluded.stable_key,request_key=excluded.request_key,created_at=recorder_records.created_at,updated_at=excluded.updated_at",
            params![plan.record_id, plan.kind, plan.title, plan.path, plan.intent, current.sha256, plan.status, plan.stable_key, plan.request_key, plan.created_at, plan.updated_at],
        )
        .map_err(|_| SessionError::storage())?;
    transaction
        .execute(
            "DELETE FROM recorder_record_sources WHERE record_id=?1",
            [&plan.record_id],
        )
        .map_err(|_| SessionError::storage())?;
    for source_id in &plan.source_ids {
        transaction
            .execute(
                "INSERT INTO recorder_record_sources(record_id,session_id) VALUES(?1,?2)",
                params![plan.record_id, source_id],
            )
            .map_err(|_| SessionError::storage())?;
    }
    transaction
        .execute(
            "INSERT OR IGNORE INTO recorder_revisions(record_id,revision,created_at,reason,source,source_ids) VALUES(?1,?2,?3,?4,?5,?6)",
            params![plan.record_id, current.sha256, plan.updated_at, plan.reason, source, source_ids],
        )
        .map_err(|_| SessionError::storage())?;
    let result_json = serde_json::to_string(&RecordStatus {
        record_id: plan.record_id.clone(),
        kind: plan.kind.clone(),
        title: plan.title.clone(),
        path: plan.path.clone(),
        intent: plan.intent.clone(),
        revision: current.sha256.clone(),
        status: plan.status.clone(),
        source_ids: plan.source_ids.clone(),
        created_at: plan.created_at.clone(),
        updated_at: plan.updated_at.clone(),
    })
    .map_err(|_| SessionError::storage())?;
    transaction
        .execute(
            "UPDATE recorder_receipts SET state='committed', result_json=?2 WHERE request_key=?1 AND candidate_hash=?3",
            params![plan.request_key, result_json, current.sha256],
        )
        .map_err(|_| SessionError::storage())?;
    transaction.commit().map_err(|_| SessionError::storage())?;
    Ok(RecordStatus {
        record_id: plan.record_id.clone(),
        kind: plan.kind.clone(),
        title: plan.title.clone(),
        path: plan.path.clone(),
        intent: plan.intent.clone(),
        revision: current.sha256,
        status: plan.status.clone(),
        source_ids: plan.source_ids.clone(),
        created_at: plan.created_at.clone(),
        updated_at: plan.updated_at.clone(),
    })
}

fn get_receipt(
    connection: &Connection,
    request_key: &str,
) -> Result<Option<Receipt>, SessionError> {
    connection
        .query_row(
            "SELECT state,candidate_hash,meta FROM recorder_receipts WHERE request_key=?1",
            [request_key],
            |row| {
                Ok(Receipt {
                    state: row.get(0)?,
                    candidate_hash: row.get(1)?,
                    meta: row.get(2)?,
                })
            },
        )
        .optional()
        .map_err(|_| SessionError::storage())
}

fn stable_record_exists(connection: &Connection, key: &str) -> Result<bool, SessionError> {
    connection
        .query_row(
            "SELECT 1 FROM recorder_records WHERE stable_key=?1",
            [key],
            |_| Ok(()),
        )
        .optional()
        .map(|value| value.is_some())
        .map_err(|_| SessionError::storage())
}

fn get_record_status(
    connection: &Connection,
    record_id: &str,
) -> Result<Option<RecordStatus>, SessionError> {
    let record = connection
        .query_row(
            "SELECT record_id,kind,title,path,intent,revision,status,created_at,updated_at FROM recorder_records WHERE record_id=?1",
            [record_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                ))
            },
        )
        .optional()
        .map_err(|_| SessionError::storage())?;
    let Some((id, kind, title, path, intent, revision, status, created_at, updated_at)) = record
    else {
        return Ok(None);
    };
    let source_ids = record_sources(connection, &id)?;
    Ok(Some(RecordStatus {
        record_id: id,
        kind,
        title,
        path,
        intent,
        revision,
        status,
        source_ids,
        created_at,
        updated_at,
    }))
}

fn get_record_by_stable_key(
    connection: &Connection,
    key: &str,
) -> Result<Option<RecordStatus>, SessionError> {
    let record_id = connection
        .query_row(
            "SELECT record_id FROM recorder_records WHERE stable_key=?1",
            [key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| SessionError::storage())?;
    record_id
        .as_deref()
        .map(|id| get_record_status(connection, id))
        .transpose()
        .map(Option::flatten)
}

fn record_exists(connection: &Connection, record_id: &str) -> Result<bool, SessionError> {
    connection
        .query_row(
            "SELECT 1 FROM recorder_records WHERE record_id=?1",
            [record_id],
            |_| Ok(()),
        )
        .optional()
        .map(|value| value.is_some())
        .map_err(|_| SessionError::storage())
}

fn record_sources(connection: &Connection, record_id: &str) -> Result<Vec<String>, SessionError> {
    let mut statement = connection
        .prepare(
            "SELECT session_id FROM recorder_record_sources WHERE record_id=?1 ORDER BY session_id",
        )
        .map_err(|_| SessionError::storage())?;
    let rows = statement
        .query_map([record_id], |row| row.get::<_, String>(0))
        .map_err(|_| SessionError::storage())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| SessionError::storage())
}

fn stable_key_for_record(connection: &Connection, record_id: &str) -> Result<String, SessionError> {
    connection
        .query_row(
            "SELECT stable_key FROM recorder_records WHERE record_id=?1",
            [record_id],
            |row| row.get(0),
        )
        .map_err(|_| SessionError::storage())
}

fn validate_source_ids(connection: &Connection, ids: &[String]) -> Result<(), SessionError> {
    if ids.len() > 64 {
        return Err(SessionError::invalid(
            "at most 64 session source IDs are allowed",
        ));
    }
    for id in ids {
        let exists = connection
            .query_row(
                "SELECT 1 FROM recorder_sessions WHERE session_id=?1",
                [id],
                |_| Ok(()),
            )
            .optional()
            .map_err(|_| SessionError::storage())?
            .is_some();
        if !exists {
            return Err(SessionError::not_found(
                "a referenced session source does not exist",
            ));
        }
    }
    Ok(())
}

fn pdc_property(key: &str, value: &str) -> oximemo_core::pdc_documents::PdcProperty {
    oximemo_core::pdc_documents::PdcProperty {
        key: key.to_string(),
        value: serde_json::Value::String(value.to_string()),
    }
}

fn markdown_list(items: &[String], tasks: bool) -> String {
    items
        .iter()
        .map(|item| {
            if tasks {
                format!("- [ ] {}", item.replace('\n', " "))
            } else {
                format!("- {}", item.replace('\n', " "))
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn truncate_chars(value: &str, max: usize) -> String {
    let mut chars = value.chars();
    let mut result: String = chars.by_ref().take(max).collect();
    if chars.next().is_some() {
        result.push('…');
    }
    result
}

fn hash_request(value: &serde_json::Value) -> Result<String, SessionError> {
    let bytes = serde_json::to_vec(value).map_err(|_| SessionError::storage())?;
    Ok(crate::export::digest(&bytes))
}

fn pdc_timestamps(path: &str, bytes: &[u8]) -> Result<(String, String), SessionError> {
    let ext = document_ext(path)?;
    let doc = parse_pdc(
        std::str::from_utf8(bytes).map_err(|_| SessionError::invalid("PDC source is not UTF-8"))?,
        ext,
    )?;
    let created = doc
        .envelope
        .get("created")
        .and_then(|value| value.as_str())
        .ok_or_else(|| SessionError::invalid("PDC source has no creation timestamp"))?;
    let updated = doc
        .envelope
        .get("updated")
        .and_then(|value| value.as_str())
        .ok_or_else(|| SessionError::invalid("PDC source has no update timestamp"))?;
    Ok((created.to_string(), updated.to_string()))
}

fn document_ext(path: &str) -> Result<oxi_frontmatter::pdc::DocumentExt, SessionError> {
    match Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
    {
        Some("md") => Ok(oxi_frontmatter::pdc::DocumentExt::Markdown),
        Some("html") => Ok(oxi_frontmatter::pdc::DocumentExt::Html),
        _ => Err(SessionError::invalid(
            "session record path is not a supported PDC source",
        )),
    }
}

fn parse_pdc(
    source: &str,
    ext: oxi_frontmatter::pdc::DocumentExt,
) -> Result<oxi_frontmatter::pdc::PdcDocument, SessionError> {
    match oxi_frontmatter::pdc::classify(ext, source.as_bytes()) {
        oxi_frontmatter::pdc::Classification::Valid(document) if !document.legacy => Ok(document),
        _ => Err(SessionError::invalid(
            "session record is not a canonical PDC document",
        )),
    }
}

fn pdc_title(
    source: &[u8],
    ext: oxi_frontmatter::pdc::DocumentExt,
) -> Result<String, SessionError> {
    let text = std::str::from_utf8(source)
        .map_err(|_| SessionError::invalid("PDC source is not UTF-8"))?;
    let doc = parse_pdc(text, ext)?;
    doc.envelope
        .get("title")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .ok_or_else(|| SessionError::invalid("PDC source has no title"))
}

fn ensure_same_pdc_identity(current: &str, target: &str, path: &str) -> Result<(), SessionError> {
    let ext = document_ext(path)?;
    let current = parse_pdc(current, ext)?;
    let target = parse_pdc(target, ext)?;
    if current.id != target.id
        || current.profile != target.profile
        || current.envelope.get("created") != target.envelope.get("created")
    {
        return Err(SessionError::external_change(
            "target revision has a different PDC identity",
        ));
    }
    Ok(())
}

fn advance_timestamp(current: &str, target: &str) -> Result<String, SessionError> {
    let current = OffsetDateTime::parse(current, &Rfc3339)
        .map_err(|_| SessionError::invalid("current PDC timestamp is invalid"))?;
    let target = OffsetDateTime::parse(target, &Rfc3339)
        .map_err(|_| SessionError::invalid("target PDC timestamp is invalid"))?;
    let now = OffsetDateTime::now_utc();
    let mut next = now.max(current).max(target);
    if next <= current || next <= target {
        next += time::Duration::milliseconds(1);
    }
    let format = time::macros::format_description!(
        "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
    );
    next.format(format).map_err(|_| SessionError::storage())
}

fn valid_request_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

fn valid_sha256(value: &str) -> bool {
    value
        .strip_prefix("sha256:")
        .is_some_and(|hex| hex.len() == 64 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

fn map_pdc_error(error: oximemo_core::CoreError) -> SessionError {
    let message = error.to_string();
    if message.contains("external_change_conflict") {
        SessionError::external_change("PDC source changed during session write")
    } else {
        SessionError::invalid("PDC source rejected the session record")
    }
}

trait FallbackTitle {
    fn or_title(self, fallback: &str) -> String;
}

impl FallbackTitle for String {
    fn or_title(self, fallback: &str) -> String {
        if self.trim().is_empty() {
            fallback.to_string()
        } else {
            self
        }
    }
}
