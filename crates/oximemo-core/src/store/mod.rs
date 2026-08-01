//! Storage layer: source-of-truth files plus derived indexes.

pub mod files;
pub mod index;
pub mod search;

pub use files::{FileStore, ParsedFile};
pub use index::{IndexRecord, RedbIndex};
pub use search::TantivySearch;
