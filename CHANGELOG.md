# Changelog

All notable changes to oxinot are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- **`oxinot` CLI did not compile** — `format.rs` still referenced the removed
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
- **`oxinot doctor`** — 8-point vault/index consistency audit with a safe
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
- `oxinot` CLI: `new`, `list`, `get`, `search`, `export`, `delete`, `purge`,
  `reindex`, `doctor`, `vault path` — JSON/NDJSON-first for agent consumption.
- Agent integration via `skills/oxinot/SKILL.md`.
- Light/dark mode following the macOS system appearance.

[Unreleased]: https://github.com/a7garden/oxinot/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/a7garden/oxinot/releases/tag/v0.3.0
[0.2.0]: https://github.com/a7garden/oxinot/releases/tag/v0.2.0
[0.1.0]: https://github.com/a7garden/oxinot/releases/tag/v0.1.0
