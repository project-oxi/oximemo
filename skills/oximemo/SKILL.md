---
name: oximemo
description: Read, write, and search the user's oximemo memo vault from the shell. Use when the user wants to capture a thought, recall a memo, list/search their notes, edit note bodies or properties, sync the vault, or operate the oximemo CLI. Also covers schema-aware work — creating knowledge notes, registering books/movies in collection folders, installing collections, filling metadata from providers, driving status transitions. Triggers on phrases like "save a memo", "create a memo", "list my notes", "search memos for X", "what did I write about Y", "organize my notes", "add a movie", "log this book", "create knowledge notes", "purge the trash", "show the vault path", or any direct invocation of the `oximemo` binary.
---

# oximemo

`oximemo` is a fast, minimal card-based memo capture app. The CLI is the
authoritative agent interface: human/agent parity — every operation the GUI
can do, the CLI can do, and vice versa. The vault is a directory of plain
`.md` files (the source of truth), backed by an in-process redb + tantivy
index that the CLI reads/writes transparently.

The vault lives at **`~/.oxi/vault/`** — a shared file space in the oxi
ecosystem (oxios and other tools may write the same tree through the same
frontmatter contract). Notes are organized in **folders** (physical
subdirectories); there are no categories.

## When to use

- The user wants to **capture a thought quickly** (one line, no formatting
  friction) — `oximemo new`.
- The user wants to **list recent memos** or filter by folder/tag/property —
  `oximemo list`.
- The user wants to **search notes** by keyword — `oximemo search` (BM25).
- The user wants to **read a specific memo** — `oximemo get <id>`.
- The user wants to **edit a note's body, favorite, or properties** —
  `oximemo update`.
- The user wants to **sync the vault** with an external cache (read manifest
  → diff hashes → fetch changed bodies) — `oximemo export`.
- The user wants to **create schema-valid content** — knowledge notes,
   book/movie registrations, collection installs, metadata grounding —
   see "Folders, schemas & collections" below (`folders`, `schema`,
   `collection`, `new --set`, `metadata search`, `stamp`).
- The user wants to **soft-delete** (`oximemo delete`) or **purge the trash**
  (`oximemo purge`).

Do **not** use this skill for: editing arbitrary files outside the vault, or
anything that needs a WYSIWYG.

## Discovery

- The vault path defaults to `~/.oxi/vault/`. Override with `--vault <PATH>`
  (or the env var `OXIMEMO_VAULT`).
- Quick check: `oximemo vault path` prints the resolved root.
- A memo's `id` is a UUIDv7 string (e.g. `019fa927-a897-7e12-9102-8a8c7ebbb594`).

## Command reference

```bash
oximemo new [TEXT] [--tag TAG]… [--folder PATH] [--html] [--set KEY=VAL]…
  # TEXT may be omitted: stdin is read. Empty notes are rejected.
  # --folder targets a subfolder (created if missing); empty = vault root.
  # --html creates a .html note (frontmatter in a leading HTML comment).
  # --set stamps properties onto the NEW note in the same command and
  #   fires the folder's schema transitions (one-command schema-valid
  #   creation). Comma values become lists.

oximemo folders [--format table|json|ndjson]
  # The vault's folder map: every physical folder, note counts, preset
  # markers (knowledge/daily/book/movie/blog/novel/idea), workspace
  # names, and which folder is the configured daily folder.

oximemo schema [FOLDER]           # JSON; FOLDER omitted = vault root
  # { folder, preset, workspace, schema, template } — the parsed
  # SCHEMA.toml (properties, allowed options, metadata mappings,
  # transitions, review queue) plus the raw TEMPLATE.md a new note
  # starts from. `"schema": null` = free-property folder (a fact, not
  # an error). Nonexistent folder exits 1.

oximemo collection list           # installable preset catalog (JSON)
oximemo collection install <PRESET> <FOLDER>
  # Install a collection (book/movie/blog/novel/idea) into a folder —
  # creates TEMPLATE.md + SCHEMA.toml, skip-if-exists (user files are
  # never overwritten). Same semantics as the GUI install flow.

oximemo list [--limit N] [--tag T]… [--folder PATH] [--favorites]
            [--where EXPR]… [--sort SPEC] [--offset N]
            [--format table|json|ndjson]        # default: table (human)
  # --where 'status=stub' | 'domain=TECH,MATH' (any-of) | 'subdomain~AI' (list/substring)
  # --sort 'updated' | 'updated:desc' | <property-key>

oximemo get <ID> [--md]
  # --md emits the raw .md file (frontmatter + body). Default is JSON.

oximemo update <ID> [--body TEXT | --body-stdin]
                 [--favorite | --unfavorite]
                 [--set KEY=VAL]… [--unset KEY]…
  # Edit an existing note. Omitted fields are left unchanged.
  # --set/--unset edit properties; comma values become lists.

oximemo search <QUERY> [--limit N] [--format json|ndjson]

oximemo metadata search <QUERY> --domain book|movie [--format ndjson|json]
  # Provider-grounded facts using the user's [metadata] config (enabled
  # flag + API keys) — the same providers and gating as the GUI 채우기
  # flow. Disabled config or no matching keys ⇒ empty list, exit 0.

oximemo stamp <ID>               # MetaHit JSON on stdin
  # Stamp a hit from `metadata search` onto a note: fills ONLY
  # schema-declared metadata props that are still empty, plus
  # source_url/cover_url when the schema declares them. Never
  # overwrites existing values. Ratings never map (user judgment).

oximemo stats            # live memo counts as JSON

oximemo export [--since RFC3339]
              [--ids a,b,c | --ids-file PATH | --ids-stdin]
              [--full] [--format ndjson|json]
  # Without --full: emits a manifest of {id, hash, updated_at, deleted}.
  # With --full:    emits full memo records. Default format is NDJSON.

oximemo delete <ID>            # soft-delete (moves to .trash/, path preserved)
oximemo restore <ID>           # un-delete a trashed note
oximemo purge [--older-than 30d]
oximemo reindex                 # rebuild indexes from files
oximemo doctor [--fix]          # audit / repair
oximemo vault path              # print the vault path
oximemo upgrade [--check]       # self-update (GUI+CLI together when inside the app)
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

## Editing notes — prefer the CLI for every mutation

The vault is plain files, so you *can* read them with any tool — `cat`,
`grep`, editors, all fine. **For writes, commit through the CLI**:

- **Body edit**: compose the new body yourself, then
  `oximemo update <ID> --body-stdin` (pipe the full new body).
- **New note**: `oximemo new --folder <path>` — mints the id (UUIDv7,
  time-sortable), `created`/`updated`, applies the folder's TEMPLATE.md and
  SCHEMA.toml defaults (e.g. a fresh knowledge note starts `status: stub`).
- **Property change** (status, rating, relations…):
  `oximemo update <ID> --set status=understood`.
- **Delete**: `oximemo delete` (soft, restorable, path preserved). Never
  `rm` a vault file yourself.

Why: the CLI write path is atomic (tmp+fsync+rename), re-reads the file at
write time so unknown keys and the `oxios:` app table survive, and bumps
`updated` — the sync cursor. A raw edit that skips those loses sync
visibility (`oximemo export --since` won't see it) and can drop another
app's metadata.

If you *must* write a file directly (bulk tooling, unusual formats), follow
the format rules below exactly — a malformed frontmatter block makes the
note a hard parse error or silently invisible to the index (`oximemo
doctor` reports it).

## The note format (v4)

Markdown notes are `---`-fenced YAML frontmatter (a restricted subset we
own); `.html` notes wrap the same block in a leading HTML comment — line 1
is `<!--`, line 2 is `---`, the block closes with `---` then `-->`.
Example:

```markdown
---
id: 01991a2e-7c3f-7c91-9f3e-6b1a2e8f9c10
created: 2026-07-28T10:15:03+09:00
updated: 2026-07-28T10:15:03+09:00
favorite: false
status: stub
oxios:
  author: agent
---

The capture overlay must appear in under one frame.
```

- **Core keys**: `id`, `created`, `updated` (RFC 3339, required);
  `favorite`, `deleted` (optional; `deleted` presence = soft-deleted
  tombstone). Core keys change only through the CLI — a direct edit must
  not fabricate them on an existing note.
- **Properties**: every other top-level key (e.g. `status`, `rating`) —
  indexed, searchable via `--where`, and covered by the sync hash.
- **App tables**: nested maps like `oxios:` belong to other apps; preserve
  them verbatim.
- **Tags** live in the body as `#tag`; frontmatter `tags:` (if another tool
  wrote it) is read and unioned, never rewritten.
- **`hash` is not stored** — it is derived at index time (see below). Do
  not write a `hash` key.
- YAML subset allowed: flat `key: value`, nesting to depth 2, flow
  (`[a, b]`) and block sequences, `|` block scalars. **Forbidden**: tabs,
  comments (`#` must be quoted inside values), anchors/aliases, tags,
  multi-document, duplicate keys, BOM. CRLF accepted on read; LF on write.
- A file whose leading block is **missing** is body-only: readable on
  disk but invisible to the index and search. A **malformed** block
  (tab, BOM, duplicate key, unclosed fence) is a hard parse error —
  same practical outcome (not indexed), but `oximemo doctor` reports it
  as a parse error, not body-only.

The index/watcher picks up changes within the debounce window and
re-indexes automatically. After bulk external edits, run
`oximemo reindex` once. **Do not** delete `.trash/` files yourself; use
`oximemo purge`.

Wikilinks (`[[Note Title]]` and `[[alias]]`) resolve through titles and the
`aliases` property; links inside property values count for backlinks and
rename propagation.

## Synchronization algorithm

The manifest is a stream of `{"id", "hash", "updated_at", "deleted"}`
lines. The body-less design keeps the manifest cheap regardless of vault
size.

1. **Fetch the manifest since your last cursor:**
   ```bash
   oximemo export --since "$CURSOR" --format ndjson > manifest.ndjson
   ```
2. **Diff against your local `id → hash` cache** (do this in your code):
   - `id` not in your cache → **fetch**.
   - `hash` differs → **fetch** (the hash covers body + favorite + all
     properties, so metadata edits are detected; tags live in the body).
   - `deleted: true` → **drop** from your cache.
3. **Fetch changed notes in bulk.** For small batches:
   ```bash
   oximemo export --ids a,b,c --full --format ndjson
   ```
   For large batches (the macOS `ARG_MAX` is ~256 KB) use one of:
   ```bash
   oximemo export --ids-file ids.txt --full --format ndjson
   cat ids.txt | oximemo export --ids-stdin --full --format ndjson
   ```
4. **Advance your cursor** to the max `updated_at` you saw. Repeat.

The hash is `b3:` + BLAKE3 over the normalized body, the favorite flag, and
every property in canonical order — computed at index time, never stored in
the file.


## Folders, schemas & collections

Folders are physical subdirectories; a folder that carries a
`SCHEMA.toml` declares **property types, allowed values, metadata
provider mappings, state transitions, and (optionally) a review
queue**. The GUI drives all of this; the CLI exposes the same facts
(`folders` + `schema`), so human and agent see one truth.

Workflow for ANY "create X for me" request:

1. **Locate the folder** — `oximemo folders --format json` (or read the
   `folders:` facts in the context block you were handed). Match by
   preset id (`movie`, `book`, `knowledge`, …) or workspace name
   (영화, 책, 지식, …). No matching folder? `oximemo collection list`
   then `oximemo collection install <preset> <folder>` — ask the user
   which folder name they want when ambiguous.
2. **Read the schema** — `oximemo schema <folder>`. It tells you every
   property, its allowed values (`options`), which fields auto-fill
   from metadata providers (`metadata = "director"` etc.), and what
   the folder's TEMPLATE stamps on a new note.
3. **Create with properties in one command:**
   ```bash
   oximemo new "감상 내용…" --folder movies --set rating=5 --set series=false
   ```
   `--set` values MUST come from the schema's `options` when the
   property declares them; transitions (e.g. knowledge
   `status=understood` → `peak_status`/`status_changed` stamping) fire
   exactly as in the GUI.
4. **Free-property folders** (`"schema": null`) accept any `--set`
   keys — still prefer the folder's own vocabulary when one exists.

## Metadata grounding (books & movies)

The vault config carries the user's metadata provider keys (Google
Books, Aladin, TMDB, OMDB, …). Ground factual fields through them
instead of guessing:

```bash
oximemo metadata search "듄" --domain movie --format ndjson | head -3
# pick the right hit, then:
oximemo metadata search "듄" --domain movie --format ndjson | head -1 | oximemo stamp <ID>
```

- `stamp` fills ONLY schema-declared, still-empty mapped props
  (director, release_date, runtime_min, original_title, author, isbn,
  …) plus `source_url`/`cover_url` when the schema declares them.
- **Ratings, status, and watched/read dates are the user's judgment —
  they never map.** Set those yourself only when the user said so.
- Empty result = metadata disabled or no keys configured for that
  domain (e.g. movie search is all-keyed). Fall back to asking the
  user or using well-established facts, and say which you did.

## Quick recipes

- **Capture a thought during a session:**
  ```bash
  echo "Bump redb to 2.6 next sprint" | oximemo new --tag backlog
  ```
- **Add a movie the user just watched:**
  ```bash
  oximemo folders --format json          # find the movie folder (preset: "movie")
  oximemo schema movies                  # director/release_date/runtime_min/series/rating…
  ID=$(oximemo new "한 줄 감상…" --folder movies --set rating=4 | tail -1)
  oximemo metadata search "Interstellar" --domain movie --format ndjson \
    | head -1 | oximemo stamp "$ID"
  ```
- **Create several knowledge notes:**
  ```bash
  oximemo schema knowledge               # status/domain/subdomain vocab
  oximemo new "BLAKE3는 병렬 해시다" --folder knowledge \
    --set domain=TECH --set subdomain=SW --set status=stub
  ```
  (`status` transitions — stub→understood etc. — can be driven later
  with `oximemo update <ID> --set status=understood`; the schema's
  peak/stamp rules fire on write.)
- **Capture into the knowledge folder (schema defaults applied):**
  ```bash
  echo "Rust async cancellation is cooperative" | oximemo new --folder knowledge
  ```
- **Promote an idea by moving it (GUI action; CLI uses folder-targeted capture + delete):**
  ```bash
  oximemo get <ID> | jq -r .body | oximemo new --folder knowledge
  oximemo delete <ID>
  ```
  (Prefer the GUI/`move_note` path when available; this recipe is
  body-only — the new note gets a fresh id and its properties are
  re-derived from the target folder's TEMPLATE, unlike a real move.)
- **List stubs in a knowledge folder:**
  ```bash
  oximemo list --folder knowledge --where status=stub --format ndjson
  ```
- **Rewrite a note body via the CLI commit path:**
  ```bash
  cat new_body.md | oximemo update <ID> --body-stdin
  ```
- **Search and pull the top hit:**
  ```bash
  ID=$(oximemo search "redb upgrade" --format ndjson | head -1 | jq -r .id)
  oximemo get "$ID" --md
  ```
- **Audit and repair:**
  ```bash
  oximemo doctor          # report
  oximemo doctor --fix    # apply safe repairs (never deletes files)
  ```

## Error handling

- The CLI exits non-zero on any error; the first line of stderr is the
  message; subsequent lines include the chain (e.g. lock timeout).
- `LockTimeout` means another oximemo process is currently using the
  index (likely the desktop app is open). The wait is 5 seconds; after
  that, retry or back off.
- Frontmatter errors name the file and the reason; fix the block's YAML
  subset violations or run `oximemo doctor --fix` for safe repairs.

## Concurrency and locks

The CLI shares the vault with the desktop app and other ecosystem tools. A
cross-process advisory `fs2` flock protects the index; reads are shared,
writes are exclusive. Closing the desktop app is **not** required for CLI
use, but if a write keeps timing out, another writer is probably mid-write
— wait and retry. Per-file conflicts resolve last-writer-wins; visibility
between apps is by frontmatter (a `---` block ⇒ indexed note).

## What this skill does not cover

- Capturing formatted rich text or attachments.
- In-app AI features (the app's copilot delegates to external agents; that
  is a GUI concern, not a CLI surface).
- Synchronizing across machines; the vault lives on one host at a time.
  Move the vault directory (and re-run `oximemo reindex` on the new host)
  if you need to migrate.
