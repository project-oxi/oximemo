# Tasks (할 일) — Design

Date: 2026-08-27 · Status: proposed (brainstorm + design review 2026-08-27)
· revised after independent review · awaiting final approval · Prior art
verified against obsidian-tasks v8.4.0, logseq master (2026-08-26),
obsidian-help master, Dataview docs

## Goal

Logseq-/Obsidian-Tasks-grade task management where **the markdown task
line is the only source of truth**. A task is an extended GFM-compatible
checkbox list item in any note; there is no separate task store.
Aggregation, scheduling views, and daily-note composition ride the shipped
query engine (`source: tasks`). Tasks are created and edited three ways with
identical results: typing markdown, GUI (checkbox click / edit popover /
slash command), and agents (`oximemo task` CLI). App-generated task metadata
never renders as emoji: each recognized field renders as a lucide icon with
a localized date chip. User-authored text, including intentional emoji, is
preserved verbatim.

## Decisions (from brainstorm)

| Question | Decision |
|---|---|
| Source of truth | Extended GFM-compatible checkbox lines in note bodies. `[ ]`/`[xX]` are the GFM subset; custom status characters are the Obsidian Tasks extension. No separate task space, no per-task note. |
| Wire format | Obsidian Tasks **emoji** format is canonical; `[due:: …]` dataview format is read-compatible. One write format per vault (`[tasks] write_format`, default `emoji`). |
| UI presentation | **App-generated task metadata never renders as emoji.** lucide icons + localized relative date chips; intentional emoji in the user's description remains text. React and CM6 share one semantic icon mapping. |
| Status model | Obsidian Tasks' `symbol → (name, next symbol, type)` table; 6 types. Unknown symbols degrade to `TODO`. |
| Logseq marker words (`TODO`/`DOING`), org `SCHEDULED:`/`DEADLINE:`, `:LOGBOOK:` | Rejected — not GFM, bound to outline blocks, doubles file churn. The scheduled/start/due *semantics* are adopted through emoji fields. |
| Index | `IndexRecord.tasks: Vec<TaskRow>` — zero new redb tables; rides existing upsert/watcher/snapshot-generation/result-cache machinery. |
| Query | `.query` gains `source: notes \| tasks`; `RowData.subject`, `BaseRow.row_id`, and all existing view adapters become dataset-aware; new view type `tasks`. |
| Mutation unit | Strict optimistic raw-line or bounded-subtree patch keyed `(memo_id, line, line_hash)` under one exclusive vault lock. |
| Daily notes | Template section + `this.file.name`-scoped query fence; manual rollover command; recurring tasks belong in a dedicated note. |
| Agent surface | `oximemo task` CLI + `skills/oximemo/SKILL.md`. Not IPC — the app never applies agent output (`copilot.rs:447-500`, `lib.rs:2066`). |
| Slash commands | General editor command system; tasks are one group. |
| Reminders/notifications | Out of scope v1 — no notification plugin, no scheduler (`apps/desktop/src-tauri/Cargo.toml:22-38`, `capabilities/default.json`). |
| Browser fallback (`tauri.ts`) | Task queries are desktop-only (a second index/parser is not acceptable). Editor checkbox toggle and slash commands work everywhere through a Rust draft-transform command on desktop and a golden-fixture-tested TS mirror in browser mode. |

## §1 Wire format

A task is a Markdown list item whose content starts with an extended
checkbox marker:

```md
- [ ] 우유 사기 #장보기 🛫 2026-08-28 ⏳ 2026-08-29 📅 2026-08-30 ⏫ 🔁 every week when done
- [/] 스펙 초안 쓰는 중 📅 2026-08-27
- [x] redb 벤치 돌리기 ✅ 2026-08-27
- [-] 취소된 것 ❌ 2026-08-27
```

- Unordered markers `-`, `*`, `+` and ordered markers (`1.`, `2)`, …) are
  accepted and preserved. `[ ]`, `[x]`, and `[X]` are GFM; other one-character
  markers such as `[/]` and `[-]` are the Obsidian Tasks-compatible extension.
  Leading indentation is measured in Markdown columns (a tab advances to the
  next multiple of four); an indented task records its nearest containing
  shallower list task as `parent`, not merely the nearest preceding task line.
- Field table (canonical emoji ↔ dataview alias, both parsed):

  | Field | Emoji | Dataview | Value |
  |---|---|---|---|
  | created | `➕` | `[created:: …]` | `YYYY-MM-DD` |
  | start | `🛫` | `[start:: …]` | `YYYY-MM-DD` |
  | scheduled | `⏳` | `[scheduled:: …]` | `YYYY-MM-DD` |
  | due | `📅` | `[due:: …]` | `YYYY-MM-DD` |
  | done | `✅` | `[completion:: …]` | `YYYY-MM-DD` |
  | cancelled | `❌` | `[cancelled:: …]` | `YYYY-MM-DD` |
  | priority | `🔺⏫🔼🔽⏬` | `[priority:: highest…lowest]` | 5-level scale |
  | recurrence | `🔁` | `[repeat:: …]` | rule string starting `every` |

- Dates are **date-only, local**. No times: the app has no scheduler, and
  Obsidian Tasks' timezone bug class (#1289, #2785, #3395) all stems from
  timestamp-vs-local-day confusion.
- Invalid or duplicate fields are not dropped. `TaskWarning { field, raw,
  kind }` records the exact offending token for UI repair. When direct
  Markdown contains the same field more than once, the **rightmost valid**
  value wins for queries; every token remains byte-for-byte in the raw line
  until an app edit of that field collapses its duplicates to one canonical
  token. Unsupported recurrence is the same warning path, not a separate
  parser failure.
- Description = the line minus checkbox, minus recognized top-level field
  tokens, minus the exact configured `global_filter` token. Trailing inline
  tags are scanned with the existing `crates/oximemo-core/src/tags.rs`
  scanner so task tags and note tags normalize identically. Field-looking
  text inside inline code or link destinations is description, never
  metadata.
- Parser tolerances (each is a documented upstream footgun): a `\u00A0`
  (NBSP) between an emoji and its date is accepted (obsidian-tasks #606);
  `\uFE0F` variation selectors are ignored for symbol matching but retained
  in the raw line (#2273); multiple separator spaces are accepted; unknown
  emoji are left verbatim in the description and never swallowed.
- `write_format` (`emoji` | `dataview`) picks the serialization for every
  app-initiated field write. Reading always accepts mixed formats. New tasks
  and task promotion also append the configured non-empty `global_filter`;
  editing text preserves it. Removing that token by hand intentionally
  demotes the line to an ordinary checklist item on the next reindex.

### Why emoji on disk, icons on screen

Emoji fields are the interop standard actually read by Obsidian Tasks,
Dataview, and downstream exporters; they keep ordinary field updates on one
line and remain greppable. Normal UI never asks the user to type or interpret
those markers: §7.0 renders metadata as icon chips and §7.2/§7.3/§8 insert it
through controls. Raw metadata is deliberately revealed only while the caret
is inside that task line, preserving direct hand editing. A vault that wants
zero emoji on disk sets `write_format = "dataview"`; rendered metadata is
identical either way.

## §2 Status model

`[tasks.statuses]` is a validated table of
`symbol → (optional custom name, next symbol, type)`; built-in labels are
localized by `StatusType`, while a configured custom `name` is displayed
verbatim. Defaults:

| Symbol | Built-in label key | Next | Type |
|---|---|---|---|
| `` (space) | task_status_todo | `x` | `TODO` |
| `/` | task_status_in_progress | `x` | `IN_PROGRESS` |
| `x` / `X` | task_status_done | (space) | `DONE` |
| `-` | task_status_cancelled | (space) | `CANCELLED` |

- Types: `TODO`, `IN_PROGRESS`, `ON_HOLD`, `DONE`, `CANCELLED`, `NON_TASK`.
  `done` = `DONE ∪ CANCELLED`; `not done` = `TODO ∪ IN_PROGRESS ∪ ON_HOLD`.
  `NON_TASK` lines remain ordinary checkboxes and are excluded from
  `IndexRecord.tasks`.
- `X` normalizes to the built-in `x` definition. Any other unknown symbol
  degrades to `{ name: "Unknown", next: 'x', type: TODO }` so imported theme
  markers remain queryable instead of causing parse errors.
- A config is rejected unless every symbol is exactly one character,
  symbols are unique after `X → x` normalization, every `next` symbol
  resolves, and every type is known.
- Type transitions are defined once by Rust and occur only when the type
  changes:
  - entering `DONE` clears `cancelled`, stamps `done = today`, and may spawn
    recurrence (§6); leaving `DONE` clears `done`
  - entering `CANCELLED` clears `done` and stamps `cancelled = today`;
    leaving `CANCELLED` clears `cancelled`
  - `NON_TASK` never stamps dates or recurs
- The frontend reads definitions for labels and controls through `get_config`;
  it does not reimplement transitions. Desktop editor mutations call the pure
  Rust draft transformer (§5/§7.1); the browser mirror is verified against
  the same generated fixture corpus.

## §3 Extraction and indexing

New module `crates/oximemo-core/src/tasks.rs`:

```rust
#[serde(transparent)]
pub struct TaskLineHash(pub String); // lowercase 16-hex BLAKE3-64; JSON-safe

pub struct TaskWarning {
    pub field: Option<TaskField>,
    pub raw: String,
    pub kind: TaskWarningKind,       // InvalidValue | Duplicate | UnsupportedRule
}

pub struct TaskRow {
    pub line: u32,                   // 0-based body line index
    pub indent_columns: u16,
    pub parent: Option<u32>,         // nearest containing shallower task line
    pub symbol: char,
    pub status_type: StatusType,
    pub text: String,                // description, recognized fields stripped
    pub tags: Vec<String>,
    pub section: Option<String>,     // nearest preceding heading
    pub created: Option<Date>, pub start: Option<Date>, pub scheduled: Option<Date>,
    pub due: Option<Date>, pub done: Option<Date>, pub cancelled: Option<Date>,
    pub priority: Priority,          // Highest..Lowest, default None
    pub recurrence: Option<String>,
    pub warnings: Vec<TaskWarning>,
    pub line_hash: TaskLineHash,
}

pub fn parse_tasks(body: &str, fmt: NoteFormat, cfg: &TasksConfig) -> ParsedTasks;
pub fn render_new_task(text: &str, fields: &TaskFields, cfg: &TasksConfig) -> Result<String>;
pub struct TaskLineChange {
    pub start_line: u32,             // 0-based gap/line
    pub delete_lines: u32,
    pub insert_lines: Vec<String>,
}
pub struct TaskDraftTransform { pub changes: Vec<TaskLineChange> }

pub fn transform_task_draft(
    body: &str, line: u32, edit: &TaskEdit, today: Date, cfg: &TasksConfig
) -> Result<TaskDraftTransform>;
```

`parse_tasks` is pure and property-tested (§13). It also returns
`truncated: bool` when the per-note cap is reached. Insertion points:

- `FileStore::read_memo` (`crates/oximemo-core/src/store/files.rs:271-303`)
  and `record_of` (`vault.rs:2853`) populate
  `IndexRecord.tasks: Vec<TaskRow>` (`store/index.rs:27-49`).
- Existing `upsert`, `reindex_path` (`vault.rs:2346-2360`), the debounced
  watcher (`watcher.rs`, `config.rs:288-296`), and the base result cache's
  `ResultKey.generation` (`base/cache.rs:152-175`) pick task changes up
  without a second index. Per-file incremental reindex — the exact fix
  obsidian-tasks needed after #697 and still the cause of its 40k-vault
  startup complaints (#3492) — is inherited, not rebuilt.
- Excluded from extraction: `.html` notes (v1; body is not markdown),
  `TEMPLATE.md`/`TEMPLATE.html`, `.trash/`, `_assets/`.
- `MAX_TASKS_PER_NOTE = 1000`; overflow sets
  `IndexRecord.tasks_truncated = true` and surfaces a query warning instead
  of silently omitting rows. `snapshot_with_gen` keeps the existing 50k-note
  cap and adds a total cached-task weight cap; exceeding either returns the
  fresh snapshot without caching. The note-count cap alone does not bound
  `Vec<TaskRow>` memory.
- `INDEX_FORMAT_VERSION` (`vault.rs:47-51`) is bumped for the schema change.
  A separate persisted BLAKE3 fingerprint of canonical
  `(parser_version, enabled, global_filter, statuses)` triggers reindex when
  extraction-affecting config changes. Presentation-only `write_format`,
  `capture_target`, and `recurrence_insert` are excluded from the fingerprint.
- Both `tasks` and `tasks_truncated` are declared `#[serde(default)]`.
  This is load-bearing: most evolvable `IndexRecord` fields follow that
  pattern (`store/index.rs:34-50`), while mandatory `hash`, `deleted`, and
  `preview` deliberately do not. Without defaults, pre-existing JSON records
  fail before the version-bump reindex can refill them. Old records therefore
  load as `tasks: []`, `tasks_truncated: false`.
- Block scanning follows CommonMark fence rules: backtick and tilde fences,
  opener length, matching closer length/character, and up to three leading
  spaces. Task-like text inside fenced or indented code is skipped.
  Blockquote task items and multi-line task descriptions are preserved as
  Markdown but are not independently indexed in v1; they are explicit
  non-goals rather than accidental partial support.

## §4 Query engine — `source: tasks`

- `BaseDef` (`crates/oximemo-core/src/base.rs:26-39`) gains
  `source: BaseSourceKind` (`notes` default, `tasks`); an unknown value is a
  load-time error (`base.rs:262-330` validation path).
- `RowData` is currently a struct, not an enum (`expr/eval.rs:60-71`). It
  gains `subject: RowSubject<'a>`:

  ```rust
  enum RowSubject<'a> { Note, Task(&'a TaskRow) }
  ```

  `from_record` constructs `Note`; a task-source loop constructs one
  `Task` scope per indexed task. Formula evaluation, filtering, group-major
  stable sort, aggregates, and paging continue to operate on `RowData`, but
  `base::exec` must iterate `(IndexRecord, TaskRow)` subjects rather than
  claiming this is a zero-change seam.

  | Namespace | Resolves to |
  |---|---|
  | `task.*` | `status` (symbol), `type`, `text`, `tags`, `section`, `line`, `created`, `start`, `scheduled`, `due`, `done`, `cancelled`, `priority` (Num −2…2), `recurring` (Bool), `invalid` (Bool), `warnings` (List) |
  | `file.*` | the **parent note** — `path`, `folder`, `name`, `format`, `created`, `updated`, `favorite`, `tags` (unchanged semantics) |
  | `note.*` / bare | the parent note's frontmatter props, with the existing core-key fallback |
  | `this.*` | unchanged embed scope (`exec.rs:423-468`) |

- Missing optional task fields resolve to `Null`. Equality with `null` is
  valid; ordering against `Null` is an expression error, so shipped/default
  filters must guard optional dates with `field != null && …`.
- `BaseRow` (`exec.rs:94-100`) gains both `row_id: String` and
  `task: Option<TaskDto>`. Note rows use `n:<memo_id>`; task rows use the
  generation-scoped identity `t:<memo_id>:<line>`. `summary` still carries
  the parent note's metadata, but is **not** row identity.
- Supporting every existing view is an explicit cross-cutting refactor:
  `BaseView` keeps `BaseDisplayRow[]`; formula cells, `TableView`
  freeze/patch maps, React keys, Board drag state, List/Card adapters, and
  query embeds all key by `row_id` rather than `summary.id`. Task cards/list
  items render task text + field chips + parent breadcrumb.
  Selection opens through `openTask(TaskRef)`: use the indexed line when its
  hash still matches, otherwise search the current body for one unique
  `line_hash`; ambiguous/missing matches open the parent note without
  scrolling and show a stale-result toast. Local patched/frozen state is
  cleared when `BasePage.result_key` changes (`exec.rs:94-107`), because
  line-based task identity is generation-scoped and intentionally not
  persistent across external edits.
- New view type `tasks` is a checkbox list (group section → checkbox →
  description → field chips → note breadcrumb). `table`, `board`, `list`,
  and `cards` also accept task rows. Board drag commits a status only when
  grouped by editable `task.status`; a derived `task.type` board is
  view-only because multiple configured symbols may share one type.
- Editable task cells: `task.status`, `task.due`, `task.scheduled`,
  `task.start`, `task.priority`, and `task.text`. Everything under `file.*`,
  `note.*`, and `formula.*` stays read-only. Commits route to `patch_task`
  (§5); every commit carries `TaskDto.task_ref`.
- When `source: tasks` and a view declares no `limit`, the engine applies
  **200**. `Checked`/`Unchecked` summaries retain their Bool-property
  meaning; completion counts use explicit `task.type` filters.

## §5 Mutation primitive

```rust
pub struct TaskRef {
    pub memo_id: MemoId,
    pub line: u32,
    pub line_hash: TaskLineHash,
}

pub enum TaskSelector {
    Exact(TaskRef),
    CurrentLine { memo_id: MemoId, line: u32 }, // explicit CLI --force only
}

pub enum DateField { Created, Start, Scheduled, Due, Done, Cancelled }

pub enum TaskEdit {
    Toggle,
    SetStatus(char),
    SetDate { field: DateField, value: Option<Date> },
    SetPriority(Priority),
    SetText(String),
    SetRecurrence(Option<String>),
    Delete,
}

pub enum AddTarget { Note(MemoId), Daily(Date), Inbox }

pub struct MoveTasksRequest {
    pub source: MemoId,
    pub tasks: Vec<TaskRef>,
    pub destination: AddTarget,
    pub expected_destination_hash: Option<MemoHash>,
}

impl Vault {
    pub fn patch_task(&self, s: TaskSelector, e: TaskEdit, today: Date)
        -> Result<PatchTaskResult>;
    pub fn add_task(&self, t: AddTarget, text: String, f: TaskFields, today: Date)
        -> Result<PatchTaskResult>;
    pub fn move_tasks(&self, r: MoveTasksRequest, today: Date)
        -> Result<MoveTasksReceipt>;
}
```

`TaskDto` contains the indexed fields plus a complete `task_ref`.
`PatchTaskResult` returns the updated note hash, changed task, and optional
spawned task rather than the whole note body. `MoveTasksReceipt` contains
source/destination ids, pre/post `MemoHash` values, and the exact raw moved
lines needed for guarded undo; all three are shared Rust/Tauri/CLI DTOs.

- `TaskLineHash` is lowercase 16-hex text, never a JSON number: JavaScript
  cannot round-trip arbitrary `u64`. GUI/Tauri mutations always use
  `TaskSelector::Exact`; CLI mutation requires `--hash` unless the caller
  explicitly supplies `--force`, which maps to `CurrentLine`. A line number
  alone is not optimistic locking: an insertion above it can otherwise
  redirect the edit to another task.
- `patch_task` and `add_task` hold **one exclusive vault flock across the
  complete read → verify → raw-span rewrite → atomic file write → redb/search
  upsert** for cooperating GUI/CLI processes. This cannot call today's public
  `update_note_with` while holding the lock: that method opens separate
  shared/exclusive lock scopes (`vault.rs:820-835`, `:1135`,
  `:1308-1322`) and would race or re-enter the flock. Plan A extracts
  caller-lock-aware internal read/write/upsert helpers; existing public CRUD
  delegates to them without behavior change. Non-cooperating external editors
  cannot honor the vault flock, so the operation also rechecks the whole-file
  `MemoHash` immediately before replacement and returns `TaskConflict` if the
  bytes changed since its locked read; no design can serialize an editor that
  overwrites after that final check.
- Ordinary edits splice only the recognized token spans in the current raw
  line. They preserve list marker, unrecognized text, CRLF vs LF, final
  newline, and every untouched byte. `SetText`, section names, and
  `global_filter` reject newline and NUL. New tasks/promotions append the
  configured filter token; `SetText` cannot remove it.
- `Delete` is the sole bounded-subtree mutation: it removes the task line and
  dedents its descendant continuation/task lines by the deleted parent's
  indent delta, preserving relative nesting. This resolves the contradiction
  between “single line only” and child promotion.
- `today` is supplied by the caller in local time, exactly like
  `open_daily(date)` (`vault.rs:953`); the backend never guesses a timezone.
- `AddTarget::Daily` uses a caller-lock-aware
  `open_or_create_daily_locked` equivalent (the public `open_daily` delegates
  to it), so it remains idempotent without re-entering the vault lock. It
  adopts hand-created files, then appends inside `default_section`, creating
  the heading when absent. `Inbox` resolves to
  `{capture inbox folder}/{default_section}.md`, adopts it when present, and
  otherwise creates it through the same locked internal path.
- `move_tasks` is the only cross-note task operation. Each selected root
  moves with its full Markdown subtree; descendant selections already covered
  by an ancestor are deduplicated, destination root indentation is normalized
  to the section, and relative indentation/bytes are preserved. It verifies
  every source `TaskRef`; if `expected_destination_hash` is present it must
  match, while `None` accepts current contents or first creation. Under the
  same exclusive lock it prepares both bodies, rechecks whole-file hashes,
  writes the destination first, then the source. If the second write fails it
  restores the destination; a process crash between atomic replacements can
  duplicate a task but cannot lose it. `MoveTasksReceipt` records pre/post
  note hashes and exact moved subtrees; undo applies its inverse only while
  both post-hashes still match.

## §6 Recurrence

- Rule grammar (subset of Obsidian Tasks, which itself wraps RRULE):
  `every day|week|month|year`, `every N days|weeks|months|years`,
  `every weekday`, `every week on <weekday list>`, optional `when done`
  suffix. A rule must start with `every`.
- On entering `DONE`: the original line keeps its completed status and
  completion date; the next occurrence is inserted one sibling line above by
  default. `recurrence_insert = "below"` means **after the entire task
  subtree**, never immediately before its children.
- Reference date priority `due > scheduled > start`; `when done` anchors on
  the completion date instead. All present dates shift by the same delta so
  a start/due window is preserved.
- The spawned occurrence uses the first configured `TODO` symbol, preserves
  text/tags/recurrence, clears `done` and `cancelled`, shifts
  start/scheduled/due by the recurrence delta, and stamps `created = today`
  only when the original carried a created field. Re-applying DONE to an
  already-DONE type is a no-op and never spawns twice.
- Month/year arithmetic reuses `expr::value::date_add`
  (`expr/value.rs:206-226`), which applies calendar months first with
  end-of-month clamping and saturates instead of panicking on overflow.
  **No RRULE crate is added.** Two bridging details the implementation must
  honor: (a) its signature is
  `date_add(OffsetDateTime, &DurationSpec, sign: i32, local: UtcOffset)`,
  so a date-only task field is lifted to local midnight, shifted, then
  converted back to a local `YYYY-MM-DD` — never through UTC; (b)
  `every N months|years` uses `DurationSpec.calendar_months`, while
  `every N days|weeks` and `every weekday` use `fixed_millis`, matching how
  duration literals already compile (`expr/value.rs:88-135`).
  Clamping is also why `every month on the 31st`-style rules are excluded
  below: Obsidian Tasks *skips* short months there, which is the opposite of
  clamping, and shipping a silent semantic mismatch is worse than refusing
  the rule.
- A recurrence rule requires at least one of start/scheduled/due (Tasks
  5.0.0 rule): the GUI blocks it, the CLI rejects it, and a file that
  violates it parses with a warning flag rather than failing.
- Unsupported complex rules (`every 6 months on the 2nd Wednesday`) do not
  silently mis-fire: parsing fails, the task keeps its rule text verbatim,
  the UI shows a warning chip, and completion does not spawn a child.
- `transform_task_draft` is the single desktop transition/recurrence
  implementation. It accepts the full unsaved body plus target line, parses
  the current task subtree, and returns non-overlapping line changes. This
  lets `recurrence_insert = "below"` target the gap after the subtree rather
  than stealing its children. It reads/writes no disk. The CM6 adapter maps
  line ranges to document offsets and dispatches all changes in one
  transaction. The browser-only TS mirror consumes the same generated golden
  fixtures; it is not a second index or production persistence path.

## §7 GUI

### §7.0 Icon rendering layer (zero emoji metadata in UI)

The semantic icon catalog is the table below. React imports
`lucide-react ^0.460.0` (`apps/desktop/package.json:30`); CM6 uses static
SVG masks copied from that exact pinned catalog. They are two render
implementations of one reviewed mapping, not falsely claimed to be one
runtime source.

| Field | Icon | Field | Icon |
|---|---|---|---|
| created | `CalendarPlus` | recurrence | `Repeat` |
| start | `Play` | highest / high | `ChevronsUp` / `ChevronUp` |
| scheduled | `CalendarClock` | medium | `Equal` |
| due | `CalendarDays` | low / lowest | `ChevronDown` / `ChevronsDown` |
| done | `CalendarCheck` | cancelled | `CalendarX` |
| invalid date | `TriangleAlert` | unsupported recurrence | `CircleAlert` |

Two render contexts, two mechanisms, one visual result:

1. **React surfaces** (tasks view, table cells, list rows, edit popover,
   slash menu): `lucide-react` components via shared
   `components/TaskFieldChip.tsx` and `components/TaskCheckbox.tsx`.
2. **CM6 widget DOM** (non-React, cannot mount components): the widget emits
   `<span class="ox-task-field ox-task-due">8월 30일</span>` and the glyph
   comes from `app.css` via `mask-image` with an inlined lucide SVG data URI
   plus `background-color: currentColor`, so theme and dark mode follow for
   free. Precedent for plain CSS classes on widget DOM is
   `.ox-query-embed` (`apps/desktop/src/app.css:163-188`). The lucide source
   and its ISC license are noted in a CSS comment. Rejected alternative:
   `react-dom/server`-rendered SVG strings (pulls a server renderer into the
   client bundle) and per-widget React portals (lifecycle complexity inside
   a CM6 `WidgetType`).

Both paths share semantic class names and a snapshot test verifies that
every catalog entry has both a React component and a CSS mask.

- **Checkbox is a control, not a glyph**: `<button role="checkbox"
  aria-checked>` with a CSS box; the inner mark is `Check` (done), `Minus`
  (cancelled), or a half-fill (in progress). Keyboard-focusable, with
  `focus-visible:outline-2 focus-visible:outline-focus-ring` per the token
  rules.
- **Dates never render as raw ISO.** New `dates.ts` helper
  `relativeDayLabel(iso, today, locale)` → `오늘` / `내일` / `어제` /
  `8월 30일` / `3일 지남`, built on the existing local-time `daysBetween`
  and `dayLabel` (`lib/dates.ts:57-62`, `:81-87`). Tone: overdue
  `--color-status-error`, today `--color-status-warning`, future subtle.
  A shared local-midnight timer updates a `todayKey` state and invalidates
  relative labels after day rollover; render-time `new Date()` calls alone
  are insufficient.
- **Card previews** (HTML string, no React): preprocessing replaces both
  recognized metadata fields and every extended checkbox marker (`[ ]`,
  `[xX]`, `[/]`, `[-]`, configured symbols) with the same inert
  `ox-task-*` markup before `marked`. This is required because GFM `marked`
  renders only space/x markers. The existing sanitizer is a FORBID-list, so
  `span`/`class` survive. `previewText` strips recognized metadata only;
  intentional emoji in the user's task description remains untouched.
- Priority renders as an icon + tone only; no numeric badge.

### §7.1 Editor checkbox widget

- New `apps/desktop/src/lib/taskCheckboxes.ts`, factory
  `taskCheckboxExtension({ statuses, labels })`, mounted in the existing
  extension assembly (`MemoEditorForm.tsx:52-83`) which
  `MarkdownEditor.tsx:158-165` forwards to `AtomicCodeMirrorEditor`.
- Structure follows `lib/embeds.ts` — line scan, `Decoration.replace`,
  `WidgetType.eq/toDOM`, and a `ViewPlugin` that rebuilds decorations on
  document, viewport, **or selection** changes. Selection-triggered rebuild
  is required to reveal raw text under the caret; merely mapping existing
  decorations through `tr.changes` cannot implement live preview. Widgets
  never fetch or own the view. Button handlers prevent the editor's default
  mousedown selection before applying their transaction.
- Click / `⌘⇧Enter` sends the full current draft and target line to the pure
  `transform_task_draft` Tauri command, converts its non-overlapping line
  changes to CodeMirror offsets, and dispatches them in one transaction;
  browser mode uses the golden-tested TS mirror. The existing 500 ms autosave
  then persists the draft. No disk-based `patch_task` runs while the editor
  owns an unsaved buffer.
- **Required cutover:** `MemoDetail`'s save-and-close handler is
  `(e.metaKey || e.ctrlKey) && e.key === "Enter"` (`MemoDetail.tsx:129`)
  and does not exclude `shiftKey`. It must gain `&& !e.shiftKey` in the same
  task. The CM6 keymap remains under `Prec.highest`, but the document-level
  listener still requires the guard.
- Out-of-editor surfaces call strict `patch_task(TaskSelector::Exact, …)`.
  `lib/taskLine.ts` is the browser transform mirror and syntax helper, not
  the desktop source of transition logic. Rust generates its golden corpus
  across statuses, formats, warnings, recurrence, CRLF, and filter settings.
- Caret inside a decorated range reveals the raw text (standard live-preview
  behavior), so a field can always be hand-edited or deleted.

### §7.2 Task edit popover

`⌘⇧E` on a task line, or right-click on the checkbox, opens a popover
(Base UI `Popover`, following `FolderCombobox.tsx`'s structure, z-`[60]`)
with status, priority, start/scheduled/due date controls, recurrence with a
live next-occurrence preview, and description. v1 uses native date inputs
plus explicit 오늘/내일/지우기 shortcuts; it does not invent a second
natural-language date parser. Save uses strict `patch_task` outside the
editor or `transform_task_draft` on the editor's full draft. Plain tab order
and `⌘Enter` commit replace Obsidian's access-key affordance.

### §7.3 Line auto-suggest

A CM6 `CompletionSource` activates only on a recognized task line and
offers only fields not already present. Options render lucide icons and
localized labels. A date selection writes a real local ISO date in the
vault's configured format — e.g. `📅 2026-08-27` or
`[due:: 2026-08-27]` — while the widget immediately displays
`CalendarDays 오늘`. No literal `오늘` is serialized. CompletionSource
integration preserves the project's IME-safe doctrine.

### §7.4 Tasks surface

- Sidebar gains a `할 일` system entry opening an installed `.query` with
  `source: tasks` and views 오늘 / 예정 / 지연 / 전체. It is seeded once
  behind an install marker, follows the existing collection ownership rule,
  and is never recreated after deliberate deletion. Users may duplicate and
  edit it; there is no hidden query definition.
- Default grouping in the `tasks` view: 지연 / 오늘 / 내일 / 이번 주 /
  이후 / 날짜 없음, computed from `task.due` with `task.scheduled`
  fallback.
- Row click opens the parent note and scrolls to the task's line; the
  checkbox toggles in place through `patch_task`, then `["base"]` is
  invalidated exactly like the shipped cell-commit path
  (`TableView.tsx:194-211`).

### §7.5 Card previews stay inert

Card previews render only the first block, truncated
(`markdownPreview.ts:33-53`), so a preview checkbox cannot be reliably
mapped back to a body line. Preview checkboxes therefore render as
non-interactive chips, and `Card.tsx`'s article-level click
(`Card.tsx:60-64`) continues to open the note. Toggling lives in the
editor and in task views.

## §8 Slash commands (general system)

- New `apps/desktop/src/lib/slashCommands.ts` + `slashExtension(deps)`
  implemented as a CM6 `CompletionSource` over `@codemirror/autocomplete`
  (already a direct dependency, `package.json:15`), with a custom per-option
  `render` so rows carry icon + label + hint.
- Trigger: `/` at line start or after whitespace. Dismiss on `Esc` or
  `Space`; arrows + Enter select. It never fires mid-word, inside fenced or
  indented code, or inside an inline-code span.
- Ranking reuses `paletteCommands.ts` verbatim — `matchScore`
  (`:225-249`), `rankCommands` (`:322-337`), `RecencyLog` (`:301-318`) —
  with a separate localStorage recency key (the app palette uses
  `oximemo.paletteRecency`, `CommandPalette.tsx:47`). The command *catalog*
  is forked, not reused: palette commands close over app navigation
  callbacks, editor commands close over an `EditorView`.
- Command shape: `{ id, group, label, hint, icon, apply(view, range) }` —
  Logseq's `(label, steps, doc, icon, group)` adapted to CM6. `apply` may
  insert text *or* transform the line (e.g. promote the current line to a
  task), which is what makes the task group possible.
- Groups (v1): **할 일** (할 일, 진행 중, 마감일, 예정일, 시작일,
  우선순위, 반복) · **날짜** (오늘, 내일, 어제, 현재 시각) · **서식**
  (제목 1-3, 표, 코드 블록, 인용, 구분선) · **링크** (메모 링크, 메모
  임베드, 이미지) · **쿼리** (쿼리 블록, 오늘의 할 일 블록) ·
  **템플릿** (폴더 템플릿 삽입).
- Insertion resolves `write_format`, `global_filter`, and current local date
  from dependencies. Menus render only icons and localized labels; generated
  task metadata is immediately decorated rather than shown as emoji text.

## §9 Daily-note composition

- The daily preset template (`schema.rs:514`) gains a `## 할 일` section
  followed by a query fence:

  ```query
  source: tasks
  filters:
    and:
      - 'task.type != "DONE" && task.type != "CANCELLED"'
      - '(task.due != null && task.due <= this.file.name) || (task.scheduled != null && task.scheduled <= this.file.name)'
  views:
    - { type: tasks, name: 오늘 }
  ```

  A daily note's `file.name` is its ISO date, and the engine promotes an
  ISO-parseable `Str` to `Date` in ordering comparisons, so day scoping
  needs **no new syntax**. `this.*` resolution in fenced blocks is already
  shipped (`exec.rs:423-468`, `queryEmbeds.ts:318-325`).
- Quick add: `⌘⇧T` anywhere, and `/할일` in the capture overlay, append one
  line to today's note through `add_task(AddTarget::Daily(today), …)`.
- **Rollover** is an explicit command (`어제의 미완료 이월`, also in the
  ⌘K palette) backed by `move_tasks`: strict source refs and destination note
  hash, destination-first writes, compensating rollback, and a
  `MoveTasksReceipt`. The toast's undo applies the receipt inverse only if
  both post-operation note hashes still match. It is never automatic.
- `add_task` warns when a recurring task targets a daily note: Obsidian
  Tasks documents this as an anti-pattern because each daily note would
  accumulate its own copies. Recurring tasks belong in a stable note that
  daily views query.
- The sidebar calendar (`Sidebar.tsx:225-273`) is unchanged in v1; a
  due-date heatmap is a non-goal.

## §10 Agent and CLI surface

Copilot cannot mutate the vault over IPC — the app takes a manifest
snapshot before and after a subprocess turn and only *observes* changes
(`copilot.rs:564`, `lib.rs:2225-2244`); the documented commit path is the
bundled `oximemo` CLI advertised in the context block plus
`skills/oximemo/SKILL.md` (`copilot.rs:447-500`). Therefore the CLI **is**
the agent API:

```
oximemo task list [--where EXPR] [--note ID] [--folder P]
                  [--due before:DATE|after:DATE|on:DATE] [--status SYMBOL]
                  [--not-done] [--limit N] [--format json|md|table]
oximemo task add  TEXT [--note ID | --daily [DATE] | --inbox]
                  [--section NAME] [--due D] [--scheduled D] [--start D]
                  [--priority highest|high|medium|low|lowest]
                  [--repeat RULE] [--tag T]…
oximemo task done   <NOTE_ID> <LINE> (--hash H | --force)
oximemo task status <NOTE_ID> <LINE> <SYMBOL> (--hash H | --force)
oximemo task edit   <NOTE_ID> <LINE> (--hash H | --force)
                    [--set-due D|--clear-due] [--set-text T]
                    [--set-priority P] [--set-repeat R|--clear-repeat]
oximemo task rm     <NOTE_ID> <LINE> (--hash H | --force)
oximemo task rollover [--from DATE] [--to DATE] [--dry-run]
```

- `--format json` emits `TaskDto`, including its complete `task_ref`;
  line numbers are documented as 0-based in JSON and CLI input so
  `list → edit` needs no conversion. Hashes are 16-hex strings. Mutation
  commands require `--hash`; `--force` is an explicit escape hatch that
  targets whatever task currently occupies that line and is never used by
  `SKILL.md` examples.
- `task add` with no explicit target resolves `[tasks].capture_target`;
  `--note`, `--daily`, and `--inbox` are mutually exclusive overrides.
- `task rollover` defaults yesterday → today, previews candidates with
  `--dry-run`, and calls the single core `move_tasks` operation.
- `SKILL.md` documents `TaskRef`, caller-local `today`, strict conflicts,
  and rollover. Nothing is added to `build_context`; unconditional task
  counts would add cost and noise to every turn.
- Tauri mirrors: `list_tasks`, `patch_task`, `add_task`, `move_tasks`, and
  pure `transform_task_draft`, registered in `generate_handler!`.
- Wire-DTO discipline: every new DTO serializes identically in Rust and in
  the browser fallback, with UI-derived fields kept in a separate repair
  layer — the rule established by the v0.10.0 crash
  (`lib/summaryFolder.ts:1-15` and its test).

## §11 Configuration

```toml
[tasks]
enabled = true
write_format = "emoji"        # emoji | dataview
global_filter = ""            # "" = every extended checkbox is a task
                              # e.g. "#task": exact token required, hidden
                              # from rendered metadata, auto-added by app writes
recurrence_insert = "above"   # above | below
default_section = "할 일"      # section add_task appends to (created if missing)
capture_target = "daily"      # daily | inbox — target of ⌘⇧T and the capture overlay

[[tasks.statuses]]
symbol = " "
# name = "Custom label"       # optional; built-in types use localized labels
next = "x"
type = "TODO"
# … one block per custom status; built-in defaults apply when absent
```

`enabled = false` hides every task surface and produces empty indexed task
vectors. On vault open/migrate, the extraction fingerprint described in §3
is compared before serving task queries; changing `enabled`,
`global_filter`, or `statuses` reindexes and bumps the normal generation.
Invalid status graphs or filter strings containing newline/NUL fail config
validation with an exact field error. `global_filter` defaults empty, like
Obsidian Tasks.

## §12 i18n

New keys in both `locales/ko.ts` (source) and `locales/en.ts` (typed
mirror): `tasks_section`, `task_new`, `task_edit`, `task_delete`,
`task_status_{todo,in_progress,on_hold,done,cancelled,non_task}`,
`task_priority_{highest,high,medium,low,lowest,none}`,
`task_field_{created,start,scheduled,due,done,cancelled}`,
`task_recurrence`, `task_recurrence_next`, `task_recurrence_needs_date`,
`task_warning_{invalid,duplicate,unsupported}`, `task_conflict_reload`,
`task_group_{overdue,today,tomorrow,this_week,later,no_date}`,
`task_rollover`, `task_rollover_done`, `task_rollover_none`,
`task_rollover_conflict`, `task_daily_recurrence_warning`, `view_tasks`,
`slash_group_{task,date,format,link,query,template}`, plus one label per
slash command. Relative dates use `relativeDayLabel` + `Intl`. Widget labels
are injected at mount; Rust config never hardcodes Korean defaults.

## §13 Testing

**Rust unit (`tasks.rs`)** — emoji/dataview/mixed parsing; GFM `[xX]` and
extended statuses; unordered and ordered markers; tab indentation and
containing-parent calculation; CommonMark backtick/tilde/indented-code
exclusion; inline-code/link-destination field lookalikes; NBSP and variation
selectors; rightmost-valid duplicate precedence with structured warnings;
global-filter recognition/insertion; exact CRLF/final-newline preservation;
per-note truncation flag; status validation and terminal-date transitions;
`render_new_task` for both write formats.

**Rust property (`proptest`)** — parse → transform → parse invariants over
generated task lines: an unrelated field edit changes only its token spans;
unknown metadata and user-authored emoji survive; strict hashes are stable
for unchanged bytes; arbitrary newline/NUL text inputs are rejected.

**Rust recurrence** — all supported units, weekday sets, `when done`,
month-end clamping, reference priority, spawned TODO/reset fields, below
insertion after the full subtree, same-type DONE no-op, missing-date and
unsupported-rule warnings.

**Rust integration (`tmp_vault()`)** — JSON/Tauri round-trip keeps
`TaskLineHash` as hex text; stale strict ref conflicts; two `Vault` instances
patch different lines concurrently without a lost update; `--force` is the
only current-line path; add injects `global_filter`; extraction-config
fingerprint changes force reindex; watcher edit bumps generation; truncation
surfaces a query warning; `move_tasks` failure injection never loses source
lines and its receipt undo rejects intervening edits.

**Query integration** — two tasks from one parent produce distinct
`BaseRow.row_id` values and formula cells; task filters, stable sort/group
paging, all optional fields as `Null`, guarded daily-date filter with an
undated task, `this.file.name` scoping, 200-row default, every existing view
type accepting task rows, and cache invalidation after mutation.

**CLI** — add → JSON list → strict edit → done round-trip; hash-required and
explicit-force paths; not-done semantics; rollover dry-run/commit/conflict;
JSON line numbers documented 0-based.

**Frontend (`bun test`)** — Rust-generated transform fixtures in the browser
mirror; every view adapter keys by `row_id` and renders task content instead
of collapsing by parent id; frozen/patched state resets on generation;
midnight timer and `relativeDayLabel`; slash triggers including inline/fenced
code guards; auto-suggest respects format/filter and emits ISO dates;
extended preview checkboxes become inert app controls; metadata emoji fields
disappear while user-authored emoji remain; icon-catalog React/CSS parity.

**Manual E2E (Tauri)** — editor transform reaches disk and every
tasks/table/board/list/cards view without row collisions; board drag on
`task.status`; caret reveal/restore; daily query remains healthy with
undated tasks; rollover and hash-guarded undo; concurrent CLI edit while GUI
is open; Korean IME slash behavior; keyboard/ARIA operation and icon contrast
in dark/light themes.

## §14 Non-goals (v1)

- OS notifications and due reminders — no notification plugin, no
  scheduler, no background tick exists today; a separate spec must add the
  plugin, capability, and a tick source.
- Task dependencies (`🆔` / `⛔`) and `🏁 onCompletion` — needs vault-wide
  id uniqueness; parsed and preserved verbatim, not interpreted.
- `:LOGBOOK:` / clock entries / time tracking.
- Urgency scoring and `sort by urgency`.
- Tasks inside `.html` notes.
- Blockquote task items and multi-line task descriptions as query rows; their
  Markdown remains untouched, but v1 indexes only the first-line list grammar
  defined in §1.
- Browser-fallback task queries (a second parser is not acceptable); the
  editor widget and slash commands do work in browser mode.
- Obsidian Tasks' English sentence DSL (`due before tomorrow`). The `expr`
  engine is the query language; sentence sugar can be layered later.
- Per-line block ids / `^block-ref` anchors for tasks.
- Due-date heatmap on the sidebar calendar.

## Review corrections (2026-08-27)

| Finding | Correction |
|---|---|
| Body patch and hash check were outside one lock | One exclusive GUI/CLI lock now covers read through index upsert; final whole-file hash recheck covers non-cooperating editors as far as possible |
| Parent `summary.id` collided for multiple task rows | Added `BaseRow.row_id`, `RowData.subject`, `BaseDisplayRow`, and an explicit all-view adapter cutover |
| Daily filter compared `Null <= Date` | Optional dates resolve `Null`; default query now short-circuit guards every ordering comparison |
| `global_filter` excluded app-created tasks | Every create/promote path auto-adds it; text edits preserve it |
| Extraction config could leave stale rows | Persisted parser/config fingerprint forces reindex |
| `u64` line hash was unsafe over JSON; optional hash could retarget | Hex `TaskLineHash`, strict-by-default selectors, explicit CLI-only `--force` |
| Rollover had no safe primitive | Added destination-first `move_tasks`, compensating rollback, receipt-based guarded undo, CLI/Tauri mirrors |
| “GFM” overstated custom statuses; parser lost warning detail | Defined extended grammar, `[X]`, ordered lists, CommonMark fences, structured raw warnings, duplicate precedence |
| Delete claimed both one-line rewrite and child promotion | Defined one bounded-subtree exception with deterministic dedent |
| Terminal status dates could remain contradictory | Entry cross-clears the other terminal date; exit clears its own |
| Editor would duplicate Rust recurrence logic | Desktop uses pure Rust draft transformer; browser mirror is fixture-differential |
| “No emoji anywhere” contradicted user text preservation | Zero-emoji promise narrowed to app-generated metadata; user-authored emoji remains |
| 50k-note snapshot cap did not bound task vectors | Added total cached-task weight cap and visible per-note truncation warning |

User scope decision after review: `source: tasks` supports
`tasks`, `table`, `board`, `list`, and `cards` in v1. This is an explicit
Plan B/C row-model refactor, not a free side effect of retaining
`MemoSummary`.

## Implementation plans

Five plans, each independently demonstrable:

- **Plan A — core and safe mutation**: grammar/parser/warnings,
  `TaskLineHash`, `IndexRecord.tasks` + truncation/fingerprint migration,
  config validation, lock-aware mutation internals, pure
  `transform_task_draft`, strict `patch_task`/`add_task`/`move_tasks`, full
  `oximemo task` CLI including rollover, and `SKILL.md`. Demonstrated
  entirely through concurrent CLI scenarios.
- **Plan B — dataset-aware query core**: `source: tasks`,
  `RowData.subject`, `BaseRow.row_id`/`TaskDto`, null semantics, formulas,
  filtering/sorting/grouping/paging, default limit, DTO/browser repair
  contract. Demonstrated through `oximemo base` JSON on a hand-written
  `.query`; no frontend adapter is silently assumed.
- **Plan C — all view adapters and editor**: `BaseDisplayRow` cutover across
  tasks/table/board/list/cards/query embeds, task cell mutation, icon catalog
  and preview transforms, CM6 checkbox/field widgets, desktop transform
  command + browser fixture mirror, edit popover, auto-suggest.
- **Plan D — slash commands**: general six-group completion system, ranking,
  format/filter-aware task insertion, IME and Markdown-context guards.
- **Plan E — daily and installed surface**: guarded template query,
  local-midnight refresh, `⌘⇧T`, receipt-backed rollover/undo, one-shot
  installed `할 일.query`, palette entries.

Dependencies: A → B → C. D depends on C's draft-transform/decoration surface.
E depends on A's move/add primitives, B's query source, and C's task views.
Each completed plan has the standalone demonstration named above.

## Prior art references

- Obsidian Tasks v8.4.0 — emoji format, dataview format, statuses,
  recurrence, Edit Task modal, Auto-Suggest, global filter:
  <https://publish.obsidian.md/tasks/Reference/Task+Formats/Tasks+Emoji+Format>,
  <https://publish.obsidian.md/tasks/Getting+Started/Statuses>,
  <https://publish.obsidian.md/tasks/Getting+Started/Recurring+Tasks>,
  <https://publish.obsidian.md/tasks/Editing/Auto-Suggest>
- Logseq — marker workflow, `SCHEDULED:`/`DEADLINE:`, repeaters, slash
  command registry and journal default queries:
  <https://docs.logseq.com/#/page/Tasks>,
  <https://docs.logseq.com/#/page/Commands>,
  `logseq/src/main/frontend/commands.cljs:195-365,558-577`,
  `logseq/src/main/frontend/state.cljs:427-451`
- Obsidian core Slash Commands — trigger and dismiss rules:
  <https://help.obsidian.md/plugins/slash-commands>
- Dataview — implicit task fields as a DTO model:
  <https://blacksmithgu.github.io/obsidian-dataview/annotation/metadata-tasks/>
- Pitfalls that shaped this design: obsidian-tasks #3492 / #697
  (whole-vault scanning), #1289 / #2785 / #3395 (timezone and rollover),
  #606 / #2273 (emoji parsing), logseq #11260 / #3823 (repeater
  semantics).
