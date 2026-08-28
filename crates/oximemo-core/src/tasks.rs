//! Task extraction, mutation, and serialization for the Tasks feature.
//! Spec: docs/superpowers/specs/2026-08-27-tasks-design.md.

use crate::error::{CoreError, Result};
use crate::expr::value::DurationSpec;
use serde::{Deserialize, Serialize};
use time::{Date, UtcOffset};

/// `#[serde(transparent)]` so it round-trips as a bare JSON string —
/// JavaScript cannot represent an arbitrary `u64` losslessly (spec §5).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TaskLineHash(pub String);

impl TaskLineHash {
    /// Hash exactly the raw source line bytes. Strict optimistic locking
    /// keys off `(memo_id, line, line_hash)` (spec §5).
    pub fn of_line(raw_line: &str) -> Self {
        let digest = blake3::hash(raw_line.as_bytes());
        Self(digest.to_hex()[..16].to_ascii_lowercase())
    }
}

impl std::fmt::Display for TaskLineHash {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Recognized emoji/dataview metadata fields (spec §1 field table).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskField {
    Created,
    Start,
    Scheduled,
    Due,
    Done,
    Cancelled,
    Priority,
    Recurrence,
}

/// Which date field a `TaskEdit::SetDate` targets (spec §5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DateField {
    Created,
    Start,
    Scheduled,
    Due,
    Done,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TaskWarningKind {
    InvalidValue,
    Duplicate,
    UnsupportedRule,
}

/// Records an offending raw token verbatim for UI repair (spec §1). The
/// raw line is never mutated by parsing; warnings are metadata only.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskWarning {
    pub field: Option<TaskField>,
    pub raw: String,
    pub kind: TaskWarningKind,
}

/// 5-level priority scale (spec §1 field table); `None` = no priority set.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Priority {
    Lowest,
    Low,
    #[default]
    None,
    Medium,
    High,
    Highest,
}

/// Spec §2: `NON_TASK` lines stay ordinary checkboxes and never enter
/// `IndexRecord.tasks`; `done` = `Done | Cancelled`; `not done` = the rest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum StatusType {
    Todo,
    InProgress,
    OnHold,
    Done,
    Cancelled,
    NonTask,
}

impl StatusType {
    pub fn is_done_family(self) -> bool {
        matches!(self, StatusType::Done | StatusType::Cancelled)
    }
}

/// One row of `[[tasks.statuses]]` (spec §2/§11). `name: None` uses the
/// built-in localized label for that `type`; a configured `name` displays
/// verbatim.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskStatusDef {
    pub symbol: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub next: String,
    pub r#type: StatusType,
}

/// `[tasks]` vault configuration (spec §11).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct TasksConfig {
    pub enabled: bool,
    pub write_format: WriteFormat,
    pub global_filter: String,
    pub recurrence_insert: RecurrenceInsert,
    pub default_section: String,
    pub capture_target: CaptureTarget,
    pub statuses: Vec<TaskStatusDef>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WriteFormat {
    Emoji,
    Dataview,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecurrenceInsert {
    Above,
    Below,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptureTarget {
    Daily,
    Inbox,
}

impl Default for TasksConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            write_format: WriteFormat::Emoji,
            global_filter: String::new(),
            recurrence_insert: RecurrenceInsert::Above,
            default_section: "할 일".into(),
            capture_target: CaptureTarget::Daily,
            statuses: Vec::new(),
        }
    }
}

/// Validated, X-normalized status table with built-in defaults merged in.
/// Built by [`TasksConfig::effective_statuses`]; never constructed by hand.
#[derive(Debug, Clone)]
pub struct EffectiveStatuses {
    // symbol -> (display name override, next symbol, type)
    by_symbol: std::collections::BTreeMap<char, (Option<String>, char, StatusType)>,
}

impl EffectiveStatuses {
    /// Looks up a symbol's `(name override, next symbol, type)`. Unknown
    /// symbols degrade to `("Unknown", 'x', TODO)` per spec §2 — this
    /// method never fails.
    pub fn get(&self, symbol: char) -> (Option<String>, char, StatusType) {
        let normalized = if symbol == 'X' { 'x' } else { symbol };
        self.by_symbol
            .get(&normalized)
            .cloned()
            .unwrap_or_else(|| (Some("Unknown".to_string()), 'x', StatusType::Todo))
    }

    pub fn is_known(&self, symbol: char) -> bool {
        let normalized = if symbol == 'X' { 'x' } else { symbol };
        self.by_symbol.contains_key(&normalized)
    }

    /// The first configured symbol whose type is `TODO`, used when
    /// spawning a recurrence occurrence (spec §6). Falls back to `' '`.
    pub fn first_todo_symbol(&self) -> char {
        self.by_symbol
            .iter()
            .find(|(_, (_, _, ty))| *ty == StatusType::Todo)
            .map(|(sym, _)| *sym)
            .unwrap_or(' ')
    }
}

const BUILTIN_STATUSES: &[(char, char, StatusType)] = &[
    (' ', 'x', StatusType::Todo),
    ('/', 'x', StatusType::InProgress),
    ('x', ' ', StatusType::Done),
    ('-', ' ', StatusType::Cancelled),
];

impl TasksConfig {
    /// Merges configured `[[tasks.statuses]]` over the built-in defaults,
    /// normalizes `X -> x`, and validates the result (spec §2):
    /// - every symbol is exactly one character
    /// - configured symbols are unique after normalization (an entry may
    ///   override a built-in, but two configured entries may not map to
    ///   the same symbol)
    /// - every `next` resolves to a configured (or built-in) symbol
    /// - `global_filter` contains no newline or NUL (spec §11)
    /// - every `type` is a known `StatusType` (guaranteed by the Rust
    ///   type system once deserialized, so this reduces to the first
    ///   three checks plus re-validating after merge)
    pub fn effective_statuses(&self) -> Result<EffectiveStatuses> {
        if self.global_filter.contains('\n') || self.global_filter.contains('\0') {
            return Err(CoreError::InvalidTasksConfig(
                "global_filter must not contain newline or NUL".into(),
            ));
        }
        let mut by_symbol = std::collections::BTreeMap::new();
        for (sym, next, ty) in BUILTIN_STATUSES {
            by_symbol.insert(*sym, (None, *next, *ty));
        }
        let mut configured = std::collections::BTreeSet::new();
        for def in &self.statuses {
            let mut chars = def.symbol.chars();
            let sym = chars.next().ok_or_else(|| {
                CoreError::InvalidTasksConfig("status symbol must not be empty".into())
            })?;
            if chars.next().is_some() {
                return Err(CoreError::InvalidTasksConfig(format!(
                    "status symbol {:?} must be exactly one character",
                    def.symbol
                )));
            }
            let normalized = if sym == 'X' { 'x' } else { sym };
            let mut next_chars = def.next.chars();
            let next = next_chars.next().ok_or_else(|| {
                CoreError::InvalidTasksConfig(format!(
                    "status {:?} has an empty next symbol",
                    def.symbol
                ))
            })?;
            if next_chars.next().is_some() {
                return Err(CoreError::InvalidTasksConfig(format!(
                    "status {:?} next symbol must be exactly one character",
                    def.symbol
                )));
            }
            // Duplicates are only two CONFIGURED entries colliding after
            // normalization; a single configured entry may legitimately
            // override a built-in (spec §11's example overrides " ").
            if !configured.insert(normalized) {
                return Err(CoreError::InvalidTasksConfig(format!(
                    "duplicate status symbol {:?} after normalization",
                    def.symbol
                )));
            }
            by_symbol.insert(normalized, (def.name.clone(), next, def.r#type));
        }
        for (sym, (_, next, _)) in &by_symbol {
            let normalized_next = if *next == 'X' { 'x' } else { *next };
            if !by_symbol.contains_key(&normalized_next) {
                return Err(CoreError::InvalidTasksConfig(format!(
                    "status {sym:?} has unresolvable next symbol {next:?}"
                )));
            }
        }
        Ok(EffectiveStatuses { by_symbol })
    }
}

/// One indexed task row (spec §3). `text` has the checkbox, recognized
/// field tokens, and the configured `global_filter` token stripped;
/// unrecognized text and the user's own emoji remain.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskRow {
    pub line: u32,
    pub indent_columns: u16,
    pub parent: Option<u32>,
    pub symbol: char,
    pub status_type: StatusType,
    pub text: String,
    pub tags: Vec<String>,
    pub section: Option<String>,
    pub created: Option<Date>,
    pub start: Option<Date>,
    pub scheduled: Option<Date>,
    pub due: Option<Date>,
    pub done: Option<Date>,
    pub cancelled: Option<Date>,
    pub priority: Priority,
    pub recurrence: Option<String>,
    pub warnings: Vec<TaskWarning>,
    pub line_hash: TaskLineHash,
}

#[derive(Debug, Clone, Default)]
pub struct ParsedTasks {
    pub tasks: Vec<TaskRow>,
    pub truncated: bool,
}

/// Identifies one task line for `Vault::patch_task`, carrying a
/// stale-write guard (spec §5). `line_hash` is the target line's
/// `TaskLineHash` at the time the caller last saw it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskRef {
    pub memo_id: crate::memo::MemoId,
    pub line: u32,
    pub line_hash: TaskLineHash,
}

/// How `Vault::patch_task` locates the target line (spec §5): `Exact`
/// rejects the edit if the line has drifted since `line_hash` was
/// captured (concurrent-write guard); `CurrentLine` skips that check
/// and targets whatever line is currently there (CM6 editor's
/// unsaved-buffer path, where the caller already has authoritative
/// knowledge of the current text).
#[derive(Debug, Clone, PartialEq)]
pub enum TaskSelector {
    Exact(TaskRef),
    CurrentLine {
        memo_id: crate::memo::MemoId,
        line: u32,
    },
}

/// Indexed `TaskRow` fields plus the ref needed to patch it again. Wire
/// DTO shared verbatim by Tauri and CLI JSON output (spec §10).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskDto {
    pub task_ref: TaskRef,
    pub symbol: char,
    pub status_type: StatusType,
    pub text: String,
    pub tags: Vec<String>,
    pub section: Option<String>,
    pub created: Option<Date>,
    pub start: Option<Date>,
    pub scheduled: Option<Date>,
    pub due: Option<Date>,
    pub done: Option<Date>,
    pub cancelled: Option<Date>,
    pub priority: Priority,
    pub recurrence: Option<String>,
    pub warnings: Vec<TaskWarning>,
}

impl TaskDto {
    pub fn from_row(memo_id: crate::memo::MemoId, row: &TaskRow) -> Self {
        Self {
            task_ref: TaskRef {
                memo_id,
                line: row.line,
                line_hash: row.line_hash.clone(),
            },
            symbol: row.symbol,
            status_type: row.status_type,
            text: row.text.clone(),
            tags: row.tags.clone(),
            section: row.section.clone(),
            created: row.created,
            start: row.start,
            scheduled: row.scheduled,
            due: row.due,
            done: row.done,
            cancelled: row.cancelled,
            priority: row.priority,
            recurrence: row.recurrence.clone(),
            warnings: row.warnings.clone(),
        }
    }
}
/// Result of a successful `Vault::patch_task` call (spec §5/§6):
/// `note_hash` is the whole-note hash right after the write (callers
/// use it to detect further drift), `task` is the patched row
/// re-parsed from the new body, `spawned` is the newly-created
/// recurrence occurrence's row when the edit spawned one.
/// `daily_recurrence_warning` is `add_task`-only (spec §9): the
/// appended task carries a recurrence rule AND the target was a daily
/// note — the documented anti-pattern (each daily note accumulates its
/// own copies; recurring tasks belong in a stable note daily views
/// query). Advisory: the write succeeded, the UI toasts, never blocks.
/// `serde(default)` keeps older serialized results decodable.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PatchTaskResult {
    pub note_hash: crate::memo::MemoHash,
    pub task: TaskDto,
    pub spawned: Option<TaskDto>,
    #[serde(default)]
    pub daily_recurrence_warning: bool,
}

/// Where `Vault::add_task` appends a new task line (spec §6/§7).
#[derive(Debug, Clone, PartialEq)]
pub enum AddTarget {
    Note(crate::memo::MemoId),
    Daily(Date),
    Inbox,
}

/// Atomic task-subtree move request (spec §7): all `tasks` must belong
/// to `source` and pass their line-hash guards against the freshly-read
/// source body. `expected_destination_hash`, when supplied, protects
/// the destination from a stale drag/drop view.
#[derive(Debug, Clone)]
pub struct MoveTasksRequest {
    pub source: crate::memo::MemoId,
    pub tasks: Vec<TaskRef>,
    pub destination: AddTarget,
    pub expected_destination_hash: Option<crate::memo::MemoHash>,
}

/// Proof of a successful `Vault::move_tasks`, sufficient for guarded
/// `undo_move_tasks`: undo only proceeds while both post-move hashes
/// still match, so it never erases an intervening edit.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MoveTasksReceipt {
    pub source: crate::memo::MemoId,
    pub destination: crate::memo::MemoId,
    pub source_pre_hash: crate::memo::MemoHash,
    pub source_post_hash: crate::memo::MemoHash,
    pub destination_pre_hash: Option<crate::memo::MemoHash>,
    pub destination_post_hash: crate::memo::MemoHash,
    pub moved_lines: Vec<String>,
}

pub const MAX_TASKS_PER_NOTE: usize = 1000;

/// Field token spans within one raw line, byte-offset ranges into that
/// line's `&str`. Used by `transform_task_draft` (Task 4/5) to splice
/// exactly the recognized token, preserving every other byte untouched.
/// Not serialized; internal to this module. Has no `global_filter` span:
/// this parser has no visibility into vault config, so
/// `transform_task_draft` locates the configured filter token itself
/// when it needs to (`SetText`'s reconstruction).
#[derive(Debug, Clone, Default)]
pub(crate) struct LineSpans {
    pub checkbox: std::ops::Range<usize>,
    pub fields: Vec<(TaskField, std::ops::Range<usize>)>,
}

pub(crate) struct TaskRowFields {
    symbol: char,
    pub(crate) status_type: StatusType,
    text: String,
    tags: Vec<String>,
    created: Option<Date>,
    start: Option<Date>,
    scheduled: Option<Date>,
    due: Option<Date>,
    done: Option<Date>,
    cancelled: Option<Date>,
    priority: Priority,
    recurrence: Option<String>,
    warnings: Vec<TaskWarning>,
}

const EMOJI_CREATED: char = '➕';
const EMOJI_START: char = '🛫';
const EMOJI_SCHEDULED: char = '⏳';
const EMOJI_DUE: char = '📅';
const EMOJI_DONE: char = '✅';
const EMOJI_CANCELLED: char = '❌';
const EMOJI_RECURRENCE: char = '🔁';
const VARIATION_SELECTOR_16: char = '\u{FE0F}';
const NBSP: char = '\u{00A0}';

fn date_emoji_field(c: char) -> Option<TaskField> {
    match c {
        EMOJI_CREATED => Some(TaskField::Created),
        EMOJI_START => Some(TaskField::Start),
        EMOJI_SCHEDULED => Some(TaskField::Scheduled),
        EMOJI_DUE => Some(TaskField::Due),
        EMOJI_DONE => Some(TaskField::Done),
        EMOJI_CANCELLED => Some(TaskField::Cancelled),
        _ => None,
    }
}

fn priority_emoji(c: char) -> Option<Priority> {
    match c {
        '🔺' => Some(Priority::Highest),
        '⏫' => Some(Priority::High),
        '🔼' => Some(Priority::Medium),
        '🔽' => Some(Priority::Low),
        '⏬' => Some(Priority::Lowest),
        _ => None,
    }
}

fn dataview_key(key: &str) -> Option<TaskField> {
    match key {
        "created" => Some(TaskField::Created),
        "start" => Some(TaskField::Start),
        "scheduled" => Some(TaskField::Scheduled),
        "due" => Some(TaskField::Due),
        "completion" => Some(TaskField::Done),
        "cancelled" => Some(TaskField::Cancelled),
        "priority" => Some(TaskField::Priority),
        "repeat" => Some(TaskField::Recurrence),
        _ => None,
    }
}

fn parse_priority_word(s: &str) -> Option<Priority> {
    match s.trim().to_ascii_lowercase().as_str() {
        "highest" => Some(Priority::Highest),
        "high" => Some(Priority::High),
        "medium" => Some(Priority::Medium),
        "low" => Some(Priority::Low),
        "lowest" => Some(Priority::Lowest),
        _ => None,
    }
}

/// Hand-rolled strict `YYYY-MM-DD` parser (spec §1: date-only, local).
/// Avoids depending on `time`'s format-description macro API surface.
fn parse_date_yyyy_mm_dd(s: &str) -> Option<Date> {
    let s = s.trim();
    let bytes = s.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    if !bytes[0..4].iter().all(u8::is_ascii_digit)
        || !bytes[5..7].iter().all(u8::is_ascii_digit)
        || !bytes[8..10].iter().all(u8::is_ascii_digit)
    {
        return None;
    }
    let year: i32 = s[0..4].parse().ok()?;
    let month: u8 = s[5..7].parse().ok()?;
    let day: u8 = s[8..10].parse().ok()?;
    let month = time::Month::try_from(month).ok()?;
    Date::from_calendar_date(year, month, day).ok()
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Remove `#tag` runs (word-boundary rule matching `crate::tags`) from
/// `s`, returning the remainder. Tag *values* are computed separately via
/// `crate::tags::extract_tags` before this strips them from display text.
fn strip_tag_spans(s: &str) -> String {
    remove_ranges(s, &find_tag_spans(s))
}

/// Collapse runs of Unicode whitespace (including NBSP) to single ASCII
/// spaces and trim the ends. Used after span removal, which otherwise
/// leaves gaps.
fn collapse_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Delete `ranges` (byte ranges into `s`, possibly unsorted) and return
/// the remaining bytes joined back into a `String`.
fn remove_ranges(s: &str, ranges: &[std::ops::Range<usize>]) -> String {
    let mut sorted: Vec<std::ops::Range<usize>> = ranges.to_vec();
    sorted.sort_by_key(|r| r.start);
    let mut out = String::with_capacity(s.len());
    let mut cursor = 0usize;
    for r in sorted {
        let start = r.start.max(cursor);
        if start > cursor {
            out.push_str(&s[cursor..start]);
        }
        cursor = cursor.max(r.end);
    }
    if cursor < s.len() {
        out.push_str(&s[cursor..]);
    }
    out
}

/// Mutable scan state accumulated while walking one task line's content.
/// Owns rightmost-valid-wins duplicate resolution (spec §1).
struct ScanState {
    created: Option<Date>,
    start: Option<Date>,
    scheduled: Option<Date>,
    due: Option<Date>,
    done: Option<Date>,
    cancelled: Option<Date>,
    priority: Priority,
    recurrence: Option<String>,
    valid_seen: std::collections::HashSet<TaskField>,
    warnings: Vec<TaskWarning>,
    field_spans: Vec<(TaskField, std::ops::Range<usize>)>,
}

impl ScanState {
    fn new() -> Self {
        Self {
            created: None,
            start: None,
            scheduled: None,
            due: None,
            done: None,
            cancelled: None,
            priority: Priority::default(),
            recurrence: None,
            valid_seen: std::collections::HashSet::new(),
            warnings: Vec::new(),
            field_spans: Vec::new(),
        }
    }

    fn set_date(
        &mut self,
        field: TaskField,
        raw_token: &str,
        value: Option<Date>,
        range: std::ops::Range<usize>,
    ) {
        match value {
            Some(d) => {
                if self.valid_seen.contains(&field) {
                    self.warnings.push(TaskWarning {
                        field: Some(field),
                        raw: raw_token.to_string(),
                        kind: TaskWarningKind::Duplicate,
                    });
                }
                self.valid_seen.insert(field);
                match field {
                    TaskField::Created => self.created = Some(d),
                    TaskField::Start => self.start = Some(d),
                    TaskField::Scheduled => self.scheduled = Some(d),
                    TaskField::Due => self.due = Some(d),
                    TaskField::Done => self.done = Some(d),
                    TaskField::Cancelled => self.cancelled = Some(d),
                    _ => {}
                }
            }
            None => {
                self.warnings.push(TaskWarning {
                    field: Some(field),
                    raw: raw_token.to_string(),
                    kind: TaskWarningKind::InvalidValue,
                });
            }
        }
        self.field_spans.push((field, range));
    }

    fn set_priority(
        &mut self,
        raw_token: &str,
        value: Option<Priority>,
        range: std::ops::Range<usize>,
    ) {
        match value {
            Some(p) => {
                if self.valid_seen.contains(&TaskField::Priority) {
                    self.warnings.push(TaskWarning {
                        field: Some(TaskField::Priority),
                        raw: raw_token.to_string(),
                        kind: TaskWarningKind::Duplicate,
                    });
                }
                self.valid_seen.insert(TaskField::Priority);
                self.priority = p;
            }
            None => {
                self.warnings.push(TaskWarning {
                    field: Some(TaskField::Priority),
                    raw: raw_token.to_string(),
                    kind: TaskWarningKind::InvalidValue,
                });
            }
        }
        self.field_spans.push((TaskField::Priority, range));
    }

    fn set_recurrence(
        &mut self,
        raw_token: &str,
        value: Option<String>,
        range: std::ops::Range<usize>,
    ) {
        match value {
            Some(v) => {
                if self.valid_seen.contains(&TaskField::Recurrence) {
                    self.warnings.push(TaskWarning {
                        field: Some(TaskField::Recurrence),
                        raw: raw_token.to_string(),
                        kind: TaskWarningKind::Duplicate,
                    });
                }
                self.valid_seen.insert(TaskField::Recurrence);
                self.recurrence = Some(v);
            }
            None => {
                self.warnings.push(TaskWarning {
                    field: Some(TaskField::Recurrence),
                    raw: raw_token.to_string(),
                    kind: TaskWarningKind::InvalidValue,
                });
            }
        }
        self.field_spans.push((TaskField::Recurrence, range));
    }
}

/// Recognize a list marker (`-`,`*`,`+`, or `N.`/`N)`) followed by one
/// space, then a `[<char>]` checkbox followed by one space (or end of
/// line). Returns the byte offset (relative to `after_indent`) where the
/// task's content begins, and the checkbox symbol.
fn recognize_checkbox_prefix(after_indent: &str) -> Option<(usize, char)> {
    let mut chars = after_indent.char_indices();
    let (_, c0) = chars.next()?;
    let marker_len = if matches!(c0, '-' | '*' | '+') {
        c0.len_utf8()
    } else if c0.is_ascii_digit() {
        let mut len = c0.len_utf8();
        let mut saw_delim = false;
        for (idx, c) in chars {
            if c.is_ascii_digit() {
                len = idx + c.len_utf8();
                continue;
            }
            if c == '.' || c == ')' {
                len = idx + c.len_utf8();
                saw_delim = true;
            }
            break;
        }
        if !saw_delim {
            return None;
        }
        len
    } else {
        return None;
    };
    let rest = after_indent.get(marker_len..)?;
    let rest = rest.strip_prefix(' ')?;
    let rest = rest.strip_prefix('[')?;
    let mut rest_chars = rest.chars();
    let sym = rest_chars.next()?;
    let rest = rest_chars.as_str();
    let rest = rest.strip_prefix(']')?;
    let content_start = if let Some(stripped) = rest.strip_prefix(' ') {
        after_indent.len() - stripped.len()
    } else if rest.is_empty() {
        after_indent.len()
    } else {
        return None;
    };
    Some((content_start, sym))
}

/// Scan a task line's content (the text after the checkbox) for
/// recognized field tokens, honoring inline-code and link-destination
/// exclusion (spec §1). `content_base` is `content`'s absolute byte
/// offset within the original raw line, so recorded spans are directly
/// usable against that raw line.
fn scan_content(content: &str, content_base: usize, state: &mut ScanState) {
    let len = content.len();
    let mut i = 0usize;
    let mut in_code = false;
    while i < len {
        let rest = &content[i..];
        let Some(ch) = rest.chars().next() else { break };

        if ch == '`' {
            in_code = !in_code;
            i += 1;
            continue;
        }
        if in_code {
            i += ch.len_utf8();
            continue;
        }
        if let Some(after_link) = rest.strip_prefix("](")
            && let Some(close_rel) = after_link.find(')')
        {
            i += 2 + close_rel + 1;
            continue;
        }
        if ch == '['
            && let Some(colon_pos) = rest[1..].find("::")
        {
            let after_bracket = &rest[1..];
            let key = &after_bracket[..colon_pos];
            if !key.is_empty()
                && key.chars().all(|c| c.is_ascii_alphabetic())
                && let Some(field) = dataview_key(key)
                && let Some(close_rel) = after_bracket[colon_pos + 2..].find(']')
            {
                let after_colons = &after_bracket[colon_pos + 2..];
                let value_raw = after_colons[..close_rel].trim();
                let token_len = 1 + colon_pos + 2 + close_rel + 1;
                let token_range = (content_base + i)..(content_base + i + token_len);
                match field {
                    TaskField::Priority => {
                        let parsed = parse_priority_word(value_raw);
                        state.set_priority(value_raw, parsed, token_range);
                    }
                    TaskField::Recurrence => {
                        let val = value_raw.to_ascii_lowercase().starts_with("every");
                        state.set_recurrence(
                            value_raw,
                            val.then(|| value_raw.to_string()),
                            token_range,
                        );
                    }
                    _ => {
                        let parsed = parse_date_yyyy_mm_dd(value_raw);
                        state.set_date(field, value_raw, parsed, token_range);
                    }
                }
                i += token_len;
                continue;
            }
        }
        if let Some(field) = date_emoji_field(ch) {
            let marker_len = ch.len_utf8();
            let mut after = &rest[marker_len..];
            if let Some(stripped) = after.strip_prefix(VARIATION_SELECTOR_16) {
                after = stripped;
            }
            let sep_len: usize = after
                .chars()
                .take_while(|&c| c == ' ' || c == NBSP)
                .map(char::len_utf8)
                .sum();
            let after_sep = &after[sep_len..];
            let value_len = after_sep
                .find(|c: char| c.is_whitespace())
                .unwrap_or(after_sep.len());
            let value_raw = &after_sep[..value_len];
            let parsed = parse_date_yyyy_mm_dd(value_raw);
            let consumed = rest.len() - after_sep.len() + value_len;
            let token_len = consumed.max(marker_len);
            let token_range = (content_base + i)..(content_base + i + token_len);
            state.set_date(field, value_raw, parsed, token_range);
            i += token_len;
            continue;
        }
        if let Some(p) = priority_emoji(ch) {
            let mut total_len = ch.len_utf8();
            if rest[total_len..].starts_with(VARIATION_SELECTOR_16) {
                total_len += VARIATION_SELECTOR_16.len_utf8();
            }
            let token_range = (content_base + i)..(content_base + i + total_len);
            state.set_priority(&rest[..total_len], Some(p), token_range);
            i += total_len;
            continue;
        }
        if ch == EMOJI_RECURRENCE {
            let marker_len = ch.len_utf8();
            let mut after = &rest[marker_len..];
            if let Some(stripped) = after.strip_prefix(VARIATION_SELECTOR_16) {
                after = stripped;
            }
            let sep_len: usize = after
                .chars()
                .take_while(|&c| c == ' ' || c == NBSP)
                .map(char::len_utf8)
                .sum();
            let after_sep = &after[sep_len..];
            let value_len = after_sep
                .char_indices()
                .find_map(|(idx, c)| {
                    if c == '['
                        || date_emoji_field(c).is_some()
                        || priority_emoji(c).is_some()
                        || c == EMOJI_RECURRENCE
                    {
                        Some(idx)
                    } else {
                        None
                    }
                })
                .unwrap_or(after_sep.len());
            let value_raw = after_sep[..value_len].trim_end();
            let token_len = rest.len() - after_sep.len() + value_raw.len();
            let val = value_raw.to_ascii_lowercase().starts_with("every");
            let token_range = (content_base + i)..(content_base + i + token_len);
            state.set_recurrence(value_raw, val.then(|| value_raw.to_string()), token_range);
            // Continue past the recurrence token so any later emoji
            // (e.g. a done/cancelled token spliced in by
            // transform_task_draft AFTER the recurrence) is still
            i += token_len;
            continue;
        }
        i += ch.len_utf8();
    }
}

/// Tab-aware indentation column count (a tab advances to the next
/// multiple of four columns; spec §1).
pub(crate) fn indent_columns_of(raw: &str) -> u16 {
    let mut cols: u16 = 0;
    for ch in raw.chars() {
        match ch {
            ' ' => cols += 1,
            '\t' => cols = (cols / 4 + 1) * 4,
            _ => break,
        }
    }
    cols
}

/// Parse one already-fence-excluded, already-indent-classified raw line
/// as a task list item. Returns `None` if the line is not a checkbox list
/// item at all. `NON_TASK`-typed symbols per spec §2 still return
/// `Some` (with `StatusType::NonTask`) — `parse_tasks` is the one that
/// excludes those from `IndexRecord.tasks`.
pub(crate) fn parse_task_line(
    raw: &str,
    eff: &EffectiveStatuses,
) -> Option<(TaskRowFields, LineSpans)> {
    let trimmed_start = raw.trim_start_matches([' ', '\t']);
    let indent_bytes = raw.len() - trimmed_start.len();
    let (content_rel_start, sym) = recognize_checkbox_prefix(trimmed_start)?;
    let checkbox_range = indent_bytes..(indent_bytes + content_rel_start);
    let content = &trimmed_start[content_rel_start..];
    let content_base = indent_bytes + content_rel_start;

    let (_, _next, status_type) = eff.get(sym);
    let normalized_symbol = if sym == 'X' { 'x' } else { sym };

    let mut state = ScanState::new();
    scan_content(content, content_base, &mut state);

    let removal_ranges: Vec<std::ops::Range<usize>> = state
        .field_spans
        .iter()
        .map(|(_, r)| (r.start - content_base)..(r.end - content_base))
        .collect();
    let after_fields = collapse_whitespace(&remove_ranges(content, &removal_ranges));
    let tags = crate::tags::extract_tags(&after_fields);
    let text = collapse_whitespace(&strip_tag_spans(&after_fields));

    let fields = TaskRowFields {
        symbol: normalized_symbol,
        status_type,
        text,
        tags,
        created: state.created,
        start: state.start,
        scheduled: state.scheduled,
        due: state.due,
        done: state.done,
        cancelled: state.cancelled,
        priority: state.priority,
        recurrence: state.recurrence,
        warnings: state.warnings,
    };
    let spans = LineSpans {
        checkbox: checkbox_range,
        fields: state.field_spans,
    };
    Some((fields, spans))
}

/// ATX heading recognition (`#`..`######`, spec-adjacent CommonMark
/// subset sufficient for `section` tracking).
fn parse_atx_heading(trimmed: &str) -> Option<String> {
    let hashes = trimmed.chars().take_while(|&c| c == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = &trimmed[hashes..];
    if !rest.is_empty() && !rest.starts_with(' ') && !rest.starts_with('\t') {
        return None;
    }
    let text = rest
        .trim_start_matches([' ', '\t'])
        .trim_end_matches([' ', '\t', '#'])
        .to_string();
    Some(text)
}

/// Extract every extended-checkbox line from `body` into `TaskRow`s.
/// Pure; does not consult a `Vault`. CommonMark fence rules (backtick and
/// tilde, opener length, matching closer, up to three leading spaces) and
/// 4-space indented code both exclude task-like text inside them (spec
/// §3). Enforces `MAX_TASKS_PER_NOTE` and reports `truncated`.
pub fn parse_tasks(body: &str, cfg: &TasksConfig) -> ParsedTasks {
    let eff = cfg.effective_statuses().unwrap_or_else(|_| {
        TasksConfig::default()
            .effective_statuses()
            .expect("default statuses are always valid")
    });

    let mut fence: Option<(u8, usize)> = None;
    let mut section: Option<String> = None;
    let mut stack: Vec<(u16, u32)> = Vec::new();
    let mut tasks: Vec<TaskRow> = Vec::new();
    let mut truncated = false;

    for (i, raw_line) in body.lines().enumerate() {
        let line_no = i as u32;
        let leading_spaces = raw_line.len() - raw_line.trim_start_matches(' ').len();

        if leading_spaces <= 3 {
            let trimmed = &raw_line[leading_spaces..];
            if let Some(fence_char) = trimmed.chars().next()
                && (fence_char == '`' || fence_char == '~')
            {
                let run_len = trimmed.chars().take_while(|&c| c == fence_char).count();
                if run_len >= 3 {
                    match fence {
                        None => {
                            fence = Some((fence_char as u8, run_len));
                            continue;
                        }
                        Some((fc, flen))
                            if fc == fence_char as u8
                                && run_len >= flen
                                && trimmed[run_len..].trim().is_empty() =>
                        {
                            fence = None;
                            continue;
                        }
                        _ => {}
                    }
                }
            }
        }
        if fence.is_some() {
            continue;
        }

        let indent_columns = indent_columns_of(raw_line);
        if stack.is_empty() && indent_columns >= 4 {
            continue;
        }

        if leading_spaces <= 3 {
            let trimmed = &raw_line[leading_spaces..];
            if let Some(heading_text) = parse_atx_heading(trimmed) {
                section = Some(heading_text);
                continue;
            }
        }

        let Some((mut fields, _spans)) = parse_task_line(raw_line, &eff) else {
            continue;
        };

        if !cfg.global_filter.is_empty() {
            if !raw_line.contains(cfg.global_filter.as_str()) {
                continue;
            }
            if let Some(pos) = fields.text.find(cfg.global_filter.as_str()) {
                fields
                    .text
                    .replace_range(pos..pos + cfg.global_filter.len(), "");
                fields.text = collapse_whitespace(&fields.text);
            }
            if let Some(bare) = cfg.global_filter.strip_prefix('#')
                && let Some(normalized) = crate::tags::extract_tags(&format!("#{bare}"))
                    .into_iter()
                    .next()
            {
                fields.tags.retain(|t| t != &normalized);
            }
        }

        if fields.status_type == StatusType::NonTask {
            continue;
        }

        if tasks.len() >= MAX_TASKS_PER_NOTE {
            truncated = true;
            continue;
        }

        while let Some(&(top_ic, _)) = stack.last() {
            if top_ic >= indent_columns {
                stack.pop();
            } else {
                break;
            }
        }
        let parent = stack.last().map(|&(_, ln)| ln);
        stack.push((indent_columns, line_no));

        tasks.push(TaskRow {
            line: line_no,
            indent_columns,
            parent,
            symbol: fields.symbol,
            status_type: fields.status_type,
            text: fields.text,
            tags: fields.tags,
            section: section.clone(),
            created: fields.created,
            start: fields.start,
            scheduled: fields.scheduled,
            due: fields.due,
            done: fields.done,
            cancelled: fields.cancelled,
            priority: fields.priority,
            recurrence: fields.recurrence,
            warnings: fields.warnings,
            line_hash: TaskLineHash::of_line(raw_line),
        });
    }

    ParsedTasks { tasks, truncated }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct TaskFields {
    pub created: Option<Date>,
    pub start: Option<Date>,
    pub scheduled: Option<Date>,
    pub due: Option<Date>,
    pub priority: Priority,
    pub recurrence: Option<String>,
    pub tags: Vec<String>,
}

fn format_date_yyyy_mm_dd(d: Date) -> String {
    format!("{:04}-{:02}-{:02}", d.year(), u8::from(d.month()), d.day())
}

fn priority_emoji_char(p: Priority) -> Option<char> {
    match p {
        Priority::Highest => Some('🔺'),
        Priority::High => Some('⏫'),
        Priority::Medium => Some('🔼'),
        Priority::Low => Some('🔽'),
        Priority::Lowest => Some('⏬'),
        Priority::None => None,
    }
}

fn priority_dataview_word(p: Priority) -> Option<&'static str> {
    match p {
        Priority::Highest => Some("highest"),
        Priority::High => Some("high"),
        Priority::Medium => Some("medium"),
        Priority::Low => Some("low"),
        Priority::Lowest => Some("lowest"),
        Priority::None => None,
    }
}

/// Render a brand-new task line (spec §1/§11). Appends the configured
/// non-empty `global_filter` token. Rejects `text` containing `\n` or
/// `\0` (spec §5: `SetText` and `global_filter` reject newline and NUL).
pub fn render_new_task(text: &str, fields: &TaskFields, cfg: &TasksConfig) -> Result<String> {
    if text.contains('\n') || text.contains('\0') {
        return Err(CoreError::InvalidTasksConfig(
            "task text must not contain newline or NUL".into(),
        ));
    }
    let mut line = String::from("- [ ] ");
    line.push_str(text);
    for tag in &fields.tags {
        line.push_str(" #");
        line.push_str(tag);
    }
    if !cfg.global_filter.is_empty() {
        line.push(' ');
        line.push_str(&cfg.global_filter);
    }

    let date_fields: [(TaskField, Option<Date>); 4] = [
        (TaskField::Created, fields.created),
        (TaskField::Start, fields.start),
        (TaskField::Scheduled, fields.scheduled),
        (TaskField::Due, fields.due),
    ];
    for (field, value) in date_fields {
        if let Some(d) = value {
            line.push(' ');
            line.push_str(&format_date_field_token(field, d, cfg.write_format));
        }
    }

    if let Some(token) = format_priority_token(fields.priority, cfg.write_format) {
        line.push(' ');
        line.push_str(&token);
    }

    if let Some(rule) = &fields.recurrence {
        line.push(' ');
        line.push_str(&format_recurrence_token(rule, cfg.write_format));
    }

    Ok(line)
}

/// Map a `TaskEdit::SetDate` target to the corresponding recognized
/// field (the two enums share the same date-field variant set).
fn date_field_to_task_field(f: DateField) -> TaskField {
    match f {
        DateField::Created => TaskField::Created,
        DateField::Start => TaskField::Start,
        DateField::Scheduled => TaskField::Scheduled,
        DateField::Due => TaskField::Due,
        DateField::Done => TaskField::Done,
        DateField::Cancelled => TaskField::Cancelled,
    }
}

fn task_field_date_emoji(field: TaskField) -> char {
    match field {
        TaskField::Created => EMOJI_CREATED,
        TaskField::Start => EMOJI_START,
        TaskField::Scheduled => EMOJI_SCHEDULED,
        TaskField::Due => EMOJI_DUE,
        TaskField::Done => EMOJI_DONE,
        TaskField::Cancelled => EMOJI_CANCELLED,
        TaskField::Priority | TaskField::Recurrence => {
            unreachable!("task_field_date_emoji called with a non-date field")
        }
    }
}

fn task_field_dataview_key(field: TaskField) -> &'static str {
    match field {
        TaskField::Created => "created",
        TaskField::Start => "start",
        TaskField::Scheduled => "scheduled",
        TaskField::Due => "due",
        TaskField::Done => "completion",
        TaskField::Cancelled => "cancelled",
        TaskField::Priority | TaskField::Recurrence => {
            unreachable!("task_field_dataview_key called with a non-date field")
        }
    }
}

/// Format one date field's token (spec §1 field table), shared by
/// `render_new_task` and `transform_task_draft` so both produce
/// identical bytes for the same field/value/format (no duplicated
/// formatting logic per spec §5/§6).
fn format_date_field_token(field: TaskField, d: Date, fmt: WriteFormat) -> String {
    let rendered = format_date_yyyy_mm_dd(d);
    match fmt {
        WriteFormat::Emoji => format!("{} {}", task_field_date_emoji(field), rendered),
        WriteFormat::Dataview => format!("[{}:: {}]", task_field_dataview_key(field), rendered),
    }
}

/// Format the priority token, or `None` for `Priority::None` (no token
/// emitted). Shared by `render_new_task` and `transform_task_draft`.
fn format_priority_token(p: Priority, fmt: WriteFormat) -> Option<String> {
    match fmt {
        WriteFormat::Emoji => priority_emoji_char(p).map(String::from),
        WriteFormat::Dataview => priority_dataview_word(p).map(|w| format!("[priority:: {w}]")),
    }
}

/// Format the recurrence token. Shared by `render_new_task` and
/// `transform_task_draft`.
fn format_recurrence_token(rule: &str, fmt: WriteFormat) -> String {
    match fmt {
        WriteFormat::Emoji => format!("{EMOJI_RECURRENCE} {rule}"),
        WriteFormat::Dataview => format!("[repeat:: {rule}]"),
    }
}

/// Strip exactly `cols` leading columns from `raw`, advancing a tab to
/// the next multiple of four (matching `indent_columns_of`). A tab
/// straddling the cut boundary becomes the leftover columns as spaces
/// (so the surviving line keeps its column position visually
/// continuous). Removing more columns than present consumes all
/// leading whitespace and returns the rest of the line untouched.
pub(crate) fn dedent_line(raw: &str, cols: u16) -> String {
    if cols == 0 {
        return raw.to_string();
    }
    let mut remaining = cols;
    let mut consumed = 0usize;
    let bytes = raw.as_bytes();
    let len = bytes.len();
    let mut i = 0usize;
    while remaining > 0 && i < len {
        let b = bytes[i];
        if b == b' ' {
            remaining -= 1;
            consumed += 1;
            i += 1;
        } else if b == b'\t' {
            let cols_before = cols - remaining;
            let next_boundary = cols_before / 4 * 4 + 4;
            let tab_width = next_boundary - cols_before;
            if tab_width <= remaining {
                remaining -= tab_width;
                consumed += 1;
                i += 1;
            } else {
                let leftover = remaining as usize;
                let mut out = String::with_capacity(raw.len() - consumed + leftover);
                out.push_str(&raw[..consumed]);
                for _ in 0..leftover {
                    out.push(' ');
                }
                out.push_str(&raw[i + 1..]);
                return out;
            }
        } else {
            break;
        }
    }
    String::from(&raw[consumed..])
}

/// Parse the supported subset of a recurrence rule string
/// (`"every" [N] unit ["when" "done"]`) into a `DurationSpec` and a
/// `when_done` flag. Tokens MUST be lowercase; any other shape (extra
/// tokens, unrecognized unit, missing "every") returns `None` so the
/// caller skips the spawn but still applies the status change.
fn parse_recurrence_spec(rule: &str) -> Option<(DurationSpec, bool)> {
    let trimmed = rule.trim();
    let lower = trimmed.to_ascii_lowercase();
    let mut tokens: Vec<&str> = lower.split_whitespace().collect();
    if tokens.is_empty() || tokens[0] != "every" {
        return None;
    }
    let when_done = if tokens.len() >= 3
        && tokens[tokens.len() - 2] == "when"
        && tokens[tokens.len() - 1] == "done"
    {
        tokens.truncate(tokens.len() - 2);
        true
    } else {
        false
    };
    let rest = &tokens[1..];
    let (n, unit): (i64, &str) = if rest.len() == 1 {
        (1, rest[0])
    } else if rest.len() == 2 {
        let n: i64 = rest[0].parse().ok()?;
        if n <= 0 {
            return None;
        }
        (n, rest[1])
    } else {
        return None;
    };
    let day_ms: i64 = 86_400_000;
    let dur = match unit {
        "day" | "days" => DurationSpec {
            calendar_months: 0,
            fixed_millis: n * day_ms,
        },
        "week" | "weeks" => DurationSpec {
            calendar_months: 0,
            fixed_millis: n * 7 * day_ms,
        },
        "month" | "months" => DurationSpec {
            calendar_months: n.try_into().ok()?,
            fixed_millis: 0,
        },
        "year" | "years" => DurationSpec {
            calendar_months: (n * 12).try_into().ok()?,
            fixed_millis: 0,
        },
        _ => return None,
    };
    Some((dur, when_done))
}

/// Shift a `Date` by a `time::Duration` (alias for `SignedDuration`),
/// using UTC midnight as the carrier instant so date-only arithmetic
/// doesn't accidentally trip DST offsets.
fn shift_date(d: Date, delta: time::Duration) -> Date {
    (d.midnight().assume_utc() + delta).date()
}

/// Byte ranges (relative to `s`) of every `#tag` run (word-boundary rule
/// matching `crate::tags`). Used both to strip tags from extracted
/// description text (`strip_tag_spans`) and, in
/// `transform_task_draft`'s `SetText` arm, to preserve tag bytes
/// verbatim while replacing only the free-text description.
fn find_tag_spans(s: &str) -> Vec<std::ops::Range<usize>> {
    let chars: Vec<(usize, char)> = s.char_indices().collect();
    let mut spans = Vec::new();
    let mut i = 0usize;
    while i < chars.len() {
        let (byte_idx, c) = chars[i];
        if c == '#' {
            let prev_is_word = i > 0 && is_word_char(chars[i - 1].1);
            if !prev_is_word {
                let mut j = i + 1;
                while j < chars.len() && is_word_char(chars[j].1) {
                    j += 1;
                }
                if j > i + 1 {
                    let end_byte = if j < chars.len() { chars[j].0 } else { s.len() };
                    spans.push(byte_idx..end_byte);
                    i = j;
                    continue;
                }
            }
        }
        i += 1;
    }
    spans
}

/// Sort and merge overlapping/adjacent byte ranges.
fn merge_ranges(ranges: &[std::ops::Range<usize>]) -> Vec<std::ops::Range<usize>> {
    let mut sorted: Vec<std::ops::Range<usize>> = ranges.to_vec();
    sorted.sort_by_key(|r| r.start);
    let mut out: Vec<std::ops::Range<usize>> = Vec::new();
    for r in sorted {
        if let Some(last) = out.last_mut() {
            if r.start <= last.end {
                last.end = last.end.max(r.end);
                continue;
            }
        } else {
            out.push(r);
            continue;
        }
        out.push(r);
    }
    out
}

/// Remove every existing occurrence of `target`'s span from `raw`
/// (absolute byte ranges from `LineSpans::fields`), then append
/// `new_token` (if any) at the end of the line, separated by a single
/// space from whatever now precedes it. Every other byte on the line —
/// other fields, tags, description text, indentation — is left
/// untouched (spec §5: single-field splice).
fn splice_field(
    raw: &str,
    field_spans: &[(TaskField, std::ops::Range<usize>)],
    target: TaskField,
    new_token: Option<String>,
) -> String {
    splice_field_ops(raw, field_spans, &[(target, new_token)])
}

/// Batch variant of `splice_field`. All removals and appends are
/// computed against the ORIGINAL `raw`'s byte offsets in one pass, so
/// edits to one field never invalidate another field's range. Operations
/// are applied in the order given; the trailing token of each `Some`
/// op is appended (single-space separated from the surviving text) in
/// that order.
fn splice_field_ops(
    raw: &str,
    field_spans: &[(TaskField, std::ops::Range<usize>)],
    ops: &[(TaskField, Option<String>)],
) -> String {
    let mut remove: Vec<std::ops::Range<usize>> = Vec::new();
    for (target, _) in ops {
        let target = *target;
        for (_, r) in field_spans.iter().filter(|(f, _)| *f == target) {
            remove.push(r.clone());
        }
    }
    let mut new_line = remove_ranges(raw, &remove);
    for (_, token) in ops {
        if let Some(t) = token {
            if !new_line.is_empty() && !new_line.ends_with(' ') {
                new_line.push(' ');
            }
            new_line.push_str(t);
        }
    }
    new_line
}

fn single_line_change(line: u32, new_line: String) -> TaskDraftTransform {
    TaskDraftTransform {
        changes: vec![TaskLineChange {
            start_line: line,
            delete_lines: 1,
            insert_lines: vec![new_line],
        }],
        ..Default::default()
    }
}

/// Replace the checkbox symbol in `raw` with `new_symbol`. The
/// `spans.checkbox` range stays valid in any string produced by
/// date-only splices (which never touch bytes before the first field
/// span), so this is safe to call AFTER `splice_field` for Done or
/// Cancelled.
fn replace_symbol(raw: &str, spans: &LineSpans, new_symbol: char) -> Result<String> {
    let checkbox_str = &raw[spans.checkbox.clone()];
    let bracket_rel = checkbox_str
        .find('[')
        .ok_or_else(|| CoreError::other("transform_task_draft: checkbox span missing '['"))?;
    let sym_start = spans.checkbox.start + bracket_rel + 1;
    let raw_sym = checkbox_str[bracket_rel + 1..]
        .chars()
        .next()
        .ok_or_else(|| CoreError::other("transform_task_draft: checkbox span missing symbol"))?;
    let sym_end = sym_start + raw_sym.len_utf8();
    let mut new_line = String::with_capacity(raw.len());
    new_line.push_str(&raw[..sym_start]);
    new_line.push(new_symbol);
    new_line.push_str(&raw[sym_end..]);
    Ok(new_line)
}

/// A single non-terminal edit to one task line (spec §5). `Delete`'s
/// bounded-subtree dedent and the terminal-transition/recurrence-spawn
/// behavior of `Toggle`/`SetStatus` are implemented by Task 5; this enum
/// and `transform_task_draft` already model every variant.
#[derive(Debug, Clone, PartialEq)]
pub enum TaskEdit {
    Toggle,
    SetStatus(char),
    SetDate {
        field: DateField,
        value: Option<Date>,
    },
    SetPriority(Priority),
    SetText(String),
    SetRecurrence(Option<String>),
    Delete,
}

/// One non-overlapping edit to apply to a draft body: delete
/// `delete_lines` lines starting at `start_line` (0-based) and insert
/// `insert_lines` in their place. An empty `insert_lines` with
/// `delete_lines: 0` at some `start_line` is a pure insertion into the
/// gap before that line.
#[derive(Debug, Clone, PartialEq)]
pub struct TaskLineChange {
    pub start_line: u32,
    pub delete_lines: u32,
    pub insert_lines: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct TaskDraftTransform {
    pub changes: Vec<TaskLineChange>,
    /// The 0-based line, in the body AFTER applying `changes`, where a
    /// spawned recurrence occurrence landed — `None` when this edit did
    /// not spawn one. Lets callers (e.g. `Vault::patch_task`) look up
    /// the exact spawned `TaskRow` after re-parsing instead of
    /// heuristically guessing which row is new.
    pub spawned_line_hint: Option<u32>,
}

/// Pure transition/recurrence kernel (spec §5/§6/§7.1). Takes the full
/// unsaved draft body plus the target 0-based line, so it can see the
/// task's full subtree — required for `recurrence_insert = "below"`
/// (Task 5) to target the gap *after* the subtree rather than stealing
/// its children. Reads and writes no disk. Desktop calls this from the
/// CM6 editor (on the unsaved buffer) AND `Vault::patch_task` calls it
/// (on the freshly-read file body, under the exclusive lock) — one
/// implementation, two call sites (spec §5/§6 explicitly forbid
/// duplicating this logic).
pub fn transform_task_draft(
    body: &str,
    line: u32,
    edit: &TaskEdit,
    today: Date,
    cfg: &TasksConfig,
) -> Result<TaskDraftTransform> {
    if let TaskEdit::SetText(t) = edit
        && (t.contains('\n') || t.contains('\0'))
    {
        return Err(CoreError::InvalidTasksConfig(
            "task text must not contain newline or NUL".into(),
        ));
    }
    let eff = cfg.effective_statuses()?;
    let lines: Vec<&str> = body.lines().collect();
    let raw = *lines.get(line as usize).ok_or_else(|| {
        CoreError::other(format!("transform_task_draft: line {line} out of range"))
    })?;
    let Some((fields, spans)) = parse_task_line(raw, &eff) else {
        return Err(CoreError::other(format!(
            "transform_task_draft: line {line} is not a task line"
        )));
    };

    match edit {
        TaskEdit::Delete => {
            // Bounded-subtree dedent (Task 5, spec §5): scan forward for
            // children whose indent is strictly greater than the
            // deleted task's own; everything in that range gets
            // re-rooted at the deleted parent's indent. The delta is
            // computed once from the first child line so every
            // grandchild's depth stays consistent with its new
            // siblings' (preserves the tree).
            let deleted_indent = indent_columns_of(raw);
            let mut end = line as usize + 1;
            let first_child_indent = lines.get(end).map(|s| indent_columns_of(s)).unwrap_or(0);
            while let Some(next_raw) = lines.get(end) {
                if indent_columns_of(next_raw) <= deleted_indent {
                    break;
                }
                end += 1;
            }
            let delta = first_child_indent.saturating_sub(deleted_indent);
            let mut insert_lines = Vec::with_capacity(end.saturating_sub(line as usize));
            for raw_child in &lines[(line as usize + 1)..end] {
                insert_lines.push(dedent_line(raw_child, delta));
            }
            Ok(TaskDraftTransform {
                changes: vec![TaskLineChange {
                    start_line: line,
                    delete_lines: (end - line as usize) as u32,
                    insert_lines,
                }],
                ..Default::default()
            })
        }
        TaskEdit::Toggle | TaskEdit::SetStatus(_) => {
            // Terminal-transition kernel (Task 5, spec §5/§6):
            //   old == new : symbol splice only.
            //   entering Done : stamp done=today + cross-clear
            //                   cancelled + optional spawn.
            //   entering Cancelled : mirror of Done, NEVER spawn.
            //   leaving terminal : clear the corresponding date field
            //                     only.
            // Date splices are applied FIRST on `raw` (spans are
            // relative to it), then the symbol is replaced into the
            // result using the original checkbox offset — bytes before
            // any field span are unchanged by the splices, so the
            // sym range remains valid.
            let new_symbol = match edit {
                TaskEdit::Toggle => eff.get(fields.symbol).1,
                TaskEdit::SetStatus(c) => *c,
                _ => unreachable!(),
            };
            if matches!(new_symbol, '\n' | '\r' | '\0' | '[' | ']') {
                return Err(CoreError::InvalidTasksConfig(
                    "status symbol must not be newline, NUL, or a bracket".into(),
                ));
            }
            let (_, _, new_type) = eff.get(new_symbol);
            let old_type = fields.status_type;
            let old_is_terminal = matches!(old_type, StatusType::Done | StatusType::Cancelled);
            let new_is_terminal = matches!(new_type, StatusType::Done | StatusType::Cancelled);
            if old_type == new_type {
                // Same-type transition (e.g. x -> X): splice only the
                // symbol; leave any date field untouched.
                let new_line = replace_symbol(raw, &spans, new_symbol)?;
                return Ok(single_line_change(line, new_line));
            }

            let mut line_buf = raw.to_string();
            let mut spawn_line: Option<String> = None;

            if new_is_terminal {
                let stamp_field = match new_type {
                    StatusType::Done => TaskField::Done,
                    StatusType::Cancelled => TaskField::Cancelled,
                    _ => unreachable!("new_is_terminal guarantees Done|Cancelled"),
                };
                let clear_field = match new_type {
                    StatusType::Done => TaskField::Cancelled,
                    StatusType::Cancelled => TaskField::Done,
                    _ => unreachable!(),
                };
                // Batch the stamp + cross-clear so both removals
                // resolve against the SAME `raw` offset space —
                // sequential splices on the mutated `line_buf` would
                // shift the second field's span if both Done and
                // Cancelled tokens existed in the source line and the
                // stamp's range was before the clear's range.
                let token = format_date_field_token(stamp_field, today, cfg.write_format);
                line_buf = splice_field_ops(
                    raw,
                    &spans.fields,
                    &[(stamp_field, Some(token)), (clear_field, None)],
                );

                // Spawn fires only on ENTERING Done from a non-terminal
                // type (spec §6).
                if new_type == StatusType::Done
                    && !old_is_terminal
                    && let Some(rule) = fields.recurrence.as_deref()
                    && let Some((dur, when_done)) = parse_recurrence_spec(rule)
                    && let Some(anchor) = fields.due.or(fields.scheduled).or(fields.start)
                {
                    let anchor_date = if when_done { today } else { anchor };
                    let new_anchor = crate::expr::value::date_add(
                        anchor_date.midnight().assume_utc(),
                        &dur,
                        1,
                        UtcOffset::UTC,
                    )
                    .date();
                    let delta = new_anchor - anchor;
                    let shift = |d: Date| shift_date(d, delta);
                    let spawned_fields = TaskFields {
                        created: fields.created,
                        start: fields.start.map(shift),
                        scheduled: fields.scheduled.map(shift),
                        due: fields.due.map(shift),
                        priority: fields.priority,
                        recurrence: fields.recurrence.clone(),
                        tags: fields.tags.clone(),
                    };
                    spawn_line = Some(render_new_task(&fields.text, &spawned_fields, cfg)?);
                }
            } else if old_is_terminal {
                // Leaving a terminal state: clear the OLD terminal
                // field's date only.
                let clear_field = match old_type {
                    StatusType::Done => TaskField::Done,
                    StatusType::Cancelled => TaskField::Cancelled,
                    _ => unreachable!("old_is_terminal guarantees Done|Cancelled"),
                };
                line_buf = splice_field(&line_buf, &spans.fields, clear_field, None);
            }

            let new_line = replace_symbol(&line_buf, &spans, new_symbol)?;

            match spawn_line {
                None => Ok(single_line_change(line, new_line)),
                Some(spawned) => match cfg.recurrence_insert {
                    RecurrenceInsert::Above => {
                        // Single change: replace line with
                        // [spawned, completed] so the spawned
                        // occurrence lands one line above.
                        Ok(TaskDraftTransform {
                            changes: vec![TaskLineChange {
                                start_line: line,
                                delete_lines: 1,
                                insert_lines: vec![spawned, new_line],
                            }],
                            spawned_line_hint: Some(line),
                        })
                    }
                    RecurrenceInsert::Below => {
                        // Two changes: replace toggled line with the

                        // completed version, and insert the spawned
                        // occurrence at the gap AFTER the full
                        // subtree (after children, before the next
                        // sibling — never stealing children).
                        let deleted_indent = indent_columns_of(raw);
                        let mut end = line as usize + 1;
                        while let Some(next_raw) = lines.get(end) {
                            if indent_columns_of(next_raw) <= deleted_indent {
                                break;
                            }
                            end += 1;
                        }
                        Ok(TaskDraftTransform {
                            changes: vec![
                                TaskLineChange {
                                    start_line: line,
                                    delete_lines: 1,
                                    insert_lines: vec![new_line],
                                },
                                TaskLineChange {
                                    start_line: end as u32,
                                    delete_lines: 0,
                                    insert_lines: vec![spawned],
                                },
                            ],
                            spawned_line_hint: Some(end as u32),
                        })
                    }
                },
            }
        }
        TaskEdit::SetDate { field, value } => {
            let target = date_field_to_task_field(*field);
            let token = value.map(|d| format_date_field_token(target, d, cfg.write_format));
            let new_line = splice_field(raw, &spans.fields, target, token);
            Ok(single_line_change(line, new_line))
        }
        TaskEdit::SetPriority(p) => {
            let token = format_priority_token(*p, cfg.write_format);
            let new_line = splice_field(raw, &spans.fields, TaskField::Priority, token);
            Ok(single_line_change(line, new_line))
        }
        TaskEdit::SetRecurrence(rule) => {
            let token = rule
                .as_ref()
                .map(|r| format_recurrence_token(r, cfg.write_format));
            let new_line = splice_field(raw, &spans.fields, TaskField::Recurrence, token);
            Ok(single_line_change(line, new_line))
        }
        TaskEdit::SetText(new_text) => {
            // Rebuild: prefix through the checkbox stays verbatim, then
            // the new description, then every preserved token (fields,
            // tags, global filter) in original order, single-space
            // separated. The global filter is preserved by SUBSTRING
            // occurrence (first match), mirroring `parse_tasks`'s
            // containment gating: with a non-tag filter that only
            // appears inside the old description, preserving those bytes
            // is what keeps the line matching the filter — dropping it
            // would silently remove the task from queries. A filter the
            // original line never had is NOT added (render_new_task is
            // the API that adds it on creation).
            let content_start = spans.checkbox.end;
            let content = &raw[content_start..];
            let tag_spans: Vec<std::ops::Range<usize>> = find_tag_spans(content)
                .into_iter()
                .map(|r| (r.start + content_start)..(r.end + content_start))
                .collect();
            let mut kept: Vec<std::ops::Range<usize>> =
                spans.fields.iter().map(|(_, r)| r.clone()).collect();
            kept.extend(tag_spans);
            if let Some(pos) = (!cfg.global_filter.is_empty())
                .then(|| content.find(cfg.global_filter.as_str()))
                .flatten()
            {
                let abs = (pos + content_start)..(pos + content_start + cfg.global_filter.len());
                kept.push(abs);
            }
            let kept = merge_ranges(&kept);
            let mut new_line = String::with_capacity(raw.len() + new_text.len());
            new_line.push_str(&raw[..content_start]);
            new_line.push_str(new_text);
            for r in &kept {
                new_line.push(' ');
                new_line.push_str(&raw[r.clone()]);
            }
            Ok(single_line_change(line, new_line))
        }
    }
}

/// Apply a `TaskDraftTransform`'s (or any set of) non-overlapping
/// `TaskLineChange`s to `body`, returning the resulting full text.
/// Changes are applied bottom-up (highest `start_line` first) so an
/// earlier change's `start_line` never shifts before it is processed.
/// Shared by `Vault::patch_task`/`add_task`/`move_tasks` (Tasks 8-10)
/// and the CM6 editor adapter's document-offset equivalent — one
/// implementation for the "how do TaskLineChanges apply" question
/// (spec §5/§6: no duplicated splice logic).
pub(crate) fn apply_line_changes_to_body(body: &str, changes: &[TaskLineChange]) -> String {
    let mut lines: Vec<String> = body.lines().map(str::to_string).collect();
    let mut sorted: Vec<&TaskLineChange> = changes.iter().collect();
    sorted.sort_by_key(|change| std::cmp::Reverse(change.start_line));
    for c in sorted {
        let start = c.start_line as usize;
        let end = start + c.delete_lines as usize;
        lines.splice(start..end, c.insert_lines.iter().cloned());
    }
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

/// Remove selected task refs whose nearest task ancestor is also
/// selected, returning the remaining subtree roots in source-line
/// order (spec §7). Uses the same indent-stack parent rule as
/// `parse_tasks`; callers verify every ref's line/hash before calling,
/// so this helper is deliberately pure and cannot name a `MemoId` in
/// an error.
pub(crate) fn dedup_covered_descendants(
    lines: &[&str],
    selected: &[TaskRef],
    eff: &EffectiveStatuses,
) -> Vec<TaskRef> {
    let selected_lines: std::collections::HashSet<u32> =
        selected.iter().map(|task| task.line).collect();
    let mut parents: std::collections::HashMap<u32, Option<u32>> = Default::default();
    let mut stack: Vec<(u16, u32)> = Vec::new();
    for (index, raw) in lines.iter().enumerate() {
        let line = index as u32;
        let Some((fields, _spans)) = parse_task_line(raw, eff) else {
            continue;
        };
        if fields.status_type == StatusType::NonTask {
            continue;
        }
        let indent = indent_columns_of(raw);
        while let Some(&(parent_indent, _)) = stack.last() {
            if parent_indent >= indent {
                stack.pop();
            } else {
                break;
            }
        }
        parents.insert(line, stack.last().map(|&(_, parent_line)| parent_line));
        stack.push((indent, line));
    }

    let mut roots: Vec<TaskRef> = selected
        .iter()
        .filter(|task| {
            let mut parent = parents.get(&task.line).copied().flatten();
            while let Some(line) = parent {
                if selected_lines.contains(&line) {
                    return false;
                }
                parent = parents.get(&line).copied().flatten();
            }
            true
        })
        .cloned()
        .collect();
    roots.sort_by_key(|task| task.line);
    roots.dedup_by_key(|task| task.line);
    roots
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Test-only thin wrapper: delegate to the real
    /// `apply_line_changes_to_body` so tests exercise the exact
    /// production splice logic instead of a parallel copy.
    fn apply_line_changes(body: &str, changes: &[TaskLineChange]) -> String {
        apply_line_changes_to_body(body, changes)
    }

    fn transform_single_line(body: &str, edit: TaskEdit) -> String {
        let c = cfg();
        let today = time::macros::date!(2026 - 08 - 27);
        let t = transform_task_draft(body, 0, &edit, today, &c).unwrap();
        apply_line_changes(body, &t.changes)
    }

    #[test]
    fn dedup_covered_descendants_keeps_only_outermost_selected_subtrees() {
        let body = "- [ ] parent\n  - [ ] child\n    - [ ] grandchild\n- [ ] sibling\n";
        let lines: Vec<&str> = body.lines().collect();
        let id = crate::memo::MemoId::now();
        let selected = vec![
            TaskRef {
                memo_id: id,
                line: 2,
                line_hash: TaskLineHash::of_line("    - [ ] grandchild"),
            },
            TaskRef {
                memo_id: id,
                line: 0,
                line_hash: TaskLineHash::of_line("- [ ] parent"),
            },
            TaskRef {
                memo_id: id,
                line: 1,
                line_hash: TaskLineHash::of_line("  - [ ] child"),
            },
            TaskRef {
                memo_id: id,
                line: 3,
                line_hash: TaskLineHash::of_line("- [ ] sibling"),
            },
        ];
        let eff = cfg().effective_statuses().unwrap();
        let roots = dedup_covered_descendants(&lines, &selected, &eff);
        assert_eq!(
            roots.iter().map(|task| task.line).collect::<Vec<_>>(),
            vec![0, 3]
        );
    }

    #[test]
    fn task_line_hash_is_16_lowercase_hex_chars() {
        let h = TaskLineHash::of_line("- [ ] buy milk 📅 2026-08-30");
        assert_eq!(h.0.len(), 16);
        assert!(
            h.0.chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        );
    }

    #[test]
    fn task_line_hash_is_stable_for_identical_bytes() {
        let a = TaskLineHash::of_line("- [ ] same line");
        let b = TaskLineHash::of_line("- [ ] same line");
        assert_eq!(a, b);
    }

    #[test]
    fn task_line_hash_changes_when_bytes_change() {
        let a = TaskLineHash::of_line("- [ ] same line");
        let b = TaskLineHash::of_line("- [x] same line");
        assert_ne!(a, b);
    }

    #[test]
    fn default_statuses_match_spec_table() {
        let cfg = TasksConfig::default();
        let eff = cfg.effective_statuses().expect("defaults are valid");
        assert_eq!(eff.get(' '), (None, 'x', StatusType::Todo));
        assert_eq!(eff.get('/'), (None, 'x', StatusType::InProgress));
        assert_eq!(eff.get('x'), (None, ' ', StatusType::Done));
        assert_eq!(eff.get('X'), eff.get('x'), "X normalizes to built-in x");
        assert_eq!(eff.get('-'), (None, ' ', StatusType::Cancelled));
    }

    #[test]
    fn unknown_symbol_degrades_to_unknown_todo() {
        let cfg = TasksConfig::default();
        let eff = cfg.effective_statuses().unwrap();
        let (name, next, ty) = eff.get('?');
        assert_eq!(name.as_deref(), Some("Unknown"));
        assert_eq!(next, 'x');
        assert_eq!(ty, StatusType::Todo);
    }

    #[test]
    fn duplicate_symbols_after_x_normalization_are_rejected() {
        let mut cfg = TasksConfig::default();
        cfg.statuses.push(TaskStatusDef {
            symbol: "x".into(),
            name: Some("Custom done".into()),
            next: " ".into(),
            r#type: StatusType::Done,
        });
        // "X" normalizes onto the configured "x" above — a true duplicate.
        cfg.statuses.push(TaskStatusDef {
            symbol: "X".into(),
            name: None,
            next: " ".into(),
            r#type: StatusType::Done,
        });
        let err = cfg.effective_statuses().unwrap_err();
        assert!(matches!(err, CoreError::InvalidTasksConfig(_)));
    }

    #[test]
    fn configured_status_overrides_builtin() {
        // Spec §11's example config: a single entry may relabel a built-in.
        let mut cfg = TasksConfig::default();
        cfg.statuses.push(TaskStatusDef {
            symbol: "X".into(), // legal override of the built-in 'x'
            name: Some("Finished".into()),
            next: " ".into(),
            r#type: StatusType::Done,
        });
        let eff = cfg
            .effective_statuses()
            .expect("built-in override is legal");
        assert_eq!(
            eff.get('x'),
            (Some("Finished".into()), ' ', StatusType::Done)
        );
        assert_eq!(eff.get('X'), eff.get('x'));
    }

    #[test]
    fn global_filter_with_newline_is_rejected() {
        let mut cfg = TasksConfig::default();
        cfg.global_filter = "#task\n".into();
        let err = cfg.effective_statuses().unwrap_err();
        assert!(matches!(err, CoreError::InvalidTasksConfig(_)));
    }

    #[test]
    fn global_filter_with_nul_is_rejected() {
        let mut cfg = TasksConfig::default();
        cfg.global_filter = "#task\0".into();
        let err = cfg.effective_statuses().unwrap_err();
        assert!(matches!(err, CoreError::InvalidTasksConfig(_)));
    }

    #[test]
    fn unresolvable_next_symbol_is_rejected() {
        let mut cfg = TasksConfig::default();
        cfg.statuses.push(TaskStatusDef {
            symbol: "!".into(),
            name: Some("Blocked".into()),
            next: "?".into(), // '?' is not a configured symbol
            r#type: StatusType::OnHold,
        });
        let err = cfg.effective_statuses().unwrap_err();
        assert!(matches!(err, CoreError::InvalidTasksConfig(_)));
    }

    #[test]
    fn multi_character_symbol_is_rejected() {
        let mut cfg = TasksConfig::default();
        cfg.statuses.push(TaskStatusDef {
            symbol: "ab".into(),
            name: Some("Bad".into()),
            next: "x".into(),
            r#type: StatusType::Todo,
        });
        let err = cfg.effective_statuses().unwrap_err();
        assert!(matches!(err, CoreError::InvalidTasksConfig(_)));
    }

    fn cfg() -> TasksConfig {
        TasksConfig::default()
    }

    #[test]
    fn parses_minimal_gfm_checkbox_as_todo() {
        let body = "- [ ] buy milk\n";
        let parsed = parse_tasks(body, &cfg());
        assert_eq!(parsed.tasks.len(), 1);
        let t = &parsed.tasks[0];
        assert_eq!(t.line, 0);
        assert_eq!(t.symbol, ' ');
        assert_eq!(t.status_type, StatusType::Todo);
        assert_eq!(t.text, "buy milk");
        assert!(t.due.is_none() && t.scheduled.is_none() && t.start.is_none());
    }

    #[test]
    fn parses_emoji_fields_full_example_from_spec() {
        let body = "- [ ] 우유 사기 #장보기 🛫 2026-08-28 ⏳ 2026-08-29 📅 2026-08-30 ⏫\n";
        let parsed = parse_tasks(body, &cfg());
        let t = &parsed.tasks[0];
        assert_eq!(t.start, Some(time::macros::date!(2026 - 08 - 28)));
        assert_eq!(t.scheduled, Some(time::macros::date!(2026 - 08 - 29)));
        assert_eq!(t.due, Some(time::macros::date!(2026 - 08 - 30)));
        assert_eq!(t.priority, Priority::High);
        assert_eq!(t.tags, vec!["장보기".to_string()]);
        assert_eq!(t.text, "우유 사기");
    }

    #[test]
    fn dataview_fields_parse_identically_to_emoji() {
        let body = "- [ ] task [due:: 2026-08-30] [start:: 2026-08-28]\n";
        let parsed = parse_tasks(body, &cfg());
        let t = &parsed.tasks[0];
        assert_eq!(t.due, Some(time::macros::date!(2026 - 08 - 30)));
        assert_eq!(t.start, Some(time::macros::date!(2026 - 08 - 28)));
        assert_eq!(t.text, "task");
    }

    #[test]
    fn extended_status_symbols_parse_with_defaults() {
        let body = "- [/] in progress\n- [x] done\n- [X] also done\n- [-] cancelled\n";
        let parsed = parse_tasks(body, &cfg());
        assert_eq!(parsed.tasks[0].status_type, StatusType::InProgress);
        assert_eq!(parsed.tasks[1].status_type, StatusType::Done);
        assert_eq!(parsed.tasks[2].status_type, StatusType::Done);
        assert_eq!(
            parsed.tasks[2].symbol, 'x',
            "X normalizes to x in the stored row"
        );
        assert_eq!(parsed.tasks[3].status_type, StatusType::Cancelled);
    }

    #[test]
    fn ordered_list_markers_are_accepted() {
        let body = "1. [ ] first\n2) [ ] second\n";
        let parsed = parse_tasks(body, &cfg());
        assert_eq!(parsed.tasks.len(), 2);
    }

    #[test]
    fn tab_indentation_advances_to_next_multiple_of_four() {
        let body = "- [ ] parent\n\t- [ ] child\n";
        let parsed = parse_tasks(body, &cfg());
        assert_eq!(parsed.tasks[0].indent_columns, 0);
        assert_eq!(parsed.tasks[1].indent_columns, 4);
        assert_eq!(parsed.tasks[1].parent, Some(0));
    }

    #[test]
    fn parent_is_nearest_containing_shallower_task_not_nearest_preceding() {
        let body = "- [ ] parent\n  - [ ] child a\n  - [ ] child b\n";
        let parsed = parse_tasks(body, &cfg());
        assert_eq!(parsed.tasks[1].parent, Some(0));
        assert_eq!(parsed.tasks[2].parent, Some(0));
    }

    #[test]
    fn fenced_code_blocks_are_skipped() {
        let body = "```\n- [ ] not a task\n```\n- [ ] real task\n";
        let parsed = parse_tasks(body, &cfg());
        assert_eq!(parsed.tasks.len(), 1);
        assert_eq!(parsed.tasks[0].text, "real task");
    }

    #[test]
    fn indented_code_blocks_are_skipped() {
        let body = "    - [ ] not a task (4-space indent = code)\n- [ ] real task\n";
        let parsed = parse_tasks(body, &cfg());
        assert_eq!(parsed.tasks.len(), 1);
    }

    #[test]
    fn field_lookalike_inside_inline_code_is_description_not_metadata() {
        let body = "- [ ] run `📅 2026-08-30` in shell\n";
        let parsed = parse_tasks(body, &cfg());
        assert!(parsed.tasks[0].due.is_none());
        assert!(parsed.tasks[0].text.contains("📅 2026-08-30"));
    }

    #[test]
    fn duplicate_field_uses_rightmost_valid_value_with_warning() {
        let body = "- [ ] task 📅 2026-08-30 📅 2026-09-01\n";
        let parsed = parse_tasks(body, &cfg());
        let t = &parsed.tasks[0];
        assert_eq!(t.due, Some(time::macros::date!(2026 - 09 - 01)));
        assert!(
            t.warnings
                .iter()
                .any(|w| w.kind == TaskWarningKind::Duplicate)
        );
    }

    #[test]
    fn invalid_date_value_is_warned_not_dropped() {
        let body = "- [ ] task 📅 not-a-date\n";
        let parsed = parse_tasks(body, &cfg());
        let t = &parsed.tasks[0];
        assert!(t.due.is_none());
        assert!(
            t.warnings
                .iter()
                .any(|w| w.kind == TaskWarningKind::InvalidValue && w.raw.contains("not-a-date"))
        );
    }

    #[test]
    fn nbsp_between_emoji_and_date_is_accepted() {
        let body = "- [ ] task 📅\u{00A0}2026-08-30\n";
        let parsed = parse_tasks(body, &cfg());
        assert_eq!(
            parsed.tasks[0].due,
            Some(time::macros::date!(2026 - 08 - 30))
        );
    }

    #[test]
    fn variation_selector_is_ignored_for_matching_but_kept_in_raw() {
        let body = "- [ ] task 📅\u{FE0F} 2026-08-30\n";
        let parsed = parse_tasks(body, &cfg());
        assert_eq!(
            parsed.tasks[0].due,
            Some(time::macros::date!(2026 - 08 - 30))
        );
    }

    #[test]
    fn unknown_emoji_is_left_in_description() {
        let body = "- [ ] task 🎉 celebrate\n";
        let parsed = parse_tasks(body, &cfg());
        assert!(parsed.tasks[0].text.contains('🎉'));
    }

    #[test]
    fn inline_tags_are_scanned_from_description() {
        let body = "- [ ] task #home #urgent 📅 2026-08-30\n";
        let parsed = parse_tasks(body, &cfg());
        let mut tags = parsed.tasks[0].tags.clone();
        tags.sort();
        assert_eq!(tags, vec!["home".to_string(), "urgent".to_string()]);
    }

    #[test]
    fn section_records_nearest_preceding_heading() {
        let body = "## Work\n- [ ] task one\n## Home\n- [ ] task two\n";
        let parsed = parse_tasks(body, &cfg());
        assert_eq!(parsed.tasks[0].section.as_deref(), Some("Work"));
        assert_eq!(parsed.tasks[1].section.as_deref(), Some("Home"));
    }

    #[test]
    fn global_filter_token_required_when_configured() {
        let mut c = cfg();
        c.global_filter = "#task".into();
        let body = "- [ ] not a task, no filter token\n- [ ] real #task\n";
        let parsed = parse_tasks(body, &c);
        assert_eq!(parsed.tasks.len(), 1);
        assert_eq!(parsed.tasks[0].text, "real");
        assert!(!parsed.tasks[0].tags.contains(&"task".to_string()));
    }

    #[test]
    fn per_note_task_cap_sets_truncated_flag() {
        let mut body = String::new();
        for i in 0..1001 {
            body.push_str(&format!("- [ ] task {i}\n"));
        }
        let parsed = parse_tasks(&body, &cfg());
        assert_eq!(parsed.tasks.len(), 1000);
        assert!(parsed.truncated);
    }

    #[test]
    fn crlf_line_endings_do_not_break_parsing() {
        let body = "- [ ] task one\r\n- [ ] task two\r\n";
        let parsed = parse_tasks(body, &cfg());
        assert_eq!(parsed.tasks.len(), 2);
    }

    proptest::proptest! {
        #[test]
        fn prop_unrelated_field_edit_preserves_other_spans(due_present in proptest::bool::ANY) {
            let c = cfg();
            let body = if due_present {
                "- [ ] task 📅 2026-08-30 #tag\n".to_string()
            } else {
                "- [ ] task #tag\n".to_string()
            };
            let before = parse_tasks(&body, &c).tasks.remove(0);
            // Re-parsing the same bytes again must yield byte-identical
            // field values (parser determinism / idempotence) — this is
            // the parser-scoped half of the invariant; Task 5 adds the
            // transform-scoped half once field-splicing exists.
            let after = parse_tasks(&body, &c).tasks.remove(0);
            proptest::prop_assert_eq!(before.due, after.due);
            proptest::prop_assert_eq!(before.tags, after.tags);
            proptest::prop_assert_eq!(before.text, after.text);
        }
    }

    #[test]
    fn render_new_task_emoji_format_includes_global_filter() {
        let mut c = cfg();
        c.global_filter = "#task".into();
        let fields = TaskFields {
            due: Some(time::macros::date!(2026 - 08 - 30)),
            priority: Priority::High,
            ..Default::default()
        };
        let line = render_new_task("buy milk", &fields, &c).unwrap();
        assert!(line.starts_with("- [ ] buy milk"));
        assert!(line.contains("#task"));
        assert!(line.contains("📅 2026-08-30"));
        assert!(line.contains('⏫'));
    }

    #[test]
    fn render_new_task_dataview_format() {
        let mut c = cfg();
        c.write_format = WriteFormat::Dataview;
        let fields = TaskFields {
            due: Some(time::macros::date!(2026 - 08 - 30)),
            ..Default::default()
        };
        let line = render_new_task("buy milk", &fields, &c).unwrap();
        assert!(line.contains("[due:: 2026-08-30]"));
        assert!(!line.contains('📅'));
    }

    #[test]
    fn render_new_task_rejects_newline_and_nul_in_text() {
        let c = cfg();
        assert!(render_new_task("bad\ntext", &TaskFields::default(), &c).is_err());
        assert!(render_new_task("bad\0text", &TaskFields::default(), &c).is_err());
    }

    #[test]
    fn rendered_line_reparses_to_the_same_fields() {
        let c = cfg();
        let fields = TaskFields {
            due: Some(time::macros::date!(2026 - 08 - 30)),
            scheduled: Some(time::macros::date!(2026 - 08 - 29)),
            priority: Priority::Highest,
            ..Default::default()
        };
        let line = render_new_task("round trip", &fields, &c).unwrap();
        let body = format!("{line}\n");
        let parsed = parse_tasks(&body, &c);
        let t = &parsed.tasks[0];
        assert_eq!(t.text, "round trip");
        assert_eq!(t.due, fields.due);
        assert_eq!(t.scheduled, fields.scheduled);
        assert_eq!(t.priority, fields.priority);
        assert!(t.warnings.is_empty());
    }

    #[test]
    fn set_priority_splices_only_the_priority_token() {
        let body = "- [ ] task 📅 2026-08-30\n";
        let out = transform_single_line(body, TaskEdit::SetPriority(Priority::High));
        assert!(out.contains("📅 2026-08-30"), "due token untouched");
        assert!(out.contains('⏫'));
    }

    #[test]
    fn set_date_clears_field_when_value_is_none() {
        let body = "- [ ] task 📅 2026-08-30\n";
        let out = transform_single_line(
            body,
            TaskEdit::SetDate {
                field: DateField::Due,
                value: None,
            },
        );
        assert!(!out.contains('📅'));
        assert!(out.contains("task"));
    }

    #[test]
    fn set_date_adds_field_when_absent() {
        let body = "- [ ] task\n";
        let out = transform_single_line(
            body,
            TaskEdit::SetDate {
                field: DateField::Due,
                value: Some(time::macros::date!(2026 - 08 - 30)),
            },
        );
        assert!(out.contains("📅 2026-08-30"));
    }

    #[test]
    fn set_text_preserves_every_field_and_the_list_marker() {
        let body = "  - [ ] old text 📅 2026-08-30 #tag\n";
        let out = transform_single_line(body, TaskEdit::SetText("new text".into()));
        assert!(
            out.starts_with("  - [ ]"),
            "indentation and marker preserved"
        );
        assert!(out.contains("new text"));
        assert!(out.contains("📅 2026-08-30"));
        assert!(out.contains("#tag"));
        assert!(!out.contains("old text"));
    }

    #[test]
    fn set_text_preserves_tag_that_precedes_a_field_token() {
        // Kept spans arrive fields-first regardless of source order;
        // merge_ranges must sort before merging or this tag's span is
        // swallowed by the later field span and its bytes dropped.
        let body = "- [ ] old #tag 📅 2026-08-30\n";
        let out = transform_single_line(body, TaskEdit::SetText("new".into()));
        assert!(
            out.contains("#tag"),
            "tag before the field must survive: {out}"
        );
        assert!(out.contains("📅 2026-08-30"));
        assert!(!out.contains("old"));
    }

    #[test]
    fn set_text_cannot_remove_the_global_filter_token() {
        let mut c = cfg();
        c.global_filter = "#task".into();
        let body = "- [ ] old #task\n";
        let today = time::macros::date!(2026 - 08 - 27);
        let t = transform_task_draft(body, 0, &TaskEdit::SetText("new".into()), today, &c).unwrap();
        let out = apply_line_changes(body, &t.changes);
        assert!(out.contains("#task"));
    }

    #[test]
    fn set_text_rejects_newline_and_nul() {
        let c = cfg();
        let today = time::macros::date!(2026 - 08 - 27);
        let body = "- [ ] task\n";
        assert!(
            transform_task_draft(body, 0, &TaskEdit::SetText("a\nb".into()), today, &c).is_err()
        );
        assert!(
            transform_task_draft(body, 0, &TaskEdit::SetText("a\0b".into()), today, &c).is_err()
        );
    }

    #[test]
    fn set_recurrence_adds_and_clears_rule() {
        let body = "- [ ] task\n";
        let out = transform_single_line(body, TaskEdit::SetRecurrence(Some("every week".into())));
        assert!(out.contains("🔁 every week"));
        let out2 = transform_single_line(&out, TaskEdit::SetRecurrence(None));
        assert!(!out2.contains('🔁'));
    }

    #[test]
    fn set_status_to_unrecognized_symbol_still_splices() {
        let body = "- [ ] task\n";
        let out = transform_single_line(body, TaskEdit::SetStatus('!'));
        assert!(out.starts_with("- [!]"));
    }

    #[test]
    fn change_targets_the_correct_zero_based_line() {
        let body = "- [ ] first\n- [ ] second\n";
        let c = cfg();
        let today = time::macros::date!(2026 - 08 - 27);
        let t = transform_task_draft(body, 1, &TaskEdit::SetPriority(Priority::Low), today, &c)
            .unwrap();
        assert_eq!(t.changes.len(), 1);
        assert_eq!(t.changes[0].start_line, 1);
        assert_eq!(t.changes[0].delete_lines, 1);
    }

    proptest::proptest! {
        #[test]
        fn prop_set_priority_never_changes_other_fields(
            due_present in proptest::bool::ANY,
        ) {
            let c = cfg();
            let today = time::macros::date!(2026 - 08 - 27);
            let body = if due_present {
                "- [ ] task 📅 2026-08-30 #tag\n"
            } else {
                "- [ ] task #tag\n"
            };
            let t = transform_task_draft(body, 0, &TaskEdit::SetPriority(Priority::High), today, &c).unwrap();
            let out = apply_line_changes(body, &t.changes);
            let before = parse_tasks(body, &c).tasks.remove(0);
            let after = parse_tasks(&out, &c).tasks.remove(0);
            proptest::prop_assert_eq!(before.due, after.due);
            proptest::prop_assert_eq!(before.tags, after.tags);
            proptest::prop_assert_eq!(before.text, after.text);
            proptest::prop_assert_eq!(after.priority, Priority::High);
        }
    }

    #[test]
    fn set_status_rejects_structural_chars() {
        let c = cfg();
        let today = time::macros::date!(2026 - 08 - 27);
        let body = "- [ ] task\n";
        for bad in ['\n', '\r', '\0', '[', ']'] {
            assert!(
                transform_task_draft(body, 0, &TaskEdit::SetStatus(bad), today, &c).is_err(),
                "SetStatus({bad:?}) must be rejected"
            );
        }
    }

    #[test]
    fn set_text_preserves_non_tag_global_filter_occurrence() {
        // Non-tag-shaped filter whose only occurrence lives inside the
        // old description: the matching bytes must survive SetText so
        // the line still passes parse_tasks' containment gating.
        let mut c = cfg();
        c.global_filter = "milk".into();
        let body = "- [ ] buy milk\n";
        let today = time::macros::date!(2026 - 08 - 27);
        let t = transform_task_draft(body, 0, &TaskEdit::SetText("new".into()), today, &c).unwrap();
        let out = apply_line_changes(body, &t.changes);
        assert!(
            out.contains("milk"),
            "filter occurrence must survive: {out}"
        );
        assert!(out.contains("new"));
        assert!(!out.contains("buy"));
        // And the edited line still parses as a task under the filter.
        let parsed = parse_tasks(&out, &c);
        assert_eq!(parsed.tasks.len(), 1);
        // Display text excludes the filter token (parse_tasks strips it).
        assert_eq!(parsed.tasks[0].text, "new");
    }

    // ------------------------------------------------------------------
    // Task 5: terminal status transitions, recurrence spawn, and Delete
    // subtree dedent.
    // ------------------------------------------------------------------

    #[test]
    fn entering_done_stamps_done_and_clears_cancelled() {
        let body = "- [-] task ❌ 2026-08-20\n";
        let c = cfg();
        let today = time::macros::date!(2026 - 08 - 27);
        let t = transform_task_draft(body, 0, &TaskEdit::SetStatus('x'), today, &c).unwrap();
        let out = apply_line_changes(body, &t.changes);
        let row = parse_tasks(&out, &c).tasks.remove(0);
        assert_eq!(row.status_type, StatusType::Done);
        assert_eq!(row.done, Some(today));
        assert!(row.cancelled.is_none());
    }

    #[test]
    fn entering_cancelled_stamps_cancelled_and_clears_done() {
        let body = "- [x] task ✅ 2026-08-20\n";
        let c = cfg();
        let today = time::macros::date!(2026 - 08 - 27);
        let t = transform_task_draft(body, 0, &TaskEdit::SetStatus('-'), today, &c).unwrap();
        let out = apply_line_changes(body, &t.changes);
        let row = parse_tasks(&out, &c).tasks.remove(0);
        assert_eq!(row.status_type, StatusType::Cancelled);
        assert_eq!(row.cancelled, Some(today));
        assert!(row.done.is_none());
    }

    #[test]
    fn leaving_done_clears_done_date() {
        let body = "- [x] task ✅ 2026-08-20\n";
        let c = cfg();
        let today = time::macros::date!(2026 - 08 - 27);
        let t = transform_task_draft(body, 0, &TaskEdit::SetStatus(' '), today, &c).unwrap();
        let out = apply_line_changes(body, &t.changes);
        let row = parse_tasks(&out, &c).tasks.remove(0);
        assert_eq!(row.status_type, StatusType::Todo);
        assert!(row.done.is_none());
    }

    #[test]
    fn toggle_on_todo_uses_configured_next_symbol_and_stamps_done() {
        let body = "- [ ] task\n";
        let c = cfg();
        let today = time::macros::date!(2026 - 08 - 27);
        let t = transform_task_draft(body, 0, &TaskEdit::Toggle, today, &c).unwrap();
        let out = apply_line_changes(body, &t.changes);
        let row = parse_tasks(&out, &c).tasks.remove(0);
        assert_eq!(row.status_type, StatusType::Done);
        assert_eq!(row.done, Some(today));
    }

    #[test]
    fn same_type_transition_is_a_no_op_for_dates() {
        let body = "- [x] task ✅ 2026-08-20\n";
        let c = cfg();
        let today = time::macros::date!(2026 - 08 - 27);
        let t = transform_task_draft(body, 0, &TaskEdit::SetStatus('X'), today, &c).unwrap();
        let out = apply_line_changes(body, &t.changes);
        let row = parse_tasks(&out, &c).tasks.remove(0);
        assert_eq!(
            row.done,
            Some(time::macros::date!(2026 - 08 - 20)),
            "unchanged"
        );
    }

    #[test]
    fn recurrence_spawns_one_sibling_above_by_default() {
        let body = "- [ ] task 📅 2026-08-27 🔁 every week\n";
        let c = cfg();
        let today = time::macros::date!(2026 - 08 - 27);
        let t = transform_task_draft(body, 0, &TaskEdit::Toggle, today, &c).unwrap();
        let out = apply_line_changes(body, &t.changes);
        let rows = parse_tasks(&out, &c).tasks;
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows[0].status_type,
            StatusType::Todo,
            "spawned occurrence is above"
        );
        assert_eq!(rows[0].due, Some(time::macros::date!(2026 - 09 - 03)));
        assert_eq!(
            rows[1].status_type,
            StatusType::Done,
            "original stays, completed"
        );
        assert_eq!(rows[1].done, Some(today));
    }

    #[test]
    fn recurrence_below_targets_gap_after_full_subtree_not_before_children() {
        let mut c = cfg();
        c.recurrence_insert = RecurrenceInsert::Below;
        let today = time::macros::date!(2026 - 08 - 27);
        let body = "- [ ] task 📅 2026-08-27 🔁 every week\n  - [ ] child\n- [ ] unrelated\n";
        let t = transform_task_draft(body, 0, &TaskEdit::Toggle, today, &c).unwrap();
        let out = apply_line_changes(body, &t.changes);
        let lines: Vec<&str> = out.lines().collect();
        let task_idx = lines
            .iter()
            .position(|l| l.contains("📅 2026-09-03"))
            .unwrap();
        let child_idx = lines.iter().position(|l| l.contains("child")).unwrap();
        let unrelated_idx = lines.iter().position(|l| l.contains("unrelated")).unwrap();
        assert!(child_idx < task_idx && task_idx < unrelated_idx);
    }

    #[test]
    fn recurrence_reference_priority_is_due_then_scheduled_then_start() {
        let c = cfg();
        let today = time::macros::date!(2026 - 08 - 27);
        let body = "- [ ] task 🛫 2026-08-01 ⏳ 2026-08-10 📅 2026-08-20 🔁 every week\n";
        let t = transform_task_draft(body, 0, &TaskEdit::Toggle, today, &c).unwrap();
        let out = apply_line_changes(body, &t.changes);
        let spawned = parse_tasks(&out, &c)
            .tasks
            .into_iter()
            .find(|r| r.status_type == StatusType::Todo)
            .unwrap();
        assert_eq!(spawned.due, Some(time::macros::date!(2026 - 08 - 27)));
        assert_eq!(spawned.scheduled, Some(time::macros::date!(2026 - 08 - 17)));
        assert_eq!(spawned.start, Some(time::macros::date!(2026 - 08 - 08)));
    }

    #[test]
    fn when_done_recurrence_anchors_on_completion_date() {
        let c = cfg();
        let today = time::macros::date!(2026 - 08 - 27);
        let body = "- [ ] task 📅 2026-08-20 🔁 every week when done\n";
        let t = transform_task_draft(body, 0, &TaskEdit::Toggle, today, &c).unwrap();
        let out = apply_line_changes(body, &t.changes);
        let spawned = parse_tasks(&out, &c)
            .tasks
            .into_iter()
            .find(|r| r.status_type == StatusType::Todo)
            .unwrap();
        assert_eq!(
            spawned.due,
            Some(time::macros::date!(2026 - 09 - 03)),
            "today + 1 week, not due + 1 week"
        );
    }

    #[test]
    fn month_recurrence_uses_calendar_months_with_end_of_month_clamp() {
        let c = cfg();
        let today = time::macros::date!(2026 - 08 - 27);
        let body = "- [ ] task 📅 2026-01-31 🔁 every month\n";
        let t = transform_task_draft(body, 0, &TaskEdit::Toggle, today, &c).unwrap();
        let out = apply_line_changes(body, &t.changes);
        let spawned = parse_tasks(&out, &c)
            .tasks
            .into_iter()
            .find(|r| r.status_type == StatusType::Todo)
            .unwrap();
        assert_eq!(
            spawned.due,
            Some(time::macros::date!(2026 - 02 - 28)),
            "clamped, no panic"
        );
    }

    #[test]
    fn recurring_task_re_applying_done_to_already_done_is_a_no_op() {
        let body = "- [x] task ✅ 2026-08-20 📅 2026-08-20 🔁 every week\n";
        let c = cfg();
        let today = time::macros::date!(2026 - 08 - 27);
        let t = transform_task_draft(body, 0, &TaskEdit::SetStatus('X'), today, &c).unwrap();
        let out = apply_line_changes(body, &t.changes);
        assert_eq!(parse_tasks(&out, &c).tasks.len(), 1, "no duplicate spawn");
    }

    #[test]
    fn recurrence_without_any_reference_date_is_rejected() {
        let body = "- [ ] task 🔁 every week\n";
        let c = cfg();
        let today = time::macros::date!(2026 - 08 - 27);
        let err = transform_task_draft(body, 0, &TaskEdit::Toggle, today, &c);
        if let Ok(t) = err {
            let out = apply_line_changes(body, &t.changes);
            assert_eq!(parse_tasks(&out, &c).tasks.len(), 1);
        }
    }

    #[test]
    fn unsupported_complex_rule_does_not_spawn_and_keeps_rule_text() {
        let body = "- [ ] task 📅 2026-08-20 🔁 every 6 months on the 2nd wednesday\n";
        let c = cfg();
        let today = time::macros::date!(2026 - 08 - 27);
        let t = transform_task_draft(body, 0, &TaskEdit::Toggle, today, &c).unwrap();
        let out = apply_line_changes(body, &t.changes);
        let rows = parse_tasks(&out, &c).tasks;
        assert_eq!(rows.len(), 1, "no spawn for an unsupported rule");
        assert!(rows[0].recurrence.as_deref() == Some("every 6 months on the 2nd wednesday"));
    }

    #[test]
    fn delete_removes_line_and_dedents_children() {
        let body = "- [ ] parent\n  - [ ] child one\n  - [ ] child two\n- [ ] unrelated\n";
        let c = cfg();
        let today = time::macros::date!(2026 - 08 - 27);
        let t = transform_task_draft(body, 0, &TaskEdit::Delete, today, &c).unwrap();
        let out = apply_line_changes(body, &t.changes);
        let rows = parse_tasks(&out, &c).tasks;
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].text, "child one");
        assert_eq!(rows[0].indent_columns, 0);
        assert_eq!(rows[1].text, "child two");
        assert_eq!(rows[1].indent_columns, 0);
        assert_eq!(rows[2].text, "unrelated");
    }

    #[test]
    fn delete_leaf_task_only_removes_its_own_line() {
        let body = "- [ ] parent\n  - [ ] only child\n";
        let c = cfg();
        let today = time::macros::date!(2026 - 08 - 27);
        let t = transform_task_draft(body, 1, &TaskEdit::Delete, today, &c).unwrap();
        let out = apply_line_changes(body, &t.changes);
        let rows = parse_tasks(&out, &c).tasks;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].text, "parent");
    }

    proptest::proptest! {
        #[test]
        fn prop_recurrence_shift_preserves_date_window_width(days_offset in 1i64..365) {
            let c = cfg();
            let today = time::macros::date!(2026 - 08 - 27);
            let due = today;
            let start = due - time::Duration::days(days_offset);
            let body = format!(
                "- [ ] task 🛫 {} 📅 {} 🔁 every week\n",
                format_date_yyyy_mm_dd(start),
                format_date_yyyy_mm_dd(due),
            );
            let t = transform_task_draft(&body, 0, &TaskEdit::Toggle, today, &c).unwrap();
            let out = apply_line_changes(&body, &t.changes);
            let spawned = parse_tasks(&out, &c).tasks.into_iter().find(|r| r.status_type == StatusType::Todo).unwrap();
            let new_width = (spawned.due.unwrap() - spawned.start.unwrap()).whole_days();
            proptest::prop_assert_eq!(new_width, days_offset);
        }
    }

    /// Golden-fixture corpus emitter (Task 1, plan C). Builds a JSON
    /// document of `transform_task_draft` cases that covers every edit
    /// variant in the browser-mirror scope (Toggle/SetStatus per status
    /// family, SetDate per field per format, SetPriority every level,
    /// SetText with global_filter and tag preservation, SetRecurrence,
    /// recurrence spawn above/below/`when done`/reference priority,
    /// CRLF bodies, duplicate-field collapse, unsupported-rule no-spawn).
    /// Skips `TaskEdit::Delete`: the spec defers it to a later task and
    /// Task 1's mirror only needs the edits Tasks 2/8/9/10 actually
    /// drive, so Delete is out of mirror scope and intentionally
    /// absent from the fixtures.
    ///
    /// When `UPDATE_TASK_FIXTURES=1`, overwrites
    /// `apps/desktop/src/lib/taskFixtures.json`. Otherwise asserts the
    /// committed file matches the regenerated JSON byte-for-byte; CI
    /// without the frontend checkout (the desktop tree is git-ignored
    /// in some builds) skips the diff and only verifies the kernel
    /// still runs.
    #[test]
    fn emit_golden_fixture_corpus() {
        use serde_json::json;

        let today: Date = time::macros::date!(2026 - 08 - 27);

        // Build one (cfg, body, line, edit, expected_changes) row.
        // `cfg` defaults to emoji/above; override per case for dataview,
        // below, global filter.
        let mut cases: Vec<serde_json::Value> = Vec::new();

        let mk = |name: &str,
                  cfg: TasksConfig,
                  body: &str,
                  line: u32,
                  edit: TaskEdit,
                  today: Date| {
            let t = transform_task_draft(body, line, &edit, today, &cfg)
                .expect("kernel must accept fixture case");
            let cfg_json = serde_json::to_value(&cfg).unwrap();
            let edit_json = edit_to_json(&edit);
            let changes_json = changes_to_json(&t.changes);
            serde_json::json!({
                "name": name,
                "cfg": cfg_json,
                "body": body,
                "line": line,
                "edit": edit_json,
                "today": format!("{:04}-{:02}-{:02}", today.year(), u8::from(today.month()), today.day()),
                "expected": { "changes": changes_json },
            })
        };

        // --- entering Done from cancelled: stamps done + clears cancelled
        cases.push(mk(
            "entering_done_from_cancelled_stamps_done_clears_cancelled",
            TasksConfig::default(),
            "- [-] task ❌ 2026-08-20\n",
            0,
            TaskEdit::SetStatus('x'),
            today,
        ));
        cases.push(mk(
            "toggle_done_to_todo_clears_done",
            TasksConfig::default(),
            "- [x] task ✅ 2026-08-20\n",
            0,
            TaskEdit::Toggle,
            today,
        ));
        // --- set status: Done -> Cancelled stamps cancelled + clears done
        cases.push(mk(
            "set_status_done_to_cancelled_stamps_clears_done",
            TasksConfig::default(),
            "- [x] task ✅ 2026-08-20\n",
            0,
            TaskEdit::SetStatus('-'),
            today,
        ));
        // --- toggle: Todo -> Done spawns sibling above (default)
        cases.push(mk(
            "toggle_recurrence_spawns_above_by_default",
            TasksConfig::default(),
            "- [ ] task 📅 2026-08-27 🔁 every week\n",
            0,
            TaskEdit::Toggle,
            today,
        ));
        // --- toggle: recurrence, recurrence_insert = below, with subtree
        {
            let mut cfg = TasksConfig::default();
            cfg.recurrence_insert = RecurrenceInsert::Below;
            cases.push(mk(
                "toggle_recurrence_spawns_below_after_subtree",
                cfg,
                "- [ ] task 📅 2026-08-27 🔁 every week\n  - [ ] child\n- [ ] unrelated\n",
                0,
                TaskEdit::Toggle,
                today,
            ));
        }
        // --- toggle: reference priority due > scheduled > start
        cases.push(mk(
            "toggle_recurrence_reference_priority_due_over_scheduled_over_start",
            TasksConfig::default(),
            "- [ ] task 🛫 2026-08-01 ⏳ 2026-08-10 📅 2026-08-20 🔁 every week\n",
            0,
            TaskEdit::Toggle,
            today,
        ));
        // --- toggle: when done anchors on completion
        cases.push(mk(
            "toggle_recurrence_when_done_anchors_on_today",
            TasksConfig::default(),
            "- [ ] task 📅 2026-08-20 🔁 every week when done\n",
            0,
            TaskEdit::Toggle,
            today,
        ));
        // --- toggle: month recurrence with end-of-month clamp
        cases.push(mk(
            "toggle_recurrence_month_clamp_jan31_to_feb28",
            TasksConfig::default(),
            "- [ ] task 📅 2026-01-31 🔁 every month\n",
            0,
            TaskEdit::Toggle,
            today,
        ));
        // --- toggle: unsupported complex rule — no spawn, rule text preserved
        cases.push(mk(
            "toggle_recurrence_unsupported_rule_no_spawn_keeps_text",
            TasksConfig::default(),
            "- [ ] task 📅 2026-08-20 🔁 every 6 months on the 2nd wednesday\n",
            0,
            TaskEdit::Toggle,
            today,
        ));
        // --- toggle: leaving terminal clears its own date
        cases.push(mk(
            "toggle_done_to_todo_clears_done_no_spawn",
            TasksConfig::default(),
            "- [x] task ✅ 2026-08-20 📅 2026-08-20 🔁 every week\n",
            0,
            TaskEdit::SetStatus('X'),
            today,
        ));
        // --- same-type transition (x -> X) is a no-op for dates
        cases.push(mk(
            "set_status_same_type_done_x_to_X_preserves_done_date",
            TasksConfig::default(),
            "- [x] task ✅ 2026-08-20\n",
            0,
            TaskEdit::SetStatus('X'),
            today,
        ));

        // --- SetDate set: each field, emoji + dataview, present and absent
        for (field, label) in [
            (DateField::Created, "created"),
            (DateField::Start, "start"),
            (DateField::Scheduled, "scheduled"),
            (DateField::Due, "due"),
        ] {
            // emoji, field absent -> append
            cases.push(mk(
                &format!("set_date_{label}_emoji_append_when_absent"),
                TasksConfig::default(),
                "- [ ] task\n",
                0,
                TaskEdit::SetDate {
                    field,
                    value: Some(time::macros::date!(2026 - 08 - 30)),
                },
                today,
            ));
            // emoji, field present -> splice
            let emoji_char = match field {
                DateField::Created => "➕",
                DateField::Start => "🛫",
                DateField::Scheduled => "⏳",
                DateField::Due => "📅",
                _ => unreachable!("only the four date fields above"),
            };
            cases.push(mk(
                &format!("set_date_{label}_emoji_replace_when_present"),
                TasksConfig::default(),
                &format!("- [ ] task {emoji_char} 2026-08-30\n"),
                0,
                TaskEdit::SetDate {
                    field,
                    value: Some(time::macros::date!(2026 - 08 - 31)),
                },
                today,
            ));
            // dataview, absent -> append
            let mut cfg = TasksConfig::default();
            cfg.write_format = WriteFormat::Dataview;
            cases.push(mk(
                &format!("set_date_{label}_dataview_append_when_absent"),
                cfg.clone(),
                "- [ ] task\n",
                0,
                TaskEdit::SetDate {
                    field,
                    value: Some(time::macros::date!(2026 - 08 - 30)),
                },
                today,
            ));
            // dataview, present -> splice
            let dataview_key = match field {
                DateField::Created => "created",
                DateField::Start => "start",
                DateField::Scheduled => "scheduled",
                DateField::Due => "due",
                _ => unreachable!("only the four date fields above"),
            };
            cases.push(mk(
                &format!("set_date_{label}_dataview_replace_when_present"),
                cfg,
                &format!("- [ ] task [{dataview_key}:: 2026-08-30]\n"),
                0,
                TaskEdit::SetDate {
                    field,
                    value: Some(time::macros::date!(2026 - 08 - 31)),
                },
                today,
            ));
            // clear (None) emoji
            cases.push(mk(
                &format!("set_date_{label}_emoji_clear"),
                TasksConfig::default(),
                &format!("- [ ] task {emoji_char} 2026-08-30\n"),
                0,
                TaskEdit::SetDate { field, value: None },
                today,
            ));
        }
        // --- SetDate: done/cancelled are also date targets
        cases.push(mk(
            "set_date_done_emoji_set",
            TasksConfig::default(),
            "- [ ] task\n",
            0,
            TaskEdit::SetDate {
                field: DateField::Done,
                value: Some(time::macros::date!(2026 - 08 - 25)),
            },
            today,
        ));
        cases.push(mk(
            "set_date_cancelled_emoji_clear",
            TasksConfig::default(),
            "- [-] task ❌ 2026-08-20\n",
            0,
            TaskEdit::SetDate {
                field: DateField::Cancelled,
                value: None,
            },
            today,
        ));

        // --- SetPriority every level, emoji + dataview
        for level in [
            Priority::Highest,
            Priority::High,
            Priority::Medium,
            Priority::Low,
            Priority::Lowest,
            Priority::None,
        ] {
            cases.push(mk(
                &format!("set_priority_{:?}_emoji", level),
                TasksConfig::default(),
                "- [ ] task 📅 2026-08-30\n",
                0,
                TaskEdit::SetPriority(level),
                today,
            ));
            let mut cfg = TasksConfig::default();
            cfg.write_format = WriteFormat::Dataview;
            cases.push(mk(
                &format!("set_priority_{:?}_dataview", level),
                cfg,
                "- [ ] task 📅 2026-08-30\n",
                0,
                TaskEdit::SetPriority(level),
                today,
            ));
        }

        // --- SetText preserves tags, fields, and the global filter token
        cases.push(mk(
            "set_text_emoji_preserves_due_and_tag",
            TasksConfig::default(),
            "- [ ] old text 📅 2026-08-30 #tag\n",
            0,
            TaskEdit::SetText("new text".into()),
            today,
        ));
        // tag before a field — both must survive (merge_ranges test)
        cases.push(mk(
            "set_text_emoji_tag_before_field_both_survive",
            TasksConfig::default(),
            "- [ ] old #tag 📅 2026-08-30\n",
            0,
            TaskEdit::SetText("new".into()),
            today,
        ));
        // dataview format
        let mut cfg = TasksConfig::default();
        cfg.write_format = WriteFormat::Dataview;
        cases.push(mk(
            "set_text_dataview_preserves_field",
            cfg,
            "- [ ] old text [due:: 2026-08-30] #tag\n",
            0,
            TaskEdit::SetText("new text".into()),
            today,
        ));
        // global filter preserved
        let mut cfg = TasksConfig::default();
        cfg.global_filter = "#task".into();
        cases.push(mk(
            "set_text_global_filter_hash_preserved",
            cfg,
            "- [ ] old #task\n",
            0,
            TaskEdit::SetText("new".into()),
            today,
        ));
        // global filter as bare word preserved
        let mut cfg = TasksConfig::default();
        cfg.global_filter = "milk".into();
        cases.push(mk(
            "set_text_global_filter_word_preserved",
            cfg,
            "- [ ] buy milk\n",
            0,
            TaskEdit::SetText("new".into()),
            today,
        ));

        // --- SetRecurrence set/clear
        cases.push(mk(
            "set_recurrence_add_rule_emoji",
            TasksConfig::default(),
            "- [ ] task\n",
            0,
            TaskEdit::SetRecurrence(Some("every week".into())),
            today,
        ));
        cases.push(mk(
            "set_recurrence_clear_rule_emoji",
            TasksConfig::default(),
            "- [ ] task 🔁 every week\n",
            0,
            TaskEdit::SetRecurrence(None),
            today,
        ));
        let mut cfg = TasksConfig::default();
        cfg.write_format = WriteFormat::Dataview;
        cases.push(mk(
            "set_recurrence_add_rule_dataview",
            cfg,
            "- [ ] task\n",
            0,
            TaskEdit::SetRecurrence(Some("every week".into())),
            today,
        ));

        // --- CRLF body preservation: SetText on a CRLF body keeps CRLF
        cases.push(mk(
            "set_text_crlf_body_preserves_crlf",
            TasksConfig::default(),
            "- [ ] old\r\n- [ ] target 📅 2026-08-30\r\n- [ ] after\r\n",
            1,
            TaskEdit::SetText("new".into()),
            today,
        ));

        // --- duplicate-field collapse: scan keeps rightmost (kernel
        // only records the splice; rightmost wins is a parse-time rule)
        cases.push(mk(
            "set_date_due_emoji_collapse_when_duplicate_present",
            TasksConfig::default(),
            "- [ ] task 📅 2026-08-30 📅 2026-09-01\n",
            0,
            TaskEdit::SetDate {
                field: DateField::Due,
                value: Some(time::macros::date!(2026 - 08 - 15)),
            },
            today,
        ));

        // --- change_targets_the_correct_zero_based_line: body line 1
        cases.push(mk(
            "set_priority_targets_second_zero_based_line",
            TasksConfig::default(),
            "- [ ] first\n- [ ] second\n",
            1,
            TaskEdit::SetPriority(Priority::Low),
            today,
        ));

        // --- Non-ASCII (Korean) task body coverage. Hangul is 3 UTF-8
        // bytes / 1 UTF-16 code unit, so this is a true multibyte test
        // for the mirror's span arithmetic — it MUST stay in lock-step
        // with the kernel's byte-offset span semantics. Each case uses
        // a distinct combination of body bytes / edit / format so a
        // regression in any branch surfaces immediately.

        // 1. Korean description + emoji date tokens: enter Done.
        cases.push(mk(
            "korean_description_toggle_to_done_stamps_done_emoji",
            TasksConfig::default(),
            "- [ ] 우유 사기 #장보기 📅 2026-08-30\n",
            0,
            TaskEdit::SetStatus('x'),
            today,
        ));
        // 1b. Same line, SetDate replaces the emoji date.
        cases.push(mk(
            "korean_description_set_date_due_emoji_replace",
            TasksConfig::default(),
            "- [ ] 우유 사기 #장보기 📅 2026-08-30\n",
            0,
            TaskEdit::SetDate {
                field: DateField::Due,
                value: Some(time::macros::date!(2026 - 09 - 01)),
            },
            today,
        ));
        // 2. Korean description + dataview tokens: SetPriority.
        {
            let mut cfg = TasksConfig::default();
            cfg.write_format = WriteFormat::Dataview;
            cases.push(mk(
                "korean_description_set_priority_high_dataview",
                cfg,
                "- [ ] 보고서 초안 [due:: 2026-08-30] [priority:: high]\n",
                0,
                TaskEdit::SetPriority(Priority::Medium),
                today,
            ));
        }
        // 3. SetText on a Korean description preserving tags + global
        // filter substring that lives AFTER the Korean text. The find
        // must be a UTF-16 code-unit offset that still slices back to
        // the original bytes.
        {
            let mut cfg = TasksConfig::default();
            cfg.global_filter = "milk".into();
            cases.push(mk(
                "korean_description_set_text_preserves_tag_and_filter_substring",
                cfg,
                "- [ ] 우유 사기 #장보기 buy milk\n",
                0,
                TaskEdit::SetText("새 글".into()),
                today,
            ));
        }
        // 4. Korean description with recurrence: entering Done spawns
        // a sibling above whose text is the original Korean verbatim.
        cases.push(mk(
            "korean_description_recurrence_spawn_carries_korean_text",
            TasksConfig::default(),
            "- [ ] 주간 회의 📅 2026-08-27 🔁 every week\n",
            0,
            TaskEdit::Toggle,
            today,
        ));
        // 5. Duplicate-field collapse on a line with Korean text
        // before BOTH date tokens. Splice uses the union, then
        // appends the canonical token.
        cases.push(mk(
            "korean_description_duplicate_due_field_collapse",
            TasksConfig::default(),
            "- [ ] 보고서 제출 📅 2026-08-30 📅 2026-09-01\n",
            0,
            TaskEdit::SetDate {
                field: DateField::Due,
                value: Some(time::macros::date!(2026 - 08 - 15)),
            },
            today,
        ));
        // 6. CRLF body with Korean text — multibyte + CRLF together.
        cases.push(mk(
            "korean_description_crlf_body_preserves_crlf_and_text",
            TasksConfig::default(),
            "- [ ] 한국 메모\r\n- [ ] 우유 사기 #장보기 📅 2026-08-30\r\n- [ ] 끝\r\n",
            1,
            TaskEdit::SetDate {
                field: DateField::Due,
                value: Some(time::macros::date!(2026 - 09 - 01)),
            },
            today,
        ));
        // 7. Tab-indented child: scanner, splice, and replaceSymbol
        // must all work when the checkbox range starts past column 0
        // and a tab advances indent to a 4-col boundary.
        cases.push(mk(
            "tab_indent_child_set_priority_low",
            TasksConfig::default(),
            "- [ ] parent\n\t- [ ] child task\n",
            1,
            TaskEdit::SetPriority(Priority::Low),
            today,
        ));

        let corpus = serde_json::json!({ "cases": cases });

        // Compute repo root: crates/oximemo-core -> ../.. -> <root>.
        let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let workspace_root = manifest_dir
            .ancestors()
            .find(|p| p.join("Cargo.toml").exists() && p.join("apps").exists())
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| manifest_dir.parent().unwrap().to_path_buf());
        let target = workspace_root
            .join("apps")
            .join("desktop")
            .join("src")
            .join("lib")
            .join("taskFixtures.json");

        if std::env::var_os("UPDATE_TASK_FIXTURES").is_some() {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).expect("create fixture dir");
            }
            let pretty = serde_json::to_string_pretty(&corpus).expect("re-serialize");
            std::fs::write(&target, pretty).expect("write fixtures");
            return;
        }

        match std::fs::read(&target) {
            Ok(existing) => {
                let existing_json: serde_json::Value =
                    serde_json::from_slice(&existing).expect("existing must parse");
                let expected = serde_json::to_value(&corpus).unwrap();
                if existing_json != expected {
                    panic!(
                        "fixtures drift: regenerate with UPDATE_TASK_FIXTURES=1 (target={})",
                        target.display()
                    );
                }
            }
            Err(_) => {
                // No committed file (CI may ship without the desktop
                // tree). The kernel still ran; just skip the diff.
                eprintln!("skip fixture diff: {} not present", target.display());
            }
        }

        // Silence unused warnings on the json! macro import when the
        // corpus above is inlined.
        let _ = json!(null);
    }

    /// Manual externally-tagged JSON form for `TaskEdit`. The kernel
    /// type is `Debug, Clone, PartialEq` only (no `Serialize`), so the
    /// fixture emitter hand-builds each variant. Unit variants
    /// serialize to their bare variant name string; tuple variants to
    /// `{ "<Variant>": value }`; struct variants to
    /// `{ "<Variant>": { ... } }`. Field names inside structs use the
    /// same casing as the Rust type (the brief's TS adapter translates
    /// them to camelCase on the wire).
    fn edit_to_json(edit: &TaskEdit) -> serde_json::Value {
        use serde_json::json;
        match edit {
            TaskEdit::Toggle => json!("Toggle"),
            TaskEdit::SetStatus(c) => json!({ "SetStatus": c.to_string() }),
            TaskEdit::SetDate { field, value } => {
                let field = match field {
                    DateField::Created => "Created",
                    DateField::Start => "Start",
                    DateField::Scheduled => "Scheduled",
                    DateField::Due => "Due",
                    DateField::Done => "Done",
                    DateField::Cancelled => "Cancelled",
                };
                let value =
                    value.map(|d| serde_json::to_value(d).expect("Date serializes via time serde"));
                json!({ "SetDate": { "field": field, "value": value } })
            }
            TaskEdit::SetPriority(p) => {
                let word = match p {
                    Priority::Highest => "Highest",
                    Priority::High => "High",
                    Priority::Medium => "Medium",
                    Priority::Low => "Low",
                    Priority::Lowest => "Lowest",
                    Priority::None => "None",
                };
                json!({ "SetPriority": word })
            }
            TaskEdit::SetText(s) => json!({ "SetText": s }),
            TaskEdit::SetRecurrence(r) => json!({ "SetRecurrence": r }),
            TaskEdit::Delete => json!("Delete"),
        }
    }

    /// Manual JSON form for `TaskLineChange`. The struct has no
    /// `Serialize` derive (kept `Debug, Clone, PartialEq` only — the
    /// kernel type never crosses the wire on its own), so we build the
    /// array the brief expects by hand.
    fn changes_to_json(changes: &[TaskLineChange]) -> serde_json::Value {
        let arr: Vec<serde_json::Value> = changes
            .iter()
            .map(|c| {
                serde_json::json!({
                    "start_line": c.start_line,
                    "delete_lines": c.delete_lines,
                    "insert_lines": c.insert_lines,
                })
            })
            .collect();
        serde_json::Value::Array(arr)
    }
}
