# Desktop contribution checks

Follow the repository-root AGENTS.md, generated desktop routing, local additions
and the selected Garden contracts. Consult the UI integration ADR before changing
the shell, palette, modal ownership or native host.

Use public Garden APIs. Keep product text in the paired JSON catalogs and retain
localized accessible names. Do not edit managed or generated framework files.
Document format and persistence changes follow the PDC skill and staged migration.

Run `bun run garden:sync`, `bun run garden:doctor`, `bun run build` and relevant
Bun tests. Exercise the changed path in the running application, including compact
layouts and keyboard focus. Record actual evidence and known doctor limitations
in the integration assessment. Native host changes also require
`cargo test --locked -p oximemo-desktop --lib` and
`cargo clippy --locked -p oximemo-desktop --all-targets -- -D warnings` from
the desktop directory. Do not claim native behavior from browser samples.
