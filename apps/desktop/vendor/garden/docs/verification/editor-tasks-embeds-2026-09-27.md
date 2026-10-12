# Task and rich Markdown verification

Scope: circular task controls with focused-source editing, immediate property type selection, quiet collection inputs, textual task metadata, catalog-style fenced code, and host-resolved embeds.

## Format decision

Task lines retain GFM completion markers. The inline metadata shape follows Obsidian Tasks' Dataview format. Garden writes uppercase priority and completion-action enums as a documented extension: upstream's serializer uses lowercase priority values. Parser reads preserve all source; targeted edits reject ambiguous duplicate fields and invalid calendar dates.

Primary references:
- https://github.com/obsidian-tasks-group/obsidian-tasks/blob/main/src/TaskSerializer/DataviewTaskSerializer.ts
- https://github.com/logseq/docs/blob/master/pages/Tasks.md
- https://github.com/logseq/docs/blob/master/db-version.md#tasks

Logseq's file-based task interaction inspired the keyboard workflow; its current database task properties are not treated as Markdown syntax.

## Executed checks

- Property type icon opens a vertical list; selecting Text immediately updates the type. Keyboard Home/ArrowDown/Enter also applies a type.
- Tag Enter commits and clears the inline input; alias blur commits. Separate add buttons are absent.
- Task metadata parser/patch tests cover legacy lowercase preservation, uppercase writes, duplicates, invalid dates, escaping, code, links, and CRLF.
- Fenced code tests cover closed/top-level gating, nested/incomplete source fallback, focus/selection reveal, and separator-preserving copy content.
- Browser checks confirmed raw source reveal for tasks, quoted/nested tasks, ordinary lists, code fences, and audio embeds. Backspace removes the task marker while retaining metadata; undo restores the exact source.
- All embed kinds now omit a separate action row. Pencil controls appear on hover/focus, and remain available on touch devices. Markdown cards use compact padding, audio occupies 48px, and HTML fits its sanitized content (125px and 90px in the fixture) instead of reserving a fixed frame height.
- HTML sizing uses a hidden, inert shadow-root measurement mirror, with observer cleanup on widget destruction. The iframe keeps its empty sandbox and restrictive CSP; raw HTML URL attributes, scripts, event handlers, forms, and nested frames are stripped.
- At 390px viewport width the document remained 390px wide without horizontal page overflow. Keyboard focus revealed the audio edit control. The local audio loaded with duration 0.5 seconds and readyState 4 after native playback.
- `bun test packages/editor/tests packages/markdown/tests`: 120 passed, 0 failed, 412 assertions across 13 files. Scoped strict TypeScript checking of GDocumentEditor/GMarkdownEditor and dependencies passed.
- The full playground build remains blocked by a missing `packages/ui/src/components/ui/combobox` module in concurrent UI work; this is outside the editor changes.

Screenshots: [desktop media](./editor-embeds-compact-desktop.png), [390px media and keyboard focus](./editor-embeds-compact-mobile.png).

## Browser fixtures

- `/tests/document.html`: document properties and keyboard editing.
- `/tests/embeds.html`: headings, inline marks, tasks with metadata, quotes, code, tables, images, Markdown/audio/HTML embeds, unresolved references, and adversarial HTML sanitizer input.
- Full playground `Embedded media` document: host resolver supplies local assets and note bodies. These are session-only sample documents; no user's vault was migrated.

## Boundaries

Embed resolution is synchronous and host-owned. Hosts authorize URLs and enforce vault containment/integrity. The renderer does not recursively fetch nested Markdown embeds. HTML has a restrictive sanitizer and isolated sandbox; it is not a full HTML-profile editor. Recurrence and dependencies are metadata only; no scheduling or automatic deletion executes.
