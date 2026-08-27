# Tasks (할 일) — Design

Date: 2026-08-27 · Status: proposed (brainstorm 2026-08-27) · awaiting user
review · Prior art verified against obsidian-tasks v8.4.0, logseq master
(2026-08-26), obsidian-help master, Dataview docs

## Goal

Logseq-/Obsidian-Tasks-grade task management where **the markdown line is
the only source of truth**. A task is one GFM checklist line in any note;
there is no separate task store. Aggregation, scheduling views, and
daily-note composition ride the shipped query engine (`source: tasks`).
Tasks are created and edited three ways with identical results: typing
markdown, GUI (checkbox click / edit popover / slash command), and agents
(`oximemo task` CLI). The UI never displays an emoji — every field renders
as a lucide icon with a localized date chip.

## Decisions (from brainstorm)

| Question | Decision |
|---|---|
| Source of truth | Inline GFM checkbox lines in note bodies. No separate task space, no per-task note. |
| Wire format | Obsidian Tasks **emoji** format is canonical; `[due:: …]` dataview format is read-compatible. One write format per vault (`[tasks] write_format`, default `emoji`). |
| UI presentation | **No emoji anywhere in the UI.** lucide icons + localized relative date chips, one icon source shared by React surfaces and CM6 widget DOM. |
| Status model | Obsidian Tasks' `symbol → (name, next symbol, type)` table; 6 types. Unknown symbols degrade to `TODO`. |
| Logseq marker words (`TODO`/`DOING`), org `SCHEDULED:`/`DEADLINE:`, `:LOGBOOK:` | Rejected — not GFM, bound to outline blocks, doubles file churn. The scheduled/start/due *semantics* are adopted through emoji fields. |
| Index | `IndexRecord.tasks: Vec<TaskRow>` — zero new redb tables; rides existing upsert/watcher/snapshot-generation/result-cache machinery. |
| Query | `.query` gains `source: notes \| tasks`; `RowData::Task` variant; new view type `tasks`. |
| Mutation unit | Optimistic single-line patch keyed `(memo_id, line, expected_hash)`. |
| Daily notes | Template section + `this.file.name`-scoped query fence; manual rollover command; recurring tasks belong in a dedicated note. |
| Agent surface | `oximemo task` CLI + `skills/oximemo/SKILL.md`. Not IPC — the app never applies agent output (`copilot.rs:447-500`, `lib.rs:2066`). |
| Slash commands | General editor command system; tasks are one group. |
| Reminders/notifications | Out of scope v1 — no notification plugin, no scheduler (`apps/desktop/src-tauri/Cargo.toml:22-38`, `capabilities/default.json`). |
| Browser fallback (`tauri.ts`) | Task queries are desktop-only (a second parser is not acceptable). Editor checkbox toggle and slash commands are pure frontend and work everywhere. |

## §1 Wire format

A task is a markdown list item whose content starts with a checkbox:

```md
- [ ] 우유 사기 #장보기 🛫 2026-08-28 ⏳ 2026-08-29 📅 2026-08-30 ⏫ 🔁 every week when done
- [/] 스펙 초안 쓰는 중 📅 2026-08-27
- [x] redb 벤치 돌리기 ✅ 2026-08-27
- [-] 취소된 것 ❌ 2026-08-27
```

- List markers `-`, `*`, `+`. Leading indentation is allowed; an indented
  task records its nearest shallower task as `parent`.
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
- Invalid dates are kept as `invalid_dates: true` rather than dropped, so a
  typo surfaces in the UI instead of silently disappearing (Tasks'
  `due date is invalid` filter is the precedent).
- Description = the line minus checkbox, minus recognized fields, minus
  trailing inline tags. Inline `#tags` are scanned with the existing
  `crates/oximemo-core/src/tags.rs` scanner so task tags and note tags
  normalize identically.
- Parser tolerances (each is a documented upstream footgun): a `\u00A0`
  (NBSP) between an emoji and its date is accepted (obsidian-tasks #606);
  `\uFE0F` variation selectors are stripped before symbol matching (#2273);
  multiple spaces collapse; unknown emoji are left verbatim in the
  description and never swallowed.
- `write_format` (`emoji` | `dataview`) picks the serialization for every
  app-initiated write. Reading always accepts both, so an imported vault
  works before the setting is touched.

### Why emoji on disk, icons on screen

Emoji fields are the interop standard actually read by Obsidian Tasks,
Dataview, and downstream exporters, they keep every task on one line
(single-line rewrite = the sync-safest mutation), and they are greppable.
Meanwhile no user of this app should have to look at, or type, an emoji:
§7.0 renders every field as an icon chip, §7.2/§7.3/§8 insert fields
without typing them. The one exposure that remains by design is
live-preview raw text when the caret enters the line — that is deliberate
so the line stays hand-editable and hand-deletable. A vault that wants
zero emoji on disk sets `write_format = "dataview"`; the rendered chips are
byte-identical either way.

## §2 Status model

`[tasks.statuses]` is a table of `symbol → (name, next, type)`; defaults:

| Symbol | Name (ko) | Next | Type |
|---|---|---|---|
| `` (space) | 할 일 | `x` | `TODO` |
| `/` | 진행 중 | `x` | `IN_PROGRESS` |
| `x` | 완료 | (space) | `DONE` |
| `-` | 취소 | (space) | `CANCELLED` |

- Types: `TODO`, `IN_PROGRESS`, `ON_HOLD`, `DONE`, `CANCELLED`, `NON_TASK`.
  `done` = `DONE ∪ CANCELLED`; `not done` = `TODO ∪ IN_PROGRESS ∪ ON_HOLD`.
- Unknown symbol → `{ name: "Unknown", next: 'x', type: TODO }`. A vault
  using a theme's extended symbols (`[>]`, `[?]`, …) therefore still
  produces usable rows instead of parse errors.
- Type transitions, applied by `patch_task` (§5), never by the parser:
  - entering `DONE` → stamp `done = today`, spawn the recurrence line (§6)
  - leaving `DONE` → clear `done`
  - entering `CANCELLED` → stamp `cancelled = today`
  - `NON_TASK` → never stamps dates, never recurs
- The table is config data, not code: the frontend reads it through
  `get_config` and mirrors the transition rules (§7.1). Hardcoding status
  semantics in TS is prohibited — Rust is the single definition.

## §3 Extraction and indexing

New module `crates/oximemo-core/src/tasks.rs`:

```rust
pub struct TaskRow {
    pub line: u32,              // 0-based body line index
    pub indent: u16,
    pub parent: Option<u32>,    // nearest shallower task line
    pub symbol: char,
    pub status_type: StatusType,
    pub text: String,           // description, fields stripped
    pub tags: Vec<String>,
    pub section: Option<String>,// nearest preceding heading
    pub created: Option<Date>, pub start: Option<Date>, pub scheduled: Option<Date>,
    pub due: Option<Date>, pub done: Option<Date>, pub cancelled: Option<Date>,
    pub priority: Priority,     // Highest..Lowest, default None
    pub recurrence: Option<String>,
    pub invalid_dates: bool,
    pub line_hash: u64,         // blake3-64 of the raw line, for optimistic patching
}

pub fn parse_tasks(body: &str, fmt: NoteFormat) -> Vec<TaskRow>;
pub fn render_task_line(row: &TaskRow, fmt: WriteFormat, indent: u16, marker: char) -> String;
```

`parse_tasks` is pure and property-tested (§13). Insertion points:

- `FileStore::read_memo` (`crates/oximemo-core/src/store/files.rs:271-303`)
  and `record_of` (`vault.rs:2853`) populate
  `IndexRecord.tasks: Vec<TaskRow>` (`store/index.rs:27-49`).
- Nothing else changes: `upsert`, `reindex_path` (`vault.rs:2346-2360`),
  the debounced watcher (`watcher.rs`, `config.rs:288-296`),
  `snapshot_with_gen`'s `(mtime, size)` generation (`vault.rs:1612-1653`),
  and the base result cache's `ResultKey.generation`
  (`base/cache.rs:152-175`) all pick tasks up for free. Per-file
  incremental reindex — the exact fix obsidian-tasks needed after #697 and
  still the cause of its 40k-vault startup complaints (#3492) — is
  inherited, not built.
- Excluded from extraction: `.html` notes (v1; body is not markdown),
  `TEMPLATE.md`/`TEMPLATE.html`, `.trash/`, `_assets/`.
- `MAX_TASKS_PER_NOTE = 1000`; the overflow is dropped with a warning so a
  pathological file cannot inflate one `IndexRecord` past the snapshot
  budget (`SNAPSHOT_CACHE_CAP` 50k records, `vault.rs:106`).
- `INDEX_FORMAT_VERSION` (`vault.rs:47-51`) is bumped so existing vaults
  reindex once through the normal `migrate()` path.
- Fenced code blocks are skipped: a ` ```md ` sample containing `- [ ]` is
  not a task. The parser tracks fence state while scanning lines.

## §4 Query engine — `source: tasks`

- `BaseDef` (`crates/oximemo-core/src/base.rs:26-39`) gains
  `source: BaseSourceKind` (`notes` default, `tasks`); an unknown value is a
  load-time error (`base.rs:262-330` validation path).
- `RowData` (`expr/eval.rs:77-107`) gains a task variant. This is the only
  engine seam: the whole `run_base` pipeline (`base/exec.rs:303`) — filter,
  formula closure, group-major stable sort, view limit, aggregates, paging —
  is dataset-agnostic above `RowData`.

  | Namespace | Resolves to |
  |---|---|
  | `task.*` | `status` (symbol), `type`, `text`, `tags`, `section`, `line`, `created`, `start`, `scheduled`, `due`, `done`, `cancelled`, `priority` (Num −2…2), `recurring` (Bool), `invalid` (Bool) |
  | `file.*` | the **parent note** — `path`, `folder`, `name`, `format`, `created`, `updated`, `favorite`, `tags` (unchanged semantics, `eval.rs:228-250`) |
  | `note.*` / bare | the parent note's frontmatter props, with the existing core-key fallback (`eval.rs:258-273`) |
  | `this.*` | unchanged embed scope (`exec.rs:423-468`) |

- `BaseRow` (`exec.rs:94-100`) gains `task: Option<TaskDto>`; `summary`
  keeps carrying the **parent note's** `MemoSummary`, so every existing
  consumer (TableView identity/freeze, BoardView titles, embed row labels,
  `normalizeSummaries`) keeps working untouched.
- New view type `tasks` added to `KNOWN_VIEW_TYPES` (`base.rs:222`) and the
  frontend `KNOWN_TYPES` dispatch (`BaseView.tsx:57`): a checkbox list
  renderer (group section → checkbox → description → field chips → note
  breadcrumb). `table`, `board`, `list`, `cards` also work over task rows.
  Board with `groupBy: task.type` is a kanban of task states, with drag
  committing a status change.
- Editable cells for task rows: `task.status` (checkbox), `task.due` /
  `task.scheduled` / `task.start` (date), `task.priority` (select),
  `task.text` (inline text). Everything under `file.*`, `note.*`, and
  `formula.*` stays read-only. Commits route to `patch_task` (§5) instead of
  `update_memo`; `tableModel.columnEditable` (`tableModel.ts:56-58`) and
  `TableView.commitCell` (`TableView.tsx:194-211`) gain a task branch.
- When `source: tasks` and a view declares no `limit`, the engine applies
  **200**. Task rows outnumber notes by an order of magnitude, and Tasks'
  own docs recommend capping at 100 for editor responsiveness.
- `Checked`/`Unchecked` summaries keep their current Bool-property meaning
  (`exec.rs:1007-1008`); task completion counts are expressed as
  `task.type == "DONE"` filters, not by redefining a shipped summary.

## §5 Mutation primitive

```rust
pub struct TaskRef { pub memo_id: MemoId, pub line: u32, pub expected_hash: Option<u64> }

pub enum DateField { Created, Start, Scheduled, Due, Done, Cancelled }

pub enum TaskEdit {
    Toggle,                                   // symbol -> its `next`
    SetStatus(char),
    SetDate { field: DateField, value: Option<Date> },
    SetPriority(Priority),
    SetText(String),
    SetRecurrence(Option<String>),
    Delete,
}

pub enum AddTarget { Note(MemoId), Daily(Date), Inbox }

impl Vault {
    pub fn patch_task(&self, r: TaskRef, e: TaskEdit, today: Date) -> Result<PatchTaskResult>;
    pub fn add_task(&self, t: AddTarget, text: String, f: TaskFields, today: Date)
        -> Result<PatchTaskResult>;
}

pub struct PatchTaskResult {
    pub note: NoteDto,
    pub tasks: Vec<TaskRow>,
    pub spawned: Option<TaskRow>,   // recurrence child, if any
}
```

- Procedure: read the body → verify `line`'s hash when `expected_hash` is
  supplied (mismatch → `CoreError::TaskConflict { line, found_hash }`) →
  rewrite **only that line** → insert the recurrence line when required →
  write the whole body through the existing `update_note_with`
  (`vault.rs:1128-1405`) so the atomic write, frontmatter preservation,
  `updated` bump, flock, and index upsert are all inherited
  (`oxi-frontmatter/src/write.rs:123-237`, `:408`).
- `today` is **supplied by the caller in local time**, exactly like
  `open_daily(date)` (`vault.rs:953`) — the backend never guesses a
  timezone. This is the structural fix for obsidian-tasks #3395 (completing
  a task at 00:30 recorded tomorrow) and #2785 (UTC day shift).
- `add_task` with `AddTarget::Daily` calls `open_daily` first (idempotent,
  adopts a hand-created file), then appends inside
  `[tasks] default_section` (creating the `## 할 일` heading when absent).
  `AddTarget::Inbox` resolves to `{inbox folder}/{default_section}.md`
  (the inbox folder is the one `create_capture` already uses,
  `vault.rs:933`), creating that note on first use. There is no
  free-form folder target: "which note in the folder" has no honest
  answer, and `Note`/`Daily`/`Inbox` cover every capture path in the app.
- `TaskEdit::Delete` removes the line; if it has indented children they are
  promoted, never orphaned into another task's subtree.
- `expected_hash: None` means "resolve against the current line" — a
  convenience for agents that just listed tasks; GUI callers always send the
  hash they rendered.

## §6 Recurrence

- Rule grammar (subset of Obsidian Tasks, which itself wraps RRULE):
  `every day|week|month|year`, `every N days|weeks|months|years`,
  `every weekday`, `every week on <weekday list>`, optional `when done`
  suffix. A rule must start with `every`.
- On entering `DONE`: the original line keeps `[x]` + `✅ today`; the next
  occurrence is written **one line above** by default
  (`recurrence_insert = "above" | "below"`).
- Reference date priority `due > scheduled > start`; `when done` anchors on
  the completion date instead. All present dates shift by the same delta so
  a start/due window is preserved.
- Month arithmetic reuses `expr::value::date_add`
  (`expr/value.rs:196-230`), which already applies calendar months first
  with end-of-month clamping (Jan 31 + 1M → Feb 28/29). **No RRULE crate is
  added.**
- A recurrence rule requires at least one of start/scheduled/due (Tasks
  5.0.0 rule): the GUI blocks it, the CLI rejects it, and a file that
  violates it parses with a warning flag rather than failing.
- Unsupported complex rules (`every 6 months on the 2nd Wednesday`) do not
  silently mis-fire: parsing fails, the task keeps its rule text verbatim,
  the UI shows a warning chip, and completion does not spawn a child.

## §7 GUI

### §7.0 Icon rendering layer (zero emoji in UI)

Single icon source: `lucide-react ^0.460.0` (`apps/desktop/package.json:30`),
already the only icon dependency.

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

Both paths share the same class names, so the icon set is defined once.

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
  Relative labels recompute on day rollover (obsidian-tasks #1289 is a
  stale-relative-date bug).
- **Card previews** (HTML string, no React): `markdownPreview.ts` gains
  `collapseTaskFields`, a sibling of `collapseQueryBlocks` /
  `collapseWikiLinks` (`markdownPreview.ts:89-99`, `:93-97`), replacing
  emoji field runs with the *same* `<span class="ox-task-*">` markup. The
  existing sanitizer is a FORBID-list (`:44-48`), so `span`/`class` pass.
  `previewText` strips fields entirely so no emoji leaks into list/timeline
  rows.
- Priority renders as an icon + tone only; no numeric badge.

### §7.1 Editor checkbox widget

- New `apps/desktop/src/lib/taskCheckboxes.ts`, factory
  `taskCheckboxExtension({ statuses, labels })`, mounted in the existing
  extension assembly (`MemoEditorForm.tsx:52-83`) which
  `MarkdownEditor.tsx:158-165` forwards to `AtomicCodeMirrorEditor`.
- Structure copied from `lib/embeds.ts`: line-scan → `Decoration.replace`
  over the `[x]` span and over each field run → `WidgetType` with `eq`,
  `toDOM`, `ignoreEvent() { return false }` (`embeds.ts:67-99`,
  `:102-124`) → `StateField` providing decorations with
  `value.decorations.map(tr.changes)` on non-doc changes (`:139-156`). The
  widget never fetches and never owns the view; the click handler is closed
  over the `EditorView` handle, mirroring
  `imageInsertionExtension` (`cm6Images.ts:108-115`).
- Click / `⌘⇧Enter` toggles by dispatching a `changes` transaction that
  rewrites the line; the existing 500 ms autosave
  (`MemoDetail.tsx:92-107`) persists it.
- **Required cutover:** `MemoDetail`'s save-and-close handler is
  `(e.metaKey || e.ctrlKey) && e.key === "Enter"` (`MemoDetail.tsx:129`)
  and does **not** exclude `shiftKey`, so `⌘⇧Enter` would close the dialog
  today. That handler must be narrowed to `&& !e.shiftKey` in the same task
  that adds the toggle keybinding. The CM6 keymap is registered under
  `Prec.highest` (the `imagePickerKeymap` precedent, `cm6Images.ts:142-152`)
  so it wins inside the editor, but the document-level listener still needs
  the guard.
- **In-editor edits are text transforms; out-of-editor edits are
  `patch_task`.** The editor holds an unsaved draft, so a disk-based patch
  would conflict with it. To keep one definition of the transition rules,
  the frontend reads the status table from `get_config` and applies it as
  data; `lib/taskLine.ts` holds the pure line rewriter shared by the widget,
  the popover, and the slash commands, and is unit-tested against fixtures
  generated from the Rust implementation.
- Caret inside a decorated range reveals the raw text (standard live-preview
  behavior), so a field can always be hand-edited or deleted.

### §7.2 Task edit popover

`⌘⇧E` on a task line, or right-click on the checkbox, opens a popover
(Base UI `Popover`, following `FolderCombobox.tsx`'s structure, z-`[60]`)
with: status select, priority select, start/scheduled/due date inputs,
recurrence text with live "다음: 9월 6일" preview, and the description.
Date inputs accept natural language in local time (`오늘`, `내일`,
`금요일`, `8-30`, `2026-08-30`). Save applies one `patch_task` (or one line
transform when the editor owns the buffer). Obsidian Tasks' Edit-Task modal
is the parity target; its access-key affordance is replaced by plain tab
order plus `⌘Enter` to commit.

### §7.3 Line auto-suggest

A CM6 `CompletionSource` that activates only on a recognized task line and
offers **only fields not already present** (Tasks' Auto-Suggest rule),
each rendered with its icon and a Korean label; selecting one inserts the
canonical field with a date picker default (`📅 오늘`). Being a completion
source rather than a keydown listener makes it IME-safe by construction —
the project's stated doctrine (`copilotMention.ts:4-7`).

### §7.4 Tasks surface

- Sidebar gains a `할 일` system entry (next to the existing system
  collections in `collectionCatalog.ts:88-91`) opening a **built-in
  `.query`** with `source: tasks` and views 오늘 / 예정 / 지연 / 전체. It is
  a real file, so users can duplicate and edit it — no hidden query.
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
- Trigger: `/` at line start or after whitespace (Logseq and Obsidian Slash
  Commands agree on this rule). Dismiss on `Esc` or `Space`; arrows +
  Enter to select. Never fires mid-word, never inside a fenced code block.
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
- Insertion always writes the canonical wire format while the menu shows
  only icons and Korean labels, so a user never types an emoji.

## §9 Daily-note composition

- The daily preset template (`schema.rs:514`) gains a `## 할 일` section
  followed by a query fence:

  ```query
  source: tasks
  filters:
    and:
      - 'task.type != "DONE" && task.type != "CANCELLED"'
      - 'task.due <= this.file.name || task.scheduled <= this.file.name'
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
  ⌘K palette): move the previous daily note's not-done task lines into
  today's `## 할 일`, delete them from the source, show a toast with an undo
  that reverses both edits. Never automatic — Logseq and Obsidian both keep
  this opt-in.
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
oximemo task done   <NOTE_ID> <LINE> [--hash H]
oximemo task status <NOTE_ID> <LINE> <SYMBOL> [--hash H]
oximemo task edit   <NOTE_ID> <LINE> [--set-due D|--clear-due] [--set-text T]
                    [--set-priority P] [--set-repeat R|--clear-repeat] [--hash H]
oximemo task rm     <NOTE_ID> <LINE> [--hash H]
```

- `--format json` emits exactly `TaskDto`, so `list → edit` pipes without a
  second schema. `--hash` enables strict optimistic locking; omitted, the
  core resolves against the current line.
- `SKILL.md` gains a task section documenting the addressing model
  (`NOTE_ID` + `LINE`), the `today` semantics, and the daily-note rollover
  command. Nothing is added to `build_context` — task counts would be cost
  and noise on every turn.
- Tauri mirrors for the GUI: `list_tasks(req)`, `patch_task(ref, edit, today)`,
  `add_task(target, text, fields, today)`, registered in the
  `generate_handler!` list (`lib.rs:254-321`).
- Wire-DTO discipline: every new DTO serializes identically in Rust and in
  the browser fallback, with UI-derived fields kept in a separate repair
  layer — the rule established by the v0.10.0 crash
  (`lib/summaryFolder.ts:1-15` and its test).

## §11 Configuration

```toml
[tasks]
enabled = true
write_format = "emoji"        # emoji | dataview
global_filter = ""            # "" = every checkbox is a task; e.g. "#task" to narrow
                              # when set: only lines containing it are tasks, and the
                              # matched text is stripped from the rendered description
recurrence_insert = "above"   # above | below
default_section = "할 일"      # section add_task appends to (created if missing)
capture_target = "daily"      # daily | inbox — target of ⌘⇧T and the capture overlay

[[tasks.statuses]]
symbol = " "
name = "할 일"
next = "x"
type = "TODO"
# … one block per status; defaults per §2 when the section is absent
```

`enabled = false` hides every task surface (sidebar entry, slash group,
editor widget) and skips extraction, matching the `[daily]`/`[brain]`
pattern. `global_filter` defaults empty, like Obsidian Tasks.

## §12 i18n

New keys in both `locales/ko.ts` (source) and `locales/en.ts` (typed
mirror): `tasks_section`, `task_new`, `task_edit`, `task_delete`,
`task_status`, `task_priority_{highest,high,medium,low,lowest,none}`,
`task_field_{created,start,scheduled,due,done,cancelled}`,
`task_recurrence`, `task_recurrence_next`, `task_recurrence_needs_date`,
`task_invalid_date`, `task_conflict_reload`, `task_group_{overdue,today,
tomorrow,this_week,later,no_date}`, `task_rollover`, `task_rollover_done`,
`task_rollover_none`, `task_daily_recurrence_warning`,
`view_tasks`, `slash_group_{task,date,format,link,query,template}`, plus
one label per slash command. Relative date labels come from
`relativeDayLabel` + `Intl`, never from hardcoded strings. Widget labels
are passed in at mount, following `EmbedLabels`/`QueryEmbedLabels`
(`embeds.ts:34-38`, `queryEmbeds.ts:31-37`).

## §13 Testing

**Rust unit (`tasks.rs`)** — emoji and dataview parsing; NBSP and variation
selectors; invalid dates flagged not dropped; nesting/`parent`; `section`
from headings; fenced-code skipping; per-note cap; unknown symbol
degradation; status transition table; `render_task_line` for both write
formats.

**Rust property (`proptest`, already a dev-dependency)** — parse →
render → parse is idempotent for arbitrary generated task lines, and
rendering never loses the description or unknown emoji.

**Rust recurrence** — `every N units`, `every weekday`, `every week on …`,
`when done`, month-end clamping (Jan 31 → Feb 28/29), reference-date
priority, rejection of a rule with no date, unsupported rule → no spawn.

**Rust integration (`tmp_vault()` fixture)** — `patch_task` hash mismatch →
`TaskConflict`; toggle stamps `✅` with the caller's local date; recurrence
inserts above and leaves other lines byte-identical; `Delete` promotes
children; `add_task` creates the section, and `AddTarget::Daily` adopts an
existing file; extraction survives a watcher-driven external edit;
`run_base` with `source: tasks` (filters, `groupBy`, group-major paging,
`this.file.name` scoping, view-limit default of 200); a task toggle bumps
the generation so a cached result is not reused.

**CLI** — `task add → list --format json → edit → done` round-trip; strict
`--hash` failure path; `list --not-done` matches `not done` semantics.

**Frontend (`bun test`)** — `taskLine.ts` rewriter against Rust-generated
fixtures; the TS status mirror equals the config table; `relativeDayLabel`
across overdue/today/tomorrow/far and locale switch; slash trigger
conditions (line start, after space, not mid-word, not in fence) and
ranking; auto-suggest excludes present fields; `collapseTaskFields`
produces chip markup and leaves **no emoji** in preview HTML or
`previewText` (asserted by regex over the emoji field set).

**Manual E2E (Tauri)** — editor toggle reaches disk and the tasks view;
caret-in-line reveals raw text and leaving it restores chips; daily query
fence renders the day's tasks; rollover moves lines and undo restores both
notes; Korean IME composition never triggers the slash menu on `/`; icon
chips have adequate contrast in dark and light themes.

## §14 Non-goals (v1)

- OS notifications and due reminders — no notification plugin, no
  scheduler, no background tick exists today; a separate spec must add the
  plugin, capability, and a tick source.
- Task dependencies (`🆔` / `⛔`) and `🏁 onCompletion` — needs vault-wide
  id uniqueness; parsed and preserved verbatim, not interpreted.
- `:LOGBOOK:` / clock entries / time tracking.
- Urgency scoring and `sort by urgency`.
- Tasks inside `.html` notes.
- Browser-fallback task queries (a second parser is not acceptable); the
  editor widget and slash commands do work in browser mode.
- Obsidian Tasks' English sentence DSL (`due before tomorrow`). The `expr`
  engine is the query language; sentence sugar can be layered later.
- Per-line block ids / `^block-ref` anchors for tasks.
- Due-date heatmap on the sidebar calendar.

## Implementation plans

Five plans, each independently demonstrable:

- **Plan A — core**: `tasks.rs` parser + `render_task_line`,
  `IndexRecord.tasks`, `INDEX_FORMAT_VERSION` bump, `[tasks]` config,
  `patch_task`/`add_task`, `oximemo task` CLI, `SKILL.md`. Demonstrated
  entirely through the CLI.
- **Plan B — query source**: `source: tasks`, `RowData` task variant,
  `BaseRow.task`, `tasks` view type, task-row cell editing, default limit.
  Demonstrated with a hand-written `.query`.
- **Plan C — editor**: icon chip layer (`app.css` masks +
  `TaskFieldChip`/`TaskCheckbox`), `taskCheckboxes.ts` widget,
  `taskLine.ts`, edit popover, line auto-suggest.
- **Plan D — slash commands**: general `slashCommands.ts` system with all
  six groups, ranking reuse, IME and fence guards.
- **Plan E — daily + surface**: template section and query fence, `⌘⇧T`
  quick add, rollover with undo, sidebar `할 일` system query, palette
  entries.

Plan A is a prerequisite for B–E. C and D are independent of each other; E
depends on B (query fence) and A (add_task).

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
