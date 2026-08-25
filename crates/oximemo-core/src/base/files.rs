//! Guarded file CRUD for `.query` base documents (spec §3).
//!
//! Every path the engine touches is validated against the vault root:
//! traversal, absolute paths, non-`.query` extensions, and reserved /
//! hidden directories are rejected before any read, write, or move. The
//! CRUD layer is split out from the model layer so the model stays
//! under the line budget — the public module path remains `crate::base`
//! for Tasks 9/12/13.
//!
//! Concurrency: the mtime cache is guarded by a `parking_lot::RwLock`
//! shared with the rest of the [`crate::vault::Vault`] facade; see
//! the [`Vault`](crate::vault::Vault) methods for the runtime entry
//! points. This file is private — callers go through the Vault.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::base::{parse_base, validate, BaseDef};
use crate::error::{CoreError, Result};
use crate::paths::{
    ASSETS_DIR, QUERY_EXT, SCHEMA_NAME, TEMPLATE_HTML_NAME, TEMPLATE_NAME, TRASH_DIR,
    TRASH_QUERIES_DIR,
};

/// Information about one discovered `.query` file.
#[derive(Debug, Clone, serde::Serialize)]
pub struct BaseInfo {
    /// Vault-relative path using forward slashes (e.g. `queries/all.query`).
    pub path: String,
    /// Filename stem without `.query` (e.g. `all`). Duplicate stems
    /// remain listed — spec §6 marks the ambiguity in the UI layer.
    pub name: String,
    /// File mtime at the moment `list_bases` walked past it.
    pub mtime: SystemTime,
    /// True if `parse_base(&raw)` succeeds on the file's contents. A
    /// non-loadable file is still listed so the user can find and edit
    /// it; it just won't appear in any view picker until repaired.
    pub loadable: bool,
}

/// Validate a vault-relative `.query` path and resolve its absolute
/// counterpart (joined to the vault root, not canonicalized yet).
///
/// Rejects empty / absolute / `..` paths, any path not ending in
/// `.query`, and any component starting with `.` or `_` (no
/// exceptions — `queries` itself never has a leading dot/underscore,
/// so a top-level `queries/<​name>.query` falls through naturally).
/// Symlink escape is detected by canonicalizing the parent directory
/// and comparing its prefix to the canonicalized vault root; the
/// parent lookup uses `exists()` first so creating a fresh dir
/// doesn't fail.
///
/// This mirrors the spec §3 contract that every path command
/// canonicalizes the vault root + parent and rejects the failure
/// modes explicitly.
pub(crate) fn query_rel_path(rel: &str, vault_root: &Path) -> Result<PathBuf> {
    if rel.is_empty() {
        return Err(CoreError::other("invalid query path: empty"));
    }
    if Path::new(rel).is_absolute() {
        return Err(CoreError::other(format!(
            "invalid query path: absolute path '{rel}'"
        )));
    }
    // Reject `..` anywhere — both as a whole component and as a segment.
    for component in Path::new(rel).components() {
        let s = component.as_os_str().to_string_lossy();
        if s == ".." || s.contains("..") {
            return Err(CoreError::other(format!(
                "invalid query path: traversal segment in '{rel}'"
            )));
        }
    }
    if Path::new(rel)
        .extension()
        .and_then(|e| e.to_str())
        != Some(QUERY_EXT)
    {
        return Err(CoreError::other(format!(
            "invalid query path: extension must be '{QUERY_EXT}' (got '{rel}')"
        )));
    }
    // Reject reserved / hidden directory components at every level.
    let rel_path = Path::new(rel);
    let comps: Vec<String> = rel_path
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect();
    for c in &comps {
        if c == TRASH_DIR || c == ASSETS_DIR || c == TRASH_QUERIES_DIR {
            return Err(CoreError::other(format!(
                "invalid query path: '{c}' is reserved"
            )));
        }
        if c.starts_with('.') || c.starts_with('_') {
            return Err(CoreError::other(format!(
                "invalid query path: hidden/reserved component '{c}'"
            )));
        }
        let lc = c.to_ascii_lowercase();
        if lc == TEMPLATE_NAME.to_ascii_lowercase()
            || lc == TEMPLATE_HTML_NAME.to_ascii_lowercase()
            || lc == SCHEMA_NAME.to_ascii_lowercase()
        {
            return Err(CoreError::other(format!(
                "invalid query path: '{c}' is reserved"
            )));
        }
    }
    let abs = vault_root.join(rel);
    // Symlink-escape check: canonicalize the parent (creating it if
    // needed would defeat this — instead check if it exists; if not,
    // there's nothing to escape yet and the caller's write will
    // create the dir canonically). When the parent exists, its
    // canonicalize() must be a strict prefix of vault_root's
    // canonicalize(). Mirrors the pattern in [`crate::vault::move_note`].
    if let Some(parent) = abs.parent()
        && parent.exists()
    {
        let canon_parent = match parent.canonicalize() {
            Ok(p) => p,
            Err(e) => {
                return Err(CoreError::other(format!(
                    "invalid query path: cannot canonicalize '{rel}': {e}"
                )));
            }
        };
        let canon_root = match vault_root.canonicalize() {
            Ok(p) => p,
            Err(e) => {
                return Err(CoreError::other(format!(
                    "invalid query path: vault root uncanonicalizable: {e}"
                )));
            }
        };
        if !canon_parent.starts_with(&canon_root)
            || (canon_parent == canon_root && rel.contains('/'))
        {
            return Err(CoreError::other(format!(
                "invalid query path: escapes vault root"
            )));
        }
    }
    Ok(abs)
}

/// Atomically replace `path` with `bytes`. Writes to a sibling temp
/// file in the same directory (so the temp + target share a filesystem
/// and the rename is atomic), fsyncs the bytes, then renames over the
/// target. Any pre-existing target is replaced; failed writes leave
/// the temp file behind for cleanup on the next save.
pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let parent = path.parent().ok_or_else(|| {
        CoreError::other("invalid query path: no parent directory")
    })?;
    let filename = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| CoreError::other("invalid query path: missing filename"))?;
    let mut tmp = parent.to_path_buf();
    let pid = std::process::id();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    tmp.push(format!(".{filename}.{pid}.{nanos}.tmp"));
    std::fs::write(&tmp, bytes)?;
    let f = std::fs::File::open(&tmp)?;
    f.sync_all()?;
    std::fs::rename(&tmp, path)?;
    if let Some(d) = path.parent() {
        // Best-effort durability on the parent directory.
        let _ = crate::store::files::fsync_dir(d);
    }
    Ok(())
}

/// Recursive `walkdir`-style scan that prunes reserved and hidden
/// directories (spec §3 `list_bases`): `.trash`, `_assets`, and any
/// component starting with `.` or `_` are skipped at every level. The
/// caller filters to `.query` files. Returns relative POSIX paths.
pub(crate) fn list_query_files(root: &Path) -> Vec<(String, SystemTime)> {
    fn visit(
        dir: &Path,
        prefix: &str,
        out: &mut Vec<(String, SystemTime)>,
    ) {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let file_type = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            let name = entry.file_name();
            let name_str = name.to_string_lossy().to_string();
            if name_str.starts_with('.') || name_str.starts_with('_') {
                continue;
            }
            let child_rel = if prefix.is_empty() {
                name_str.clone()
            } else {
                format!("{prefix}/{name_str}")
            };
            let path = entry.path();
            if file_type.is_dir() {
                visit(&path, &child_rel, out);
            } else if file_type.is_file()
                && Path::new(&name_str).extension().and_then(|e| e.to_str())
                    == Some(QUERY_EXT)
            {
                let mtime = std::fs::metadata(&path)
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .unwrap_or_else(|| UNIX_EPOCH - Duration::from_secs(1));
                out.push((child_rel, mtime));
            }
        }
    }
    let mut out = Vec::new();
    if !root.is_dir() {
        return out;
    }
    visit(root, "", &mut out);
    out
}

/// Parse + model-validate a `.query` document, propagating any error
/// (including [`CoreError::Expr`] with line/col). Used by
/// [`crate::vault::Vault::save_base`] to enforce the brief rule:
/// "never persist a file that won't load".
pub(crate) fn parse_validate(yaml: &str) -> Result<BaseDef> {
    let def = parse_base(yaml)?;
    validate(&def)?;
    Ok(def)
}
