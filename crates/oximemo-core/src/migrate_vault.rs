//! One-time default-vault migration (design 2026-08-20 §5.1, §7.2).
//!
//! The default vault moves from the pre-unification application-support
//! location (`~/Library/Application Support/com.oximemo.app/vault`) to the
//! shared ecosystem location `~/.oxi/spaces/personal/vault`. On `Vault::open(None)` this
//! module runs **before** path resolution and decides between:
//!
//! - **old populated ∧ new absent** — move the entire tree
//!   (`.trash/`, `_assets/`, `oximemo.toml`, habits, everything) and
//!   convert v3 `+++`TOML note frontmatter to the v4 `---`YAML contract
//!   via `oxi-frontmatter`;
//! - **both populated** — never touch either tree; surface
//!   [`MigrationStatus::MergeRequired`] so GUI/CLI can ask the user to
//!   merge by hand (no silent overwrite, no silent skip);
//! - **old absent** — already migrated (or fresh); a leftover-conversion
//!   retry pass is guarded by a marker under the derived index dir.
//!
//! The conversion is the only remaining v3 reader (the in-tree bridge was
//! removed): it parses the `+++` block with the `toml` crate — a
//! migration-only dependency — maps `id`/`created_at`/`updated_at`/
//! `favorite`/`deleted_at` to their v4 names, drops `hash` (recomputed
//! from the body on read) and `tags` (body-derived in v4), and keeps every
//! other key and app table verbatim. Malformed v3 frontmatter and
//! unreadable filesystem entries are both hard errors: every failure is
//! collected and reported together, never silently skipped. The
//! conversion marker ([`CONVERSION_MARKER`]) is withheld until the pass
//! completes cleanly so the self-heal retry actually runs.
//!
//! The move is journaled (see [`crate::migration_journal`]): the
//! journal entry is written before the first mutation and marked
//! complete after verification. A same-volume `rename` is atomic and
//! moves the data. The cross-volume (EXDEV) fallback copies the tree
//! with per-file verification and **keeps the source** as a retired
//! backup recorded in the journal — the old `remove_dir_all` here
//! could destroy the only good copy, so it is gone. Because the backup
//! keeps the old side populated, subsequent runs consult the journal:
//! a completed entry reads as [`MigrationStatus::AlreadyMigrated`]
//! (never [`MigrationStatus::MergeRequired`]), and doctor surfaces the
//! backup as safe to delete manually. The fallback follows file
//! symlinks and aborts on symlinked directories — the old default
//! vault never carries symlinks in practice — and a crash mid-copy
//! leaves the journal `in_progress`, so the next run resumes the copy
//! (idempotent: identical files are skipped by size + blake3).

use oxi_frontmatter::{NoteFormat, Parsed, Table, Value, atomic_write, emit, parse};
use std::path::{Path, PathBuf};

use crate::error::{CoreError, Result};
use crate::migration_journal as journal;
use crate::paths;

/// Outcome of the one-time default-vault migration check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MigrationStatus {
    /// Neither the old nor the new default vault exists (fresh install).
    Fresh,
    /// The new default vault is present and the old one is gone:
    /// already migrated (or created fresh on the new path).
    AlreadyMigrated,
    /// The tree was moved; `converted` notes were rewritten from v3
    /// `+++`TOML frontmatter to the v4 `---`YAML contract.
    Migrated {
        /// Number of note files converted.
        converted: usize,
    },
    /// Both the old and the new default vault exist. Their contents must
    /// be merged by hand before the migration can proceed; nothing was
    /// touched.
    MergeRequired {
        /// Pre-unification default vault (source).
        old: PathBuf,
        /// Shared ecosystem vault (target).
        new: PathBuf,
    },
}

/// Marker file (under the derived index dir) recording that the v3 → v4
/// conversion pass completed cleanly. Its absence re-runs the pass so a
/// run that failed on malformed notes retries after the user fixes them.
const CONVERSION_MARKER: &str = "v3-converted";

/// Pre-unification default vault: `<user-home>/Library/Application
/// Support/com.oximemo.app/vault`. Takes the **user** home, not the
/// Oxi home — the legacy location predates `~/.oxi` entirely.
pub fn old_default_vault(user_home: &Path) -> PathBuf {
    paths::legacy_app_support_dir(user_home).join(paths::VAULT_DEFAULT_SUBDIR)
}

/// Shared ecosystem default vault: `<oxi-home>/spaces/personal/vault`
/// (the post-spaces target; the historical `~/.oxi/vault` hop is
/// handled by [`crate::migrate_spaces`]).
pub fn new_default_vault(oxi_home: &Path) -> PathBuf {
    oxi_home
        .join(paths::SPACES_SUBDIR)
        .join(crate::spaces::DEFAULT_SPACE_NAME)
        .join(paths::VAULT_DEFAULT_SUBDIR)
}

/// Derived index dir for the default vault: `<oxi-home>/oximemo/index`.
fn support_index_dir(oxi_home: &Path) -> PathBuf {
    oxi_home.join("oximemo").join(paths::INDEX_SUBDIR)
}

/// Filesystem debris that an empty-looking counterpart might carry
/// (macOS Finder `.DS_Store`, Spotlight indexes, Windows `Thumbs.db`,
/// …). A stray artifact in a fresh counterpart would otherwise flip the
/// branch decision to [`MigrationStatus::MergeRequired`] and block the
/// auto-migration. Vault-meaningful hidden entries like `.trash/` are
/// not in this list.
const VAULT_CRUFT: &[&str] = &[
    ".DS_Store",
    ".localized",
    ".fseventsd",
    ".Spotlight-V100",
    ".Trashes",
    ".TemporaryItems",
    "Thumbs.db",
    "desktop.ini",
];

/// v4 canonical frontmatter names. A stray v3 key whose name collides
/// with one of these is dropped by [`map_v3_to_v4`] so it cannot
/// silently overwrite a field the typed mapping already produced (e.g.
/// a hand-written `created` next to `created_at`).
const CORE_KEYS: &[&str] = &["id", "created", "updated", "favorite", "deleted"];

/// Migrate the application-support default vault into the shared
/// spaces layout.
///
/// * `oxi_home` — the shared Oxi home (`~/.oxi`, `OXI_HOME`-aware):
///   the migration target and the journal location hang off it.
/// * `legacy_home` — the user home holding the pre-unification
///   application-support vault. `None` (no `$HOME`) means no legacy
///   candidate can exist.
///
/// Never overwrites: when both locations are populated without an
/// in-progress journal entry the trees are left untouched and
/// [`MigrationStatus::MergeRequired`] is returned. A completed journal
/// entry settles the cross-volume case where the retired backup keeps
/// the old side populated forever.
///
/// # Errors
///
/// - I/O failures while moving or converting.
/// - [`CoreError::Other`] listing **every** note whose v3 frontmatter
///   could not be converted (malformed TOML, missing required fields,
///   unrepresentable values). Convertible notes are still converted, so
///   fixing the listed files and re-running makes progress.
pub fn maybe_migrate(oxi_home: &Path, legacy_home: Option<&Path>) -> Result<MigrationStatus> {
    let new = new_default_vault(oxi_home);
    let old = legacy_home.map(old_default_vault);

    // A completed journal entry settles every ambiguity the filesystem
    // cannot: with the cross-volume fallback the retired backup keeps
    // `old` populated forever, which must never read as MergeRequired.
    if journal::is_complete(oxi_home, journal::APP_SUPPORT_VAULT) {
        retry_conversion_if_needed(oxi_home, &new)?;
        return Ok(MigrationStatus::AlreadyMigrated);
    }

    let old_populated = old.as_deref().is_some_and(is_populated);
    let new_populated = is_populated(&new);

    match (old_populated, new_populated) {
        (false, false) => Ok(MigrationStatus::Fresh),
        (true, false) => {
            let old = old.expect("old_populated implies a legacy home");
            // Journal before the first mutation: a crash anywhere in
            // the move/conversion below leaves visible resume state.
            journal::begin(oxi_home, journal::APP_SUPPORT_VAULT, &old, &new);
            // `is_populated` filters cruft, but a directory containing
            // *only* a stray `.DS_Store` is still non-empty on disk and
            // `fs::rename` rejects an existing non-empty destination
            // with `ENOTEMPTY`. Strip the cruft first; if anything real
            // is present, refuse and let the user merge by hand.
            match prepare_cruft_only_destination(&new)? {
                CruftDestOutcome::Empty | CruftDestOutcome::Cleared => {}
                CruftDestOutcome::ConservativeMergeRequired => {
                    return Ok(MigrationStatus::MergeRequired { old, new });
                }
            }
            match move_tree(&old, &new)? {
                MoveOutcome::Renamed => {
                    let converted = run_conversion(&new, &support_index_dir(oxi_home))?;
                    journal::complete(oxi_home, journal::APP_SUPPORT_VAULT, None);
                    Ok(MigrationStatus::Migrated { converted })
                }
                // Cross-volume fallback: the verified copy is done, the
                // source stays as a retired backup.
                MoveOutcome::CopiedToBackup => finish_cross_fs(oxi_home, &old, &new),
            }
        }
        (true, true) => {
            let old = old.expect("old_populated implies a legacy home");
            // Both sides populated: either a genuine conflict (never
            // touched) or the interrupted cross-volume copy the journal
            // knows how to resume. The rename path cannot produce this
            // state — it is atomic.
            let in_progress = journal::entry(oxi_home, journal::APP_SUPPORT_VAULT)
                .is_some_and(|e| e.status == journal::STATUS_IN_PROGRESS);
            if !in_progress {
                return Ok(MigrationStatus::MergeRequired { old, new });
            }
            copy_tree_resume(&old, &new)?;
            finish_cross_fs(oxi_home, &old, &new)
        }
        (false, true) => {
            // Already migrated (or a rename that landed before its
            // journal update — settle the entry now). Retry any
            // leftover v3 notes once — guarded by the marker so the
            // steady-state open never walks the tree.
            journal::complete(oxi_home, journal::APP_SUPPORT_VAULT, None);
            retry_conversion_if_needed(oxi_home, &new)?;
            Ok(MigrationStatus::AlreadyMigrated)
        }
    }
}

/// Settle a verified cross-volume migration: run the v3→v4 conversion
/// over the destination and record the kept source tree as a retired
/// backup in the journal.
fn finish_cross_fs(oxi_home: &Path, old: &Path, new: &Path) -> Result<MigrationStatus> {
    let converted = run_conversion(new, &support_index_dir(oxi_home))?;
    journal::complete(oxi_home, journal::APP_SUPPORT_VAULT, Some(old));
    tracing::info!(
        backup = %old.display(),
        "cross-volume vault migration kept the source as a retired backup \
         (safe to delete manually once the new layout is confirmed)"
    );
    Ok(MigrationStatus::Migrated { converted })
}

/// Conversion retry pass for opens where the tree already sits on the
/// new path (marker-guarded so the steady state never walks the tree).
fn retry_conversion_if_needed(oxi_home: &Path, new: &Path) -> Result<()> {
    let index_dir = support_index_dir(oxi_home);
    if !index_dir.join(CONVERSION_MARKER).exists() {
        run_conversion(new, &index_dir)?;
    }
    Ok(())
}

/// Cross-volume migration path, extracted for direct testing: EXDEV
/// cannot be reproduced on a single volume, so the journaled
/// copy-verify-keep-source flow (including resume) is exercised
/// through this entry point.
#[cfg(test)]
fn cross_fs_migrate(oxi_home: &Path, old: &Path, new: &Path) -> Result<MigrationStatus> {
    if let Some(parent) = new.parent() {
        std::fs::create_dir_all(parent)?;
    }
    copy_tree_resume(old, new)?;
    finish_cross_fs(oxi_home, old, new)
}

/// Outcome of inspecting a non-empty destination under the (true,false)
/// branch: either the destination holds nothing removable and we must
/// refuse the move (conservative — never delete unknown content), or
/// every entry is a removable cruft file we can strip.
enum CruftDestOutcome {
    /// Destination is empty (or absent) — `rename` will succeed.
    Empty,
    /// Every entry in the destination is removable cruft; the caller
    /// has already removed it. `rename` will now succeed.
    Cleared,
    /// Destination holds at least one non-cruft entry; refuse to touch.
    ConservativeMergeRequired,
}

/// Inspect a would-be destination and make it safe to `rename` over:
/// either leave it alone (empty / absent), strip purely-cruft entries
/// that would otherwise make `rename` fail with `ENOTEMPTY`, or refuse
/// to touch it (anything real is present — let the caller report
/// [`MigrationStatus::MergeRequired`]).
///
/// Cruft entries are limited to the file names in [`VAULT_CRUFT`]
/// (e.g. `.DS_Store`). Any other file — including `.git`, `.obsidian`,
/// `.trash`, an existing note, the config, … — is treated as content
/// the user must merge themselves.
fn prepare_cruft_only_destination(dest: &Path) -> Result<CruftDestOutcome> {
    let entries = match std::fs::read_dir(dest) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(CruftDestOutcome::Empty);
        }
        Err(e) => return Err(e.into()),
    };
    let mut saw_cruft = false;
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let is_cruft = VAULT_CRUFT.iter().any(|cruft| name == **cruft);
        if is_cruft {
            saw_cruft = true;
            let path = entry.path();
            if entry.file_type()?.is_dir() {
                std::fs::remove_dir_all(&path)?;
            } else {
                std::fs::remove_file(&path)?;
            }
        } else {
            // Anything real is present — abort the cleanup; the caller
            // will refuse the move and surface MergeRequired.
            return Ok(CruftDestOutcome::ConservativeMergeRequired);
        }
    }
    Ok(if saw_cruft {
        CruftDestOutcome::Cleared
    } else {
        CruftDestOutcome::Empty
    })
}

/// A directory exists and has at least one **vault-meaningful** entry:
/// pure filesystem debris (`.DS_Store`, Spotlight caches, …) does not
/// count, otherwise a stray Finder file in an empty counterpart would
/// flip the branch decision to [`MigrationStatus::MergeRequired`] and
/// block auto-migration. `pub(crate)` so the `migrate-home` preflight
/// reports pending state with the same cruft-aware definition.
pub(crate) fn is_populated(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries
        .flatten()
        .any(|e| !VAULT_CRUFT.iter().any(|cruft| e.file_name() == **cruft))
}

/// How [`move_tree`] moved the tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MoveOutcome {
    /// Same-volume `rename`: atomic, the data moved, the source is gone.
    Renamed,
    /// Cross-volume fallback: the tree was copied and verified, and the
    /// source was intentionally kept as a retired backup (recorded in
    /// the journal — never deleted here).
    CopiedToBackup,
}

/// Move the whole old vault tree to the new location. `rename` is
/// atomic on one volume (the common case — both paths live under the
/// home); the cross-device fallback copies the tree with per-file
/// verification and KEEPS the source. If the fallback dies midway, the
/// journal stays `in_progress` and the next run resumes the copy
/// (idempotent by content digest) — it never silently drops data and
/// never destroys the only copy.
fn move_tree(old: &Path, new: &Path) -> Result<MoveOutcome> {
    if let Some(parent) = new.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match std::fs::rename(old, new) {
        Ok(()) => Ok(MoveOutcome::Renamed),
        Err(e) if e.kind() == std::io::ErrorKind::CrossesDevices => {
            copy_tree_resume(old, new)?;
            Ok(MoveOutcome::CopiedToBackup)
        }
        Err(e) => Err(e.into()),
    }
}

/// Recursive verbatim copy with per-file verification and idempotent
/// resume (cross-device fallback of [`move_tree`]): files already
/// present at the destination with identical size and blake3 digest
/// are skipped, so an interrupted copy continues instead of restarting.
///
/// **Limitation:** file symlinks are followed and materialized into the
/// destination via [`std::fs::copy`]; symlinked directories surface as
/// `EISDIR` and abort the copy. The migration never sees real-world
/// symlinks in the old default vault (macOS app-support is symlink-
/// free), and an aborted copy leaves the source intact.
fn copy_tree_resume(src: &Path, dst: &Path) -> Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree_resume(&from, &to)?;
        } else if !identical_file(&from, &to) {
            std::fs::copy(&from, &to)?;
            if !identical_file(&from, &to) {
                return Err(CoreError::Other(format!(
                    "copy verification failed for {}",
                    from.display()
                )));
            }
        }
    }
    Ok(())
}

/// Size-then-digest equality. Unreadable counterparts count as
/// *different* (forcing a fresh copy), never silently equal.
fn identical_file(a: &Path, b: &Path) -> bool {
    let (Ok(ma), Ok(mb)) = (std::fs::metadata(a), std::fs::metadata(b)) else {
        return false;
    };
    if !ma.is_file() || !mb.is_file() || ma.len() != mb.len() {
        return false;
    }
    match (file_digest(a), file_digest(b)) {
        (Ok(da), Ok(db)) => da == db,
        // A destination file we cannot read back is not verified — copy.
        _ => false,
    }
}

fn file_digest(path: &Path) -> std::io::Result<[u8; 32]> {
    let mut hasher = blake3::Hasher::new();
    std::io::copy(&mut std::fs::File::open(path)?, &mut hasher)?;
    Ok(*hasher.finalize().as_bytes())
}

/// Run the v3 → v4 conversion pass over `root`, then write the marker on
/// a clean finish. Malformed files are **all** reported in one error —
/// convertible ones are still converted so a fix-and-retry makes progress.
fn run_conversion(root: &Path, index_dir: &Path) -> Result<usize> {
    let mut stats = ConvertStats::default();
    convert_tree(root, &mut stats);
    if !stats.malformed.is_empty() {
        let details = stats
            .malformed
            .iter()
            .map(|(path, reason)| format!("  {}: {reason}", path.display()))
            .collect::<Vec<_>>()
            .join("\n");
        return Err(CoreError::other(format!(
            "v3 → v4 conversion failed for {} file(s); fix or remove them and restart:\n{details}",
            stats.malformed.len()
        )));
    }
    std::fs::create_dir_all(index_dir)?;
    std::fs::write(
        index_dir.join(CONVERSION_MARKER),
        format!("{}\n", stats.converted),
    )?;
    Ok(stats.converted)
}

/// Recursively walk `root` converting every v3 note found. Malformed
/// files and unreadable filesystem entries are collected into
/// `stats.malformed` so the caller can report **every** offender at once
/// and refuse to write [`CONVERSION_MARKER`] until the walk completes
/// cleanly — otherwise an unreadable subtree (EACCES/EIO/…) would
/// silently strand its v3 notes as BodyOnly in the index, outside the
/// self-healing retry path.
fn convert_tree(root: &Path, stats: &mut ConvertStats) {
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(e) => {
            stats
                .malformed
                .push((root.to_path_buf(), format!("cannot read directory: {e}")));
            return;
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                stats.malformed.push((
                    root.to_path_buf(),
                    format!("directory entry unreadable: {e}"),
                ));
                continue;
            }
        };
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(e) => {
                stats
                    .malformed
                    .push((entry.path(), format!("file type unreadable: {e}")));
                continue;
            }
        };
        if file_type.is_symlink() {
            // Moved verbatim; never followed (avoid cycles).
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            convert_tree(&path, stats);
        } else if file_type.is_file() && is_note_path(&path) {
            match convert_file(&path) {
                Ok(true) => stats.converted += 1,
                Ok(false) => {}
                Err(reason) => stats.malformed.push((path, reason)),
            }
        }
    }
}

/// `.md` / `.html` note extension check (mirrors the store scanner).
fn is_note_path(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e == "md" || e == "html")
}

/// Convert a single v3 note file in place. `Ok(false)` means the file has
/// no v3 fence (nothing to do — system and foreign files pass through
/// verbatim). Errors carry a human-readable reason for collection.
fn convert_file(path: &Path) -> std::result::Result<bool, String> {
    let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let fmt = match path.extension().and_then(|e| e.to_str()) {
        Some("html") => NoteFormat::Html,
        _ => NoteFormat::Markdown,
    };
    let (toml_text, body) = match fmt {
        NoteFormat::Markdown => match split_v3_markdown(&content)? {
            Some(split) => split,
            None => return Ok(false),
        },
        NoteFormat::Html => match crate::html::split_frontmatter(&content) {
            crate::html::HtmlFrontmatterSplit::Some { toml_text, body } => {
                (toml_text.to_string(), body.to_string())
            }
            crate::html::HtmlFrontmatterSplit::None { .. } => return Ok(false),
        },
    };
    let raw: toml::Table =
        toml::from_str(&toml_text).map_err(|e| format!("invalid TOML frontmatter: {e}"))?;
    let table = map_v3_to_v4(&raw)?;

    // Round-trip guard: never write a document the v4 parser would read
    // back differently (unknown keys, app tables, body — all of it).
    let emitted = emit(&table, &body, fmt);
    match parse(&emitted, fmt) {
        Ok(Parsed::Memo {
            table: read_back,
            body: read_body,
        }) if read_back == table && read_body == body => {}
        Ok(_) => {
            return Err(
                "converted document does not round-trip through the v4 grammar".to_string(),
            );
        }
        Err(e) => return Err(format!("emitted v4 frontmatter does not re-parse: {e}")),
    }
    atomic_write(path, emitted.as_bytes()).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Split a v3 markdown note into TOML frontmatter + body, mirroring the
/// deleted v3 reader exactly: the first line must be `+++`, the block
/// runs to the next `+++` line, and the body starts after that line with
/// exactly one leading newline dropped (the conventional separator).
/// `Ok(None)` = no v3 fence (foreign/system file).
fn split_v3_markdown(content: &str) -> std::result::Result<Option<(String, String)>, String> {
    let first_line_end = content.find('\n').unwrap_or(content.len());
    if content[..first_line_end].trim_end_matches('\r') != "+++" {
        return Ok(None);
    }
    let after_open = match content.find('\n') {
        Some(i) => i + 1,
        None => return Err("empty v3 frontmatter (unclosed fence)".to_string()),
    };
    let mut pos = after_open;
    while pos < content.len() {
        let line_end = content[pos..]
            .find('\n')
            .map(|i| pos + i)
            .unwrap_or(content.len());
        if content[pos..line_end].trim_end_matches('\r') == "+++" {
            let toml_text = content[after_open..pos].to_string();
            let body_start = if line_end < content.len() {
                line_end + 1
            } else {
                content.len()
            };
            let mut body = &content[body_start..];
            if body.starts_with('\n') {
                body = &body[1..];
            }
            return Ok(Some((toml_text, body.to_string())));
        }
        pos = if line_end < content.len() {
            line_end + 1
        } else {
            break;
        }
    }
    Err("missing closing `+++` delimiter".to_string())
}

/// Map a parsed v3 TOML frontmatter table onto the v4 table shape:
/// `id`/`created_at`/`updated_at`/`favorite`/`deleted_at` →
/// `id`/`created`/`updated`/`favorite`/`deleted`; `hash` dropped
/// (recomputed from the body on read) and `tags` dropped (body-derived
/// in v4); every other key and app table kept.
fn map_v3_to_v4(raw: &toml::Table) -> std::result::Result<Table, String> {
    let mut out = Table::new();

    let id = match raw.get("id") {
        Some(toml::Value::String(s)) => s.clone(),
        Some(other) => {
            return Err(format!(
                "field `id` must be a string, got {}",
                toml_kind(other)
            ));
        }
        None => return Err("missing required field `id`".to_string()),
    };
    out.insert("id".to_string(), Value::Str(id));
    out.insert(
        "created".to_string(),
        Value::Str(rfc3339_field(raw, "created_at")?),
    );
    out.insert(
        "updated".to_string(),
        Value::Str(rfc3339_field(raw, "updated_at")?),
    );
    let favorite = match raw.get("favorite") {
        Some(toml::Value::Boolean(b)) => *b,
        None => false,
        Some(other) => {
            return Err(format!(
                "field `favorite` must be a boolean, got {}",
                toml_kind(other)
            ));
        }
    };
    out.insert("favorite".to_string(), Value::Bool(favorite));
    if raw.contains_key("deleted_at") {
        out.insert(
            "deleted".to_string(),
            Value::Str(rfc3339_field(raw, "deleted_at")?),
        );
    }
    // Carry over unknown keys + app tables, **but refuse to silently
    // overwrite a core v4 field**. A v3 file that hand-wrote a stray
    // `created` (or `updated` / `favorite` / `deleted` / `id`) alongside
    // the canonical `created_at` is treated as malformed: the mapped
    // value wins, never the random hand-written one.
    for (key, value) in raw {
        if matches!(
            key.as_str(),
            "id" | "created_at" | "updated_at" | "favorite" | "deleted_at" | "hash" | "tags"
        ) {
            continue;
        }
        if CORE_KEYS.contains(&key.as_str()) {
            return Err(format!(
                "stray field `{key}` collides with the v4 mapping; \
                 remove or rename it (the typed value is authoritative)"
            ));
        }
        if let Some(converted) =
            convert_value(value).map_err(|e| format!("field `{key}` cannot be converted: {e}"))?
        {
            out.insert(key.clone(), converted);
        }
    }
    Ok(out)
}

/// Extract + validate an RFC3339 timestamp field (TOML datetime or
/// quoted string; v3's serde wrote the offset form).
fn rfc3339_field(raw: &toml::Table, name: &str) -> std::result::Result<String, String> {
    let Some(value) = raw.get(name) else {
        return Err(format!("missing required field `{name}`"));
    };
    let s = match value {
        toml::Value::String(s) => s.clone(),
        toml::Value::Datetime(d) => d.to_string(),
        other => {
            return Err(format!(
                "field `{name}` must be an RFC3339 timestamp, got {}",
                toml_kind(other)
            ));
        }
    };
    time::OffsetDateTime::parse(&s, &time::format_description::well_known::Rfc3339)
        .map_err(|e| format!("field `{name}` is not RFC3339 ({s}): {e}"))?;
    Ok(s)
}

/// Convert one unknown v3 value to the v4 grammar. `Ok(None)` means the
/// key is dropped: empty arrays (`key = []`) have no representable v4
/// form — the same call the old v3→v4 bridge made.
fn convert_value(value: &toml::Value) -> std::result::Result<Option<Value>, String> {
    Ok(match value {
        toml::Value::String(s) => Some(Value::Str(s.clone())),
        toml::Value::Integer(i) => Some(Value::Str(i.to_string())),
        toml::Value::Float(f) => Some(Value::Str(f.to_string())),
        toml::Value::Boolean(b) => Some(Value::Bool(*b)),
        toml::Value::Datetime(d) => Some(Value::Str(d.to_string())),
        toml::Value::Array(items) => {
            if items.is_empty() {
                None
            } else {
                let mut out = Vec::with_capacity(items.len());
                for item in items {
                    let s = match item {
                        toml::Value::String(s) => s.clone(),
                        toml::Value::Integer(i) => i.to_string(),
                        toml::Value::Float(f) => f.to_string(),
                        toml::Value::Boolean(b) => b.to_string(),
                        toml::Value::Datetime(d) => d.to_string(),
                        other => {
                            return Err(format!("nested {} inside an array", toml_kind(other)));
                        }
                    };
                    out.push(s);
                }
                Some(Value::Array(out))
            }
        }
        toml::Value::Table(sub) => {
            let mut map = Table::new();
            for (k, v) in sub {
                if let Some(converted) = convert_value(v)? {
                    map.insert(k.clone(), converted);
                }
            }
            Some(Value::Map(map))
        }
    })
}

/// Human-readable TOML kind for error messages.
fn toml_kind(value: &toml::Value) -> &'static str {
    match value {
        toml::Value::String(_) => "a string",
        toml::Value::Integer(_) => "an integer",
        toml::Value::Float(_) => "a float",
        toml::Value::Boolean(_) => "a boolean",
        toml::Value::Datetime(_) => "a datetime",
        toml::Value::Array(_) => "an array",
        toml::Value::Table(_) => "a table",
    }
}

/// Bookkeeping for one conversion pass.
#[derive(Default)]
struct ConvertStats {
    converted: usize,
    malformed: Vec<(PathBuf, String)>,
}
/// Test helper: run `f` with `HOME` pointed at `home`, serialized against
/// every other env-swapping test and restored even on panic.
///
/// `home` must be a **leaked** tempdir (`TempDir::keep`): unrelated
/// tests running concurrently resolve their derived index through
/// `app_support_dir()` (env `HOME`) at their own moment, so the swapped
/// home must stay alive for the whole test-binary run — deleting it
/// mid-run yanks index files out from under them.
#[cfg(test)]
pub(crate) fn with_home<T>(home: &Path, f: impl FnOnce() -> T) -> T {
    static LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());
    struct Restore(Option<String>);
    impl Drop for Restore {
        fn drop(&mut self) {
            match self.0.take() {
                Some(h) => unsafe { std::env::set_var("HOME", h) },
                None => unsafe { std::env::remove_var("HOME") },
            }
        }
    }
    let _guard = LOCK.lock();
    let _restore = Restore(std::env::var("HOME").ok());
    unsafe { std::env::set_var("HOME", home) };
    f()
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// The Oxi home for a user-home fixture: `<fixture>/.oxi`.
    fn oxi_of(home: &Path) -> PathBuf {
        home.join(".oxi")
    }

    /// One-line migration call used by every fixture: the fixture dir
    /// acts as the user home, `<fixture>/.oxi` as the Oxi home (the
    /// journal lands inside and keeps the test hermetic).
    fn migrate(home: &Path) -> Result<MigrationStatus> {
        maybe_migrate(&oxi_of(home), Some(home))
    }

    const V3_ID: &str = "0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";

    /// A canonical v3 markdown note: the seven keys the v3 typed writer
    /// always emitted. `extra` lines are inserted before the closing
    /// fence (unknown keys, app tables).
    fn v3_md(extra: &str) -> String {
        format!(
            "+++\n\
             id = \"{V3_ID}\"\n\
             created_at = 2025-01-02T03:04:05Z\n\
             updated_at = 2025-01-02T03:04:06Z\n\
             hash = \"cafe1234cafe1234\"\n\
             favorite = true\n\
             tags = [\"idea\"]\n\
             {extra}\
             +++\n\
             \n\
             # Title\n\
             \n\
             body text\n"
        )
    }

    /// Seed a populated pre-unification default vault under `home`.
    /// Returns the old vault path.
    fn seed_old_vault(home: &Path) -> PathBuf {
        let old = old_default_vault(home);
        std::fs::create_dir_all(old.join(".trash/novel")).unwrap();
        std::fs::create_dir_all(old.join("novel")).unwrap();
        std::fs::create_dir_all(old.join("_assets")).unwrap();
        std::fs::create_dir_all(old.join("habits")).unwrap();
        std::fs::write(old.join("oximemo.toml"), "[general]\n").unwrap();
        std::fs::write(old.join("_assets/img.png"), b"\x89PNG-not-really").unwrap();
        std::fs::write(old.join("novel/first.md"), v3_md("")).unwrap();
        std::fs::write(old.join(".trash/novel/old.md"), v3_md("")).unwrap();
        // System file: frontmatter-less, must move verbatim.
        std::fs::write(old.join("habits/emoji.md"), "\u{1f4da}\n").unwrap();
        old
    }

    // -- conversion (unit level) ------------------------------------------

    #[test]
    fn toml_to_yaml_conversion_fields() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("note.md");
        std::fs::write(&path, v3_md("")).unwrap();

        assert!(convert_file(&path).unwrap(), "v3 note must be converted");

        let converted = std::fs::read_to_string(&path).unwrap();
        assert!(converted.starts_with("---\n"), "v4 fence: {converted}");
        assert!(!converted.contains("+++"), "v3 fence must be gone");
        let Parsed::Memo { table, body } = parse(&converted, NoteFormat::Markdown).unwrap() else {
            panic!("converted note must carry frontmatter")
        };
        assert_eq!(table["id"], Value::Str(V3_ID.to_string()));
        assert_eq!(table["created"], Value::Str("2025-01-02T03:04:05Z".into()));
        assert_eq!(table["updated"], Value::Str("2025-01-02T03:04:06Z".into()));
        assert_eq!(table["favorite"], Value::Bool(true));
        assert!(
            !table.contains_key("deleted"),
            "no tombstone in the fixture"
        );

        // hash dropped (recomputed from body on read); tags dropped
        // (body-derived in v4).
        assert!(!table.contains_key("hash"));
        assert!(!table.contains_key("tags"));

        // Body preserved verbatim (the one blank separator line after the
        // v3 fence is dropped, matching the v3 reader's semantics).
        assert_eq!(body, "# Title\n\nbody text\n");

        // Idempotent: no v3 fence left, the pass must not touch it again.
        assert!(!convert_file(&path).unwrap());
    }

    #[test]
    fn conversion_preserves_unknown_keys_and_app_tables() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("note.md");
        std::fs::write(
            &path,
            v3_md(
                "color = 5\n\
                 aliases = [\"goal\", \"anchor\"]\n\
                 empty_list = []\n\
                 [oxios]\n\
                 author = \"agent\"\n\
                 needs_review = true\n",
            ),
        )
        .unwrap();

        assert!(convert_file(&path).unwrap());

        let converted = std::fs::read_to_string(&path).unwrap();
        let Parsed::Memo { table, .. } = parse(&converted, NoteFormat::Markdown).unwrap() else {
            panic!("must carry frontmatter")
        };
        // Unknown scalar kept (numeric scalars are strings in v4).
        assert_eq!(table["color"], Value::Str("5".into()));
        // Non-empty string array kept.
        assert_eq!(
            table["aliases"],
            Value::Array(vec!["goal".into(), "anchor".into()])
        );
        // App table kept as a nested map.
        let Value::Map(oxios) = &table["oxios"] else {
            panic!("oxios table must survive")
        };
        assert_eq!(oxios["author"], Value::Str("agent".into()));
        assert_eq!(oxios["needs_review"], Value::Bool(true));
        // Empty array dropped: the v4 grammar rejects `key: []`.
        assert!(!table.contains_key("empty_list"));
    }

    #[test]
    fn conversion_maps_deleted_at_tombstone() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("note.md");
        std::fs::write(&path, v3_md("deleted_at = 2025-01-02T03:04:07Z\n")).unwrap();

        assert!(convert_file(&path).unwrap());

        let converted = std::fs::read_to_string(&path).unwrap();
        let Parsed::Memo { table, .. } = parse(&converted, NoteFormat::Markdown).unwrap() else {
            panic!("must carry frontmatter")
        };
        assert_eq!(table["deleted"], Value::Str("2025-01-02T03:04:07Z".into()));
    }

    #[test]
    fn converts_html_note() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("note.html");
        std::fs::write(
            &path,
            format!(
                "<!--\n+++\nid = \"{V3_ID}\"\ncreated_at = 2025-01-02T03:04:05Z\n\
                 updated_at = 2025-01-02T03:04:06Z\nhash = \"x\"\nfavorite = false\ntags = []\n\
                 +++\n-->\n<h1>Title</h1>\n"
            ),
        )
        .unwrap();

        assert!(convert_file(&path).unwrap());

        let converted = std::fs::read_to_string(&path).unwrap();
        let Parsed::Memo { table, body } = parse(&converted, NoteFormat::Html).unwrap() else {
            panic!("html note must carry frontmatter")
        };
        assert_eq!(table["id"], Value::Str(V3_ID.to_string()));
        assert_eq!(table["created"], Value::Str("2025-01-02T03:04:05Z".into()));
        assert!(!table.contains_key("hash"));
        assert_eq!(body, "<h1>Title</h1>\n");
    }

    #[test]
    fn malformed_v3_is_collected_not_skipped() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("good.md"), v3_md("")).unwrap();
        // Unclosed fence.
        std::fs::write(dir.path().join("unclosed.md"), "+++\nid = \"x\"\n").unwrap();
        // Invalid TOML.
        std::fs::write(dir.path().join("bad-toml.md"), "+++\nid = \n+++\nbody\n").unwrap();
        // Missing required field.
        std::fs::write(
            dir.path().join("no-id.md"),
            "+++\ncreated_at = 2025-01-02T03:04:05Z\n+++\nbody\n",
        )
        .unwrap();

        let mut stats = ConvertStats::default();
        convert_tree(dir.path(), &mut stats);

        assert_eq!(stats.converted, 1, "good note still converts");
        let names: Vec<String> = stats
            .malformed
            .iter()
            .map(|(p, _)| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert!(names.contains(&"unclosed.md".to_string()), "{names:?}");
        assert!(names.contains(&"bad-toml.md".to_string()), "{names:?}");
        assert!(names.contains(&"no-id.md".to_string()), "{names:?}");
        // The malformed files are left untouched for the user to fix.
        assert!(
            std::fs::read_to_string(dir.path().join("bad-toml.md"))
                .unwrap()
                .starts_with("+++")
        );
    }

    // -- migration decision ------------------------------------------------

    #[test]
    fn migrates_old_default_tree_and_converts() {
        let home = TempDir::new().unwrap();
        let old = seed_old_vault(home.path());
        let new = new_default_vault(&oxi_of(home.path()));

        let status = migrate(home.path()).unwrap();

        assert_eq!(
            status,
            MigrationStatus::Migrated { converted: 2 },
            "live + trashed note convert; the frontmatter-less habits file does not"
        );
        assert!(!old.exists(), "old tree must be moved away");
        assert!(
            new.join("oximemo.toml").is_file(),
            "config moves with the tree"
        );
        assert_eq!(
            std::fs::read(new.join("_assets/img.png")).unwrap(),
            b"\x89PNG-not-really",
            "binary assets copy verbatim"
        );
        // Notes converted in place.
        assert!(
            std::fs::read_to_string(new.join("novel/first.md"))
                .unwrap()
                .starts_with("---\n")
        );
        assert!(
            std::fs::read_to_string(new.join(".trash/novel/old.md"))
                .unwrap()
                .starts_with("---\n")
        );
        // System file verbatim, still frontmatter-less.
        assert_eq!(
            std::fs::read_to_string(new.join("habits/emoji.md")).unwrap(),
            "\u{1f4da}\n"
        );
        // Marker written: the pass completed cleanly.
        assert!(
            support_index_dir(&oxi_of(home.path()))
                .join(CONVERSION_MARKER)
                .is_file()
        );
    }

    #[test]
    fn merge_required_when_both_exist() {
        let home = TempDir::new().unwrap();
        let old = seed_old_vault(home.path());
        let old_bytes = std::fs::read_to_string(old.join("novel/first.md")).unwrap();
        let new = new_default_vault(&oxi_of(home.path()));
        std::fs::create_dir_all(&new).unwrap();
        std::fs::write(new.join("other.md"), "---\nid: x\n---\nnew side\n").unwrap();
        let new_bytes = std::fs::read_to_string(new.join("other.md")).unwrap();

        let status = migrate(home.path()).unwrap();

        assert_eq!(
            status,
            MigrationStatus::MergeRequired {
                old: old.clone(),
                new: new.clone()
            }
        );
        // Neither tree touched.
        assert!(old.join("novel/first.md").is_file(), "old tree stays");
        assert_eq!(
            std::fs::read_to_string(old.join("novel/first.md")).unwrap(),
            old_bytes,
            "no silent overwrite of the old side"
        );
        assert_eq!(
            std::fs::read_to_string(new.join("other.md")).unwrap(),
            new_bytes,
            "no silent overwrite of the new side"
        );
        assert!(!old.join("novel/first.md").to_string_lossy().is_empty());
    }

    #[test]
    fn tolerates_already_migrated_state() {
        let home = TempDir::new().unwrap();
        let new = new_default_vault(&oxi_of(home.path()));
        std::fs::create_dir_all(&new).unwrap();
        let v4 = "---\nid: 0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee\ncreated: 2025-01-02T03:04:05Z\nupdated: 2025-01-02T03:04:06Z\nfavorite: false\n---\nbody\n";
        std::fs::write(new.join("a.md"), v4).unwrap();

        let status = migrate(home.path()).unwrap();
        assert_eq!(status, MigrationStatus::AlreadyMigrated);
        assert_eq!(std::fs::read_to_string(new.join("a.md")).unwrap(), v4);

        // Marker written by the clean pass; a second run is a no-op.
        assert!(
            support_index_dir(&oxi_of(home.path()))
                .join(CONVERSION_MARKER)
                .is_file()
        );
        assert_eq!(
            migrate(home.path()).unwrap(),
            MigrationStatus::AlreadyMigrated
        );
    }

    #[test]
    fn fresh_when_neither_exists() {
        let home = TempDir::new().unwrap();
        assert_eq!(migrate(home.path()).unwrap(), MigrationStatus::Fresh);
    }

    #[test]
    fn malformed_notes_block_migration_with_full_report() {
        let home = TempDir::new().unwrap();
        let old = seed_old_vault(home.path());
        std::fs::write(old.join("novel/broken.md"), "+++\nid = \n+++\nbody\n").unwrap();

        let err = migrate(home.path()).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("broken.md"), "error lists the offender: {msg}");

        // The tree still moved and the good notes converted.
        assert!(!old.exists());
        let new = new_default_vault(&oxi_of(home.path()));
        assert!(
            std::fs::read_to_string(new.join("novel/first.md"))
                .unwrap()
                .starts_with("---\n")
        );
        // No marker: the pass did not complete.
        assert!(
            !support_index_dir(&oxi_of(home.path()))
                .join(CONVERSION_MARKER)
                .exists()
        );

        // Fixing the file and re-running converts it (retry pass).
        std::fs::write(new.join("novel/broken.md"), v3_md("")).unwrap();
        assert_eq!(
            migrate(home.path()).unwrap(),
            MigrationStatus::AlreadyMigrated
        );
        assert!(
            std::fs::read_to_string(new.join("novel/broken.md"))
                .unwrap()
                .starts_with("---\n")
        );
        assert!(
            support_index_dir(&oxi_of(home.path()))
                .join(CONVERSION_MARKER)
                .is_file()
        );
    }

    /// Stray filesystem debris in a fresh counterpart must not count as
    /// population — otherwise a stray `.DS_Store` from macOS Finder or a
    /// `Thumbs.db` from a network share would flip the branch decision
    /// to [`MigrationStatus::MergeRequired`] and block auto-migration.
    #[test]
    fn is_populated_filters_vault_cruft() {
        let dir = TempDir::new().unwrap();
        // Absent dir is not populated.
        assert!(!is_populated(&dir.path().join("absent")));
        // A dir with only `.DS_Store` looks empty to the migration.
        std::fs::create_dir(dir.path().join("only-ds")).unwrap();
        std::fs::write(dir.path().join("only-ds/.DS_Store"), b"\x00\x01\x02\x03").unwrap();
        std::fs::write(dir.path().join("only-ds/Thumbs.db"), b"\x00\x00\x00\x00").unwrap();
        assert!(
            !is_populated(&dir.path().join("only-ds")),
            "pure cruft must not count as population"
        );
        // A real entry alongside the cruft still counts.
        std::fs::create_dir(dir.path().join("with-note")).unwrap();
        std::fs::write(dir.path().join("with-note/.DS_Store"), b"").unwrap();
        std::fs::write(dir.path().join("with-note/note.md"), b"").unwrap();
        assert!(
            is_populated(&dir.path().join("with-note")),
            "vault-meaningful entries must dominate cruft"
        );
    }

    /// A v3 file with a hand-written `created` next to the canonical
    /// `created_at` must not silently overwrite the mapped timestamp.
    #[test]
    fn stray_core_key_is_rejected_not_silently_overwritten() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("note.md");
        std::fs::write(
            &path,
            v3_md("created = \"1999-01-01T00:00:00Z\"\nupdated = \"1999-01-01T00:00:00Z\"\n"),
        )
        .unwrap();

        // map_v3_to_v4 must reject the stray `created`/`updated`
        // collision; the malformed-entry pipeline then reports it.
        let raw: toml::Table =
            toml::from_str("id = \"x\"\ncreated_at = 2025-01-02T03:04:05Z\nupdated_at = 2025-01-02T03:04:06Z\ncreated = \"1999-01-01T00:00:00Z\"\n").unwrap();
        let err = map_v3_to_v4(&raw).unwrap_err();
        assert!(
            err.contains("created"),
            "rejection cites the offender: {err}"
        );
    }

    /// An unreadable subtree must surface as a malformed entry (not
    /// silently skip) and block the marker so the self-heal retry
    /// actually runs.
    #[test]
    fn unreadable_subtree_is_collected_and_blocks_marker() {
        // Drive the walk directly so we can construct an EACCES-like
        // condition portably: a path that is never created but the
        // walk starts from. convert_tree collects the read_dir failure.
        let dir = TempDir::new().unwrap();
        let missing = dir.path().join("does-not-exist");
        let mut stats = ConvertStats::default();
        convert_tree(&missing, &mut stats);
        assert_eq!(stats.converted, 0);
        assert_eq!(
            stats.malformed.len(),
            1,
            "read_dir failure must be collected"
        );
        assert!(stats.malformed[0].0.ends_with("does-not-exist"));
        assert!(
            stats.malformed[0].1.contains("cannot read directory"),
            "the offender's reason explains the IO class: {}",
            stats.malformed[0].1
        );

        // run_conversion must withhold the marker on a collected error.
        let index_dir = dir.path().join("index");
        let err = run_conversion(&missing, &index_dir).unwrap_err();
        assert!(err.to_string().contains("does-not-exist"));
        assert!(
            !index_dir.join(CONVERSION_MARKER).exists(),
            "marker withheld"
        );
    }

    /// Two processes racing the first-open: the loser's rename returns
    /// `NotFound`, and we must fall through to AlreadyMigrated instead
    /// of hard-erroring on the next open.
    #[test]
    fn rename_race_loser_is_already_migrated() {
        let home = TempDir::new().unwrap();
        let old = old_default_vault(home.path());
        let new = new_default_vault(&oxi_of(home.path()));
        seed_old_vault(home.path());
        // Simulate the race: remove the source between is_populated()
        // and move_tree(). move_tree will report NotFound.
        std::fs::remove_dir_all(&old).unwrap();
        std::fs::create_dir_all(new.parent().unwrap()).unwrap();

        let result = move_tree(&old, &new);
        assert!(result.is_err(), "source gone → move must fail");
        let err = result.unwrap_err();
        if let CoreError::Io(io) = &err {
            assert_eq!(io.kind(), std::io::ErrorKind::NotFound);
        } else {
            panic!("rename NotFound must surface as CoreError::Io, got {err:?}");
        }

        // The maybe_migrate branch handles the NotFound by returning
        // AlreadyMigrated (with no conversion pass): the population
        // check is bypassed because the source is already gone, so we
        // exercise the inner branch directly with a fresh, populated
        // target.
        std::fs::create_dir_all(&new).unwrap();
        std::fs::write(
            new.join("seed.md"),
            "---\nid: x\ncreated: 2025-01-02T03:04:05Z\n---\nbody\n",
        )
        .unwrap();
        // Drop the marker so the (false, true) retry arm runs.
        let _ =
            std::fs::remove_file(support_index_dir(&oxi_of(home.path())).join(CONVERSION_MARKER));
        let status = migrate(home.path()).unwrap();
        assert_eq!(status, MigrationStatus::AlreadyMigrated);
    }

    // -- round-2 review coverage -----------------------------------------

    /// (a) Destination contains only a removable `.DS_Store` cruft
    /// file: the migration strips it and proceeds with the rename,
    /// instead of hard-failing on `ENOTEMPTY`.
    #[test]
    fn cruft_only_destination_is_cleared_and_migrated() {
        let home = TempDir::new().unwrap();
        let old = seed_old_vault(home.path());
        let new = new_default_vault(&oxi_of(home.path()));
        std::fs::create_dir_all(&new).unwrap();
        std::fs::write(new.join(".DS_Store"), b"\x00\x01\x02mac-finder").unwrap();

        let status = migrate(home.path()).unwrap();
        assert!(
            matches!(status, MigrationStatus::Migrated { .. }),
            "cruft-only destination must migrate, not hard-fail: {status:?}"
        );
        assert!(!old.exists(), "old tree moved away");
        assert!(
            !new.join(".DS_Store").exists(),
            "cruft stripped before the rename"
        );
        assert!(new.join("oximemo.toml").is_file(), "tree landed intact");
    }

    /// (b) Destination contains anything real (a `.git` repo, an
    /// `.obsidian` folder, any user note, …): the migration must NOT
    /// touch it and must surface [`MigrationStatus::MergeRequired`]
    /// so the user merges by hand.
    #[test]
    fn real_destination_entry_triggers_merge_required() {
        let home = TempDir::new().unwrap();
        let old = seed_old_vault(home.path());
        let new = new_default_vault(&oxi_of(home.path()));
        std::fs::create_dir_all(&new).unwrap();
        std::fs::create_dir_all(new.join(".git")).unwrap();
        std::fs::write(new.join(".git/HEAD"), b"ref: refs/heads/main\n").unwrap();

        let status = migrate(home.path()).unwrap();
        assert_eq!(
            status,
            MigrationStatus::MergeRequired {
                old: old.clone(),
                new: new.clone()
            }
        );
        // Cruft-aware population treats the .git as a real entry — the
        // old side is still populated, so the (true, true) branch
        // reports MergeRequired without touching either tree.
        assert!(old.join("novel/first.md").is_file(), "old untouched");
        assert!(
            new.join(".git/HEAD").is_file(),
            "new side .git must NOT be touched"
        );
    }

    /// (c) Empty destination: rename succeeds, behavior preserved.
    #[test]
    fn empty_destination_migrates_normally() {
        let home = TempDir::new().unwrap();
        let old = seed_old_vault(home.path());
        let new = new_default_vault(&oxi_of(home.path()));
        // No creation — destination absent.
        let status = migrate(home.path()).unwrap();
        assert!(
            matches!(status, MigrationStatus::Migrated { .. }),
            "absent destination must migrate: {status:?}"
        );
        assert!(!old.exists(), "old tree moved away");
        assert!(new.join("oximemo.toml").is_file());
    }

    // -- journaled, resumable, source-preserving migration (P0-2) ------

    /// The rename path records a completed journal entry with no
    /// retired backup, and reruns read as AlreadyMigrated.
    #[test]
    fn journal_marks_complete_after_rename() {
        let home = TempDir::new().unwrap();
        seed_old_vault(home.path());
        assert_eq!(
            migrate(home.path()).unwrap(),
            MigrationStatus::Migrated { converted: 2 }
        );
        let entry =
            journal::entry(&oxi_of(home.path()), journal::APP_SUPPORT_VAULT).expect("entry");
        assert_eq!(entry.status, journal::STATUS_COMPLETE);
        assert!(entry.retired_backup.is_none(), "rename keeps no backup");
        assert_eq!(
            migrate(home.path()).unwrap(),
            MigrationStatus::AlreadyMigrated
        );
    }

    /// Cross-volume fallback: verified copy, source kept as a retired
    /// backup (still v3 — only the destination is converted), and the
    /// journal prevents MergeRequired on rerun despite both sides
    /// being populated.
    #[test]
    fn cross_fs_copy_preserves_source_and_journals_backup() {
        let home = TempDir::new().unwrap();
        let old = seed_old_vault(home.path());
        let new = new_default_vault(&oxi_of(home.path()));

        let status = cross_fs_migrate(&oxi_of(home.path()), &old, &new).unwrap();

        assert_eq!(status, MigrationStatus::Migrated { converted: 2 });
        let old_note = std::fs::read_to_string(old.join("novel/first.md")).unwrap();
        assert!(old_note.starts_with("+++"), "backup keeps the v3 bytes");
        assert!(old.join("oximemo.toml").is_file(), "source tree intact");
        assert!(
            std::fs::read_to_string(new.join("novel/first.md"))
                .unwrap()
                .starts_with("---\n"),
            "destination converted"
        );
        let entry =
            journal::entry(&oxi_of(home.path()), journal::APP_SUPPORT_VAULT).expect("entry");
        assert_eq!(entry.status, journal::STATUS_COMPLETE);
        assert_eq!(entry.retired_backup.as_deref(), Some(old.to_str().unwrap()));
        assert_eq!(
            migrate(home.path()).unwrap(),
            MigrationStatus::AlreadyMigrated,
            "retired backup must not read as MergeRequired"
        );
    }

    /// Crash mid-copy: journal `in_progress` + both sides populated →
    /// the next run resumes the copy (skipping identical files) and
    /// completes, keeping the source as the backup.
    #[test]
    fn interrupted_cross_fs_copy_resumes_and_completes() {
        let home = TempDir::new().unwrap();
        let old = seed_old_vault(home.path());
        let new = new_default_vault(&oxi_of(home.path()));

        // Simulate the crash: journal began, only part of the tree copied.
        journal::begin(&oxi_of(home.path()), journal::APP_SUPPORT_VAULT, &old, &new);
        std::fs::create_dir_all(new.join("novel")).unwrap();
        std::fs::copy(old.join("oximemo.toml"), new.join("oximemo.toml")).unwrap();

        let status = migrate(home.path()).unwrap();

        assert!(
            matches!(status, MigrationStatus::Migrated { .. }),
            "{status:?}"
        );
        assert!(
            new.join("_assets/img.png").is_file() && new.join(".trash/novel/old.md").is_file(),
            "resumed copy completed the tree"
        );
        assert!(old.exists(), "resumed copy keeps the source as the backup");
        let entry =
            journal::entry(&oxi_of(home.path()), journal::APP_SUPPORT_VAULT).expect("entry");
        assert_eq!(entry.status, journal::STATUS_COMPLETE);
        assert_eq!(entry.retired_backup.as_deref(), Some(old.to_str().unwrap()));
    }

    // -- P1-5: .git history and permission preservation -----------------

    /// P1-5: `.git` history must survive the same-volume rename intact
    /// (the data moves; nothing is rebuilt).
    #[test]
    fn git_history_survives_rename_migration() {
        let home = TempDir::new().unwrap();
        let old = seed_old_vault(home.path());
        let Some(head) = crate::testing::git_init_commit(&old) else {
            eprintln!("git unavailable; skipping");
            return;
        };
        let new = new_default_vault(&oxi_of(home.path()));

        assert!(matches!(
            migrate(home.path()).unwrap(),
            MigrationStatus::Migrated { .. }
        ));

        assert!(new.join(".git/HEAD").is_file(), ".git moves with the tree");
        assert_eq!(
            crate::testing::git_head(&new).as_deref(),
            Some(head.as_str()),
            "git history works on the destination"
        );
        assert!(!old.exists(), "rename path: source moved away");
    }

    /// P1-5: the cross-volume copy must carry a working `.git` to the
    /// destination AND keep the source backup's history intact.
    #[test]
    fn git_history_survives_cross_fs_copy_preserving_source() {
        let home = TempDir::new().unwrap();
        let old = seed_old_vault(home.path());
        let Some(head) = crate::testing::git_init_commit(&old) else {
            eprintln!("git unavailable; skipping");
            return;
        };
        let new = new_default_vault(&oxi_of(home.path()));

        cross_fs_migrate(&oxi_of(home.path()), &old, &new).unwrap();

        assert!(new.join(".git/HEAD").is_file() && old.join(".git/HEAD").is_file());
        assert_eq!(
            crate::testing::git_head(&new).as_deref(),
            Some(head.as_str()),
            "history works on the destination"
        );
        assert_eq!(
            crate::testing::git_head(&old).as_deref(),
            Some(head.as_str()),
            "source backup keeps its history"
        );
    }

    /// P1-5: rename must not disturb permission bits.
    #[cfg(unix)]
    #[test]
    fn permissions_survive_rename_migration() {
        let home = TempDir::new().unwrap();
        let old = seed_old_vault(home.path());
        let secret = old.join("novel/secret.md");
        let script = old.join("habits/run.sh");
        std::fs::write(&secret, "private\n").unwrap();
        std::fs::write(&script, "#!/bin/sh\necho hi\n").unwrap();
        if !crate::testing::chmod_supported(&secret, 0o600)
            || !crate::testing::chmod_supported(&script, 0o755)
        {
            eprintln!("chmod is a no-op on this filesystem; skipping");
            return;
        }
        let new = new_default_vault(&oxi_of(home.path()));

        assert!(matches!(
            migrate(home.path()).unwrap(),
            MigrationStatus::Migrated { .. }
        ));

        assert_eq!(
            crate::testing::mode_of(&new.join("novel/secret.md")),
            Some(0o600)
        );
        assert_eq!(
            crate::testing::mode_of(&new.join("habits/run.sh")),
            Some(0o755)
        );
    }

    /// P1-5: the copy fallback must carry permission bits per file,
    /// on the destination and on the kept source alike.
    #[cfg(unix)]
    #[test]
    fn permissions_survive_cross_fs_copy() {
        let home = TempDir::new().unwrap();
        let old = seed_old_vault(home.path());
        let secret = old.join("novel/secret.md");
        let script = old.join("habits/run.sh");
        std::fs::write(&secret, "private\n").unwrap();
        std::fs::write(&script, "#!/bin/sh\necho hi\n").unwrap();
        if !crate::testing::chmod_supported(&secret, 0o600)
            || !crate::testing::chmod_supported(&script, 0o755)
        {
            eprintln!("chmod is a no-op on this filesystem; skipping");
            return;
        }
        let new = new_default_vault(&oxi_of(home.path()));

        cross_fs_migrate(&oxi_of(home.path()), &old, &new).unwrap();

        assert_eq!(
            crate::testing::mode_of(&new.join("novel/secret.md")),
            Some(0o600)
        );
        assert_eq!(
            crate::testing::mode_of(&new.join("habits/run.sh")),
            Some(0o755)
        );
        assert_eq!(
            crate::testing::mode_of(&old.join("novel/secret.md")),
            Some(0o600),
            "kept source keeps its modes"
        );
    }
}
