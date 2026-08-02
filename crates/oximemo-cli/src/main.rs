//! oximemo — command-line interface.
//!
//! Thin adapter over `oximemo-core`. Every subcommand opens a [`Vault`] and
//! delegates; the binary carries no domain logic of its own.

use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{Result, anyhow};
use clap::{Parser, Subcommand};
use oximemo_core::Vault;
use oximemo_core::memo::MemoId;

mod commands;
mod format;

#[derive(Parser)]
#[command(
    name = "oximemo",
    version,
    about = "Minimal note capture for humans and agents",
    long_about = "Reads/writes the oximemo vault. Agent-facing commands default to JSON/NDJSON."
)]
struct Cli {
    /// Vault root (defaults to the user vault under Application Support).
    #[arg(long, global = true, env = "OXIMEMO_VAULT")]
    vault: Option<PathBuf>,

    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Create a note from an argument or stdin.
    New {
        /// Memo body. If omitted, reads from stdin.
        text: Option<String>,
        /// Inline tag appended to the body as `#TAG` (repeatable).
        #[arg(long = "tag", value_name = "TAG")]
        tags: Vec<String>,
        /// OKLCH color string, e.g. `oklch(0.75 0.15 75)`.
        #[arg(long)]
        color: Option<String>,
    },

    /// List notes (newest first).
    List {
        #[arg(long, default_value_t = 50)]
        limit: u32,
        /// Include notes with this tag (repeatable; OR).
        #[arg(long = "tag", value_name = "TAG")]
        tag: Vec<String>,
        #[arg(long)]
        favorites: bool,
        /// table | json | ndjson
        #[arg(long, default_value = "table")]
        format: String,
    },

    /// Read a single note.
    Get {
        id: String,
        /// Emit the raw `.md` file (frontmatter + body) instead of JSON.
        #[arg(long)]
        md: bool,
    },

    /// Full-text search.
    Search {
        query: String,
        #[arg(long, default_value_t = 20)]
        limit: u32,
        #[arg(long, default_value = "ndjson")]
        format: String,
    },

    /// Export notes for synchronization (§9.2). Defaults to a lightweight
    /// manifest (no bodies) as NDJSON.
    Export {
        /// Only notes updated at or after this RFC 3339 timestamp.
        #[arg(long, value_name = "RFC3339")]
        since: Option<String>,
        /// Comma-separated ids.
        #[arg(long, value_name = "IDS")]
        ids: Option<String>,
        /// One id per line from a file.
        #[arg(long, value_name = "PATH")]
        ids_file: Option<PathBuf>,
        /// One id per line from stdin.
        #[arg(long)]
        ids_stdin: bool,
        /// Include bodies (full records).
        #[arg(long)]
        full: bool,
        #[arg(long, default_value = "ndjson")]
        format: String,
    },

    /// Soft-delete a note (moves to trash).
    Delete { id: String },

    /// Hard-delete trashed memos older than the retention.
    Purge {
        #[arg(long, default_value = "30d")]
        older_than: String,
    },

    /// Rebuild the indexes from the source-of-truth files.
    Reindex,

    /// Check vault/index consistency (§9.3).
    Doctor {
        /// Apply safe repairs (never deletes files).
        #[arg(long)]
        fix: bool,
    },

    /// Print the resolved vault path.
    Vault {
        #[command(subcommand)]
        sub: Option<VaultCmd>,
    },
}

#[derive(Subcommand)]
enum VaultCmd {
    /// Print the vault root path.
    Path,
}

fn main() -> ExitCode {
    init_tracing();
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("oximemo: {e}");
            if let Some(src) = e.source() {
                eprintln!("  caused by: {src}");
            }
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<()> {
    let cli = Cli::parse();
    let vault = Vault::open(cli.vault.as_deref())?;
    vault.migrate()?;
    match cli.cmd {
        Cmd::New { text, tags, color } => commands::cmd_new(&vault, text, tags, color),
        Cmd::List {
            limit,
            tag,
            favorites,
            format,
        } => {
            let fmt = format::Format::from_arg(&format)
                .ok_or_else(|| anyhow!("unknown --format: {format}"))?;
            commands::cmd_list(&vault, limit, tag, favorites, fmt)
        }
        Cmd::Get { id, md } => commands::cmd_get(&vault, parse_id(&id)?, md),
        Cmd::Search {
            query,
            limit,
            format,
        } => {
            let fmt = format::Format::from_arg(&format)
                .ok_or_else(|| anyhow!("unknown --format: {format}"))?;
            commands::cmd_search(&vault, query, limit, fmt)
        }
        Cmd::Export {
            since,
            ids,
            ids_file,
            ids_stdin,
            full,
            format,
        } => {
            let fmt = format::Format::from_arg(&format)
                .ok_or_else(|| anyhow!("unknown --format: {format}"))?;
            commands::cmd_export(&vault, since, ids, ids_file, ids_stdin, full, fmt)
        }
        Cmd::Delete { id } => commands::cmd_delete(&vault, parse_id(&id)?),
        Cmd::Purge { older_than } => {
            let d = commands::parse_duration(&older_than)?;
            commands::cmd_purge(&vault, d)
        }
        Cmd::Reindex => commands::cmd_reindex(&vault),
        Cmd::Doctor { fix } => commands::cmd_doctor(&vault, fix),
        Cmd::Vault { sub } => match sub {
            Some(VaultCmd::Path) | None => commands::cmd_vault_path(&vault),
        },
    }
}

fn parse_id(s: &str) -> Result<MemoId> {
    MemoId::parse(s).map_err(|e| anyhow!("invalid id `{s}`: {e}"))
}

fn init_tracing() {
    use tracing_subscriber::EnvFilter;
    let _ = tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .try_init();
}
