//! oxinot-core: the pure-Rust heart of oxinot.
//!
//! This crate owns the file store (source of truth), the derived metadata and
//! search indexes, file-watching, and synchronization. It knows nothing about
//! Tauri or clap; the desktop app and the CLI are thin adapters over the
//! [`vault::Vault`] facade.

// `CoreError` carries redb's large error enums inline (160B Result variant).
// Harmless for oxinot's workload; silence the pedantic lint rather than box
// every redb variant.
#![allow(clippy::result_large_err)]

pub mod config;
pub mod error;
pub mod hash;
pub mod note;
pub mod paths;

pub mod lock;
pub mod store;
pub mod sync;
pub mod vault;
pub mod watcher;

pub use config::{Theme, VaultConfig};
pub use error::{CoreError, Result};
pub use note::{
    Cursor, IndexStats, Note, NoteColor, NoteFilter, NoteHash, NoteId, NoteStats, NoteSummary,
    Page,
};
pub use paths::Paths;
pub use vault::{DoctorReport, Vault};
