# PDC 2 source contract

Use this reference when inspecting source boundaries, constructing a body
edit, or explaining a legacy/unsupported source. The authoritative standard
is [Portable Document Contract 2](https://github.com/a7garden/portable-document-contract/blob/main/references/PDC-2.0.md),
with the separately versioned
[PDC Query Contract 1](https://github.com/a7garden/portable-document-contract/blob/main/references/PDC-QUERY-1.0.md).
Oximemo pins upstream `0ee51ea` (`v2.0.0-draft.2`), corpus
`pdc-document-conformance/2` revision 2. Repository `AGENTS.md` and
`docs/PDC-MIGRATION.md` govern implementation work; a planned role is not
proof that every shipping CLI mutation already meets the contract.

## Envelope and transport

The CLI writes the envelope. Do not construct or replace it by hand during
ordinary note operations. Minimal canonical Markdown has this shape:

```markdown
---
format: pdc-document/2
body: pdc-markdown/1
id: 018f47c6-4a77-7c52-9db8-0e5f9bcb17db
created: 2026-09-14T12:34:56.789Z
updated: 2026-09-14T12:34:56.789Z
title: Concurrency notes
tags: [rust]
review:
  status: stub
---
# Concurrency notes

Cancellation is cooperative.
```

Markdown starts at byte zero with an exact `---` line; another exact `---`
line closes the envelope. The remainder is the body, including any leading
blank line. HTML starts with exact lines `<!--`, `---`, then its YAML
envelope, then exact lines `---`, `-->` followed by a line ending. The HTML
body begins after that line ending. Its `body` value is `pdc-html/1`.
HTML can be an authored fragment or a complete document; do not wrap an
existing fragment. HTML envelope values must not introduce literal `-->`
or `--!>` before the closing wrapper; let the writer validate them.

Canonical sources are UTF-8 without BOM, at most 4 MiB. Writers create LF;
readers accept LF and CRLF without rewriting untouched files.

Required fields are `format`, `body`, `id`, `created`, `updated`, and `title`.
New IDs are lowercase hyphenated UUIDv7; migrated valid UUID versions remain
readable. Canonical timestamps are UTC `YYYY-MM-DDTHH:MM:SS.sssZ` with exactly
three fractional digits. `updated` cannot precede `created`.

Known optional keys are `profile`, `lang`, `tags`, `aliases`, `cssclasses`,
`favorite`, `deleted`, and `deleted_at`. A nonempty stored `title` wins over
body headings; an empty title falls back to the first Markdown H1 (HTML H1,
then HTML title) and finally filename stem. `tags` is a duplicate-free
string sequence. `deleted_at` is present exactly when `deleted` is true.

New/full canonical writes order known fields as:
`format`, `body`, `id`, `created`, `updated`, `title`, `profile`, `lang`,
`tags`, `aliases`, `cssclasses`, `favorite`, `deleted`, `deleted_at`, then
user properties in observed order. This does not authorize reordering an
existing envelope.

The envelope uses safe general YAML 1.2 Core: a single mapping with unique,
nonempty string keys and JSON-compatible values. Comments and nested
maps/sequences are allowed (depth cap 32, node cap 10,000). Anchors, aliases,
explicit/custom tags, complex keys, duplicate keys, multi-document streams,
nonfinite numbers, and tabs in indentation are forbidden. Every unknown
top-level key is a user property; there is no reserved `x_` namespace.
Preserve value types, nesting, comments, quoting, spelling, and ordering.

## Body and partial edits

Markdown uses CommonMark 0.31.2 plus GFM tables, task lists, strikethrough,
and autolinks. Preserve wiki links/embeds, callouts, highlights, source
comments, math, footnotes, inline tags, caret block IDs, raw HTML, and code
fence info strings. Unsupported syntax stays readable and unchanged.

Only `[ ]`, `[x]`, and `[X]` have standard task semantics. Other markers,
dates, priorities, and recurrence syntax are preserved Oximemo extensions;
do not normalize them into standard states. Stable caret IDs use
`[A-Za-z0-9-]+`; HTML targets use `id="b-<uuid>"`. Preserve assigned targets
and report duplicates before any write.

A title-only patch preserves the entire body and every untouched envelope
line byte-for-byte. A body-only edit preserves envelope values and untouched
source spelling. No-op reads and saves preserve every byte and do not advance
`updated`. An edit must compare the whole source with the digest retained
when editing began and write atomically; refreshing a digest without
reconciling an old replacement is an overwrite, not conflict recovery.

## Discovery, links, and queries

PDC discovery includes lowercase `.md`, `.html`, legacy `.djot`, and declared
`.base` queries; it skips dot-prefixed components and symlinks. Canonical
tombstones remain visible in `_trash/`. Consult `pdc list` for complete
classification instead of inferring visibility from an index or frontmatter
presence. Malformed, unsupported, and legacy sources must remain visible
with diagnostics.

Relative vault links/assets, wiki links/embeds, and `pdc://document/<uuid>`
links are supported forms. Resolution stays inside the vault. Never rewrite
unresolved links to guessed targets or change identity when renaming/moving.
Optional managed assets use `pdc://asset/sha256/<64-hex>` and
`.pdc/assets/sha256/<first-two-hex>/<64-hex>`; stored bytes must match the
digest. No automatic network fetch for indexing or asset garbage collection.

`pdc-query/1` is enabled by `"query": "pdc-query/1"` in `.pdc/vault.json`.
Its transports are lowercase `.base` and Markdown fences with info string
exactly `base`. Queries and unknown constructs remain source-preserved and
unexecuted by Oximemo's PDC reader. A query cannot authorize a mutation.

## Legacy and unsupported sources

`pdc-document/1` with `pdc-djot/1` or `pdc-html/1` is readable legacy. Plain
Markdown and unmarked HTML are visible legacy too. Do not add PDC markers,
normalize frontmatter, convert Djot, repair diagnostics, or save these files
in place as a side effect of reading/searching/upgrading.

Explicit conversion needs a backup, a new canonical target, and a
machine-readable per-document loss report before user-authorized source
replacement. Keep canonical-to-canonical candidates outside active discovery
until replacement to avoid duplicate document IDs. If lossless editing or
the required guarded CLI operation is unavailable, retain read-only access
and report the limitation.
