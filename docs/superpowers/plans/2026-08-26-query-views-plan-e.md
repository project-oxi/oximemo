# Query Views — Plan E (Inline Embeds) Implementation Plan

**Goal:** Spec §6 — `![[query:이름]]` markers and ```query fenced blocks
rendering live compact results inside notes, with the embeds.ts
orchestration pattern (StateField + resolver ViewPlugin + effect cache;
widgets never fetch), result-key-safe invalidation, and depth-1 semantics.

**Landed design** (implemented alongside this doc):
- `lib/queryEmbeds.ts`: `queryEmbedExtension({ thisId, labels })`. Markers
  render as single-line block replaces; fences render a block widget
  BELOW the closing fence (YAML stays editable). Fence spans come from a
  deterministic line scan (` ```query ` … ` ``` `) rather than syntaxTree —
  parser-independent, same contract (flagged divergence: spec letter says
  syntaxTree; nested-fence YAML is the only corner affected).
- Marker resolution: explicit path (contains `/` or `.query`) → direct;
  bare stem → `list_bases()` unique match; duplicates → error chip listing
  candidates; zero → error. The resolved path rides the entry for
  「전체 열기」.
- Requests: `run_base(view 0, offset 0, limit 10, group null, no counts,
  no summaries, thisId = embedding note)` — per-note scopes never share
  cells (result-key thisId, Plan A).
- Invalidation: plugin listens `bases:changed` + `memos:changed` → clears
  all entries → visible re-resolve (backend result cache absorbs the cost).
- Widgets: header (name · N results), ≤10 rows (name + ≤3 cells,
  `formatBaseValue`, ⚠︎ on cell error), row click selects the note,
  footer 「전체 열기」 → `openBase({path})` (marker) / `openBase({inline:
  yaml})` (fence).
- Card previews: ```query blocks collapse to `[쿼리]` in `previewText`
  (sync preview cannot run queries; the count form would require async —
  scope note). `![[query:…]]` markers already collapse through the
  existing wiki-link rule. HTML notes: no CM6, no embeds (by construction).
- Depth-1: memo embeds render bodies via sanitized HTML — query markers
  inside an embedded note stay inert text (by construction).

**Tasks:** (1) lib/queryEmbeds.ts + CSS, (2) MemoEditorForm mount with
thisId, (3) preview collapse. Verification: build + suite green; widget
behavior exercised through the editor in the final review pass.
