//! Domain model: notes, identifiers, categories, pagination.
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
pub struct MemoId(pub Uuid);

impl MemoId {
    /// Mint a new UUIDv7 id (creation time = now).
    pub fn now() -> Self {
        Self(Uuid::now_v7())
    }

    pub fn parse(s: &str) -> Result<Self> {
        let u = Uuid::parse_str(s.trim()).map_err(|_| CoreError::InvalidMemoId(s.into()))?;
        Ok(Self(u))
    }

    pub fn as_uuid(&self) -> Uuid {
        self.0
    }
}

impl std::fmt::Display for MemoId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0.hyphenated())
    }
}

impl std::str::FromStr for MemoId {
    type Err = CoreError;
    fn from_str(s: &str) -> Result<Self> {
        Self::parse(s)
    }
}

/// Content hash. Stored as `<algo>:<hex>`, currently `b3:` for BLAKE3. The
/// algorithm prefix lets us migrate later without rehashing history.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct MemoHash(pub String);

impl MemoHash {
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

impl std::fmt::Display for MemoHash {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Default category id for new notes. Used when no category is supplied.
pub const DEFAULT_CATEGORY: &str = "inbox";

/// Synchronization cursor: `(updated_at, id)`. Stable across reindex because
/// both components live in the note file's frontmatter (§5.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cursor {
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
    pub id: MemoId,
}

impl Cursor {
    /// Parse a cursor from its JSON serialization. The cursor is serialized
    /// as `{updated_at, id}`; this parses that shape from a string.
    pub fn parse(s: &str) -> Result<Self> {
        serde_json::from_str(s).map_err(|e| CoreError::Other(format!("invalid cursor: {e}")))
    }

    /// Ordering used for pagination and export: newer (larger updated_at, then
    /// larger id) sorts first.
    pub fn sort_key(&self) -> (OffsetDateTime, MemoId) {
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
pub struct Memo {
    pub id: MemoId,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
    pub hash: MemoHash,
    pub pinned: bool,
    #[serde(default = "default_category")]
    pub category: String,
    pub tags: Vec<String>,
    pub body: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "time::serde::rfc3339::option"
    )]
    pub deleted_at: Option<OffsetDateTime>,
}

pub fn default_category() -> String {
    DEFAULT_CATEGORY.to_string()
}

/// Lightweight projection used by listings, search results and exports.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoSummary {
    pub id: MemoId,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
    pub hash: MemoHash,
    pub pinned: bool,
    #[serde(default = "default_category")]
    pub category: String,
    pub tags: Vec<String>,
    pub preview: String,
    pub deleted: bool,
}

impl MemoSummary {
    /// Max characters kept in a card preview.
    pub const PREVIEW_MAX: usize = 280;
}

impl From<Memo> for MemoSummary {
    fn from(n: Memo) -> Self {
        let deleted = n.deleted_at.is_some();
        Self {
            id: n.id,
            created_at: n.created_at,
            updated_at: n.updated_at,
            hash: n.hash,
            pinned: n.pinned,
            category: n.category,
            tags: n.tags,
            preview: make_preview(&n.body),
            deleted,
        }
    }
}

/// Build a card preview of bounded length: non-empty trimmed lines joined by
/// newlines so a multi-line note renders multi-line in the grid (line breaks
/// the user typed are preserved), then truncated on a char boundary.
pub fn make_preview(body: &str) -> String {
    let joined: String = body
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    truncate_chars(&joined, MemoSummary::PREVIEW_MAX)
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
    pub next_cursor: Option<String>,
}

/// Filter applied to listings (§4.3, §7.5). Composite: include-tag set
/// (AND or OR), exclude-tag set, category set (OR membership), pin, deleted.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MemoFilter {
    /// Memo must contain these tags. Empty = no constraint.
    pub include_tags: Vec<String>,
    /// Memo must contain NONE of these tags.
    pub exclude_tags: Vec<String>,
    /// `true` = note must contain ALL `include_tags` (AND); `false` = ANY (OR).
    pub match_all: bool,
    /// Non-empty = note's category must equal one of these (OR membership).
    pub categories: Vec<String>,
    pub pinned_only: bool,
    /// When false, soft-deleted notes are excluded.
    pub include_deleted: bool,
}

impl MemoFilter {
    pub fn matches(&self, s: &MemoSummary) -> bool {
        if !self.include_deleted && s.deleted {
            return false;
        }
        if self.pinned_only && !s.pinned {
            return false;
        }
        if !self.categories.is_empty()
            && !self.categories.iter().any(|c| c == &s.category)
        {
            return false;
        }
        if !self.exclude_tags.is_empty()
            && self
                .exclude_tags
                .iter()
                .any(|t| s.tags.iter().any(|x| x.eq_ignore_ascii_case(t)))
        {
            return false;
        }

        if !self.include_tags.is_empty() {
            let hit = |t: &String| s.tags.iter().any(|x| x.eq_ignore_ascii_case(t));
            let ok = if self.match_all {
                self.include_tags.iter().all(hit)
            } else {
                self.include_tags.iter().any(hit)
            };
            if !ok {
                return false;
            }
        }
        true
    }
}

/// Statistics produced by `reindex`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct IndexStats {
    pub memos: u64,
    pub trashed_memos: u64,
    pub added: u64,
    pub updated: u64,
    pub unchanged: u64,
    pub failed: u64,
}

/// Live vault statistics (excludes soft-deleted tombstones).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MemoStats {
    pub memos: u64,
    pub pinned: u64,
}

/// Tag + category counts across the (non-deleted) vault, for the sidebar (§4.2).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Facets {
    /// `(normalized_tag, count)` sorted by tag.
    pub tags: Vec<(String, u32)>,
    /// `(category_id, count)` sorted by category; default-category notes excluded.
    pub categories: Vec<(String, u32)>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_preserves_linebreaks_and_truncates() {
        // Blank lines are dropped; surviving non-empty lines keep their breaks.
        let body = "first line\n\nsecond line\n".to_string();
        assert_eq!(make_preview(&body), "first line\nsecond line");
        // A long body truncates on a char boundary with an ellipsis.
        let big = "a\n".repeat(400);
        let pv = make_preview(&big);
        assert!(pv.chars().count() <= MemoSummary::PREVIEW_MAX);
        assert!(pv.ends_with('\u{2026}'));
    }
}

#[cfg(test)]
mod filter_tests {
    use super::*;
    use time::OffsetDateTime;

    fn sum(tags: &[&str], category: &str, pinned: bool) -> MemoSummary {
        MemoSummary {
            id: MemoId::now(),
            created_at: OffsetDateTime::now_utc(),
            updated_at: OffsetDateTime::now_utc(),
            hash: MemoHash::new("h"),
            pinned,
            category: category.to_string(),
            tags: tags.iter().map(|t| t.to_string()).collect(),
            preview: String::new(),
            deleted: false,
        }
    }

    #[test]
    fn include_or_and_exclude() {
        let f = MemoFilter {
            include_tags: vec!["a".into(), "b".into()],
            exclude_tags: vec!["x".into()],
            match_all: false,
            ..Default::default()
        };
        assert!(f.matches(&sum(&["a"], "inbox", false)));
        assert!(f.matches(&sum(&["b"], "inbox", false)));
        assert!(!f.matches(&sum(&["c"], "inbox", false)));
        assert!(!f.matches(&sum(&["a", "x"], "inbox", false)));
    }

    #[test]
    fn include_and_requires_all() {
        let f = MemoFilter {
            include_tags: vec!["a".into(), "b".into()],
            match_all: true,
            ..Default::default()
        };
        assert!(f.matches(&sum(&["a", "b"], "inbox", false)));
        assert!(!f.matches(&sum(&["a"], "inbox", false)));
    }

    #[test]
    fn category_membership() {
        let f = MemoFilter {
            categories: vec!["todo".into()],
            ..Default::default()
        };
        assert!(f.matches(&sum(&[], "todo", false)));
        assert!(!f.matches(&sum(&[], "idea", false)));
        assert!(MemoFilter::default().matches(&sum(&[], "inbox", false)));
    }
}
