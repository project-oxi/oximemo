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
mod upgrade;

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
        /// Note body. If omitted, reads from stdin.
        text: Option<String>,
        /// Inline tag appended to the body as `#TAG` (repeatable).
        #[arg(long = "tag", value_name = "TAG")]
        tags: Vec<String>,
        /// Folder path (e.g. `novel`, `diary`). Empty = vault root.
        #[arg(long, value_name = "PATH")]
        folder: Option<String>,
        /// Create an html note (`.html`) instead of markdown.
        #[arg(long)]
        html: bool,
    },

    /// List notes (newest first).
    List {
        #[arg(long, default_value_t = 50)]
        limit: u32,
        /// Include notes with this tag (repeatable; OR).
        #[arg(long = "tag", value_name = "TAG")]
        tag: Vec<String>,
        /// Only notes in this folder (path prefix, e.g. `novel`).
        #[arg(long, value_name = "PATH")]
        folder: Option<String>,
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
    /// Edit an existing note (body / favorite).
    Update {
        id: String,
        /// Replace the body with TEXT.
        #[arg(long)]
        body: Option<String>,
        /// Read the new body from stdin.
        #[arg(long)]
        body_stdin: bool,
        /// Mark as favorite.
        #[arg(long)]
        favorite: bool,
        /// Remove favorite.
        #[arg(long)]
        unfavorite: bool,
    },
    /// Restore a soft-deleted (trashed) memo.
    Restore { id: String },
    /// Live memo counts.
    Stats,

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

    /// Migrate vault from v2 (categories) to v3 (folders) layout.
    Migrate {
        /// Preview changes without writing.
        #[arg(long)]
        dry_run: bool,
    },

    /// Check for a newer release and self-update.
    Upgrade {
        /// Report availability without installing.
        #[arg(long)]
        check: bool,
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
    // `upgrade` manages the binary itself and never touches a vault.
    if let Cmd::Upgrade { check } = &cli.cmd {
        return upgrade::run(*check);
    }
    let vault = Vault::open(cli.vault.as_deref())?;
    vault.migrate()?;
    match cli.cmd {
        Cmd::New {
            text,
            tags,
            folder,
            html,
        } => commands::cmd_new(&vault, text, tags, folder, html),
        Cmd::List {
            limit,
            tag,
            folder,
            favorites,
            format,
        } => {
            let fmt = format::Format::from_arg(&format)
                .ok_or_else(|| anyhow!("unknown --format: {format}"))?;
            commands::cmd_list(&vault, limit, tag, folder, favorites, fmt)
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
        Cmd::Update {
            id,
            body,
            body_stdin,
            favorite,
            unfavorite,
        } => {
            let fav = if unfavorite {
                Some(false)
            } else if favorite {
                Some(true)
            } else {
                None
            };
            commands::cmd_update(&vault, parse_id(&id)?, body, body_stdin, fav)
        }
        Cmd::Restore { id } => commands::cmd_restore(&vault, parse_id(&id)?),
        Cmd::Stats => commands::cmd_stats(&vault),
        Cmd::Purge { older_than } => {
            let d = commands::parse_duration(&older_than)?;
            commands::cmd_purge(&vault, d)
        }
        Cmd::Reindex => commands::cmd_reindex(&vault),
        Cmd::Doctor { fix } => commands::cmd_doctor(&vault, fix),
        Cmd::Vault { sub } => match sub {
            Some(VaultCmd::Path) | None => commands::cmd_vault_path(&vault),
        },
        Cmd::Migrate { dry_run } => {
            let report = oximemo_core::migrate::migrate_vault(vault.paths(), dry_run)?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            if !dry_run && report.files_moved > 0 {
                vault.reindex()?;
            }
            Ok(())
        }
        // Handled before the vault is opened (see above).
        Cmd::Upgrade { .. } => unreachable!(),
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
