# Oximemo documentation

This index separates current product guidance, document-contract requirements, accepted decisions, and dated design records.

## Project guidance

- [README](../README.md) — product overview, installation, and quick start.
- [CONTRIBUTING](../CONTRIBUTING.md) — development and contribution workflow.
- [CHANGELOG](../CHANGELOG.md) — release history.
- [AGENTS.md](../AGENTS.md) — repository-specific agent routing and safety priorities.

## Product and design references

- [Product and data design](../doc/DESIGN.md) — dated v0.2 architecture reference.
- [Unified design system](../doc/UNIFIED-DESIGN.md) — historical Oxi ecosystem design snapshot.
- [Production-readiness report](../doc/PRODUCTION_READINESS.md) — historical assessment dated 2026-07-29, not current release status.
- [Updater architecture](../doc/UPDATER.md) — proposed RFC; verify shipped behavior against the release workflow and changelog.
- [Agent CLI guide](../skills/oximemo/SKILL.md) — command contract for coding agents.

## User guide

- [Session recorder](SESSION-RECORDER.md) — imports, opt-in automatic collection, provider consent, review, and local data boundaries.

## Document contract

- [PDC migration plan](PDC-MIGRATION.md) — normative implementation stages and preservation gates.
- [Legacy `x_oximemo` registry](pdc/X-OXIMEMO-v1.md) — frozen mapping for legacy PDC 1 data.
- [Migration report schema](pdc/migration-report-v1.schema.json) — machine-readable per-document conversion findings.

## Accepted decisions

- [Session collection boundaries](decisions/0001-session-collection-boundaries.md) — export, Codex hook, and Git metadata scope.

## Design and implementation records

- `docs/superpowers/specs/` — dated product and interaction specifications.
- `docs/superpowers/plans/` — dated implementation plans.
- `docs/superpowers/notes/` — investigation notes.
- `docs/superpowers/mockups/` — visual prototypes.

The dated records provide historical context. Current data-format requirements are in the PDC migration plan; accepted architecture decisions are in `docs/decisions/`.
