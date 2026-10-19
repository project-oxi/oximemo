use crate::SessionRecorder;
use crate::error::SessionError;
use crate::export::{contains_secret, digest};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use uuid::Uuid;

const MAX_HOOK_BYTES: usize = 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES: usize = 64 * 1024 * 1024;
const MAX_GIT_SCAN_LIMIT: usize = 1000;
const MAX_CHANGED_PATHS: usize = 500;
const MAX_PATH_BYTES: usize = 512;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ActivityEvent {
    pub activity_id: String,
    pub source_kind: String,
    pub source_key: String,
    pub external_id: String,
    pub title: String,
    pub occurred_at: String,
    pub payload_digest: String,
    pub state: String,
    pub metadata: Option<Value>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ActivityCaptureReceipt {
    pub activity_id: String,
    pub source_kind: String,
    pub external_id: String,
    pub state: String,
    pub duplicate: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GitSourceRegistration {
    pub path: String,
    pub enabled: bool,
    pub last_error: Option<String>,
    pub created_at: String,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GitScanItem {
    pub path: String,
    pub scanned: usize,
    pub captured: usize,
    pub duplicates: usize,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GitScanReport {
    pub scanned: usize,
    pub captured: usize,
    pub duplicates: usize,
    pub failed: usize,
    pub items: Vec<GitScanItem>,
}

#[derive(Debug)]
struct GitCommit {
    hash: String,
    authored_at: String,
    author: String,
    subject: String,
}

impl SessionRecorder {
    /// Capture Codex SessionEnd metadata only. `transcript_path` is retained as
    /// inert metadata; this method never opens or reads the referenced file.
    pub fn capture_codex_hook_json(
        &self,
        bytes: &[u8],
    ) -> Result<ActivityCaptureReceipt, SessionError> {
        if bytes.is_empty() || bytes.len() > MAX_HOOK_BYTES {
            return Err(SessionError::invalid(
                "Codex hook input exceeds its size limit",
            ));
        }
        let input: Value = serde_json::from_slice(bytes)
            .map_err(|_| SessionError::invalid("Codex hook input is not valid JSON"))?;
        let object = input
            .as_object()
            .ok_or_else(|| SessionError::invalid("Codex hook input must be a JSON object"))?;
        if object.get("hook_event_name").and_then(Value::as_str) != Some("SessionEnd") {
            return Err(SessionError::invalid(
                "only Codex SessionEnd events are accepted",
            ));
        }
        let external_id = bounded_string(object.get("session_id"), "session_id", 512)?;
        if external_id.trim().is_empty() {
            return Err(SessionError::invalid("Codex session_id must not be empty"));
        }
        let cwd = optional_bounded_string(object.get("cwd"), "cwd", 4096)?;
        let transcript_path =
            optional_bounded_string(object.get("transcript_path"), "transcript_path", 4096)?;
        let reason = optional_bounded_string(object.get("reason"), "reason", 512)?;
        let metadata = json!({
            "format": "oximemo-codex-session-end/1",
            "hook_event": "SessionEnd",
            "session_id": external_id,
            "cwd": cwd,
            "transcript_path": transcript_path,
            "reason": reason,
            "transcript_note": "Transcript path is metadata only; Oximemo never reads its contents."
        });
        self.capture_activity(
            "codex_session",
            "",
            &external_id,
            &format!(
                "Codex session {}",
                external_id.chars().take(12).collect::<String>()
            ),
            &crate::now_rfc3339(),
            &metadata,
        )
    }

    pub fn list_activity_events(&self, limit: usize) -> Result<Vec<ActivityEvent>, SessionError> {
        if limit == 0 || limit > 1000 {
            return Err(SessionError::invalid("activity limit must be in 1..=1000"));
        }
        let connection = self.state.connect()?;
        let mut statement = connection
            .prepare(
                "SELECT activity_id,source_kind,source_key,external_id,title,occurred_at,payload_digest,state,payload_json,created_at FROM recorder_activity_events ORDER BY occurred_at DESC,created_at DESC LIMIT ?1",
            )
            .map_err(|_| SessionError::storage())?;
        let rows = statement
            .query_map([limit as i64], |row| {
                let metadata: Option<String> = row.get(8)?;
                Ok((
                    ActivityEvent {
                        activity_id: row.get(0)?,
                        source_kind: row.get(1)?,
                        source_key: row.get(2)?,
                        external_id: row.get(3)?,
                        title: row.get(4)?,
                        occurred_at: row.get(5)?,
                        payload_digest: row.get(6)?,
                        state: row.get(7)?,
                        metadata: None,
                        created_at: row.get(9)?,
                    },
                    metadata,
                ))
            })
            .map_err(|_| SessionError::storage())?;
        let mut events = Vec::new();
        for row in rows {
            let (mut event, metadata) = row.map_err(|_| SessionError::storage())?;
            event.metadata = metadata
                .map(|text| serde_json::from_str(&text).map_err(|_| SessionError::storage()))
                .transpose()?;
            events.push(event);
        }
        Ok(events)
    }

    /// Delete one local activity receipt. Quarantined payload bytes are also
    /// removed; normal activity metadata is stored directly in the database.
    pub fn discard_activity_event(&self, activity_id: &str) -> Result<(), SessionError> {
        if Uuid::parse_str(activity_id).is_err() {
            return Err(SessionError::invalid("invalid activity id"));
        }
        let _lock = self.state.acquire_lock()?;
        let mut connection = self.state.connect()?;
        let transaction = connection
            .transaction()
            .map_err(|_| SessionError::storage())?;
        let payload_ref: Option<String> = transaction
            .query_row(
                "SELECT payload_ref FROM recorder_activity_events WHERE activity_id=?1",
                [activity_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| SessionError::storage())?
            .flatten();
        let deleted = transaction
            .execute(
                "DELETE FROM recorder_activity_events WHERE activity_id=?1",
                [activity_id],
            )
            .map_err(|_| SessionError::storage())?;
        if deleted == 0 {
            return Err(SessionError::not_found("activity event not found"));
        }
        transaction.commit().map_err(|_| SessionError::storage())?;
        if let Some(path) = payload_ref {
            let path = PathBuf::from(path);
            if path.parent() == Some(self.state.quarantine.as_path()) {
                self.state.remove_quarantine(&path)?;
            }
        }
        Ok(())
    }

    pub fn register_git_source(&self, path: &Path) -> Result<GitSourceRegistration, SessionError> {
        let canonical = git_repository_root(path)?;
        let canonical_text = canonical.to_string_lossy().into_owned();
        let _lock = self.state.acquire_lock()?;
        let connection = self.state.connect()?;
        let now = crate::now_rfc3339();
        connection
            .execute(
                "INSERT INTO recorder_git_sources(path,enabled,created_at) VALUES(?1,1,?2) ON CONFLICT(path) DO UPDATE SET enabled=1,last_error=NULL",
                rusqlite::params![canonical_text, now],
            )
            .map_err(|_| SessionError::storage())?;
        get_git_source(&connection, &canonical_text)?.ok_or_else(SessionError::storage)
    }

    pub fn list_git_sources(&self) -> Result<Vec<GitSourceRegistration>, SessionError> {
        let connection = self.state.connect()?;
        let mut statement = connection
            .prepare(
                "SELECT path,enabled,last_error,created_at,cursor FROM recorder_git_sources ORDER BY path",
            )
            .map_err(|_| SessionError::storage())?;
        let rows = statement
            .query_map([], |row| {
                Ok(GitSourceRegistration {
                    path: row.get(0)?,
                    enabled: row.get::<_, i64>(1)? != 0,
                    last_error: row.get(2)?,
                    created_at: row.get(3)?,
                    cursor: row.get(4)?,
                })
            })
            .map_err(|_| SessionError::storage())?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| SessionError::storage())
    }

    pub fn set_git_source_enabled(
        &self,
        path: &Path,
        enabled: bool,
    ) -> Result<GitSourceRegistration, SessionError> {
        let stored_path = git_repository_root(path)?.to_string_lossy().into_owned();
        let _lock = self.state.acquire_lock()?;
        let connection = self.state.connect()?;
        let changed = connection
            .execute(
                "UPDATE recorder_git_sources SET enabled=?2,last_error=NULL WHERE path=?1",
                rusqlite::params![stored_path, enabled as i64],
            )
            .map_err(|_| SessionError::storage())?;
        if changed == 0 {
            return Err(SessionError::not_found("registered Git source not found"));
        }
        get_git_source(&connection, &stored_path)?.ok_or_else(SessionError::storage)
    }

    pub fn remove_git_source(&self, path: &Path) -> Result<bool, SessionError> {
        let stored_path = git_repository_root(path)?.to_string_lossy().into_owned();
        let _lock = self.state.acquire_lock()?;
        let connection = self.state.connect()?;
        connection
            .execute(
                "DELETE FROM recorder_git_sources WHERE path=?1",
                [stored_path],
            )
            .map(|count| count > 0)
            .map_err(|_| SessionError::storage())
    }

    /// Scan only explicitly registered repositories. Git commands read commit
    /// metadata and changed paths; file contents and diffs are never opened.
    pub fn scan_registered_git_sources(
        &self,
        limit_per_repository: usize,
    ) -> Result<GitScanReport, SessionError> {
        if limit_per_repository == 0 || limit_per_repository > MAX_GIT_SCAN_LIMIT {
            return Err(SessionError::invalid("Git scan limit must be in 1..=1000"));
        }
        let sources = self.list_git_sources()?;
        let mut report = GitScanReport {
            scanned: 0,
            captured: 0,
            duplicates: 0,
            failed: 0,
            items: Vec::new(),
        };
        for source in sources.into_iter().filter(|source| source.enabled) {
            match self.scan_git_source(&source, limit_per_repository) {
                Ok(item) => {
                    report.scanned += item.scanned;
                    report.captured += item.captured;
                    report.duplicates += item.duplicates;
                    report.items.push(item);
                }
                Err(error) => {
                    report.failed += 1;
                    let detail = error.to_string();
                    self.set_git_source_error(&source.path, Some(&detail))?;
                    report.items.push(GitScanItem {
                        path: source.path,
                        scanned: 0,
                        captured: 0,
                        duplicates: 0,
                        error: Some(detail),
                    });
                }
            }
        }
        Ok(report)
    }

    pub fn codex_hook_installed(
        &self,
        cli_path: &Path,
        vault_path: &Path,
    ) -> Result<bool, SessionError> {
        let command = codex_hook_command(cli_path, vault_path)?;
        hook_registered(&codex_hooks_path()?, &command)
    }

    /// Install only Oximemo's Codex SessionEnd command while preserving every
    /// unrelated hook entry. The UI calls this only after an explicit action.
    pub fn install_codex_hook(
        &self,
        cli_path: &Path,
        vault_path: &Path,
    ) -> Result<String, SessionError> {
        let command = codex_hook_command(cli_path, vault_path)?;
        let path = codex_hooks_path()?;
        mutate_codex_hooks(&path, &command, true)?;
        Ok(path.to_string_lossy().into_owned())
    }

    pub fn uninstall_codex_hook(
        &self,
        cli_path: &Path,
        vault_path: &Path,
    ) -> Result<String, SessionError> {
        let command = codex_hook_command(cli_path, vault_path)?;
        let path = codex_hooks_path()?;
        mutate_codex_hooks(&path, &command, false)?;
        Ok(path.to_string_lossy().into_owned())
    }

    fn scan_git_source(
        &self,
        source: &GitSourceRegistration,
        limit: usize,
    ) -> Result<GitScanItem, SessionError> {
        let root = git_repository_root(Path::new(&source.path))?;
        let commits = read_git_commits(&root, source.cursor.as_deref(), limit)?;
        let scanned = commits.len();
        let mut captured = 0;
        let mut duplicates = 0;
        for commit in &commits {
            let (paths, paths_truncated, omitted_paths) = changed_paths(&root, &commit.hash)?;
            let (author, author_truncated) = bounded_field(&commit.author, 1024);
            let (subject, subject_truncated) = bounded_field(&commit.subject, 8192);
            let metadata = json!({
                "format": "oximemo-git-commit/1",
                "repository": source.path,
                "commit": commit.hash,
                "authored_at": commit.authored_at,
                "author": author,
                "author_truncated": author_truncated,
                "subject": subject,
                "subject_truncated": subject_truncated,
                "changed_paths": paths,
                "changed_paths_truncated": paths_truncated,
                "omitted_changed_path_count": omitted_paths
            });
            let title = if contains_secret(&metadata.to_string()) {
                format!("Git commit {}", &commit.hash[..commit.hash.len().min(12)])
            } else {
                subject
            };
            let receipt = self.capture_activity(
                "git_commit",
                &source.path,
                &commit.hash,
                &title,
                &commit.authored_at,
                &metadata,
            )?;
            if receipt.duplicate {
                duplicates += 1;
            } else {
                captured += 1;
            }
        }
        if let Some(latest) = commits.last() {
            self.set_git_source_cursor(&source.path, &latest.hash)?;
        }
        self.set_git_source_error(&source.path, None)?;
        Ok(GitScanItem {
            path: source.path.clone(),
            scanned,
            captured,
            duplicates,
            error: None,
        })
    }

    fn capture_activity(
        &self,
        source_kind: &str,
        source_key: &str,
        external_id: &str,
        title: &str,
        occurred_at: &str,
        metadata: &Value,
    ) -> Result<ActivityCaptureReceipt, SessionError> {
        if source_kind.is_empty()
            || source_kind.len() > 64
            || source_key.len() > 4096
            || external_id.is_empty()
            || external_id.len() > 512
            || title.len() > 1024
            || occurred_at.len() > 64
        {
            return Err(SessionError::invalid(
                "activity event fields exceed their limits",
            ));
        }
        let payload_json = serde_json::to_string(metadata).map_err(|_| SessionError::storage())?;
        if payload_json.len() > 64 * 1024 {
            return Err(SessionError::invalid("activity metadata exceeds 64 KiB"));
        }
        let payload_digest = digest(payload_json.as_bytes());
        let activity_id = Uuid::new_v5(
            &Uuid::NAMESPACE_URL,
            format!("oximemo-activity/1\u{1}{source_kind}\u{1}{source_key}\u{1}{external_id}\u{1}{payload_digest}").as_bytes(),
        )
        .to_string();
        let secret_suspected = contains_secret(&payload_json)
            || contains_secret(source_key)
            || contains_secret(external_id)
            || contains_secret(title)
            || contains_secret(occurred_at);
        let (stored_source_key, stored_external_id, stored_title, receipt_external_id) =
            if secret_suspected {
                let redacted_key = format!("quarantined:{activity_id}");
                (
                    redacted_key,
                    "[redacted]".to_string(),
                    format!("Quarantined {} activity", source_kind.replace('_', " ")),
                    "[redacted]".to_string(),
                )
            } else {
                (
                    source_key.to_string(),
                    external_id.to_string(),
                    title.to_string(),
                    external_id.to_string(),
                )
            };
        let _lock = self.state.acquire_lock()?;
        let connection = self.state.connect()?;
        let existing: Option<String> = connection
            .query_row(
                "SELECT activity_id FROM recorder_activity_events WHERE source_kind=?1 AND source_key=?2 AND external_id=?3 AND payload_digest=?4",
                rusqlite::params![source_kind, stored_source_key, stored_external_id, payload_digest],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| SessionError::storage())?;
        if let Some(existing) = existing {
            return Ok(ActivityCaptureReceipt {
                activity_id: existing,
                source_kind: source_kind.to_string(),
                external_id: receipt_external_id,
                state: if secret_suspected {
                    "quarantined"
                } else {
                    "captured"
                }
                .into(),
                duplicate: true,
            });
        }
        let (state, payload_json, payload_ref) = if secret_suspected {
            let path = self
                .state
                .write_quarantine(&activity_id, payload_json.as_bytes())?;
            (
                "quarantined",
                None,
                Some(path.to_string_lossy().into_owned()),
            )
        } else {
            ("captured", Some(payload_json), None)
        };
        let now = crate::now_rfc3339();
        let inserted = connection.execute(
            "INSERT INTO recorder_activity_events(activity_id,source_kind,source_key,external_id,title,occurred_at,payload_digest,payload_json,payload_ref,state,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            rusqlite::params![activity_id, source_kind, stored_source_key, stored_external_id, stored_title, occurred_at, payload_digest, payload_json, payload_ref, state, now],
        );
        if inserted.is_err() {
            if secret_suspected {
                let _ = self
                    .state
                    .remove_quarantine(&self.state.quarantine_path(&activity_id));
            }
            return Err(SessionError::storage());
        }
        Ok(ActivityCaptureReceipt {
            activity_id,
            source_kind: source_kind.to_string(),
            external_id: receipt_external_id,
            state: state.to_string(),
            duplicate: false,
        })
    }

    fn set_git_source_cursor(&self, path: &str, cursor: &str) -> Result<(), SessionError> {
        let _lock = self.state.acquire_lock()?;
        let connection = self.state.connect()?;
        connection
            .execute(
                "UPDATE recorder_git_sources SET cursor=?2,last_error=NULL WHERE path=?1",
                rusqlite::params![path, cursor],
            )
            .map_err(|_| SessionError::storage())?;
        Ok(())
    }

    fn set_git_source_error(&self, path: &str, error: Option<&str>) -> Result<(), SessionError> {
        let _lock = self.state.acquire_lock()?;
        let connection = self.state.connect()?;
        connection
            .execute(
                "UPDATE recorder_git_sources SET last_error=?2 WHERE path=?1",
                rusqlite::params![path, error],
            )
            .map_err(|_| SessionError::storage())?;
        Ok(())
    }
}

fn bounded_string(
    value: Option<&Value>,
    field: &str,
    max_bytes: usize,
) -> Result<String, SessionError> {
    let value = value
        .and_then(Value::as_str)
        .ok_or_else(|| SessionError::invalid(format!("Codex hook {field} must be a string")))?;
    if value.len() > max_bytes {
        return Err(SessionError::invalid(format!(
            "Codex hook {field} exceeds its size limit"
        )));
    }
    Ok(value.to_string())
}

fn optional_bounded_string(
    value: Option<&Value>,
    field: &str,
    max_bytes: usize,
) -> Result<Option<String>, SessionError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(value) => bounded_string(Some(value), field, max_bytes).map(Some),
    }
}

fn get_git_source(
    connection: &rusqlite::Connection,
    path: &str,
) -> Result<Option<GitSourceRegistration>, SessionError> {
    connection
        .query_row(
            "SELECT path,enabled,last_error,created_at,cursor FROM recorder_git_sources WHERE path=?1",
            [path],
            |row| {
                Ok(GitSourceRegistration {
                    path: row.get(0)?,
                    enabled: row.get::<_, i64>(1)? != 0,
                    last_error: row.get(2)?,
                    created_at: row.get(3)?,
                    cursor: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|_| SessionError::storage())
}

fn git_repository_root(path: &Path) -> Result<PathBuf, SessionError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .map_err(|_| SessionError::invalid("could not run Git for the selected path"))?;
    if !output.status.success() {
        return Err(SessionError::invalid(
            "selected path is not a Git repository",
        ));
    }
    let root = String::from_utf8(output.stdout)
        .map_err(|_| SessionError::invalid("Git repository path is not UTF-8"))?;
    PathBuf::from(root.trim())
        .canonicalize()
        .map_err(|_| SessionError::invalid("Git repository path is unavailable"))
}

fn read_git_commits(
    repository: &Path,
    cursor: Option<&str>,
    limit: usize,
) -> Result<Vec<GitCommit>, SessionError> {
    let head = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args(["rev-parse", "--verify", "--quiet", "HEAD"])
        .output()
        .map_err(|_| SessionError::invalid("could not read Git history"))?;
    if !head.status.success() {
        return Ok(Vec::new());
    }
    let cursor = match cursor {
        Some(cursor) if is_git_ancestor(repository, cursor)? => Some(cursor),
        _ => None,
    };
    let mut list = Command::new("git");
    list.arg("-C")
        .arg(repository)
        .args(["rev-list", "--topo-order", "--reverse"]);
    if let Some(cursor) = cursor {
        list.arg(format!("{cursor}..HEAD"));
    } else {
        list.arg("HEAD");
    }
    let output = list
        .output()
        .map_err(|_| SessionError::invalid("could not read Git history"))?;
    if !output.status.success() {
        return Err(SessionError::invalid("Git history scan failed"));
    }
    if output.stdout.len() > MAX_GIT_OUTPUT_BYTES {
        return Err(SessionError::invalid("Git history output exceeds 64 MiB"));
    }
    let ids = String::from_utf8(output.stdout)
        .map_err(|_| SessionError::invalid("Git history contains invalid UTF-8"))?
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(limit)
        .map(str::to_string)
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut log = Command::new("git");
    log.arg("-C")
        .arg(repository)
        .args([
            "log",
            "--format=%H%x00%aI%x00%an%x00%s%x00",
            "--no-walk=unsorted",
        ])
        .args(&ids);
    let output = log
        .output()
        .map_err(|_| SessionError::invalid("could not read Git commit metadata"))?;
    if !output.status.success() || output.stdout.len() > MAX_GIT_OUTPUT_BYTES {
        return Err(SessionError::invalid(
            "Git commit metadata scan failed or exceeded 64 MiB",
        ));
    }
    let fields = String::from_utf8_lossy(&output.stdout);
    let values = fields.split('\0').collect::<Vec<_>>();
    let mut commits = Vec::new();
    for row in values.as_chunks::<4>().0 {
        let hash = row[0].trim();
        if hash.is_empty() {
            continue;
        }
        commits.push(GitCommit {
            hash: hash.to_string(),
            authored_at: row[1].trim().to_string(),
            author: row[2].trim().to_string(),
            subject: row[3].trim().to_string(),
        });
    }
    Ok(commits)
}

fn is_git_ancestor(repository: &Path, commit: &str) -> Result<bool, SessionError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args(["merge-base", "--is-ancestor", commit, "HEAD"])
        .output()
        .map_err(|_| SessionError::invalid("could not verify Git scan cursor"))?;
    if output.status.success() {
        return Ok(true);
    }
    if output.status.code() == Some(1) {
        return Ok(false);
    }
    Ok(false)
}

fn changed_paths(
    repository: &Path,
    commit: &str,
) -> Result<(Vec<String>, bool, usize), SessionError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args([
            "diff-tree",
            "--root",
            "--no-commit-id",
            "--name-only",
            "-r",
            "-z",
            commit,
        ])
        .output()
        .map_err(|_| SessionError::invalid("could not read Git changed paths"))?;
    if !output.status.success() || output.stdout.len() > MAX_GIT_OUTPUT_BYTES {
        return Err(SessionError::invalid(
            "Git changed-path scan failed or exceeded 64 MiB",
        ));
    }
    let entries = output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
        .collect::<Vec<_>>();
    let mut paths = Vec::new();
    let mut omitted = 0;
    for entry in entries {
        if paths.len() == MAX_CHANGED_PATHS || entry.len() > MAX_PATH_BYTES {
            omitted += 1;
        } else {
            paths.push(String::from_utf8_lossy(entry).into_owned());
        }
    }
    Ok((paths, omitted > 0, omitted))
}

fn bounded_field(value: &str, max_bytes: usize) -> (String, bool) {
    if value.len() <= max_bytes {
        return (value.to_string(), false);
    }
    let boundary = value
        .char_indices()
        .map(|(index, _)| index)
        .take_while(|index| *index <= max_bytes)
        .last()
        .unwrap_or(0);
    (value[..boundary].to_string(), true)
}

fn codex_hooks_path() -> Result<PathBuf, SessionError> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| SessionError::invalid("could not locate the user's home directory"))?;
    Ok(home.join(".codex").join("hooks.json"))
}

fn codex_hook_command(cli_path: &Path, vault_path: &Path) -> Result<String, SessionError> {
    let cli = cli_path
        .canonicalize()
        .map_err(|_| SessionError::invalid("Oximemo CLI binary is unavailable"))?;
    let vault = vault_path
        .canonicalize()
        .map_err(|_| SessionError::invalid("active Oximemo vault is unavailable"))?;
    if !cli.is_file() || !vault.is_dir() {
        return Err(SessionError::invalid(
            "Oximemo CLI or vault path is invalid",
        ));
    }
    Ok(format!(
        "{} --vault {} session activity codex-hook",
        shell_quote(&cli.to_string_lossy()),
        shell_quote(&vault.to_string_lossy())
    ))
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn codex_hooks_file_contains(path: &Path, command: &str) -> Result<bool, SessionError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err(SessionError::storage()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(SessionError::external_change(
            "Codex hooks path is not a regular file",
        ));
    }
    let bytes = fs::read(path).map_err(|_| SessionError::storage())?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err(SessionError::invalid("Codex hooks file exceeds 4 MiB"));
    }
    let root: Value = serde_json::from_slice(&bytes)
        .map_err(|_| SessionError::invalid("Codex hooks file is not valid JSON"))?;
    Ok(contains_hook_command(&root, command))
}

fn hook_registered(path: &Path, command: &str) -> Result<bool, SessionError> {
    codex_hooks_file_contains(path, command)
}

fn contains_hook_command(root: &Value, command: &str) -> bool {
    root.pointer("/hooks/SessionEnd")
        .and_then(Value::as_array)
        .is_some_and(|groups| {
            groups.iter().any(|group| {
                group
                    .get("hooks")
                    .and_then(Value::as_array)
                    .is_some_and(|hooks| {
                        hooks.iter().any(|hook| {
                            hook.get("command").and_then(Value::as_str) == Some(command)
                        })
                    })
            })
        })
}

fn mutate_codex_hooks(path: &Path, command: &str, install: bool) -> Result<(), SessionError> {
    let parent = path
        .parent()
        .ok_or_else(|| SessionError::invalid("Codex hooks file has no parent directory"))?;
    fs::create_dir_all(parent).map_err(|_| SessionError::storage())?;
    let original = match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(SessionError::external_change(
                    "Codex hooks path is not a regular file",
                ));
            }
            let bytes = fs::read(path).map_err(|_| SessionError::storage())?;
            if bytes.len() > 4 * 1024 * 1024 {
                return Err(SessionError::invalid("Codex hooks file exceeds 4 MiB"));
            }
            Some(bytes)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err(SessionError::storage()),
    };
    let mut root = match &original {
        Some(bytes) => serde_json::from_slice::<Value>(bytes)
            .map_err(|_| SessionError::invalid("Codex hooks file is not valid JSON"))?,
        None => json!({}),
    };
    let root_object = root
        .as_object_mut()
        .ok_or_else(|| SessionError::invalid("Codex hooks file root must be an object"))?;
    let hooks = root_object.entry("hooks").or_insert_with(|| json!({}));
    let hooks_object = hooks
        .as_object_mut()
        .ok_or_else(|| SessionError::invalid("Codex hooks field must be an object"))?;
    let session_end = hooks_object
        .entry("SessionEnd")
        .or_insert_with(|| json!([]));
    let groups = session_end
        .as_array_mut()
        .ok_or_else(|| SessionError::invalid("Codex SessionEnd hooks must be an array"))?;
    let already_registered = groups.iter().any(|group| {
        group
            .get("hooks")
            .and_then(Value::as_array)
            .is_some_and(|items| {
                items
                    .iter()
                    .any(|item| item.get("command").and_then(Value::as_str) == Some(command))
            })
    });
    if install {
        if already_registered {
            return Ok(());
        }
        groups.push(json!({
            "hooks": [{
                "type": "command",
                "command": command,
                "timeout": 3,
                "statusMessage": "Saving Oximemo session metadata"
            }]
        }));
    } else {
        if !already_registered {
            return Ok(());
        }
        for group in groups.iter_mut() {
            if let Some(items) = group.get_mut("hooks").and_then(Value::as_array_mut) {
                items.retain(|item| item.get("command").and_then(Value::as_str) != Some(command));
            }
        }
    }
    if let Some(expected) = &original {
        backup_codex_hooks_once(path, expected)?;
        let current = fs::read(path).map_err(|_| SessionError::storage())?;
        if &current != expected {
            return Err(SessionError::external_change(
                "Codex hooks changed during Oximemo's update",
            ));
        }
    } else if path.exists() {
        return Err(SessionError::external_change(
            "Codex hooks appeared during Oximemo's update",
        ));
    }
    let mut bytes = serde_json::to_vec_pretty(&root).map_err(|_| SessionError::storage())?;
    bytes.push(b'\n');
    atomic_write_json(path, &bytes, original.as_deref())
}

fn backup_codex_hooks_once(path: &Path, original: &[u8]) -> Result<(), SessionError> {
    let backup = path.with_extension("json.oximemo.bak");
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(&backup) {
        Ok(mut file) => {
            file.write_all(original)
                .map_err(|_| SessionError::storage())?;
            file.sync_all().map_err(|_| SessionError::storage())?;
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(_) => Err(SessionError::storage()),
    }
}

fn atomic_write_json(
    path: &Path,
    bytes: &[u8],
    original: Option<&[u8]>,
) -> Result<(), SessionError> {
    let parent = path
        .parent()
        .ok_or_else(|| SessionError::invalid("Codex hooks file has no parent directory"))?;
    let temporary = parent.join(format!(".hooks.json.oximemo-{}.tmp", Uuid::now_v7()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| -> Result<(), SessionError> {
        let mut file = options
            .open(&temporary)
            .map_err(|_| SessionError::storage())?;
        file.write_all(bytes).map_err(|_| SessionError::storage())?;
        file.sync_all().map_err(|_| SessionError::storage())?;
        if let Some(original) = original {
            if let Ok(metadata) = fs::metadata(path) {
                fs::set_permissions(&temporary, metadata.permissions())
                    .map_err(|_| SessionError::storage())?;
            }
            let current = fs::read(path).map_err(|_| SessionError::storage())?;
            if current != original {
                return Err(SessionError::external_change(
                    "Codex hooks changed before Oximemo could save",
                ));
            }
        } else if path.exists() {
            return Err(SessionError::external_change(
                "Codex hooks appeared before Oximemo could save",
            ));
        }
        fs::rename(&temporary, path).map_err(|_| SessionError::storage())?;
        if let Ok(directory) = OpenOptions::new().read(true).open(parent) {
            let _ = directory.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;
    use tempfile::TempDir;

    fn test_recorder() -> (SessionRecorder, TempDir, TempDir) {
        let vault = tempfile::tempdir().unwrap();
        let state_root = tempfile::tempdir().unwrap();
        let paths = oximemo_core::Paths {
            vault: vault.path().join("vault"),
            index_dir: vault.path().join("index"),
        };
        fs::create_dir_all(&paths.vault).unwrap();
        let recorder = SessionRecorder::from_state_root(
            paths,
            crate::ProviderConfig::default(),
            state_root.path().join("recorder"),
        )
        .unwrap();
        (recorder, vault, state_root)
    }

    fn git(repo: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn commit(repo: &Path, name: &str, content: &str, subject: &str) {
        fs::write(repo.join(name), content).unwrap();
        git(repo, &["add", name]);
        git(
            repo,
            &[
                "-c",
                "user.name=Test Author",
                "-c",
                "user.email=test@example.test",
                "commit",
                "-m",
                subject,
            ],
        );
    }

    #[test]
    fn codex_hook_captures_metadata_idempotently_without_reading_transcript() {
        let (recorder, _vault, _state) = test_recorder();
        let missing =
            std::env::temp_dir().join(format!("nonexistent-oximemo-transcript-{}", Uuid::now_v7()));
        let input = json!({
            "hook_event_name":"SessionEnd",
            "session_id":"codex-session-1",
            "cwd":"/tmp/project",
            "transcript_path":missing.to_string_lossy(),
            "reason":"completed"
        });
        let bytes = serde_json::to_vec(&input).unwrap();
        let first = recorder.capture_codex_hook_json(&bytes).unwrap();
        let duplicate = recorder.capture_codex_hook_json(&bytes).unwrap();
        assert!(!first.duplicate);
        assert!(duplicate.duplicate);
        assert_eq!(first.activity_id, duplicate.activity_id);
        assert!(!missing.exists());
        let events = recorder.list_activity_events(10).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].source_kind, "codex_session");
        assert_eq!(
            events[0].metadata.as_ref().unwrap()["transcript_path"],
            missing.to_string_lossy().as_ref()
        );
    }

    #[test]
    fn codex_hook_installer_preserves_unrelated_entries_and_removes_only_oximemo() {
        let root = tempfile::tempdir().unwrap();
        let hooks = root.path().join(".codex/hooks.json");
        fs::create_dir_all(hooks.parent().unwrap()).unwrap();
        fs::write(&hooks, br#"{"other":true,"hooks":{"SessionEnd":[{"hooks":[{"type":"command","command":"other"}]}]}}"#).unwrap();
        let cli = root.path().join("oximemo");
        fs::write(&cli, b"binary fixture").unwrap();
        let vault = root.path().join("vault");
        fs::create_dir_all(&vault).unwrap();
        let command = codex_hook_command(&cli, &vault).unwrap();
        mutate_codex_hooks(&hooks, &command, true).unwrap();
        let mut installed: Value = serde_json::from_slice(&fs::read(&hooks).unwrap()).unwrap();
        assert_eq!(installed["other"], true);
        assert!(contains_hook_command(&installed, &command));
        assert!(hooks.with_extension("json.oximemo.bak").exists());
        let groups = installed
            .pointer_mut("/hooks/SessionEnd")
            .unwrap()
            .as_array_mut()
            .unwrap();
        let oximemo_group = groups.pop().unwrap();
        groups[0]["hooks"]
            .as_array_mut()
            .unwrap()
            .push(oximemo_group["hooks"][0].clone());
        fs::write(&hooks, serde_json::to_vec(&installed).unwrap()).unwrap();
        mutate_codex_hooks(&hooks, &command, false).unwrap();
        let removed: Value = serde_json::from_slice(&fs::read(&hooks).unwrap()).unwrap();
        assert_eq!(removed["other"], true);
        assert!(!contains_hook_command(&removed, &command));
        let remaining_hooks = removed.pointer("/hooks/SessionEnd/0/hooks").unwrap();
        assert_eq!(remaining_hooks.as_array().unwrap().len(), 1);
        assert_eq!(remaining_hooks[0]["command"], "other");
    }

    #[test]
    fn git_scanner_captures_only_commit_metadata_and_advances_idempotently() {
        let (recorder, vault, _state) = test_recorder();
        let repo = vault.path().join("repository");
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        let source = recorder.register_git_source(&repo).unwrap();
        let empty = recorder
            .run_with_consent(10, false, false, true)
            .unwrap()
            .git_scan
            .unwrap();
        assert_eq!(empty.scanned, 0);
        assert_eq!(empty.failed, 0);
        commit(
            &repo,
            "source.rs",
            "private code body must not be collected",
            "initial commit",
        );
        let first = recorder
            .run_with_consent(10, false, false, true)
            .unwrap()
            .git_scan
            .unwrap();
        assert_eq!(first.scanned, 1);
        assert_eq!(first.captured, 1);
        assert_eq!(recorder.list_git_sources().unwrap()[0].path, source.path);
        let duplicate = recorder
            .run_with_consent(10, false, false, true)
            .unwrap()
            .git_scan
            .unwrap();
        assert_eq!(duplicate.scanned, 0);
        assert_eq!(duplicate.captured, 0);
        let events = recorder.list_activity_events(10).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].source_kind, "git_commit");
        assert_eq!(events[0].title, "initial commit");
        let metadata = events[0].metadata.as_ref().unwrap();
        assert_eq!(metadata["changed_paths"][0], "source.rs");
        assert!(!metadata.to_string().contains("private code body"));
    }

    #[test]
    fn git_metadata_with_secret_is_quarantined_and_discardable() {
        let (recorder, vault, _state) = test_recorder();
        let repo = vault.path().join("repository");
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        commit(&repo, "safe.txt", "body", "api_key=abcdefgh1234");
        recorder.register_git_source(&repo).unwrap();
        assert_eq!(
            recorder.scan_registered_git_sources(10).unwrap().captured,
            1
        );
        let events = recorder.list_activity_events(10).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].state, "quarantined");
        assert!(events[0].metadata.is_none());
        assert_eq!(events[0].external_id, "[redacted]");
        assert!(events[0].source_key.starts_with("quarantined:"));
        assert!(!events[0].title.contains("api_key"));
        recorder
            .discard_activity_event(&events[0].activity_id)
            .unwrap();
        assert!(recorder.list_activity_events(10).unwrap().is_empty());
    }

    #[test]
    fn git_source_enable_and_remove_resolve_to_registered_toplevel() {
        let (recorder, vault, _state) = test_recorder();
        let repo = vault.path().join("repository");
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        commit(&repo, "safe.txt", "body", "initial commit");
        fs::create_dir_all(repo.join("nested/deeper")).unwrap();

        let registered = recorder
            .register_git_source(&repo.join("nested/deeper"))
            .unwrap();
        assert_eq!(
            registered.path,
            repo.canonicalize().unwrap().to_string_lossy()
        );

        // Enabling through an unrelated alias inside the repo still resolves
        // to the registered toplevel instead of inserting a duplicate row.
        let enabled = recorder
            .set_git_source_enabled(&repo.join("nested"), false)
            .unwrap();
        assert!(!enabled.enabled);
        assert_eq!(recorder.list_git_sources().unwrap().len(), 1);
        let enabled = recorder
            .set_git_source_enabled(&repo.join("nested/deeper"), true)
            .unwrap();
        assert!(enabled.enabled);

        // Removal through any in-repo path resolves and reports the removal.
        assert!(recorder.remove_git_source(&repo.join("nested")).unwrap());
        assert!(recorder.list_git_sources().unwrap().is_empty());

        // A path that is not inside a Git repository fails visibly instead of
        // silently returning removed=false.
        let outside = vault.path().join("not-a-repo");
        fs::create_dir_all(&outside).unwrap();
        assert!(recorder.remove_git_source(&outside).is_err());
    }
}
