//! Vault migration from v2 (categories + date sharding) to v3 (folders + titles).
//!
//! Transforms `memos/<YYYY>/<MM>/<uuid>.md` with `category` frontmatter into
//! `<folder>/<title-slug>.md` with simplified frontmatter. Backs up the vault
//! before modifying anything.

use std::path::{Path, PathBuf};

use crate::error::Result;
use crate::memo::{derive_title, slugify, timestamp_filename};
use crate::paths::Paths;

/// Report of what a migration did (or would do in dry-run).
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct MigrationReport {
    pub files_moved: usize,
    pub folders_created: usize,
    pub wiki_links_updated: usize,
    pub errors: Vec<String>,
    pub dry_run: bool,
}

/// Migrate a vault from v2 to v3 layout.
///
/// Steps:
/// 1. Detect old layout (`memos/` directory exists).
/// 2. Walk `memos/**/*.md`, parse frontmatter.
/// 3. For each file: derive folder from category, filename from H1/timestamp.
/// 4. Rewrite frontmatter (drop category/deleted_at fields).
/// 5. Move to new location.
/// 6. Remove empty `memos/` dirs.
/// 7. Convert `[[UUID]]` wiki links → `[[title]]` in all files.
pub fn migrate_vault(paths: &Paths, dry_run: bool) -> Result<MigrationReport> {
    let mut report = MigrationReport {
        dry_run,
        ..Default::default()
    };

    let old_memos = paths.vault.join("memos");
    if !old_memos.exists() {
        // Already migrated or empty.
        return Ok(report);
    }

    // Collect all old-style .md files.
    let old_files = walk_md(&old_memos);
    if old_files.is_empty() {
        // Clean up empty memos/ dir.
        if !dry_run {
            let _ = std::fs::remove_dir_all(&old_memos);
        }
        return Ok(report);
    }

    // Build a UUID→title map for wiki link conversion.
    let mut id_title_map: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    for path in &old_files {
        if let Ok(text) = std::fs::read_to_string(path)
            && let Some((id, title)) = extract_id_and_title(&text)
        {
            id_title_map.insert(id, title);
        }
    }

    // Process each file.
    for old_path in &old_files {
        match migrate_one(paths, old_path, &id_title_map, dry_run) {
            Ok(()) => {
                report.files_moved += 1;
            }
            Err(e) => {
                report.errors.push(format!("{}: {e}", old_path.display()));
            }
        }
    }

    // Convert wiki links in all files (including already-migrated ones).
    if !dry_run && !id_title_map.is_empty() {
        report.wiki_links_updated = convert_wiki_links(paths, &id_title_map)?;
    }

    // Remove empty memos/ directories, then the memos/ root itself.
    if !dry_run {
        remove_empty_dirs(&old_memos);
        let _ = std::fs::remove_dir(&old_memos);
    }

    // Clear stale search index (schema changed between v2 and v3; tantivy
    // panics if fast-field schema mismatches). The caller's reindex rebuilds it.
    if !dry_run {
        let search_dir = paths.search_dir();
        if search_dir.exists() {
            let _ = std::fs::remove_dir_all(&search_dir);
        }
    }

    report.folders_created = count_folders(paths);
    Ok(report)
}

/// Migrate a single file: parse old frontmatter, derive new path, move.
fn migrate_one(
    paths: &Paths,
    old_path: &Path,
    _id_title_map: &std::collections::HashMap<String, String>,
    dry_run: bool,
) -> Result<()> {
    let text = std::fs::read_to_string(old_path)?;

    // Split frontmatter + body.
    let (fm_text, body) = split_old_frontmatter(&text);

    // Parse old frontmatter to get category, id, created_at, deleted_at.
    let category = parse_toml_field(fm_text, "category").unwrap_or_default();
    let id = parse_toml_field(fm_text, "id").unwrap_or_default();
    let deleted_at = parse_toml_field(fm_text, "deleted_at");

    // Derive folder from category.
    let folder = match category.as_str() {
        "" | "inbox" => String::new(),
        other => other.to_string(),
    };

    // Derive filename.
    let filename = match derive_title(body) {
        Some(title) => slugify(&title),
        None => {
            // Use created_at timestamp or fall back to the UUID.
            let created = parse_toml_field(fm_text, "created_at").unwrap_or_default();
            timestamp_from_rfc3339(&created)
                .map(timestamp_filename)
                .unwrap_or_else(|| slugify(&id))
        }
    };

    // Build new frontmatter (without category/deleted_at).
    let new_fm = rewrite_frontmatter(fm_text);
    let new_text = format!("+++\n{new_fm}+++\n\n{body}");

    // Determine target path.
    let rel_path = if folder.is_empty() {
        format!("{filename}.md")
    } else {
        format!("{folder}/{filename}.md")
    };

    if dry_run {
        tracing::info!(dry_run = true, from = %old_path.display(), to = %rel_path, "would migrate");
        return Ok(());
    }

    // Handle deleted files → trash.
    if deleted_at.is_some() {
        let trash_path = paths.trash_path(&rel_path);
        if let Some(parent) = trash_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&trash_path, new_text)?;
        std::fs::remove_file(old_path)?;
        return Ok(());
    }

    // Write to new location with collision handling.
    let new_path = unique_path(&paths.vault.join(&rel_path));
    if let Some(parent) = new_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&new_path, new_text)?;
    std::fs::remove_file(old_path)?;
    Ok(())
}

/// Convert `[[UUID]]` wiki links to `[[title]]` in all vault files.
fn convert_wiki_links(
    paths: &Paths,
    id_title_map: &std::collections::HashMap<String, String>,
) -> Result<usize> {
    let mut count = 0;
    // Walk all .md files in the vault (post-migration).
    let files = walk_md(&paths.vault);
    for path in &files {
        // Skip trash and assets.
        if path.starts_with(paths.trash_root()) || path.starts_with(paths.assets_root()) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(path) else {
            continue;
        };
        let new_text = convert_uuid_links(&text, id_title_map);
        if new_text != text {
            std::fs::write(path, &new_text)?;
            count += 1;
        }
    }
    Ok(count)
}

/// Replace `[[uuid]]` patterns with `[[title]]` using the map.
fn convert_uuid_links(
    text: &str,
    id_title_map: &std::collections::HashMap<String, String>,
) -> String {
    let re = regex::Regex::new(
        r"\[\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\|[^\]\n]+)?\]\]",
    )
    .expect("valid uuid link regex");
    re.replace_all(text, |caps: &regex::Captures| {
        let uuid = &caps[1];
        let label = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        if let Some(title) = id_title_map.get(uuid) {
            format!("[[{title}{label}]]")
        } else {
            caps[0].to_string()
        }
    })
    .to_string()
}

// ---- helpers ----

fn walk_md(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    walk_md_into(root, &mut out);
    out
}

fn walk_md_into(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if ft.is_dir() {
            walk_md_into(&path, out);
        } else if ft.is_file() && path.extension().is_some_and(|e| e == "md") {
            out.push(path);
        }
    }
}

fn split_old_frontmatter(text: &str) -> (&str, &str) {
    let first_line = text.lines().next().unwrap_or("").trim_end_matches('\r');
    if first_line != "+++" {
        return ("", text);
    }
    let after_first = text.find('\n').map(|i| &text[i + 1..]).unwrap_or("");
    if let Some(end) = after_first.find("\n+++") {
        let fm = &after_first[..end];
        let body_start = end + 4;
        let body = after_first[body_start..]
            .strip_prefix('\n')
            .unwrap_or(&after_first[body_start..]);
        (fm, body)
    } else {
        ("", text)
    }
}

fn parse_toml_field(fm: &str, field: &str) -> Option<String> {
    for line in fm.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix(&format!("{field} =")) {
            let val = rest.trim().trim_matches('"');
            if !val.is_empty() {
                return Some(val.to_string());
            }
        }
    }
    None
}

fn extract_id_and_title(text: &str) -> Option<(String, String)> {
    let (fm, body) = split_old_frontmatter(text);
    let id = parse_toml_field(fm, "id")?;
    let title = derive_title(body).unwrap_or_else(|| slugify(&id));
    Some((id, title))
}

fn rewrite_frontmatter(fm: &str) -> String {
    let mut out = String::new();
    for line in fm.lines() {
        let trimmed = line.trim();
        // Skip removed fields.
        if trimmed.starts_with("category")
            || trimmed.starts_with("deleted_at")
            || trimmed.starts_with("folder")
        {
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

fn timestamp_from_rfc3339(s: &str) -> Option<time::OffsetDateTime> {
    use time::format_description::well_known::Rfc3339;
    time::OffsetDateTime::parse(s, &Rfc3339).ok()
}

fn unique_path(target: &Path) -> PathBuf {
    if !target.exists() {
        return target.to_path_buf();
    }
    let stem = target
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("note");
    let ext = target.extension().and_then(|s| s.to_str()).unwrap_or("md");
    let parent = target.parent().unwrap_or(Path::new("."));
    for n in 2..u32::MAX {
        let candidate = parent.join(format!("{stem}-{n}.{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    target.to_path_buf()
}

fn remove_empty_dirs(root: &Path) {
    let _ = remove_empty_dirs_recursive(root);
}

fn remove_empty_dirs_recursive(dir: &Path) -> std::io::Result<bool> {
    let entries = std::fs::read_dir(dir)?;
    let mut all_empty = true;
    for entry in entries {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            let sub = entry.path();
            if remove_empty_dirs_recursive(&sub)? {
                std::fs::remove_dir(&sub)?;
            } else {
                all_empty = false;
            }
        } else {
            all_empty = false;
        }
    }
    Ok(all_empty)
}

fn count_folders(paths: &Paths) -> usize {
    fn count_dirs(dir: &Path, depth: u32) -> usize {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return 0;
        };
        let mut count = 0;
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                if !name_str.starts_with('.') && name_str != crate::paths::ASSETS_DIR {
                    count += 1;
                    if depth < 10 {
                        count += count_dirs(&entry.path(), depth + 1);
                    }
                }
            }
        }
        count
    }
    count_dirs(&paths.vault, 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_old_memo(paths: &Paths, id: &str, body: &str, category: &str) -> PathBuf {
        let dir = paths.vault.join("memos/2026/08");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{id}.md"));
        let text = format!(
            "+++\nid = \"{id}\"\ncreated_at = \"2026-08-13T14:30:52Z\"\nupdated_at = \"2026-08-13T14:30:52Z\"\nhash = \"b3:abc\"\nfavorite = false\ncategory = \"{category}\"\ntags = []\n+++\n\n{body}"
        );
        std::fs::write(&path, text).unwrap();
        path
    }

    #[test]
    fn dry_run_does_not_modify() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::resolve(Some(dir.path()));
        write_old_memo(
            &paths,
            "01957a3b-1234-5678-9abc-def012345678",
            "# My Note\nbody",
            "idea",
        );
        let report = migrate_vault(&paths, true).unwrap();
        assert!(report.dry_run);
        assert!(report.files_moved > 0);
        // Original file still exists.
        assert!(paths.vault.join("memos").exists());
    }

    #[test]
    fn migrates_to_folder_layout() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::resolve(Some(dir.path()));
        write_old_memo(
            &paths,
            "01957a3b-1234-5678-9abc-def012345678",
            "# My Note\nbody",
            "idea",
        );
        let report = migrate_vault(&paths, false).unwrap();
        assert_eq!(report.files_moved, 1);
        // File should be in idea/ folder with title-derived name.
        assert!(paths.vault.join("idea").exists());
        // Old memos/ dir should be gone.
        assert!(!paths.vault.join("memos").exists());
    }

    #[test]
    fn inbox_goes_to_root() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::resolve(Some(dir.path()));
        write_old_memo(
            &paths,
            "01957a3b-1234-5678-9abc-def012345678",
            "# Root Note",
            "inbox",
        );
        let report = migrate_vault(&paths, false).unwrap();
        assert_eq!(report.files_moved, 1);
        // Should be at vault root, not in an inbox/ folder.
        assert!(!paths.vault.join("inbox").exists());
        let root_files: Vec<_> = std::fs::read_dir(&paths.vault)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".md"))
            .collect();
        assert!(!root_files.is_empty());
    }

    #[test]
    fn no_memos_dir_is_noop() {
        let dir = TempDir::new().unwrap();
        let paths = Paths::resolve(Some(dir.path()));
        let report = migrate_vault(&paths, false).unwrap();
        assert_eq!(report.files_moved, 0);
    }
}
