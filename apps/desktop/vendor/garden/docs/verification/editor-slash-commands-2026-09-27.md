# Markdown slash commands

This records the initial 13-command verification. The built-in wiki follow-up expands the menu to 22 commands; see [wiki foundation verification](./editor-wiki-foundation-2026-09-27.md) for the current support and test results.

The insertion interaction takes inspiration from [Logseq's tutorial](https://github.com/logseq/docs/blob/master/pages/tutorial.md): typing `/` opens a command list, including task and embed actions. Garden uses its own Markdown grammar and existing theme tokens rather than Logseq's stored block properties.

## Scope

- A compact insertion list appears at the caret on an otherwise empty paragraph.
- Localized labels/descriptions and English aliases support Korean and English discovery.
- Arrow keys navigate, Enter inserts, and Escape dismisses while retaining literal source.
- Commands insert tasks, three heading levels, two list types, quotes, code fences, tables, dividers, links, images, and wiki embeds.
- Source remains authoritative, with one undoable insertion and explicit cursor placement.
- Code, metadata envelopes, HTML, tables, nested blocks, read-only documents, and multiple selections are excluded.

## Reproduction

Run the playground and open `/tests/slash.html`. The fixture exposes language, theme, read-only, and clear controls plus the serialized source disclosure. The same extension is enabled in the normal document editor, with text from the app locale catalog.

## Browser evidence

- `/` showed all 13 options. Two Down presses selected Heading 2; Enter wrote `## `.
- Task insertion wrote `- [ ] `; one undo restored `/`.
- `/code` selected the localized code command; the resulting fence placed typing inside its body.
- Korean `/코드 ` filtered to the code command, and clicking it inserted the same source.
- Escape dismissed the menu without deleting the query. A slash inside a code fence remained literal, and typing `https://example.com/` did not show commands.
- Switching to read-only while the menu was open closed it and preserved `/`.
- In the normal Korean document scene, `/task` filtered to the localized task action and inserted `- [ ] ` at the end of the sample note; subsequent text remained in that task line.
- At a 390px viewport, the menu spanned x=40..360 and the page remained 390px wide.
- Light and dark token palettes were checked: [light](./editor-slash-menu-light.png), [dark](./editor-slash-menu-dark.png).
- `bun run --filter @garden/playground build` passed, including TypeScript and Vite production compilation.

The fixture's automated text entry verifies Korean filtering, not an operating-system IME candidate session. Composition handling is additionally guarded in the extension.

## Automated checks

`bun test packages/editor/tests packages/markdown/tests` passed 129 tests (520 assertions across 14 files), including nine new slash-command cases. These cover localization/filter updates, all command insertion ranges, protected syntax with the cursor inside the protected line, read-only/multiple selections, stale selection/query rejection, reversible changes, and CRLF preservation for multiline templates. Scoped strict TypeScript checking also passed. Review findings around stale completion application and pre-change composition were addressed with apply-time range validation and composition guards.
