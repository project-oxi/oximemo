# Quick Capture → Inbox-Only Destination (Design)

**Status:** Approved — ready for planning.
**Date:** 2026-08-25

## Why

Quick capture (`CaptureOverlay` / `QuickCaptureForm`) shipped a `/`-slash
folder picker (`2026-07-30-category-system-plan.md`) back when the app's
only destinations were plain folders. Since then the app grew first-party
**collections** (book/movie/blog/집필/idea — folders carrying a
`SCHEMA.toml`+`TEMPLATE.md`, `2026-08-23-collections-metadata-settings-design.md`).
The slash menu was never updated for this: it lists every folder,
collections included, with no distinction. Selecting a collection folder
silently skips that collection's real intake path (e.g. book/movie's
provider-search "추가" dialog), producing metadata-empty shells.

Investigated three fixes (schema-driven exclusion + search redirect,
default-folder-only, inbox-only) with the user. Decision: **quick capture
drops destination selection entirely and always lands in a single,
first-party Inbox collection.** Organizing into the right collection
happens afterward, in the main window, same as any other note move.

## What changes

### 1. `idea` preset display rename → Inbox

The `idea` preset (`crates/oximemo-core/src/schema.rs` `IDEA_TEMPLATE_MD`/
`IDEA_SCHEMA_TOML`) already is a frictionless-capture-then-review-queue
inbox by design (`kind: idea`, `status: fleeting`, `[review]
due_values=["fleeting"] decay_to="archived"`, promote-to-knowledge via
folder move). It becomes the literal capture destination, so its display
name changes from "아이디어"/"Ideas" to "인박스"/"Inbox":

- `apps/desktop/src/lib/locales/ko.ts` / `en.ts`: `collection_name_idea`,
  `prop_val_idea`, `collection_desc_idea` (copy adjusted to describe the
  capture-inbox role, not just "ideas").
- `apps/desktop/src/lib/collectionCatalog.ts`: `defaultFolder` ko
  "아이디어"→"인박스", en "ideas"→"inbox"; icon `Lightbulb`→`Inbox` (lucide).
- `crates/oximemo-core/src/schema.rs` `IDEA_SCHEMA_TOML`: `[workspace]
  name = "아이디어"` → `"인박스"`.

**Invariant (same rule as the prior `novel`→집필 rename):** the preset id
`"idea"` and the on-disk `kind: idea` value are stable data vocabulary —
never renamed. Only display strings change. Existing notes/folders with
`kind: idea` need no migration.

### 2. Inbox becomes a one-time-seeded default collection

New constant `oximemo-core::schema::DEFAULT_INBOX_FOLDER = "inbox"`
(mirrors `DEFAULT_KNOWLEDGE_FOLDER`).

`Vault::migrate()` already runs `ensure_default_folders()` on every vault
open and writes an index-format marker file
(`self.paths.index_fmt_marker_path()`). Add a parallel one-shot marker,
e.g. `inbox_seed_marker_path()`, and seed logic in
`ensure_default_folders()`:

```
if !inbox_seed_marker_exists() {
    let already_has_idea_folder = self.folder_inventory()?
        .iter().any(|f| f.preset.as_deref() == Some("idea"));
    if !already_has_idea_folder {
        self.apply_preset(DEFAULT_INBOX_FOLDER, IDEA_TEMPLATE_MD, IDEA_SCHEMA_TOML)?;
    }
    write_inbox_seed_marker()?;
}
```

**Why not just call `apply_preset` unconditionally like daily/knowledge:**
daily/knowledge are system folders — spec `2026-08-23-collections-metadata-settings-design.md`
line 26 states install-type collections are "사용자 소유. 삭제 시
재생성되지 않는다 (시스템 폴더가 아니므로)." Inbox is install-type, not
system-type. An unconditional per-launch `apply_preset` call would
resurrect the folder every time the user deleted it (path-based
skip-if-exists can't tell "user deleted this on purpose" from "never
existed"), breaking that contract. The one-shot marker seeds it exactly
once (retrofitting existing vaults on their next `migrate()` too) and
never re-checks after that — deletion is respected forever, same as any
other installed collection. The `already_has_idea_folder` guard also
prevents double-installing for users who manually installed "아이디어"
via the catalog picker before this change shipped.

### 3. Capture always resolves to Inbox — single backend entry point

New `Vault::create_capture(body: String) -> Result<Memo>`:

```rust
pub fn create_capture(&self, body: String) -> Result<Memo> {
    let folder = self
        .folder_inventory()?
        .into_iter()
        .find(|f| f.preset.as_deref() == Some("idea"))
        .map(|f| f.path)
        .unwrap_or_default(); // root fallback: pre-seed vaults, deleted inbox
    self.create_note_auto(&folder, body)
}
```

Exposed as a single Tauri command `create_capture(body)`. Resolution is
marker-based (`preset == "idea"`), not a hardcoded path, so a user
renaming the inbox folder via the existing folder-rename UI doesn't break
capture. If the inbox was deleted (respecting its permanent-delete
contract) or the vault predates seeding, capture falls back to vault root
— never a hard error.

### 4. Frontend: strip destination selection from capture

- `apps/desktop/src/lib/api.ts`: add `createCapture(body: string):
  Promise<NoteDto>` calling the new command; remove the `createMemo`
  callsite in `CaptureOverlay` (the `folder`-param API stays for other
  callers if any exist — grep before removal).
- `apps/desktop/src/components/CaptureOverlay.tsx`: drop `folder` state,
  the `listFolders()` effect, and the `FolderEntry[]` import; call
  `createCapture(value.trim())` in `save()`.
- `apps/desktop/src/components/QuickCaptureForm.tsx`: remove
  `SlashFolderMenu`, `FolderChip`, the `slashQuery`/`menuOpen`/`filtered`/
  `isNew` slash-parsing state, and the `folder`/`onFolderChange`/`folders`
  props from `QuickCaptureFormProps`. Component becomes a plain textarea
  shell (body + hint only), matching its original pre-slash-menu shape
  before the 2026-07-30 category-system plan added destination picking.
- `doc/CAPTURE_SLASH_PALETTE.md`: superseded by this doc — delete it (it
  was already marked "⛔ Design incomplete — not ready for
  implementation" and never shipped).

## Non-goals

- No book/movie search-dialog redirect from capture — moot once capture
  has no destination choice at all.
- No cross-window event bridge (`capture:open_metadata_search`) — not
  needed for the same reason.
- No required-property auto-fill or forced inline picker during capture
  — the inbox schema (`kind`+`status`, `status` template-defaulted) has no
  required properties, so this was never triggered anyway.
- No new SCHEMA.toml fields.
- No change to how notes leave the inbox (existing review-queue
  promote-to-knowledge / archive flow, or a manual folder move, both
  already work unchanged).

## Verification

- `cargo test -p oximemo-core`: new tests — `create_capture` targets the
  marker-tagged folder; falls back to root when absent; inbox seed runs
  once and is not resurrected after a folder delete; seed skips when an
  `idea`-preset folder already exists at a non-default path.
- `bun x tsc --noEmit`, `bun test`, `bun run build` (apps/desktop).
- Browser/app smoke: fresh vault → Inbox folder appears pinned/visible
  with the new name and icon on first open; `⌘⇧N` capture → Enter saves
  into Inbox (no slash menu appears); existing vault with a prior "아이디어"
  folder → no duplicate collection created, existing folder just
  redisplays as "인박스" in browse mode (deliberate — the id/kind stayed
  `idea` throughout) — display-name-only pin/sidebar rows should be
  spot-checked for stale "아이디어" strings via grep after the locale edit.
