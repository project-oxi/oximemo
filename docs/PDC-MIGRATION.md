# Portable Document Contract Migration

Status: priority 1 · Stage 0 complete (2026-09-14): corpus revision 3 pinned and executed in Rust + frontend; `x_oximemo` keys and the migration-report schema frozen  
Standard: `portable-document-contract` draft 4 (`pdc-djot/1` + `pdc-html/1`)  
Contract: `pdc-document/1`, corpus revision 3  
Target capabilities: Full Reader; Djot Writer/Mutator; HTML Writer/Mutator

This is the authoritative migration plan for Oximemo's durable user-authored note plane. The canonical external contract lives in the `portable-document-contract` repository. If this plan and the contract disagree, stop and update one deliberately before changing note bytes.

## Invariants

1. HTML remains a first-class authored format. It is never demoted to generated preview or forced through Djot.
2. Existing `.md` and unmarked `.html` notes remain readable throughout migration.
3. Opening, indexing, or upgrading never converts a note.
4. Conversion writes a new target until the user reviews its machine-readable report and explicitly authorizes replacement.
5. Unknown envelope data and unsupported body source survive every write, or the document becomes read-only.
6. Files are source of truth; indexes, previews, derived tags, tasks, and link graphs are rebuilt projections.

## Current state

- Notes are `.md` or `.html`; format is derived from extension.
- Both use `oxi-frontmatter` constrained YAML. HTML wraps the envelope in a leading comment.
- IDs are UUIDv7. `created`, `updated`, `favorite`, a deletion timestamp, aliases, and arbitrary properties already exist.
- The merge writer preserves unknown keys and performs atomic replacement, but the desktop note-save API does not carry the source digest captured when editing began.
- Markdown preview uses Marked/GFM plus Oximemo preprocessing. HTML uses a CodeMirror source editor and a DOMPurify-sanitized sandboxed preview.
- Links use `[[title]]`/aliases, assets use `oximg:` plus a short BLAKE3 name, tasks include richer Oximemo status/date/priority/recurrence semantics, and deleted files currently move under `.trash`.

## Target formats

### Djot

- Extension: `.djot`
- Body profile: `pdc-djot/1`
- Transport: the PDC `---` constrained envelope followed by Djot body source
- Use for ordinary notes and task-bearing prose.

### HTML

- Extension: `.html`
- Body profile: `pdc-html/1`
- Transport: the PDC constrained envelope wrapped in the exact leading `<!--` / `-->` transport
- Use when HTML structure, layout, or inline CSS is part of the authored source.
- Preserve body bytes during envelope-only migration. Existing source and split/preview editing remain product features.

### Legacy

- `.md` stays legacy Markdown until explicit conversion to a new `.djot` target.
- An `.html` file without the PDC transport stays visible legacy HTML. It may be upgraded to PDC HTML without body conversion when it passes the HTML safety/profile checks.
- Body-only, malformed, unsupported, and oversized files must be visible with diagnostics; they are never silently omitted.

## Field and semantic mapping

| Current Oximemo value | PDC target | Rule |
|---|---|---|
| memo UUID | `id` | Preserve the UUID value and canonical spelling. |
| `created` / `updated` | same names | Normalize to UTC with exact millisecond precision. |
| derived H1/title | `title` | Import as empty when current fallback behavior must remain dynamic; otherwise store the reviewed title. |
| inline derived tags | `tags` | Snapshot the current extracted tags at import. In canonical documents the envelope is authoritative; Oximemo may visibly synchronize body hashtags on a user save, never during indexing. |
| `favorite` | `favorite` | Direct Boolean mapping. |
| deletion timestamp | `deleted`, `deleted_at` | Timestamp becomes `deleted: true` plus normalized `deleted_at`; absence becomes false. |
| `aliases` property | `aliases` | Promote to the standard field. |
| other properties | `x_oximemo` | Preserve scalars/lists directly; encode complex values as an opaque `_json` literal string. |

## Links, assets, tasks, and deletion

### Links

- Canonical links use `pdc://document/<uuid>` in profile-native syntax.
- Resolve a legacy wiki link only when title/alias lookup has one unambiguous target.
- Ambiguous and unresolved links remain readable legacy text and appear in the loss report. Never apply the current oldest-note winner silently during conversion.

### Assets

- Read the original asset bytes, compute full SHA-256, create the PDC managed-asset path atomically, then rewrite the reference.
- Preserve original filename/media type hints. Preserve Oximemo width hints in standard HTML attributes where possible or `data-x-oximemo-*` otherwise.
- Missing files, hash conflicts, unsupported media, and resources over the PDC limit are reportable conflicts.
- Garbage collection scans Djot, PDC HTML, and legacy documents and uses recoverable quarantine.

### Tasks and queries

- Map open/completed state to the PDC core construct.
- Preserve status families, dates, priority, recurrence, warnings, and legacy line hash under `x_oximemo` body attributes or opaque extension data with readable text.
- Assign a stable block UUID only when a task or block needs identity; never assign IDs merely by reading.
- Legacy `query` fences become `pdc-query` only when their text can be preserved exactly. Execution remains governed by a separate query contract.

### Deletion

- Canonical soft-deleted documents remain in PDC discovery scope with `deleted: true`; do not move them under `.trash`.
- Existing `.trash` behavior remains a legacy adapter during the compatibility window.
- Purge remains an explicit destructive action and is never part of migration.

## Implementation stages

### Stage 0 — shared contract gate

- Pin the app to PDC corpus revision 3.
- Import all shared fixtures into Rust and frontend tests.
- Freeze `x_oximemo` keys and the machine-readable migration-report schema before converting data.

Exit: the contract, schema, profile transports, and expected diagnostics have executable tests.

### Stage 1 — Full Reader, no writes

- Add `.djot` and PDC HTML classification to scanner, watcher, CLI, and desktop.
- Parse the shared envelope before dispatching to Djot or HTML body handling.
- Surface invalid/unsupported documents and visible legacy HTML; remove body-only silent omission.
- Resolve PDC UUID links and verify managed assets without modifying files.

Exit: opening and closing every fixture is byte-identical; duplicate IDs across `.djot` and `.html` are visible.

### Stage 2 — canonical creation

- Add an explicit new-note format choice: Djot or HTML. Keep legacy writers available only for existing legacy files.
- Create `.pdc/vault.json` before the first canonical write.
- Add `TEMPLATE.djot`; retain `TEMPLATE.html` for canonical or legacy HTML according to its envelope.
- Use a Djot-aware or plain source editor plus sanitized preview. Keep the existing HTML source/split/preview experience and bring it under the PDC HTML render policy.

Exit: new Djot and HTML notes pass corpus round-trip, sanitizer, link, asset, and task tests.

### Stage 3 — conforming mutation

- Return a source digest with every document read and require it on every body or metadata update.
- Block, merge with an explicit report, or create a conflict copy when source bytes changed externally.
- Ensure no-op, metadata-only, and body-only writes meet byte-preservation rules for both profiles.
- Route all canonical note writes through the merge writer and atomic replacement path.

Exit: external-change and byte-preservation fixtures pass through CLI and desktop save paths.

### Stage 4 — dry-run importers

- Implement separate importers for current Markdown and current HTML.
- Inventory every note without reading or rewriting unrelated vault state.
- Produce per-document JSON with `safe`, `ambiguous`, `unsafe`, `externalized`, and `unsupported` findings.
- Build the complete UUID, link, and asset mapping before writing any converted target.

Exit: representative copied vaults produce deterministic plans; source trees are unchanged.

### Stage 5 — user-authorized conversion

- Convert safe documents to sibling targets or a new vault.
- Keep original files and legacy readers until the user explicitly authorizes replacement.
- Rebuild all indexes from canonical body source and compare document counts, UUIDs, links, assets, tags, and task state.

Exit: all participating apps pass the same corpus revision and representative cross-app vault tests.

## Non-goals

- No automatic bulk conversion on application upgrade.
- No HTML-to-Djot policy; the formats remain parallel.
- No reuse of filename, path, title, or index key as canonical identity.
- No silent repair of malformed envelopes or unsafe HTML.
- No requirement for pixel-identical previews across apps.

## Verification

```bash
cargo fmt --all -- --check
cargo clippy -p oxi-frontmatter -p oximemo-core -p oximemo-cli -p oximemo-capture --all-targets -- -D warnings
cargo test -p oxi-frontmatter -p oximemo-core -p oximemo-cli -p oximemo-capture
cargo clippy -p oximemo-desktop --all-targets -- -D warnings
cd apps/desktop && bun run build
```

Migration-specific suites must additionally run the shared PDC corpus, copied-vault dry runs, cross-profile duplicate-ID tests, and Oximemo↔Sawhorse↔Oxibrain interoperability fixtures.
