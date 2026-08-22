# Remaining Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the six remaining interaction features: sidebar pin management + reordering, vault-wide tag rename, external file-drop import, editor image menu, graph node menu.

**Architecture:** Two new core commands (`set_pin_order`, `rename_tag`) + IPC/browser-fallback wiring; one new `PointMenu` component for React-external surfaces (CM6 images); Base UI menus for React-owned surfaces (pin rows, tag chips, graph SVG nodes); file-drop import on the CardGrid scroll area.

**Tech Stack:** Rust (oximemo-core), Tauri v2 IPC, React 19 + Base UI, CM6.

## Global Constraints

- Repo `/Volumes/MERCURY/PROJECTS/oximemo`; frontend `apps/desktop`, core `crates/oximemo-core`, IPC `apps/desktop/src-tauri/src/lib.rs`, browser fallback `apps/desktop/src/lib/tauri.ts`.
- Tag token model MUST mirror `crates/oximemo-core/src/tags.rs` / `apps/desktop/src/lib/tags.ts` (`#` not preceded by word char; token = word-char run; NFC+lowercase normalization).
- Verification per task: `cargo test -p oximemo-core` (Rust), `cd apps/desktop && set -o pipefail && npx tsc -b` (TS), browser smoke on `vite --port 5199`.
- i18n keys to BOTH `ko.ts`/`en.ts`. Commits conventional. No placeholders.

---

### Task 1: Core commands — `set_pin_order` + `rename_tag`

**Files:**
- Modify: `crates/oximemo-core/src/vault.rs` (near `set_folder_pinned`, line ~1485)
- Test: `crates/oximemo-core/src/vault.rs` tests module (find `set_folder_pinned_roundtrip` at line 3155 for the fixture pattern)

**Interfaces:**
- Produces: `Vault::set_pin_order(&self, order: &[String]) -> Result<()>`; `Vault::rename_tag(&self, old: &str, new: &str) -> Result<u64>` (changed-note count).

- [ ] **Step 1: Implement `set_pin_order`**

```rust
/// Reorder pinned folder entries in `oximemo.toml`. `order` must be a
/// permutation of the currently pinned paths — anything else is an
/// error (the frontend only ever sends drag results). Unpinned entries
/// keep their relative order; pinned entries are appended in `order`
/// (items order is only consumed as pin order — `list_folders` sorts).
pub fn set_pin_order(&self, order: &[String]) -> Result<()> {
    let mut cfg = self.config.write();
    let mut pinned: Vec<String> = cfg
        .folders
        .items
        .iter()
        .filter(|f| f.pinned == Some(true))
        .map(|f| f.path.clone())
        .collect();
    pinned.sort();
    let mut want = order.to_vec();
    want.sort();
    if pinned != want {
        return Err(CoreError::other("pin order must be a permutation of pinned folders"));
    }
    let by_path: std::collections::HashMap<String, FolderDef> = cfg
        .folders
        .items
        .iter()
        .map(|f| (f.path.clone(), f.clone()))
        .collect();
    let mut items: Vec<FolderDef> = cfg
        .folders
        .items
        .iter()
        .filter(|f| f.pinned != Some(true))
        .cloned()
        .collect();
    for p in order {
        if let Some(f) = by_path.get(p) {
            items.push(f.clone());
        }
    }
    cfg.folders.items = items;
    cfg.save(&self.paths)?;
    Ok(())
}
```

- [ ] **Step 2: Implement `rename_tag`**

```rust
/// Vault-wide `#old` → `#new` rename across live note bodies. Token
/// boundaries follow `tags::extract_tags` (word-char runs, NFC+casefold
/// comparison). Renaming onto an existing tag merges them (tags are
/// body-derived). Returns the count of rewritten notes.
pub fn rename_tag(&self, old: &str, new: &str) -> Result<u64> {
    let old_norm = old.nfc().collect::<String>().to_lowercase();
    let new_norm = new.nfc().collect::<String>().to_lowercase();
    if new_norm.is_empty() {
        return Err(CoreError::other("new tag must not be empty"));
    }
    if old_norm == new_norm {
        return Ok(0);
    }
    let old_id: String = format!("#{old_norm}");
    let new_id: String = format!("#{new_norm}");
    let recs = self.with_redb(|idx| idx.export_since(None))?;
    let mut changed: u64 = 0;
    for r in recs.iter().filter(|r| !r.deleted) {
        let memo = self.get_memo(r.id)?;
        let body = match &memo.body { Some(b) => b, None => continue };
        let rewritten = rewrite_tag(&body, &old_norm, &new_id);
        if rewritten != *body {
            self.update_memo(r.id, Some(rewritten), None)?;
            changed += 1;
        }
    }
    Ok(changed)
}
```

With a free helper next to it (mirrors the scanner in `tags.rs`):

```rust
/// Replace every `#token` whose normalized form equals `old_norm` with
/// `new_id` (e.g. `#newtag`). Char-scanned like `tags::extract_tags`.
fn rewrite_tag(body: &str, old_norm: &str, new_id: &str) -> String {
    let chars: Vec<char> = body.chars().collect();
    let is_word = |c: char| c.is_alphanumeric() || c == '_';
    let mut out = String::with_capacity(body.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '#' && (i == 0 || !is_word(chars[i - 1])) {
            let start = i + 1;
            let mut j = start;
            while j < chars.len() && is_word(chars[j]) {
                j += 1;
            }
            if j > start {
                let norm: String = chars[start..j]
                    .iter()
                    .collect::<String>()
                    .nfc()
                    .collect::<String>()
                    .to_lowercase();
                if norm == old_norm {
                    out.push_str(new_id);
                    i = j;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}
```

(Adjust to the file's real imports: `unicode_normalization::UnicodeNormalization` is already used in `tags.rs`; `FolderDef`/`CoreError` are in scope per `set_folder_pinned`. If `get_memo`'s body field differs — verify against the actual `Memo` type while implementing; the roundtrip test will catch drift.)

- [ ] **Step 3: Roundtrip tests** (mirror `set_folder_pinned_roundtrip`'s temp-vault fixture)

```rust
#[test]
fn set_pin_order_roundtrip() {
    // fixture: pin a, b, c → order [c, a, b] → config pinned tail == [c, a, b];
    // unpinned entry inserted between pins keeps preceding unpinned block order;
    // non-permutation order errors.
}

#[test]
fn rename_tag_rewrites_bodies() {
    // bodies: "#악보 첫줄", "C#m7 무관", "#Tag 대소문자", "#tag 중복" (same norm),
    // "#악보/#보고 같은줄" → old=악보 new=보고 merges → assert bodies, count,
    // and old==new → 0, empty new → error.
}
```

- [ ] **Step 4: Run + commit**

```bash
cargo test -p oximemo-core 2>&1 | tail -5
git add -A && git commit -m "feat(core): set_pin_order + rename_tag"
```

---

### Task 2: IPC + api.ts + browser fallback

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs` (commands near `set_folder_pinned`, line ~829; register in `generate_handler!` near line 230)
- Modify: `apps/desktop/src/lib/api.ts`
- Modify: `apps/desktop/src/lib/tauri.ts` (`browserFallback` switch)

**Interfaces:**
- Produces: `setPinOrder(order: string[]): Promise<void>`; `renameTag(old: string, new: string): Promise<number>`.

- [ ] **Step 1: lib.rs commands**

```rust
    #[tauri::command]
    pub fn set_pin_order(state: State<'_, AppState>, app: AppHandle, order: Vec<String>) -> Result<(), String> {
        state.vault.set_pin_order(&order).map_err(|e| e.to_string())?;
        let _ = app.emit("config:changed", ());
        Ok(())
    }

    #[tauri::command]
    pub fn rename_tag(state: State<'_, AppState>, app: AppHandle, old: String, new: String) -> Result<u64, String> {
        let n = state.vault.rename_tag(&old, &new).map_err(|e| e.to_string())?;
        let _ = app.emit("memos:changed", ());
        Ok(n)
    }
```

Register both in `generate_handler![...]` (`commands::set_pin_order, commands::rename_tag` — follow the existing module path style used by `set_folder_pinned`).

- [ ] **Step 2: api.ts**

```ts
export async function setPinOrder(order: string[]): Promise<void> {
  return invoke("set_pin_order", { order });
}

export async function renameTag(old: string, new: string): Promise<number> {
  return invoke<number>("rename_tag", { old, new });
}
```

- [ ] **Step 3: tauri.ts browser fallback cases**

```ts
    case "set_pin_order": {
      const order = (args?.order ?? []) as string[];
      const pins = loadPins().filter((p) => order.includes(p));
      const rest = order.filter((p) => !pins.includes(p));
      savePins([...pins, ...rest]);
      return null;
    }
    case "rename_tag": {
      const oldTag = String(args?.old ?? "").normalize("NFC").toLowerCase();
      const newTag = String(args?.new ?? "");
      if (!newTag.trim()) throw new Error("new tag must not be empty");
      const store = loadStore();
      let changed = 0;
      for (const n of Object.values(store)) {
        if (n.deleted_at) continue;
        // Same scanner as extractTags: replace #old tokens with #new.
        const chars = [...n.body];
        const WORD = /[\p{L}\p{N}_]/u;
        let out = "", i = 0;
        while (i < chars.length) {
          if (chars[i] === "#" && (i === 0 || !WORD.test(chars[i - 1]))) {
            let j = i + 1;
            while (j < chars.length && WORD.test(chars[j])) j += 1;
            const norm = chars.slice(i + 1, j).join("").normalize("NFC").toLowerCase();
            if (norm === oldTag && j > i + 1) {
              out += "#" + newTag;
              changed += 1;
              i = j;
              continue;
            }
          }
          out += chars[i];
          i += 1;
        }
        if (out !== n.body) {
          n.body = out;
          n.tags = extractTags(out);
          n.updated_at = new Date().toISOString();
        }
      }
      if (changed > 0) persistStore(store);
      emitBrowser("memos:changed");
      return changed;
    }
```

(`changed` counts replacements per note in the fallback — close enough for the toast; the Rust count is per-note. Match the store's real save helper names while implementing — `loadStore`/`persistStore` or equivalent.)

- [ ] **Step 4: Verify + commit**

```bash
cd apps/desktop && set -o pipefail && npx tsc -b && echo TSC_OK
git add -A && git commit -m "feat(desktop): IPC + browser fallback for set_pin_order/rename_tag"
```

---

### Task 3: PointMenu + i18n keys

**Files:**
- Create: `apps/desktop/src/components/PointMenu.tsx`
- Modify: `apps/desktop/src/lib/locales/ko.ts`, `en.ts`

**Interfaces:**
- Produces: `PointMenu({ x, y, onClose, children })` — fixed popup; children = `PointItem` rows sharing `CtxItem`'s props (icon/label/danger/onClick; auto-close on click).

- [ ] **Step 1: i18n keys** — ko/en pairs:

`pin_rename` 이미 존재(`rename_folder`) 재활용; 추가: `tag_rename: "태그 이름 바꾸기"`/`"Rename Tag"`, `tag_renamed_toast: "{n}개 노트 업데이트"`/`"{n} notes updated"`, `import_toast: "{n}개 노트 가져옴"`/`"Imported {n} notes"`, `img_delete: "이미지 삭제"`/`"Delete Image"`, `img_reset_width: "너비 초기화"`/`"Reset Width"`, `img_copy_url: "URL 복사"`/`"Copy URL"`, `node_open: "노트 열기"`/`"Open Note"`(없으면 `link_open_note` 재활용), `node_delete`(없으면 `action_delete` 재활용).

- [ ] **Step 2: PointMenu**

```tsx
/** Fixed-position popup for React-external right-clicks (CM6 images).
 *  Same visual vocabulary as CtxMenu (POPUP_CLS); closes on outside
 *  pointerdown, Escape, scroll, or item click. */
export function PointMenu({ x, y, onClose, children }: {
  x: number; y: number; onClose: () => void; children: ReactNode;
}) {
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest("[data-point-menu]")) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);
  return (
    <div data-point-menu className="fixed z-[70] min-w-44 rounded-lg border border-line bg-surface-raised p-1 text-sm text-text shadow-lg"
      style={{ left: Math.min(x, window.innerWidth - 200), top: Math.min(y, window.innerHeight - 160) }}>
      {children}
    </div>
  );
}

export function PointItem({ icon: Icon, label, danger, onClick }: { ... }) {
  // Same row styling as ContextMenu.CtxItem's inner markup.
}
```

- [ ] **Step 3: Verify + commit** — `tsc -b`; `git commit -m "feat(desktop): PointMenu positioned popup + i18n"`

---

### Task 4: Sidebar pin row management + reorder

**Files:**
- Modify: `apps/desktop/src/components/Sidebar.tsx` (`SidebarFolderRow`, pins map, `Sidebar` state)

**Interfaces:**
- Consumes: `renameFolder(from, to)` (to = full new path), `deleteFolder(path)`, `folderChildren(path)`, `setPinOrder`, `TextCtxMenu`, existing `FolderMenu` armed-delete pattern.

- [ ] **Step 1: Naming session + handlers in `Sidebar`**

State `pinNaming: { path: string } | null`. Commit: `to = parentOf(path) ? parentOf(path) + "/" + name : name` (import `parentOf` from `../lib/dropTarget`), guard empty/same-name, `renameFolder(path, to)` → invalidate `["memos"]`/`["config"]`/`["folderChildren"]`. Delete: `deleteFolder(path)` → same invalidation.

- [ ] **Step 2: Row upgrade**

`SidebarFolderRow` props grow: `naming: boolean`, `onRename: (path) => void`, `onNameCommit: (path: string | null) => void`, `onDelete: (path: string) => void`. The row container becomes the context trigger (CtxRoot + CtxTrigger render merging onto the row div — keep useFolderDrop spread); the ⋯ button keeps left-click=unpin. Menu: 열기 / 이름 바꾸기 / 고정 해제 / 삭제…(armed, wording via folderChildren count: `useQuery({ queryKey: ["folderChildren", path], queryFn: () => folderChildren(path), staleTime: 30_000 })` — the count = sum of FolderCard.note_count? use `note_count` of the folder itself from facets `folderMap` if FolderCard lacks totals — verify field while implementing; the confirm tooltip uses it). While `naming`, label swaps to a TextCtxMenu-wrapped input (Enter=commit, Esc=cancel, blur=commit — same as tiles).

- [ ] **Step 3: Reorder handle**

In the row (before the ⋯ button), a `GripVertical` button (visible on hover, `draggable`): `onDragStart` → `setDraggingFolder(null)`, `e.dataTransfer.setData("application/x-oximemo-pin", path)`. The row's drop handler (inside `useFolderDrop` consumer) additionally handles the pin payload BEFORE note/folder logic: on dragover, if types include `x-oximemo-pin` and source ≠ row → preventDefault + half-split highlight class (`before:` ring-top / ring-bottom — use two classes by midpoint); on drop → compute new order array (move dragged before/after target) → `setPinOrder` → invalidate `["config"]`. Guard self-drops.

- [ ] **Step 4: Verify + commit** — `tsc -b`; browser smoke (rename inline, delete confirm, drag ⠿→ order change); `git commit -m "feat(desktop): sidebar pin row management + drag reorder"`

---

### Task 5: Tag rename UI

**Files:**
- Modify: `apps/desktop/src/components/Sidebar.tsx` (tag chip block)

- [ ] **Step 1:** State `tagNaming: string | null` (the tag being renamed). Chip menu gains **태그 이름 바꾸기** (PenLine icon) → `setTagNaming(tag)`. The chip renders a TextCtxMenu-wrapped input seeded with the tag (no `#`) while renaming; Enter → `renameTag(tag, value)` → invalidate `["memos"]`/`["facets"]` → toast `t.tag_renamed_toast.replace("{n}", String(n))` (`useUI((s) => s.setToast)`); Esc cancels.

- [ ] **Step 2: Verify + commit** — browser smoke (rename `#악보`→`#보고`, facets show 보고); `git commit -m "feat(desktop): vault-wide tag rename UI"`

---

### Task 6: External file drop import

**Files:**
- Modify: `apps/desktop/src/components/CardGrid.tsx` (main scroll container)

- [ ] **Step 1:** On the main scroll div: `onDragOver` — if `e.dataTransfer.types.includes("Files")` → `preventDefault(); setFileOver(true)`. `onDragLeave`/`onDrop` → clear. `onDrop`: for each `f of e.dataTransfer.files` with name matching `\.(md|markdown|txt)$/i` → `const body = await f.text(); await createMemo(body, folderFilter !== null && !favoritesOnly ? folderFilter : "")` (browse target only when actually browsing; query mode imports to root) → toast `t.import_toast`. Ring class on file drag (`ring-2 ring-focus-ring`), matching `dropCls` vocabulary.

- [ ] **Step 2: Verify + commit** — browser smoke (synthetic File drop via DataTransfer.items.add(new File(...)), note appears in current folder); `git commit -m "feat(desktop): drop .md/.txt files to import notes"`

---

### Task 7: Editor inline-image menu

**Files:**
- Modify: `apps/desktop/src/lib/cm6Images.ts` (domEventHandlers + contextmenu)
- Modify: `apps/desktop/src/components/MarkdownEditor.tsx`

- [ ] **Step 1: cm6Images contextmenu bridge**

```ts
      contextmenu(e) {
        const img = e.target instanceof HTMLImageElement ? e.target : null;
        const name = img?.dataset.oxName;
        if (!img || !name) return false;
        e.preventDefault();
        e.stopPropagation();
        window.dispatchEvent(
          new CustomEvent("oximemo:image-menu", { detail: { name, x: e.clientX, y: e.clientY } }),
        );
        return true;
      },
```

(The image processor already sets `img.dataset.oxDone`/title — add `img.dataset.oxName = name` in `process()` if absent.)

- [ ] **Step 2: MarkdownEditor PointMenu**

State `{ name, x, y } | null`; `useEffect` listens for the CustomEvent; render `<PointMenu x y onClose>` with items: 이미지 삭제 (remove the markdown line whose oximg URL contains the content hash of `name` — regex `/^.*oximg:\/\/localhost\/${escaped name}.*\n?/gm` replace ""), 너비 초기화 (strip `#w=\d+` on that URL via `commitWidth(view, name, 0)` — width<=0 strips per its doc), URL 복사 (`navigator.clipboard.writeText("oximg://localhost/" + name)`).

- [ ] **Step 3: Verify + commit** — `tsc -b` + build (CM6 surface: build + code-path; desktop data needed for real images); `git commit -m "feat(desktop): editor inline-image context menu"`

---

### Task 8: Graph node menu

**Files:**
- Modify: `apps/desktop/src/components/views/GraphView.tsx`
- Modify: `apps/desktop/src/components/CardGrid.tsx` (pass handlers)

- [ ] **Step 1:** `GraphView` props grow `onToggleFavorite: (id: string, fav: boolean) => void`, `onDelete: (id: string) => void`. Node `<g>` becomes CtxRoot/CtxTrigger render target; menu: 노트 열기 (select), 즐겨찾기 토글 (Star icon; `items.find(i => i.id === n.id)?.favorite`), 삭제 (danger). CardGrid threads the same handlers it passes to GridView/TimelineView.

- [ ] **Step 2: Verify + commit** — `tsc -b` + build; `git commit -m "feat(desktop): graph node context menu"`

---

### Task 9: End-to-end verify + changelog

- [ ] `cargo test -p oximemo-core` full suite; `tsc -b`; `vite build`.
- [ ] Browser smoke: pin rename/delete, ⠿ reorder (fallback store order), tag rename (bodies+facets), file drop import, existing regressions (favorites view, folder picker, note menu).
- [ ] CHANGELOG entry under `[Unreleased]`; commit `docs: changelog for remaining features`.
