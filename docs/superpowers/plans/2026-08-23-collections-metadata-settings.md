# Collections Library · Metadata Providers · Settings Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Installable collection presets (book/movie/blog/novel/idea), a multi-country metadata provider layer for book/movie notes, and a rail+content settings modal — per spec `docs/superpowers/specs/2026-08-23-collections-metadata-settings-design.md`.

**Architecture:** Presets stay pure data (TEMPLATE.md + SCHEMA.toml consts in `oximemo-core`); `install_collection(preset_id, folder)` generalizes the existing `apply_preset`. Metadata splits: core holds the pure `ProviderInfo` catalog + field mapping, `src-tauri` holds HTTP adapters (app's first network dep). Settings becomes a centered modal with a left rail; existing section components are reused verbatim.

**Tech Stack:** Rust (tauri 2, oximemo-core, reqwest+rustls NEW), TS/React 19, Base UI Dialog, TanStack Query, Tailwind oxi tokens, bun test.

## Global Constraints

- Schema validation stays warning-level; presets must not add `required` unless the spec's table says so.
- `oximemo-core` gains NO network dependency — provider HTTP lives in `src-tauri`.
- Existing files are never overwritten by presets (skip-if-exists); existing daily/knowledge SCHEMA.toml files are NOT rewritten (marker fallback by path).
- Custom user schemas (no `[meta] preset`) never appear as collection tabs.
- `kind` vocabulary: note|knowledge|daily|book|movie|blog|novel|idea; ordinary notes stay absent.
- Browser fallback (tauri.ts): collection install = yes, metadata search = desktop-only (hidden in fallback, like backlinks).
- i18n: every user-facing string in `locales/ko.ts` + `locales/en.ts` (well-known vocab only; custom schemas stay verbatim).
- Gates per commit: `cargo test --workspace` (291+), `bun x tsc --noEmit`, `bun test`, `bun run build` (apps/desktop).
- Conventional commits, English bodies.

---

### Task 1: Settings modal shell (rail + content pane)

**Files:**
- Modify: `apps/desktop/src/components/SettingsMenu.tsx` (restructure `SettingsMenu()` render, lines ~771-1062)
- Modify: `apps/desktop/src/locales/ko.ts`, `en.ts` (rail group/tab labels)

**Interfaces:**
- Produces: `SettingsMenu` export unchanged (same trigger, same `settingsOpen` store flag). Internal: `RailItem { id: string; label: string; icon: ReactNode }`, `activeTab` local state.

**Steps:**
- [ ] Restructure `Dialog.Popup`: centered `left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(880px,92vw)] h-[min(640px,85vh)] flex` → left rail `w-[200px] border-r border-line overflow-y-auto py-3` + right pane `flex-1 overflow-y-auto px-6 py-4`.
- [ ] Rail groups: 일반[외관/동작/캡처], 연동[브레인], 폴더 관리, 시스템[저장소/고급/CLI/업데이트/정보]. Group headers `text-[10px] uppercase tracking-wide text-text-subtle px-3 pt-3`. Items: icon + label, active = `bg-surface-muted text-text`, inactive `text-text-muted hover:bg-surface-muted/50`.
- [ ] Content pane per tab reuses the existing section bodies verbatim (Appearance block, `GeneralSection`, `CaptureSection`, `BrainSection`, `FoldersSection`, Storage block, `AdvancedSection`, `CliSection`, `UpdaterSection`, About block). Move the Section-title into a pane header (`h2 text-sm font-semibold`).
- [ ] Default tab: 외관. ESC/backdrop close unchanged (Dialog.Root handles).
- [ ] Gates: tsc/build. Browser e2e: open settings, click every rail item, assert each pane renders (spot-check 3 panes' content strings).
- [ ] Commit: `feat: settings drawer → centered rail+content modal`

### Task 2: Core preset catalog + `[meta] preset` + install_collection

**Files:**
- Modify: `crates/oximemo-core/src/schema.rs` (SchemaMeta struct, 5 preset const pairs, [meta] in knowledge/daily consts)
- Modify: `crates/oximemo-core/src/vault.rs` (preset registry, `install_collection`)
- Test: in-file `#[cfg(test)]` blocks (existing pattern)

**Interfaces:**
- Produces: 
  ```rust
  pub struct SchemaMeta { pub preset: Option<String> }   // [meta] table; FolderSchema.meta
  pub const BOOK_TEMPLATE_MD: &str;  pub const BOOK_SCHEMA_TOML: &str;
  pub const MOVIE_TEMPLATE_MD: &str; pub const MOVIE_SCHEMA_TOML: &str;
  pub const BLOG_TEMPLATE_MD: &str;  pub const BLOG_SCHEMA_TOML: &str;
  pub const NOVEL_TEMPLATE_MD: &str; pub const NOVEL_SCHEMA_TOML: &str;
  pub const IDEA_TEMPLATE_MD: &str;  pub const IDEA_SCHEMA_TOML: &str;
  pub fn collection_preset(id: &str) -> Option<(&'static str, &'static str)>;  // (template_md, schema_toml)
  impl Vault { pub fn install_collection(&self, preset_id: &str, folder: &str) -> Result<()>; }  // creates folder, apply_preset semantics (skip-if-exists)
  ```
- PropertyDef gains `pub metadata: Option<String>` (schema field `metadata = "author"` → MetaField name), Task 6 consumes.

**Preset content (exact):**
- Templates: `book`: `"---\nkind: book\nstatus: reading\n---\n\n# \n"`; `movie`: `"---\nkind: movie\nwatched_at: {{date}}\n---\n\n# \n"`; `blog`: `"---\nkind: blog\nstatus: draft\n---\n\n# \n"`; `novel`: `"---\nkind: novel\nstatus: outline\n---\n\n# \n"`; `idea`: `"---\nkind: idea\nstatus: fleeting\n---\n\n# \n"`. (Mirror KNOWLEDGE_TEMPLATE_MD shape; no blank line issue — no {{date}} H1 dependency except none here.)
- Schemas: each starts `[meta]\npreset = "<id>"` + `[workspace]` mirroring DAILY_SCHEMA_TOML's workspace shape; properties per spec §2.2:
  - book: `kind`(select), `status`(select reading/done/paused/abandoned, badge, colors info/success/neutral/warning), `rating`(select 1-5), `author`(text, `metadata = "author"`), `[review]` mirroring knowledge's review block (property = "status" does NOT fit books — review is for highlights; use review property = "status" with due_values = ["done"]? NO — books review the *notes* when finished: due_values=["done"], decay_to="reading"… DECISION: `[review] property = "status", due_values = ["done"], decay_to = "paused"` — finished books resurface for highlight review; "다시 읽기" reasserts).
  - movie: `kind`, `watched_at`(date), `rating`(select 1-5), `series`(bool).
  - blog: `kind`, `status`(draft/revising/scheduled/published, badge, neutral/warning/info/success), `platform`(text), `published_at`(date).
  - novel: `kind`, `status`(outline/draft/rev1/done, badge, neutral/info/warning/success).
  - idea: `kind`, `status`(fleeting/archived, badge, info/neutral), `source`(text), `[review] property = "status", due_values = ["fleeting"], decay_to = "archived", promote = { into = "knowledge", kind = "knowledge", start_status = "stub" }` (promote table parsed in Task 5).
- knowledge/daily consts: prepend `[meta]\npreset = "knowledge"` / `"daily"` (new installs carry the marker; existing files untouched).

**Steps:**
- [ ] Add `SchemaMeta` + `FolderSchema.meta` field (serde default) — keep `deny_unknown_fields`.
- [ ] Write failing tests: `collection_preset` returns all 6 ids; `install_collection("book", "책")` creates folder + TEMPLATE.md + SCHEMA.toml with `[meta] preset = "book"`; re-run is skip-if-exists (mtimes unchanged / same content); unknown id errors.
- [ ] Implement consts + registry + `Vault::install_collection` (delegate to private `apply_preset`).
- [ ] `cargo test -p oximemo-core` green; full workspace gate.
- [ ] Commit: `feat(core): collection preset catalog + install_collection + [meta] marker`

### Task 3: IPC + frontend API + browser fallback parity

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs` (command `install_collection(preset_id, folder)`; REMOVE `apply_knowledge_preset` command)
- Modify: `apps/desktop/src/lib/api.ts` (replace `applyKnowledgePreset` with `installCollection(presetId, folder)`; update the ONLY callsite `CardGrid.tsx:42,826` to `installCollection("knowledge", to)`)
- Modify: `apps/desktop/src/lib/types.ts` (`FolderSchema.meta?: { preset?: string }`)
- Modify: `apps/desktop/src/lib/tauri.ts` (fallback: 5 preset mirrors like `DAILY_PRESET_SCHEMA`, `installCollection` writing localStorage schemas + folder, `ensureDefaultFolders` unchanged)
- Test: `apps/desktop/src/lib/*.test.ts` (bun) — install writes schema+template seed, skip-if-exists, unknown id rejects.

**Steps:**
- [ ] bun failing tests for fallback `installCollection`; implement; green.
- [ ] Rust command wiring; `cargo build` + tauri type gate (tsc).
- [ ] Commit: `feat: install_collection IPC + fallback parity (replaces apply_knowledge_preset)`

### Task 4: Collection catalog picker + ⌘K + settings rail "설치된 컬렉션"

**Files:**
- Create: `apps/desktop/src/components/CollectionCatalogPicker.tsx` (Base UI Dialog; grid of uninstalled presets: icon, localized name, one-line desc, folder-name input defaulting to localized name, 설치 → `installCollection`)
- Modify: `apps/desktop/src/stores/ui.ts` (`collectionPickerOpen` flag + setter)
- Modify: `apps/desktop/src/lib/paletteCommands.ts` + `CommandPalette.tsx` + `CardGrid.tsx` (command "컬렉션 추가" → `openCollectionPicker` callback)
- Modify: `apps/desktop/src/components/SettingsMenu.tsx` (dynamic rail group: installed collections computed from folders+schemas via `useSchemaInfo`/folder list — `[meta].preset` first, path==config daily/knowledge fallback; `CollectionSection` pane: folder path, 폴더로 이동 (setFolderFilter), 제거 2-click (deleteFolder; daily/knowledge labeled 초기화 w/ system-folder note + `[daily] enabled` toggle via `setDailyConfig`), book/movie: provider link → metadata tab)
- Modify: locales ko/en.

**Interfaces:**
- Consumes: `installCollection` (Task 3), `FolderSchema.meta.preset`, existing `deleteFolder`/`setFolderFilter`/`setDailyConfig`.
- Produces: `CollectionCatalogPicker({ open, onClose })`; ui flag `collectionPickerOpen`.

**Steps:**
- [ ] Picker component + ui flag + palette command (score keys: palette_add_collection).
- [ ] Settings dynamic rail group + CollectionSection.
- [ ] Gates + browser e2e: install 책 via picker → rail tab appears → pane shows path → 제거 → tab gone; ⌘K "컬렉션 추가" opens picker.
- [ ] Commit: `feat: collection library — catalog picker, ⌘K entry, installed-collections settings rail`

### Task 5: Ideas — review promote/archive

**Files:**
- Modify: `crates/oximemo-core/src/schema.rs` (`ReviewDef.promote: Option<PromoteDef>`; `PromoteDef { into: String, kind: String, start_status: Option<String> }`)
- Modify: `apps/desktop/src/lib/types.ts` (`SchemaReviewDef.promote?`)
- Modify: `apps/desktop/src/components/ReviewQueue.tsx` (when `review.promote` present: actions = "지식으로 승격" / "보관(→decay_to)"; promote = `updateMove(id, { folder: promote.into, props: {kind: Str(promote.kind), status: Str(start_status ?? "stub")} })` — verify `updateMove` IPC accepts props+folder atomically; else `moveNote`+`updateMemo`)
- Modify: locales.

**Steps:**
- [ ] Rust parse test for promote table; TS type.
- [ ] ReviewQueue actions + invalidation (["memos","folderChildren","folder-schema"]).
- [ ] e2e (browser): install idea → new idea note (status fleeting) → review queue shows it → 승격 → note lives in knowledge/ with kind knowledge + status stub; 보관 → status archived, queue empties.
- [ ] Commit: `feat: ideas collection — review queue promote-to-knowledge / archive`

### Task 6: Metadata core contracts

**Files:**
- Modify: `crates/oximemo-core/src/schema.rs` or new `crates/oximemo-core/src/metadata.rs`: 
  ```rust
  pub enum MetaField { Author, Isbn, PageCount, PublishedDate, Director, ReleaseDate, RuntimeMin, OriginalTitle }
  pub struct MetaHit { pub provider: String, pub title: String, pub subtitle: Option<String>, pub url: Option<String>, pub fields: BTreeMap<MetaField, String> }
  pub enum ProviderAccess { Keyless, ConditionalKeyless, Keyed, KeyedWithApproval }
  pub struct ProviderInfo { pub id: &'static str, pub domain: ProviderDomain, pub access: ProviderAccess, pub regions: &'static [&'static str] }  // empty regions = global
  pub const PROVIDER_CATALOG: &[ProviderInfo];  // 8 entries per spec §3.2
  pub fn stamp_targets(schema: &FolderSchema, hit: &MetaHit) -> Vec<(String, PropValue)>;  // props with `metadata` field matching hit fields → Str values; excludes rating (never mapped in presets)
  pub fn provider_order(domain: ProviderDomain, region: &str) -> Vec<&'static str>;  // region priority per spec §3.3 table
  ```
- Modify: book/movie SCHEMA consts (author metadata="author"; add `isbn` text metadata="isbn"? — DECISION: no extra props beyond spec; author only for book; movie adds none in v1).
- Tests: provider_order per region table; stamp_targets fixture.

**Steps:**
- [ ] Failing tests → implement → green → workspace gate.
- [ ] Commit: `feat(core): metadata provider catalog + declarative stamp mapping`

### Task 7: src-tauri metadata config + provider adapters

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml` (`reqwest = { version = "0.12", default-features = false, features = ["json","rustls-tls"] }`)
- Modify: `crates/oximemo-core/src/config.rs` (`[metadata]` section: `enabled: bool(default true)`, `region: String(default "")`, five key fields; `set_metadata_config` section setter mirroring `set_brain_config`)
- Create: `apps/desktop/src-tauri/src/metadata.rs` (adapter fn per provider: `openlibrary_search`, `google_books_search`, `aladin_search`, `ndl_search`, `dnb_search`, `tmdb_search`, `omdb_search`, `kmdb_search` — each takes query+lang+key, returns `Vec<MetaHit>`; commands `search_book_metadata(query)` / `search_movie_metadata(query)` gated on `[metadata] enabled` + key presence per provider_order; `set_metadata_config` command)
- Test: fixture-based mapping tests (each provider: canned JSON/XML → MetaHit fields). No network in tests.

**Steps:**
- [ ] Config section + setter + command wiring + `cargo test`.
- [ ] Adapters with fixture tests (one per provider).
- [ ] Commit: `feat: metadata providers (8) + [metadata] config + search IPC`

### Task 8: Metadata settings pane + stamp UX

**Files:**
- Create: `apps/desktop/src/components/MetadataSection.tsx` (settings pane: enabled toggle, region select [auto-detect via `Intl.DateTimeFormat().resolvedOptions().locale` → ISO 3166; options: 대한민국/일본/독일/글로벌+others raw codes], provider list grouped 책/영화 sorted by provider_order with badges 키리스/조건부 키리스/키 필요/승인 대기, key TextRows, 저장 시 ping test)
- Modify: `apps/desktop/src/lib/api.ts` (`searchBookMetadata`/`searchMovieMetadata`/`setMetadataConfig`), `types.ts` (MetadataConfig)
- Modify: `apps/desktop/src/components/PropertyPanel.tsx` (header action "메타데이터 채우기" when schema has ≥1 `metadata`-mapped prop AND desktop (tauri available); popover: query input → results (provider-grouped, TMDB attribution footer) → pick → `updateMemo` with stamp_targets-equivalent props + `source_url` Str)
- Modify: SettingsMenu rail (연동 group gains 메타데이터 tab), locales ko/en.

**Steps:**
- [ ] MetadataSection + config plumbing; region select writes `[metadata] region`.
- [ ] PropertyPanel popover + stamp flow (desktop-only; fallback browser: affordance hidden).
- [ ] Gates + browser e2e (pane renders, badges, region switch; search UI hidden in fallback — assert affordance absent).
- [ ] Commit: `feat: metadata settings pane + fill-from-search stamping`

### Task 9: Closeout

- [ ] CHANGELOG entry (collections + metadata + settings).
- [ ] Spec status → 구현 완료; date stamp.
- [ ] Full gates: cargo workspace, tsc, bun test, build, browser e2e sweep (settings nav, install/uninstall, ideas promote, metadata pane).
- [ ] Final commit: `docs: collections/metadata/settings changelog + spec status`

## Self-Review (done)

- Spec coverage: §2 library=T2-5, §3 metadata=T6-8, §4 settings=T1/T4/T8, §5 lists=T2/3/7/8, §6 verification=per-task gates+T9, §7 out-of-scope honored (no poster rendering, no manual reorder).
- Types: `installCollection(presetId: string, folder: string)` used consistently; `SchemaReviewDef.promote` matches Rust `ReviewDef.promote`; `MetaHit`/`stamp_targets` core-side only (frontend consumes via IPC DTO).
- Known risk: `updateMove` props support unverified — Task 5 step verifies before use, fallback documented.
