# Category Management & UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make categories persistent & manageable (CRUD + rename-with-migration), redesign settings as a drawer, make inbox transparent, fix+redesign capture, and add a shared keyboard-first category combobox.

**Architecture:** Single source of truth for categories in `config.toml` (via interior-mutable `Vault.config`). Rust core owns persistence + migration; Tauri commands wrap it; React consumes via TanStack Query. Capture window routing fixed by window-label branching so `CaptureOverlay` actually mounts.

**Tech Stack:** Rust (oxinot-core, redb, tantivy, parking_lot), Tauri 2, React 19, TanStack Query, Zustand, Base UI, Tailwind v4.

## Global Constraints

- `inbox` is `DEFAULT_CATEGORY` — its id is immutable; color editable; never deletable/renameable.
- Category ids: trim + lowercase + NFC; reject empty/duplicate.
- All category mutations persist to `config.toml` via `VaultConfig::save()` AND update in-memory config atomically.
- `rename_category` migrates all referencing notes (rewrite file + rehash + reindex), bumps `updated_at` (sync-manifest correctness).
- Verification: Rust tasks use `cargo test -p oxinot-core`; frontend uses `tsc -b` + manual/visual (no unit-test framework for components). `clippy` 0 warnings. Redeploy needs `cargo build -p oxinot-desktop --release` + codesign.
- Spec: `docs/superpowers/specs/2026-07-31-category-management-ux-design.md`.

---

## File Structure

**Rust core** (`crates/oxinot-core/src/`):
- `config.rs` — add `VaultConfig::save()`; inbox color `""`; `AUTO_COLORS[0] = ""`.
- `vault.rs` — `config: VaultConfig` → `RwLock<VaultConfig>`; add `categories()`, `create_category`, `update_category`, `rename_category`, `delete_category`; update `config()` callers.

**Tauri** (`apps/desktop/src-tauri/src/lib.rs`):
- Add `update_category`/`rename_category`/`delete_category` commands; rewrite `create_category`/`list_categories` to delegate to core; remove `AppState.user_categories`.

**Frontend** (`apps/desktop/src/`):
- `lib/api.ts` — wrap new commands.
- `lib/tauri.ts` — browser-mode mock parity.
- `lib/color.ts` — `INBOX_NEUTRAL = ""`.
- `lib/window.ts` — `isRouteCapture()` label-based.
- `components/SettingsMenu.tsx` — Dialog → Drawer; add Categories section.
- `components/CategoryCombobox.tsx` — NEW shared selector.
- `components/NoteEditorForm.tsx` — `<select>` → `<CategoryCombobox>`.
- `components/QuickCaptureForm.tsx` / `CaptureOverlay.tsx` — shell redesign.
- `App.tsx` — conditional `refetchOnWindowFocus` (Task 10, §8-dependent).

---

## Task 1: Fix capture window routing (CaptureOverlay never mounts)

**Confirmed defect (spec §6.2):** capture window has no `url`; `isRouteCapture()` is pathname-based → capture renders `<Shell/>`, not `<CaptureOverlay/>`. This unblocks all capture work and the §8 diagnostic.

**Files:**
- Modify: `apps/desktop/src/lib/window.ts:10-13`

**Interfaces:**
- Produces: `isRouteCapture(): boolean` — label-based in Tauri, pathname fallback in browser.

- [ ] **Step 1: Rewrite `isRouteCapture` to branch on window label**

```ts
// window.ts — replace isRouteCapture body
import { getCurrentWindow } from "@tauri-apps/api/window";

export function isRouteCapture(): boolean {
  if (typeof window === "undefined") return false;
  if ("__TAURI_INTERNALS__" in window) {
    // Label is the robust signal: the capture window's label is "capture"
    // regardless of the loaded URL (the window config sets no `url`, so it
    // loads "/", which would defeat a pathname-only check).
    return getCurrentWindow().label === "capture";
  }
  // Browser/dev mode: no window labels, fall back to the route.
  return window.location.pathname.startsWith("/capture");
}
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/desktop && bunx tsc -b`
Expected: exit 0.

- [ ] **Step 3: Runtime verify (manual, blocks capture tasks)**

Run `cargo tauri dev` (from `apps/desktop/src-tauri`). Press ⌘⇧N.
Expected: a capture input appears (NOT a clipped grid). If a grid still shows, the label check failed — confirm `getCurrentWindow().label` returns `"capture"` via devtools console.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/lib/window.ts
git commit -m "fix(capture): route capture window by label, not pathname

CaptureOverlay never mounted because the capture window loads '/' (no url
in config) and isRouteCapture checked pathname. Branch on window label in
Tauri mode; keep pathname fallback for browser dev."
```

---

## Task 2: Rust — VaultConfig::save() + interior-mutable config

**Files:**
- Modify: `crates/oxinot-core/src/config.rs` (add `save`)
- Modify: `crates/oxinot-core/src/vault.rs` (`config` → `RwLock`, add `categories()`, fix `config()` callers)
- Test: `crates/oxinot-core/src/config.rs` (tests mod), `vault.rs` (tests mod)

**Interfaces:**
- Produces: `VaultConfig::save(&self, paths: &Paths) -> Result<()>`; `Vault::categories() -> Vec<CategoryDef>`; `Vault::with_config<R>(&self, f: impl FnOnce(&VaultConfig) -> R) -> R` (read guard helper).

- [ ] **Step 1: Write failing test — save round-trips**

In `config.rs` tests mod:
```rust
#[test]
fn save_roundtrips_categories() {
    let dir = tempfile::tempdir().unwrap();
    let paths = Paths::resolve(Some(dir.path()));
    let mut cfg = VaultConfig::default();
    cfg.categories.items.push(CategoryDef { id: "custom".into(), color: "oklch(0.7 0.1 200)".into(), builtin: false });
    cfg.save(&paths).unwrap();
    let reloaded = VaultConfig::load(&paths);
    assert!(reloaded.categories.items.iter().any(|c| c.id == "custom"));
}
```
Add `tempfile` to `[dev-dependencies]` in `crates/oxinot-core/Cargo.toml` if absent.

- [ ] **Step 2: Run test — verify it fails**

Run: `cargo test -p oxinot-core save_roundtrips`
Expected: FAIL — no `save` method.

- [ ] **Step 3: Implement `save`**

```rust
// config.rs impl VaultConfig
pub fn save(&self, paths: &Paths) -> Result<()> {
    let text = self.to_toml()?;
    std::fs::write(paths.config_path(), text)?;
    Ok(())
}
```
(`to_toml` returns `Result<String, toml::ser::Error>` and `std::fs::write` returns `io::Result`; both convert into `crate::error::CoreError` via existing `#[from]` impls — `TomlSerialize` and `Io` — so plain `?` suffices, no manual mapping.)

- [ ] **Step 4: Run test — verify pass**

Run: `cargo test -p oxinot-core save_roundtrips`
Expected: PASS.

- [ ] **Step 5: Make `Vault.config` interior-mutable**

In `vault.rs`:
```rust
use parking_lot::RwLock;
pub struct Vault {
    paths: Paths,
    config: RwLock<VaultConfig>,
    files: FileStore,
}
// in Vault::open:
config: RwLock::new(VaultConfig::load(&paths)),
```
Add `parking_lot` to `crates/oxinot-core/Cargo.toml` `[dependencies]` if absent.

- [ ] **Step 6: Add read helper + categories(), fix callers**

```rust
// vault.rs
/// Read config under a read guard.
pub fn with_config<R>(&self, f: impl FnOnce(&VaultConfig) -> R) -> R {
    f(&self.config.read())
}
pub fn categories(&self) -> Vec<CategoryDef> {
    self.config.read().categories.items.clone()
}
```
Replace existing `config()` method callers:
- `spawn_watcher` (lib.rs): `state.vault.config().capture...` → `state.vault.with_config(|c| c.capture.double_tap_threshold_ms)`; same for `index.watcher_debounce_ms`.
- Remove the old `pub fn config(&self) -> &VaultConfig` (no longer possible behind RwLock).

- [ ] **Step 7: Build + full test**

Run: `cargo build -p oxinot-core && cargo test -p oxinot-core`
Expected: build OK, all tests pass.

- [ ] **Step 8: Commit**

```bash
git add crates/oxinot-core/src/config.rs crates/oxinot-core/src/vault.rs crates/oxinot-core/Cargo.toml apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(core): persistable config — VaultConfig::save + RwLock config"
```

---

## Task 3: Rust — category CRUD (create/update/delete)

**Files:**
- Modify: `crates/oxinot-core/src/vault.rs`
- Test: `vault.rs` tests mod

**Interfaces:**
- Produces: `Vault::create_category(id, color) -> Result<CategoryDef>`, `update_category(id, color) -> Result<()>`, `delete_category(id) -> Result<()>`.
- Consumes: `Vault::with_config`, `VaultConfig::save` (Task 2), `note::DEFAULT_CATEGORY`.

- [ ] **Step 1: Write failing tests**

```rust
#[test]
fn category_crud_persists() {
    let dir = tempfile::tempdir().unwrap();
    let v = Vault::open(Some(dir.path())).unwrap();
    v.ensure_initialized().unwrap();

    // create
    let c = v.create_category("urgent".into(), None).unwrap();
    assert_eq!(c.id, "urgent");
    assert!(!c.color.is_empty());

    // duplicate rejected
    assert!(v.create_category("urgent".into(), None).is_err());
    // empty rejected
    assert!(v.create_category("  ".into(), None).is_err());
    // inbox collision rejected
    assert!(v.create_category("inbox".into(), None).is_err());

    // update color
    v.update_category("urgent".into(), "oklch(0.6 0.2 25)".into()).unwrap();
    assert_eq!(v.categories().iter().find(|c| c.id == "urgent").unwrap().color, "oklch(0.6 0.2 25)");

    // delete
    v.delete_category("urgent".into()).unwrap();
    assert!(v.categories().iter().all(|c| c.id != "urgent"));

    // inbox not deletable
    assert!(v.delete_category("inbox".into()).is_err());
    // unknown update/rename target rejected
    assert!(v.update_category("nope".into(), "x".into()).is_err());

    // persists across reopen
    let v2 = Vault::open(Some(dir.path())).unwrap();
    assert!(v2.categories().iter().all(|c| c.id != "urgent"));
}
```

- [ ] **Step 2: Run — verify fail**

Run: `cargo test -p oxinot-core category_crud_persists`
Expected: FAIL — methods missing.

- [ ] **Step 3: Implement CRUD**

```rust
// vault.rs
use unicode_normalization::UnicodeNormalization; // add to deps if not present; else use a simple lowercase

fn normalize_id(id: &str) -> String { id.trim().to_lowercase() } // NFC: add .nfc().collect::<String>() if unicode-normalization avail

impl Vault {
    pub fn create_category(&self, id: String, color: Option<String>) -> Result<CategoryDef> {
        let id = normalize_id(&id);
        if id.is_empty() { return Err(CoreError::other("category id empty")); }
        let mut cfg = self.config.write();
        if cfg.categories.items.iter().any(|c| c.id == id) {
            return Err(CoreError::other(format!("category '{id}' exists")));
        }
        let color = color.unwrap_or_else(|| pick_auto_color(&cfg.categories.items));
        let def = CategoryDef { id: id.clone(), color, builtin: false };
        cfg.categories.items.push(def.clone());
        cfg.save(&self.paths)?;
        Ok(def)
    }
    pub fn update_category(&self, id: String, color: String) -> Result<()> {
        let id = normalize_id(&id);
        let mut cfg = self.config.write();
        let def = cfg.categories.items.iter_mut().find(|c| c.id == id)
            .ok_or_else(|| CoreError::other(format!("category '{id}' not found")))?;
        def.color = color;
        cfg.save(&self.paths)
    }
    pub fn delete_category(&self, id: String) -> Result<()> {
        let id = normalize_id(&id);
        if id == note::DEFAULT_CATEGORY {
            return Err(CoreError::other("inbox cannot be deleted"));
        }
        let mut cfg = self.config.write();
        let before = cfg.categories.items.len();
        cfg.categories.items.retain(|c| c.id != id);
        if cfg.categories.items.len() == before {
            return Err(CoreError::other(format!("category '{id}' not found")));
        }
        cfg.save(&self.paths)
    }
}
```
`pick_auto_color(items)` = first `AUTO_COLORS` entry not used by any item (cycle). Use `CoreError::other(msg)` (exists in `error.rs`) for all validation errors — there is no `InvalidInput` variant. If `unicode-normalization` isn't a dep, `normalize_id` = `trim().to_lowercase()` suffices (ids are ASCII slugs); revisit NFC only if non-ASCII ids are needed.

- [ ] **Step 4: Run — verify pass**

Run: `cargo test -p oxinot-core category_crud_persists`
Expected: PASS.

- [ ] **Step 5: clippy + commit**

```bash
cargo clippy -p oxinot-core -- -D warnings
git add crates/oxinot-core/src/vault.rs crates/oxinot-core/src/error.rs crates/oxinot-core/Cargo.toml
git commit -m "feat(core): category CRUD persisted to config.toml"
```

---

## Task 4: Rust — rename_category migration

**Files:**
- Modify: `crates/oxinot-core/src/vault.rs`
- Test: `vault.rs` tests mod

**Interfaces:**
- Produces: `Vault::rename_category(old, new) -> Result<u64>` (count migrated).

- [ ] **Step 1: Write failing test**

```rust
#[test]
fn rename_category_migrates_notes() {
    let dir = tempfile::tempdir().unwrap();
    let v = Vault::open(Some(dir.path())).unwrap();
    v.ensure_initialized().unwrap();

    let a = v.create_note("note A".into(), Some("todo".into())).unwrap();
    let b = v.create_note("note B".into(), Some("todo".into())).unwrap();
    let c = v.create_note("note C".into(), Some("idea".into())).unwrap();

    let n = v.rename_category("todo".into(), "tasks".into()).unwrap();
    assert_eq!(n, 2);

    // migrated
    assert_eq!(v.get_note(a.id).unwrap().category, "tasks");
    assert_eq!(v.get_note(b.id).unwrap().category, "tasks");
    // unaffected
    assert_eq!(v.get_note(c.id).unwrap().category, "idea");
    // registry updated
    assert!(v.categories().iter().any(|c| c.id == "tasks"));
    assert!(v.categories().iter().all(|c| c.id != "todo"));

    // inbox not renameable
    assert!(v.rename_category("inbox".into(), "x".into()).is_err());
    // collision
    assert!(v.rename_category("tasks".into(), "idea".into()).is_err());
}
```

- [ ] **Step 2: Run — verify fail**

Run: `cargo test -p oxinot-core rename_category_migrates_notes`
Expected: FAIL — no method.

- [ ] **Step 3: Implement rename migration**

```rust
// vault.rs
pub fn rename_category(&self, old: String, new: String) -> Result<u64> {
    let old = normalize_id(&old);
    let new = normalize_id(&new);
    if old == note::DEFAULT_CATEGORY || new == note::DEFAULT_CATEGORY {
        return Err(CoreError::other("inbox id is immutable"));
    }
    if old == new { return Err(CoreError::other("old == new")); }

    // validate + mutate registry under write lock, but defer save until after migration
    {
        let cfg = self.config.read();
        if !cfg.categories.items.iter().any(|c| c.id == old) {
            return Err(CoreError::other(format!("category '{old}' not found")));
        }
        if cfg.categories.items.iter().any(|c| c.id == new) {
            return Err(CoreError::other(format!("category '{new}' exists")));
        }
    }

    let mut migrated = 0u64;
    self.with_redb_and_search(|idx, search| {
        for rec in idx.export_since(None)? {
            if rec.category != old { continue; }
            let path = self.paths.note_path(rec.id, rec.created_at);
            let mut note = self.files.read_note(&path)?
                .ok_or_else(|| CoreError::NotFound(rec.id.to_string()))?;
            note.category = new.clone();
            note.updated_at = OffsetDateTime::now_utc();
            note.hash = hash::hash_note(note.body.as_bytes(), note.favorite, &note.category);
            self.files.write(&note)?;
            idx.upsert(&record_of(&note))?;
            search.upsert(note.id, &note.body, &note.tags)?;
            migrated += 1;
        }
        Ok(())
    })?;

    // update registry + persist
    {
        let mut cfg = self.config.write();
        for def in cfg.categories.items.iter_mut() {
            if def.id == old { def.id = new.clone(); }
        }
        cfg.save(&self.paths)?;
    }
    Ok(migrated)
}
```
Note: `export_since(None)` returns all `IndexRecord`s (confirmed has `category` field). `record_of`, `hash::hash_note`, `with_redb_and_search` already exist.

- [ ] **Step 4: Run — verify pass**

Run: `cargo test -p oxinot-core rename_category_migrates_notes`
Expected: PASS.

- [ ] **Step 5: full test + clippy + commit**

```bash
cargo test -p oxinot-core && cargo clippy -p oxinot-core -- -D warnings
git add crates/oxinot-core/src/vault.rs
git commit -m "feat(core): rename_category migrates referencing notes + reindex"
```

---

## Task 5: Tauri commands + api.ts + remove user_categories

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs` (commands mod + AppState + invoke_handler)
- Modify: `apps/desktop/src/lib/api.ts`
- Modify: `apps/desktop/src/lib/tauri.ts` (mock parity)

**Interfaces:**
- Produces (IPC): `update_category(id, color)`, `rename_category(old, new) -> number`, `delete_category(id)`; rewritten `create_category`/`list_categories` (core-delegated).

- [ ] **Step 1: Remove `user_categories` from AppState; rewrite list/create; add commands**

In `lib.rs`:
- `AppState`: drop `user_categories` field (and its init in `new`).
- `list_categories`: `Ok(state.vault.categories())`.
- `create_category`: `state.vault.create_category(id, color).map_err(|e| e.to_string())` + `let _ = app.emit("notes:changed", ());`.
- Add `update_category`, `rename_category`, `delete_category` — each delegates to core, emits `notes:changed`, maps error to String. `rename_category` returns the migrated count.
- Register all in `invoke_handler![...]`.

```rust
#[tauri::command]
pub fn update_category(state: State<'_, AppState>, app: AppHandle, id: String, color: String) -> Result<(), String> {
    state.vault.update_category(id, color).map_err(|e| e.to_string())?;
    let _ = app.emit("notes:changed", ());
    Ok(())
}
#[tauri::command]
pub fn rename_category(state: State<'_, AppState>, app: AppHandle, old: String, new: String) -> Result<u64, String> {
    let n = state.vault.rename_category(old, new).map_err(|e| e.to_string())?;
    let _ = app.emit("notes:changed", ());
    Ok(n)
}
#[tauri::command]
pub fn delete_category(state: State<'_, AppState>, app: AppHandle, id: String) -> Result<(), String> {
    state.vault.delete_category(id).map_err(|e| e.to_string())?;
    let _ = app.emit("notes:changed", ());
    Ok(())
}
```

- [ ] **Step 2: api.ts wrappers**

```ts
export async function updateCategory(id: string, color: string) {
  return invoke<void>("update_category", { id, color });
}
export async function renameCategory(oldId: string, newId: string) {
  return invoke<number>("rename_category", { old: oldId, new: newId });
}
export async function deleteCategory(id: string) {
  return invoke<void>("delete_category", { id });
}
```

- [ ] **Step 3: tauri.ts mock parity (browser mode)**

In `browserFallback`: add `update_category`/`rename_category`/`delete_category` cases operating on a localStorage-backed category list (mirror `list_categories` mock). For `rename_category`, rewrite matching notes' `category` in the store. Keep simple — browser mode is dev-only.

- [ ] **Step 4: Build (Rust + TS)**

Run: `cargo check -p oxinot-desktop && cd apps/desktop && bunx tsc -b`
Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/lib.rs apps/desktop/src/lib/api.ts apps/desktop/src/lib/tauri.ts
git commit -m "feat(tauri): category CRUD/rename commands; drop ephemeral user_categories"
```

---

## Task 6: Inbox transparent color

**Files:**
- Modify: `crates/oxinot-core/src/config.rs` (`AUTO_COLORS[0]`, default inbox item)
- Modify: `apps/desktop/src/lib/color.ts` (`INBOX_NEUTRAL`)

- [ ] **Step 1: Rust — empty inbox color**

In `config.rs`:
```rust
pub const AUTO_COLORS: &[&str] = &[
    "",                       // inbox — transparent (renders default surface)
    "oklch(0.75 0.13 250)",   // note
    // ... rest unchanged
];
```
`CategoriesConfig::default` already zips ids with `AUTO_COLORS`, so inbox gets `""`. `resolve_category_color` returns `AUTO_COLORS[0]` (= `""`) for orphans.

- [ ] **Step 2: TS — empty inbox neutral**

In `color.ts`:
```ts
const INBOX_NEUTRAL = "";   // transparent → paperFor/edgeFor return default surface
```

- [ ] **Step 3: Test + build**

Run: `cargo test -p oxinot-core && cd apps/desktop && bunx tsc -b`
Expected: pass. Verify an existing test that asserted the old inbox color string — update if any.

- [ ] **Step 4: Commit**

```bash
git add crates/oxinot-core/src/config.rs apps/desktop/src/lib/color.ts
git commit -m "feat(color): inbox transparent — default card surface, categorized cards pop"
```

---

## Task 7: Settings → side drawer

**Files:**
- Modify: `apps/desktop/src/components/SettingsMenu.tsx`

**Interfaces:**
- Consumes: existing `Segmented`/`Section` helpers; `useUI` settings open-state.

- [ ] **Step 1: Convert Dialog → right-side Drawer**

Replace the centered `Dialog` with a right-anchored panel: `fixed right-0 top-0 h-full w-[380px] border-l bg-white dark:bg-zinc-950 shadow-xl`, slide-in via `motion` (already a dep) or a CSS transition. Keep the trigger (gear button in CardGrid header). Outside-click + Esc close. Header: "설정" + close `X`.

- [ ] **Step 2: Lay out vertical sections**

Stack (scrollable): Appearance (theme Segmented + language) · **Categories (Task 8 fills)** · Storage/Vault (reindex/doctor/path — move existing rows here) · About (version). Reuse `Section` helper for each.

- [ ] **Step 3: Typecheck + visual**

Run: `bunx tsc -b`. Then `cargo tauri dev`, open settings: drawer slides from right, all existing actions still work.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/components/SettingsMenu.tsx
git commit -m "refactor(settings): modal → right-side drawer with section layout"
```

---

## Task 8: Categories management section

**Files:**
- Modify: `apps/desktop/src/components/SettingsMenu.tsx` (Categories section)
- Consumes: `api.ts` `createCategory`/`updateCategory`/`renameCategory`/`deleteCategory`/`listCategories`, `color.ts` `COLOR_PRESETS`.

- [ ] **Step 1: Categories section UI**

- `useQuery(["categories"], listCategories)` for the list.
- Each row: color swatch (click → `COLOR_PRESETS` popover + OKLCH input → `updateCategory`), id label (inline-edit → on commit `renameCategory`, show toast "N notes moved"), delete button (`deleteCategory`; disabled when `id === "inbox"`; inbox row also disables rename).
- "New category" row: id input + default swatch + Add → `createCategory`.
- On any mutation success: `qc.invalidateQueries(["categories"])`, `["facets"]`, `["notes"]`.

- [ ] **Step 2: Typecheck + manual**

Run: `bunx tsc -b`. `cargo tauri dev`: create a category, restart app — it persists. Edit a color — grid cards recolor instantly. Rename — affected notes move, toast shows count. Delete a non-inbox — its notes fall back to inbox color.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/components/SettingsMenu.tsx
git commit -m "feat(settings): category management section (CRUD + rename + color)"
```

---

## Task 9: Shared CategoryCombobox + NoteEditorForm

**Files:**
- Create: `apps/desktop/src/components/CategoryCombobox.tsx`
- Modify: `apps/desktop/src/components/NoteEditorForm.tsx:58-68` (`<select>` → combobox)

**Interfaces:**
- Produces: `<CategoryCombobox value onValueChange categories onCreate />`.

- [ ] **Step 1: Build the combobox**

Keyboard-first: a trigger chip (color dot + id) that opens a panel with a filter input + list (color dot + id), capped height + scroll. `↑`/`↓` move, `Enter` select, `Esc` close, type filters. When the typed string matches no id exactly, show a "✨ Create '`<typed>`'" row → calls `onCreate(typed)`. Use Base UI primitives if suitable (`@base-ui-components/react` Combobox/Select); else hand-roll with a button + absolute panel + `useRef` keydown.

- [ ] **Step 2: Wire into NoteEditorForm**

Replace the `<select>` block with:
```tsx
<CategoryCombobox
  value={category || "inbox"}
  onValueChange={onCategoryChange}
  categories={categories}
  onCreate={/* createCategory then onCategoryChange(newId) */}
/>
```

- [ ] **Step 3: Typecheck + manual**

Run: `bunx tsc -b`. `cargo tauri dev`: open a note, type to filter categories, arrow+Enter to pick, create a new one inline.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/components/CategoryCombobox.tsx apps/desktop/src/components/NoteEditorForm.tsx
git commit -m "feat(ui): shared keyboard-first CategoryCombobox; replaces NoteEditorForm select"
```

---

## Task 10: Capture shell redesign + capture→main refresh (§8 conditional)

**Prerequisite:** Task 1 (routing) done. **Depends on §8 diagnostic** (spec §8): after Task 1, run the capture diagnostic to decide the refresh mechanism.

**Files:**
- Modify: `apps/desktop/src/components/QuickCaptureForm.tsx`, `CaptureOverlay.tsx`
- Conditionally: `apps/desktop/src/App.tsx`

- [ ] **Step 1: Run §8 diagnostic (manual)**

After Task 1, `cargo tauri dev`, ⌘⇧N → type → Enter. Check:
- devtools console (main window) for `[oxinot] notes:changed received`
- terminal for `create_note: emitted notes:changed`
- does the captured note appear in the main grid?

Record the result — it determines Step 4.

- [ ] **Step 2: Redesign capture shell (keep slash logic)**

Rebuild `QuickCaptureForm` shell to spec §6.1: borderless glassy capsule, single auto-grow input (1→~5 lines then inner-scroll), category chip above input, `/` opens `SlashCategoryMenu` (reuse its parse/filter/create logic, restyle), no buttons, `Enter` save / `Shift+Enter` newline / `Esc` close, faint `↵ 저장 · esc 닫기` hint. `CaptureOverlay.save()` flow unchanged.

- [ ] **Step 3: `/capture` window sizing sanity**

The window is fixed 560×200 (`tauri.conf.json`). The auto-grow input + floating slash menu must fit; if the menu needs more height, raise the window `height` in config and re-anchor math in `show_capture`.

- [ ] **Step 4: capture→main refresh (branch on Step 1 result)**

- **If `[oxinot] notes:changed received` DID appear and the note showed:** event works — no `App.tsx` change. Remove the diagnostic `console.log` (CardGrid) and `tracing::info!` (lib.rs) added during P0.
- **If the listener did NOT fire / note missing:** set `refetchOnWindowFocus: true` for the notes query in `App.tsx` (override the QueryClient default for `["notes"]`), so the main grid refetches when the overlay hides and focus returns. Keep or remove diagnostics per preference.

- [ ] **Step 5: Typecheck + manual end-to-end**

Run: `bunx tsc -b`. `cargo tauri dev`: ⌘⇧N → `/todo` → type → Enter → note appears in main grid with todo color. Esc closes without saving.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/components/QuickCaptureForm.tsx apps/desktop/src/components/CaptureOverlay.tsx apps/desktop/src/App.tsx apps/desktop/src/components/CardGrid.tsx apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(capture): redesigned shell (slash logic reused) + reliable capture→main refresh"
```

---

## Final verification

- [ ] `cargo test -p oxinot-core` — all pass (incl. new save/CRUD/rename tests).
- [ ] `cargo clippy -p oxinot-core -- -D warnings` + `cargo check -p oxinot-desktop` — 0 warnings.
- [ ] `cd apps/desktop && bunx tsc -b` — exit 0.
- [ ] Manual (spec §11): settings drawer; category CRUD persists across restart; rename migrates; inbox transparent; capture input mounts + saves + appears in grid; combobox filter/create.
- [ ] Redeploy: `cargo build -p oxinot-desktop --release` + `codesign --force --deep -s -` on the .app.
