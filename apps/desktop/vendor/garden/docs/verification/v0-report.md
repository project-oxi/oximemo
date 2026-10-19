# Garden v0 acceptance report

Verified locally on 2026-09-27. The checkout remains `garden-ui`; the product is Garden 0.1.0.

| Acceptance area | Delivered evidence |
| --- | --- |
| Monorepo and pins | All six package/build stages and playground build pass; Bun frozen-lockfile install passes; React 19.3.0, Tauri API/CLI/crate 2.12.0, tauri-build 2.7.0, Rust 1.98.1 are pinned. |
| Seven playbooks and agent routing | English normative rules in playbook; generated thin AGENTS.md; CLI lifecycle tests exercise generation, drift, sync, refusal, and version upgrades. |
| UI contracts and implementation | GAppShell, GTitleBar, GSettings, GCommandPalette; Codex source measurements plus live Cassette/Obsidian layout measurements; browser and native captures in renders. |
| Daemon mechanics | Ten boundary/process tests; real generated Bun service queue RPC lifecycle, same-socket Rust handshake/health, graceful shutdown; see service-run.md. |
| Markdown and editor | Vendored PDC 2 contract/schema/corpus, generated query capabilities, safe parsing/patching/query evaluation, atomic host adapter, Atomic 0.6.2 library integration, live CRLF Undo proof; see editor-run.md. |
| Generated projects | `.verification/v0-desktop` and `.verification/v0-service` install/build/run independently with vendored source; desktop has 68 passing document/editor tests; doctor intentionally rejects a changed version and recovers after byte-exact restoration. |
| Swift archive | Local annotated tag `archive/swiftui-v0` at `85d988877b2d77b4c2c118190ba89f403846bb73`; active Swift source removed; EXPERIENCE.md retained. |

The framework suite passes 81 tests. The final grouped-query fallback adds one assertion without changing that count. UI review caught and fixed focus propagation, palette keyboard behavior, Atomic light-mode contrast, frontmatter being misread as a setext heading, CRLF history loss, native Settings identity, and minimized-window recovery. Document review caught and fixed delimiter construction, adjacent-property deletion, unsafe YAML coercion, and unsupported-expression execution. Daemon review fixed stale-lock races, lease-expiry validation, shutdown handler tracking, and UTF-8 frame decoding.

## Design decisions

- Keep the existing checkout path, migrate active implementation to React, and preserve Swift through a local archive tag.
- Use PDC 2 rather than inventing a Garden document dialect; keep HTML first-class in the standard while the v0 editor/metadata mutator targets Markdown and other profiles remain readable source.
- Add separate `@garden/markdown`, `@garden/editor`, and `@garden/native` packages to separate parsing, editing, and host commands.
- Provide the editor as a library. Compose Atomic's public CodeMirror extensions; no upstream fork is necessary for this slice, and its MIT attribution is retained.
- Vendor a coherent source snapshot and its documentation into each project. The small manifest records adoption; a separate hash lock records managed files.
- Use deterministic local command generation instead of making prerelease Specta a required dependency. Record an exact-pin/comparison route for future adoption.
- Use native macOS decorated overlay windows so AppKit owns corner curvature, shadow, and traffic lights. Fields use caret plus neutral surface focus; keyboard controls retain a visible monochrome cue. This owner-requested adjustment preserves all color token values and the three vocabularies.

See ADRs 0001–0003 for rationale and sources.

## Material limits

This is a tested v0, not a claim of full PDC Reader/Writer/Mutator conformance. HTML/Djot rendering and mutations, vault-wide duplicate IDs and asset resolution, and grouped Bases views remain explicit work; unsupported queries report `valid_unexecuted`. The template editor is an in-memory draft and does not silently persist user data.

Atomic replacement uses cooperative file locking and digest/inode checks. A writer that ignores the lock can still race the final check/rename boundary; the adapter does not claim cross-application compare-and-swap. Daemon writer locks protect cooperating kit processes, not arbitrary direct SQLite connections.

The native app was verified on this macOS host only and is unsigned. Vite reports a large-chunk warning, especially for the playground's preserved legacy gallery. Native screenshots include the operating system's capture badge. Theme diffs are evidence of theme changes, not an approved visual regression baseline.

No remote push or publication was performed. Farm was read only for this task; its five source files used for extraction remain unchanged against Git. Unrelated farm working-tree activity was observed and left untouched. Token changes are schema metadata and obsolete Swift annotations only; colors, spacing, radii, and the `--accent` decision are preserved.
