//! Vault configuration parsed from `config.toml` (§5.8).
//!
//! All fields have defaults so a vault with no config file behaves identically
//! to one with every value spelled out.

use serde::{Deserialize, Serialize};

use crate::paths::Paths;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct VaultConfig {
    pub general: GeneralConfig,
    pub capture: CaptureConfig,
    pub appearance: AppearanceConfig,
    pub color: ColorConfig,
    pub index: IndexConfig,
    /// Forward-compatible schema marker. Unknown fields are ignored.
    pub schema_version: u32,
}

impl Default for VaultConfig {
    fn default() -> Self {
        Self {
            general: GeneralConfig::default(),
            capture: CaptureConfig::default(),
            appearance: AppearanceConfig::default(),
            color: ColorConfig::default(),
            index: IndexConfig::default(),
            schema_version: 1,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct GeneralConfig {
    pub trash_retention_days: u32,
}

impl Default for GeneralConfig {
    fn default() -> Self {
        Self { trash_retention_days: 30 }
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
        Self { double_tap_threshold_ms: 350, overlay_max_height: 400 }
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
        Self { theme: Theme::System, show_dock_icon: true }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ColorConfig {
    /// OKLCH preset strings offered in the picker.
    pub presets: Vec<String>,
}

impl Default for ColorConfig {
    fn default() -> Self {
        Self {
            presets: crate::note::COLOR_PRESETS.iter().map(|s| s.to_string()).collect(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct IndexConfig {
    pub watcher_debounce_ms: u32,
    pub watcher_retry_count: u32,
    pub watcher_retry_interval_ms: u32,
}

impl Default for IndexConfig {
    fn default() -> Self {
        Self { watcher_debounce_ms: 300, watcher_retry_count: 2, watcher_retry_interval_ms: 200 }
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

    /// Serialize back to TOML text (used by `oxinot` config init / doctor).
    pub fn to_toml(&self) -> Result<String, toml::ser::Error> {
        toml::to_string_pretty(self)
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
        assert_eq!(back.schema_version, 1);
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
}
