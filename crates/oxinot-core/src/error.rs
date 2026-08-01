//! Error model for oxinot-core.
//!
//! Errors are split by the subsystem that produces them so callers can react
//! precisely (e.g. a watcher treats a [`CoreError::Frontmatter`] as "defer
//! parsing" rather than aborting).

use std::io;
use std::path::PathBuf;
use thiserror::Error;

pub type Result<T, E = CoreError> = std::result::Result<T, E>;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("io error: {0}")]
    Io(#[from] io::Error),

    #[error("toml error: {0}")]
    Toml(#[from] toml::de::Error),

    #[error("toml serialize error: {0}")]
    TomlSerialize(#[from] toml::ser::Error),

    #[error("redb error: {0}")]
    Redb(#[from] redb::Error),

    #[error("redb database error: {0}")]
    RedbDb(#[from] redb::DatabaseError),

    #[error("redb transaction error: {0}")]
    RedbTx(#[from] redb::TransactionError),

    #[error("redb storage error: {0}")]
    RedbStorage(#[from] redb::StorageError),

    #[error("redb table error: {0}")]
    RedbTable(#[from] redb::TableError),

    #[error("redb commit error: {0}")]
    RedbCommit(#[from] redb::CommitError),

    #[error("tantivy error: {0}")]
    Tantivy(#[from] tantivy::TantivyError),

    #[error("notify watcher error: {0}")]
    Notify(#[from] notify::Error),

    #[error("tantivy query parse error: {0}")]
    QueryParse(#[from] tantivy::query::QueryParserError),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("time parse error: {0}")]
    TimeParse(#[from] time::error::Parse),

    #[error("time format error: {0}")]
    TimeFormat(#[from] time::error::Format),

    #[error("uuid error: {0}")]
    Uuid(#[from] uuid::Error),

    #[error("memo not found: {0}")]
    NotFound(String),

    #[error("invalid memo id: {0}")]
    InvalidMemoId(String),

    /// A file existed but its frontmatter could not be parsed. The watcher and
    /// `doctor` treat this as recoverable; body-only content is still indexed.
    #[error("corrupt frontmatter in {path}: {reason}")]
    Frontmatter { path: PathBuf, reason: String },

    #[error("vault is not initialized at {0}")]
    NotInitialized(PathBuf),

    #[error("index lock held by another process (timed out after {0}s)")]
    LockTimeout(u64),

    #[error("ids option conflict: only one of --ids/--ids-file/--ids-stdin may be used")]
    IdsOptionConflict,

    #[error("image rejected: {0}")]
    AssetRejected(String),

    #[error("{0}")]
    Other(String),
}

impl CoreError {
    pub fn other(msg: impl Into<String>) -> Self {
        Self::Other(msg.into())
    }
}
