//! Vault configuration parsed from `config.toml` (§5.8).
//!
//! All fields have defaults so a vault with no config file behaves identically
//! to one with every value spelled out.

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::paths::Paths;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct VaultConfig {
    pub general: GeneralConfig,
    pub capture: CaptureConfig,
    pub appearance: AppearanceConfig,
    pub folders: FoldersConfig,
    pub index: IndexConfig,
    /// oxibrain integration (spec D13). The desktop panel degrades to a
    /// one-line status when the daemon is unreachable.
    pub brain: BrainConfig,
    /// Daily notes section (spec 2026-08-21 §1).
    pub daily: DailyConfig,
    /// Forward-compatible schema marker. Unknown fields are ignored.
    pub schema_version: u32,
}

impl Default for VaultConfig {
    fn default() -> Self {
        Self {
            general: GeneralConfig::default(),
            capture: CaptureConfig::default(),
            appearance: AppearanceConfig::default(),
            folders: FoldersConfig::default(),
            index: IndexConfig::default(),
            brain: BrainConfig::default(),
            daily: DailyConfig::default(),
            schema_version: 3,
        }
    }
}

/// oxibrain daemon connection settings. `socket` empty = use
/// `~/.oxi/brain/oxibrain.sock` (the daemon default).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct BrainConfig {
    /// Panel visibility and context gathering master switch.
    pub enabled: bool,
    /// Absolute path to the daemon's Unix socket; empty = default location.
    pub socket: String,
    /// Knowledge space name; "personal" matches the daemon's own default.
    pub space: String,
}

impl Default for BrainConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            socket: String::new(),
            space: "personal".to_string(),
        }
    }
}
/// Daily notes (spec 2026-08-21 §1). `folder` is vault-relative; the
/// folder is auto-created by the first note's write.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct DailyConfig {
    pub enabled: bool,
    pub folder: String,
}

impl Default for DailyConfig {
    fn default() -> Self {
        Self { enabled: true, folder: "daily".into() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct GeneralConfig {
    pub trash_retention_days: u32,
}

impl Default for GeneralConfig {
    fn default() -> Self {
        Self {
            trash_retention_days: 30,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct CaptureConfig {
    pub double_tap_threshold_ms: u32,
    pub overlay_max_height: u32,
}

impl Default for CaptureConfig {
    fn default() -> Self {
        Self {
            double_tap_threshold_ms: 350,
            overlay_max_height: 400,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppearanceConfig {
    pub theme: Theme,
    pub show_dock_icon: bool,
}

impl Default for AppearanceConfig {
    fn default() -> Self {
        Self {
            theme: Theme::System,
            show_dock_icon: true,
        }
    }
}
/// View mode for a folder (§6.1). Grid is the global default; folders can
/// override and optionally lock their choice.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ViewMode {
    #[default]
    Grid,
    List,
    Timeline,
    Graph,
}

/// A user-configured folder: path, optional locked view, optional color.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderDef {
    /// Vault-root-relative folder path (e.g. `"novel"`, `"diary"`).
    /// Empty string = root.
    pub path: String,
    /// Locked view mode. `None` = use global default (grid).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<ViewMode>,
    /// OKLCH color for sidebar dot / card accent. `None` = no tint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Pinned to the sidebar favorites section. `None` = not pinned.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct FoldersConfig {
    pub items: Vec<FolderDef>,
}

/// Resolve a folder path to its OKLCH color. Returns `None` when the folder
/// has no color configured (caller renders default surface).
pub fn resolve_folder_color(path: &str, items: &[FolderDef]) -> Option<String> {
    items
        .iter()
        .find(|f| f.path == path)
        .and_then(|f| f.color.clone())
}

/// Resolve a folder path to its locked view mode. Returns `None` when unlocked.
pub fn resolve_folder_view(path: &str, items: &[FolderDef]) -> Option<ViewMode> {
    items.iter().find(|f| f.path == path).and_then(|f| f.view)
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct IndexConfig {
    pub watcher_debounce_ms: u32,
}

impl Default for IndexConfig {
    fn default() -> Self {
        Self {
            watcher_debounce_ms: 300,
        }
    }
}

impl VaultConfig {
    /// Load config for a vault, falling back to defaults if the file is absent
    /// or unreadable (a corrupt file is logged but never fatal).
    pub fn load(paths: &Paths) -> Self {
        let path = paths.config_path();
        match std::fs::read_to_string(&path) {
            Ok(text) => match toml::from_str::<Self>(&text) {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!(path = %path.display(), error = %e, "config.toml parse failed; using defaults");
                    Self::default()
                }
            },
            Err(_) => Self::default(),
        }
    }

    /// Serialize back to TOML text (used by `oximemo` config init / doctor).
    pub fn to_toml(&self) -> Result<String, toml::ser::Error> {
        toml::to_string_pretty(self)
    }

    /// Persist this config to `<vault>/oximemo.toml`.
    pub fn save(&self, paths: &Paths) -> Result<()> {
        let text = self.to_toml()?;
        let path = paths.config_write_path();
        // Crash-safe: write to a temp sibling then atomically rename (APFS).
        let tmp = path.with_extension("toml.tmp");
        std::fs::write(&tmp, text)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }

    /// Serialize to a JSON value with `folders` flattened to a plain array
    /// (the frontend `Config` type expects `folders: FolderDef[]`, not
    /// `{ items: [...] }`).
    pub fn config_json(&self) -> serde_json::Value {
        serde_json::json!({
            "schema_version": self.schema_version,
            "general": self.general,
            "capture": self.capture,
            "appearance": self.appearance,
            "folders": self.folders.items,
            "brain": self.brain,
            "daily": self.daily,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_roundtrip() {
        let c = VaultConfig::default();
        let s = c.to_toml().unwrap();
        let back: VaultConfig = toml::from_str(&s).unwrap();
        assert_eq!(back.general.trash_retention_days, 30);
        assert_eq!(back.schema_version, 3);
    }

    #[test]
    fn brain_section_defaults_and_roundtrip() {
        let c = VaultConfig::default();
        assert!(c.brain.enabled);
        assert_eq!(c.brain.socket, "");
        assert_eq!(c.brain.space, "personal");

        let s = c.to_toml().unwrap();
        let back: VaultConfig = toml::from_str(&s).unwrap();
        assert!(back.brain.enabled);

        // Explicit override wins.
        let t = r#"
[brain]
enabled = false
socket = "/tmp/custom.sock"
space = "work"
"#;
        let c2: VaultConfig = toml::from_str(t).unwrap();
        assert!(!c2.brain.enabled);
        assert_eq!(c2.brain.socket, "/tmp/custom.sock");
        assert_eq!(c2.brain.space, "work");

        // Exposed via config_json for the frontend.
        let j = c2.config_json();
        assert_eq!(j["brain"]["socket"], "/tmp/custom.sock");
    }
    #[test]
    fn daily_section_defaults_and_overrides() {
        let c = VaultConfig::default();
        assert!(c.daily.enabled);
        assert_eq!(c.daily.folder, "daily");

        // Round-trips through TOML.
        let s = c.to_toml().unwrap();
        let back: VaultConfig = toml::from_str(&s).unwrap();
        assert_eq!(back.daily.folder, "daily");

        // Explicit override wins.
        let t = r#"
[daily]
enabled = false
folder = "journal"
"#;
        let c2: VaultConfig = toml::from_str(t).unwrap();
        assert!(!c2.daily.enabled);
        assert_eq!(c2.daily.folder, "journal");

        // Exposed via config_json for the frontend.
        let json = c.config_json();
        assert_eq!(json["daily"]["enabled"], serde_json::json!(true));
        assert_eq!(json["daily"]["folder"], serde_json::json!("daily"));
    }

    #[test]
    fn unknown_fields_ignored() {
        let t = r#"schema_version = 1
[general]
trash_retention_days = 7
unknown_future_field = true
"#;
        let c: VaultConfig = toml::from_str(t).unwrap();
        assert_eq!(c.general.trash_retention_days, 7);
    }

    #[test]
    fn save_roundtrips_folders() {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = VaultConfig::default();
        let paths = Paths::resolve(Some(dir.path()));
        cfg.folders.items.push(FolderDef {
            path: "novel".into(),
            view: Some(ViewMode::List),
            color: Some("oklch(0.7 0.1 200)".into()),
            pinned: None,
        });

        cfg.save(&paths).unwrap();
        let reloaded = VaultConfig::load(&paths);
        assert!(reloaded.folders.items.iter().any(|f| f.path == "novel"));
    }

    #[test]
    fn old_config_with_categories_loads() {
        // Old config with [categories] section — unknown field ignored by serde.
        let t = r#"schema_version = 2
[categories]
[[categories.items]]
id = "todo"
color = "oklch(0.78 0.15 75)"
builtin = true
"#;
        let c: VaultConfig = toml::from_str(t).unwrap();
        assert!(c.folders.items.is_empty());
    }
}
