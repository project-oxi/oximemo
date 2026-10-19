# Built-in wiki foundation

The default editor grammar is CommonMark + GFM with the PDC wiki compatibility constructs. A single `@garden/markdown/syntax` module feeds the CodeMirror editor, embedded Markdown reader, and block-ID validation; source remains authoritative. No stored plugin configuration or new document profile is introduced.

## Included

Wiki note links, aliases, heading and caret targets; standalone wiki embeds; callout blockquotes; highlights; comments; tags; footnotes with definition/return navigation; inline and display KaTeX math. The slash menu now includes 22 localized insertion commands, including all nine new wiki-oriented actions. The playground resolves sample document titles, aliases, paths, and PDC IDs and passes anchor targets to the editor.

## Running UI verification

Use `/tests/wiki.html`, `/tests/slash.html`, or the normal document scene's **Connected knowledge** sample.

- Wiki alias clicks passed `Garden notes`; heading links passed `Garden notes#A shared foundation`; keyboard activation passed `#^decision`.
- In the normal app, the local decision link positioned the selection on `A decision worth keeping. ^shared-language`. The component-table link opened Component guide and focused its matching heading.
- Footnote reference and second return control navigated between definition and the original reference line.
- Clicking rendered inline math exposed `$E = mc^2$` as source. Multiline comments kept inner `[[hidden]]` inert and preserved blank lines.
- Embedded GFM tasks displayed disabled unchecked/checked controls and preserved inline wiki links after fixing the shared AST `Task` dispatch.
- Embedded Markdown displayed the same highlight, wiki-link, math, and callout grammar. Quote markers did not leak into the embed prose.
- `\href{javascript:...}` and `\includegraphics{https://...}` inside math produced no anchor or image elements. Incomplete display math retained source.
- `/` displayed 22 Korean options. `/footnote` selected the footnote action; Enter inserted `[^1]\n\n[^1]: \n`, and a single undo restored `/footnote`.
- Light/dark styles were inspected. At 390px, the document width and scroll width were both 390px.
- Screenshots: [light](./editor-wiki-light.png), [dark](./editor-wiki-dark.png).

## Validation and limits

`bun test packages/editor/tests packages/markdown/tests`: 151 passing tests, 662 assertions across 18 files. Scoped strict editor TypeScript validation and the playground production build passed. The Markdown package build passed. Standalone editor-package compilation remains blocked by existing extensionless imports in `packages/ui/src/index.ts`; the integrated app and scoped editor check compile successfully. Review regressions for HTML comments, text, quoted attribute contents, and `data-id` now pass while nested real IDs still reject duplicates. Vite retains its large-bundle warning; KaTeX and fonts are bundled locally.

Callouts currently retain collapse markers without interactive folding. Footnote definitions show their source body rather than a separate rich block, and labels use ASCII letters, digits, underscores, or hyphens. Nested embeds are not loaded recursively. Unresolved or ambiguous references stay readable. These changes do not add a vault-wide index, graph, or global backlinks panel.
