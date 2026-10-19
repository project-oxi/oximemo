# Playground showcase verification — 2026-09-27

## Scope

Added overview, assistant, workspace, and feedback compositions using Garden controls,
TurnStream, StreamText, TaskRows, and feedback primitives. Retained documents, queries,
settings, and the full 45-demo catalog. Command palette backdrops are transparent.
Entrance motion uses shared tokens and reduced-motion overrides.

## Automated checks

- `bun run --filter @garden/ui build`: passed.
- `bun run --filter @garden/playground build`: passed (TypeScript and Vite).
- English/Korean key parity: passed for app and showcase catalogs.
- Vite retains its large-bundle advisory; no new dependencies were added.

An intermediate full typecheck encountered unrelated editor dependency/type errors.
The final complete playground build passed without changes to editor source by this task.

## Running browser checks

Used the local Vite app at `http://127.0.0.1:5176/` in the in-app browser.

- Korean overview and all three composition pages rendered.
- Assistant: submitted a sample message; switched to execution output; allowed the
  sample approval. Message appeared in the transcript and approval changed to allowed.
- Workspace: Next task advanced to composer and then motion; completion changed the
  selected row to Complete / 100%; adding a task increased the table to five rows.
- Feedback: Save produced an Undo toast; Undo restored the unsaved button. Retry
  replaced the local error with its success state.
- Dialog: cancelling returned focus to Open dialog. Confirming from banner Details
  removed the banner and returned focus to the persistent Open dialog fallback.
- Palette: computed backdrop was `rgba(0, 0, 0, 0)`; panel retained overlay shadow.
  Searching for the theme command and pressing Enter switched to the light theme.
- Catalog: initially showed 45 demos; searching `progress` reduced it to one demo.
- English overview and settings navigation rendered correctly.
- Desktop 1280×800, mobile 390×844, and short landscape 667×375 were inspected.
  Overview, workspace, and feedback had document width equal to the mobile viewport.
  The short landscape rail preserved 36px buttons and scrolled vertically.
- The toast was verified inside the viewport after its provider was moved outside
  the size-query container. Page-level entry animation uses opacity only so fixed
  feedback stays viewport-anchored during transitions.

## Integration fixes found during verification

- Large Button text-size utilities no longer displace inverse foreground colors
  during class merging; checked light primary text/background as white / near-black.
- Progress forwards its value to Radix so accessibility values match the visual bar.
- Removed inert action buttons; replaced simulated copy success with a real reset
  action; fixed Next task cycling; retained submitted messages; cleaned retry timers.

## Copy and shell cleanup

- Removed sidebar branding, footer copy and duplicate settings button; removed the bottom local-preview status region.
- Removed scene introductions, decorative metrics and section descriptions, keeping component labels, controls and demo content.
- Restored the titlebar context-panel toggle on all non-settings routes.
- Running app at port 5176: overview, assistant, feedback and settings rendered successfully. The assistant context panel closed and reopened through the titlebar button. Settings remained reachable through the activity rail.
- Targeted Showcase/catalog/UI TypeScript check passed. Vite production bundle passed.
- Full playground build is currently blocked by the concurrently edited `packages/editor/src/GDocumentEditor.tsx`: `taskLabels` is not yet part of `GMarkdownEditorProps` (TS2322).

## Shared query table styling

- Extracted the catalog Records Table's shell, scroll, table, cell and hover rules into `@garden/ui/table.css`; query results and standards tables now consume the same rules.
- Removed broad playground table overrides that were changing catalog and query cell padding.
- Running app: query results show shared column borders, 42px rows, 0px/12px cell padding and separate borders. Opening Component guide from a query result still navigates to that document.
- Query component TypeScript check and Vite production bundle passed. Full typecheck is currently blocked by unrelated `task-field.ts` Range<Decoration> typing errors.

## Interactive query controls

- Added transient search, AND column filters with value suggestions, numeric-aware sorting, column visibility, removable filter chips, row counts and reset. Tag arrays render as chips. Query source disclosure is collapsed below the results.
- Source/schema changes reset table state; document updates preserve it. Filtered views explicitly label summaries as full-query totals.
- Four state tests pass (search, compound/tag filtering, numeric/empty handling, stable sorting).
- Independent browser harness using the real GQueryView and existing UI primitives: search for framework returned two rows, Status contains draft returned two rows, hiding Tags removed its header, reset restored all rows/columns, missing search returned zero, initial Title ascending applied, Priority sorted both ways with blanks last. Review findings on initial sort and accessible sort direction fixed and exercised.
- Isolated harness was necessary because concurrent catalog imports (PatternGallery/UtilityGallery) and editor EmbedPreviewOptions typing currently block the full playground build. Temporary harness and server were removed after verification.
- Final integration retry: catalog files appeared, but UtilityGallery still imports not-yet-exported UI components (Breadcrumb, Calendar, DataTable, Table, etc.), so the full app remains temporarily unavailable. No query-control TypeScript errors were reported in that check.
