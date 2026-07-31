//! Command implementations — thin adapters over [`oxinot_core::Vault`].

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use oxinot_core::Vault;
use oxinot_core::memo::{MemoFilter, MemoId};
use oxinot_core::store::files::FileStore;

use crate::format::{self, Format};

/// `oxinot new` — capture a note from an argument or stdin.
///
/// `--tag` values are folded into the body as inline `#tag` tokens so the
/// derived model picks them up (the core no longer takes a tags argument).
pub fn cmd_new(
    vault: &Vault,
    text: Option<String>,
    tags: Vec<String>,
    color: Option<String>,
) -> Result<()> {
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
    if body.is_empty() {
        return Err(anyhow!("refusing to create an empty note"));
    }
    let note = vault.create_memo(body, color)?;
    println!("{}", note.id);
    Ok(())
}

/// `oxinot list`.
pub fn cmd_list(
    vault: &Vault,
    limit: u32,
    tag: Vec<String>,
    pinned: bool,
    fmt: Format,
) -> Result<()> {
    let filter = MemoFilter {
        include_tags: tag,
        match_all: false,
        pinned_only: pinned,
        ..Default::default()
    };
    let page = vault.list_memos(None, limit, filter)?;
    format::print_summaries(&page.items, fmt)
}

/// `oxinot get`.
pub fn cmd_get(vault: &Vault, id: MemoId, md: bool) -> Result<()> {
    let note = vault.get_memo(id)?;
    if md {
        // Emit the exact on-disk representation (frontmatter + body).
        println!("{}", FileStore::serialize(&note)?);
    } else {
        let summary: oxinot_core::memo::MemoSummary = oxinot_core::memo::MemoSummary::from(note);
        println!("{}", serde_json::to_string_pretty(&summary)?);
    }
    Ok(())
}

/// `oxinot search`.
pub fn cmd_search(vault: &Vault, query: String, limit: u32, fmt: Format) -> Result<()> {
    let hits = vault.search_memos(&query, limit)?;
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

/// `oxinot delete` — soft-delete (trash).
pub fn cmd_delete(vault: &Vault, id: MemoId) -> Result<()> {
    vault.delete_memo(id)?;
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
        stats.memos, stats.trashed_memos, stats.added, stats.updated, stats.unchanged, stats.failed
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
