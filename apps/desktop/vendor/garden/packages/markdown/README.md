# `@garden/markdown`

Portable Document Contract 2 Markdown document and read-only Bases query primitives for garden. The shared normative source, generated envelope/query metadata, and revision 2 conformance corpus are under [`contracts/markdown`](../../contracts/markdown/README.md).

The main browser-safe entry point is intentionally a pure string API. It does not perform migration, vault discovery, or rendering. `patchMarkdownEnvelope` compares an optional opening source snapshot before producing a new string and only edits canonical PDC 2 Markdown metadata. The Node/Bun-only `@garden/markdown/storage` subpath provides digest-guarded atomic replacement for an existing regular file; callers validate PDC content before using it, and the adapter does not claim full PDC Writer conformance.
