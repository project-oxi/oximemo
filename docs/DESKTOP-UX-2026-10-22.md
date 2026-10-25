# Desktop reading and writing refinement — 2026-10-22

Scope: existing desktop shell and document adapters, without format conversion.
Hallmark/anti-slop in-place review follows the existing DESIGN.md and Garden
exceptions. Critique: purpose 4, hierarchy 4, execution 4, specificity 4,
restraint 4; cross-page variety is intentionally inapplicable to this app.

## Changes

- List rows reserve separate space for title, three-line rendered excerpt,
  tags and time. Long titles wrap to two lines; compact containers move the
  folder label underneath. Grid excerpts retain multiple paragraphs.
- Excerpts preserve emphasis, line breaks and task status. A dedicated Marked
  instance avoids changing other renderers. Sanitization removes navigation,
  resource loads, form controls, authored styles and layout classes. Markdown
  images use inert descriptions. This is a derived preview, never a source edit.
- The existing editor history is exposed through Garden undo/redo controls,
  with availability following CodeMirror history and focus returning to editing.
- Empty properties start collapsed. Stored/schema properties start expanded;
  a user's disclosure choice stays with the current note.

## Verification

- Desktop build/typecheck passed; existing large-bundle warning remains.
- Garden sync and doctor passed, with the existing approved exceptions.
- Targeted Bun tests: 220 passed, 2 DOM-only tests skipped, 0 failed.
  Run from apps/desktop with explicit ./src paths; a first root invocation
  accidentally matched archived target checkouts with missing dependencies.
- Real browser DOM checks at /qa/preview-check.html: 6/6 passed (paragraphs,
  task states, inert links/media/forms, layout-class removal, Unicode,
  plain-text image descriptions). These tests are separate from skipped Bun DOM cases.
- UI walkthrough using browser-local test notes: create, write Markdown,
  undo, redo, save, reopen, list/grid, immersive mode, property expansion,
  property creation and reopen. Light and dark inspected at 1280×720.
- At 760×720, page scrollWidth equals 760; all three list rows have matching
  scrollWidth/clientWidth (506). Long titles wrap without horizontal overflow.

The running preview uses browser localStorage, not the real vault. Native
packaging, native filesystem writes and PC/mobile sync were not re-tested for
this desktop-only change. PDC Stage 2 remains incomplete; this advances its
safe-preview gate only. No install, release or document conversion performed.
