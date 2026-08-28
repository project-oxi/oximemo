//! Output formatting for the CLI: table (human), JSON, and NDJSON.

use std::io::{self, Write};

use oximemo_core::memo::MemoSummary;
use oximemo_core::sync::{FullRecord, ManifestRecord};

#[derive(Debug, Clone, Copy, clap::ValueEnum)]
pub enum Format {
    /// Human-readable aligned table.
    Table,
    /// Pretty-printed JSON array.
    Json,
    /// Line-delimited JSON (streaming-friendly; default for export).
    Ndjson,
}

impl Format {
    pub fn from_arg(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "table" => Some(Self::Table),
            "json" => Some(Self::Json),
            "ndjson" => Some(Self::Ndjson),
            _ => None,
        }
    }
}

/// Print a slice of summaries in the chosen format.
pub fn print_summaries(items: &[MemoSummary], fmt: Format) -> anyhow::Result<()> {
    let stdout = io::stdout();
    match fmt {
        Format::Json => println!("{}", serde_json::to_string_pretty(items)?),
        Format::Ndjson => {
            let mut h = stdout.lock();
            for it in items {
                writeln!(h, "{}", serde_json::to_string(it)?)?;
            }
        }
        Format::Table => print_summary_table(items)?,
    }
    Ok(())
}

pub fn print_manifest(items: &[ManifestRecord], fmt: Format) -> anyhow::Result<()> {
    let stdout = io::stdout();
    match fmt {
        Format::Json => println!("{}", serde_json::to_string_pretty(items)?),
        Format::Ndjson => {
            let mut h = stdout.lock();
            for it in items {
                writeln!(h, "{}", serde_json::to_string(it)?)?;
            }
        }
        Format::Table => {
            let mut h = stdout.lock();
            writeln!(h, "{:<38} {:<40} {:<10} DELETED", "ID", "HASH", "UPDATED")?;
            for it in items {
                writeln!(
                    h,
                    "{:<38} {:<40} {:<10} {}",
                    it.id,
                    it.hash,
                    rfc3339(it.updated_at),
                    it.deleted
                )?;
            }
        }
    }
    Ok(())
}

pub fn print_full(items: &[FullRecord], fmt: Format) -> anyhow::Result<()> {
    let stdout = io::stdout();
    match fmt {
        Format::Json => println!("{}", serde_json::to_string_pretty(items)?),
        // NDJSON is the default for export --full (streaming).
        Format::Ndjson => {
            let mut h = stdout.lock();
            for it in items {
                writeln!(h, "{}", serde_json::to_string(it)?)?;
            }
        }
        Format::Table => {
            let mut h = stdout.lock();
            for it in items {
                writeln!(h, "--- {} ---", it.id)?;
                writeln!(h, "{}", serde_json::to_string_pretty(it)?)?;
            }
        }
    }
    Ok(())
}

fn print_summary_table(items: &[MemoSummary]) -> anyhow::Result<()> {
    let stdout = io::stdout();
    let mut h = stdout.lock();
    if items.is_empty() {
        writeln!(h, "(no notes)")?;
        return Ok(());
    }
    writeln!(
        h,
        "{:<10} {:<19} {:<3} {:<20}  PREVIEW",
        "ID", "UPDATED", "FAV", "TITLE"
    )?;
    for s in items {
        let id = s.id.to_string();
        let short = &id[..8.min(id.len())];
        let star = if s.favorite { "*" } else { "" };
        let title: String = s.title.as_deref().unwrap_or("-").chars().take(20).collect();
        let preview: String = s.preview.chars().take(60).collect();
        writeln!(
            h,
            "{:<10} {:<19} {:<3} {:<20}  {}",
            short,
            rfc3339(s.updated_at),
            star,
            title,
            preview
        )?;
    }
    Ok(())
}
/// Render an `OffsetDateTime` as RFC 3339 (or "?" on failure).
fn rfc3339(t: time::OffsetDateTime) -> String {
    use time::format_description::well_known::Rfc3339;
    t.format(&Rfc3339).unwrap_or_else(|_| "?".into())
}

// --- .query base rendering (spec 2026-08-25 §3) --------------------------

/// Max view columns the run table renders (`file.name` + 4 more).
pub const BASE_TABLE_MAX_COLUMNS: usize = 5;

/// Max characters of one table cell before it is ellipsized (titles
/// and long values must not wreck the fixed-width layout).
const BASE_TABLE_CELL_MAX: usize = 48;

/// `oximemo base run` renderer (pure): the `path · view · N rows`
/// header, a fixed-width table of up to [`BASE_TABLE_MAX_COLUMNS`] view
/// columns (`⚠` for error cells, error text is tooltip-only), then the
/// group-counts line. Warnings are the command's job (stderr).
pub fn format_base_table(
    path: &str,
    view_name: &str,
    columns: &[String],
    page: &oximemo_core::base::BasePage,
) -> String {
    let n = page.rows.len();
    let mut out = String::new();
    let plural = if n == 1 { "row" } else { "rows" };
    out.push_str(&format!("{path} · {view_name} · {n} {plural}"));
    if page.total != n {
        out.push_str(&format!(" (of {})", page.total));
    }
    out.push('\n');

    if n == 0 {
        out.push_str("no rows\n");
    } else {
        let ncols = columns.len().min(BASE_TABLE_MAX_COLUMNS);
        let header: Vec<String> = columns[..ncols]
            .iter()
            .map(|c| ellipsize(c, BASE_TABLE_CELL_MAX))
            .collect();
        let rows: Vec<Vec<String>> = page
            .rows
            .iter()
            .map(|r| {
                (0..ncols)
                    .map(|i| match r.cells.get(i) {
                        Some(c) if c.error.is_some() => "⚠".to_string(),
                        Some(c) => c
                            .value
                            .as_ref()
                            .map(oximemo_core::expr::value::group_string)
                            .unwrap_or_default(),
                        None => String::new(),
                    })
                    .map(|s| ellipsize(&s, BASE_TABLE_CELL_MAX))
                    .collect()
            })
            .collect();
        let mut widths: Vec<usize> = header.iter().map(|h| h.chars().count()).collect();
        for row in &rows {
            for (i, cell) in row.iter().enumerate() {
                widths[i] = widths[i].max(cell.chars().count());
            }
        }
        let line = |parts: &[String]| {
            parts
                .iter()
                .enumerate()
                .map(|(i, p)| format!("{:<width$}", p, width = widths[i]))
                .collect::<Vec<_>>()
                .join("  ")
        };
        out.push_str(&line(&header));
        out.push('\n');
        for row in &rows {
            out.push_str(&line(row));
            out.push('\n');
        }
    }

    if let Some(counts) = page.group_counts.as_ref().filter(|c| !c.is_empty()) {
        let parts: Vec<String> = counts
            .iter()
            .map(|g| {
                let key = if g.key.is_empty() {
                    "(none)"
                } else {
                    g.key.as_str()
                };
                format!("{key} {}", g.count)
            })
            .collect();
        out.push_str(&format!("groups: {}\n", parts.join(" · ")));
    }
    out
}

/// `oximemo base list` table renderer: `PATH  NAME  MODIFIED  STATUS`
/// with `⚠ unloadable` marking files that do not parse (still listed
/// so the user can find and fix them).
pub fn format_base_list_table(bases: &[oximemo_core::base::BaseInfo]) -> String {
    if bases.is_empty() {
        return "no .query bases found\n".to_string();
    }
    let rows: Vec<[String; 4]> = bases
        .iter()
        .map(|b| {
            [
                b.path.clone(),
                b.name.clone(),
                rfc3339(time::OffsetDateTime::from(b.mtime)),
                if b.loadable {
                    "ok".into()
                } else {
                    "⚠ unloadable".into()
                },
            ]
        })
        .collect();
    let header = ["PATH", "NAME", "MODIFIED", "STATUS"];
    let mut widths: [usize; 4] = [0; 4];
    for (i, h) in header.iter().enumerate() {
        widths[i] = h.len();
    }
    for row in &rows {
        for (i, cell) in row.iter().enumerate() {
            widths[i] = widths[i].max(cell.chars().count());
        }
    }
    let mut out = String::new();
    let header_cells: Vec<String> = header.iter().map(|s| s.to_string()).collect();
    for parts in std::iter::once(header_cells).chain(rows.iter().map(|r| r.to_vec())) {
        let cells: Vec<String> = parts
            .iter()
            .enumerate()
            .map(|(i, p)| format!("{:<width$}", p, width = widths[i]))
            .collect();
        out.push_str(&cells.join("  "));
        out.push('\n');
    }
    out
}

/// `oximemo task list` table renderer (pure): `LINE  STATUS  DUE
/// TEXT`. Lines are 0-based (they index straight back into the note
/// for `task done/status/edit/rm`).
pub fn format_task_table(tasks: &[oximemo_core::tasks::TaskDto]) -> String {
    const TEXT_MAX: usize = 48;
    let mut out = String::new();
    if tasks.is_empty() {
        out.push_str("(no tasks)\n");
        return out;
    }
    out.push_str("LINE  STATUS  DUE          TEXT\n");
    out.push_str("----  ------  -----------  ----\n");
    for t in tasks {
        let status = format!("[{}]", t.symbol);
        let due = t
            .due
            .map(|d| format!("{:04}-{:02}-{:02}", d.year(), u8::from(d.month()), d.day()))
            .unwrap_or_else(|| "-".into());
        out.push_str(&format!(
            "{:>4}  {:<6}  {:<11}  {}\n",
            t.task_ref.line,
            status,
            due,
            ellipsize(&t.text, TEXT_MAX)
        ));
    }
    out
}

/// Cap `s` at `max` characters, appending `…` when truncated.
fn ellipsize(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut cut: String = s.chars().take(max.saturating_sub(1)).collect();
    cut.push('…');
    cut
}
