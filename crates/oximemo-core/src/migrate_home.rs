//! Home-layout migration orchestration — the engine behind
//! `oximemo migrate-home`.
//!
//! [`preflight`] is pure inspection: every legacy source (the
//! application-support vault, the flat vault, legacy settings, the
//! legacy index) is reported as `fresh` / `pending` / `completed` /
//! `conflict` with byte totals when pending and the required action,
//! mutating nothing. [`run`] executes (or resumes) both migrators in
//! order; the CLI then attempts the pending-registration flush on top.
//!
//! All facts resolve from the shared Oxi home ([`crate::paths`]) so the
//! report honors `OXI_HOME` and stays hermetic in tests.

use std::path::Path;

use crate::error::Result;
use crate::migration_journal as journal;
use crate::paths;
use crate::spaces::{self, DEFAULT_SPACE_NAME};
use crate::{migrate_spaces, migrate_vault};

/// Status of one migration source in the preflight report.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceStatus {
    /// Nothing to migrate (fresh install or already absorbed).
    Fresh,
    /// A migration is required (or resumable) for this source.
    Pending,
    /// The migration already completed (possibly with a retired backup).
    Completed,
    /// Both sides are populated without journal cover: merge by hand.
    Conflict,
}

/// One source line of the preflight report.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SourceReport {
    /// Stable identifier: `app-support-vault`, `flat-vault`,
    /// `legacy-settings`, `legacy-index`.
    pub source: String,
    /// The source path when it is meaningful (None = nothing legacy).
    pub path: Option<String>,
    pub status: SourceStatus,
    /// Byte total of the source tree when a migration is pending.
    pub pending_bytes: Option<u64>,
    /// What the user should do next.
    pub action: String,
}

/// Pure-inspection report for `oximemo migrate-home --dry-run`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct HomeMigrationPreflight {
    pub oxi_home: String,
    pub sources: Vec<SourceReport>,
    /// A documents-root registration is waiting for a flush.
    pub pending_root_registration: bool,
    /// Retired cross-volume backups from completed migrations —
    /// verified copies, safe to delete manually.
    pub retired_backups: Vec<String>,
}

/// One executed (or resumed) migration.
#[derive(Debug, Clone, serde::Serialize)]
pub struct MigrationStep {
    pub source: String,
    /// Human-readable outcome (`migrated`, `already-migrated`,
    /// `merge-required`, `fresh`, …).
    pub outcome: String,
}

/// Result of `oximemo migrate-home` (no `--dry-run`).
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct HomeMigrationRun {
    pub migrations: Vec<MigrationStep>,
    /// Pending-registration flush attempt. `None` = nothing pending or
    /// the brain is disabled; `Some(false)` = flush failed (offline —
    /// the pending file stays for the next flush point).
    pub flush_succeeded: Option<bool>,
    /// The brain-side outcome when the flush succeeded.
    pub flush_outcome: Option<String>,
}

fn tree_bytes(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    let mut total = 0;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            total += tree_bytes(&p);
        } else if let Ok(meta) = entry.metadata() {
            total += meta.len();
        }
    }
    total
}

fn journal_status(oxi_home: &Path, key: &str) -> Option<&'static str> {
    journal::entry(oxi_home, key).map(|e| {
        if e.status == journal::STATUS_COMPLETE {
            "complete"
        } else {
            "in_progress"
        }
    })
}

fn pending_action(resume: bool) -> String {
    if resume {
        "resume the interrupted migration: oximemo migrate-home".into()
    } else {
        "run: oximemo migrate-home".into()
    }
}

fn app_support_vault_report(oxi_home: &Path, legacy_home: Option<&Path>) -> SourceReport {
    let old = legacy_home.map(migrate_vault::old_default_vault);
    let new = migrate_vault::new_default_vault(oxi_home);
    let status = journal_status(oxi_home, journal::APP_SUPPORT_VAULT);
    let old_populated = old.as_deref().is_some_and(migrate_vault::is_populated);
    let new_populated = migrate_vault::is_populated(&new);

    let (status, pending_bytes, action) = if status == Some("complete") {
        let backup =
            journal::entry(oxi_home, journal::APP_SUPPORT_VAULT).and_then(|e| e.retired_backup);
        (
            SourceStatus::Completed,
            None,
            match backup {
                Some(b) => format!("none — retired backup at {b} can be deleted manually"),
                None => "none".to_string(),
            },
        )
    } else if old_populated && !new_populated {
        (
            SourceStatus::Pending,
            old.as_deref().map(tree_bytes),
            pending_action(false),
        )
    } else if old_populated && new_populated {
        if status == Some("in_progress") {
            (
                SourceStatus::Pending,
                old.as_deref().map(tree_bytes),
                pending_action(true),
            )
        } else {
            (
                SourceStatus::Conflict,
                None,
                format!("merge {} and {} by hand", old_display(&old), new.display()),
            )
        }
    } else {
        (SourceStatus::Fresh, None, "none".to_string())
    };

    SourceReport {
        source: "app-support-vault".into(),
        path: old.map(|p| p.display().to_string()),
        status,
        pending_bytes,
        action,
    }
}

fn old_display(old: &Option<std::path::PathBuf>) -> String {
    old.as_deref()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "(none)".into())
}

fn flat_vault_report(oxi_home: &Path) -> SourceReport {
    let flat = oxi_home.join("vault");
    let personal = spaces::space_vault_dir(oxi_home, DEFAULT_SPACE_NAME);
    let status = journal_status(oxi_home, journal::FLAT_VAULT);
    let flat_present = migrate_spaces::flat_signature(&flat);
    let personal_present = personal.is_dir();

    let (status, pending_bytes, action) = if status == Some("complete") && !flat_present {
        (SourceStatus::Completed, None, "none".to_string())
    } else if flat_present && !personal_present {
        (
            SourceStatus::Pending,
            Some(tree_bytes(&flat)),
            pending_action(false),
        )
    } else if flat_present && personal_present {
        if status == Some("in_progress") {
            (
                SourceStatus::Pending,
                Some(tree_bytes(&flat)),
                pending_action(true),
            )
        } else {
            (
                SourceStatus::Conflict,
                None,
                format!(
                    "merge {} and {} by hand",
                    flat.display(),
                    personal.display()
                ),
            )
        }
    } else {
        (SourceStatus::Fresh, None, "none".to_string())
    };

    SourceReport {
        source: "flat-vault".into(),
        path: flat_present.then(|| flat.display().to_string()),
        status,
        pending_bytes,
        action,
    }
}

fn legacy_settings_report(oxi_home: &Path, legacy_home: Option<&Path>) -> SourceReport {
    // Candidates in recency order: the flat-era `~/.oxi/settings.json`
    // first, then the pre-flat application-support copy. Mirrors
    // `migrate_spaces::migrate_legacy_settings`.
    let flat = oxi_home.join("settings.json");
    let source = if flat.is_file() {
        Some(flat)
    } else {
        legacy_home
            .map(|h| paths::legacy_app_support_dir(h).join("settings.json"))
            .filter(|p| p.is_file())
    };
    let dest = spaces::app_settings_path_in(oxi_home);
    let completed = |key| journal_status(oxi_home, key) == Some("complete");

    let (status, pending_bytes, action) = match &source {
        Some(src) if !dest.exists() => (
            SourceStatus::Pending,
            Some(src.metadata().map(|m| m.len()).unwrap_or(0)),
            pending_action(false),
        ),
        Some(_) => (SourceStatus::Completed, None, "none".to_string()),
        None if completed(journal::FLAT_SETTINGS) || completed(journal::LEGACY_SETTINGS) => {
            (SourceStatus::Completed, None, "none".to_string())
        }
        None => (SourceStatus::Fresh, None, "none".to_string()),
    };

    SourceReport {
        source: "legacy-settings".into(),
        path: source.map(|p| p.display().to_string()),
        status,
        pending_bytes,
        action,
    }
}

fn legacy_index_report(oxi_home: &Path, legacy_home: Option<&Path>) -> SourceReport {
    let source = legacy_home
        .map(|h| paths::legacy_app_support_dir(h).join(paths::INDEX_SUBDIR))
        .filter(|p| p.join(paths::META_DB_NAME).is_file());
    let namespaced = oxi_home
        .join("oximemo")
        .join(paths::INDEX_SUBDIR)
        .join(DEFAULT_SPACE_NAME)
        .exists();

    let (status, pending_bytes, action) = match &source {
        Some(src) if !namespaced => (
            SourceStatus::Pending,
            Some(tree_bytes(src)),
            pending_action(false),
        ),
        Some(_) => (SourceStatus::Completed, None, "none".to_string()),
        None => (SourceStatus::Fresh, None, "none".to_string()),
    };

    SourceReport {
        source: "legacy-index".into(),
        path: source.map(|p| p.display().to_string()),
        status,
        pending_bytes,
        action,
    }
}

/// Inspect every legacy home-layout source without mutating anything
/// (`oximemo migrate-home --dry-run`).
pub fn preflight() -> HomeMigrationPreflight {
    let oxi = paths::oxi_home();
    let legacy = paths::user_home();
    HomeMigrationPreflight {
        oxi_home: oxi.display().to_string(),
        sources: vec![
            app_support_vault_report(&oxi, legacy.as_deref()),
            flat_vault_report(&oxi),
            legacy_settings_report(&oxi, legacy.as_deref()),
            legacy_index_report(&oxi, legacy.as_deref()),
        ],
        pending_root_registration: crate::brain::has_pending_root_registration(),
        retired_backups: journal::retired_backups(&oxi),
    }
}

/// Execute (or resume) both home-layout migrators. The pending-
/// registration flush is left to the caller (the CLI does it right
/// after, blocking, with an `[brain].executable`-aware resolution).
///
/// # Errors
///
/// Propagates migrator I/O or conversion errors; each migrator is
/// idempotent/resumable, so re-running after a fixed error is safe.
pub fn run() -> Result<HomeMigrationRun> {
    let oxi = paths::oxi_home();
    let legacy = paths::user_home();
    let mut run = HomeMigrationRun::default();

    let status = migrate_vault::maybe_migrate(&oxi, legacy.as_deref())?;
    run.migrations.push(MigrationStep {
        source: "app-support-vault".into(),
        outcome: fmt_vault_status(status),
    });

    let status = migrate_spaces::maybe_migrate(&oxi, legacy.as_deref())?;
    run.migrations.push(MigrationStep {
        source: "flat-vault".into(),
        outcome: fmt_flat_status(status),
    });

    Ok(run)
}

fn fmt_vault_status(status: migrate_vault::MigrationStatus) -> String {
    use migrate_vault::MigrationStatus as M;
    match status {
        M::Fresh => "fresh".into(),
        M::AlreadyMigrated => "already-migrated".into(),
        M::Migrated { converted } => format!("migrated ({converted} notes converted)"),
        M::MergeRequired { old, new } => {
            format!(
                "merge-required: {} and {} both exist",
                old.display(),
                new.display()
            )
        }
    }
}

fn fmt_flat_status(status: migrate_spaces::FlatMigrationStatus) -> String {
    use migrate_spaces::FlatMigrationStatus as M;
    match status {
        M::Fresh => "fresh".into(),
        M::AlreadyMigrated => "already-migrated".into(),
        M::Migrated { moved } => format!("migrated ({moved} entries moved)"),
        M::MergeRequired { flat, space } => {
            format!(
                "merge-required: {} and {} both exist",
                flat.display(),
                space.display()
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migrate_vault::with_home;

    #[test]
    fn preflight_reports_pending_and_never_mutates() {
        let home = tempfile::tempdir().unwrap().keep();
        with_home(&home, || {
            // Seed a legacy application-support vault.
            let old = migrate_vault::old_default_vault(&home);
            std::fs::create_dir_all(&old).unwrap();
            std::fs::write(old.join("oximemo.toml"), "[general]\n").unwrap();
            std::fs::write(old.join("note.md"), "---\nid: a\n---\nhello\n").unwrap();

            let report = preflight();
            let vault = report
                .sources
                .iter()
                .find(|s| s.source == "app-support-vault")
                .expect("vault line");
            assert_eq!(vault.status, SourceStatus::Pending);
            assert!(vault.pending_bytes.unwrap_or(0) > 0);
            // Pure inspection: the legacy vault is untouched, nothing
            // migrated, nothing journaled, no spaces layout created.
            assert!(old.join("oximemo.toml").is_file());
            assert!(!migrate_vault::new_default_vault(&home).exists());
            assert!(!home.join(".oxi/spaces").exists());
            assert!(!home.join(".oxi/oximemo/migration-journal.json").exists());
        });
    }

    #[test]
    fn run_migrates_and_reports_outcomes() {
        let home = tempfile::tempdir().unwrap().keep();
        with_home(&home, || {
            let old = migrate_vault::old_default_vault(&home);
            std::fs::create_dir_all(old.join("novel")).unwrap();
            std::fs::write(
                old.join("novel/a.md"),
                "---\nid: a\ncreated: t\nupdated: t\n---\nx\n",
            )
            .unwrap();

            let report = run().expect("run");
            assert_eq!(report.migrations.len(), 2);
            assert!(
                report.migrations[0].outcome.starts_with("migrated"),
                "{:?}",
                report.migrations
            );
            assert!(
                migrate_vault::new_default_vault(&home.join(".oxi"))
                    .join("novel/a.md")
                    .is_file(),
                "vault landed in the spaces layout"
            );

            // Idempotent rerun.
            let rerun = run().unwrap();
            assert_eq!(rerun.migrations[0].outcome, "already-migrated");
        });
    }
}
