# Tasks Plan B — Dataset-Aware Query Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `source: tasks` turns the `.query` engine into a task dataset: one row per indexed task, `task.*` identifiers, `BaseRow.row_id`/`BaseRow.task`, null semantics, default limit, and a CLI-JSON demonstration on a hand-written `.query`.

**Architecture:** The existing `run_base` pipeline (filter → per-row formulas → group-major stable sort → hard cap → summaries → page slice) stays intact; its row unit becomes subject-driven. `RowData` gains `subject: RowSubject` so the expr engine can resolve `task.*` against a `TaskRow` while `file.*`/`note.*` keep serving the parent note. `BaseRow` gains a generation-scoped `row_id` and an optional `TaskDto` so every downstream consumer (Plan C adapters, browser fixtures, CLI JSON) keys rows without parent-summary collisions. No frontend/Tauri file is touched.

**Tech Stack:** Rust (`oximemo-core`, `oximemo-cli`), serde YAML/JSON, existing `expr` engine and `base::exec` pipeline. No new dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-27-tasks-design.md` §4 (query engine) governs this plan; §13 "Query integration" defines the test obligations.
- `cargo test -p oximemo-core -p oximemo-cli` 0 failures; `cargo clippy -p oximemo-core -p oximemo-cli -- -D warnings` clean; `cargo fmt --check` clean — after every task.
- Wire DTOs stay snake_case JSON (established Plan A convention; `BaseRow` already snake_case via no `rename_all`).
- `TaskLineHash` stays hex text over JSON (never a number).
- No frontend/Tauri file may be created or modified (`apps/` is out of scope until Plan C).
- Plan A's primitives are consumed as-is: `TaskRow`, `TaskDto::from_row`, `TaskWarning`, `StatusType`, `Priority`, `IndexRecord.tasks`/`tasks_truncated`. Do not re-implement any of them.
- Missing optional task fields resolve `Value::Null`; equality with `null` is valid; ordering against `Null` is an expression error (already the engine's `compare` behavior — pin it with tests, do not change it).
- `base_props` stays note-level (filter-builder catalog is unchanged by task sources — explicit non-goal).

## File Structure

- `crates/oximemo-core/src/base.rs` — `BaseSourceKind`, `BaseDef.source`, load-time rejection, source/view-type validation warnings.
- `crates/oximemo-core/src/expr/eval.rs` — `RowSubject`, `RowData.subject` + `from_task`, `resolve_task`, `resolve_standard` local-offset threading.
- `crates/oximemo-core/src/base/exec.rs` — subject-driven `Kept`, task-source iteration, `(id, line)` tie-break, `BaseRow.row_id`/`task`, 200 default limit, truncation warning, `RowData` rebuild helper.
- `crates/oximemo-cli/src/commands.rs` — demonstration test only (CLI JSON contract).
- No new files.

---

### Task 1: `BaseSourceKind` on `BaseDef` — parse, default, reject, view-type warnings

**Files:**
- Modify: `crates/oximemo-core/src/base.rs` (struct at line 31; `KNOWN_VIEW_TYPES` at line 191; `validate` at line 340)
- Test: same file, `mod tests` (line 529+)

**Interfaces:**
- Produces: `pub enum BaseSourceKind { Notes, Tasks }` (serde `lowercase`, `Default = Notes`); `BaseDef.source: BaseSourceKind` (`#[serde(default)]`, camelCase field name `source`); `KNOWN_VIEW_TYPES` becomes `["table", "board", "cards", "list", "tasks"]`; `validate` emits the two new warnings below. Later tasks match on `def.source == BaseSourceKind::Tasks`.

- [ ] **Step 1: Write the failing tests** (append to `mod tests` in `base.rs`)

```rust
#[test]
fn source_defaults_to_notes_and_parses_tasks() {
    let d = parse_base("views:\n  - type: table\n").unwrap();
    assert!(matches!(d.source, BaseSourceKind::Notes));
    let d = parse_base("source: tasks\nviews:\n  - type: table\n").unwrap();
    assert!(matches!(d.source, BaseSourceKind::Tasks));
    // round-trip keeps the field
    let yaml = write_base(&d).unwrap();
    assert!(yaml.contains("source: tasks"));
}

#[test]
fn unknown_source_is_a_load_time_error() {
    let err = parse_base("source: bogus\nviews:\n  - type: table\n").unwrap_err();
    assert!(
        err.to_string().to_lowercase().contains("source"),
        "error names the field: {err}"
    );
}

#[test]
fn validate_warns_on_source_view_type_mismatch() {
    // notes source + tasks view -> warning
    let d = parse_base("views:\n  - type: tasks\n").unwrap();
    let warns = validate(&d).unwrap();
    assert!(warns.iter().any(|w| w.contains("requires source: tasks")));
    // tasks source + tasks/table/board/list/cards -> no source warnings
    for ty in ["tasks", "table", "board", "list", "cards"] {
        let d = parse_base(&format!("source: tasks\nviews:\n  - type: {ty}\n")).unwrap();
        let warns = validate(&d).unwrap();
        assert!(!warns.iter().any(|w| w.contains("source")), "{ty}: {warns:?}");
    }
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test -p oximemo-core base::tests::source_ -- --nocapture`
Expected: FAIL (no `source` field / no `BaseSourceKind`).

- [ ] **Step 3: Implement**

In `base.rs` add above `BaseDef`:

```rust
/// Which dataset a base iterates (spec §4): `notes` (the default — one
/// row per indexed note) or `tasks` (one row per indexed task; `file.*`
/// still serves the parent note). Unknown YAML values are load-time
/// errors via serde.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BaseSourceKind {
    #[default]
    Notes,
    Tasks,
}
```

Add to `BaseDef` (keeps camelCase serialization of the struct):

```rust
    #[serde(default)]
    pub source: BaseSourceKind,
```

Update `KNOWN_VIEW_TYPES`:

```rust
pub const KNOWN_VIEW_TYPES: [&str; 5] = ["table", "board", "cards", "list", "tasks"];
```

In `validate` (after the existing unknown-view-type warning loop), add:

```rust
    for (i, view) in def.views.iter().enumerate() {
        let label = view_label(view, i);
        match def.source {
            BaseSourceKind::Notes => {
                if view.r#type == "tasks" {
                    out.push(format!(
                        "view {label}: type `tasks` requires source: tasks"
                    ));
                }
            }
            BaseSourceKind::Tasks => {
                if !matches!(
                    view.r#type.as_str(),
                    "tasks" | "table" | "board" | "list" | "cards"
                ) {
                    out.push(format!(
                        "view {label}: source: tasks supports tasks/table/board/list/cards"
                    ));
                }
            }
        }
    }
```

(Use the real `out`/warning-vector variable name from the surrounding code; `view_label` already exists.)

- [ ] **Step 4: Run the module suite**

Run: `cargo test -p oximemo-core base::`
Expected: PASS including the three new tests and every pre-existing round-trip test (serde default keeps old YAML loading).

- [ ] **Step 5: Commit**

```bash
git add crates/oximemo-core/src/base.rs
git commit -m "feat(base): BaseDef.source dataset selector with load-time validation"
```

---

### Task 2: `RowSubject` and the `task.*` identifier namespace

**Files:**
- Modify: `crates/oximemo-core/src/expr/eval.rs` (`RowData` at line 60, `resolve_standard` at line 188, `resolve_file` at line 256)
- Test: same file, its `mod tests`

**Interfaces:**
- Consumes: `crate::tasks::{TaskRow, StatusType, Priority}` (Plan A; `TaskRow` fields are all `pub`).
- Produces:
  - `pub enum RowSubject<'a> { Note, Task(&'a TaskRow) }`
  - `RowData.subject: RowSubject<'a>` (private field, `Note` from `from_record`/`from_query_file`)
  - `RowData::from_task(rec: &'a IndexRecord, task: &'a TaskRow, formulas: &'a HashMap<String, Result<Value, CoreError>>, this: Option<&'a RowData<'a>>) -> Self`
  - `resolve_standard` and `resolve_task` gain a `local: UtcOffset` parameter (thread it from `resolve`); `task.*` resolves per the table below. Task 3's executor calls `from_task` for task-source rows.

  | Path | Value |
  |---|---|
  | `task.status` | `Str(symbol)` — the raw marker char, e.g. `" "`, `"/"`, `"x"` |
  | `task.type` | `Str(SCREAMING_SNAKE variant)` — `"TODO"`, `"IN_PROGRESS"`, `"ON_HOLD"`, `"DONE"`, `"CANCELLED"` (matches `StatusType` serde) |
  | `task.text` | `Str(text)` |
  | `task.tags` | `List<Str>` |
  | `task.section` | `Str(section)` or `Null` |
  | `task.line` | `Num(line)` (0-based) |
  | `task.created`/`start`/`scheduled`/`due`/`done`/`cancelled` | `Date(midnight assume local)` or `Null` |
  | `task.priority` | `Num` −2…2 for Lowest…Highest; `Null` when `Priority::None` |
  | `task.recurring` | `Bool(recurrence.is_some())` |
  | `task.invalid` | `Bool(!warnings.is_empty())` |
  | `task.warnings` | `List<Str>` — `"<kind>: <raw>"` per warning, kind in camelCase (`invalidValue`, `duplicate`, `unsupportedRule`) |
  | any other `task.<k>` | `Null` |
  | `task.*` when subject is `Note` | `Null` (never an error) |

- [ ] **Step 1: Write the failing tests** (append to `mod tests` in `eval.rs`; reuse the file's existing record-building helper — if tests build `IndexRecord` literals inline, follow that pattern)

```rust
#[test]
fn task_namespace_resolves_every_spec_field() {
    let rec = test_record(); // existing helper or inline literal, path "daily/2026-08-27.md"
    let task = crate::tasks::TaskRow {
        line: 4,
        indent_columns: 0,
        parent: None,
        symbol: '/',
        status_type: crate::tasks::StatusType::InProgress,
        text: "ship plan b".into(),
        tags: vec!["oss".into()],
        section: Some("Today".into()),
        created: Some(time::macros::date!(2026 - 08 - 20)),
        start: None,
        scheduled: None,
        due: Some(time::macros::date!(2026 - 08 - 30)),
        done: None,
        cancelled: None,
        priority: crate::tasks::Priority::High,
        recurrence: Some("every week".into()),
        warnings: vec![],
        line_hash: crate::tasks::TaskLineHash::of_line("- [/] ship plan b"),
    };
    let empty = HashMap::new();
    let row = RowData::from_task(&rec, &task, &empty, None);
    // Real consumer path: parse + eval with a pinned UTC clock.
    let clock = EvalClock { now_utc: OffsetDateTime::UNIX_EPOCH, local: UtcOffset::UTC };
    let ctx = EvalCtx { clock: &clock, depth: std::cell::Cell::new(0) };
    let v = |p: &str| eval(&parse_expr(p).unwrap(), &row, &ctx).unwrap();
    assert_eq!(v("task.status"), Value::Str("/".into()));
    assert_eq!(v("task.type"), Value::Str("IN_PROGRESS".into()));
    assert_eq!(v("task.text"), Value::Str("ship plan b".into()));
    assert_eq!(v("task.line"), Value::Num(4.0));
    assert_eq!(v("task.priority"), Value::Num(1.0), "High is +1 on the -2..2 scale");
    assert_eq!(v("task.recurring"), Value::Bool(true));
    assert_eq!(v("task.invalid"), Value::Bool(false));
    assert_eq!(
        v("task.due"),
        Value::Date(time::macros::datetime!(2026-08-30 0:00).assume_utc())
    );
    assert_eq!(v("task.start"), Value::Null);
    assert_eq!(v("task.section"), Value::Str("Today".into()));
    assert_eq!(v("task.bogus"), Value::Null);
    // parent-note namespaces still serve the parent
    assert_eq!(v("file.folder"), Value::Str("daily".into()));
}

#[test]
fn task_priority_scale_maps_none_to_null() {
    // Lowest -2, Low -1, None -> Null, Medium 0, High 1, Highest 2
    // build four one-line TaskRows cycling `priority` and assert each
    // `task.priority` value per the table above.
}

#[test]
fn task_namespace_is_null_for_note_subjects() {
    let rec = test_record();
    let empty = HashMap::new();
    let row = RowData::from_record(&rec, &empty, None);
    assert_eq!(resolve(&["task".into(), "text".into()], &row, UtcOffset::UTC).unwrap(), Value::Null);
}
```

(Adapt helper names to the file's real test utilities — e.g. build `Value::Date` via `time::PrimitiveDateTime`→`OffsetDateTime` the way existing date tests do.)

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test -p oximemo-core expr::`
Expected: FAIL (`from_task` missing).

- [ ] **Step 3: Implement**

Add to `eval.rs` (near `RowData`):

```rust
/// What one row of a base dataset is (spec §4): a whole note, or a
/// single indexed task inside one. `file.*`/`note.*` always serve the
/// parent note record; only `task.*` depends on the subject.
pub enum RowSubject<'a> {
    Note,
    Task(&'a TaskRow),
}
```

`RowData` gains `subject: RowSubject<'a>`; `from_record`/`from_query_file` set `subject: RowSubject::Note`; new constructor:

```rust
    /// Task-subject row scope (spec §4): `file.*`/`note.*` resolve
    /// against the parent note record; `task.*` against `task`.
    pub fn from_task(
        rec: &'a IndexRecord,
        task: &'a TaskRow,
        formulas: &'a HashMap<String, Result<Value, CoreError>>,
        this: Option<&'a RowData<'a>>,
    ) -> Self {
        Self {
            subject: RowSubject::Task(task),
            ..Self::from_record(rec, formulas, this)
        }
    }
```

Thread `local` into `resolve_standard` (add the parameter at both call sites in `resolve`) and add the namespace arm:

```rust
            "task" if rest.len() <= 1 => Ok(Some(resolve_task(rest, row, local)?)),
```

```rust
/// `task.*` (spec §4 identifier table). Only resolves on a task
/// subject; a note subject yields Null for every key so shared filters
/// stay valid across sources. Dates lift to local midnight in the
/// pinned offset; `Priority::None` maps to Null (absent, not zero).
fn resolve_task(rest: &[String], row: &RowData, local: UtcOffset) -> Result<Value, CoreError> {
    let RowSubject::Task(t) = &row.subject else {
        return Ok(Value::Null);
    };
    let date = |d: Option<time::Date>| {
        d.map(|d| Value::Date(d.midnight().assume_offset(local)))
    };
    let v = match rest {
        [k] => match k.as_str() {
            "status" => Value::Str(t.symbol.to_string()),
            "type" => Value::Str(status_type_name(t.status_type)),
            "text" => Value::Str(t.text.clone()),
            "tags" => Value::List(t.tags.iter().map(|s| Value::Str(s.clone())).collect()),
            "section" => t.section.clone().map(Value::Str).unwrap_or(Value::Null),
            "line" => Value::Num(t.line as f64),
            "created" => date(t.created)?,   // see note below
            "start" => date(t.start)?,
            "scheduled" => date(t.scheduled)?,
            "due" => date(t.due)?,
            "done" => date(t.done)?,
            "cancelled" => date(t.cancelled)?,
            "priority" => priority_num(t.priority),
            "recurring" => Value::Bool(t.recurrence.is_some()),
            "invalid" => Value::Bool(!t.warnings.is_empty()),
            "warnings" => Value::List(
                t.warnings.iter().map(|w| Value::Str(format!("{}: {}", warning_kind_name(w), w.raw))).collect(),
            ),
            _ => Value::Null,
        },
        _ => Value::Null,
    };
    Ok(v)
}
```

(`date` closure returns `Option<Value>` — write it as a plain match, not `?`; `status_type_name`/`priority_num`/`warning_kind_name` are tiny private helpers — `status_type_name` returns the `SCREAMING_SNAKE_CASE` string via the same mapping as serde (`serde_plain`-style match is fine, no new dep); `priority_num`: `Lowest→-2.0, Low→-1.0, None→Null (Value), Medium→0.0, High→1.0, Highest→2.0`; `warning_kind_name`: match on `TaskWarningKind` → `"invalidValue" | "duplicate" | "unsupportedRule"`.)

- [ ] **Step 4: Run the expr suite + engine-wide compile**

Run: `cargo test -p oximemo-core expr::`
Expected: PASS, no behavior change for note rows (`task.*` was `Null` before by the unknown-namespace rule and still is).

- [ ] **Step 5: Commit**

```bash
git add crates/oximemo-core/src/expr/eval.rs
git commit -m "feat(expr): RowSubject and task.* identifier namespace"
```

---

### Task 3: Subject-driven executor — `row_id`, `BaseRow.task`, task-source iteration

**Files:**
- Modify: `crates/oximemo-core/src/base/exec.rs` (`BaseRow` at line 63; `Kept` at line 265; the record loop at line 474; the sort at line 547; cell building at line 605)
- Test: same file, `mod tests` (line 1037+; reuse the file's existing `tmp_vault`-style integration helpers)

**Interfaces:**
- Consumes: `RowData::from_task`, `RowSubject`, `TaskDto::from_row` (all landed above/Plan A).
- Produces:
  - `BaseRow.row_id: String` — `"n:<memo_id>"` for note rows, `"t:<memo_id>:<line>"` for task rows (generation-scoped identity; NOT stable across external edits — documented field doc-comment).
  - `BaseRow.task: Option<TaskDto>` — `Some` only for task rows.
  - `Kept.subject: RowSubject<'a>` + `Kept.row_id: String`; final sort tie-break `(rec.id, subject line)` so task pages never duplicate/skip rows.
  - `run_base` iterates `source: tasks` as one row per `(record, TaskRow)` (deleted records excluded exactly as today; records with zero tasks contribute nothing).

- [ ] **Step 1: Write the failing integration test** (append to `mod tests` in `exec.rs`; follow the existing pattern that writes notes into a tmp vault and calls `run_base` with `BaseSource::Inline`)

```rust
#[test]
fn task_source_rows_have_distinct_row_ids_and_task_dtos() {
    let (_t, v) = tmp_vault(); // the file's existing helper; else inline the pattern
    let body = "# Note\n\n## Today\n\n- [ ] first task 📅 2026-08-30\n- [x] second task\n";
    let id = v.create_memo(body.to_string(), None).unwrap().id;
    v.migrate().unwrap(); // ensure tasks indexed (or rely on create's upsert)
    let def = crate::base::parse_base(
        "source: tasks\nviews:\n  - type: table\n    columns: [task.text, task.due]\n",
    )
    .unwrap();
    let page = v
        .run_base(
            &BaseSource::Inline(def),
            &RunBaseReq {
                view_index: 0,
                offset: 0,
                limit: 50,
                group: None,
                now_ms: None,
                local_offset_seconds: None,
                include_group_counts: false,
                include_summaries: false,
                this_id: None,
            },
        )
        .unwrap();
    assert_eq!(page.rows.len(), 2, "one row per task: {page:?}");
    let ids: Vec<&str> = page.rows.iter().map(|r| r.row_id.as_str()).collect();
    assert_eq!(
        ids,
        vec![
            format!("t:{id}:0").as_str(),
            format!("t:{id}:1").as_str()
        ]
    );
    // parent summary + task DTO both present
    assert_eq!(page.rows[0].summary.id, id);
    let task = page.rows[0].task.as_ref().expect("task dto");
    assert_eq!(task.text, "first task");
    assert_eq!(task.task_ref.line, 0);
    // formula/cell content is per-task
    assert_eq!(page.rows[0].cells[0].value, Some(Value::Str("first task".into())));
    assert_eq!(page.rows[1].cells[0].value, Some(Value::Str("second task".into())));
}

#[test]
fn note_source_rows_use_note_row_ids() {
    // same vault, def WITHOUT source: tasks -> row_id "n:<id>", task None,
    // exactly one row for the note.
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test -p oximemo-core base::exec::tests::task_source`
Expected: FAIL (no `row_id` field).

- [ ] **Step 3: Implement**

`BaseRow`:

```rust
#[derive(Debug, Clone, Serialize)]
pub struct BaseRow {
    /// Generation-scoped row identity (spec §4): `n:<memo_id>` for note
    /// rows, `t:<memo_id>:<line>` for task rows. NOT stable across
    /// external edits — consumers clear derived state when
    /// `BasePage.result_key` changes.
    pub row_id: String,
    pub summary: MemoSummary,
    pub folder: String,
    pub format: String,
    /// Present only for `source: tasks` rows.
    pub task: Option<TaskDto>,
    pub cells: Vec<BaseCell>,
}
```

`Kept` gains `subject: RowSubject<'a>` and `row_id: String`. Replace the record loop header (line 474) with a subject-driven iteration:

```rust
        let task_source = def.source == BaseSourceKind::Tasks;
        for rec in snap.iter().filter(|r| !r.deleted) {
            let subjects: Vec<RowSubject<'_>> = if task_source {
                rec.tasks.iter().map(RowSubject::Task).collect()
            } else {
                vec![RowSubject::Note]
            };
            for subject in subjects {
                let task_ref = match &subject {
                    RowSubject::Task(t) => Some(t),
                    RowSubject::Note => None,
                };
                // ... per-row formula map (unchanged), then:
                let row = match task_ref {
                    Some(t) => RowData::from_task(rec, t, &fmap, this_row.as_ref()),
                    None => RowData::from_record(rec, &fmap, this_row.as_ref()),
                };
                // ... filters, group key, order keys (unchanged code, `row` swapped)
                kept.push(Kept {
                    rec,
                    subject,
                    row_id: match task_ref {
                        Some(t) => format!("t:{}:{}", rec.id, t.line),
                        None => format!("n:{}", rec.id),
                    },
                    formulas: fmap,
                    keys,
                    group_str,
                });
            }
        }
```

(The formula-evaluation block inside the loop must also build its intermediate `RowData` with the subject — one `from_task`/`from_record` selection helper keeps it DRY. Give `Kept` a `row_data<'b>(&'b self, this: Option<&'b RowData<'b>>) -> RowData<'b>`-style helper or a free `fn row_data_of(kept, this_row)` used by formula eval, sort-key precompute, summaries, and cell building so all four see the same subject.)

Sort tie-break (line 547):

```rust
            let line_of = |k: &Kept| match &k.subject {
                RowSubject::Task(t) => t.line,
                RowSubject::Note => 0,
            };
            kept.sort_by(|a, b| {
                for ((ka, kb), d) in a.keys.iter().zip(&b.keys).zip(&descs) {
                    let ord = cmp_key(ka, kb, *d);
                    if ord != Ordering::Equal {
                        return ord;
                    }
                }
                a.rec.id.cmp(&b.rec.id).then(line_of(a).cmp(&line_of(b)))
            });
```

Cell building (line 605) — build `row` via the same helper and emit:

```rust
            full_rows.push(BaseRow {
                row_id: k.row_id.clone(),
                summary: k.rec.to_summary(),
                folder: folder_of(&k.rec.path),
                format: format_of(&k.rec.path).to_string(),
                task: match &k.subject {
                    RowSubject::Task(t) => Some(TaskDto::from_row(k.rec.id, t)),
                    RowSubject::Note => None,
                },
                cells,
            });
```

`compute_summaries` and `group_key` take rows — route them through the same subject-aware `RowData` construction (their signatures can keep `&[Kept]` and rebuild internally via the helper).

- [ ] **Step 4: Run the exec suite**

Run: `cargo test -p oximemo-core base::`
Expected: PASS — every pre-existing notes-source test must still pass byte-for-byte (row_id addition is additive serialization; tests comparing whole `BaseRow` structs will need the two new fields in expected literals — update them mechanically).

- [ ] **Step 5: Commit**

```bash
git add crates/oximemo-core/src/base/exec.rs
git commit -m "feat(base): subject-driven executor with row_id and TaskDto rows"
```

---

### Task 4: Query semantics — 200 default limit, Null-ordering contract, truncation warning

**Files:**
- Modify: `crates/oximemo-core/src/base/exec.rs` (hard cap at line 558; the record loop's task-source branch)
- Test: same file, `mod tests`

**Interfaces:**
- Consumes: Task 3's iteration (records carry `tasks_truncated: bool`).
- Produces: `pub const TASK_SOURCE_DEFAULT_LIMIT: u32 = 200;` applied when `def.source == Tasks` and `view.limit.is_none()`; `BasePage.warnings` gains a per-note truncation warning when a task-source note has `tasks_truncated` set.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn task_source_applies_200_default_limit() {
    // tmp vault; one note with 250 synthetic task lines
    // ("- [ ] task 000 … task 249") via format!; run source: tasks
    // with NO view limit -> page.total == 200, rows.len() == request limit.
    // Same def with `limit: 5` on the view -> total == 5 (explicit wins).
}

#[test]
fn task_source_null_ordering_is_fatal_until_guarded() {
    // One dated + one undated task; def filter `task.due < today()` ->
    // run_base returns Err containing "cannot compare" (expression
    // error, spec §4 — not a silent row drop).
    // Filter `task.due != null && task.due < today()` -> Ok, page
    // holds exactly the dated task.
    // `task.due == null` -> Ok, page holds exactly the undated task.
}

#[test]
fn truncated_task_note_surfaces_a_query_warning() {
    // tmp vault; hand-write a note whose body has 1001 task lines
    // (exceeds MAX_TASKS_PER_NOTE) via std::fs::write into the vault
    // dir + v.reindex(); run source: tasks -> page.warnings contains
    // an entry mentioning the note path and "truncat".
    // total == 1000 (the note's indexed rows), not 1001.
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test -p oximemo-core base::exec::tests::task_source`
Expected: FAIL (no default limit / no warning).

- [ ] **Step 3: Implement**

Hard cap replacement (line 557):

```rust
        // Spec §4: an undeclared limit on a task source defaults to
        // 200 — task datasets are per-line, not per-note, and an
        // accidental unbounded query would otherwise fan out to the
        // whole vault's task lines.
        let effective_limit = view.limit.or(match def.source {
            BaseSourceKind::Tasks => Some(TASK_SOURCE_DEFAULT_LIMIT),
            BaseSourceKind::Notes => None,
        });
        if let Some(cap) = effective_limit {
            kept.truncate(cap as usize);
        }
```

In the task-source branch of the record loop (before iterating subjects):

```rust
            if task_source && rec.tasks_truncated {
                warnings.push(format!(
                    "{}: task list truncated at {} rows (only the first {} indexed)",
                    rec.path, crate::tasks::MAX_TASKS_PER_NOTE, crate::tasks::MAX_TASKS_PER_NOTE
                ));
            }
```

(`MAX_TASKS_PER_NOTE` is already `pub` in `tasks.rs`; if not, make it `pub` — it is referenced by tests already.)

- [ ] **Step 4: Run the suite**

Run: `cargo test -p oximemo-core base::`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/oximemo-core/src/base/exec.rs
git commit -m "feat(base): task-source default limit, null-ordering guards, truncation warning"
```

---

### Task 5: CLI JSON demonstration, wire-contract snapshot, cache invalidation

**Files:**
- Modify: `crates/oximemo-cli/src/commands.rs` (`mod tests`; `cmd_base_run` at line 582 gains nothing — JSON already serializes the new fields)
- Test: same file, `mod tests`

**Interfaces:**
- Consumes: everything above; `cmd_base_run(vault, path, view, limit, offset)`.
- Produces: the plan's standalone demonstration — a hand-written `.query` on disk run through the real CLI path — plus the pinned JSON wire contract Plan C and browser fixtures consume; no production code changes expected in this task (if `cmd_base_run` needs a `--format json` flag it already has one — verify, don't add).

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn base_run_json_exposes_task_rows_and_row_ids() {
    let t = TmpVault::new();
    // Create a daily note with two tasks (one recurring), then write a
    // hand-written .query exactly as a user would:
    let query = "source: tasks\nviews:\n  - type: tasks\n    filters:\n      - \"task.type != \\\"DONE\\\"\"\n    order:\n      - property: task.due\n        direction: asc\n";
    let qdir = t.dir().join("queries");
    std::fs::create_dir_all(&qdir).unwrap();
    std::fs::write(qdir.join("todo.query"), query).unwrap();
    // cmd_base_run prints; assert through the same call path it uses
    // (run_base + serde), then assert the serialized JSON keys:
    let page = t.v().run_base(
        &BaseSource::Path("queries/todo.query".into()),
        &RunBaseReq {
            view_index: 0,
            offset: 0,
            limit: 10,
            group: None,
            now_ms: None,
            local_offset_seconds: None,
            include_group_counts: false,
            include_summaries: false,
            this_id: None,
        },
    ).unwrap();
    let json = serde_json::to_value(&page).unwrap();
    let row = &json["rows"][0];
    for key in ["row_id", "summary", "folder", "format", "task", "cells"] {
        assert!(row.get(key).is_some(), "wire key {key} missing: {row}");
    }
    assert!(row["row_id"].as_str().unwrap().starts_with("t:"));
    assert!(row["task"]["task_ref"]["line_hash"].is_string(), "hash stays hex text");
    assert!(row["task"]["task_ref"]["memo_id"].is_string());
}
```

(The exact req-builder helpers follow the file's existing tests; `t.dir()` may need a small accessor if `TmpVault` lacks one — add `fn dir(&self) -> &Path` to the existing struct, it is test-local.)

- [ ] **Step 2: Run to verify it fails** — `cargo test -p oximemo-cli base_run_json` — expected FAIL or the test compiles and passes trivially if the previous tasks already emit the fields; in that case the test is the contract pin, keep it.

- [ ] **Step 3 (only if Step 2 revealed a gap): fix the gap** in the production module where it lives.

- [ ] **Step 4: Manual demonstration (the plan's DoD)**

In a scratch vault (temp dir), with the real binary:

```bash
# scratch vault in a temp dir; the global --vault flag (env OXIMEMO_VAULT)
# points the CLI at it.
CLI="cargo run -p oximemo-cli --"
$CLI --vault /tmp/planb-demo task add "demo task" --due 2026-12-01
printf 'source: tasks\nviews:\n  - type: tasks\n' > /tmp/planb-demo/queries/todo.query
$CLI --vault /tmp/planb-demo base run queries/todo.query --format json
```

Expected: JSON rows with `row_id: "t:…"`, `task.text: "demo task"`, and the due chip visible in `task.due`. Record the exact output in the task report.

- [ ] **Step 5: Full gate + commit**

```bash
cargo test -p oximemo-core -p oximemo-cli
cargo clippy -p oximemo-core -p oximemo-cli -- -D warnings
cargo fmt --check -p oximemo-core -p oximemo-cli
git add crates/oximemo-cli/
git commit -m "test(cli): pin base-run JSON task wire contract"
```

---

## Plan B Definition of Done

- `cargo test -p oximemo-core -p oximemo-cli` passes with 0 failures (expect ~464 core + a dozen new, plus CLI).
- `cargo clippy -p oximemo-core -p oximemo-cli -- -D warnings` clean; `cargo fmt --check` clean.
- `oximemo base run <file>.query --format json` on a hand-written `source: tasks` file returns task rows with distinct `row_id`s, `task` DTOs (hex `line_hash`), per-task formula cells, guarded Null semantics, the 200 default limit, and a truncation warning for over-cap notes (spec §13 "Query integration" bullets: distinct row_ids/formula cells ✓, filters ✓, Null optional fields ✓, guarded daily-date filter with an undated task ✓, 200 default ✓; `this.file.name` scoping and every-view-type acceptance are Plan C rendering concerns — the engine tests here cover the underlying rows).
- Cache invalidation: a `patch_task` mutation bumps the snapshot generation, so the next `run_base` re-evaluates (covered by the existing generation-key tests plus one new assertion inside Task 5's test file if not already implied — add `assert result_key changes after mutation` to the Task 5 test when convenient).
- No frontend/Tauri file touched.
