//! Command implementations — thin adapters over [`oxinot_core::Vault`].

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use oxinot_core::note::{NoteFilter, NoteId};
use oxinot_core::store::files::FileStore;
use oxinot_core::Vault;

use crate::format::{self, Format};

/// `oxinot new` — capture a note from an argument or stdin.
pub fn cmd_new(
    vault: &Vault,
    text: Option<String>,
    tags: Vec<String>,
    color: Option<String>,
) -> Result<()> {
    let body = match text {
        Some(t) => t,
        None => {
            use std::io::Read;
            let mut buf = String::new();
            std::io::stdin().read_to_string(&mut buf).context("read stdin")?;
            buf.trim_end().to_string()
        }
    };
    if body.is_empty() {
        return Err(anyhow!("refusing to create an empty note"));
    }
    let note = vault.create_note(body, tags, color)?;
    println!("{}", note.id);
    Ok(())
}

/// `oxinot list`.
pub fn cmd_list(
    vault: &Vault,
    limit: u32,
    tag: Option<String>,
    pinned: bool,
    fmt: Format,
) -> Result<()> {
    let filter = NoteFilter { tag, pinned_only: pinned, include_deleted: false };
    let page = vault.list_notes(None, limit, filter)?;
    format::print_summaries(&page.items, fmt)
}

/// `oxinot get`.
pub fn cmd_get(vault: &Vault, id: NoteId, md: bool) -> Result<()> {
    let note = vault.get_note(id)?;
    if md {
        // Emit the exact on-disk representation (frontmatter + body).
        println!("{}", FileStore::serialize(&note)?);
    } else {
        let summary: oxinot_core::note::NoteSummary = oxinot_core::note::NoteSummary::from(note);
        println!("{}", serde_json::to_string_pretty(&summary)?);
    }
    Ok(())
}

/// `oxinot search`.
pub fn cmd_search(vault: &Vault, query: String, limit: u32, fmt: Format) -> Result<()> {
    let hits = vault.search_notes(&query, limit)?;
    format::print_summaries(&hits, fmt)
}

/// `oxinot export` (§9.2). Manifest by default; `--full` includes bodies.
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
            let ids: Vec<NoteId> = manifest.iter().map(|m| m.id).collect();
            let items = vault.export_full(&ids)?;
            format::print_full(&items, fmt)
        }
        (IdsMode::Some(ids), _) => {
            let items = vault.export_full(ids)?;
            format::print_full(&items, fmt)
        }
    }
}

/// `oxinot delete` — soft-delete (trash).
pub fn cmd_delete(vault: &Vault, id: NoteId) -> Result<()> {
    vault.delete_note(id)?;
    println!("trashed {}", id);
    Ok(())
}

/// `oxinot purge` — hard-delete trashed notes older than the retention.
pub fn cmd_purge(vault: &Vault, older_than: Duration) -> Result<()> {
    let n = vault.purge(older_than)?;
    println!("purged {}", n);
    Ok(())
}

/// `oxinot reindex` — rebuild indexes from files.
pub fn cmd_reindex(vault: &Vault) -> Result<()> {
    let stats = vault.reindex()?;
    println!(
        "notes={} trashed={} added={} updated={} unchanged={} failed={}",
        stats.notes, stats.trashed, stats.added, stats.updated, stats.unchanged, stats.failed
    );
    Ok(())
}

/// `oxinot vault path`.
pub fn cmd_vault_path(vault: &Vault) -> Result<()> {
    println!("{}", vault.paths().vault.display());
    Ok(())
}

/// `oxinot doctor [--fix]`.
pub fn cmd_doctor(vault: &Vault, fix: bool) -> Result<()> {
    let report = vault.doctor(fix)?;
    let json = serde_json::to_string_pretty(&report)?;
    println!("{json}");
    Ok(())
}


// --- helpers ----------------------------------------------------------

enum IdsMode {
    All,
    Some(Vec<NoteId>),
}

impl IdsMode {
    fn resolve(
        ids: Option<String>,
        ids_file: Option<PathBuf>,
        ids_stdin: bool,
    ) -> Result<Self> {
        let provided = [ids.is_some(), ids_file.is_some(), ids_stdin]
            .iter()
            .filter(|&&b| b)
            .count();
        if provided > 1 {
            return Err(anyhow!("only one of --ids / --ids-file / --ids-stdin may be used"));
        }
        if let Some(csv) = ids {
            let v = parse_ids(csv.split(',').map(str::trim))?;
            return Ok(Self::Some(v));
        }
        if let Some(path) = ids_file {
            let text = std::fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
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

fn parse_ids<'a, I: Iterator<Item = &'a str>>(it: I) -> Result<Vec<NoteId>> {
    let mut out = Vec::new();
    for s in it {
        if s.is_empty() {
            continue;
        }
        out.push(NoteId::parse(s).with_context(|| format!("invalid id: {s}"))?);
    }
    Ok(out)
}

fn parse_since(s: Option<String>) -> Result<Option<time::OffsetDateTime>> {
    use time::format_description::well_known::Rfc3339;
    match s {
        None => Ok(None),
        Some(t) => Ok(Some(
            time::OffsetDateTime::parse(&t, &Rfc3339).with_context(|| format!("parse --since: {t}"))?,
        )),
    }
}

/// Parse a short duration like `30d`, `12h`, `45m`.
pub fn parse_duration(s: &str) -> Result<Duration> {
    let s = s.trim();
    if s.is_empty() {
        return Err(anyhow!("empty duration"));
    }
    let (num, unit) = s.split_at(
        s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len()),
    );
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
