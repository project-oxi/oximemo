//! One-time flat → space migration (spec 2026-08-28 §3).
//!
//! The pre-spaces vault lives *flat* at `~/.oxi/vault` (notes, folders,
//! `.git` directly under it). With spaces adopted, that flat root is the
//! *container* of space directories — so the legacy content moves into
//! the default space `~/.oxi/vault/personal/` once, on `Vault::open`,
//! before path resolution. Provisioned space directories (roots in
//! oxibrain's `~/.oxi/brain/documents.toml`) are excluded from the move;
//! a pre-existing `personal/` blocks the move with `MergeRequired`
//! (same contract as `migrate_vault`). The one sanctioned brain-dir
//! write happens here: the flat root's `path` in `documents.toml` is
//! rewritten to the space dir so the flat `**/*.md` include can never
//! double-ingest future spaces.

use std::path::{Path, PathBuf};

use crate::error::Result;
use crate::spaces::{self, DEFAULT_SPACE_NAME};

/// Outcome of the one-time flat → space migration check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FlatMigrationStatus {
    /// No flat vault present (fresh install or spaces-only layout).
    Fresh,
    /// Default space dir present, no flat signature left.
    AlreadyMigrated,
    /// Content moved into the default space; `moved` counts entries.
    Migrated { moved: usize },
    /// Both the flat signature and `personal/` exist. Nothing was
    /// touched; the user must merge by hand (see `oximemo doctor`).
    MergeRequired { flat: PathBuf, space: PathBuf },
}

/// True when the directory looks like a pre-spaces flat vault: a
/// top-level `oximemo.toml`/`config.toml`, or any top-level regular
/// file (dated note captures). Space containers hold only directories.
fn flat_signature(root: &Path) -> bool {
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
/// `path` value. Line-based (the file is machine-managed by oxibrain);
/// unknown lines are preserved verbatim for the rewrite path.
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

/// Directory names that oxibrain already provisioned as per-space
/// roots (`path = ~/.oxi/vault/<name>` in documents.toml, any tilde or
/// absolute spelling). These are spaces, not flat content.
fn provisioned_space_names(home: &Path) -> Vec<String> {
    let text = std::fs::read_to_string(home.join(".oxi/brain/documents.toml")).unwrap_or_default();
    let flat = spaces::spaces_root(home);
    let flat_canonical = flat.canonicalize().unwrap_or_else(|_| flat.clone());
    let mut names = Vec::new();
    for raw in root_paths(&text) {
        let expanded = if let Some(rest) = raw.strip_prefix("~/") {
            home.join(rest)
        } else {
            PathBuf::from(&raw)
        };
        // Keep the string-match fallback: a tilde path whose target does
        // not exist cannot canonicalize, yet may still name a space dir.
        if expanded == flat {
            continue;
        }
        let canonical = expanded.canonicalize().unwrap_or(expanded.clone());
        if let Ok(rel) = canonical.strip_prefix(&flat_canonical) {
            // Exactly one level under the flat root.
            if rel.components().count() == 1
                && let Some(name) = rel.to_str()
                && spaces::validate_space_name(name).is_ok()
            {
                names.push(name.to_string());
            }
        }
    }
    names
}

/// Rewrite the flat root's `path` in documents.toml to the personal
/// space dir. Only `[[root]]` blocks whose path resolves to the flat
/// root (absolute, tilde, or trailing-slash spelling) are touched;
/// every other line is preserved byte-for-byte. Returns whether any
/// line changed. Atomic (tempfile + rename).
fn rewrite_documents_flat_root(home: &Path) -> Result<bool> {
    let path = home.join(".oxi/brain/documents.toml");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ok(false);
    };
    let flat = spaces::spaces_root(home);
    let target = spaces::space_dir(home, DEFAULT_SPACE_NAME);
    let flat_str = flat.to_string_lossy().to_string();
    let flat_tilde = "~/.oxi/vault".to_string();
    let replacements = [
        flat_str.clone(),
        format!("{flat_str}/"),
        flat_tilde.clone(),
        format!("{flat_tilde}/"),
    ];
    let mut in_root_block = false;
    let mut changed = false;
    let mut out = String::with_capacity(text.len() + 64);
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            in_root_block = t.starts_with("[[root]]");
        } else if in_root_block
            && let Some(v) = strip_path_value(line)
            && replacements.contains(&v)
        {
            out.push_str(&format!("path = \"{}\"", target.to_string_lossy()));
            changed = true;
            out.push('\n');
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    if changed {
        Ok(oxi_frontmatter::atomic_write(&path, out.as_bytes()).is_ok())
    } else {
        Ok(false)
    }
}

/// Run the one-time flat → space migration for `home`. See the module
/// docs for the decision table.
pub fn maybe_migrate(home: &Path) -> Result<FlatMigrationStatus> {
    let flat = spaces::spaces_root(home);
    let space = spaces::space_dir(home, DEFAULT_SPACE_NAME);
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

    let excluded: Vec<String> = provisioned_space_names(home);
    std::fs::create_dir_all(&space)?;
    let mut moved = 0usize;
    for entry in std::fs::read_dir(&flat)?.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy().to_string();
        // The destination dir lives inside the flat root; renaming it
        // into itself is an error. Skip it (and any provisioned space).
        if entry.path() == space || (entry.path().is_dir() && excluded.contains(&name_str)) {
            continue;
        }
        std::fs::rename(entry.path(), space.join(&name))?;
        moved += 1;
    }

    // Index rename: flat `index/` → `index/personal/` when the index is
    // still flat (meta.redb directly inside) and not already namespaced.
    let index = home
        .join("Library/Application Support")
        .join(crate::paths::APP_SUPPORT_SUBDIR)
        .join(crate::paths::INDEX_SUBDIR);
    if index.join(crate::paths::META_DB_NAME).is_file() && !index.join(DEFAULT_SPACE_NAME).exists()
    {
        let tmp = index.with_extension("personal-migrating");
        std::fs::rename(&index, &tmp)?;
        std::fs::create_dir_all(&index)?;
        std::fs::rename(&tmp, index.join(DEFAULT_SPACE_NAME))?;
    }

    rewrite_documents_flat_root(home)?;
    tracing::info!(
        moved,
        "migrated flat vault into space '{DEFAULT_SPACE_NAME}'"
    );
    Ok(FlatMigrationStatus::Migrated { moved })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn seed_flat(home: &Path) {
        let flat = crate::spaces::spaces_root(home);
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
        let personal = crate::spaces::space_dir(&home, "personal");
        let status = maybe_migrate(&home).unwrap();
        assert!(matches!(status, FlatMigrationStatus::Migrated { moved: n } if n >= 5));
        assert!(personal.join("daily/today.md").is_file());
        assert!(personal.join("_assets").is_dir());
        assert!(personal.join(".git/HEAD").is_file()); // history moves with the tree
        assert!(personal.join("oximemo.toml").is_file());
        assert!(!crate::spaces::spaces_root(&home).join("daily").exists());
    }

    #[test]
    fn idempotent_second_run_is_already_migrated() {
        let home = tempfile::tempdir().unwrap().keep();
        seed_flat(&home);
        maybe_migrate(&home).unwrap();
        assert!(matches!(
            maybe_migrate(&home).unwrap(),
            FlatMigrationStatus::AlreadyMigrated
        ));
    }

    #[test]
    fn provisioned_space_dirs_are_excluded_from_the_move() {
        let home = tempfile::tempdir().unwrap().keep();
        seed_flat(&home);
        std::fs::create_dir_all(crate::spaces::spaces_root(&home).join("work")).unwrap();
        seed_brain_dir(
            &home,
            &format!(
                "[[root]]\nalias = \"work\"\npath = \"{}\"\nspace = \"work\"\n",
                crate::spaces::spaces_root(&home).join("work").display()
            ),
        );
        let status = maybe_migrate(&home).unwrap();
        assert!(matches!(status, FlatMigrationStatus::Migrated { .. }));
        assert!(crate::spaces::spaces_root(&home).join("work").is_dir());
        assert!(crate::spaces::space_dir(&home, "personal/daily").is_dir());
    }

    #[test]
    fn existing_personal_blocks_with_merge_required_and_touches_nothing() {
        let home = tempfile::tempdir().unwrap().keep();
        seed_flat(&home);
        let personal = crate::spaces::space_dir(&home, "personal");
        std::fs::create_dir_all(&personal).unwrap();
        std::fs::write(personal.join("mine.md"), "---\nid: m\n---\n").unwrap();
        let before =
            std::fs::read_to_string(crate::spaces::spaces_root(&home).join("2026-08-28-101010.md"))
                .unwrap();
        let status = maybe_migrate(&home).unwrap();
        assert!(matches!(status, FlatMigrationStatus::MergeRequired { .. }));
        // Zero mutations on either side.
        assert_eq!(
            std::fs::read_to_string(crate::spaces::spaces_root(&home).join("2026-08-28-101010.md"))
                .unwrap(),
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
            maybe_migrate(&home).unwrap(),
            FlatMigrationStatus::Fresh
        ));
        // Only space dirs, no top-level files → not a flat vault.
        std::fs::create_dir_all(crate::spaces::space_dir(&home, "work")).unwrap();
        assert!(matches!(
            maybe_migrate(&home).unwrap(),
            FlatMigrationStatus::Fresh
        ));
    }

    #[test]
    fn rewrites_documents_flat_root_to_personal() {
        let home = tempfile::tempdir().unwrap().keep();
        seed_flat(&home);
        let flat = crate::spaces::spaces_root(&home);
        seed_brain_dir(
            &home,
            &format!(
                "[[root]]\nalias = \"vault\"\npath = \"{}\"\nspace = \"personal\"\ninclude = [\"**/*.md\"]\n",
                flat.display()
            ),
        );
        maybe_migrate(&home).unwrap();
        let text = std::fs::read_to_string(home.join(".oxi/brain/documents.toml")).unwrap();
        let personal = crate::spaces::space_dir(&home, "personal");
        assert!(
            text.contains(&format!("path = \"{}\"", personal.display())),
            "flat root path not rewritten: {text}"
        );
        assert!(!text.contains(&format!("path = \"{}\"", flat.display())));
        // The rewritten file keeps other fields verbatim.
        assert!(text.contains("include = [\"**/*.md\"]"));
    }

    #[test]
    fn documents_rewrite_handles_tilde_spelling() {
        let home = tempfile::tempdir().unwrap().keep();
        seed_flat(&home);
        seed_brain_dir(
            &home,
            "[[root]]\nalias = \"vault\"\npath = \"~/.oxi/vault\"\nspace = \"personal\"\n",
        );
        maybe_migrate(&home).unwrap();
        let text = std::fs::read_to_string(home.join(".oxi/brain/documents.toml")).unwrap();
        assert!(text.contains(&format!(
            "path = \"{}\"",
            crate::spaces::space_dir(&home, "personal").display()
        )));
    }

    #[test]
    fn flat_index_is_renamed_to_personal() {
        let home = tempfile::tempdir().unwrap().keep();
        seed_flat(&home);
        let index = home
            .join("Library/Application Support")
            .join(crate::paths::APP_SUPPORT_SUBDIR)
            .join(crate::paths::INDEX_SUBDIR);
        std::fs::create_dir_all(&index).unwrap();
        std::fs::write(index.join(crate::paths::META_DB_NAME), b"redb").unwrap();
        maybe_migrate(&home).unwrap();
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
        maybe_migrate(&home).unwrap(); // vault migrates; an already-namespaced index must survive untouched
        assert!(
            index
                .join("personal")
                .join(crate::paths::META_DB_NAME)
                .is_file()
        );
    }
}
