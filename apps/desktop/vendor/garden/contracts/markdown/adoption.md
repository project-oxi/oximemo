# Adopting Portable Document Contract 2

Read the normative specification ([`PDC-2.0.md`](PDC-2.0.md)) first. This guide explains how to apply the canonical body profiles without broadening the shared document plane, and how to coexist with frozen PDC 1 documents.

## Decide whether the standard applies

PDC applies when an app persists durable text that a person understands as a note or document and another participating app may open, index, edit, link, embed, or migrate.

It does not automatically apply to:

- `README.md`, `AGENTS.md`, design docs, changelogs, and source-controlled prose;
- prompts, logs, telemetry, queues, immutable event ledgers, database-only records, and caches;
- generated previews, reports, and temporary editor state;
- Markdown, HTML, or Djot accepted only as import or emitted only as export.

If a document-like record must remain in a database for product reasons, expose a PDC adapter only when cross-app interchange is required. Do not force the internal database schema to mimic files.

## Choose a body profile

- Use `pdc-markdown/1` and lowercase `.md` for ordinary notes, knowledge documents, task-bearing prose, and Obsidian-compatible content. It is the default profile of PDC 2.
- Use `pdc-html/1` and `.html` when authored HTML structure, layout, or inline CSS is part of the source's value. HTML is not a generated preview and is not second-class.
- Do not invent app-specific canonical Markdown, HTML, JSON, or rich-text dialects. Extend PDC through user properties and readable fallbacks. Executable queries belong exclusively to `pdc-query/1` (`.base` files and fenced `base` code blocks).
- Conversion between profiles — including any conversion out of legacy PDC 1 Djot or HTML — is an explicit migration/export, never an automatic save behavior.

A full PDC 2 Reader reads all canonical profiles **and** all legacy PDC 1 documents. A Writer declares which profile or profiles it creates and never writes `.djot` or `pdc-document/1` envelopes. A Mutator may edit one profile and keep the others read-only while preserving and safely presenting them.

## New applications

1. Choose Full Reader, Writer, and profile-specific Mutator capabilities.
2. Discover lowercase `.md`, `.html`, and `.djot` files according to the vault rules, plus `.base` files when the vault manifest declares `pdc-query/1`. Classify plain Markdown and unmarked HTML visibly as legacy; classify PDC 1 documents as readable legacy.
3. Parse the safe general YAML envelope, then dispatch to exactly the declared `body` profile. Preserve every user property losslessly.
4. Resolve document links by UUID where used, relative and wiki links inside the vault, and managed assets by digest. Never use paths, titles, or app-local database IDs as canonical identity.
5. Use a Markdown-aware or plain source editor for Markdown. Use a source-preserving HTML editor for HTML. A structural editor must retain unsupported source constructs or downgrade to read-only.
6. Sanitize every preview. Raw Markdown HTML and PDC HTML use an isolated view with scripts, event handlers, forms, popups, navigation, and unapproved subresources disabled; sanitization never rewrites stored source.
7. Preserve unknown extension metadata and unsupported constructs. If lossless preservation is impossible, require an explicit conversion to a new target.
8. Run the shared `pdc-document-conformance/2` revision 2 fixtures — including the legacy v1 readability cases — in the app's native stack.

## Existing applications

Use this order:

1. Inventory transports, metadata, links, assets, semantic extensions, discovery rules, security policy, and editor round-trip behavior.
2. Add a Full Reader for PDC 2 Markdown and HTML **and** for legacy `pdc-document/1` Djot and HTML, without changing existing files.
3. Make invalid `.md`/`.djot`, canonical/legacy `.html`, plain Markdown, unsupported versions, and invalid queries visible instead of silently skipping them.
4. Write PDC 2 for newly created documents using the product-appropriate body profile while retaining legacy readers and writers during the compatibility window.
5. Add explicit importers from each legacy format. Legacy HTML that already meets the safe-authored profile may migrate to `pdc-html/1` under a `pdc-document/2` envelope without body conversion. Legacy Djot is readable forever; converting it to Markdown is an explicit, user-authorized operation.
6. Recalculate format-derived indexes such as tasks, tags, headings, links, and body hashes from the selected canonical body; never carry projections from another dialect forward as authoritative.
7. Offer per-document or user-authorized batch conversion with backup and a machine-readable loss report. Conversion is new-target-first; source replacement happens only after the user accepts the report.
8. Retire a legacy writer only after shared fixtures and representative real-vault tests pass in every participating application.

Never rewrite a vault merely because an app was upgraded. Opening and closing an untouched document leaves every byte unchanged — for PDC 2 and PDC 1 alike.

## Editor and preview integration

### Markdown

- CommonMark-plus-GFM is the base grammar. Obsidian-compatible wiki links, embeds, callouts, highlights, comments, math, footnotes, tags, and caret block IDs are recognized compatibility syntax: preserve byte-for-byte, render readably, never rewrite into different syntax.
- An editor that cannot preserve a construct (for example a lossy DOM round trip of raw HTML or fence info strings) must downgrade to source-only or read-only.
- Fenced `base` code blocks follow `pdc-query/1`: show them as content unless the query contract is implemented.

### HTML

- Preserve the raw body source; DOM serialization is not a harmless round trip.
- A source-only editor is conforming. A visual editor is conforming only when comments, unknown elements and attributes, whitespace, and ordering survive or the user explicitly accepts a new converted target.
- Render through sanitization and isolation. Inline CSS may remain useful inside the sandbox, but external CSS, fonts, imports, and CSS URLs require explicit app policy.

### Legacy Djot

- Legacy `pdc-djot/1` documents stay byte-stable. A viewer renders them read-only through a Djot renderer or a readable source fallback; an editor that cannot round-trip Djot must not open them for editing.

### All profiles

- Preview parity means the same document structure and core semantics, not identical CSS.
- Link clicks, embeds, tasks, query blocks, and asset URLs go through PDC resolvers; custom URI schemes are never handed directly to a browser engine.
- Editing starts from a source-byte snapshot or digest and checks it before replacement.

## Existing product roles

- **Oximemo:** Full Reader; Markdown and HTML Writer/Mutator. Keep HTML first-class; write Markdown for ordinary notes. Read legacy PDC 1 Djot and HTML in place; migrate selectively with explicit, authorized conversions only.
- **Sawhorse:** Full Reader; Markdown and HTML Writer/Mutator for authored documents only. Keep workflow ledgers, runtime state, approvals, caches, and generated evidence outside the document plane. Prefer PDC HTML for compatible `shdoc/1` material when preserving authored HTML semantics is safer than converting.
- **Oxibrain:** Full Reader/indexer through connectors only. Never write or migrate the user's vault.
- **Farm:** no current document-plane migration. Re-run the scope gate before introducing a durable shared user document.
- **Lexi:** keep SQLite as product storage. Add explicit Markdown import/export only when dictionary entries are deliberately promoted for cross-app interchange.

## Repository integration

Each participating repository keeps a migration or adoption document that states its role, in-scope data, mappings, stages, safety gates, and completion criteria. Its root `AGENTS.md` marks that plan as the highest-priority document-plane initiative unless the user explicitly overrides it.

Use wording equivalent to:

> Portable Document Contract adoption is the repository's highest-priority document-plane initiative. Before changing durable user-document storage, discovery, parsing, editing, rendering, linking, assets, indexing, or migration, load the `portable-document-contract` skill and follow the repository migration plan. Do not convert or rewrite user files — including legacy PDC 1 documents — without the plan's explicit gates and user authorization.

Pin tests to the fixture corpus revision used by the app (`pdc-document-conformance/2` revision 2 or later). When the standard changes, update parser, writer, migration, and corpus revision coherently.

## Review checklist

- Does every Full Reader find the same valid `.md` and PDC `.html` files — and the same readable `.djot` legacy files?
- Are plain Markdown and unmarked HTML visible as legacy rather than silently skipped?
- Does every invalid or unsupported file produce an actionable diagnostic?
- Are identity, links, and assets independent of filenames and local databases?
- Are metadata-only edits body-byte-preserving for all profiles, including YAML comments and user properties?
- Are raw HTML and PDC HTML previews isolated without mutating source?
- Are unknown user properties and source constructs preserved or the document made read-only?
- Are writes atomic and guarded against external changes?
- Can legacy import report every lossy, unsafe, ambiguous, or externalized transformation before replacing a source?
- Do Rust, TypeScript, Swift, and other implementations consume the same fixture revision?
