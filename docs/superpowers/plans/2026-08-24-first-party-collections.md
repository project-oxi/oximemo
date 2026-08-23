# First-Party Collections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Execution mode (established preference):** inline in this session.

**Goal:** Collections get 위치-tier icons, 집필 rename, book/movie
search-to-add, and provider keys move into the collections pane.

**Architecture:** Preset marker (`[meta] preset`) is the single source of
"which collection is this folder" — icons, add-flow gating, and settings
embedding all read it through the shared `useSchemaInfo` cache. The
metadata search/stamp backend is unchanged; only the UX in front of it.

**Tech Stack:** React 19 + Base UI + TanStack Query (apps/desktop/src),
Rust core presets (crates/oximemo-core), bun test, cargo test.

## Global Constraints

- Preset id `novel` never changes; only display names do.
- Existing SCHEMA.toml files are never rewritten (skip-if-exists).
- Another session works in this repo concurrently: re-read every file
  immediately before editing; never `git checkout`/rollback shared files.
- Locale dicts must stay key-parity (ko source of truth, en derives).

---

### Task 1: Core preset rename 소설 → 집필

**Files:**
- Modify: `crates/oximemo-core/src/schema.rs` (NOVEL_SCHEMA_TOML)
- Modify: `apps/desktop/src/lib/tauri.ts` (NOVEL_PRESET_SCHEMA mirror)
- Test: existing `collection_presets_parse_with_marker` covers parse.

- [ ] NOVEL_SCHEMA_TOML `workspace.name = "집필"`; comment updated.
- [ ] tauri.ts NOVEL_PRESET_SCHEMA `workspace: { name: "집필" }`.
- [ ] `cargo test -p oximemo-core schema` passes.

### Task 2: Catalog + locale updates

**Files:**
- Modify: `apps/desktop/src/lib/collectionCatalog.ts` (novel defaultFolder)
- Modify: `apps/desktop/src/lib/locales/ko.ts`, `en.ts`

**Produces:** locale keys `metadata_add_title`, `metadata_add_manual`,
`metadata_add_from_hit` (unused? — no, manual only), `schema_empty_sub_search`,
`provider_keys_saved`; renamed `collection_name_novel`; removed
`metadata`, `metadata_enabled`, `metadata_save`, `metadata_saved`,
`collection_metadata_keys`, `collection_provider_hint`.

- [ ] defaultFolder novel → { ko: "집필", en: "writing" }.
- [ ] ko/en edits per Produces; parity via `as const satisfies`.
- [ ] `bun test src/lib/installCollection.test.ts` + tsc pass.

### Task 3: Sidebar collection icons

**Files:**
- Modify: `apps/desktop/src/components/Sidebar.tsx`

- [ ] `useSchemaInfo(folders.map(f => f.path))` in Sidebar; map preset →
      catalog icon; pass `icon` prop to SidebarFolderRow (replaces the
      `<Folder>` node when present, size 14).
- [ ] Browser check: 책/영화/아이디어 rows show BookOpen/Clapperboard/
      Lightbulb; generic pins keep Folder.

### Task 4: Search-to-add dialog

**Files:**
- Create: `apps/desktop/src/components/MetadataAddDialog.tsx`
- Modify: `apps/desktop/src/components/CardGrid.tsx` (gate + empty copy)

**Interfaces:**
- `<MetadataAddDialog open folder schema onClose onManual />` — renders
  search UI, calls createMemo + stampMetadata itself, selects the note.
- `metadataDomainOf(schema)` (existing) decides gating in CardGrid.

- [ ] Dialog component: search form, results with cover/thumb fallback,
      provider tag, busy/empty states, 직접 추가 button.
- [ ] Pick → create `# title` → stamp → select (no draftId) → close.
- [ ] CardGrid: `requestAdd()` replaces direct create in header button,
      empty CTA, ctx menu, ⌘N when domain ≠ null; empty-state sub swaps
      to `schema_empty_sub_search`.
- [ ] Browser: 책 추가 opens dialog (fallback → empty list → 직접 추가
      creates the old way); 블로그 추가 stays direct.

### Task 5: Settings consolidation

**Files:**
- Create: `apps/desktop/src/components/ProviderKeys.tsx`
- Modify: `apps/desktop/src/components/SettingsMenu.tsx`
- Delete: `apps/desktop/src/components/MetadataSection.tsx`

- [ ] Extract PROVIDERS/KEY_FIELD/ProviderBadge + compact ProviderRow
      (name + badge + key input w/ show-hide, save on Enter/blur via
      merged setMetadataConfig + 저장됨 flash) + RegionSelect into
      ProviderKeys.tsx.
- [ ] CollectionsSection: book/movie expand embeds ProviderKeys(domain)
      + region; drop the metadata jump button.
- [ ] Remove rail entry `metadata`, pane render, MetadataSection import;
      delete MetadataSection.tsx.
- [ ] Browser: settings has no 메타데이터 tab; book expand shows
      provider inputs; keys persist after reopen.

### Task 6: Verification + docs

- [ ] `bun run build` && `bun test` (apps/desktop).
- [ ] `cargo test -p oximemo-core` && `cargo test` (src-tauri workspace
      member) — run `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` if separate.
- [ ] Browser smoke per Tasks 3–5; screenshots via inspect_image.
- [ ] CHANGELOG entry; commit `feat(desktop): first-party collections —
      location icons, 집필 rename, search-to-add, per-collection keys`.
