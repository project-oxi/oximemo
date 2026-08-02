//! Output formatting for the CLI: table (human), JSON, and NDJSON.

use std::io::{self, Write};

use oximemo_core::config::CategoryDef;
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

pub fn print_categories(items: &[CategoryDef], fmt: Format) -> anyhow::Result<()> {
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
            writeln!(h, "{:<16} {:<28} KIND", "ID", "COLOR")?;
            for it in items {
                writeln!(
                    h,
                    "{:<16} {:<28} {}",
                    it.id,
                    it.color,
                    if it.builtin { "builtin" } else { "user" }
                )?;
            }
        }
    }
    Ok(())
}

fn print_summary_table(items: &[MemoSummary]) -> anyhow::Result<()> {
    let stdout = io::stdout();
    let mut h = stdout.lock();
    if items.is_empty() {
        writeln!(h, "(no memos)")?;
        return Ok(());
    }
    writeln!(
        h,
        "{:<10} {:<19} {:<3} {:<10}  PREVIEW",
        "ID", "UPDATED", "FAV", "CAT"
    )?;
    for s in items {
        let id = s.id.to_string();
        let short = &id[..8.min(id.len())];
        let star = if s.favorite { "*" } else { "" };
        let cat = if s.category.is_empty() {
            "-"
        } else {
            &s.category
        };
        let preview: String = s.preview.chars().take(60).collect();
        writeln!(
            h,
            "{:<10} {:<19} {:<3} {:<10}  {}",
            short,
            rfc3339(s.updated_at),
            star,
            cat,
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
