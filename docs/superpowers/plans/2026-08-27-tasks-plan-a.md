# Tasks Plan A — Core and Safe Mutation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the markdown task grammar, safe lock-aware mutation
primitives (`patch_task`/`add_task`/`move_tasks`), and the full `oximemo
task` CLI, so tasks can be created/edited/completed/rolled-over entirely
through the CLI with zero data races, demonstrating the feature end to end
without any frontend changes.

**Architecture:** New `crates/oximemo-core/src/tasks.rs` owns parsing,
serialization, and the pure `transform_task_draft` transition/recurrence
kernel. `IndexRecord` gains a `tasks: Vec<TaskRow>` field populated at the
same choke points that already build `IndexRecord` today. `Vault` gains
three new lock-aware public methods that hold one exclusive flock across
read→verify→rewrite→upsert. `crates/oximemo-cli` gains an `oximemo task`
subcommand tree that calls those methods.

**Tech Stack:** Rust (existing `oximemo-core`/`oximemo-cli` crates), `blake3`
(already a workspace dep), `time` (already a workspace dep), `proptest`
(already a dev-dep of `oximemo-core`). No new crates.

**Spec:** `docs/superpowers/specs/2026-08-27-tasks-design.md` (committed,
reviewed twice, "Ready for final approval"). Cite section numbers (`§1`,
`§5`, …) in code comments where this plan quotes it.

## Global Constraints

- `TaskLineHash` is a lowercase 16-hex-digit string (BLAKE3-64, i.e. the
  first 16 hex chars of a full BLAKE3 digest), `#[serde(transparent)]` over
  `String` — **never** a JSON number (spec §5).
- `MAX_TASKS_PER_NOTE = 1000`; overflow sets `IndexRecord.tasks_truncated =
  true` instead of silently dropping rows (spec §3).
- Wire format: `write_format` is `"emoji"` (default) or `"dataview"` (spec
  §1, §11). Reading always accepts both, mixed.
- Built-in status defaults exactly: `' ' -> (todo, next 'x', TODO)`,
  `'/' -> (in_progress, next 'x', IN_PROGRESS)`, `'x'/'X' -> (done, next
  ' ', DONE)`, `'-' -> (cancelled, next ' ', CANCELLED)` (spec §2). `X`
  normalizes to the built-in `x` definition. Unknown symbols degrade to
  `{ name: "Unknown", next: 'x', type: TODO }`.
- Reference-date priority for recurrence is `due > scheduled > start`;
  `when done` anchors on the completion date instead (spec §6).
- Recurrence date arithmetic **must** go through
  `crate::expr::value::date_add(OffsetDateTime, &DurationSpec, sign, local)`
  — lift the date-only field to local midnight, shift, convert back to a
  local `YYYY-MM-DD` string, never through UTC. `every N months|years` uses
  `DurationSpec.calendar_months`; `every N days|weeks` and `every weekday`
  use `DurationSpec.fixed_millis`. **No RRULE crate is added** (spec §6).
- `patch_task` and `add_task` hold **one exclusive vault flock** across
  read → verify → raw-span rewrite → atomic file write → redb/search
  upsert. They must not call the existing public `update_note_with` while
  holding that lock (it opens its own separate lock scopes and would
  self-deadlock/timeout against the same fd — see Task 7). `move_tasks`
  writes the destination note first, then the source, under the same lock
  (spec §5).
- `TaskSelector::Exact` (memo_id + line + line_hash) is the only path GUI
  and cooperating agents use. `TaskSelector::CurrentLine` is reachable only
  via an explicit `--force` CLI flag (spec §5).
- `Delete` is the **only** bounded-subtree mutation: it removes the task
  line and dedents descendant lines by the deleted line's indent delta,
  preserving relative nesting (spec §5). Every other `TaskEdit` variant is
  a same-line splice.
- `INDEX_FORMAT_VERSION` (`vault.rs:44-48`, currently `4`) must be bumped
  by one for the `IndexRecord.tasks` schema addition. Both new
  `IndexRecord` fields are `#[serde(default)]` (spec §3 — load-bearing:
  lets pre-migration JSON/redb records deserialize as `tasks: []`).
- CLI conventions to match exactly: `anyhow::Result` everywhere, single
  `ExitCode::FAILURE`/`SUCCESS` (`main.rs:301-313`), `eprintln!("oximemo:
  {e}")` + `caused by:` chain, mutating commands print the resulting
  record as pretty JSON, `--format table|json|ndjson` via
  `format::Format::from_arg`, pure `String`-returning table renderers
  (`format_base_table` is the template, `format.rs:139-223`).
- `TaskLineHash`/`TaskRef`/`TaskDto` and friends are collision-free new
  names (verified: no `Task*`-prefixed type exists anywhere in
  `oximemo-core` or `oximemo-cli` today).
- No Tauri/frontend work in this plan. Plan A is demonstrated entirely
  through the CLI against a `tmp_vault()`-style test harness and manual
  `oximemo task` invocations.

## File Structure

- **Create** `crates/oximemo-core/src/tasks.rs` — all task domain types,
  the parser, the serializer, and the pure transform/recurrence kernel.
  This is the only new core module; it is registered as `pub mod tasks;`
  in `crates/oximemo-core/src/lib.rs` (grep the existing `pub mod` list
  and add it alphabetically).
- **Modify** `crates/oximemo-core/src/error.rs` — three new `CoreError`
  variants (Task 1).
- **Modify** `crates/oximemo-core/src/config.rs` — new `TasksConfig` +
  `TaskStatusDef` structs, `VaultConfig.tasks` field (Task 1).
- **Modify** `crates/oximemo-core/src/store/index.rs` — `IndexRecord.tasks`
  + `.tasks_truncated` fields (Task 6).
- **Modify** `crates/oximemo-core/src/vault.rs` — `record_of` extraction
  wiring, `INDEX_FORMAT_VERSION` bump, tasks-fingerprint marker (Task 6);
  lock-aware internal helpers (Task 7); `patch_task`/`add_task`/
  `move_tasks` (Tasks 8-10); `set_tasks_config` (Task 1).
- **Modify** `crates/oximemo-cli/src/main.rs`, `commands.rs`, `format.rs`
  — `oximemo task` subcommand tree (Task 11).
- **Modify** `skills/oximemo/SKILL.md` — Tasks section (Task 12).

---

### Task 1: Task domain types, config, and status validation

**Files:**
- Create: `crates/oximemo-core/src/tasks.rs`
- Modify: `crates/oximemo-core/src/lib.rs` (register `pub mod tasks;`)
- Modify: `crates/oximemo-core/src/error.rs`
- Modify: `crates/oximemo-core/src/config.rs`
- Modify: `crates/oximemo-core/src/vault.rs` (`set_tasks_config` setter only)
- Test: inline `#[cfg(test)] mod tests` in `tasks.rs` and `config.rs`

**Interfaces:**
- Produces (used by every later task): `TaskLineHash`, `TaskField`,
  `TaskWarningKind`, `TaskWarning`, `StatusType`, `Priority`, `DateField`,
  `TaskStatusDef`, `EffectiveStatuses`, `TasksConfig`,
  `CoreError::{TaskConflict, TaskNotFound, InvalidTasksConfig}`.

- [ ] **Step 1: Write the failing tests for status validation and hashing**

Add to `crates/oximemo-core/src/tasks.rs` (new file):

```rust
//! Task extraction, mutation, and serialization for the Tasks feature.
//! Spec: docs/superpowers/specs/2026-08-27-tasks-design.md.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_line_hash_is_16_lowercase_hex_chars() {
        let h = TaskLineHash::of_line("- [ ] buy milk 📅 2026-08-30");
        assert_eq!(h.0.len(), 16);
        assert!(h.0.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
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
            symbol: "X".into(), // collides with built-in 'x' after normalization
            name: None,
            next: "x".into(),
            r#type: StatusType::Done,
        });
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
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p oximemo-core tasks::tests -- --nocapture`
Expected: compile errors (`TaskLineHash`, `TasksConfig`, etc. don't exist
yet).

- [ ] **Step 3: Implement the domain types**

At the top of `crates/oximemo-core/src/tasks.rs`, above the test module:

```rust
use crate::error::{CoreError, Result};
use serde::{Deserialize, Serialize};
use time::Date;

/// Lowercase 16-hex-digit BLAKE3 hash of one task's raw source line.
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Priority {
    Lowest,
    Low,
    None,
    Medium,
    High,
    Highest,
}

impl Default for Priority {
    fn default() -> Self {
        Priority::None
    }
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
    /// - symbols are unique after normalization
    /// - every `next` resolves to a configured (or built-in) symbol
    /// - every `type` is a known `StatusType` (guaranteed by the Rust
    ///   type system once deserialized, so this reduces to the first
    ///   three checks plus re-validating after merge)
    pub fn effective_statuses(&self) -> Result<EffectiveStatuses> {
        let mut by_symbol = std::collections::BTreeMap::new();
        for (sym, next, ty) in BUILTIN_STATUSES {
            by_symbol.insert(*sym, (None, *next, *ty));
        }
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
```

Add three variants to `crates/oximemo-core/src/error.rs`'s `CoreError` enum
(insert before the closing `#[error("{0}")] Other(String),` arm, keep
`Other` last):

```rust
    #[error("task conflict: note {memo_id} changed since it was read")]
    TaskConflict { memo_id: crate::memo::MemoId },

    #[error("task not found: note {memo_id} line {line}")]
    TaskNotFound { memo_id: crate::memo::MemoId, line: u32 },

    #[error("invalid tasks config: {0}")]
    InvalidTasksConfig(String),
```

Register the module in `crates/oximemo-core/src/lib.rs`: find the
alphabetically-sorted `pub mod` list and insert `pub mod tasks;` in its
correct alphabetical position (between whichever two existing modules
sort around `tasks` — read the file first to find them; do not guess the
list).

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p oximemo-core tasks::tests -- --nocapture`
Expected: PASS, all 8 tests green.

- [ ] **Step 5: Add `TasksConfig` to `VaultConfig` and validate the setter**

Read `crates/oximemo-core/src/config.rs` in full first (496 lines) to see
the exact `VaultConfig` field list and the `DailyConfig` shape
(`config.rs:135-151` is the precedent — copy its doc-comment style, not
its content). Add:

```rust
#[serde(default)]
pub tasks: crate::tasks::TasksConfig,
```

as a new field on `VaultConfig` (`config.rs:14-36`), and a test mirroring
the existing `daily_section_defaults_and_overrides` test
(`config.rs:435-457`) named `tasks_section_defaults_and_overrides` that
round-trips a `[tasks]` TOML block through `VaultConfig` and asserts
`enabled == true`, `write_format == WriteFormat::Emoji`,
`default_section == "할 일"` by default.

In `crates/oximemo-core/src/vault.rs`, add `set_tasks_config` mirroring the
existing `set_daily_config` pattern exactly (same file, ~`vault.rs:2004-
2006`, using the private `replace_section` helper at ~`vault.rs:1990-
1995` — read both first to copy the exact signature shape), **except**
call `value.effective_statuses()` and propagate its `Err` *before*
calling `replace_section` (config load never validates elsewhere in this
codebase, but writes must reject bad input per spec §11):

```rust
pub fn set_tasks_config(&self, value: crate::tasks::TasksConfig) -> Result<()> {
    value.effective_statuses()?;
    self.replace_section(|cfg, v| cfg.tasks = v, value)
}
```

Add a `vault::tests` test `set_tasks_config_rejects_invalid_statuses` that
constructs a `TasksConfig` with a duplicate-after-normalization symbol and
asserts `set_tasks_config` returns `Err` and the on-disk config is
unchanged (re-open the vault and check `with_config(|c| c.tasks.clone())`
still equals the pre-call default).

- [ ] **Step 6: Run the full core test suite**

Run: `cargo test -p oximemo-core`
Expected: all previously-passing 370 tests plus the new ones PASS (0
failures). If any existing test constructs `VaultConfig` with a struct
literal instead of `Default`/deserialization, it will fail to compile —
fix those call sites by adding `tasks: Default::default()` or switching to
`..Default::default()`.

- [ ] **Step 7: Commit**

```bash
git add crates/oximemo-core/src/tasks.rs crates/oximemo-core/src/lib.rs \
        crates/oximemo-core/src/error.rs crates/oximemo-core/src/config.rs \
        crates/oximemo-core/src/vault.rs
git commit -m "feat(tasks): add task domain types, status validation, and [tasks] config"
```

---

### Task 2: Line parser — extraction into `TaskRow`

**Files:**
- Modify: `crates/oximemo-core/src/tasks.rs`
- Test: same file, `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: `TaskLineHash`, `TaskField`, `TaskWarning`, `TaskWarningKind`,
  `StatusType`, `Priority`, `EffectiveStatuses`, `TasksConfig` (Task 1);
  `crate::tags::extract_tags(body: &str) -> Vec<String>`
  (`crates/oximemo-core/src/tags.rs:19-20`, read it first — it scans a
  whole body, so call it on the isolated description substring, not the
  full note body).
- Produces: `pub struct TaskRow { .. }`, `pub struct ParsedTasks { pub
  tasks: Vec<TaskRow>, pub truncated: bool }`, `pub fn parse_tasks(body:
  &str, cfg: &TasksConfig) -> ParsedTasks`, and the crate-internal
  `pub(crate) struct LineSpans` + `pub(crate) fn parse_task_line(raw: &str,
  cfg: &EffectiveStatuses) -> Option<(TaskRowFields, LineSpans)>` that
  Task 4/5 (`transform_task_draft`) reuse for byte-precise splicing —
  design it so `parse_tasks` calls this same function per candidate line
  and discards `LineSpans`, so there is exactly one line-grammar
  implementation.

- [ ] **Step 1: Write the failing tests**

Add to `tasks.rs`'s test module (append; do not replace Task 1's tests):

```rust
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
        // spec §1 example line, minus the recurrence suffix (Task 5 covers recurrence).
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
        assert_eq!(parsed.tasks[2].symbol, 'x', "X normalizes to x in the stored row");
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
        // Two siblings at indent 2 under one parent at indent 0: both
        // must record the parent, not the preceding sibling.
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
        assert!(t.warnings.iter().any(|w| w.kind == TaskWarningKind::Duplicate));
    }

    #[test]
    fn invalid_date_value_is_warned_not_dropped() {
        let body = "- [ ] task 📅 not-a-date\n";
        let parsed = parse_tasks(body, &cfg());
        let t = &parsed.tasks[0];
        assert!(t.due.is_none());
        assert!(t
            .warnings
            .iter()
            .any(|w| w.kind == TaskWarningKind::InvalidValue && w.raw.contains("not-a-date")));
    }

    #[test]
    fn nbsp_between_emoji_and_date_is_accepted() {
        let body = "- [ ] task 📅\u{00A0}2026-08-30\n";
        let parsed = parse_tasks(body, &cfg());
        assert_eq!(parsed.tasks[0].due, Some(time::macros::date!(2026 - 08 - 30)));
    }

    #[test]
    fn variation_selector_is_ignored_for_matching_but_kept_in_raw() {
        let body = "- [ ] task 📅\u{FE0F} 2026-08-30\n";
        let parsed = parse_tasks(body, &cfg());
        assert_eq!(parsed.tasks[0].due, Some(time::macros::date!(2026 - 08 - 30)));
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p oximemo-core tasks::tests -- --nocapture`
Expected: compile errors (`TaskRow`, `parse_tasks` don't exist).

- [ ] **Step 3: Implement `TaskRow` and `parse_tasks`**

Append to `tasks.rs` (above the test module):

```rust
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

pub const MAX_TASKS_PER_NOTE: usize = 1000;

/// Field token spans within one raw line, byte-offset ranges into that
/// line's `&str`. Used by `transform_task_draft` (Task 4/5) to splice
/// exactly the recognized token, preserving every other byte untouched.
/// Not serialized; internal to this module.
#[derive(Debug, Clone, Default)]
pub(crate) struct LineSpans {
    pub checkbox: std::ops::Range<usize>, // e.g. "- [ ]" or "1. [x]"
    pub fields: Vec<(TaskField, std::ops::Range<usize>)>,
    pub global_filter: Option<std::ops::Range<usize>>,
}

/// Extract every extended-checkbox line from `body` into `TaskRow`s.
/// Pure; does not consult a `Vault`. CommonMark fence rules (backtick and
/// tilde, opener length, matching closer, up to three leading spaces) and
/// 4-space indented code both exclude task-like text inside them (spec
/// §3). Enforces `MAX_TASKS_PER_NOTE` and reports `truncated`.
pub fn parse_tasks(body: &str, cfg: &TasksConfig) -> ParsedTasks {
    let eff = cfg.effective_statuses().unwrap_or_else(|_| {
        // A config that fails validation never reaches here in practice
        // (Vault::set_tasks_config rejects it before save; a hand-edited
        // file falls back to built-in defaults for this parse, same
        // corrupt-file tolerance as VaultConfig::load elsewhere).
        TasksConfig::default().effective_statuses().expect("default statuses are always valid")
    });
    // ... implementation: walk `body` line by line, tracking:
    //  - current CommonMark fence state (none | Backtick{len} | Tilde{len})
    //    to skip fenced content; a line is a fence opener/closer per
    //    CommonMark (<=3 leading spaces, run of >=3 matching chars, an
    //    opener also allows an info string, a closer must be bare);
    //  - 4-space-or-more indentation (after tab expansion to the next
    //    multiple of 4) that is not inside a list = indented code, skip;
    //  - the nearest preceding ATX/Setext heading text for `section`;
    //  - an indent-column stack of (indent_columns, task_index) to
    //    compute `parent` as the nearest containing shallower task line;
    //  - global_filter: if cfg.global_filter is non-empty, a line must
    //    contain that exact token (checked against the raw line, not the
    //    stripped description) to be recognized as a task at all; strip
    //    the token from `text` same as any other recognized span.
    // For each candidate list-item line, call `parse_task_line(line, &eff)`
    // (Step 4 below); on `Some((fields, _spans))` push a `TaskRow` with
    // `line_hash: TaskLineHash::of_line(line)`; stop recognizing new tasks
    // once `MAX_TASKS_PER_NOTE` is reached and set `truncated = true`
    // (already-recognized rows are kept, later ones are dropped, not the
    // reverse).
    todo!("implement per the walkthrough above and the test cases in this module")
}
```

**Do not leave the `todo!()` in the final implementation** — the line
above marks where the actual implementation body goes; replace it
entirely with real line-scanning code that makes every test in Step 1
pass. The comment block above it is your algorithm outline, not optional
detail.

- [ ] **Step 4: Implement the shared single-line parser**

Still in `tasks.rs`:

```rust
struct TaskRowFields {
    symbol: char,
    status_type: StatusType,
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

/// Parse one already-fence-excluded, already-indent-classified raw line
/// as a task list item. Returns `None` if the line is not a checkbox list
/// item at all (ordinary text, ordinary list item, `NON_TASK`-typed
/// symbol per spec §2 stays a `TaskRowFields` with `StatusType::NonTask`
/// — it IS returned, `parse_tasks` is the one that excludes it from
/// `IndexRecord.tasks`).
///
/// List marker recognition: `-`, `*`, `+`, or `N.`/`N)` followed by one
/// space, then `[<one char>]`, then one space, then the rest of the line.
/// Emoji/dataview field scanning happens over "the rest of the line"
/// only, skipping any inline-code span (`` `...` ``) or link destination
/// (`(...)` immediately after `[...]`) — text inside those is never
/// treated as a field, even if it looks like one (spec §1).
pub(crate) fn parse_task_line(
    raw: &str,
    eff: &EffectiveStatuses,
) -> Option<(TaskRowFields, LineSpans)> {
    todo!("implement: marker + checkbox recognition, field-token scanning \
           with NBSP (U+00A0) and variation-selector (U+FE0F) tolerance, \
           rightmost-valid-wins duplicate resolution with TaskWarning, \
           inline-code/link-destination exclusion, description = \
           remainder after stripping checkbox + recognized field spans + \
           global_filter token, tag extraction via crate::tags::extract_tags \
           on the description substring only")
}
```

Implement both `todo!()` bodies for real. Use `time::Date` parsing for
`YYYY-MM-DD` (the crate already depends on `time`; use
`time::Date::parse` with a `format_description!("[year]-[month]-[day]")`
or hand-roll a strict 3-part numeric parse — either is fine as long as
`"not-a-date"` fails and `"2026-08-30"` succeeds). Priority emoji mapping
(spec §1): `🔺` = Highest, `⏫` = High, `🔼` = Medium, `🔽` = Low, `⏬` =
Lowest; dataview `[priority:: highest|high|medium|low|lowest]` maps the
same way case-insensitively.

- [ ] **Step 5: Run to verify it passes**

Run: `cargo test -p oximemo-core tasks::tests -- --nocapture`
Expected: PASS, all tests from Step 1 (and Task 1's) green.

- [ ] **Step 6: Add the proptest invariant**

Add a `proptest!` block (the crate already depends on `proptest`, see
`Cargo.toml:46`) asserting: for any generated valid task line + an
unrelated field's new value, splicing that field (using
`parse_task_line`'s spans, not the full transform kernel — this proptest
targets the *parser's* span correctness, Task 4/5 add the *transform*
proptest) and re-parsing yields a `TaskRow` where every other field is
byte-identical to the original parse. Name it
`prop_unrelated_field_edit_preserves_other_spans`. If constructing this
proptest requires transform helpers that don't exist until Task 4, it is
acceptable to defer this specific proptest to Task 5's test step instead
— note in the commit message which you chose.

- [ ] **Step 7: Run full core suite and commit**

Run: `cargo test -p oximemo-core`
Expected: 0 failures.

```bash
git add crates/oximemo-core/src/tasks.rs
git commit -m "feat(tasks): implement extended-checkbox line parser and TaskRow extraction"
```

---

### Task 3: `render_new_task` and write-format serialization

**Files:**
- Modify: `crates/oximemo-core/src/tasks.rs`

**Interfaces:**
- Consumes: `TaskLineHash`, `TasksConfig`, `WriteFormat`, `Priority`,
  `DateField` (Task 1); `TaskRow` shape (Task 2, for round-trip tests).
- Produces: `pub struct TaskFields { .. }`, `pub fn render_new_task(text:
  &str, fields: &TaskFields, cfg: &TasksConfig) -> Result<String>` used by
  `add_task` (Task 9) and by the CLI `task add` command (Task 11).

- [ ] **Step 1: Write the failing tests**

```rust
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p oximemo-core tasks::tests::render_new_task -- --nocapture`
Expected: compile errors (`TaskFields`, `render_new_task` don't exist).

- [ ] **Step 3: Implement**

```rust
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
    // append recognized fields in the spec §1 canonical field-table order
    // (created, start, scheduled, due, priority, recurrence), formatted
    // per cfg.write_format:
    //  - WriteFormat::Emoji: "🛫 YYYY-MM-DD" etc, priority as its emoji
    //    (🔺/⏫/🔼/🔽/⏬; Priority::None emits nothing), recurrence as
    //    "🔁 <rule>"
    //  - WriteFormat::Dataview: "[start:: YYYY-MM-DD]" etc, "[priority::
    //    highest|high|medium|low|lowest]", "[repeat:: <rule>]"
    todo!("append fields.start/scheduled/due/priority/recurrence per cfg.write_format")
}
```

Implement the `todo!()` for real, covering every branch exercised by the
tests in Step 1.

- [ ] **Step 4: Run to verify it passes, run full suite, commit**

Run: `cargo test -p oximemo-core tasks::tests -- --nocapture` then
`cargo test -p oximemo-core`.
Expected: all green, 0 failures.

```bash
git add crates/oximemo-core/src/tasks.rs
git commit -m "feat(tasks): render_new_task serializer for both write formats"
```

---

### Task 4: `transform_task_draft` — non-terminal single-line edits

**Files:**
- Modify: `crates/oximemo-core/src/tasks.rs`

**Interfaces:**
- Consumes: `TaskLineHash`, `TaskField`, `DateField`, `Priority`,
  `EffectiveStatuses`, `TasksConfig`, `WriteFormat` (Task 1);
  `parse_task_line`/`LineSpans`/`TaskRowFields` (Task 2, `pub(crate)`);
  `render_new_task`'s per-field formatting logic (Task 3 — factor the
  "format one field as emoji/dataview token" logic out of
  `render_new_task` into a shared private helper `fn format_field_token
  (field: TaskField, value: &Value, fmt: WriteFormat) -> String` if it
  isn't already separable, so both functions share one formatting
  implementation).
- Produces: `pub enum TaskEdit { Toggle, SetStatus(char), SetDate {
  field: DateField, value: Option<Date> }, SetPriority(Priority),
  SetText(String), SetRecurrence(Option<String>), Delete }`, `pub struct
  TaskLineChange { pub start_line: u32, pub delete_lines: u32, pub
  insert_lines: Vec<String> }`, `pub struct TaskDraftTransform { pub
  changes: Vec<TaskLineChange> }`, `pub fn transform_task_draft(body:
  &str, line: u32, edit: &TaskEdit, today: Date, cfg: &TasksConfig) ->
  Result<TaskDraftTransform>` — **this task implements every `TaskEdit`
  variant except the terminal-status/recurrence-spawn behavior of
  `Toggle`/`SetStatus` entering `DONE`/`CANCELLED`, and except `Delete`'s
  subtree dedent; Task 5 adds those.** For this task, `Toggle`/
  `SetStatus` simply flip the symbol and update `status_type`-derived
  fields with no cross-clearing and no recurrence spawn (Task 5 replaces
  that stub logic).

- [ ] **Step 1: Write the failing tests**

```rust
    fn transform_single_line(body: &str, edit: TaskEdit) -> String {
        let c = cfg();
        let today = time::macros::date!(2026 - 08 - 27);
        let t = transform_task_draft(body, 0, &edit, today, &c).unwrap();
        apply_line_changes(body, &t.changes) // test-only helper, see Step 3
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
            TaskEdit::SetDate { field: DateField::Due, value: None },
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
        assert!(out.starts_with("  - [ ]"), "indentation and marker preserved");
        assert!(out.contains("new text"));
        assert!(out.contains("📅 2026-08-30"));
        assert!(out.contains("#tag"));
        assert!(!out.contains("old text"));
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
        assert!(transform_task_draft(body, 0, &TaskEdit::SetText("a\nb".into()), today, &c).is_err());
        assert!(transform_task_draft(body, 0, &TaskEdit::SetText("a\0b".into()), today, &c).is_err());
    }

    #[test]
    fn set_recurrence_adds_and_clears_rule() {
        let body = "- [ ] task\n";
        let out = transform_single_line(
            body,
            TaskEdit::SetRecurrence(Some("every week".into())),
        );
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
        let t = transform_task_draft(body, 1, &TaskEdit::SetPriority(Priority::Low), today, &c).unwrap();
        assert_eq!(t.changes.len(), 1);
        assert_eq!(t.changes[0].start_line, 1);
        assert_eq!(t.changes[0].delete_lines, 1);
    }
```

Add the test-only helper referenced above (place it near the top of the
test module, above the tests that use it):

```rust
    /// Test-only: apply a `TaskDraftTransform`'s changes to `body`,
    /// returning the resulting full text. Mirrors what the CM6 adapter
    /// does with document offsets, but line-based since this is a plain
    /// Rust test. Changes are assumed non-overlapping and are applied
    /// from the bottom up so earlier `start_line` values stay valid.
    fn apply_line_changes(body: &str, changes: &[TaskLineChange]) -> String {
        let mut lines: Vec<String> = body.lines().map(str::to_string).collect();
        let mut sorted: Vec<&TaskLineChange> = changes.iter().collect();
        sorted.sort_by(|a, b| b.start_line.cmp(&a.start_line));
        for c in sorted {
            let start = c.start_line as usize;
            let end = start + c.delete_lines as usize;
            lines.splice(start..end, c.insert_lines.iter().cloned());
        }
        let mut out = lines.join("\n");
        out.push('\n');
        out
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p oximemo-core tasks::tests -- --nocapture`
Expected: compile errors (`TaskEdit`, `TaskLineChange`, `TaskDraftTransform`,
`transform_task_draft` don't exist).

- [ ] **Step 3: Implement**

```rust
#[derive(Debug, Clone, PartialEq)]
pub enum TaskEdit {
    Toggle,
    SetStatus(char),
    SetDate { field: DateField, value: Option<Date> },
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
}

/// Pure transition/recurrence kernel (spec §5/§6/§7.1). Takes the full
/// unsaved draft body plus the target 0-based line, so it can see the
/// task's full subtree — required for `recurrence_insert = "below"`
/// (Task 5) to target the gap *after* the subtree rather than stealing
/// its children. Reads and writes no disk. Desktop calls this from the
/// CM6 editor (on the unsaved buffer) AND from `Vault::patch_task` (on
/// the freshly-read file body, under the exclusive lock) — one
/// implementation, two call sites (spec §5/§6 explicitly forbid
/// duplicating this logic).
pub fn transform_task_draft(
    body: &str,
    line: u32,
    edit: &TaskEdit,
    today: Date,
    cfg: &TasksConfig,
) -> Result<TaskDraftTransform> {
    if let TaskEdit::SetText(t) = edit {
        if t.contains('\n') || t.contains('\0') {
            return Err(CoreError::InvalidTasksConfig(
                "task text must not contain newline or NUL".into(),
            ));
        }
    }
    let eff = cfg.effective_statuses()?;
    let lines: Vec<&str> = body.lines().collect();
    let raw = lines.get(line as usize).ok_or_else(|| {
        CoreError::other(format!("transform_task_draft: line {line} out of range"))
    })?;
    let Some((fields, spans)) = parse_task_line(raw, &eff) else {
        return Err(CoreError::other(format!(
            "transform_task_draft: line {line} is not a task line"
        )));
    };
    match edit {
        TaskEdit::Delete => {
            // Task 5 replaces this arm with the bounded-subtree dedent.
            unimplemented!("Task 5 implements Delete's subtree dedent")
        }
        TaskEdit::Toggle | TaskEdit::SetStatus(_) => {
            // Task 5 replaces this arm with terminal-transition handling
            // (cross-clearing done/cancelled, recurrence spawn). For this
            // task, implement only the same-line symbol splice: Toggle
            // looks up `eff.get(fields.symbol).1` (the configured `next`
            // symbol) and splices it in; SetStatus splices the given
            // symbol verbatim into the same checkbox span.
            todo!("splice new symbol into spans.checkbox, single TaskLineChange")
        }
        TaskEdit::SetDate { field, value } => {
            todo!("splice or insert/remove the field's token using spans.fields, \
                   formatted per cfg.write_format (reuse Task 3's field-token \
                   formatter)")
        }
        TaskEdit::SetPriority(p) => {
            todo!("splice or insert/remove the priority token")
        }
        TaskEdit::SetText(new_text) => {
            todo!("rebuild the line: keep everything up to the end of the \
                   checkbox span, then new_text, then every recognized \
                   field span and the global_filter span in their \
                   original relative order and exact original bytes, \
                   as one full-line replacement (delete_lines: 1)")
        }
        TaskEdit::SetRecurrence(rule) => {
            todo!("splice or insert/remove the recurrence token")
        }
    }
}
```

Implement every `todo!()` for real (leave the two `unimplemented!()` arms
for `Delete` and the terminal-transition path of `Toggle`/`SetStatus` —
Task 5 replaces those two arms specifically; do not leave `todo!()`
anywhere else). Each non-Delete, non-terminal-transition arm returns
`Ok(TaskDraftTransform { changes: vec![TaskLineChange { start_line: line,
delete_lines: 1, insert_lines: vec![new_line] }] })`.

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p oximemo-core tasks::tests -- --nocapture`
Expected: every test from Step 1 PASSes. (Tests that would exercise
`Delete` or DONE/CANCELLED transitions are not present yet — Task 5 adds
them alongside its implementation.)

- [ ] **Step 5: Property test — unrelated field edits touch only their own span**

Add (or move here if deferred from Task 2):

```rust
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
```

Run: `cargo test -p oximemo-core tasks::tests -- --nocapture`
Expected: PASS.

- [ ] **Step 6: Run full core suite and commit**

Run: `cargo test -p oximemo-core`
Expected: 0 failures.

```bash
git add crates/oximemo-core/src/tasks.rs
git commit -m "feat(tasks): transform_task_draft for non-terminal single-line edits"
```

---

### Task 5: Terminal transitions, recurrence spawn, and `Delete` subtree dedent

**Files:**
- Modify: `crates/oximemo-core/src/tasks.rs`

**Interfaces:**
- Consumes: everything from Tasks 1-4, plus
  `crate::expr::value::{DurationSpec, date_add}` (read
  `crates/oximemo-core/src/expr/value.rs` around lines 29-37 and 205-226
  first to confirm the exact current signature before writing code
  against it) and `time::UtcOffset` (for the `local: UtcOffset` parameter
  — local-time semantics only, no timezone database lookups: the caller
  supplies today's local offset the same way `today: Date` is supplied,
  see Step 3).
- Produces: replaces the two `unimplemented!()` arms left in Task 4's
  `transform_task_draft` (`Delete`, and the terminal-transition path of
  `Toggle`/`SetStatus`). No new public types.

- [ ] **Step 1: Write the failing tests**

```rust
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
        // x -> X is DONE -> DONE: not a type change, done date untouched.
        let body = "- [x] task ✅ 2026-08-20\n";
        let c = cfg();
        let today = time::macros::date!(2026 - 08 - 27);
        let t = transform_task_draft(body, 0, &TaskEdit::SetStatus('X'), today, &c).unwrap();
        let out = apply_line_changes(body, &t.changes);
        let row = parse_tasks(&out, &c).tasks.remove(0);
        assert_eq!(row.done, Some(time::macros::date!(2026 - 08 - 20)), "unchanged");
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
        assert_eq!(rows[0].status_type, StatusType::Todo, "spawned occurrence is above");
        assert_eq!(rows[0].due, Some(time::macros::date!(2026 - 09 - 03)));
        assert_eq!(rows[1].status_type, StatusType::Done, "original stays, completed");
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
        // spawned occurrence must appear after "child" and before "unrelated",
        // never between "task" and "child".
        let task_idx = lines.iter().position(|l| l.contains("📅 2026-09-03")).unwrap();
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
        let spawned = parse_tasks(&out, &c).tasks.into_iter().find(|r| r.status_type == StatusType::Todo).unwrap();
        // shift is anchored on `due` (2026-08-20 -> 2026-08-27), and every
        // present date shifts by the SAME delta (+7d):
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
        let spawned = parse_tasks(&out, &c).tasks.into_iter().find(|r| r.status_type == StatusType::Todo).unwrap();
        assert_eq!(spawned.due, Some(time::macros::date!(2026 - 09 - 03)), "today + 1 week, not due + 1 week");
    }

    #[test]
    fn month_recurrence_uses_calendar_months_with_end_of_month_clamp() {
        let c = cfg();
        let today = time::macros::date!(2026 - 08 - 27);
        let body = "- [ ] task 📅 2026-01-31 🔁 every month\n";
        let t = transform_task_draft(body, 0, &TaskEdit::Toggle, today, &c).unwrap();
        let out = apply_line_changes(body, &t.changes);
        let spawned = parse_tasks(&out, &c).tasks.into_iter().find(|r| r.status_type == StatusType::Todo).unwrap();
        assert_eq!(spawned.due, Some(time::macros::date!(2026 - 02 - 28)), "clamped, no panic");
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
        // parses with a warning (this line already carries an invalid
        // rule per spec §6's "requires at least one of start/scheduled/
        // due"); toggling it to DONE must not panic or silently spawn —
        // either the transform succeeds with no spawn, or it surfaces
        // the same warning. Assert no spawn happened either way:
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
        assert_eq!(rows[0].indent_columns, 0, "dedented by the deleted parent's indent delta");
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p oximemo-core tasks::tests -- --nocapture`
Expected: `unimplemented!()` panics for the `Delete` and terminal-transition
tests; other suites still pass.

- [ ] **Step 3: Implement**

Replace the `TaskEdit::Delete` `unimplemented!()` arm:

```rust
TaskEdit::Delete => {
    let deleted_indent = fields_indent_columns; // capture before the match, see note below
    let mut end = line as usize + 1;
    while let Some(next_raw) = lines.get(end) {
        let next_indent = /* compute indent_columns the same way parse_tasks does */;
        if next_indent <= deleted_indent {
            break;
        }
        end += 1;
    }
    let mut insert_lines = Vec::new();
    for raw_child in &lines[(line as usize + 1)..end] {
        insert_lines.push(dedent_line(raw_child, deleted_indent));
    }
    Ok(TaskDraftTransform {
        changes: vec![TaskLineChange {
            start_line: line,
            delete_lines: (end - line as usize) as u32,
            insert_lines,
        }],
    })
}
```

You will need to factor the tab-aware indent-column computation out of
`parse_tasks` (Task 2) into a shared private `fn indent_columns_of(raw:
&str) -> u16` so both functions use one implementation, and write
`fn dedent_line(raw: &str, delta: u16) -> String` that removes exactly
`delta` columns worth of leading whitespace (tabs count as advancing to
the next multiple of 4, same rule as indentation measurement) while
leaving the rest of the line untouched.

Replace the `Toggle | SetStatus(_)` `todo!()` arm with terminal-transition
handling: compute `(_, next_symbol, new_type) = eff.get(new_symbol)` where
`new_symbol` is `eff.get(fields.symbol).1` for `Toggle` or the given `char`
for `SetStatus`; compare `fields.status_type` (old type) to `new_type`:

- entering `Done`: splice the new symbol, add/replace `done = today`
  token, remove any `cancelled` token; if the task has a `recurrence` rule
  and `date_add`-based spawn succeeds (see below), also emit a second
  `TaskLineChange` inserting the spawned occurrence line either at
  `start_line: line, delete_lines: 0` (above, default) or at the gap
  after the full subtree's last line (below — reuse the same subtree-scan
  loop shape as `Delete`, but without removing anything).
- entering `Cancelled`: mirror `Done` (stamp `cancelled = today`, clear
  `done`), no recurrence spawn (spec §6 only fires "on entering DONE").
- leaving `Done` or `Cancelled` (new type is neither): clear the
  corresponding date field, no other side effect.
- same-type transition (old type == new type, e.g. `x -> X`): splice only
  the symbol, no date changes, no spawn (the no-op tests above).

Recurrence spawn arithmetic: parse the rule string (grammar in Global
Constraints), pick the reference date via `due > scheduled > start`
(`when done` anchors on `today` instead of any of those three), build a
`DurationSpec` (`calendar_months` for month/year units, `fixed_millis` for
day/week/weekday units — 1 week = 7 * 86_400_000 ms), call
`crate::expr::value::date_add(reference.midnight().assume_offset(local),
&duration, 1, local)` where `local` is a `time::UtcOffset` — **for this
pure function, use `time::UtcOffset::UTC`**, since date-only values have
no timezone and the function's contract only needs a consistent offset for
calendar-month clamping, not a real local zone (the caller-supplied
`today: Date` already encodes the caller's local day, matching the
existing `open_daily(date)` convention cited in the spec); shift every
present date field (`start`/`scheduled`/`due`) by the same delta so a
start→due window width is preserved; a rule that isn't `every ...` at all,
or uses a unit/structure outside the supported grammar, must not spawn —
return the transform with only the status-splice change, no second
`TaskLineChange`, and no error (spec §6: "parsing fails ... completion
does not spawn a child", not a hard error from `transform_task_draft`
itself). Re-toggling an already-`Done`/`Cancelled` task to the same type
must not spawn twice (the no-op test).

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p oximemo-core tasks::tests -- --nocapture`
Expected: every test in this task's Step 1 PASSes, and all of Tasks 1-4's
tests still pass.

- [ ] **Step 5: Recurrence proptest**

```rust
    proptest::proptest! {
        #[test]
        fn prop_recurrence_shift_preserves_date_window_width(days_offset in 1i64..365) {
            let c = cfg();
            let today = time::macros::date!(2026 - 08 - 27);
            let due = today; // any fixed anchor; the property is about the delta, not the absolute date
            let start = due - time::Duration::days(days_offset);
            let body = format!(
                "- [ ] task 🛫 {start} 📅 {due} 🔁 every week\n",
            );
            let t = transform_task_draft(&body, 0, &TaskEdit::Toggle, today, &c).unwrap();
            let out = apply_line_changes(&body, &t.changes);
            let spawned = parse_tasks(&out, &c).tasks.into_iter().find(|r| r.status_type == StatusType::Todo).unwrap();
            let new_width = (spawned.due.unwrap() - spawned.start.unwrap()).whole_days();
            proptest::prop_assert_eq!(new_width, days_offset);
        }
    }
```

Adjust the `{start}`/`{due}` formatting to whatever `Date`'s `Display`
actually produces (check with a quick `println!` in a scratch test if
unsure) — it must render as `YYYY-MM-DD` for the parser to accept it; if
`time::Date`'s default `Display` isn't `YYYY-MM-DD`, format explicitly
with a `format_description!`.

- [ ] **Step 6: Run full core suite and commit**

Run: `cargo test -p oximemo-core`
Expected: 0 failures (should now be roughly 370 + ~50 new tests).

```bash
git add crates/oximemo-core/src/tasks.rs
git commit -m "feat(tasks): terminal status transitions, recurrence spawn, and Delete dedent"
```

---

### Task 6: `IndexRecord.tasks` integration, fingerprint reindex, snapshot cap

**Files:**
- Modify: `crates/oximemo-core/src/store/index.rs`
- Modify: `crates/oximemo-core/src/vault.rs`
- Test: `crates/oximemo-core/src/vault.rs` (`vault::tests` module) and
  `crates/oximemo-core/src/store/index.rs`

**Interfaces:**
- Consumes: `TaskRow`, `parse_tasks`, `MAX_TASKS_PER_NOTE`, `TasksConfig`
  (Tasks 1-2).
- Produces: `IndexRecord.tasks: Vec<TaskRow>`, `IndexRecord
  .tasks_truncated: bool` (both `#[serde(default)]`); a new
  `TASKS_FINGERPRINT_MARKER` file analogous to the existing
  `index-fmt` marker, comparing a BLAKE3 fingerprint of canonical
  `(parser_version, enabled, global_filter, statuses)`; `Vault::migrate`
  triggers a full `reindex()` when either the `INDEX_FORMAT_VERSION` or
  the tasks fingerprint changed since last open.

- [ ] **Step 1: Write the failing tests**

Read `crates/oximemo-core/src/vault.rs` lines around `2280-2360` (the
existing `INDEX_FORMAT_VERSION` migrate-marker check) and `2853-2872`
(`record_of`) in full before writing code — copy the marker-file pattern
exactly, do not invent a new one. Read `crates/oximemo-core/src/paths.rs`
for how `index_fmt_marker_path()` is defined, and add a sibling
`tasks_fingerprint_path()` the same way.

Add to `vault::tests`:

```rust
    #[test]
    fn parsed_tasks_ride_the_existing_index_without_a_second_store() {
        let (vault, _tmp) = tmp_vault();
        vault.create_note(None, "- [ ] buy milk 📅 2026-08-30".into(), NoteFormat::Markdown).unwrap();
        let recs = vault.snapshot().unwrap();
        let rec = recs.iter().find(|r| !r.deleted).unwrap();
        assert_eq!(rec.tasks.len(), 1);
        assert_eq!(rec.tasks[0].text, "buy milk");
        assert!(!rec.tasks_truncated);
    }

    #[test]
    fn note_with_more_than_1000_tasks_sets_truncated_flag() {
        let (vault, _tmp) = tmp_vault();
        let mut body = String::new();
        for i in 0..1001 {
            body.push_str(&format!("- [ ] task {i}\n"));
        }
        vault.create_note(None, body, NoteFormat::Markdown).unwrap();
        let recs = vault.snapshot().unwrap();
        let rec = recs.iter().find(|r| !r.deleted).unwrap();
        assert_eq!(rec.tasks.len(), 1000);
        assert!(rec.tasks_truncated);
    }

    #[test]
    fn editing_note_body_updates_its_tasks_on_reindex() {
        let (vault, _tmp) = tmp_vault();
        let (memo, _) = (vault.create_note(None, "- [ ] first".into(), NoteFormat::Markdown).unwrap(), ());
        vault.update_note(memo.id, Some("- [ ] first\n- [ ] second".into()), None).unwrap();
        let recs = vault.snapshot().unwrap();
        let rec = recs.iter().find(|r| r.id == memo.id).unwrap();
        assert_eq!(rec.tasks.len(), 2);
    }

    #[test]
    fn changing_global_filter_triggers_reindex_via_fingerprint() {
        let (vault, _tmp) = tmp_vault();
        vault.create_note(None, "- [ ] no filter token".into(), NoteFormat::Markdown).unwrap();
        let mut tasks_cfg = vault.with_config(|c| c.tasks.clone());
        tasks_cfg.global_filter = "#task".into();
        vault.set_tasks_config(tasks_cfg).unwrap();
        // Re-open (migrate() runs on open, comparing the persisted
        // fingerprint) to simulate the next app launch picking up the
        // config-driven reindex, matching how INDEX_FORMAT_VERSION bumps
        // are picked up today:
        let reopened = Vault::open(Some(vault.paths.root())).unwrap();
        reopened.migrate().unwrap();
        let recs = reopened.snapshot().unwrap();
        let rec = recs.iter().find(|r| !r.deleted).unwrap();
        assert_eq!(rec.tasks.len(), 0, "no filter token present, now correctly excluded");
    }
```

Adjust the exact `tmp_vault()` / `create_note` / `Vault::open` call
shapes to match what already exists elsewhere in `vault::tests` — read a
handful of existing tests first (e.g. `reindex_is_idempotent`,
`open_migrates_default_vault_and_reindex_sees_the_memo`) and copy their
setup idioms exactly; the snippets above are illustrative of intent, not
a literal API guarantee for helper names like `vault.paths.root()`.

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p oximemo-core vault::tests -- --nocapture`
Expected: compile errors (`IndexRecord.tasks` field doesn't exist).

- [ ] **Step 3: Add the fields and update every constructor site**

In `crates/oximemo-core/src/store/index.rs`, add to `IndexRecord`
(`index.rs:25-53`) right after the existing `props` field:

```rust
    #[serde(default)]
    pub tasks: Vec<crate::tasks::TaskRow>,
    #[serde(default)]
    pub tasks_truncated: bool,
```

Update **every** `IndexRecord { .. }` construction site (the scout
research for this plan enumerated them; re-grep to be exhaustive before
finishing this step — do not trust this list as complete without
re-checking):
- `crates/oximemo-core/src/vault.rs` `record_of` (~2853-2872) — the real
  production site; call `crate::tasks::parse_tasks(&n.body,
  &self.with_config(|c| c.tasks.clone()))` here and set both new fields
  from its `ParsedTasks`.
- `crates/oximemo-core/src/base/exec.rs` synthetic query-file record
  (~445-461) — set `tasks: Vec::new(), tasks_truncated: false` (a query
  file is never a task source).
- `crates/oximemo-core/src/store/index.rs` test helper `rec()` (~362).
- `crates/oximemo-core/src/expr/eval.rs` test helper `rec()` (~746).
- `crates/oximemo-core/src/base/exec.rs` test constructors (~1750, 1793,
  1897, 1920, 1964, 2028, 2061) — set both fields to empty/false unless a
  specific test's whole point is task rows (none are, in this plan).

Compile after this step (`cargo build -p oximemo-core`) and fix every
`E0063: missing field` the compiler reports — the list above is a
starting point, not a substitute for reading the compiler's own error
list.

- [ ] **Step 4: Fingerprint marker and migrate wiring**

Read `crates/oximemo-core/src/vault.rs` lines 2280-2360 in full (the
`INDEX_FORMAT_VERSION` marker-check block inside `migrate()`) and
`crates/oximemo-core/src/paths.rs` for `index_fmt_marker_path()`. Add:

```rust
// vault.rs, near INDEX_FORMAT_VERSION:
/// Fingerprints the extraction-affecting subset of `[tasks]` config
/// (spec §3): `parser_version`, `enabled`, `global_filter`, `statuses`.
/// Presentation-only fields (`write_format`, `capture_target`,
/// `recurrence_insert`) are deliberately excluded — changing them never
/// changes what counts as a task.
const TASKS_PARSER_VERSION: u32 = 1;

fn tasks_fingerprint(cfg: &crate::tasks::TasksConfig) -> String {
    let canonical = format!(
        "{}:{}:{}:{:?}",
        TASKS_PARSER_VERSION, cfg.enabled, cfg.global_filter, cfg.statuses
    );
    blake3::hash(canonical.as_bytes()).to_hex().to_string()
}
```

In `paths.rs`, add `tasks_fingerprint_path()` mirroring
`index_fmt_marker_path()` exactly (same directory, sibling filename e.g.
`tasks-fingerprint`).

In `migrate()`, after the existing `INDEX_FORMAT_VERSION` check block,
add an equivalent check: read the persisted fingerprint file (missing =
treat as changed), compare to `tasks_fingerprint(&self.with_config(|c|
c.tasks.clone()))`; on mismatch call `self.reindex()?` (reuse the same
reindex call the version-bump path already makes — if `migrate()` already
decided to reindex for the version bump, do not reindex twice) and then
write the new fingerprint file. This makes `changing_global_filter_
triggers_reindex_via_fingerprint` (Step 1) pass.

- [ ] **Step 5: Snapshot cache task-weight cap**

Read `crates/oximemo-core/src/vault.rs` lines 96-101 (`SNAPSHOT_CACHE_CAP`)
and `1612-1644` (`snapshot_with_gen`) in full. Add a second cap alongside
the existing note-count cap — sum `recs.iter().map(|r|
r.tasks.len()).sum::<usize>()` and skip caching (return the freshly-loaded
`Arc` uncached, exactly like the existing `recs.len() >
SNAPSHOT_CACHE_CAP` branch does) when that sum exceeds a new
`const SNAPSHOT_TASK_WEIGHT_CAP: usize = 200_000;` (chosen so 50k notes ×
4 average tasks fits comfortably, while one note's `MAX_TASKS_PER_NOTE =
1000` cap still bounds any single record). Add a test
`snapshot_task_weight_cap_prevents_caching_oversized_task_vectors` that
creates enough notes with near-1000 tasks each to exceed the cap and
asserts two consecutive `vault.snapshot()` calls both succeed (this is a
"doesn't crash / doesn't hold a giant cached Arc forever" test, not a
performance benchmark — asserting successful completion is sufficient).

- [ ] **Step 6: Run full core suite and commit**

Run: `cargo test -p oximemo-core`
Expected: 0 failures.

```bash
git add crates/oximemo-core/src/store/index.rs crates/oximemo-core/src/vault.rs \
        crates/oximemo-core/src/paths.rs crates/oximemo-core/src/base/exec.rs \
        crates/oximemo-core/src/expr/eval.rs
git commit -m "feat(tasks): wire IndexRecord.tasks into extraction, reindex, and snapshot cap"
```

---

### Task 7: Lock-aware mutation internals (extract from `update_note_with`)

**Files:**
- Modify: `crates/oximemo-core/src/vault.rs`

**Interfaces:**
- Consumes: `crate::lock::{FileLock, LockKind, acquire}` (existing,
  `lock.rs`), existing `with_redb`/`with_redb_and_search` (vault.rs:820-
  835) as the *pattern* to generalize, not to call from inside a held
  lock.
- Produces: new pub(crate) helpers that Tasks 8-10 call while already
  holding one exclusive `FileLock` for the whole operation:
  `fn with_redb_locked<R>(&self, _guard: &FileLock, f: impl FnOnce(&RedbIndex) -> Result<R>) -> Result<R>`
  and
  `fn with_redb_and_search_locked<R>(&self, _guard: &FileLock, f: impl FnOnce(&RedbIndex, &TantivySearch) -> Result<R>) -> Result<R>`
  (both just open `RedbIndex`/`TantivySearch` transiently and call `f`,
  **without acquiring a new lock** — the `_guard: &FileLock` parameter
  exists purely so the compiler enforces "caller must already hold the
  lock", it is not used inside the body beyond that type-level proof);
  a private `fn read_file_locked(&self, id: MemoId) -> Result<(Memo,
  String, PathBuf)>` (memo, vault-relative path, absolute path) that does
  the disk read+parse without taking any lock itself (callers already
  hold one); a private `fn write_file_and_upsert_locked(&self, _guard:
  &FileLock, path: &Path, rel: &str, new_body: &str) -> Result<Memo>`
  that does the atomic file write, re-reads via `read_memo`, and upserts
  the index — this is the single choke point Tasks 8-10 call after
  computing their new body text.

- [ ] **Step 1: Write the failing test**

This task is pure refactoring (no new observable behavior), so its test
is a regression guard, not a new-feature test. Add to `vault::tests`:

```rust
    #[test]
    fn locked_helpers_do_not_change_update_note_with_behavior() {
        let (vault, _tmp) = tmp_vault();
        let memo = vault.create_note(None, "before".into(), NoteFormat::Markdown).unwrap();
        let updated = vault.update_note_with(memo.id, Some("after".into()), None, None).unwrap();
        assert_eq!(updated.body, "after");
        let refetched = vault.get_memo(memo.id).unwrap().unwrap();
        assert_eq!(refetched.body, "after");
    }

    #[test]
    fn concurrent_readers_do_not_deadlock_against_a_held_write_lock_scope() {
        // With the new locked helpers in place, a normal with_redb (shared)
        // call from another thread must still succeed promptly once the
        // exclusive scope releases — i.e. we have not introduced a lock
        // that outlives its intended scope.
        let (vault, _tmp) = tmp_vault();
        let vault = std::sync::Arc::new(vault);
        let memo = vault.create_note(None, "x".into(), NoteFormat::Markdown).unwrap();
        let v2 = vault.clone();
        let handle = std::thread::spawn(move || v2.get_memo(memo.id));
        let result = handle.join().unwrap();
        assert!(result.unwrap().is_some());
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p oximemo-core vault::tests::locked_helpers -- --nocapture`
Expected: PASS already for these two specific behaviors (they exercise
only existing public API) — this step is a baseline confirmation, not a
red step in the usual TDD sense. Proceed to Step 3 regardless; the real
regression protection is re-running these tests after refactoring.

- [ ] **Step 3: Extract the internal helpers**

Read `crates/oximemo-core/src/vault.rs` lines 812-835 (`lock`, `with_redb`,
`with_redb_and_search`) and 1128-1405 (`update_note_with`) in full before
editing. Add the four helpers described in Interfaces above, placed
immediately after `with_redb_and_search` (~line 836). Implementation
notes:

```rust
/// Caller already holds `guard` for the whole operation (spec §5: one
/// exclusive lock across read -> verify -> rewrite -> upsert). This
/// function itself acquires no lock; the `&FileLock` parameter is a
/// compile-time proof obligation, not a resource this function manages.
fn with_redb_locked<R>(
    &self,
    _guard: &FileLock,
    f: impl FnOnce(&RedbIndex) -> Result<R>,
) -> Result<R> {
    let idx = RedbIndex::open(&self.paths.meta_db_path())?;
    f(&idx)
}

fn with_redb_and_search_locked<R>(
    &self,
    _guard: &FileLock,
    f: impl FnOnce(&RedbIndex, &TantivySearch) -> Result<R>,
) -> Result<R> {
    let idx = RedbIndex::open(&self.paths.meta_db_path())?;
    let search = TantivySearch::open(&self.paths.search_dir())?;
    f(&idx, &search)
}
```

For `read_file_locked` and `write_file_and_upsert_locked`, do **not**
rewrite `update_note_with` itself in this task — leave its existing
per-step lock acquisition exactly as-is (it is proven correct by 370
passing tests and touching it is out of scope for this plan; Plan A only
needs new lock-aware entry points for the *new* task-mutation methods).
Instead, write `read_file_locked`/`write_file_and_upsert_locked` as new,
independent functions that mirror `update_note_with`'s file-I/O and
index-upsert steps (its "ALL file I/O unlocked" temp+rename write, then
one `with_redb_and_search`-shaped upsert) but parameterized to accept an
externally-held lock for the upsert half instead of acquiring their own.
Reuse `record_of`, `search_fields`, `hash::hash_memo`, and the existing
atomic-write helper (`write_document`, or whatever the current
`update_note_with` calls internally — read it first) rather than
reimplementing file writing.

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p oximemo-core vault::tests -- --nocapture`
Expected: PASS, including the two tests from Step 1.

- [ ] **Step 5: Run full core suite and commit**

Run: `cargo test -p oximemo-core`
Expected: 0 failures — this step must show the exact same 370-plus-prior-
tasks' count as before, since this task changes no observable behavior.

```bash
git add crates/oximemo-core/src/vault.rs
git commit -m "refactor(vault): extract lock-aware internal helpers for task mutation"
```

---

### Task 8: `Vault::patch_task`

**Files:**
- Modify: `crates/oximemo-core/src/vault.rs`

**Interfaces:**
- Consumes: `transform_task_draft`, `TaskEdit`, `TaskLineHash`,
  `parse_task_line`/`TaskRow` (Tasks 2, 4, 5); lock-aware helpers (Task
  7); `crate::tasks::MAX_TASKS_PER_NOTE`, `CoreError::{TaskConflict,
  TaskNotFound}` (Task 1).
- Produces: `pub struct TaskRef { pub memo_id: MemoId, pub line: u32, pub
  line_hash: TaskLineHash }`, `pub enum TaskSelector { Exact(TaskRef),
  CurrentLine { memo_id: MemoId, line: u32 } }`, `pub struct
  PatchTaskResult { pub note_hash: MemoHash, pub task: TaskDto, pub
  spawned: Option<TaskDto> }`, `pub struct TaskDto { .. }` (indexed
  `TaskRow` fields flattened plus `pub task_ref: TaskRef`), `impl Vault {
  pub fn patch_task(&self, s: TaskSelector, e: TaskEdit, today: Date) ->
  Result<PatchTaskResult> }`.

- [ ] **Step 1: Write the failing tests**

Add to `vault::tests`:

```rust
    #[test]
    fn patch_task_toggle_by_exact_ref_succeeds() {
        let (vault, _tmp) = tmp_vault();
        let memo = vault.create_note(None, "- [ ] buy milk".into(), NoteFormat::Markdown).unwrap();
        let hash = crate::tasks::TaskLineHash::of_line("- [ ] buy milk");
        let today = time::macros::date!(2026 - 08 - 27);
        let result = vault
            .patch_task(
                TaskSelector::Exact(TaskRef { memo_id: memo.id, line: 0, line_hash: hash }),
                TaskEdit::Toggle,
                today,
            )
            .unwrap();
        assert_eq!(result.task.status_type, StatusType::Done);
        let refetched = vault.get_memo(memo.id).unwrap().unwrap();
        assert!(refetched.body.starts_with("- [x]"));
    }

    #[test]
    fn patch_task_rejects_stale_hash() {
        let (vault, _tmp) = tmp_vault();
        let memo = vault.create_note(None, "- [ ] buy milk".into(), NoteFormat::Markdown).unwrap();
        let stale_hash = crate::tasks::TaskLineHash::of_line("- [ ] wrong original text");
        let today = time::macros::date!(2026 - 08 - 27);
        let err = vault
            .patch_task(
                TaskSelector::Exact(TaskRef { memo_id: memo.id, line: 0, line_hash: stale_hash }),
                TaskEdit::Toggle,
                today,
            )
            .unwrap_err();
        assert!(matches!(err, CoreError::TaskConflict { .. } | CoreError::TaskNotFound { .. }));
    }

    #[test]
    fn patch_task_current_line_ignores_hash_and_targets_whatever_is_there() {
        let (vault, _tmp) = tmp_vault();
        let memo = vault.create_note(None, "- [ ] buy milk".into(), NoteFormat::Markdown).unwrap();
        let today = time::macros::date!(2026 - 08 - 27);
        let result = vault
            .patch_task(
                TaskSelector::CurrentLine { memo_id: memo.id, line: 0 },
                TaskEdit::Toggle,
                today,
            )
            .unwrap();
        assert_eq!(result.task.status_type, StatusType::Done);
    }

    #[test]
    fn patch_task_out_of_range_line_is_task_not_found() {
        let (vault, _tmp) = tmp_vault();
        let memo = vault.create_note(None, "- [ ] buy milk".into(), NoteFormat::Markdown).unwrap();
        let today = time::macros::date!(2026 - 08 - 27);
        let err = vault
            .patch_task(
                TaskSelector::CurrentLine { memo_id: memo.id, line: 99 },
                TaskEdit::Toggle,
                today,
            )
            .unwrap_err();
        assert!(matches!(err, CoreError::TaskNotFound { .. }));
    }

    #[test]
    fn two_vault_instances_patch_different_lines_concurrently_without_lost_update() {
        let (vault_a, tmp) = tmp_vault();
        vault_a
            .create_note(None, "- [ ] first\n- [ ] second".into(), NoteFormat::Markdown)
            .unwrap();
        let memo = vault_a.snapshot().unwrap().into_iter().find(|r| !r.deleted).unwrap();
        let vault_b = Vault::open(Some(tmp.path())).unwrap();
        let hash0 = crate::tasks::TaskLineHash::of_line("- [ ] first");
        let hash1 = crate::tasks::TaskLineHash::of_line("- [ ] second");
        let today = time::macros::date!(2026 - 08 - 27);
        vault_a
            .patch_task(
                TaskSelector::Exact(TaskRef { memo_id: memo.id, line: 0, line_hash: hash0 }),
                TaskEdit::Toggle,
                today,
            )
            .unwrap();
        vault_b
            .patch_task(
                TaskSelector::Exact(TaskRef { memo_id: memo.id, line: 1, line_hash: hash1 }),
                TaskEdit::Toggle,
                today,
            )
            .unwrap();
        let refetched = vault_a.get_memo(memo.id).unwrap().unwrap();
        assert!(refetched.body.contains("- [x] first"));
        assert!(refetched.body.contains("- [x] second"));
    }

    #[test]
    fn patch_task_recheck_detects_a_non_cooperating_external_write() {
        let (vault, tmp) = tmp_vault();
        let memo = vault.create_note(None, "- [ ] buy milk".into(), NoteFormat::Markdown).unwrap();
        let hash = crate::tasks::TaskLineHash::of_line("- [ ] buy milk");
        // Simulate an external editor writing the file directly, bypassing
        // the vault entirely, between patch_task's locked read and its
        // final hash recheck. This test calls patch_task normally (there
        // is no seam to inject a mid-operation write in a synchronous
        // single-threaded test), so it instead verifies the *symptom*:
        // patching a note whose on-disk bytes were changed by a raw
        // filesystem write after the note's current known hash surfaces
        // as a conflict, not a silent overwrite.
        let today = time::macros::date!(2026 - 08 - 27);
        // First, an ordinary vault-mediated edit changes the file (this
        // exercises the same code path a non-cooperating writer's change
        // would hit at recheck time, without needing to race threads):
        vault.update_note(memo.id, Some("- [ ] buy milk (edited)".into()), None).unwrap();
        let err = vault
            .patch_task(
                TaskSelector::Exact(TaskRef { memo_id: memo.id, line: 0, line_hash: hash }),
                TaskEdit::Toggle,
                today,
            )
            .unwrap_err();
        assert!(matches!(err, CoreError::TaskConflict { .. } | CoreError::TaskNotFound { .. }));
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p oximemo-core vault::tests::patch_task -- --nocapture`
Expected: compile errors (`patch_task`, `TaskRef`, `TaskSelector`,
`PatchTaskResult`, `TaskDto` don't exist).

- [ ] **Step 3: Implement**

Add to `tasks.rs` (these are DTOs shared by core/CLI, so they live next to
the domain types, not in `vault.rs`):

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskRef {
    pub memo_id: crate::memo::MemoId,
    pub line: u32,
    pub line_hash: TaskLineHash,
}

#[derive(Debug, Clone, PartialEq)]
pub enum TaskSelector {
    Exact(TaskRef),
    CurrentLine { memo_id: crate::memo::MemoId, line: u32 },
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
            task_ref: TaskRef { memo_id, line: row.line, line_hash: row.line_hash.clone() },
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

#[derive(Debug, Clone)]
pub struct PatchTaskResult {
    pub note_hash: crate::memo::MemoHash,
    pub task: TaskDto,
    pub spawned: Option<TaskDto>,
}
```

Add to `vault.rs`, near the other public mutation methods (e.g. right
after `update_note_with`):

```rust
pub fn patch_task(
    &self,
    selector: crate::tasks::TaskSelector,
    edit: crate::tasks::TaskEdit,
    today: time::Date,
) -> Result<crate::tasks::PatchTaskResult> {
    let guard = self.lock(LockKind::Exclusive)?;
    let memo_id = match &selector {
        crate::tasks::TaskSelector::Exact(r) => r.memo_id,
        crate::tasks::TaskSelector::CurrentLine { memo_id, .. } => *memo_id,
    };
    let (memo, rel, abs_path) = self.read_file_locked(memo_id)?;
    let cfg = self.with_config(|c| c.tasks.clone());
    let eff = cfg.effective_statuses()?;
    let target_line = match &selector {
        crate::tasks::TaskSelector::Exact(r) => r.line,
        crate::tasks::TaskSelector::CurrentLine { line, .. } => *line,
    };
    let lines: Vec<&str> = memo.body.lines().collect();
    let raw = lines
        .get(target_line as usize)
        .ok_or(CoreError::TaskNotFound { memo_id, line: target_line })?;
    if crate::tasks::parse_task_line(raw, &eff).is_none() {
        return Err(CoreError::TaskNotFound { memo_id, line: target_line });
    }
    if let crate::tasks::TaskSelector::Exact(r) = &selector {
        let actual = crate::tasks::TaskLineHash::of_line(raw);
        if actual != r.line_hash {
            return Err(CoreError::TaskConflict { memo_id });
        }
    }
    let transform = crate::tasks::transform_task_draft(&memo.body, target_line, &edit, today, &cfg)?;
    let new_body = apply_line_changes_to_body(&memo.body, &transform.changes);
    // Final whole-file hash recheck immediately before replacement (spec
    // §5): re-read the file bytes fresh (not the `memo` we read at the
    // top of this function) and compare to `memo.hash`.
    let current_on_disk = self.files.read_memo(&abs_path)?;
    let unchanged = current_on_disk
        .as_ref()
        .map(|m| m.hash == memo.hash)
        .unwrap_or(false);
    if !unchanged {
        return Err(CoreError::TaskConflict { memo_id });
    }
    let updated_memo = self.write_file_and_upsert_locked(&guard, &abs_path, &rel, &new_body)?;
    let reparsed = crate::tasks::parse_tasks(&updated_memo.body, &cfg);
    let task_row = reparsed
        .tasks
        .iter()
        .find(|t| t.line == target_line)
        .ok_or(CoreError::TaskNotFound { memo_id, line: target_line })?;
    let spawned = if matches!(edit, crate::tasks::TaskEdit::Toggle | crate::tasks::TaskEdit::SetStatus(_)) {
        reparsed
            .tasks
            .iter()
            .find(|t| t.status_type == StatusType::Todo && t.line != target_line && (t.due.is_some() || t.scheduled.is_some() || t.start.is_some()))
            .map(|t| crate::tasks::TaskDto::from_row(memo_id, t))
    } else {
        None
    };
    Ok(crate::tasks::PatchTaskResult {
        note_hash: updated_memo.hash,
        task: crate::tasks::TaskDto::from_row(memo_id, task_row),
        spawned,
    })
}
```

Write the `apply_line_changes_to_body` helper (private, in `vault.rs` or
`tasks.rs` — prefer `tasks.rs` since it is pure text manipulation with no
`Vault` dependency, and make it `pub(crate)` so Task 9/10/11 and this
function all share one implementation) with the exact same non-overlapping
bottom-up splice semantics as the test-only `apply_line_changes` helper
Task 4 wrote for tests — that test helper should now call through to this
real `pub(crate)` function instead of duplicating the logic; update Task
4's test helper accordingly if you find it diverging.

The `spawned` detection heuristic above (find a `Todo`-typed row with a
date field, other than the target line) is a placeholder heuristic — **do
not leave it this loose**. Implement it precisely instead: have
`transform_task_draft` (Task 5) return which inserted line, if any, is a
spawned recurrence occurrence (e.g. by having `TaskDraftTransform` carry
an optional `spawned_line_hint: Option<u32>` alongside `changes`, set only
by the recurrence-spawn branch) so `patch_task` can look up that exact
line in `reparsed.tasks` instead of guessing. Add this field to
`TaskDraftTransform` now (Task 5's code and tests still pass unmodified
since the field defaults to `None` via `..Default::default()` in test
constructions, or update Task 5's test assertions if they construct
`TaskDraftTransform` by struct literal anywhere — check before assuming).

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p oximemo-core vault::tests::patch_task -- --nocapture`
Expected: PASS.

- [ ] **Step 5: Run full core suite and commit**

Run: `cargo test -p oximemo-core`
Expected: 0 failures.

```bash
git add crates/oximemo-core/src/vault.rs crates/oximemo-core/src/tasks.rs
git commit -m "feat(tasks): Vault::patch_task with strict hash-guarded lock-aware mutation"
```

---

### Task 9: `Vault::add_task`

**Files:**
- Modify: `crates/oximemo-core/src/vault.rs`
- Modify: `crates/oximemo-core/src/tasks.rs` (`AddTarget` enum lives here)

**Interfaces:**
- Consumes: `render_new_task`, `TaskFields` (Task 3); lock-aware helpers
  (Task 7); `TaskDto` (Task 8); existing `open_daily` (`vault.rs:953`,
  read it in full first — `add_task`'s daily-note path reuses its
  adopt-or-create logic but must run it *inside* the same exclusive lock
  this method holds, so it cannot call the public `open_daily` — extract
  the same private `fn open_or_create_daily_locked(&self, guard:
  &FileLock, date: Date) -> Result<(Memo, String, PathBuf)>` the spec
  names, following the exact adopt-then-create branches `open_daily`
  already implements, and make the public `open_daily` delegate to it
  under its own freshly-acquired lock so there is only one
  implementation).
- Produces: `pub enum AddTarget { Note(MemoId), Daily(Date), Inbox }`,
  `impl Vault { pub fn add_task(&self, target: AddTarget, text: String,
  fields: TaskFields, today: Date) -> Result<PatchTaskResult> }`.

- [ ] **Step 1: Write the failing tests**

```rust
    #[test]
    fn add_task_to_existing_note_appends_a_line_with_global_filter() {
        let (vault, _tmp) = tmp_vault();
        let memo = vault.create_note(None, "# Notes".into(), NoteFormat::Markdown).unwrap();
        let mut tasks_cfg = vault.with_config(|c| c.tasks.clone());
        tasks_cfg.global_filter = "#task".into();
        vault.set_tasks_config(tasks_cfg).unwrap();
        let today = time::macros::date!(2026 - 08 - 27);
        let result = vault
            .add_task(AddTarget::Note(memo.id), "buy milk".into(), TaskFields::default(), today)
            .unwrap();
        assert_eq!(result.task.text, "buy milk");
        let refetched = vault.get_memo(memo.id).unwrap().unwrap();
        assert!(refetched.body.contains("- [ ] buy milk #task"));
    }

    #[test]
    fn add_task_daily_creates_todays_note_with_default_section() {
        let (vault, _tmp) = tmp_vault();
        let today = time::macros::date!(2026 - 08 - 27);
        let result = vault
            .add_task(AddTarget::Daily(today), "call mom".into(), TaskFields::default(), today)
            .unwrap();
        assert_eq!(result.task.text, "call mom");
    }

    #[test]
    fn add_task_daily_is_idempotent_on_the_note_creation_side() {
        let (vault, _tmp) = tmp_vault();
        let today = time::macros::date!(2026 - 08 - 27);
        vault.add_task(AddTarget::Daily(today), "first".into(), TaskFields::default(), today).unwrap();
        let result = vault
            .add_task(AddTarget::Daily(today), "second".into(), TaskFields::default(), today)
            .unwrap();
        assert_eq!(result.task.text, "second");
        // both tasks landed in the SAME note, not two competing daily notes:
        let (daily, _created) = vault.open_daily(&today.to_string()).unwrap();
        assert!(daily.body.contains("first") && daily.body.contains("second"));
    }

    #[test]
    fn add_task_creates_default_section_heading_when_absent() {
        let (vault, _tmp) = tmp_vault();
        let memo = vault.create_note(None, "# Notes\nsome text".into(), NoteFormat::Markdown).unwrap();
        let today = time::macros::date!(2026 - 08 - 27);
        vault.add_task(AddTarget::Note(memo.id), "task one".into(), TaskFields::default(), today).unwrap();
        let refetched = vault.get_memo(memo.id).unwrap().unwrap();
        let default_section = vault.with_config(|c| c.tasks.default_section.clone());
        assert!(refetched.body.contains(&format!("## {default_section}")));
    }

    #[test]
    fn add_task_rejects_newline_in_text() {
        let (vault, _tmp) = tmp_vault();
        let memo = vault.create_note(None, "# Notes".into(), NoteFormat::Markdown).unwrap();
        let today = time::macros::date!(2026 - 08 - 27);
        let err = vault
            .add_task(AddTarget::Note(memo.id), "bad\ntext".into(), TaskFields::default(), today)
            .unwrap_err();
        assert!(matches!(err, CoreError::InvalidTasksConfig(_)));
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p oximemo-core vault::tests::add_task -- --nocapture`
Expected: compile errors.

- [ ] **Step 3: Implement**

Add `AddTarget` to `tasks.rs`:

```rust
#[derive(Debug, Clone, PartialEq)]
pub enum AddTarget {
    Note(crate::memo::MemoId),
    Daily(Date),
    Inbox,
}
```

Add `open_or_create_daily_locked` to `vault.rs` by reading `open_daily`
(`vault.rs:953-1053`) in full and extracting its body into a version that
takes `&FileLock` instead of acquiring its own; have `open_daily`
delegate: `pub fn open_daily(&self, date: &str) -> Result<(Memo, bool)> {
let guard = self.lock(LockKind::Exclusive)?; self.open_or_create_daily_
locked(&guard, date) }` — confirm this produces byte-identical behavior
by re-running every existing `open_daily_*` test in `vault::tests` (there
are several — `open_daily_creates_then_is_idempotent`,
`open_daily_respects_configured_folder`, etc., all found in the earlier
research) before moving on.

Add `add_task`:

```rust
pub fn add_task(
    &self,
    target: crate::tasks::AddTarget,
    text: String,
    fields: crate::tasks::TaskFields,
    today: time::Date,
) -> Result<crate::tasks::PatchTaskResult> {
    let guard = self.lock(LockKind::Exclusive)?;
    let cfg = self.with_config(|c| c.tasks.clone());
    let line = crate::tasks::render_new_task(&text, &fields, &cfg)?;
    let (memo_id, mut memo, rel, abs_path) = match target {
        crate::tasks::AddTarget::Note(id) => {
            let (m, r, p) = self.read_file_locked(id)?;
            (id, m, r, p)
        }
        crate::tasks::AddTarget::Daily(date) => {
            let (m, created_rel, p) = self.open_or_create_daily_locked(&guard, &date.to_string())?;
            (m.id, m, created_rel, p)
        }
        crate::tasks::AddTarget::Inbox => {
            todo!("resolve `{capture inbox folder}/{default_section}.md`, adopt if present, \
                   otherwise create via the same locked internal path used by \
                   open_or_create_daily_locked's create branch")
        }
    };
    let new_body = append_task_line_under_section(&memo.body, &line, &cfg.default_section);
    let updated = self.write_file_and_upsert_locked(&guard, &abs_path, &rel, &new_body)?;
    let reparsed = crate::tasks::parse_tasks(&updated.body, &cfg);
    let appended = reparsed.tasks.last().ok_or_else(|| CoreError::other("add_task: appended line did not parse back as a task"))?;
    Ok(crate::tasks::PatchTaskResult {
        note_hash: updated.hash,
        task: crate::tasks::TaskDto::from_row(memo_id, appended),
        spawned: None,
    })
}
```

Implement the `Inbox` `todo!()` and `append_task_line_under_section`
(private helper: find a `## {default_section}` heading; if present,
append the new line as the section's last line, preserving everything
else; if absent, append a blank line, the heading, then the task line, at
the end of the body) for real. Look up `[capture].inbox_folder`-equivalent
config (read `config.rs`'s `CaptureConfig` or equivalent section — the
research notes a `capture` section exists on `VaultConfig`; read it to
find the exact field name before writing `Inbox`'s resolution code).

- [ ] **Step 4: Run to verify it passes, run full suite, commit**

Run: `cargo test -p oximemo-core vault::tests -- --nocapture` then
`cargo test -p oximemo-core`.
Expected: 0 failures.

```bash
git add crates/oximemo-core/src/vault.rs crates/oximemo-core/src/tasks.rs
git commit -m "feat(tasks): Vault::add_task with locked daily/inbox targets"
```

---

### Task 10: `Vault::move_tasks`

**Files:**
- Modify: `crates/oximemo-core/src/vault.rs`
- Modify: `crates/oximemo-core/src/tasks.rs` (`MoveTasksRequest`/
  `MoveTasksReceipt` live here)

**Interfaces:**
- Consumes: `TaskRef`, `AddTarget`, lock-aware helpers (Tasks 7-9).
- Produces: `pub struct MoveTasksRequest { pub source: MemoId, pub tasks:
  Vec<TaskRef>, pub destination: AddTarget, pub
  expected_destination_hash: Option<MemoHash> }`, `pub struct
  MoveTasksReceipt { pub source: MemoId, pub destination: MemoId, pub
  source_pre_hash: MemoHash, pub source_post_hash: MemoHash, pub
  destination_pre_hash: Option<MemoHash>, pub destination_post_hash:
  MemoHash, pub moved_lines: Vec<String> }`, `impl Vault { pub fn
  move_tasks(&self, req: MoveTasksRequest, today: Date) ->
  Result<MoveTasksReceipt> pub fn undo_move_tasks(&self, receipt:
  &MoveTasksReceipt) -> Result<()> }`.

- [ ] **Step 1: Write the failing tests**

```rust
    #[test]
    fn move_tasks_moves_full_subtree_to_destination_and_removes_from_source() {
        let (vault, _tmp) = tmp_vault();
        let source = vault
            .create_note(None, "- [ ] parent\n  - [ ] child\n- [ ] unrelated".into(), NoteFormat::Markdown)
            .unwrap();
        let dest = vault.create_note(None, "# Dest\n## 할 일\n".into(), NoteFormat::Markdown).unwrap();
        let hash = crate::tasks::TaskLineHash::of_line("- [ ] parent");
        let today = time::macros::date!(2026 - 08 - 27);
        let receipt = vault
            .move_tasks(
                MoveTasksRequest {
                    source: source.id,
                    tasks: vec![TaskRef { memo_id: source.id, line: 0, line_hash: hash }],
                    destination: AddTarget::Note(dest.id),
                    expected_destination_hash: None,
                },
                today,
            )
            .unwrap();
        let src_after = vault.get_memo(source.id).unwrap().unwrap();
        assert!(!src_after.body.contains("parent"));
        assert!(!src_after.body.contains("child"));
        assert!(src_after.body.contains("unrelated"));
        let dst_after = vault.get_memo(dest.id).unwrap().unwrap();
        assert!(dst_after.body.contains("parent"));
        assert!(dst_after.body.contains("child"));
        assert_eq!(receipt.source, source.id);
        assert_eq!(receipt.destination, dest.id);
    }

    #[test]
    fn move_tasks_deduplicates_descendant_selections_covered_by_an_ancestor() {
        let (vault, _tmp) = tmp_vault();
        let source = vault
            .create_note(None, "- [ ] parent\n  - [ ] child".into(), NoteFormat::Markdown)
            .unwrap();
        let dest = vault.create_note(None, "# Dest\n## 할 일\n".into(), NoteFormat::Markdown).unwrap();
        let parent_hash = crate::tasks::TaskLineHash::of_line("- [ ] parent");
        let child_hash = crate::tasks::TaskLineHash::of_line("  - [ ] child");
        let today = time::macros::date!(2026 - 08 - 27);
        vault
            .move_tasks(
                MoveTasksRequest {
                    source: source.id,
                    tasks: vec![
                        TaskRef { memo_id: source.id, line: 0, line_hash: parent_hash },
                        TaskRef { memo_id: source.id, line: 1, line_hash: child_hash },
                    ],
                    destination: AddTarget::Note(dest.id),
                    expected_destination_hash: None,
                },
                today,
            )
            .unwrap();
        let dst_after = vault.get_memo(dest.id).unwrap().unwrap();
        // "child" appears exactly once, not duplicated by selecting both
        // the parent (which carries it) and the child explicitly:
        assert_eq!(dst_after.body.matches("child").count(), 1);
    }

    #[test]
    fn move_tasks_verifies_expected_destination_hash() {
        let (vault, _tmp) = tmp_vault();
        let source = vault.create_note(None, "- [ ] task".into(), NoteFormat::Markdown).unwrap();
        let dest = vault.create_note(None, "# Dest".into(), NoteFormat::Markdown).unwrap();
        let hash = crate::tasks::TaskLineHash::of_line("- [ ] task");
        let today = time::macros::date!(2026 - 08 - 27);
        let wrong_hash = crate::memo::MemoHash::new("wrong");
        let err = vault
            .move_tasks(
                MoveTasksRequest {
                    source: source.id,
                    tasks: vec![TaskRef { memo_id: source.id, line: 0, line_hash: hash }],
                    destination: AddTarget::Note(dest.id),
                    expected_destination_hash: Some(wrong_hash),
                },
                today,
            )
            .unwrap_err();
        assert!(matches!(err, CoreError::TaskConflict { .. }));
    }

    #[test]
    fn move_tasks_receipt_supports_undo_while_hashes_still_match() {
        let (vault, _tmp) = tmp_vault();
        let source = vault.create_note(None, "- [ ] task".into(), NoteFormat::Markdown).unwrap();
        let dest = vault.create_note(None, "# Dest\n## 할 일\n".into(), NoteFormat::Markdown).unwrap();
        let hash = crate::tasks::TaskLineHash::of_line("- [ ] task");
        let today = time::macros::date!(2026 - 08 - 27);
        let receipt = vault
            .move_tasks(
                MoveTasksRequest {
                    source: source.id,
                    tasks: vec![TaskRef { memo_id: source.id, line: 0, line_hash: hash }],
                    destination: AddTarget::Note(dest.id),
                    expected_destination_hash: None,
                },
                today,
            )
            .unwrap();
        vault.undo_move_tasks(&receipt).unwrap();
        let src_after = vault.get_memo(source.id).unwrap().unwrap();
        assert!(src_after.body.contains("task"));
    }

    #[test]
    fn move_tasks_undo_rejects_intervening_edits() {
        let (vault, _tmp) = tmp_vault();
        let source = vault.create_note(None, "- [ ] task".into(), NoteFormat::Markdown).unwrap();
        let dest = vault.create_note(None, "# Dest\n## 할 일\n".into(), NoteFormat::Markdown).unwrap();
        let hash = crate::tasks::TaskLineHash::of_line("- [ ] task");
        let today = time::macros::date!(2026 - 08 - 27);
        let receipt = vault
            .move_tasks(
                MoveTasksRequest {
                    source: source.id,
                    tasks: vec![TaskRef { memo_id: source.id, line: 0, line_hash: hash }],
                    destination: AddTarget::Note(dest.id),
                    expected_destination_hash: None,
                },
                today,
            )
            .unwrap();
        vault.update_note(dest.id, Some("# Dest\n## 할 일\n- [ ] task\nintervening edit".into()), None).unwrap();
        let err = vault.undo_move_tasks(&receipt).unwrap_err();
        assert!(matches!(err, CoreError::TaskConflict { .. }));
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p oximemo-core vault::tests::move_tasks -- --nocapture`
Expected: compile errors.

- [ ] **Step 3: Implement**

Add `MoveTasksRequest`/`MoveTasksReceipt` to `tasks.rs` (field lists given
in Interfaces above — write them verbatim). Add `move_tasks` to
`vault.rs`:

```rust
pub fn move_tasks(
    &self,
    req: crate::tasks::MoveTasksRequest,
    today: time::Date,
) -> Result<crate::tasks::MoveTasksReceipt> {
    let guard = self.lock(LockKind::Exclusive)?;
    let (source_memo, source_rel, source_abs) = self.read_file_locked(req.source)?;
    let cfg = self.with_config(|c| c.tasks.clone());
    let eff = cfg.effective_statuses()?;

    // 1. Verify every source TaskRef against the freshly-read body.
    let source_lines: Vec<&str> = source_memo.body.lines().collect();
    for t in &req.tasks {
        let raw = source_lines
            .get(t.line as usize)
            .ok_or(CoreError::TaskNotFound { memo_id: req.source, line: t.line })?;
        if crate::tasks::TaskLineHash::of_line(raw) != t.line_hash {
            return Err(CoreError::TaskConflict { memo_id: req.source });
        }
    }

    // 2. Compute the root selection: drop any selected line whose nearest
    //    task ancestor (by indent, same rule as TaskRow.parent) is ALSO
    //    selected, using indent_columns_of + the same ancestor-walk shape
    //    as parse_tasks. Sort remaining roots by line ascending.
    let roots = dedup_covered_descendants(&source_lines, &req.tasks, &eff);

    // 3. For each root, compute its full subtree line range (same scan
    //    as TaskEdit::Delete in Task 5) and collect its exact raw lines,
    //    re-indented to the destination section's base indentation (0).
    let mut moved_lines: Vec<String> = Vec::new();
    let mut removed_ranges: Vec<(usize, usize)> = Vec::new(); // (start, end) in source_lines, descending order later
    for root in &roots {
        let start = root.line as usize;
        let base_indent = indent_columns_of(source_lines[start]);
        let mut end = start + 1;
        while let Some(next) = source_lines.get(end) {
            if indent_columns_of(next) <= base_indent {
                break;
            }
            end += 1;
        }
        for raw in &source_lines[start..end] {
            moved_lines.push(dedent_line(raw, base_indent));
        }
        removed_ranges.push((start, end));
    }

    // 4. Resolve destination, prepare its new body (append moved_lines
    //    under cfg.default_section, same helper Task 9 wrote).
    let (dest_id, dest_memo, dest_rel, dest_abs) = match &req.destination {
        crate::tasks::AddTarget::Note(id) => {
            let (m, r, p) = self.read_file_locked(*id)?;
            (*id, m, r, p)
        }
        crate::tasks::AddTarget::Daily(date) => {
            let (m, r, p) = self.open_or_create_daily_locked(&guard, &date.to_string())?;
            (m.id, m, r, p)
        }
        crate::tasks::AddTarget::Inbox => {
            todo!("same Inbox resolution as add_task (Task 9); factor into a \
                   shared private helper both methods call instead of duplicating")
        }
    };
    if let Some(expected) = &req.expected_destination_hash {
        if &dest_memo.hash != expected {
            return Err(CoreError::TaskConflict { memo_id: dest_id });
        }
    }
    let destination_pre_hash = if req.expected_destination_hash.is_some() || dest_memo.body != "" {
        Some(dest_memo.hash.clone())
    } else {
        None
    };
    let joined = moved_lines.join("\n");
    let dest_new_body = append_task_line_under_section(&dest_memo.body, &joined, &cfg.default_section);

    // 5. Compute the new source body by removing every root's subtree
    //    range, bottom-up so earlier ranges stay valid.
    let mut remaining: Vec<&str> = source_lines.clone();
    let mut sorted_ranges = removed_ranges.clone();
    sorted_ranges.sort_by(|a, b| b.0.cmp(&a.0));
    for (start, end) in &sorted_ranges {
        remaining.drain(*start..*end);
    }
    let source_new_body = remaining.join("\n") + "\n";

    // 6. Destination first, then source (spec §5). If the source write
    //    fails, restore the destination to its pre-move content.
    let dest_updated = self.write_file_and_upsert_locked(&guard, &dest_abs, &dest_rel, &dest_new_body)?;
    let source_result = self.write_file_and_upsert_locked(&guard, &source_abs, &source_rel, &source_new_body);
    let source_updated = match source_result {
        Ok(m) => m,
        Err(e) => {
            // Compensating rollback: restore destination's prior body.
            let _ = self.write_file_and_upsert_locked(&guard, &dest_abs, &dest_rel, &dest_memo.body);
            return Err(e);
        }
    };

    Ok(crate::tasks::MoveTasksReceipt {
        source: req.source,
        destination: dest_id,
        source_pre_hash: source_memo.hash,
        source_post_hash: source_updated.hash,
        destination_pre_hash,
        destination_post_hash: dest_updated.hash,
        moved_lines,
    })
}

pub fn undo_move_tasks(&self, receipt: &crate::tasks::MoveTasksReceipt) -> Result<()> {
    let guard = self.lock(LockKind::Exclusive)?;
    let (source_memo, source_rel, source_abs) = self.read_file_locked(receipt.source)?;
    let (dest_memo, dest_rel, dest_abs) = self.read_file_locked(receipt.destination)?;
    if source_memo.hash != receipt.source_post_hash || dest_memo.hash != receipt.destination_post_hash {
        return Err(CoreError::TaskConflict { memo_id: receipt.source });
    }
    // Inverse: remove the exact moved_lines block from the destination
    // (it was appended verbatim under default_section) and append it
    // back to the source body.
    let joined = receipt.moved_lines.join("\n");
    let dest_restored = dest_memo.body.replacen(&joined, "", 1);
    let source_restored = format!("{}\n{}\n", source_memo.body.trim_end(), joined);
    self.write_file_and_upsert_locked(&guard, &dest_abs, &dest_rel, &dest_restored)?;
    self.write_file_and_upsert_locked(&guard, &source_abs, &source_rel, &source_restored)?;
    Ok(())
}
```

Implement `dedup_covered_descendants` (private helper, `tasks.rs` or
`vault.rs` — pure function over `&[&str]` + `&[TaskRef]` +
`&EffectiveStatuses`, no `Vault` dependency, so put it in `tasks.rs` and
unit test it directly there): for each selected `TaskRef`, walk upward
through the same indent-based ancestor chain `parse_tasks` uses for
`parent`; if any ancestor line number is also present in the selection,
drop this ref; keep the rest, sorted ascending by line. Implement the
`Inbox` case identically to Task 9's (factor into one shared private
helper, e.g. `fn resolve_add_target_locked(&self, guard: &FileLock,
target: &AddTarget) -> Result<(MemoId, Memo, String, PathBuf)>`, and have
both `add_task` and `move_tasks` call it — refactor `add_task`'s inline
match in this task's step to call the new shared helper too, so `Inbox`
has exactly one implementation).

- [ ] **Step 4: Run to verify it passes, run full suite, commit**

Run: `cargo test -p oximemo-core vault::tests::move_tasks -- --nocapture`
then `cargo test -p oximemo-core`.
Expected: 0 failures.

```bash
git add crates/oximemo-core/src/vault.rs crates/oximemo-core/src/tasks.rs
git commit -m "feat(tasks): Vault::move_tasks with destination-first writes and guarded undo"
```

---

### Task 11: `oximemo task` CLI subcommand tree

**Files:**
- Modify: `crates/oximemo-cli/src/main.rs`
- Modify: `crates/oximemo-cli/src/commands.rs`
- Modify: `crates/oximemo-cli/src/format.rs`
- Test: `crates/oximemo-cli/tests/` (find the existing integration test
  location — the earlier CLI baseline run reported "25 tests" including
  integration-style tests; read `crates/oximemo-cli/Cargo.toml` and the
  crate's test module layout first to match the existing convention
  exactly, whether that's `#[cfg(test)]` in `main.rs`/`commands.rs` or a
  separate `tests/*.rs` file).

**Interfaces:**
- Consumes: `Vault::{patch_task, add_task, move_tasks}`, `TaskSelector`,
  `TaskRef`, `TaskEdit`, `DateField`, `AddTarget`, `TaskDto`,
  `TaskFields`, `Priority`, `crate::tasks::parse_tasks` (for `list`, read
  directly from `vault.snapshot()`), `format::Format` (existing).

- [ ] **Step 1: Write the failing tests**

Read `crates/oximemo-cli/src/main.rs` lines 19-193 (clap tree) and 268-296
(the `BaseCmd` nested-subcommand precedent) in full, and
`crates/oximemo-cli/src/commands.rs` lines 233-255 (`cmd_update`, the
mutating-command output convention) in full, before writing any code.
Then add tests matching however this crate's existing tests are
structured (mirror an existing CLI integration test's exact harness setup
— e.g. if it shells out to the built binary via `assert_cmd` or calls
`commands::cmd_*` functions directly against a `tempfile` vault, copy that
exact pattern):

```rust
    #[test]
    fn task_add_then_list_json_round_trips_line_and_hash_as_hex_text() {
        let vault = test_vault(); // whatever the existing harness calls its tmp-vault constructor
        cmd_task_add(&vault, "buy milk".into(), TaskAddTarget::Inbox, TaskAddOpts::default()).unwrap();
        let listed = cmd_task_list_json(&vault, TaskListFilter::default()).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].text, "buy milk");
        // hash serializes as a JSON string, never a number:
        let json = serde_json::to_value(&listed[0]).unwrap();
        assert!(json["taskRef"]["lineHash"].is_string());
    }

    #[test]
    fn task_done_requires_hash_unless_force() {
        let vault = test_vault();
        cmd_task_add(&vault, "buy milk".into(), TaskAddTarget::Inbox, TaskAddOpts::default()).unwrap();
        let listed = cmd_task_list_json(&vault, TaskListFilter::default()).unwrap();
        let task_ref = listed[0].task_ref.clone();
        // Correct hash succeeds:
        cmd_task_done(&vault, task_ref.memo_id, task_ref.line, Some(task_ref.line_hash.clone()), false).unwrap();
        // Wrong hash without --force fails:
        let bad = crate::tasks_hash_for_test("wrong"); // or however the crate constructs one for tests
        let err = cmd_task_done(&vault, task_ref.memo_id, task_ref.line, Some(bad), false).unwrap_err();
        assert!(err.to_string().contains("conflict") || err.to_string().contains("not found"));
    }

    #[test]
    fn task_not_done_filters_out_done_and_cancelled() {
        let vault = test_vault();
        cmd_task_add(&vault, "a".into(), TaskAddTarget::Inbox, TaskAddOpts::default()).unwrap();
        cmd_task_add(&vault, "b".into(), TaskAddTarget::Inbox, TaskAddOpts::default()).unwrap();
        let listed = cmd_task_list_json(&vault, TaskListFilter::default()).unwrap();
        let first = listed[0].task_ref.clone();
        cmd_task_done(&vault, first.memo_id, first.line, Some(first.line_hash), false).unwrap();
        let not_done = cmd_task_list_json(&vault, TaskListFilter { not_done: true, ..Default::default() }).unwrap();
        assert_eq!(not_done.len(), 1);
        assert_eq!(not_done[0].text, "b");
    }

    #[test]
    fn task_rollover_dry_run_previews_without_mutating() {
        let vault = test_vault();
        let yesterday = time::macros::date!(2026 - 08 - 26);
        cmd_task_add(&vault, "leftover".into(), TaskAddTarget::Daily(yesterday), TaskAddOpts::default()).unwrap();
        let preview = cmd_task_rollover(&vault, Some(yesterday), None, true).unwrap();
        assert_eq!(preview.len(), 1);
        // dry-run: yesterday's note is untouched
        let listed = cmd_task_list_json(&vault, TaskListFilter::default()).unwrap();
        assert_eq!(listed.len(), 1, "still only in the original note");
    }

    #[test]
    fn task_line_numbers_are_documented_zero_based_in_json() {
        let vault = test_vault();
        cmd_task_add(&vault, "first".into(), TaskAddTarget::Note(create_note_for_test(&vault, "# N")), TaskAddOpts::default()).unwrap();
        let listed = cmd_task_list_json(&vault, TaskListFilter::default()).unwrap();
        assert_eq!(listed[0].task_ref.line, 0);
    }
```

The exact helper names (`test_vault`, `create_note_for_test`,
`cmd_task_list_json`, etc.) above are illustrative of the *behavior* to
test, not a literal contract — read the existing test harness in this
crate first (e.g. how `cmd_update`/`cmd_base_run` are already tested, if
at all — the earlier baseline run reported CLI tests exist) and use
whatever helper names and structure that harness already establishes.

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p oximemo-cli`
Expected: compile errors (none of the `cmd_task_*` functions exist).

- [ ] **Step 3: Implement the clap tree**

In `main.rs`, add a `Task` variant to the top-level `Cmd` enum (alongside
`Base`) following the exact `BaseCmd` nesting pattern (`main.rs:226-229,
268-296`):

```rust
    /// Manage extended-checkbox tasks (spec 2026-08-27).
    Task {
        #[command(subcommand)]
        sub: TaskCmd,
    },
```

```rust
#[derive(Subcommand)]
enum TaskCmd {
    List {
        #[arg(long)]
        r#where: Option<String>,
        #[arg(long)]
        note: Option<String>,
        #[arg(long)]
        folder: Option<String>,
        #[arg(long)]
        due: Option<String>, // "before:DATE" | "after:DATE" | "on:DATE"
        #[arg(long)]
        status: Option<String>,
        #[arg(long)]
        not_done: bool,
        #[arg(long, default_value_t = 50)]
        limit: usize,
        #[arg(long, default_value = "table")]
        format: String,
    },
    Add {
        text: String,
        #[arg(long)]
        note: Option<String>,
        #[arg(long)]
        daily: Option<Option<String>>,
        #[arg(long)]
        inbox: bool,
        #[arg(long)]
        section: Option<String>,
        #[arg(long)]
        due: Option<String>,
        #[arg(long)]
        scheduled: Option<String>,
        #[arg(long)]
        start: Option<String>,
        #[arg(long)]
        priority: Option<String>,
        #[arg(long)]
        repeat: Option<String>,
        #[arg(long = "tag")]
        tags: Vec<String>,
    },
    Done {
        note_id: String,
        line: u32,
        #[arg(long)]
        hash: Option<String>,
        #[arg(long)]
        force: bool,
    },
    Status {
        note_id: String,
        line: u32,
        symbol: String,
        #[arg(long)]
        hash: Option<String>,
        #[arg(long)]
        force: bool,
    },
    Edit {
        note_id: String,
        line: u32,
        #[arg(long)]
        hash: Option<String>,
        #[arg(long)]
        force: bool,
        #[arg(long = "set-due")]
        set_due: Option<String>,
        #[arg(long = "clear-due")]
        clear_due: bool,
        #[arg(long = "set-text")]
        set_text: Option<String>,
        #[arg(long = "set-priority")]
        set_priority: Option<String>,
        #[arg(long = "set-repeat")]
        set_repeat: Option<String>,
        #[arg(long = "clear-repeat")]
        clear_repeat: bool,
    },
    Rm {
        note_id: String,
        line: u32,
        #[arg(long)]
        hash: Option<String>,
        #[arg(long)]
        force: bool,
    },
    Rollover {
        #[arg(long)]
        from: Option<String>,
        #[arg(long)]
        to: Option<String>,
        #[arg(long)]
        dry_run: bool,
    },
}
```

Wire dispatch in `run()` (`main.rs:315-321` area, alongside the existing
`Cmd::Base { sub } => ...` arm) delegating each `TaskCmd` variant to a new
`commands::cmd_task_*` function, exactly matching the existing dispatch
style (`main.rs:471-486` for the `BaseCmd` precedent — mirror its shape
verbatim for `TaskCmd`). `--hash H` and `--force` are mutually exclusive
per the mutation commands (`done`/`status`/`edit`/`rm`): validate in the
dispatch arm (`if hash.is_some() && force { return Err(anyhow!("--hash
and --force are mutually exclusive")); }`) before calling into
`commands::cmd_task_*`; exactly one of `--hash`/`--force` is required
(missing both is also an error, matching the spec's `(--hash H |
--force)` syntax).

- [ ] **Step 4: Implement the command functions**

In `commands.rs`, add one `pub fn cmd_task_*` per subcommand, each
constructing the appropriate `TaskSelector`/`TaskEdit`/`AddTarget`/
`MoveTasksRequest` and calling the matching `Vault` method, then printing
per the existing convention: mutating commands print the resulting
`TaskDto` (or `PatchTaskResult`) as pretty JSON (mirror `cmd_update`,
`commands.rs:233-255`); `list` respects `--format table|json|md`
(`json`: `serde_json::to_string_pretty` of `Vec<TaskDto>`; `table`: a new
pure `fn format_task_table(tasks: &[TaskDto]) -> String` following the
`format_base_table` template, columns `LINE | STATUS | DUE | TEXT`;
`md`: for each matching task, re-read its parent note's current body via
`vault.get_memo` and print the exact raw line at `task_ref.line`, one per
line — this is a live re-read at print time, not a cached raw string,
since `TaskRow` deliberately does not store raw source text).

`list`'s `--where EXPR` filters at the **note** level only, via
`crate::expr::{parse_expr, eval}` against a `RowData::from_record` built
from each candidate `IndexRecord` (empty formulas map, no `this` scope) —
this already works today without any Plan B changes, because it never
touches `task.*` resolution. `--due`/`--status`/`--not-done` are dedicated
flags that filter directly on each note's `TaskRow` fields (not through
the expr engine, since `task.*` expression resolution doesn't exist until
a later plan). Document this split with a code comment at the `list`
implementation site so a future Plan B implementer understands why
`--where` doesn't see `task.*` yet.

`rollover` computes `from` (default: yesterday relative to the local
date) and `to` (default: today), lists every not-done task in `from`'s
daily note (if it exists — a missing daily note means zero candidates,
not an error), and either prints the candidate list (`--dry-run`) or
calls `vault.move_tasks(...)` once with all candidates targeting
`AddTarget::Daily(to)`, `expected_destination_hash: None` (rollover always
accepts today's current daily-note state or its first creation).

- [ ] **Step 5: Run to verify it passes**

Run: `cargo test -p oximemo-cli`
Expected: PASS (previously-passing 24 tests plus the new ones).

- [ ] **Step 6: Manual smoke test**

Run (adjust `--vault` to a scratch temp directory):

```bash
cargo run -p oximemo-cli -- --vault /tmp/oxi-smoke task add "smoke test task" --inbox
cargo run -p oximemo-cli -- --vault /tmp/oxi-smoke task list --format json
```

Expected: the `add` command prints a `TaskDto` JSON object with a 16-hex
`lineHash` string; `list --format json` shows the same task.

- [ ] **Step 7: Run full workspace suite and commit**

Run: `cargo test -p oximemo-core -p oximemo-cli`
Expected: 0 failures.

```bash
git add crates/oximemo-cli/src/main.rs crates/oximemo-cli/src/commands.rs \
        crates/oximemo-cli/src/format.rs
git commit -m "feat(cli): oximemo task subcommand tree (list/add/done/status/edit/rm/rollover)"
```

---

### Task 12: `SKILL.md` documentation and end-to-end integration test

**Files:**
- Modify: `skills/oximemo/SKILL.md`
- Test: `crates/oximemo-cli/tests/` or equivalent existing integration
  test location (same convention as Task 11)

**Interfaces:**
- Consumes: the full `oximemo task` CLI surface (Task 11).
- Produces: no new code; documentation + one broad integration test
  demonstrating the whole plan end to end.

- [ ] **Step 1: Write the end-to-end integration test**

Add a test (same file/harness convention as Task 11) that runs the full
lifecycle in one `tmp_vault`-backed scenario: `task add` into a daily
note → `task list --format json` shows it → `task edit --set-due` →
`task status` to an in-progress symbol → `task done` (with correct hash)
→ verify the note body on disk shows the completed line → `task add` a
recurring task with `--repeat "every week"` and a `--due` date → `task
done` it → `task list` shows both the completed original and the spawned
occurrence → `task rollover --dry-run` on yesterday's date shows nothing
(nothing was left there) → create a second daily note artificially with
an unfinished task, then `task rollover --from <that date>` (no
`--dry-run`) moves it into today's note → `task list --not-done` shows it
under today.

- [ ] **Step 2: Run to verify it fails, then implement any gaps it exposes**

Run: `cargo test -p oximemo-cli task_lifecycle -- --nocapture` (or
whatever name you gave the test). If this test reveals a real bug in
Tasks 1-11 (not a test-harness mistake), fix it in the module where the
bug lives and re-run that module's own test suite before returning here —
do not patch around it inside this test.

Expected after fixes: PASS.

- [ ] **Step 3: Write the `SKILL.md` Tasks section**

Read `skills/oximemo/SKILL.md` in full (376 lines). Insert a new `##
Tasks` section between "Metadata grounding (books & movies)" and "Quick
recipes" (matching the existing prose-bullets-plus-fenced-bash-example
style of its neighbors), and add the `oximemo task ...` subcommands to
the existing "Command reference" fenced bash block (after the `oximemo
metadata`/`oximemo stamp` lines, before `oximemo stats`), each with a
one-line `#` comment in the same style as every other command there.
Content requirements (spec §10):
- Document `TaskRef` (memo id + 0-based line + hex hash) as the unit
  agents patch.
- Document that `today` is caller-local (the CLI derives it from the
  local system clock; there is no server-side timezone guessing).
- Document that mutation commands require `--hash` by default and that
  `--force` is an explicit escape hatch never used in the skill's own
  examples (spec: "never used by `SKILL.md` examples" — so every example
  command block you write must use `--hash`, obtained from a preceding
  `task list --format json` in the same recipe, never `--force`).
- Document `task rollover` with a `--dry-run` example first, then the
  real invocation.
- Do not add task counts or task-specific content to `build_context`
  (there is no such section in this file to touch — confirm by reading
  the file that no context-building code lives here; if you find one,
  stop and re-read the spec's exact wording before proceeding, since spec
  §10 explicitly says nothing is added there).

- [ ] **Step 4: Final full workspace verification**

Run: `cargo test -p oximemo-core -p oximemo-cli`
Expected: 0 failures, full count reported (should be roughly 370 + ~70
new core tests, plus 24 + new CLI tests).

Run: `cargo fmt --check -p oximemo-core -p oximemo-cli` and `cargo clippy
-p oximemo-core -p oximemo-cli -- -D warnings` — fix any findings (these
two crates evidently run clean today per the repo's release-gate history;
new code must not introduce warnings).

- [ ] **Step 5: Commit**

```bash
git add skills/oximemo/SKILL.md crates/oximemo-cli/
git commit -m "docs(tasks): SKILL.md Tasks section and end-to-end CLI lifecycle test"
```

---

## Plan A Definition of Done

- `cargo test -p oximemo-core -p oximemo-cli` passes with 0 failures.
- `cargo clippy -p oximemo-core -p oximemo-cli -- -D warnings` is clean.
- A fresh vault demonstrates the full lifecycle via `oximemo task`
  commands alone (Task 12's integration test is the automated proof of
  this; Task 11 Step 6 is the manual proof).
- No frontend/Tauri file is touched.
- `docs/superpowers/specs/2026-08-27-tasks-design.md`'s §1-§6, §10, §11,
  and the Plan A bullet of "Implementation plans" are each implemented by
  at least one task above; §13's "Rust unit", "Rust property", "Rust
  recurrence", "Rust integration", and "CLI" testing bullets are each
  covered by at least one test written in Tasks 1-12.
</content>
