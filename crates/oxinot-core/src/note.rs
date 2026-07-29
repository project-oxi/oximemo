//! Domain model: notes, identifiers, colors, pagination.
//!
//! These types are the shared contract between the file store, the metadata
//! index, the search index, the CLI and the Tauri commands. Keeping them in one
//! place means every subsystem agrees on what a "note" is.

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::{CoreError, Result};

/// Permanent identifier of a note. A UUIDv7 encodes its creation instant, so
/// ids are time-ordered and usable as a synchronization tie-breaker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct NoteId(pub Uuid);

impl NoteId {
    /// Mint a new UUIDv7 id (creation time = now).
    pub fn now() -> Self {
        Self(Uuid::now_v7())
    }

    pub fn parse(s: &str) -> Result<Self> {
        let u = Uuid::parse_str(s.trim()).map_err(|_| CoreError::InvalidNoteId(s.into()))?;
        Ok(Self(u))
    }

    pub fn as_uuid(&self) -> Uuid {
        self.0
    }
}

impl std::fmt::Display for NoteId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0.hyphenated())
    }
}

impl std::str::FromStr for NoteId {
    type Err = CoreError;
    fn from_str(s: &str) -> Result<Self> {
        Self::parse(s)
    }
}

/// Content hash. Stored as `<algo>:<hex>`, currently `b3:` for BLAKE3. The
/// algorithm prefix lets us migrate later without rehashing history.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct NoteHash(pub String);

impl NoteHash {
    pub const ALGO: &'static str = "b3";

    pub fn new(hex: impl Into<String>) -> Self {
        Self(format!("{}:{}", Self::ALGO, hex.into()))
    }

    /// Wrap an already-formatted `b3:...` string without re-prefixing.
    pub fn from_stored(s: impl Into<String>) -> Self {
        Self(s.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for NoteHash {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Note color, stored verbatim as a CSS `oklch(...)` string. Validation is
/// permissive on the Rust side (§7.7); the renderer is the final authority.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct NoteColor(pub String);

impl NoteColor {
    pub const NONE: Self = Self(String::new());

    /// True when empty (no color) or a valid-looking `oklch(...)` value.
    pub fn is_valid(&self) -> bool {
        self.0.is_empty() || self.0.starts_with("oklch(")
    }

    /// Coerce legacy enum-style values to "none" (§7.7 fallback).
    pub fn parse_or_none(s: &str) -> Self {
        if s.is_empty() || s.starts_with("oklch(") {
            Self(s.to_string())
        } else {
            Self::NONE
        }
    }
}

impl std::fmt::Display for NoteColor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Default OKLCH preset palette (§7.7). L≈0.70–0.75, C≈0.12–0.15 so every
/// preset reads well on both light and dark backgrounds.
pub const COLOR_PRESETS: &[&str] = &[
    "oklch(0.75 0.15 25)",  // red
    "oklch(0.75 0.15 75)",  // amber
    "oklch(0.75 0.13 145)", // green
    "oklch(0.75 0.12 195)", // teal
    "oklch(0.70 0.14 250)", // blue
    "oklch(0.72 0.15 310)", // purple
];

/// Synchronization cursor: `(updated_at, id)`. Stable across reindex because
/// both components live in the note file's frontmatter (§5.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cursor {
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
    pub id: NoteId,
}

impl Cursor {
    /// Parse a cursor from its JSON serialization. The cursor is serialized
    /// as `{updated_at, id}`; this parses that shape from a string.
    pub fn parse(s: &str) -> Result<Self> {
        serde_json::from_str(s).map_err(|e| CoreError::Other(format!("invalid cursor: {e}")))
    }

    /// Ordering used for pagination and export: newer (larger updated_at, then
    /// larger id) sorts first.
    pub fn sort_key(&self) -> (OffsetDateTime, NoteId) {
        (self.updated_at, self.id)
    }
}

impl PartialOrd for Cursor {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Cursor {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.sort_key().cmp(&other.sort_key())
    }
}

/// A complete note: its body plus all metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Note {
    pub id: NoteId,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
    pub hash: NoteHash,
    pub pinned: bool,
    pub color: NoteColor,
    pub tags: Vec<String>,
    pub body: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "time::serde::rfc3339::option"
    )]
    pub deleted_at: Option<OffsetDateTime>,
}

/// Lightweight projection used by listings, search results and exports.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteSummary {
    pub id: NoteId,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
    pub hash: NoteHash,
    pub pinned: bool,
    pub color: NoteColor,
    pub tags: Vec<String>,
    pub preview: String,
    pub deleted: bool,
}

impl NoteSummary {
    /// Max characters kept in a card preview.
    pub const PREVIEW_MAX: usize = 280;
}

impl From<Note> for NoteSummary {
    fn from(n: Note) -> Self {
        let deleted = n.deleted_at.is_some();
        Self {
            id: n.id,
            created_at: n.created_at,
            updated_at: n.updated_at,
            hash: n.hash,
            pinned: n.pinned,
            color: n.color,
            tags: n.tags,
            preview: make_preview(&n.body),
            deleted,
        }
    }
}

/// Compress a body into a single-line preview of bounded length: non-empty
/// trimmed lines joined by a single space, then truncated on a char boundary.
pub fn make_preview(body: &str) -> String {
    let joined: String = body
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    truncate_chars(&joined, NoteSummary::PREVIEW_MAX)
}

/// Truncate on a char boundary, appending an ellipsis when truncated.
fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('\u{2026}');
    out
}

/// A page of cursor-paginated results.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<Cursor>,
}

/// Filter applied to listings (§7.5).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NoteFilter {
    pub tag: Option<String>,
    pub pinned_only: bool,
    /// When false, soft-deleted notes are excluded.
    pub include_deleted: bool,
}

impl NoteFilter {
    pub fn matches(&self, s: &NoteSummary) -> bool {
        if !self.include_deleted && s.deleted {
            return false;
        }
        if self.pinned_only && !s.pinned {
            return false;
        }
        if let Some(t) = &self.tag
            && !s.tags.iter().any(|x| x.eq_ignore_ascii_case(t))
        {
            return false;
        }
        true
    }
}

/// Statistics produced by `reindex`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct IndexStats {
    pub notes: u64,
    pub trashed: u64,
    pub added: u64,
    pub updated: u64,
    pub unchanged: u64,
    pub failed: u64,
}

/// Live vault statistics (excludes soft-deleted tombstones).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NoteStats {
    pub notes: u64,
    pub pinned: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn color_falls_back_for_legacy_values() {
        assert_eq!(NoteColor::parse_or_none("amber"), NoteColor::NONE);
        assert_eq!(
            NoteColor::parse_or_none("oklch(0.75 0.15 75)").0,
            "oklch(0.75 0.15 75)"
        );
    }

    #[test]
    fn preview_collapses_and_truncates() {
        let body = "first line\n\nsecond line\n".to_string();
        assert_eq!(make_preview(&body), "first line second line");
    }
}
