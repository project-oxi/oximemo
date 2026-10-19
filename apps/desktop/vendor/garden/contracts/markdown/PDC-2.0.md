# Portable Document Contract 2

Status: public draft 2

Date: 2026-09-14

Document identifier: `pdc-document/2`

Canonical body profiles: `pdc-markdown/1`, `pdc-html/1`

Optional query contract: `pdc-query/1` (see `PDC-QUERY-1.0.md`)

This document is normative. The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** describe conformance requirements.

## 1. Scope and compatibility promise

Portable Document Contract 2 governs durable, user-authored notes and documents that participating applications may open, index, edit, link, embed, or migrate.

It does not govern repository documentation, source-code comments, prompts, logs, caches, generated previews, exported reports, immutable event ledgers, or database-internal records unless they are explicitly promoted to the shared document plane.

PDC 2 replaces the Djot-first ordinary-document profile of PDC 1 with an Obsidian-compatible Markdown profile and keeps HTML first-class. Portable Document Contract 1 remains a frozen legacy contract: every conforming PDC 2 application MUST read `pdc-document/1` documents — both `pdc-djot/1` and `pdc-html/1` bodies — and MUST NOT automatically convert, rewrite, or re-emit them. Conversion of any v1 document is an explicit, user-authorized operation that writes a new target; see section 14.

Two fully conforming applications given the same vault MUST:

1. discover the same conforming Markdown and HTML documents, and the same readable legacy v1 documents;
2. either open each document safely or show an explicit unsupported/invalid diagnostic;
3. agree on document identity, standard metadata, links, managed assets, task state, and block targets;
4. preserve data they do not understand, including every user-defined frontmatter property;
5. never silently hide, discard, execute, or reinterpret a conforming document during a write or preview.

Compatibility does not require identical CSS, pixel-identical previews, identical search ranking, or editing every body profile. Unsupported editing features MUST retain a readable source or rendered fallback, make the document read-only when necessary, and survive round trips.

## 2. Versioning and profiles

- `pdc-document/2` identifies the shared vault, envelope, identity, metadata, linking, asset, preservation, and concurrency contract.
- `pdc-markdown/1` identifies the canonical Markdown body profile: lowercase `.md`, Obsidian-compatible.
- `pdc-html/1` identifies the canonical safe-authored HTML body profile, unchanged in substance from PDC 1.
- A document declares exactly one body profile in its `body` envelope field.
- `pdc-djot/1` is valid only inside a `pdc-document/1` envelope. A `pdc-document/2` envelope declaring `pdc-djot/1` is `invalid_transport`. A `pdc-document/1` envelope declaring `pdc-markdown/1` is likewise `invalid_transport`: the Markdown profile exists only under PDC 2.
- Compatible clarifications and new optional fields may be added without changing the major identifier.
- A change that makes a previously conforming document parse differently, changes required semantics, removes a field, or permits destructive down-conversion MUST use a new major identifier.
- Readers MUST compare identifiers as exact, case-sensitive strings. `pdc-document/1` is legacy-readable, never unsupported. An unknown major version is unsupported, not malformed.
- Implementations MUST be tested against a named conformance-corpus revision. Depending only on parser package versions is insufficient.

The Markdown syntax baseline is CommonMark `0.31.2` plus the GitHub Flavored Markdown Spec (`0.29-gfm`) extensions for tables, task lists, strikethrough, and autolinks. Upstream changes do not alter `pdc-markdown/1` until incorporated here with corpus fixtures.

`pdc-html/1` uses the HTML parsing model implemented by conforming HTML5 parsers. The PDC corpus is the authority for profile-specific classification, PDC semantics, and safe-render behavior; an HTML library version alone does not define this profile.

The legacy `pdc-djot/1` profile is defined by `PDC-1.0.md` section 6.1 and its pinned Djot commit; that definition is frozen.

## 3. Vault and discovery

A vault is a user-selected directory. A document path never defines document identity.

### 3.1 Vault manifest

A writable vault MUST contain `.pdc/vault.json`:

```json
{
  "format": "pdc-vault/1",
  "id": "018f47c6-1199-72b3-87de-344e5a493e27",
  "created": "2026-09-14T12:34:56.789Z"
}
```

- `format`, `id`, and `created` are required.
- The vault ID follows the document-ID rules in section 7.
- A Reader MAY open a manifest-free directory as an uninitialized vault.
- A Writer MUST create the manifest before its first canonical write, without moving or rewriting existing files.
- Unknown manifest properties MUST be preserved.
- A vault MAY declare `"query": "pdc-query/1"` to enable the query contract of `PDC-QUERY-1.0.md`. The field is optional; its absence never invalidates a vault.

### 3.2 Document discovery

- Canonical Markdown documents use lowercase `.md`. Canonical HTML documents use lowercase `.html` with the exact PDC HTML envelope transport in section 4.3.
- Readers MUST recursively discover regular `.md`, `.html`, and `.djot` files below the vault root, and `.base` files when the vault manifest declares the query contract.
- Readers MUST NOT scan `.pdc`, `.git`, or any path with a dot-prefixed component.
- Readers MUST NOT follow symbolic links during recursive discovery.
- File ordering MUST NOT affect identity or conflict resolution.
- Every discovered `.djot` file MUST appear as a readable legacy v1 document or a visible diagnostic; it is never rewritten merely by being opened.
- Every discovered `.html` file MUST appear as a canonical v2 document, a readable legacy v1 document, a visible legacy HTML item, or a visible diagnostic. A non-PDC HTML file is legacy, not malformed merely because it lacks a PDC envelope.
- Every discovered `.md` file MUST appear as a canonical v2 document, a visible plain-Markdown legacy item, or a visible diagnostic. A `.md` file without valid PDC frontmatter is plain Markdown, not malformed merely because it lacks a PDC envelope.
- Duplicate document IDs across all body profiles and both major versions are vault errors. An app MUST show every conflicting path and MUST NOT choose a winner silently.
- A canonical document with `deleted: true` MUST remain in a discovery-visible path so all Readers can offer trash and recovery views.

`.markdown`, `.dj`, unmarked HTML, unmarked Markdown, `shdoc/1`, and other legacy formats may be discovered by separate adapters. They MUST NOT be classified as canonical PDC documents merely because their content resembles a canonical profile.

## 4. File transports

### 4.1 Common transport rules

- A canonical document is UTF-8 without a byte-order mark. A Reader MUST reject a byte-order mark as `invalid_transport`; it MUST NOT strip one silently.
- A canonical document is at most 4 MiB, including envelope transport and body.
- Writers create LF line endings. Readers MUST accept LF or CRLF and interpret them equivalently for envelope parsing.
- Writers MUST NOT normalize an untouched document merely because it was opened.
- The body slice begins after its profile-specific envelope transport. It may be empty and remains distinct from the parsed envelope for preservation rules.
- A missing, empty, duplicated, or unclosed PDC envelope is malformed where the transport requires one.
- The common envelope uses the grammar in section 5 regardless of body profile.

### 4.2 Markdown transport

- The extension is `.md`, lowercase.
- The media type is `application/vnd.pdc.document+markdown;version=2`.
- The file starts at byte 0 with a line containing exactly `---` (the frontmatter delimiter), followed by the envelope source, followed by a line containing exactly `---` that closes the envelope. The remainder is the Markdown body.
- The first delimiter MUST start at byte 0. Indented, repeated, or trailing-whitespace delimiters are `invalid_transport`.
- The envelope `body` value is exactly `pdc-markdown/1`; any other value in this transport is `invalid_transport`.
- An empty envelope (no keys) is `invalid_envelope`, not an empty document.
- A `.md` file that does not start with the exact `---` delimiter is plain Markdown: visible legacy input, never an automatic conversion target.
- A canonical Markdown body has a maximum block nesting depth of 256 after parsing.

### 4.3 HTML transport

- The extension is `.html`.
- The media type is `application/vnd.pdc.document+html;version=2` for a `pdc-document/2` envelope and `;version=1` for the legacy `pdc-document/1` envelope.
- The first line is exactly `<!--`, the second line is exactly `---`, the next exact `---` line closes the envelope, and the immediately following line is exactly `-->`.
- The bytes after the line ending following `-->` are the HTML body. A canonical Writer emits that line ending even for an empty body.
- The envelope `body` value is exactly `pdc-html/1`; any other value in this transport is `invalid_transport`.
- The serialized envelope between the opening `<!--` line and the wrapper's closing `-->` line MUST NOT contain an earlier literal `-->` or `--!>` sequence. Such a sequence is `invalid_transport`. A Writer MUST reject or losslessly encode the affected metadata value before serialization; it MUST NOT emit a browser-visible partial envelope.
- The comment wrapper keeps a conforming file directly browser-readable while preventing envelope text from becoming rendered content.
- A body may be an HTML fragment or a full HTML document. A Writer creating a new standalone HTML document SHOULD emit `<!doctype html>` and a complete document; it MUST NOT wrap or normalize an existing fragment during a no-op or metadata-only write.
- A `.html` file without the exact opening transport is legacy HTML. A Full Reader MUST keep it visible as legacy and MUST NOT silently relabel it as PDC.
- A canonical HTML body has a maximum DOM nesting depth of 256 after HTML parsing.

### 4.4 Legacy Djot transport

- The `.djot` transport is defined by `PDC-1.0.md` section 4.2 and remains exactly as written there.
- A PDC 2 Reader classifies conforming Djot documents as legacy-readable v1 documents. It MUST apply the full v1 envelope, identity, and preservation rules to them.
- A PDC 2 Writer MUST NOT create `.djot` documents. `pdc-djot/1` appears in v2 output only inside an untouched legacy file.

## 5. Envelope grammar and data model

The envelope uses safe general YAML 1.2 with the Core Schema, restricted as follows.

- The document is a single YAML document whose root is a mapping.
- Keys are nonempty, case-sensitive strings. Duplicate keys are forbidden.
- Values are restricted to JSON-compatible data: null, Boolean, finite number, string, sequence, or mapping. `.inf`, `-.inf`, `.nan`, binaries, timestamps-as-dates, and set/ordered-map types are forbidden. A plain scalar that looks like a date is a string.
- Nesting (combined map and sequence depth) is capped at 32 levels. Total node count is capped at 10,000. Exceeding either cap is `document_too_complex`.
- Comments (a `#` that begins a comment per YAML rules) are permitted and preserved under the no-op and patch rules.
- Anchors (`&`), aliases (`*`), explicit or custom tags (`!!`, `!name`), complex keys, multi-document streams, and tabs in indentation are forbidden.
- General-purpose YAML libraries MAY be used only behind validation that rejects every forbidden feature. They MUST use safe loading and MUST NOT instantiate tagged objects.
- CRLF is normalized only for envelope parsing. Original body bytes remain distinct.
- A malformed opening envelope is a hard error, never body text.

### 5.1 Required fields

| Field | Type | Requirement |
|---|---|---|
| `format` | string | Exact value `pdc-document/2` |
| `body` | string | Exact value `pdc-markdown/1` or `pdc-html/1`, matching transport |
| `id` | string | Canonical lowercase UUID |
| `created` | string | Canonical UTC timestamp |
| `updated` | string | Canonical UTC timestamp, not earlier than `created` |
| `title` | string | Display title; may be empty |

Known fields have strict types. A Boolean known field given a string, or a string field given a number, is `invalid_envelope`.

Canonical timestamps use `YYYY-MM-DDTHH:MM:SS.sssZ`, with exactly millisecond precision and a real Gregorian calendar date and time. Readers MAY accept other RFC 3339 forms only in a legacy importer; canonical Writers MUST emit the form above. Unquoted YAML date-like scalars are strings, so quoting is optional, but the parsed value MUST be this exact string form.

The stored title is authoritative when nonempty. When it is empty, the display fallback is:

1. Markdown: plain text of the first level-one heading, then filename stem.
2. HTML: plain text of the first `<h1>`, then `<title>`, then filename stem.

### 5.2 Standard optional fields

| Field | Type | Default / semantics |
|---|---|---|
| `profile` | string | `note`; lower kebab-case token |
| `lang` | string | Unspecified; BCP 47 language tag |
| `tags` | string sequence | Empty; case-sensitive, duplicate-free labels |
| `aliases` | string sequence | Empty; alternate human-facing titles |
| `cssclasses` | string sequence | Empty; CSS classes applied when rendering this document |
| `favorite` | Boolean | `false` |
| `deleted` | Boolean | `false`; excluded from default lists but available to trash/recovery views |
| `deleted_at` | string | Canonical UTC timestamp; MUST be present exactly when `deleted` is true |

Writers MUST preserve Unicode text. They MUST NOT silently case-fold or normalize titles, aliases, or body text. New tags SHOULD use Unicode NFC; tag comparison SHOULD compare NFC without changing stored spelling.

Envelope `title` and `tags` are the shared metadata source of truth. An app that also recognizes body headings, inline `#tags`, or other property sources MUST document whether it synchronizes them, treats them as suggestions, or keeps them app-specific; it MUST NOT silently overwrite authoritative envelope values during indexing.

### 5.3 User properties and extensions

- Every top-level envelope key that is not a known field of section 5.1 or 5.2 is a **user property** owned by the user and applications the user chooses.
- User properties MUST be preserved losslessly — value, type, nesting, order, and spelling — by every Reader, Writer, and Mutator. An app that cannot represent a user property MUST make the document read-only or report a conversion conflict; it MUST NOT drop, flatten, coerce, or silently reinterpret it.
- User properties are queryable: `pdc-query/1` expressions MAY reference any user property by name.
- PDC 2 has no reserved `x_` mechanism; an application that wants a private namespace SHOULD prefix its property keys (for example `acme_status`) to avoid collisions. Collision behavior between two apps using the same property name is a user concern, not a contract error.
- Unknown user properties are never permission to treat a document as malformed unless their serialized value violates the envelope grammar.

### 5.4 Canonical key order

New documents and full canonical rewrites emit known keys in this order:

`format`, `body`, `id`, `created`, `updated`, `title`, `profile`, `lang`, `tags`, `aliases`, `cssclasses`, `favorite`, `deleted`, `deleted_at`.

User properties retain observed order after the known keys. Reordering alone MUST NOT trigger a rewrite of an existing file.

## 6. Body profiles

### 6.1 `pdc-markdown/1`

The body is user-authored Markdown. The parsed document is a projection; the source bytes are canonical.

**Base grammar.** CommonMark `0.31.2` with the GFM extensions for pipe tables, task lists, strikethrough, and autolinks. An implementation that accepts syntax beyond this dialect does so only as an importer or as recognized compatibility syntax; it MUST NOT write extra syntax while labeling the body `pdc-markdown/1`.

**Recognized compatibility syntax.** The following constructs MUST be preserved byte-for-byte and MUST remain readable when an implementation does not render them specially. Recognizing them is interop behavior, not permission to invent a different base grammar:

- Wiki links: `[[Note]]`, `[[Note|Label]]`, `[[Note#Heading]]`, `[[Note#^block-id]]`.
- Wiki embeds: `![[Note]]`, `![[image.png]]`.
- Callouts: `> [!type]` blockquote prefixes.
- Highlights: `==text==`.
- Source comments: `%%text%%`.
- Math: `$inline$` and `$$display$$`.
- Footnotes: `[^label]` references and definitions.
- Inline tags: `#tag`.
- Caret block IDs: `^id` (section 7.2).

**Raw HTML.** Inline and block raw HTML permitted by CommonMark is preserved byte-for-byte in source. Rendering MUST sanitize it per section 11 and the render policy. Active or unsafe constructs (script, event handlers, unsafe URLs) are `unsafe_content`: source is preserved, preview is inert.

**Preservation.**

- A body parser MUST retain source ranges or another lossless representation sufficient for section 10.
- A structural editor MUST preserve unknown syntax, HTML comments, attributes, whitespace, and fence info strings, or downgrade the document to source-only/read-only. Fence info strings are user data.
- Writers creating or fully regenerating a body use LF, end a nonempty body with one LF, and otherwise preserve authored layout. Existing authored layout is preserved unless a deliberate format action is requested.

**Editor safety.** A Markdown editor MAY apply Markdown-native transforms. It MUST NOT reinterpret Djot, wiki-markup, or other dialect syntax that this profile does not define, and MUST NOT rewrite compatibility syntax it does not implement.

### 6.2 `pdc-html/1`

The body is user-authored HTML source, not a generated Markdown preview. The source-preservation, safe-authoring, rendering-isolation, and HTML class/attribute namespace rules of `PDC-1.0.md` section 6.2 apply unchanged. Under a `pdc-document/2` envelope, however, the transport rules of section 4.3 and the envelope/user-property rules of section 5 govern metadata; PDC 1's envelope extension ownership rules do not carry forward.

### 6.3 Legacy `pdc-djot/1`

The Djot profile is frozen at `PDC-1.0.md` section 6.1. PDC 2 Readers apply it unchanged to legacy documents. PDC 2 conformance suites MUST include v1 readability cases; a PDC 2 application that cannot read v1 documents is not a Full Reader.

## 7. Identity and block targets

### 7.1 Document identity

- `id` is the sole canonical document identity.
- It is a hyphenated lowercase UUID string.
- Writers MUST generate UUIDv7 for new documents. Readers MUST accept any valid UUID version for migrated documents.
- Moving, renaming, or changing body profile MUST NOT change the ID.
- App-local database IDs, filenames, paths, titles, and legacy human IDs MUST NOT replace it.

### 7.2 Stable block and inline targets

A body element becomes a stable target through profile-specific canonical syntax:

- Markdown: a caret block ID `^<target-id>` attached per Obsidian placement (end of the block, or end of the list item), or `id="b-<uuid>"` inside raw HTML.
- HTML: `id="b-<uuid>"` on the target element.

Accepted caret ID charset: Latin letters, digits, and hyphens (`[A-Za-z0-9-]+`, nonempty). A Writer that needs a guaranteed portable, collision-free target emits `^b-<uuid>`, where the UUID follows the document-ID rules and Writers generate UUIDv7. Short human-chosen IDs are valid; uniqueness is per document.

Once assigned, the target ID MUST survive edits, moves within the document, body-profile-preserving round trips, and app changes. An app MUST NOT assign IDs merely by opening a document. It MAY assign one when a link, task identity, comment, or feature needs a stable target.

Duplicate caret block IDs or duplicate `b-<uuid>` targets within one document are invalid. The app MUST surface the conflict before writing (`duplicate_block_id`).

## 8. Links, embeds, and assets

### 8.1 Document links

Canonical link forms, all first-class:

1. **Relative vault links** (core Markdown):
   ```text
   [Readable label](folder/note.md)
   [Readable label](folder/note.md#heading)
   [Readable label](folder/note.md#^block-id)
   ```
2. **Wiki links and embeds** (recognized compatibility syntax): `[[note]]`, `[[note|label]]`, `[[note#heading]]`, `[[note#^block-id]]`, and `![[note]]` / `![[image.png]]` embeds.
3. **Stable cross-app links** (optional, unchanged from PDC 1):
   ```text
   [Readable label](pdc://document/<document-uuid>)
   [Readable label](pdc://document/<document-uuid>#b-<block-uuid>)
   ```

Rules:

- Relative link resolution MUST stay inside the vault root. Lexical `..` segments MUST NOT escape the vault, and resolution MUST NOT follow symbolic links out of the vault. A link that would escape resolves to a visible broken-link state.
- Wiki-link targets resolve against vault-local paths using each implementation's documented ambiguity policy (shortest unique path match is the default). An unresolved target is a visible broken-link state, not a reason to rewrite the link.
- `pdc:` is a private contract URI scheme, not an operating-system protocol-handler requirement. The label is fallback content and MUST remain readable when unresolved.
- Absolute filesystem paths, `file:`, and `data:` URLs are not canonical links. App-specific schemes are extensions, not canonical links.

A document embed is a link or wiki embed that the viewer renders inline. A viewer without inline embedding renders the ordinary link fallback.

### 8.2 Assets

- **Relative vault-local references are canonical.** Images and attachments addressed by vault-relative paths (including wiki embeds) are canonical asset references. They resolve under the same containment rules as links: inside the vault, never through symlinks out of it.
- **Managed digest assets remain an optional stable form.** Managed asset bytes are addressed by lowercase SHA-256 digest; the canonical URI is `pdc://asset/sha256/<64-hex-digest>`; the canonical vault path is `.pdc/assets/sha256/<first-two-hex>/<64-hex-digest>`; stored bytes MUST hash to the URI digest; a managed asset is at most 64 MiB. Writers MUST use atomic create-if-absent and MUST NOT overwrite different bytes at an existing digest path.
- Apps MUST NOT garbage-collect unreferenced assets automatically. Garbage collection requires an explicit maintenance action, a complete reference scan across all body profiles, and a recoverable quarantine period.
- No automatic fetch while indexing: HTTP(S) resources are external and MUST NOT be fetched merely for indexing. Relative file URLs outside the vault, absolute filesystem paths, `file:`, and `data:` are not canonical managed assets.
- Original filename and media type hints (`data-pdc-filename`, `data-pdc-media-type`, or equivalent attributes) remain hints, not identity.

## 9. Standard semantic constructs

### 9.1 Tasks

Markdown task items use the GFM task-list syntax. `- [ ]` is open; `- [x]` or `- [X]` is completed.

- Any other checkbox character (`[/]`, `[-]`, custom states) is a preserved extension: it MUST round-trip byte-for-byte, MUST NOT be rewritten to a standard state, and implementations without support for it display the literal state.
- A task needing stable identity carries a caret block ID on the task item (`- [ ] Task text ^b-<uuid>`), or `id="b-<uuid>"` in raw HTML.
- A Mutator exposing task toggling changes only the canonical task marker and required metadata timestamps. App-specific dates, priorities, recurrence, and status families are user properties or namespaced extensions with readable body text.

### 9.2 Query blocks

Executable queries are defined by the separately versioned `pdc-query/1` contract (`PDC-QUERY-1.0.md`). In a `pdc-markdown/1` body, a fenced code block whose info string is exactly `base` carries a query. Transport, grammar, and security rules live in the query specification.

Apps that do not implement the query contract show the code block or `.base` file as content. They MUST NOT execute, delete, or rewrite it.

### 9.3 Extension fallback

Every new semantic extension MUST have a fallback expressible as ordinary text, link, code, or container content in its body profile. Removing the extension syntax must leave understandable content. Opaque binary editor state is forbidden as the only representation of user content.

## 10. Read, write, and preservation rules

### 10.1 No-op and partial writes

- Opening, previewing, indexing, or closing a document without user-visible changes MUST leave every byte unchanged.
- A metadata-only mutation MUST preserve body bytes exactly in all profiles and MUST preserve every untouched envelope line byte-for-byte, including YAML comments, quoting, key order, and user properties.
- A body-only mutation SHOULD preserve untouched envelope spelling and user-property order; it MUST preserve all envelope values.
- Updating content or standard metadata MUST update `updated`. A no-op MUST NOT update it.
- Automatic ID assignment is a mutation and requires an actual feature need; it MUST NOT happen during read-only access.
- Format or body-profile conversion is never a no-op and always follows section 14.

### 10.2 Unknown and unsupported content

- Unknown envelope fields (user properties), Markdown compatibility syntax, raw HTML, HTML source constructs, and readable fallbacks MUST survive writes.
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
- The shared render policy is `pdc-document-render-policy/3`.

### 11.2 Markdown rendering

- Previewers MUST sanitize generated HTML or construct a safe native view tree. Raw HTML and unsafe link/image URLs are inert in preview.
- Only allowlisted elements and attributes are exposed to rendered HTML. GFM task-list checkboxes render as disabled, non-interactive inputs.
- Recognized compatibility syntax degrades to readable fallbacks (wiki links render as links or text; callouts as styled blockquotes; highlights, math, comments, and footnotes as their nearest safe equivalent) rather than disappearing.

### 11.3 HTML rendering

- A conforming app renders HTML only through a sanitizer plus an isolated native view or sandbox that does not grant script execution, forms, popups, top navigation, plugins, or unrestricted subresource loading.
- Source `<script>`, event handlers, meta refresh, nested browsing contexts, executable embeds, and unsafe URLs are removed or inert in the preview while remaining untouched in stored source.
- Authored inline CSS may render only inside the isolation boundary. The app MUST block or policy-gate external stylesheets, fonts, CSS imports, and CSS `url()` resources.
- PDC links and assets are resolved by the host before sanitized content reaches the isolated renderer.
- Directly opening a PDC HTML file in a general browser is outside the app sandbox. An app SHOULD warn before doing so when unsafe constructs are present.

## 12. Conformance roles and capabilities

### Full Reader

A Full Reader implements discovery and transport validation for `.md`, `.html`, and `.djot`, parses all canonical and legacy body profiles (`pdc-markdown/1`, `pdc-html/1`, legacy `pdc-djot/1`), applies standard metadata and semantic rules, safely presents rendered content or source fallback, resolves UUID links, relative links, wiki links, and managed assets, classifies plain Markdown and unmarked HTML as visible legacy, and exposes visible diagnostics.

Owner applications claiming cross-app PDC compatibility MUST at least be Full Readers. A product MAY expose a narrower profile-specific Reader capability, but it MUST NOT call that capability full PDC compatibility.

### Writer

A Writer is a Full Reader that can create canonical documents and vault manifests, generate UUIDv7 IDs, emit canonical timestamps, respect limits, and write atomically with external-change detection. A Writer declares whether it writes Markdown, HTML, or both. A PDC 2 Writer MUST NOT create `.djot` documents or `pdc-document/1` envelopes.

### Mutator

A Mutator is a Writer that can modify one or more declared body profiles while satisfying byte preservation, user-property preservation, unknown-data preservation, conflict detection, safe-render separation, and read-only downgrade rules. An app may be a Markdown Mutator and HTML Reader without losing Full Reader conformance.

An app MUST NOT claim a role until it passes every applicable shared fixture for that role and body capability in its shipping implementation. Corpus success is necessary but not sufficient.

## 13. Diagnostics

At minimum, apps distinguish:

- `invalid_transport`
- `invalid_envelope`
- `invalid_query`
- `legacy_html`
- `legacy_markdown`
- `legacy_document_version`
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

`legacy_document_version` marks a readable `pdc-document/1` document. `legacy_html` and `legacy_markdown` mark visible legacy items, not errors, and never authorize rewriting the file. Diagnostics include the path, body profile when known, and a human-readable reason. Parse diagnostics SHOULD include line and column. Indexing one bad document MUST NOT hide or prevent access to unrelated valid documents.

## 14. Legacy migration and interchange

- PDC 1 documents (`pdc-djot/1`, `pdc-html/1` under `pdc-document/1`) are mandatory readable legacy inputs. Plain Markdown, unmarked HTML, `shdoc/1`, and other formats are importer inputs or exporter outputs, not alternate canonical bodies.
- Automatic conversion is forbidden. Opening, indexing, previewing, or saving a legacy document in place MUST NOT change its format, profile, envelope, or bytes.
- Conversion is explicit, user-authorized, new-target-first: the converter writes a new canonical target, requires a backup, and produces a machine-readable loss report listing every dropped, approximated, externalized, unsafe, ambiguous, or unsupported construct. Source replacement happens only after the user accepts the report.
- A canonical-to-canonical body-profile conversion keeps the document UUID, so its candidate output MUST remain outside active vault discovery until the old canonical path is replaced or removed. A converter MUST NOT leave two discoverable canonical files with the same ID while awaiting approval.
- A legacy HTML document may migrate to `pdc-html/1` under a `pdc-document/2` envelope without converting its body when it already satisfies the safe-authored profile; the importer adds the new transport and maps semantics explicitly.
- Existing apps SHOULD use dual-read and canonical-write-for-new-documents before offering conversion: read v1 and v2 everywhere, write `pdc-document/2` only for newly created documents during the compatibility window.
- Importers MUST map identity, timestamps, links, assets, task state, title/tag authority, and app semantics explicitly. When a legacy ID parses as a UUID in noncanonical spelling, preserve the UUID value and emit canonical lowercase hyphenated spelling. When a legacy ID is not a UUID, allocate UUIDv7 and preserve the original as a user property (conventionally `legacy_id`).
- Export does not change canonical source and SHOULD state the exact target dialect.

## 15. Change governance

The standard repository is the source of truth. A change is complete only when it updates, as applicable:

1. this specification;
2. the parsed-envelope schema (`envelope-2.schema.json`) and render policy (`render-policy-3.json`);
3. positive and negative fixtures for all body profiles, including v1 readability cases;
4. adoption or migration guidance;
5. participating implementations and their pinned corpus revision.

No single app implementation silently defines the standard. When the specification and an implementation differ, report the difference and change one deliberately; do not normalize the conflict away.

## Appendix A: minimal canonical Markdown document

```text
---
format: pdc-document/2
body: pdc-markdown/1
id: 018f47c6-4a77-7c52-9db8-0e5f9bcb17db
created: 2026-09-14T12:34:56.789Z
updated: 2026-09-14T12:34:56.789Z
title: First document
---
# First document

This body is portable Markdown, Obsidian-compatible.
```

## Appendix B: minimal canonical HTML document

```html
<!--
---
format: pdc-document/2
body: pdc-html/1
id: 018f47c6-4a77-7c52-9db8-0e5f9bcb17db
created: 2026-09-14T12:34:56.789Z
updated: 2026-09-14T12:34:56.789Z
title: First HTML document
---
-->
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>First HTML document</title></head>
<body><h1>First HTML document</h1><p>This source remains browser-readable.</p></body>
</html>
```

## Appendix C: the 100% guarantee

For this standard, "100% compatible" means every fully conforming app can find, identify, parse, safely present, link, and preserve every conforming Markdown and HTML document — and every readable PDC 1 legacy document — without silent loss. An app may lack an optional execution or editing feature, but the source remains readable and intact. Files outside the contract — plain Markdown, unmarked or unsafe legacy HTML, malformed documents, and newer major versions — must still be visible as legacy, invalid, or unsupported rather than disappearing.
