# Handoff — Memo → Notebook Transformation

> **Status:** Ready for implementation. Spec approved, plan written. Next session executes.
> **Date:** 2026-08-13
> **Branch:** `main` (create `feat/notebook-transform` before starting)
> **Last commit:** `38b0dcc` — `docs: memo-to-notebook transformation design spec`

---

## 1. What This Project Is

oximemo is a macOS note-taking app (Tauri 2 + React 19 + Rust core). Currently it's a flat "quick capture memo" app: all notes are UUID-named `.md` files in `memos/YYYY/MM/`, organized by a `category` field in frontmatter.

**We're transforming it into a physical-folder markdown notebook:**

- Files live in **real folders** (`novel/act1/chapter-1.md`, `diary/2026-08-13.md`)
- **File name = title** (derived from `# H1` heading, or timestamp for untitled memos)
- **Frontmatter simplified** (no `category`, `folder`, `deleted_at` — location and filename are the truth)
- **Wiki links** `[[Note Title]]` connect notes (title-based, not UUID)
- **Templates** via per-folder `TEMPLATE.md` with variables (`{{date}}`, `{{counter}}`)
- **4 view modes**: Grid, List, Timeline, Graph
- **Markdown is the source of truth**; redb/tantivy indexes are rebuildable caches

---

## 2. Documents to Read First (in order)

| Order | Document | What it gives you |
|-------|----------|-------------------|
| 1 | **This file** | Project context, current state, how to start |
| 2 | `docs/superpowers/specs/2026-08-13-memo-to-notebook-design.md` | Full design spec (561 lines). Every decision, rationale, edge cases |
| 3 | `docs/superpowers/plans/2026-08-13-memo-to-notebook.md` | Task-by-task implementation plan (8 phases, ~25 tasks) |
| 4 | `doc/DESIGN.md` §5 | Current storage architecture (what we're changing FROM) |
| 5 | `CONTRIBUTING.md` | Build/test commands, conventions |

**Do not start coding until you've read items 1-3.**

---

## 3. Current State

### What exists

- oximemo v0.9.2 with working: capture, categories, tags, search, favorites, markdown editor, sync, in-app updater
- `Memo` struct with: `id` (UUIDv7), `category`, `tags`, `body`, `favorite`, `deleted_at`
- Storage: `memos/<YYYY>/<MM>/<uuid>.md` with TOML frontmatter (`+++` delimited)
- redb metadata index + tantivy full-text search
- Wiki links **implemented but UUID-based** (`[[memo-id]]`) — needs conversion to title-based
- `@atomic-editor/editor` (CM6) with `wikiLinks()` extension already integrated
- Cross-process file lock, file watcher, sync manifest

### What the design spec replaces

| Current | New |
|---------|-----|
| `memos/YYYY/MM/<uuid>.md` | `<folder>/<title-slug>.md` (physical folders) |
| `category` frontmatter field | File's physical folder location |
| `deleted_at` frontmatter field | Move to `.trash/<original-path>` |
| UUID filename | Title-derived filename (H1 slug or timestamp) |
| `[[uuid]]` wiki links | `[[Note Title]]` title-based links |
| Flat category sidebar | Recursive folder tree |
| CardGrid only | Grid / List / Timeline / Graph (per-folder, lockable) |
| No templates | Per-folder `TEMPLATE.md` with variables |

### Git state

```
main branch, clean working tree
Last commit: 38b0dcc (design spec)
No implementation started yet.
```

---

## 4. How to Execute

### Execution method

Use **superpowers:subagent-driven-development** (recommended) or **superpowers:executing-plans**.

The plan at `docs/superpowers/plans/2026-08-13-memo-to-notebook.md` has checkboxes (`- [ ]`) for each step. Work through phases in order.

### Before starting

```bash
# Create feature branch
git checkout -b feat/notebook-transform

# Verify clean build
cargo fmt --all -- --check
cargo clippy -p oximemo-core -p oximemo-cli -p oximemo-capture --all-targets -- -D warnings
cargo test -p oximemo-core -p oximemo-cli -p oximemo-capture
cd apps/desktop && bun run build
```

### CI gates (run before EVERY commit)

```bash
cargo fmt --all -- --check
cargo clippy -p oximemo-core -p oximemo-cli -p oximemo-capture --all-targets -- -D warnings
cargo test -p oximemo-core -p oximemo-cli -p oximemo-capture
cd apps/desktop && bun run build
```

---

## 5. Suggested Starting Point

### Phase 1, Task 1.1 is the first task.

It's the foundation: update the `Memo` struct, remove `category`, add `derive_title()`, `slugify()`, `timestamp_filename()`.

**Read these files before touching code:**

| File | Why |
|------|-----|
| `crates/oximemo-core/src/memo.rs` | The `Memo` struct, `MemoFilter`, `MemoSummary` — what you're modifying |
| `crates/oximemo-core/src/store/files.rs:22-54` | `Frontmatter` struct — how frontmatter maps to `Memo` |
| `crates/oximemo-core/src/config.rs:90-102` | `AUTO_COLORS`, category system — what's being replaced |
| `crates/oximemo-core/src/paths.rs:1-30` | Filesystem layout — what's changing |

**Warning:** Task 1.1 will cause widespread compile errors because `category` is referenced throughout `vault.rs`, `index.rs`, `search.rs`, CLI, and Tauri commands. This is expected. Strategy:
1. Make the struct changes in `memo.rs`.
2. Add the new utility functions.
3. Run `cargo check -p oximemo-core` — expect errors everywhere `category` is used.
4. Stub/comment out broken references temporarily.
5. Fix them properly in Tasks 1.2-1.5 and Phase 2.

**Alternative:** If the cascade is too large for one commit, consider keeping `category` as a deprecated field during Phase 1 and removing it at the end. But the spec says clean cutover — every caller migrated.

---

## 6. Phase Map

| Phase | Scope | Tasks | Est. difficulty | Dependencies |
|-------|-------|-------|-----------------|--------------|
| **1** | Core: Data model & storage | 5 | 🔴 Hard (cascading changes) | None |
| **2** | Core: Index & Vault | 4 | 🟡 Medium | Phase 1 |
| **3** | Core: Wiki links | 3 | 🟡 Medium | Phase 1-2 |
| **4** | Core: Templates | 2 | 🟢 Easy | Phase 1-2 |
| **5** | Core: Migration | 2 | 🟡 Medium | Phases 1-4 |
| **6** | Frontend: Foundation | 2 | 🟡 Medium | Phases 1-5 |
| **7** | Frontend: Views | 5 | 🟡 Medium (Graph = 🔴) | Phase 6 |
| **8** | Frontend: UI | 6 | 🟡 Medium | Phases 6-7 |

**Critical path:** 1 → 2 → 5 → 6 → 7 → 8. Phases 3 & 4 can run parallel with 5.

---

## 7. Key Decisions (Don't Re-Litigate)

These were explicitly decided with the user during brainstorming:

1. **No type/kind field.** Ever. One entity. Content + location = behavior.
2. **Physical folders, not logical.** Files live in real directories. Finder-browseable.
3. **File name = title** (from H1). No separate title field. Untitled = timestamp filename.
4. **`TEMPLATE.md` per folder.** No central template store. No config-based template linking.
5. **Title-based wiki links** `[[Note Title]]`, not UUID. Rename propagation updates all refs.
6. **4 view modes only.** No Outline (rejected — List view covers same use case). No auto-suggestion.
7. **Lock to pin view** per folder. Unlocked = session-only, resets to grid on restart.
8. **Markdown is truth.** Indexes are caches. `oximemo reindex` rebuilds everything.

---

## 8. Risks & Gotchas

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Cascading compile errors** when removing `category` | Blocks all Phase 1 work until resolved | Stub references, fix incrementally per task |
| **Rename propagation performance** on large vaults | UI freeze when renaming well-linked notes | Background task with progress indicator |
| **File watcher noise** from physical folder structure | Excessive reindex triggers | Debounce watcher events; ignore `_assets/`, `.trash/`, `TEMPLATE.md` |
| **Filename collisions** (two notes with same H1 in same folder) | Silent overwrite or error | Append `-2`, `-3` suffix on collision |
| **Korean filename safety** | Some tools may not handle Unicode filenames | macOS APFS is safe; document limitation for non-macOS |
| **Graph view performance** with hundreds of nodes | Slow rendering | Use canvas (not SVG); virtualize; cap visible nodes |
| **Migration irreversibility** | Data loss if migration fails | Automatic backup to `<vault>.bak/`; `--dry-run` flag |
| **Existing `[[uuid]]` wiki links** | Broken after migration to title-based | Migration step scans and converts all `[[uuid]]` → `[[title]]` |

---

## 9. Key Code Anchors

### `Memo` struct (what changes)
```rust
// crates/oximemo-core/src/memo.rs:115-135
// CURRENT: has category field
// TARGET: no category, title derived from body
```

### File path computation (what changes)
```rust
// crates/oximemo-core/src/paths.rs:5-6
// CURRENT: memos/<YYYY>/<MM>/<id>.md
// TARGET: <folder>/<title-slug>.md
```

### Wiki link serialization (what changes)
```rust
// apps/desktop/src/lib/memoLinks.ts
// CURRENT: serializeSuggestion returns UUID
// TARGET: serializeSuggestion returns filename/title
```

### Frontmatter parsing (backward compat)
```rust
// crates/oximemo-core/src/store/files.rs:22-39
// serde ignores unknown fields by default → old `category` field is silently skipped
```

### Vault facade (the API surface)
```rust
// crates/oximemo-core/src/vault.rs
// This is what both CLI and Tauri call. All new operations go here.
```

---

## 10. Out of Scope (Don't Implement)

- Multiple vaults
- Mobile / web client
- Collaborative editing
- Embed recursion (multi-level transclusion)
- Advanced graph filtering/grouping
- Conflict resolution UI (sync)
- Physical folder + date sharding hybrid
- Custom view mode plugins

---

## 11. Quick Reference: Commands

```bash
# Rust
cargo test -p oximemo-core                              # core unit tests
cargo run -p oximemo-cli -- --vault /tmp/test list      # CLI test
cargo run -p oximemo-cli -- --vault /tmp/test new "hi"  # create note

# Frontend
cd apps/desktop && bun run dev                          # dev server
cd apps/desktop && bun run build                        # TS + Vite build

# Full app
cargo tauri dev                                         # desktop app in dev

# Migration testing
cargo run -p oximemo-cli -- --vault /tmp/old-vault migrate --dry-run
```

---

## 12. Final Checklist Before "Transformation Complete"

- [ ] All 8 phases implemented
- [ ] `cargo fmt --all -- --check` clean
- [ ] `cargo clippy` clean (all crates)
- [ ] `cargo test` passes (all crates)
- [ ] `cd apps/desktop && bun run build` green
- [ ] Migration tested on real vault with backup
- [ ] Wiki links work end-to-end (create, navigate, backlinks, rename)
- [ ] Templates work (TEMPLATE.md + variable substitution)
- [ ] All 4 view modes render correctly
- [ ] Graph view renders with real wiki link data
- [ ] Quick capture still works (root timestamp file)
- [ ] External file editing detected by watcher
- [ ] Dark mode works in all views
- [ ] `doc/DESIGN.md` updated to reflect new architecture
- [ ] `skills/oximemo/SKILL.md` updated if CLI surface changed
- [ ] `CHANGELOG.md` updated

---

End of handoff. Read this + the spec + the plan, create your branch, and start with Phase 1 Task 1.1.
