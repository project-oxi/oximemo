# Garden CLI and personal plugin

Date: 2026-09-27

Status: accepted

## Decision

Provide a local `garden` executable and a personal Codex/OMP plugin with the Garden
skill and a bundled framework snapshot. The executable owns deterministic
creation, adoption setup, generation, verification and snapshot updates. The
skill owns app-specific semantic migration: integrate the real UI/native/service
paths and preserve the existing product and its user data.

The default source is the installed CLI's checkout; an explicit source path or
`GARDEN_SOURCE` selects another snapshot. A bundled plugin works without that
checkout or global executable. Current adopted contracts remain authoritative
until an intentional update.

Initial adoption preserves domain code and existing configuration, merges
framework infrastructure, and reports incomplete integration. It never declares
the app migrated solely because manifest generation succeeded. The skill must
finish the requested code changes and exercise the changed running paths.

Personal development updates compare content as well as versions. Same-version
changes remain guarded by snapshot integrity, transactional replacement and
retained recovery copies. No public registry or release publication is required.

Codex and OMP use the same skill directory and bundled framework. Codex discovers
the `.codex-plugin` manifest through the personal marketplace; OMP links the
private package manifest and discovers its `skills` directory. Neither host needs
a separate standard or a model-specific copy of the migration instructions.
