use crate::error::SessionError;
use crate::export::{MAX_INPUT_BYTES, digest, parse_export};
use crate::{ImportReceipt, SessionRecorder};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use uuid::Uuid;

const EXPORT_SUFFIX: &str = ".cassette-session.json";
const MAX_SOURCE_EXPORTS: usize = 500;
const MAX_DIRECTORY_ENTRIES: usize = 10_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SourceRegistration {
    pub id: String,
    pub path: String,
    pub enabled: bool,
    pub last_error: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SourceScanItem {
    pub file_name: String,
    pub state: String,
    pub import: Option<ImportReceipt>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SourceScanReport {
    pub scanned: usize,
    pub imported: usize,
    pub duplicates: usize,
    pub failed: usize,
    pub items: Vec<SourceScanItem>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SourcePreviewItem {
    pub source_id: String,
    pub file_name: String,
    pub source_digest: Option<String>,
    pub state: String,
    pub source_kind: Option<String>,
    pub external_id: Option<String>,
    pub title: Option<String>,
    pub source_revision: Option<String>,
    pub message_count: Option<usize>,
    pub import_state: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SourcePreviewSelection {
    pub source_id: String,
    pub file_name: String,
    pub source_digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SourcePreviewReport {
    pub scanned: usize,
    pub ready: usize,
    pub duplicates: usize,
    pub unchanged: usize,
    pub conflicts: usize,
    pub failed: usize,
    pub items: Vec<SourcePreviewItem>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SourceCollectionReport {
    pub preview: SourcePreviewReport,
    pub import: SourceScanReport,
}

impl SessionRecorder {
    /// Import one user-selected export file. Symlinks and non-regular files are
    /// rejected; only the exact Cassette export suffix is accepted.
    pub fn import_export_file(&self, path: &Path) -> Result<ImportReceipt, SessionError> {
        if !path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(EXPORT_SUFFIX))
        {
            return Err(SessionError::invalid(
                "selected file must end with .cassette-session.json",
            ));
        }
        let bytes = read_bounded_regular_file(path)?;
        self.import_export_bytes(&bytes)
    }
    pub fn apply_quarantine_file(
        &self,
        session_id: &str,
        path: &Path,
    ) -> Result<ImportReceipt, SessionError> {
        if !path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(EXPORT_SUFFIX))
        {
            return Err(SessionError::invalid(
                "selected file must end with .cassette-session.json",
            ));
        }
        let bytes = read_bounded_regular_file(path)?;
        self.apply_quarantine(session_id, &bytes)
    }

    /// Register a directory chosen by the user. Scans are non-recursive and
    /// never infer a default path or inspect private application storage.
    pub fn register_source_dir(
        &self,
        path: &Path,
        enabled: bool,
    ) -> Result<SourceRegistration, SessionError> {
        let canonical = validate_source_dir(path)?;
        let _lock = self.state.acquire_lock()?;
        let connection = self.state.connect()?;
        let canonical_str = canonical.to_string_lossy().into_owned();
        let id = Uuid::new_v5(&Uuid::NAMESPACE_URL, canonical_str.as_bytes()).to_string();
        let now = crate::now_rfc3339();
        connection
            .execute(
                "INSERT INTO recorder_sources(id,path,enabled,created_at) VALUES(?1,?2,?3,?4) ON CONFLICT(path) DO UPDATE SET enabled=excluded.enabled,last_error=NULL",
                params![id, canonical_str, enabled as i64, now],
            )
            .map_err(|_| SessionError::storage())?;
        get_source(&connection, &canonical_str)?.ok_or_else(SessionError::storage)
    }

    pub fn set_source_enabled(
        &self,
        source_id: &str,
        enabled: bool,
    ) -> Result<SourceRegistration, SessionError> {
        let _lock = self.state.acquire_lock()?;
        let connection = self.state.connect()?;
        let changed = connection
            .execute(
                "UPDATE recorder_sources SET enabled=?2,last_error=NULL WHERE id=?1",
                params![source_id, enabled as i64],
            )
            .map_err(|_| SessionError::storage())?;
        if changed == 0 {
            return Err(SessionError::not_found(
                "registered source directory not found",
            ));
        }
        get_source_by_id(&connection, source_id)?.ok_or_else(SessionError::storage)
    }

    pub fn remove_source(&self, source_id: &str) -> Result<bool, SessionError> {
        let _lock = self.state.acquire_lock()?;
        let mut connection = self.state.connect()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| SessionError::storage())?;
        transaction
            .execute(
                "DELETE FROM recorder_scan_seen WHERE source_id=?1",
                [source_id],
            )
            .map_err(|_| SessionError::storage())?;
        let removed = transaction
            .execute("DELETE FROM recorder_sources WHERE id=?1", [source_id])
            .map_err(|_| SessionError::storage())?;
        transaction.commit().map_err(|_| SessionError::storage())?;
        Ok(removed > 0)
    }

    pub fn list_sources(&self) -> Result<Vec<SourceRegistration>, SessionError> {
        let connection = self.state.connect()?;
        let mut statement = connection
            .prepare(
                "SELECT id,path,enabled,last_error,created_at FROM recorder_sources ORDER BY path",
            )
            .map_err(|_| SessionError::storage())?;
        let rows = statement
            .query_map([], |row| {
                Ok(SourceRegistration {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    enabled: row.get::<_, i64>(2)? != 0,
                    last_error: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })
            .map_err(|_| SessionError::storage())?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| SessionError::storage())
    }

    /// Inspect explicitly registered folders without importing or changing any
    /// recorder state. Only immediate, non-hidden export files are considered.
    pub fn preview_registered_sources(&self) -> Result<SourcePreviewReport, SessionError> {
        let sources = self.list_sources()?;
        let mut report = SourcePreviewReport {
            scanned: 0,
            ready: 0,
            duplicates: 0,
            unchanged: 0,
            conflicts: 0,
            failed: 0,
            items: Vec::new(),
        };

        for source in sources.into_iter().filter(|source| source.enabled) {
            let root = PathBuf::from(&source.path);
            if validate_registered_dir(&root).is_err() {
                report.failed += 1;
                report.items.push(preview_failure(
                    &source.id,
                    "<source directory>",
                    "invalid_source",
                    "registered directory changed",
                ));
                continue;
            }
            let files = match immediate_export_files(&root) {
                Ok(files) => files,
                Err(error) => {
                    report.failed += 1;
                    report.items.push(preview_failure(
                        &source.id,
                        "<source directory>",
                        "failed",
                        &error.to_string(),
                    ));
                    continue;
                }
            };
            if report.scanned.saturating_add(files.len()) > MAX_SOURCE_EXPORTS {
                report.failed += 1;
                report.items.push(preview_failure(
                    &source.id,
                    "<source directory>",
                    "failed",
                    "registered folders exceed the 500 export preview limit",
                ));
                break;
            }
            for path in files {
                report.scanned += 1;
                let item = preview_source_file(&self.state, &source.id, &root, &path);
                let item = match item {
                    Ok(item) => item,
                    Err(error) => {
                        let file_name = path
                            .file_name()
                            .and_then(|name| name.to_str())
                            .unwrap_or("<invalid filename>");
                        preview_failure(&source.id, file_name, "failed", &error.to_string())
                    }
                };
                match item.state.as_str() {
                    "ready" => report.ready += 1,
                    "duplicate" => report.duplicates += 1,
                    "unchanged" => report.unchanged += 1,
                    "conflict" => report.conflicts += 1,
                    _ => report.failed += 1,
                }
                report.items.push(item);
            }
        }
        Ok(report)
    }

    /// Import only candidates supplied by a report-only preview. Each file is
    /// re-read and its raw digest is checked before import.
    pub fn import_source_preview(
        &self,
        selections: &[SourcePreviewSelection],
    ) -> Result<SourceScanReport, SessionError> {
        if selections.len() > MAX_SOURCE_EXPORTS {
            return Err(SessionError::invalid(
                "source preview import exceeds the 500 file limit",
            ));
        }
        let sources = self
            .list_sources()?
            .into_iter()
            .map(|source| (source.id.clone(), source))
            .collect::<HashMap<_, _>>();
        let mut report = SourceScanReport {
            scanned: 0,
            imported: 0,
            duplicates: 0,
            failed: 0,
            items: Vec::with_capacity(selections.len()),
        };
        let mut seen = HashSet::with_capacity(selections.len());

        for selection in selections {
            report.scanned += 1;
            let identity = (selection.source_id.clone(), selection.file_name.clone());
            let failure = |error: &str| SourceScanItem {
                file_name: selection.file_name.clone(),
                state: "failed".into(),
                import: None,
                error: Some(error.to_string()),
            };
            if !seen.insert(identity) {
                report.failed += 1;
                report
                    .items
                    .push(failure("duplicate file in preview selection"));
                continue;
            }
            let Some(source) = sources.get(&selection.source_id) else {
                report.failed += 1;
                report
                    .items
                    .push(failure("registered source no longer exists"));
                continue;
            };
            if !source.enabled {
                report.failed += 1;
                report.items.push(failure("registered source is disabled"));
                continue;
            }
            if !valid_leaf_export_name(&selection.file_name) {
                report.failed += 1;
                report.items.push(failure("invalid export filename"));
                continue;
            }
            let root = PathBuf::from(&source.path);
            if validate_registered_dir(&root).is_err() {
                self.set_source_error(&source.id, Some("registered directory changed"))?;
                report.failed += 1;
                report.items.push(failure("registered directory changed"));
                continue;
            }
            let path = root.join(&selection.file_name);
            let bytes = match read_immediate_source_file(&root, &path) {
                Ok(bytes) => bytes,
                Err(error) => {
                    let message = error.to_string();
                    self.set_source_error(&source.id, Some(&message))?;
                    report.failed += 1;
                    report.items.push(failure(&message));
                    continue;
                }
            };
            let source_digest = digest(&bytes);
            if source_digest != selection.source_digest {
                report.failed += 1;
                report.items.push(failure(
                    "export changed since preview; preview the folder again",
                ));
                continue;
            }
            match self.import_export_bytes(&bytes) {
                Ok(receipt) => {
                    if let Err(error) = mark_source_seen(
                        &self.state,
                        &source.id,
                        &selection.file_name,
                        &source_digest,
                    ) {
                        report.failed += 1;
                        report.items.push(failure(&error.to_string()));
                        continue;
                    }
                    self.set_source_error(&source.id, None)?;
                    if receipt.duplicate {
                        report.duplicates += 1;
                        report.items.push(SourceScanItem {
                            file_name: selection.file_name.clone(),
                            state: "duplicate".into(),
                            import: Some(receipt),
                            error: None,
                        });
                    } else {
                        report.imported += 1;
                        report.items.push(SourceScanItem {
                            file_name: selection.file_name.clone(),
                            state: receipt.state.clone(),
                            import: Some(receipt),
                            error: None,
                        });
                    }
                }
                Err(error) => {
                    let message = error.to_string();
                    self.set_source_error(&source.id, Some(&message))?;
                    report.failed += 1;
                    report.items.push(failure(&message));
                }
            }
        }
        Ok(report)
    }
    /// Automatically import every currently ready item from explicitly
    /// registered folders, retaining the same path and digest checks as the
    /// user-confirmed preview flow.
    pub fn collect_registered_sources(&self) -> Result<SourceCollectionReport, SessionError> {
        let preview = self.preview_registered_sources()?;
        let selections = preview
            .items
            .iter()
            .filter(|item| item.state == "ready")
            .map(|item| {
                Ok(SourcePreviewSelection {
                    source_id: item.source_id.clone(),
                    file_name: item.file_name.clone(),
                    source_digest: item
                        .source_digest
                        .clone()
                        .ok_or_else(SessionError::storage)?,
                })
            })
            .collect::<Result<Vec<_>, SessionError>>()?;
        let import = self.import_source_preview(&selections)?;
        Ok(SourceCollectionReport { preview, import })
    }

    fn set_source_error(&self, source_id: &str, error: Option<&str>) -> Result<(), SessionError> {
        let _lock = self.state.acquire_lock()?;
        let connection = self.state.connect()?;
        connection
            .execute(
                "UPDATE recorder_sources SET last_error=?2 WHERE id=?1",
                params![
                    source_id,
                    error.map(|value| value.chars().take(240).collect::<String>())
                ],
            )
            .map_err(|_| SessionError::storage())?;
        Ok(())
    }
}

fn preview_source_file(
    state: &crate::state::State,
    source_id: &str,
    root: &Path,
    path: &Path,
) -> Result<SourcePreviewItem, SessionError> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| SessionError::invalid("export filename is not valid UTF-8"))?;
    let bytes = read_immediate_source_file(root, path)?;
    let source_digest = digest(&bytes);
    let validated = parse_export(&bytes)?;
    let connection = state.connect()?;
    let seen = connection
        .query_row(
            "SELECT digest FROM recorder_scan_seen WHERE source_id=?1 AND rel_path=?2",
            params![source_id, file_name],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|_| SessionError::storage())?;
    let mut item = SourcePreviewItem {
        source_id: source_id.to_string(),
        file_name: file_name.to_string(),
        source_digest: Some(source_digest.clone()),
        state: "ready".into(),
        source_kind: Some(validated.export.source_kind.clone()),
        external_id: Some(validated.export.session_id.clone()),
        title: Some(validated.export.title.clone()),
        source_revision: Some(validated.export.source_revision.clone()),
        message_count: Some(validated.export.messages.len()),
        import_state: Some(
            if validated.secret_suspected {
                "quarantined"
            } else if validated.export.complete {
                "queued"
            } else {
                "capture_only"
            }
            .into(),
        ),
        error: None,
    };
    if seen.as_deref() == Some(source_digest.as_str()) {
        item.state = "unchanged".into();
        return Ok(item);
    }
    if let Some((stored_digest,)) = connection
        .query_row(
            "SELECT payload_digest FROM recorder_sessions WHERE source_kind=?1 AND external_id=?2 AND source_revision=?3",
            params![
                validated.export.source_kind,
                validated.export.session_id,
                validated.export.source_revision,
            ],
            |row| Ok((row.get::<_, String>(0)?,)),
        )
        .optional()
        .map_err(|_| SessionError::storage())?
    {
        if stored_digest == validated.digest {
            item.state = "duplicate".into();
        } else {
            item.state = "conflict".into();
            item.error = Some("same source identity and revision have different content".into());
        }
    }
    Ok(item)
}

fn preview_failure(
    source_id: &str,
    file_name: &str,
    state: &str,
    error: &str,
) -> SourcePreviewItem {
    SourcePreviewItem {
        source_id: source_id.to_string(),
        file_name: file_name.to_string(),
        source_digest: None,
        state: state.to_string(),
        source_kind: None,
        external_id: None,
        title: None,
        source_revision: None,
        message_count: None,
        import_state: None,
        error: Some(error.chars().take(240).collect()),
    }
}

fn immediate_export_files(root: &Path) -> Result<Vec<PathBuf>, SessionError> {
    let entries = fs::read_dir(root)
        .map_err(|_| SessionError::invalid("registered directory is inaccessible"))?;
    let mut files = Vec::new();
    for (index, entry) in entries.enumerate() {
        if index >= MAX_DIRECTORY_ENTRIES {
            return Err(SessionError::invalid(
                "registered directory exceeds the 10000 entry scan limit",
            ));
        }
        let entry =
            entry.map_err(|_| SessionError::invalid("registered directory could not be read"))?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name.starts_with('.') || !name.ends_with(EXPORT_SUFFIX) {
            continue;
        }
        files.push(entry.path());
        if files.len() > MAX_SOURCE_EXPORTS {
            return Err(SessionError::invalid(
                "registered directory exceeds the 500 export preview limit",
            ));
        }
    }
    files.sort();
    Ok(files)
}

fn valid_leaf_export_name(file_name: &str) -> bool {
    let path = Path::new(file_name);
    path.components().count() == 1
        && path.file_name().and_then(|name| name.to_str()) == Some(file_name)
        && file_name.ends_with(EXPORT_SUFFIX)
        && !file_name.starts_with('.')
}

fn mark_source_seen(
    state: &crate::state::State,
    source_id: &str,
    file_name: &str,
    source_digest: &str,
) -> Result<(), SessionError> {
    let _lock = state.acquire_lock()?;
    let mut connection = state.connect()?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| SessionError::storage())?;
    transaction
        .execute(
            "INSERT INTO recorder_scan_seen(source_id,rel_path,digest,seen_at) VALUES(?1,?2,?3,?4) ON CONFLICT(source_id,rel_path) DO UPDATE SET digest=excluded.digest,seen_at=excluded.seen_at",
            params![source_id, file_name, source_digest, crate::now_rfc3339()],
        )
        .map_err(|_| SessionError::storage())?;
    transaction.commit().map_err(|_| SessionError::storage())
}

fn get_source(
    connection: &Connection,
    path: &str,
) -> Result<Option<SourceRegistration>, SessionError> {
    connection
        .query_row(
            "SELECT id,path,enabled,last_error,created_at FROM recorder_sources WHERE path=?1",
            [path],
            |row| {
                Ok(SourceRegistration {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    enabled: row.get::<_, i64>(2)? != 0,
                    last_error: row.get(3)?,
                    created_at: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|_| SessionError::storage())
}

fn get_source_by_id(
    connection: &Connection,
    id: &str,
) -> Result<Option<SourceRegistration>, SessionError> {
    connection
        .query_row(
            "SELECT id,path,enabled,last_error,created_at FROM recorder_sources WHERE id=?1",
            [id],
            |row| {
                Ok(SourceRegistration {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    enabled: row.get::<_, i64>(2)? != 0,
                    last_error: row.get(3)?,
                    created_at: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|_| SessionError::storage())
}

fn validate_source_dir(path: &Path) -> Result<PathBuf, SessionError> {
    if !path.is_absolute() {
        return Err(SessionError::invalid("source directory must be absolute"));
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| SessionError::not_found("source directory not found"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(SessionError::invalid(
            "source directory must not be a symlink",
        ));
    }
    let canonical = fs::canonicalize(path)
        .map_err(|_| SessionError::invalid("source directory is inaccessible"))?;
    let after = fs::symlink_metadata(&canonical)
        .map_err(|_| SessionError::invalid("source directory changed"))?;
    if !after.is_dir() || !same_file(&metadata, &after) {
        return Err(SessionError::external_change(
            "source directory changed during selection",
        ));
    }
    Ok(canonical)
}

fn validate_registered_dir(path: &Path) -> Result<(), SessionError> {
    let canonical = validate_source_dir(path)?;
    if canonical != path {
        return Err(SessionError::external_change(
            "registered directory changed",
        ));
    }
    Ok(())
}

fn read_bounded_regular_file(path: &Path) -> Result<Vec<u8>, SessionError> {
    let before = fs::symlink_metadata(path)
        .map_err(|_| SessionError::not_found("session export file not found"))?;
    if !before.is_file() || before.file_type().is_symlink() {
        return Err(SessionError::invalid(
            "session export must be a regular file",
        ));
    }
    if before.len() > MAX_INPUT_BYTES as u64 {
        return Err(SessionError::invalid(
            "session export exceeds the 4 MiB limit",
        ));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    nofollow_options(&mut options);
    let file = options
        .open(path)
        .map_err(|_| SessionError::external_change("session export changed during open"))?;
    let opened = file.metadata().map_err(|_| SessionError::storage())?;
    let after = fs::symlink_metadata(path)
        .map_err(|_| SessionError::external_change("session export changed during open"))?;
    if !opened.is_file() || !same_file(&before, &opened) || !same_file(&opened, &after) {
        return Err(SessionError::external_change(
            "session export changed during open",
        ));
    }
    let mut bytes = Vec::with_capacity((opened.len() as usize).min(MAX_INPUT_BYTES));
    file.take((MAX_INPUT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| SessionError::storage())?;
    if bytes.len() > MAX_INPUT_BYTES {
        return Err(SessionError::invalid(
            "session export exceeds the 4 MiB limit",
        ));
    }
    Ok(bytes)
}

fn read_immediate_source_file(root: &Path, path: &Path) -> Result<Vec<u8>, SessionError> {
    validate_registered_dir(root)?;
    if path.parent() != Some(root) {
        return Err(SessionError::invalid(
            "source export must be an immediate directory child",
        ));
    }
    read_bounded_regular_file(path)
}

fn nofollow_options(options: &mut OpenOptions) {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        use std::os::unix::fs::OpenOptionsExt;
        #[cfg(target_os = "macos")]
        options.custom_flags(0x0100 | 0x0004);
        #[cfg(target_os = "linux")]
        options.custom_flags(0x20000 | 0x0800);
    }
}

#[cfg(unix)]
fn same_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(not(unix))]
fn same_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.len() == right.len() && left.modified().ok() == right.modified().ok()
}
