# redb 3.x upgrade — evaluation, deferral, then execution

**Verdict (superseded 2026-08-26):** EXECUTED. See the addendum.

## Original evaluation (2026-08-26 morning): DEFER

**Scope:** the query-views result cache invalidation goal (Plan B
review + Plan A ledger) targeted redb 3.x's `ReadOnlyDatabase` so the
warm-read code path stops bumping the on-disk header per
`snapshot_with_gen` open. The then-current crate (redb 2.6.3) lacked it.

**Findings (vendored sources):**
- redb 3.1.3 added `Database::open_readonly` and a free `Database::open`
  returning `ReadOnlyDatabase`.
- 3.x requires `FILE_FORMAT_VERSION3` on disk; 2.x wrote v2 by default.
  redb 3 surfaces `UpgradeRequired` ("Manual upgrade required") and
  aborts the open.
- No automatic upgrade ships *in 3.x* (upstream cberner/redb#829 about
  quick-repair was open).

## Addendum (2026-08-26): the deferral's premise was wrong

Re-inspection of the vendored sources found the migration path the
deferral said didn't exist — not in redb 3, but in **redb 2.6 itself**:

- `redb 2.6.3 Database::upgrade()` (db.rs:455) performs an in-place
  v2 → v3 format bump using redb's own two-phase-commit machinery.
  Crash-safe; a re-run after an interrupted upgrade finishes it.
- redb 2.6.3 fully reads **and writes** v3 files (header accepts ≤ v3,
  `Builder::create_with_file_format_v3`, `file_format_v3()` branches
  throughout transactions.rs). The "old binary can't open new vault"
  cliff only exists for redb < 2.6 — no shipped oximemo used those.

So the upgrade is: pin redb 3, keep redb 2.6 linked solely for the
one-shot hop, and on `DatabaseError::UpgradeRequired(2)` call
`redb2::Database::open(path)?.upgrade()` then retry. No side-by-side
copy, no backup dance, no format cliff.

**Landed** (crates/oximemo-core/src/store/index.rs):
- `RedbIndex::open` catches `redb::DatabaseError::UpgradeRequired` and
  hops through `redb2` transparently; every oximemo-released vault
  opens unchanged.
- Workspace: `redb = "3"` + `redb2 = { package = "redb", version = "2.6" }`
  (the dual dep is the entire "migration tool").
- Test `opens_v2_file_by_upgrading_in_place`: seeds a genuine v2 file
  via redb 2.6, opens through `RedbIndex`, asserts data survival and
  idempotent re-open.

**Not pursued:** the original warm-read motivation
(`ReadOnlyDatabase` for snapshot opens). The header-mtime bump is
bounded (first open per process) and the snapshot cache already keys on
the post-open stat; revisit only if profiling demands it.
