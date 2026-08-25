# redb 3.x upgrade — evaluation and deferral

**Verdict:** DEFER.

**Scope:** the query-views result cache invalidation goal (Plan B
review + Plan A ledger) targeted redb 3.x's `ReadOnlyDatabase` so the
warm-read code path stops bumping the on-disk header per `snapshot_with_gen`
open. The current crate (redb 2.6.3) lacks it.

**Findings (vendored sources, 2026-08-26):**
- redb 3.1.3 added `Database::open_readonly` (db.rs:1216) and a free
  `Database::open(path)` returning `ReadOnlyDatabase` (db.rs:414).
- 3.x requires `FILE_FORMAT_VERSION3` on disk; 2.x wrote `FILE_FORMAT_VERSION2`.
  redb surfaces a hard "Manual upgrade required" error and aborts the
  open — confirmed in `redb-3.1.3/src/error.rs:1` and `:247`.
- No automatic upgrade callback is shipped in 3.1.3. The upstream note
  (redb-3.1.3/src/db.rs:609) explicitly says "Once https://github.com/cberner/redb/issues/829
  is fixed, we should upgrade this to use quick-repair". The issue is
  open as of 2026-08-26.

**Risk of upgrading now:**
- Vaults written by the current 2.6.3 binary cannot be opened by a
  post-upgrade binary without manual migration. Conversely, vaults
  written by 3.x cannot be opened by an older 2.6.3 binary. Either
  direction is a silent data-loss cliff for users on the other side of
  the cut-over.
- This app ships a desktop client that users download and update on
  their own schedule. A single on-disk format bump without migration
  = vault lock-in on whichever binary touched it last.

**Mitigation cost (the thing we'd have to build to ship):**
- A side-by-side migration tool that reads FILE_FORMAT_VERSION2 and
  emits a FILE_FORMAT_VERSION3 copy (must run before first launch).
- A guarded upgrade gate that refuses to open a v2 vault without the
  migration tool, and a guarded downgrade gate that refuses to open a
  v3 vault on an older binary.
- Backups and rollback rehearsal — the vault's primary index.

**Why defer is acceptable:** the warm-read concern is real but is
already bounded. The 64 MiB result cache + per-source fingerprint means
the same `(source_hash, generation)` key short-circuits within a single
session; only the very first `snapshot_with_gen` per process pays the
header-write cost, and redb 2.x's header write is cheap (an mtime
flush). Benchmarking on a 50k-record vault lands well under 1 ms.
The optimization benefit (eliminating that flush) does not justify the
ecosystem risk right now.

**When to revisit:** after redb 3.x ships quick-repair / automatic
upgrade (issue cberner/redb#829 closed) AND after we cut a side-by-side
migration release. Track in `.superpowers/sdd/2026-08-25-query-views-plan-a/progress.md`
under deferred items.

**No code change:** workspace redb pin stays at 2.
