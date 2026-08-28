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
pub mod metadata;
pub mod migrate;
pub mod migrate_vault;
pub mod paths;
pub mod props;
pub mod schema;
pub mod tags;
pub mod tasks;
pub mod template;
pub mod wiki;

pub mod base;
pub mod expr;
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
pub use props::{
    NoteQuery, PropMutation, PropOp, PropPredicate, PropValue, QueryPage, SortSpec, aliases_of,
    parse_sort, parse_where, props_from_table, props_link_text,
};
pub use schema::{
    DEFAULT_KNOWLEDGE_FOLDER, FolderSchema, KNOWLEDGE_SCHEMA_TOML, KNOWLEDGE_TEMPLATE_MD,
    MergeKind, OnKind, PropType, PropertyDef, ReviewDef, TransitionRule, Violation, WorkspaceDef,
    apply_transitions, parse_schema, read_schema, validate,
};
pub use vault::{
    BacklinkInfo, DoctorReport, FolderCard, FolderInfo, FolderRecent, GraphData, GraphEdge,
    GraphNode, Vault, VaultStatus,
};
