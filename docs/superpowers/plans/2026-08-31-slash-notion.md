# Slash Menu v2 (Notion-Style) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bare `/` immediately opens the slash menu with the full catalog, presented as a Notion-style floating panel (group headers, icon boxes, two-line rows).

**Architecture:** Keep the v1 pure core (catalog/rank/patch/insertions); change only the trigger gate (one line in the CM6 source), the empty-query ranking semantics (one guard), and the presentation (app.css block targeting CM6's autocomplete tooltip). No React surface — CM6 native, IME gates untouched.

**Tech Stack:** TypeScript + CodeMirror 6 autocompletion 6.20.3, bun (`bun:test`), Vite, Tauri.

**Spec:** `docs/superpowers/specs/2026-08-31-slash-notion-design.md`

## Global Constraints

- Tests: `bun test` (bun:test imports), run from `apps/desktop/`.
- Type gate: `cd apps/desktop && bunx tsc -b`.
- Conventional commits (English), file-unit `git add` only — parallel sessions share this working tree; always `git status --short` immediately before staging and re-check the staged diff matches the intended files.
- `/Volumes/MERCURY` EPERM transients: mass instant test failures → re-run twice before diagnosing.
- IME doctrine: never fire mid-composition (`context.view?.composing` gate stays).
- CSS uses existing design tokens only (`--color-*`, `--radius-*`, `--shadow-*`); selectors scoped under `.cm-tooltip-autocomplete`.
- No new npm dependencies.
- The shared palette `rankCommands` (paletteCommands.ts:336 "Empty query → []") is a palette contract — NOT modified; the empty-query change lives in `rankSlashCommands` only.

---

### Task 1: `rankSlashCommands` — empty query returns the full catalog

**Files:**
- Modify: `apps/desktop/src/lib/slashCommands.ts:100-121` (function + doc comment)
- Test: `apps/desktop/src/lib/slashCommands.test.ts`

**Interfaces:**
- Consumes: `buildSlashCatalog(deps: SlashDeps): SlashCatalogEntry[]`, `rankSlashCommands<C extends SlashCommand>(commands: C[], query: string, recency: RecencyLog): C[]` (existing signatures, unchanged).
- Produces: `rankSlashCommands` with new contract — `query === ""` (or whitespace-only) returns ALL commands in curated `order`; typed queries unchanged.

- [ ] **Step 1: Write the failing tests**

Append to the describe block in `slashCommands.test.ts` (reuse the file's existing deps-builder; if it has none, construct inline exactly like this):

```ts
import { RecencyLog } from "./paletteCommands";
import { buildSlashCatalog, rankSlashCommands, type SlashDeps } from "./slashCommands";

const bareDeps: SlashDeps = { cfg: null, locale: "ko", recency: new RecencyLog() };

test("empty query — the full catalog in curated order (bare '/' opens the menu)", () => {
  const catalog = buildSlashCatalog(bareDeps);
  const ranked = rankSlashCommands(catalog, "", bareDeps.recency);
  expect(ranked).toEqual(catalog);
});

test("empty query ignores recency — curated order is stable", () => {
  const catalog = buildSlashCatalog(bareDeps);
  const recency = new RecencyLog();
  recency.record("slash.rule");
  const ranked = rankSlashCommands(catalog, "", recency);
  expect(ranked.map((c) => c.id)).toEqual(catalog.map((c) => c.id));
});

test("whitespace-only query behaves like empty", () => {
  const catalog = buildSlashCatalog(bareDeps);
  expect(rankSlashCommands(catalog, "  ", bareDeps.recency)).toEqual(catalog);
});
```

(If the file already imports these symbols or already has a deps helper, reuse them; the three tests themselves go in verbatim.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/desktop && bun test src/lib/slashCommands.test.ts`
Expected: the three new tests FAIL (empty query currently returns `[]`).

- [ ] **Step 3: Implement the guard**

In `rankSlashCommands` (slashCommands.ts:105), insert after the opening brace, and update the doc comment line "Empty query → [] (the menu opens on the first query character)." to "Empty query → the full catalog in curated order (the bare `/` opens the menu; recency applies only to typed queries).":

```ts
  // v2 (slash-notion spec): a bare '/' opens the menu — the empty
  // query IS the whole catalog in curated order. Recency ranks typed
  // queries only, so the open state is deterministic. Copy, never
  // mutate the caller's array.
  if (!query.trim()) return [...commands];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/desktop && bun test src/lib/slashCommands.test.ts`
Expected: PASS (including all pre-existing tests).

- [ ] **Step 5: Commit**

```bash
git status --short
git add apps/desktop/src/lib/slashCommands.ts apps/desktop/src/lib/slashCommands.test.ts
git commit -m "feat(slash): empty query ranks the full catalog — bare '/' opens the menu"
```

---

### Task 2: `slashCompletionSource` — bare `/` arms the menu

**Files:**
- Modify: `apps/desktop/src/lib/slashExtension.ts:91-116` (source gate + doc comments)

**Interfaces:**
- Consumes: `slashTriggerAt(doc, pos): SlashTrigger | null` — already returns `{ from, query: "" }` for a bare `/` (covered by slashTrigger.test.ts:25).
- Produces: the source returns a `CompletionResult` for a bare `/` (from = the `/` offset, `to = context.pos`, `filter: false`). Consumers: the merged `taskSuggestExtension` override via `extraSources`, and the standalone `slashExtension` mount.

- [ ] **Step 1: Remove the gate**

In `slashCompletionSource`'s returned closure, change:

```ts
    const trigger = slashTriggerAt(doc, context.pos);
    if (!trigger) return null;
```

(deleting `|| trigger.query === ""`).

- [ ] **Step 2: Update the stale doc comments**

- Module header (slashExtension.ts:4-9): replace "word-start '/', no whitespace in the query" with "word-start '/', including the bare `/` with an empty query".
- Source doc (slashExtension.ts:91-94): replace "a bare '/' arms nothing (the menu opens on the first query character) and a space inside the query disarms it" with "the bare `/` opens the menu (full catalog, spec 2026-08-31-slash-notion-design) and a space inside the query disarms it".
- Also fix the matching stale comment in slashCommands.ts above `rankSlashCommands` if Task 1 left any "first query character" wording.

- [ ] **Step 3: Type gate**

Run: `cd apps/desktop && bunx tsc -b`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git status --short
git add apps/desktop/src/lib/slashExtension.ts apps/desktop/src/lib/slashCommands.ts
git commit -m "feat(slash): source arms on bare '/' — immediate menu open"
```

---

### Task 3: app.css — Notion-style completion tooltip

**Files:**
- Modify: `apps/desktop/src/app.css` (append one scoped section at end of file)

**Interfaces:**
- Consumes: CM6 6.20.3 tooltip DOM — `.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]`, spans `.cm-completionLabel`/`.cm-completionDetail`, custom element `completion-section` (section headers, `document.createElement("completion-section")` in the dist), row glyphs = inline `<svg>` from `completionIconRenderer`.
- Produces: styled tooltip shared by ALL completion surfaces in the editor (slash, task-field, wiki `[[`) — intended consistency.

- [ ] **Step 1: Append the CSS block**

```css
/* --- Slash menu v2: Notion-style completion tooltip --------------------- */
/* Spec: docs/superpowers/specs/2026-08-31-slash-notion-design.md. Scoped to
   the CM6 autocomplete tooltip so no other surface is touched. Section
   headers are CM6's `completion-section` custom element; rows are a 2-col
   grid — icon box (col 1) with label + description stacked (col 2). */
.cm-tooltip.cm-tooltip-autocomplete {
  border: 1px solid var(--color-line);
  border-radius: var(--radius-lg);
  background: var(--color-surface-raised);
  box-shadow: var(--shadow-lg);
  padding: 6px;
}
.cm-tooltip-autocomplete > ul {
  max-height: 336px;
  min-width: 280px;
  overflow-y: auto;
  padding: 0;
  font-family: inherit;
}
.cm-tooltip-autocomplete > ul > li {
  display: grid;
  grid-template-columns: auto 1fr;
  column-gap: 10px;
  align-items: center;
  padding: 5px 10px;
  border-radius: var(--radius-md);
  line-height: 1.25;
  cursor: default;
}
.cm-tooltip-autocomplete > ul > li[aria-selected="true"],
.cm-tooltip-autocomplete > ul > li:hover {
  background: var(--color-surface-muted);
}
.cm-tooltip-autocomplete completion-section {
  display: block;
  padding: 8px 10px 3px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--color-text-subtle);
  user-select: none;
}
.cm-tooltip-autocomplete > ul > li > svg {
  box-sizing: border-box;
  width: 22px;
  height: 22px;
  padding: 4px;
  background: var(--color-surface-muted);
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
}
.cm-tooltip-autocomplete .cm-completionLabel {
  grid-column: 2;
  font-size: 14px;
  color: var(--color-text);
}
.cm-tooltip-autocomplete .cm-completionDetail {
  grid-column: 2;
  display: block;
  font-size: 12px;
  font-style: normal;
  color: var(--color-text-subtle);
}
```

- [ ] **Step 2: Build gate**

Run: `cd apps/desktop && bunx vite build`
Expected: clean build (CSS is passthrough).

- [ ] **Step 3: Commit**

```bash
git status --short
git add apps/desktop/src/app.css
git commit -m "feat(slash): Notion-style completion tooltip presentation"
```

---

### Task 4: Visual harness + browser verification

**Files:**
- Create: `apps/desktop/harness/slash.html`
- Create: `apps/desktop/harness/slash-main.ts`

**Interfaces:**
- Consumes: `slashExtension(deps)` (standalone mount — mounts its own `autocompletion`), `cfgFromJson(json: WireTaskLineCfg): TaskLineCfg` with wire shape `{ write_format: "emoji" | "dataview", global_filter: string, recurrence_insert: "above" | "below", statuses: { symbol: string; type: string; next: string }[] }` (type values UPPERCASE: TODO / IN_PROGRESS / DONE), `RecencyLog`, app.css tokens.
- Produces: a permanent dev harness served by the existing Vite dev server at `/harness/slash.html` — no app-code imports reversed, nothing in the bundled app references it.

- [ ] **Step 1: Write the harness**

`apps/desktop/harness/slash.html`:

```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <title>slash menu harness</title>
  </head>
  <body>
    <div id="editor"></div>
    <script type="module" src="./slash-main.ts"></script>
  </body>
</html>
```

`apps/desktop/harness/slash-main.ts`:

```ts
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { RecencyLog } from "../src/lib/paletteCommands";
import { slashExtension } from "../src/lib/slashExtension";
import { cfgFromJson } from "../src/lib/taskLine";
import "../src/app.css";

const cfg = cfgFromJson({
  write_format: "emoji",
  global_filter: "",
  recurrence_insert: "below",
  statuses: [
    { symbol: " ", type: "TODO", next: "IN_PROGRESS" },
    { symbol: ">", type: "IN_PROGRESS", next: "DONE" },
    { symbol: "x", type: "DONE", next: "CANCELLED" },
  ],
});

new EditorView({
  parent: document.getElementById("editor")!,
  state: EditorState.create({
    doc: "메모\n\n",
    extensions: [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      ...slashExtension({
        cfg,
        locale: "ko",
        recency: new RecencyLog(),
        templateBody: () => "# 회의\n\n- 참석자: \n",
      }),
    ],
  }),
});
```

(If `tsc` rejects `next: "CANCELLED"` or the wire `type` casing, mirror exactly what `STATUS_TYPE_TO_CAMEL` (taskLine.ts:215) accepts — UPPERCASE keys — and keep `next` pointing at an existing status `type`.)

- [ ] **Step 2: Serve and drive it**

Run: `cd apps/desktop && bun run dev` (Vite; note the port, default 5173 unless vite.config pins another — check `vite.config.ts` `server.port`; the Tauri dev flow uses 1420, a plain `bun run dev` may pick 5173).

Browser (xd://browser), viewport 720×560:
1. `open http://localhost:<port>/harness/slash.html`
2. Click into the editor, type `/` alone → **the full menu opens immediately** (bare `/`).
3. Assert via `tab.evaluate`: `document.querySelectorAll(".cm-tooltip-autocomplete completion-section").length >= 6` — 할 일/날짜/서식/링크/쿼리/템플릿 headers present (6 when cfg resolves).
4. Screenshot: bare-`/` open state (group headers + icon boxes + two-line rows visible).
5. Type `마` → filters to 마감일 rows; screenshot filtered state.
6. `press ArrowDown` → `aria-selected` moves; `press Enter` → task line promoted (evaluate editor text contains the task symbol); screenshot applied state.
7. `press " "` (space) after a fresh `/오` → menu closes, text keeps the literal characters.
8. Korean IME sanity: type `ㅎㅏㄹ` via `tab.type("할")` composition → menu filters on the composed syllable without flicker/dismiss.

- [ ] **Step 3: Fix and iterate** until all eight checks pass (adjust CSS values only, not tokens).

- [ ] **Step 4: Commit the harness**

```bash
git status --short
git add apps/desktop/harness/slash.html apps/desktop/harness/slash-main.ts
git commit -m "test(slash): standalone visual harness for the completion menu"
```

- [ ] **Step 5: Real-app smoke**

`cargo tauri dev` (hub `op:"start"`, cwd `apps/desktop/src-tauri`, `OXI_HOME=/tmp/oxi-slash-trial2`): the window boots, opening a memo editor and typing `/할` shows the same styled menu inside the real app (the merged source path, unlike the harness's standalone mount). Kill the process after.

---

### Task 5: Full gate

- [ ] **Step 1: All tests**

Run: `cd apps/desktop && bun test`
Expected: all pass. Mass-instant failures → EPERM transient: re-run twice before diagnosing.

- [ ] **Step 2: Type + production build**

Run: `cd apps/desktop && bunx tsc -b && bunx vite build`
Expected: clean.

- [ ] **Step 3: Working tree clean**

`git status --short` → empty (all intended files committed; nothing unrelated swept in).

---

### Task 6: Release + local install

**Interfaces:**
- Consumes: the auto-release-prep skill (CI gates, version from commits — 3+ `feat:` commits since v0.13.1 → minor bump expected, v0.14.0), `scripts/install.sh` (dmg download → sha256 verify → copy to /Applications).
- Produces: published GitHub release + `/Applications/OxiMemo.app` at the new version.

- [ ] **Step 1: Read and follow skill://auto-release-prep** end-to-end (it drives CI watch, bump, tag, publish, verification without questions).

- [ ] **Step 2: Verify the release is NOT a draft** — `gh release view` (the `--generate-notes` draft footgun from memory 2026-08-29); if draft, publish it.

- [ ] **Step 3: Install locally**

```bash
APPS_DIR=/Applications sh scripts/install.sh
mdls -name kMDItemVersion /Applications/OxiMemo.app
```

Expected: the new version string.

- [ ] **Step 4: Launch once and verify** — the journaled vault migration (v0.12.0 → spaces layout, memory 2026-08-29/30) runs on first open: check `~/.oxi/spaces/personal/vault` exists and `~/Library/Application Support/com.oximemo.app/` journal shows completion, app window opens. Open a memo, type `/` → menu opens immediately. Report the migration outcome in the final summary (user asleep — no questions).
