//! Command implementations — thin adapters over [`oximemo_core::Vault`].

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use oximemo_core::Vault;
use oximemo_core::memo::{MemoFilter, MemoId};

use crate::format::{self, Format};

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
    ["knowledge", "daily", "book", "movie", "blog", "novel", "idea"]
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
pub fn cmd_stamp(
    vault: &Vault,
    id: MemoId,
    hit: &oximemo_core::metadata::MetaHit,
) -> Result<()> {
    let memo = vault.get_memo(id)?;
    let dto = vault.note_dto(&memo);
    let schema = vault
        .folder_schema(&dto.folder)?
        .unwrap_or_default();
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

        cmd_update(t.v(), id, Some("new body #urgent".into()), false, None, None).unwrap();
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
        cmd_update(t.v(), make_memo(t.v(), "fav"), None, false, Some(true), None).unwrap();
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
        let by: std::collections::HashMap<String, FolderRow> = rows
            .into_iter()
            .map(|r| (r.path.clone(), r))
            .collect();
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
            full.template.as_deref().unwrap().contains("kind: knowledge"),
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
        for expected in ["knowledge", "daily", "book", "movie", "blog", "novel", "idea"] {
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
            fields: [(
                oximemo_core::metadata::MetaField::RuntimeMin,
                "166".into(),
            )]
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
}
