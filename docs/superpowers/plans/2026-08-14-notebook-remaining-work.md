# Handoff — Notebook Transform: Remaining Work (COMPLETED)

> **Date:** 2026-08-14
> **Branch:** `feat/notebook-transform`
> **Last commit:** `8bb535b` — `feat: backlinks panel, rename propagation, migration search-index fix`
> **Predecessor:** `docs/superpowers/plans/2026-08-13-memo-to-notebook-handoff.md`

---

## 0. Current State — ALL ITEMS DONE

All previously-listed remaining work (§1.1 Backlinks Panel, §1.2 Rename
Propagation, §1.3 Migration Test) is complete as of `8bb535b`.

**What shipped in `8bb535b`:**
- `vault.get_backlinks(id) -> Vec<BacklinkInfo>` + Tauri command +
  `getBacklinks()` API + `BacklinksPanel.tsx` wired into `MemoDetail.tsx`
  (collapsible, click-to-navigate, locale-aware empty state)
- Rename propagation in `update_note`: H1 change rewrites `[[old]]` →
  `[[new]]` across all linking notes; batch file + index + search update
  in one locked pass. Search titles use each backlinking note's own
  `derive_title(&n.body)` (regression-tested)
- Migration fix: `migrate_vault` clears the stale tantivy search index
  (v2/v3 fast-field schema mismatch caused a reindex panic)
- CHANGELOG L23: `wiki::backlinks` → `wiki::links_to` (function renamed)

**Verification performed:**
- 91 core + 11 CLI tests pass (new: `get_backlinks_finds_linking_notes`,
  `rename_propagation_rewrites_links` with search-title regression guard)
- `cargo clippy --all-targets -- -D warnings` clean across all crates
- Frontend builds green (`bun run build`)
- Runtime: browser-verified all 4 view modes, no errors
- Real v2 vault (20 memos) migrated: 20 files moved, 5 folders created,
  0 errors; reindex succeeds after index clear; CLI `list` reads the
  migrated vault correctly

## 1. Previously Remaining Features — ALL COMPLETED in `8bb535b`

### 1.1 Backlinks Panel — DONE

**Spec:** §4.3, §7.2

**What exists:**
- `wiki::extract_links()` parses `[[...]]` from bodies ✓
- `wiki::links_to()` checks if a body links to a target ✓
- `graph_data()` already builds the forward link graph (edges) ✓
- No `get_backlinks` Tauri command
- No `BacklinksPanel.tsx` component
- `MemoDetail.tsx` has no backlinks section

**What to build:**
1. Add `vault.get_backlinks(id) -> Vec<BacklinkInfo>` — scan all live
   notes, find those whose body contains `[[<target_title>]]`.
2. Add Tauri command `get_backlinks(id: String)`.
3. Create `BacklinksPanel.tsx` — query `get_backlinks(noteId)`, list
   linking notes (title + preview), click navigates. Collapsible.
4. Wire into `MemoDetail.tsx` below the editor.

**Effort:** Medium. ~2h. The graph view already visualizes backlinks
visually; this adds a text panel in the detail view.

### 1.2 Rename Propagation — DONE (auto-propagate on save, Obsidian-style)

**Spec:** §4.4

**What exists:**
- `wiki::replace_link_target(body, old, new)` ✓ (tested pure function)
- `vault.update_note()` already renames the file when H1 changes ✓
- Link body rewriting across OTHER notes is NOT wired
- No dedicated `rename_note` Tauri command (rename happens via
  `update_note` when body H1 changes, but doesn't propagate to other notes)

**What to build:**
1. After `update_note` detects a title change, scan all notes for
   `[[old_title]]` and rewrite to `[[new_title]]` using
   `wiki::replace_link_target`.
2. Save affected notes + update their index records.
3. Rebuild graph data cache (or invalidate).

**Effort:** Medium. ~2h. The hard part is deciding UX: auto-propagate
on save (Obsidian-style, may be slow for large vaults) vs. explicit
"Rename" action.

### 1.3 Migration Test on Real v2 Vault — DONE (backup kept at /tmp/oximemo-vault-backup)

**Spec:** §11

The migration code exists (`migrate.rs`) and has unit tests, but has
never been tested on a real v2 vault with actual data.

**How to test:**
1. Locate the user's real vault (check `~/.oximemo` or `OXIMEMO_VAULT`).
2. **Back it up** (`cp -r vault vault.bak`).
3. Run `oximemo migrate --dry-run` → verify the planned changes look
   correct.
4. Run `oximemo migrate` → verify files moved to
   `<folder>/<title>.md`, frontmatter stripped, `memos/` tree cleaned.
5. Launch the app → verify all notes appear, search works, indexes
   rebuilt.

**Effort:** Low. ~30min. Risk: data loss if migration has a bug.
Always test with `--dry-run` first and keep the backup.

---

## 2. Known Limitations

- **Graph view in browser mode:** the browser fallback returns empty
  edges (no bodies to parse). Only works in the Tauri desktop app.
- **View lock in browser mode:** `set_folder_view` browser fallback is
  a no-op. Lock state doesn't persist outside Tauri.
- **External editing:** the watcher detects file changes and reindexes,
  but this hasn't been tested with the new folder layout at runtime.
- **Dark mode:** the 4 view components use semantic tokens, but dark-mode
  rendering hasn't been visually verified for list/timeline/graph.

---

## 3. Key Files for Each Feature

```
Feature             Files to touch
─────────────────── ──────────────────────────────────────────────
Backlinks panel     crates/oximemo-core/src/vault.rs (add get_backlinks)
                    apps/desktop/src-tauri/src/lib.rs (add command)
                    apps/desktop/src/lib/api.ts (add getBacklinks)
                    apps/desktop/src/components/BacklinksPanel.tsx (new)
                    apps/desktop/src/components/MemoDetail.tsx (wire panel)

Rename propagation  crates/oximemo-core/src/vault.rs (add link rewrite
                      loop to update_note, or new rename_note method)
                    apps/desktop/src-tauri/src/lib.rs (if new command)

Migration test      Run: oximemo migrate --dry-run / oximemo migrate
                    Verify: file layout, frontmatter, search, index
```

---

## 4. Git History

```
8bb535b feat: backlinks panel, rename propagation, migration search-index fix
91e7537 docs: remaining-work handoff + CHANGELOG move_note entry
9004e9a fix(core): implement missing graph_data, get_config, set_folder_view, move_note commands
5c440bc docs: record memo-to-notebook transformation
90f8608 feat(frontend): folder-based UI with 4 view modes
044aed2 fix(desktop): update Tauri commands for folder-based model
78d75e8 feat(core): wire templates into note creation, migrate CLI command
ee76e8b feat(core): add wiki links, templates, and migration modules
ba95c6d feat(core): add title field to search index, update all callers
47afbaa refactor(core): remove category system, add folder-based notebook model
```

End of handoff. All items complete as of `8bb535b`. Only known limitations
(§2) remain — browser-mode fallbacks and untested-at-runtime dark mode /
external-editing watcher, none blocking.
