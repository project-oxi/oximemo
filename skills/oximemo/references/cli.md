# Oximemo CLI workflows

Use `oximemo SUBCOMMAND --help` for the installed build's full flags. Carry
the selected `--vault` or `--space` through every command. The PDC source
and digest rules in `../SKILL.md` apply to all existing-document mutations.

## Runtime boundary

`pdc capabilities` reports `document_contract`, `body_profiles`, `writers`,
`guarded_source_update`, `memo_metadata_patch`, and `implicit_home_migration`.
Use named capabilities rather than a minimum version: older and newer local
builds may have the same package version. Recheck when the executable changes.

Current canonical creation paths are `pdc create`, `new`, collection templates,
and task capture. Existing source edits use SHA-256 snapshots. Narrow indexed
memo-property patches and native task transactions also preserve canonical
envelopes; unsupported/legacy sources remain read-only.

Compatibility fallback: a binary lacking capabilities may still have PDC
source commands while `new` and collection installation emit old envelopes.
Use only its verified PDC source commands. Older indexed reads may initialize
or migrate a vault; use inventory/source reads instead on those binaries.

With `implicit_home_migration: false`, CLI reads never convert/move old homes
or install preset templates. They may refresh private indexes. `vault path`
resolves the path without opening a vault or creating files.

## Indexed recall

```bash
oximemo list --folder knowledge --where 'status=stub' --format json
oximemo list --tag rust --favorites --sort updated:desc --limit 20 --format ndjson
oximemo search 'cancellation' --limit 10 --format json
oximemo get UUID
```

`list --where` supports `key=value`, comma-separated any-of values, and
`key~value` list-membership/substring checks. Repeated filters are ANDed.
`--sort updated`, `updated:desc`, or a property key pairs with `--offset`.
`list` defaults to a human table; `search` defaults to NDJSON. Prefer an
explicit machine-readable format. `get UUID --md` emits raw note source,
but does not supply the caller-held digest required for a guarded save.

Memo indexes can omit files that remain readable through `pdc list` / `read`.
PDC writes are index-independent; verify them through the source inventory,
not solely an immediate search hit. If a stale index matters, an explicitly
chosen `reindex` rebuilds projections without converting documents.

## Folders, schemas, and collections

```bash
oximemo folders --format json
oximemo schema knowledge
oximemo collection list
```

Match a requested book/movie/knowledge destination against folder `preset`
and workspace facts. `schema FOLDER` returns `{folder, preset, workspace,
schema, template}`; `schema: null` means free-property mode. Read declared
property types/options and template defaults before collection creation.
Do not invent vocabulary when the schema supplies it.

After the runtime writer gate passes, a requested collection setup can use
`collection install PRESET FOLDER` to create missing template/schema files
and preserve existing ones. A legacy or unsupported template is not
permission to repair or convert it.

For schema-aware capture only after verifying that `new` writes PDC 2:

```bash
oximemo new '한 줄 감상…' --folder movies --set rating=4
oximemo new 'Rust cancellation is cooperative.' --folder knowledge \
  --set domain=TECH --set subdomain=SW --set status=stub
```

Use only values allowed by the actual folder schema and ratings/statuses
the user supplied. `new` prints a UUID, applies templates, and fires schema
transitions; these behaviors alone do not establish PDC 2 output. Its
`--set` values use strings or comma-separated lists;
they are not the typed JSON interface of `pdc create --set`. `new --html`
selects HTML, whose envelope must also pass the runtime gate. `new --tag`
appends inline body tags; use
`pdc create --tag` when authoritative envelope tags are required.

`pdc create` directly accepts a title, body, profile, tags, and typed user
properties. It bypasses folder template inheritance and transitions. Choose
the entry point matching the requested workflow rather than assuming the
two creation commands are interchangeable.

## Provider metadata

```bash
oximemo metadata search 'Interstellar' --domain movie --format json
oximemo metadata search 'Dune' --domain book --format ndjson
```

The user's metadata configuration controls enabled providers and keys.
An empty result may mean disabled lookup or missing keys. Use matching
provider facts rather than guessing; do not expose credentials or guess
the user's rating, status, or watched/read dates.

Include confirmed facts when creating a new note. For an indexed canonical
memo, `stamp UUID` fills schema-declared empty properties and guards the
snapshot read by that transaction. `update UUID --set KEY=VAL`, `--unset KEY`,
and `--favorite/--unfavorite` apply narrow patches when
`memo_metadata_patch` is true. They preserve untouched body/envelope bytes.
For an edit based on an earlier property read, retain its PDC token and use
`update UUID --sha256 TOKEN --set KEY=VAL`. Body replacement via this command
requires that token; prefer `pdc update` for body/title edits. Arbitrary nested
property mutations are not supported by the memo interface. Do not reconstruct
the envelope as a workaround.
An unsupported projection may require the PDC source path or remain read-only.

## Tasks

```bash
oximemo task list --not-done --format json
oximemo task list --note UUID --format json
oximemo task list --folder daily --due before:2026-10-20 --format md
```

`--where` filters notes; `--due`, `--status`, and `--not-done` filter tasks.
Statuses include `todo`, `in_progress`, `on_hold`, `done`, `cancelled`.
Dates such as `today` follow the CLI host's local date; use explicit dates
when the requested timezone differs.

Each task row contains `task_ref` with `memo_id`, a **0-based** body `line`,
and a 16-hex `line_hash`. With `writers.task_patch`, native
`task done|status|edit|rm` commands verify that reference and preserve the
canonical envelope using a whole-source snapshot captured inside the locked
mutation. Do not use `--force` to bypass a conflict; list and reconcile again.

```bash
oximemo task add '인보이스 정리' --inbox --due 2026-10-20
oximemo task list --not-done --format json
oximemo task done UUID LINE --hash HASH_FROM_TASK_REF
```

`task add` requires `writers.task_capture`; choose `--note UUID`,
`--daily DATE`, or `--inbox` according to user intent. Native completion
retains recurrence/date side effects. Legacy targets are read-only and must
never be adopted or converted automatically. For a requested rollover,
preview with `task rollover --dry-run` before applying the native operation.

## Export and incremental caches

```bash
oximemo export --format ndjson
oximemo export --since '2026-10-18T00:00:00.000Z' --format ndjson
oximemo export --ids a,b,c --full --format ndjson
oximemo export --ids-file ids.txt --full --format ndjson
```

Without `--full`, records contain `{id, hash, updated_at, deleted}`. Compare
against a local id/hash cache, fetch changed live records with `--full`,
and drop deleted records from that cache. `--ids`, `--ids-file`, and
`--ids-stdin` are mutually exclusive. Fetches must complete before advancing
the RFC 3339 cursor; use an inclusive boundary and deduplicate IDs.

The `b3:` memo/export hash is a derived index value. It is **not** the
`sha256:` source token from `pdc read` and cannot guard a source edit.
Export records are memo projections, not a complete byte-preserving backup
of canonical, legacy, and unsupported documents. Do not use them to replace
source files or claim a full PDC vault synchronization.

## Maintenance and errors

`stats` reports memo counts; `doctor` audits the existing memo/index view;
`pdc list` supplies document-plane diagnostics. Read-only inspection never
authorizes `doctor --fix`, migration commands, `migrate-home`, or an upgrade.
Do not run repair/conversion automatically to make a read succeed.

Canonical trash is `_trash/`; legacy `.trash/` remains readable. Use a
conforming application path for deletion/restoration; never `rm`, invent
tombstones, or simulate a move by new capture plus deletion. `purge` is
irreversible maintenance, not routine cleanup, and is outside ordinary
capture/edit workflows.

On an index lock timeout, wait briefly and retry a bounded number of times;
do not delete locks or rebuild indexes as conflict recovery. Source conflicts
require re-reading and reconciling the edit. Preserve valid files and report
legacy, unsupported, preservation, or capability errors rather than repairing
them silently.
