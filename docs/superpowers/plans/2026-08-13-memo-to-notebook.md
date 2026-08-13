# Memo → Notebook Transformation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform oximemo from a flat memo app into a physical-folder, title-based markdown notebook with wiki links, templates, and 4 view modes.

**Architecture:** Markdown files in physical folders are the single source of truth. File name = title (derived from H1). Folder location = organization. Frontmatter simplified (no category/folder/deleted_at). redb + tantivy are rebuildable caches. Wiki links resolve by filename. Templates are per-folder `TEMPLATE.md` files.

**Tech Stack:** Rust (edition 2024, redb 2, tantivy 0.22, notify 7), Tauri 2 + React 19, @atomic-editor/editor (CM6), Zustand, TanStack Query, Tailwind v4, d3-force (graph view).

**Spec:** `docs/superpowers/specs/2026-08-13-memo-to-notebook-design.md`

## Global Constraints

- **Rust edition 2024**, MSRV 1.89.
- **CI gates (must pass before each commit):**
  ```bash
  cargo fmt --all -- --check
  cargo clippy -p oximemo-core -p oximemo-cli -p oximemo-capture --all-targets -- -D warnings
  cargo test -p oximemo-core -p oximemo-cli -p oximemo-capture
  cd apps/desktop && bun run build
  ```
- **No types/modes/kinds.** One entity. Content + location determine behavior.
- **100% markdown compatibility.** Body is pure CommonMark + GFM.
- **File is truth.** Indexes are caches rebuildable via `oximemo reindex`.
- **Backward-compatible parsing.** Old frontmatter (`category`, `deleted_at`) is read and mapped; new writes use the simplified schema.
- **Commit convention:** `feat:`, `fix:`, `refactor:`, `test:`, `docs:` — one logical change per commit.

---

## File Structure (Target State)

```
crates/oximemo-core/src/
├── memo.rs          # MODIFY: remove category, add derive_title()
├── config.rs        # MODIFY: CategoriesConfig → FoldersConfig, schema_version 3
├── paths.rs         # MODIFY: remove date sharding, vault-root-relative paths
├── vault.rs         # MODIFY: folder ops, title-based listing, rename propagation
├── store/
│   ├── files.rs     # MODIFY: folder-aware file ops, simplified Frontmatter
│   ├── index.rs     # MODIFY: redb schema (path, title fields), backlinks table
│   └── search.rs    # MODIFY: title field, path filtering
├── migrate.rs       # CREATE: vault migration old→new layout
├── wiki.rs          # CREATE: [[link]] parsing, title resolution, backlink graph
├── template.rs      # CREATE: TEMPLATE.md loading, variable substitution
├── error.rs         # MODIFY: new error variants
├── lib.rs           # MODIFY: pub mod migrate, wiki, template
└── (hash, lock, paths, sync, tags, watcher, assets — minor updates)

crates/oximemo-cli/src/
└── main.rs          # MODIFY: migrate subcommand, folder-aware CLI args

apps/desktop/src-tauri/src/
└── lib.rs (or commands.rs)  # MODIFY: new Tauri commands for folders, rename, etc.

apps/desktop/src/
├── components/
│   ├── Sidebar.tsx          # MODIFY: folder tree
│   ├── CardGrid.tsx         # MODIFY → rename to GridView.tsx
│   ├── ListView.tsx         # CREATE
│   ├── TimelineView.tsx     # CREATE
│   ├── GraphView.tsx        # CREATE
│   ├── ViewSwitcher.tsx     # CREATE: 4-mode toggle + lock
│   ├── Toolbar.tsx          # CREATE: breadcrumb + view + sort
│   ├── BacklinksPanel.tsx   # CREATE
│   └── ContextMenu.tsx      # MODIFY: folder move, rename, wiki link copy
├── lib/
│   ├── tauri.ts             # MODIFY: new command bindings
│   ├── memoLinks.ts         # MODIFY: UUID→title serialization
│   ├── embeds.ts            # MODIFY: UUID→title resolution
│   └── wiki.ts              # CREATE: frontend wiki link helpers
└── stores/
    └── ui.ts                # MODIFY: folder nav, view mode, lock state
```

---

## Phase 1: Rust Core — Data Model & Storage

Foundation for everything. Must compile and pass tests before any other phase.

### Task 1.1: Update `Memo` struct — remove category, add title derivation

**Files:**
- Modify: `crates/oximemo-core/src/memo.rs`
- Test: `crates/oximemo-core/src/memo.rs` (inline `#[cfg(test)] mod tests`)

**Interfaces:**
- Produces: `pub fn derive_title(body: &str) -> Option<String>` — extracts first `# H1` heading text.
- Produces: `pub fn slugify(title: &str) -> String` — normalizes title to filesystem-safe filename.
- Produces: `pub fn timestamp_filename(t: OffsetDateTime) -> String` — `YYYY-MM-DD-HHMMSS` for untitled notes.
- Removes: `category: String` field from `Memo` and `MemoSummary`.
- Removes: `MemoFilter.category` field (replaced by `folder: Option<String>` — a path prefix filter).

**Implementation:**

```rust
/// Derive a note's display title from its body: the first `# H1` heading.
/// Returns None if no H1 exists (untitled memo).
pub fn derive_title(body: &str) -> Option<String> {
    for line in body.lines() {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("# ") {
            let title = rest.trim().to_string();
            if !title.is_empty() {
                return Some(title);
            }
        }
        // Skip empty lines but keep scanning; stop at first non-empty
        // non-heading line? No — H1 could be after a blank line. Scan all.
    }
    None
}

/// Normalize a title into a filesystem-safe filename component.
/// Spaces → hyphens, removes `/ \ : * ? " < > |`, preserves Unicode.
pub fn slugify(title: &str) -> String {
    let mut s: String = title
        .trim()
        .chars()
        .map(|c| match c {
            ' ' => '-',
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '\0', // mark for removal
            _ => c,
        })
        .filter(|c| *c != '\0')
        .collect();
    // Collapse multiple hyphens
    while s.contains("--") {
        s = s.replace("--", "-');
    }
    s.trim_matches('-').to_string()
}

/// Generate a timestamp-based filename for untitled notes.
pub fn timestamp_filename(t: OffsetDateTime) -> String {
    format!(
        "{:04}-{:02}-{:02}-{:02}{:02}{:02}",
        t.year(),
        t.month() as u8,
        t.day(),
        t.hour(),
        t.minute(),
        t.second(),
    )
}
```

- [ ] **Step 1:** Write tests for `derive_title`, `slugify`, `timestamp_filename`
- [ ] **Step 2:** Run tests — verify they fail (functions don't exist yet)
- [ ] **Step 3:** Implement the three functions
- [ ] **Step 4:** Run tests — verify pass
- [ ] **Step 5:** Remove `category` field from `Memo`, `MemoSummary`, `MemoFilter`. Replace `MemoFilter.category: Vec<String>` with `MemoFilter.folder: Option<String>` (path prefix). Update `MemoFilter::matches` accordingly.
- [ ] **Step 6:** Run `cargo check -p oximemo-core` — fix all compile errors (there will be many in vault.rs, index.rs, etc. — comment out or stub for now, fix properly in later tasks)
- [ ] **Step 7:** Commit: `refactor(core): remove category field, add title derivation utilities`

### Task 1.2: Simplify `Frontmatter`

**Files:**
- Modify: `crates/oximemo-core/src/store/files.rs`
- Test: inline tests

**Interfaces:**
- `Frontmatter` fields: `id`, `created_at`, `updated_at`, `hash`, `favorite`, `tags`.
- Removes: `category`, `deleted_at` from `Frontmatter`.
- Backward compat: `ParsedFile::parse()` reads old frontmatter — if `category` exists, it's ignored (folder is derived from file path); if `deleted_at` exists, file is treated as trashed.

**Implementation:**

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Frontmatter {
    pub id: MemoId,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
    pub hash: crate::memo::MemoHash,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub tags: Vec<String>,
    // category and deleted_at REMOVED — serde ignores unknown fields by default
    // when using #[serde(default)] on the struct (add #[serde(deny_unknown_fields)]? NO —
    // we WANT to ignore old fields for backward compat)
}
```

Note: serde ignores unknown fields by default (no `deny_unknown_fields` attribute). Old files with `category = "..."` will parse fine — the field is simply ignored.

- [ ] **Step 1:** Update `Frontmatter` struct (remove fields)
- [ ] **Step 2:** Update `Frontmatter::from_memo()` mapping
- [ ] **Step 3:** Write test: parse old frontmatter (with `category`, `deleted_at`) → succeeds, fields ignored
- [ ] **Step 4:** Write test: round-trip new frontmatter (write → read → compare)
- [ ] **Step 5:** Run tests — verify pass
- [ ] **Step 6:** Commit: `refactor(core): simplify frontmatter, backward-compatible parsing`

### Task 1.3: Update `Paths` — remove date sharding

**Files:**
- Modify: `crates/oximemo-core/src/paths.rs`

**Interfaces:**
- Removes: `MEMOS_DIR` constant, `shard()` function, date-based path computation.
- `Paths::note_path(&self, folder: &str, filename: &str) -> PathBuf` — vault-root-relative.
- `Paths::trash_path(&self, rel_path: &str) -> PathBuf` — `.trash/<rel_path>`.
- `Paths::scan_root(&self) -> &Path` — the vault root (files live directly here).
- Rename `ASSETS_DIR` from `"assets"` to `"_assets"`.

**Implementation:**

```rust
// Constants
pub const TRASH_DIR: &str = ".trash";
pub const ASSETS_DIR: &str = "_assets";  // renamed from "assets"
// MEMOS_DIR removed

impl Paths {
    /// Full path for a note file.
    pub fn note_path(&self, folder: &str, filename: &str) -> PathBuf {
        match folder.is_empty() {
            true => self.vault.join(format!("{}.md", filename)),
            false => self.vault.join(folder).join(format!("{}.md", filename)),
        }
    }

    /// Trash path preserving original relative location.
    pub fn trash_path(&self, rel_path: &str) -> PathBuf {
        self.trash_dir.join(rel_path)
    }

    /// Root directory to scan for notes (= vault root).
    pub fn scan_root(&self) -> &Path {
        &self.vault
    }
}
```

- [ ] **Step 1-5:** TDD cycle for `note_path`, `trash_path`
- [ ] **Step 6:** Remove `shard()`, `MEMOS_DIR`, update all references
- [ ] **Step 7:** Commit: `refactor(core): remove date sharding, folder-based paths`

### Task 1.4: Update `FileStore` — folder-aware operations

**Files:**
- Modify: `crates/oximemo-core/src/store/files.rs`

**Interfaces:**
- `FileStore::write_note(&self, folder: &str, memo: &Memo) -> Result<PathBuf>` — computes filename from body (H1 or timestamp), writes to `folder/filename.md`, returns path.
- `FileStore::read_note(&self, path: &Path) -> Result<Memo>` — reads frontmatter + body from arbitrary path.
- `FileStore::move_note(&self, from: &Path, to_folder: &str) -> Result<PathBuf>` — moves file, preserves frontmatter.
- `FileStore::rename_note(&self, path: &Path, new_title: &str) -> Result<PathBuf>` — renames file based on new title slug.
- `FileStore::delete_note(&self, path: &Path) -> Result<()>` — moves to `.trash/<rel_path>`.
- `FileStore::scan(&self) -> Result<Vec<(PathBuf, ParsedFile)>>` — walks vault root, returns all `.md` files except `_assets/`, `.trash/`, `_templates/`-prefixed special files.

**Key detail:** `write_note` derives the filename from the body:
```rust
fn derive_filename(memo: &Memo) -> String {
    match derive_title(&memo.body) {
        Some(title) => slugify(&title),
        None => timestamp_filename(memo.created_at),
    }
}
```

Collision handling: if file exists, append `-2`, `-3`, etc.

- [ ] **Steps 1-5:** TDD for each method
- [ ] **Step 6:** Commit: `feat(core): folder-aware file store operations`

### Task 1.5: Update `Config` — FoldersConfig

**Files:**
- Modify: `crates/oximemo-core/src/config.rs`

**Interfaces:**
- `CategoriesConfig` → `FoldersConfig` with `items: Vec<FolderDef>`.
- `FolderDef { path: String, view: Option<ViewMode>, color: Option<String> }`.
- `ViewMode` enum: `Grid`, `List`, `Timeline`, `Graph`.
- `schema_version: 3`.
- Backward compat: old `[categories]` with `items` containing `{id, color, builtin}` → mapped to `[[folders]]` with `path = id`.

```rust
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ViewMode {
    #[default]
    Grid,
    List,
    Timeline,
    Graph,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderDef {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<ViewMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct FoldersConfig {
    #[serde(default)]
    pub items: Vec<FolderDef>,
}
```

- [ ] **Steps 1-5:** TDD for config parse/serialize, backward compat
- [ ] **Step 6:** Commit: `refactor(core): categories→folders config, schema_version 3`

---

## Phase 2: Rust Core — Index & Vault

Update the derived indexes and Vault facade for the new storage model.

### Task 2.1: Update redb index schema

**Files:**
- Modify: `crates/oximemo-core/src/store/index.rs`

**Changes:**
- `IndexRecord`: replace `category: String` with `path: String` (vault-relative) and `title: Option<String>`.
- Bump index format version.
- `MemoIndex::upsert()` takes path + title.
- Add `backlinks` table (key: target_id Uuid, value: Vec of source_id + link_text).

- [ ] **Steps 1-5:** TDD for new IndexRecord, backlinks table
- [ ] **Step 6:** Commit: `feat(core): redb index with path/title/backlinks`

### Task 2.2: Update `Vault` facade

**Files:**
- Modify: `crates/oximemo-core/src/vault.rs`

**Changes:**
- Replace category CRUD with folder operations (folder creation = `create_dir_all`, listing = `read_dir`).
- `Vault::create_note(folder, body, tags) -> Result<MemoId>` — applies template if `TEMPLATE.md` exists, writes file.
- `Vault::list(folder: Option<&str>, filter: &MemoFilter) -> Vec<MemoSummary>` — path-prefix filtering.
- `Vault::move_note(id, new_folder) -> Result<()>`.
- `Vault::rename_note(id, new_title) -> Result<()>` — triggers wiki link propagation (Phase 3).
- `Vault::delete_note(id) -> Result<()>` — moves to trash.

- [ ] **Steps 1-5:** TDD for folder ops, create_note with template
- [ ] **Step 6:** Commit: `feat(core): vault facade with folder operations`

### Task 2.3: Update tantivy search

**Files:**
- Modify: `crates/oximemo-core/src/store/search.rs`

**Changes:**
- Add `title` field to schema (text, indexed).
- Add `path` field (stored, for filtering and display).
- `SearchIndex::search()` accepts optional folder filter.
- Index `title` from `derive_title(body)`.

- [ ] **Steps 1-5:** TDD for title indexing, folder-filtered search
- [ ] **Step 6:** Commit: `feat(core): tantivy with title field and path filtering`

### Task 2.4: Update watcher

**Files:**
- Modify: `crates/oximemo-core/src/watcher.rs`

**Changes:**
- Watch vault root recursively (not just `memos/`).
- Detect folder creation/deletion/rename.
- Ignore `_assets/`, `.trash/`, `TEMPLATE.md` (for index purposes).
- Emit events for: note created, note modified, note moved, note deleted, folder created, folder deleted.

- [ ] **Steps 1-5:** TDD for watcher events (or integration test)
- [ ] **Step 6:** Commit: `feat(core): recursive vault watcher`

---

## Phase 3: Rust Core — Wiki Links

### Task 3.1: Create `wiki.rs` — link parsing & resolution

**Files:**
- Create: `crates/oximemo-core/src/wiki.rs`

**Interfaces:**
- `pub fn extract_links(body: &str) -> Vec<WikiLink>` — parses all `[[target]]` and `[[target|label]]`.
- `pub struct WikiLink { target: String, label: Option<String>, is_embed: bool }`.
- `pub fn resolve_link(target: &str, vault: &Vault) -> Option<MemoId>` — normalizes target to filename, searches vault.
- `pub fn extract_backlinks(target_id: MemoId, all_notes: &[(MemoId, String)]) -> Vec<(MemoId, String)>` — finds all notes whose body links to target.

**Parsing regex:** `r"\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]"` for links, `r"!\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]"` for embeds.

**Resolution:** normalize target via `slugify()`, then scan index for matching filename/path.

- [ ] **Steps 1-5:** TDD for parsing, resolution
- [ ] **Step 6:** Commit: `feat(core): wiki link parsing and title-based resolution`

### Task 3.2: Backlinks index

**Files:**
- Modify: `crates/oximemo-core/src/store/index.rs`
- Modify: `crates/oximemo-core/src/vault.rs`

**Changes:**
- `MemoIndex::update_backlinks(note_id, links: &[WikiLink])` — resolves each link target, updates backlinks table.
- `MemoIndex::get_backlinks(note_id) -> Vec<LinkRef>`.
- Called during `Vault::save_note()` and `Vault::reindex()`.

- [ ] **Steps 1-5:** TDD for backlinks table CRUD
- [ ] **Step 6:** Commit: `feat(core): backlinks index with wiki link resolution`

### Task 3.3: Rename propagation

**Files:**
- Modify: `crates/oximemo-core/src/vault.rs`
- Modify: `crates/oximemo-core/src/wiki.rs`

**Changes:**
- `Vault::rename_note(id, new_title)`:
  1. Derive old title from current body.
  2. Update H1 in body.
  3. Rename physical file.
  4. Scan all notes for `[[old title]]` → replace with `[[new title]]`.
  5. Update backlinks index.
  6. Save all affected notes.

- [ ] **Steps 1-5:** TDD for rename propagation (create two notes, link them, rename one, verify link updates)
- [ ] **Step 6:** Commit: `feat(core): rename propagation for wiki links`

---

## Phase 4: Rust Core — Templates

### Task 4.1: Create `template.rs`

**Files:**
- Create: `crates/oximemo-core/src/template.rs`

**Interfaces:**
- `pub fn load_template(paths: &Paths, folder: &str) -> Option<String>` — reads `folder/TEMPLATE.md` (or `vault/TEMPLATE.md` for root). Returns raw template body.
- `pub fn apply_template(template: &str, ctx: &TemplateCtx) -> String` — replaces `{{variables}}`.
- `pub struct TemplateCtx { date, weekday, time, year, month, day, counter, folder }`.

```rust
pub fn apply_template(template: &str, ctx: &TemplateCtx) -> String {
    template
        .replace("{{date}}", &ctx.date)
        .replace("{{weekday}}", &ctx.weekday)
        .replace("{{time}}", &ctx.time)
        .replace("{{year}}", &ctx.year.to_string())
        .replace("{{month}}", &ctx.month)
        .replace("{{day}}", &ctx.day)
        .replace("{{counter}}", &ctx.counter.to_string())
        .replace("{{folder}}", &ctx.folder)
}
```

- [ ] **Steps 1-5:** TDD for variable substitution, template loading
- [ ] **Step 6:** Commit: `feat(core): template loading and variable substitution`

### Task 4.2: Wire templates into note creation

**Files:**
- Modify: `crates/oximemo-core/src/vault.rs`

**Changes:**
- `Vault::create_note(folder, body, tags)`:
  1. Check for `TEMPLATE.md` in folder.
  2. If exists + body is empty → apply template → use result as body.
  3. If body provided (manual creation) → use as-is (template only for blank creation).
  4. Compute counter from existing notes in folder.
  5. Write note.

- [ ] **Steps 1-5:** TDD for template-applied note creation
- [ ] **Step 6:** Commit: `feat(core): template application on note creation`

---

## Phase 5: Rust Core — Migration

### Task 5.1: Create `migrate.rs`

**Files:**
- Create: `crates/oximemo-core/src/migrate.rs`

**Interfaces:**
- `pub fn migrate_vault(paths: &Paths, dry_run: bool) -> Result<MigrationReport>`.
- `MigrationReport { files_moved: usize, folders_created: usize, wiki_links_updated: usize, errors: Vec<String> }`.

**Logic:**
1. Backup vault to `<vault>.bak/`.
2. Walk `memos/**/*.md` (old layout).
3. For each file:
   a. Parse frontmatter (old format with `category`, `deleted_at`).
   b. Determine new folder: `category` value (or root if "inbox").
   c. Determine new filename: `slugify(derive_title(body))` or `timestamp_filename(created_at)`.
   d. Create target folder if needed.
   e. Rewrite frontmatter (remove `category`, `deleted_at`).
   f. Move file to new location.
4. Handle `deleted_at` files → move to `.trash/<original_folder>/<filename>`.
5. Remove empty `memos/` directories.
6. Migrate `config.toml`: `[categories]` → `[[folders]]`, bump `schema_version` to 3.
7. Rename `config.toml` → `oximemo.toml`.
8. Migrate `[[UUID]]` wiki links → `[[title]]`.
9. Run reindex.

- [ ] **Steps 1-5:** TDD with a temp vault (create old-style files, migrate, verify new layout)
- [ ] **Step 6:** Commit: `feat(core): vault migration from v2 to v3 layout`

### Task 5.2: Add `migrate` CLI command

**Files:**
- Modify: `crates/oximemo-cli/src/main.rs`

**Changes:**
- `oximemo migrate [--dry-run] [--vault <path>]` subcommand.

- [ ] **Step 1:** Add clap subcommand
- [ ] **Step 2:** Test with `cargo run -p oximemo-cli -- --vault /tmp/test migrate --dry-run`
- [ ] **Step 3:** Commit: `feat(cli): migrate subcommand`

---

## Phase 6: Frontend — Foundation

### Task 6.1: Update Tauri command bindings

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs` (or commands)
- Modify: `apps/desktop/src/lib/tauri.ts`

**New commands:**
- `list_folders() -> Vec<FolderInfo>` — scans vault for folder tree.
- `create_note(folder: String) -> NoteId` — applies template, creates file.
- `move_note(id: String, new_folder: String) -> ()`.
- `rename_note(id: String, new_title: String) -> ()`.
- `get_backlinks(id: String) -> Vec<BacklinkInfo>`.
- `get_folder_view(folder: String) -> Option<ViewMode>`.
- `set_folder_view(folder: String, view: ViewMode, locked: bool) -> ()`.
- `migrate_vault(dry_run: bool) -> MigrationReport`.

- [ ] **Step 1:** Add Tauri command handlers in Rust
- [ ] **Step 2:** Add TypeScript bindings in `tauri.ts`
- [ ] **Step 3:** `bun run build` passes
- [ ] **Step 4:** Commit: `feat(desktop): Tauri commands for folder ops, views, migration`

### Task 6.2: Update `stores/ui.ts`

**Files:**
- Modify: `apps/desktop/src/stores/ui.ts`

**New state:**
```typescript
interface UIState {
  // Folder navigation
  currentFolder: string;           // "" = root
  folderTree: FolderNode[];        // cached folder structure
  // View modes
  viewMode: ViewMode;              // current view
  viewLocked: boolean;             // lock state
  // ...existing state (selectedNoteId, etc.)
}
```

- [ ] **Steps:** Implement folder nav state, view mode state, lock persistence
- [ ] **Commit:** `feat(desktop): UI store with folder navigation and view modes`

---

## Phase 7: Frontend — Views

### Task 7.1: Rename `CardGrid` → `GridView`

**Files:**
- Rename: `apps/desktop/src/components/CardGrid.tsx` → `GridView.tsx`

**Changes:**
- Accept `folder` prop for color accent.
- Keep existing card rendering logic.
- Export as `GridView`.

- [ ] **Commit:** `refactor(desktop): CardGrid → GridView`

### Task 7.2: Create `ListView`

**Files:**
- Create: `apps/desktop/src/components/ListView.tsx`

**Component:**
```typescript
export function ListView({ notes, onOpen }: Props) {
  return (
    <div className="divide-y divide-line">
      {notes.map(note => (
        <button key={note.id} onClick={() => onOpen(note.id)}
          className="flex w-full items-center gap-3 px-4 py-2 hover:bg-surface-sunken">
          {note.favorite && <Star className="size-4 text-status-warning" />}
          <span className="flex-1 truncate text-left font-medium">
            {note.title ?? note.preview.slice(0, 60)}
          </span>
          <span className="flex gap-1">
            {note.tags.slice(0, 3).map(t => (
              <span key={t} className="text-xs text-text-muted">#{t}</span>
            ))}
          </span>
          <span className="text-xs text-text-muted">{relativeTime(note.updatedAt)}</span>
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Commit:** `feat(desktop): list view component`

### Task 7.3: Create `TimelineView`

**Files:**
- Create: `apps/desktop/src/components/TimelineView.tsx`

**Logic:** Group notes by `created_at` date. Render date headers + note list per group. Use `@tanstack/react-virtual` for performance if many entries.

- [ ] **Commit:** `feat(desktop): timeline view component`

### Task 7.4: Create `GraphView`

**Files:**
- Create: `apps/desktop/src/components/GraphView.tsx`
- Add dependency: `d3-force` (or `vis-network`)

**Logic:**
1. Fetch all notes + backlinks via Tauri commands.
2. Build node/edge arrays.
3. Render with d3-force simulation on SVG or canvas.
4. Node click → `onOpen(noteId)`.
5. Node color from folder. Node size from connection count.

**Key pattern:**
```typescript
const simulation = d3.forceSimulation(nodes)
  .force("link", d3.forceLink(edges).id(d => d.id))
  .force("charge", d3.forceManyBody().strength(-300))
  .force("center", d3.forceCenter(width / 2, height / 2));
```

- [ ] **Commit:** `feat(desktop): graph view with d3-force`

### Task 7.5: View switcher + lock

**Files:**
- Create: `apps/desktop/src/components/ViewSwitcher.tsx`

**Component:**
- 4 buttons (Grid/List/Timeline/Graph) with icons.
- Lock toggle (🔒/🔓).
- Calls `set_folder_view` Tauri command when locked.
- Reads initial state from `get_folder_view`.

- [ ] **Commit:** `feat(desktop): view switcher with lock`

---

## Phase 8: Frontend — UI

### Task 8.1: Sidebar folder tree

**Files:**
- Modify: `apps/desktop/src/components/Sidebar.tsx`

**Changes:**
- Replace flat category list with recursive folder tree.
- `FolderTree` component: renders `FolderNode[]` with expand/collapse.
- Drag-and-drop: move notes between folders (HTML5 drag events → `move_note` Tauri command).
- Special entries: "전체 노트", "즐겨찾기", "최근 수정".
- Folder right-click: new note, new subfolder, rename, delete, set view.
- Color dots from `oximemo.toml` folder config.

- [ ] **Commit:** `feat(desktop): sidebar folder tree`

### Task 8.2: Toolbar with breadcrumbs

**Files:**
- Create: `apps/desktop/src/components/Toolbar.tsx`

**Component:**
- Folder breadcrumb (clickable segments).
- ViewSwitcher + lock.
- "New note" button (applies template if exists).
- Sort dropdown.

- [ ] **Commit:** `feat(desktop): toolbar with breadcrumbs`

### Task 8.3: Editor wiki link changes

**Files:**
- Modify: `apps/desktop/src/lib/memoLinks.ts`

**Changes:**
- `suggest(q)`: search by title (not UUID). Return `{ target: filename, label: title }`.
- `serializeSuggestion(s)`: return `${s.target}]]` (filename, not UUID).
- `resolve(target)`: look up note by filename/title via new Tauri command.
- `onOpen(target)`: resolve filename → noteId → open.

- [ ] **Commit:** `refactor(desktop): wiki links UUID→title serialization`

### Task 8.4: Backlinks panel

**Files:**
- Create: `apps/desktop/src/components/BacklinksPanel.tsx`

**Component:**
- Fetches `get_backlinks(currentNoteId)`.
- Lists linking notes (title + preview).
- Click → navigate to linking note.
- Collapsible.

- [ ] **Commit:** `feat(desktop): backlinks panel`

### Task 8.5: Context menu updates

**Files:**
- Modify: `apps/desktop/src/components/ContextMenu.tsx`

**New items:**
- "폴더로 이동..." → folder picker dialog → `move_note`.
- "이름 변경" → inline rename → `rename_note`.
- "위키링크 복사" → `[[title]]` to clipboard.

- [ ] **Commit:** `feat(desktop): context menu with folder move, rename, wiki link copy`

### Task 8.6: Search enhancements

**Files:**
- Modify: `apps/desktop/src/components/` (search UI)

**Changes:**
- Results show: title + folder path + highlighted excerpt.
- Filter chips: folder, tag, date range.
- Wiki link awareness: searching for a title also finds notes linking to it.

- [ ] **Commit:** `feat(desktop): enhanced search with folder paths and filters`

---

## Phase Ordering & Dependencies

```text
Phase 1 (Core: Data Model)
  ↓
Phase 2 (Core: Index & Vault)
  ↓
Phase 3 (Core: Wiki Links)    ←┐
Phase 4 (Core: Templates)     ←┤ (parallel)
  ↓                            ↓
Phase 5 (Core: Migration)
  ↓
Phase 6 (Frontend: Foundation)
  ↓
Phase 7 (Frontend: Views)     ←┐
Phase 8 (Frontend: UI)        ←┤ (partially parallel)
```

**Critical path:** Phase 1 → 2 → 5 → 6 → 7 → 8. Phases 3, 4 can parallel with 5.

---

## Verification Plan

After all phases:

1. **Migration:** Create old-style vault → `oximemo migrate` → verify file layout, frontmatter, config.
2. **Folder ops:** Create/move/delete notes via UI → verify in Finder.
3. **Wiki links:** Create `[[link]]` → autocomplete → click navigation → backlinks panel → rename propagation.
4. **Templates:** Create `TEMPLATE.md` in folder → new note → verify variable substitution.
5. **View modes:** Switch between 4 views → lock → restart → verify persistence.
6. **Graph view:** Vault with wiki links → graph renders → node click navigates.
7. **Quick capture:** Global shortcut → root file created → appears in grid.
8. **Regression:** Search, tags, favorites, dark mode all work.
9. **External editing:** Edit `.md` file in VS Code → app detects change via watcher.
