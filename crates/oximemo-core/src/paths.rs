//! Filesystem layout for a vault and its derived index.
//!
//! Layout:
//! ```text
//! <vault>/                          # default: ~/.oxi/vault
//! ├── <folder>/<title-slug>.md     # notes in physical folders
//! ├── _assets/<blake3hex>.<ext>     # images referenced as oximg://<name>
//! ├── .trash/<original-path>        # deleted files (path preserved)
//! └── oximemo.toml                  # vault config
//! <app_support>/index/
//!     ├── meta.redb
//!     ├── meta.redb.lock
//!     ├── search/
//!     └── by-vault/<hash>/   # only for custom `--vault` paths
//! ```
//!
//! The default vault moved to `~/.oxi/vault` (shared ecosystem location);
//! [`crate::migrate_vault`] performs the one-time move from the
//! pre-unification application-support path.

use std::path::{Path, PathBuf};

pub const APP_SUPPORT_SUBDIR: &str = "com.oximemo.app";
pub const VAULT_DEFAULT_SUBDIR: &str = "vault";
pub const INDEX_SUBDIR: &str = "index";
pub const META_DB_NAME: &str = "meta.redb";
pub const META_LOCK_NAME: &str = "meta.redb.lock";
pub const SEARCH_SUBDIR: &str = "search";
pub const TRASH_DIR: &str = ".trash";
pub const ASSETS_DIR: &str = "_assets";
pub const BY_VAULT_SUBDIR: &str = "by-vault";
pub const CONFIG_NAME: &str = "oximemo.toml";
/// Legacy config filename (pre-v3). Loaded as fallback for backward compat.
pub const LEGACY_CONFIG_NAME: &str = "config.toml";
/// Filename reserved for per-folder markdown templates; excluded from listings.
pub const TEMPLATE_NAME: &str = "TEMPLATE.md";
/// Filename reserved for per-folder HTML templates; excluded from listings.
pub const TEMPLATE_HTML_NAME: &str = "TEMPLATE.html";
/// Filename reserved for per-folder property schemas; `.toml` is already
/// outside the note extensions so no scan exclusion is needed (design
/// 2026-08-23 §6.2).
pub const SCHEMA_NAME: &str = "SCHEMA.toml";
/// Extension for saved query-view documents (spec §1, §3).
pub const QUERY_EXT: &str = "query";
/// Sub-directory under `.trash/` holding trashed `.query` files. Lives under
/// the trash root so a global purge (designed elsewhere) wipes them with the
/// rest of the trash tree.
pub const TRASH_QUERIES_DIR: &str = "_queries";

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
                let vault = default_vault_dir();
                let index_dir = support.join(INDEX_SUBDIR);
                Self { vault, index_dir }
            }
            Some(v) => {
                // An explicitly-passed default vault (the GUI watcher
                // opens `Some(paths().vault)` on every fs event) must
                // share the top-level index: a by-vault namespace here
                // forks the index, and watcher reindexes land in a copy
                // that open(None) — the app's read path — never reads.
                // Lexical comparison (no fs access): both sides derive
                // from the same `$HOME` string, so normalization is
                // exact for the cases that matter (trailing slash, `.`,
                // `..`); a symlinked variant still namespaces, same as
                // it always has.
                if lexical_abs(v) == lexical_abs(&default_vault_dir()) {
                    let vault = default_vault_dir();
                    return Self {
                        vault,
                        index_dir: support.join(INDEX_SUBDIR),
                    };
                }
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

    /// Root directory to scan for notes (= vault root). Files live directly
    /// in physical folders, not date-sharded subdirectories.
    pub fn scan_root(&self) -> &Path {
        &self.vault
    }

    pub fn trash_root(&self) -> PathBuf {
        self.vault.join(TRASH_DIR)
    }

    pub fn assets_root(&self) -> PathBuf {
        self.vault.join(ASSETS_DIR)
    }

    /// Path of a single asset by its `<hash>.<ext>` name. Caller is
    /// responsible for validating `name` (see `assets::valid_name`); this
    /// only joins it.
    pub fn asset_path(&self, name: &str) -> PathBuf {
        self.assets_root().join(name)
    }

    /// Config path: prefer `oximemo.toml`, fall back to legacy `config.toml`.
    pub fn config_path(&self) -> PathBuf {
        let new = self.vault.join(CONFIG_NAME);
        if new.exists() {
            return new;
        }
        let legacy = self.vault.join(LEGACY_CONFIG_NAME);
        if legacy.exists() {
            return legacy;
        }
        new
    }

    /// Where new config should be written (always `oximemo.toml`).
    pub fn config_write_path(&self) -> PathBuf {
        self.vault.join(CONFIG_NAME)
    }

    pub fn meta_db_path(&self) -> PathBuf {
        self.index_dir.join(META_DB_NAME)
    }

    pub fn meta_lock_path(&self) -> PathBuf {
        self.index_dir.join(META_LOCK_NAME)
    }

    /// Marker file recording the indexed preview format version. Its absence
    /// (or a stale version) triggers a one-time reindex on startup so cached
    /// previews are regenerated after `make_preview` changes.
    pub fn index_fmt_marker_path(&self) -> PathBuf {
        self.index_dir.join("index-fmt")
    }

    /// Marker file recording whether the one-time Inbox (`idea` preset)
    /// seed has run. Idempotent across migrations; absent = seed on next
    /// `ensure_default_folders()`. Lives under the index dir (not the
    /// vault) so a synced/cloud vault never carries the marker.
    pub fn inbox_seed_marker_path(&self) -> PathBuf {
        self.index_dir.join("inbox-seed")
    }

    pub fn search_dir(&self) -> PathBuf {
        self.index_dir.join(SEARCH_SUBDIR)
    }

    /// Full path for a note file: `<vault>/<folder>/<filename><ext>`.
    /// Empty `folder` = vault root. The extension comes from the format.
    pub fn note_path(&self, folder: &str, filename: &str, fmt: crate::memo::NoteFormat) -> PathBuf {
        let name = format!("{filename}{}", fmt.ext());
        match folder.is_empty() {
            true => self.vault.join(name),
            false => self.vault.join(folder).join(name),
        }
    }

    /// Trash path preserving the original relative location.
    pub fn trash_path(&self, rel_path: &str) -> PathBuf {
        self.trash_root().join(rel_path)
    }

    /// Convert an absolute path inside the vault to a vault-relative string.
    /// Returns `None` if the path is outside the vault.
    pub fn relative_path(&self, abs: &Path) -> Option<String> {
        abs.strip_prefix(&self.vault)
            .ok()
            .and_then(|p| p.to_str())
            .map(|s| s.to_string())
    }
}

/// `~/Library/Application Support/com.oximemo.app` (macOS default).
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


/// Lexically absolutize and normalize `p` without touching the
/// filesystem: relative paths resolve against the CWD, `.` components
/// drop, and `..` collapses against the previous component. Symlinks
/// are NOT resolved — [`Paths::resolve`]'s default-vault comparison
/// feeds both sides through this, so lexical equality is exact.
fn lexical_abs(p: &Path) -> PathBuf {
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(p)
    };
    let mut out = PathBuf::new();
    for c in abs.components() {
        match c {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}
/// `~/.oxi/vault` — the shared ecosystem default vault (design
/// 2026-08-20 §5.1). The derived index still lives under application
/// support (see [`Paths::resolve`]) so a vault synced through a cloud
/// folder never ships its binary indexes.
pub fn default_vault_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home).join(".oxi").join(VAULT_DEFAULT_SUBDIR)
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

    /// The default vault lives at `~/.oxi/vault` (shared ecosystem
    /// location, design 2026-08-20 §5.1) while its derived index stays
    /// under application support.
    #[test]
    fn default_vault_lives_under_dot_oxi() {
        // Leaked home (see `migrate_vault::with_home`): concurrent tests
        // resolve their index through env HOME, so the swap target must
        // outlive them.
        let home = tempfile::tempdir().unwrap().keep();
        crate::migrate_vault::with_home(&home, || {
            let p = Paths::resolve(None);
            assert_eq!(p.vault, home.join(".oxi").join(VAULT_DEFAULT_SUBDIR));
            assert_eq!(p.index_dir, app_support_dir().join(INDEX_SUBDIR));
        });
    }

    #[test]
    fn distinct_custom_vaults_get_distinct_indexes() {
        let a = Paths::resolve(Some(Path::new("/tmp/vault-a")));
        let b = Paths::resolve(Some(Path::new("/tmp/vault-b")));
        assert_ne!(a.index_dir, b.index_dir);
    }

    #[test]
    fn note_path_root_folder() {
        let p = Paths::resolve(Some(Path::new("/tmp/v")));
        assert_eq!(
            p.note_path("", "2026-08-13-143052", crate::memo::NoteFormat::Markdown),
            PathBuf::from("/tmp/v/2026-08-13-143052.md")
        );
    }

    #[test]
    fn note_path_nested_folder() {
        let p = Paths::resolve(Some(Path::new("/tmp/v")));
        assert_eq!(
            p.note_path(
                "novel/act1",
                "첫-번째-장",
                crate::memo::NoteFormat::Markdown
            ),
            PathBuf::from("/tmp/v/novel/act1/첫-번째-장.md")
        );
        assert_eq!(
            p.note_path("wiki", "아키텍처", crate::memo::NoteFormat::Html),
            PathBuf::from("/tmp/v/wiki/아키텍처.html")
        );
    }

    #[test]
    fn trash_path_preserves_structure() {
        let p = Paths::resolve(Some(Path::new("/tmp/v")));
        assert_eq!(
            p.trash_path("novel/act1/old.md"),
            PathBuf::from("/tmp/v/.trash/novel/act1/old.md")
        );
    }

    #[test]
    fn explicit_default_vault_shares_top_level_index() {
        // The GUI watcher opens Vault::open(Some(<default vault>)) on
        // every fs event; that must map to the SAME index the app reads
        // via open(None), or watcher reindexes land in an index nobody
        // reads (fix for the 2026-08-28 index-fork finding).
        let none = Paths::resolve(None);
        let explicit = Paths::resolve(Some(&default_vault_dir()));
        assert_eq!(explicit.index_dir, none.index_dir);
        assert_eq!(explicit.vault, none.vault);

        // Lexical variants of the same path must not fork a namespace.
        let trailing = PathBuf::from(format!("{}/", default_vault_dir().display()));
        assert_eq!(Paths::resolve(Some(&trailing)).index_dir, none.index_dir);
        let mut dotted = default_vault_dir();
        dotted.push(".");
        dotted.push("..");
        dotted.push(VAULT_DEFAULT_SUBDIR);
        assert_eq!(Paths::resolve(Some(&dotted)).index_dir, none.index_dir);
    }

    #[test]
    fn custom_vaults_still_get_hash_namespaces() {
        let a = Paths::resolve(Some(Path::new("/tmp/some-other-vault")));
        let none = Paths::resolve(None);
        assert!(a
            .index_dir
            .parent()
            .is_some_and(|p| p.ends_with(BY_VAULT_SUBDIR)));
        assert_ne!(a.index_dir, none.index_dir);
        assert_eq!(a.vault, PathBuf::from("/tmp/some-other-vault"));
    }
}
