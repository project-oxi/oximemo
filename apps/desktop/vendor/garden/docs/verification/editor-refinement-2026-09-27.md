# Editor refinement verification — 2026-09-27

## Scope

Garden-owned task keyboard behavior over Atomic 0.6.2, leading property type icons, consistent label/value rows, and Markdown typography using Garden semantic tokens. Distribution remains deferred. Source stays canonical Markdown; no dependency source or stored user document was converted.

## Browser evidence

The isolated `apps/playground/tests/document.html` fixture runs the real `GDocumentEditor`, sample documents, and shared styles. It avoids concurrent changes to the application's Showcase routes.

- Leading type icons open a focused type selector. Number `2` converts to text `"2"`; text `"02"` refuses conversion to number and preserves the source. Escape restores focus to the icon.
- A string-list property can be created, receive a chip with Enter, and be removed. List input focus remains after adding a chip. Switching documents clears the pending property-name draft.
- Task Enter creates an unchecked `- [ ] ` item. Backspace on the empty item leaves a clean empty line; Undo restores the marker. Enter on the empty item exits the list.
- Backspace at the start of a populated task preserves its text; Undo restores the marker. Pointer and Space activation update the source check state. Activating a table exposes its original Markdown.
- Light and dark document surfaces were visually inspected. At 375px, document scroll width remains 375px and the type selector stays within the viewport.
- The Component guide sample now covers heading hierarchy, emphasis, inline code, strike, blockquote, nested and numbered lists, a table, fenced code, a rule, and tasks.

Screenshots: [light properties](renders/editor-properties-light.png), [dark properties](renders/editor-properties-dark.png).

## Automated checks

- `bun test packages/editor/tests packages/markdown/tests`: **100 passed**, 0 failed, 320 assertions.
- Markdown and editor package builds passed. The task tests cover CRLF, parent-relative nested outdent, multiple selection transactions, read-only behavior, and non-task contexts. The component retains its existing single-selection configuration.
- Independent review reported no remaining material finding after corrections.
- Playground TypeScript checking passed on the final build attempt, but bundling was blocked by the concurrently edited Showcase route importing missing `Showcase.css`. That separate application work was preserved; editor interaction was verified through the isolated fixture.

## Preservation boundaries

Removing a single-line flow string list preserves sibling YAML, comments, body bytes, and CRLF. Commented, multiline, block-style, and structured collection removal remains guarded. Tests cover both accepted and refused cases.

The playground uses session-only drafts. This work does not establish filesystem persistence, complete PDC conformance, or specialized preview support for every Markdown extension.
