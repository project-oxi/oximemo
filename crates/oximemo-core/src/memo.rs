//! Domain model: notes, identifiers, pagination.
//!
//! These types are the shared contract between the file store, the metadata
//! index, the search index, the CLI and the Tauri commands. Keeping them in one
//! place means every subsystem agrees on what a "note" is.

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::{CoreError, Result};

/// Permanent identifier of a memo. A UUIDv7 encodes its creation instant, so
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

/// Synchronization cursor: `(updated_at, id)`. Stable across reindex because
/// both components live in the memo file's frontmatter (§5.3).
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
    pub favorite: bool,
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
pub struct MemoSummary {
    pub id: MemoId,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
    pub hash: MemoHash,
    pub favorite: bool,
    /// Title derived from the first `# H1` heading, or `None` for untitled notes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Vault-root-relative path, e.g. `"novel/act1/첫-번째-장.md"`.
    #[serde(default)]
    pub path: String,
    pub tags: Vec<String>,
    pub preview: String,
    pub deleted: bool,
}

impl MemoSummary {
    /// Max characters kept in a card preview.
    pub const PREVIEW_MAX: usize = 280;
}

/// Full-note DTO for the desktop API: a [`Memo`] plus its vault placement.
/// Returned by `get_memo` / `create_memo` / `update_memo` / `move_note`
/// commands so the renderer can route editors and render badges without a
/// second lookup.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NoteDto {
    pub id: MemoId,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
    pub hash: MemoHash,
    pub favorite: bool,
    pub tags: Vec<String>,
    pub body: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "time::serde::rfc3339::option"
    )]
    pub deleted_at: Option<OffsetDateTime>,
    /// Display title (derived, format-aware). `None` for untitled notes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Vault-root-relative path, e.g. `"novel/act1/장.html"`.
    #[serde(default)]
    pub path: String,
    /// Parent folder of `path` (empty for vault root).
    #[serde(default)]
    pub folder: String,
    /// Serialization format, derived from the path extension.
    pub format: NoteFormat,
}

impl NoteDto {
    /// Assemble from a [`Memo`] and its vault-relative path. The format,
    /// folder, and title are all derived — nothing is stored twice.
    pub fn from_memo(memo: &Memo, path: &str) -> Self {
        Self {
            id: memo.id,
            created_at: memo.created_at,
            updated_at: memo.updated_at,
            hash: memo.hash.clone(),
            favorite: memo.favorite,
            tags: memo.tags.clone(),
            body: memo.body.clone(),
            deleted_at: memo.deleted_at,
            title: note_title(NoteFormat::from_rel(path), &memo.body),
            path: path.to_string(),
            folder: path
                .rfind('/')
                .map(|i| &path[..i])
                .unwrap_or("")
                .to_string(),
            format: NoteFormat::from_rel(path),
        }
    }
}

impl From<Memo> for MemoSummary {
    fn from(n: Memo) -> Self {
        let deleted = n.deleted_at.is_some();
        Self {
            id: n.id,
            created_at: n.created_at,
            updated_at: n.updated_at,
            hash: n.hash,
            favorite: n.favorite,
            title: derive_title(&n.body),
            path: String::new(),
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
/// (AND or OR), exclude-tag set, folder path-prefix, favorite, deleted.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MemoFilter {
    /// Memo must contain these tags. Empty = no constraint.
    pub include_tags: Vec<String>,
    /// Memo must contain NONE of these tags.
    pub exclude_tags: Vec<String>,
    /// `true` = note must contain ALL `include_tags` (AND); `false` = ANY (OR).
    pub match_all: bool,
    /// When set, note's `path` must start with this folder prefix (e.g. `"novel"`).
    /// Empty string = root folder (loose files only). `None` = all folders.
    pub folder: Option<String>,
    pub favorites_only: bool,
    /// When false, soft-deleted notes are excluded.
    pub include_deleted: bool,
}

impl MemoFilter {
    pub fn matches(&self, s: &MemoSummary) -> bool {
        if !self.include_deleted && s.deleted {
            return false;
        }
        if self.favorites_only && !s.favorite {
            return false;
        }
        if let Some(folder) = &self.folder
            && !folder_matches(&s.path, folder)
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

/// Check whether `path` (vault-relative, e.g. `"novel/act1/x.md"`) belongs to
/// `folder`. `folder == ""` matches root-level files (no `/` before the stem).
/// Otherwise the path's directory must equal or be nested under `folder`.
fn folder_matches(path: &str, folder: &str) -> bool {
    // Strip the filename: keep the directory portion.
    let dir = match path.rfind('/') {
        Some(i) => &path[..i],
        None => "",
    };
    if folder.is_empty() {
        return dir.is_empty();
    }
    dir == folder || dir.starts_with(&format!("{folder}/"))
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
    pub favorites: u64,
}

/// Tag + folder counts across the (non-deleted) vault, for the sidebar.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Facets {
    /// `(normalized_tag, count)` sorted by tag.
    pub tags: Vec<(String, u32)>,
    /// `(folder_path, count)` sorted by path.
    pub folders: Vec<(String, u32)>,
}

// ---- Note format ----------------------------------------------------------

/// A note's on-disk format. Never stored: always derived from the file
/// extension, so the vault cannot drift out of sync with itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoteFormat {
    Markdown,
    Html,
}

impl NoteFormat {
    /// Derive the format from a file path's extension. Unknown extensions
    /// (including none) default to [`NoteFormat::Markdown`].
    pub fn from_path(path: &std::path::Path) -> Self {
        match path.extension().and_then(|e| e.to_str()) {
            Some("html") => Self::Html,
            _ => Self::Markdown,
        }
    }

    /// Derive the format from a vault-relative path string.
    pub fn from_rel(rel: &str) -> Self {
        Self::from_path(std::path::Path::new(rel))
    }

    /// File extension including the dot.
    pub fn ext(&self) -> &'static str {
        match self {
            Self::Markdown => ".md",
            Self::Html => ".html",
        }
    }
}

/// Derive a note's display title in a format-aware way: markdown uses the
/// first `# H1`; html uses the first `<h1>` (falling back to `<title>`).
pub fn note_title(fmt: NoteFormat, body: &str) -> Option<String> {
    match fmt {
        NoteFormat::Markdown => derive_title(body),
        NoteFormat::Html => crate::html::derive_title(body),
    }
}

/// Format-aware card preview: html bodies are reduced to text first.
pub fn preview_of(fmt: NoteFormat, body: &str) -> String {
    match fmt {
        NoteFormat::Markdown => make_preview(body),
        NoteFormat::Html => make_preview(&crate::html::html_to_text(body)),
    }
}

/// Format-aware inline `#tag` extraction. For html the tags are extracted
/// from the *text* content so URL fragments (`href="#section"`) and
/// attribute values never masquerade as tags.
pub fn tags_of(fmt: NoteFormat, body: &str) -> Vec<String> {
    match fmt {
        NoteFormat::Markdown => crate::tags::extract_tags(body),
        NoteFormat::Html => crate::tags::extract_tags(&crate::html::html_to_text(body)),
    }
}

/// The body text that should feed the full-text search index. Markdown is
/// passed through; html is reduced to text.
pub fn searchable_body<'a>(fmt: NoteFormat, body: &'a str) -> std::borrow::Cow<'a, str> {
    match fmt {
        NoteFormat::Markdown => std::borrow::Cow::Borrowed(body),
        NoteFormat::Html => std::borrow::Cow::Owned(crate::html::html_to_text(body)),
    }
}

// ---- Title derivation & filename helpers ---------------------------------

/// Derive a note's display title from its body: the first `# H1` heading text.
/// Returns `None` if no H1 exists (untitled memo).
pub fn derive_title(body: &str) -> Option<String> {
    for line in body.lines() {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("# ") {
            let title = rest.trim().to_string();
            if !title.is_empty() {
                return Some(title);
            }
        }
    }
    None
}

/// Normalize a title into a filesystem-safe filename component.
/// Spaces → hyphens, removes `/ \ : * ? " < > |`, preserves Unicode.
pub fn slugify(title: &str) -> String {
    let mut s: String = title
        .trim()
        .chars()
        .map(|c| match c {
            ' ' => '-',
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '\0',
            _ => c,
        })
        .filter(|c| *c != '\0')
        .collect();
    while s.contains("--") {
        s = s.replace("--", "-");
    }
    s.trim_matches('-').to_string()
}

/// Generate a timestamp-based filename for untitled notes: `YYYY-MM-DD-HHMMSS`.
pub fn timestamp_filename(t: OffsetDateTime) -> String {
    use time::Month;
    let month = match t.month() {
        Month::January => "01",
        Month::February => "02",
        Month::March => "03",
        Month::April => "04",
        Month::May => "05",
        Month::June => "06",
        Month::July => "07",
        Month::August => "08",
        Month::September => "09",
        Month::October => "10",
        Month::November => "11",
        Month::December => "12",
    };
    format!(
        "{:04}-{}-{:02}-{:02}{:02}{:02}",
        t.year(),
        month,
        t.day(),
        t.hour(),
        t.minute(),
        t.second(),
    )
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

    #[test]
    fn derive_title_finds_h1() {
        assert_eq!(derive_title("# Hello World"), Some("Hello World".into()));
        assert_eq!(derive_title("  # Spaced"), Some("Spaced".into()));
        assert_eq!(derive_title("body\n# Title\nmore"), Some("Title".into()));
    }

    #[test]
    fn derive_title_none_without_h1() {
        assert_eq!(derive_title("just text"), None);
        assert_eq!(derive_title("## H2 not H1"), None);
        assert_eq!(derive_title("# "), None); // empty heading
    }

    #[test]
    fn slugify_basic() {
        assert_eq!(slugify("Hello World"), "Hello-World");
        assert_eq!(slugify("  trim  "), "trim");
        assert_eq!(slugify("a/b\\c:d*e?f"), "abcdef");
        assert_eq!(slugify("multiple   spaces"), "multiple-spaces");
        assert_eq!(slugify("한글 제목"), "한글-제목");
    }

    #[test]
    fn timestamp_filename_format() {
        use time::Month;
        let t = OffsetDateTime::from_unix_timestamp(0)
            .unwrap()
            .replace_year(2026)
            .unwrap()
            .replace_month(Month::August)
            .unwrap()
            .replace_day(13)
            .unwrap()
            .replace_hour(14)
            .unwrap()
            .replace_minute(30)
            .unwrap()
            .replace_second(52)
            .unwrap();
        assert_eq!(timestamp_filename(t), "2026-08-13-143052");
    }
}

#[cfg(test)]
mod format_tests {
    use super::*;

    #[test]
    fn from_rel_by_extension() {
        assert_eq!(NoteFormat::from_rel("a/b/note.md"), NoteFormat::Markdown);
        assert_eq!(NoteFormat::from_rel("x/note.html"), NoteFormat::Html);
        assert_eq!(NoteFormat::from_rel("noext"), NoteFormat::Markdown);
        assert_eq!(NoteFormat::from_rel("x/note.htm"), NoteFormat::Markdown);
    }

    #[test]
    fn ext_roundtrip_with_from_rel() {
        for fmt in [NoteFormat::Markdown, NoteFormat::Html] {
            let rel = format!("folder/note{}", fmt.ext());
            assert_eq!(NoteFormat::from_rel(&rel), fmt);
        }
    }

    #[test]
    fn html_tags_skip_url_fragments() {
        let body = r##"<p>see <a href="#section">link</a></p><p>#real 태그</p>"##;
        assert_eq!(tags_of(NoteFormat::Html, body), vec!["real"]);
    }

    #[test]
    fn searchable_body_reduces_html() {
        let body = "<h1>제목</h1>\n<p>본문 <b>텍스트</b></p>";
        assert_eq!(
            searchable_body(NoteFormat::Html, body).as_ref(),
            "제목 본문 텍스트"
        );
        // Markdown passes through unchanged.
        let md = "# T\nbody";
        assert_eq!(searchable_body(NoteFormat::Markdown, md).as_ref(), md);
    }

    #[test]
    fn note_title_dispatches_by_format() {
        assert_eq!(
            note_title(NoteFormat::Markdown, "# MD\n"),
            Some("MD".to_string())
        );
        assert_eq!(
            note_title(NoteFormat::Html, "<h1>HTML</h1>"),
            Some("HTML".to_string())
        );
        assert_eq!(note_title(NoteFormat::Html, "<h2>nope</h2>"), None);
    }

    #[test]
    fn preview_of_strips_html() {
        assert_eq!(
            preview_of(NoteFormat::Html, "<p>첫 문장</p><p>둘째</p>"),
            "첫 문장 둘째"
        );
    }
}

#[cfg(test)]
mod filter_tests {
    use super::*;
    use time::OffsetDateTime;

    fn sum(tags: &[&str], path: &str, favorite: bool) -> MemoSummary {
        MemoSummary {
            id: MemoId::now(),
            created_at: OffsetDateTime::now_utc(),
            updated_at: OffsetDateTime::now_utc(),
            hash: MemoHash::new("h"),
            favorite,
            title: None,
            path: path.to_string(),
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
        assert!(f.matches(&sum(&["a"], "", false)));
        assert!(f.matches(&sum(&["b"], "", false)));
        assert!(!f.matches(&sum(&["c"], "", false)));
        assert!(!f.matches(&sum(&["a", "x"], "", false)));
    }

    #[test]
    fn include_and_requires_all() {
        let f = MemoFilter {
            include_tags: vec!["a".into(), "b".into()],
            match_all: true,
            ..Default::default()
        };
        assert!(f.matches(&sum(&["a", "b"], "", false)));
        assert!(!f.matches(&sum(&["a"], "", false)));
    }

    #[test]
    fn folder_membership() {
        let f = MemoFilter {
            folder: Some("novel".into()),
            ..Default::default()
        };
        assert!(f.matches(&sum(&[], "novel/ch1.md", false)));
        assert!(f.matches(&sum(&[], "novel/act1/ch1.md", false)));
        assert!(!f.matches(&sum(&[], "diary/today.md", false)));
        assert!(!f.matches(&sum(&[], "root-file.md", false)));
    }

    #[test]
    fn root_folder_filter() {
        let f = MemoFilter {
            folder: Some(String::new()),
            ..Default::default()
        };
        assert!(f.matches(&sum(&[], "root-file.md", false)));
        assert!(!f.matches(&sum(&[], "novel/ch1.md", false)));
    }
}
