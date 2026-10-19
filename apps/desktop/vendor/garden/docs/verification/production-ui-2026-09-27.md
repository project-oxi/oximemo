# Production UI refinement verification — 2026-09-27

## Changes

- Shared titlebar, rail, and sidebar use one uninterrupted surface; the workspace is an inset rounded canvas. Settings and supporting panels follow the same shell.
- Language and theme controls live in settings. The command palette has one visible search entry, with its keyboard shortcut retained.
- Document properties support typed creation, scalar editing/removal, explicit safe type conversion, and compact tag chips. Failed conversions preserve the original value and show a diagnostic.
- GFM tables render semantic rows and columns with alignment, empty/uneven cells, escaped pipes, and basic inline formatting. Enter, Space, or click reveals the original source; blur restores the preview.
- The primary component catalog contains 45 actual demos, including all 19 BeautifulUI demos previously imported into this repository. Categories and search remain inside the shared workspace.
- Layout, toolbar, property, and table behavior are recorded in the UI and Markdown presentation contracts.

## Automated verification

- Full suite before the final uneven-table-row regression: 102 passed, 0 failed, 342 assertions across 10 files.
- Final editor suite including that regression: 16 passed, 0 failed, 96 assertions across 4 files.
- UI, Markdown, editor, and playground builds passed. Vite retains its large-bundle advisory (approximately 1.43 MB uncompressed).
- `garden doctor`: healthy. `git diff --check`: passed.

## Running-app verification

Tested the local playground at `http://127.0.0.1:5174/?lang=ko` through the in-app Browser:

- Created a numeric property, edited it to 12, converted it to text, and confirmed invalid boolean conversion leaves 12 intact. Created and toggled a boolean property; removed a scalar property.
- Edited document priority and observed the query result and aggregate update to 9. Reloaded after these tests to restore sample documents.
- Confirmed table preview, keyboard source reveal, blur restoration, and initial rendering when a table starts at byte offset 0.
- Confirmed catalog category/search, the restored Code Block demo, and an interactive Approval Card transition. Counted 19 BeautifulUI demos.
- Confirmed settings language/theme controls, sidebar collapse, and supporting-panel behavior. Desktop and 375px catalog measurements showed no horizontal document overflow.
- Inspected the final dark document screenshot after restoring the samples.

The browser adapter's pointer targeting was unreliable, so semantic keyboard activation and form operations were used for interactive verification. This is not a claim that every pointer path was exercised.

## Evidence and boundaries

- [Dark document with rendered table](renders/production-table-dark.png)
- [Restored component catalog](renders/production-catalog-dark.png)

Codex references are the supplied screenshots and previously extracted design tokens. Direct Computer Use access to the Codex application was blocked; no fresh live measurements are claimed. Playground edits are session-only. Structured YAML values remain readable fallbacks; list removal is not exposed where the document patcher cannot preserve it safely. Nested tables and unsupported inline syntax retain source fallbacks. This does not claim complete Obsidian/Notion feature parity or full PDC Reader/Writer conformance.
