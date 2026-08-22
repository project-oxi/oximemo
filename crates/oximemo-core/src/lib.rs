//! oximemo-core: the pure-Rust heart of oximemo.
//!
//! This crate owns the file store (source of truth), the derived metadata and
//! search indexes, file-watching, and synchronization. It knows nothing about
//! Tauri or clap; the desktop app and the CLI are thin adapters over the
//! [`vault::Vault`] facade.

// `CoreError` carries redb's large error enums inline (160B Result variant).
// Harmless for oximemo's workload; silence the pedantic lint rather than box
// every redb variant.
#![allow(clippy::result_large_err)]

pub mod assets;
pub mod brain;
pub mod config;
pub mod error;
pub mod hash;
pub mod html;
pub mod memo;
pub mod migrate;
pub mod migrate_vault;
pub mod paths;
pub mod tags;
pub mod template;
pub mod wiki;

pub mod lock;
pub mod store;
pub mod sync;
pub mod vault;
pub mod watcher;

pub use assets::{AssetInfo, AssetRef};
pub use config::{FolderDef, Theme, VaultConfig, ViewMode};
pub use error::{CoreError, Result};
pub use memo::{
    Cursor, Facets, IndexStats, Memo, MemoFilter, MemoHash, MemoId, MemoStats, MemoSummary,
    NoteFormat, Page, derive_title, note_title, preview_of, searchable_body, slugify, tags_of,
    timestamp_filename,
};
pub use migrate_vault::MigrationStatus;
pub use paths::Paths;
pub use vault::{
    BacklinkInfo, DoctorReport, FolderCard, FolderRecent, GraphData, GraphEdge, GraphNode, Vault,
    VaultStatus,
};
