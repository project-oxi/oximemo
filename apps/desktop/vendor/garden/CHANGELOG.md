# Changelog

## 0.1.0

Initial garden framework: React desktop surfaces, portable document editing, Bun daemon mechanisms, vendored project generation, and reproducible contract checks.

The `garden-personal/1` standard now defines the stack, application layout,
prohibited UI/copy patterns and recorded per-app exceptions. The shared shell
provides pane toggles and the upper-right command launcher. Desktop starters use
the complete PDC document editor, and `GDocumentProperties` exposes the shared
property surface independently. `garden doctor` verifies the profile, exception
records and applicable stack/native configuration in addition to existing checks.

The local `garden` executable now provides short creation commands, existing-app
adoption with dry runs, project-aware run/build/test commands and automatic source
selection. Updates compare same-version snapshot contents and retain recovery
history. A self-contained personal Codex Desktop/OMP plugin bundles the Garden migration
skill, CLI and framework contracts.

Update preflight health checks run through the installed snapshot's own CLI, so a
project on a snapshot predating the framework contract can still update; when the
target framework contract declares a profile and the manifest lacks `standards`,
update adopts `{profile, exceptions: []}` from that contract.

The multi-workspace shell contract now distinguishes the persistent primary
`GActivityRail` from the independently collapsible contextual `GNavigation`
sidebar. The desktop starter's one-level navigation is documented as a
single-workspace example, and the Garden adoption skill requires the paired
composition for multi-workspace products.

The playground now demonstrates that hierarchy as the executable reference: its
activity rail selects the major workspace (Showcases, Documents, Reference) and
the sidebar lists only the selected workspace's destinations, resuming the last
destination per workspace. The framework contract, UI contract and adoption
skill all state that rail and sidebar are different levels of classification
and forbid flattening workspaces into one sidebar list.

Framework review hardening: `garden sync` now applies the same project-local
directory and write guards as `init`/`update` (refusing symlinked `AGENTS.md`
and `vendor/garden`), `garden doctor` flags non-regular entries and untracked
files inside the managed tree instead of silently skipping them and now reports
malformed JSON with file paths instead of aborting, updates stage the recovery
backup before rotating history, query summaries no longer read from unrelated
documents when a view matches no rows, daemon RPC dispatch ignores prototype
keys, and task-metadata removal consumes at most one separator per side as
documented. The managed lock is documented as drift detection, not
authentication of untrusted projects.
