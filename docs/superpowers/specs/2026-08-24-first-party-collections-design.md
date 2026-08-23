# First-Party Collections — Tier-Parity UI, Search-to-Add, Settings Consolidation

Date: 2026-08-24 · Status: approved-for-implementation (user asleep; decisions
delegated per prompt — "설계를 하고 구현까지 하면 돼")

## Problem

Book/movie/blog/novel(집필)/idea are first-party collections, but the UI
treats them like generic pinned folders:

1. **위치 tier gap** — installed collections render as generic pin rows
   (folder icon, drag handle), while 볼트/데일리/지식 get icon rows. They
   deserve the same tier with their catalog icons.
2. **Naming confusion** — "소설" (novel) reads as a *reading* collection
   next to "책" (books). It is a *writing* collection → rename to
   **집필** (ko) / **writing** (en). Preset id `novel` is stable data
   vocabulary and never changes.
3. **Add flow ignores metadata** — "책 추가" opens a blank templated note.
   First-party means the add flow for book/movie starts with an external
   search (title → poster/cover + descriptive props in one pick).
4. **Settings duplication** — provider API keys live in
   연동 → 메타데이터 while the collections pane only links there. Keys
   belong to each collection's own settings area; the metadata rail tab
   goes away.
5. **Per-collection support audit** — knowledge (review queue), daily
   (calendar/mood), book/movie (shelf + fill) are strong; blog/집필/idea
   are adequately served by the generic property engine (badges, chips,
   sort). Empty-state copy is the only gap: book/movie should pitch the
   search flow.

## Design

### A. 위친 (Locations) tier parity

`Sidebar.tsx`: a pinned folder whose schema carries a `[meta] preset`
marker renders with the catalog's icon (BookOpen/Clapperboard/FileText/
PenLine/Lightbulb, size 14) instead of the generic Folder icon. The row
stays a `SidebarFolderRow` — rename/unpin/reorder/delete/drop all keep
working; collections ARE folders, management is honest. Presence in
위치 remains pin-driven (install pins; deliberate unpin respected —
existing autopin/install semantics unchanged). Knowledge keeps its
hardcoded row; a collection that the user renamed keeps its icon
(marker follows the folder, not the name).

Implementation: Sidebar already loads config folders; add
`useSchemaInfo(paths)` (shared cached queries) and pass an optional
`icon` node into `SidebarFolderRow`.

### B. 소설 → 집필

- Locale: `collection_name_novel` "소설"→"집필" (en "Novel"→"Writing").
- Catalog `defaultFolder`: ko "소설"→"집필", en "novel"→"writing".
- `NOVEL_SCHEMA_TOML` workspace.name → "집필" (new installs; existing
  SCHEMA.toml files are user-owned and never rewritten — their display
  stays until reinstall, by design).
- tauri.ts fallback mirror updated to match.
- `kind: novel` option values unchanged (data, not display).

### C. Search-to-add (book/movie)

New `MetadataAddDialog.tsx` (Base UI Dialog, same shell as settings):
opens INSTEAD of blank-note creation whenever the active folder's
schema has a metadata domain (`metadataDomainOf` ≠ null — book/movie
presets and custom schemas declaring mapped fields).

- Search input (autofocus) → `searchBookMetadata`/`searchMovieMetadata`
  with the effective region (auto → Intl, same rule as the fill flow).
- Result rows: cover thumb (`hit.cover_url`, poster-ratio, typographic
  fallback), title, subtitle, provider tag. Enter runs the search; ↑↓
  optional (list is short; click/tap primary).
- Pick → `createMemo("# " + hit.title, folder)` (non-blank body keeps
  the H1 but still inherits template frontmatter stamps, e.g. movie
  `watched_at`) → `stampMetadata(id, hit)` (fills only empty
  schema-declared props + source_url + cover_url) → select the note,
  NO draftId (the note is deliberately created with content; closing
  must not discard it) → invalidate ["memos"]/["facets"] → close.
- "직접 추가" secondary button → existing blank-note path
  (`createMemo("")` + setDraftId), preserving offline/no-hit flows.
- Gate points: header add button, empty-state CTA, canvas context menu,
  and ⌘N (`onNewNote`) — all route through one `requestAdd()` that
  opens the dialog when a domain exists. The palette's newNote and
  FolderTile's per-folder "+ MD" stay direct (they target arbitrary
  folders; the dialog is folder-scoped to the active view).
- Empty-state sub copy switches per domain: "제목을 검색해 정보와
  표지를 한 번에 가져올 수 있어요".
- stamp fallback (`null` in browser mode) is handled: cache-set skipped.

### D. Settings consolidation

- New `ProviderKeys.tsx` (extracted from MetadataSection): provider
  catalog rows (badge + key input with show/hide) + region select,
  compact enough for an expand area. Keys auto-save on commit
  (Enter/blur) by merging into `[metadata]` via `setMetadataConfig`;
  no save button. A subtle "저장됨" flash replaces it.
- Collections pane: book row embeds book providers (google_books,
  aladin + keyless open_library/ndl_search/dnb_sru as status-only
  rows); movie row embeds movie providers (tmdb, omdb, kmdb + approval
  hint). Region select appears in both (shared field, stays in sync
  via query invalidation).
- Removed: 연동 → 메타데이터 rail entry, MetadataSection.tsx, the
  "메타데이터 키 설정" jump button, locale keys `metadata`,
  `metadata_enabled`, `metadata_save`, `metadata_saved`,
  `collection_metadata_keys`, `collection_provider_hint`.
  `[metadata] enabled` stays a config.toml field (backend compat);
  no UI — keys-empty already disables keyed providers and search is
  always user-initiated, so a master switch guards nothing passive.

### E. Non-goals

- No new long-form writing views for 집필 (chapters-as-notes + status
  chips carry it; spec §7 unchanged).
- No blog publish integration (platform/published_at props suffice).
- No per-collection keychain hardening, no new providers.

## Verification

- `bun run build` (tsc) + `bun test` (locale parity, catalog,
  installCollection, metadataRegion).
- `cargo test -p oximemo-core` (schema presets incl. renamed 집필) and
  `cargo test` in src-tauri (metadata mapping unchanged).
- Browser drive on vite (fallback mode): install book/movie → sidebar
  icons; 책 추가 → dialog (empty results in fallback → 직접 추가);
  settings: keys inline in collections pane, metadata tab gone;
  집필 label in catalog + picker.
