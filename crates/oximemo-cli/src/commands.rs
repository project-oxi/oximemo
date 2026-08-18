//! Command implementations — thin adapters over [`oximemo_core::Vault`].

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use oximemo_core::Vault;
use oximemo_core::memo::{MemoFilter, MemoId};
use oximemo_core::store::files::FileStore;

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
    println!("{}", note.id);
    Ok(())
}

/// `oximemo list`.
pub fn cmd_list(
    vault: &Vault,
    limit: u32,
    tag: Vec<String>,
    folder: Option<String>,
    favorites: bool,
    fmt: Format,
) -> Result<()> {
    let filter = MemoFilter {
        include_tags: tag,
        folder,
        match_all: false,
        favorites_only: favorites,
        ..Default::default()
    };
    let page = vault.list_memos(None, limit, filter)?;
    format::print_summaries(&page.items, fmt)
}

/// `oximemo get`.
pub fn cmd_get(vault: &Vault, id: MemoId, md: bool) -> Result<()> {
    let note = vault.get_memo(id)?;
    if md {
        // Emit the exact on-disk representation (frontmatter + body).
        println!("{}", FileStore::serialize(&note)?);
    } else {
        let summary: oximemo_core::memo::MemoSummary = oximemo_core::memo::MemoSummary::from(note);
        println!("{}", serde_json::to_string_pretty(&summary)?);
    }
    Ok(())
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

/// `oximemo update` — edit an existing note's body or favorite flag.
pub fn cmd_update(
    vault: &Vault,
    id: MemoId,
    body: Option<String>,
    body_stdin: bool,
    favorite: Option<bool>,
) -> Result<()> {
    let body = if body_stdin {
        Some(read_stdin()?)
    } else {
        body
    };
    if body.is_none() && favorite.is_none() {
        return Err(anyhow!(
            "no changes specified; pass --body/--body-stdin or --favorite/--unfavorite"
        ));
    }
    let note = vault.update_note(id, body, favorite)?;
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

        cmd_update(t.v(), id, None, false, Some(true)).unwrap();
        let after = t.v().get_memo(id).unwrap();
        assert!(after.favorite);
        assert_eq!(after.body, "first body");

        cmd_update(t.v(), id, Some("new body #urgent".into()), false, None).unwrap();
        let after = t.v().get_memo(id).unwrap();
        assert_eq!(after.body, "new body #urgent");
        assert!(after.tags.iter().any(|x| x == "urgent"));
    }

    #[test]
    fn update_without_changes_is_an_error() {
        let t = TmpVault::new();
        let id = make_memo(t.v(), "x");
        assert!(cmd_update(t.v(), id, None, false, None).is_err());
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
        cmd_update(t.v(), make_memo(t.v(), "fav"), None, false, Some(true)).unwrap();
        cmd_stats(t.v()).unwrap();
        let s = t.v().memo_stats().unwrap();
        assert_eq!(s.memos, 3);
        assert_eq!(s.favorites, 1);
    }
}
