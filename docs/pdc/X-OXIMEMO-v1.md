# `x_oximemo` Extension Registry — v1

Status: frozen at Stage 0 (`docs/PDC-MIGRATION.md`) · 2026-09-14
Contract: `pdc-document/1`, corpus revision 3, namespaces per PDC §5.3

Oximemo is the only Writer allowed to create or reinterpret values in
the `x_oximemo` namespace. Every other participating app MUST preserve
the map verbatim. This registry freezes the key and attribute names
Oximemo writes; additions are append-only and compatible, while renames
or removals are standard changes requiring a migration report.

## Envelope keys (`x_oximemo.*`)

Values obey the constrained envelope grammar: Booleans, single-line
strings, flat string sequences, or literal block strings. A key ending
in `_json` holds an opaque literal-block string containing UTF-8 JSON;
only Oximemo interprets its contents, and every other app preserves the
exact string (PDC §5.3).

| Key | Value | Rule |
|---|---|---|
| `legacy_id` | single-line string | Original pre-PDC memo identifier, preserved when an import allocated a new UUIDv7. UUID-valued legacy IDs keep their value instead and do not get this key. |
| `<original key>` | scalar or flat string list | Unrecognized legacy memo properties ride their original names verbatim under `x_oximemo`. |
| `<original key>_json` | literal block string | Complex legacy property values are encoded as opaque JSON and never flattened. |

## Body attributes (`data-x-oximemo-*`) and classes (`x-oximemo-*`)

Names follow PDC §6.2. Attributes carry app-specific semantics only
when a feature needs them; the surrounding readable text is always the
fallback and must survive with the attribute removed (PDC §9.3).

| Attribute | Applies to | Rule |
|---|---|---|
| `data-x-oximemo-width` / `data-x-oximemo-height` | images | Legacy Oximemo width/height hints preserved during asset migration when standard HTML attributes cannot hold them. |
| `data-x-oximemo-task-status` | task items | Original status token of a preserved Oximemo status family; the canonical open/completed state stays in the PDC task construct. |
| `data-x-oximemo-task-start` / `-due` / `-done` | task items | Legacy date values preserved verbatim. |
| `data-x-oximemo-task-priority` | task items | Original priority token. |
| `data-x-oximemo-task-recurrence` | task items | Original recurrence expression. |
| `data-x-oximemo-task-warning` | task items | Original warning flag or text. |
| `data-x-oximemo-task-line-hash` | task items | Legacy line hash used for reconciliation with pre-migration indexes. |

Task-specific attributes are stable only on items that carry a `pdc-task`
identity (PDC §9.1). Plain task items MUST NOT accumulate them.
