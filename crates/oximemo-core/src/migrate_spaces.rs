//! One-time flat → spaces migration (spec 2026-08-28 §3, unified-home
//! amendment 2026-08-30).
//!
//! The pre-spaces vault lives *flat* at `~/.oxi/vault` (notes, folders,
//! `.git` directly under it). With spaces adopted, that flat root is the
//! *container* of space directories — so its content moves once, on
//! `Vault::open`, before path resolution:
//!
//! - a top-level directory oxibrain provisioned as a per-space root in
//!   `documents.toml` (see [`provisioned_space_names`]) is a **pre-
//!   per-space-vault space**: it moves to `~/.oxi/spaces/<name>/vault/`
//!   (a `vault/` child moves as the whole container to
//!   `~/.oxi/spaces/<name>/`). Before this rule these directories were
//!   skipped, and a later `create_space` for the same name stranded the
//!   old notes under the flat root;
//! - everything else (dated captures, `daily/`, `_assets/`,
//!   `oximemo.toml`, `.git`, plain note folders — names alone do not
//!   make a space) is **personal content** and moves into
//!   `~/.oxi/spaces/personal/vault/`.
//!
//! A pre-existing `personal/` vault blocks the move with
//! `MergeRequired` (same contract as [`crate::migrate_vault`]): nothing
//! on either side is touched.
//!
//! Two one-shot pieces ride along:
//!
//! - the legacy macOS application-support `settings.json` (last-space
//!   selection) moves into oximemo's private `~/.oxi/oximemo/` when the
//!   destination is absent;
//! - a legacy flat `index/` (meta.redb directly inside) is namespaced
//!   to `index/personal/`.
//!
//! **No brain writes.** oximemo never edits
//! `~/.oxi/brain/documents.toml`: after the move, the active root is
//! *recorded* as a pending registration ([`crate::brain`]) and a later
//! flush registers it through the oxibrain-client
//! `register_document_root` boundary. The legacy flat-root entry (and
//! any stale per-space flat path) may linger in the brain's config
//! until that upsert lands — the alias-keyed upsert replaces it, and
//! the indexer skips root directories that no longer exist.
//!
//! The wave is journaled ([`crate::migration_journal`], key
//! `flat_vault`): the entry is written before the first rename and
//! marked complete only after every expected move verified at its
//! destination. Per-entry renames are restart-tolerant, so an
//! interrupted run resumes cleanly on the next open.

use std::path::{Path, PathBuf};

use crate::error::{CoreError, Result};
use crate::migration_journal as journal;
use crate::spaces::{self, DEFAULT_SPACE_NAME};

/// Outcome of the one-time flat → space migration check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FlatMigrationStatus {
    /// No flat vault present (fresh install or spaces-only layout).
    Fresh,
    /// Default space dir present, no flat signature left.
    AlreadyMigrated,
    /// Content moved into the spaces layout; `moved` counts entries.
    Migrated { moved: usize },
    /// Both the flat signature and `personal/` exist. Nothing was
    /// touched; the user must merge by hand (see `oximemo doctor`).
    MergeRequired { flat: PathBuf, space: PathBuf },
}

/// True when the directory looks like a pre-spaces flat vault: a
/// top-level `oximemo.toml`/`config.toml`, or any top-level regular
/// file (dated note captures). Space containers hold only directories.
/// `pub(crate)` so the `migrate-home` preflight reports with the same
/// definition.
pub(crate) fn flat_signature(root: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(root) else {
        return false;
    };
    for e in entries.flatten() {
        let name = e.file_name();
        let name = name.to_string_lossy();
        if name == "oximemo.toml" || name == "config.toml" {
            return true;
        }
        if e.path().is_file() {
            return true;
        }
    }
    false
}

/// `path = "x"` → `Some("x")` for a `[[root]]` body line.
fn strip_path_value(line: &str) -> Option<String> {
    let t = line.trim().strip_prefix("path")?.trim_start();
    let t = t.strip_prefix('=')?.trim();
    let t = t.strip_prefix('"')?;
    let end = t.find('"')?;
    Some(t[..end].to_string())
}

/// Parse `[[root]]` blocks of a documents.toml and return each block's
/// `path` value. Line-based (the file is machine-managed by oxibrain;
/// oximemo only ever reads it).
fn root_paths(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_root_block = false;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            in_root_block = t.starts_with("[[root]]");
        } else if in_root_block && let Some(v) = strip_path_value(line) {
            out.push(v);
        }
    }
    out
}

/// Directory names oxibrain provisioned as per-space roots
/// (`path = <flat>/<name>` in documents.toml — absolute, tilde, or
/// trailing-slash spelling, matched by string shape without touching
/// the filesystem). These flat-era directories are **pre-per-
/// space-vault spaces**; plain note folders can also pass space-name
/// validation, so provisioning — not the name alone — decides.
fn provisioned_space_names(oxi_home: &Path) -> Vec<String> {
    let text = std::fs::read_to_string(oxi_home.join("brain/documents.toml")).unwrap_or_default();
    let flat = oxi_home.join("vault");
    let flat_str = flat.to_string_lossy().to_string();
    let mut names = Vec::new();
    for raw in root_paths(&text) {
        let norm = raw.trim_end_matches('/');
        let Some(rest) = norm
            .strip_prefix(&flat_str)
            .or_else(|| norm.strip_prefix("~/.oxi/vault"))
            .filter(|r| r.starts_with('/') && r.len() > 1)
        else {
            continue;
        };
        let name = rest.trim_start_matches('/');
        // Exactly one level under the flat root, and a valid space name.
        if !name.contains('/') && spaces::validate_space_name(name).is_ok() {
            names.push(name.to_string());
        }
    }
    names
}

/// Where a flat-root entry belongs in the spaces layout.
///
/// - a directory that oxibrain provisioned as a per-space root (see
///   [`provisioned_space_names`]) is a **pre-per-space-vault space**:
///   the entry moves to `spaces/<name>/vault/`, or wholesale to
///   `spaces/<name>/` when it already carries a `vault/` child;
/// - a directory that merely validates as a space name is NOT enough —
///   flat-vault subfolders (`daily/`, `projects/`, …) are note folders
///   and stay personal content;
/// - everything else is personal content:
///   `spaces/personal/vault/<name>`.
///
/// `None` = deliberately left in place (a same-named new-layout space
/// already exists — never merge silently; doctor surfaces the leftover).
fn flat_entry_destination(
    oxi_home: &Path,
    personal_vault: &Path,
    provisioned: &[String],
    entry: &Path,
) -> Option<PathBuf> {
    let name = entry.file_name()?.to_string_lossy().into_owned();
    let is_space_dir = entry.is_dir()
        && name != DEFAULT_SPACE_NAME
        && (provisioned.iter().any(|n| n == &name)
            || entry.join(crate::paths::VAULT_DEFAULT_SUBDIR).is_dir());
    if is_space_dir {
        let space_dir = spaces::space_dir(oxi_home, &name);
        if space_dir.exists() {
            tracing::warn!(
                dir = %entry.display(),
                existing = %space_dir.display(),
                "flat-era space dir left in place: the new-layout space already exists"
            );
            return None;
        }
        if entry.join(crate::paths::VAULT_DEFAULT_SUBDIR).is_dir() {
            return Some(space_dir);
        }
        let _ = std::fs::create_dir_all(&space_dir);
        return Some(space_dir.join(crate::paths::VAULT_DEFAULT_SUBDIR));
    }
    Some(personal_vault.join(&name))
}

/// One-shot legacy `settings.json` migration: candidates in recency
/// order are the flat-era `~/.oxi/settings.json` and the pre-flat
/// macOS application-support `settings.json`. The first that exists
/// moves into oximemo's private dir, only when the destination is
/// absent. Journal-tracked; the source is moved (rename, with a
/// copy+remove fallback across volumes). Failures are logged, never
/// fatal — `last_space` resolution self-heals to the default space.
fn migrate_legacy_settings(oxi_home: &Path, legacy_home: Option<&Path>) {
    let flat_source = oxi_home.join("settings.json");
    let app_support_source =
        legacy_home.map(|h| crate::paths::legacy_app_support_dir(h).join("settings.json"));
    let (source, key) = if flat_source.is_file() {
        (Some(flat_source), journal::FLAT_SETTINGS)
    } else if app_support_source.as_ref().is_some_and(|p| p.is_file()) {
        (app_support_source, journal::LEGACY_SETTINGS)
    } else {
        return;
    };
    let Some(source) = source else {
        return;
    };
    let dest = spaces::app_settings_path_in(oxi_home);
    if dest.exists() {
        return; // newer settings win; the legacy copy is inert
    }
    journal::begin(oxi_home, key, &source, &dest);
    let moved = match std::fs::rename(&source, &dest) {
        Ok(()) => true,
        Err(_) => {
            let copied = std::fs::copy(&source, &dest).is_ok_and(|n| n > 0);
            copied && std::fs::remove_file(&source).is_ok()
        }
    };
    if moved {
        journal::complete(oxi_home, key, None);
        tracing::info!(
            to = %dest.display(),
            "migrated legacy settings.json into oximemo's private dir"
        );
    } else {
        tracing::warn!(
            from = %source.display(),
            "legacy settings.json migration failed; will retry on the next open"
        );
    }
}

/// Run the one-time flat → space migration. See the module docs for
/// the decision table.
///
/// * `oxi_home` — the shared Oxi home (`~/.oxi`, `OXI_HOME`-aware):
///   the flat root, spaces layout, journal, and pending registration
///   all hang off it.
/// * `legacy_home` — the user home holding the legacy application-
///   support index and settings; `None` skips those candidates.
pub fn maybe_migrate(oxi_home: &Path, legacy_home: Option<&Path>) -> Result<FlatMigrationStatus> {
    migrate_legacy_settings(oxi_home, legacy_home);
    let flat = oxi_home.join("vault");
    let space = spaces::space_vault_dir(oxi_home, DEFAULT_SPACE_NAME);
    if !flat_signature(&flat) {
        return Ok(if space.is_dir() {
            FlatMigrationStatus::AlreadyMigrated
        } else {
            FlatMigrationStatus::Fresh
        });
    }
    if space.exists() {
        return Ok(FlatMigrationStatus::MergeRequired { flat, space });
    }

    journal::begin(oxi_home, journal::FLAT_VAULT, &flat, &space);
    let provisioned = provisioned_space_names(oxi_home);
    std::fs::create_dir_all(&space)?;
    let mut moved = 0usize;
    let mut expected: Vec<(PathBuf, PathBuf)> = Vec::new();
    for entry in std::fs::read_dir(&flat)?.flatten() {
        let from = entry.path();
        // The destination dir lives inside the flat root in legacy
        // layouts; renaming it into itself would be an error.
        if from == space {
            continue;
        }
        let Some(dest) = flat_entry_destination(oxi_home, &space, &provisioned, &from) else {
            continue;
        };
        std::fs::rename(&from, &dest)?;
        expected.push((from, dest));
        moved += 1;
    }

    // Verify every expected move landed before marking complete; a
    // mismatch keeps the journal `in_progress` so the next run retries.
    for (from, dest) in &expected {
        if !dest.exists() {
            return Err(CoreError::Other(format!(
                "flat migration verify failed: {} did not land at {}",
                from.display(),
                dest.display()
            )));
        }
    }

    // Index rename: flat `index/` → `index/personal/` when the legacy
    // application-support index is still flat and not already
    // namespaced.
    if let Some(legacy_index) = legacy_home
        .map(|h| crate::paths::legacy_app_support_dir(h).join(crate::paths::INDEX_SUBDIR))
        .filter(|p| p.join(crate::paths::META_DB_NAME).is_file())
    {
        let index = oxi_home.join("oximemo").join(crate::paths::INDEX_SUBDIR);
        if !index.join(DEFAULT_SPACE_NAME).exists() {
            std::fs::create_dir_all(index.parent().expect("index has parent"))?;
            let tmp = legacy_index.with_extension("personal-migrating");
            std::fs::rename(&legacy_index, &tmp)?;
            std::fs::create_dir_all(&index)?;
            std::fs::rename(&tmp, index.join(DEFAULT_SPACE_NAME))?;
        }
    }

    // No direct documents.toml write: record a pending registration per
    // moved root for the next flush (module docs). The personal vault
    // gets the default-space request; every moved space dir (e.g. a
    // provisioned `knowledge/`) re-registers under its own name so the
    // brain's alias-keyed upsert repairs the stale flat-era root. The
    // legacy entries may linger in the brain's config until the flush
    // lands; the indexer skips directories that no longer exist.
    crate::brain::record_pending_root_registration(&space, DEFAULT_SPACE_NAME);
    for (from, dest) in &expected {
        let Some(name) = from.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if personal_vault_entry(&space, name) == *dest {
            continue; // personal content, covered by the default request
        }
        crate::brain::record_pending_request(crate::brain::document_root_request(dest, name));
    }

    journal::complete(oxi_home, journal::FLAT_VAULT, None);
    tracing::info!(
        moved,
        "migrated the flat vault into the spaces layout (default space '{DEFAULT_SPACE_NAME}')"
    );
    Ok(FlatMigrationStatus::Migrated { moved })
}

/// The personal-vault destination of a flat entry with `name` — the
/// counterpart of [`flat_entry_destination`]'s content rule, used to
/// tell personal content from moved space dirs after the move.
fn personal_vault_entry(personal_vault: &Path, name: &str) -> PathBuf {
    personal_vault.join(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// The Oxi home for a user-home fixture: `<fixture>/.oxi`.
    fn oxi_of(home: &Path) -> PathBuf {
        home.join(".oxi")
    }

    /// One-line migration call used by every fixture: the fixture dir
    /// acts as the user home, `<fixture>/.oxi` as the Oxi home (the
    /// journal and pending registration land inside, hermetically).
    fn migrate(home: &Path) -> Result<FlatMigrationStatus> {
        maybe_migrate(&oxi_of(home), Some(home))
    }

    fn seed_flat(home: &Path) {
        let flat = home.join(".oxi/vault");
        std::fs::create_dir_all(flat.join("daily")).unwrap();
        std::fs::create_dir_all(flat.join("_assets")).unwrap();
        std::fs::write(flat.join("2026-08-28-101010.md"), "---\nid: a\n---\n").unwrap();
        std::fs::write(flat.join("daily/today.md"), "---\nid: b\n---\n").unwrap();
        std::fs::write(flat.join("oximemo.toml"), "[general]\n").unwrap();
        std::fs::create_dir_all(flat.join(".git")).unwrap();
        std::fs::write(flat.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
    }

    fn seed_brain_dir(home: &Path, toml: &str) {
        let brain = home.join(".oxi").join("brain");
        std::fs::create_dir_all(&brain).unwrap();
        std::fs::write(brain.join("documents.toml"), toml).unwrap();
    }

    #[test]
    fn migrates_flat_content_into_personal() {
        let home = tempfile::tempdir().unwrap().keep();
        seed_flat(&home);
        let personal = crate::spaces::space_vault_dir(&oxi_of(&home), "personal");
        let status = migrate(&home).unwrap();
        assert!(matches!(status, FlatMigrationStatus::Migrated { moved: n } if n >= 5));
        assert!(personal.join("daily/today.md").is_file());
        assert!(personal.join("_assets").is_dir());
        assert!(personal.join(".git/HEAD").is_file()); // history moves with the tree
        assert!(personal.join("oximemo.toml").is_file());
        assert!(
            !crate::spaces::spaces_root(&oxi_of(&home))
                .join("daily")
                .exists()
        );
        // The wave is journaled as complete.
        let entry = journal::entry(&oxi_of(&home), journal::FLAT_VAULT).expect("entry");
        assert_eq!(entry.status, journal::STATUS_COMPLETE);
    }

    /// The flat era kept `settings.json` at the Oxi-home root. It must
    /// move into oximemo's private dir (journal-tracked), not be
    /// orphaned by the spaces layout.
    #[test]
    fn flat_era_settings_move_into_private_dir() {
        let home = tempfile::tempdir().unwrap().keep();
        seed_flat(&home);
        std::fs::write(
            home.join(".oxi/settings.json"),
            r#"{"version":9,"theme":"github_dark"}"#,
        )
        .unwrap();
        migrate(&home).unwrap();
        let dest = crate::spaces::app_settings_path_in(&oxi_of(&home));
        assert!(dest.is_file(), "settings moved into the private dir");
        assert!(!home.join(".oxi/settings.json").exists());
        let entry = journal::entry(&oxi_of(&home), journal::FLAT_SETTINGS).expect("entry");
        assert_eq!(entry.status, journal::STATUS_COMPLETE);
        // An existing private-dir settings file wins; the flat copy is inert.
        let home2 = tempfile::tempdir().unwrap().keep();
        seed_flat(&home2);
        std::fs::write(home2.join(".oxi/settings.json"), r#"{"version":9}"#).unwrap();
        let dest2 = crate::spaces::app_settings_path_in(&oxi_of(&home2));
        std::fs::create_dir_all(dest2.parent().unwrap()).unwrap();
        std::fs::write(&dest2, r#"{"version":10}"#).unwrap();
        migrate(&home2).unwrap();
        assert!(
            home2.join(".oxi/settings.json").is_file(),
            "inert copy kept"
        );
        assert_eq!(
            std::fs::read_to_string(&dest2).unwrap(),
            r#"{"version":10}"#,
            "newer private settings untouched"
        );
    }

    #[test]
    fn idempotent_second_run_is_already_migrated() {
        let home = tempfile::tempdir().unwrap().keep();
        seed_flat(&home);
        migrate(&home).unwrap();
        assert!(matches!(
            migrate(&home).unwrap(),
            FlatMigrationStatus::AlreadyMigrated
        ));
    }

    /// Pre-per-space-vault space directories under the flat root move
    /// to their OWN space (`spaces/<name>/vault/`) — previously they
    /// were missed, stranding the notes under the flat root and making
    /// a later `create_space` for the same name useless. A provisioned
    /// documents.toml root for the same name must not block the move,
    /// and oximemo must not touch the file.
    #[test]
    fn flat_space_dirs_move_to_their_own_space_vault() {
        let home = tempfile::tempdir().unwrap().keep();
        seed_flat(&home);
        let flat_work = home.join(".oxi/vault/work");
        std::fs::create_dir_all(flat_work.join("meeting")).unwrap();
        std::fs::write(flat_work.join("meeting/notes.md"), "---\nid: w\n---\n").unwrap();
        seed_brain_dir(
            &home,
            &format!(
                "[[root]]\nalias = \"work\"\npath = \"{}\"\nspace = \"work\"\n",
                flat_work.display()
            ),
        );
        let before = std::fs::read(home.join(".oxi/brain/documents.toml")).unwrap();

        crate::brain::with_test_pending_dir(&home.join("pending"), || {
            let status = migrate(&home).unwrap();
            assert!(matches!(status, FlatMigrationStatus::Migrated { .. }));
            let work_vault = crate::spaces::space_vault_dir(&oxi_of(&home), "work");
            assert!(
                work_vault.join("meeting/notes.md").is_file(),
                "the pre-per-space-vault space lands as its own vault"
            );
            assert!(!flat_work.exists());
            // documents.toml untouched: registration goes through the
            // pending-file boundary instead — one request per moved
            // root, keyed by alias so the brain's upsert repairs the
            // stale flat-era entry in place.
            assert_eq!(
                std::fs::read(home.join(".oxi/brain/documents.toml")).unwrap(),
                before,
                "documents.toml must stay byte-identical"
            );
            let pending = crate::brain::pending_root_registration().expect("recorded");
            let by_alias: Vec<(String, String)> = pending
                .requests
                .iter()
                .map(|r| (r.request.alias.clone(), r.request.path.clone()))
                .collect();
            assert!(
                by_alias.contains(&(
                    "work".to_string(),
                    work_vault.to_string_lossy().into_owned()
                )),
                "the moved work root is re-registered: {by_alias:?}"
            );
            assert!(
                by_alias.iter().any(|(a, _)| a == "personal"),
                "the personal vault keeps its default-space request: {by_alias:?}"
            );
        });
    }

    #[test]
    fn existing_personal_blocks_with_merge_required_and_touches_nothing() {
        let home = tempfile::tempdir().unwrap().keep();
        seed_flat(&home);
        let personal = crate::spaces::space_vault_dir(&oxi_of(&home), "personal");
        std::fs::create_dir_all(&personal).unwrap();
        std::fs::write(personal.join("mine.md"), "---\nid: m\n---\n").unwrap();
        let before = std::fs::read_to_string(home.join(".oxi/vault/2026-08-28-101010.md")).unwrap();
        let status = migrate(&home).unwrap();
        assert!(matches!(status, FlatMigrationStatus::MergeRequired { .. }));
        // Zero mutations on either side.
        assert_eq!(
            std::fs::read_to_string(home.join(".oxi/vault/2026-08-28-101010.md")).unwrap(),
            before
        );
        assert!(personal.join("mine.md").is_file());
        assert!(!personal.join("daily").exists());
    }

    #[test]
    fn no_flat_signature_is_a_noop() {
        let home = tempfile::tempdir().unwrap().keep();
        // Nothing at ~/.oxi/vault.
        assert!(matches!(
            migrate(&home).unwrap(),
            FlatMigrationStatus::Fresh
        ));
        // Only space dirs, no top-level files → not a flat vault.
        std::fs::create_dir_all(crate::spaces::space_dir(&oxi_of(&home), "work")).unwrap();
        assert!(matches!(
            migrate(&home).unwrap(),
            FlatMigrationStatus::Fresh
        ));
    }

    /// The legacy flat-root registration is NOT rewritten in place:
    /// oximemo records a pending registration for the personal-space
    /// vault instead (alias-keyed upsert handles the stale entry at
    /// flush time) and leaves documents.toml byte-identical.
    #[test]
    fn flat_migration_records_pending_registration_for_personal_root() {
        let home = tempfile::tempdir().unwrap().keep();
        seed_flat(&home);
        let flat = home.join(".oxi/vault");
        seed_brain_dir(
            &home,
            &format!(
                "[[root]]\nalias = \"vault\"\npath = \"{}\"\nspace = \"personal\"\ninclude = [\"**/*.md\"]\n",
                flat.display()
            ),
        );
        let before = std::fs::read(home.join(".oxi/brain/documents.toml")).unwrap();

        crate::brain::with_test_pending_dir(&home.join("pending"), || {
            migrate(&home).unwrap();
            assert_eq!(
                std::fs::read(home.join(".oxi/brain/documents.toml")).unwrap(),
                before,
                "documents.toml must stay byte-identical"
            );
            let pending = crate::brain::pending_root_registration()
                .expect("the personal root must be recorded for the next flush");
            let personal = crate::spaces::space_vault_dir(&oxi_of(&home), "personal");
            assert_eq!(pending.requests.len(), 1);
            assert_eq!(pending.requests[0].request.alias, "personal");
            assert_eq!(pending.requests[0].request.space, "personal");
            assert_eq!(pending.requests[0].request.path, personal.to_string_lossy());
        });
    }

    #[test]
    fn flat_index_is_renamed_to_personal() {
        let home = tempfile::tempdir().unwrap().keep();
        seed_flat(&home);
        let legacy_index =
            crate::paths::legacy_app_support_dir(&home).join(crate::paths::INDEX_SUBDIR);
        std::fs::create_dir_all(&legacy_index).unwrap();
        std::fs::write(legacy_index.join(crate::paths::META_DB_NAME), b"redb").unwrap();
        migrate(&home).unwrap();
        let index = oxi_of(&home)
            .join("oximemo")
            .join(crate::paths::INDEX_SUBDIR);
        assert!(
            index
                .join("personal")
                .join(crate::paths::META_DB_NAME)
                .is_file()
        );
        assert!(!index.join(crate::paths::META_DB_NAME).exists());
    }

    #[test]
    fn already_namespaced_index_is_left_alone() {
        let home = tempfile::tempdir().unwrap().keep();
        seed_flat(&home);
        let index = home
            .join("Library/Application Support")
            .join(crate::paths::APP_SUPPORT_SUBDIR)
            .join(crate::paths::INDEX_SUBDIR);
        std::fs::create_dir_all(index.join("personal")).unwrap();
        std::fs::write(
            index.join("personal").join(crate::paths::META_DB_NAME),
            b"redb",
        )
        .unwrap();
        migrate(&home).unwrap(); // vault migrates; an already-namespaced index must survive untouched
        assert!(
            index
                .join("personal")
                .join(crate::paths::META_DB_NAME)
                .is_file()
        );
    }

    /// One-shot legacy `settings.json` (last-space) migration into
    /// oximemo's private dir; the source is moved away.
    #[test]
    fn migrates_legacy_settings_json() {
        let home = tempfile::tempdir().unwrap().keep();
        seed_flat(&home);
        let legacy_settings = crate::paths::legacy_app_support_dir(&home).join("settings.json");
        std::fs::create_dir_all(legacy_settings.parent().unwrap()).unwrap();
        std::fs::write(&legacy_settings, "{\"last_space\":\"work\"}").unwrap();

        migrate(&home).unwrap();

        let dest = spaces::app_settings_path_in(&oxi_of(&home));
        assert_eq!(
            std::fs::read_to_string(&dest).unwrap(),
            "{\"last_space\":\"work\"}"
        );
        assert!(!legacy_settings.exists(), "source moved");
        // Journal settled; a rerun is a no-op (destination present).
        let entry = journal::entry(&oxi_of(&home), journal::LEGACY_SETTINGS).expect("entry");
        assert_eq!(entry.status, journal::STATUS_COMPLETE);
        assert!(matches!(
            migrate(&home).unwrap(),
            FlatMigrationStatus::AlreadyMigrated
        ));
        assert_eq!(
            std::fs::read_to_string(&dest).unwrap(),
            "{\"last_space\":\"work\"}"
        );
    }

    /// Legacy settings are NOT clobbered when the destination already
    /// has newer settings.
    #[test]
    fn existing_settings_win_over_legacy() {
        let home = tempfile::tempdir().unwrap().keep();
        seed_flat(&home);
        let legacy_settings = crate::paths::legacy_app_support_dir(&home).join("settings.json");
        std::fs::create_dir_all(legacy_settings.parent().unwrap()).unwrap();
        std::fs::write(&legacy_settings, "{\"last_space\":\"old\"}").unwrap();
        let dest = spaces::app_settings_path_in(&oxi_of(&home));
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        std::fs::write(&dest, "{\"last_space\":\"new\"}").unwrap();

        migrate(&home).unwrap();

        assert_eq!(
            std::fs::read_to_string(&dest).unwrap(),
            "{\"last_space\":\"new\"}"
        );
    }

    // -- P1-5: .git history and permission preservation -----------------

    /// P1-5: a real `.git` repository in the flat vault must end up in
    /// the personal vault with working history.
    #[test]
    fn git_history_and_permissions_survive_flat_migration() {
        let home = tempfile::tempdir().unwrap().keep();
        seed_flat(&home);
        let flat = home.join(".oxi/vault");
        let Some(head) = crate::testing::git_init_commit(&flat) else {
            eprintln!("git unavailable; skipping");
            return;
        };
        let secret = flat.join("2026-08-28-101010.md");
        let script = flat.join("_assets/run.sh");
        std::fs::write(&script, "#!/bin/sh\necho hi\n").unwrap();
        if !crate::testing::chmod_supported(&secret, 0o600)
            || !crate::testing::chmod_supported(&script, 0o755)
        {
            eprintln!("chmod is a no-op on this filesystem; skipping");
            return;
        }

        let personal = crate::spaces::space_vault_dir(&oxi_of(&home), "personal");
        migrate(&home).unwrap();

        assert_eq!(
            crate::testing::git_head(&personal).as_deref(),
            Some(head.as_str()),
            "git history works inside the personal vault"
        );
        assert_eq!(
            crate::testing::mode_of(&personal.join("2026-08-28-101010.md")),
            Some(0o600)
        );
        assert_eq!(
            crate::testing::mode_of(&personal.join("_assets/run.sh")),
            Some(0o755)
        );
    }
}
