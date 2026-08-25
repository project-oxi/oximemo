# Inbox-Only Quick Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quick capture always writes into the Inbox collection (the `idea` preset, renamed). No destination picker. Folder organization happens after the fact via the existing folder-move or review-queue flow.

**Architecture:** Two-axis change. **Backend (Rust):** a new one-shot seed installs the inbox folder via `ensure_default_folders()` (mirroring daily/knowledge but respecting the "user-ownable collection" contract via a seed-once marker); `Vault::create_capture(body)` resolves the inbox by `preset=="idea"` marker with root fallback. **Frontend (TS):** `CaptureOverlay` loses its folder state and uses a new `createCapture(body)` API; `QuickCaptureForm` loses its slash-folder-menu/chip/props and becomes a body-only composer; i18n/display strings and the obsolete `CAPTURE_SLASH_PALETTE.md` design doc are cleaned up.

**Tech Stack:** Rust (tauri 2, oximemo-core, workspace 0.9.3), React 19 / TypeScript 5.6, Tauri IPC, TanStack Query. No new dependencies.

## Global Constraints

- Preset id `"idea"` and on-disk `kind: idea` value are **stable data vocabulary — never renamed** (same rule as the `novel`→집필 rename). Only display strings change.
- `[workspace] name = "아이디어"` → `"인박스"` (Korean); en catalog workspace name → `"Inbox"`. The Korean folder slug defaults to `"inbox"` (lowercased ASCII, matching how other default folders like `knowledge`, `daily` slug themselves).
- Capture never errors on a missing inbox — root (`""`) fallback per spec.
- One-shot marker file (new `Paths::inbox_seed_marker_path()`) prevents seed resurrection after deliberate deletion. Every-migrate-run bypass is fine — the marker gates it.
- No new SCHEMA.toml fields. No required-property prompts. No book/movie search-redirect bridge.
- Conventional commits (English). Conventional commit prefixes per `AGENTS.md`.
- Gates per task: `cargo test -p oximemo-core --all-features` (or workspace equivalent), `bun x tsc --noEmit`, `bun run build` (apps/desktop), browser smoke where applicable.

---

### Task 1: Core — one-shot inbox seed + `create_capture`

**Files:**
- Modify: `crates/oximemo-core/src/paths.rs` (add `inbox_seed_marker_path()`)
- Modify: `crates/oximemo-core/src/schema.rs` (add `DEFAULT_INBOX_FOLDER = "inbox"`, change `[workspace] name` in `IDEA_SCHEMA_TOML`)
- Modify: `crates/oximemo-core/src/vault.rs` (`ensure_default_folders()` seeds inbox via marker; add `create_capture(body)`; new test module `#[cfg(test)] mod create_capture_tests`)
- Test: `crates/oximemo-core/src/vault.rs` inline `#[test]` blocks

**Interfaces:**
- Consumes: `apply_preset()` (vault.rs:227), `folder_inventory()` (vault.rs:472), `create_note_auto()` (vault.rs:859), `IDEA_TEMPLATE_MD`/`IDEA_SCHEMA_TOML` (schema.rs), `Paths::index_fmt_marker_path()` pattern (paths.rs:132).
- Produces:
  - `oximemo_core::schema::DEFAULT_INBOX_FOLDER: &str = "inbox"`
  - `oximemo_core::paths::Paths::inbox_seed_marker_path(&self) -> PathBuf` (mirrors `index_fmt_marker_path`)
  - `oximemo_core::vault::Vault::create_capture(&self, body: String) -> Result<Memo>`

- [ ] **Step 1: Write failing tests** in `vault.rs`'s existing test module (use the existing `tmp_vault()` helper pattern, see `knowledge_preset_end_to_end` at ~line 4201):

```rust
#[test]
fn create_capture_targets_idea_preset_folder() {
    let (_t, v) = tmp_vault();
    // First-vault open installs daily+knowledge+inbox (one-shot seed).
    v.migrate().unwrap();
    let n = v.create_capture("quick thought".into()).unwrap();
    assert_eq!(v.note_dto(&n).path, "inbox/quick-thought.md");
}

#[test]
fn create_capture_targets_idea_preset_renamed_path() {
    let (_t, v) = tmp_vault();
    v.migrate().unwrap();
    // Move inbox via the existing rename_folder path so the marker resolves the new path.
    v.rename_folder("inbox", "scratch").unwrap();
    let n = v.create_capture("x".into()).unwrap();
    let path = v.note_dto(&n).path;
    assert!(path.starts_with("scratch/"), "got {path}");
}

#[test]
fn create_capture_falls_back_to_root_when_inbox_missing() {
    let (_t, v) = tmp_vault();
    v.migrate().unwrap();
    // Delete inbox folder; verify capture still works (root fallback).
    v.delete_folder("inbox", false).unwrap(); // adjust signature to existing delete_folder(bool trash)
    let n = v.create_capture("y".into()).unwrap();
    assert_eq!(v.note_dto(&n).folder, "");
}

#[test]
fn inbox_seed_runs_once_and_not_recreated_after_delete() {
    let (t, v) = tmp_vault();
    v.migrate().unwrap();
    assert!(v.paths().vault.join("inbox").join("SCHEMA.toml").exists());
    v.delete_folder("inbox", false).unwrap();
    // Re-run migrate — seed must NOT resurrect the deleted folder.
    v.migrate().unwrap();
    assert!(!v.paths().vault.join("inbox").join("SCHEMA.toml").exists());
    // Drop t at end of scope by NOT asserting further; t is bound below.
    drop(t);
}

#[test]
fn inbox_seed_skips_when_existing_idea_folder_already_present() {
    let (_t, v) = tmp_vault();
    // User pre-installed an ideas folder at a non-default path BEFORE migrate.
    v.install_collection("idea", "user-thoughts").unwrap();
    // migrate must NOT install the default "inbox" folder on top.
    v.migrate().unwrap();
    let by_preset: std::collections::HashMap<String, String> = v
        .folder_inventory()
        .unwrap()
        .into_iter()
        .filter_map(|f| f.preset.map(|p| (p, f.path)))
        .collect();
    assert_eq!(by_preset.get("idea").map(String::as_str), Some("user-thoughts"));
    assert!(!v.folder_inventory().unwrap().iter().any(|f| f.path == "inbox"));
}
```

Adjust the `delete_folder` callsite to match the actual signature in this tree (grep `pub fn delete_folder` in `vault.rs`). The Plan's intent: deleting a folder invalidates it from `folder_inventory()`.

- [ ] **Step 2: Run the tests; verify they fail with the expected names not defined / methods not found.**
  Run: `cargo test -p oximemo-core -- create_capture 2>&1 | tail -30`

- [ ] **Step 3: Add `DEFAULT_INBOX_FOLDER` + update `IDEA_SCHEMA_TOML`** in `crates/oximemo-core/src/schema.rs`. Place the constant next to `DEFAULT_KNOWLEDGE_FOLDER` (line ~102). Update the `[workspace] name = "아이디어"` line in `IDEA_SCHEMA_TOML` to `"인박스"`. **Do NOT** touch `kind`/`status` props or any preset id.

- [ ] **Step 4: Add `inbox_seed_marker_path()` in `paths.rs`.** Right after `index_fmt_marker_path()` (paths.rs:132). Same shape:

```rust
/// Marker file recording whether the one-time Inbox (`idea` preset)
/// seed has run. Idempotent across migrations; absent = seed on next
/// `ensure_default_folders()`.
pub fn inbox_seed_marker_path(&self) -> PathBuf {
    self.index_dir.join("inbox-seed")
}
```

- [ ] **Step 5: Update `ensure_default_folders()` in `vault.rs:2101`.** Replace its body with one that:
  1. Unconditionally applies knowledge + daily (existing behavior, do not change).
  2. Seeds inbox under a one-shot marker:

```rust
fn ensure_default_folders(&self) -> Result<()> {
    self.apply_knowledge_preset(crate::schema::DEFAULT_KNOWLEDGE_FOLDER)?;
    let daily = self.with_config(|c| c.daily.folder.clone());
    let daily = daily.trim_end_matches('/');
    if !daily.is_empty() {
        self.apply_preset(daily, crate::schema::DAILY_TEMPLATE_MD, crate::schema::DAILY_SCHEMA_TOML)?;
    }
    // One-shot Inbox seed (idea preset). Differs from the
    // knowledge/daily above: install-type collections are user-ownable
    // per the collections metadata/settings design §2.6, so once a
    // user deletes the inbox we must NOT resurrect it on every
    // migrate(). The marker + inventory check guards both the
    // first-ever seed and the "user installed idea elsewhere"
    // retroactively-applied case.
    let marker = self.paths.inbox_seed_marker_path();
    if !marker.exists() {
        let already_has_idea = self
            .folder_inventory()?
            .iter()
            .any(|f| f.preset.as_deref() == Some("idea"));
        if !already_has_idea {
            self.apply_preset(
                crate::schema::DEFAULT_INBOX_FOLDER,
                crate::schema::IDEA_TEMPLATE_MD,
                crate::schema::IDEA_SCHEMA_TOML,
            )?;
        }
        if let Some(parent) = marker.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&marker, b"1")?;
    }
    Ok(())
}
```

- [ ] **Step 6: Add `Vault::create_capture(body)`** right after `create_note_auto` (vault.rs:859):

```rust
/// Quick-capture entry: write into the Inbox (`idea` preset)
/// folder, falling back to vault root when the inbox is absent
/// (e.g. user deleted it, older vault). Marked by `preset` schema
/// marker so a renamed inbox still resolves.
pub fn create_capture(&self, body: String) -> Result<Memo> {
    let folder = self
        .folder_inventory()?
        .into_iter()
        .find(|f| f.preset.as_deref() == Some("idea"))
        .map(|f| f.path)
        .unwrap_or_default();
    self.create_note_auto(&folder, body)
}
```

- [ ] **Step 7: Run the new tests; verify they pass.**
  Run: `cargo test -p oximemo-core -- create_capture inbox_seed 2>&1 | tail -40`
  Expected: 5/5 PASS.

- [ ] **Step 8: Run full workspace tests; verify no regressions.**
  Run: `cargo test --workspace 2>&1 | tail -20`
  If any pre-existing test fails (e.g. the fixture `knowledge_preset_end_to_end` relied on a specific folder_inventory shape), adjust the test rather than the implementation — but expect none since `folder_inventory()` adds rather than removes fields.

- [ ] **Step 9: Commit.**
  ```bash
  git add crates/oximemo-core/src/{paths.rs,schema.rs,vault.rs}
  git commit -m "feat(core): one-shot inbox seed + create_capture

Adds DEFAULT_INBOX_FOLDER (\"inbox\") and a one-time seed marker so
the idea preset is installed on next migrate() without ever being
resurrected after the user deletes it (matches the install-type
collection contract). Vault::create_capture resolves the inbox via
the preset schema marker (not a hardcoded path) and falls back to
vault root when the inbox is absent."
  ```

---

### Task 2: Tauri IPC — `create_capture` command

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs` (add `create_capture` command near `create_memo` at ~line 732)

**Interfaces:**
- Consumes: `vault.create_capture(body)` from Task 1.
- Produces:
  - `#[tauri::command] pub fn create_capture(state: ..., app: AppHandle, body: String) -> Result<NoteDto, String>` — frontend invocation name `create_capture`. Emits `memos:changed` like `create_memo` does.

- [ ] **Step 1: Add the command** after the existing `create_memo` (right before `open_daily_note`'s doc-comment block at lib.rs:761):

```rust
/// Quick-capture entry — writes into the Inbox (`idea` preset)
/// folder with root fallback. Identical shape to `create_memo`
/// but with no `folder`/`format` params: the backend resolves
/// the destination.
#[tauri::command]
pub fn create_capture(
    state: State<'_, AppState>,
    app: AppHandle,
    body: String,
) -> Result<oximemo_core::memo::NoteDto, String> {
    let memo = state.vault.create_capture(body).map_err(|e| e.to_string())?;
    let _ = app.emit("memos:changed", ());
    Ok(state.vault.note_dto(&memo))
}
```

- [ ] **Step 2: Build & confirm registration.**
  Run: `cargo build -p oxi-desktop 2>&1 | tail -10`
  Expected: clean build. Tauri auto-registers `#[tauri::command]`-decorated pub fns.

- [ ] **Step 3: Commit.**
  ```bash
  git add apps/desktop/src-tauri/src/lib.rs
  git commit -m "feat(ipc): create_capture command

Single backend entry point for the quick-capture flow — no
folder param, no format param. Resolves the Inbox folder
via the preset schema marker and writes the note there."
  ```

---

### Task 3: Browser fallback — `create_capture` mirror

**Files:**
- Modify: `apps/desktop/src/lib/tauri.ts` (`browserInvoke` switch around line 655)

**Interfaces:**
- Consumes: `browserInvoke` switch for `"create_memo"` (lines 655-683), `loadStore()` / `saveStore()` / `emitBrowser()` helpers already in this file.
- Produces: a `case "create_capture":` branch whose semantics match Rust — `"inbox"` folder if a folder preset `"idea"` mirror exists in `loadSchemas()`, else `""`. Empty body = no-op (matches Rust's `validate_note_input`).

- [ ] **Step 1: Add the `case "create_capture":` branch** immediately before the `case "create_memo":` block at tauri.ts:655:

```typescript
case "create_capture": {
    // Browser preview parity: resolve inbox via installed schema
    // mirrors exactly like Rust does (first SCHEMA with
    // meta.preset === "idea"). Falls back to "" root when absent.
    const body = (args?.body as string | undefined) ?? "";
    const format: "markdown" | "html" = "markdown";
    const folder = (() => {
        const schemas = loadSchemas();
        for (const [p, s] of Object.entries(schemas)) {
            if (s?.meta?.preset === "idea") return p;
        }
        return "";
    })();
    const title = deriveTitle(body, format);
    const ext = format === "html" ? ".html" : ".md";
    const base = (title ?? `note-${Date.now()}`).replace(/[^\p{L}\p{N}]+/gu, "-");
    const now = new Date().toISOString();
    const memo: Memo = {
        id: crypto.randomUUID(),
        created_at: now,
        updated_at: now,
        hash: fakeHash(),
        favorite: false,
        folder,
        path: `${folder ? `${folder}/` : ""}${base}${ext}`,
        format,
        title,
        tags: extractTags(body),
        body,
        props: {},
        deleted_at: null,
    };
    const store = loadStore();
    store[memo.id] = memo;
    saveStore(store);
    emitBrowser("memos:changed");
    return memo;
}
```

- [ ] **Step 2: tsc gate.**
  Run: `cd apps/desktop && bun x tsc --noEmit 2>&1 | tail -20`
  Expected: no errors.

- [ ] **Step 3: Commit.**
  ```bash
  git add apps/desktop/src/lib/tauri.ts
  git commit -m "feat(desktop): browser fallback for create_capture

Resolves the inbox folder by scanning installed schema mirrors
for meta.preset === \"idea\", matching the Rust behavior."
  ```

---

### Task 4: API + CaptureOverlay — drop destination state, call `createCapture`

**Files:**
- Modify: `apps/desktop/src/lib/api.ts` (add `createCapture(body)` after `createMemo`)
- Modify: `apps/desktop/src/components/CaptureOverlay.tsx` (drop folder/folders/listFolders/FolderEntry import; call `createCapture`)

**Interfaces:**
- Consumes: existing `invoke` wrapper used by `createMemo` (api.ts:65-71), `closeCurrentWindow` / `showCurrentWindow` / `listen` already imported in `CaptureOverlay.tsx`.
- Produces:
  - `export async function createCapture(body: string): Promise<Memo>` in `api.ts`
  - `CaptureOverlay` no longer imports `listFolders` / `createMemo` / `FolderEntry`; only `createCapture`.

- [ ] **Step 1: Add `createCapture`** right after `createMemo` in `apps/desktop/src/lib/api.ts` (after line 71):

```typescript
/** Quick-capture: writes to the Inbox (`idea` preset) folder.
 *  Backend resolves the destination — no `folder`/`format` args. */
export async function createCapture(body: string): Promise<Memo> {
  return invoke<Memo>("create_capture", { body });
}
```

- [ ] **Step 2: Refactor `CaptureOverlay.tsx`.** Strip destination-related state and imports:

  - Remove from imports: `createMemo`, `listFolders`, `FolderEntry`.
  - Add to imports: `createCapture` (from `"../lib/api"`).
  - Remove state: `const [folder, setFolder] = useState("");` and `const [folders, setFolders] = useState<FolderEntry[]>([]);`.
  - Remove the `useEffect(() => void listFolders().then(setFolders).catch(() => {}), []);` (lines ~29-33).
  - In `save()`, replace `await createMemo(body, folder || null);` with `await createCapture(body);`.
  - Remove the `folder`, `onFolderChange`, `folders` props passed to `QuickCaptureForm`. Leave `body`, `onBodyChange`, `bodyRef`, `bodyProps`, `hint` only.

  Resulting `CaptureOverlay.tsx` shape (for reference):

```tsx
import { useEffect, useRef, useState } from "react";
import { createCapture } from "../lib/api";
import { listen } from "../lib/tauri";
import { useI18n } from "../lib/i18n";
import { closeCurrentWindow, showCurrentWindow } from "../lib/window";
import { useUI } from "../stores/ui";
import { QuickCaptureForm } from "./QuickCaptureForm";
import { ErrorToast } from "./ErrorBoundary";

export function CaptureOverlay() {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const setError = useUI((s) => s.setError);
  const savingRef = useRef(false);

  useEffect(() => {
    void listen("capture:show", () => {
      setValue("");
      window.setTimeout(() => ref.current?.focus(), 30);
    });
  }, []);

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") void closeCurrentWindow();
    else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void save(); }
  };

  async function save() {
    if (savingRef.current) return;
    const body = value.trim();
    if (!body) return;
    savingRef.current = true;
    try {
      await closeCurrentWindow();
      await createCapture(body);
    } catch (e) {
      setError(String(e).split("\n")[0]);
      await showCurrentWindow();
    } finally {
      savingRef.current = false;
    }
  }

  return (
    <div className="relative isolate flex h-screen w-full items-end justify-center p-2">
      <QuickCaptureForm
        body={value}
        onBodyChange={setValue}
        bodyRef={ref}
        bodyProps={{ placeholder: t.capture_placeholder, onKeyDown: onKey }}
        hint={`↵ ${t.capture_save} · esc ${t.close}`}
      />
      <ErrorToast />
    </div>
  );
}
```

- [ ] **Step 3: tsc gate.**
  Run: `cd apps/desktop && bun x tsc --noEmit 2>&1 | tail -20`
  Expected: no errors. (The follow-up Task 5 will remove the `QuickCaptureForm` props it complains about; until then, `bodyProps`/`hint` are still required by the current prop interface.)

- [ ] **Step 4: Commit.**
  ```bash
  git add apps/desktop/src/lib/api.ts apps/desktop/src/components/CaptureOverlay.tsx
  git commit -m "refactor(desktop): capture overlay drops destination state

CaptureOverlay no longer manages folder/folders/listFolders. Save
calls the new createCapture IPC; QuickCaptureForm now renders
without folder/onFolderChange/folders props."
  ```

---

### Task 5: QuickCaptureForm — strip slash folder menu + folder props

**Files:**
- Modify: `apps/desktop/src/components/QuickCaptureForm.tsx` (remove `SlashFolderMenu`, `FolderChip`, the folder/`onFolderChange`/`folders` props; drop folder-related state and `createFolder`/`colorForFolder`/`useFolderNames` usage; remove unused icon imports `Folder`/`FolderPlus`; remove the `isNew`-create folder codepath)

**Interfaces:**
- Consumes: existing `QuickCaptureForm` props interface (lines ~27-41), existing keyboard handling.
- Produces:
  - `QuickCaptureFormProps` reduced to: `body`, `onBodyChange`, `bodyRef?`, `bodyProps?`, `bodyClassName?`, `hint`, `className?`. **No `folder`/`onFolderChange`/`folders`.**
  - The file no longer exports or references `SlashFolderMenu` / `FolderChip`.

- [ ] **Step 1: Strip the folder block.** Delete the `SlashFolderMenu` function (lines ~43-84), the `FolderChip` function (lines ~86-117), and any imports that only those need: `Folder`, `FolderPlus`, `X` from `lucide-react`; `useFolderNames`; `colorForFolder`; `createFolder`.

- [ ] **Step 2: Reduce `QuickCaptureFormProps`.** Final interface should be:

```typescript
export interface QuickCaptureFormProps {
  body: string;
  onBodyChange: (v: string) => void;
  bodyRef?: Ref<HTMLTextAreaElement>;
  bodyProps?: Omit<
    TextareaHTMLAttributes<HTMLTextAreaElement>,
    "value" | "onChange" | "className"
  >;
  bodyClassName?: string;
  hint: string;
  className?: string;
}
```

- [ ] **Step 3: Strip the folder-related state and keydown logic.** Remove: `menuOpen`, `slashQuery`, `sel`, `filtered`, `isNew` `useMemo`s/usestates; the `handleSlashSelect`/`handleSlashCreate` callbacks; the slash-navigation branch in the existing `onKeyDown` switch. Keep `bodyProps?.onKeyDown?.(e)` as the default branch (the capture overlay already wires Enter/Esc through `bodyProps.onKeyDown`).

- [ ] **Step 4: Strip the folder render pieces.** Remove `<SlashFolderMenu ...>` and `<FolderChip ...>` from the JSX (these are nested inside the pill). Verify the resulting JSX is just: outer container, optional floating folder UX gone, textarea (`<textarea {...bodyProps} ...>`), hint line at the bottom (`hint` prop). The component should look like a plain single-textarea body input with no slash menu, no chip, no folder button.

- [ ] **Step 5: tsc gate.**
  Run: `cd apps/desktop && bun x tsc --noEmit 2>&1 | tail -20`
  Expected: no errors. Task 4 already aligned `CaptureOverlay` props with the reduced interface.

- [ ] **Step 6: Run full build gate.**
  Run: `cd apps/desktop && bun run build 2>&1 | tail -30`
  Expected: clean build.

- [ ] **Step 7: Commit.**
  ```bash
  git add apps/desktop/src/components/QuickCaptureForm.tsx
  git commit -m "refactor(desktop): QuickCaptureForm loses slash folder menu

QuickCaptureForm is now a body-only composer (textarea + hint).
The SlashFolderMenu, FolderChip, isNew-create behavior, and the
folder/onFolderChange/folders props are removed — capture has no
destination choice. Enter saves, Esc closes, Shift+Enter inserts
a newline."
  ```

---

### Task 6: Display strings — `idea` → `Inbox`

**Files:**
- Modify: `apps/desktop/src/lib/locales/ko.ts` (`collection_name_idea`, `prop_val_idea`, `collection_desc_idea`)
- Modify: `apps/desktop/src/lib/locales/en.ts` (same keys)
- Modify: `apps/desktop/src/lib/collectionCatalog.ts` (`defaultFolder` ko/en + icon `Lightbulb`→`Inbox`)
- Modify: `apps/desktop/src/lib/tauri.ts` (`IDEA_PRESET_SCHEMA.workspace.name`, label strings)
- Modify: `crates/oximemo-core/src/schema.rs` `IDEA_SCHEMA_TOML` (already updated in Task 1 — verify the workspace line is `"인박스"`)

**Interfaces:**
- Produces: same key names (`collection_name_idea`, `prop_val_idea`, `collection_desc_idea`); only their values change.

- [ ] **Step 1: Korean locale (`apps/desktop/src/lib/locales/ko.ts`).**
  - `prop_val_idea: "아이디어"` → `"인박스"`
  - `collection_name_idea: "아이디어"` → `"인박스"`
  - `collection_desc_idea: "떠오른 대로 적고, 복습 큐에서 지식으로 승격"` → `"빠르게 적고, 복습 큐에서 지식으로 승격하거나 보관"` (signals the new capture role — slightly adjusted copy, verify with user later if they prefer a different wording).

- [ ] **Step 2: English locale (`apps/desktop/src/lib/locales/en.ts`).**
  - `prop_val_idea: "Idea"` → `"Inbox"`
  - `collection_name_idea: "Ideas"` → `"Inbox"`
  - `collection_desc_idea: "Capture freely, promote the keepers from the review queue"` → `"Quick capture inbox — promote keepers to knowledge, archive the rest"`

- [ ] **Step 3: Catalog (`apps/desktop/src/lib/collectionCatalog.ts`).**
  - In the `idea` catalog entry: `defaultFolder: { ko: "아이디어", en: "ideas" }` → `{ ko: "인박스", en: "inbox" }`.
  - Icon: change the `icon: Lightbulb,` line to `icon: Inbox,`. Add `Inbox` to the `lucide-react` import.

- [ ] **Step 4: Browser fallback schema (`apps/desktop/src/lib/tauri.ts`).** In `IDEA_PRESET_SCHEMA`:
  - `workspace: { name: "아이디어" }` → `workspace: { name: "인박스" }`.
  - Note the existing `colors: { fleeting: "info", archived: "neutral" }` and other fields: do not touch.

- [ ] **Step 5: Verify the core schema line.** Confirm `IDEA_SCHEMA_TOML` in `crates/oximemo-core/src/schema.rs` has `[workspace] name = "인박스"` (Task 1 already set this). If not, edit it now.

- [ ] **Step 6: Grep sweep for stale "아이디어"/"Idea" strings.**
  Run from repo root:
  ```
  grep -rn '"아이디어"' apps/desktop/src apps/desktop/src-tauri crates
  grep -rn 'Idea\b.*\b(아이디어|collection_name_idea|prop_val_idea)' apps/desktop/src
  grep -rn 'Lightbulb' apps/desktop/src
  ```
  Expected: zero hits except in comments or changelogs (CHANGELOG entries must keep the historical term — fix only living code).

- [ ] **Step 7: tsc + build gate.**
  Run: `cd apps/desktop && bun x tsc --noEmit && bun run build 2>&1 | tail -20`
  Expected: clean.

- [ ] **Step 8: Commit.**
  ```bash
  git add apps/desktop/src/lib/locales/ko.ts apps/desktop/src/lib/locales/en.ts apps/desktop/src/lib/collectionCatalog.ts apps/desktop/src/lib/tauri.ts crates/oximemo-core/src/schema.rs
  git commit -m "feat(desktop): rename idea collection display to Inbox

The idea preset is the quick-capture inbox. Display strings flip
to '인박스' / 'Inbox'; defaultFolder slug to 'inbox' / 'inbox';
icon Lightbulb→Inbox. The preset id (\"idea\") and on-disk
kind: idea value stay stable per the novel/집필 rename precedent."
  ```

---

### Task 7: Cleanup — remove obsolete `CAPTURE_SLASH_PALETTE.md`

**Files:**
- Delete: `doc/CAPTURE_SLASH_PALETTE.md`

- [ ] **Step 1: Verify nothing else references it.**
  Run: `grep -rn 'CAPTURE_SLASH_PALETTE' apps desktop doc docs 2>/dev/null`
  Expected: only the file path itself. The doc was already marked "⛔ Design incomplete — not ready for implementation" and never shipped.

- [ ] **Step 2: Delete the file.**
  Run: `git rm doc/CAPTURE_SLASH_PALETTE.md`

- [ ] **Step 3: Commit.**
  ```bash
  git commit -m "docs: remove obsolete CAPTURE_SLASH_PALETTE spec

Superseded by docs/superpowers/specs/2026-08-25-inbox-only-capture-design.md.
The slash-folder-palette mechanic was never shipped (the doc was
flagged as incomplete) and is now explicitly retired by the
inbox-only capture design."
  ```

---

### Task 8: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Rust gate.**
  Run: `cargo test --workspace 2>&1 | tail -15`
  Expected: all green, including the 5 new tests added in Task 1.

- [ ] **Step 2: Desktop build + type-check gate.**
  Run: `cd apps/desktop && bun x tsc --noEmit && bun run build 2>&1 | tail -10`
  Expected: clean.

- [ ] **Step 3: Browser smoke.** From `apps/desktop`:
  ```
  bun run dev
  ```
  In the browser:
  1. With a fresh dev vault (clear `localStorage` once if needed), open the app. Verify the "인박스" / "Inbox" folder appears as a pinned location with the inbox icon (not the lightbulb).
  2. Press `⌘⇧N` (capture shortcut). Capture window opens. Verify the slash menu is GONE — typing `/` no longer opens a folder dropdown; typing `/` simply inserts a slash into the textarea (Korean IME is no longer special-cased in capture since capture has no command surface).
  3. Type text, press Enter. Verify the note lands in the `inbox/` folder in the file tree (browser fallback uses localStorage; confirm via the inbox folder's notes listing).
  4. Screenshot the capture overlay (empty + typing states) for visual evidence.

- [ ] **Step 4: Existing-vault regression smoke.** If a prior-vault snapshot is available, point the dev server at it via the vault path. On first migrate(), verify the inbox folder is created exactly once and at the canonical `"inbox"` path (not at a side path). Confirm `doctor` reports no schema_violations for the new inbox notes.

- [ ] **Step 5: Commit any CHANGELOG entry** if the convention requires one:
  ```bash
  git add CHANGELOG.md
  git commit -m "docs(changelog): quick capture now lands in Inbox (idea preset)"
  ```
  (Skip this step if CHANGELOG.md wasn't touched — depends on the convention in this repo; check if Task 6 already updated it.)

---

## Spec coverage check

| Spec section | Implemented in task |
|---|---|
| Rename `idea` → 인박스/Inbox (display only, preset id/kind stable) | Task 1 Step 3 (schema core workspace name) + Task 6 (catalog/locales/browser mirror) |
| One-shot inbox seed via marker, never resurrets, no duplicate with manual install | Task 1 Steps 4-5 + tests |
| `Vault::create_capture(body)` resolves via marker, falls back to root | Task 1 Step 6 + tests |
| Tauri command `create_capture` (no folder/format params), emits `memos:changed` | Task 2 |
| Browser fallback `case "create_capture"` | Task 3 |
| `CaptureOverlay` strips destination state, calls `createCapture` | Task 4 |
| `QuickCaptureForm` strips SlashFolderMenu/FolderChip/folder props | Task 5 |
| Remove `doc/CAPTURE_SLASH_PALETTE.md` | Task 7 |
| Verification gates | Task 8 |
| **Non-goals (no book/movie bridge, no required-prop prompts, no new SCHEMA.toml fields)** | Explicitly absent from all tasks |
