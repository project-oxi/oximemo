# @garden/editor

A React source editor using Atomic Editor **0.6.2** and CodeMirror 6. Import `GMarkdownEditor` and `@garden/editor/styles.css`. All labels come from props.

```tsx
<GMarkdownEditor value={draft} onChange={setDraft} label={catalog.editor}
  unsupportedLabel={catalog.unsupportedSource} documentId={document.id} />
```

The editor emits an unsaved source draft. The host validates the PDC envelope, updates `updated` on actual saves, and checks the original snapshot before atomic replacement. Do not mistake an editable buffer for a complete PDC Writer or Full Reader.

Source is authoritative: no DOM-to-Markdown round trip. Uniform LF/CRLF is retained. Mixed line endings and isolated CR use a visible read-only source fallback. External value replacement does not echo `onChange`; switching documentId resets editor history. Read-only mode disables editing and preview task widgets.

Atomic's React wrapper enables whole-construct table/image widgets. Garden composes the safe CodeMirror exports directly, as Cassette does: syntax, highlighting, and inline preview. Garden adds source-preserving previews for GFM tables, fenced code, and host-resolved embeds. Activate an edit control or place the cursor in a block to edit its original source. Unresolved images and attachments remain readable source; the editor does not fetch arbitrary references. All link clicks are intercepted; no link opens by default. Only relative, HTTP(S), and PDC targets reach the optional host callback, which must resolve PDC internally and apply its own vault/network policy.

Garden owns the editing behavior and presentation layer on top of the pinned Atomic extensions. Task keyboard commands and document properties evolve here without modifying installed dependencies. Exact pinning and the retained MIT license make future upstream changes reviewable; `LICENSE.atomic-editor` preserves upstream attribution. Distribution and broader library extraction are deferred.

Library-first is the v0 decision: desktop and service templates already supply application structure, while an independent Obsidian-like app would add vault management, sync, search, and product policy. A standalone document app is deferred until shared parser/query/storage conformance and the editor API stabilize.

The document's line separator is held stable until `documentId` changes, including when all text is deleted; Undo can restore the original CRLF source. When loading a different document or deliberately converting its line endings, provide a new document identity. `apps/playground/tests/editor.html` is the browser regression fixture for select-all replacement and exact CRLF Undo restoration.

## Document workbench

`GDocumentEditor` accepts the full canonical source as `value`, emits full source through `onChange`, and projects it into a title, properties, technical metadata disclosure, and a body-only `GMarkdownEditor`. Its `strings` prop supplies localized labels. `documentId` resets editor identity when switching documents. The component never writes files; persistence still belongs to the host's guarded storage adapter.

Scalar properties and flow string arrays use source-preserving metadata patches. Nested values remain visible through a readable JSON fallback; unsupported lossless edits report a diagnostic. Body edits preserve the envelope except for the required `updated` timestamp. No-op operations retain source exactly. Unsupported/legacy profiles and mixed line endings remain read-only source. Focus does not tint the document surface.

Properties use a leading type icon, a label, and a value region. The icon opens an explicit type-change control for user properties. Standard property types remain fixed. Source and technical disclosures sit below the body. The isolated `apps/playground/tests/document.html` fixture exercises this surface without depending on the playground's application routes.

## Query results

`GQueryView` takes `source` (the YAML of a `.base` file or exact `base` fence), `documents` (the host-provided `QueryDocument[]`), `enabled`, localized `strings`, and optional `onOpenDocument(id)`. The host must explicitly enable the query contract and define the collection scope. The component performs no discovery, network access, or persistence.

It renders table/list views, display names, and summaries from the existing PDC evaluator. Disabled, invalid, unsupported, and successful-empty queries remain distinguishable. Unsupported syntax is shown with its source, never partially evaluated. See `contracts/markdown/presentation.md` for the complete adoption boundary.

### Task lines

Tasks use circular GFM controls and `Mod-Enter` to create or toggle an item. Enter continues a task; an empty task exits or outdents, and Backspace at content start removes its marker.

Per-line metadata follows the Obsidian Tasks Dataview field shape: `- [ ] Review [priority:: HIGH] [due:: 2026-10-01]`. Garden adopts uppercase enum values as an explicit extension; upstream Tasks expects lowercase priority values. Reading never converts existing text. Compact metadata previews reveal the original source when editing the line. Dates, recurrence, identifiers and dependencies remain in the Markdown line; no task database, recurrence scheduler, or automatic completion action is introduced.

Property type icons open immediate vertical choices. Tags and aliases commit with Enter or blur, without add buttons.

## Composable property renderer

Mount GDocumentProperties independently when an application needs the canonical envelope property sheet without a Markdown body editor. It accepts the complete PDC Markdown source through value and emits complete updated source through onChange. Metadata edits use the same source-preserving parser and patcher as GDocumentEditor; there is no parallel property model and the component never writes files. Pass readOnly to render the same supported properties without editing controls; in that mode onChange may be omitted. documentId resets transient form and type-picker state when an application switches documents.

The component edits the title, supported standard properties, and user-defined text, number, Boolean, and string-list properties. Structured or mixed values keep their JSON fallback. It does not flatten nested values, infer a new property type, or coerce values during a patch. Unsupported conversions, technical fields, malformed envelopes, mixed line endings, legacy input, and non-Markdown profiles retain the existing diagnostics and read-only fallback behavior. Hosts remain responsible for saving the emitted source with snapshot checks and atomic replacement.

GPropertyValue is the read-only value renderer for JSON-compatible envelope values. It presents scalars directly, string lists as chips, and nested or mixed values in an expandable JSON view. An optional emptyValue supplies localized display text for null, empty strings, and empty lists. Rendering is a view of parsed data; the original source remains authoritative.

```tsx
import { GDocumentProperties, GPropertyValue } from '@garden/editor';
import '@garden/editor/styles.css';

<GDocumentProperties value={source} onChange={setSource}
  documentId={document.id} strings={catalog.documentStrings} />

<GDocumentProperties value={source} readOnly
  documentId={document.id} strings={catalog.documentStrings} />

<GPropertyValue value={parsedProperty}
  strings={{ jsonValue: catalog.structuredValue }} />
```

### Slash commands

Type `/` at the start of an empty paragraph to open the inline insertion menu. Continue typing to filter by localized names or English aliases, use Up/Down and Enter to insert, and Escape to dismiss without changing source. Commands insert tasks, headings, lists, quotes, fenced code, tables, dividers, links, images, wiki embeds, wiki links, callouts, highlights, comments, footnotes, inline/display math, tags, and block IDs as ordinary Markdown. The cursor moves into the inserted content or selects a replaceable destination. Insertion is a single undoable source transaction and preserves the document's line separators. Code, envelope, HTML, table, and nested-list contexts do not activate the menu.

`GMarkdownEditor.slashLabels` and `GDocumentEditor.strings.slashCommands` accept localized labels and descriptions keyed by `SlashCommandId`. These commands insert source only; selecting an embed does not upload or fetch an attachment.

### Host-resolved embeds

`GMarkdownEditor` and `GDocumentEditor` accept `resolveEmbed(reference)`, a synchronous host callback returning `{kind: 'image' | 'audio', url, title?}` or `{kind: 'markdown' | 'html', source, title?}`. The host resolves canonical vault-relative references or managed assets, verifies containment and integrity, and supplies an authorized display URL. Missing resources retain their source. Standalone `![label](reference)` and `![[reference]]` work without changing their serialized form. Audio uses native controls and does not autoplay; nested Markdown embeds do not recursively load resources.

HTML blocks and resolved HTML attachments use allowlist sanitization plus an empty-sandbox iframe and restrictive CSP. This is a preview capability, not complete PDC HTML Reader conformance. Unsupported inline HTML and nested embed contexts remain source. No source is derived from the rendered DOM. `embedLabels` and `codeLabels` localize controls in the low-level editor; the document editor forwards its localized strings.

## Built-in wiki foundation

The editor and embedded Markdown reader share `@garden/markdown/syntax`: CommonMark + GFM plus the PDC wiki compatibility grammar. Wiki aliases, heading/block links, callouts, highlights, comments, tags, caret IDs, footnotes, and KaTeX math are enabled together. Focused lines expose their original source. Footnotes navigate to their definition and expose return controls; definition bodies retain source formatting. KaTeX runs with `trust: false` and bounded expansion. No rendering path rewrites document source.

Hosts route wiki targets through `onLinkOpen`, resolve attachments through `resolveEmbed`, and can pass `navigationTarget={{anchor, requestId}}` to move to a heading or caret ID. The playground resolves unique sample titles, aliases, paths, and PDC document IDs. Unresolved or ambiguous references do not select an arbitrary document. Localization is supplied through `slashLabels`, `wikiLabels`, or the document editor string catalog.
