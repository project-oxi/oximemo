//! `oxi-frontmatter` — oxi ecosystem frontmatter contract crate.
//!
//! Defines the canonical file-format contract for vault notes shared by
//! `oximemo`, `oxibrain`, and `oxios`. The crate exposes a parsing
//! entry point plus the canonical emitter + merge-write API used by the
//! ecosystem's writer side (Tasks 2, 3, 4, 11, 12, 19).
//!
//! The crate is dependency-light (uuid v7, time 0.3, indexmap 2,
//! thiserror 2).
//!
//! See [`SPEC.md`](../SPEC.md) for the normative grammar.

#![deny(missing_docs)]
mod emit;
mod parse;
mod write;

pub use emit::emit;
pub use parse::{NoteFormat, ParseError, Parsed, Table, Value, parse};
pub use write::{
    FrontmatterError, Mutation, Synthesize, WriteOutcome, atomic_write, write_document,
};
