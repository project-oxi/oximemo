# Document and query presentation

Status: normative Garden adoption profile. Syntax authority remains the vendored PDC 2 and PDC Query 1 specifications. This document defines presentation, not a new dialect.

## Document structure

The ordinary-note source is one PDC Markdown document; authored HTML remains a first-class PDC profile with the current package's explicit read-only source fallback. The editor projects Markdown into properties and body; it never persists JSON editor state in place of that source. `title`, tags, aliases, booleans, numeric and string user properties render as labeled property rows. System fields (`format`, `body`, `id`, `created`, `updated`) remain visible in a technical disclosure. Nested user objects and heterogeneous lists have a readable JSON/source fallback; no flattening or type guessing is allowed.

`GDocumentProperties` is the public standalone property surface from `@garden/editor`. It receives complete document source, emits complete source after guarded metadata patches, and resets transient drafts when document identity changes. `GDocumentEditor` composes the same property surface with the body editor and post-body technical/source disclosures. Apps may place the standalone surface in an inspector without importing internal property helpers or inventing a separate metadata model. A read-only property view preserves values without mutation controls. Neither component discovers a vault or persists a file.

`GPropertyValue` is the public read-only renderer for a parsed JSON-compatible value. It preserves scalar meaning, renders string lists and discloses structured JSON. Its optional localized empty-value label affects presentation only. It does not define a second serializer or coerce values into editing types. The query view retains its own documented result/empty-value semantics.

Metadata edits use the source-preserving patcher. A body edit keeps untouched envelope spelling and updates `updated`. A no-op does neither. Properties with unsupported editing semantics remain readable. Invalid, legacy and non-Markdown profiles remain explicit source fallbacks; they are never silently converted. The host owns snapshot/conflict checks and atomic filesystem persistence. The playground uses session-only state.

## Syntax support matrix

| Syntax | Standard | Garden presentation |
| --- | --- | --- |
| Headings, emphasis, lists, quotes, links, code | CommonMark 0.31.2 | Source-preserving inline editor |
| Tables, tasks, strike, autolinks | GFM 0.29 extensions | Tasks/strike inline; tables render from GFM syntax with explicit source editing |
| `[[Note]]`, aliases and heading/block links | PDC compatibility syntax | Inline links; host resolves notes and passes heading/block navigation targets |
| `![[Note]]`, images/audio/HTML attachments | PDC compatibility syntax | Host-resolved standalone embeds; unresolved references retain source |
| `> [!note]`, `==highlight==` | PDC compatibility syntax | Callout blockquotes and highlighted spans; active source remains editable |
| `$math$`, `$$math$$` | PDC compatibility syntax | KaTeX with untrusted macros; malformed math retains readable source |
| `[^label]`, `[^label]: definition` | PDC compatibility syntax | Footnote navigation and return controls; definition source remains readable |
| `%%comment%%`, `#tag`, `^block-id` | PDC compatibility syntax | Muted comments, inline tags, and source-addressable block anchors |
| `^block-id` | PDC stable targets | Preserve; parser reports duplicate targets |
| Raw HTML | PDC Markdown | Top-level blocks use sanitized, sandboxed previews; inline/unsupported HTML stays source |
| Authored `.html` | PDC HTML first-class profile | Read-only source fallback in this package |
| Legacy `.djot` / PDC 1 HTML | Frozen PDC 1 | Read-only source fallback, no auto-conversion |
| `.base`, exact fenced `base` | PDC Query 1 | Explicitly enabled in-memory table/list projections |

Do not claim full PDC Reader/Writer conformance for this package. Vault discovery, link/asset resolution, safe HTML rendering, and complete Bases support require additional host capabilities.

The built-in grammar lives in `@garden/markdown/syntax` and is shared by the editor, embedded Markdown reader, and Markdown block-ID validation. These capabilities ship together by default, without per-document plugin configuration. Every preview keeps source ranges authoritative. Code, escapes, envelopes, and opaque math/comment bodies are protected from wiki interpretation. Callout collapse markers are preserved but do not yet provide folding. Footnote labels use ASCII letters, digits, underscores, and hyphens; definition bodies remain source-readable. Vault indexing and graph views remain host concerns.

## Query semantics

Queries use only `.base` YAML and exact fenced `base` blocks. No SQL, Dataview, JavaScript, or competing Garden syntax. Query scope in the playground is the labeled in-memory sample document collection, including the currently edited note. Production vaults enable queries through `query: pdc-query/1` in the manifest.

The canonical supported subset is machine-readable in `query-capabilities.json`. `order` is column order, never row sorting. All supported table/list views render their own result and summaries. Filters and formulas read envelope properties; updating properties changes the result projection without changing query source. Display names affect presentation only. Unknown constructs, unsupported grouping, and malformed YAML produce distinct visible unexecuted/invalid diagnostics and retain source; they never masquerade as a successful empty result.

Query execution cannot write documents, fetch resources, launch processes, or authorize actions. Result selection is an explicit callback to the host. The same renderer accepts YAML extracted by a host from a canonical fenced block or a standalone `.base` file; it does not scan arbitrary text and execute it automatically.

## Typed property editing

The property sheet supports creating named text, number, checkbox, and string-list values. These types map directly to JSON-compatible YAML values; no new envelope type registry is serialized. Reserved technical fields remain managed, duplicate names cannot overwrite existing values, and a user property type changes only through an explicit type action. Conversions must preserve information (for example, numeric text with leading zeros must not silently become a number). Structured or otherwise non-losslessly editable YAML remains visible with a diagnostic rather than being flattened. Tag chips are compact, subdued list values with labeled removal and an inline add affordance.

Property rows place the type icon before the label and the editable content after it. User-property icons open a vertical choice list; choosing a type applies the guarded conversion immediately without a second Apply action. Invalid conversions preserve the value and show a local diagnostic. Choices support arrow keys, Enter, Escape, and outside dismissal. Standard properties retain their contract-defined types. Tag and alias values use inline chip inputs with Enter or blur to commit, without separate add buttons. Technical metadata and complete-source disclosures follow the body so the writing surface remains continuous. Markdown typography, code, quotes, tables, and task controls use Garden's semantic theme tokens in both light and dark appearances.

Task-list keyboard edits are source transactions: Enter continues a populated task with an unchecked item, Enter on an empty task exits or outdents it, and Backspace at the start of task content removes the marker without deleting the content. Code fences and the envelope are not task-editing contexts. Undo must restore the source, including its line-separator convention.

Tasks appear as circular controls with localized open/completed status. Mod-Enter turns an eligible text or list line into a task and toggles an existing task. These are editing controls over canonical GFM markers, not a separate Boolean property or duplicated task database. The interaction takes inspiration from Logseq's block task workflow. Task metadata uses the Obsidian Tasks Dataview inline-field shape, for example `- [ ] Review [priority:: HIGH] [due:: 2026-10-01]`. Garden's explicitly adopted extension uses uppercase priority enums (`HIGHEST`, `HIGH`, `MEDIUM`, `NONE`, `LOW`, `LOWEST`) and completion-action enums (`KEEP`, `DELETE`), rather than emoji signifiers. This is not byte-for-byte Tasks compatibility: upstream Tasks recognizes lowercase priority values. Lowercase input remains readable without automatic rewriting. Completion remains authoritative in the GFM marker; no second status field is introduced. Recognized metadata is shown compactly outside the active line, and the original text remains editable. Unknown, malformed, duplicate, escaped, code, and link content must remain visible and preserved. Recurrence and dependencies are descriptive metadata; no scheduler or automatic deletion runs.

Tables use the GFM parser's structure, not a separate pipe-splitting grammar. Rendering must never rewrite the source, execute HTML, or fetch resources. Keyboard and pointer activation expose the source for editing; source selection and copy remain possible. Unsupported nested contexts retain readable source.

## Embedded content and code

Slash commands are a presentation feature over the same Markdown source. On an otherwise empty paragraph, `/` opens a localized insertion list with keyboard navigation, Enter to insert, and Escape to dismiss. Commands insert standard Markdown or existing wiki-embed syntax in one reversible transaction; they do not introduce stored command objects, convert existing content, or execute external actions. Source contexts such as fences and document envelopes must retain literal slashes.

Fenced code uses the catalog card structure: a language header, copy action, line numbers, and an inset code surface. Editing exposes the original fence and info string. Standalone Markdown images and wiki embeds may resolve to image/audio URLs or Markdown/HTML source through an explicit synchronous host resolver. The host owns vault containment, asset verification, and authorization of remote resources. Missing references retain their visible source. Embedded Markdown uses a safe native tree and does not recursively load more embeds. Audio never autoplays. HTML is allowlist-sanitized before entering an empty-sandbox iframe with a restrictive content security policy. Source is never serialized from rendered DOM.
