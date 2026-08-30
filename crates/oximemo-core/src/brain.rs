//! Documents-plane glue between oximemo's vault and the oxibrain
//! caller-owned model (unified home design, 2026-08-30).
//!
//! The brain has no resident process: every interaction spawns
//! `oxibrain admin serve --stdio` as a short-lived caller-owned child
//! and speaks newline-delimited JSON-RPC over its piped stdio.
//! **oximemo never writes brain files** (`~/.oxi/brain/`): the
//! documents root is registered through
//! [`BrainClient::register_document_root`], an idempotent upsert keyed
//! by alias that lives on the oxibrain side of the client boundary.
//!
//! Because a registration needs a live oxibrain child and
//! `Vault::open` must never block (or spawn anything), open only
//! *records* the pending request and a later flush delivers it:
//!
//! - [`document_root_request`] — the pure vault+space → request
//!   mapping (`None` rules mean the brain's connector defaults apply;
//!   oximemo deliberately ships no include/exclude/size policy).
//! - [`record_pending_root_registration`] — boot-time, synchronous,
//!   oximemo-private fs only: atomically writes
//!   `<app_support_dir()>/pending_root_registration.json`.
//! - [`register_document_root`] / [`flush_pending_registrations`] —
//!   the client-boundary calls. The flush is offline-tolerant: on any
//!   failure the pending file is restored verbatim and `Ok(None)`
//!   returned, so an unflushable registration is a normal state, not
//!   an error.
//! - [`vault_space_name`] — the space identity, derived from the vault
//!   directory basename (amended spaces spec §2). There is no
//!   configured space anywhere in oximemo.
//!
//! Flush points: the desktop boot task, `oximemo doctor`, and
//! `oximemo migrate-home`. `Vault::open` itself re-records the pending
//! request on every open with `[brain].enabled`, so even a lost flush
//! is retried on the next launch.
//!
//! Failure posture (ECOSYSTEM C1): the brain is additive; a missing or
//! uninstalled oxibrain is a normal state, never an error for the
//! caller's main flow.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use oxibrain_client::{
    BrainClient, LocalProcessEndpoint, RegisterDocumentRootOutcome, RegisterDocumentRootRequest,
};

/// Filename of the deferred registration record under
/// [`crate::paths::app_support_dir()`].
pub const PENDING_FILE_NAME: &str = "pending_root_registration.json";

#[cfg(test)]
use std::cell::RefCell;

#[cfg(test)]
thread_local! {
    /// Per-thread pending-dir override for tests: without an installed
    /// override the pending glue is a no-op under `cfg(test)` so
    /// unrelated vault-opening tests never touch the developer's real
    /// `~/.oxi/oximemo/` (the same contract as the retired
    /// `NoopBrainRegistrar` gate). Production is always active.
    static TEST_PENDING_DIR: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn with_test_pending_dir<R>(dir: &Path, f: impl FnOnce() -> R) -> R {
    let _ = TEST_PENDING_DIR.try_with(|cell| *cell.borrow_mut() = Some(dir.to_path_buf()));
    let out = f();
    let _ = TEST_PENDING_DIR.try_with(|cell| *cell.borrow_mut() = None);
    out
}

/// Under `cfg(test)` with no override installed, the pending glue is a
/// no-op. Production is always active.
#[cfg(test)]
fn test_pending_gate_active() -> bool {
    TEST_PENDING_DIR
        .try_with(|cell| cell.borrow().is_some())
        .unwrap_or(false)
}

/// `~/.oxi/brain` (or `$OXI_HOME/brain`) — the oxibrain data plane.
/// Caller-owned stdio children are pointed here with `--dir`;
/// `documents.toml` lives inside. The directory is created and owned
/// by oxibrain — oximemo only passes the path.
pub fn brain_dir() -> PathBuf {
    crate::paths::oxi_home().join("brain")
}

/// The space name for a vault: its directory basename, or `"personal"`
/// when the path has no usable final component (root path, empty).
pub fn vault_space_name(vault: &Path) -> String {
    vault
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("personal")
        .to_string()
}

/// The pure vault+space → registration request mapping. Alias and
/// space are the vault directory basename; `None` rules mean the
/// brain's connector defaults apply.
pub fn document_root_request(vault: &Path, space: &str) -> RegisterDocumentRootRequest {
    RegisterDocumentRootRequest {
        space: space.to_string(),
        alias: space.to_string(),
        path: vault.to_string_lossy().into_owned(),
        include: None,
        exclude: None,
        max_file_bytes: None,
    }
}

/// One deferred [`RegisterDocumentRootRequest`] plus when it was
/// recorded (unix seconds).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RecordedRootRequest {
    pub request: RegisterDocumentRootRequest,
    pub recorded_at: u64,
}

/// The pending-registration file
/// (`pending_root_registration.json`): a list of deferred requests,
/// deduplicated by alias (a fresh record for an alias replaces the
/// stale one). The flat→spaces migration records one request per moved
/// space so every moved root is re-registered, not just the personal
/// vault. Restored verbatim on a failed flush, so `recorded_at` keeps
/// the original recording time.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PendingRootRegistration {
    pub requests: Vec<RecordedRootRequest>,
}

/// Backward compatibility: the 0.13.0 single-request shape.
#[derive(serde::Deserialize)]
#[serde(untagged)]
enum PendingFile {
    List {
        requests: Vec<RecordedRootRequest>,
    },
    LegacySingle {
        request: RegisterDocumentRootRequest,
        recorded_at: u64,
    },
}

/// The pending-registration directory: the test override under
/// `cfg(test)`, oximemo's private app-support dir in production.
fn pending_dir() -> PathBuf {
    #[cfg(test)]
    if let Some(dir) = TEST_PENDING_DIR
        .try_with(|cell| cell.borrow().clone())
        .ok()
        .flatten()
    {
        return dir;
    }
    crate::paths::app_support_dir()
}

fn pending_path() -> PathBuf {
    pending_dir().join(PENDING_FILE_NAME)
}

/// The pending registrations, if any are recorded. Accepts both the
/// current list shape and the 0.13.0 single-request shape. A corrupt
/// file is logged and ignored — the next `Vault::open` re-records
/// anyway.
pub fn pending_root_registration() -> Option<PendingRootRegistration> {
    #[cfg(test)]
    if !test_pending_gate_active() {
        return None;
    }
    let text = std::fs::read_to_string(pending_path()).ok()?;
    match serde_json::from_str::<PendingFile>(&text) {
        Ok(PendingFile::List { requests }) => Some(PendingRootRegistration { requests }),
        Ok(PendingFile::LegacySingle {
            request,
            recorded_at,
        }) => Some(PendingRootRegistration {
            requests: vec![RecordedRootRequest {
                request,
                recorded_at,
            }],
        }),
        Err(e) => {
            tracing::warn!(
                error = %e,
                path = %pending_path().display(),
                "brain: corrupt pending registration file ignored"
            );
            None
        }
    }
}

/// Whether documents-root registrations are waiting for a flush
/// (doctor visibility).
pub fn has_pending_root_registration() -> bool {
    pending_root_registration().is_some()
}

/// Record one registration request for a later
/// [`flush_pending_registrations`], replacing any earlier request with
/// the same alias and preserving the others. Synchronous, pure
/// filesystem, and strictly inside oximemo's own private subtree —
/// never a brain file, never a spawned child, so `Vault::open` stays
/// instant (C1: boot never blocks on the brain). Failures are logged,
/// never propagated.
pub fn record_pending_request(request: RegisterDocumentRootRequest) {
    #[cfg(test)]
    if !test_pending_gate_active() {
        return;
    }
    let mut pending = pending_root_registration().unwrap_or(PendingRootRegistration {
        requests: Vec::new(),
    });
    pending
        .requests
        .retain(|r| r.request.alias != request.alias);
    pending.requests.push(RecordedRootRequest {
        request,
        recorded_at: unix_now(),
    });
    let Ok(body) = serde_json::to_string_pretty(&pending) else {
        tracing::warn!("brain: pending registration serialize failed");
        return;
    };
    let path = pending_path();
    if let Err(e) = oxi_frontmatter::atomic_write(&path, body.as_bytes()) {
        tracing::warn!(
            error = %e,
            path = %path.display(),
            "brain: pending registration not recorded"
        );
    }
}

/// Record the active vault's registration request for a later
/// [`flush_pending_registrations`]. See [`record_pending_request`].
pub fn record_pending_root_registration(vault: &Path, space: &str) {
    record_pending_request(document_root_request(vault, space));
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Register the document root through the client boundary: spawn the
/// caller-owned `oxibrain admin serve --stdio` child for
/// [`brain_dir`], perform the idempotent alias-keyed upsert, and drop
/// the child (`kill_on_drop`). Mirrors the desktop app's endpoint
/// construction. Never touches `documents.toml` directly.
pub async fn register_document_root(
    executable: &Path,
    request: &RegisterDocumentRootRequest,
) -> Result<RegisterDocumentRootOutcome> {
    let endpoint = LocalProcessEndpoint::new(executable, brain_dir());
    let mut client = BrainClient::spawn_local(endpoint)
        .await
        .context("spawn oxibrain for document-root registration")?;
    let outcome = client
        .register_document_root(request.clone())
        .await
        .context("register_document_root rpc")?;
    drop(client);
    Ok(outcome)
}

/// Deliver the recorded pending registrations: read and delete the
/// pending file, attempt every request in recording order, and on full
/// success return the first outcome. On any failure (offline, oxibrain
/// missing, handshake or RPC error) the pending file is re-written
/// verbatim — including the requests already delivered, which are
/// idempotent alias-keyed upserts brain-side — and `Ok(None)` is
/// returned, never an error for the caller (C1). A crash between
/// delete and attempt loses nothing because the next `Vault::open`
/// re-records the requests.
pub async fn flush_pending_registrations(
    executable: &Path,
) -> Result<Option<RegisterDocumentRootOutcome>> {
    let Some(pending) = pending_root_registration() else {
        return Ok(None);
    };
    if pending.requests.is_empty() {
        let _ = std::fs::remove_file(pending_path());
        return Ok(None);
    }
    let _ = std::fs::remove_file(pending_path());
    let mut first_outcome: Option<RegisterDocumentRootOutcome> = None;
    for recorded in &pending.requests {
        match register_document_root(executable, &recorded.request).await {
            Ok(outcome) if first_outcome.is_none() => first_outcome = Some(outcome),
            Ok(_) => {}
            Err(error) => {
                tracing::debug!(
                    error = %format!("{error:#}"),
                    alias = %recorded.request.alias,
                    "brain: pending registration flush failed; requests kept for the next flush point"
                );
                if let Ok(body) = serde_json::to_string_pretty(&pending) {
                    let _ = oxi_frontmatter::atomic_write(&pending_path(), body.as_bytes());
                }
                return Ok(None);
            }
        }
    }
    Ok(first_outcome)
}

/// Blocking flush for synchronous callers (the CLI has no async
/// runtime of its own): runs the async flush on a minimal
/// current-thread tokio runtime.
pub fn flush_pending_registrations_blocking(
    executable: &Path,
) -> Result<Option<RegisterDocumentRootOutcome>> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .context("build tokio runtime for pending flush")?
        .block_on(flush_pending_registrations(executable))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migrate_vault::with_home;

    #[test]
    fn document_root_request_maps_alias_space_path() {
        let request = document_root_request(Path::new("/tmp/x/work"), "work");
        assert_eq!(request.space, "work");
        assert_eq!(request.alias, "work");
        assert_eq!(request.path, "/tmp/x/work");
        // Rules stay unset: the brain's connector defaults apply.
        assert!(request.include.is_none());
        assert!(request.exclude.is_none());
        assert!(request.max_file_bytes.is_none());

        assert_eq!(vault_space_name(Path::new("/tmp/x/work")), "work");
        assert_eq!(vault_space_name(Path::new("work")), "work");
        assert_eq!(vault_space_name(Path::new("/")), "personal");
        assert_eq!(vault_space_name(Path::new("")), "personal");
    }

    #[test]
    fn no_override_is_a_noop() {
        // Without `with_test_pending_dir`, cfg(test) builds must never
        // touch the real pending file (NoopBrainRegistrar contract).
        record_pending_root_registration(Path::new("/tmp/oximemo-noop-vault"), "personal");
        assert!(!has_pending_root_registration());
    }

    #[test]
    fn record_then_read_roundtrips_request() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().join("spaces/work/vault");
        std::fs::create_dir_all(&vault).unwrap();
        let before = unix_now();
        with_test_pending_dir(dir.path(), || {
            record_pending_root_registration(&vault, "work");
            let pending = pending_root_registration().expect("recorded");
            let want = document_root_request(&vault, "work");
            assert_eq!(pending.requests.len(), 1);
            assert_eq!(pending.requests[0].request.space, want.space);
            assert_eq!(pending.requests[0].request.alias, want.alias);
            assert_eq!(pending.requests[0].request.path, want.path);
            assert!(
                pending.requests[0].recorded_at >= before.saturating_sub(1),
                "recorded_at = {}",
                pending.requests[0].recorded_at
            );
            assert!(has_pending_root_registration());
            // The file lands under the override dir with the documented name.
            assert!(dir.path().join(PENDING_FILE_NAME).is_file());
        });
    }

    #[test]
    fn recording_by_alias_replaces_only_that_alias() {
        let dir = tempfile::tempdir().unwrap();
        with_test_pending_dir(dir.path(), || {
            record_pending_request(document_root_request(Path::new("/t/k"), "knowledge"));
            record_pending_request(document_root_request(Path::new("/t/p"), "personal"));
            // A re-open of the personal vault replaces its entry, keeps
            // the knowledge one.
            record_pending_request(document_root_request(Path::new("/t/p2"), "personal"));
            let pending = pending_root_registration().unwrap();
            let aliases: Vec<&str> = pending
                .requests
                .iter()
                .map(|r| r.request.alias.as_str())
                .collect();
            assert_eq!(aliases, vec!["knowledge", "personal"]);
            assert_eq!(pending.requests[1].request.path, "/t/p2");
        });
    }

    #[test]
    fn legacy_single_request_file_reads_as_one_element_list() {
        let dir = tempfile::tempdir().unwrap();
        // The 0.13.0 shape, verbatim.
        std::fs::write(
            dir.path().join(PENDING_FILE_NAME),
            r#"{
  "request": {
    "space": "personal",
    "alias": "personal",
    "path": "/t/vault"
  },
  "recorded_at": 1788048572
}"#,
        )
        .unwrap();
        with_test_pending_dir(dir.path(), || {
            let pending = pending_root_registration().unwrap();
            assert_eq!(pending.requests.len(), 1);
            assert_eq!(pending.requests[0].request.alias, "personal");
            assert_eq!(pending.requests[0].recorded_at, 1788048572);
        });
    }

    #[test]
    fn offline_flush_keeps_pending_and_never_touches_brain_files() {
        let home = tempfile::tempdir().unwrap().keep();
        with_home(&home, || {
            let pending_dir = home.join("pending-test");
            let vault = home.join("spaces/work/vault");
            std::fs::create_dir_all(&vault).unwrap();
            with_test_pending_dir(&pending_dir, || {
                record_pending_root_registration(&vault, "work");
                assert!(pending_dir.join(PENDING_FILE_NAME).is_file());

                // A missing executable fails the spawn; the flush must
                // report Ok(None) and re-write the pending file verbatim.
                let before = std::fs::read(pending_dir.join(PENDING_FILE_NAME)).unwrap();
                let out = flush_pending_registrations_blocking(Path::new("/nonexistent/oxibrain"))
                    .expect("flush never errors for offline");
                assert!(out.is_none());
                assert_eq!(
                    std::fs::read(pending_dir.join(PENDING_FILE_NAME)).unwrap(),
                    before,
                    "pending file restored verbatim"
                );
                // No brain files anywhere: oximemo only ever passes the
                // path to the spawned child.
                assert!(!home.join(".oxi/brain").exists());
            });
        });
    }

    #[test]
    fn flush_without_pending_is_a_noop() {
        let dir = tempfile::tempdir().unwrap();
        with_test_pending_dir(dir.path(), || {
            let out = flush_pending_registrations_blocking(Path::new("/nonexistent/oxibrain"))
                .expect("no pending → no attempt");
            assert!(out.is_none());
        });
    }
}
