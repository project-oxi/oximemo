---
name: oxinot
description: Read, write, and search the user's oxinot memo vault from the shell. Use when the user wants to capture a thought, recall a memo, list/search their notes, sync the vault, or operate the oxinot CLI. Triggers on phrases like "save a memo", "create a memo", "list my notes", "search memos for X", "what did I write about Y", "purge the trash", "show the vault path", or any direct invocation of the `oxinot` binary.
---

# oxinot

`oxinot` is a fast, minimal card-based memo capture app. The CLI is the
authoritative agent interface: human/agent parity — every operation the GUI
can do, the CLI can do, and vice versa. The vault is a directory of plain
`.md` files (the source of truth), backed by an in-process redb + tantivy
index that the CLI reads/writes transparently.

## When to use

- The user wants to **capture a thought quickly** (one line, no formatting
  friction) — `oxinot new`.
- The user wants to **list recent memos** — `oxinot list`.
- The user wants to **search notes** by keyword — `oxinot search` (BM25 over
  body and tags).
- The user wants to **read a specific memo** — `oxinot get <id>`.
- The user wants to **sync the vault** with an external cache (read manifest
  → diff hashes → fetch changed bodies) — `oxinot export`.
- The user wants to **soft-delete** (`oxinot delete`) or **purge the trash**
  (`oxinot purge`).
- The user wants to **audit / repair** the vault — `oxinot doctor [--fix]`.

Do **not** use this skill for: editing arbitrary files, writing prose with
formatting, or anything that needs a WYSIWYG. The MVP design explicitly
excludes rich text, AI features, and wikilinks (§3 of `doc/DESIGN.md`).

## Discovery

- The vault path is the user vault under `~/Library/Application Support/com.oxinot.app/vault/` by default. Override with `--vault <PATH>` (also see the env var `OXINOT_VAULT`).
- Quick check: `oxinot vault path` prints the resolved root.
- A memo's `id` is a UUIDv7 string (e.g. `019fa927-a897-7e12-9102-8a8c7ebbb594`).

## Command reference

```bash
oxinot new [TEXT] [--tag TAG]… [--color "oklch(0.75 0.15 75)"]
  # TEXT may be omitted: stdin is read. Empty memos are rejected.

oxinot list [--limit N] [--tag T] [--pinned]
            [--format table|json|ndjson]   # default: table (human)

oxinot get <ID> [--md]
  # --md emits the raw .md file (frontmatter + body). Default is JSON.

oxinot search <QUERY> [--limit N] [--format json|ndjson]

oxinot export [--since RFC3339]
              [--ids a,b,c | --ids-file PATH | --ids-stdin]
              [--full]
              [--format ndjson|json]
  # Without --full: emits a manifest of {id, hash, updated_at, deleted}.
  # With --full:    emits full memo bodies (id, body, tags, color, ...).
  # Default format is NDJSON (line-delimited JSON, streaming-friendly).

oxinot delete <ID>            # soft-delete (moves to .trash/)
oxinot purge [--older-than 30d]
oxinot reindex                 # rebuild indexes from files
oxinot doctor [--fix]          # audit / repair
oxinot vault path              # print the vault path
```

`--ids`, `--ids-file`, and `--ids-stdin` are mutually exclusive; combining
them is an error.

## Output formats

- `table` — human-readable aligned table (default for `list`).
- `json` — single pretty-printed JSON array.
- `ndjson` — one JSON value per line, streaming-friendly (default for
  `export` and `search`).

Timestamps in JSON are **RFC 3339** (e.g. `2026-07-28T15:07:23.665405Z`).
This is the sync cursor format; do not assume the space-separated variant.

## Synchronization algorithm (§9.2 of `doc/DESIGN.md`)

The manifest is a stream of `{"id", "hash", "updated_at", "deleted"}` lines.
The body-less design keeps the manifest cheap regardless of memo size.

1. **Fetch the manifest since your last cursor:**
   ```bash
   oxinot export --since "$CURSOR" --format ndjson > manifest.ndjson
   ```
2. **Diff against your local `id → hash` cache** (do this in your code):
   - `id` not in your cache → **fetch**.
   - `id.hash` differs from your cache → **fetch** (metadata changes are
     reflected in the hash, so tag/pin/color edits are detected).
   - `deleted: true` → **drop** from your cache.
3. **Fetch changed memos in bulk.** For small batches:
   ```bash
   oxinot export --ids a,b,c --full --format ndjson
   ```
   For large batches (the macOS `ARG_MAX` is ~256 KB) use one of:
   ```bash
   oxinot export --ids-file ids.txt --full --format ndjson
   cat ids.txt | oxinot export --ids-stdin --full --format ndjson
   ```
4. **Advance your cursor** to the max `updated_at` you saw. Repeat.

The hash is `b3:<blake3-hex>` and covers the memo's body **plus** its
tags, pin flag, and color (§5.3 of `doc/DESIGN.md` — extended from
body-only to include meaningful metadata). A pure metadata edit (add a tag,
change a color) bumps the hash, so the diff correctly flags it.

## Notes on writing files directly

The vault is plain `.md` files with TOML frontmatter. You may read or edit
them with any tool. **If you write a file directly**, observe these rules
(or the file will be flagged by `oxinot doctor` and skipped by the
indexer):

1. The **first line** must be exactly `+++` for frontmatter to exist.
2. Frontmatter runs from line 1 to the **second** `+++` line.
3. After the second `+++` line, everything is the body.
4. A file whose first line is not `+++` is treated as body-only (no
   identity; not indexed as a memo).
5. Frontmatter must parse as TOML. The fields `id`, `created_at`,
   `updated_at`, `hash`, `pinned`, `color`, `tags` are well-known; the
   indexer preserves unknown fields. `deleted_at` is optional and signals
   a tombstone.

The index/watcher will pick up your change within the debounce window
(default 300 ms) and re-index automatically — there is no need to run
`oxinot reindex` for ordinary writes. If you bulk-edit many files, run
`oxinot reindex` once to flush.

**Do not** delete `.trash` files yourself; use `oxinot purge` so the
metadata index stays consistent.

## Quick recipes

- **Capture a thought during a session:** echo the body over stdin.
  ```bash
  echo "Bump redb to 2.6 next sprint" | oxinot new --tag backlog
  ```
- **List pinned notes:**
  ```bash
  oxinot list --pinned --limit 10 --format ndjson
  ```
- **Search for a term and pull the top hit's body:**
  ```bash
  ID=$(oxinot search "redb upgrade" --format ndjson | head -1 | jq -r .id)
  oxinot get "$ID" --md
  ```
- **Print the manifest for a calendar day:**
  ```bash
  SINCE=$(date -u -v-1d +%Y-%m-%dT00:00:00Z 2>/dev/null || date -u --date='1 day ago' +%Y-%m-%dT00:00:00Z)
  oxinot export --since "$SINCE" --format ndjson
  ```
- **Audit and repair:**
  ```bash
  oxinot doctor          # report
  oxinot doctor --fix    # apply safe repairs (never deletes files)
  ```
- **Find the vault on disk:**
  ```bash
  oxinot vault path
  ```

## Error handling

- The CLI exits non-zero on any error; the first line of stderr is the
  message; subsequent lines include the chain (e.g. lock timeout).
- `LockTimeout` means another oxinot process is currently using the
  index (likely the desktop app is open). The wait is 5 seconds; after
  that, retry or back off.
- `Frontmatter` errors name the file and the reason; fix the file's
  TOML or run `oxinot doctor --fix` for safe repairs.

## Concurrency and locks

The CLI shares the vault with the desktop app. A cross-process advisory
`fs2` flock protects the index; reads are shared, writes are exclusive.
This means the CLI can read while the desktop app runs, and writes are
serialized. Closing the desktop app is **not** required for CLI use, but
if a write keeps timing out, the GUI is probably mid-write — wait and
retry.

## What this skill does not cover

- Capturing formatted text or attachments (MVP exclusion, §3).
- Wikilinks / backlinks / graph (deferred to v0.3+).
- AI summaries, embeddings, or semantic search (deferred, §14).
- Synchronizing across machines; the vault lives on one host at a time.
  Move the vault directory (and re-run `oxinot reindex` on the new host)
  if you need to migrate.
