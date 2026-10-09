use crate::error::SessionError;
use fs2::FileExt;
use oximemo_core::{Paths, paths::oxi_home};
use rusqlite::Connection;
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;
use uuid::Uuid;

const MAX_QUARANTINE_BYTES: usize = 4 * 1024 * 1024;
const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS recorder_policy(
  id INTEGER PRIMARY KEY CHECK(id=1),
  mode TEXT NOT NULL DEFAULT 'automatic',
  retention_days INTEGER,
  updated_at TEXT
);
INSERT OR IGNORE INTO recorder_policy(id, mode, retention_days) VALUES(1, 'automatic', NULL);
CREATE TABLE IF NOT EXISTS recorder_sources(
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recorder_sessions(
  session_id TEXT PRIMARY KEY,
  source_group TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  complete INTEGER NOT NULL,
  state TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  payload_digest TEXT NOT NULL,
  export_json TEXT,
  payload_ref TEXT,
  lease_until TEXT,
  lease_token TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  secret_suspected INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  UNIQUE(source_kind, external_id, source_revision)
);
CREATE TABLE IF NOT EXISTS recorder_records(
  record_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  path TEXT NOT NULL,
  intent TEXT NOT NULL,
  revision TEXT NOT NULL,
  status TEXT NOT NULL,
  stable_key TEXT UNIQUE,
  request_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recorder_record_sources(
  record_id TEXT NOT NULL REFERENCES recorder_records(record_id),
  session_id TEXT NOT NULL REFERENCES recorder_sessions(session_id),
  PRIMARY KEY(record_id, session_id)
);
CREATE TABLE IF NOT EXISTS recorder_revisions(
  record_id TEXT NOT NULL REFERENCES recorder_records(record_id),
  revision TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  source TEXT NOT NULL,
  source_ids TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY(record_id, revision)
);
CREATE TABLE IF NOT EXISTS recorder_receipts(
  request_key TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  candidate_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  meta TEXT NOT NULL,
  result_json TEXT
);
CREATE TABLE IF NOT EXISTS recorder_chunks(
  session_id TEXT NOT NULL REFERENCES recorder_sessions(session_id),
  chunk_index INTEGER NOT NULL,
  chunk_digest TEXT NOT NULL,
  result_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(session_id, chunk_index)
);
CREATE TABLE IF NOT EXISTS recorder_scan_seen(
  source_id TEXT NOT NULL REFERENCES recorder_sources(id),
  rel_path TEXT NOT NULL,
  digest TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY(source_id, rel_path)
);
CREATE TABLE IF NOT EXISTS recorder_git_sources(
  path TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_error TEXT,
  created_at TEXT NOT NULL,
  cursor TEXT
);
CREATE TABLE IF NOT EXISTS recorder_activity_events(
  activity_id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  source_key TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  payload_json TEXT,
  payload_ref TEXT,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(source_kind, source_key, external_id, payload_digest)
);
CREATE INDEX IF NOT EXISTS recorder_activity_recent
  ON recorder_activity_events(occurred_at DESC, created_at DESC);
"#;

#[derive(Debug, Clone)]
pub(crate) struct State {
    pub db_path: PathBuf,
    pub quarantine: PathBuf,
    lock_path: PathBuf,
    processing_lock_path: PathBuf,
}

impl State {
    pub fn new(paths: &Paths) -> Result<Self, SessionError> {
        let namespace = blake3::hash(paths.index_dir.to_string_lossy().as_bytes())
            .to_hex()
            .to_string();
        let root = oxi_home()
            .join("recorder")
            .join("by-vault")
            .join(&namespace[..16]);
        Self::from_root(root)
    }

    pub(crate) fn from_root(root: PathBuf) -> Result<Self, SessionError> {
        ensure_private_dir(&root)?;
        let quarantine = root.join("quarantine");
        ensure_private_dir(&quarantine)?;
        let state = Self {
            db_path: root.join("sessions.db"),
            lock_path: root.join("recorder.lock"),
            processing_lock_path: root.join("recorder-processing.lock"),
            quarantine,
        };
        state.connect()?;
        state.cleanup_orphaned_quarantine()?;
        Ok(state)
    }

    pub fn connect(&self) -> Result<Connection, SessionError> {
        ensure_regular_or_absent(&self.db_path)?;
        if !self.db_path.exists() {
            create_private_file(&self.db_path)?;
        }
        ensure_regular_or_absent(&self.db_path)?;
        let connection = Connection::open(&self.db_path).map_err(|_| SessionError::storage())?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|_| SessionError::storage())?;
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
            )
            .map_err(|_| SessionError::storage())?;
        connection
            .execute_batch(SCHEMA)
            .map_err(|_| SessionError::storage())?;
        set_private_file(&self.db_path)?;
        Ok(connection)
    }

    pub fn acquire_lock(&self) -> Result<File, SessionError> {
        let file = open_lock_file(&self.lock_path)?;
        file.lock_exclusive().map_err(|_| SessionError::storage())?;
        Ok(file)
    }

    pub fn try_processing_lock(&self) -> Result<File, SessionError> {
        let file = open_lock_file(&self.processing_lock_path)?;
        match file.try_lock_exclusive() {
            Ok(()) => Ok(file),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                Err(SessionError::busy())
            }
            Err(_) => Err(SessionError::storage()),
        }
    }

    pub fn quarantine_path(&self, session_id: &str) -> PathBuf {
        self.quarantine.join(format!("{session_id}.json"))
    }

    pub fn write_quarantine(
        &self,
        session_id: &str,
        bytes: &[u8],
    ) -> Result<PathBuf, SessionError> {
        if bytes.len() > MAX_QUARANTINE_BYTES || !valid_session_id(session_id) {
            return Err(SessionError::invalid("invalid quarantine payload"));
        }
        let path = self.quarantine_path(session_id);
        ensure_regular_or_absent(&path)?;
        let temporary = self
            .quarantine
            .join(format!(".{session_id}-{}.tmp", Uuid::now_v7()));
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
            fs::rename(&temporary, &path).map_err(|_| SessionError::storage())?;
            set_private_file(&path)?;
            sync_dir(&self.quarantine)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result?;
        Ok(path)
    }

    fn cleanup_orphaned_quarantine(&self) -> Result<(), SessionError> {
        let _lock = self.acquire_lock()?;
        let connection = self.connect()?;
        let referenced = {
            let mut statement = connection
                .prepare(
                    "SELECT payload_ref FROM recorder_sessions WHERE payload_ref IS NOT NULL UNION SELECT payload_ref FROM recorder_activity_events WHERE payload_ref IS NOT NULL",
                )
                .map_err(|_| SessionError::storage())?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|_| SessionError::storage())?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|_| SessionError::storage())?
                .into_iter()
                .map(PathBuf::from)
                .filter(|path| path.parent() == Some(self.quarantine.as_path()))
                .collect::<HashSet<_>>()
        };
        let entries = fs::read_dir(&self.quarantine).map_err(|_| SessionError::storage())?;
        let mut removed = false;
        for entry in entries {
            let entry = entry.map_err(|_| SessionError::storage())?;
            let file_type = entry.file_type().map_err(|_| SessionError::storage())?;
            if !file_type.is_file() || file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let orphan = (is_quarantine_file(name) && !referenced.contains(&path))
                || is_quarantine_temp(name);
            if orphan {
                fs::remove_file(path).map_err(|_| SessionError::storage())?;
                removed = true;
            }
        }
        if removed {
            sync_dir(&self.quarantine)?;
        }
        Ok(())
    }

    pub fn remove_quarantine(&self, path: &Path) -> Result<(), SessionError> {
        if path.parent() != Some(self.quarantine.as_path()) {
            return Err(SessionError::invalid("invalid quarantine reference"));
        }
        let metadata = fs::symlink_metadata(path)
            .map_err(|_| SessionError::not_found("quarantine item not found"))?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(SessionError::external_change(
                "quarantine file is not regular",
            ));
        }
        fs::remove_file(path).map_err(|_| SessionError::storage())?;
        sync_dir(&self.quarantine)
    }
}

fn ensure_private_dir(path: &Path) -> Result<(), SessionError> {
    fs::create_dir_all(path).map_err(|_| SessionError::storage())?;
    let metadata = fs::symlink_metadata(path).map_err(|_| SessionError::storage())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(SessionError::external_change(
            "recorder state directory is not a regular directory",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| SessionError::storage())?;
    }
    Ok(())
}

fn ensure_regular_or_absent(path: &Path) -> Result<(), SessionError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => Ok(()),
        Ok(_) => Err(SessionError::external_change(
            "recorder state file is not regular",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(SessionError::storage()),
    }
}

fn create_private_file(path: &Path) -> Result<(), SessionError> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(|_| SessionError::storage())?;
    set_private_file(path)
}

fn set_private_file(path: &Path) -> Result<(), SessionError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|_| SessionError::storage())?;
    }
    Ok(())
}

fn open_lock_file(path: &Path) -> Result<File, SessionError> {
    ensure_regular_or_absent(path)?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
        #[cfg(target_os = "macos")]
        options.custom_flags(0x0100);
        #[cfg(target_os = "linux")]
        options.custom_flags(0x20000);
    }
    let file = options.open(path).map_err(|_| SessionError::storage())?;
    let opened = file.metadata().map_err(|_| SessionError::storage())?;
    let current = fs::symlink_metadata(path).map_err(|_| SessionError::storage())?;
    if !opened.is_file() || current.file_type().is_symlink() || !same_file(&opened, &current) {
        return Err(SessionError::external_change("recorder lock file changed"));
    }
    set_private_file(path)?;
    Ok(file)
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

fn is_quarantine_file(name: &str) -> bool {
    name.strip_suffix(".json").is_some_and(is_canonical_uuid)
}

fn is_quarantine_temp(name: &str) -> bool {
    let Some(stem) = name
        .strip_prefix('.')
        .and_then(|name| name.strip_suffix(".tmp"))
    else {
        return false;
    };
    let (Some(session_id), Some(token)) = (stem.get(..36), stem.get(37..)) else {
        return false;
    };
    stem.len() == 73
        && stem.as_bytes().get(36) == Some(&b'-')
        && is_canonical_uuid(session_id)
        && is_canonical_uuid(token)
}

fn valid_session_id(value: &str) -> bool {
    is_canonical_uuid(value)
}

fn is_canonical_uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}

fn sync_dir(path: &Path) -> Result<(), SessionError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| SessionError::storage())
}
#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    #[test]
    fn quarantine_cleanup_removes_only_orphans_and_temp_files() {
        let root = tempfile::tempdir().unwrap();
        let state = State::from_root(root.path().join("recorder")).unwrap();
        let referenced_id = Uuid::now_v7().to_string();
        let referenced_path = state.quarantine_path(&referenced_id);
        fs::write(&referenced_path, b"referenced").unwrap();
        let orphan_path = state.quarantine_path(&Uuid::now_v7().to_string());
        fs::write(&orphan_path, b"orphan").unwrap();
        let temp_path = state
            .quarantine
            .join(format!(".{referenced_id}-{}.tmp", Uuid::now_v7()));
        fs::write(&temp_path, b"partial").unwrap();

        let connection = state.connect().unwrap();
        connection.execute(
            "INSERT INTO recorder_sessions(session_id,source_group,source_kind,external_id,title,occurred_at,source_revision,complete,state,message_count,payload_digest,payload_ref,created_at) VALUES(?1,?1,'test',?1,'title','2025-01-01T00:00:00Z','r1',0,'quarantined',0,'digest',?2,'2025-01-01T00:00:00Z')",
            params![referenced_id, referenced_path.to_string_lossy()],
        ).unwrap();
        drop(connection);

        state.cleanup_orphaned_quarantine().unwrap();

        assert!(referenced_path.exists());
        assert!(!orphan_path.exists());
        assert!(!temp_path.exists());
        assert!(!is_quarantine_temp(
            ".éééééééééééééééééé-00000000-0000-0000-0000-000000000000.tmp"
        ));
    }
}
