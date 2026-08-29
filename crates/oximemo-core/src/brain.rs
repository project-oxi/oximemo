//! Documents-plane glue between oximemo's vault and the oxibrain 0.10+
//! caller-owned model (spec 2026-08-29 brain 0.10 cutover, §2).
//!
//! The brain has no resident process: every interaction spawns
//! `oxibrain admin serve --stdio` as a short-lived child (desktop side),
//! and vault ingestion is a reconcile of `~/.oxi/brain/documents.toml`
//! roots. This module owns the two filesystem operations that never
//! need a live brain:
//!
//! - [`ensure_document_root`] — idempotently guarantees a `[[root]]`
//!   entry whose `path` is exactly the active vault. This is one of the
//!   two sanctioned oximemo writes into `~/.oxi/brain/` (the other is
//!   the one-time flat-root rewrite in `migrate_spaces`). Operator
//!   configuration is never clobbered: an existing root for the same
//!   path is left byte-identical, and an unparseable file is never
//!   touched.
//! - [`vault_space_name`] — the space identity, derived from the vault
//!   directory basename (amended spaces spec §2). There is no
//!   configured space anywhere in oximemo anymore.
//!
//! Failure posture (ECOSYSTEM C1): every path here either succeeds
//! quietly or logs and returns without blocking `Vault::open`. The
//! brain is additive; a missing/uninstalled oxibrain is a normal state.

#[cfg(test)]
use std::cell::RefCell;
use std::path::{Path, PathBuf};

#[cfg(test)]
thread_local! {
    /// Per-thread brain-dir override for tests, mirroring the retired
    /// recorder pattern: without an installed override, the documents
    /// glue is a no-op so unrelated tests never touch the developer's
    /// real `~/.oxi/brain/documents.toml`.
    static TEST_BRAIN_DIR: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn with_test_brain_dir<R>(dir: &Path, f: impl FnOnce() -> R) -> R {
    let _ = TEST_BRAIN_DIR.try_with(|cell| *cell.borrow_mut() = Some(dir.to_path_buf()));
    let out = f();
    let _ = TEST_BRAIN_DIR.try_with(|cell| *cell.borrow_mut() = None);
    out
}

/// Under `cfg(test)` with no override installed, the documents glue is
/// a no-op (the old `NoopBrainRegistrar` contract). Production is
/// always active.
fn test_brain_gate_active() -> bool {
    #[cfg(test)]
    return TEST_BRAIN_DIR
        .try_with(|cell| cell.borrow().is_some())
        .unwrap_or(false);
    #[cfg(not(test))]
    true
}

/// `~/.oxi/brain` — the oxibrain data plane. Caller-owned stdio children
/// are pointed here with `--dir`; `documents.toml` lives inside. Empty
/// `HOME` degrades to a relative `.oxi/brain` (tests override the whole
/// dir via [`with_test_brain_dir`]).
pub fn brain_dir() -> PathBuf {
    #[cfg(test)]
    if let Some(dir) = TEST_BRAIN_DIR
        .try_with(|cell| cell.borrow().clone())
        .ok()
        .flatten()
    {
        return dir;
    }
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".oxi").join("brain")
}

/// The space name for a vault: its directory basename, or `"personal"`
/// when the path has no usable final component (root path, empty).
pub fn vault_space_name(vault: &Path) -> String {
    vault
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("personal")
        .to_string()
}

/// Outcome of [`ensure_document_root`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnsureOutcome {
    /// The root entry was appended (file created or extended).
    Added,
    /// A root with exactly this `path` already existed — nothing written.
    Present,
    /// `documents.toml` exists but does not parse (or the write failed)
    /// — left untouched.
    SkippedInvalid,
}

/// One `[[root]]` entry of oxibrain's canonical `documents.toml`
/// (alias, path, space are mandatory; include/exclude/max_file_bytes are
/// optional and never written by oximemo — server defaults apply).
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
struct DocumentRoot {
    alias: String,
    path: String,
    space: String,
}

#[derive(Debug, Default, serde::Deserialize, serde::Serialize)]
#[serde(default)]
struct DocumentsFile {
    #[serde(rename = "root")]
    roots: Vec<DocumentRoot>,
}

/// Guarantee that `documents.toml` carries a root whose `path` is
/// exactly `vault`. Idempotent by filesystem check — repeated opens are
/// no-ops without any memoization. Never blocks: I/O errors are logged
/// and reported as `SkippedInvalid` rather than propagated (the vault
/// must open even when the brain dir is unwritable).
pub fn ensure_document_root(vault: &Path, space: &str) -> EnsureOutcome {
    if !test_brain_gate_active() {
        return EnsureOutcome::Present;
    }
    let file = brain_dir().join("documents.toml");
    let mut doc = match std::fs::read_to_string(&file) {
        Err(_) => DocumentsFile::default(),
        Ok(text) => match toml::from_str::<DocumentsFile>(&text) {
            Ok(d) => d,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    path = %file.display(),
                    "brain: documents.toml unparseable; leaving untouched"
                );
                return EnsureOutcome::SkippedInvalid;
            }
        },
    };
    if doc.roots.iter().any(|r| Path::new(&r.path) == vault) {
        return EnsureOutcome::Present;
    }
    doc.roots.push(DocumentRoot {
        alias: space.to_string(),
        path: vault.to_string_lossy().into_owned(),
        space: space.to_string(),
    });
    let body = match toml::to_string_pretty(&doc) {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!(error = %e, "brain: documents.toml serialize failed");
            return EnsureOutcome::SkippedInvalid;
        }
    };
    if let Some(parent) = file.parent()
        && let Err(e) = std::fs::create_dir_all(parent)
    {
        tracing::warn!(error = %e, path = %parent.display(), "brain: cannot create brain dir");
        return EnsureOutcome::SkippedInvalid;
    }
    let tmp = file.with_extension("toml.oximemo-tmp");
    if let Err(e) = std::fs::write(&tmp, &body).and_then(|_| std::fs::rename(&tmp, &file)) {
        tracing::warn!(error = %e, path = %file.display(), "brain: documents.toml write failed");
        return EnsureOutcome::SkippedInvalid;
    }
    EnsureOutcome::Added
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed_documents(home: &Path, text: &str) -> PathBuf {
        let brain = home.join(".oxi").join("brain");
        std::fs::create_dir_all(&brain).unwrap();
        let file = brain.join("documents.toml");
        std::fs::write(&file, text).unwrap();
        file
    }

    #[test]
    fn no_override_is_a_noop() {
        // Without `with_test_brain_dir`, cfg(test) builds must never
        // touch the real brain dir (NoopBrainRegistrar contract).
        let vault = std::env::temp_dir().join("oximemo-noop-ensure-check");
        std::fs::create_dir_all(&vault).unwrap();
        assert_eq!(
            ensure_document_root(&vault, "personal"),
            EnsureOutcome::Present
        );
    }
    #[test]
    fn absent_documents_toml_is_created_with_one_root() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_path_buf();
        let vault = home.join(".oxi/vault/personal");
        let brain = home.join(".oxi/brain");
        std::fs::create_dir_all(&vault).unwrap();
        let doc = brain.join("documents.toml");
        with_test_brain_dir(&brain, || {
            assert_eq!(
                ensure_document_root(&vault, "personal"),
                EnsureOutcome::Added
            );
            let text = std::fs::read_to_string(&doc).unwrap();
            assert!(
                text.contains(&format!("path = \"{}\"", vault.display())),
                "text: {text}"
            );
            assert!(text.contains("space = \"personal\""));
            assert!(text.contains("alias = \"personal\""));
        });
    }

    #[test]
    fn exact_path_root_is_present_without_rewrite() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_path_buf();
        let vault = home.join(".oxi/vault/work");
        std::fs::create_dir_all(&vault).unwrap();
        let body = format!(
            "[[root]]\nalias = \"work\"\npath = \"{}\"\nspace = \"work\"\n",
            vault.display()
        );
        let file = seed_documents(&home, &body);
        let before = std::fs::read(&file).unwrap();
        with_test_brain_dir(&home.join(".oxi/brain"), || {
            assert_eq!(ensure_document_root(&vault, "work"), EnsureOutcome::Present);
        });
        assert_eq!(
            std::fs::read(&file).unwrap(),
            before,
            "no rewrite on Present"
        );
    }

    #[test]
    fn same_path_different_alias_space_is_present() {
        // Operator owns alias/space/include for an existing exact-path
        // root; oximemo never clobbers it even when the values differ
        // from what it would have written.
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_path_buf();
        let vault = home.join(".oxi/vault/work");
        std::fs::create_dir_all(&vault).unwrap();
        let body = format!(
            "[[root]]\nalias = \"custom-alias\"\npath = \"{}\"\nspace = \"elsewhere\"\ninclude = [\"**/*.md\"]\n",
            vault.display()
        );
        let file = seed_documents(&home, &body);
        let before = std::fs::read(&file).unwrap();
        with_test_brain_dir(&home.join(".oxi/brain"), || {
            assert_eq!(ensure_document_root(&vault, "work"), EnsureOutcome::Present);
        });
        assert_eq!(std::fs::read(&file).unwrap(), before);
    }

    #[test]
    fn invalid_toml_is_never_touched() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_path_buf();
        let vault = home.join(".oxi/vault/personal");
        std::fs::create_dir_all(&vault).unwrap();
        let file = seed_documents(&home, "not [ valid toml");
        let before = std::fs::read(&file).unwrap();
        with_test_brain_dir(&home.join(".oxi/brain"), || {
            assert_eq!(
                ensure_document_root(&vault, "personal"),
                EnsureOutcome::SkippedInvalid
            );
        });
        assert_eq!(std::fs::read(&file).unwrap(), before);
    }

    #[test]
    fn additional_roots_preserved_when_appending() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_path_buf();
        let vault = home.join(".oxi/vault/personal");
        let other = home.join("some/other/root");
        std::fs::create_dir_all(&vault).unwrap();
        let body = format!(
            "[[root]]\nalias = \"ext\"\npath = \"{}\"\nspace = \"ext\"\n",
            other.display()
        );
        seed_documents(&home, &body);
        with_test_brain_dir(&home.join(".oxi/brain"), || {
            assert_eq!(
                ensure_document_root(&vault, "personal"),
                EnsureOutcome::Added
            );
            let text = std::fs::read_to_string(home.join(".oxi/brain/documents.toml")).unwrap();
            assert!(
                text.contains("alias = \"ext\""),
                "existing root kept: {text}"
            );
            assert!(text.contains(&format!("path = \"{}\"", vault.display())));
        });
    }

    #[test]
    fn vault_space_name_uses_basename_or_personal() {
        assert_eq!(vault_space_name(Path::new("/tmp/x/work")), "work");
        assert_eq!(vault_space_name(Path::new("work")), "work");
        assert_eq!(vault_space_name(Path::new("/")), "personal");
        assert_eq!(vault_space_name(Path::new("")), "personal");
    }

    #[test]
    fn stale_brain_config_keys_parse_and_ignore() {
        // socket/space are retired keys; serde(default) + no
        // deny_unknown_fields keeps old oximemo.toml files loading.
        let t = "[brain]\nenabled = true\nsocket = \"/old.sock\"\nspace = \"work\"\n";
        #[derive(serde::Deserialize, Default)]
        #[serde(default)]
        struct Brain {
            enabled: bool,
            executable: String,
        }
        #[derive(serde::Deserialize, Default)]
        #[serde(default)]
        struct Root {
            brain: Brain,
        }
        let r: Root = toml::from_str(t).unwrap();
        assert!(r.brain.enabled);
        assert_eq!(r.brain.executable, "");
    }
}
