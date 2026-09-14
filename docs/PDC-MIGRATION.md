# Portable Document Contract Migration

Status: priority 1 · Stage 0 (v2) complete (2026-09-14): `pdc-document/2` classification, safe general-YAML envelope, `pdc-query/1` gate, and the unified conformance corpus exercised in both Rust and TypeScript.

Standard: `pdc-document/2` (upstream commit `0ee51ea`, tag `v2.0.0-draft.2`)

Corpus: `pdc-document-conformance/2` revision 2 (`pdc-document-conformance/1` r3 kept as the legacy pin)

Canonical profiles: `pdc-markdown/1` (lowercase `.md`) + `pdc-html/1`

Query contract: `pdc-query/1`, declared at vault level (`.pdc/vault.json` `"query"`); read-only, never executed here
Reference: `references/PDC-2.0.md`, `references/PDC-QUERY-1.0.md` in the `portable-document-contract` repository — it wins over this plan

This is the authoritative migration plan for Oximemo's durable user-authored
note plane. The v2 pivot replaces PDC v1's Djot-first design with a
Markdown-first contract while keeping every existing file visible and
byte-preserved.

## Invariants

1. Canonical ordinary documents are Obsidian-compatible lowercase `.md`
   with a safe general-YAML 1.2 Core frontmatter envelope. HTML remains a
   first-class authored format (`pdc-html/1`), never a generated preview.
2. Existing Djot/HTML and user files remain readable throughout migration:
   v1 documents (`pdc-djot/1`, `pdc-html/1` under `pdc-document/1`) are
   legacy-readable; unmarked `.md`/`.html` are visible legacy items.
3. Opening, indexing, previewing, or upgrading never converts or rewrites
   a note; no-op reads leave every byte unchanged.
4. Conversion writes a new target, requires a backup and a machine-readable
   report, and replaces the source only after explicit user authorization.
5. Unknown user properties (any JSON-compatible value) survive every write,
   or the document becomes read-only. Every write is atomic and guarded by
   the source bytes or digest captured when editing began.
6. Files are source of truth; indexes, previews, derived tags, tasks, and
   link graphs are rebuildable projections.

## Target formats

### Markdown (canonical)

- Extension: `.md`, lowercase; transport: `---` YAML frontmatter fences.
- Envelope: `pdc-document/2` + `body: pdc-markdown/1`; required
  `format/body/id/created/updated/title`; optional
  `profile/lang/tags/aliases/cssclasses/favorite/deleted/deleted_at`;
  every other top-level key is a user property, preserved losslessly.
- Safe general YAML only: single mapping document, nonempty string keys,
  JSON-compatible values; anchors/aliases/tags/complex keys/multi-doc
  streams/tabs forbidden; depth cap 32, node cap 10 000
  (`document_too_complex`); comments permitted and preserved by patches.
- Body: CommonMark 0.31.2 + GFM. Caret block IDs `^` + `[A-Za-z0-9-]+`
  (duplicates are `duplicate_block_id`); `pdc://document/<uuid>` and
  relative links/assets are first-class; raw HTML is source-preserved and
  preview-inert, with active constructs (`script`, event handlers,
  `javascript:`/`vbscript:`) reported as `unsafe_content`; fences whose
  info string is exactly `base` carry opaque `pdc-query/1` blocks.

### HTML

- Extension: `.html`; transport unchanged from v1 (`<!--` / `---` / `-->`)
  with the v2 envelope (`body: pdc-html/1`). Safe-authoring rules of v1
  §6.2 apply unchanged; the HTML body scan (unsafe elements, event
  handlers, `b-<uuid>` targets) is shared with the legacy path.

### Legacy

- `pdc-djot/1` is frozen at PDC 1 §6.1 and read through the v1 pipeline;
  `.djot` files are never created by v2 writers.
- Unmarked `.md` is plain Markdown (`legacy_markdown`); `.html` without
  the exact transport is legacy HTML (`legacy_html`); readable v1
  documents carry the legacy marker (`legacy_document_version`).
- Body-only, malformed, unsupported, and oversized files must be visible
  with diagnostics; they are never silently omitted or repaired.

## Query plane

`pdc-query/1` is declared at vault level, aligns with `.base` files and
`base` fences, and is classified read-only: safe-YAML validation,
`invalid_query` for malformed sources, `valid_unexecuted` for unknown view
types/keys (including non-portable `order`/`summaries` shapes — `order` is
a property-ref list, view `summaries` a mapping, equality spelled `==`).
There is no execution or authorization semantics in this repository.

## Field and semantic mapping

| Current Oximemo value | PDC v2 target | Rule |
|---|---|---|
| memo UUID | `id` | Preserve the UUID value and canonical spelling. |
| `created` / `updated` | same names | Normalize to UTC millisecond precision. |
| derived H1/title | `title` | Store the reviewed title; empty keeps dynamic fallback. |
| inline derived tags | `tags` | Snapshot extracted tags at import; envelope is authoritative. |
| `favorite` | `favorite` | Direct Boolean mapping. |
| deletion timestamp | `deleted`, `deleted_at` | `deleted: true` plus normalized `deleted_at`; present exactly together. |
| other properties | top-level user properties | Preserve scalars/lists/nested values verbatim; no reserved `x_` namespace in v2. |

## Implementation stages

### Stage 0 — shared contract gate (complete)

- Pin the app to `pdc-document/2`, corpus r2 (`8ac7a6b`→`0ee51ea` series,
  tag `v2.0.0-draft.2`); keep the v1 r3 corpus as the legacy pin.
- Rust classifier: v2 Markdown/HTML classification, safe general-YAML
  walker, Markdown body scan, `.base` query gate, byte-preserving
  metadata patches, guarded saves; unified corpus executed in
  `oxi-frontmatter`.
- Freeze the `x_oximemo` v1 registry as legacy-only and the
  `oximemo-pdc-migration-report/1` schema (`target_profile` gains
  `pdc-markdown/1`; `source_format` gains `pdc-djot-legacy/1`).

Exit: contract diagnostics, preservation operations, and both corpora
have executable tests. Remaining: TS mirror re-pointed to the v2 corpus.

### Stage 1 — Full Reader, no writes

- Add `.md`-classification, `.djot` legacy, and `.base` discovery to
  scanner, watcher, CLI, and desktop; parse the envelope before body
  dispatch; surface invalid/unsupported/legacy items with diagnostics.
- Resolve `pdc://` links and verify managed assets without modifying
  files; duplicate IDs across profiles are visible vault errors.

Exit: opening and closing every fixture is byte-identical; every
discovered file is canonical, legacy, or visibly diagnosed.

### Stage 2 — canonical creation

- New notes are v2 Markdown by default; HTML stays available for
  canonical or legacy HTML according to its envelope. Create
  `.pdc/vault.json` before the first canonical write (with optional
  `"query": "pdc-query/1"`).
- Canonical key order per PDC 2 §5.4; templates become `TEMPLATE.md`
  v2 documents; Markdown editing keeps source/preview split with the
  sanitizing render policy.

Exit: new Markdown and HTML notes pass corpus round-trip, sanitizer,
link, asset, and task tests.

### Stage 3 — conforming mutation

- Source digest with every read, required on every update; block, merge
  with an explicit report, or create a conflict copy on external change.
- No-op, metadata-only, and body-only writes meet byte-preservation for
  both profiles (comments, quoting, key order, user properties intact);
  all canonical writes route through the atomic merge writer.

Exit: external-change and byte-preservation fixtures pass through CLI
and desktop save paths.

### Stage 4 — explicit legacy conversion only

- Dry-run importers for v1 Djot/HTML and plain Markdown produce
  per-document `oximemo-pdc-migration-report/1` reports
  (`safe`/`ambiguous`/`unsafe`/`externalized`/`unsupported` findings)
  and full UUID/link/asset mappings before any write.
- Conversion is user-authorized, new-target-first, with rebuild-and-
  compare indexes; automatic or bulk conversion is forbidden.

Exit: representative copied vaults produce deterministic plans; source
trees unchanged until authorized replacement.

## Non-goals

- No automatic bulk conversion on application upgrade; no Djot writing.
- No reuse of filename, path, title, or index key as canonical identity.
- No silent repair of malformed envelopes or unsafe bodies.
- No query execution engine in this change; `pdc-query/1` stays a
  classification gate.
- No requirement for pixel-identical previews across apps.

## Verification

```bash
cargo fmt --all -- --check
cargo test -p oxi-frontmatter
cargo test -p oximemo-core pdc
cargo clippy -p oxi-frontmatter -p oximemo-core -p oximemo-cli -p oximemo-capture --all-targets -- -D warnings
cd apps/desktop && bun test src/lib/pdc/corpus.test.ts && bun run build
```
