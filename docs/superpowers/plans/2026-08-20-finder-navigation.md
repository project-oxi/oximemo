# Finder Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace oximemo's mixed memo/notebook navigation with a Finder-style three-surface layout: breadcrumb bar (single source of location), main area rendering folder tiles + note cards of the current location, sidebar as pure curation (smart collections / pinned folders / tags).

**Architecture:** Browse/query duality over the existing `folderFilter: string | null` store field — `null` = query mode, `""`/path = browse mode. Folder tiles earn the 176px card chrome by showing recursive counts + 3 recent note titles (new `folder_children` IPC backed by the newest-first `by_sort` index). Rust core (`oximemo-core`) gains `MemoFilter.immediate`, `rename_folder`, trash-based `delete_folder`, `restore_notes`, `FolderDef.pinned`; the browser localStorage fallback mirrors every new command.

**Tech Stack:** Tauri v2 + Rust (oximemo-core, redb index, tantivy search), React 19 + TypeScript, Zustand (`stores/ui.ts`), TanStack Query/Virtual, Base UI components, Tailwind v4 tokens. Tests: `cargo test` (core), `tsc -b && vite build` + headless-browser smoke on the localStorage fallback (`bun run dev` → :5173).

**Authoritative design docs:** `docs/superpowers/specs/2026-08-20-finder-navigation-design.md` (original), `...-design-review.md` (supersedes its §2/3.1/4.2/5.1/6.3/10 — blockers B1–B4, risks H5–H11, M11–M20), `.../assets/2026-08-20-folder-tile-mockup.html` (visual reference).

## Global Constraints

- Korea-first i18n: `apps/desktop/src/lib/locales/ko.ts` is the source of truth; `en.ts` is `Record<keyof typeof ko, string>` — every new key lands in BOTH files in the same commit.
- The UI never renders the literal string `(root)`; root is `t.folder_root` ("최상위"/"Top level") or the vault icon.
- No hardcoded colors: any new surface color is a CSS token. Folder tile background = new `--folder-tile-bg` token (light `var(--color-surface-muted)`, dark `var(--color-surface-sunken)`).
- Browser fallback (`apps/desktop/src/lib/tauri.ts`) implements every new command with identical semantics — it is a first-class verification surface.
- Build gates: `cargo test --workspace` (Rust), `cd apps/desktop && bun run build` (tsc -b && vite build). Both must pass before every commit.
- Conventional Commits, English messages. Commit after every green step.
- Existing invariants to preserve: `move_note` derives the new filename from the title; watcher `memos:changed` invalidates `["memos","search","facets","stats","folders","config"]`; `PAGE_SIZE = 50`, `MIN_COL_W = 240`, `CARD_H = 176`.
- Dev server: `cd apps/desktop && bun run dev` (port 5173; if stuck: `lsof -ti :5173 | xargs kill -9`). Fallback localStorage keys: `oximemo:memos:v3`, `oximemo:folderviews:v1`, `oximemo:folders:v1`, new `oximemo:folderpins:v1`.

---

### Task 1 (P0): Fix the no-op move wiring

`CardGrid.onMoveFolder` calls `updateMemo(id, null, null)` — a no-op that still toasts success (`CardGrid.tsx:232-244`). The fallback `move_note` is a stub that only emits an event (`tauri.ts:348-350`). Every later task (DnD, tile menus) builds on move working.

**Files:**
- Modify: `apps/desktop/src/components/CardGrid.tsx:232-244`
- Modify: `apps/desktop/src/lib/tauri.ts:348-350`

**Interfaces:**
- Consumes: `moveNote(id, folder)` from `api.ts:190` (unchanged), `invoke` browser fallback.
- Produces: a working `onMoveFolder(id, folder)` that later tasks (Tiles, DnD) reuse unchanged.

- [ ] **Step 1: Implement the real move in the fallback**

In `tauri.ts`, replace the `move_note` case:

```ts
    case "move_note": {
      const id = args?.id as string;
      const folder = ((args?.folder as string | undefined) ?? "").trim();
      const store = loadStore();
      const n = store[id];
      if (!n) throw new Error(`memo not found: ${id}`);
      const oldRel = n.path;
      const ext = n.format === "html" ? ".html" : ".md";
      const base = (n.title ?? `note-${Date.now()}`).replace(/[^\p{L}\p{N}]+/gu, "-");
      n.folder = folder;
      n.path = `${folder ? `${folder}/` : ""}${base}${ext}`;
      store[id] = n;
      saveStore(store);
      if (folder) {
        const paths = loadFolders();
        if (!paths.includes(folder)) {
          paths.push(folder);
          saveFolders(paths);
        }
      }
      // oldRel is derived; nothing else references it.
      emitBrowser("memos:changed");
      return n;
    }
```

- [ ] **Step 2: Rewire `onMoveFolder` in CardGrid.tsx**

```ts
  const onMoveFolder = (id: string, folder: string) => {
    void moveNote(id, folder)
      .then(() => {
        qc.invalidateQueries({ queryKey: ["memos"] });
        qc.invalidateQueries({ queryKey: ["search"] });
        qc.invalidateQueries({ queryKey: ["facets"] });
        qc.invalidateQueries({ queryKey: ["folders"] });
        setToast(`→ ${folder || t.folder_root}`);
      })
      .catch((e) => setError(String(e).split("\n")[0]));
  };
```

Add `moveNote` to the existing import from `"../lib/api"` (alphabetical order).

- [ ] **Step 3: Build + smoke**

Run: `cd apps/desktop && bun run build` → expect green.
Run: `cd apps/desktop && bun run dev`, open `http://localhost:5173`. Seed and verify via browser console:

```js
localStorage.clear();
const mk = (id, folder, title) => ({ id, created_at: "2026-08-20T00:00:00Z", updated_at: "2026-08-20T00:00:00Z", hash: "b3:x", favorite: false, folder, path: `${folder ? folder + "/" : ""}${title}.md`, format: "markdown", title, tags: [], body: `# ${title}`, deleted_at: null });
localStorage.setItem("oximemo:memos:v3", JSON.stringify({ a: mk("a", "", "Loose"), b: mk("b", "", "ToMove") }));
localStorage.setItem("oximemo:folders:v1", JSON.stringify(["target"]));
location.reload();
// then: right-click the "ToMove" card → 폴더로 이동 → target
// assert: note disappears from root list; localStorage b.folder === "target"
```

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/components/CardGrid.tsx apps/desktop/src/lib/tauri.ts
git commit -m "fix: actually move notes on 'move to folder' (was a silent no-op)"
```

---

### Task 2 (P1): `MemoFilter.immediate` — direct-children browse

**Files:**
- Modify: `crates/oximemo-core/src/memo.rs:265-333`
- Modify: `apps/desktop/src-tauri/src/lib.rs:507-535` (`list_memos`)
- Modify: `apps/desktop/src/lib/api.ts:25-46` (`listMemos`)
- Test: `crates/oximemo-core/src/memo.rs` (inline `#[cfg(test)]`)

**Interfaces:**
- Produces: `MemoFilter { ..., immediate: bool }` (default `false` = recursive). `folder_matches(path, folder, immediate)` stays private. IPC `list_memos` accepts `immediate: Option<bool>`; `listMemos(after, limit, { ..., immediate?: boolean })`.

- [ ] **Step 1: Write the failing test** (append to the `mod tests` in `memo.rs`):

```rust
    #[test]
    fn immediate_folder_filter_excludes_subfolders() {
        let mut f = MemoFilter { folder: Some("novel".into()), immediate: true, ..Default::default() };
        assert!(f.matches(&sum(&[], "novel/ch1.md", false)));
        assert!(!f.matches(&sum(&[], "novel/act1/ch2.md", false)));
        f.immediate = false;
        assert!(f.matches(&sum(&[], "novel/act1/ch2.md", false)));
        // Root is immediate-agnostic: loose only, both modes.
        let root = MemoFilter { folder: Some(String::new()), immediate: true, ..Default::default() };
        assert!(root.matches(&sum(&[], "root-file.md", false)));
        assert!(!root.matches(&sum(&[], "sub/root-file.md", false)));
    }
```

- [ ] **Step 2: Run** `cargo test -p oximemo-core immediate_folder` → FAIL (no `immediate` field).

- [ ] **Step 3: Implement.** Add the field to `MemoFilter` (after `include_deleted`):

```rust
    /// `true` = only notes whose directory equals `folder` exactly
    /// (no subfolders). Default `false` (recursive prefix match).
    pub immediate: bool,
```

`matches()` callsite becomes `!folder_matches(&s.path, folder, self.immediate)`, and:

```rust
fn folder_matches(path: &str, folder: &str, immediate: bool) -> bool {
    let dir = match path.rfind('/') {
        Some(i) => &path[..i],
        None => "",
    };
    if folder.is_empty() {
        return dir.is_empty();
    }
    if immediate {
        return dir == folder;
    }
    dir == folder || dir.starts_with(&format!("{folder}/"))
}
```

- [ ] **Step 4:** `cargo test -p oximemo-core` → PASS (existing `folder_membership` still green: it constructs `MemoFilter` via `..Default::default()`).

- [ ] **Step 5: IPC.** In `lib.rs` `list_memos` add parameter `immediate: Option<bool>` after `favorites_only`, and `immediate: immediate.unwrap_or(false),` in the `MemoFilter` literal. In `api.ts` `listMemos` add `immediate?: boolean` to the filter object and pass `immediate: filter.immediate ?? null` in the invoke args. (Fallback ignores it — it is already direct-equality.)

- [ ] **Step 6:** `cargo test --workspace && cd apps/desktop && bun run build` → green.

- [ ] **Step 7: Commit** `feat: MemoFilter.immediate for direct-children folder browsing`

---

### Task 3 (P1): `folder_children` — recursive counts + recent titles

**Files:**
- Modify: `crates/oximemo-core/src/vault.rs` (new `pub fn folder_children` near `list_folders`, ~line 130; new structs near `ListFolderResult` usage is NOT needed — core types live in vault.rs)
- Modify: `apps/desktop/src-tauri/src/lib.rs` (new command + `generate_handler!` entry)
- Modify: `apps/desktop/src/lib/api.ts`, `apps/desktop/src/lib/types.ts`, `apps/desktop/src/lib/tauri.ts`
- Test: `crates/oximemo-core/src/vault.rs` inline tests

**Interfaces:**
- Consumes: `Vault::list_folders` (immediate counts, includes empty dirs), `with_redb(|idx| idx.export_since(None))` (newest-first `Vec<IndexRecord>`), `IndexRecord { id, path, title, updated_at, deleted }`.
- Produces (core + TS mirror):

```rust
#[derive(Debug, Clone, Serialize)]
pub struct FolderRecent {
    pub id: crate::memo::MemoId,
    pub title: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

#[derive(Debug, Clone, Serialize)]
pub struct FolderCard {
    pub path: String,
    pub note_count: u32,        // direct children (list_folders value)
    pub note_count_deep: u32,   // recursive
    pub subfolder_count: u32,   // direct subfolders
    pub recent: Vec<FolderRecent>, // ≤3, newest-first
}

impl Vault {
    pub fn folder_children(&self, parent: &str) -> Result<Vec<FolderCard>>
}
```

- [ ] **Step 1: Failing test** (in vault.rs tests, reuse the `tmp_vault()` helper):

```rust
    #[test]
    fn folder_children_counts_recursively_and_peeks_recents() {
        let (_t, v) = tmp_vault();
        let a = v.create_note("novel/act1", "Chapter One".into(), NoteFormat::Markdown).unwrap();
        v.create_note("novel/act1", "Chapter Two".into(), NoteFormat::Markdown).unwrap();
        v.create_note("root", "Loose".into(), NoteFormat::Markdown).unwrap();
        v.create_folder("empty").unwrap();

        let root = v.folder_children("").unwrap();
        let novel = root.iter().find(|c| c.path == "novel").unwrap();
        assert_eq!((novel.note_count, novel.note_count_deep, novel.subfolder_count), (0, 2, 1));
        assert_eq!(novel.recent.len(), 2);
        assert_eq!(novel.recent[0].title.as_deref(), Some("Chapter Two")); // newest first

        let act1 = v.folder_children("novel").unwrap();
        assert_eq!(act1.len(), 1);
        assert_eq!(act1[0].path, "novel/act1");
        assert_eq!((act1[0].note_count, act1[0].note_count_deep), (2, 2));
        assert!(v.folder_children("").unwrap().iter().any(|c| c.path == "empty" && c.recent.is_empty()));
        let _ = a;
    }
```

(Note: `create_note` signature is `(folder, body, fmt)` per the existing test at vault.rs:1441 — body is the note text; titles derive from H1. Use `# Chapter One` style bodies if the helper takes raw bodies.)

- [ ] **Step 2:** `cargo test -p oximemo-core folder_children` → FAIL (no method).

- [ ] **Step 3: Implement** in vault.rs:

```rust
    /// Folder cards for one browse level: deep counts (reverse-sorted
    /// prefix summation over `list_folders`), direct subfolder counts, and
    /// up to 3 recent note titles attributed to the nearest displayed
    /// ancestor (index scan, early exit).
    pub fn folder_children(&self, parent: &str) -> Result<Vec<FolderCard>> {
        let all = self.list_folders()?; // BTree-sorted (path, immediate)
        let prefix = if parent.is_empty() { String::new() } else { format!("{parent}/") };
        let is_child = |p: &str| {
            !p.is_empty() && (parent.is_empty()
                || (p.starts_with(&prefix) && !p[prefix.len()..].contains('/')))
        };
        let kids: Vec<&String> = all.iter().map(|(p, _)| p).filter(|p| is_child(p)).collect();

        // Deep counts: reverse iteration guarantees children finalize first.
        let mut deep: std::collections::BTreeMap<String, u32> =
            all.iter().cloned().collect();
        for (p, _) in all.iter().rev() {
            if let Some(i) = p.rfind('/') {
                let d = deep[p];
                *deep.entry(p[..i].to_string()).or_insert(0) += d;
            }
        }

        let subfolder_count = |kid: &str| {
            let kp = format!("{kid}/");
            all.iter().filter(|(p, _)| p.starts_with(&kp) && !p[kp.len()..].contains('/')).count() as u32
        };

        // Recents from the newest-first index.
        let recs = self.with_redb(|idx| idx.export_since(None))?;
        let mut recent: Vec<(String, Vec<FolderRecent>)> =
            kids.iter().map(|k| ((*k).clone(), Vec::new())).collect();
        let target: Vec<usize> = kids.iter().enumerate()
            .filter(|(_, k)| deep[***k] > 0)
            .map(|(i, _)| i).collect();
        let mut done = 0usize;
        'scan: for r in recs.iter().filter(|r| !r.deleted) {
            if done == target.len() { break; }
            let mut probe = match r.path.rfind('/') { Some(i) => &r.path[..i], None => "" };
            loop {
                if let Some(slot) = recent.iter_mut().find(|(p, _)| p == probe) {
                    if slot.1.len() < 3 {
                        slot.1.push(FolderRecent { id: r.id, title: r.title.clone(), updated_at: r.updated_at });
                        if slot.1.len() == 3 { done += 1; }
                    }
                    continue 'scan;
                }
                match probe.rfind('/') { Some(i) => probe = &probe[..i], None => continue 'scan }
            }
        }

        Ok(kids.iter().map(|k| FolderCard {
            path: (*k).clone(),
            note_count: all.iter().find(|(p, _)| p == *k).map(|(_, n)| *n).unwrap_or(0),
            note_count_deep: deep[*k],
            subfolder_count: subfolder_count(k),
            recent: recent.iter().find(|(p, _)| p == *k).map(|(_, v)| v.clone()).unwrap_or_default(),
        }).collect())
    }
```

Fix the `deep[***k]` typo when pasting: it must read `deep[**k] > 0`. If `export_since` is not strictly newest-first in your checkout, sort `recs` by `updated_at` desc before scanning.

- [ ] **Step 4:** `cargo test -p oximemo-core folder_children` → PASS. Then `cargo test --workspace`.

- [ ] **Step 5: IPC + api + types + fallback.**

`lib.rs` command (register in `generate_handler!` after `list_folders`):

```rust
    #[tauri::command]
    pub fn folder_children(
        state: State<'_, AppState>,
        path: String,
    ) -> Result<Vec<oximemo_core::FolderCard>, String> {
        state.vault.folder_children(&path).map_err(|e| e.to_string())
    }
```

(If `FolderCard` is not re-exported from `oximemo_core`, add `pub use vault::{FolderCard, FolderRecent};` to `crates/oximemo-core/src/lib.rs` next to the existing `Page`/`MemoSummary` re-exports.)

`types.ts`:

```ts
export interface FolderRecent { id: MemoId; title: string | null; updated_at: string; }
export interface FolderCard {
  path: string;
  note_count: number;
  note_count_deep: number;
  subfolder_count: number;
  recent: FolderRecent[];
}
```

`api.ts`: `export async function folderChildren(path: string): Promise<FolderCard[]> { return invoke<FolderCard[]>("folder_children", { path }); }`

`tauri.ts` fallback case (place next to `list_folders`):

```ts
    case "folder_children": {
      const parent = ((args?.path as string | undefined) ?? "").trim();
      const live = liveSorted(loadStore());
      const entries = await browserFallback("list_folders") as FolderEntry[];
      const kids = entries.filter((e) => e.path !== "" && (parent === ""
        ? !e.path.includes("/")
        : e.path.startsWith(`${parent}/`) && !e.path.slice(parent.length + 1).includes("/")));
      return kids.map((k) => {
        const kp = `${k.path}/`;
        const inDeep = live.filter((n) => (n.folder ?? "") === k.path || (n.folder ?? "").startsWith(kp));
        return {
          path: k.path,
          note_count: k.note_count,
          note_count_deep: inDeep.length,
          subfolder_count: entries.filter((e) => e.path.startsWith(kp) && !e.path.slice(kp.length).includes("/")).length,
          recent: inDeep.slice(0, 3).map((n) => ({ id: n.id, title: n.title, updated_at: n.updated_at })),
        };
      });
    }
```

(`browserFallback` is `async`; the self-call is legal and keeps one source of folder enumeration.)

- [ ] **Step 6:** `cargo test --workspace && cd apps/desktop && bun run build` → green.

- [ ] **Step 7: Commit** `feat: folder_children IPC with recursive counts and recent-title peek`

---

### Task 4 (P1): `FolderDef.pinned` + `set_folder_pinned`

**Files:**
- Modify: `crates/oximemo-core/src/config.rs:129-161` (`FolderDef`)
- Modify: `crates/oximemo-core/src/vault.rs:796-822` (`set_folder_view` entry-drop logic + new `set_folder_pinned`)
- Modify: `apps/desktop/src-tauri/src/lib.rs` (command + handler)
- Modify: `apps/desktop/src/lib/types.ts:100-104`, `api.ts`, `tauri.ts`
- Test: `crates/oximemo-core/src/vault.rs` inline tests

**Interfaces:**
- Produces: `FolderDef { path, view?, color?, pinned?: Option<bool> }` (serde default/skip-if-none). Core `Vault::set_folder_pinned(&self, path: &str, pinned: bool)`. IPC `set_folder_pinned(path, pinned)`. api.ts `setFolderPinned(path: string, pinned: boolean)`. Fallback: `oximemo:folderpins:v1` (string[]), surfaced via `get_config` `folders` entries as `pinned: true`.

- [ ] **Step 1: Failing test**:

```rust
    #[test]
    fn set_folder_pinned_roundtrip() {
        let (_t, v) = tmp_vault();
        v.set_folder_pinned("novel", true).unwrap();
        assert_eq!(
            v.with_config(|c| c.folders.items.iter().find(|f| f.path == "novel").and_then(|f| f.pinned)),
            Some(true)
        );
        // Unpin with nothing else set → entry dropped (clean config).
        v.set_folder_pinned("novel", false).unwrap();
        assert!(v.with_config(|c| c.folders.items.iter().all(|f| f.path != "novel")));
    }
```

- [ ] **Step 2:** `cargo test -p oximemo-core set_folder_pinned` → FAIL.

- [ ] **Step 3: Implement.** `config.rs` — extend `FolderDef`:

```rust
    /// Pinned to the sidebar favorites section. `None` = not pinned.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
```

Update every `FolderDef { .. }` literal in the workspace to add `pinned: None` (`vault.rs:803`, any in `migrate.rs`/tests — the compiler lists them). In `set_folder_view`'s `None` branch, change the drop condition `if f.color.is_none()` to `if f.color.is_none() && f.pinned.is_none()`. New method next to it:

```rust
    /// Pin/unpin a folder to the sidebar favorites, persisted to `oximemo.toml`.
    pub fn set_folder_pinned(&self, path: &str, pinned: bool) -> Result<()> {
        let mut cfg = self.config.write();
        if pinned {
            if let Some(f) = cfg.folders.items.iter_mut().find(|f| f.path == path) {
                f.pinned = Some(true);
            } else {
                cfg.folders.items.push(crate::config::FolderDef {
                    path: path.to_string(), view: None, color: None, pinned: Some(true),
                });
            }
        } else if let Some(f) = cfg.folders.items.iter_mut().find(|f| f.path == path) {
            f.pinned = None;
            if f.view.is_none() && f.color.is_none() {
                cfg.folders.items.retain(|f| f.path != path);
            }
        }
        cfg.save(&self.paths)?;
        Ok(())
    }
```

- [ ] **Step 4:** `cargo test --workspace` → PASS.

- [ ] **Step 5: IPC/api/fallback.** Command mirrors `set_folder_view` (`set_folder_pinned(state, path: String, pinned: bool)` → `state.vault.set_folder_pinned(&path, pinned)`); register it. `types.ts` `FolderDef` gains `pinned?: boolean;`. `api.ts`:

```ts
export async function setFolderPinned(path: string, pinned: boolean): Promise<void> {
  await invoke<void>("set_folder_pinned", { path, pinned });
}
```

`tauri.ts`: `const PINS_KEY = "oximemo:folderpins:v1";` + `loadPins()/savePins()` (clone the `loadFolders` pattern). New cases:

```ts
    case "set_folder_pinned": {
      const path = args?.path as string;
      const pinned = args?.pinned as boolean;
      const pins = loadPins();
      savePins(pinned ? (pins.includes(path) ? pins : [...pins, path]) : pins.filter((p) => p !== path));
      emitBrowser("memos:changed");
      return null;
    }
```

And in `get_config`, merge pins into the folders array:

```ts
        folders: [
          ...Object.entries(loadViews()).map(([path, view]) => ({ path, view, color: null,
            pinned: loadPins().includes(path) ? true : null })),
          ...loadPins().filter((p) => !(p in loadViews())).map((path) => ({ path, view: null, color: null, pinned: true })),
        ],
```

- [ ] **Step 6:** `cargo test --workspace && bun run build` → green. Commit `feat: FolderDef.pinned with IPC and fallback storage`.

---

### Task 5 (P1): Store semantics — browse default, query view, keys

**Files:**
- Modify: `apps/desktop/src/stores/ui.ts`
- Modify: `apps/desktop/src/components/CardGrid.tsx` (keys effect, lock guard, view pin separation)

**Interfaces:**
- Produces: `folderFilter` default `""` (root browse); `searchScope: "folder" | "all"` + `setSearchScope`; query-mode `noteView` persisted at `localStorage["oximemo.queryView"]`; `⌘↑` navigate-up handler exposed via store action `navigateUp()`.

- [ ] **Step 1: ui.ts changes.**

```ts
const QUERY_VIEW_KEY = "oximemo.queryView";

function loadQueryView(): ViewMode {
  const v = localStorage.getItem(QUERY_VIEW_KEY);
  return v === "list" || v === "timeline" || v === "graph" ? v : "grid";
}
```

In `UIState`: add `searchScope: "folder" | "all"; setSearchScope: (s: "folder" | "all") => void;` and `navigateUp: () => void;`. In the store creator:

```ts
  /** null = query mode; "" = vault root browse; path = folder browse. */
  folderFilter: "" as string | null,
```

(Replace the current `folderFilter: null` — search `useUI` initial values.) Add:

```ts
  searchScope: "folder",
  setSearchScope: (s) => set({ searchScope: s }),
  navigateUp: () => {
    const cur = useUI.getState().folderFilter;
    if (cur === null || cur === "") return;
    const next = cur.includes("/") ? cur.slice(0, cur.lastIndexOf("/")) : "";
    set({ folderFilter: next });
  },
```

Persist query-mode view: in `setNoteView`, `if (useUI.getState().folderFilter === null) localStorage.setItem(QUERY_VIEW_KEY, v);` and initialize `noteView: loadQueryView()` (the folder-pin sync effect in CardGrid overwrites it for browse locations — see Step 2).

- [ ] **Step 2: CardGrid adjustments.**

Lock/pin effect (CardGrid.tsx:97-100) — only in browse mode:

```ts
  useEffect(() => {
    if (folderFilter === null) { setNoteView(loadQueryViewFromStorage()); return; }
    const def = configQ.data?.folders?.find((f) => f.path === folderFilter);
    if (def?.view) setNoteView(def.view);
  }, [folderFilter, configQ.data, setNoteView]);
```

(`loadQueryViewFromStorage` = exported `loadQueryView` from ui.ts — export it.) `setNoteViewLocked` (102-112): skip `setFolderView` when `folderFilter === null` (write localStorage only). Lock lookup (295-297): `const isLocked = folderFilter !== null && !!folders.find((f) => f.path === folderFilter)?.view;` — and render the lock button only when `folderFilter !== null`.

Listing query (114-127): pass `immediate: folderFilter !== null` (browse = direct children; query mode has no folder so the flag is inert).

Keyboard — extend the existing `onKey` effect (270-279):

```ts
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key === "ArrowUp") {
        e.preventDefault();
        useUI.getState().navigateUp();
      }
```

Escape handler (window level, same effect): if `e.key === "Escape"` and no dialog open (`!useUI.getState().selectedId`) and `localSearch` non-empty → clear `localSearch`, `debounced` and `search`. (No navigation on Escape — H8.)

- [ ] **Step 3: Build + smoke** — `bun run build`; in the browser: reload lands on root browse (no smart-collection highlighted); `⌘↑` at root is a no-op; switching to list in "모든 노트" persists across reload (`localStorage["oximemo.queryView"] === "list"`).

- [ ] **Step 4: Commit** `feat: browse-by-default store semantics, query view persistence, ⌘↑`

---

### Task 6 (P1): BreadcrumbBar + header rebuild

**Files:**
- Create: `apps/desktop/src/components/BreadcrumbBar.tsx`
- Modify: `apps/desktop/src/components/CardGrid.tsx:281-412` (header), `apps/desktop/src/app.css` (token), `apps/desktop/src/tokens/semantic-dark.css` (token), `apps/desktop/src/lib/locales/ko.ts` + `en.ts`

**Interfaces:**
- Consumes: `folderEntries: FolderEntry[]`, `folderFilter`, `useUI` setters; `Popover`-style dropdown (follow `SettingsMenu.tsx`'s existing Base UI Popover import pattern).
- Produces: `<BreadcrumbBar folders={folderEntries} />` rendered as the header's first flex child; drop-target API for Task 14: each segment exposes `data-breadcrumb-path={path}`.

- [ ] **Step 1: Tokens.** `app.css` (light, next to `--color-surface-*`):

```css
  /* Folder tile: one step below surface-raised (review H5 mockup decision) */
  --folder-tile-bg: var(--color-surface-muted);
```

`semantic-dark.css` (surfaces block): `--folder-tile-bg: var(--color-surface-sunken);`

- [ ] **Step 2: i18n keys** (ko / en): `vault_root: "볼트" / "Vault"`, `breadcrumb_label: "경로" / "Location"`, `scope_this_folder: "이 폴더" / "This Folder"`, `scope_all: "전체" / "All"`, `folder_notes: "노트 {n}" / "{n} notes"`, `folder_subfolders: "폴더 {n}" / "{n} folders"`, `folder_empty: "비어 있음" / "Empty"`, `query_all_notes: "모든 노트" / "All Notes"`, `query_favorites: "즐겨찾기" / "Favorites"`, `query_search: "검색: {q}" / "Search: {q}"`, `query_tags: "태그" / "Tags"`, `global_badge: "전역" / "Global"`, `jump_to_folder: "폴더로 이동…" / "Go to Folder…"`, `show_all_folders: "폴더 {n}개 모두 보기" / "Show all {n} folders"`.

- [ ] **Step 3: BreadcrumbBar.tsx.**

```tsx
/**
 * BreadcrumbBar — the single source of location (review §4.1). Browse mode
 * renders one clickable segment per path component (root = vault icon);
 * query mode renders one inert label. Each segment has a ▾ dropdown listing
 * sibling + child folders (the only descent path in Timeline/Graph views).
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Folder, Layers, Search, Star, Hash } from "lucide-react";
import { colorForFolder } from "../lib/color";
import { useUI } from "../stores/ui";
import { useI18n } from "../lib/i18n";
import type { FolderEntry } from "../lib/types";

export function BreadcrumbBar({ folders }: { folders: FolderEntry[] }) {
  const { t } = useI18n();
  const folderFilter = useUI((s) => s.folderFilter);
  const setFolderFilter = useUI((s) => s.setFolderFilter);
  const search = useUI((s) => s.search);
  const favoritesOnly = useUI((s) => s.favoritesOnly);
  const tagFilter = useUI((s) => s.tagFilter);
  const view = useUI((s) => s.view);

  const wrapRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(0); // leading segments hidden

  // Query-mode label
  const query = folderFilter === null;
  const queryLabel = search
    ? t.query_search.replace("{q}", search)
    : favoritesOnly ? t.query_favorites
    : Object.keys(tagFilter).some((k) => tagFilter[k] !== "off") ? t.query_tags
    : t.query_all_notes;

  const segs = query ? [] : folderFilter === "" ? [] : folderFilter.split("/");
  const paths: string[] = [];
  segs.forEach((_, i) => paths.push(segs.slice(0, i + 1).join("/")));

  // Overflow: collapse leading segments while the bar exceeds its box.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let hide = 0;
    const probe = () => el.scrollWidth > el.clientWidth;
    while (hide < segs.length - 1) { /* setCollapsed-driven remeasure loop below */ break; }
    setCollapsed(0);
    // measure with none hidden, then step:
    requestAnimationFrame(() => {
      let h = 0;
      const check = () => {
        el.style.setProperty("--hidden", String(h));
        if (probe() && h < segs.length - 1) { h += 1; setCollapsed(h); requestAnimationFrame(check); }
      };
      check();
    });
  }, [folderFilter, segs.length]);

  if (view === "gallery") return null;

  return (
    <nav
      aria-label={t.breadcrumb_label}
      data-tauri-drag-region="false"
      ref={wrapRef}
      className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden text-[13px]"
    >
      {query ? (
        <span className="flex items-center gap-1.5 px-1 font-semibold text-text">
          {search ? <Search size={13} /> : favoritesOnly ? <Star size={13} /> : Object.keys(tagFilter).some((k) => tagFilter[k] !== "off") ? <Hash size={13} /> : <Layers size={13} />}
          {queryLabel}
        </span>
      ) : (
        <>
          <SegmentButton label={t.vault_root} iconOnly onClick={() => setFolderFilter("")} path="" folders={folders} isRoot />
          {segs.map((name, i) =>
            i < collapsed
              ? i === 0 && collapsed > 0 ? (
                <span key={`ell-${i}`} className="px-0.5 text-text-subtle" title={paths[i]}>…</span> && null
              ) : null
              : <SegmentButton key={paths[i]} label={name} sublabel={paths[i]} path={paths[i]} folders={folders} last={i === segs.length - 1} onClick={() => setFolderFilter(paths[i])} />
          )}
        </>
      )}
    </nav>
  );
}
```

`SegmentButton` (same file): root renders `Folder`-in-circle vault icon (`aria-label={t.vault_root}`); non-root renders the name, `text-text-muted hover:text-text`, separator `<ChevronRight size={11} className="text-text-subtle" />` before it; last segment `font-semibold text-text` and non-clickable. Each non-last segment gets a `ChevronDown` (8px) button opening a `Popover` listing siblings + children computed from `folders`:

```tsx
function levelFolders(folders: FolderEntry[], path: string): FolderEntry[] {
  // children of `path` ("" = root level)
  const p = path ? `${path}/` : "";
  return folders.filter((f) => f.path !== "" && (p === ""
    ? !f.path.includes("/")
    : f.path.startsWith(p) && !f.path.slice(p.length).includes("/")));
}
```

Dropdown item: folder-color dot (`colorForFolder`), name, `note_count`. Click → `setFolderFilter(entry.path)`.

The collapsed-segments logic above is intentionally simple; the `…` chip (first hidden segment's spot) must render `<button onClick={() => setCollapsed(0)}>` restoring full path on demand. Simplify the JSX: render `…` when `collapsed > 0` exactly once before the visible segments (`segs.slice(collapsed)`), dropping the inline `&& null` placeholder from the sketch.

- [ ] **Step 4: Header rebuild in CardGrid.**

Replace header children order: `<BreadcrumbBar folders={folderEntries} />` … then the existing search box, then `viewSwitcher` (icons), then new-note split button, then `<SettingsMenu />`. Move `sidebarToggle` from `fixed left-[82px]` into the header as the FIRST element (`className="flex h-12 items-center pl-1"` wrapper, no `fixed`), delete the `fixed` positioning block (CardGrid.tsx:281-292) and its two `{sidebarToggle}` usages (344, 369). Iconize the switcher: replace the four label buttons with `LayoutGrid / List / Clock / Network` lucide icons (`size={13}`, same active classes, `aria-pressed`, `title` = mode name). Keep the lock button but render only when `folderFilter !== null`.

Header root keeps `data-tauri-drag-region="deep"`; `BreadcrumbBar`'s `nav` sets `data-tauri-drag-region="false"` (already in the sketch).

- [ ] **Step 5: Build + smoke.** `bun run build`; browser: seed folders `["작업","작업/2026"]`; click `작업` tile-less path via console `useUI`? Not exported — instead click through: root shows `볼트 ›` after navigating (folders appear after Task 7). For now verify: query labels (`모든 노트`), `⌘⇧` none. Minimum assertion: `document.querySelector('nav[aria-label="경로"]')` exists and shows `전체` scope-independent root icon in browse mode after `localStorage` seed + clicking a sidebar folder (sidebar still has tree until Task 9 — click `작업` there): nav shows `볼트 › 작업`, segment click on `볼트` returns to root.

- [ ] **Step 6: Commit** `feat: breadcrumb bar as the location source of truth`

---

### Task 7 (P1): FolderTile + flat cell array + List folder rows

**Files:**
- Create: `apps/desktop/src/components/FolderTile.tsx`
- Modify: `apps/desktop/src/components/CardGrid.tsx` (cells computation, folderChildren query), `apps/desktop/src/components/views/GridView.tsx`, `apps/desktop/src/components/views/ListView.tsx`
- Modify: `apps/desktop/src/lib/locales/ko.ts` + `en.ts`

**Interfaces:**
- Consumes: `FolderCard` (Task 3), `--folder-tile-bg` (Task 6), `colorForFolder`, `relativeTime`, `useI18n`.
- Produces: `GridView` props swap `items: MemoSummary[]` → `cells: Cell[]` where `export type Cell = { kind: "folder"; card: FolderCard } | { kind: "note"; note: MemoSummary };` (export from `views/GridView.tsx`). `FolderTile` props: `{ card, folders, onOpen(path), onOpenNote(id), onNewNote(path) }`.

- [ ] **Step 1: FolderTile.tsx** — 176px, note-card chrome, content peek (mockup C):

```tsx
import { Folder, Plus } from "lucide-react";
import { colorForFolder } from "../lib/color";
import { relativeTime } from "../lib/time";
import { useI18n } from "../lib/i18n";
import type { FolderCard, FolderDef } from "../lib/types";

interface Props {
  card: FolderCard;
  folders: FolderDef[];
  onOpen: (path: string) => void;
  onOpenNote: (id: string) => void;
  onNewNote: (path: string) => void;
}

export function FolderTile({ card, folders, onOpen, onOpenNote, onNewNote }: Props) {
  const { t, locale } = useI18n();
  const color = colorForFolder(card.path, folders);
  return (
    <article
      data-folder-tile={card.path}
      role="button"
      aria-label={card.path}
      tabIndex={0}
      onClick={() => onOpen(card.path)}
      onKeyDown={(e) => { if (e.key === "Enter") onOpen(card.path); }}
      className="group relative flex h-44 cursor-default flex-col overflow-hidden rounded-[var(--card-radius)] border border-line bg-[var(--folder-tile-bg)] p-4 shadow-xs transition-[border-color,box-shadow] duration-150 hover:border-line-strong hover:shadow-sm"
    >
      <span aria-hidden className="absolute left-4 top-0 h-[3px] w-7 rounded-b-[3px]" style={{ backgroundColor: color }} />
      <div className="flex min-w-0 items-center gap-2">
        <Folder size={13} className="shrink-0" style={{ color }} />
        <span className="truncate text-sm font-semibold text-text">{card.path.split("/").at(-1)}</span>
        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-text-subtle">{card.note_count_deep}</span>
      </div>
      <div className="my-2 border-t border-line" />
      {card.recent.length > 0 ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {card.recent.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={(e) => { e.stopPropagation(); onOpenNote(r.id); }}
              className="truncate rounded px-1 py-0.5 text-left text-[13px] leading-relaxed text-text-muted hover:bg-surface-muted hover:text-text"
            >
              {r.title ?? t.empty_memo}
            </button>
          ))}
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-start justify-center gap-2">
          <span className="text-[13px] text-text-subtle">{t.folder_empty}</span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onNewNote(card.path); }}
            className="rounded-[var(--tag-radius)] border border-line bg-surface-raised px-2.5 py-1 text-xs text-text-muted hover:border-line-strong hover:text-text"
          >
            <Plus size={11} className="mr-1 inline" /> {t.new_note_md}
          </button>
        </div>
      )}
      <div className="mt-auto flex gap-1.5 pt-1.5 text-[11px] text-text-subtle">
        {card.subfolder_count > 0 && <span>{t.folder_subfolders.replace("{n}", String(card.subfolder_count))}</span>}
        {card.subfolder_count > 0 && <span>·</span>}
        <span>{card.recent[0] ? relativeTime(card.recent[0].updated_at, locale) : ""}</span>
      </div>
    </article>
  );
}
```

- [ ] **Step 2: CardGrid — cells + query.**

```ts
  const browseFoldersQ = useQuery({
    queryKey: ["folderChildren", folderFilter],
    queryFn: () => folderChildren(folderFilter ?? ""),
    enabled: folderFilter !== null && !inSearch && (noteView === "grid" || noteView === "list"),
  });
```

(`inSearch` already exists at line 137; place the query after it. Also add `["folderChildren"]` to the `memos:changed` invalidation list at CardGrid.tsx:195-206.)

Cells memo (replaces `items` for grid; keep `items` for timeline/graph):

```ts
  const folderCells: Cell[] = (browseFoldersQ.data ?? []).map((card) => ({ kind: "folder" as const, card }));
  const noteCells: Cell[] = items.map((note) => ({ kind: "note" as const, note }));
  const cells = useMemo(() => [...folderCells, ...noteCells], [browseFoldersQ.data, items]);
  const rowCount = Math.ceil(cells.length / cols);
```

(Delete the old `rowCount = Math.ceil(items.length / cols)` at line 178.)

- [ ] **Step 3: GridView** — accept `cells: Cell[]`; row slice maps `cell.kind === "folder" ? <FolderTile …/> : <Card …/>` with `onOpen={(p) => setFolderFilter(p)}`, `onOpenNote={select}`, `onNewNote={(p) => onNewNote()}` (create in that folder: extend `onNewNote(format?)` call with a folder — simplest: `onNewNote()` creates in current `folderFilter`; the tile's folder IS current-adjacent, so pass `onNewNoteIn` through props: `onNewNoteIn: (folder: string) => void` wired in CardGrid to `createMemo("", folder)` + `select`.) Export `Cell`.

- [ ] **Step 4: ListView folder rows.** ListView gains `folders: FolderCard[]` + `onOpenFolder(path)` props; before note rows render:

```tsx
      {folders.map((f) => (
        <li
          key={f.path}
          data-folder-row={f.path}
          onClick={() => onOpenFolder(f.path)}
          className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-surface-muted"
        >
          <Folder size={13} style={{ color: colorForFolder(f.path, folderDefs) }} />
          <span className="text-sm font-semibold text-text">{f.path.split("/").at(-1)}</span>
          <span className="text-xs text-text-subtle">
            {t.folder_notes.replace("{n}", String(f.note_count_deep))}
            {f.subfolder_count > 0 ? ` · ${t.folder_subfolders.replace("{n}", String(f.subfolder_count))}` : ""}
          </span>
          <span className="ml-auto chev text-text-subtle">›</span>
        </li>
      ))}
```

- [ ] **Step 5: Build + smoke.** Seed: memos in `작업/2026/x`, `작업` empty-of-direct-notes, loose root note; folders set `["작업","작업/2026"]`. Assertions at root: `document.querySelectorAll("[data-folder-tile]").length === 1`, tile shows `1` (deep) and a recent title; click tile → breadcrumb `볼트 › 작업`, tiles now `2026`; list view shows `[data-folder-row]`. Verify virtualization alignment: scroll to bottom with 60 notes — no overlap (`document.querySelector('[style*="height"]')` container height ≥ rows×188).

- [ ] **Step 6: Commit** `feat: folder tiles with content peek in the flat grid cell array`

---

### Task 8 (P1): FolderChipBar for Timeline/Graph + global badge

**Files:**
- Create: `apps/desktop/src/components/FolderChipBar.tsx`
- Modify: `apps/desktop/src/components/views/TimelineView.tsx`, `apps/desktop/src/components/views/GraphView.tsx`, `apps/desktop/src/components/CardGrid.tsx` (pass props)

**Interfaces:**
- Produces: `<FolderChipBar cards={FolderCard[]} onOpen(path) onNewFolder() />` (32px chips, wrap, `＋ 새 폴더` chip). Timeline item folder chip `data-note-folder`. Graph badge `data-global-badge`.

- [ ] **Step 1: FolderChipBar.tsx** — chips per mockup section E: `h-8 rounded-[var(--tag-radius)] border border-line bg-surface-raised px-3 text-[13px]` + Folder icon (colorForFolder) + name + deep count; wrap `flex flex-wrap gap-1.5`; trailing `＋ {t.folder_new}` chip → `onNewFolder()`. `role="list"`, chips `role="listitem"`.

- [ ] **Step 2: TimelineView** — accept `folders: FolderCard[]`, `onOpenFolder`, `onNewFolder`; render `<FolderChipBar>` above the first group. Each item gains the source chip (recursive scope mixes subfolders):

```tsx
{n.folder && (
  <span className="mt-1.5 inline-flex items-center gap-1 font-mono text-[10px] text-text-subtle">
    <i className="size-1.5 rounded-[2px]" style={{ backgroundColor: colorForFolder(n.folder, folderDefs) }} />
    {n.folder}/
  </span>
)}
```

- [ ] **Step 3: GraphView** — accept `folders`, `onOpenFolder`, `onNewFolder`; chip bar above the canvas; badge top-right inside the canvas container:

```tsx
<span data-global-badge className="absolute right-2.5 top-2.5 inline-flex items-center gap-1.5 rounded-[var(--tag-radius)] border border-line-strong bg-surface-muted px-2.5 py-1 text-[11px] text-text-muted" title={t.global_badge_tooltip}>
  <Globe size={11} /> {t.global_badge}
</span>
```

(i18n add `global_badge_tooltip: "이 뷰는 볼트 전체를 보여줍니다" / "This view shows the entire vault"`.)

- [ ] **Step 4: CardGrid wiring** — for `noteView === "timeline" || noteView === "graph"`, pass `folders={browseFoldersQ.data ?? []}` (extend the `folder_children` query `enabled` to these views), `onOpenFolder={setFolderFilter}`, `onNewFolder={() => startFolderCreate()}` — `startFolderCreate` arrives in Task 12; until then pass a no-op is FORBIDDEN: instead wire it to the sidebar-era behavior by creating at current location via `createFolder` + toast (minimal, Task 12 replaces):

```ts
  const startFolderCreate = () => {
    const loc = folderFilter ?? "";
    const def = loc ? `${loc}/${t.folder_new}` : t.folder_new;
    void createFolder(def).then(() => qc.invalidateQueries({ queryKey: ["folderChildren"] }));
  };
```

Also: Timeline in browse mode lists recursive notes — CardGrid must call `listMemos` with `immediate: false` when `noteView` is timeline/graph (folder-scoped recursive): change Task 5's `immediate` arg to `folderFilter !== null && (noteView === "grid" || noteView === "list")`. `noteView` is in the query key already? Add it (the key at line 115 lacks `noteView` — append).

- [ ] **Step 5: Build + smoke.** Timeline: chip bar visible, items show folder chips; Graph: badge present (`[data-global-badge]`), chip bar visible. Commit `feat: folder chip bar for timeline/graph with global badge`.

---

### Task 9 (P1): Sidebar rebuild — curation only

**Files:**
- Modify: `apps/desktop/src/components/Sidebar.tsx` (rewrite), `apps/desktop/src/lib/locales/ko.ts` + `en.ts`

**Interfaces:**
- Consumes: `configQ.data.folders` (`pinned`), `folderChildren("")` for seed fallback, existing `facets`/`stats`.
- Produces: sidebar with smart collections + FOLDERS(pinned, seeded) + TAGS. Drops `buildTree`, `FolderTreeNode`, naming state (Task 12 moves optimistic create to the main area).

- [ ] **Step 1: i18n** — `all_memos` value change: `"모든 노트"` / `"All Notes"` (ko.ts source change; en.ts mirror). Add `folders_pinned_section: "폴더" / "FOLDERS"` (replaces usage of `folders_section` here; keep the old key — Settings still uses it if referenced, else delete with grep proof).

- [ ] **Step 2: Rewrite.** Delete `FolderTreeNode`, `buildTree`, `naming` state, the header `+` button (Sidebar.tsx:296-311) and tree render (312-325). New FOLDERS section:

```tsx
  const pins = folders.filter((f) => f.pinned);
  const explicit = pins.length > 0;
  const seed: FolderEntry[] = explicit ? [] : (foldersQ.data ?? []).filter((f) => f.path !== "" && !f.path.includes("/"));
  const shown = explicit
    ? pins.map((f) => f.path)
    : seed.map((f) => f.path);
```

Render rows: Folder icon (colorForFolder) + name + (explicit only) unpin on right-click via a small `⋯` hover button calling `setFolderPinned(path, false)` then `qc.invalidateQueries({queryKey:["config"]})`. Click → `setView("memos"); setFolderFilter(path); setFavoritesOnly(false);`. Highlight when `folderFilter === path`. Empty section (`shown.length === 0`): hide the header entirely.

Smart collections (existing three buttons at 226-260) stay; their `setFolderFilter(null)` calls now mean query mode — the "모든 노트" button keeps `null`.

- [ ] **Step 3: DnD note** — rows get `data-sidebar-folder={path}` (drop target wiring lands in Task 14).

- [ ] **Step 4: Build + smoke.** Tree gone (`document.querySelector("[data-tree]")` — remove any leftover attr; assert `.size-4` chevrons absent), pin round-trip: fallback `set_folder_pinned` via console `await window.__TAURI_INTERNALS__` not available — use the UI path arriving in Task 12; for now assert seed: with no pins and folders `["작업","작업/2026"]`, sidebar shows only `작업`. Tag click → query mode (`모든 노트`-style label in breadcrumb).

- [ ] **Step 5: Commit** `feat: sidebar as curation surface (smart collections, pinned folders, tags)`

---

### Task 10 (P2): `rename_folder` + inline tile rename

**Files:**
- Modify: `crates/oximemo-core/src/vault.rs` (new `rename_folder`; adjust `set_folder_view`/`set_folder_pinned` untouched), `apps/desktop/src-tauri/src/lib.rs`, `api.ts`, `types.ts` (none), `tauri.ts`
- Modify: `apps/desktop/src/components/CardGrid.tsx` (rename flow state), `FolderTile.tsx` (inline input), `ko.ts`/`en.ts`
- Test: vault.rs inline

**Interfaces:**
- Produces: `Vault::rename_folder(&self, from: &str, to: &str) -> Result<()>`; IPC `rename_folder(from, to)`; api `renameFolder(from, to)`; fallback rekeys store paths + folder set. `FolderTile` props add `namingPath: string | null; onNameCommit(value: string | null): void` (mirrors the sidebar pattern from commit `b5be6ba`).

- [ ] **Step 1: Failing test**:

```rust
    #[test]
    fn rename_folder_moves_files_index_and_config() {
        let (_t, v) = tmp_vault();
        let n = v.create_note("novel", "# Old Home".into(), NoteFormat::Markdown).unwrap();
        v.set_folder_pinned("novel", true).unwrap();
        v.rename_folder("novel", "book").unwrap();
        assert!(!v.paths.vault.join("novel").exists());
        assert!(v.paths.vault.join("book").exists());
        let got = v.get_memo(n.id).unwrap();
        assert!(v.paths.vault.join("book").join(
            got.title.clone().map(|t| format!("{}.md", t.replace(' ', "-"))).unwrap_or_default()
        ).exists() || v.paths.vault.read_dir().unwrap().any(|_| true));
        assert!(v.with_config(|c| c.folders.items.iter().any(|f| f.path == "book" && f.pinned == Some(true))));
        // Target must not already exist.
        v.create_folder("other").unwrap();
        assert!(v.rename_folder("book", "other").is_err());
        let _ = got;
    }
```

(Adjust the file-name assertion to the actual slug rule once you see `write_note` — the invariant under test is "file exists under book/, not under novel/".)

- [ ] **Step 2:** `cargo test -p oximemo-core rename_folder` → FAIL.

- [ ] **Step 3: Implement.**

```rust
    /// Rename/move a folder tree. Disk rename first (atomic, preserves
    /// templates and subfolders), then index records under the old prefix
    /// are rewritten (best-effort; the watcher repairs any stragglers),
    /// then config folder entries are re-pathed.
    pub fn rename_folder(&self, from: &str, to: &str) -> Result<()> {
        if from.is_empty() { return Err(CoreError::other("cannot rename vault root")); }
        if to.is_empty() { return Err(CoreError::other("rename target must not be empty")); }
        let from_dir = self.paths.vault.join(from);
        let to_dir = self.paths.vault.join(to);
        if !from_dir.is_dir() { return Err(CoreError::NotFound(from.to_string())); }
        if to_dir.exists() { return Err(CoreError::other(format!("folder '{to}' already exists"))); }
        if let Some(parent) = to_dir.parent() { std::fs::create_dir_all(parent)?; }
        std::fs::rename(&from_dir, &to_dir)?;

        let prefix = format!("{from}/");
        let recs = self.with_redb(|idx| idx.export_since(None))?;
        let mut index_failures = 0u32;
        for r in recs {
            if !r.path.starts_with(&prefix) { continue; }
            let new_rel = format!("{to}/{}", &r.path[prefix.len()..]);
            match self.files.read_memo(&to_dir.join(&r.path[prefix.len()..])) {
                Ok(Some(note)) => {
                    let fmt = crate::memo::NoteFormat::from_rel(&new_rel);
                    let (sbody, stitle) = search_fields(fmt, &note);
                    let mut rec2 = r.clone();
                    rec2.path = new_rel;
                    if self.with_redb_and_search(|idx, search| {
                        idx.upsert(&rec2)?;
                        search.upsert(note.id, &sbody, stitle.as_deref(), &note.tags)
                    }).is_err() { index_failures += 1; }
                }
                _ => { index_failures += 1; }
            }
        }

        // Re-path config entries under `from/`.
        {
            let mut cfg = self.config.write();
            let fp = format!("{from}/");
            for f in cfg.folders.items.iter_mut() {
                if f.path == from { f.path = to.to_string(); }
                else if f.path.starts_with(&fp) { f.path = format!("{to}/{}", &f.path[fp.len()..]); }
            }
            cfg.save(&self.paths)?;
        }

        if index_failures > 0 {
            return Err(CoreError::other(format!(
                "folder renamed on disk but {index_failures} index entries need reindex"
            )));
        }
        Ok(())
    }
```

(`search_fields`, `record path upsert` mirror `move_note` at vault.rs:862-888. If `read_memo` needs the file at its new path keyed differently, read from `to_dir.join(strip(prefix))` as shown.)

- [ ] **Step 4:** `cargo test --workspace` → PASS.

- [ ] **Step 5: IPC + api + fallback.** Command `rename_folder(state, app, from, to)` → core call + `app.emit("memos:changed", ())`; register. api: `renameFolder(from: string, to: string)`. Fallback:

```ts
    case "rename_folder": {
      const from = args?.from as string;
      const to = args?.to as string;
      if (!from || !to || from === to) throw new Error("invalid rename");
      const store = loadStore();
      for (const n of Object.values(store)) {
        if (n.folder === from) n.folder = to;
        else if (n.folder.startsWith(`${from}/`)) n.folder = `${to}/${n.folder.slice(from.length + 1)}`;
        if (n.folder === to && !n.path.startsWith(`${to}/`)) {
          n.path = `${to}/${n.path.split("/").pop()}`;
        } else if (n.path.startsWith(`${from}/`)) {
          n.path = `${to}/${n.path.slice(from.length + 1)}`;
        }
      }
      saveStore(store);
      saveFolders(loadFolders().map((p) => p === from ? to : p.startsWith(`${from}/`) ? `${to}/${p.slice(from.length + 1)}` : p));
      const views = loadViews();
      if (views[from]) { views[to] = views[from]; delete views[from]; }
      localStorage.setItem(VIEW_KEY, JSON.stringify(views));
      savePins(loadPins().map((p) => p === from ? to : p));
      emitBrowser("memos:changed");
      return null;
    }
```

- [ ] **Step 6: Inline rename UI.** `CardGrid` gains `namingPath: string | null` state + `commitFolderName(value: string | null)` (port of Sidebar's `finishNaming`, but rename via `renameFolder(namingPath, loc + "/" + name)` when changed; cancel/Esc on a just-created folder calls `deleteFolder`). `FolderTile`: when `namingPath === card.path`, header name becomes the selected input (copy the input element from the old `FolderTreeNode` at Sidebar.tsx:110-126, `style={{ boxShadow: "none" }}` included). i18n: `rename_failed_left: "{n}개 노트가 '{from}'에 남아 있습니다" / "{n} notes remain in '{from}'"` surfaced via `setError` on failure.

- [ ] **Step 7: Build + smoke + commit** `feat: rename_folder with inline tile rename`. Fallback smoke: create `작업` (empty via folders set), trigger rename to `업무` (via tile context menu arriving Task 12 — until then call `renameFolder` from console through a temporary dev-only exposure? NO — order tasks so the tile context menu (Task 12) executes before smoke; acceptable: this task's browser smoke covers the IPC via the Task 12 menu in its own smoke; here verify Rust tests + build only, and note the deferral in the commit body).

---

### Task 11 (P2): Trash-based `delete_folder` + `restore_notes` + undo toast

**Files:**
- Modify: `crates/oximemo-core/src/vault.rs:88-96` (`delete_folder`), new `restore_notes`; `apps/desktop/src-tauri/src/lib.rs`; `api.ts`; `tauri.ts`
- Modify: `apps/desktop/src/components/Toast.tsx` (action slot), `CardGrid.tsx` (confirm + undo), `ko.ts`/`en.ts`

**Interfaces:**
- Produces: `Vault::delete_folder(&self, path: &str) -> Result<Vec<MemoId>>` (all live notes trashed, tree removed); `Vault::restore_notes(&self, ids: &[MemoId]) -> Result<Vec<MemoId>>` (restored ids). IPC `delete_folder` returns `Vec<String>`, `restore_notes(ids: Vec<String>) -> Vec<String>`. api: `deleteFolder(path): Promise<string[]>`, `restoreNotes(ids: string[]): Promise<string[]>`. `Toast` props: `action?: { label: string; onClick: () => void }`.

- [ ] **Step 1: Failing test**:

```rust
    #[test]
    fn delete_folder_trashes_then_restores() {
        let (_t, v) = tmp_vault();
        let a = v.create_note("doomed", "one".into(), NoteFormat::Markdown).unwrap();
        let b = v.create_note("doomed", "two".into(), NoteFormat::Markdown).unwrap();
        let ids = v.delete_folder("doomed").unwrap();
        assert_eq!(ids.len(), 2);
        assert!(!v.paths.vault.join("doomed").exists());
        assert!(v.get_memo(a.id).unwrap().deleted_at.is_some());
        let back = v.restore_notes(&[a.id, b.id]).unwrap();
        assert_eq!(back.len(), 2);
        assert!(v.paths.vault.join("doomed").is_dir()); // restore recreates parents
        assert!(v.get_memo(a.id).unwrap().deleted_at.is_none());
    }
```

- [ ] **Step 2:** FAIL → **Step 3: Implement.**

```rust
    /// Delete a folder: every live note goes to trash (structure preserved),
    /// then the remaining tree (templates, empty dirs) is removed. Returns
    /// the trashed ids so the UI can offer undo.
    pub fn delete_folder(&self, path: &str) -> Result<Vec<crate::memo::MemoId>> {
        if path.is_empty() { return Err(CoreError::other("cannot delete vault root")); }
        let prefix = format!("{path}/");
        let recs = self.with_redb(|idx| idx.export_since(None))?;
        let ids: Vec<crate::memo::MemoId> = recs.iter()
            .filter(|r| !r.deleted && r.path.starts_with(&prefix))
            .map(|r| r.id).collect();
        for id in &ids { self.delete_memo(*id)?; }
        let dir = self.paths.vault.join(path);
        if dir.is_dir() { std::fs::remove_dir_all(&dir)?; }
        Ok(ids)
    }

    /// Restore trashed notes (undo for folder delete). Parents are
    /// recreated by `restore_from_trash`.
    pub fn restore_notes(&self, ids: &[crate::memo::MemoId]) -> Result<Vec<crate::memo::MemoId>> {
        let mut ok = Vec::new();
        for id in ids {
            match self.restore_memo(*id) { Ok(_) => ok.push(*id), Err(e) => return Err(e) }
        }
        Ok(ok)
    }
```

- [ ] **Step 4:** `cargo test --workspace` → PASS.

- [ ] **Step 5: IPC + fallback.** `delete_folder` command return type becomes `Result<Vec<String>, String>` (map ids). New `restore_notes(state, app, ids: Vec<String>) -> Result<Vec<String>, String>`; register both. Fallback `delete_folder`: mark matching notes `deleted_at` (keep them in store), drop from folder set, return ids; `restore_notes`: clear `deleted_at` for ids, re-add their folders to the set.

- [ ] **Step 6: Toast action slot + confirm + undo.** `Toast.tsx`: optional `action` rendered as a text button right of the message (`text-hue-blue hover:underline`). `CardGrid` `onDeleteFolder(path, deepCount)`:

```ts
  const onDeleteFolder = (path: string, deep: number) => {
    if (deep > 0 && !window.confirm(t.delete_folder_confirm.replace("{folder}", path.split("/").at(-1) ?? path).replace("{n}", String(deep)))) return;
    void deleteFolder(path)
      .then((ids) => {
        qc.invalidateQueries({ queryKey: ["folderChildren"] });
        qc.invalidateQueries({ queryKey: ["folders"] });
        qc.invalidateQueries({ queryKey: ["config"] });
        const undo = () => {
          void restoreNotes(ids).then(() => {
            if (ids.length === 0) void createFolder(path); // folder had no notes
            qc.invalidateQueries({ queryKey: ["folderChildren"] });
          }).catch((e) => setError(String(e).split("\n")[0]));
        };
        setToast(`→ 🗑 ${path}`, { label: t.undo, onClick: undo });
      })
      .catch((e) => setError(String(e).split("\n")[0]));
  };
```

(`setToast` signature grows an optional action — extend `UIState.toast` to `{ msg: string; action?: { label: string; onClick: () => void } } | null` and update the two existing `setToast` callsites plus `Toast.tsx` consumer.) i18n: `delete_folder_confirm: "'{folder}'와 노트 {n}개를 휴지통으로 보낼까요?" / "Send \"{folder}\" and {n} notes to trash?"`, `undo: "실행 취소" / "Undo"`, `delete_folder_action: "삭제…" / "Delete…"`.

- [ ] **Step 7:** build + fallback smoke (delete folder with 1 note → toast with 실행 취소 → click undo → note back in list). Commit `feat: folder delete trashes contents with undo restore`.

---

### Task 12 (P2): Context menus everywhere + main-area optimistic create

**Files:**
- Create: `apps/desktop/src/components/NoteCtxMenu.tsx` (extracted from `Card.tsx:104-131`)
- Modify: `Card.tsx`, `FolderTile.tsx`, `ListView.tsx`, `TimelineView.tsx`, `CardGrid.tsx`, `SettingsMenu.tsx` (pin toggle), `ko.ts`/`en.ts`

**Interfaces:**
- Produces: `<NoteCtxMenu memo folders folderEntries onToggleFavorite onMoveFolder onCopyBody onDelete />` shared by all three note surfaces. `FolderTile` gains `onRename(path)`, `onTogglePin(path, pinned)`, `onDelete(path, deep)`, `namingPath/onNameCommit` (Task 10). Empty-area menu on the scroller. `startFolderCreate()` optimistic flow in CardGrid (port of Sidebar's `startCreate`/`finishNaming`, target = current browse location).

- [ ] **Step 1: Extract NoteCtxMenu** (verbatim move of the `CtxMenu` block; `Card.tsx` uses it; no behavior change). `bun run build` → green; commit `refactor: extract shared note context menu`.

- [ ] **Step 2: Wire menus.** `ListView`/`TimelineView` rows: wrap each `li` in `CtxRoot`/`CtxTrigger render={<li …/>}` with `<NoteCtxMenu …/>` (props already flow through `viewProps`). Timeline row header gains the favorite star button (copy ListView's). `FolderTile`: `CtxMenu` with `열기` (`t.open_folder`), separator, `이름 변경` (`t.rename_folder` → `onRename`), `사이드바에 고정/고정 해제` (`t.pin_to_sidebar`/`t.unpin_from_sidebar` → `onTogglePin` + invalidate `["config"]`), separator, `삭제…` (`t.delete_folder_action` → `onDelete(path, card.note_count_deep)`).

- [ ] **Step 3: Empty-area menu.** In CardGrid, wrap the scroller content (`<div ref={scrollerCallbackRef} …>`'s inner content div — add a wrapper) with `CtxRoot`/`CtxTrigger`:

```tsx
<CtxMenu>
  <CtxItem icon={FilePlus2} label={t.new_note_md} onClick={() => onNewNote()} />
  <CtxItem icon={CodeXml} label={t.new_note_html} onClick={onNewHtmlNote} />
  {folderFilter !== null && <><CtxSeparator /><CtxItem icon={FolderPlus} label={t.folder_new} onClick={startFolderCreate} /></>}
</CtxMenu>
```

(Query-mode hides 새 폴더 — B3. `FilePlus2`, `CodeXml`, `FolderPlus` from lucide.)

- [ ] **Step 4: Optimistic create in main.** Port Sidebar's `naming/commitRef` (Sidebar.tsx:182-214) into CardGrid as `startFolderCreate()` (create `loc ? \`${loc}/${t.folder_new}\` : t.folder_new` → invalidate `["folderChildren"]` → `setNamingPath(def)`) and `commitFolderName(value)` (Enter/blur → if changed `renameFolder(def, full(name))`; Esc/empty → `deleteFolder(def)`; always invalidate). `FolderTile` renders the naming input when `namingPath === card.path` (Task 10 wiring). Delete the old Sidebar-era flow if any residue remains (Task 9 already removed it). Header `＋` split button unchanged (notes only; folder creation lives in empty-area menu + chip bar `＋` — chip bar's `onNewFolder` now calls `startFolderCreate`).

- [ ] **Step 5: Settings pin toggle.** In `SettingsMenu`'s storage/folder section, each folder row gains a pin icon toggle (`Pin`/`PinOff` lucide) → `setFolderPinned(path, !pinned)` + invalidate `["config"]`.

- [ ] **Step 6: Build + full P2 smoke** (fallback): create folder via empty-area menu (appears with selected name; Esc removes it; typing + Enter renames), tile menu rename, pin → sidebar section updates, delete with notes → confirm → undo. Commit `feat: context menus, optimistic folder create, pin toggles`.

---

### Task 13 (P3): Search scope chip — no mode switch

**Files:**
- Modify: `apps/desktop/src/stores/ui.ts` (`searchScope` from Task 5), `apps/desktop/src/components/CardGrid.tsx:129-155` (search filter), `BreadcrumbBar.tsx` (chip render), `Card.tsx` (query-mode folder chip)

**Interfaces:**
- Consumes: `searchScope` (Task 5).
- Produces: browse-mode search scoped to current location **recursively** by default, `전체` opt-out via chip; query mode unchanged (global). Search results render without folder tiles.

- [ ] **Step 1: Recursive scope filter.** Replace the direct-equality line (CardGrid.tsx:145):

```ts
      if (searchScope === "folder" && folderFilter !== null) {
        const p = folderFilter === "" ? "" : `${folderFilter}/`;
        const inScope = folderFilter === "" ? !n.folder : (n.folder === folderFilter || n.folder.startsWith(p));
        if (!inScope) return false;
      }
```

Add `searchScope` to the `items` memo deps and to the `searching` usage; hide folder cells while searching: `folderCells` become `inSearch ? [] : …` (the `folder_children` query already disables on `!inSearch` from Task 7).

- [ ] **Step 2: Scope chip.** In the header, left of the search input, render when `folderFilter !== null && debounced.length > 0`:

```tsx
<button type="button" onClick={() => setSearchScope(searchScope === "folder" ? "all" : "folder")}
  className="h-7 rounded-[var(--tag-radius)] border border-line bg-surface-raised px-2.5 text-xs text-text-muted hover:border-line-strong"
  title={searchScope === "folder" ? t.scope_this_folder : t.scope_all}>
  {searchScope === "folder" ? t.scope_this_folder : t.scope_all} ▾
</button>
```

Breadcrumb still shows the path (search does not switch modes — B2).

- [ ] **Step 3: Query-mode folder chips on cards.** `Card.tsx`: when a `showFolderChip` prop is true (`folderFilter === null && !search`-style condition passed from GridView), render under the tags row:

```tsx
{showFolderChip && memo.folder && (
  <span className="mt-auto flex items-center gap-1 pt-2 text-[10px] text-text-subtle">
    <i className="size-1.5 rounded-[2px]" style={{ backgroundColor: folderColor }} />
    <span className="truncate">{memo.folder}</span>
  </span>
)}
```

- [ ] **Step 4: Build + smoke.** Browse `작업` → search "x" → results only from `작업/**`; click chip → 전체 → results from everywhere. Commit `feat: folder-scoped search with scope chip (no mode switch)`.

---

### Task 14 (P3): Drag & drop move

**Files:**
- Modify: `apps/desktop/src/stores/ui.ts` (`draggingNote: MemoSummary | null; setDraggingNote`), `Card.tsx`, `ListView.tsx`, `FolderTile.tsx`, `FolderChipBar.tsx`, `BreadcrumbBar.tsx` (segments), `Sidebar.tsx` (pinned rows), `CardGrid.tsx` (autoscroll)

**Interfaces:**
- Consumes: `moveNote` (Task 1), drop rules M16.
- Produces: HTML5 DnD with payload type `application/x-oximemo-notes` (JSON id array); `data-drop-folder` attributes on targets; module-shared `draggingNote` state for hover suppression.

- [ ] **Step 1: Drag sources.** `Card.tsx` article + ListView note rows: `draggable` + `onDragStart={(e) => { setDraggingNote(memo); e.dataTransfer.setData("application/x-oximemo-notes", JSON.stringify([memo.id])); e.dataTransfer.effectAllowed = "move"; }}` and `onDragEnd={() => setDraggingNote(null)}`.

- [ ] **Step 2: Drop targets.** Shared hook (new file `apps/desktop/src/lib/dropTarget.ts`):

```ts
import { useState } from "react";
import { useUI } from "../stores/ui";

/** M16 rules: no-op + no highlight when the dragged note already lives in
 * the target folder. Ancestor drops are allowed. */
export function useFolderDrop(folderPath: string, onDrop: (id: string) => void) {
  const draggingNote = useUI((s) => s.draggingNote);
  const [over, setOver] = useState(false);
  const active = !!draggingNote && draggingNote.folder !== folderPath;
  return {
    "data-drop-folder": folderPath,
    onDragOver: (e: React.DragEvent) => {
      if (!active) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setOver(false);
      const raw = e.dataTransfer.getData("application/x-oximemo-notes");
      try {
        for (const id of JSON.parse(raw) as string[]) onDrop(id);
      } catch { /* not ours */ }
    },
    className: over ? "ring-2 ring-focus-ring ring-offset-1" : undefined,
  };
}
```

Apply to: FolderTile article, ListView folder rows, FolderChipBar chips, BreadcrumbBar segments (each `SegmentButton`), Sidebar pinned rows. `onDrop` → the Task 1 `onMoveFolder(id, path)`.

- [ ] **Step 3: Autoscroll.** On the scroller div (CardGrid.tsx:413): `onDragOver` measuring `e.clientY` against `getBoundingClientRect()`: within 48px of either edge → `requestAnimationFrame` loop `scrollBy({ top: ±12 })` while a `dragScrollRef.current` flag is set; clear on `onDragLeave`/`onDrop`.

- [ ] **Step 4: Build + fallback smoke.** Drag the "ToMove" card onto the `target` tile → toast `→ target`, note gone from list, `b.folder === "target"`; drop onto its own folder tile → no highlight, no-op; drop on breadcrumb `볼트` from a nested folder moves it to root. Commit `feat: drag-and-drop note moves with autoscroll and drop rules`.

---

### Task 15 (P4): ⌘⇧O palette, overflow, ARIA, cross-view regression

**Files:**
- Create: `apps/desktop/src/components/FolderPalette.tsx`
- Modify: `CardGrid.tsx` (hotkey + folder-cell collapse), `BreadcrumbBar.tsx` (ARIA), `FolderTile.tsx` (ARIA pass), `ko.ts`/`en.ts`

**Interfaces:**
- Produces: `FolderPalette` — modal (Base UI Dialog, reuse MemoDetail's dialog patterns) listing `folderEntries`, substring filter input, Enter/click → `setFolderFilter(path)`, `Escape` closes. Hotkey `⌘⇧O` (window keydown, guard when a dialog is open).

- [ ] **Step 1: FolderPalette** — `<input autofocus>` + list (`role="listbox"`, options `role="option"` `aria-selected`), filter = case-insensitive substring on path, highlight match, empty state `t.jump_to_folder`. Wire `⌘⇧O` in CardGrid's key effect: `(e.metaKey||e.ctrlKey) && e.shiftKey && e.key.toLowerCase()==="o"`.

- [ ] **Step 2: Folder overflow collapse** — in CardGrid, when `folderCells.length > 2 * cols - 1`: render `2*cols - 1` folder cells then a tile-sized button `t.show_all_folders.replace("{n}", …)` toggling session state `showAllFolders` (per-location `Map` in component state, not the store).

- [ ] **Step 3: ARIA pass** — BreadcrumbBar: `aria-current="page"` on the last segment; dropdown buttons `aria-haspopup="listbox"`. FolderTile: `aria-label` = full path + count; recent-title buttons are real buttons (already). ChipBar `role="list"`. Verify focus rings visible (`:focus-visible` classes).

- [ ] **Step 4: Cross-view × mode regression (fallback).** Seed rich state (3 folders incl. nested, 8 notes incl. favorites/tags, pins). Walk the matrix: {Grid, List, Timeline, Graph} × {root browse, nested browse, 모든 노트, favorites, tag, search folder-scoped, search global}: no console errors, breadcrumb correct, folder affordances per matrix, moves/renames/deletes+undo work from every surface. Update the spec's acceptance list outcomes in the commit message.

- [ ] **Step 5:** `cargo test --workspace && bun run build` → commit `feat: folder jump palette, overflow collapse, a11y pass`.

---

## Self-Review (done)

- **Spec coverage:** B1→T1, immediate→T2, folder_children/M11→T3, pinned/H9→T4+T9, browse default/keys→T5, breadcrumb/H7/M12/M13→T6, tiles/H5/H6→T7, chip bar/H11→T8, sidebar/H10-3→T9, rename/M17→T10, delete+undo/B4→T11, menus/M20/B3→T12, search/B2→T13, DnD/M15/M16→T14, palette/overflow/ARIA/H10-2→T15. B3 covered (query mode hides 새 폴더, T12 Step 3). M14 (keyboard context menu) — verified during T12 Step 2: if Base UI lacks `Shift+F10` support, add the `⋯` overflow button on Card/FolderTile (decide in-task; both paths specified here).
- **Placeholder scan:** the two sketch-level spots (BreadcrumbBar collapse JSX, Task 10 slug assertion) carry explicit resolution instructions rather than TODOs.
- **Type consistency:** `FolderCard` fields identical across Rust/TS; `Cell` exported once (GridView) and consumed in CardGrid; `setToast` action signature changed once (T11) with callsites enumerated.
