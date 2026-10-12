# Oximemo UI adoption

Follow the repository-root AGENTS.md and PDC migration instructions. This app
adopts Garden UI only. Read `docs/decisions/0001-garden-ui-integration.md` and the
manifest exceptions before changing the shell, palette, native host or modal
ownership. Existing document adapters and guarded writes remain authoritative.

Import controls from the public `@garden/ui` API. Keep framework source managed
and unchanged. `src/garden-adapter.css` is the app-owned visual adapter. Product
copy lives in `locales/en.json` and `locales/ko.json`; the old TypeScript locale
paths export typed compatibility bindings.

Use `bun run build`, relevant Bun tests, Garden sync and doctor. The owner
authorized native verification and exact Rust pin alignment; doctor is healthy.
Retain the custom host and permissions through the recorded exception. Changes
to native code require locked Rust tests and Clippy with warnings denied.
