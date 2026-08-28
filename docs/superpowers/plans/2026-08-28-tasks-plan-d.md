# Tasks Plan D — Slash Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A general CM6 slash-command system in the editor (`/` → icon+label+hint menu) with six v1 groups — 할 일, 날짜, 서식, 링크, 쿼리, 템플릿 — whose task group inserts format-aware task metadata that the Plan C widgets decorate immediately.

**Architecture:** One `CompletionSource` over the already-direct `@codemirror/autocomplete` dependency with a custom per-option `render` (icon + label + hint). Ranking is REUSED verbatim from `paletteCommands.ts` (`matchScore`, `rankCommands`, `RecencyLog`) with a separate localStorage key; the command CATALOG is forked (palette commands close over navigation, editor commands close over an `EditorView`). Every `apply(view, range)` is a pure text insertion or line transform — the task group's transforms reuse Plan C's `lib/taskLine.ts` splicing so there is exactly one task-line writer.

**Tech Stack:** CodeMirror 6 (`@codemirror/autocomplete` ^6.20.3, `@codemirror/view`/`state`), lucide-react icons via plain-DOM rendering inside the completion widget, `bun test`. No new dependencies.

## Global Constraints

- Governing spec: `docs/superpowers/specs/2026-08-27-tasks-design.md` §8 (all bullets) + §12 (`slash_group_{task,date,format,link,query,template}` and one label per command) + §13 Frontend bullet ("slash triggers including inline/fenced code guards").
- Trigger contract (§8, verbatim): `/` at line start or after whitespace; dismiss on `Esc` or `Space`; arrows + Enter select; never fires mid-word, inside fenced or indented code, or inside an inline-code span.
- Ranking functions are imported from `lib/paletteCommands.ts`, never copied: `matchScore` (`paletteCommands.ts:225-249`), `rankCommands` (`:322-337`), `RecencyLog` (`:301-318`). Recency persists under a NEW key `oximemo.editorSlashRecency` (palette's is `oximemo.paletteRecency`, `CommandPalette.tsx:47`).
- Command shape (§8): `{ id, group, label, hint, icon, apply(view: EditorView, range: { from: number; to: number }) }`.
- Task-group insertions resolve `write_format`, `global_filter`, and the current local date from injected deps (`TaskLineCfg` + `todayLocalISO()`) — the extension never reads config itself.
- Generated task metadata is immediately decorated (Plan C's widget rebuild rides the doc change); menus render icons + localized labels ONLY — no serialized `오늘` (dates serialize as local ISO in cfg format).
- IME doctrine: completion activation gated on `view.composing === false`, re-evaluated on composition end (mirror `lib/taskSuggest.ts`'s guard from Plan C Task 10).
- i18n keys land in `locales/ko.ts` + typed `locales/en.ts` in the same task that first shows them.
- `cd apps/desktop && bun test` green after every task; no Rust changes in this plan.

## File Structure

- Create: `lib/slashCommands.ts` (catalog + types), `lib/slashExtension.ts` (CM6 wiring: CompletionSource, render, keymap interplay), `lib/slashTrigger.ts` (pure trigger/guard predicates), `lib/slashInsertions.ts` (pure insertion-text builders for every non-task group), tests `slashTrigger.test.ts`, `slashInsertions.test.ts`, `slashCommands.test.ts`
- Modify: `components/MemoEditorForm.tsx` (mount `slashExtension(deps)` in the extension assembly), `lib/locales/{ko,en}.ts`
- Task-group transforms import from `lib/taskLine.ts` (Plan C Task 1).

---

### Task 1: Trigger/guard predicates + ranking integration

**Files:** Create `lib/slashTrigger.ts`, `lib/slashTrigger.test.ts`; Modify nothing else yet.

**Interfaces:**
- `slashTriggerAt(doc: string, pos: number): { from: number; query: string } | null` — active iff: pos is after a `/` that sits at line start or after whitespace; the text from that `/`+1 to pos contains no whitespace; the `/` is not mid-word (char before it is start-of-line/whitespace); pos is NOT inside a fenced code block (``` or ~~, CommonMark fence scan), an indented-code line (≥4 columns leading whitespace with no preceding paragraph in-block context — approximate with the existing `lib/taskCheckboxes.ts` fence scanner from Plan C), or an inline-code span (backtick scan on the line).
- `slashCommands.ts` types: `SlashCommand`, `SlashDeps = { cfg: TaskLineCfg; locale: "ko" | "en"; recency: RecencyLog }`.
- `rankSlashCommands(cmds: SlashCommand[], query: string, recency: RecencyLog): SlashCommand[]` — thin wrapper over `rankCommands` + `matchScore` (adapt via a shared minimal shape; if `rankCommands`' parameter type differs, map fields, do NOT fork the algorithm).

- [ ] **Step 1:** failing `slashTrigger.test.ts` — cases: line-start `/할`, after-space `할 일 /마감`, mid-word `abc/def` → null, fenced block → null, indented code → null, inline code `` `​/code`​ `` → null, `/` followed by space then text → null (dismissed), query spanning newline → null, CRLF lines.
- [ ] **Step 2:** implement (fence/inline scans imported or re-exported from taskCheckboxes' helpers — one implementation, reused). `bun test slashTrigger` green. Commit `feat(editor): slash trigger predicates with code-context guards`.

### Task 2: Insertion builders for 날짜/서식/링크/쿼리/템플릿 groups

**Files:** Create `lib/slashInsertions.ts`, `lib/slashInsertions.test.ts`.

**Interfaces:** Pure builders returning the exact text a command inserts (line-prefix-aware — they receive the current line's indentation and apply it to every inserted line):
- 날짜: 오늘/내일/어제 → local ISO via `dates.ts`; 현재 시각 → local `HH:mm`.
- 서식: 제목 1-3 (`# `…), 표 (a 2×2 `| | |` skeleton with alignment row), 코드 블록 (fenced ```` ``` ```` pair, language placeholder `ts`? — no placeholder text per repo taste: bare fence), 인용 (`> `), 구분선 (`---`).
- 링크: 메모 링크 `[[|]]` (caret inside braces), 메모 임베드 `![[|]]`, 이미지 `![[|.png]]` — matching the existing wiki-link grammar used by `lib/wikiLinks`-equivalent extension (verify the app's actual link syntax in `AtomicCodeMirrorEditor` usage and mirror it exactly).
- 쿼리: 쿼리 블록 (```query fence with `views:\n  - type: table` minimal stub), 오늘의 할 일 블록 — the §9 daily fence verbatim:
  ````
  ```query
  source: tasks
  filters:
    and:
      - 'task.type != "DONE" && task.type != "CANCELLED"'
      - '(task.due != null && task.due <= this.file.name) || (task.scheduled != null && task.scheduled <= this.file.name)'
  views:
    - { type: tasks, name: 오늘 }
  ```
  ````
  (Bare-string filter grammar respected: the `and:` grouped map with a sequence value is the spec §1 form.)
- 템플릿: 폴더 템플릿 삽입 → inserts the active folder's `TEMPLATE.md` body (deps inject a `templateBody(): string | null`; null → command hidden from the menu).
- [ ] **Step 1:** failing tests — every builder's exact output, indentation propagation, fence escaping (a template body containing ``` is not broken: builder wraps in a longer fence).
- [ ] **Step 2:** implement; green; commit `feat(editor): slash insertion builders for date/format/link/query/template`.

### Task 3: Catalog + CompletionSource + custom render + mount

**Files:** Create `lib/slashCommands.ts` (catalog: 24 v1 commands across the six groups with lucide icon components + `slash_group_*` + per-command labels in both locales), `lib/slashExtension.ts`; Modify `components/MemoEditorForm.tsx`.

**Interfaces:**
- `slashExtension(deps: SlashDeps & { onPick?: (id: string) => void })` → `autocompletion({ override: [source], icons: false, activateOnTyping: true })` with `source` building options via `slashTriggerAt` + `rankSlashCommands`; each option's `render` creates plain DOM: lucide icon (SVG imported as component, rendered via `renderToStaticMarkup`? NO — plain DOM: import the icon's SVG node via `lucide-react`'s underlying `createElement` is React-only; use the icon's raw SVG path from `lib/taskIcons.ts` masks — one catalog, two mechanisms, same visual) + label + hint.
- Option `apply(view, range)` deletes the `/query` range and inserts the builder text at a line-appropriate position; task-group commands first check `parseTaskLine` — on a task line they APPEND the field token (via `taskLine` splice helpers), off a task line the 할 일/진행 중 commands promote/insert `- [ ] `/`- [/] ` + `global_filter`.
- 할 일 group date commands (마감일/예정일/시작일) offer 오늘/내일 sub-options writing cfg-format tokens; 우선순위 offers the 5 levels with icons; 반복 inserts `every `… skeleton? NO skeletons per no-placeholder taste: 반복 opens nothing in v1 — it inserts `🔁 every day` default? Spec lists 반복 as a command; the popover (Plan C) is the editor for rules. Decision: 반복 command inserts `🔁 every week` (most common default) and immediately shows the popover is out of scope — document choice in code comment.
- Recency recorded per command id in `oximemo.editorSlashRecency`.
- [ ] **Step 1:** failing `slashCommands.test.ts` — catalog completeness (24 commands, six groups, every id unique, every label key exists in both locales), apply-on-task-line vs off-line behavior for the task group, ranking order with recency boost.
- [ ] **Step 2:** implement + mount in `MemoEditorForm` extension array (before taskSuggest so both can coexist — different triggers). Full `bun test` green. Manual check via `bun run dev` browser mode (editor works in browser per non-goals note). Commit `feat(editor): slash command menu with six v1 groups`.

## Plan D Definition of Done

- `bun test` green (slashTrigger/slashInsertions/slashCommands suites).
- Manual E2E (browser mode suffices — editor features work there): `/할` filters the task group; Enter inserts a decorated task; `/마감` on a task line appends a cfg-format date token; `/` inside fenced/inline code never opens the menu; Space/Esc dismisses; Korean IME composition does not open or corrupt the menu; recency reorders after picks (persisted under the new key); `/오늘의 할 일` inserts the exact §9 fence and the query embed renders (desktop) or is inert (browser).
- No changes outside `apps/desktop/src/lib/*`, `components/MemoEditorForm.tsx`, and the two locale files.
