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
        /// Category id, e.g. `todo`, `idea` (defaults to `inbox`).
        #[arg(long, value_name = "ID")]
        category: Option<String>,
    },

    /// List notes (newest first).
    List {
        #[arg(long, default_value_t = 50)]
        limit: u32,
        /// Include notes with this tag (repeatable; OR).
        #[arg(long = "tag", value_name = "TAG")]
        tag: Vec<String>,
        /// Only notes in this category (repeatable; OR).
        #[arg(long = "category", value_name = "ID")]
        category: Vec<String>,
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
    /// Edit an existing memo (body / favorite / category).
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
        /// Move to this category id.
        #[arg(long, value_name = "ID")]
        category: Option<String>,
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
    /// Category registry management.
    Category {
        #[command(subcommand)]
        sub: CategoryCmd,
    },
}

#[derive(Subcommand)]
enum VaultCmd {
    /// Print the vault root path.
    Path,
}

#[derive(Subcommand)]
enum CategoryCmd {
    /// List categories (id, color, builtin).
    List {
        /// table | json | ndjson
        #[arg(long, default_value = "table")]
        format: String,
    },
    /// Create a category.
    New {
        id: String,
        /// OKLCH color; auto-picks one if omitted.
        #[arg(long, value_name = "COLOR")]
        color: Option<String>,
    },
    /// Change a category's color.
    Recolor {
        id: String,
        /// OKLCH color string.
        color: Option<String>,
        /// Clear the color.
        #[arg(long)]
        none: bool,
    },
    /// Rename a category (moves all its memos).
    Rename { old: String, new: String },
    /// Delete a user category (inbox cannot be deleted).
    Delete { id: String },
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
        Cmd::New {
            text,
            tags,
            category,
        } => commands::cmd_new(&vault, text, tags, category),
        Cmd::List {
            limit,
            tag,
            category,
            favorites,
            format,
        } => {
            let fmt = format::Format::from_arg(&format)
                .ok_or_else(|| anyhow!("unknown --format: {format}"))?;
            commands::cmd_list(&vault, limit, tag, category, favorites, fmt)
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
            category,
        } => {
            let fav = if unfavorite {
                Some(false)
            } else if favorite {
                Some(true)
            } else {
                None
            };
            commands::cmd_update(&vault, parse_id(&id)?, body, body_stdin, fav, category)
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
        Cmd::Category { sub } => match sub {
            CategoryCmd::List { format } => {
                let fmt = format::Format::from_arg(&format)
                    .ok_or_else(|| anyhow!("unknown --format: {format}"))?;
                commands::cmd_category_list(&vault, fmt)
            }
            CategoryCmd::New { id, color } => commands::cmd_category_new(&vault, id, color),
            CategoryCmd::Recolor { id, color, none } => {
                commands::cmd_category_recolor(&vault, id, color, none)
            }
            CategoryCmd::Rename { old, new } => commands::cmd_category_rename(&vault, old, new),
            CategoryCmd::Delete { id } => commands::cmd_category_delete(&vault, id),
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
