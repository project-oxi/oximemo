//! Filesystem layout for a vault and its derived index (§5.1, §5.2).
//!
//! Layout:
//! ```text
//! <vault>/
//! ├── notes/<YYYY>/<MM>/<id>.md
//! ├── .trash/<id>.md
//! └── config.toml
//! <app_support>/index/
//!     ├── meta.redb
//!     ├── meta.redb.lock
//!     ├── search/
//!     └── by-vault/<hash>/   # only for custom `--vault` paths
//! ```

use std::path::{Path, PathBuf};
use time::{Month, OffsetDateTime};

use crate::note::NoteId;

pub const APP_SUPPORT_SUBDIR: &str = "com.oxinot.app";
pub const VAULT_DEFAULT_SUBDIR: &str = "vault";
pub const INDEX_SUBDIR: &str = "index";
pub const META_DB_NAME: &str = "meta.redb";
pub const META_LOCK_NAME: &str = "meta.redb.lock";
pub const SEARCH_SUBDIR: &str = "search";
pub const NOTES_DIR: &str = "notes";
pub const TRASH_DIR: &str = ".trash";
pub const BY_VAULT_SUBDIR: &str = "by-vault";
pub const CONFIG_NAME: &str = "config.toml";

/// Resolved filesystem locations for one vault.
#[derive(Debug, Clone)]
pub struct Paths {
    pub vault: PathBuf,
    pub index_dir: PathBuf,
}

impl Paths {
    /// Resolve paths for a vault root.
    ///
    /// The derived index **always** lives under application support, never
    /// inside the vault. This honors §15's hard rule: a vault placed inside an
    /// iCloud Drive folder would otherwise sync the binary index files and
    /// corrupt them across devices. For the default vault the index sits at the
    /// documented `…/index/` location (§5.1); a custom (`--vault`) vault is
    /// namespaced under `…/index/by-vault/<hash>/` so distinct vaults never
    /// share an index.
    pub fn resolve(vault: Option<&Path>) -> Self {
        let support = app_support_dir();
        match vault {
            None => {
                let vault = support.join(VAULT_DEFAULT_SUBDIR);
                let index_dir = support.join(INDEX_SUBDIR);
                Self { vault, index_dir }
            }
            Some(v) => {
                let index_dir = support
                    .join(INDEX_SUBDIR)
                    .join(BY_VAULT_SUBDIR)
                    .join(vault_namespace(v));
                Self {
                    vault: v.to_path_buf(),
                    index_dir,
                }
            }
        }
    }

    pub fn notes_root(&self) -> PathBuf {
        self.vault.join(NOTES_DIR)
    }

    pub fn trash_root(&self) -> PathBuf {
        self.vault.join(TRASH_DIR)
    }

    pub fn config_path(&self) -> PathBuf {
        self.vault.join(CONFIG_NAME)
    }

    pub fn meta_db_path(&self) -> PathBuf {
        self.index_dir.join(META_DB_NAME)
    }

    pub fn meta_lock_path(&self) -> PathBuf {
        self.index_dir.join(META_LOCK_NAME)
    }

    pub fn search_dir(&self) -> PathBuf {
        self.index_dir.join(SEARCH_SUBDIR)
    }

    /// Where a live note's file lives, sharded by creation year/month.
    pub fn note_path(&self, id: NoteId, created_at: OffsetDateTime) -> PathBuf {
        let (year, month) = shard(created_at);
        self.notes_root()
            .join(year.to_string())
            .join(month)
            .join(format!("{}.md", id))
    }

    pub fn trash_path(&self, id: NoteId) -> PathBuf {
        self.trash_root().join(format!("{}.md", id))
    }
}

/// Year + zero-padded 2-digit month for directory sharding.
fn shard(t: OffsetDateTime) -> (i32, String) {
    let month = match t.month() {
        Month::January => "01",
        Month::February => "02",
        Month::March => "03",
        Month::April => "04",
        Month::May => "05",
        Month::June => "06",
        Month::July => "07",
        Month::August => "08",
        Month::September => "09",
        Month::October => "10",
        Month::November => "11",
        Month::December => "12",
    };
    (t.year(), month.to_string())
}

/// `~/Library/Application Support/com.oxinot.app` (macOS default).
pub fn app_support_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join(APP_SUPPORT_SUBDIR)
}

/// Stable, collision-resistant namespace for a custom vault's index dir.
///
/// Derived from the absolute path so the same vault always maps to the same
/// index even if the (possibly non-existent) dir is referenced by a relative
/// path. Truncated to 16 hex chars: enough entropy, human-scannable.
fn vault_namespace(vault: &Path) -> String {
    let abs = if vault.is_absolute() {
        vault.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(vault)
    };
    let mut hasher = blake3::Hasher::new();
    hasher.update(abs.to_string_lossy().as_bytes());
    let hex = hasher.finalize().to_hex();
    hex.as_str()[..16].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_vault_index_lives_outside_vault() {
        let p = Paths::resolve(Some(Path::new("/tmp/some-vault")));
        assert!(
            !p.index_dir.starts_with(&p.vault),
            "index must not be inside the vault"
        );
        assert!(p.index_dir.starts_with(app_support_dir()));
    }

    #[test]
    fn default_vault_uses_documented_index_layout() {
        let p = Paths::resolve(None);
        assert_eq!(p.index_dir, app_support_dir().join(INDEX_SUBDIR));
    }

    #[test]
    fn distinct_custom_vaults_get_distinct_indexes() {
        let a = Paths::resolve(Some(Path::new("/tmp/vault-a")));
        let b = Paths::resolve(Some(Path::new("/tmp/vault-b")));
        assert_ne!(a.index_dir, b.index_dir);
    }
}
