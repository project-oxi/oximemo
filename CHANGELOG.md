# Changelog

All notable changes to oximemo are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
## [Unreleased]

### Added


- **Note properties & folder schemas (knowledge management)** — every
  frontmatter key beyond the core five is now a first-class *property*:
  indexed (`IndexRecord.props`), carried on `Memo`/`MemoSummary`/`NoteDto`,
  covered by the sync digest (`hash_memo` now hashes properties), and
  queryable. New offset-paginated `NoteQuery` (`query_notes` IPC, CLI
  `list --where KEY=VAL --sort KEY --offset N`, with `~` for list
  membership and comma values for any-of) complements the cursor path.
  Property edits land through `update_memo`'s new `props` diff (CLI
  `update --set/--unset`) with the same semantic-NoOp contract — a
  same-value re-set never touches the file. Folders can declare a
  `SCHEMA.toml` (types, allowed values, badges, color tokens, state
  transitions with `merge = "max"` peak preservation and `on = "write"`
  reassert stamping, and an optional `[review]` queue). TEMPLATE.md
  frontmatter now seeds new notes' properties — including captures with
  non-blank bodies. The knowledge preset ("지식 관리 폴더" in ⌘K)
  installs the whole status lifecycle (stub→vague→understood→mastered,
  decayed with all-time-high peak). Wiki links now resolve through
  `aliases` (H1 first, oldest note on conflict) and `[[..]]` inside
  property values (e.g. `related`) count for backlinks, graph edges,
  and rename propagation. The editor gains a typed property panel
  (select/multiselect/date/text, warning-level violations), cards/list
  rows/graph nodes gain schema badges, folders with schemas get
  property filter chips + property sorts, and `[review]` folders get a
  review queue (oldest-first, "설명 가능함"/"막힘" actions) plus a
  state-driven ⌘K command. `doctor` reports `schema_violations`
  (warning-level, never auto-fixed). Index format bumped to v4;
  tantivy gains an `aliases` field and rebuilds on schema change.
  Browser fallback exercises properties, queries, schemas, and the
  review queue (transitions stay desktop-only, like backlinks).

- **Default knowledge folder + localized system-folder names** — the
  knowledge folder now ships with every vault (`Vault::migrate` creates
  it, macOS system-folder semantics: deleting and restarting recreates
  an empty preset; user edits to its files are never overwritten), and
  the UI displays the vault's default folders under localized names —
  `daily` → "데일리"/"Daily", `knowledge` → "지식"/"Knowledge" — while
  disk paths, CLI, and wiki links keep the stable physical names
  (`~/Desktop` → "데스크톱" convention). Applied across the sidebar,
  breadcrumbs, folder tiles/rows, chips, palette (physical path stays
  searchable as an alias), move/delete menus, capture form, settings,
  and the note detail; rename inputs still edit the physical name.
- **Command palette (⌘K)** — a global intent surface: navigation
  (전체 메모 · 즐겨찾기 · 갤러리 · 볼트 루트 · 오늘의 노트 · every folder ·
  #tags), view switches (grid/list/timeline/graph, sidebar), and actions
  (new MD/HTML note, new folder, quick capture, settings, theme) ranked
  by a deterministic score ladder (exact > prefix > boundary >
  substring > subsequence) plus a decaying selection-recency boost.
  Bare text also BM25-searches notes (150 ms debounce) with a bridge row
  that graduates the query into the persistent header search; the empty
  query shows 최근 노트 first (⌘K → ⏎ opens the most recent note) then
  curated suggestions. ⌘⇧O remains as an alias — the palette subsumed
  the old FolderPalette. New `show_capture_window` IPC exposes the
  capture toggle to the renderer; the settings drawer and
  folder-creation requests are store-owned so the palette can drive
  them. IME-safe (composition Enter never runs a command).

- **Sidebar pin management + reordering, tag rename, file import,
  editor/graph menus** — pinned folder rows gain full management parity
  (inline rename with note re-pathing, two-click armed delete with deep
  count) and a ⠿ drag handle for reordering (top/bottom-half drop =
  before/after, persisted via the new `set_pin_order`); tag chips gain
  vault-wide rename (`rename_tag` rewrites `#tag` bodies with the
  shared token-boundary scanner, merges on collision, toasts the
  changed-note count); dropping `.md`/`.markdown`/`.txt` files on the
  note area imports them as notes in the current folder (copy
  semantics); inline editor images get a context menu (delete /
  reset width / copy URL) and graph nodes get 노트 열기 · 즐겨찾기 ·
  삭제.


### Changed

- **Custom context menus everywhere + DnD completion** — the native
  webview right-click menu is blocked app-wide (dev: Alt+right-click
  keeps it); every editable surface (CM6 markdown/html editors, search,
  capture, folder filter, rename inputs) gets a cut/copy/paste/select-all
  menu backed by the new clipboard-manager plugin (paste reuses the
  editor's own paste pipeline); gallery thumbnails, sidebar tag chips,
  and backlink entries get dedicated menus; timeline rows became drag
  sources and the Locations 볼트/daily rows became drop targets.
- **Favorites is a collection, not a filter** — clicking 즐겨찾기 now
  enters the exclusive smart collection (breadcrumb label, never a
  browse path mixed in), and its empty state drops the "clear filters"
  treatment for dedicated copy. The note dialog's folder picker applies
  immediately via move_note (previously the selection was silently
  dropped on save); the daily folder — a real path — now appears in
  Locations under 볼트.
- **Sidebar redesign — Finder completion (A안)** — new **Locations**
  section holds the **볼트** root-browse entry (root browsing was
  unreachable once you entered the flat collection) plus pinned folders;
  **데일리** merges the Today's Note row with the mini calendar into one
  block; the flat smart collection is renamed **전체 메모** and root notes'
  cards no longer mislabel it as their folder; folder chips on query-mode
  cards/timeline rows are now clickable (enter that folder's browse);
  ⌘↑ escapes query mode into root browse; "최상위" unifies to **볼트**.

- **Discard untouched daily notes** — closing a daily note that this
  session just created (template body intact, nothing typed) now removes
  it instead of leaving an empty stub. Revisited/adopted daily notes are
  never discarded. `open_daily_note` now returns `{memo, created}` so the
  frontend only marks fresh notes as discardable drafts.

## [0.9.3] — 2026-08-21

### Added
- **`oxi-frontmatter` 0.1.0 (new crate, ready to publish)** — the oxi ecosystem
  frontmatter contract crate. Owns the canonical YAML-subset grammar
  (grammar v2, SPEC.md), the `parse` / `emit` / `atomic_write` API, and the
  `Mutation` / `Synthesize` / `WriteOutcome` writer side. `oximemo-core`,
  `oxibrain`, and `oxios` now share one parser and one emitter through
  this crate; the inline duplicate parsers in oximemo-core / oxibrain are
  deleted. `oxi-frontmatter = "0.1"` is the public interface for downstream
  ecosystem crates.


- **Daily notes** — sidebar DAILY section: mini month calendar (dots on
  days with notes, click = open-or-create, past/future backfill) plus a
  "Today's Note" smart-collection button. Notes live in `[daily].folder`
  (default `daily`) titled by ISO date; the folder's `TEMPLATE.md` seeds
  new entries with local-date variables. `Vault::open_daily` is the
  idempotent create-or-open; `[daily] enabled = false` hides the UI.
- **Settings GUI parity — every TOML field is now GUI-settable** — new
  settings sections: Brain (enabled / socket / space with a live daemon
  space picker, free-text fallback offline), Capture (double-tap threshold,
  overlay height), Behavior (trash retention), Advanced (index debounce);
  the Appearance section gains a dock-icon toggle (applies the macOS
  activation policy immediately) and the theme Segmented now writes through
  to `appearance.theme`. Section-granular config setters landed on the vault
  with atomic persist. Dead TOML fields removed: `index.watcher_retry_count`,
  `index.watcher_retry_interval_ms` (parsed-but-unused; old files still
  parse). `capture.overlay_max_height` is now real — it sizes the capture
  overlay window.

### Dependencies

- **oxibrain-client v0.3.0 → v0.6.0** — picks up space enumeration
  (`list_spaces`, typed `SpaceSummary`), the `resources/read` scope-bypass
  security fix, and the daemon-side vault watch surface (`sync_run` /
  `SyncOutcome`). With oxibrain ≥ 0.6.0 the vault flows into the brain via
  `oxibrain sync <vault>` + daemon watcher (ADR-010) — oximemo itself
  stays read-only over the socket. `brainGather` now returns the typed
  `BrainRecall` envelope (runtime shape defense unchanged).

### Changed
- **Default vault moved to `~/.oxi/vault`** — the shared ecosystem
  location. On first open the pre-unification default vault
  (`~/Library/Application Support/com.oximemo.app/vault`) is moved
  there once and its v3 notes are auto-converted to the v4 layout in
  the same pass. The derived index stays under application support
  so a cloud-synced vault never ships its binary indexes.
- **`MergeRequired` when both vaults exist** — if both the old and
  the new default vault are populated, neither tree is touched:
  `Vault::status()` surfaces `MergeRequired`, `oximemo doctor`
  reports `merge_required`, and a startup warning names both paths
  for a manual merge. No silent overwrite, no silent skip.
- **Brain registration on open** — with `[brain]` enabled, opening
  the vault registers it with the brain daemon fire-and-forget (a
  missing daemon never blocks open); the ecosystem `[vault].space`
  wins over the vault-local `brain.space`.
- **Memo → Notebook transformation** — oximemo is no longer a flat
  category-based memo app. It is now a physical-folder markdown notebook
  where each note is a real file at `<vault>/<folder>/<title>.md` (or a
  timestamped capture at the vault root). **Breaking** for any script
  consuming the old `category`/`tags` frontmatter or category registry.
  - **Frontmatter simplified** — `category`, `folder`, `deleted_at` are
    gone. Frontmatter only carries `id`, `created_at`, `updated_at`,
    `favorite`, and `tags`. Folder location and H1-derived title are the
    single source of truth.
  - **Title-based wiki links** — `[[Note Title]]` instead of `[[UUID]]`.
    Renames propagate through every note that references the old title.
    `crates/oximemo-core/src/wiki.rs` parses, resolves, and rewrites
    links; `wiki::links_to` is the building block for the backlinks panel.
  - **Per-folder `TEMPLATE.md`** — a folder containing `TEMPLATE.md`
    applies its body as a stub when a new note is created there.
    Variables (`{{date}}`, `{{weekday}}`, `{{time}}`, `{{year}}`,
    `{{month}}`, `{{day}}`, `{{counter}}`, `{{folder}}`) are
    substituted at creation time. `crates/oximemo-core/src/template.rs`.
  - **`FoldersConfig` replaces `CategoriesConfig`** —
    `oximemo.toml` now carries `[[folders]]` with `path`, `view` (`grid` /
    `list` / `timeline` / `graph`), and `color`. Locked views survive
    restarts; unlocked folders fall back to the global default.
  - **Schema bumped to `v3`** — `migrate.rs` walks the v2 layout, walks
    each memo's body for the first `# H1`, derives a slug filename, moves
    the file to `<folder>/<slug>.md`, strips the old category/folder/
    deleted_at fields, and removes the empty `memos/YYYY/MM/` tree.
    `oximemo migrate --dry-run` previews; `--vault-path <path>` selects
    the target. The CLI auto-runs `migrate_vault` on first open.
  - **Title field in the index** — `IndexRecord.path` and
    `IndexRecord.title` (extracted at scan time) replace `category`.
    Search hits title via tantivy BM25.

### Added
- **Four view modes** — `grid` (default virtualized cards), `list` (dense
  rows), `timeline` (day-grouped chronological), and `graph`
  (force-directed wiki-link graph). The toolbar carries a
  `[LOCK]`/`[UNLOCK]` toggle that persists the active mode per folder
  to `oximemo.toml`.
- **Sidebar folder tree** — the left sidebar now renders a real
  collapsible tree over vault folders, with counts and an "All / Favorites
  / Gallery" navigation row.
- **Folder picker** — `FolderCombobox` (keyboard-first, mirrors the old
  `CategoryCombobox` API) drives both the capture overlay's `/` slash
  menu and the MemoDetail editor's folder button.
- **Note move** — `move_note` Tauri command (and `moveNote` API)
  renames a note's `.md` file to `<new_folder>/<slug>.md` and updates
  the index path. Powers the card context-menu "Move to folder" action.


- **HTML note format (`.html`)** — `.html` files are first-class notes; the
  frontmatter is a leading HTML comment `<!-- +++ TOML +++ -->` (D1). Title is
  derived from the first `<h1>` or `<title>`, tags/preview/search are all
  format-aware. New notes in folders that contain a `TEMPLATE.html` (and no
  `TEMPLATE.md`) are created as HTML automatically; when both exist, the new-note
  toolbar splits the button (D8). The CLI gains `oximemo new --html`, and a
  folder that ships a template allows an empty body.
- **`[brain]` config section** — `oximemo.toml` now carries
  `[brain] enabled/socket/space` (defaults `true` / `""` / `"personal"`).
  `space` defaults to `"personal"` to match the daemon MCP default (the daemon
  treats an empty space as the empty space, so the default is non-empty).
- **oxibrain integration panel** — the desktop app links the
  `oxibrain-client` git tag `v0.6.0` (src-tauri only). `MemoDetail` renders a
  `BrainPanel` with status dot (`brain_status` — `online`, server version,
  episodes/entities/statements/contradictions; a stopped daemon is a normal
  `online: false` state, not an error), a "Gather context" button that calls
  `brain_gather` and renders the recall layers with a `kind` label per layer,
  and a "Start a new note from this" distill action. With
  `config.brain.enabled = false` the panel is hidden entirely.
- **Enriched `NoteDto`** — `get_memo`/`create_memo`/`update_move`/`move_note`
  Tauri commands now return `memo + title/path/folder/format`, fixing the latent
  bug where the TS `Memo` type required fields the Rust serializer omitted.
- **Hardened HTML preview** — `MemoEditorForm` now routes HTML notes to an
  `HtmlEditor` (raw CM6 with `@codemirror/lang-html`) with an
  Edit / Split / Preview toolbar. Card previews render the new note HTML with
  DOMPurify inside a `sandbox="allow-same-origin"` iframe
  (`allow-scripts` deliberately omitted) — the existing marked-raw-HTML XSS in
  card previews is now also DOMPurify-washed.

### Notes
- MD notes retain their existing pipeline end-to-end (no regression in the 91
  core + 11 CLI tests). oxibrain connector `.html` scanning/watch is owned by
  the oxibrain repo and tracked as a follow-up there.

### Removed
- **Category registry** — `list_categories`, `create_category`,
  `rename_category`, `delete_category`, `update_category`, the
  `CategoryDef` type, and the `CategoriesSection` settings panel are
  gone. The desktop `CategoryCombobox.tsx` is deleted.

## [0.9.2] — 2026-08-09



### Documentation
- **Unified update architecture (RFC)** — `doc/UPDATER.md` records the
  design decision that the CLI is the only engine for download/verify/swap,
  and the GUI is a view of the CLI. This is the shared blueprint for
  oximemo and oxiline; the open question of an end-to-end live-swap probe
  is tracked as a follow-up.

### Fixed
- **rustfmt drift in `oximemo-cli/src/upgrade.rs`** — several lines added
  in 0.9.1 broke `cargo fmt --check`. Reformatted; CI fmt gate is green
  again on `main`.

## [0.9.1] — 2026-08-08

### Added
- **CLI self-update (`oximemo upgrade`)** — the `oximemo` CLI now updates itself
  from GitHub Releases, mirroring the desktop app's updater. Inside the app it
  replaces the whole `.app` bundle (GUI + CLI together); as a standalone binary
  it replaces just the binary. `--check` reports availability without installing.
  Both paths verify the release before installing (minisign signature for the
  bundle, SHA-256 for the CLI tarball).

## [0.9.0] — 2026-08-08

### Added
- **In-app auto-updater** — the desktop app detects newer signed builds
  from GitHub Releases and installs them in place (verify → swap →
  relaunch) via `tauri-plugin-updater`. Settings → "Updates" shows the
  available version with a download-and-install button and progress, and
  a launch-time check badges the settings gear and toasts once per new
  version. The release workflow signs `OxiMemo.app.tar.gz` and publishes
  a `latest.json` manifest the app polls at
  `releases/latest/download/latest.json`.

## [0.8.1] — 2026-08-08

### Changed
- **Editor layout unified** — `MemoEditorForm` now always uses a `flex-1
  min-h-0` layout in both immersive and normal modes (normal mode previously
  capped the editor at `max-h-[55vh]`), so the editor fills its container
  consistently across modes.
- **Memo-detail popup fills its box** — the detail popup now uses a fixed
  viewport-relative height (`h-[94vh]` / `h-[80vh]`) instead of a `max-height`,
  so it occupies the full intended area rather than collapsing to its content.

## [0.8.0] — 2026-08-07

### Added
- **In-app CLI install** — the `oximemo` CLI now ships inside the macOS app as
  a signed sidecar. Settings → "Command-line tool" (plus a first-launch nudge)
  exposes `oximemo` on `/usr/local/bin` via a one-time macOS admin prompt, so a
  single `.dmg` install gives you both the GUI and the terminal command.
  Headless/agent machines keep using the release tarball.

### Fixed
- **Release build** — disabled thin LTO in the release profile, which broke
  tauri 2.11.5's proc-macro linking (`E0463: can't find crate for
  tauri_macros`) and would have failed the release workflow.

## [0.7.0] — 2026-08-06

### Fixed
- **macOS: dock click reopens the main window after close** — the main window
  was destroyed on the red close button (no `CloseRequested` handler for
  non-capture windows) and there was no `RunEvent::Reopen` handler, so
  clicking the Dock icon could not bring the window back even though the
  app stayed alive. The main window's `CloseRequested` is now intercepted
  (`prevent_close` + `hide`) and re-shown on `RunEvent::Reopen`.

### Added
- **crates.io publish** — `oximemo-core`, `oximemo-capture`, and
  `oximemo-cli` are now published to crates.io and installable with
  `cargo install oximemo-cli`.

## [0.6.0] — 2026-08-04

### Added
- **oxi design-system token layer** — the desktop app now builds on the oxi
  semantic token tier: primitive → dark-override → component OKLCH tokens
  (`apps/desktop/src/tokens/`), exposed to Tailwind v4 via `@theme` in
  `app.css`. Self-hosted SUIT / SUITE variable fonts and Geist Mono replace
  system fonts. A FOUC-prevention script reads the `oxi-theme` key before
  first paint.
- **Apple Developer ID signing + notarization** — the macOS `.dmg` is now
  signed and notarized when the `APPLE_*` repository secrets are configured,
  so it opens without Gatekeeper warnings on first launch.

### Changed
- **Product name "OxiMemo"** — `productName`, bundle display name, and
  locale strings now spell "OxiMemo" (was lowercased).
- **Semantic color migration** — every desktop component now uses semantic
  utilities (`bg-surface`, `text-text`, `border-line`, `bg-hue-*`,
  `bg-status-*`, `bg-interactive-primary`) instead of raw zinc / hex values;
  inputs render borders via box-shadow per design spec 6.5.

## [0.5.0] — 2026-08-02

### Changed
- **CLI `--color` → `--category`** — the `new` command's `--color` flag stored
  its OKLCH value into the memo's `category` field (an orphan category that
  rendered with no color in the UI). Renamed to `--category <ID>` to match the
  desktop app and the on-disk data model. Color is a property of the category
  registry, derived for display; memos carry only a `category` id. **Breaking**
  for any script passing `--color`.

### Added
- **CLI parity** — `oximemo update` (edit body / favorite / category),
  `restore` (un-delete), `stats` (live counts), and a `category` group
  (`list` / `new` / `recolor` / `rename` / `delete`). `list` gains a
  `--category` filter. Closes the gap where the desktop app exposed memo +
  category operations the CLI lacked (image/asset management — `list_assets`,
  `gc_assets` — remains desktop-only).
- **`OXIMEMO_VAULT` env var** — the CLI now honors it for `--vault`, matching
  the desktop app.

### Fixed
- **GitHub Actions Node 20 deprecation** — bumped `actions/checkout`,
  `upload-artifact`, and `download-artifact` to v5 (Node 24 runtime).
- **Repo URL** — README badges, clone/install links, and Cargo metadata now
  point at `project-oxi/oximemo` (was `a7garden/oximemo`).
- **Docs reconciled to the `category` data model** — README/SKILL/DESIGN
  frontmatter example, hash description, OKLCH storage, and CLI reference.

## [0.4.0] — 2026-08-01

### Changed
- **`note` → `memo` terminology** — every identifier, IPC surface, file
  path, and JSON key previously spelled `note` is now `memo`, for parity
  with the user-facing Korean UI which already used "메모". This is a
  breaking change for external agents consuming the Tauri command/event
  surface or the CLI's JSON output.
  - Types: `Note` → `Memo`, `NoteId` → `MemoId`, `NoteHash` → `MemoHash`,
    `NoteSummary` → `MemoSummary`, `NoteFilter` → `MemoFilter`,
    `NoteStats` → `MemoStats`, `NoteWatcher` → `MemoWatcher`,
    `NoteIndex` → `MemoIndex`
  - Vault methods: `create_note` / `get_note` / `update_note` /
    `delete_note` / `list_notes` / `search_notes` / `note_stats` /
    `restore_note` / `read_note` all renamed
  - Tauri commands and event: `notes:changed` → `memos:changed`
  - Disk directory: `<vault>/notes/` → `<vault>/memos/`
    (auto-renamed on first `Vault::open` by `Vault::migrate`)
  - JSON keys: `IndexStats.notes` / `trashed` → `memos` / `trashed_memos`
- **`pin` → `favorites` terminology** — the pinned-memo concept is renamed to favorites: the `favorite` frontmatter field (was `pinned`), `MemoFilter.favorites_only`, the `--favorites` CLI flag (was `--pinned`), the `favoritesOnly` / `favorite` Tauri IPC keys, the Star icon, and "즐겨찾기" / "Favorites" UI labels. Pre-release: existing vaults must be reset.

### Removed
- **Builtin `note` category** — the `note` (blue) category is no longer
  a default. Existing memos with `category = "note"` fall back to the
  inbox/transparent color through the existing `resolve_category_color`
  orphan rule (no per-file rewrite required).

### Added

- **Gallery → open containing memo** — clicking a gallery image now opens the
  first memo that references it (the lightbox stays as the orphan-asset
  fallback). Adds a `find_memo_by_asset` core API and `memo_for_asset` command.

### Fixed

- **⌘I image shortcut inserted at the wrong cursor** — the wrapper `<div>`
  handler ran only after CodeMirror's built-in `Mod-i` (`selectParentSyntax`)
  had already expanded the selection, shifting the insertion point; a
  `Prec.highest` keymap now preempts it at the editor layer.
- **Vault `reset` was non-atomic** — derived indexes were cleared under the
  lock but source files were deleted afterward with errors swallowed, allowing
  a half-wiped state. File deletion now runs under the exclusive index lock and
  propagates errors.
- **Embed widgets ignored the locale** — `![[memo-id]]` loading/missing/open
  labels were hardcoded Korean; they now use the i18n dictionary, and the
  widget header shows the target memo's preview once resolved.
- **Tray menu default locale mismatched the renderer** on non-Korean/non-English
  systems — the default now mirrors the renderer's `detectInitial`.
- **Wiki-link autocomplete detail** now includes the relative date.
- **Immersive (focus) toggle** returns focus to the editor instead of leaving
  it on the toolbar button.
- **Gallery GC** now logs a warning when an unparseable memo's image refs
  cannot be counted.
- Removed the dead `CoreError::AssetInvalid` variant.
- **`oximemo` CLI did not compile** — `format.rs` still referenced the removed
  `color` field after the category refactor; updated to `category`.

## [0.3.0] — 2026-07-30

### Added
- **Inline `#tag` extraction** — tags are now derived from note bodies
  (`#foo` in the text is auto-recognized), with a chord-symbol guard
  (`C#m7` / `F#m7` are not mistaken for tags). No more separate tag chip input.
- **`list_facets` core API** — single backend aggregation of all tags and
  colors with counts, replacing the previous "loaded page only" facet hack.
- **Collapsible left sidebar** — filter the grid by tag (with count) and by
  color, plus a 3-state (inactive / include / exclude) filter with AND/OR
  composition. Apple Notes–style.
- **Tag accent color** — app-wide orange tag token (`--color-tag`) unifying
  sidebar filter chips, inline body chips, and card chips.
- **Capture & editor compose panel unification** — the post-it capture overlay
  and the full editor now share one component, ensuring visual and behavioral
  parity.

### Changed
- **Body-derived `tags` field** — `tags` on a note is now derived from the body
  on every read/write/index. Direct edits to `tags` in frontmatter are dropped
  on next reindex.
- **`hash` excludes `tags`** — note identity (BLAKE3 `b3:`) is now content-only,
  preventing spurious hash drift when tags are re-extracted.
- **`NoteFilter` is now a composite** — `Tag::Eq` / `Color::Eq` / `Text` /
  `Pinned` / `Date` collapse into one `NoteFilter` enum shared by CLI + Tauri.

## [0.2.0] — 2026-07-28

### Added
- **Cross-process index locking** — an advisory `fs2` flock now guards the redb
  index with shared (read) / exclusive (write) semantics and a 5 s timeout, so
  the CLI and the desktop app can share one vault safely.
- **Hardened file watcher** — 300 ms debounce plus up to 2 retries with a
  200 ms back-off for parse failures, with a "parse-pending" queue so external
  writes (editors, iCloud) never crash the indexer.
- **Overlay warm-up** — the capture window is created off-screen and kept
  `visible`, surfaced via a `capture:ready` handshake, so the overlay appears in
  a single frame (≤ 16 ms) on trigger.
- **Bulk ID input for `export`** — `--ids-file` and `--ids-stdin` join `--ids`
  to sidestep the macOS `ARG_MAX` (~256 KB) limit when syncing large batches.
- **Strict frontmatter parser** — the 5-rule `+++` TOML frontmatter contract is
  now enforced and documented for direct file writers.
- **OKLCH color system** — notes carry free-form `oklch()` colors with a
  perceptually-uniform preset palette, replacing the old string enum.
- **`config.toml`** — full vault configuration schema (retention, capture,
  appearance, index tuning) with forward-compatible parsing.
- **`oximemo doctor`** — 8-point vault/index consistency audit with a safe
  `--fix` mode (never deletes files).

### Changed
- Realistic idle-memory target of ~150 MB (was 100 MB), with rationale.

## [0.1.0] — 2026-07-21

### Added
- Initial public version.
- Card grid main window (search, tags, pin, OKLCH color labels) with virtualized
  scrolling.
- Three-tier storage: plain `.md` files (source of truth) + redb metadata index
  + tantivy BM25 full-text index.
- `Option` double-tap global capture overlay, with a `Cmd+Shift+N` fallback
  shortcut and a menu-bar status item.
- Note CRUD, soft-delete trash, and purge with configurable retention.
- `oximemo` CLI: `new`, `list`, `get`, `search`, `export`, `delete`, `purge`,
  `reindex`, `doctor`, `vault path` — JSON/NDJSON-first for agent consumption.
- Agent integration via `skills/oximemo/SKILL.md`.
- Light/dark mode following the macOS system appearance.

[0.8.0]: https://github.com/project-oxi/oximemo/releases/tag/v0.8.0
[0.7.0]: https://github.com/project-oxi/oximemo/releases/tag/v0.7.0
[0.6.0]: https://github.com/project-oxi/oximemo/releases/tag/v0.6.0
[0.5.0]: https://github.com/project-oxi/oximemo/releases/tag/v0.5.0
[0.4.0]: https://github.com/project-oxi/oximemo/releases/tag/v0.4.0
[0.3.0]: https://github.com/project-oxi/oximemo/releases/tag/v0.3.0
[0.2.0]: https://github.com/project-oxi/oximemo/releases/tag/v0.2.0
[0.1.0]: https://github.com/project-oxi/oximemo/releases/tag/v0.1.0
[Unreleased]: https://github.com/project-oxi/oximemo/compare/v0.9.3...HEAD
[0.9.3]: https://github.com/project-oxi/oximemo/releases/tag/v0.9.3
[0.9.2]: https://github.com/project-oxi/oximemo/releases/tag/v0.9.2
[0.9.1]: https://github.com/project-oxi/oximemo/releases/tag/v0.9.1
[0.9.0]: https://github.com/project-oxi/oximemo/releases/tag/v0.9.0
[0.8.1]: https://github.com/project-oxi/oximemo/releases/tag/v0.8.1
