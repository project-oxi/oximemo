# Copilot Schema Awareness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the copilot (any delegated agent) understand every folder schema and perform every vault operation — discover folders, read schemas, install collections, create schema-valid notes in one command, ground movie/book facts through the user's metadata providers.

**Architecture:** The vault becomes self-describing through the CLI (agent/human parity): `folders`/`schema`/`collection`/`metadata`/`stamp` commands plus `new --set`. Provider adapters move to a shared sync (ureq) crate `oximemo-metadata` consumed by both desktop and CLI. The copilot context block gains a compact folder-map fact section; SKILL.md documents the whole surface. Core stays network-free.

**Tech Stack:** Rust (edition 2024, workspace 0.9.3), clap derive, ureq 2 + rustls, serde, existing oximemo-core vault APIs.

## Global Constraints

- oximemo app code contains no model-directed instruction strings (spec 2026-08-23 §3, acceptance 3). Facts only in the context block; behavior lives in SKILL.md.
- Core crate stays network-free (design 2026-08-24 §2.3).
- Capture path untouched. No new IPC commands (all work is CLI-side + context block).
- Existing semantics preserved: skip-if-exists installs, fill-only-empty stamping, transitions on app-initiated writes, keyless/keyed provider gating.
- `single_line()` sanitization for every untrusted string entering the context block (folder paths, workspace names).
- Conventional commits, English messages.

---

### Task 1: Core — `Vault::folder_inventory()`

**Files:**
- Modify: `crates/oximemo-core/src/vault.rs` (near `list_folders`, ~line 454)
- Modify: `crates/oximemo-core/src/lib.rs` (re-export if schema types are gated — check existing `pub use` for schema)

**Interfaces:**
- Produces: `pub fn folder_inventory(&self) -> Result<Vec<FolderInfo>>` and
  `pub struct FolderInfo { pub path: String, pub notes: u32, pub preset: Option<String>, pub workspace: Option<String>, pub has_schema: bool, pub has_template: bool }` (derive `Serialize`, `Debug`, `Clone`, `PartialEq`) — placed in `vault.rs`, re-exported from core root alongside other vault types.

- [ ] **Step 1: Failing test** in `vault.rs` tests module (pattern: `tmp_vault()`):

```rust
#[test]
fn folder_inventory_reports_schemas_templates_and_counts() {
    let (dir, v) = tmp_vault();
    // Default vault ships knowledge + daily presets (ensure_default_folders).
    v.install_collection("movie", "movies").unwrap();
    v.create_note("knowledge", "k1 body".into(), oximemo_core::memo::NoteFormat::Markdown).unwrap();
    let inv = v.folder_inventory().unwrap();
    let by: std::collections::HashMap<String, FolderInfo> =
        inv.into_iter().map(|f| (f.path.clone(), f)).collect();
    let k = &by["knowledge"];
    assert_eq!(k.notes, 1);
    assert_eq!(k.preset.as_deref(), Some("knowledge"));
    assert_eq!(k.workspace.as_deref(), Some("지식"));
    assert!(k.has_schema && k.has_template);
    let m = &by["movies"];
    assert_eq!(m.notes, 0); // installed-but-empty collection is visible
    assert_eq!(m.preset.as_deref(), Some("movie"));
    let root_absent = !by.contains_key("");
    assert!(root_absent);
    drop(dir);
}
```

- [ ] **Step 2:** `cargo test -p oximemo-core folder_inventory` → FAIL (method missing).
- [ ] **Step 3:** Implement — iterate `self.list_folders()?`, for each folder call `self.folder_schema(path)` (cached) and `template::load_template` for both formats:

```rust
pub fn folder_inventory(&self) -> Result<Vec<FolderInfo>> {
    let mut out = Vec::new();
    for (path, notes) in self.list_folders()? {
        let schema = self.folder_schema(&path)?;
        let has_template = crate::template::load_template(
            self.paths(), &path, crate::memo::NoteFormat::Markdown,
        ).is_some() || crate::template::load_template(
            self.paths(), &path, crate::memo::NoteFormat::Html,
        ).is_some();
        let (preset, workspace) = schema.map(|s| (
            s.meta.preset, s.workspace.name,
        )).unwrap_or((None, None));
        out.push(FolderInfo { path, notes, preset, workspace, has_schema: schema.is_some(), has_template });
    }
    Ok(out)
}
```

- [ ] **Step 4:** Test passes. `cargo test -p oximemo-core` full crate green.
- [ ] **Step 5:** `git commit -m "feat(core): folder_inventory — folders with schema facts"`

### Task 2: CLI — `folders` and `schema` commands

**Files:**
- Modify: `crates/oximemo-cli/src/main.rs` (Cmd enum + run dispatch)
- Modify: `crates/oximemo-cli/src/commands.rs` (cmd_folders, cmd_schema)
- Modify: `crates/oximemo-cli/src/format.rs` (FolderInfo printing — reuse pattern of print_summaries)

**Interfaces:**
- Consumes: `Vault::folder_inventory`, `Vault::folder_schema`, `template::load_template`, `Vault::paths()`, `Vault::with_config` (daily folder: `c.daily.folder`).
- Produces: `pub fn cmd_folders(vault: &Vault, fmt: Format) -> Result<()>`, `pub fn cmd_schema(vault: &Vault, folder: Option<String>) -> Result<()>` (JSON-only output).

Output contracts:
- `folders --format json`: `[{"path":"knowledge","notes":1,"preset":"knowledge","workspace":"지식","daily":false}]` (`daily` flag marks the configured daily folder; table shows `FOLDER NOTES SCHEMA` with `영화 (movie)` style schema column).
- `schema knowledge`: `{"folder":"knowledge","schema":{...FolderSchema...},"template":"---\nkind: knowledge\n..."}`; no schema → `"schema":null`; nonexistent folder → exit 1 `no such folder: X`; template may be `null`.

- [ ] **Step 1: Failing tests** in `commands.rs` tests (temp vault; call cmd_* directly; JSON goes to stdout — assert via return value only where practical; for output shape test the pure builder): expose `pub fn folder_rows(vault: &Vault) -> Result<Vec<FolderRow>>` (`FolderRow` = FolderInfo + `daily: bool`) and `pub fn schema_report(vault: &Vault, folder: &str) -> Result<Option<SchemaReport>>` as pure builders; commands print them. Tests assert builders.

```rust
#[test]
fn folder_rows_marks_daily_and_presets() { /* temp vault: rows contain daily:true on configured daily folder, preset markers */ }
#[test]
fn schema_report_full_null_and_missing() { /* knowledge → Some with schema+template; root "" → schema null handled; "nope" → None → command errors */ }
```

- [ ] **Step 2:** `cargo test -p oximemo-cli` → FAIL.
- [ ] **Step 3:** Implement builders + Cmd variants (`Folders { format }`, `Schema { folder: Option<String> }`) + dispatch + table/json/ndjson printing (`print_folder_rows`).
- [ ] **Step 4:** Tests pass; `cargo run -q -p oximemo-cli -- folders` manual sanity.
- [ ] **Step 5:** `git commit -m "feat(cli): folders + schema — vault self-description"`

### Task 3: CLI — `collection` install/list

**Files:** same as Task 2.

**Interfaces:**
- Consumes: `oximemo_core::schema::collection_preset`, `Vault::install_collection`.
- Produces: `pub fn collection_ids() -> Vec<(&'static str, &'static str)>` (id + workspace name parsed from preset SCHEMA.toml via `parse_schema(...).workspace.name`); `pub fn cmd_collection_list() -> Result<()>`; `pub fn cmd_collection_install(vault: &Vault, id: &str, folder: &str) -> Result<()>`.

- [ ] **Step 1: Failing test:** install movie → folder appears in `folder_inventory` with preset movie; unknown id errors listing valid ids.
- [ ] **Step 2:** FAIL. **Step 3:** Implement `Collection { List, Install { id, folder } }` subcommand enum.
- [ ] **Step 4:** Pass. **Step 5:** `git commit -m "feat(cli): collection install/list — GUI parity"`

### Task 4: CLI — `new --set`

**Files:**
- Modify: `crates/oximemo-cli/src/main.rs` (New variant gains `set: Vec<String>`)
- Modify: `crates/oximemo-cli/src/commands.rs` (cmd_new gains `sets` param)

**Interfaces:**
- Consumes: `Vault::create_note` → `Vault::update_note_with(id, None, None, Some(PropMutation))` (transitions fire — same path as GUI property edits).
- Produces: `pub fn cmd_new(vault, text, tags, folder, html, sets: Vec<(String, PropValue)>)` — parse KEY=VAL in main.rs exactly like Update (comma→List). On empty note + no template + sets present: still refuse empty body unless template exists (existing rule; sets don't make an empty note meaningful).

- [ ] **Step 1: Failing test:** knowledge folder, `cmd_new` with `status=understood` → note props contain `status`, `peak_status=understood`, `status_changed=today` (transition proof), and template defaults `kind=knowledge` survived.

```rust
#[test]
fn new_with_set_fires_schema_transitions() {
    let (dir, v) = tmp_vault();
    let id = commands::cmd_new_creates(&v, Some("코루틴 취소".into()), vec![], Some("knowledge".into()), false,
        vec![("status".into(), oximemo_core::PropValue::Str("understood".into()))]).unwrap();
    let note = v.get_memo(id).unwrap();
    assert_eq!(note.props.get("kind"), Some(&oximemo_core::PropValue::Str("knowledge".into())));
    assert_eq!(note.props.get("peak_status"), Some(&oximemo_core::PropValue::Str("understood".into())));
    assert!(note.props.contains_key("status_changed"));
    drop(dir);
}
```

(`cmd_new` currently prints and returns `()`; refactor to return the created `MemoId` — internal signature change, callers updated.)

- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** Pass + existing new tests green.
- [ ] **Step 5:** `git commit -m "feat(cli): new --set — one-command schema-valid creation"`

### Task 5: `oximemo-metadata` shared crate (sync ureq)

**Files:**
- Create: `crates/oximemo-metadata/Cargo.toml`, `crates/oximemo-metadata/src/lib.rs`
- Modify: root `Cargo.toml` (members + workspace dep `oximemo-metadata`, `ureq` workspace dep)
- Modify: `apps/desktop/src-tauri/Cargo.toml` (add oximemo-metadata, drop reqwest), `apps/desktop/src-tauri/src/metadata.rs` (becomes thin re-export + doc), `apps/desktop/src-tauri/src/lib.rs` (spawn_blocking wrappers at search IPC)

**Interfaces:**
- Produces: `oximemo_metadata::{search_books, search_movies, enabled_providers}` — all **sync** (`pub fn search_books(cfg: &MetadataConfig, query: &str) -> Vec<MetaHit>`), plus `pub` adapters and `map_*` normalizers moved verbatim from desktop `metadata.rs` with `async fn` → `fn` and reqwest → ureq:

```rust
fn fetch_json<T: for<'de> Deserialize<'de>>(url: &str) -> anyhow::Result<T> {
    let resp = ureq::get(url)
        .set("User-Agent", concat!("oximemo/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(8))
        .call()?;
    Ok(resp.into_json()?)
}
```

- Desktop `metadata.rs` keeps `pub use oximemo_metadata::{enabled_providers, search_books, search_movies};` and the settings-facing types (`ProviderInfo` etc. already come from core). IPC `search_book_metadata`/`search_movie_metadata` become:

```rust
let hits = tokio::task::spawn_blocking({
    let cfg = cfg.clone(); let q = query.clone();
    move || oximemo_metadata::search_books(&cfg, &q)
}).await.map_err(|e| e.to_string())?;
```

- [ ] **Step 1:** Create crate; move code; move the tests module verbatim (map_* fixtures). `MetadataConfig` fields needed by provider_key are `pub` in core — confirm (`google_books_key` etc.).
- [ ] **Step 2:** `cargo test -p oximemo-metadata` green (normalizers + enabled_providers gate).
- [ ] **Step 3:** Desktop migration; `cargo test -p oximemo-desktop` green; reqwest gone from Cargo.toml.
- [ ] **Step 4:** `cargo check --workspace` green.
- [ ] **Step 5:** `git commit -m "refactor(metadata): shared sync adapter crate (ureq) for desktop + CLI"`

### Task 6: CLI — `metadata search` + `stamp`

**Files:**
- Modify: `crates/oximemo-cli/Cargo.toml` (oximemo-metadata dep), `main.rs`, `commands.rs`

**Interfaces:**
- Consumes: `oximemo_metadata::search_books/search_movies`, `Vault::with_config(|c| c.metadata.clone())`, `oximemo_core::metadata::{stamp_targets, MetaHit}`, `Vault::update_note_with`, `Vault::note_dto`/`get_memo`.
- Produces: `Metadata { Search { query, domain: String, format } }` and `Stamp { id, hit_stdin: bool }` variants; `cmd_metadata_search(vault, query, domain, fmt)`; `cmd_stamp(vault, id)` reading one MetaHit JSON from stdin. Stamp mirrors the IPC contract exactly: `stamp_targets(schema, &hit)` filtered by `!props.contains_key(k)`, then `source_url`/`cover_url` special cases, single `update_note_with` when non-empty.

- [ ] **Step 1: Failing tests:** stamp fills only empty props (pre-set `director` survives), stamps `source_url`+`cover_url` when schema declares them; metadata search on disabled config returns empty without network.
- [ ] **Step 2:** FAIL. **Step 3:** Implement (domain arg validated to book|movie via clap ValueEnum).
- [ ] **Step 4:** Pass. **Step 5:** `git commit -m "feat(cli): metadata search + stamp — provider grounding for agents"`

### Task 7: Copilot context block — folder map facts

**Files:**
- Modify: `apps/desktop/src-tauri/src/copilot.rs` (`build_context` + `FolderFact`), `apps/desktop/src-tauri/src/lib.rs` (copilot_send passes inventory)

**Interfaces:**
- Consumes: `Vault::folder_inventory`, `Vault::with_config(|c| c.daily.folder.clone())`.
- Produces: `build_context(vault_root, cli, skill, folders: &[FolderFact], daily_folder: Option<&str>, active, referenced)`; `pub struct FolderFact { path, notes, preset, workspace }`; `pub fn folder_facts(v: &Vault) -> (Vec<FolderFact>, Option<String>)` capped at 64 (+ count line). Context section:

```yaml
daily_folder: daily
folders:
  - path: knowledge
    notes: 12
    preset: knowledge
    workspace: 지식
```

- [ ] **Step 1: Failing tests** in copilot.rs tests: facts serialize under `folders:`; `path`/`workspace` pass through `single_line` (newline-crafted workspace name collapses); cap at 64 with `folders_omitted: N` line.
- [ ] **Step 2:** FAIL. **Step 3:** Implement + update copilot_send call site (spawn_blocking around inventory — it touches disk/index locks).
- [ ] **Step 4:** `cargo test -p oximemo-desktop` green (all existing context tests updated).
- [ ] **Step 5:** `git commit -m "feat(copilot): folder-map facts in the context block"`

### Task 8: SKILL.md + docs

**Files:**
- Modify: `skills/oximemo/SKILL.md` — new "Folders, schemas & collections" + "Metadata grounding" sections, updated command reference (folders/schema/collection/new --set/metadata/stamp), recipes ("Add a movie", "Create knowledge notes"), description triggers.
- Modify: `doc/DESIGN.md` §10.4 (copilot section — schema-awareness paragraph), `CHANGELOG.md` (Unreleased entry).

- [ ] Verify every command/flag documented matches shipped behavior (grep the Cmd enum after Tasks 2–6).
- [ ] `git commit -m "docs(skill): schema-aware vault contract — folders, collections, metadata"`

### Task 9: Verification

- [ ] `cargo test --workspace` + `cargo clippy --workspace -- -D warnings`
- [ ] `bun run build` (apps/desktop) — frontend untouched but CI parity.
- [ ] CLI end-to-end smoke on a temp vault: install collection → folders → schema → new --set (transition check) → metadata search shape (disabled → empty) → stamp round-trip.
- [ ] Real copilot turn (ignored test `real_omp_turn` updated path or a scripted `oxios run`): ask "지식 노트 2개 만들어줘" against a temp vault, assert schema-valid notes created. Run only if omp/oxios present; otherwise document skip.
