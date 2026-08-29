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

    /// Space name (one-shot; not persisted). Vault lives at
    /// ~/.oxi/vault/<space>/. Mutually exclusive with --vault.
    #[arg(long, global = true, env = "OXIMEMO_SPACE", conflicts_with = "vault")]
    space: Option<String>,

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
        /// Set a property `KEY=VAL` on the new note (repeatable).
        /// Comma values = list. Fires the folder's schema transitions.
        #[arg(long = "set", value_name = "KEY=VAL")]
        set: Vec<String>,
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
        /// Property filter, `KEY=VAL` / `KEY~VAL` (repeatable; AND).
        /// Comma values = any-of. `~` = list membership (or substring).
        #[arg(long = "where", value_name = "EXPR")]
        where_: Vec<String>,
        /// Sort: `updated` (asc), `updated:desc`, or a property key (asc).
        #[arg(long, value_name = "SPEC")]
        sort: Option<String>,
        /// Page offset (used with --sort for offset pagination).
        #[arg(long, default_value_t = 0)]
        offset: u32,
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

    /// List folders with schema facts (the vault's folder map).
    Folders {
        /// table | json | ndjson
        #[arg(long, default_value = "table")]
        format: String,
    },

    /// Dump a folder's schema + template as JSON (omit FOLDER = root).
    /// A schema-less folder reports `"schema": null` (free-property
    /// mode) — that is a fact, not an error.
    Schema {
        /// Folder path, e.g. `knowledge`. Empty = vault root.
        folder: Option<String>,
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

    /// Installable collection presets (books, movies, …).
    Collection {
        #[command(subcommand)]
        sub: CollectionCmd,
    },

    /// Soft-delete a note (moves to trash).
    Delete {
        id: String,
    },
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
        /// Set a property `KEY=VAL` (repeatable). Comma values = list.
        #[arg(long = "set", value_name = "KEY=VAL")]
        set: Vec<String>,
        /// Remove a property key (repeatable).
        #[arg(long = "unset", value_name = "KEY")]
        unset: Vec<String>,
    },
    Restore {
        id: String,
    },
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

    /// Space operations (spec 2026-08-28 §4).
    Space {
        #[command(subcommand)]
        sub: Option<SpaceCmd>,
    },

    /// Search metadata providers (books/movies) with the vault's
    /// `[metadata]` config — the grounding behind the GUI 채우기 flow.
    Metadata {
        #[command(subcommand)]
        sub: MetadataCmd,
    },

    /// Stamp a metadata hit (MetaHit JSON on stdin) onto a note —
    /// fills only schema-declared, still-empty fields.
    Stamp {
        id: String,
    },

    /// Query-view bases (`.query` files): list, run, rename, trash,
    /// restore.
    Base {
        #[command(subcommand)]
        sub: BaseCmd,
    },

    /// Manage extended-checkbox tasks (spec 2026-08-27).
    Task {
        #[command(subcommand)]
        sub: TaskCmd,
    },
}

#[derive(Subcommand, Clone)]
enum SpaceCmd {
    /// List spaces; `*` marks the active one.
    List,
    /// Create a space (idempotent) and scaffold its vault.
    Add {
        /// Space name (letters/digits/`-`/`_`, 1..=64).
        name: String,
    },
    /// Record the selected space for future runs.
    Switch { name: String },
}

#[derive(Subcommand)]
enum TaskCmd {
    /// List tasks across notes (filtered). Lines are 0-based.
    List {
        /// Note-level filter expression (same grammar as `list
        /// --where`, evaluated against NOTE columns; `task.*` does not
        /// resolve here yet).
        #[arg(long = "where", value_name = "EXPR")]
        where_: Option<String>,
        /// Restrict to one note by id.
        #[arg(long, value_name = "ID")]
        note: Option<String>,
        /// Restrict to one folder (path prefix).
        #[arg(long, value_name = "PATH")]
        folder: Option<String>,
        /// Due-date filter: `before:DATE`, `after:DATE`, or `on:DATE`.
        #[arg(long, value_name = "SPEC")]
        due: Option<String>,
        /// Status filter: todo|in_progress|on_hold|done|cancelled
        /// (case-insensitive, `_` optional).
        #[arg(long, value_name = "STATUS")]
        status: Option<String>,
        /// Exclude done and cancelled tasks.
        #[arg(long)]
        not_done: bool,
        #[arg(long, default_value_t = 50)]
        limit: usize,
        /// table | json | md
        #[arg(long, default_value = "table")]
        format: String,
    },
    /// Add a task (`--note ID` | `--daily [DATE]` | `--inbox`; default
    /// follows `[tasks] capture_target`).
    Add {
        /// Task description text.
        text: String,
        /// Append into the note with this id.
        #[arg(long, value_name = "ID")]
        note: Option<String>,
        /// Append into a daily note (`--daily` alone = today).
        #[arg(long, num_args = 0..=1, default_missing_value = "today")]
        daily: Option<String>,
        /// Append into the Inbox note.
        #[arg(long)]
        inbox: bool,
        /// Override the target section heading for this add.
        #[arg(long, value_name = "HEADING")]
        section: Option<String>,
        /// Due date (YYYY-MM-DD).
        #[arg(long, value_name = "DATE")]
        due: Option<String>,
        /// Scheduled date (YYYY-MM-DD).
        #[arg(long, value_name = "DATE")]
        scheduled: Option<String>,
        /// Start date (YYYY-MM-DD).
        #[arg(long, value_name = "DATE")]
        start: Option<String>,
        /// Priority word: highest|high|medium|low|lowest.
        #[arg(long, value_name = "WORD")]
        priority: Option<String>,
        /// Recurrence rule, e.g. `every week` or `every 2 weeks when done`.
        #[arg(long, value_name = "RULE")]
        repeat: Option<String>,
        /// Inline tag (repeatable).
        #[arg(long = "tag", value_name = "TAG")]
        tags: Vec<String>,
    },
    /// Toggle a task to its next status (todo -> done -> todo).
    Done {
        note_id: String,
        /// 0-based line within the note.
        line: u32,
        /// Line hash from `task list` (16 hex chars).
        #[arg(long, value_name = "HASH")]
        hash: Option<String>,
        /// Skip the hash guard (last-writer-wins).
        #[arg(long)]
        force: bool,
    },
    /// Set an explicit status symbol.
    Status {
        note_id: String,
        line: u32,
        /// Status symbol, e.g. `x`, ` `, `/`, `-`.
        symbol: String,
        #[arg(long, value_name = "HASH")]
        hash: Option<String>,
        #[arg(long)]
        force: bool,
    },
    /// Edit one task field (`--set-due DATE`, `--clear-due`,
    /// `--set-text`, `--set-priority`, `--set-repeat`, `--clear-repeat`
    /// — exactly one per invocation).
    Edit {
        note_id: String,
        line: u32,
        #[arg(long, value_name = "HASH")]
        hash: Option<String>,
        #[arg(long)]
        force: bool,
        #[arg(long = "set-due", value_name = "DATE")]
        set_due: Option<String>,
        #[arg(long = "clear-due")]
        clear_due: bool,
        #[arg(long = "set-text", value_name = "TEXT")]
        set_text: Option<String>,
        #[arg(long = "set-priority", value_name = "WORD")]
        set_priority: Option<String>,
        #[arg(long = "set-repeat", value_name = "RULE")]
        set_repeat: Option<String>,
        #[arg(long = "clear-repeat")]
        clear_repeat: bool,
    },
    /// Delete a task line (subtree re-roots at its indent).
    Rm {
        note_id: String,
        line: u32,
        #[arg(long, value_name = "HASH")]
        hash: Option<String>,
        #[arg(long)]
        force: bool,
    },
    /// Move not-done tasks from an older daily note into a newer one.
    Rollover {
        /// Source date (YYYY-MM-DD; default: local yesterday).
        #[arg(long, value_name = "DATE")]
        from: Option<String>,
        /// Target date (default: local today).
        #[arg(long, value_name = "DATE")]
        to: Option<String>,
        /// Preview candidates without moving.
        #[arg(long)]
        dry_run: bool,
    },
}

#[derive(Subcommand)]
enum MetadataCmd {
    /// Search a domain's providers; hits print as NDJSON (json for
    /// eyeballing). Empty when metadata is disabled or no keys match.
    Search {
        query: String,
        /// book | movie.
        #[arg(long, value_enum)]
        domain: commands::MetadataDomain,
        /// table | json | ndjson (ndjson default — agent-facing).
        #[arg(long, default_value = "ndjson")]
        format: String,
    },
}

#[derive(Subcommand)]
enum VaultCmd {
    /// Print the vault root path.
    Path,
}

#[derive(Subcommand)]
enum CollectionCmd {
    /// List the installable preset catalog (id + name, JSON).
    List,
    /// Install a preset into a folder (created if missing;
    /// skip-if-exists — existing files are never overwritten).
    Install {
        /// Preset id from `collection list` (book, movie, …).
        id: String,
        /// Target folder path.
        folder: String,
    },
}

#[derive(Subcommand)]
enum BaseCmd {
    /// List the vault's `.query` bases. Unloadable files are listed
    /// too, with a ⚠ marker.
    List {
        /// table | json | ndjson
        #[arg(long, default_value = "table")]
        format: String,
    },
    /// Run one page of a `.query` view and print the table.
    Run {
        /// Vault-relative `.query` path (e.g. `queries/all.query`).
        path: String,
        /// View index within the file (0-based).
        #[arg(long)]
        view: Option<usize>,
        /// Page size.
        #[arg(long, default_value_t = 30)]
        limit: u32,
        /// Page offset.
        #[arg(long, default_value_t = 0)]
        offset: usize,
    },
    /// Rename/move a `.query` file (destination must not exist).
    Rename { from: String, to: String },
    /// Move a `.query` file to trash; prints the restore token.
    Trash { path: String },
    /// Restore a trashed `.query` file by its token.
    Restore { token: String },
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
    // `space` needs no vault: handled before any resolution (below).
    if let Cmd::Space { sub } = &cli.cmd {
        return match sub.clone().unwrap_or(SpaceCmd::List) {
            SpaceCmd::List => commands::cmd_space_list(),
            SpaceCmd::Add { name } => commands::cmd_space_add(&name),
            SpaceCmd::Switch { name } => commands::cmd_space_switch(&name),
        };
    }
    let spec =
        oximemo_core::spaces::resolve_vault_spec(cli.vault.as_deref(), cli.space.as_deref())?;
    let vault = Vault::open_spec(&spec)?;
    vault.migrate()?;
    match cli.cmd {
        Cmd::New {
            text,
            tags,
            folder,
            html,
            set,
        } => {
            let mut sets: Vec<(String, oximemo_core::PropValue)> = Vec::new();
            for s in &set {
                let (k, v) = s
                    .split_once('=')
                    .ok_or_else(|| anyhow!("invalid --set {s:?}: expected KEY=VAL"))?;
                let value = if v.contains(',') {
                    oximemo_core::PropValue::List(
                        v.split(',').map(|p| p.trim().to_string()).collect(),
                    )
                } else {
                    oximemo_core::PropValue::Str(v.to_string())
                };
                sets.push((k.trim().to_string(), value));
            }
            commands::cmd_new(&vault, text, tags, folder, html, sets).map(|_| ())
        }
        Cmd::List {
            limit,
            tag,
            folder,
            favorites,
            where_,
            sort,
            offset,
            format,
        } => {
            let fmt = format::Format::from_arg(&format)
                .ok_or_else(|| anyhow!("unknown --format: {format}"))?;
            let predicates = where_
                .iter()
                .map(|w| oximemo_core::parse_where(w))
                .map(|r| r.map_err(|e| anyhow::anyhow!(e)))
                .collect::<Result<Vec<_>>>()?;
            let sort_spec = match &sort {
                Some(s) => Some(oximemo_core::parse_sort(s)?),
                None => None,
            };
            commands::cmd_list(
                &vault, limit, tag, folder, favorites, predicates, sort_spec, offset, fmt,
            )
        }
        Cmd::Metadata { sub } => match sub {
            MetadataCmd::Search {
                query,
                domain,
                format,
            } => {
                let fmt = format::Format::from_arg(&format)
                    .ok_or_else(|| anyhow!("unknown --format: {format}"))?;
                commands::cmd_metadata_search(&vault, domain, &query, fmt)
            }
        },
        Cmd::Stamp { id } => commands::cmd_stamp_stdin(&vault, parse_id(&id)?),
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
        Cmd::Folders { format } => {
            let fmt = format::Format::from_arg(&format)
                .ok_or_else(|| anyhow!("unknown --format: {format}"))?;
            commands::cmd_folders(&vault, fmt)
        }
        Cmd::Collection { sub } => match sub {
            CollectionCmd::List => commands::cmd_collection_list(),
            CollectionCmd::Install { id, folder } => {
                commands::cmd_collection_install(&vault, &id, &folder)
            }
        },
        Cmd::Schema { folder } => commands::cmd_schema(&vault, folder),
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
            set,
            unset,
        } => {
            let fav = if unfavorite {
                Some(false)
            } else if favorite {
                Some(true)
            } else {
                None
            };
            let mut pm = oximemo_core::PropMutation::default();
            for s in &set {
                let (k, v) = s
                    .split_once('=')
                    .ok_or_else(|| anyhow!("invalid --set {s:?}: expected KEY=VAL"))?;
                let value = if v.contains(',') {
                    oximemo_core::PropValue::List(
                        v.split(',').map(|x| x.trim().to_string()).collect(),
                    )
                } else {
                    oximemo_core::PropValue::Str(v.to_string())
                };
                pm.sets.push((k.trim().to_string(), value));
            }
            for k in &unset {
                pm.removes.push(k.clone());
            }
            let props = if pm.is_empty() { None } else { Some(pm) };
            commands::cmd_update(&vault, parse_id(&id)?, body, body_stdin, fav, props)
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
        Cmd::Base { sub } => match sub {
            BaseCmd::List { format } => {
                let fmt = format::Format::from_arg(&format)
                    .ok_or_else(|| anyhow!("unknown --format: {format}"))?;
                commands::cmd_base_list(&vault, fmt)
            }
            BaseCmd::Run {
                path,
                view,
                limit,
                offset,
            } => commands::cmd_base_run(&vault, &path, view, limit, offset),
            BaseCmd::Rename { from, to } => commands::cmd_base_rename(&vault, &from, &to),
            BaseCmd::Trash { path } => commands::cmd_base_trash(&vault, &path),
            BaseCmd::Restore { token } => commands::cmd_base_restore(&vault, &token),
        },
        Cmd::Task { sub } => dispatch_task(&vault, sub),
        // Handled before the vault is opened (see above).
        Cmd::Upgrade { .. } => unreachable!(),
        Cmd::Space { .. } => unreachable!(),
    }
}

/// `oximemo task …` dispatch. Kept out of `run()`'s match so the
/// mutation-guard validation (`--hash` XOR `--force`) reads as one
/// block instead of being repeated across four arms.
fn dispatch_task(vault: &Vault, sub: TaskCmd) -> Result<()> {
    // Exactly one of --hash/--force is required per mutating subcommand
    // (spec §5 `(--hash H | --force)`): hash = guarded, force =
    // last-writer-wins.
    let guard = |hash: &Option<String>, force: bool| -> Result<commands::TaskGuard> {
        match (hash.as_deref(), force) {
            (Some(_), true) => Err(anyhow!("--hash and --force are mutually exclusive")),
            (Some(h), false) => Ok(commands::TaskGuard::Hash(commands::parse_line_hash(h)?)),
            (None, false) => Err(anyhow!(
                "pass either --hash H (guarded) or --force (last-writer-wins)"
            )),
            (None, true) => Ok(commands::TaskGuard::Force),
        }
    };
    match sub {
        TaskCmd::List {
            where_,
            note,
            folder,
            due,
            status,
            not_done,
            limit,
            format,
        } => commands::cmd_task_list(
            vault,
            &commands::TaskListArgs {
                where_: where_.as_deref(),
                note: note.as_deref(),
                folder: folder.as_deref(),
                due: due.as_deref(),
                status: status.as_deref(),
                not_done,
                limit,
                format: &format,
            },
        ),
        TaskCmd::Add {
            text,
            note,
            daily,
            inbox,
            section,
            due,
            scheduled,
            start,
            priority,
            repeat,
            tags,
        } => commands::cmd_task_add(
            vault,
            &text,
            &commands::TaskAddArgs {
                note: note.as_deref(),
                daily: daily.as_deref(),
                inbox,
                section: section.as_deref(),
                due: due.as_deref(),
                scheduled: scheduled.as_deref(),
                start: start.as_deref(),
                priority: priority.as_deref(),
                repeat: repeat.as_deref(),
                tags: &tags,
            },
        ),
        TaskCmd::Done {
            note_id,
            line,
            hash,
            force,
        } => commands::cmd_task_patch(
            vault,
            &commands::TaskPatchArgs {
                note_id: &note_id,
                line,
                guard: guard(&hash, force)?,
                edit: commands::parse_task_edit("toggle", None)?,
            },
        ),
        TaskCmd::Status {
            note_id,
            line,
            symbol,
            hash,
            force,
        } => commands::cmd_task_patch(
            vault,
            &commands::TaskPatchArgs {
                note_id: &note_id,
                line,
                guard: guard(&hash, force)?,
                edit: commands::parse_task_edit("status", Some(&symbol))?,
            },
        ),
        TaskCmd::Edit {
            note_id,
            line,
            hash,
            force,
            set_due,
            clear_due,
            set_text,
            set_priority,
            set_repeat,
            clear_repeat,
        } => {
            let mut which: Option<(&str, Option<String>)> = None;
            let mut set = |kind: &'static str, val: Option<String>| -> Result<()> {
                if which.is_some() {
                    Err(anyhow!("one edit per invocation"))
                } else {
                    which = Some((kind, val));
                    Ok(())
                }
            };
            if let Some(d) = set_due {
                set("set-due", Some(d))?;
            }
            if clear_due {
                set("clear-due", None)?;
            }
            if let Some(t) = set_text {
                set("set-text", Some(t))?;
            }
            if let Some(p) = set_priority {
                set("set-priority", Some(p))?;
            }
            if let Some(r) = set_repeat {
                set("set-repeat", Some(r))?;
            }
            if clear_repeat {
                set("clear-repeat", None)?;
            }
            let Some((kind, val)) = which else {
                return Err(anyhow!(
                    "no edit specified; pass --set-due/--clear-due/--set-text/--set-priority/--set-repeat/--clear-repeat"
                ));
            };
            commands::cmd_task_patch(
                vault,
                &commands::TaskPatchArgs {
                    note_id: &note_id,
                    line,
                    guard: guard(&hash, force)?,
                    edit: commands::parse_task_edit(kind, val.as_deref())?,
                },
            )
        }
        TaskCmd::Rm {
            note_id,
            line,
            hash,
            force,
        } => commands::cmd_task_patch(
            vault,
            &commands::TaskPatchArgs {
                note_id: &note_id,
                line,
                guard: guard(&hash, force)?,
                edit: commands::parse_task_edit("rm", None)?,
            },
        ),
        TaskCmd::Rollover { from, to, dry_run } => {
            commands::cmd_task_rollover(vault, from.as_deref(), to.as_deref(), dry_run)
        }
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
