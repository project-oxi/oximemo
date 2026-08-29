//! Command implementations — thin adapters over [`oximemo_core::Vault`].

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use oximemo_core::Vault;
use oximemo_core::base::{BaseSource, RunBaseReq};
use oximemo_core::memo::{MemoFilter, MemoId};

use crate::format::{self, Format};

// -- space (spec 2026-08-28 §4) ------------------------------------------

/// `oximemo space list` — validated space dirs, `*` marks the active one.
pub fn cmd_space_list() -> Result<()> {
    let names = oximemo_core::spaces::list_spaces();
    let active = match oximemo_core::spaces::resolve_vault_spec(None, None)? {
        oximemo_core::spaces::VaultSpec::Space(n) => n,
        oximemo_core::spaces::VaultSpec::Explicit(_) => String::new(),
    };
    for n in names {
        let marker = if n == active { "* " } else { "  " };
        println!("{marker}{n}");
    }
    Ok(())
}

/// `oximemo space add <name>` — create (idempotent) + scaffold.
pub fn cmd_space_add(name: &str) -> Result<()> {
    let dir = oximemo_core::spaces::create_space(name)?;
    println!("vault dir: {}", dir.display());
    Ok(())
}

/// `oximemo space switch <name>` — record the selection.
pub fn cmd_space_switch(name: &str) -> Result<()> {
    let dir = oximemo_core::spaces::switch_space(name)?;
    println!("vault dir: {}", dir.display());
    Ok(())
}

/// `oximemo new` — capture a note from an argument or stdin.
///
/// `--tag` values are folded into the body as inline `#tag` tokens so the
/// derived model picks them up (the core no longer takes a tags argument).
pub fn cmd_new(
    vault: &Vault,
    text: Option<String>,
    tags: Vec<String>,
    folder: Option<String>,
    html: bool,
    sets: Vec<(String, oximemo_core::PropValue)>,
) -> Result<MemoId> {
    let mut body = match text {
        Some(t) => t,
        None => {
            use std::io::Read;
            let mut buf = String::new();
            std::io::stdin()
                .read_to_string(&mut buf)
                .context("read stdin")?;
            buf.trim_end().to_string()
        }
    };
    if !tags.is_empty() {
        let suffix = tags
            .iter()
            .map(|t| format!("#{}", t.trim().trim_start_matches('#')))
            .collect::<Vec<_>>()
            .join(" ");
        if body.is_empty() {
            body = suffix;
        } else {
            body.push_str("\n\n");
            body.push_str(&suffix);
        }
    }
    let fmt = if html {
        oximemo_core::memo::NoteFormat::Html
    } else {
        oximemo_core::memo::NoteFormat::Markdown
    };
    // An empty body is only acceptable when a folder template will fill it.
    if body.is_empty()
        && oximemo_core::template::load_template(
            vault.paths(),
            folder.as_deref().unwrap_or(""),
            fmt,
        )
        .is_none()
    {
        return Err(anyhow!("refusing to create an empty note"));
    }
    let note = vault.create_note(folder.as_deref().unwrap_or(""), body, fmt)?;
    let id = note.id;
    // Explicit properties ride the same write path as `update --set`:
    // schema transitions (peak_status, status_changed, …) fire exactly
    // as they do for a GUI property edit. The id is echoed only after
    // the note exists in its final shape.
    if !sets.is_empty() {
        vault.update_note_with(
            id,
            None,
            None,
            Some(oximemo_core::PropMutation {
                sets,
                removes: Vec::new(),
            }),
        )?;
    }
    println!("{id}");
    Ok(id)
}

/// `oximemo list`. Without `--where`/`--sort` this stays on the cursor
/// path (newest-first); either flag switches to the offset query path so
/// property sorts paginate correctly (design 2026-08-23 §5.2).
#[allow(clippy::too_many_arguments)]
pub fn cmd_list(
    vault: &Vault,
    limit: u32,
    tag: Vec<String>,
    folder: Option<String>,
    favorites: bool,
    predicates: Vec<oximemo_core::PropPredicate>,
    sort: Option<oximemo_core::SortSpec>,
    offset: u32,
    fmt: Format,
) -> Result<()> {
    let filter = MemoFilter {
        include_tags: tag,
        folder,
        match_all: false,
        favorites_only: favorites,
        ..Default::default()
    };
    if predicates.is_empty() && sort.is_none() {
        let page = vault.list_memos(None, limit, filter)?;
        return format::print_summaries(&page.items, fmt);
    }
    let query = oximemo_core::NoteQuery {
        filter,
        props: predicates,
        sort: sort.unwrap_or_default(),
        offset: offset as usize,
        limit,
    };
    let page = vault.query_notes(&query)?;
    if matches!(fmt, Format::Table) {
        // The table is a human summary; annotate the total so paged
        // property queries are self-describing.
        eprintln!("{} matches (offset {offset})", page.total);
    }
    format::print_summaries(&page.items, fmt)
}

/// `oximemo get`.
pub fn cmd_get(vault: &Vault, id: MemoId, md: bool) -> Result<()> {
    let note = vault.get_memo(id)?;
    if md {
        println!("{}", markdown_of(vault, id)?);
    } else {
        let summary: oximemo_core::memo::MemoSummary = oximemo_core::memo::MemoSummary::from(note);
        println!("{}", serde_json::to_string_pretty(&summary)?);
    }
    Ok(())
}

/// The exact on-disk representation (frontmatter + body) for `--md`,
/// read verbatim from the note's file. Uses [`Vault::note_file_path`]'s
/// live→trash fallback so a trashed note still prints instead of
/// erroring with a raw IO message.
fn markdown_of(vault: &Vault, id: MemoId) -> Result<String> {
    let note = vault.get_memo(id)?;
    let path = vault.note_file_path(&note).ok_or_else(|| {
        anyhow!(
            "note {} has no file on disk (neither live nor trash); it may have been purged",
            note.id
        )
    })?;
    Ok(std::fs::read_to_string(&path)?)
}

/// `oximemo search`.
pub fn cmd_search(vault: &Vault, query: String, limit: u32, fmt: Format) -> Result<()> {
    let hits = vault.search_memos(&query, limit)?;
    format::print_summaries(&hits, fmt)
}

/// `oximemo export` (§9.2). Manifest by default; `--full` includes bodies.
pub fn cmd_export(
    vault: &Vault,
    since: Option<String>,
    ids: Option<String>,
    ids_file: Option<PathBuf>,
    ids_stdin: bool,
    full: bool,
    fmt: Format,
) -> Result<()> {
    let mode = IdsMode::resolve(ids, ids_file, ids_stdin)?;

    match (&mode, full) {
        (IdsMode::All, false) => {
            let since = parse_since(since)?;
            let items = vault.export_manifest(since)?;
            format::print_manifest(&items, fmt)
        }
        (IdsMode::All, true) => {
            let since = parse_since(since)?;
            let manifest = vault.export_manifest(since)?;
            let ids: Vec<MemoId> = manifest.iter().map(|m| m.id).collect();
            let items = vault.export_full(&ids)?;
            format::print_full(&items, fmt)
        }
        (IdsMode::Some(ids), _) => {
            let items = vault.export_full(ids)?;
            format::print_full(&items, fmt)
        }
    }
}

/// `oximemo delete` — soft-delete (trash).
pub fn cmd_delete(vault: &Vault, id: MemoId) -> Result<()> {
    vault.delete_memo(id)?;
    println!("trashed {}", id);
    Ok(())
}

/// `oximemo purge` — hard-delete trashed memos older than the retention.
pub fn cmd_purge(vault: &Vault, older_than: Duration) -> Result<()> {
    let n = vault.purge(older_than)?;
    println!("purged {}", n);
    Ok(())
}

/// `oximemo reindex` — rebuild indexes from files.
pub fn cmd_reindex(vault: &Vault) -> Result<()> {
    let stats = vault.reindex()?;
    println!(
        "memos={} trashed_memos={} added={} updated={} unchanged={} failed={}",
        stats.memos, stats.trashed_memos, stats.added, stats.updated, stats.unchanged, stats.failed
    );
    Ok(())
}

/// `oximemo vault path`.
pub fn cmd_vault_path(vault: &Vault) -> Result<()> {
    println!("{}", vault.paths().vault.display());
    Ok(())
}

/// `oximemo doctor [--fix]`.
pub fn cmd_doctor(vault: &Vault, fix: bool) -> Result<()> {
    let report = vault.doctor(fix)?;
    let json = serde_json::to_string_pretty(&report)?;
    println!("{json}");
    Ok(())
}

/// `oximemo update` — edit an existing note's body, favorite flag, or
/// properties (`--set/--unset`).
pub fn cmd_update(
    vault: &Vault,
    id: MemoId,
    body: Option<String>,
    body_stdin: bool,
    favorite: Option<bool>,
    props: Option<oximemo_core::PropMutation>,
) -> Result<()> {
    let body = if body_stdin {
        Some(read_stdin()?)
    } else {
        body
    };
    if body.is_none() && favorite.is_none() && props.as_ref().is_none_or(|p| p.is_empty()) {
        return Err(anyhow!(
            "no changes specified; pass --body/--body-stdin, --favorite/--unfavorite, or --set/--unset"
        ));
    }
    let note = vault.update_note_with(id, body, favorite, props)?;
    let summary: oximemo_core::memo::MemoSummary = oximemo_core::memo::MemoSummary::from(note);
    println!("{}", serde_json::to_string_pretty(&summary)?);
    Ok(())
}

/// `oximemo restore` — un-delete a trashed memo.
pub fn cmd_restore(vault: &Vault, id: MemoId) -> Result<()> {
    let note = vault.restore_memo(id)?;
    let summary: oximemo_core::memo::MemoSummary = oximemo_core::memo::MemoSummary::from(note);
    println!("{}", serde_json::to_string_pretty(&summary)?);
    Ok(())
}

/// `oximemo stats` — live memo counts.
pub fn cmd_stats(vault: &Vault) -> Result<()> {
    let stats = vault.memo_stats()?;
    println!("{}", serde_json::to_string_pretty(&stats)?);
    Ok(())
}

// --- vault self-description (copilot schema-awareness 2026-08-24) -------

/// One row of `oximemo folders`: inventory facts plus the `daily` flag
/// (the config-driven daily folder — the one folder whose path is not
/// discoverable from disk alone).
#[derive(Debug, Clone, serde::Serialize)]
pub struct FolderRow {
    pub path: String,
    pub notes: u32,
    pub preset: Option<String>,
    pub workspace: Option<String>,
    /// True when this folder is the configured `[daily] folder`.
    pub daily: bool,
}

pub fn folder_rows(vault: &Vault) -> Result<Vec<FolderRow>> {
    let daily = vault.with_config(|c| c.daily.folder.clone());
    Ok(vault
        .folder_inventory()?
        .into_iter()
        .map(|f| FolderRow {
            daily: !daily.is_empty() && f.path == daily,
            path: f.path,
            notes: f.notes,
            preset: f.preset,
            workspace: f.workspace,
        })
        .collect())
}

/// `oximemo folders` — the vault's folder map. Table for humans,
/// json/ndjson for agents (same facts).
pub fn cmd_folders(vault: &Vault, fmt: crate::format::Format) -> Result<()> {
    let rows = folder_rows(vault)?;
    match fmt {
        crate::format::Format::Table => {
            println!("{:<24} {:>5}  SCHEMA", "FOLDER", "NOTES");
            for r in &rows {
                let schema = match (&r.preset, &r.workspace) {
                    (Some(p), Some(w)) => format!("{w} ({p})"),
                    (Some(p), None) => p.clone(),
                    (None, Some(w)) => w.clone(),
                    (None, None) => "-".to_string(),
                };
                let daily = if r.daily { " ·daily" } else { "" };
                println!("{:<24} {:>5}  {}{}", r.path, r.notes, schema, daily);
            }
        }
        crate::format::Format::Json => println!("{}", serde_json::to_string_pretty(&rows)?),
        crate::format::Format::Ndjson => {
            for r in &rows {
                println!("{}", serde_json::to_string(r)?);
            }
        }
    }
    Ok(())
}

/// `oximemo schema` report: everything an agent needs to know about
/// what a note in this folder looks like — the parsed schema (or null
/// for free-property mode) and the raw template a new note starts from.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SchemaReport {
    pub folder: String,
    pub preset: Option<String>,
    pub workspace: Option<String>,
    /// Parsed SCHEMA.toml, or null when the folder has none.
    pub schema: Option<oximemo_core::FolderSchema>,
    /// Raw TEMPLATE.md (or TEMPLATE.html) content, or null.
    pub template: Option<String>,
}

/// Build the report for `folder` ("" = vault root). `Ok(None)` when the
/// folder does not exist on disk — the command turns that into an error.
pub fn schema_report(vault: &Vault, folder: &str) -> Result<Option<SchemaReport>> {
    let folder = folder.trim_end_matches('/');
    let dir = if folder.is_empty() {
        vault.paths().vault.clone()
    } else {
        vault.paths().vault.join(folder)
    };
    if !dir.is_dir() {
        return Ok(None);
    }
    let schema = vault.folder_schema(folder)?;
    let preset = schema.as_ref().and_then(|s| s.meta.preset.clone());
    let workspace = schema.as_ref().and_then(|s| s.workspace.name.clone());
    let template = [
        oximemo_core::paths::TEMPLATE_NAME,
        oximemo_core::paths::TEMPLATE_HTML_NAME,
    ]
    .into_iter()
    .find_map(|name| std::fs::read_to_string(dir.join(name)).ok())
    .filter(|t| !t.trim().is_empty());
    Ok(Some(SchemaReport {
        folder: folder.to_string(),
        preset,
        workspace,
        schema,
        template,
    }))
}

/// `oximemo schema [FOLDER]` — JSON only (the consumer is an agent or
/// a script; humans read the folder's SCHEMA.toml directly).
pub fn cmd_schema(vault: &Vault, folder: Option<String>) -> Result<()> {
    let folder = folder.unwrap_or_default();
    match schema_report(vault, &folder)? {
        Some(report) => {
            println!("{}", serde_json::to_string_pretty(&report)?);
            Ok(())
        }
        None => Err(anyhow!("no such folder: {}", folder)),
    }
}

/// Installable collection presets: `(id, workspace name)`. The names
/// are parsed from the preset schemas themselves — one source of truth
/// with the GUI catalog.
pub fn collection_catalog() -> Vec<(&'static str, String)> {
    [
        "knowledge",
        "daily",
        "book",
        "movie",
        "blog",
        "novel",
        "idea",
    ]
    .into_iter()
    .filter_map(|id| {
        let (_, schema_toml) = oximemo_core::schema::collection_preset(id)?;
        let name = oximemo_core::schema::parse_schema(schema_toml)
            .ok()
            .and_then(|s| s.workspace.name)
            .unwrap_or_else(|| id.to_string());
        Some((id, name))
    })
    .collect()
}

/// `oximemo collection list` — the installable catalog (JSON).
pub fn cmd_collection_list() -> Result<()> {
    let catalog: Vec<serde_json::Value> = collection_catalog()
        .into_iter()
        .map(|(id, name)| serde_json::json!({ "id": id, "name": name }))
        .collect();
    println!("{}", serde_json::to_string_pretty(&catalog)?);
    Ok(())
}

/// Search domain for [`metadata_search`] — mirrors the GUI's two
/// metadata panels.
#[derive(Debug, Clone, Copy, clap::ValueEnum)]
pub enum MetadataDomain {
    Book,
    Movie,
}

/// `oximemo metadata search` — provider-grounded facts using the
/// user's own `[metadata]` config (enabled + keys), exactly as the GUI
/// 채우기 flow does. Disabled config ⇒ empty list.
pub fn metadata_search(
    vault: &Vault,
    domain: MetadataDomain,
    query: &str,
) -> Result<Vec<oximemo_core::metadata::MetaHit>> {
    let cfg = vault.with_config(|c| c.metadata.clone());
    Ok(match domain {
        MetadataDomain::Book => oximemo_metadata::search_books(&cfg, query),
        MetadataDomain::Movie => oximemo_metadata::search_movies(&cfg, query),
    })
}

/// `oximemo metadata search` printing — ndjson default (agents), json
/// for eyeballing.
pub fn cmd_metadata_search(
    vault: &Vault,
    domain: MetadataDomain,
    query: &str,
    fmt: crate::format::Format,
) -> Result<()> {
    let hits = metadata_search(vault, domain, query)?;
    match fmt {
        crate::format::Format::Json => println!("{}", serde_json::to_string_pretty(&hits)?),
        _ => {
            for h in &hits {
                println!("{}", serde_json::to_string(h)?);
            }
        }
    }
    Ok(())
}

/// `oximemo stamp <ID> --hit-stdin` — stamp a chosen MetaHit onto a
/// note. Identical contract to the GUI stamp (spec 2026-08-23 §3.5):
/// core `stamp_targets` fills only schema-declared, still-empty mapped
/// props; `source_url`/`cover_url` land only when the schema declares
/// them and nothing occupies them. Ratings never map.
pub fn cmd_stamp(vault: &Vault, id: MemoId, hit: &oximemo_core::metadata::MetaHit) -> Result<()> {
    let memo = vault.get_memo(id)?;
    let dto = vault.note_dto(&memo);
    let schema = vault.folder_schema(&dto.folder)?.unwrap_or_default();
    let mut sets: Vec<(String, oximemo_core::PropValue)> =
        oximemo_core::metadata::stamp_targets(&schema, hit)
            .into_iter()
            .filter(|(k, _)| !memo.props.contains_key(k))
            .collect();
    if let (Some(url), false) = (&hit.url, memo.props.contains_key("source_url"))
        && schema.properties.contains_key("source_url")
    {
        sets.push((
            "source_url".into(),
            oximemo_core::PropValue::Str(url.clone()),
        ));
    }
    if let (Some(cover), false) = (&hit.cover_url, memo.props.contains_key("cover_url"))
        && schema.properties.contains_key("cover_url")
    {
        sets.push((
            "cover_url".into(),
            oximemo_core::PropValue::Str(cover.clone()),
        ));
    }
    if sets.is_empty() {
        return Ok(());
    }
    vault.update_note_with(
        id,
        None,
        None,
        Some(oximemo_core::props::PropMutation {
            sets,
            removes: Vec::new(),
        }),
    )?;
    Ok(())
}

/// `oximemo stamp` entry — reads one MetaHit JSON document from stdin.
pub fn cmd_stamp_stdin(vault: &Vault, id: MemoId) -> Result<()> {
    let raw = read_stdin()?;
    let hit: oximemo_core::metadata::MetaHit =
        serde_json::from_str(&raw).context("stdin is not a MetaHit JSON document")?;
    cmd_stamp(vault, id, &hit)
}

/// `oximemo collection install <PRESET> <FOLDER>` — same skip-if-exists
/// semantics as the GUI flow (`Vault::install_collection`).
pub fn cmd_collection_install(vault: &Vault, id: &str, folder: &str) -> Result<()> {
    if oximemo_core::schema::collection_preset(id).is_none() {
        let ids: Vec<&str> = collection_catalog().iter().map(|(i, _)| *i).collect();
        return Err(anyhow!(
            "unknown collection preset '{id}' (valid: {})",
            ids.join(", ")
        ));
    }
    vault.install_collection(id, folder)?;
    println!("installed {id} collection at {folder}");
    Ok(())
}

// --- .query bases (spec 2026-08-25 §3) -----------------------------------

/// One row of `oximemo base list` in json/ndjson modes — mirrors the
/// desktop wire shape (`mtime` as epoch millis).
#[derive(Debug, Clone, serde::Serialize)]
pub struct BaseListRow {
    pub path: String,
    pub name: String,
    pub mtime_ms: u64,
    pub loadable: bool,
}

/// `oximemo base list [--format table|json|ndjson]` — the vault's
/// `.query` bases. Table for humans, json/ndjson for agents (same
/// facts as `folders`).
pub fn cmd_base_list(vault: &Vault, fmt: Format) -> Result<()> {
    let bases = vault.list_bases()?;
    match fmt {
        Format::Table => print!("{}", format::format_base_list_table(&bases)),
        Format::Json => {
            let rows: Vec<BaseListRow> = bases.iter().map(base_list_row).collect();
            println!("{}", serde_json::to_string_pretty(&rows)?);
        }
        Format::Ndjson => {
            for b in &bases {
                println!("{}", serde_json::to_string(&base_list_row(b))?);
            }
        }
    }
    Ok(())
}

fn base_list_row(b: &oximemo_core::base::BaseInfo) -> BaseListRow {
    BaseListRow {
        path: b.path.clone(),
        name: b.name.clone(),
        mtime_ms: b
            .mtime
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
        loadable: b.loadable,
    }
}

/// `oximemo base run <PATH> [--view N] [--limit N] [--offset N]` —
/// execute one page of a `.query` view and print the table. Warnings
/// ride the page, so they go to stderr where scripts can ignore them.
pub fn cmd_base_run(
    vault: &Vault,
    path: &str,
    view: Option<usize>,
    limit: u32,
    offset: usize,
) -> Result<()> {
    let req = RunBaseReq {
        view_index: view.unwrap_or(0),
        offset,
        limit,
        group: None,
        now_ms: None,
        local_offset_seconds: None,
        include_group_counts: true,
        include_summaries: false,
        this_id: None,
    };
    let page = vault.run_base(&BaseSource::Path(path.to_string()), &req)?;
    // Header context from the same def run_base used (mtime-cached
    // read — no second parse).
    let def = vault.load_base(path)?;
    let view_def = def.views.get(req.view_index);
    let view_name = view_def
        .and_then(|v| v.name.clone())
        .unwrap_or_else(|| format!("view {}", req.view_index));
    let columns = view_def
        .map(oximemo_core::base::default_columns)
        .unwrap_or_default();
    for w in &page.warnings {
        eprintln!("warning: {w}");
    }
    if columns.len() > format::BASE_TABLE_MAX_COLUMNS {
        eprintln!(
            "note: showing first {} of {} columns",
            format::BASE_TABLE_MAX_COLUMNS,
            columns.len()
        );
    }
    print!(
        "{}",
        format::format_base_table(path, &view_name, &columns, &page)
    );
    Ok(())
}

/// `oximemo base rename <FROM> <TO>` — moves a `.query` file (the
/// destination must not exist).
pub fn cmd_base_rename(vault: &Vault, from: &str, to: &str) -> Result<()> {
    vault.rename_base(from, to, None)?;
    println!("renamed {from} -> {to}");
    Ok(())
}

/// `oximemo base trash <PATH>` — prints the restore token (single
/// stdout line; pipe it straight into `base restore`).
pub fn cmd_base_trash(vault: &Vault, path: &str) -> Result<()> {
    let token = vault.trash_base(path)?;
    println!("{token}");
    Ok(())
}

/// `oximemo base restore <TOKEN>` — prints the restored file's
/// vault-relative path.
pub fn cmd_base_restore(vault: &Vault, token: &str) -> Result<()> {
    let rel = vault.restore_base(token)?;
    println!("{rel}");
    Ok(())
}

// --- tasks (spec 2026-08-27) ---------------------------------------------

use oximemo_core::tasks::{
    AddTarget, DateField, Priority, StatusType, TaskEdit, TaskFields, TaskLineHash, TaskSelector,
};

/// Stale-write guard choice for the mutating `task` subcommands,
/// resolved from `--hash H` (guarded) XOR `--force` (last-writer-wins)
/// in `main::dispatch_task`.
pub enum TaskGuard {
    Hash(TaskLineHash),
    Force,
}

/// `task list` flags (already-validated strings stay strings; parse
/// errors surface as CLI errors here, close to the flag definition).
pub struct TaskListArgs<'a> {
    pub where_: Option<&'a str>,
    pub note: Option<&'a str>,
    pub folder: Option<&'a str>,
    pub due: Option<&'a str>,
    pub status: Option<&'a str>,
    pub not_done: bool,
    pub limit: usize,
    pub format: &'a str,
}

/// `task add` flags.
pub struct TaskAddArgs<'a> {
    pub note: Option<&'a str>,
    /// `--daily [DATE]`: `None` = flag absent, `Some("today")` = bare
    /// flag, `Some(date)` = explicit.
    pub daily: Option<&'a str>,
    pub inbox: bool,
    pub section: Option<&'a str>,
    pub due: Option<&'a str>,
    pub scheduled: Option<&'a str>,
    pub start: Option<&'a str>,
    pub priority: Option<&'a str>,
    pub repeat: Option<&'a str>,
    pub tags: &'a [String],
}

/// Shared shape of `task done|status|edit|rm`.
pub struct TaskPatchArgs<'a> {
    pub note_id: &'a str,
    pub line: u32,
    pub guard: TaskGuard,
    pub edit: TaskEdit,
}

/// Parse the edit kind + optional value into a [`TaskEdit`]. Called
/// from `dispatch_task` with the canonical kind strings.
pub fn parse_task_edit(kind: &str, value: Option<&str>) -> Result<TaskEdit> {
    Ok(match kind {
        "toggle" => TaskEdit::Toggle,
        "status" => {
            let raw = value.ok_or_else(|| anyhow!("status requires a symbol"))?;
            let mut chars = raw.chars();
            let symbol = chars
                .next()
                .ok_or_else(|| anyhow!("status symbol must be one character"))?;
            if chars.next().is_some() {
                return Err(anyhow!("status symbol must be one character, got {raw:?}"));
            }
            TaskEdit::SetStatus(symbol)
        }
        "set-due" => TaskEdit::SetDate {
            field: DateField::Due,
            value: Some(parse_task_date(value.unwrap_or_default())?),
        },
        "clear-due" => TaskEdit::SetDate {
            field: DateField::Due,
            value: None,
        },
        "set-text" => TaskEdit::SetText(
            value
                .ok_or_else(|| anyhow!("--set-text requires TEXT"))?
                .to_string(),
        ),
        "set-priority" => {
            TaskEdit::SetPriority(parse_priority_word_cli(value.unwrap_or_default())?)
        }
        "set-repeat" => TaskEdit::SetRecurrence(Some(
            value
                .ok_or_else(|| anyhow!("--set-repeat requires RULE"))?
                .to_string(),
        )),
        "clear-repeat" => TaskEdit::SetRecurrence(None),
        "rm" => TaskEdit::Delete,
        other => return Err(anyhow!("unknown task edit kind: {other}")),
    })
}

/// Parse a 16-char lowercase-hex line hash (as printed by `task list`).
pub fn parse_line_hash(s: &str) -> Result<TaskLineHash> {
    let ok = s.len() == 16
        && s.chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase());
    if !ok {
        return Err(anyhow!(
            "invalid --hash {s:?}: expected 16 lowercase hex chars"
        ));
    }
    Ok(TaskLineHash(s.to_string()))
}

fn parse_task_date(s: &str) -> Result<time::Date> {
    oximemo_core::template::parse_iso_date(s)
        .ok_or_else(|| anyhow!("invalid date {s:?}: expected YYYY-MM-DD"))
}

fn parse_priority_word_cli(s: &str) -> Result<Priority> {
    match s.trim().to_ascii_lowercase().as_str() {
        "none" => Ok(Priority::None),
        "lowest" => Ok(Priority::Lowest),
        "low" => Ok(Priority::Low),
        "medium" => Ok(Priority::Medium),
        "high" => Ok(Priority::High),
        "highest" => Ok(Priority::Highest),
        other => Err(anyhow!(
            "invalid priority {other:?}: expected none|lowest|low|medium|high|highest"
        )),
    }
}

/// Local "today" for task date semantics (date-only, local per spec §1).
fn local_today() -> time::Date {
    let offset = time::UtcOffset::current_local_offset().unwrap_or(time::UtcOffset::UTC);
    time::OffsetDateTime::now_utc().to_offset(offset).date()
}

pub fn cmd_task_list(vault: &Vault, args: &TaskListArgs) -> Result<()> {
    let out = task_list_dtos(vault, args)?;
    match args.format {
        "json" => println!("{}", serde_json::to_string_pretty(&out)?),
        "md" => {
            for dto in &out {
                let memo = vault.get_memo(dto.task_ref.memo_id)?;
                // Live re-read at print time: TaskRow deliberately
                // stores no raw source text.
                if let Some(raw) = memo.body.lines().nth(dto.task_ref.line as usize) {
                    println!("{raw}");
                }
            }
        }
        _ => print!("{}", format::format_task_table(&out)),
    }
    Ok(())
}

/// Collect matching task DTOs (`cmd_task_list` minus the printing).
pub fn task_list_dtos(
    vault: &Vault,
    args: &TaskListArgs,
) -> Result<Vec<oximemo_core::tasks::TaskDto>> {
    // Note-level `--where` runs through the expr engine against each
    // candidate's NOTE record (RowData::from_record, no task scope).
    // `task.*` does NOT resolve here: task-level expressions land with
    // the query-engine plan (Plan B), which extends RowData with a
    // task namespace. Until then --due/--status/--not-done are the
    // dedicated task-level filters.
    let note_expr = match args.where_ {
        Some(src) => Some(
            oximemo_core::expr::parser::parse_expr(src)
                .map_err(|e| anyhow!("invalid --where: {e}"))?,
        ),
        None => None,
    };
    let note_id = match args.note {
        Some(id) => Some(MemoId::parse(id).map_err(|e| anyhow!("invalid --note id: {e}"))?),
        None => None,
    };
    let due_filter = match args.due {
        Some(spec) => Some(parse_due_filter(spec)?),
        None => None,
    };
    let status_filter = match args.status {
        Some(s) => Some(parse_status_filter(s)?),
        None => None,
    };

    let clock = oximemo_core::expr::eval::EvalClock {
        now_utc: time::OffsetDateTime::now_utc(),
        local: time::UtcOffset::current_local_offset().unwrap_or(time::UtcOffset::UTC),
    };
    let ctx = oximemo_core::expr::eval::EvalCtx {
        clock: &clock,
        depth: std::cell::Cell::new(0),
    };
    let no_formulas: std::collections::HashMap<
        String,
        Result<oximemo_core::expr::value::Value, oximemo_core::CoreError>,
    > = std::collections::HashMap::new();

    let snapshot = vault.snapshot()?;
    let mut out: Vec<oximemo_core::tasks::TaskDto> = Vec::new();
    'notes: for rec in snapshot.iter() {
        if rec.deleted {
            continue;
        }
        if let Some(id) = note_id
            && rec.id != id
        {
            continue;
        }
        if let Some(prefix) = args.folder
// folder prefix match: "novel" covers "novel/act1"
            && !rec.path.starts_with(prefix)
        {
            continue;
        }
        if let Some(expr) = &note_expr {
            let row = oximemo_core::expr::eval::RowData::from_record(rec, &no_formulas, None);
            match oximemo_core::expr::eval::eval(expr, &row, &ctx) {
                Ok(oximemo_core::expr::value::Value::Bool(true)) => {}
                Ok(_) => continue 'notes,
                // An expression that PARSED but fails to evaluate
                // (type mismatch against a concrete note) must surface,
                // not silently filter the note away — a mistyped
                // comparison would otherwise quietly empty the list.
                Err(e) => {
                    return Err(anyhow!("--where failed on note {}: {e}", rec.id));
                }
            }
        }
        for task in &rec.tasks {
            if out.len() >= args.limit {
                break 'notes;
            }
            if args.not_done && task.status_type.is_done_family() {
                continue;
            }
            if let Some(want) = status_filter
                && task.status_type != want
            {
                continue;
            }
            if let Some(filter) = due_filter.as_ref()
                && !filter.matches(task.due)
            {
                continue;
            }
            out.push(oximemo_core::tasks::TaskDto::from_row(rec.id, task));
        }
    }

    Ok(out)
}

enum DueFilter {
    Before(time::Date),
    After(time::Date),
    On(time::Date),
}

impl DueFilter {
    fn matches(&self, due: Option<time::Date>) -> bool {
        match (self, due) {
            (_, None) => false,
            (DueFilter::Before(d), Some(x)) => x < *d,
            (DueFilter::After(d), Some(x)) => x > *d,
            (DueFilter::On(d), Some(x)) => x == *d,
        }
    }
}

fn parse_due_filter(spec: &str) -> Result<DueFilter> {
    let (op, date) = spec.split_once(':').ok_or_else(|| {
        anyhow!("invalid --due {spec:?}: expected before:DATE|after:DATE|on:DATE")
    })?;
    let d = parse_task_date(date.trim())?;
    match op.trim().to_ascii_lowercase().as_str() {
        "before" => Ok(DueFilter::Before(d)),
        "after" => Ok(DueFilter::After(d)),
        "on" => Ok(DueFilter::On(d)),
        other => Err(anyhow!("invalid --due op {other:?}: before|after|on")),
    }
}

fn parse_status_filter(s: &str) -> Result<StatusType> {
    let norm = s.trim().to_ascii_lowercase().replace('_', "");
    match norm.as_str() {
        "todo" => Ok(StatusType::Todo),
        "inprogress" => Ok(StatusType::InProgress),
        "onhold" => Ok(StatusType::OnHold),
        "done" => Ok(StatusType::Done),
        "cancelled" => Ok(StatusType::Cancelled),
        other => Err(anyhow!(
            "invalid --status {other:?}: todo|in_progress|on_hold|done|cancelled"
        )),
    }
}

/// `oximemo task add` — prints the created task DTO (pretty JSON).
pub fn cmd_task_add(vault: &Vault, text: &str, args: &TaskAddArgs) -> Result<()> {
    let provided = [args.note.is_some(), args.daily.is_some(), args.inbox]
        .iter()
        .filter(|&&b| b)
        .count();
    if provided > 1 {
        return Err(anyhow!("only one of --note / --daily / --inbox"));
    }
    let target = if let Some(id) = args.note {
        AddTarget::Note(MemoId::parse(id).map_err(|e| anyhow!("invalid --note id: {e}"))?)
    } else if args.daily.is_some() {
        let raw = args.daily.unwrap_or("today");
        let date = if raw == "today" {
            local_today()
        } else {
            parse_task_date(raw)?
        };
        AddTarget::Daily(date)
    } else if args.inbox {
        AddTarget::Inbox
    } else {
        // No flag: follow the configured capture routing.
        match vault.with_config(|c| c.tasks.capture_target) {
            oximemo_core::tasks::CaptureTarget::Daily => AddTarget::Daily(local_today()),
            oximemo_core::tasks::CaptureTarget::Inbox => AddTarget::Inbox,
        }
    };
    let result = if let Some(section) = args.section {
        // One-shot heading override via the core's dedicated API —
        // the persisted [tasks] config is never touched (an earlier
        // swap-and-restore of the config here was crash-vulnerable:
        // a failure between the two saves stranded the user's
        // default_section modified).
        vault.add_task_with_section(
            target,
            text.to_string(),
            task_fields(args)?,
            local_today(),
            section,
        )?
    } else {
        vault.add_task(target, text.to_string(), task_fields(args)?, local_today())?
    };
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}

fn task_fields(args: &TaskAddArgs) -> Result<TaskFields> {
    Ok(TaskFields {
        created: None,
        start: args.start.map(parse_task_date).transpose()?,
        scheduled: args.scheduled.map(parse_task_date).transpose()?,
        due: args.due.map(parse_task_date).transpose()?,
        priority: match args.priority {
            Some(word) => parse_priority_word_cli(word)?,
            None => Priority::None,
        },
        recurrence: args.repeat.map(str::to_string),
        tags: args.tags.to_vec(),
    })
}

/// Shared runner for `task done|status|edit|rm` — prints the
/// `PatchTaskResult` pretty JSON on success.
pub fn cmd_task_patch(vault: &Vault, args: &TaskPatchArgs) -> Result<()> {
    let memo_id = MemoId::parse(args.note_id).map_err(|e| anyhow!("invalid note id: {e}"))?;
    let selector = match &args.guard {
        TaskGuard::Hash(h) => TaskSelector::Exact(oximemo_core::tasks::TaskRef {
            memo_id,
            line: args.line,
            line_hash: h.clone(),
        }),
        TaskGuard::Force => TaskSelector::CurrentLine {
            memo_id,
            line: args.line,
        },
    };
    let result = vault.patch_task(selector, args.edit.clone(), local_today())?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}

/// `oximemo task rollover [--from DATE] [--to DATE] [--dry-run]` —
/// move every not-done task from an older daily note into a newer
/// one. A missing source daily note is zero candidates, not an error.
pub fn cmd_task_rollover(
    vault: &Vault,
    from: Option<&str>,
    to: Option<&str>,
    dry_run: bool,
) -> Result<()> {
    let today = local_today();
    let from_date = match from {
        Some(s) => parse_task_date(s)?,
        None => today.previous_day().unwrap_or(today),
    };
    let to_date = match to {
        Some(s) => parse_task_date(s)?,
        None => today,
    };
    if from_date == to_date {
        return Err(anyhow!(
            "--from and --to are the same date ({to_date}); rollover needs two different days"
        ));
    }

    // Locate the source daily note by its canonical path (md or html).
    let folder = vault.with_config(|c| c.daily.folder.trim_end_matches('/').to_string());
    let md_path = format!("{folder}/{}.md", format_date_yyyy_mm_dd(from_date));
    let html_path = format!("{folder}/{}.html", format_date_yyyy_mm_dd(from_date));
    let snapshot = vault.snapshot()?;
    let source_rec = snapshot
        .iter()
        .find(|r| !r.deleted && (r.path == md_path || r.path == html_path));

    let candidates: Vec<oximemo_core::tasks::TaskRef> = match source_rec {
        None => Vec::new(),
        Some(rec) => rec
            .tasks
            .iter()
            .filter(|t| !t.status_type.is_done_family())
            .map(|t| oximemo_core::tasks::TaskRef {
                memo_id: rec.id,
                line: t.line,
                line_hash: t.line_hash.clone(),
            })
            .collect(),
    };

    if dry_run {
        let preview: Vec<&oximemo_core::tasks::TaskRef> = candidates.iter().collect();
        println!("{}", serde_json::to_string_pretty(&preview)?);
        return Ok(());
    }
    if candidates.is_empty() {
        println!("[]");
        return Ok(());
    }
    let source_id = source_rec.map(|r| r.id).unwrap();
    let receipt = vault.move_tasks(
        oximemo_core::tasks::MoveTasksRequest {
            source: source_id,
            tasks: candidates,
            destination: AddTarget::Daily(to_date),
            // Rollover always accepts today's current daily-note state
            // (or its first creation).
            expected_destination_hash: None,
        },
        today,
    )?;
    println!("{}", serde_json::to_string_pretty(&receipt)?);
    Ok(())
}

fn format_date_yyyy_mm_dd(d: time::Date) -> String {
    format!("{:04}-{:02}-{:02}", d.year(), u8::from(d.month()), d.day())
}

/// Read all of stdin, trimming a single trailing newline.
fn read_stdin() -> Result<String> {
    use std::io::Read;
    let mut buf = String::new();
    std::io::stdin()
        .read_to_string(&mut buf)
        .context("read stdin")?;
    Ok(buf.trim_end().to_string())
}

// --- helpers ----------------------------------------------------------

enum IdsMode {
    All,
    Some(Vec<MemoId>),
}

impl IdsMode {
    fn resolve(ids: Option<String>, ids_file: Option<PathBuf>, ids_stdin: bool) -> Result<Self> {
        let provided = [ids.is_some(), ids_file.is_some(), ids_stdin]
            .iter()
            .filter(|&&b| b)
            .count();
        if provided > 1 {
            return Err(anyhow!(
                "only one of --ids / --ids-file / --ids-stdin may be used"
            ));
        }
        if let Some(csv) = ids {
            let v = parse_ids(csv.split(',').map(str::trim))?;
            return Ok(Self::Some(v));
        }
        if let Some(path) = ids_file {
            let text = std::fs::read_to_string(&path)
                .with_context(|| format!("read {}", path.display()))?;
            let v = parse_ids(text.lines().map(str::trim))?;
            return Ok(Self::Some(v));
        }
        if ids_stdin {
            use std::io::Read;
            let mut buf = String::new();
            std::io::stdin().read_to_string(&mut buf)?;
            let v = parse_ids(buf.lines().map(str::trim))?;
            return Ok(Self::Some(v));
        }
        Ok(Self::All)
    }
}

fn parse_ids<'a, I: Iterator<Item = &'a str>>(it: I) -> Result<Vec<MemoId>> {
    let mut out = Vec::new();
    for s in it {
        if s.is_empty() {
            continue;
        }
        out.push(MemoId::parse(s).with_context(|| format!("invalid id: {s}"))?);
    }
    Ok(out)
}

fn parse_since(s: Option<String>) -> Result<Option<time::OffsetDateTime>> {
    use time::format_description::well_known::Rfc3339;
    match s {
        None => Ok(None),
        Some(t) => Ok(Some(
            time::OffsetDateTime::parse(&t, &Rfc3339)
                .with_context(|| format!("parse --since: {t}"))?,
        )),
    }
}

/// Parse a short duration like `30d`, `12h`, `45m`.
pub fn parse_duration(s: &str) -> Result<Duration> {
    let s = s.trim();
    if s.is_empty() {
        return Err(anyhow!("empty duration"));
    }
    let (num, unit) = s.split_at(s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len()));
    let n: u64 = num.parse().context("duration number")?;
    let secs = match unit {
        "d" | "D" => n * 86400,
        "h" | "H" => n * 3600,
        "m" | "M" => n * 60,
        "s" | "S" | "" => n,
        other => return Err(anyhow!("unknown duration unit: {other} (use d/h/m/s)")),
    };
    Ok(Duration::from_secs(secs))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TmpVault {
        vault: Vault,
        dir: std::path::PathBuf,
    }

    impl TmpVault {
        fn new() -> Self {
            let _ = oximemo_core::paths::isolate_index_root_for_tests();
            use std::sync::atomic::{AtomicU64, Ordering};
            static N: AtomicU64 = AtomicU64::new(0);
            let dir = std::env::temp_dir().join(format!(
                "oximemo-cli-test-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::SeqCst)
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let vault = Vault::open(Some(&dir)).unwrap();
            vault.ensure_initialized().unwrap();
            vault.migrate().unwrap();
            Self { vault, dir }
        }
        fn v(&self) -> &Vault {
            &self.vault
        }
        fn dir(&self) -> &std::path::Path {
            &self.dir
        }
    }

    impl Drop for TmpVault {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn make_memo(vault: &Vault, body: &str) -> MemoId {
        vault.create_memo(body.to_string(), None).unwrap().id
    }

    #[test]
    fn update_body_and_favorite() {
        let t = TmpVault::new();
        let id = make_memo(t.v(), "first body");

        cmd_update(t.v(), id, None, false, Some(true), None).unwrap();
        let after = t.v().get_memo(id).unwrap();
        assert!(after.favorite);
        assert_eq!(after.body, "first body");

        cmd_update(
            t.v(),
            id,
            Some("new body #urgent".into()),
            false,
            None,
            None,
        )
        .unwrap();
        let after = t.v().get_memo(id).unwrap();
        assert_eq!(after.body, "new body #urgent");
        assert!(after.tags.iter().any(|x| x == "urgent"));
    }

    #[test]
    fn update_without_changes_is_an_error() {
        let t = TmpVault::new();
        let id = make_memo(t.v(), "x");
        assert!(cmd_update(t.v(), id, None, false, None, None).is_err());
    }

    #[test]
    fn restore_revives_a_trashed_memo() {
        let t = TmpVault::new();
        let id = make_memo(t.v(), "to be deleted");
        t.v().delete_memo(id).unwrap();
        assert!(t.v().get_memo(id).unwrap().deleted_at.is_some());
        cmd_restore(t.v(), id).unwrap();
        assert!(t.v().get_memo(id).unwrap().deleted_at.is_none());
    }

    #[test]
    fn stats_counts_memos_and_favorites() {
        let t = TmpVault::new();
        make_memo(t.v(), "a");
        make_memo(t.v(), "b");
        cmd_update(
            t.v(),
            make_memo(t.v(), "fav"),
            None,
            false,
            Some(true),
            None,
        )
        .unwrap();
        cmd_stats(t.v()).unwrap();
        let s = t.v().memo_stats().unwrap();
        assert_eq!(s.memos, 3);
        assert_eq!(s.favorites, 1);
    }

    /// Round-1 review finding 2: `get --md` must print a trashed
    /// note's on-disk representation (from the trash path) instead of
    /// failing with a raw IO error on the missing live path.
    #[test]
    fn markdown_of_trashed_note_reads_trash_file() {
        let t = TmpVault::new();
        let id = make_memo(t.v(), "trash me");
        t.v().delete_memo(id).unwrap();
        let md = markdown_of(t.v(), id).unwrap();
        assert!(md.starts_with("---\n"), "must be the file verbatim: {md}");
        assert!(md.contains("trash me"), "body must be present: {md}");
        assert!(
            md.contains("deleted:"),
            "trashed file carries its tombstone: {md}"
        );
    }

    #[test]
    fn folder_rows_mark_daily_and_presets() {
        let t = TmpVault::new();
        t.v().install_collection("movie", "movies").unwrap();
        let rows = folder_rows(t.v()).unwrap();
        let by: std::collections::HashMap<String, FolderRow> =
            rows.into_iter().map(|r| (r.path.clone(), r)).collect();
        assert!(by["daily"].daily, "configured daily folder is flagged");
        assert!(!by["knowledge"].daily);
        assert_eq!(by["knowledge"].preset.as_deref(), Some("knowledge"));
        assert_eq!(by["movies"].preset.as_deref(), Some("movie"));
    }

    #[test]
    fn schema_report_full_null_and_missing() {
        let t = TmpVault::new();
        t.v().create_folder("plain").unwrap();

        let full = schema_report(t.v(), "knowledge").unwrap().unwrap();
        assert_eq!(full.preset.as_deref(), Some("knowledge"));
        assert!(full.schema.is_some());
        assert!(
            full.template
                .as_deref()
                .unwrap()
                .contains("kind: knowledge"),
            "raw TEMPLATE.md is reported"
        );

        let plain = schema_report(t.v(), "plain").unwrap().unwrap();
        assert!(plain.schema.is_none() && plain.template.is_none());
        assert!(plain.preset.is_none() && plain.workspace.is_none());

        assert!(schema_report(t.v(), "nope").unwrap().is_none());

        // The vault root is a valid target ("" folder).
        let root = schema_report(t.v(), "").unwrap().unwrap();
        assert!(root.schema.is_none() && root.template.is_none());
    }

    #[test]
    fn collection_catalog_names_and_install() {
        let ids: Vec<&str> = collection_catalog().iter().map(|(id, _)| *id).collect();
        for expected in [
            "knowledge",
            "daily",
            "book",
            "movie",
            "blog",
            "novel",
            "idea",
        ] {
            assert!(ids.contains(&expected), "catalog carries {expected}");
        }
        // Names come from the presets themselves (single source of truth).
        let movie = collection_catalog()
            .into_iter()
            .find(|(id, _)| *id == "movie")
            .unwrap();
        assert!(movie.1.contains("영화"), "movie name: {}", movie.1);

        // install → visible in the inventory with its facts.
        let t = TmpVault::new();
        cmd_collection_install(t.v(), "movie", "movies").unwrap();
        let inv = t.v().folder_inventory().unwrap();
        let m = inv.iter().find(|f| f.path == "movies").unwrap();
        assert_eq!(m.preset.as_deref(), Some("movie"));

        // Unknown id: error names the valid ones.
        let err = cmd_collection_install(t.v(), "nope", "x")
            .unwrap_err()
            .to_string();
        assert!(err.contains("book"), "error lists catalog ids: {err}");
    }

    /// One-command schema-valid creation: `new --folder knowledge --set
    /// status=understood` stamps the template defaults AND fires the
    /// folder's transitions (peak_status/status_changed) — the same
    /// write path the GUI property editor uses.
    #[test]
    fn new_with_set_fires_schema_transitions() {
        let t = TmpVault::new();
        let id = cmd_new(
            t.v(),
            Some("코루틴 취소는 협력적이다".into()),
            vec![],
            Some("knowledge".into()),
            false,
            vec![(
                "status".to_string(),
                oximemo_core::PropValue::Str("understood".into()),
            )],
        )
        .unwrap();
        let note = t.v().get_memo(id).unwrap();
        // Template defaults survived the explicit sets.
        assert_eq!(
            note.props.get("kind"),
            Some(&oximemo_core::PropValue::Str("knowledge".into()))
        );
        // The explicit set landed…
        assert_eq!(
            note.props.get("status"),
            Some(&oximemo_core::PropValue::Str("understood".into()))
        );
        // …and the schema's transition side effects fired with it.
        assert_eq!(
            note.props.get("peak_status"),
            Some(&oximemo_core::PropValue::Str("understood".into()))
        );
        assert!(note.props.contains_key("status_changed"));
    }
    /// Stamp mirrors the GUI contract exactly: fill-only-empty mapped
    /// fields, never overwrite, source_url/cover_url only when the
    /// schema declares them.
    #[test]
    fn stamp_fills_only_empty_props() {
        let t = TmpVault::new();
        t.v().install_collection("movie", "movies").unwrap();
        let id = t
            .v()
            .create_note(
                "movies",
                "# 듄\n본문".into(),
                oximemo_core::memo::NoteFormat::Markdown,
            )
            .unwrap()
            .id;
        // Pre-existing judgment value — must survive the stamp.
        t.v()
            .update_note_with(
                id,
                None,
                None,
                Some(oximemo_core::props::PropMutation {
                    sets: vec![(
                        "rating".to_string(),
                        oximemo_core::PropValue::Str("5".into()),
                    )],
                    removes: vec![],
                }),
            )
            .unwrap();

        let hit = oximemo_core::metadata::MetaHit {
            provider: "tmdb".into(),
            title: "듄: 파트 2".into(),
            subtitle: None,
            url: Some("https://themoviedb.org/693134".into()),
            cover_url: Some("https://image.tmdb.org/t/p/w342/x.jpg".into()),
            fields: [
                (
                    oximemo_core::metadata::MetaField::Director,
                    "드니 빌뇌브".into(),
                ),
                (
                    oximemo_core::metadata::MetaField::ReleaseDate,
                    "2024-02-27".into(),
                ),
            ]
            .into_iter()
            .collect(),
        };
        cmd_stamp(t.v(), id, &hit).unwrap();
        let note = t.v().get_memo(id).unwrap();
        assert_eq!(
            note.props.get("director").unwrap(),
            &oximemo_core::PropValue::Str("드니 빌뇌브".into())
        );
        assert_eq!(
            note.props.get("release_date").unwrap(),
            &oximemo_core::PropValue::Str("2024-02-27".into())
        );
        assert_eq!(
            note.props.get("source_url").unwrap(),
            &oximemo_core::PropValue::Str("https://themoviedb.org/693134".into())
        );
        assert!(note.props.contains_key("cover_url"));
        // The pre-set rating is untouched.
        assert_eq!(
            note.props.get("rating").unwrap(),
            &oximemo_core::PropValue::Str("5".into())
        );

        // A second stamp fills the still-empty mapped field but never
        // overwrites an occupied one.
        let hit2 = oximemo_core::metadata::MetaHit {
            provider: "tmdb".into(),
            title: "듄: 파트 2".into(),
            subtitle: None,
            url: Some("https://elsewhere".into()),
            cover_url: None,
            fields: [(oximemo_core::metadata::MetaField::RuntimeMin, "166".into())]
                .into_iter()
                .collect(),
        };
        cmd_stamp(t.v(), id, &hit2).unwrap();
        let note = t.v().get_memo(id).unwrap();
        // runtime_min IS a mapped field and was empty — filled.
        assert_eq!(
            note.props.get("runtime_min").unwrap(),
            &oximemo_core::PropValue::Str("166".into())
        );
        assert_eq!(
            note.props.get("source_url").unwrap(),
            &oximemo_core::PropValue::Str("https://themoviedb.org/693134".into()),
            "occupied source_url must not be overwritten"
        );
    }

    /// Disabled metadata config → empty hit list, no network.
    #[test]
    fn metadata_search_disabled_returns_empty() {
        let t = TmpVault::new();
        t.v()
            .set_metadata_config(oximemo_core::config::MetadataConfig {
                enabled: false,
                ..Default::default()
            })
            .unwrap();
        let hits = metadata_search(t.v(), MetadataDomain::Movie, "듄").unwrap();
        assert!(hits.is_empty());
    }

    // --- base subcommands (spec 2026-08-25 §3) --------------------------

    use oximemo_core::base::{
        BaseCell, BaseInfo, BasePage, BaseRow, BaseSource, EvalClockDto, GroupCount, RunBaseReq,
    };
    use oximemo_core::expr::value::Value;
    use oximemo_core::memo::{MemoHash, MemoSummary};

    fn cell_ok(v: Value) -> BaseCell {
        BaseCell {
            value: Some(v),
            error: None,
        }
    }

    fn cell_err(msg: &str) -> BaseCell {
        BaseCell {
            value: None,
            error: Some(msg.to_string()),
        }
    }

    fn base_row(name: &str, cells: Vec<BaseCell>) -> BaseRow {
        let id = MemoId::now();
        BaseRow {
            row_id: format!("n:{id}"),
            summary: MemoSummary {
                id,
                created_at: time::OffsetDateTime::UNIX_EPOCH,
                updated_at: time::OffsetDateTime::UNIX_EPOCH,
                hash: MemoHash::new(""),
                favorite: false,
                title: Some(name.to_string()),
                path: format!("notes/{name}.md"),
                tags: Vec::new(),
                props: Default::default(),
                preview: String::new(),
                deleted: false,
            },
            folder: "notes".into(),
            format: "md".into(),
            task: None,
            cells,
        }
    }

    fn base_page(
        rows: Vec<BaseRow>,
        total: usize,
        group_counts: Option<Vec<GroupCount>>,
    ) -> BasePage {
        BasePage {
            rows,
            total,
            group_counts,
            summaries: None,
            clock: EvalClockDto {
                now_utc: String::new(),
                local_offset_seconds: 0,
            },
            result_key: String::new(),
            warnings: Vec::new(),
        }
    }

    #[test]
    fn base_table_renders_header_rows_and_error_markers() {
        let page = base_page(
            vec![
                base_row(
                    "First",
                    vec![
                        cell_ok(Value::Str("First".into())),
                        cell_err("division by zero"),
                    ],
                ),
                base_row(
                    "Second",
                    vec![
                        cell_ok(Value::Str("Second".into())),
                        cell_ok(Value::Num(3.0)),
                    ],
                ),
            ],
            2,
            None,
        );
        let out = format::format_base_table(
            "queries/all.query",
            "Main",
            &["file.name".to_string(), "score".to_string()],
            &page,
        );
        assert!(
            out.starts_with("queries/all.query · Main · 2 rows\n"),
            "header line first, got: {out}"
        );
        assert!(
            out.contains("file.name") && out.contains("score"),
            "column labels head the table: {out}"
        );
        assert!(out.contains("First"));
        assert!(out.contains("Second"));
        assert!(out.contains("3"), "numeric cells render as text: {out}");
        assert!(out.contains("⚠"), "error cells render the ⚠ marker: {out}");
        assert!(
            !out.contains("division by zero"),
            "cell error detail stays out of the table: {out}"
        );
    }

    #[test]
    fn base_table_header_counts_page_and_total() {
        let page = base_page(
            vec![base_row("Only", vec![cell_ok(Value::Str("Only".into()))])],
            5,
            None,
        );
        let out = format::format_base_table("q.query", "Table", &["file.name".to_string()], &page);
        assert!(
            out.starts_with("q.query · Table · 1 row (of 5)\n"),
            "sliced page shows the dataset total: {out}"
        );
    }

    #[test]
    fn base_table_caps_columns_at_five() {
        let cells: Vec<BaseCell> = (0..7).map(|i| cell_ok(Value::Num(i as f64))).collect();
        let page = base_page(vec![base_row("R", cells)], 1, None);
        let cols: Vec<String> = ["c1", "c2", "c3", "c4", "c5", "c6", "c7"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let out = format::format_base_table("q.query", "T", &cols, &page);
        for kept in &["c1", "c2", "c3", "c4", "c5"] {
            assert!(out.contains(kept), "column {kept} kept: {out}");
        }
        assert!(
            !out.contains("c6") && !out.contains("c7"),
            "columns past five are dropped: {out}"
        );
    }

    #[test]
    fn base_table_renders_group_counts_line() {
        let page = base_page(
            Vec::new(),
            0,
            Some(vec![
                GroupCount {
                    key: "reading".into(),
                    count: 2,
                },
                GroupCount {
                    key: String::new(),
                    count: 1,
                },
            ]),
        );
        let out = format::format_base_table("q.query", "T", &["file.name".to_string()], &page);
        assert!(out.contains("no rows"), "empty page says so: {out}");
        assert!(
            out.contains("groups: reading 2 · (none) 1"),
            "group counts render after the table: {out}"
        );
    }

    #[test]
    fn base_list_table_marks_unloadable_bases() {
        let bases = vec![
            BaseInfo {
                path: "queries/all.query".into(),
                name: "all".into(),
                mtime: std::time::UNIX_EPOCH,
                loadable: true,
            },
            BaseInfo {
                path: "queries/bad.query".into(),
                name: "bad".into(),
                mtime: std::time::UNIX_EPOCH,
                loadable: false,
            },
        ];
        let out = format::format_base_list_table(&bases);
        assert!(
            out.contains("PATH")
                && out.contains("NAME")
                && out.contains("MODIFIED")
                && out.contains("STATUS"),
            "brief's column headers: {out}"
        );
        assert!(out.contains("queries/all.query"));
        assert!(out.contains("ok"), "loadable base reads ok: {out}");
        assert!(
            out.contains("⚠"),
            "unloadable base carries the marker: {out}"
        );
    }

    /// End-to-end through the real executor: the page `run_base`
    /// produces must render (formatter + core shapes in lockstep).
    #[test]
    fn base_table_renders_a_real_run_base_page() {
        let t = TmpVault::new();
        let a = make_memo(t.v(), "# Alpha");
        let mut pm = oximemo_core::PropMutation::default();
        pm.sets.push((
            "status".into(),
            oximemo_core::PropValue::Str("reading".into()),
        ));
        cmd_update(t.v(), a, None, false, None, Some(pm)).unwrap();
        make_memo(t.v(), "# Beta");
        t.v()
            .save_base(
                "queries/reading.query",
                "views:\n  - type: table\n    name: Main\n    columns: [file.name, status]\n    groupBy: { property: status }\n",
                None,
            )
            .unwrap();
        let req = RunBaseReq {
            view_index: 0,
            offset: 0,
            limit: 30,
            group: None,
            now_ms: None,
            local_offset_seconds: None,
            include_group_counts: true,
            include_summaries: false,
            this_id: None,
        };
        let page = t
            .v()
            .run_base(&BaseSource::Path("queries/reading.query".into()), &req)
            .unwrap();
        let out = format::format_base_table(
            "queries/reading.query",
            "Main",
            &["file.name".to_string(), "status".to_string()],
            &page,
        );
        assert!(
            out.starts_with("queries/reading.query · Main · 2 rows"),
            "{out}"
        );
        assert!(out.contains("reading"), "status prop value renders: {out}");
        assert!(
            out.contains("groups: reading 1 · (none) 1"),
            "real group counts render: {out}"
        );
    }

    // --- task subcommands (spec 2026-08-27) -----------------------------

    use oximemo_core::tasks::TaskDto;

    fn no_args<'a>() -> TaskListArgs<'a> {
        TaskListArgs {
            where_: None,
            note: None,
            folder: None,
            due: None,
            status: None,
            not_done: false,
            limit: 50,
            format: "json",
        }
    }

    fn add_args<'a>(note: Option<&'a str>, daily: Option<&'a str>, inbox: bool) -> TaskAddArgs<'a> {
        TaskAddArgs {
            note,
            daily,
            inbox,
            section: None,
            due: None,
            scheduled: None,
            start: None,
            priority: None,
            repeat: None,
            tags: &[],
        }
    }

    #[test]
    fn task_add_then_list_json_round_trips_line_and_hash_as_hex_text() {
        let t = TmpVault::new();
        cmd_task_add(t.v(), "buy milk", &add_args(None, None, true)).unwrap();
        let listed = task_list_dtos(t.v(), &no_args()).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].text, "buy milk");
        // Hash serializes as a JSON string, never a number (snake_case
        // field names match every other core DTO — MemoSummary etc.):
        let json = serde_json::to_value(&listed[0]).unwrap();
        assert!(json["task_ref"]["line_hash"].is_string());
        assert!(json["task_ref"]["line"].is_u64());
    }

    #[test]
    fn task_done_requires_hash_unless_force() {
        let t = TmpVault::new();
        cmd_task_add(t.v(), "buy milk", &add_args(None, None, true)).unwrap();
        let listed = task_list_dtos(t.v(), &no_args()).unwrap();
        let task_ref = listed[0].task_ref.clone();
        // Correct hash succeeds:
        cmd_task_patch(
            t.v(),
            &TaskPatchArgs {
                note_id: &task_ref.memo_id.to_string(),
                line: task_ref.line,
                guard: TaskGuard::Hash(task_ref.line_hash.clone()),
                edit: TaskEdit::Toggle,
            },
        )
        .unwrap();
        // Wrong hash fails as a conflict:
        let bad = parse_line_hash("0123456789abcdef").unwrap();
        let other = task_list_dtos(t.v(), &TaskListArgs { ..no_args() }).unwrap();
        let other_ref = other[0].task_ref.clone();
        let err = cmd_task_patch(
            t.v(),
            &TaskPatchArgs {
                note_id: &other_ref.memo_id.to_string(),
                line: other_ref.line,
                guard: TaskGuard::Hash(bad),
                edit: TaskEdit::Toggle,
            },
        )
        .unwrap_err();
        assert!(
            err.to_string().contains("conflict") || err.to_string().contains("not found"),
            "{err}"
        );
    }

    #[test]
    fn task_not_done_filters_out_done_and_cancelled() {
        let t = TmpVault::new();
        cmd_task_add(t.v(), "a", &add_args(None, None, true)).unwrap();
        cmd_task_add(t.v(), "b", &add_args(None, None, true)).unwrap();
        let listed = task_list_dtos(t.v(), &no_args()).unwrap();
        // Snapshot order is newest-first; "a" was created first so it
        // is the OLDER note — find tasks by text instead.
        let a = listed.iter().find(|d| d.text == "a").unwrap();
        cmd_task_patch(
            t.v(),
            &TaskPatchArgs {
                note_id: &a.task_ref.memo_id.to_string(),
                line: a.task_ref.line,
                guard: TaskGuard::Hash(a.task_ref.line_hash.clone()),
                edit: TaskEdit::Toggle,
            },
        )
        .unwrap();
        let not_done = task_list_dtos(
            t.v(),
            &TaskListArgs {
                not_done: true,
                ..no_args()
            },
        )
        .unwrap();
        assert_eq!(not_done.len(), 1);
        assert_eq!(not_done[0].text, "b");
    }

    #[test]
    fn task_rollover_dry_run_previews_without_mutating() {
        let t = TmpVault::new();
        let yesterday = local_today().previous_day().unwrap();
        cmd_task_add(
            t.v(),
            "leftover",
            &add_args(None, Some(yesterday.to_string().as_str()), false),
        )
        .unwrap();
        cmd_task_rollover(t.v(), Some(&yesterday.to_string()), None, true).unwrap();
        // dry-run: yesterday's note is untouched
        let listed = task_list_dtos(t.v(), &no_args()).unwrap();
        assert_eq!(listed.len(), 1, "still only in the original note");
    }

    #[test]
    fn task_rollover_moves_leftovers_into_today() {
        let t = TmpVault::new();
        let yesterday = local_today().previous_day().unwrap();
        cmd_task_add(
            t.v(),
            "leftover",
            &add_args(None, Some(yesterday.to_string().as_str()), false),
        )
        .unwrap();
        cmd_task_rollover(t.v(), Some(&yesterday.to_string()), None, false).unwrap();
        let listed = task_list_dtos(t.v(), &no_args()).unwrap();
        assert_eq!(listed.len(), 1);
        let folder = t
            .v()
            .with_config(|c| c.daily.folder.trim_end_matches('/').to_string());
        let today_path = format!("{folder}/{}.md", local_today());
        assert!(!listed[0].task_ref.memo_id.to_string().is_empty());
        // The task now lives in today's daily note: verify via the
        // source record path.
        let snap = t.v().snapshot().unwrap();
        let src = snap
            .iter()
            .find(|r| r.id == listed[0].task_ref.memo_id)
            .unwrap();
        assert_eq!(src.path, today_path);
    }

    #[test]
    fn task_line_numbers_are_documented_zero_based_in_json() {
        let t = TmpVault::new();
        let id = make_memo(t.v(), "# N");
        cmd_task_add(
            t.v(),
            "first",
            &add_args(Some(&id.to_string()), None, false),
        )
        .unwrap();
        let listed = task_list_dtos(t.v(), &no_args()).unwrap();
        let ours: Vec<&TaskDto> = listed.iter().filter(|d| d.text == "first").collect();
        assert_eq!(ours.len(), 1);
        assert!(ours[0].task_ref.line >= 2, "line lands under the heading");
        let memo = t.v().get_memo(id).unwrap();
        let raw = memo
            .body
            .lines()
            .nth(ours[0].task_ref.line as usize)
            .unwrap();
        assert!(raw.contains("first"), "line indexes the raw source");
    }

    #[test]
    fn task_list_where_filters_at_note_level() {
        let t = TmpVault::new();
        let id = make_memo(t.v(), "# Work");
        t.v()
            .update_note_with(
                id,
                None,
                None,
                Some(oximemo_core::props::PropMutation {
                    sets: vec![(
                        "area".to_string(),
                        oximemo_core::PropValue::Str("work".into()),
                    )],
                    removes: vec![],
                }),
            )
            .unwrap();
        cmd_task_add(
            t.v(),
            "work item",
            &add_args(Some(&id.to_string()), None, false),
        )
        .unwrap();
        cmd_task_add(t.v(), "home item", &add_args(None, None, true)).unwrap();
        let hits = task_list_dtos(
            t.v(),
            &TaskListArgs {
                where_: Some("area == \"work\""),
                ..no_args()
            },
        )
        .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].text, "work item");
    }

    #[test]
    fn task_list_due_and_status_filters() {
        let t = TmpVault::new();
        cmd_task_add(
            t.v(),
            "urgent",
            &TaskAddArgs {
                due: Some("2030-01-01"),
                ..add_args(None, None, true)
            },
        )
        .unwrap();
        cmd_task_add(t.v(), "whenever", &add_args(None, None, true)).unwrap();
        let before = task_list_dtos(
            t.v(),
            &TaskListArgs {
                due: Some("before:2031-01-01"),
                ..no_args()
            },
        )
        .unwrap();
        assert_eq!(before.len(), 1);
        assert_eq!(before[0].text, "urgent");
        let todo_only = task_list_dtos(
            t.v(),
            &TaskListArgs {
                status: Some("todo"),
                ..no_args()
            },
        )
        .unwrap();
        assert_eq!(todo_only.len(), 2);
    }

    #[test]
    fn task_guard_hash_xor_force_validated_at_parse_level() {
        assert!(parse_line_hash("XYZ").is_err());
        assert!(parse_line_hash("0123456789abcdef").is_ok());
        assert!(parse_line_hash("0123456789abcdef0").is_err(), "17 chars");
        assert!(parse_task_edit("set-due", Some("2030-01-01")).is_ok());
        assert!(parse_task_edit("set-due", Some("not-a-date")).is_err());
        assert!(parse_task_edit("bogus", None).is_err());
    }

    /// Full lifecycle through the CLI surface alone (Plan A's
    /// automated Definition-of-Done proof): add into a daily note,
    /// edit a field, set an in-progress status, complete with the
    /// guarded hash, complete a recurring task and see the spawned
    /// occurrence, then roll an older day's leftovers into today.
    #[test]
    fn task_lifecycle_end_to_end() {
        let t = TmpVault::new();
        let today = local_today();
        let yesterday = today.previous_day().unwrap();
        let two_days_ago = yesterday.previous_day().unwrap();

        // 1. add into yesterday's daily note.
        cmd_task_add(
            t.v(),
            "write report",
            &add_args(None, Some(yesterday.to_string().as_str()), false),
        )
        .unwrap();

        // 2. list shows it.
        let listed = task_list_dtos(t.v(), &no_args()).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].text, "write report");
        let r = listed[0].task_ref.clone();

        // 3. edit --set-due.
        cmd_task_patch(
            t.v(),
            &TaskPatchArgs {
                note_id: &r.memo_id.to_string(),
                line: r.line,
                guard: TaskGuard::Hash(r.line_hash.clone()),
                edit: parse_task_edit("set-due", Some("2030-01-15")).unwrap(),
            },
        )
        .unwrap();

        // 4. status -> in-progress (/).
        let listed = task_list_dtos(t.v(), &no_args()).unwrap();
        let r = listed[0].task_ref.clone();
        cmd_task_patch(
            t.v(),
            &TaskPatchArgs {
                note_id: &r.memo_id.to_string(),
                line: r.line,
                guard: TaskGuard::Hash(r.line_hash.clone()),
                edit: parse_task_edit("status", Some("/")).unwrap(),
            },
        )
        .unwrap();
        let listed = task_list_dtos(t.v(), &no_args()).unwrap();
        assert_eq!(listed[0].status_type, StatusType::InProgress);

        // 5. done with the fresh (post-edit) hash.
        let r = listed[0].task_ref.clone();
        cmd_task_patch(
            t.v(),
            &TaskPatchArgs {
                note_id: &r.memo_id.to_string(),
                line: r.line,
                guard: TaskGuard::Hash(r.line_hash.clone()),
                edit: parse_task_edit("toggle", None).unwrap(),
            },
        )
        .unwrap();

        // 6. the note body on disk shows the completed line.
        let memo = t.v().get_memo(r.memo_id).unwrap();
        assert!(
            memo.body.contains("[x] write report"),
            "completed line on disk: {}",
            memo.body
        );

        // 7. recurring task (default target = today's daily), done it.
        cmd_task_add(
            t.v(),
            "water plants",
            &TaskAddArgs {
                due: Some("2030-02-01"),
                repeat: Some("every week"),
                ..add_args(None, None, false)
            },
        )
        .unwrap();
        let listed = task_list_dtos(t.v(), &no_args()).unwrap();
        let recurring = listed
            .iter()
            .find(|d| d.text == "water plants" && d.status_type == StatusType::Todo)
            .expect("recurring task present")
            .task_ref
            .clone();
        cmd_task_patch(
            t.v(),
            &TaskPatchArgs {
                note_id: &recurring.memo_id.to_string(),
                line: recurring.line,
                guard: TaskGuard::Hash(recurring.line_hash.clone()),
                edit: parse_task_edit("toggle", None).unwrap(),
            },
        )
        .unwrap();

        // 8. completed original AND spawned occurrence both listed.
        let listed = task_list_dtos(t.v(), &no_args()).unwrap();
        let water: Vec<&TaskDto> = listed.iter().filter(|d| d.text == "water plants").collect();
        assert_eq!(water.len(), 2, "completed + spawned: {water:?}");
        let completed = water
            .iter()
            .find(|d| d.status_type == StatusType::Done)
            .expect("completed original");
        let spawned = water
            .iter()
            .find(|d| d.status_type == StatusType::Todo)
            .expect("spawned occurrence");
        assert_eq!(
            completed.task_ref.memo_id, spawned.task_ref.memo_id,
            "spawn stays in the same note as the completed line"
        );
        assert!(
            completed.task_ref.line > spawned.task_ref.line,
            "Above insert places the spawn above the completed line"
        );
        assert_eq!(
            spawned.due,
            Some(time::Date::from_calendar_date(2030, time::Month::February, 8).unwrap()),
            "spawned due = original due + 1 week"
        );

        // 9. dry-run rollover on yesterday: its only task is done, so
        // the preview shows nothing and no state on disk moves.
        let snapshot_before = t.v().snapshot().unwrap();
        let before = serde_json::to_string(snapshot_before.as_ref()).unwrap();
        let yrec = snapshot_before
            .iter()
            .find(|rec| rec.id == r.memo_id)
            .unwrap();
        assert!(
            yrec.tasks
                .iter()
                .all(|task| task.status_type.is_done_family()),
            "yesterday has no not-done tasks to roll"
        );
        cmd_task_rollover(t.v(), Some(&yesterday.to_string()), None, true).unwrap();
        let after = serde_json::to_string(t.v().snapshot().unwrap().as_ref()).unwrap();
        assert_eq!(before, after, "dry-run must not mutate the vault");

        // 10. an older day with an unfinished task, rolled into today.
        cmd_task_add(
            t.v(),
            "leftover chore",
            &add_args(None, Some(two_days_ago.to_string().as_str()), false),
        )
        .unwrap();
        cmd_task_rollover(t.v(), Some(&two_days_ago.to_string()), None, false).unwrap();

        // 11. not-done list shows it under today's daily note.
        let not_done = task_list_dtos(
            t.v(),
            &TaskListArgs {
                not_done: true,
                ..no_args()
            },
        )
        .unwrap();
        let chore = not_done
            .iter()
            .find(|d| d.text == "leftover chore")
            .expect("rolled into today");
        let folder = t
            .v()
            .with_config(|c| c.daily.folder.trim_end_matches('/').to_string());
        let snap = t.v().snapshot().unwrap();
        let src = snap
            .iter()
            .find(|rec| rec.id == chore.task_ref.memo_id)
            .unwrap();
        assert_eq!(
            src.path,
            format!("{folder}/{}.md", today),
            "chore now lives in today's daily note"
        );
    }

    /// Wire-contract pin for Plan B: `base run` over a hand-written
    /// `.query` (`source: tasks`) must emit one row per indexed task,
    /// each carrying a distinct `row_id` (`t:<memo>:<line>`) and a
    /// `task` DTO with hex-text `line_hash`. The result is the JSON
    /// shape Plan C's frontend adapter and the browser fixtures
    /// consume -- the test pins the keys so a refactor that drops one
    /// fails CI, not downstream code.
    #[test]
    fn base_run_json_exposes_task_rows_and_row_ids() {
        let t = TmpVault::new();
        // Build the daily-note content first: "demo task" lands in
        // today's daily note, then a plain inbox task gives the query
        // two rows to assert against.
        cmd_task_add(
            t.v(),
            "demo task",
            &TaskAddArgs {
                due: Some("2030-01-01"),
                ..add_args(None, None, false)
            },
        )
        .unwrap();
        cmd_task_add(t.v(), "second task", &add_args(None, None, true)).unwrap();

        // Hand-written .query exactly as a user would type it.
        let query = "source: tasks\nviews:\n  - type: tasks\n    filters: \"task.type != \\\"DONE\\\"\"\n    order:\n      - property: task.due\n        direction: asc\n";
        let qdir = t.dir().join("queries");
        std::fs::create_dir_all(&qdir).unwrap();
        std::fs::write(qdir.join("todo.query"), query).unwrap();

        let page = t
            .v()
            .run_base(
                &BaseSource::Path("queries/todo.query".into()),
                &RunBaseReq {
                    view_index: 0,
                    offset: 0,
                    limit: 10,
                    group: None,
                    now_ms: None,
                    local_offset_seconds: None,
                    include_group_counts: false,
                    include_summaries: false,
                    this_id: None,
                },
            )
            .unwrap();
        let json = serde_json::to_value(&page).unwrap();
        assert_eq!(
            json["rows"].as_array().unwrap().len(),
            2,
            "two indexed tasks feed the rows: {}",
            json["rows"]
        );

        let row = &json["rows"][0];
        for key in ["row_id", "summary", "folder", "format", "task", "cells"] {
            assert!(row.get(key).is_some(), "wire key {key} missing: {row}");
        }
        assert!(row["row_id"].as_str().unwrap().starts_with("t:"));
        assert!(
            row["task"]["task_ref"]["line_hash"].is_string(),
            "line_hash stays hex text (snake_case + string): {}",
            row["task"]["task_ref"]["line_hash"]
        );
        assert!(row["task"]["task_ref"]["memo_id"].is_string());
        assert_eq!(row["task"]["text"], "demo task");

        // Cache invalidation: completing the demo task must bump the
        // snapshot generation so the next run_base re-evaluates and
        // the filter (task.type != "DONE") drops the now-done row.
        let first_key = json["result_key"].as_str().unwrap().to_string();
        // Re-list without a where_ filter (task-list's --where runs at
        // note level only; demo task's text isn't a note property).
        let demo = task_list_dtos(t.v(), &no_args())
            .unwrap()
            .into_iter()
            .find(|d| d.text == "demo task")
            .expect("demo task in list");
        cmd_task_patch(
            t.v(),
            &TaskPatchArgs {
                note_id: &demo.task_ref.memo_id.to_string(),
                line: demo.task_ref.line,
                guard: TaskGuard::Hash(demo.task_ref.line_hash.clone()),
                edit: TaskEdit::Toggle,
            },
        )
        .unwrap();
        let page2 = t
            .v()
            .run_base(
                &BaseSource::Path("queries/todo.query".into()),
                &RunBaseReq {
                    view_index: 0,
                    offset: 0,
                    limit: 10,
                    group: None,
                    now_ms: None,
                    local_offset_seconds: None,
                    include_group_counts: false,
                    include_summaries: false,
                    this_id: None,
                },
            )
            .unwrap();
        let json2 = serde_json::to_value(&page2).unwrap();
        let second_key = json2["result_key"].as_str().unwrap();
        assert_ne!(first_key, second_key, "mutation must bump the result_key");
        let rows2 = json2["rows"].as_array().unwrap();
        assert_eq!(
            rows2.len(),
            1,
            "filter excludes the now-done demo task: {rows2:?}"
        );
        assert_eq!(rows2[0]["task"]["text"], "second task");
    }
}
