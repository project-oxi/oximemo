# Portable Document Contract 1

Status: public draft 4

Date: 2026-09-13

Document identifier: `pdc-document/1`

Canonical body profiles: `pdc-djot/1`, `pdc-html/1`

This document is normative. The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** describe conformance requirements.

## 1. Scope and compatibility promise

Portable Document Contract 1 governs durable, user-authored notes and documents that participating applications may open, index, edit, link, embed, or migrate.

It does not govern repository documentation, source-code comments, prompts, logs, caches, generated previews, exported reports, immutable event ledgers, or database-internal records unless they are explicitly promoted to the shared document plane.

PDC separates one logical document contract from two canonical body profiles. Djot is the default for ordinary notes and structured prose. HTML is equally canonical when native document structure, layout, and styling are part of the authored source.

Two fully conforming applications given the same vault MUST:

1. discover the same conforming Djot and HTML documents;
2. either open each document safely or show an explicit unsupported/invalid diagnostic;
3. agree on document identity, standard metadata, links, managed assets, task state, and block targets;
4. preserve data they do not understand;
5. never silently hide, discard, execute, or reinterpret a conforming document during a write or preview.

Compatibility does not require identical CSS, pixel-identical previews, identical search ranking, or editing every body profile. Unsupported editing features MUST retain a readable source or rendered fallback, make the document read-only when necessary, and survive round trips.

## 2. Versioning and profiles

- `pdc-document/1` identifies the shared vault, envelope, identity, metadata, linking, asset, preservation, and concurrency contract.
- `pdc-djot/1` identifies the frozen Djot body profile.
- `pdc-html/1` identifies the frozen safe-authored HTML body profile.
- A document declares exactly one body profile in its `body` envelope field.
- Compatible clarifications and new optional fields may be added without changing the major identifier.
- A change that makes a previously conforming document parse differently, changes required semantics, removes a field, or permits destructive down-conversion MUST use a new major identifier.
- Readers MUST compare identifiers as exact, case-sensitive strings. An unknown major version is unsupported, not malformed.
- Implementations MUST be tested against a named conformance-corpus revision. Depending only on parser package versions is insufficient.

The upstream Djot syntax baseline is commit [`d77f8a0cbea6785c42b3e2b03463195b5ca6f7c7`](https://github.com/jgm/djot/tree/d77f8a0cbea6785c42b3e2b03463195b5ca6f7c7). Upstream changes do not alter `pdc-djot/1` until incorporated here with fixtures.

`pdc-html/1` uses the HTML parsing model implemented by conforming HTML5 parsers. The PDC corpus is the authority for profile-specific classification, PDC semantics, and safe-render behavior; an HTML library version alone does not define this profile.

## 3. Vault and discovery

A vault is a user-selected directory. A document path never defines document identity.

### 3.1 Vault manifest

A writable vault MUST contain `.pdc/vault.json`:

```json
{
  "format": "pdc-vault/1",
  "id": "018f47c6-1199-72b3-87de-344e5a493e27",
  "created": "2026-09-13T12:34:56.789Z"
}
```

- `format`, `id`, and `created` are required.
- The vault ID follows the document-ID rules in section 7.
- A Reader MAY open a manifest-free directory as an uninitialized vault.
- A Writer MUST create the manifest before its first canonical write, without moving or rewriting existing files.
- Unknown manifest properties MUST be preserved.

### 3.2 Document discovery

- Canonical Djot documents use lowercase `.djot`. Canonical HTML documents use lowercase `.html` and the exact PDC HTML envelope transport in section 4.3.
- Readers MUST recursively discover regular `.djot` and `.html` files below the vault root.
- Readers MUST NOT scan `.pdc`, `.git`, or any path with a dot-prefixed component.
- Readers MUST NOT follow symbolic links during recursive discovery.
- File ordering MUST NOT affect identity or conflict resolution.
- Every discovered `.djot` file MUST appear as a canonical document or a visible diagnostic.
- Every discovered `.html` file MUST appear as a canonical document, a visible legacy HTML item, or a visible diagnostic. A non-PDC HTML file is legacy, not malformed merely because it lacks a PDC envelope.
- Duplicate document IDs across both body profiles are vault errors. An app MUST show every conflicting path and MUST NOT choose a winner silently.
- A canonical document with `deleted: true` MUST remain in a discovery-visible path so all Readers can offer trash and recovery views. Moving it under `.trash`, `.pdc`, or another excluded directory makes it legacy app state, not a discoverable canonical deletion.

`.md`, `.markdown`, `.dj`, unmarked HTML, `shdoc/1`, and other legacy formats may be discovered by separate adapters. They MUST NOT be classified as canonical PDC documents merely because their body resembles a canonical profile.

## 4. File transports

### 4.1 Common transport rules

- A canonical document is UTF-8 without a byte-order mark. A Reader MUST reject a byte-order mark as `invalid_transport`; it MUST NOT strip one silently.
- A canonical document is at most 4 MiB, including envelope transport and body.
- Writers create LF line endings. Readers MUST accept LF or CRLF and interpret them equivalently for envelope parsing.
- Writers MUST NOT normalize an untouched document merely because it was opened.
- The body slice begins after its profile-specific envelope transport. It may be empty and remains distinct from the parsed envelope for preservation rules.
- A missing, empty, duplicated, or unclosed PDC envelope is malformed.
- The common envelope uses the grammar in section 5 regardless of body profile.

### 4.2 Djot transport

- The extension is `.djot`.
- The media type is `application/vnd.pdc.document+djot;version=1`.
- The first line is exactly `---`. The next exact `---` line closes the envelope. The remainder is the Djot body.
- The envelope `body` value is exactly `pdc-djot/1`; any other value in this transport is `invalid_transport`.
- Frontmatter-free `.djot` is valid upstream Djot but invalid PDC transport. A Reader reports `invalid_transport` and MAY offer an explicit foreign-Djot import.
- A canonical Djot body has at most 256 simultaneously open block containers.

### 4.3 HTML transport

- The extension is `.html`.
- The media type is `application/vnd.pdc.document+html;version=1`.
- The first line is exactly `<!--`, the second line is exactly `---`, the next exact `---` line closes the envelope, and the immediately following line is exactly `-->`.
- The bytes after the line ending following `-->` are the HTML body. A canonical Writer emits that line ending even for an empty body.
- The envelope `body` value is exactly `pdc-html/1`; any other value in this transport is `invalid_transport`.
- The serialized envelope between the opening `<!--` line and the wrapper's closing `-->` line MUST NOT contain an earlier literal `-->` or `--!>` sequence. Such a sequence is `invalid_transport` because an HTML parser can terminate the comment before the PDC parser does. A Writer MUST reject or losslessly encode the affected metadata value before serialization; it MUST NOT emit a browser-visible partial envelope.
- The comment wrapper keeps a conforming file directly browser-readable while preventing envelope text from becoming rendered content.
- A body may be an HTML fragment or a full HTML document. A Writer creating a new standalone HTML document SHOULD emit `<!doctype html>` and a complete document; it MUST NOT wrap or normalize an existing fragment during a no-op or metadata-only write.
- An `.html` file without the exact opening transport is legacy HTML. A Full Reader MUST keep it visible as legacy and MUST NOT silently relabel it as PDC. A product may omit legacy items from its default canonical-document list only when another explicit view or diagnostic still exposes them.
- A canonical HTML body has a maximum DOM nesting depth of 256 after HTML parsing.

## 5. Envelope grammar and data model

The envelope uses the frozen PDC constrained-YAML grammar, not general YAML.

- Keys are nonempty, case-sensitive strings at indentation level zero.
- A value is a Boolean, single-line string, flat string sequence, literal block string, or one nested map.
- Nested-map children use exactly two spaces. Deeper maps and sequences of maps are forbidden.
- Duplicate keys, tabs, comments, anchors, aliases, tags, complex keys, multi-document streams, and empty values are forbidden.
- `true` and `false` are Booleans. Other bare or quoted scalars are strings; numbers and timestamps are not implicit numeric or date types.
- Flow sequences are single-line flat string sequences. Block sequences are accepted by Readers, but Writers SHOULD emit flow sequences.
- CRLF is normalized only for envelope parsing. Original body bytes remain distinct.
- A malformed opening envelope is a hard error, never body text.

General-purpose YAML libraries MAY be used only behind validation that rejects every forbidden feature. They MUST use safe loading and MUST NOT instantiate tagged objects.

### 5.1 Required fields

| Field | Type | Requirement |
|---|---|---|
| `format` | string | Exact value `pdc-document/1` |
| `body` | string | Exact value `pdc-djot/1` or `pdc-html/1`, matching transport |
| `id` | string | Canonical lowercase UUID |
| `created` | string | Canonical UTC timestamp |
| `updated` | string | Canonical UTC timestamp, not earlier than `created` |
| `title` | string | Display title; may be empty |

Canonical timestamps use `YYYY-MM-DDTHH:MM:SS.sssZ`, with exactly millisecond precision and a real Gregorian calendar date and time. Readers MAY accept other RFC 3339 forms only in a legacy importer; canonical Writers MUST emit the form above.

The stored title is authoritative when nonempty. When it is empty, the display fallback is:

1. Djot: plain text of the first level-one heading, then filename stem.
2. HTML: plain text of the first `<h1>`, then `<title>`, then filename stem.

### 5.2 Standard optional fields

| Field | Type | Default / semantics |
|---|---|---|
| `profile` | string | `note`; lower kebab-case token |
| `lang` | string | Unspecified; BCP 47 language tag |
| `tags` | string sequence | Empty; case-sensitive, duplicate-free labels |
| `aliases` | string sequence | Empty; alternate human-facing titles |
| `favorite` | Boolean | `false` |
| `deleted` | Boolean | `false`; excluded from default lists but available to trash/recovery views |
| `deleted_at` | string | Canonical UTC timestamp; MUST be present exactly when `deleted` is true |

Writers MUST preserve Unicode text. They MUST NOT silently case-fold or normalize titles, aliases, or body text. New tags SHOULD use Unicode NFC; tag comparison SHOULD compare NFC without changing stored spelling.

Envelope `title` and `tags` are the shared metadata source of truth. An app that also recognizes body headings or inline hashtags MUST document whether it synchronizes them, treats them as suggestions, or keeps them app-specific; it MUST NOT silently overwrite authoritative envelope values during indexing.

### 5.3 Extensions and unknown fields

- Unprefixed field names are reserved for future PDC versions.
- An application-specific extension MUST be a top-level map named `x_<namespace>`, where the namespace is lowercase ASCII letters and digits beginning with a letter.
- The initially registered application namespaces are `x_oximemo`, `x_sawhorse`, `x_oxibrain`, `x_farm`, and `x_lexi`. Their corresponding app is the only Writer allowed to create or reinterpret values in that map.
- A new app claims a namespace by adding it to this registry before shipping writes. Renaming or transferring a claimed namespace is a standard change with a migration plan.
- A Writer MUST NOT create another application's namespace.
- Readers and Mutators MUST preserve unknown unprefixed fields and unknown extension maps.
- An unknown field is not permission to treat a document as malformed unless its serialized value violates the envelope grammar.
- Complex extension data that does not fit the constrained grammar MUST be carried as an opaque literal-block string in the owning namespace. A child key ending `_json` conventionally contains UTF-8 JSON; only the owning namespace interprets it, while every other Writer preserves the exact string value.

### 5.4 Canonical key order

New documents and full canonical rewrites emit known keys in this order:

`format`, `body`, `id`, `created`, `updated`, `title`, `profile`, `lang`, `tags`, `aliases`, `favorite`, `deleted`, `deleted_at`.

Unknown unprefixed fields retain observed order. Extension maps follow, sorted by namespace. Reordering alone MUST NOT trigger a rewrite of an existing file.

## 6. Body profiles

### 6.1 `pdc-djot/1`

The body uses the pinned Djot syntax with these constraints:

- Raw inline and raw block nodes in any output format are nonconforming. In particular, embedded raw HTML is forbidden inside a Djot-profile body.
- The only attributes with standard semantics are `id`, `class`, `lang`, `title`, and `data-pdc-*`.
- Class names beginning `pdc-` and attributes beginning `data-pdc-` are reserved by this standard.
- App-specific classes use `x-<namespace>-<name>`. App-specific attributes use `data-x-<namespace>-<name>`.
- A body parser MUST retain source ranges or another lossless representation sufficient for section 10.
- Writers creating or fully regenerating a body use LF, place a blank line between block elements, omit trailing spaces, and end a nonempty body with one LF. Existing authored layout is preserved unless a deliberate format action is requested.
- An implementation that accepts syntax beyond this dialect does so only as an importer. It MUST NOT write extra syntax while labeling the body `pdc-djot/1`.

Standard Djot structures—headings, paragraphs, emphasis, strong text, links, images, autolinks, verbatim text, highlight, superscript, subscript, insert/delete, math, footnotes, lists, task items, code blocks, divs, and pipe tables—must remain parseable and preservable. A viewer MAY use a readable textual fallback for a presentation feature it cannot render.

### 6.2 `pdc-html/1`

The body is user-authored HTML source, not a generated Djot preview.

- HTML fragments and full documents are accepted according to the HTML parsing model.
- The source bytes are canonical. A parsed DOM is a projection and MUST NOT replace or reserialize source merely because a document was opened, indexed, previewed, or patched only in metadata.
- A source editor MAY edit arbitrary text. A structural editor MUST preserve comments, unknown elements, attributes, whitespace, and ordering or downgrade the document to source-only/read-only.
- Standard PDC semantics use `id`, `class`, `lang`, `title`, and `data-pdc-*`. App-specific classes and attributes follow the same namespace rules as Djot.
- New canonical HTML MUST NOT create `<script>`, inline event-handler attributes, `javascript:` or `vbscript:` URLs, `<base>`, meta refresh, executable plugin content, or unsandboxed nested browsing contexts.
- A Reader that encounters active or unsafe constructs reports `unsafe_content`, preserves the source, and presents a safe source view or sanitized inert preview. It MUST NOT execute the construct or silently remove it from the stored file.
- Inline `<style>` elements and `style` attributes are allowed because authored layout is a purpose of this profile, but rendering MUST isolate them. External CSS, fonts, CSS `url()`, and other subresources follow the external-resource policy in section 11.
- HTML comments and `data-*` attributes are source content and survive writes. Render exposure remains allowlisted separately from preservation.

## 7. Identity and block targets

### 7.1 Document identity

- `id` is the sole canonical document identity.
- It is a hyphenated lowercase UUID string.
- Writers MUST generate UUIDv7 for new documents. Readers MUST accept any valid UUID version for migrated documents.
- Moving, renaming, or changing body profile MUST NOT change the ID.
- App-local database IDs, filenames, paths, titles, and legacy human IDs MUST NOT replace it.

### 7.2 Stable block and inline targets

A body element becomes a stable target only through profile-specific canonical syntax:

- Djot: an `#b-<uuid>` attribute on the target element. A block attribute sits immediately before its block; an inline attribute sits immediately after its inline element.
- HTML: `id="b-<uuid>"` on the target element.

The UUID follows the document-ID rules; Writers generate UUIDv7. Once assigned, the target ID MUST survive edits, moves within the document, body-profile-preserving round trips, and app changes. An app MUST NOT assign IDs merely by opening a document. It MAY assign one when a link, task identity, comment, or feature needs a stable target.

Duplicate `b-<uuid>` target IDs within one document are invalid. The app MUST surface the conflict before writing.

## 8. Links, embeds, and assets

### 8.1 Document links

Canonical internal links resolve by UUID within the current vault:

```text
[Readable label](pdc://document/<document-uuid>)
[Readable label](pdc://document/<document-uuid>#b-<block-uuid>)
```

```html
<a href="pdc://document/018f47c6-4a77-7c52-9db8-0e5f9bcb17db">Readable label</a>
<a href="pdc://document/018f47c6-4a77-7c52-9db8-0e5f9bcb17db#b-018f47c6-7dbe-7a14-9f67-6f89a5e3cc32">Section</a>
```

- `pdc:` is a private contract URI scheme, not an operating-system protocol-handler requirement.
- The label is fallback content and MUST remain readable when unresolved.
- An unresolved target is a visible broken-link state, not a reason to rewrite the URL.
- `[[wiki links]]`, app-specific schemes, and path-only note links are legacy or extension syntax, not canonical links.

A document embed is the same link with class `pdc-embed`. A viewer without inline embedding renders the ordinary link fallback.

### 8.2 Managed assets

- Managed asset bytes are addressed by lowercase SHA-256 digest.
- The canonical URI is `pdc://asset/sha256/<64-hex-digest>`.
- The canonical vault path is `.pdc/assets/sha256/<first-two-hex>/<64-hex-digest>`.
- A managed asset is at most 64 MiB. Larger resources remain external or require a future extension with explicit streaming semantics.
- Stored bytes MUST hash to the URI digest. A mismatch is a visible integrity error.
- Original filename and media type MAY be carried in Djot as `data-pdc-filename` and `data-pdc-media-type`, or in HTML as attributes of the referring element. They are hints, not identity.
- Writers MUST use atomic create-if-absent and MUST NOT overwrite different bytes at an existing digest path.
- Apps MUST NOT garbage-collect unreferenced assets automatically. Garbage collection requires an explicit maintenance action, a complete reference scan across both body profiles, and a recoverable quarantine period.
- HTTP(S) resources are external. Relative file URLs, absolute filesystem paths, `file:`, `data:`, and app-specific asset schemes are not canonical managed assets.

```text
![Diagram](pdc://asset/sha256/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef){data-pdc-filename="diagram.png" data-pdc-media-type="image/png"}
```

```html
<img src="pdc://asset/sha256/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" alt="Diagram" data-pdc-filename="diagram.png" data-pdc-media-type="image/png">
```

## 9. Standard semantic constructs

### 9.1 Tasks

Djot task items use the frozen Djot task syntax. `[ ]` is open and `[x]` or `[X]` is completed. A task needing stable identity wraps its complete leading label in a `pdc-task` span with a block ID.

```text
- [ ] [Open task]{#b-018f47c6-c718-728c-9d91-b2bc700814bb .pdc-task}
```

HTML task items use an `li.pdc-task` with `data-pdc-task-state="open"` or `"completed"`. An optional stable ID is placed on the `<li>`. Canonical Writers use `☐` or `☑` as the leading readable fallback and keep it consistent with the authoritative data attribute.

```html
<ul>
  <li class="pdc-task" data-pdc-task-state="open" id="b-018f47c6-c718-728c-9d91-b2bc700814bb">☐ Open task</li>
</ul>
```

A Mutator exposing task toggling changes only the canonical task marker/state, its matching readable fallback when HTML requires it, and required metadata timestamps. App-specific dates, priorities, recurrence, and status families require a namespaced extension with readable body text.

### 9.2 Query blocks

An executable query is opaque in Document 1. Query execution belongs to a separately versioned contract.

Djot uses a fenced code block whose language is `pdc-query`. HTML uses `<pre class="pdc-query"><code>…</code></pre>` and takes the code element's text content as the opaque query.

Apps that do not implement the query contract show the code block. They MUST NOT execute, delete, or rewrite it.

### 9.3 Extension fallback

Every new semantic extension MUST have a fallback expressible as ordinary text, link, code, or container content in its body profile. Removing the extension class or attribute must leave understandable content. Opaque binary editor state is forbidden as the only representation of user content.

## 10. Read, write, and preservation rules

### 10.1 No-op and partial writes

- Opening, previewing, indexing, or closing a document without user-visible changes MUST leave every byte unchanged.
- A metadata-only mutation MUST preserve body bytes exactly in both profiles.
- A body-only mutation SHOULD preserve untouched envelope spelling and unknown-field order; it MUST preserve all envelope values.
- Updating content or standard metadata MUST update `updated`. A no-op MUST NOT update it.
- Automatic ID assignment is a mutation and requires an actual feature need; it MUST NOT happen during read-only access.
- Format or body-profile conversion is never a no-op and always follows section 14.

### 10.2 Unknown and unsupported content

- Unknown envelope fields, extension maps, Djot attributes, HTML source constructs, and readable fallbacks MUST survive writes.
- Render sanitization MUST NOT mutate stored source.
- If an editor's internal model cannot preserve a construct, the app MUST make the document read-only or require an explicit lossy conversion listing affected constructs.
- A lossy conversion MUST write to a new target until the user explicitly authorizes source replacement.

### 10.3 Concurrency and durability

- Writers MUST compare current source bytes or digest with the snapshot that editing began from before replacement.
- If the source changed externally, the app MUST block overwrite, merge with conflict reporting, or create a conflict copy. Last-writer-wins without notice is forbidden.
- File replacement MUST be atomic on the target filesystem.
- A Writer MUST fsync the temporary file before rename when the platform exposes that primitive; durability of the containing directory SHOULD also be requested.
- Errors MUST retain the previous valid file and surface an actionable diagnostic.

## 11. Rendering and security

Documents and renderer output are untrusted input. Source preservation and render exposure are separate decisions.

### 11.1 Common rules

- `javascript:`, `vbscript:`, `data:`, `file:`, and unknown schemes MUST NOT be navigated or loaded automatically.
- `pdc:` URIs MUST be handled by an internal resolver, never handed directly to a browser or operating system.
- External HTTP(S) resources require the app's normal privacy/network policy and MUST NOT be fetched merely for indexing.
- Managed assets are verified and resolved before rendering.
- The shared render policy is `pdc-document-render-policy/2`.

### 11.2 Djot rendering

- Previewers MUST sanitize generated HTML or construct a safe native view tree.
- Raw HTML is forbidden inside the Djot profile.
- Only allowlisted elements and attributes are exposed to rendered HTML.

### 11.3 HTML rendering

- A conforming app renders HTML only through a sanitizer plus an isolated native view or sandbox that does not grant script execution, forms, popups, top navigation, plugins, or unrestricted subresource loading.
- Source `<script>`, event handlers, meta refresh, nested browsing contexts, executable embeds, and unsafe URLs are removed or inert in the preview while remaining untouched in stored source.
- Authored inline CSS may render only inside the isolation boundary. The app MUST block or policy-gate external stylesheets, fonts, CSS imports, and CSS `url()` resources.
- PDC links and assets are resolved by the host before sanitized content reaches the isolated renderer.
- Directly opening a PDC HTML file in a general browser is outside the app sandbox. An app SHOULD warn before doing so when unsafe constructs are present.

## 12. Conformance roles and capabilities

### Full Reader

A Full Reader implements discovery and transport validation for `.djot` and `.html`, parses both body profiles, applies standard metadata and semantic rules, safely presents rendered content or source fallback, resolves UUID links and managed assets, and exposes visible diagnostics.

Owner applications claiming cross-app PDC compatibility MUST at least be Full Readers. A product MAY expose a narrower profile-specific Reader capability, but it MUST NOT call that capability full PDC compatibility.

### Writer

A Writer is a Full Reader that can create canonical documents and vault manifests, generate UUIDv7 IDs, emit canonical timestamps, respect limits, and write atomically with external-change detection. A Writer declares whether it writes Djot, HTML, or both; Oximemo-class note applications may deliberately offer both.

### Mutator

A Mutator is a Writer that can modify one or both declared body profiles while satisfying byte preservation, unknown-data preservation, conflict detection, safe-render separation, and read-only downgrade rules. An app may be a Djot Mutator and HTML Reader without losing Full Reader conformance.

An app MUST NOT claim a role until it passes every applicable shared fixture for that role and body capability in its shipping implementation. Corpus success is necessary but not sufficient.

## 13. Diagnostics

At minimum, apps distinguish:

- `invalid_transport`
- `invalid_envelope`
- `legacy_html`
- `unsupported_document_version`
- `unsupported_body_version`
- `invalid_document_id`
- `duplicate_document_id`
- `duplicate_block_id`
- `document_too_large`
- `document_too_complex`
- `missing_asset`
- `asset_digest_mismatch`
- `unsafe_content`
- `unsupported_lossless_edit`
- `external_change_conflict`

Diagnostics include the path, body profile when known, and a human-readable reason. Parse diagnostics SHOULD include line and column. Indexing one bad document MUST NOT hide or prevent access to unrelated valid documents. `legacy_html` is a visible classification, not an error that authorizes rewriting the file.

## 14. Legacy migration and interchange

- Markdown, foreign Djot, unmarked HTML, `shdoc/1`, and other formats are importer inputs or exporter outputs, not alternate canonical bodies.
- Existing apps SHOULD use dual-read and canonical-write-for-new-documents before offering conversion.
- A canonical-to-canonical body-profile conversion keeps the document UUID, so its candidate output MUST remain outside active vault discovery until the old canonical path is replaced or removed. A converter MUST NOT leave two discoverable canonical files with the same ID while awaiting approval.
- A legacy HTML document may migrate to `pdc-html/1` without converting its body when it already satisfies the safe-authored profile; the importer adds a new conforming transport and maps semantics explicitly.
- Importers MUST map identity, timestamps, links, assets, task state, title/tag authority, and app semantics explicitly.
- When a legacy ID parses as a UUID in noncanonical spelling, preserve the UUID value and emit canonical lowercase hyphenated spelling.
- When a legacy ID is not a UUID, allocate UUIDv7 and preserve the original in the source app's extension map.
- Oximemo v4 uses `deleted` as a deletion timestamp string. Its importer maps that value to `deleted: true` plus the same instant normalized into `deleted_at`; absence maps to `deleted: false`.
- Oximemo Markdown remains legacy until explicitly converted to `pdc-djot/1`. Oximemo HTML remains legacy until it carries the PDC HTML transport and passes the HTML profile; HTML itself is not demoted to Djot.
- Sawhorse `shdoc/1` SHOULD target `pdc-html/1` when preserving authored HTML semantics is safer than converting to Djot.
- Importers MUST report dropped, approximated, externalized, unsafe, ambiguous, or unsupported constructs before source replacement.
- Export does not change canonical source and SHOULD state the exact target dialect.

## 15. Change governance

The standard repository is the source of truth. A change is complete only when it updates, as applicable:

1. this specification;
2. parsed-envelope schema and render policy;
3. positive and negative fixtures for both body profiles;
4. adoption or migration guidance;
5. participating implementations and their pinned corpus revision.

No single app implementation silently defines the standard. When the specification and an implementation differ, report the difference and change one deliberately; do not normalize the conflict away.

## Appendix A: minimal canonical Djot document

```text
---
format: pdc-document/1
body: pdc-djot/1
id: 018f47c6-4a77-7c52-9db8-0e5f9bcb17db
created: 2026-09-13T12:34:56.789Z
updated: 2026-09-13T12:34:56.789Z
title: First document
profile: note
favorite: false
deleted: false
---
# First document

This body is Djot, not an unspecified Markdown dialect.
```

## Appendix B: minimal canonical HTML document

```html
<!--
---
format: pdc-document/1
body: pdc-html/1
id: 018f47c6-4a77-7c52-9db8-0e5f9bcb17db
created: 2026-09-13T12:34:56.789Z
updated: 2026-09-13T12:34:56.789Z
title: First HTML document
profile: note
favorite: false
deleted: false
---
-->
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>First HTML document</title></head>
<body><h1>First HTML document</h1><p>This source remains browser-readable.</p></body>
</html>
```

## Appendix C: the 100% guarantee

For this standard, “100% compatible” means every fully conforming app can find, identify, parse, safely present, link, and preserve every conforming Djot and HTML document without silent loss. An app may lack an optional execution or editing feature, but the source remains readable and intact. Files outside the contract—legacy Markdown, unmarked or unsafe legacy HTML, malformed documents, and newer major versions—must still be visible as legacy, invalid, or unsupported rather than disappearing.
