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
    pub categories: CategoriesConfig,
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
            categories: CategoriesConfig::default(),
            index: IndexConfig::default(),
            schema_version: 2,
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
/// Five default category color stops (OKLCH). The order and ids are the
/// canonical built-in palette; `CategoriesConfig::default` ships them as the
/// initial `items` so a fresh vault inherits a usable sidebar. The previous
/// sixth entry, the `note` (blue) category, was retired: orphan refs (memos
/// with `category = "note"`) fall back to the default card surface via
/// [`resolve_category_color`] because the id is no longer in `items`.
pub const AUTO_COLORS: &[&str] = &[
    "",                       // inbox — transparent (renders default card surface)
    "oklch(0.78 0.15 75)",  // todo — amber
    "oklch(0.72 0.15 310)", // idea — purple
    "oklch(0.75 0.12 195)", // bookmark — teal
    "oklch(0.75 0.13 145)", // snippet — green
];

/// Resolve a category id to its OKLCH color string. Returns the inbox color
/// (empty/transparent) when the id is empty or not in `items`, so an unknown
/// / legacy category never crashes rendering — it falls back to the default
/// card surface (no tint).
pub fn resolve_category_color(id: &str, items: &[CategoryDef]) -> String {
    if let Some(def) = items.iter().find(|c| c.id == id) {
        return def.color.clone();
    }
    AUTO_COLORS[0].to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CategoryDef {
    pub id: String,
    pub color: String,
    #[serde(default)]
    pub builtin: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct CategoriesConfig {
    pub items: Vec<CategoryDef>,
}

impl Default for CategoriesConfig {
    fn default() -> Self {
        let ids = ["inbox", "todo", "idea", "bookmark", "snippet"];
        let items = ids
            .iter()
            .zip(AUTO_COLORS.iter())
            .map(|(id, color)| CategoryDef {
                id: (*id).to_string(),
                color: (*color).to_string(),
                builtin: true,
            })
            .collect();
        Self { items }
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
        Self {
            watcher_debounce_ms: 300,
            watcher_retry_count: 2,
            watcher_retry_interval_ms: 200,
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

    /// Serialize back to TOML text (used by `oxinot` config init / doctor).
    pub fn to_toml(&self) -> Result<String, toml::ser::Error> {
        toml::to_string_pretty(self)
    }

    /// Persist this config to `<vault>/config.toml`. Used after category CRUD
    /// to write user-defined categories back to disk so they survive restarts.
    pub fn save(&self, paths: &Paths) -> Result<()> {
        let text = self.to_toml()?;
        let path = paths.config_path();
        // Crash-safe: write to a temp sibling then atomically rename (APFS).
        // A torn write would otherwise silently revert the user's category
        // setup to built-ins on next load (load() degrades to defaults).
        let tmp = path.with_extension("toml.tmp");
        std::fs::write(&tmp, text)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
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
        assert_eq!(back.schema_version, 2);
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
    fn save_roundtrips_categories() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::resolve(Some(dir.path()));
        let mut cfg = VaultConfig::default();
        cfg.categories.items.push(CategoryDef {
            id: "custom".into(),
            color: "oklch(0.7 0.1 200)".into(),
            builtin: false,
        });
        cfg.save(&paths).unwrap();
        let reloaded = VaultConfig::load(&paths);
        assert!(reloaded.categories.items.iter().any(|c| c.id == "custom"));
    }
}
