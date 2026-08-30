//! Shared migration journal (`pub(crate)`) — crash visibility and
//! resume state for the home-layout migrations ([`crate::migrate_vault`]
//! and [`crate::migrate_spaces`]), read back by `Vault::doctor` and the
//! `migrate-home` preflight.
//!
//! Location: `<oxi-home>/oximemo/migration-journal.json` — inside
//! oximemo's own private subtree, never a brain file. Each migration
//! writes its entry atomically (tempfile + rename) **before** the first
//! filesystem mutation and marks it complete only after verification,
//! so a crash anywhere in between leaves a visible `in_progress` entry
//! the next run resumes from. The journal is advisory on top of the
//! migrations' own restart tolerance: write failures are logged and
//! swallowed, never propagated to the migration path.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Journal key: application-support default vault →
/// `spaces/personal/vault`.
pub(crate) const APP_SUPPORT_VAULT: &str = "app_support_vault";
/// Journal key: flat `~/.oxi/vault` → spaces layout (+ legacy index).
pub(crate) const FLAT_VAULT: &str = "flat_vault";
/// Journal key: legacy `settings.json` → oximemo-private settings.
pub(crate) const LEGACY_SETTINGS: &str = "legacy_settings";

/// Entry status until the migration verified cleanly.
pub(crate) const STATUS_IN_PROGRESS: &str = "in_progress";
/// Entry status after the migration verified.
pub(crate) const STATUS_COMPLETE: &str = "complete";

/// One migration's journal entry (schema v1).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct JournalEntry {
    /// [`STATUS_IN_PROGRESS`] or [`STATUS_COMPLETE`].
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination: Option<String>,
    /// Cross-volume fallback: the source tree intentionally kept as a
    /// verified backup (never deleted by the migration).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retired_backup: Option<String>,
}

/// The journal document (schema version 1).
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
pub(crate) struct Journal {
    version: u32,
    #[serde(default)]
    migrations: BTreeMap<String, JournalEntry>,
}

fn journal_path(oxi_home: &Path) -> PathBuf {
    oxi_home.join("oximemo").join("migration-journal.json")
}

/// Load the journal; missing or unparseable files read as empty (the
/// migrations then take their filesystem-derived branches, exactly as
/// before the journal existed).
pub(crate) fn load(oxi_home: &Path) -> Journal {
    let Ok(text) = std::fs::read_to_string(journal_path(oxi_home)) else {
        return Journal::default();
    };
    match serde_json::from_str(&text) {
        Ok(j) => j,
        Err(e) => {
            tracing::warn!(
                error = %e,
                path = %journal_path(oxi_home).display(),
                "migration journal unparseable; treating as empty"
            );
            Journal::default()
        }
    }
}

fn save(oxi_home: &Path, journal: &Journal) {
    match serde_json::to_string_pretty(journal) {
        Ok(body) => {
            if let Err(e) = oxi_frontmatter::atomic_write(&journal_path(oxi_home), body.as_bytes())
            {
                tracing::warn!(
                    error = %e,
                    path = %journal_path(oxi_home).display(),
                    "migration journal write failed; continuing (advisory state)"
                );
            }
        }
        Err(e) => tracing::warn!(error = %e, "migration journal serialize failed"),
    }
}

/// The current entry for `key`, if any.
pub(crate) fn entry(oxi_home: &Path, key: &str) -> Option<JournalEntry> {
    load(oxi_home).migrations.get(key).cloned()
}

/// Whether the migration for `key` is journaled as complete.
pub(crate) fn is_complete(oxi_home: &Path, key: &str) -> bool {
    entry(oxi_home, key).is_some_and(|e| e.status == STATUS_COMPLETE)
}

/// Record that the migration for `key` is starting. Written **before**
/// the first filesystem mutation so a crash leaves visible state.
pub(crate) fn begin(oxi_home: &Path, key: &str, source: &Path, destination: &Path) {
    let entry = JournalEntry {
        status: STATUS_IN_PROGRESS.into(),
        source: Some(source.display().to_string()),
        destination: Some(destination.display().to_string()),
        retired_backup: None,
    };
    let mut journal = load(oxi_home);
    journal.version = 1;
    journal.migrations.insert(key.to_string(), entry);
    save(oxi_home, &journal);
}

/// Mark the migration for `key` complete, optionally recording the
/// source tree kept as a retired backup (cross-volume fallback).
pub(crate) fn complete(oxi_home: &Path, key: &str, retired_backup: Option<&Path>) {
    let mut journal = load(oxi_home);
    let fresh = JournalEntry {
        status: STATUS_COMPLETE.into(),
        source: journal.migrations.get(key).and_then(|e| e.source.clone()),
        destination: journal
            .migrations
            .get(key)
            .and_then(|e| e.destination.clone()),
        retired_backup: retired_backup.map(|p| p.display().to_string()),
    };
    journal.version = 1;
    journal.migrations.insert(key.to_string(), fresh);
    save(oxi_home, &journal);
}

/// Verified source-tree backups from completed cross-volume migrations
/// — safe to delete manually once the new layout is confirmed working
/// (`doctor` surfaces them).
pub(crate) fn retired_backups(oxi_home: &Path) -> Vec<String> {
    load(oxi_home)
        .migrations
        .into_values()
        .filter_map(|e| e.retired_backup)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn begin_complete_roundtrip_and_backup_listing() {
        let dir = tempfile::tempdir().unwrap();
        let oxi = dir.path().to_path_buf();

        assert!(load(&oxi).migrations.is_empty());
        assert!(!is_complete(&oxi, APP_SUPPORT_VAULT));
        assert!(retired_backups(&oxi).is_empty());

        begin(
            &oxi,
            APP_SUPPORT_VAULT,
            Path::new("/old"),
            Path::new("/new"),
        );
        let e = entry(&oxi, APP_SUPPORT_VAULT).expect("entry after begin");
        assert_eq!(e.status, STATUS_IN_PROGRESS);
        assert_eq!(e.source.as_deref(), Some("/old"));
        assert_eq!(e.destination.as_deref(), Some("/new"));
        assert!(e.retired_backup.is_none());
        // Other keys untouched.
        assert!(entry(&oxi, FLAT_VAULT).is_none());

        complete(&oxi, APP_SUPPORT_VAULT, Some(Path::new("/old")));
        let e = entry(&oxi, APP_SUPPORT_VAULT).expect("entry after complete");
        assert_eq!(e.status, STATUS_COMPLETE);
        assert_eq!(e.source.as_deref(), Some("/old"), "source survives");
        assert_eq!(e.retired_backup.as_deref(), Some("/old"));
        assert!(is_complete(&oxi, APP_SUPPORT_VAULT));
        assert_eq!(retired_backups(&oxi), vec!["/old".to_string()]);

        complete(&oxi, FLAT_VAULT, None);
        assert_eq!(
            retired_backups(&oxi),
            vec!["/old".to_string()],
            "the flat entry adds no backup of its own"
        );
    }

    #[test]
    fn corrupt_journal_reads_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        let oxi = dir.path().to_path_buf();
        let file = journal_path(&oxi);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "{not json").unwrap();
        assert!(load(&oxi).migrations.is_empty());
        assert!(!is_complete(&oxi, APP_SUPPORT_VAULT));
    }
}
