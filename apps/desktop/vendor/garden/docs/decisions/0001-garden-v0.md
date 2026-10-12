# ADR 0001: garden v0 boundaries

Status: accepted

The existing checkout remains named garden-ui to preserve local project identity; the repository product and packages are garden. React is the sole active UI implementation. SwiftUI is archived at a local Git tag before removal. EXPERIENCE.md and extraction records are historical evidence and retain their original language.

The latest mission explicitly requires Markdown-first documents. Adopt PDC 2 Markdown and first-class HTML, with PDC 1 Djot and HTML as read-only legacy inputs. This supersedes the older personal-default wording that selected PDC 1 for new documents. Vendor the upstream standards, schemas, licenses, and conformance corpus. Do not invent a Garden document dialect or query language.

The editor is a library in v0: applications compose it within their own shell. A standalone knowledge app is a roadmap item, not an additional product to maintain before the shared contracts stabilize.

Projects vendor a coherent framework snapshot instead of referencing a private package registry. garden.json remains the small adoption manifest; generation provenance and file hashes are separate lock metadata. Updates require a target snapshot and migration notes, and refuse to overwrite changed managed files.

Rust hosts native window operations and supervision. Bun hosts the domain-neutral daemon. Browser-only UI remains independent of native APIs. The original three token vocabularies and blue --accent decision remain unchanged.

Swift archive: local annotated tag `archive/swiftui-v0`, source commit `85d9888`. No remote push was performed.
