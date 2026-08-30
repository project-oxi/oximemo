//! Filesystem layout for a vault and its derived index.
//!
//! Layout:
//! ```text
//! ~/.oxi/spaces/<space>/vault/       # default: ~/.oxi/spaces/personal/vault
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
//! The default vault moved to `~/.oxi/spaces/personal/vault` (shared ecosystem location);
//! [`crate::migrate_vault`] performs the one-time move from the
//! pre-unification application-support path.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub const APP_SUPPORT_SUBDIR: &str = "com.oximemo.app";
pub const SPACES_SUBDIR: &str = "spaces";
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
                let index_dir = custom_index_support()
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

    /// Resolve paths for a spec-aware vault selection (spec 2026-08-28
    /// §1). A space vault namespaces its derived index as
    /// `…/index/<space>/`; an explicit path keeps the historical
    /// `…/index/by-vault/<hash>/`.
    pub fn resolve_spec(spec: &crate::spaces::VaultSpec) -> Self {
        match spec {
            crate::spaces::VaultSpec::Space(name) => Self {
                vault: oxi_home()
                    .join(SPACES_SUBDIR)
                    .join(name)
                    .join(VAULT_DEFAULT_SUBDIR),
                index_dir: app_support_dir().join(INDEX_SUBDIR).join(name),
            },
            crate::spaces::VaultSpec::Explicit(p) => Self::resolve(Some(p)),
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

    /// Marker file recording the BLAKE3 fingerprint of the
    /// extraction-affecting subset of `[tasks]` config (parser version,
    /// `enabled`, `global_filter`, `statuses`). A mismatch (or absence)
    /// triggers a one-time reindex so `IndexRecord.tasks` picks up the
    /// new extraction rules.
    pub fn tasks_fingerprint_path(&self) -> PathBuf {
        self.index_dir.join("tasks-fingerprint")
    }

    /// Marker file recording whether the one-time Inbox (`idea` preset)
    /// seed has run. Idempotent across migrations; absent = seed on next
    /// `ensure_default_folders()`. Lives under the index dir (not the
    /// vault) so a synced/cloud vault never carries the marker.
    pub fn inbox_seed_marker_path(&self) -> PathBuf {
        self.index_dir.join("inbox-seed")
    }

    /// Marker file recording whether the one-shot installed `할 일`
    /// base seed (tasks spec §7.4) has run. Same ownership rule as
    /// [`Self::inbox_seed_marker_path`]: present = never reseed, so a
    /// deliberate deletion is permanent until the user re-creates the
    /// file by hand.
    pub fn tasks_base_seed_marker_path(&self) -> PathBuf {
        self.index_dir.join("tasks-base-seed")
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

/// `~/.oxi/oximemo` — oximemo-private settings and derived state.
/// Honors the test override ([`isolate_app_support_for_tests`]): when
/// oximemo-core is compiled as a plain dependency (e.g. inside the CLI
/// binary's own unit tests) the `cfg(test)` pending gate does not
/// exist, so a vault-opening test would otherwise record pending
/// registrations into the user's real `~/.oxi/oximemo`.
pub fn app_support_dir() -> PathBuf {
    TEST_APP_SUPPORT
        .get()
        .cloned()
        .unwrap_or_else(|| oxi_home().join("oximemo"))
}

static TEST_APP_SUPPORT: OnceLock<PathBuf> = OnceLock::new();

/// # Test-only
/// Redirect `app_support_dir()` (pending registrations, settings,
/// index namespaces) into `$TMPDIR/oximemo-test-appsupport-<pid>`.
/// Idempotent; the first call wins and production never initializes it
/// (a runtime-set global). Mirrors `isolate_index_root_for_tests`.
#[doc(hidden)]
pub fn isolate_app_support_for_tests() -> PathBuf {
    TEST_APP_SUPPORT
        .get_or_init(|| {
            let root = std::env::temp_dir()
                .join(format!("oximemo-test-appsupport-{}", std::process::id()));
            let _ = std::fs::create_dir_all(&root);
            root
        })
        .clone()
}

/// Legacy macOS app-support location used only while migrating old installs.
pub fn legacy_app_support_dir(home: &Path) -> PathBuf {
    home.join("Library")
        .join("Application Support")
        .join(APP_SUPPORT_SUBDIR)
}

/// Process-global override consulted ONLY by the custom-vault branch of
/// [`Paths::resolve`] (and [`by_vault_root`]). Test binaries call
/// [`isolate_index_root_for_tests`] once so `Vault::open(Some(temp))`
/// namespaces land under a per-process tempdir instead of the real
/// `~/Library/Application Support` — without it every vault-opening test
/// leaks one redb namespace per run into the user's real index dir (the
/// 2026-08-28 explosion: 267 dirs / 365 MB in a day). Production never
/// sets it, and the `resolve(None)` branch is deliberately unaffected
/// because migrate-vault tests swap `HOME` and assert default placement.
static TEST_INDEX_ROOT: OnceLock<PathBuf> = OnceLock::new();

/// # Test-only
/// Redirect custom-vault index namespaces into
/// `$TMPDIR/oximemo-test-index-<pid>`. Idempotent; the first call wins
/// and later calls return the same root. The dir is intentionally NOT
/// cleaned on exit — the OS temp reaper owns `$TMPDIR` reclamation.
#[doc(hidden)]
pub fn isolate_index_root_for_tests() -> PathBuf {
    TEST_INDEX_ROOT
        .get_or_init(|| {
            let root =
                std::env::temp_dir().join(format!("oximemo-test-index-{}", std::process::id()));
            let _ = std::fs::create_dir_all(&root);
            root
        })
        .clone()
}

/// App-support root for CUSTOM-vault index namespaces. Honors the
/// test override for the same reason the `Some` branch does.
fn custom_index_support() -> PathBuf {
    TEST_INDEX_ROOT
        .get()
        .cloned()
        .unwrap_or_else(app_support_dir)
}

/// Root holding per-custom-vault index namespaces (`index/by-vault`).
/// The GC target ([`crate::vault::Vault::gc_stale_namespaces`]); honors
/// the test override so GC tests run against fixtures, not the user's
/// real index.
pub fn by_vault_root() -> PathBuf {
    custom_index_support()
        .join(INDEX_SUBDIR)
        .join(BY_VAULT_SUBDIR)
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
/// `~/.oxi/spaces/personal/vault` — the shared ecosystem default vault (design
/// 2026-08-20 §5.1). The derived index still lives under application
/// support (see [`Paths::resolve`]) so a vault synced through a cloud
/// folder never ships its binary indexes.
pub fn default_vault_dir() -> PathBuf {
    oxi_home()
        .join(SPACES_SUBDIR)
        .join(crate::spaces::DEFAULT_SPACE_NAME)
        .join(VAULT_DEFAULT_SUBDIR)
}

/// Resolve the shared Oxi home. `OXI_HOME` is the portable/test override.
pub fn oxi_home() -> PathBuf {
    if let Some(path) = std::env::var_os("OXI_HOME") {
        return PathBuf::from(path);
    }
    let home = std::env::var_os("HOME").unwrap_or_else(|| ".".into());
    PathBuf::from(home).join(".oxi")
}

/// The user's home directory (`$HOME`) — used only for **legacy**
/// application-support lookups (pre-unification vault, index, and
/// settings). `None` when `$HOME` is unset or empty: no legacy
/// location can meaningfully exist without a home, so every legacy
/// migration candidate is then treated as absent.
pub fn user_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_vault_index_lives_outside_vault() {
        // Ordering-proof: the override may already be set by whichever
        // test ran first; assert against the override-aware root.
        let _ = isolate_index_root_for_tests();
        let p = Paths::resolve(Some(Path::new("/tmp/some-vault")));
        assert!(
            !p.index_dir.starts_with(&p.vault),
            "index must not be inside the vault"
        );
        assert!(p.index_dir.starts_with(custom_index_support()));
    }

    /// The default vault lives at `~/.oxi/spaces/personal/vault` (shared
    /// ecosystem location) while its derived index stays
    /// under application support.
    #[test]
    fn default_vault_lives_under_dot_oxi() {
        // Leaked home (see `migrate_vault::with_home`): concurrent tests
        // resolve their index through env HOME, so the swap target must
        // outlive them.
        let home = tempfile::tempdir().unwrap().keep();
        crate::migrate_vault::with_home(&home, || {
            let p = Paths::resolve(None);
            assert_eq!(
                p.vault,
                home.join(".oxi")
                    .join(SPACES_SUBDIR)
                    .join("personal")
                    .join(VAULT_DEFAULT_SUBDIR)
            );
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
        assert!(
            a.index_dir
                .parent()
                .is_some_and(|p| p.ends_with(BY_VAULT_SUBDIR))
        );
        assert_ne!(a.index_dir, none.index_dir);
        assert_eq!(a.vault, PathBuf::from("/tmp/some-other-vault"));
    }

    #[test]
    fn test_override_redirects_custom_vault_namespaces_only() {
        // First setter wins; whichever test sets it, this contract holds.
        let root = isolate_index_root_for_tests();
        let custom = Paths::resolve(Some(Path::new("/tmp/leak-check-vault")));
        assert!(
            custom.index_dir.starts_with(&root),
            "custom-vault namespace must land under the test override root"
        );
        // The None branch stays HOME-based: migrate tests swap HOME and
        // assert default placement against app_support_dir().
        let none = Paths::resolve(None);
        assert_eq!(none.index_dir, app_support_dir().join(INDEX_SUBDIR));
        assert!(!none.index_dir.starts_with(&root));
    }

    #[test]
    fn space_vaults_get_namespaced_indexes() {
        let a = Paths::resolve_spec(&crate::spaces::VaultSpec::Space("a".into()));
        let b = Paths::resolve_spec(&crate::spaces::VaultSpec::Space("b".into()));
        assert_eq!(
            a.vault,
            oxi_home()
                .join(SPACES_SUBDIR)
                .join("a")
                .join(VAULT_DEFAULT_SUBDIR)
        );
        assert_eq!(
            b.vault,
            oxi_home()
                .join(SPACES_SUBDIR)
                .join("b")
                .join(VAULT_DEFAULT_SUBDIR)
        );
        assert_ne!(a.index_dir, b.index_dir);
        assert!(a.index_dir.ends_with("index/a"));
    }

    #[test]
    fn explicit_spec_keeps_by_vault_hash_index() {
        let s = crate::spaces::VaultSpec::Explicit(PathBuf::from("/tmp/some-vault"));
        let p = Paths::resolve_spec(&s);
        let q = Paths::resolve(Some(Path::new("/tmp/some-vault")));
        assert_eq!(p.index_dir, q.index_dir);
    }
}
