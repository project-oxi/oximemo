# AGENTS.md — oximemo

## Priority 1 — Portable Document Contract migration

- Unless the user explicitly overrides priority, completing the staged plan in `docs/PDC-MIGRATION.md` is this repository's highest-priority document-plane initiative. Advance the earliest incomplete safety gate before starting a competing note-format, editor, renderer, link, asset, indexing, or migration redesign.
- Before changing durable user-document storage, discovery, parsing, editing, rendering, links, assets, tasks, deletion, synchronization, or migration, load and follow the installed `portable-document-contract` skill. The canonical external specification wins over assumptions in this repository; report a conflict and update one deliberately.
- Oximemo is a Full Reader and a Djot-and-HTML Writer/Mutator. `.djot` with `pdc-djot/1` and marked `.html` with `pdc-html/1` are parallel canonical formats. HTML remains first-class and must never be converted to Djot merely for uniformity.
- Keep existing Markdown and unmarked HTML visible through legacy adapters during migration. Never bulk-convert, replace, delete, normalize, or silently repair user files on read, indexing, application launch, or upgrade. Conversion requires a new target, backup, machine-readable per-document report, and explicit user authorization.
- Preserve unknown envelope fields, extension maps, body source, stable IDs, and unsupported constructs. If a write path cannot do so, make that document read-only. Every write is atomic and guarded by the source bytes or digest captured when editing began.
- Repository documentation, source comments, prompts, logs, caches, generated previews/reports, and database indexes are outside PDC unless explicitly promoted to the shared document plane.
