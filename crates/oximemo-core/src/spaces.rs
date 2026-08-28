//! Spaces — per-space vault identity (spec 2026-08-28).
//!
//! A space is one directory under `~/.oxi/vault/`; the directory name
//! is the space identity for the vault path, the derived index
//! namespace, and the brain registration. This module owns name
//! validation and the app-local "last selected space" setting; path
//! resolution lands here in Task 2 additions.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, Result};

/// The default space name. Matches the oxibrain daemon default and the
/// historical flat-root registration space in `documents.toml`.
pub const DEFAULT_SPACE_NAME: &str = "personal";

/// A space name is an identifier: it becomes a directory name under
/// `~/.oxi/vault/`. Letters (any script), digits, `-`, `_`; length
/// 1..=64 after trimming. Verbatim semantics of oxibrain-core's
/// `validate_space_name` (spec 2026-08-28 §4) — the two rules must not
/// drift; the acceptance corpus in `tests` pins the shared cases.
pub fn validate_space_name(raw: &str) -> Result<String> {
    let name = raw.trim();
    let chars: Vec<char> = name.chars().collect();
    if chars.is_empty() {
        return Err(CoreError::InvalidSpaceName(
            "empty after trimming".to_string(),
        ));
    }
    if chars.len() > 64 {
        return Err(CoreError::InvalidSpaceName(format!(
            "{} chars (max 64)",
            chars.len()
        )));
    }
    if let Some(bad) = chars
        .iter()
        .find(|c| !c.is_alphanumeric() && **c != '-' && **c != '_')
    {
        return Err(CoreError::InvalidSpaceName(format!(
            "disallowed character {bad:?} (letters, digits, '-', '_')"
        )));
    }
    Ok(name.to_string())
}

/// `~/.oxi/vault/` — the container whose subdirectories are spaces.
pub fn spaces_root(home: &Path) -> PathBuf {
    home.join(".oxi").join("vault")
}

/// `~/.oxi/vault/<name>/` for a validated space name.
pub fn space_dir(home: &Path, name: &str) -> PathBuf {
    spaces_root(home).join(name)
}

/// The space identity of any vault path: the directory name. Space
/// vaults were validated at resolution, so this is display/registration
/// sugar; a rootless path falls back to the default name.
pub fn vault_space_name(vault: &Path) -> String {
    vault
        .file_name()
        .and_then(|n| n.to_str())
        .map(str::to_string)
        .unwrap_or_else(|| DEFAULT_SPACE_NAME.to_string())
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct AppSettings {
    #[serde(default)]
    last_space: Option<String>,
}

/// `…/com.oximemo.app/settings.json` — app-local UI state shared by
/// desktop boot and the CLI (same machine, same app support dir).
pub fn app_settings_path() -> PathBuf {
    crate::paths::app_support_dir().join("settings.json")
}

/// The last space the user selected. `None` when unset or the file is
/// corrupt — resolution then falls through to the default space.
pub fn last_space() -> Option<String> {
    let text = std::fs::read_to_string(app_settings_path()).ok()?;
    serde_json::from_str::<AppSettings>(&text)
        .ok()?
        .last_space
        .filter(|s| validate_space_name(s).is_ok())
}

/// Persist the selected space atomically (tempfile + rename).
pub fn set_last_space(name: &str) -> Result<()> {
    let path = app_settings_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let text = serde_json::to_string_pretty(&AppSettings {
        last_space: Some(name.to_string()),
    })?;
    oxi_frontmatter::atomic_write(&path, text.as_bytes())
        .map_err(|e| CoreError::other(e.to_string()))
}

/// How a vault was selected. Space identity is the directory name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VaultSpec {
    /// Explicit path (`--vault` / `OXIMEMO_VAULT`). Tests and custom setups.
    Explicit(PathBuf),
    /// A space directory: `~/.oxi/vault/<name>/`.
    Space(String),
}

/// Resolve which vault to open (spec §1 precedence):
/// 1. explicit path → `Explicit`
/// 2. space flag → `Space(name)`
/// 3. app-local `last_space` → `Space(name)` — only when its directory exists
/// 4. default → `Space("personal")`
///
/// `explicit` and `space` together is a usage error (spec §4).
pub fn resolve_vault_spec(explicit: Option<&Path>, space: Option<&str>) -> Result<VaultSpec> {
    if let Some(p) = explicit {
        if space.is_some() {
            return Err(CoreError::Other(
                "--vault and --space are mutually exclusive".to_string(),
            ));
        }
        return Ok(VaultSpec::Explicit(p.to_path_buf()));
    }
    if let Some(raw) = space {
        return Ok(VaultSpec::Space(validate_space_name(raw)?));
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    if let Some(name) = last_space()
        && space_dir(Path::new(&home), &name).is_dir()
    {
        return Ok(VaultSpec::Space(name));
    }
    Ok(VaultSpec::Space(DEFAULT_SPACE_NAME.to_string()))
}

/// Every space directory under `~/.oxi/vault/`: subdirectories whose
/// names pass validation, skipping dotfiles, sorted. The filesystem is
/// the registry — the daemon is never consulted (offline is normal).
pub fn list_spaces() -> Vec<String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let root = spaces_root(Path::new(&home));
    let mut names: Vec<String> = std::fs::read_dir(&root)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| validate_space_name(n).is_ok())
        .collect();
    names.sort();
    names
}

/// Create a space by name (idempotent) and scaffold it: `mkdir -p`,
/// then `Vault::open_spec` + `ensure_initialized` (folders, config).
/// No brain-directory writes — daemon registration happens on the next
/// open via the existing detached `sync_run`.
pub fn create_space(name: &str) -> Result<PathBuf> {
    let name = validate_space_name(name)?;
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let dir = space_dir(Path::new(&home), &name);
    std::fs::create_dir_all(&dir)?;
    let vault = crate::Vault::open_spec(&VaultSpec::Space(name))?;
    vault.ensure_initialized()?;
    Ok(dir)
}

/// Record the user's space selection. The directory must already exist
/// (create first). Returns the space dir for the caller to report.
pub fn switch_space(name: &str) -> Result<PathBuf> {
    let name = validate_space_name(name)?;
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let dir = space_dir(Path::new(&home), &name);
    if !dir.is_dir() {
        return Err(CoreError::NotFound(format!(
            "space '{name}' does not exist (create it first: oximemo space add {name})"
        )));
    }
    set_last_space(&name)?;
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- validate_space_name (mirrors oxibrain-core spaces.rs verbatim) --

    #[test]
    fn accepts_slug_and_unicode() {
        assert_eq!(validate_space_name("personal").unwrap(), "personal");
        assert_eq!(validate_space_name(" dev-2 ").unwrap(), "dev-2");
        assert_eq!(validate_space_name("개인").unwrap(), "개인");
        assert_eq!(
            validate_space_name(&"x".repeat(64)).unwrap(),
            "x".repeat(64)
        );
    }

    #[test]
    fn rejects_bad_names() {
        assert!(validate_space_name("").is_err());
        assert!(validate_space_name("   ").is_err());
        assert!(validate_space_name("has space").is_err());
        assert!(validate_space_name("a/b").is_err());
        assert!(validate_space_name("a\\b").is_err());
        assert!(validate_space_name("a:b").is_err());
        assert!(validate_space_name("a.b").is_err());
        assert!(validate_space_name(&"x".repeat(65)).is_err());
    }

    // -- last_space setting (atomic settings.json under app support) --

    #[test]
    fn last_space_roundtrip() {
        let home = tempfile::tempdir().unwrap().keep();
        crate::migrate_vault::with_home(&home, || {
            set_last_space("work").unwrap();
            assert_eq!(last_space(), Some("work".to_string()));
            set_last_space("personal").unwrap();
            assert_eq!(last_space(), Some("personal".to_string()));
        });
    }

    #[test]
    fn last_space_missing_or_corrupt_file_is_none() {
        let home = tempfile::tempdir().unwrap().keep();
        crate::migrate_vault::with_home(&home, || {
            assert_eq!(last_space(), None); // no settings.json yet
            std::fs::create_dir_all(app_settings_path().parent().unwrap()).unwrap();
            std::fs::write(app_settings_path(), "{not json").unwrap();
            assert_eq!(last_space(), None); // corrupt JSON → None, never an error
        });
    }

    #[test]
    fn spaces_root_layout() {
        assert_eq!(spaces_root(Path::new("/h")), PathBuf::from("/h/.oxi/vault"));
        assert_eq!(
            space_dir(Path::new("/h"), "work"),
            PathBuf::from("/h/.oxi/vault/work")
        );
    }

    #[test]
    fn vault_space_name_is_the_dirname() {
        assert_eq!(
            vault_space_name(&space_dir(Path::new("/h"), "work")),
            "work"
        );
        assert_eq!(
            vault_space_name(Path::new("/tmp/custom-vault")),
            "custom-vault"
        );
        assert_eq!(vault_space_name(Path::new("/")), DEFAULT_SPACE_NAME);
    }

    // -- resolve_vault_spec precedence (spec §1) --

    #[test]
    fn explicit_path_wins() {
        let s = resolve_vault_spec(Some(Path::new("/tmp/v")), None).unwrap();
        assert!(matches!(s, VaultSpec::Explicit(ref p) if p == Path::new("/tmp/v")));
    }

    #[test]
    fn vault_and_space_flags_are_mutually_exclusive() {
        // The desktop/CLI arg layer rejects the pair before calling in,
        // but resolution defends the same contract for any other caller.
        let s = resolve_vault_spec(Some(Path::new("/tmp/v")), Some("work"));
        assert!(s.is_err());
    }

    #[test]
    fn space_flag_beats_last_space_setting() {
        let home = tempfile::tempdir().unwrap().keep();
        crate::migrate_vault::with_home(&home, || {
            set_last_space("work").unwrap();
            let s = resolve_vault_spec(None, Some("other")).unwrap();
            assert!(matches!(s, VaultSpec::Space(ref n) if n == "other"));
        });
    }

    #[test]
    fn last_space_used_only_when_its_directory_exists() {
        let home = tempfile::tempdir().unwrap().keep();
        crate::migrate_vault::with_home(&home, || {
            // Recorded but the dir was deleted → fall through to default.
            set_last_space("gone").unwrap();
            let s = resolve_vault_spec(None, None).unwrap();
            assert!(matches!(s, VaultSpec::Space(ref n) if n == "personal"));
            // Directory exists → selected.
            std::fs::create_dir_all(space_dir(&home, "gone")).unwrap();
            let s = resolve_vault_spec(None, None).unwrap();
            assert!(matches!(s, VaultSpec::Space(ref n) if n == "gone"));
        });
    }

    #[test]
    fn default_is_personal() {
        let home = tempfile::tempdir().unwrap().keep();
        crate::migrate_vault::with_home(&home, || {
            let s = resolve_vault_spec(None, None).unwrap();
            assert!(matches!(s, VaultSpec::Space(ref n) if n == DEFAULT_SPACE_NAME));
        });
    }

    #[test]
    fn invalid_space_flag_rejected() {
        assert!(resolve_vault_spec(None, Some("not/ok")).is_err());
        assert!(resolve_vault_spec(None, Some("")).is_err());
    }

    // -- list/create/switch (Task 5) --

    #[test]
    fn list_spaces_returns_validated_sorted_dirs_only() {
        let home = tempfile::tempdir().unwrap().keep();
        let root = spaces_root(&home);
        std::fs::create_dir_all(root.join("beta")).unwrap();
        std::fs::create_dir_all(root.join("alpha")).unwrap();
        std::fs::create_dir_all(root.join(".hiddendir")).unwrap();
        std::fs::write(root.join("stray.txt"), "x").unwrap();
        crate::migrate_vault::with_home(&home, || {
            assert_eq!(list_spaces(), vec!["alpha".to_string(), "beta".to_string()]);
        });
    }

    #[test]
    fn create_space_scaffolds_and_is_idempotent() {
        let home = tempfile::tempdir().unwrap().keep();
        crate::migrate_vault::with_home(&home, || {
            let dir = create_space("work").unwrap();
            // ensure_initialized scaffolds the vault, trash, and asset
            // directories; oximemo.toml is written only when the config
            // actually changes, so we assert the scaffolded dirs instead.
            assert!(dir.is_dir());
            assert!(dir.join(".trash").is_dir());
            assert!(dir.join("_assets").is_dir());
            // Second call: same dir, still success.
            let dir2 = create_space("work").unwrap();
            assert_eq!(dir, dir2);
        });
    }

    #[test]
    fn create_space_rejects_invalid_name() {
        assert!(create_space("not/ok").is_err());
    }

    #[test]
    fn switch_space_requires_existing_dir_and_records() {
        let home = tempfile::tempdir().unwrap().keep();
        crate::migrate_vault::with_home(&home, || {
            assert!(switch_space("ghost").is_err()); // missing dir
            create_space("work").unwrap();
            let dir = switch_space("work").unwrap();
            assert_eq!(dir, space_dir(&home, "work"));
            assert_eq!(last_space(), Some("work".to_string()));
        });
    }
}
