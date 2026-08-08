# Changelog

All notable changes to oximemo are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/project-oxi/oximemo/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/project-oxi/oximemo/releases/tag/v0.8.0
[0.7.0]: https://github.com/project-oxi/oximemo/releases/tag/v0.7.0
[0.6.0]: https://github.com/project-oxi/oximemo/releases/tag/v0.6.0
[0.5.0]: https://github.com/project-oxi/oximemo/releases/tag/v0.5.0
[0.4.0]: https://github.com/project-oxi/oximemo/releases/tag/v0.4.0
[0.3.0]: https://github.com/project-oxi/oximemo/releases/tag/v0.3.0
[0.2.0]: https://github.com/project-oxi/oximemo/releases/tag/v0.2.0
[Unreleased]: https://github.com/project-oxi/oximemo/compare/v0.8.1...HEAD
[0.8.1]: https://github.com/project-oxi/oximemo/releases/tag/v0.8.1
