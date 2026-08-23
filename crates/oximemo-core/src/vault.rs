//! The [`Vault`] facade: the single entry point both the CLI and the Tauri app
//! use. It coordinates the file store (source of truth) with the derived redb +
//! tantivy indexes, guarded by a cross-process advisory lock (§5.7).
//!
//! # Concurrency model
//! redb guarantees a single in-process writer but nothing across processes.
//! We bracket every operation with an `fs2` flock on `meta.redb.lock`:
//! - **shared** for reads (multiple readers, including a CLI reading while the
//!   GUI runs),
//! - **exclusive** for writes.
//!
//! redb and tantivy are opened *transiently* within the lock scope, so no
//! process holds them open across the boundary — two processes never collide on
//! redb's or tantivy's own single-writer locks. This keeps the agent path
//! (`oximemo …` while the GUI is running) correct.

use std::path::{Path, PathBuf};
use std::time::Duration;

use time::OffsetDateTime;

use parking_lot::RwLock;

use oxi_frontmatter::{Mutation, Synthesize, WriteOutcome, write_document};

use crate::config::VaultConfig;
use crate::error::{CoreError, Result};
use crate::hash;
use crate::lock::{FileLock, LockKind, acquire};
use crate::memo::{
    Cursor, Facets, IndexStats, Memo, MemoFilter, MemoHash, MemoId, MemoSummary, Page, note_title,
    preview_of, searchable_body, tags_of,
};
use crate::paths::Paths;
use crate::store::files::{FileStore, ParsedFile, to_crate_fmt};
use crate::store::index::{IndexRecord, MemoIndex, RedbIndex};
use crate::store::search::{SearchIndex, TantivySearch};
use crate::sync::{FullRecord, ManifestRecord};

/// How long to wait for the cross-process index lock before timing out (§5.7).
const LOCK_TIMEOUT: Duration = Duration::from_secs(5);

/// Indexed preview format version. Bump when `make_preview`'s output changes;
/// [`Vault::migrate`] reindexes once per bump so cached card previews are
/// regenerated. Stored in `<index_dir>/index-fmt`.
const INDEX_FORMAT_VERSION: u32 = 4;

/// Lifecycle status of an opened vault.
///
/// [`Vault::open`] runs the one-time default-vault migration
/// (see [`crate::migrate_vault`]) before resolving paths; when both the
/// pre-unification default vault and the new `~/.oxi/vault` exist, the
/// vault still opens (pointing at the new location) but carries this
/// status so GUI/CLI can demand a manual merge instead of silently
/// dropping either side.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VaultStatus {
    /// Vault opened normally.
    Ok,
    /// Both the old and the new default vault exist; their contents
    /// must be merged by hand. Surfaced through [`Vault::status`],
    /// `doctor` (`merge_required`), and a startup warning log.
    MergeRequired {
        /// Pre-unification default vault (source).
        old: PathBuf,
        /// Shared ecosystem vault (target).
        new: PathBuf,
    },
}

pub struct Vault {
    paths: Paths,
    status: VaultStatus,
    config: RwLock<VaultConfig>,
    files: FileStore,
    /// Folder-schema cache keyed by folder path: `(mtime, schema)`. The
    /// SCHEMA.toml files are not watcher targets, so the mtime is checked
    /// on every lookup (design 2026-08-23 §6.2).
    schemas: RwLock<std::collections::HashMap<String, (std::time::SystemTime, Option<crate::schema::FolderSchema>)>>,
}

impl Vault {
    /// Resolve a vault (default location when `vault` is `None`) and load its
    /// config. Does not create directories — call [`Self::ensure_initialized`]
    /// for that. For the default vault this first runs the one-time
    /// migration to `~/.oxi/vault` (see [`crate::migrate_vault`]).
    pub fn open(vault: Option<&Path>) -> Result<Self> {
        let mut status = VaultStatus::Ok;
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        if vault.is_none() {
            match crate::migrate_vault::maybe_migrate(home.as_ref())? {
                crate::migrate_vault::MigrationStatus::MergeRequired { old, new } => {
                    tracing::warn!(
                        old = %old.display(),
                        new = %new.display(),
                        "both the pre-unification default vault and ~/.oxi/vault exist; \
                         merge them by hand (see `oximemo doctor`)"
                    );
                    status = VaultStatus::MergeRequired { old, new };
                }
                crate::migrate_vault::MigrationStatus::Migrated { converted } => {
                    tracing::info!(
                        converted,
                        "migrated default vault to ~/.oxi/vault (v3 notes converted to v4)"
                    );
                }
                _ => {}
            }
        }
        let paths = Paths::resolve(vault);
        let config = VaultConfig::load(&paths);
        // Detached brain registration: ecosystem `[vault].space` wins over
        // the vault-local `brain.space`; the daemon call (sync_run) is
        // fire-and-forget so open never blocks on a missing daemon.
        if config.brain.enabled {
            let space =
                crate::brain::resolve_space(std::path::Path::new(&home), &config.brain.space);
            crate::brain::register_vault(&paths.vault, &space, &config.brain.socket);
        }
        let files = FileStore::new(paths.clone());
        Ok(Self {
            paths,
            status,
            config: RwLock::new(config),
            files,
            schemas: RwLock::new(Default::default()),
        })
    }

    /// Lifecycle status of the opened vault (e.g. a pending
    /// both-exists merge from the default-vault migration).
    pub fn status(&self) -> &VaultStatus {
        &self.status
    }

    /// Read config under a read guard.
    pub fn with_config<R>(&self, f: impl FnOnce(&VaultConfig) -> R) -> R {
        f(&self.config.read())
    }

    /// Snapshot of the current folder list (cloned under the read guard).
    pub fn folders(&self) -> Vec<crate::config::FolderDef> {
        self.config.read().folders.items.clone()
    }

    /// Create a physical folder (mkdir -p). Returns an error when the
    /// target directory already exists — the UI's optimistic
    /// folder-create flow would otherwise attach a naming session to a
    /// pre-existing folder and Esc/empty-commit would trash whatever
    /// notes lived there. The companion UI guard (auto-suffix with ` 2`,
    /// ` 3`, …) is advisory; this guard is authoritative.
    pub fn create_folder(&self, path: &str) -> Result<()> {
        let dir = if path.is_empty() {
            self.paths.vault.clone()
        } else {
            self.paths.vault.join(path)
        };
        if dir.exists() {
            return Err(CoreError::other(format!("folder '{path}' already exists")));
        }
        std::fs::create_dir_all(&dir)?;
        Ok(())
    }

    /// The folder's property schema, mtime-cached (design §6.2). `None`
    /// for schema-less folders (free-property mode). A SCHEMA.toml that
    /// fails to parse is a hard error — a silently ignored schema would
    /// corrupt transition bookkeeping.
    pub fn folder_schema(&self, folder: &str) -> Result<Option<crate::schema::FolderSchema>> {
        let folder_norm = folder.trim_end_matches('/').to_string();
        let path = if folder_norm.is_empty() {
            self.paths.vault.join(crate::paths::SCHEMA_NAME)
        } else {
            self.paths.vault.join(&folder_norm).join(crate::paths::SCHEMA_NAME)
        };
        let mtime = std::fs::metadata(&path)
            .ok()
            .and_then(|m| m.modified().ok())
            .unwrap_or(std::time::UNIX_EPOCH - std::time::Duration::from_secs(1));
        {
            let cache = self.schemas.read();
            if let Some((cached_mtime, cached)) = cache.get(&folder_norm)
                && *cached_mtime == mtime
            {
                return Ok(cached.clone());
            }
        }
        let schema = if mtime < std::time::UNIX_EPOCH {
            None
        } else {
            crate::schema::read_schema(&self.paths.vault, &folder_norm)?
        };
        self.schemas
            .write()
            .insert(folder_norm, (mtime, schema.clone()));
        Ok(schema)
    }

    /// Install the knowledge preset (design §6.3) into `folder`.
    /// Delegates to [`Self::apply_preset`]; public for the IPC surface
    /// (`apply_knowledge_preset`) and tests.
    pub fn apply_knowledge_preset(&self, folder: &str) -> Result<()> {
        self.apply_preset(
            folder,
            crate::schema::KNOWLEDGE_TEMPLATE_MD,
            crate::schema::KNOWLEDGE_SCHEMA_TOML,
        )
    }

    /// Install a collection preset (spec 2026-08-23 §2) by id into
    /// `folder`: creates the folder and applies TEMPLATE.md/SCHEMA.toml
    /// with skip-if-exists semantics. Unlike the default folders,
    /// installed collections are user-owned — deleting them is
    /// permanent (no recreate-on-migrate).
    pub fn install_collection(&self, preset_id: &str, folder: &str) -> Result<()> {
        let (template, schema) = crate::schema::collection_preset(preset_id).ok_or_else(
            || CoreError::other(format!("unknown collection preset: {preset_id}")),
        )?;
        self.apply_preset(folder, template, schema)
    }

    /// Install a folder preset: `TEMPLATE.md` (initial properties) and
    /// `SCHEMA.toml` (rules). Plain files the user may edit or delete
    /// freely; existing files are never overwritten (system-folder
    /// semantics — deleting the folder and restarting recreates the
    /// preset, user edits survive).
    fn apply_preset(&self, folder: &str, template_md: &str, schema_toml: &str) -> Result<()> {
        let folder = folder.trim_end_matches('/');
        let dir = if folder.is_empty() {
            self.paths.vault.clone()
        } else {
            self.paths.vault.join(folder)
        };
        std::fs::create_dir_all(&dir)?;
        let tmpl = dir.join(crate::paths::TEMPLATE_NAME);
        if !tmpl.exists() {
            oxi_frontmatter::atomic_write(&tmpl, template_md.as_bytes())?;
        }
        let schema = dir.join(crate::paths::SCHEMA_NAME);
        if !schema.exists() {
            oxi_frontmatter::atomic_write(&schema, schema_toml.as_bytes())?;
        }
        self.schemas.write().clear();
        Ok(())
    }

    /// Delete a folder: every live note under it goes to trash
    /// (structure-preserving, via `delete_memo`), then the remaining
    /// tree (templates, empty dirs) is removed. Returns the trashed
    /// ids so the UI can offer undo via [`Self::restore_notes`].
    ///
    /// `.trash/<path>/` is intentionally retained afterwards — that is
    /// the undo data. The trash-collision guard in [`Self::rename_folder`]
    /// exists precisely because of this residue: renaming another folder
    /// onto this path must fail fast while those tombstones are parked.
    pub fn delete_folder(&self, path: &str) -> Result<Vec<MemoId>> {
        if path.is_empty() {
            return Err(CoreError::other("cannot delete vault root"));
        }
        let prefix = format!("{path}/");
        let recs = self.with_redb(|idx| idx.export_since(None))?;
        let ids: Vec<MemoId> = recs
            .iter()
            .filter(|r| !r.deleted && r.path.starts_with(&prefix))
            .map(|r| r.id)
            .collect();
        for id in &ids {
            self.delete_memo(*id)?;
        }
        let dir = self.paths.vault.join(path);
        if dir.is_dir() {
            std::fs::remove_dir_all(&dir)?;
        }
        // Prune config FolderDef entries so the sidebar pin row and
        // any pinned subfolder view rows die with the folder. Without
        // this, a deleted pinned folder leaves a "ghost" sidebar row
        // pointing at a path that no longer exists. Mirrors the
        // re-path block in rename_folder above.
        {
            let mut cfg = self.config.write();
            let fp = format!("{path}/");
            cfg.folders
                .items
                .retain(|f| f.path != path && !f.path.starts_with(&fp));
            cfg.save(&self.paths)?;
        }
        Ok(ids)
    }

    /// Rename/move a folder tree. Disk rename first (atomic, preserves
    /// templates and subfolders), then index records under the old prefix
    /// are rewritten (best-effort; the watcher repairs any stragglers),
    /// then config folder entries are re-pathed.
    pub fn rename_folder(&self, from: &str, to: &str) -> Result<()> {
        if from.is_empty() {
            return Err(CoreError::other("cannot rename vault root"));
        }
        if to.is_empty() {
            return Err(CoreError::other("rename target must not be empty"));
        }
        if from == to {
            return Err(CoreError::other("rename target is the same as source"));
        }
        let from_dir = self.paths.vault.join(from);
        let to_dir = self.paths.vault.join(to);
        if !from_dir.is_dir() {
            return Err(CoreError::NotFound(from.to_string()));
        }
        if to_dir.exists() {
            return Err(CoreError::other(format!("folder '{to}' already exists")));
        }
        // Fail-fast guard for the matching trash subtree: a previous
        // `delete_folder` of a folder that lived at `to` would leave any
        // trashed notes behind under `.trash/<to>/`; renaming a folder
        // over that name would have the live-tree rename succeed but the
        // trash-tree rename fail with ENOTEMPTY — unretryable state because
        // the live tree already moved. Detect the collision before any
        // fs mutation. Empty trash dirs are not a collision (POSIX
        // rename(2) atomically replaces an empty destination); only
        // non-empty ones are. Silently allowed when the trash subtree is
        // absent or empty.
        let trash_from = self.paths.trash_path(from);
        let trash_to = self.paths.trash_path(to);
        if trash_from.is_dir() && trash_to_is_nonempty(&trash_to) {
            return Err(CoreError::other(format!(
                "trashed notes under '{to}' already exist"
            )));
        }
        if let Some(parent) = to_dir.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::rename(&from_dir, &to_dir)?;

        // Move the matching `.trash/<from>/` subtree to `.trash/<to>/` so
        // tombstone files stay aligned with their re-pathed index records.
        // Without this, restore_memo finds no trash file at the new path
        // and silently no-ops, leaking the old `.trash/<from>/...` copy
        // until purge deletes the (possibly restored+live) note's
        // index/search records; reindex would also revert the re-path by
        // reading `.trash/<from>/` and rebuilding records at the old path.
        // The trash subtree is optional — many folders have no trashed
        // notes — so the move is a silent no-op when the source is absent.
        if trash_from.is_dir() {
            if let Some(parent) = trash_to.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::rename(&trash_from, &trash_to)?;
        }

        // Re-path index records under `from/`. Live notes: read the file
        // at its new on-disk location and re-upsert the record + search
        // entry so the search index keeps the up-to-date body and title.
        // Tombstones (soft-deleted within retention): their trash files
        // were moved with the subtree above so the records now line up
        // again — the branch is record-only (no file read, no search
        // upsert); a tombstone must not reappear in search.
        let prefix = format!("{from}/");

        let recs = self.with_redb(|idx| idx.export_since(None))?;
        let mut index_failures: u32 = 0;
        for r in recs {
            if !r.path.starts_with(&prefix) {
                continue;
            }
            let new_rel = format!("{to}/{}", &r.path[prefix.len()..]);
            if r.deleted {
                let mut rec2 = r.clone();
                rec2.path = new_rel;
                if self.with_redb(|idx| idx.upsert(&rec2)).is_err() {
                    index_failures += 1;
                }
                continue;
            }
            let stripped = &r.path[prefix.len()..];
            match self.files.read_memo(&to_dir.join(stripped)) {
                Ok(Some(note)) => {
                    let fmt = crate::memo::NoteFormat::from_rel(&new_rel);
                    let (sbody, stitle, saliases) = search_fields(fmt, &note);
                    let mut rec2 = r.clone();
                    rec2.path = new_rel;
                    if self
                        .with_redb_and_search(|idx, search| {
                            idx.upsert(&rec2)?;
                            search.upsert(note.id, &sbody, stitle.as_deref(), &note.tags, &saliases)
                        })
                        .is_err()
                    {
                        index_failures += 1;
                    }
                }
                _ => {
                    index_failures += 1;
                }
            }
        }

        // Re-path config entries under `from/`. Exact match on `from` keeps
        // the same `FolderDef` (preserving view/color/pin); prefix matches
        // are rewritten by stripping and re-attaching the new prefix.
        {
            let mut cfg = self.config.write();
            let fp = format!("{from}/");
            for f in cfg.folders.items.iter_mut() {
                if f.path == from {
                    f.path = to.to_string();
                } else if f.path.starts_with(&fp) {
                    f.path = format!("{to}/{}", &f.path[fp.len()..]);
                }
            }
            cfg.save(&self.paths)?;
        }

        if index_failures > 0 {
            return Err(CoreError::other(format!(
                "folder renamed on disk but {index_failures} index entries need reindex"
            )));
        }
        Ok(())
    }

    /// Move a folder (with its whole subtree) into `dest` ("" = vault
    /// top level). Finder-semantics wrapper over `rename_folder`: the
    /// folder keeps its basename at the new location. Guards: moving
    /// into itself or a descendant is a cycle; moving to the current
    /// parent is a silent no-op.
    pub fn move_folder(&self, path: &str, dest: &str) -> Result<()> {
        if path.is_empty() {
            return Err(CoreError::other("cannot move the vault root"));
        }
        if dest == path || dest.starts_with(&format!("{path}/")) {
            return Err(CoreError::other(format!(
                "cannot move '{path}' into itself"
            )));
        }
        let base = path.rsplit('/').next().unwrap_or(path);
        let to = if dest.is_empty() {
            base.to_string()
        } else {
            format!("{dest}/{base}")
        };
        if to == path {
            // Already lives at the destination (drop onto current
            // parent) — no-op, not an error.
            return Ok(());
        }
        self.rename_folder(path, &to)
    }

    /// List the folder tree as a flat list of `(path, note_count)`.
    ///
    /// Includes physical directories with zero notes (they exist on disk but
    /// no file row references them), so the UI can list and manage folders
    /// the user just created. The vault root itself is never an entry.
    pub fn list_folders(&self) -> Result<Vec<(String, u32)>> {
        let mut counts: std::collections::BTreeMap<String, u32> = Default::default();
        for path in self.files.scan() {
            if let Some(rel) = self.paths.relative_path(&path) {
                let folder = rel.rfind('/').map(|i| &rel[..i]).unwrap_or("");
                *counts.entry(folder.to_string()).or_insert(0) += 1;
            }
        }
        collect_folder_dirs(&self.paths.vault, "", &mut counts);
        Ok(counts.into_iter().collect())
    }

    /// Folder cards for one browse level: deep counts (reverse-sorted
    /// prefix summation over `list_folders`), direct subfolder counts, and
    /// up to 3 recent note titles attributed to the nearest displayed
    /// ancestor (index scan, early exit).
    pub fn folder_children(&self, parent: &str) -> Result<Vec<FolderCard>> {
        let all = self.list_folders()?; // BTree-sorted (path, immediate)
        let prefix = if parent.is_empty() {
            String::new()
        } else {
            format!("{parent}/")
        };
        let is_child =
            |p: &str| !p.is_empty() && p.starts_with(&prefix) && !p[prefix.len()..].contains('/');
        let kids: Vec<&String> = all.iter().map(|(p, _)| p).filter(|p| is_child(p)).collect();

        // Deep counts: reverse iteration guarantees children finalize first.
        let mut deep: std::collections::BTreeMap<String, u32> = all.iter().cloned().collect();
        for (p, _) in all.iter().rev() {
            if let Some(i) = p.rfind('/') {
                let d = deep[p];
                *deep.entry(p[..i].to_string()).or_insert(0) += d;
            }
        }

        let subfolder_count = |kid: &str| {
            let kp = format!("{kid}/");
            all.iter()
                .filter(|(p, _)| p.starts_with(&kp) && !p[kp.len()..].contains('/'))
                .count() as u32
        };

        // Recents from the newest-first index: walk each note's path up
        // until it lands on a kid, capping the per-kid sample at
        // min(3, its deep count) so empty / small folders finalize cleanly.
        let recs = self.with_redb(|idx| idx.export_since(None))?;
        let mut recent: Vec<(String, Vec<FolderRecent>)> =
            kids.iter().map(|k| ((*k).clone(), Vec::new())).collect();
        let target: Vec<usize> = kids
            .iter()
            .enumerate()
            .filter(|(_, k)| deep[k.as_str()] > 0)
            .map(|(i, _)| i)
            .collect();
        let mut done = 0usize;
        'scan: for r in recs.iter().filter(|r| !r.deleted) {
            if done == target.len() {
                break;
            }
            let mut probe = match r.path.rfind('/') {
                Some(i) => &r.path[..i],
                None => "",
            };
            loop {
                if let Some(slot) = recent.iter_mut().find(|(p, _)| p == probe) {
                    let cap = 3u32.min(deep[slot.0.as_str()]);
                    if (slot.1.len() as u32) < cap {
                        slot.1.push(FolderRecent {
                            id: r.id,
                            title: r.title.clone(),
                            updated_at: r.updated_at,
                        });
                        if slot.1.len() as u32 == cap {
                            done += 1;
                        }
                    }
                    continue 'scan;
                }
                match probe.rfind('/') {
                    Some(i) => probe = &probe[..i],
                    None => continue 'scan,
                }
            }
        }

        Ok(kids
            .iter()
            .map(|k| FolderCard {
                path: (*k).clone(),
                note_count: all
                    .iter()
                    .find(|(p, _)| p == *k)
                    .map(|(_, n)| *n)
                    .unwrap_or(0),
                note_count_deep: deep[k.as_str()],
                subfolder_count: subfolder_count(k),
                recent: recent
                    .iter()
                    .find(|(p, _)| p == *k)
                    .map(|(_, v)| v.clone())
                    .unwrap_or_default(),
            })
            .collect())
    }

    pub fn paths(&self) -> &Paths {
        &self.paths
    }

    /// Create the vault + index directories if missing.
    pub fn ensure_initialized(&self) -> Result<()> {
        std::fs::create_dir_all(&self.paths.vault)?;
        std::fs::create_dir_all(self.paths.trash_root())?;
        std::fs::create_dir_all(self.paths.assets_root())?;
        std::fs::create_dir_all(&self.paths.index_dir)?;
        Ok(())
    }

    // -- assets ----------------------------------------------------------

    /// Persist raw image bytes as a content-addressed asset and return the
    /// `oximg://` reference to drop into markdown. Identical bytes dedup to
    /// the same file (no rewrite). `ext` is normalized + whitelisted.
    pub fn save_asset(&self, bytes: &[u8], ext: &str) -> Result<crate::assets::AssetRef> {
        self.ensure_initialized()?;
        let ext = crate::assets::normalize_ext(ext)?;
        let name = crate::assets::asset_name(bytes, ext);
        let path = self.paths.asset_path(&name);
        if !path.exists() {
            // Atomic write like memo files: temp + rename.
            let tmp = path.with_extension("tmp");
            std::fs::write(&tmp, bytes)?;
            std::fs::rename(&tmp, &path)?;
        }
        Ok(crate::assets::AssetRef {
            url: format!("oximg://localhost/{name}"),
            name,
        })
    }

    /// Read an image from an arbitrary path (file-picker) and store it. The
    /// extension is taken from the source filename.
    pub fn save_asset_from_path(&self, src: &Path) -> Result<crate::assets::AssetRef> {
        let ext = src
            .extension()
            .and_then(|e| e.to_str())
            .ok_or_else(|| CoreError::AssetRejected("source has no extension".into()))?;
        let bytes = std::fs::read(src)?;
        self.save_asset(&bytes, ext)
    }

    /// Serve an asset's bytes + content-type for the `oximg://` handler.
    /// Returns `None` if the name is malformed or the file is absent.
    pub fn read_asset(&self, name: &str) -> Option<(Vec<u8>, &'static str)> {
        if !crate::assets::valid_name(name) {
            return None;
        }
        let ext = crate::assets::ext_of(name)?;
        let path = self.paths.asset_path(name);
        std::fs::read(&path)
            .ok()
            .map(|b| (b, crate::assets::mime_for_ext(ext)))
    }

    /// All assets on disk, newest-first (gallery). Cheap: a single dir read.
    pub fn list_assets(&self) -> Result<Vec<crate::assets::AssetInfo>> {
        use crate::assets::{AssetInfo, valid_name};
        let root = self.paths.assets_root();
        if !root.exists() {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        for entry in std::fs::read_dir(&root)? {
            let entry = entry?;
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if !valid_name(&name) {
                continue;
            }
            let meta = entry.metadata()?;
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| {
                    OffsetDateTime::from_unix_timestamp(d.as_secs() as i64)
                        .unwrap_or_else(|_| OffsetDateTime::now_utc())
                })
                .unwrap_or_else(OffsetDateTime::now_utc);
            let ext = crate::assets::ext_of(&name).unwrap_or("").to_string();
            out.push(AssetInfo {
                url: format!("oximg://localhost/{name}"),
                name,
                ext,
                bytes: meta.len(),
                modified,
            });
        }
        out.sort_by_key(|b| std::cmp::Reverse(b.modified));
        Ok(out)
    }

    /// Delete assets referenced by no live memo. Returns the count removed.
    /// Scans every memo body, so call from an explicit user action (gallery
    /// "clean up"), not a hot path.
    pub fn gc_assets(&self) -> Result<u64> {
        let live = self.asset_refs_in_bodies()?;
        let root = self.paths.assets_root();
        if !root.exists() {
            return Ok(0);
        }
        let mut removed = 0u64;
        for entry in std::fs::read_dir(&root)? {
            let entry = entry?;
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if !crate::assets::valid_name(&name) || live.contains(&name) {
                continue;
            }
            if std::fs::remove_file(entry.path()).is_ok() {
                removed += 1;
            }
        }
        Ok(removed)
    }

    /// Collect every `oximg://<name>` referenced across all live memo bodies.
    fn asset_refs_in_bodies(&self) -> Result<std::collections::HashSet<String>> {
        let mut live = std::collections::HashSet::new();
        for path in self.files.list_memo_files() {
            match self.files.read_memo(&path) {
                Ok(Some(parsed)) => {
                    for name in crate::assets::refs_in_body(&parsed.body) {
                        live.insert(name);
                    }
                }
                Ok(None) => {}
                Err(e) => tracing::warn!(
                    path = %path.display(),
                    error = %e,
                    "gc: skipping unparseable memo; its image refs are not counted"
                ),
            }
        }
        Ok(live)
    }

    /// First live memo whose body references asset `name`, or `None`. Powers
    /// the gallery's "open the memo containing this image".
    pub fn find_memo_by_asset(&self, name: &str) -> Result<Option<MemoId>> {
        for path in self.files.list_memo_files() {
            match self.files.read_memo(&path) {
                Ok(Some(parsed)) if crate::assets::refs_in_body(&parsed.body).contains(name) => {
                    return Ok(Some(parsed.id));
                }
                _ => {}
            }
        }
        Ok(None)
    }

    // -- locking helpers --------------------------------------------------

    fn lock(&self, kind: LockKind) -> Result<FileLock> {
        acquire(&self.paths.meta_lock_path(), kind, LOCK_TIMEOUT)
    }

    /// Shared lock + transient redb, for a read operation.
    fn with_redb<R>(&self, f: impl FnOnce(&RedbIndex) -> Result<R>) -> Result<R> {
        let _g = self.lock(LockKind::Shared)?;
        let idx = RedbIndex::open(&self.paths.meta_db_path())?;
        f(&idx)
    }

    /// Exclusive lock + transient redb & tantivy, for a mutating operation.
    fn with_redb_and_search<R>(
        &self,
        f: impl FnOnce(&RedbIndex, &TantivySearch) -> Result<R>,
    ) -> Result<R> {
        let _g = self.lock(LockKind::Exclusive)?;
        let idx = RedbIndex::open(&self.paths.meta_db_path())?;
        let search = TantivySearch::open(&self.paths.search_dir())?;
        f(&idx, &search)
    }

    // -- CRUD -------------------------------------------------------------

    /// Create a note in `folder` (empty = vault root) in the given format.
    /// The filename is derived from the body's title (H1 for markdown,
    /// `<h1>`/`<title>` for html), or a timestamp if untitled.
    pub fn create_note(
        &self,
        folder: &str,
        body: String,
        fmt: crate::memo::NoteFormat,
    ) -> Result<Memo> {
        self.ensure_initialized()?;
        // Template application (§6.1): a blank body takes the template's
        // body; a non-blank body keeps the captured text but still
        // inherits the template's frontmatter property defaults — the
        // knowledge capture path (quick capture into a schema folder)
        // depends on that stamp.
        let counter = crate::template::count_notes(&self.paths, folder) + 1;
        let ctx = crate::template::TemplateCtx::now(folder, counter);
        let tmpl = crate::template::load_template(&self.paths, folder, fmt);
        let blank = crate::template::is_blank_body(fmt, &body);
        let (body, tmpl_props) = match &tmpl {
            Some((table, t)) => {
                let body = if blank {
                    crate::template::apply_template(t, &ctx)
                } else {
                    body
                };
                let stamped = crate::template::apply_template_to_table(table, &ctx);
                let props = crate::props::props_from_table(&stamped);
                (body, props)
            }
            None => (body, Default::default()),
        };
        let mut mutation = Mutation::default();
        for (k, v) in &tmpl_props {
            mutation.set_props.insert(k.clone(), Some(v.to_frontmatter()));
        }
        let tags = tags_of(fmt, &body);
        validate_note_input(&body, &tags)?;
        let now = OffsetDateTime::now_utc();
        // The on-disk id/created are synthesized by write_document
        // (Synthesize::Yes on a missing file). We derive the filename
        // from the body so the path is stable before the file exists,
        // then let write_document produce the canonical block, then
        // read the typed Memo back so the in-memory model and the
        // file agree.
        let base = FileStore::derive_filename_from_body(&body, fmt, now);
        let path = self.files.unique_note_path(folder, &base, fmt);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let crate_fmt = to_crate_fmt(fmt);
        write_document(
            &path,
            &body,
            crate_fmt,
            mutation,
            Synthesize::Yes,
            now,
        )
        .map_err(crate::store::files::frontmatter_error_to_core)?;
        // Read back: write_document just synthesized id/created/updated
        // (the typed values are only known after the disk write).
        let note = self
            .files
            .read_memo(&path)?
            .ok_or_else(|| CoreError::other("write_document produced an unreadable file"))?;
        let rel = self.paths.relative_path(&path).unwrap_or_default();
        let (sbody, stitle, saliases) = search_fields(fmt, &note);
        self.with_redb_and_search(|idx, search| {
            idx.upsert(&record_of(&note, &rel))?;
            search.upsert(note.id, &sbody, stitle.as_deref(), &note.tags, &saliases)
        })?;
        Ok(note)
    }

    /// Create a note whose format follows the folder's templates: a folder
    /// with `TEMPLATE.html` but no `TEMPLATE.md` produces html notes;
    /// everything else defaults to markdown (spec §D8).
    pub fn create_note_auto(&self, folder: &str, body: String) -> Result<Memo> {
        let fmt =
            if crate::template::load_template(&self.paths, folder, crate::memo::NoteFormat::Html)
                .is_some()
                && crate::template::load_template(
                    &self.paths,
                    folder,
                    crate::memo::NoteFormat::Markdown,
                )
                .is_none()
            {
                crate::memo::NoteFormat::Html
            } else {
                crate::memo::NoteFormat::Markdown
            };
        self.create_note(folder, body, fmt)
    }
    /// Open (or create) the daily note for `date` (`YYYY-MM-DD`),
    /// daily-notes spec 2026-08-21 §2. Idempotent: an existing note at
    /// `{daily.folder}/{date}.md|html` is returned as-is, so manual
    /// files with matching names are adopted. Creation applies the
    /// folder template with the caller's local date, then normalizes
    /// the H1 to the date so the filename is deterministic.
    ///
    /// Returns the note plus `created: true` only when a NEW note was
    /// minted by this call. Adopted/index hits report `false` so callers
    /// can discard untouched fresh notes without ever deleting a file
    /// the user made themselves.
    pub fn open_daily(&self, date: &str) -> Result<(Memo, bool)> {
        if crate::template::parse_iso_date(date).is_none() {
            return Err(CoreError::other("invalid date, expected YYYY-MM-DD"));
        }
        let folder = self.with_config(|c| c.daily.folder.clone());
        let folder = folder.trim_end_matches('/');
        if folder.is_empty() {
            return Err(CoreError::other("[daily] folder must not be empty"));
        }
        let md_path = format!("{folder}/{date}.md");
        let html_path = format!("{folder}/{date}.html");
        let hit = self.with_redb(|idx| {
            Ok(idx
                .export_since(None)?
                .into_iter()
                .find(|r| !r.deleted && (r.path == md_path || r.path == html_path)))
        })?;
        if let Some(rec) = hit {
            return Ok((self.get_memo(rec.id)?, false));
        }
        // Index miss does not mean the file is absent: the watcher may not
        // have ingested it yet (debounce / startup lag). Adopt a canonical
        // file found on disk — read, re-index, return — the same stale-index
        // fallback get_memo uses, instead of letting create_note write a
        // `-2` sibling (spec §2 adopt-if-exists).
        for (rel, fmt) in [
            (&md_path, crate::memo::NoteFormat::Markdown),
            (&html_path, crate::memo::NoteFormat::Html),
        ] {
            let abs = self.paths.vault.join(rel);
            if !abs.exists() {
                continue;
            }
            let note = match self.files.read_memo(&abs)? {
                Some(note) => note,
                None => {
                    // Body-only manual file (no frontmatter): adopt in
                    // place — assign an identity and rewrite at the SAME
                    // canonical path, preserving the body verbatim.
                    let ParsedFile::BodyOnly { body } = self.files.read(&abs)? else {
                        continue;
                    };
                    let now = OffsetDateTime::now_utc();
                    let note = Memo {
                        id: MemoId::now(),
                        created_at: now,
                        updated_at: now,
                        hash: hash::hash_memo(body.as_bytes(), false, &Default::default()),
                        favorite: false,
                        tags: tags_of(fmt, &body),
                        props: Default::default(),
                        body,
                        deleted_at: None,
                    };
                    // Adopt in place (same canonical path, no `-2`
                    // sibling): merge-write with synthesis so the
                    // identity sticks on disk, then read the typed Memo
                    // back so the in-memory model and the file agree
                    // (mirrors the create path).
                    write_document(
                        &abs,
                        &note.body,
                        to_crate_fmt(fmt),
                        Mutation::default(),
                        Synthesize::Yes,
                        now,
                    )
                    .map_err(crate::store::files::frontmatter_error_to_core)?;
                    self.files
                        .read_memo(&abs)?
                        .ok_or_else(|| CoreError::other("[daily] adoption re-read failed"))?
                }
            };
            let (sbody, stitle, saliases) = search_fields(fmt, &note);
            self.with_redb_and_search(|idx, search| {
                idx.upsert(&record_of(&note, rel))?;
                search.upsert(note.id, &sbody, stitle.as_deref(), &note.tags, &saliases)
            })?;
            return Ok((note, false));
        }
        // Format follows the folder's templates (create_note_auto rule).
        let md_t =
            crate::template::load_template(&self.paths, folder, crate::memo::NoteFormat::Markdown);
        let html_t =
            crate::template::load_template(&self.paths, folder, crate::memo::NoteFormat::Html);
        let fmt = if html_t.is_some() && md_t.is_none() {
            crate::memo::NoteFormat::Html
        } else {
            crate::memo::NoteFormat::Markdown
        };
        let body = match md_t.or(html_t) {
            Some((_table, tmpl)) => {
                let counter = crate::template::count_notes(&self.paths, folder) + 1;
                let ctx = crate::template::TemplateCtx::for_date(date, folder, counter);
                let applied = crate::template::apply_template(&tmpl, &ctx);
                normalize_daily_h1(fmt, &applied, date)
            }
            None => format!("# {date}\n"),
        };
        self.create_note(folder, body, fmt).map(|memo| (memo, true))
    }

    /// Backward-compat alias: create a markdown note at vault root.
    pub fn create_memo(&self, body: String, _category: Option<String>) -> Result<Memo> {
        self.create_note("", body, crate::memo::NoteFormat::Markdown)
    }

    /// Read a note by id. Uses the index to locate the file path; falls back
    /// to a vault scan if the index is stale.
    pub fn get_memo(&self, id: MemoId) -> Result<Memo> {
        // Try the index for the path.
        if let Some(rec) = self.with_redb(|idx| idx.get(id))? {
            let abs = self.paths.vault.join(&rec.path);
            if abs.exists() {
                return self
                    .files
                    .read_memo(&abs)?
                    .ok_or_else(|| CoreError::NotFound(id.to_string()));
            }
            // Maybe in trash.
            let trash = self.paths.trash_path(&rec.path);
            if trash.exists() {
                return self
                    .files
                    .read_memo(&trash)?
                    .ok_or_else(|| CoreError::NotFound(id.to_string()));
            }
        }
        // Index miss: scan the vault.
        for path in self
            .files
            .scan()
            .iter()
            .chain(self.files.scan_trash().iter())
        {
            if let Ok(Some(n)) = self.files.read_memo(path)
                && n.id == id
            {
                return Ok(n);
            }
        }
        Err(CoreError::NotFound(id.to_string()))
    }
    /// Resolve the note's on-disk file: the indexed live path when it
    /// exists, the trash path otherwise (mirrors [`Vault::get_memo`]'s
    /// live→trash fallback). Returns `None` when neither exists.
    pub fn note_file_path(&self, memo: &Memo) -> Option<PathBuf> {
        let rel = self
            .with_redb(|idx| idx.get(memo.id))
            .ok()
            .flatten()
            .map(|r| r.path)
            .unwrap_or_default();
        let live = self.paths.vault.join(&rel);
        if live.exists() {
            return Some(live);
        }
        let trash = self.paths.trash_path(&rel);
        trash.exists().then_some(trash)
    }

    /// Update a note's body and/or favorite flag. If the note's title changes,
    /// the file is renamed to match the new title (format preserved).
    pub fn update_note(
        &self,
        id: MemoId,
        body: Option<String>,
        favorite: Option<bool>,
    ) -> Result<Memo> {
        self.update_note_with(id, body, favorite, None)
    }

    /// [`update_note`] plus property changes (design 2026-08-23 §5.1).
    /// `props` is a minimal set/remove diff; a same-value re-set is a
    /// semantic NoOp and never touches the file.
    pub fn update_note_with(
        &self,
        id: MemoId,
        body: Option<String>,
        favorite: Option<bool>,
        props: Option<crate::props::PropMutation>,
    ) -> Result<Memo> {
        let mut note = self.get_memo(id)?;
        let rec = self.with_redb(|idx| idx.get(id))?;
        let old_rel = rec.as_ref().map(|r| r.path.clone()).unwrap_or_default();
        let fmt = crate::memo::NoteFormat::from_rel(&old_rel);
        let old_props = note.props.clone();

        let old_title = note_title(fmt, &note.body);
        if let Some(b) = body {
            note.body = b;
            note.tags = tags_of(fmt, &note.body);
        }
        if let Some(p) = favorite {
            note.favorite = p;
        }
        if let Some(pm) = &props {
            for k in &pm.removes {
                note.props.remove(k);
            }
            for (k, v) in &pm.sets {
                note.props.insert(k.clone(), v.clone());
            }
        }
        // Folder-schema transitions (§6.2): side effects like the
        // `peak_status` max-merge and the `status_changed` stamp apply to
        // app-initiated writes only — external edits stay untouched.
        let folder = old_rel
            .rfind('/')
            .map(|i| &old_rel[..i])
            .unwrap_or("")
            .to_string();
        if let Some(schema) = self.folder_schema(&folder)? {
            let after_user = note.props.clone();
            note.props = crate::schema::apply_transitions(&schema, &old_props, &after_user);
        }
        // The write diff is the FULL old→new property delta: the user's
        // set/remove plus any transition effects, minimal by construction.
        let mut mutation = Mutation {
            favorite,
            deleted: None,
            ..Default::default()
        };
        for (k, v) in &note.props {
            if old_props.get(k) != Some(v) {
                mutation.set_props.insert(k.clone(), Some(v.to_frontmatter()));
            }
        }
        for k in old_props.keys() {
            if !note.props.contains_key(k) {
                mutation.set_props.insert(k.clone(), None);
            }
        }
        validate_note_input(&note.body, &note.tags)?;
        let original_updated = note.updated_at;
        note.updated_at = OffsetDateTime::now_utc();
        note.hash = hash::hash_memo(note.body.as_bytes(), note.favorite, &note.props);

        let old_path = self.paths.vault.join(&old_rel);

        // If the title changed (or old path doesn't exist), compute new path.
        let new_title = note_title(fmt, &note.body);
        let needs_rename = old_title != new_title && old_path.exists();
        let now = OffsetDateTime::now_utc();
        let crate_fmt = to_crate_fmt(fmt);
        if needs_rename {
            // Derive new filename and folder from old path. Stage the
            // old bytes at the new path first so write_document's
            // `existing` table (parsed at write time) carries the
            // original id/created forward — a brand-new file would
            // get a fresh synthesized id and orphan the existing
            // note identity.
            let folder = old_rel.rfind('/').map(|i| &old_rel[..i]).unwrap_or("");
            let base = FileStore::derive_filename(&note, fmt);
            let new_path = self.files.unique_note_path(folder, &base, fmt);
            if let Some(parent) = new_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            // Pre-stage the existing file so write_document's
            // parse-merge sees the original id/created.
            let old_bytes = std::fs::read(&old_path)?;
            oxi_frontmatter::atomic_write(&new_path, &old_bytes)?;
            let outcome = write_document(
                &new_path,
                &note.body,
                crate_fmt,
                mutation.clone(),
                Synthesize::No,
                now,
            )
            .map_err(crate::store::files::frontmatter_error_to_core)?;
            if matches!(outcome, WriteOutcome::NoOp) {
                // The pre-staged bytes already matched; the file's
                // `updated` was not bumped, so neither is the memo's.
                note.updated_at = original_updated;
            }
            // Remove the old file if it differs.
            if new_path != old_path && old_path.exists() {
                std::fs::remove_file(&old_path)?;
            }
            let new_rel = self.paths.relative_path(&new_path).unwrap_or_default();
            let (sbody, stitle, saliases) = search_fields(fmt, &note);
            self.with_redb_and_search(|idx, search| {
                idx.upsert(&record_of(&note, &new_rel))?;
                search.upsert(note.id, &sbody, stitle.as_deref(), &note.tags, &saliases)
            })?;
        } else {
            // Write in place at the existing path.
            if !old_path.exists() {
                // The note lives somewhere else (trashed, or moved by
                // an external tool): `get_memo` above read it from the
                // trash path or a scan hit. Locate that file and
                // pre-stage its bytes verbatim at the new live path —
                // the same identity trick as the rename branch — so
                // write_document carries the original id/created
                // forward instead of minting a fresh identity.
                let trash = self.paths.trash_path(&old_rel);
                let src = if trash.exists() {
                    Some(trash)
                } else {
                    self.files
                        .scan()
                        .iter()
                        .chain(self.files.scan_trash().iter())
                        .find(|p| id_from_path(p) == Some(id))
                        .cloned()
                };
                let base = FileStore::derive_filename(&note, fmt);
                let p = self.files.unique_note_path("", &base, fmt);
                if let Some(parent) = p.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                let outcome = match src {
                    Some(src) => {
                        let bytes = std::fs::read(&src)?;
                        oxi_frontmatter::atomic_write(&p, &bytes)?;
                        write_document(
                            &p,
                            &note.body,
                            crate_fmt,
                            mutation.clone(),
                            Synthesize::No,
                            now,
                        )
                        .map_err(crate::store::files::frontmatter_error_to_core)?
                    }
                    // Truly no file anywhere: synthesize from scratch.
                    None => write_document(
                        &p,
                        &note.body,
                        crate_fmt,
                        mutation.clone(),
                        Synthesize::Yes,
                        now,
                    )
                    .map_err(crate::store::files::frontmatter_error_to_core)?,
                };
                if matches!(outcome, WriteOutcome::NoOp) {
                    note.updated_at = original_updated;
                }
                // Index the (re)located note under the new live path.
                let rel = self.paths.relative_path(&p).unwrap_or_default();
                let (sbody, stitle, saliases) = search_fields(fmt, &note);
                self.with_redb_and_search(|idx, search| {
                    idx.upsert(&record_of(&note, &rel))?;
                    search.upsert(note.id, &sbody, stitle.as_deref(), &note.tags, &saliases)
                })?;
            } else {
                // In-place rewrite: the existing file carries the
                // id/created forward through write_document. A NoOp
                // (identical body + favorite) leaves the file's
                // `updated` untouched, so neither the memo nor the
                // index is bumped — disk and index stay in lockstep.
                let outcome = write_document(
                    &old_path,
                    &note.body,
                    crate_fmt,
                    mutation.clone(),
                    Synthesize::No,
                    now,
                )
                .map_err(crate::store::files::frontmatter_error_to_core)?;
                if !matches!(outcome, WriteOutcome::NoOp) {
                    let (sbody, stitle, saliases) = search_fields(fmt, &note);
                    self.with_redb_and_search(|idx, search| {
                        idx.upsert(&record_of(&note, &old_rel))?;
                        search.upsert(note.id, &sbody, stitle.as_deref(), &note.tags, &saliases)
                    })?;
                } else {
                    note.updated_at = original_updated;
                }
            }
        }

        // Rename propagation (§4.4): rewrite [[old title]] → [[new title]]
        // in every other note that references it. Only when both titles exist.
        if needs_rename && old_title.is_some() && new_title.is_some() {
            let old = old_title.as_deref().unwrap();
            let new = new_title.as_deref().unwrap();
            let recs = self.with_redb(|idx| idx.export_since(None))?;
            let mut updates: Vec<(Memo, String)> = Vec::new();
            for r in &recs {
                if r.deleted || r.id == id {
                    continue;
                }
                let src_fmt = crate::memo::NoteFormat::from_rel(&r.path);
                let abs = self.paths.vault.join(&r.path);
                let Ok(Some(src)) = self.files.read_memo(&abs) else {
                    continue;
                };
                if crate::wiki::links_to(&link_scan_text(src_fmt, &src.body, &src.props), old) {
                    let rewritten = crate::wiki::replace_link_target(&src.body, old, new);
                    let mut updated = src.clone();
                    updated.body = rewritten;
                    updated.tags = tags_of(src_fmt, &updated.body);
                    // Props rewrite (design §5.3): `[[old]]` inside
                    // property values (e.g. `related`) must follow the
                    // rename or stub links silently rot.
                    let mut prop_mutation = Mutation::default();
                    for (k, v) in &src.props {
                        let rv = match v {
                            crate::props::PropValue::Str(s) => {
                                crate::props::PropValue::Str(crate::wiki::replace_link_target(s, old, new))
                            }
                            crate::props::PropValue::List(items) => {
                                crate::props::PropValue::List(
                                    items
                                        .iter()
                                        .map(|i| crate::wiki::replace_link_target(i, old, new))
                                        .collect(),
                                )
                            }
                            b @ crate::props::PropValue::Bool(_) => b.clone(),
                        };
                        if &rv != v {
                            prop_mutation.set_props.insert(k.clone(), Some(rv.to_frontmatter()));
                            updated.props.insert(k.clone(), rv);
                        }
                    }
                    updated.updated_at = OffsetDateTime::now_utc();
                    updated.hash =
                        hash::hash_memo(updated.body.as_bytes(), updated.favorite, &updated.props);
                    // Link propagation: a rewrite that lands on identical
                    // content returns NoOp and leaves the file alone (the
                    // index is still refreshed below).
                    write_document(
                        &abs,
                        &updated.body,
                        to_crate_fmt(src_fmt),
                        prop_mutation,
                        Synthesize::No,
                        OffsetDateTime::now_utc(),
                    )
                    .map_err(crate::store::files::frontmatter_error_to_core)?;
                    updates.push((updated, r.path.clone()));
                }
            }
            if !updates.is_empty() {
                self.with_redb_and_search(|idx, search| {
                    for (n, p) in &updates {
                        idx.upsert(&record_of(n, p))?;
                        let (sbody, stitle, saliases) =
                            search_fields(crate::memo::NoteFormat::from_rel(p), n);
                        search.upsert(n.id, &sbody, stitle.as_deref(), &n.tags, &saliases)?;
                    }
                    Ok(())
                })?;
            }
        }
        Ok(note)
    }

    /// Backward-compat wrapper (category ignored).
    pub fn update_memo(
        &self,
        id: MemoId,
        body: Option<String>,
        favorite: Option<bool>,
        _category: Option<String>,
    ) -> Result<Memo> {
        self.update_note(id, body, favorite)
    }

    /// Soft-delete: move to trash, mark tombstone, drop from search.
    pub fn delete_memo(&self, id: MemoId) -> Result<()> {
        let mut note = self.get_memo(id)?;
        let rec = self.with_redb(|idx| idx.get(id))?;
        let rel = rec.as_ref().map(|r| r.path.clone()).unwrap_or_default();
        let fmt = crate::memo::NoteFormat::from_rel(&rel);
        let now = OffsetDateTime::now_utc();
        note.deleted_at = Some(now);
        note.updated_at = now;
        note.hash = hash::hash_memo(note.body.as_bytes(), note.favorite, &note.props);
        // Move file to trash (preserving structure), then write the
        // tombstone version into trash via write_document so the
        // `deleted` key is canonical and unknown keys survive.
        if !rel.is_empty() {
            self.files.move_to_trash(&rel)?;
            let trash_abs = self.paths.trash_path(&rel);
            if let Some(parent) = trash_abs.parent() {
                std::fs::create_dir_all(parent)?;
            }
            write_document(
                &trash_abs,
                &note.body,
                to_crate_fmt(fmt),
                Mutation {
                    favorite: Some(note.favorite),
                    deleted: Some(Some(now)),
                    set_props: Default::default(),
                },
                Synthesize::No,
                now,
            )
            .map_err(crate::store::files::frontmatter_error_to_core)?;
        }
        self.with_redb_and_search(|idx, search| {
            idx.upsert(&record_of(&note, &rel))?;
            search.remove(note.id)
        })?;
        Ok(())
    }

    pub fn restore_memo(&self, id: MemoId) -> Result<Memo> {
        let mut note = self.get_memo(id)?;
        let rec = self.with_redb(|idx| idx.get(id))?;
        let rel = rec.as_ref().map(|r| r.path.clone()).unwrap_or_default();
        let fmt = crate::memo::NoteFormat::from_rel(&rel);
        note.deleted_at = None;
        note.updated_at = OffsetDateTime::now_utc();
        note.hash = hash::hash_memo(note.body.as_bytes(), note.favorite, &note.props);
        if !rel.is_empty() {
            self.files.restore_from_trash(&rel)?;
            let abs = self.paths.vault.join(&rel);
            if let Some(parent) = abs.parent() {
                std::fs::create_dir_all(parent)?;
            }
            write_document(
                &abs,
                &note.body,
                to_crate_fmt(fmt),
                Mutation {
                    favorite: Some(note.favorite),
                    deleted: Some(None),
                    set_props: Default::default(),
                },
                Synthesize::No,
                OffsetDateTime::now_utc(),
            )
            .map_err(crate::store::files::frontmatter_error_to_core)?;
        }
        let (sbody, stitle, saliases) = search_fields(fmt, &note);
        self.with_redb_and_search(|idx, search| {
            idx.upsert(&record_of(&note, &rel))?;
            search.upsert(note.id, &sbody, stitle.as_deref(), &note.tags, &saliases)
        })?;
        Ok(note)
    }

    /// Restore trashed notes (undo for folder delete). Parent folders
    /// are recreated by `restore_memo` → `restore_from_trash`.
    pub fn restore_notes(&self, ids: &[MemoId]) -> Result<Vec<MemoId>> {
        let mut ok = Vec::with_capacity(ids.len());
        for id in ids {
            self.restore_memo(*id)?;
            ok.push(*id);
        }
        Ok(ok)
    }

    /// Hard-delete trashed notes whose `deleted_at` is older than `retention`.
    pub fn purge(&self, retention: Duration) -> Result<u64> {
        let cutoff = OffsetDateTime::now_utc() - retention;
        let mut purged = 0u64;
        self.with_redb_and_search(|idx, search| {
            for path in self.files.scan_trash() {
                let Ok(Some(n)) = self.files.read_memo(&path) else {
                    continue;
                };
                if n.deleted_at.is_some_and(|t| t < cutoff) {
                    if let Some(rel) = self.paths.relative_path(&path) {
                        let trash_rel = rel.strip_prefix(".trash/").unwrap_or(&rel).to_string();
                        self.files.purge(&trash_rel)?;
                    } else {
                        std::fs::remove_file(&path)?;
                    }
                    idx.remove(n.id)?;
                    search.remove(n.id)?;
                    purged += 1;
                }
            }
            Ok(())
        })?;
        Ok(purged)
    }

    // -- queries ----------------------------------------------------------

    pub fn list_memos(
        &self,
        after: Option<Cursor>,
        limit: u32,
        filter: MemoFilter,
    ) -> Result<Page<MemoSummary>> {
        self.with_redb(|idx| {
            let recs = idx.list(after, limit, &filter)?;
            let items: Vec<MemoSummary> = recs.iter().map(|r| r.to_summary()).collect();
            let next_cursor = items.last().and_then(|s| {
                serde_json::to_string(&Cursor {
                    updated_at: s.updated_at,
                    id: s.id,
                })
                .ok()
            });
            Ok(Page { items, next_cursor })
        })
    }

    /// Offset-paginated property query (design 2026-08-23 §5.2). Filters
    /// and sorts over the in-memory index snapshot — never reads note
    /// files — so it composes with property sorts that the cursor path
    /// (`by_sort` encodes only `updated_at/id`) cannot express. Use the
    /// cursor path for default newest-first browsing; use this whenever a
    /// property predicate or sort is present.
    pub fn query_notes(&self, query: &crate::props::NoteQuery) -> Result<crate::props::QueryPage> {
        let recs = self.with_redb(|idx| idx.export_since(None))?;
        let summaries: Vec<MemoSummary> = recs.iter().map(|r| r.to_summary()).collect();
        let (items, total) = query.apply(summaries);
        Ok(crate::props::QueryPage { items, total })
    }

    pub fn search_memos(&self, query: &str, limit: u32) -> Result<Vec<MemoSummary>> {
        let _g = self.lock(LockKind::Shared)?;
        let search = TantivySearch::open(&self.paths.search_dir())?;
        let idx = RedbIndex::open(&self.paths.meta_db_path())?;
        let ids = search.search(query, limit)?;
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(r) = idx.get(id)? {
                if r.deleted {
                    continue;
                }
                out.push(r.to_summary());
            }
        }
        Ok(out)
    }

    pub fn get_note_summary(&self, id: MemoId) -> Result<MemoSummary> {
        self.with_redb(|idx| match idx.get(id)? {
            Some(r) => Ok(r.to_summary()),
            None => Err(CoreError::NotFound(id.to_string())),
        })
    }

    /// Live note counts (soft-deleted tombstones excluded).
    pub fn memo_stats(&self) -> Result<crate::memo::MemoStats> {
        self.with_redb(|idx| {
            let recs = idx.export_since(None)?;
            let mut stats = crate::memo::MemoStats::default();
            for r in &recs {
                if r.deleted {
                    continue;
                }
                stats.memos += 1;
                if r.favorite {
                    stats.favorites += 1;
                }
            }
            Ok(stats)
        })
    }

    /// Full-note DTO (memo + placement) for the desktop API. The path comes
    /// from the index record; falls back to an empty path when the note has
    /// not been indexed yet (callers upsert before requesting).
    pub fn note_dto(&self, memo: &Memo) -> crate::memo::NoteDto {
        let rel = self
            .with_redb(|idx| idx.get(memo.id))
            .ok()
            .flatten()
            .map(|r| r.path)
            .unwrap_or_default();
        crate::memo::NoteDto::from_memo(memo, &rel)
    }

    /// Tag + color counts over live (non-deleted) notes for the sidebar (§4.2).
    pub fn list_facets(&self) -> Result<Facets> {
        self.with_redb(|idx| {
            let recs = idx.export_since(None)?;
            let mut tag_map: std::collections::BTreeMap<String, u32> = Default::default();
            let mut folder_map: std::collections::BTreeMap<String, u32> = Default::default();
            for r in &recs {
                if r.deleted {
                    continue;
                }
                for t in &r.tags {
                    *tag_map.entry(t.clone()).or_insert(0) += 1;
                }
                let folder = r.path.rfind('/').map(|i| &r.path[..i]).unwrap_or("");
                *folder_map.entry(folder.to_string()).or_insert(0) += 1;
            }
            Ok(Facets {
                tags: tag_map.into_iter().collect(),
                folders: folder_map.into_iter().collect(),
            })
        })
    }

    // -- graph + config (§6 graph view, §6.3 folder views) ---------------

    /// Build the wiki-link graph: nodes = live notes, edges = `[[...]]` links.
    /// Resolves link targets by title (case-insensitive). No self-loops.
    pub fn graph_data(&self) -> Result<GraphData> {
        let recs = self.with_redb(|idx| idx.export_since(None))?;
        let live: Vec<&IndexRecord> = recs.iter().filter(|r| !r.deleted).collect();

        // Title & alias → id map (case-insensitive). Resolution order
        // (design §5.3): H1 titles beat aliases; within either kind the
        // OLDEST note (`created_at`) wins, so the map is deterministic
        // regardless of iteration order.
        let mut by_created: Vec<&IndexRecord> = live.iter().copied().collect();
        by_created.sort_by_key(|r| r.created_at);
        let mut title_map: std::collections::HashMap<String, MemoId> = Default::default();
        for r in &by_created {
            if let Some(t) = &r.title {
                title_map.entry(t.trim().to_lowercase()).or_insert(r.id);
            }
        }
        for r in &by_created {
            for a in crate::props::aliases_of(&r.props) {
                title_map
                    .entry(a.trim().to_lowercase())
                    .or_insert(r.id);
            }
        }

        let config_items = self.config.read().folders.items.clone();
        let mut nodes = Vec::with_capacity(live.len());
        let mut edges = Vec::new();
        let mut conn: std::collections::HashMap<String, u32> = Default::default();

        for r in &live {
            let abs = self.paths.vault.join(&r.path);
            let body = match self.files.read_memo(&abs) {
                Ok(Some(n)) => n.body,
                _ => continue,
            };
            let folder = r.path.rfind('/').map(|i| &r.path[..i]).unwrap_or("");
            let color =
                crate::config::resolve_folder_color(folder, &config_items).unwrap_or_default();

            let fmt = crate::memo::NoteFormat::from_rel(&r.path);
            for link in crate::wiki::extract_links(&link_scan_text(fmt, &body, &r.props)) {
                let key = link.target.trim().to_lowercase();
                if let Some(&tgt) = title_map.get(&key)
                    && tgt != r.id
                {
                    edges.push(GraphEdge {
                        source: r.id.to_string(),
                        target: tgt.to_string(),
                    });
                    *conn.entry(r.id.to_string()).or_insert(0) += 1;
                }
            }

            nodes.push(GraphNode {
                id: r.id.to_string(),
                title: r.title.clone().unwrap_or_else(|| "Untitled".to_string()),
                folder: folder.to_string(),
                connections: 0, // filled below
                color,
            });
        }

        // Fill connection counts now that all edges are counted.
        for n in &mut nodes {
            n.connections = *conn.get(&n.id).unwrap_or(&0);
        }

        Ok(GraphData { nodes, edges })
    }

    /// Serialize config as JSON with `folders` flattened to a plain array
    /// (matching the frontend `Config` type).
    pub fn config_json(&self) -> serde_json::Value {
        self.config.read().config_json()
    }

    /// Lock (or unlock) a folder's default view mode, persisted to
    /// `oximemo.toml`.
    pub fn set_folder_view(&self, path: &str, view: Option<crate::config::ViewMode>) -> Result<()> {
        let mut cfg = self.config.write();
        match view {
            Some(v) => {
                if let Some(f) = cfg.folders.items.iter_mut().find(|f| f.path == path) {
                    f.view = Some(v);
                } else {
                    cfg.folders.items.push(crate::config::FolderDef {
                        path: path.to_string(),
                        view: Some(v),
                        color: None,
                        pinned: None,
                    });
                }
            }
            None => {
                if let Some(f) = cfg.folders.items.iter_mut().find(|f| f.path == path) {
                    f.view = None;
                    // Drop the entry if it has no color or pin either (clean config).
                    if f.color.is_none() && f.pinned.is_none() {
                        cfg.folders.items.retain(|f| f.path != path);
                    }
                }
            }
        }
        cfg.save(&self.paths)?;
        Ok(())
    }

    /// Pin/unpin a folder to the sidebar favorites, persisted to `oximemo.toml`.
    pub fn set_folder_pinned(&self, path: &str, pinned: bool) -> Result<()> {
        let mut cfg = self.config.write();
        if pinned {
            if let Some(f) = cfg.folders.items.iter_mut().find(|f| f.path == path) {
                f.pinned = Some(true);
            } else {
                cfg.folders.items.push(crate::config::FolderDef {
                    path: path.to_string(),
                    view: None,
                    color: None,
                    pinned: Some(true),
                });
            }
        } else if let Some(f) = cfg.folders.items.iter_mut().find(|f| f.path == path) {
            f.pinned = None;
            if f.view.is_none() && f.color.is_none() {
                cfg.folders.items.retain(|f| f.path != path);
            }
        }
        cfg.save(&self.paths)?;
        Ok(())
    }

    /// Reorder pinned folder entries in `oximemo.toml`. `order` must be a
    /// permutation of the currently pinned paths — anything else is an
    /// error (the frontend only ever sends drag results). Unpinned
    /// entries keep their relative order; pinned entries are appended in
    /// `order` (items order is only consumed as pin order — listings sort
    /// alphabetically).
    pub fn set_pin_order(&self, order: &[String]) -> Result<()> {
        let mut cfg = self.config.write();
        let mut pinned: Vec<String> = cfg
            .folders
            .items
            .iter()
            .filter(|f| f.pinned == Some(true))
            .map(|f| f.path.clone())
            .collect();
        pinned.sort();
        let mut want = order.to_vec();
        want.sort();
        if pinned != want {
            return Err(CoreError::other(
                "pin order must be a permutation of the pinned folders",
            ));
        }
        let by_path: std::collections::HashMap<String, crate::config::FolderDef> = cfg
            .folders
            .items
            .iter()
            .map(|f| (f.path.clone(), f.clone()))
            .collect();
        let mut items: Vec<crate::config::FolderDef> = cfg
            .folders
            .items
            .iter()
            .filter(|f| f.pinned != Some(true))
            .cloned()
            .collect();
        for p in order {
            if let Some(f) = by_path.get(p) {
                items.push(f.clone());
            }
        }
        cfg.folders.items = items;
        cfg.save(&self.paths)?;
        Ok(())
    }

    /// Vault-wide `#old` → `#new` rename across live note bodies. Token
    /// boundaries follow `tags::extract_tags` (word-char runs, NFC+
    /// casefold comparison). Renaming onto an existing tag merges them
    /// (tags are body-derived, so a merge is just two bodies agreeing).
    /// Returns the count of rewritten notes.
    pub fn rename_tag(&self, old: &str, new: &str) -> Result<u64> {
        use unicode_normalization::UnicodeNormalization;
        let old_norm = old.nfc().collect::<String>().to_lowercase();
        let new_norm = new.nfc().collect::<String>().to_lowercase();
        if new_norm.is_empty() {
            return Err(CoreError::other("new tag must not be empty"));
        }
        if old_norm == new_norm {
            return Ok(0);
        }
        let new_id = format!("#{new_norm}");
        let recs = self.with_redb(|idx| idx.export_since(None))?;
        let mut changed: u64 = 0;
        for r in recs.iter().filter(|r| !r.deleted) {
            let memo = self.get_memo(r.id)?;
            let rewritten = crate::tags::rewrite_tag(&memo.body, &old_norm, &new_id);
            if rewritten != memo.body {
                self.update_memo(r.id, Some(rewritten), None, None)?;
                changed += 1;
            }
        }
        Ok(changed)
    }

    /// Replace an entire config section and persist to `oximemo.toml`.
    /// Section-granular (not per-field) on purpose: the TOML file is
    /// section-shaped and the settings UI edits whole sections.
    fn replace_section<T>(&self, set: impl FnOnce(&mut VaultConfig, T), value: T) -> Result<()> {
        let mut cfg = self.config.write();
        set(&mut cfg, value);
        cfg.save(&self.paths)?;
        Ok(())
    }

    /// `[brain]` — oxibrain daemon connection settings.
    pub fn set_brain_config(&self, v: crate::config::BrainConfig) -> Result<()> {
        self.replace_section(|c, v| c.brain = v, v)
    }

    /// `[general]` — trash retention and future behavior knobs.
    pub fn set_general_config(&self, v: crate::config::GeneralConfig) -> Result<()> {
        self.replace_section(|c, v| c.general = v, v)
    }

    /// `[capture]` — overlay and trigger tuning.
    pub fn set_capture_config(&self, v: crate::config::CaptureConfig) -> Result<()> {
        self.replace_section(|c, v| c.capture = v, v)
    }

    /// `[appearance]` — theme and dock visibility.
    pub fn set_appearance_config(&self, v: crate::config::AppearanceConfig) -> Result<()> {
        self.replace_section(|c, v| c.appearance = v, v)
    }

    /// `[index]` — vault watcher tuning.
    pub fn set_index_config(&self, v: crate::config::IndexConfig) -> Result<()> {
        self.replace_section(|c, v| c.index = v, v)
    }

    /// Move a note to a different folder. Renames the file to
    /// `<new_folder>/<title-slug><ext>` (format preserved) and updates the
    /// index path. No content rewrite — the on-disk file's body,
    /// frontmatter, and id are preserved verbatim; only the path
    /// changes.
    pub fn move_note(&self, id: MemoId, new_folder: &str) -> Result<Memo> {
        let note = self.get_memo(id)?;
        let rec = self.with_redb(|idx| idx.get(id))?;
        let old_rel = rec.as_ref().map(|r| r.path.clone()).unwrap_or_default();
        let fmt = crate::memo::NoteFormat::from_rel(&old_rel);
        let old_path = self.paths.vault.join(&old_rel);

        if !old_path.exists() {
            return Err(CoreError::other("note file not found; cannot move"));
        }

        // Compute the new path from the (unchanged) title; no
        // write_document call — the on-disk content is already
        // correct, we only re-locate the file.
        let base = FileStore::derive_filename(&note, fmt);
        let new_path = self.files.unique_note_path(new_folder, &base, fmt);

        if new_path == old_path {
            // No-op move (target already at the requested location).
            return Ok(note);
        }
        if let Some(parent) = new_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::rename(&old_path, &new_path)?;
        if let Some(d) = new_path.parent() {
            // fsync the parent dir so the rename survives power loss.
            // Failures here are non-fatal (best-effort durability).
            let _ = crate::store::files::fsync_dir(d);
        }

        let new_rel = self.paths.relative_path(&new_path).unwrap_or_default();
        let (sbody, stitle, saliases) = search_fields(fmt, &note);
        self.with_redb_and_search(|idx, search| {
            idx.upsert(&record_of(&note, &new_rel))?;
            search.upsert(note.id, &sbody, stitle.as_deref(), &note.tags, &saliases)
        })?;
        Ok(note)
    }

    /// Find all live notes whose body links to the target note (by title).
    /// Returns source note id, title, and preview for each backlink.
    pub fn get_backlinks(&self, id: MemoId) -> Result<Vec<BacklinkInfo>> {
        let recs = self.with_redb(|idx| idx.export_since(None))?;
        // Target: title + aliases (design §5.3 — `[[ML]]` resolves to the
        // note whose alias list contains ML).
        let target = recs
            .iter()
            .find(|r| r.id == id && !r.deleted)
            .ok_or_else(|| CoreError::NotFound(id.to_string()))?;
        let mut targets: Vec<String> = Vec::new();
        if let Some(t) = &target.title {
            targets.push(t.clone());
        }
        targets.extend(crate::props::aliases_of(&target.props));

        let mut out = Vec::new();
        for r in &recs {
            if r.deleted || r.id == id {
                continue;
            }
            let abs = self.paths.vault.join(&r.path);
            let body = match self.files.read_memo(&abs) {
                Ok(Some(n)) => n.body,
                _ => continue,
            };
            let src_fmt = crate::memo::NoteFormat::from_rel(&r.path);
            let links =
                crate::wiki::extract_links(&link_scan_text(src_fmt, &body, &r.props));
            let hit = links.iter().any(|l| {
                targets
                    .iter()
                    .any(|t| l.target.trim().eq_ignore_ascii_case(t.trim()))
            });
            if hit {
                out.push(BacklinkInfo {
                    id: r.id.to_string(),
                    title: r.title.clone().unwrap_or_else(|| "Untitled".to_string()),
                    preview: preview_of(src_fmt, &body),
                });
            }
        }
        Ok(out)
    }

    // -- sync / export (§9.2) --------------------------------------------

    pub fn export_manifest(&self, since: Option<OffsetDateTime>) -> Result<Vec<ManifestRecord>> {
        let recs = self.with_redb(|idx| idx.export_since(since))?;
        Ok(recs
            .iter()
            .map(|r| ManifestRecord {
                id: r.id,
                // The file is the source of truth: the indexed digest
                // goes stale the moment a note is edited outside the
                // app, so recompute hash_memo(body, favorite) during
                // the walk (v4 files carry no `hash` key).
                hash: self.manifest_hash(r).unwrap_or_else(|| r.hash.clone()),
                updated_at: r.updated_at,
                deleted: r.deleted,
            })
            .collect())
    }

    /// Recompute a record's digest from its current on-disk body via
    /// [`crate::hash::hash_memo`] (applied by [`FileStore::read_memo`]
    /// when it builds the memo). Deleted notes keep their
    /// vault-relative path in the index while the file lives in
    /// `.trash/`, so resolve live→trash the same way [`Vault::get_memo`]
    /// does. Returns `None` when the file is missing or unreadable —
    /// the caller then keeps the indexed digest rather than dropping
    /// the record (a missing manifest entry reads as a deletion
    /// downstream).
    fn manifest_hash(&self, rec: &IndexRecord) -> Option<MemoHash> {
        let live = self.paths.vault.join(&rec.path);
        let path = if live.exists() {
            live
        } else {
            let trash = self.paths.trash_path(&rec.path);
            if !trash.exists() {
                tracing::warn!(id = %rec.id, "export_manifest: file missing; keeping indexed hash");
                return None;
            }
            trash
        };
        match self.files.read_memo(&path) {
            Ok(Some(note)) => Some(note.hash),
            Ok(None) => {
                tracing::warn!(
                    id = %rec.id,
                    "export_manifest: body-only file; keeping indexed hash"
                );
                None
            }
            Err(e) => {
                tracing::warn!(
                    id = %rec.id,
                    error = %e,
                    "export_manifest: unreadable file; keeping indexed hash"
                );
                None
            }
        }
    }

    pub fn export_full(&self, ids: &[MemoId]) -> Result<Vec<FullRecord>> {
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            match self.get_memo(*id) {
                Ok(n) => out.push(FullRecord::from_memo(&n)),
                Err(CoreError::NotFound(_)) => { /* skip missing */ }
                Err(e) => return Err(e),
            }
        }
        Ok(out)
    }

    // -- maintenance ------------------------------------------------------

    /// Rebuild the indexes from the source-of-truth files (§5.5, §9.1).
    pub fn reindex(&self) -> Result<IndexStats> {
        self.ensure_initialized()?;
        self.with_redb_and_search(|idx, search| {
            let mut stats = IndexStats::default();
            let mut search_owned: Vec<(MemoId, String, Option<String>, Vec<String>, String)> = Vec::new();
            for path in self.files.scan() {
                match self.files.read_memo(&path) {
                    Ok(Some(note)) => {
                        let rel = self.paths.relative_path(&path).unwrap_or_default();
                        let fmt = crate::memo::NoteFormat::from_rel(&rel);
                        let (sbody, stitle, saliases) = search_fields(fmt, &note);
                        let title = stitle;
                        let rec = record_of(&note, &rel);
                        match idx.get(note.id)? {
                            None => {
                                idx.upsert(&rec)?;
                                search_owned.push((note.id, sbody, title, note.tags, saliases));
                                stats.added += 1;
                            }
                            Some(prev) if prev.hash == rec.hash && prev.preview == rec.preview => {
                                stats.unchanged += 1;
                            }
                            Some(_) => {
                                idx.upsert(&rec)?;
                                search_owned.push((note.id, sbody, title, note.tags, saliases));
                                stats.updated += 1;
                            }
                        }
                        stats.memos += 1;
                    }
                    Ok(None) => {}
                    Err(e) => {
                        tracing::warn!(path = %path.display(), error = %e, "reindex: parse failed");
                        stats.failed += 1;
                    }
                }
            }
            for path in self.files.scan_trash() {
                if let Ok(Some(note)) = self.files.read_memo(&path) {
                    let rel = self
                        .paths
                        .relative_path(&path)
                        .and_then(|r| r.strip_prefix(".trash/").map(|s| s.to_string()))
                        .unwrap_or_default();
                    let (sbody, stitle, saliases) =
                        search_fields(crate::memo::NoteFormat::from_rel(&rel), &note);
                    let rec = record_of(&note, &rel);
                    idx.upsert(&rec)?;
                    search_owned.push((note.id, sbody, stitle, note.tags, saliases));
                    stats.trashed_memos += 1;
                }
            }
            let batch: Vec<crate::store::search::Upsert<'_>> = search_owned
                .iter()
                .map(|(id, body, title, tags, aliases)| crate::store::search::Upsert {
                    id: *id,
                    body,
                    title: title.as_deref(),
                    tags,
                    aliases,
                })
                .collect();
            search.upsert_batch(&batch)?;
            Ok(stats)
        })
    }
    /// One-time migration: rebuild the index when the cached preview format
    /// lags the current `make_preview` (or the marker is absent), so existing
    /// notes' card previews pick up changes.
    ///
    /// Also ensures the default folders exist (design 2026-08-23 §6.3 — the
    /// knowledge folder ships with the vault like the daily folder, macOS
    /// system-folder style). Idempotent: a no-op once everything is current.
    pub fn migrate(&self) -> Result<()> {
        self.ensure_initialized()?;
        self.ensure_default_folders()?;
        let marker = self.paths.index_fmt_marker_path();
        let wants = INDEX_FORMAT_VERSION.to_string();
        if std::fs::read_to_string(&marker)
            .ok()
            .map(|s| s.trim() == wants)
            .unwrap_or(false)
        {
            return Ok(());
        }
        tracing::info!(version = INDEX_FORMAT_VERSION, "migrating index format");
        self.reindex()?;
        std::fs::write(&marker, &wants)?;
        Ok(())
    }

    fn ensure_default_folders(&self) -> Result<()> {
        self.apply_knowledge_preset(crate::schema::DEFAULT_KNOWLEDGE_FOLDER)?;
        // The daily preset follows the *configured* daily folder — a
        // custom `[daily] folder = "journal"` gets the journaling schema
        // at that path, not at a hardcoded "daily".
        let daily = self.with_config(|c| c.daily.folder.clone());
        let daily = daily.trim_end_matches('/');
        if !daily.is_empty() {
            self.apply_preset(
                daily,
                crate::schema::DAILY_TEMPLATE_MD,
                crate::schema::DAILY_SCHEMA_TOML,
            )?;
        }
        Ok(())
    }

    /// Re-index a single changed file. Called by the watcher (debounced). Handles
    /// create/modify (upsert) and removal (delete from index + search).
    pub fn reindex_path(&self, path: &Path) {
        if let Err(e) = self.do_reindex_path(path) {
            tracing::warn!(path = %path.display(), error = %e, "watcher reindex failed");
        }
    }

    fn do_reindex_path(&self, path: &Path) -> Result<()> {
        if !path.exists() {
            if let Some(id) = id_from_path(path) {
                self.with_redb_and_search(|idx, search| {
                    idx.remove(id)?;
                    search.remove(id)
                })?;
            }
            return Ok(());
        }
        match self.files.read_memo(path)? {
            Some(note) => {
                let rel = self.paths.relative_path(path).unwrap_or_default();
                let fmt = crate::memo::NoteFormat::from_rel(&rel);
                let (sbody, stitle, saliases) = search_fields(fmt, &note);
                self.with_redb_and_search(|idx, search| {
                    idx.upsert(&record_of(&note, &rel))?;
                    search.upsert(note.id, &sbody, stitle.as_deref(), &note.tags, &saliases)
                })
            }
            None => Ok(()),
        }
    }

    /// Start the background file watcher (§5.5). The returned handle must be
    /// kept alive for the lifetime of the watch.
    pub fn watch(&self) -> Result<crate::watcher::MemoWatcher> {
        let debounce = Duration::from_millis(self.config.read().index.watcher_debounce_ms as u64);
        let vault_path = self.paths.vault.clone();
        let on_change: crate::watcher::OnChange = std::sync::Arc::new(move |path| {
            let Ok(v) = Vault::open(Some(&vault_path)) else {
                return;
            };
            v.reindex_path(&path);
        });
        crate::watcher::MemoWatcher::spawn(
            vec![self.paths.vault.clone(), self.paths.trash_root()],
            debounce,
            on_change,
        )
    }

    /// Consistency check (§9.3). When `fix` is true, safe repairs are applied
    /// (orphan index cleanup). Files are never deleted and never rewritten:
    /// v4 hashes are derived from body+favorite and recomputed on read, so
    /// there is no stored digest to compare against or repair.
    pub fn doctor(&self, fix: bool) -> Result<DoctorReport> {
        self.ensure_initialized()?;
        let mut report = DoctorReport {
            merge_required: matches!(self.status, VaultStatus::MergeRequired { .. }),
            index_locked: crate::lock::is_locked(&self.paths.meta_lock_path()),
            ..DoctorReport::default()
        };
        // Gather indexed ids for orphan detection.
        let all_recs = self.with_redb(|idx| idx.export_since(None))?;
        let indexed: std::collections::HashMap<MemoId, IndexRecord> =
            all_recs.iter().map(|r| (r.id, r.clone())).collect();

        let mut seen: std::collections::HashSet<MemoId> = std::collections::HashSet::new();
        for path in self
            .files
            .list_memo_files()
            .iter()
            .chain(self.files.list_trash_files().iter())
        {
            match self.files.read_memo(path) {
                Ok(Some(note)) => {
                    seen.insert(note.id);
                    // Schema validation (§6.2): warning-level, never a
                    // `--fix` target — a violation may be the user's
                    // deliberate state.
                    if let Some(rel) = self.paths.relative_path(path) {
                        let folder = rel.rfind('/').map(|i| &rel[..i]).unwrap_or("");
                        if let Ok(Some(schema)) = self.folder_schema(folder) {
                            for v in crate::schema::validate(&schema, &note.props) {
                                report.schema_violations.push((
                                    path.clone(),
                                    format!("{}: {}", v.key, v.reason),
                                ));
                            }
                        }
                    }
                }
                Ok(None) => report.orphan_files.push(path.clone()),
                Err(CoreError::Frontmatter { reason, .. }) => {
                    report.corrupt_frontmatter.push((path.clone(), reason));
                }
                Err(e) => {
                    report
                        .corrupt_frontmatter
                        .push((path.clone(), e.to_string()));
                }
            }
        }

        for id in indexed.keys() {
            if !seen.contains(id) {
                report.orphan_index_records.push(*id);
            }
        }
        if fix {
            // Remove orphan index records + search docs in one locked pass.
            let orphans = report.orphan_index_records.clone();
            self.with_redb_and_search(|idx, search| {
                for id in &orphans {
                    idx.remove(*id)?;
                    search.remove(*id)?;
                }
                Ok(())
            })?;
            report.orphan_index_records.clear();
        }

        // Trash purge estimate.
        let cutoff = OffsetDateTime::now_utc()
            - Duration::from_secs(86400 * self.config.read().general.trash_retention_days as u64);
        for path in self.files.list_trash_files() {
            if let Ok(Some(n)) = self.files.read_memo(&path)
                && n.deleted_at.is_some_and(|t| t < cutoff)
            {
                report.trash_expiring += 1;
            }
        }

        report.vault_ok = self.paths.vault.is_dir();
        Ok(report)
    }

    /// Wipe all notes, trash, and the derived redb + tantivy indexes,
    /// returning the vault to an empty state. Note files (identified by the
    /// scanner) are deleted; `_assets/`, `.trash/`, config, and `TEMPLATE.md`
    /// are preserved. Backs the settings "reset" action.
    pub fn reset(&self) -> Result<()> {
        self.ensure_initialized()?;
        self.with_redb_and_search(|idx, search| {
            // Delete all live note files the scanner finds.
            for path in self.files.scan() {
                std::fs::remove_file(&path)?;
            }
            // Wipe the trash.
            let trash = self.paths.trash_root();
            if trash.exists() {
                std::fs::remove_dir_all(&trash)?;
                std::fs::create_dir_all(&trash)?;
            }
            idx.clear()?;
            search.clear()?;
            Ok(())
        })
    }
}

/// Build an [`IndexRecord`] from a [`Memo`] + its vault-relative path. The
/// format is derived from the path's extension.
fn record_of(n: &Memo, path: &str) -> IndexRecord {
    let fmt = crate::memo::NoteFormat::from_rel(path);
    IndexRecord {
        id: n.id,
        created_at: n.created_at,
        updated_at: n.updated_at,
        hash: n.hash.clone(),
        favorite: n.favorite,
        path: path.to_string(),
        title: note_title(fmt, &n.body),
        tags: n.tags.clone(),
        deleted: n.deleted_at.is_some(),
        deleted_at: n.deleted_at,
        preview: preview_of(fmt, &n.body),
        props: n.props.clone(),
    }
}

/// Derived search-index fields for a note: the searchable body text and the
/// title, both format-aware.
fn search_fields(fmt: crate::memo::NoteFormat, note: &Memo) -> (String, Option<String>, String) {
    (
        searchable_body(fmt, &note.body).into_owned(),
        note_title(fmt, &note.body),
        crate::props::aliases_of(&note.props).join(" "),
    )
}
/// True iff `path` is a directory containing at least one entry. Used by
/// the rename_folder collision guard: POSIX `rename(2)` atomically replaces
/// an empty destination, so an empty `.trash/<to>/` is not a collision —
/// only a non-empty one would ENOTEMPTY the trash rename.
fn trash_to_is_nonempty(path: &Path) -> bool {
    path.is_dir()
        && std::fs::read_dir(path)
            .map(|mut d| d.next().is_some())
            .unwrap_or(false)
}

/// Body prepared for wiki-link scanning: html comments (which carry the
/// frontmatter) are removed so their contents cannot masquerade as links.
fn link_scan_body<'a>(fmt: crate::memo::NoteFormat, body: &'a str) -> std::borrow::Cow<'a, str> {
    match fmt {
        crate::memo::NoteFormat::Markdown => std::borrow::Cow::Borrowed(body),
        crate::memo::NoteFormat::Html => std::borrow::Cow::Owned(crate::html::strip_comments(body)),
    }
}

/// Link-scan text covering the body AND all 1-dimensional property values
/// (design 2026-08-23 §5.3): `[[..]]` inside e.g. `related` counts as a
/// link for graph edges, backlinks, and rename propagation.
fn link_scan_text(
    fmt: crate::memo::NoteFormat,
    body: &str,
    props: &crate::props::Props,
) -> String {
    let body_part = link_scan_body(fmt, body);
    let props_part = crate::props::props_link_text(props);
    if props_part.is_empty() {
        body_part.into_owned()
    } else {
        format!("{body_part}\n{props_part}")
    }
}

fn id_from_path(path: &Path) -> Option<MemoId> {
    let stem = path.file_stem()?.to_str()?;
    MemoId::parse(stem).ok()
}

/// Soft input bounds (H6). A note is a quick card, not a document; reject
/// absurdly large bodies or tag spam before they hit the store/index so a
/// malformed input can't bloat the indexes.
const MAX_BODY_BYTES: usize = 64 * 1024;
const MAX_TAGS: usize = 64;
const MAX_TAG_LEN: usize = 64;

fn validate_note_input(body: &str, tags: &[String]) -> Result<()> {
    if body.len() > MAX_BODY_BYTES {
        return Err(CoreError::other(format!(
            "memo body too large: {} bytes (max {})",
            body.len(),
            MAX_BODY_BYTES
        )));
    }
    if tags.len() > MAX_TAGS {
        return Err(CoreError::other(format!(
            "too many tags: {} (max {})",
            tags.len(),
            MAX_TAGS
        )));
    }
    for t in tags {
        if t.chars().count() > MAX_TAG_LEN {
            return Err(CoreError::other(format!(
                "tag too long: {} chars (max {})",
                t.chars().count(),
                MAX_TAG_LEN
            )));
        }
    }
    Ok(())
}

/// Output of `oximemo doctor` (§9.3).
#[derive(Debug, Default, serde::Serialize)]
pub struct DoctorReport {
    pub corrupt_frontmatter: Vec<(PathBuf, String)>,
    /// True when both the pre-unification default vault and the new
    /// `~/.oxi/vault` exist and must be merged by hand
    /// ([`VaultStatus::MergeRequired`]).
    pub merge_required: bool,
    pub orphan_index_records: Vec<MemoId>,
    pub orphan_files: Vec<PathBuf>,
    /// Always empty since v4: hashes are derived from body+favorite and
    /// recomputed on read, so a stored-vs-recomputed mismatch cannot
    /// exist. Retained for the serialized report API (the frontend
    /// still sums it).
    pub hash_mismatches: Vec<MemoId>,
    /// Warning-level folder-schema violations (design 2026-08-23 §6.2).
    /// Never a `--fix` target — a violation may be deliberate.
    pub schema_violations: Vec<(PathBuf, String)>,
    /// Always 0 since v4 (see [`Self::hash_mismatches`]); `doctor`
    /// never rewrites files. Retained for the serialized report API.
    pub hash_repair_failed: u64,
    pub index_locked: bool,
    pub trash_expiring: u64,
    pub vault_ok: bool,
}

// -- graph data (§6.1 graph view) -------------------------------------

/// A node in the wiki-link graph: one note.
#[derive(Debug, Clone, serde::Serialize)]
pub struct GraphNode {
    pub id: String,
    pub title: String,
    pub folder: String,
    pub connections: u32,
    /// OKLCH color string (may be empty — frontend recomputes via colorForFolder).
    pub color: String,
}

/// A directed edge: source note links to target note via `[[...]]`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
}

/// The full wiki-link graph for the graph view.
#[derive(Debug, Clone, serde::Serialize)]
pub struct GraphData {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

/// A backlink: a note that links to the target note.
#[derive(Debug, Clone, serde::Serialize)]
pub struct BacklinkInfo {
    pub id: String,
    pub title: String,
    pub preview: String,
}

/// A single recent note attributed to a folder card (newest-first sample).
#[derive(Debug, Clone, serde::Serialize)]
pub struct FolderRecent {
    pub id: crate::memo::MemoId,
    pub title: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

/// One folder tile: direct + recursive counts plus a sample of recent note
/// titles attributed to the nearest displayed ancestor. Drives the folder
/// picker in the Finder-style browser.
#[derive(Debug, Clone, serde::Serialize)]
pub struct FolderCard {
    pub path: String,
    /// Direct note count as `list_folders` reports it.
    pub note_count: u32,
    /// Recursive note count (notes anywhere under this folder).
    pub note_count_deep: u32,
    /// Direct subfolder count.
    pub subfolder_count: u32,
    /// Up to 3 newest notes attributed to this folder (newest-first).
    pub recent: Vec<FolderRecent>,
}

/// Recursively register physical directories (even note-less ones) as folder
/// entries with count 0. Mirrors `scan_md_into`'s skip rules: hidden dirs
/// (`.trash`, …) and `_assets/` are not folders.
fn collect_folder_dirs(
    dir: &Path,
    rel: &str,
    counts: &mut std::collections::BTreeMap<String, u32>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == crate::paths::ASSETS_DIR {
            continue;
        }
        let child_rel = if rel.is_empty() {
            name
        } else {
            format!("{rel}/{name}")
        };
        counts.entry(child_rel.clone()).or_insert(0);
        collect_folder_dirs(&entry.path(), &child_rel, counts);
    }
}
/// Force the daily note's derived title to the ISO date so
/// `write_note` derives the canonical filename (spec §2). Templates
/// whose H1 is something else (`# 일지`) keep their body underneath.
fn normalize_daily_h1(fmt: crate::memo::NoteFormat, body: &str, date: &str) -> String {
    if crate::memo::note_title(fmt, body).as_deref() == Some(date) {
        return body.to_string();
    }
    match fmt {
        crate::memo::NoteFormat::Markdown => format!("# {date}\n\n{body}"),
        crate::memo::NoteFormat::Html => format!("<h1>{date}</h1>\n{body}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn tmp_vault() -> (TempDir, Vault) {
        let dir = TempDir::new().unwrap();
        let v = Vault::open(Some(dir.path())).unwrap();
        (dir, v)
    }

    // -- default-vault migration (task: ~/.oxi/vault) ----------------------

    const V3_ID: &str = "0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
    fn v3_md(extra: &str) -> String {
        format!(
            "+++\n\
             id = \"{V3_ID}\"\n\
             created_at = 2025-01-02T03:04:05Z\n\
             updated_at = 2025-01-02T03:04:06Z\n\
             hash = \"cafe1234cafe1234\"\n\
             favorite = true\n\
             tags = [\"idea\"]\n\
             {extra}\
             +++\n\
             \n\
             # Title\n\
             \n\
             body text\n"
        )
    }

    /// Seed a populated pre-unification default vault under `home`.
    fn seed_old_default(home: &Path) -> PathBuf {
        let old = home
            .join("Library")
            .join("Application Support")
            .join("com.oximemo.app")
            .join("vault");
        std::fs::create_dir_all(old.join(".trash/novel")).unwrap();
        std::fs::create_dir_all(old.join("novel")).unwrap();
        std::fs::create_dir_all(old.join("_assets")).unwrap();
        std::fs::create_dir_all(old.join("habits")).unwrap();
        std::fs::write(old.join("oximemo.toml"), "[general]\n").unwrap();
        std::fs::write(old.join("_assets/img.png"), b"\x89PNG-not-really").unwrap();
        std::fs::write(old.join("novel/first.md"), v3_md("")).unwrap();
        // Trashed v3 note carrying a tombstone.
        std::fs::write(
            old.join(".trash/novel/old.md"),
            v3_md("deleted_at = 2025-01-02T03:04:07Z\n"),
        )
        .unwrap();
        // System file: frontmatter-less, must move verbatim.
        std::fs::write(old.join("habits/emoji.md"), "\u{1f4da}\n").unwrap();
        old
    }

    #[test]
    fn open_migrates_default_vault_and_reindex_sees_the_memo() {
        // Leaked home (see `with_home`): concurrent tests resolve their
        // index through env HOME, so the swap target must outlive them.
        let home = TempDir::new().unwrap().keep();
        let old = seed_old_default(&home);
        let new = home.join(".oxi").join("vault");

        let (vault_path, status) = crate::migrate_vault::with_home(&home, || {
            let v = Vault::open(None).unwrap();
            (v.paths().vault.clone(), v.status().clone())
        });

        assert_eq!(vault_path, new, "open(None) resolves the new default");
        assert_eq!(status, VaultStatus::Ok);
        assert!(!old.exists(), "entire tree moved away");
        assert!(new.join("oximemo.toml").is_file());
        assert_eq!(
            std::fs::read(new.join("_assets/img.png")).unwrap(),
            b"\x89PNG-not-really"
        );
        let converted = std::fs::read_to_string(new.join("novel/first.md")).unwrap();
        assert!(
            converted.starts_with("---\n"),
            "converted to v4: {converted}"
        );
        assert!(!converted.contains("hash"), "stored hash dropped");
        let trashed = std::fs::read_to_string(new.join(".trash/novel/old.md")).unwrap();
        assert!(trashed.starts_with("---\n"), "trashed note converted");
        assert!(trashed.contains("deleted: 2025-01-02T03:04:07Z"));
        // System file moves verbatim, staying frontmatter-less.
        assert_eq!(
            std::fs::read_to_string(new.join("habits/emoji.md")).unwrap(),
            "\u{1f4da}\n"
        );

        // Reindex on the migrated vault sees the memo (typed read of the
        // converted file succeeds) and the trashed tombstone.
        crate::migrate_vault::with_home(&home, || {
            let v = Vault::open(None).unwrap();
            let stats = v.reindex().unwrap();
            assert_eq!(stats.memos, 1, "live memo indexed");
            assert_eq!(stats.trashed_memos, 1, "trashed memo indexed");
            assert_eq!(stats.failed, 0);
        });
    }

    #[test]
    fn open_surfaces_merge_required_and_doctor_reports_it() {
        let home = TempDir::new().unwrap().keep();
        let old = seed_old_default(&home);
        let new = home.join(".oxi").join("vault");
        std::fs::create_dir_all(&new).unwrap();
        std::fs::write(new.join("other.md"), "---\nid: other\n---\nnew side\n").unwrap();
        let old_bytes = std::fs::read_to_string(old.join("novel/first.md")).unwrap();

        crate::migrate_vault::with_home(&home, || {
            let v = Vault::open(None).unwrap();
            assert_eq!(
                v.status(),
                &VaultStatus::MergeRequired {
                    old: old.clone(),
                    new: new.clone()
                }
            );
            // The vault still opens at the new path and doctor surfaces
            // the pending merge instead of failing silently.
            assert_eq!(v.paths().vault, new);
            let report = v.doctor(false).unwrap();
            assert!(report.merge_required);
        });

        // Nothing was overwritten on either side.
        assert_eq!(
            std::fs::read_to_string(old.join("novel/first.md")).unwrap(),
            old_bytes
        );
        assert_eq!(
            std::fs::read_to_string(new.join("other.md")).unwrap(),
            "---\nid: other\n---\nnew side\n"
        );
    }

    /// Seed a target note via the raw on-disk format: an `oxios:` table
    /// (an app-extension sub-map) plus an unknown scalar must survive
    /// every public rewrite path unchanged. This is the regression
    /// target for the "typed serialization drops unknown keys" finding
    /// that motivated routing every rewrite through
    /// `oxi-frontmatter::write_document`.
    #[test]
    fn oxios_table_survives_every_rewrite_path() {
        use oxi_frontmatter::{
            NoteFormat as FrontmatterFormat, Table, Value, atomic_write, emit, parse,
        };
        let (_t, v) = tmp_vault();
        let source = v.create_note_auto("", "See [[Target]].".into()).unwrap();
        let target = v.create_note_auto("", "# Target".into()).unwrap();
        let target_path = v
            .with_redb(|idx| Ok(idx.get(target.id).unwrap().expect("target indexed").path))
            .unwrap();
        let target_path = v.paths.vault.join(target_path);
        // Build the hand-crafted v4 document. Two fields under `oxios:`
        // (an app extension) plus an unknown scalar `source` must all
        // round-trip through every rewrite path.
        let mut oxios = Table::new();
        oxios.insert("author".into(), Value::Str("agent".into()));
        oxios.insert("needs_review".into(), Value::Bool(true));
        let mut table = Table::new();
        // Format the typed timestamps as RFC3339 (the v4 grammar's
        // timestamp shape). `OffsetDateTime::to_string()` is a
        // debug-style format the parser would reject.
        let rfc = time::format_description::well_known::Rfc3339;
        table.insert("id".into(), Value::Str(target.id.to_string()));
        table.insert(
            "created".into(),
            Value::Str(target.created_at.format(&rfc).unwrap()),
        );
        table.insert(
            "updated".into(),
            Value::Str(target.updated_at.format(&rfc).unwrap()),
        );
        table.insert("favorite".into(), Value::Bool(false));
        table.insert(
            "aliases".into(),
            Value::Array(vec!["goal".into(), "anchor".into()]),
        );
        table.insert("source".into(), Value::Str("migration".into()));
        table.insert("oxios".into(), Value::Map(oxios.clone()));
        atomic_write(
            &target_path,
            emit(&table, "# Target\n\nbody", FrontmatterFormat::Markdown).as_bytes(),
        )
        .unwrap();

        let assert_preserved = |path: &std::path::Path| {
            let content = std::fs::read_to_string(path).unwrap();
            let oxi_frontmatter::Parsed::Memo { table, .. } =
                parse(&content, FrontmatterFormat::Markdown).unwrap()
            else {
                panic!("target must retain frontmatter after rewrite")
            };
            assert_eq!(table.get("id"), Some(&Value::Str(target.id.to_string())));
            assert_eq!(
                table.get("aliases"),
                Some(&Value::Array(vec!["goal".into(), "anchor".into()]))
            );
            assert_eq!(table.get("source"), Some(&Value::Str("migration".into())));
            assert_eq!(table.get("oxios"), Some(&Value::Map(oxios.clone())));
            // Derived-only fields must NOT appear on disk — they are
            // recomputed by read_memo on every read.
            assert!(!table.contains_key("hash"));
            assert!(!table.contains_key("tags"));
        };

        // Initial path (pre-rewrite): the body was "# Target" →
        // "Target.md" at the vault root. We seeded the same path
        // with the hand-crafted v4 file above, so the pre-rename
        // assertion checks that file.
        v.update_note(target.id, Some("# Renamed".into()), None)
            .unwrap();
        // After rename the file lives at Renamed.md.
        let renamed_path = v.paths.vault.join("Renamed.md");
        assert_preserved(&renamed_path);
        // Link propagation must have rewritten [[Target]] → [[Renamed]]
        // in the source note's body during the same update_note call.
        let source_path = v
            .with_redb(|idx| Ok(idx.get(source.id).unwrap().unwrap().path))
            .unwrap();
        let source_content = std::fs::read_to_string(v.paths.vault.join(&source_path)).unwrap();
        assert!(
            source_content.contains("[[Renamed]]"),
            "link propagation must rewrite [[Target]] → [[Renamed]]: {source_content}"
        );
        assert!(
            !source_content.contains("[[Target]]"),
            "old link must be gone: {source_content}"
        );

        v.delete_memo(target.id).unwrap();
        assert_preserved(&v.paths.trash_path("Renamed.md"));

        v.restore_memo(target.id).unwrap();
        assert_preserved(&renamed_path);

        v.move_note(target.id, "folder2").unwrap();
        assert_preserved(&v.paths.vault.join("folder2/Renamed.md"));
    }

    /// `create_note_auto` synthesizes id/created/updated on the file
    /// but must NOT parse the body for frontmatter — the body is taken
    /// verbatim, so a body containing `---` blocks (e.g. literal
    /// markdown separators the user wrote) survives byte-identical.
    #[test]
    fn create_note_auto_keeps_embedded_body() {
        let (_t, v) = tmp_vault();
        let body = "before\n---\nid: embedded\n---\nafter\n";
        let note = v.create_note_auto("", body.into()).unwrap();
        let rel = v
            .with_redb(|idx| Ok(idx.get(note.id).unwrap().unwrap().path))
            .unwrap();
        let content = std::fs::read_to_string(v.paths.vault.join(&rel)).unwrap();
        // Synthesized canonical keys must be present in the file.
        assert!(content.contains("created:"), "missing created: {content}");
        assert!(content.contains("updated:"), "missing updated: {content}");
        // The body (including its embedded `---` markers) must survive
        // verbatim — create never parses user bodies for frontmatter.
        let body_start = content.find("\n---\n").unwrap() + "\n---\n".len();
        let on_disk_body = &content[body_start..];
        assert_eq!(on_disk_body, body, "body must be byte-identical");
    }

    /// Round-1 review finding 1: updating a note whose indexed live
    /// path is gone (trashed) must relocate the file to a live path
    /// carrying the ORIGINAL id + created — never a freshly
    /// synthesized identity.
    #[test]
    fn update_of_trashed_note_preserves_identity() {
        let (_t, v) = tmp_vault();
        let note = v.create_note_auto("", "# Gone\n\nbody".into()).unwrap();
        v.delete_memo(note.id).unwrap();

        let updated = v
            .update_note(note.id, Some("# Back\n\nnew body".into()), None)
            .unwrap();
        // Identity: the id is the caller's handle, unchanged.
        assert_eq!(updated.id, note.id);
        assert_eq!(updated.created_at, note.created_at);

        // On-disk proof: parse the relocated live file and compare
        // id + created against the original memo.
        let path = v.note_file_path(&updated).expect("relocated live file");
        let parsed =
            crate::store::files::FileStore::parse(&std::fs::read_to_string(&path).unwrap())
                .unwrap();
        match parsed {
            crate::store::files::ParsedFile::Memo { fm, .. } => {
                assert_eq!(fm.id, note.id, "file id must be the original");
                assert_eq!(
                    fm.created_at, note.created_at,
                    "file created must be the original"
                );
            }
            crate::store::files::ParsedFile::BodyOnly { .. } => {
                panic!("relocated note must have frontmatter")
            }
        }
    }

    /// Knowledge-system design §5.1: frontmatter properties flow from the
    /// file into the Memo, the index record, and listing summaries — and a
    /// property-only edit changes the sync digest.
    #[test]
    fn props_flow_file_to_index_to_summary_and_hash() {
        let (_t, v) = tmp_vault();
        let note = v.create_note_auto("", "# 오류역전파".into()).unwrap();
        let rel = v
            .with_redb(|idx| Ok(idx.get(note.id).unwrap().unwrap().path))
            .unwrap();
        let abs = v.paths().vault.join(&rel);

        // External edit: add knowledge properties to the frontmatter.
        let raw = std::fs::read_to_string(&abs).unwrap();
        let with_props = raw.replace(
            "---\n",
            "---\nstatus: stub\ndomain: TECH\nsubdomain: [AI]\naliases: [BP, 역전파]\nrelated: [\"[[딥러닝]]\"]\n",
        );
        std::fs::write(&abs, with_props).unwrap();
        v.reindex().unwrap();

        // Memo read-back carries props.
        let memo = v.get_memo(note.id).unwrap();
        assert_eq!(
            memo.props.get("status"),
            Some(&crate::props::PropValue::Str("stub".into()))
        );
        assert_eq!(
            memo.props.get("subdomain"),
            Some(&crate::props::PropValue::List(vec!["AI".into()]))
        );
        // Property-only edit changed the digest (hash covers props).
        assert_ne!(memo.hash, note.hash);
        // Listing summary exposes props without a file read.
        let summaries = v.list_memos(None, 10, Default::default()).unwrap();
        let s = summaries
            .items
            .iter()
            .find(|s| s.id == note.id)
            .expect("note in listing");
        assert_eq!(
            s.props.get("aliases"),
            Some(&crate::props::PropValue::List(vec![
                "BP".into(),
                "역전파".into()
            ]))
        );
    }

    /// Round-1 review finding 4: an update that changes nothing
    /// (identical body + favorite) is a semantic NoOp — the file's
    /// `updated` stays at its old value AND the index record is not
    /// bumped ahead of disk.
    #[test]
    fn update_noop_keeps_file_and_index_updated() {
        let (_t, v) = tmp_vault();
        let note = v.create_note_auto("", "# Stable\n\nbody".into()).unwrap();

        // Snapshot disk + index before the NoOp update.
        let rel = v
            .with_redb(|idx| Ok(idx.get(note.id).unwrap().unwrap().path))
            .unwrap();
        let file_before = std::fs::read_to_string(v.paths.vault.join(&rel)).unwrap();
        let idx_updated_before = v
            .with_redb(|idx| Ok(idx.get(note.id).unwrap().unwrap().updated_at))
            .unwrap();

        let updated = v
            .update_note(note.id, Some("# Stable\n\nbody".into()), None)
            .unwrap();
        // The returned memo reports the file's truth, not a phantom bump.
        assert_eq!(updated.updated_at, note.updated_at);

        // Disk: byte-identical file (NoOp never rewrote it).
        let file_after = std::fs::read_to_string(v.paths.vault.join(&rel)).unwrap();
        assert_eq!(file_before, file_after, "NoOp must not rewrite the file");

        // Index: record's updated_at unchanged.
        let idx_updated_after = v
            .with_redb(|idx| Ok(idx.get(note.id).unwrap().unwrap().updated_at))
            .unwrap();
        assert_eq!(
            idx_updated_before, idx_updated_after,
            "NoOp must not bump the index ahead of disk"
        );
    }

    #[test]
    fn section_setters_roundtrip_and_removed_fields_still_parse() {
        let (dir, v) = tmp_vault();

        let brain = crate::config::BrainConfig {
            enabled: false,
            socket: "/tmp/other.sock".into(),
            space: "work".into(),
        };
        v.set_brain_config(brain.clone()).unwrap();
        v.set_general_config(crate::config::GeneralConfig {
            trash_retention_days: 7,
        })
        .unwrap();
        v.set_capture_config(crate::config::CaptureConfig {
            double_tap_threshold_ms: 500,
            overlay_max_height: 320,
        })
        .unwrap();
        v.set_index_config(crate::config::IndexConfig {
            watcher_debounce_ms: 120,
        })
        .unwrap();

        // Reload from disk: every section persisted.
        let re = Vault::open(Some(dir.path())).unwrap();
        re.with_config(|c| {
            assert_eq!(c.brain, brain);
            assert_eq!(c.general.trash_retention_days, 7);
            assert_eq!(c.capture.double_tap_threshold_ms, 500);
            assert_eq!(c.index.watcher_debounce_ms, 120);
        });

        // A config written before the retry fields were removed still parses
        // (unknown fields are ignored).
        let legacy = r#"
[index]
watcher_debounce_ms = 300
watcher_retry_count = 2
watcher_retry_interval_ms = 200
"#;
        let parsed: crate::config::VaultConfig = toml::from_str(legacy).unwrap();
        assert_eq!(parsed.index.watcher_debounce_ms, 300);
    }

    #[test]
    fn create_get_update_delete_restore() {
        let (_t, v) = tmp_vault();
        let n = v.create_memo("hello world".into(), None).unwrap();
        let got = v.get_memo(n.id).unwrap();
        assert_eq!(got.body, "hello world");

        let updated = v
            .update_memo(n.id, Some("edited".into()), Some(true), None)
            .unwrap();
        assert!(updated.favorite);
        assert_ne!(updated.hash, n.hash);

        v.delete_memo(n.id).unwrap();
        let trashed = v.get_memo(n.id).unwrap();
        assert!(trashed.deleted_at.is_some());

        v.restore_memo(n.id).unwrap();
        assert!(v.get_memo(n.id).unwrap().deleted_at.is_none());
    }

    #[test]
    fn list_folders_includes_empty_directories() {
        let (_t, v) = tmp_vault();
        v.create_memo("root note".into(), None).unwrap();
        v.create_note(
            "novel",
            "in folder".into(),
            crate::memo::NoteFormat::Markdown,
        )
        .unwrap();
        // Empty folder: created but holding no notes yet — must still be
        // listed so the UI can show and manage it.
        std::fs::create_dir_all(v.paths().vault.join("ideas/empty")).unwrap();

        let rows = v.list_folders().unwrap();
        let get = |p: &str| rows.iter().find(|(k, _)| k == p).map(|(_, c)| *c);
        assert_eq!(get(""), Some(1), "loose root notes counted");
        assert_eq!(get("novel"), Some(1));
        assert_eq!(get("ideas/empty"), Some(0), "empty dir listed with count 0");
    }

    #[test]
    fn folder_children_counts_recursively_and_peeks_recents() {
        let (_t, v) = tmp_vault();
        let a = v
            .create_note(
                "novel/act1",
                "# Chapter One".into(),
                crate::memo::NoteFormat::Markdown,
            )
            .unwrap();
        v.create_note(
            "novel/act1",
            "# Chapter Two".into(),
            crate::memo::NoteFormat::Markdown,
        )
        .unwrap();
        v.create_memo("# Loose".into(), None).unwrap();
        v.create_folder("empty").unwrap();

        let root = v.folder_children("").unwrap();
        let novel = root.iter().find(|c| c.path == "novel").unwrap();
        assert_eq!(
            (
                novel.note_count,
                novel.note_count_deep,
                novel.subfolder_count
            ),
            (0, 2, 1)
        );
        assert_eq!(novel.recent.len(), 2);
        assert_eq!(novel.recent[0].title.as_deref(), Some("Chapter Two"));

        let act1 = v.folder_children("novel").unwrap();
        assert_eq!(act1.len(), 1);
        assert_eq!(act1[0].path, "novel/act1");
        assert_eq!((act1[0].note_count, act1[0].note_count_deep), (2, 2));
        assert!(
            v.folder_children("")
                .unwrap()
                .iter()
                .any(|c| c.path == "empty" && c.recent.is_empty())
        );
        let _ = a;
    }

    #[test]
    fn list_and_search() {
        let (_t, v) = tmp_vault();
        v.create_memo("rust async runtime".into(), None).unwrap();
        v.create_memo("go goroutines".into(), None).unwrap();
        let page = v.list_memos(None, 10, MemoFilter::default()).unwrap();
        assert_eq!(page.items.len(), 2);
        let hits = v.search_memos("rust", 10).unwrap();
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn list_notes_next_cursor_roundtrips_as_string() {
        // The Tauri `list_memos(after: Option<String>)` command and the
        // frontend's cursor pagination both treat `next_cursor` as a JSON
        // *string* that `Cursor::parse(&str)` can read back. This locks that
        // contract: a non-null cursor must be a string and must round-trip.
        let (_t, v) = tmp_vault();
        v.create_memo("first note".into(), None).unwrap();
        v.create_memo("second note".into(), None).unwrap();

        // limit below the count forces a non-null cursor on page 1.
        let page = v.list_memos(None, 1, MemoFilter::default()).unwrap();
        assert_eq!(page.items.len(), 1);
        let cursor = page.next_cursor.expect("page 1 must carry a next cursor");
        assert!(
            cursor.starts_with('{'),
            "next_cursor must be a JSON object string, got: {cursor}"
        );

        let parsed = Cursor::parse(&cursor).expect("cursor must round-trip via Cursor::parse");
        let page2 = v
            .list_memos(Some(parsed), 10, MemoFilter::default())
            .unwrap();
        assert_eq!(
            page2.items.len(),
            1,
            "page 2 must return the remaining note"
        );
        // The cursor on page 2 still points past its last item; the pagination
        // terminator is the NEXT fetch returning an empty page with no cursor.
        let c2 = page2.next_cursor.expect("page 2 carries a cursor");
        let page3 = v
            .list_memos(Some(Cursor::parse(&c2).unwrap()), 10, MemoFilter::default())
            .unwrap();
        assert!(page3.items.is_empty(), "page 3 must be empty");
        assert!(
            page3.next_cursor.is_none(),
            "empty page must carry no cursor"
        );
    }

    #[test]
    fn export_manifest_and_full_roundtrip() {
        let (_t, v) = tmp_vault();
        let n = v.create_memo("body text".into(), None).unwrap();
        let manifest = v.export_manifest(None).unwrap();
        assert_eq!(manifest.len(), 1);
        let full = v.export_full(&[n.id]).unwrap();
        assert_eq!(full[0].body, "body text");
    }

    #[test]
    fn manifest_recomputes_hash_at_walk() {
        let (_t, v) = tmp_vault();
        let n = v
            .create_memo("# Title\n\noriginal body".into(), None)
            .unwrap();
        // Hand-edit the body externally: the index still holds the
        // pre-edit digest, so the manifest must recompute from the file.
        let rel = v
            .with_redb(|idx| Ok(idx.get(n.id).unwrap().expect("indexed").path))
            .unwrap();
        let abs = v.paths.vault.join(&rel);
        let edited = std::fs::read_to_string(&abs)
            .unwrap()
            .replace("original body", "hand-edited body");
        std::fs::write(&abs, &edited).unwrap();

        let manifest = v.export_manifest(None).unwrap();
        let rec = manifest.iter().find(|m| m.id == n.id).expect("in manifest");
        let on_disk = v.files.read_memo(&abs).unwrap().expect("parses");
        assert_eq!(
            rec.hash, on_disk.hash,
            "manifest hash must reflect the current body"
        );
        let indexed = v
            .with_redb(|idx| Ok(idx.get(n.id).unwrap().expect("indexed").hash))
            .unwrap();
        assert_ne!(
            rec.hash, indexed,
            "manifest must not serve the stale index digest"
        );
    }

    #[test]
    fn doctor_never_rewrites_on_hash_mismatch() {
        let (_t, v) = tmp_vault();
        let n = v
            .create_memo("# Doctor\n\nstable body".into(), None)
            .unwrap();
        let rel = v
            .with_redb(|idx| Ok(idx.get(n.id).unwrap().expect("indexed").path))
            .unwrap();
        let abs = v.paths.vault.join(&rel);
        // Drift the file from the index by editing the body externally —
        // the classic "stored hash mismatch" scenario.
        let edited = std::fs::read_to_string(&abs)
            .unwrap()
            .replace("stable body", "externally edited");
        std::fs::write(&abs, &edited).unwrap();

        let report = v.doctor(true).unwrap();
        // Hashes are derived from body+favorite and recomputed on read;
        // there is no stored digest to mismatch against.
        assert!(report.hash_mismatches.is_empty());
        assert_eq!(report.hash_repair_failed, 0);
        assert!(report.orphan_files.is_empty());
        assert!(report.orphan_index_records.is_empty());
        assert!(report.corrupt_frontmatter.is_empty());
        // Structure-only report: `doctor --fix` leaves the externally
        // edited file byte-identical (no rewrite).
        assert_eq!(std::fs::read_to_string(&abs).unwrap(), edited);
    }

    #[test]
    fn reindex_is_idempotent() {
        let (_t, v) = tmp_vault();
        v.create_memo("one".into(), None).unwrap();
        let s1 = v.reindex().unwrap();
        let s2 = v.reindex().unwrap();
        assert_eq!(s2.added, 0);
        assert!(s2.unchanged >= 1);
        let _ = s1;
    }
    #[test]
    fn derived_tags_from_body_end_to_end() {
        let (_t, v) = tmp_vault();
        let n = v.create_memo("회의록 #work #urgent".into(), None).unwrap();
        let got = v.get_memo(n.id).unwrap();
        // Tags are derived from the body, normalized + lowercased.
        assert_eq!(got.tags, vec!["work", "urgent"]);

        // include filter (AND) matches a memo carrying the tag.
        let inc = v
            .list_memos(
                None,
                10,
                MemoFilter {
                    include_tags: vec!["work".into()],
                    match_all: true,
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(inc.items.len(), 1);

        // exclude removes the memo that also carries the excluded tag.
        let exc = v
            .list_memos(
                None,
                10,
                MemoFilter {
                    include_tags: vec!["work".into()],
                    exclude_tags: vec!["urgent".into()],
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(exc.items.is_empty());

        // facets aggregate derived tags over the vault.
        let facets = v.list_facets().unwrap();
        assert_eq!(
            facets
                .tags
                .iter()
                .find(|(t, _)| t == "work")
                .map(|(_, c)| *c),
            Some(1)
        );
        assert_eq!(
            facets
                .tags
                .iter()
                .find(|(t, _)| t == "urgent")
                .map(|(_, c)| *c),
            Some(1)
        );
    }

    #[test]
    fn folder_create_delete() {
        let (_t, v) = tmp_vault();
        v.ensure_initialized().unwrap();
        v.create_folder("novel").unwrap();
        assert!(v.paths.vault.join("novel").exists());
        // Cannot delete root.
        assert!(v.delete_folder("").is_err());
        // Empty folder can be deleted.
        v.delete_folder("novel").unwrap();
        assert!(!v.paths.vault.join("novel").exists());
    }

    #[test]
    fn create_folder_rejects_existing_directory() {
        // Pre-existing folder at the same path must NOT silently succeed
        // — the UI's optimistic folder-create flow would otherwise
        // attach a naming session to a pre-existing folder and the
        // empty-commit teardown would trash whatever lived there.
        let (_t, v) = tmp_vault();
        v.ensure_initialized().unwrap();
        std::fs::create_dir_all(v.paths.vault.join("existing")).unwrap();
        let err = v.create_folder("existing").unwrap_err();
        let msg = format!("{err}");
        assert!(
            msg.contains("already exists"),
            "error must mention 'already exists', got: {msg}"
        );
        // Root always exists; creating "" must now error too rather
        // than silently no-op.
        assert!(v.create_folder("").is_err());
    }

    #[test]
    fn delete_folder_prunes_pinned_config_entries() {
        // Pin a folder, create a child, pin it too, then delete the
        // parent. The sidebar reads `Config.folders` directly, so any
        // stale entry shows up as a "ghost" pin row pointing at a path
        // that no longer exists. The delete must prune both the exact
        // entry and any descendants in one config write.
        let (_t, v) = tmp_vault();
        v.ensure_initialized().unwrap();
        v.create_folder("parent").unwrap();
        v.create_folder("parent/child").unwrap();
        v.set_folder_pinned("parent", true).unwrap();
        v.set_folder_pinned("parent/child", true).unwrap();
        // Sibling at root must survive.
        v.create_folder("sibling").unwrap();
        v.set_folder_pinned("sibling", true).unwrap();

        v.delete_folder("parent").unwrap();

        let cfg = v.folders();
        let paths: Vec<&str> = cfg.iter().map(|f| f.path.as_str()).collect();
        assert!(
            !paths.contains(&"parent"),
            "exact entry for deleted folder must be pruned: {paths:?}"
        );
        assert!(
            !paths.contains(&"parent/child"),
            "descendant entries under deleted folder must be pruned: {paths:?}"
        );
        assert!(
            paths.contains(&"sibling"),
            "unrelated sibling pin must survive: {paths:?}"
        );
    }

    #[test]
    fn delete_folder_trashes_then_restores() {
        let (_t, v) = tmp_vault();
        let a = v
            .create_note(
                "doomed",
                "# one\n\nbody".into(),
                crate::memo::NoteFormat::Markdown,
            )
            .unwrap();
        let b = v
            .create_note(
                "doomed",
                "# two\n\nbody".into(),
                crate::memo::NoteFormat::Markdown,
            )
            .unwrap();
        let ids = v.delete_folder("doomed").unwrap();
        assert_eq!(ids.len(), 2);
        assert!(!v.paths.vault.join("doomed").exists());
        assert!(v.get_memo(a.id).unwrap().deleted_at.is_some());
        let back = v.restore_notes(&[a.id, b.id]).unwrap();
        assert_eq!(back.len(), 2);
        assert!(v.paths.vault.join("doomed").is_dir()); // restore recreates parents
        assert!(v.get_memo(a.id).unwrap().deleted_at.is_none());
    }

    #[test]
    fn note_title_derives_filename() {
        let (_t, v) = tmp_vault();
        v.ensure_initialized().unwrap();
        v.create_folder("novel").unwrap();
        let n = v
            .create_note(
                "novel",
                "# 첫 번째 장\n\n본문".into(),
                crate::memo::NoteFormat::Markdown,
            )
            .unwrap();
        let got = v.get_memo(n.id).unwrap();
        assert_eq!(got.body, "# 첫 번째 장\n\n본문");
        // The file should be named from the title.
        let files: Vec<_> = std::fs::read_dir(v.paths.vault.join("novel"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(
            files.iter().any(|f| f.contains("첫-번째-장")),
            "files: {files:?}"
        );
    }

    #[test]
    fn untitled_note_uses_timestamp_filename() {
        let (_t, v) = tmp_vault();
        let n = v
            .create_note(
                "",
                "just a quick memo".into(),
                crate::memo::NoteFormat::Markdown,
            )
            .unwrap();
        // No H1 → timestamp filename at vault root.
        let files: Vec<_> = std::fs::read_dir(&v.paths.vault)
            .unwrap()
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                if name.ends_with(".md") {
                    Some(name)
                } else {
                    None
                }
            })
            .collect();
        assert!(
            files.iter().any(|f| f.len() >= "2026-08-13-143052.md".len()
                && f.chars().filter(|c| c.is_ascii_digit()).count() >= 10),
            "expected timestamp filename, got: {files:?}"
        );
        let _ = n;
    }

    #[test]
    fn update_renames_on_title_change() {
        let (_t, v) = tmp_vault();
        let n = v
            .create_note(
                "",
                "# Old Title\nbody".into(),
                crate::memo::NoteFormat::Markdown,
            )
            .unwrap();
        v.update_note(n.id, Some("# New Title\nbody".into()), None)
            .unwrap();
        let files: Vec<_> = std::fs::read_dir(&v.paths.vault)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(
            files.iter().any(|f| f.contains("New-Title")),
            "files: {files:?}"
        );
        assert!(
            !files.iter().any(|f| f.contains("Old-Title")),
            "files: {files:?}"
        );
    }

    #[test]
    fn folder_filter_in_listing() {
        let (_t, v) = tmp_vault();
        v.ensure_initialized().unwrap();
        v.create_folder("novel").unwrap();
        v.create_note(
            "novel",
            "# Chapter 1".into(),
            crate::memo::NoteFormat::Markdown,
        )
        .unwrap();
        v.create_note("", "quick note".into(), crate::memo::NoteFormat::Markdown)
            .unwrap();
        let all = v.list_memos(None, 10, MemoFilter::default()).unwrap();
        assert_eq!(all.items.len(), 2);
        let novel = v
            .list_memos(
                None,
                10,
                MemoFilter {
                    folder: Some("novel".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(novel.items.len(), 1);
    }

    #[test]
    fn reset_clears_notes_and_indexes() {
        let (_t, v) = tmp_vault();
        v.create_note("", "one".into(), crate::memo::NoteFormat::Markdown)
            .unwrap();
        v.create_note("", "two".into(), crate::memo::NoteFormat::Markdown)
            .unwrap();
        assert_eq!(v.memo_stats().unwrap().memos, 2);
        v.reset().unwrap();
        assert_eq!(v.memo_stats().unwrap().memos, 0);
        v.create_note("", "three".into(), crate::memo::NoteFormat::Markdown)
            .unwrap();
        assert_eq!(v.memo_stats().unwrap().memos, 1);
    }

    #[test]
    fn reset_clears_memos_and_indexes() {
        let (_t, v) = tmp_vault();
        v.create_memo("one".into(), None).unwrap();
        v.create_memo("two".into(), None).unwrap();
        assert_eq!(v.memo_stats().unwrap().memos, 2);
        v.reset().unwrap();
        // Live memos + derived indexes are gone; the vault stays usable.
        assert_eq!(v.memo_stats().unwrap().memos, 0);
        v.create_memo("three".into(), None).unwrap();
        assert_eq!(v.memo_stats().unwrap().memos, 1);
    }

    #[test]
    fn asset_save_dedup_read_list() {
        let (_t, v) = tmp_vault();
        let bytes = [1u8, 2, 3, 4, 5];
        let r = v.save_asset(&bytes, "PNG").unwrap();
        // Canonical scheme: name in the path, host is localhost.
        assert_eq!(r.url, format!("oximg://localhost/{}", r.name));
        assert!(r.name.ends_with(".png"));
        // Dedup: identical bytes → identical name, no second file.
        let r2 = v.save_asset(&bytes, "png").unwrap();
        assert_eq!(r.name, r2.name);
        // read_asset returns the bytes + mime.
        let (got, mime) = v.read_asset(&r.name).unwrap();
        assert_eq!(got, bytes);
        assert_eq!(mime, "image/png");
        // list_assets surfaces it.
        let list = v.list_assets().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, r.name);
    }

    #[test]
    fn asset_gc_removes_orphans_keeps_referenced() {
        let (_t, v) = tmp_vault();
        // Referenced: memo body cites this asset.
        let referenced = v.save_asset(&[1, 2, 3], "png").unwrap();
        v.create_memo(format!("see ![]({})", referenced.url), None)
            .unwrap();
        // Orphan: saved but never cited.
        let orphan = v.save_asset(&[9, 9, 9], "gif").unwrap();
        assert_eq!(v.list_assets().unwrap().len(), 2);

        let removed = v.gc_assets().unwrap();
        assert_eq!(removed, 1);
        assert!(v.read_asset(&referenced.name).is_some());
        assert!(v.read_asset(&orphan.name).is_none());
    }

    #[test]
    fn read_asset_rejects_traversal() {
        let (_t, v) = tmp_vault();
        // Malformed names must never reach the filesystem.
        assert!(v.read_asset("../../etc/passwd").is_none());
        assert!(v.read_asset("deadbeefdeadbeef.exe").is_none());
    }

    #[test]
    fn graph_data_builds_nodes_and_edges() {
        let (_t, v) = tmp_vault();
        let a = v
            .create_note(
                "",
                "# Alpha\n\nLinks to [[Beta]]".into(),
                crate::memo::NoteFormat::Markdown,
            )
            .unwrap();
        let b = v
            .create_note(
                "",
                "# Beta\n\nLinks back to [[Alpha]]".into(),
                crate::memo::NoteFormat::Markdown,
            )
            .unwrap();
        let g = v.graph_data().unwrap();
        // Two nodes, two edges (A→B and B→A).
        assert_eq!(g.nodes.len(), 2);
        assert_eq!(g.edges.len(), 2);
        // Each node has 1 connection.
        for n in &g.nodes {
            assert_eq!(
                n.connections, 1,
                "node {} should have 1 connection",
                n.title
            );
        }
        // Edge source/target are correct.
        assert!(
            g.edges
                .iter()
                .any(|e| e.source == a.id.to_string() && e.target == b.id.to_string())
        );
        assert!(
            g.edges
                .iter()
                .any(|e| e.source == b.id.to_string() && e.target == a.id.to_string())
        );
    }

    #[test]
    fn set_pin_order_roundtrip() {
        let (_t, v) = tmp_vault();
        v.set_folder_pinned("novel", true).unwrap();
        v.set_folder_pinned("work", true).unwrap();
        v.set_folder_pinned("daily", true).unwrap();
        v.set_pin_order(&["daily".into(), "novel".into(), "work".into()])
            .unwrap();
        let pinned: Vec<String> = v
            .with_config(|c| {
                c.folders
                    .items
                    .iter()
                    .filter(|f| f.pinned == Some(true))
                    .map(|f| f.path.clone())
                    .collect()
            });
        assert_eq!(pinned, vec!["daily", "novel", "work"]);
        // Non-permutation (unknown path) errors.
        assert!(v.set_pin_order(&["daily".into(), "ghost".into()]).is_err());
    }

    #[test]
    fn rename_tag_rewrites_bodies() {
        let (_t, v) = tmp_vault();
        let a = v.create_memo("#악보 첫줄".into(), None).unwrap();
        let b = v.create_memo("코드 C#m7 아님 #Tag".into(), None).unwrap();
        let c = v.create_memo("무관".into(), None).unwrap();
        let n = v.rename_tag("악보", "보고").unwrap();
        assert_eq!(n, 1);
        assert_eq!(v.get_memo(a.id).unwrap().body, "#보고 첫줄");
        assert_eq!(v.get_memo(b.id).unwrap().body, "코드 C#m7 아님 #Tag");
        assert_eq!(v.get_memo(c.id).unwrap().body, "무관");
        // Same-tag rename is a no-op; empty new tag errors.
        assert_eq!(v.rename_tag("보고", "보고").unwrap(), 0);
        assert!(v.rename_tag("보고", "").is_err());
    }

    #[test]
    fn graph_data_excludes_deleted_and_self_loops() {
        let (_t, v) = tmp_vault();
        let a = v
            .create_note(
                "",
                "# Solo\n\nSelf ref [[Solo]]".into(),
                crate::memo::NoteFormat::Markdown,
            )
            .unwrap();
        v.create_note(
            "",
            "# Ghost\n\nLinks [[Solo]]".into(),
            crate::memo::NoteFormat::Markdown,
        )
        .unwrap();
        // Delete the ghost.
        let page = v.list_memos(None, 10, MemoFilter::default()).unwrap();
        let ghost = page
            .items
            .iter()
            .find(|s| s.title.as_deref() == Some("Ghost"))
            .unwrap();
        v.delete_memo(ghost.id).unwrap();
        let g = v.graph_data().unwrap();
        // Only Solo remains; no self-loop edge.
        assert_eq!(g.nodes.len(), 1);
        assert_eq!(g.edges.len(), 0);
        let _ = a;
    }

    #[test]
    fn config_json_flattens_folders() {
        let (_t, v) = tmp_vault();
        let json = v.config_json();
        // folders should be a plain array, not { items: [...] }
        assert!(json["folders"].is_array());
        assert_eq!(json["schema_version"], 3);
    }

    #[test]
    fn set_folder_pinned_roundtrip() {
        let (_t, v) = tmp_vault();
        v.set_folder_pinned("novel", true).unwrap();
        assert_eq!(
            v.with_config(|c| c
                .folders
                .items
                .iter()
                .find(|f| f.path == "novel")
                .and_then(|f| f.pinned)),
            Some(true)
        );
        // Unpin with nothing else set → entry dropped (clean config).
        v.set_folder_pinned("novel", false).unwrap();
        assert!(v.with_config(|c| c.folders.items.iter().all(|f| f.path != "novel")));
    }
    #[test]
    fn set_folder_view_persists_and_unlocks() {
        let (_t, v) = tmp_vault();
        // Lock a folder to list view.
        v.set_folder_view("novel", Some(crate::config::ViewMode::List))
            .unwrap();
        let json = v.config_json();
        let folders = json["folders"].as_array().unwrap();
        let novel = folders.iter().find(|f| f["path"] == "novel").unwrap();
        assert_eq!(novel["view"], "list");

        // Unlock: view removed.
        v.set_folder_view("novel", None).unwrap();
        let json2 = v.config_json();
        let folders2 = json2["folders"].as_array().unwrap();
        assert!(folders2.iter().all(|f| f["path"] != "novel"));
    }

    #[test]
    fn move_note_changes_folder() {
        let (_t, v) = tmp_vault();
        v.create_folder("work").unwrap();
        let n = v
            .create_note(
                "",
                "# Project\n\nbody".into(),
                crate::memo::NoteFormat::Markdown,
            )
            .unwrap();
        // Initially at root.
        let page = v.list_memos(None, 10, MemoFilter::default()).unwrap();
        assert_eq!(page.items[0].path, "Project.md");

        // Move to work/.
        v.move_note(n.id, "work").unwrap();
        let page2 = v.list_memos(None, 10, MemoFilter::default()).unwrap();
        assert_eq!(page2.items[0].path, "work/Project.md");

        // Old file is gone.
        assert!(!v.paths().vault.join("Project.md").exists());
        assert!(v.paths().vault.join("work/Project.md").exists());
    }
    #[test]
    fn rename_folder_moves_files_index_and_config() {
        let (_t, v) = tmp_vault();
        let n = v
            .create_note(
                "novel",
                "# Old Home\n\nbody".into(),
                crate::memo::NoteFormat::Markdown,
            )
            .unwrap();
        v.set_folder_pinned("novel", true).unwrap();
        v.rename_folder("novel", "book").unwrap();
        // Disk: novel/ gone, book/ exists, memo file under book/.
        assert!(!v.paths().vault.join("novel").exists());
        assert!(v.paths().vault.join("book").exists());
        assert!(v.paths().vault.join("book/Old-Home.md").exists());
        // Index: record path rewritten.
        let rec = v.with_redb(|idx| idx.get(n.id)).unwrap().unwrap();
        assert_eq!(rec.path, "book/Old-Home.md");
        // Config: novel entry moved to book with pinned preserved.
        assert!(v.with_config(|c| {
            c.folders
                .items
                .iter()
                .any(|f| f.path == "book" && f.pinned == Some(true))
        }));
        assert!(v.with_config(|c| c.folders.items.iter().all(|f| f.path != "novel")));
        // Target must not already exist.
        v.create_folder("other").unwrap();
        assert!(v.rename_folder("book", "other").is_err());
    }

    #[test]
    fn move_folder_moves_subtree_and_rejects_cycles() {
        let (_t, v) = tmp_vault();
        v.create_folder("work/client").unwrap();
        v.create_note(
            "work/report",
            "# Report\n\nbody".into(),
            crate::memo::NoteFormat::Markdown,
        )
        .unwrap();
        v.create_folder("archive").unwrap();
        v.set_folder_pinned("work/client", true).unwrap();

        // Move work → archive/work: subtree and notes follow, pins
        // re-path (rename core).
        v.move_folder("work", "archive").unwrap();
        assert!(v.paths().vault.join("archive/work/client").is_dir());
        assert!(v.paths().vault.join("archive/work/report").is_dir());
        assert!(!v.paths().vault.join("work").exists());
        assert!(v.with_config(|c| {
            c.folders
                .items
                .iter()
                .any(|f| f.path == "archive/work/client" && f.pinned == Some(true))
        }));

        // Cycle: move a folder into itself or a descendant.
        assert!(v.move_folder("archive", "archive/work").is_err());
        assert!(v.move_folder("archive", "archive").is_err());

        // No-op: drop onto the current parent.
        v.move_folder("archive/work", "archive").unwrap();
        assert!(v.paths().vault.join("archive/work/client").is_dir());

        // Collision: destination already has that basename.
        v.create_folder("work").unwrap();
        assert!(v.move_folder("archive/work", "").is_err());

        // Root is not movable.
        assert!(v.move_folder("", "archive").is_err());
    }

    #[test]
    fn rename_folder_repaths_tombstones() {
        let (_t, v) = tmp_vault();
        let n = v
            .create_note(
                "novel",
                "# Ghost\n\nbody".into(),
                crate::memo::NoteFormat::Markdown,
            )
            .unwrap();
        // Soft-delete: file moves to .trash/novel/Ghost.md, record stays
        // as `novel/Ghost.md` with `deleted: true`.
        v.delete_memo(n.id).unwrap();
        // Rename moves the live tree AND the matching trash subtree so
        // tombstone files stay aligned with their re-pathed index
        // records. Without the trash move, restore_memo finds no
        // `.trash/book/Ghost.md` and silently no-ops; the stale
        // `.trash/novel/...` copy leaks and a later purge deletes the
        // (possibly restored+live) note's index/search records.
        v.rename_folder("novel", "book").unwrap();
        // Record is re-pathed to the new prefix; tombstone stays deleted.
        let rec = v.with_redb(|idx| idx.get(n.id)).unwrap().unwrap();
        assert!(rec.deleted, "tombstone stays deleted after rename");
        assert_eq!(
            rec.path, "book/Ghost.md",
            "tombstone record re-pathed under the new prefix"
        );
        // Trash subtree moved with the rename: file now under the new
        // trash path, old trash dir is gone.
        assert!(
            v.paths().trash_path("book/Ghost.md").exists(),
            "tombstone file moved to .trash/<to>/..."
        );
        assert!(
            !v.paths().trash_path("novel").exists(),
            "old .trash/<from>/ subtree is gone"
        );
        // restore_memo must find the trash file at the re-pathed location
        // and bring the note back live at vault/<to>/Ghost.md.
        let restored = v.restore_memo(n.id).unwrap();
        assert!(restored.deleted_at.is_none(), "deleted_at cleared");
        assert!(
            v.paths().vault.join("book/Ghost.md").exists(),
            "note restored to live tree under new folder"
        );
        assert!(
            !v.paths().trash_path("book/Ghost.md").exists(),
            "trash file is gone after restore"
        );
    }
    #[test]
    fn rename_folder_fails_fast_on_trash_collision() {
        let (_t, v) = tmp_vault();
        // Seed a tombstone under the rename TARGET so `.trash/<to>/`
        // already exists non-empty before the rename fires. Reachable
        // path: user has a folder named `other`, creates a note, deletes
        // it (file → `.trash/other/...`), then deletes the now-empty
        // folder — the trash file leaks behind. Renaming `novel → other`
        // must fail BEFORE any fs mutation; otherwise the live tree
        // rename would succeed but the trash subtree rename would hit
        // ENOTEMPTY, leaving from_dir gone and unretryable.
        v.create_folder("other").unwrap();
        let leaked = v
            .create_note(
                "other",
                "# Leak\n\nbody".into(),
                crate::memo::NoteFormat::Markdown,
            )
            .unwrap();
        v.delete_memo(leaked.id).unwrap();
        v.delete_folder("other").unwrap();
        assert!(
            v.paths().trash_path("other/Leak.md").exists(),
            "seeded leak: trash file present, live folder gone"
        );
        // Seed the rename source: live folder + pin + a tombstone under
        // `novel`. The tombstone is required — without it `trash_from`
        // is absent and the trash-rename silently no-ops (no collision),
        // which would mask the bug. Real users routinely have trashed
        // notes in any active folder.
        v.create_folder("novel").unwrap();
        let pinned = v
            .create_note(
                "novel",
                "# Keep\n\nbody".into(),
                crate::memo::NoteFormat::Markdown,
            )
            .unwrap();
        v.set_folder_pinned("novel", true).unwrap();
        let from_trash = v
            .create_note(
                "novel",
                "# FromTrash\n\nbody".into(),
                crate::memo::NoteFormat::Markdown,
            )
            .unwrap();
        v.delete_memo(from_trash.id).unwrap();
        assert!(
            v.paths().trash_path("novel/FromTrash.md").exists(),
            "seeded trash under source folder"
        );
        // Rename must Err BEFORE moving anything.
        let err = v.rename_folder("novel", "other").unwrap_err();
        assert!(
            err.to_string().contains("trashed notes under 'other'"),
            "error mentions the trash collision; got: {err}"
        );
        // Source tree still intact: live folder, its note, its pin,
        // and its trash subtree (the rename never reached the fs stage).
        assert!(v.paths().vault.join("novel").exists(), "live tree intact");
        assert!(
            v.paths().vault.join("novel/Keep.md").exists(),
            "source note intact"
        );
        assert!(
            v.paths().trash_path("novel/FromTrash.md").exists(),
            "source trash subtree not touched by the failed rename"
        );
        assert!(
            v.with_config(|c| c
                .folders
                .items
                .iter()
                .any(|f| f.path == "novel" && f.pinned == Some(true))),
            "config pin untouched"
        );
        // Pre-existing leak still parked at the same trash path.
        assert!(
            v.paths().trash_path("other/Leak.md").exists(),
            "pre-existing leak still in place"
        );
        let _ = pinned;
    }
    #[test]
    fn rename_folder_succeeds_when_trash_target_is_empty() {
        // Mirrors the previous test but the pre-existing trash directory
        // is EMPTY (purge removed the file but never pruned the dir — no
        // code path does). The guard must treat this as NOT a collision
        // (POSIX rename(2) atomically replaces an empty destination) and
        // the rename proceeds; the moved trash subtree lands inside the
        // empty target dir.
        let (_t, v) = tmp_vault();
        v.create_folder("other").unwrap();
        let leaked = v
            .create_note(
                "other",
                "# Leak\n\nbody".into(),
                crate::memo::NoteFormat::Markdown,
            )
            .unwrap();
        v.delete_memo(leaked.id).unwrap();
        v.delete_folder("other").unwrap();
        // Manually prune the trashed file (purge does this) but leave
        // the parent directory empty — that's the bug scenario.
        std::fs::remove_file(v.paths().trash_path("other/Leak.md")).unwrap();
        assert!(
            v.paths().trash_path("other").is_dir(),
            "empty .trash/other/ left behind"
        );
        assert!(
            !trash_to_is_nonempty(&v.paths().trash_path("other")),
            "guard's emptiness check sees an empty dir"
        );
        // Seed rename source with a tombstone under it so the trash
        // rename actually fires.
        v.create_folder("novel").unwrap();
        let note = v
            .create_note(
                "novel",
                "# FromTrash\n\nbody".into(),
                crate::memo::NoteFormat::Markdown,
            )
            .unwrap();
        v.delete_memo(note.id).unwrap();
        // Rename must succeed despite the pre-existing empty trash dir.
        v.rename_folder("novel", "other").unwrap();
        // Live tree moved.
        assert!(v.paths().vault.join("other").exists());
        assert!(!v.paths().vault.join("novel").exists());
        // Trash subtree landed inside the previously-empty target dir;
        // the empty-dir entry survived as the parent of the new subtree.
        assert!(v.paths().trash_path("other/FromTrash.md").exists());
        assert!(!v.paths().trash_path("novel").exists());
    }

    #[test]
    fn get_backlinks_finds_linking_notes() {
        let (_t, v) = tmp_vault();
        let target = v
            .create_note(
                "",
                "# Target\n\nHello".into(),
                crate::memo::NoteFormat::Markdown,
            )
            .unwrap();
        v.create_note(
            "",
            "# Source A\n\nSee [[Target]] for details".into(),
            crate::memo::NoteFormat::Markdown,
        )
        .unwrap();
        v.create_note(
            "",
            "# Source B\n\nAlso references [[Target|the target]]".into(),
            crate::memo::NoteFormat::Markdown,
        )
        .unwrap();
        v.create_note(
            "",
            "# Unrelated\n\nNo links here".into(),
            crate::memo::NoteFormat::Markdown,
        )
        .unwrap();

        let backlinks = v.get_backlinks(target.id).unwrap();
        assert_eq!(backlinks.len(), 2, "should find 2 linking notes");
        let titles: Vec<&str> = backlinks.iter().map(|b| b.title.as_str()).collect();
        assert!(titles.contains(&"Source A"));
        assert!(titles.contains(&"Source B"));
    }

    #[test]
    fn update_note_with_sets_and_removes_props() {
        let (_t, v) = tmp_vault();
        let note = v
            .create_note("", "# Props\n\nbody".into(), crate::memo::NoteFormat::Markdown)
            .unwrap();

        let updated = v
            .update_note_with(
                note.id,
                None,
                None,
                Some(crate::props::PropMutation {
                    sets: vec![
                        ("status".into(), crate::props::PropValue::Str("stub".into())),
                        (
                            "related".into(),
                            crate::props::PropValue::List(vec!["[[딥러닝]]".into()]),
                        ),
                    ],
                    removes: vec![],
                }),
            )
            .unwrap();
        assert_eq!(
            updated.props.get("status"),
            Some(&crate::props::PropValue::Str("stub".into()))
        );
        // On-disk file carries the props.
        let reread = v.get_memo(note.id).unwrap();
        assert_eq!(reread.props.get("status"), updated.props.get("status"));

        // Remove key.
        let updated = v
            .update_note_with(
                note.id,
                None,
                None,
                Some(crate::props::PropMutation {
                    sets: vec![],
                    removes: vec!["status".into()],
                }),
            )
            .unwrap();
        assert!(updated.props.get("status").is_none());
        assert!(v.get_memo(note.id).unwrap().props.get("status").is_none());

        // Same-value re-set must not bump `updated`.
        let before = updated.updated_at;
        let again = v
            .update_note_with(
                note.id,
                None,
                None,
                Some(crate::props::PropMutation {
                    sets: vec![("status".into(), crate::props::PropValue::Str("stub".into()))],
                    removes: vec![],
                }),
            )
            .unwrap();
        // `again` re-set status after the remove — a real change. Re-set
        // the SAME value once more: a semantic NoOp that must leave
        // `updated_at` and the digest untouched.
        assert_ne!(again.updated_at, before, "sanity: the re-set was a change");
        let prev = v.get_memo(note.id).unwrap();
        let noop = v
            .update_note_with(
                note.id,
                None,
                None,
                Some(crate::props::PropMutation {
                    sets: vec![("status".into(), crate::props::PropValue::Str("stub".into()))],
                    removes: vec![],
                }),
            )
            .unwrap();
        assert_eq!(noop.updated_at, prev.updated_at, "no-op re-set must not bump updated");
        assert_eq!(noop.hash, prev.hash, "no-op re-set must not change the digest");
    }

    #[test]
    fn query_notes_filters_sorts_and_paginates() {
        let (_t, v) = tmp_vault();
        let seed = |title: &str, status: &str, changed: &str| {
            let n = v
                .create_note("", format!("# {title}"), crate::memo::NoteFormat::Markdown)
                .unwrap();
            v.update_note_with(
                n.id,
                None,
                None,
                Some(crate::props::PropMutation {
                    sets: vec![
                        ("status".into(), crate::props::PropValue::Str(status.into())),
                        (
                            "status_changed".into(),
                            crate::props::PropValue::Str(changed.into()),
                        ),
                    ],
                    removes: vec![],
                }),
            )
            .unwrap();
            n
        };
        let a = seed("Alpha", "understood", "2026-01-01");
        seed("Beta", "stub", "2026-02-01");
        seed("Gamma", "understood", "2026-03-01");

        // Filter: status = understood, sort by status_changed asc.
        let q = crate::props::NoteQuery {
            props: vec![crate::props::parse_where("status=understood").unwrap()],
            sort: crate::props::SortSpec::PropAsc("status_changed".into()),
            offset: 0,
            limit: 10,
            ..Default::default()
        };
        let page = v.query_notes(&q).unwrap();
        assert_eq!(page.total, 2);
        let titles: Vec<Option<&str>> = page.items.iter().map(|s| s.title.as_deref()).collect();
        assert_eq!(titles, vec![Some("Alpha"), Some("Gamma")]);

        // Offset pagination.
        let q2 = crate::props::NoteQuery {
            props: vec![crate::props::parse_where("status=understood").unwrap()],
            sort: crate::props::SortSpec::PropAsc("status_changed".into()),
            offset: 1,
            limit: 10,
            ..Default::default()
        };
        let page2 = v.query_notes(&q2).unwrap();
        assert_eq!(page2.items.len(), 1);
        assert_eq!(page2.items[0].title.as_deref(), Some("Gamma"));
        // `a` is still the first item — stub filtered out.
        assert_eq!(page.items[0].id, a.id);
    }

    /// The knowledge folder ships with every vault (system-folder
    /// semantics, design + user prompt 2026-08-23): `migrate` creates it,
    /// recreation after deletion is empty-preset-only, and user edits to
    /// the preset files survive.
    #[test]
    fn migrate_ships_knowledge_folder_and_preserves_edits() {
        let (_t, v) = tmp_vault();
        v.migrate().unwrap();
        let root = v.paths().vault.join("knowledge");
        assert!(root.join("TEMPLATE.md").exists());
        assert!(root.join("SCHEMA.toml").exists());
        assert!(
            v.folder_schema("knowledge")
                .unwrap()
                .is_some(),
            "the shipped folder must carry its schema"
        );

        // User edit survives a later migrate (apply skips existing files).
        let schema_path = root.join("SCHEMA.toml");
        let edited = std::fs::read_to_string(&schema_path)
            .unwrap()
            .replace("required = true", "required = false");
        std::fs::write(&schema_path, edited).unwrap();
        v.migrate().unwrap();
        assert!(
            !std::fs::read_to_string(&schema_path)
                .unwrap()
                .contains("required = true"),
            "migrate must never overwrite user edits to the preset"
        );
    }

    /// The daily preset ships with the vault at the *configured* daily
    /// folder, and `open_daily` creation stamps `kind: daily` via the
    /// template's frontmatter (user prompt 2026-08-23).
    #[test]
    fn migrate_ships_daily_preset_at_configured_folder() {
        let (_t, v) = tmp_vault();
        // Custom daily folder: the preset must follow the config, not a
        // hardcoded "daily" path.
        v.config.write().daily.folder = "journal".into();
        v.migrate().unwrap();
        let root = v.paths().vault.join("journal");
        assert!(root.join("TEMPLATE.md").exists());
        assert!(root.join("SCHEMA.toml").exists());
        let schema = v.folder_schema("journal").unwrap().unwrap();
        assert!(schema.properties.contains_key("mood"));
        assert!(!v.paths().vault.join("daily/SCHEMA.toml").exists());

        // Creating a daily note stamps kind via the template frontmatter.
        let (m, created) = v.open_daily("2026-08-23").unwrap();
        assert!(created);
        assert_eq!(
            m.props.get("kind"),
            Some(&crate::props::PropValue::Str("daily".into()))
        );
        assert_eq!(m.body.lines().next(), Some("# 2026-08-23"));
    }
    /// Design §6.1/§6.3 end-to-end: the knowledge preset stamps
    /// `status: stub` on captures (blank AND non-blank bodies), the
    /// status lifecycle runs through real vault writes, and `doctor`
    /// surfaces schema violations.
    #[test]
    fn knowledge_preset_end_to_end() {
        let (_t, v) = tmp_vault();
        v.ensure_initialized().unwrap();
        v.create_folder("knowledge").unwrap();
        v.apply_knowledge_preset("knowledge").unwrap();

        // Blank capture → template body (H1 placeholder) + stamped props.
        let blank = v
            .create_note_auto("knowledge", String::new())
            .unwrap();
        assert_eq!(
            blank.props.get("status"),
            Some(&crate::props::PropValue::Str("stub".into()))
        );

        // Non-blank capture (§6.1 extension): keeps the captured text,
        // still inherits the template's property defaults.
        let captured = v
            .create_note_auto("knowledge", "# 어렴풋한 개념".into())
            .unwrap();
        assert_eq!(captured.body, "# 어렴풋한 개념");
        assert_eq!(
            captured.props.get("status"),
            Some(&crate::props::PropValue::Str("stub".into()))
        );

        // Lifecycle through the vault: stub → understood records the
        // peak + stamps status_changed (transitions on the app path).
        let learned = v
            .update_note_with(
                captured.id,
                None,
                None,
                Some(crate::props::PropMutation {
                    sets: vec![(
                        "status".into(),
                        crate::props::PropValue::Str("understood".into()),
                    )],
                    removes: vec![],
                }),
            )
            .unwrap();
        assert_eq!(
            learned.props.get("peak_status"),
            Some(&crate::props::PropValue::Str("understood".into()))
        );
        let today = time::OffsetDateTime::now_utc().date().to_string();
        assert_eq!(
            learned.props.get("status_changed"),
            Some(&crate::props::PropValue::Str(today.into()))
        );

        // doctor: the blank note lacks `domain` (required) → violation.
        let report = v.doctor(false).unwrap();
        assert!(
            report
                .schema_violations
                .iter()
                .any(|(p, r)| p.to_string_lossy().contains("knowledge") && r.contains("domain")),
            "doctor must surface the missing-domain violation"
        );
    }

    /// The review queue's reassert action (§7.3): setting the SAME status
    /// value still stamps `status_changed` (on="write") without touching
    /// `peak_status`.
    #[test]
    fn review_reassert_rewrites_status_changed() {
        let (_t, v) = tmp_vault();
        v.ensure_initialized().unwrap();
        v.create_folder("knowledge").unwrap();
        v.apply_knowledge_preset("knowledge").unwrap();
        let n = v
            .create_note_auto("knowledge", "# 재확인".into())
            .unwrap();
        v.update_note_with(
            n.id,
            None,
            None,
            Some(crate::props::PropMutation {
                sets: vec![(
                    "status".into(),
                    crate::props::PropValue::Str("understood".into()),
 )],
                removes: vec![],
            }),
        )
        .unwrap();
        // Backdate status_changed by writing the file directly.
        let rel = v
            .with_redb(|idx| Ok(idx.get(n.id).unwrap().unwrap().path))
            .unwrap();
        let abs = v.paths().vault.join(&rel);
        let raw = std::fs::read_to_string(&abs).unwrap();
        let today = time::OffsetDateTime::now_utc().date().to_string();
        let backdated = raw.replace(&format!("status_changed: {today}"), "status_changed: 2026-01-01");
        std::fs::write(&abs, backdated).unwrap();
        v.reindex().unwrap();

        // Reassert the same value — only status_changed moves.
        let out = v
            .update_note_with(
                n.id,
                None,
                None,
                Some(crate::props::PropMutation {
                    sets: vec![(
                        "status".into(),
                        crate::props::PropValue::Str("understood".into()),
                    )],
                    removes: vec![],
                }),
            )
            .unwrap();
        assert_eq!(
            out.props.get("status_changed"),
            Some(&crate::props::PropValue::Str(today.into())),
            "on=write must stamp the review date on a reassert"
        );
        assert_eq!(
            out.props.get("peak_status"),
            Some(&crate::props::PropValue::Str("understood".into()))
        );
    }

    /// `install_collection` (spec 2026-08-23 §2): ships TEMPLATE/SCHEMA
    /// with the `[meta] preset` marker, never overwrites existing
    /// files, and rejects unknown preset ids.
    #[test]
    fn install_collection_ships_and_preserves() {
        let (_t, v) = tmp_vault();
        v.ensure_initialized().unwrap();

        v.install_collection("book", "책").unwrap();
        let root = v.paths().vault.join("책");
        let tmpl = std::fs::read_to_string(root.join("TEMPLATE.md")).unwrap();
        assert!(tmpl.starts_with("---\nkind: book\nstatus: reading\n"));
        let schema = v.folder_schema("책").unwrap().unwrap();
        assert_eq!(schema.meta.preset.as_deref(), Some("book"));
        assert!(schema.properties.contains_key("author"));

        // skip-if-exists: a user-edited schema survives reinstall.
        std::fs::write(root.join("SCHEMA.toml"), "[workspace]\nname = \"내 책\"\n").unwrap();
        v.install_collection("book", "책").unwrap();
        assert!(std::fs::read_to_string(root.join("SCHEMA.toml"))
            .unwrap()
            .contains("내 책"));

        // Deleting an installed collection is permanent: migrate does
        // not resurrect it (unlike knowledge/daily system folders).
        v.delete_folder("책").unwrap();
        v.migrate().unwrap();
        assert!(!v.paths().vault.join("책/SCHEMA.toml").exists());

        assert!(v.install_collection("nope", "x").is_err());
    }
    #[test]
    fn aliases_and_prop_links_resolve_in_graph_and_backlinks() {
        let (_t, v) = tmp_vault();
        // Target known by alias "ML".
        let target = v
            .create_note("", "# 머신러닝\n\n본문".into(), crate::memo::NoteFormat::Markdown)
            .unwrap();
        v.update_note_with(
            target.id,
            None,
            None,
            Some(crate::props::PropMutation {
                sets: vec![(
                    "aliases".into(),
                    crate::props::PropValue::List(vec!["ML".into(), "기계학습".into()]),
                )],
                removes: vec![],
            }),
        )
        .unwrap();
        // Stub: no body links, only a frontmatter `related` prop.
        let stub = v
            .create_note("", "# 오류역전파".into(), crate::memo::NoteFormat::Markdown)
            .unwrap();
        v.update_note_with(
            stub.id,
            None,
            None,
            Some(crate::props::PropMutation {
                sets: vec![
                    ("status".into(), crate::props::PropValue::Str("stub".into())),
                    (
                        "related".into(),
                        crate::props::PropValue::List(vec!["[[ML]]".into()]),
                    ),
                ],
                removes: vec![],
            }),
        )
        .unwrap();

        // Backlinks on the target: the stub's `related: [[ML]]` counts.
        let backlinks = v.get_backlinks(target.id).unwrap();
        assert_eq!(backlinks.len(), 1, "prop link via alias must be a backlink");
        assert_eq!(backlinks[0].title, "오류역전파");

        // Graph: edge stub → target resolved through the alias.
        let g = v.graph_data().unwrap();
        let edge = g
            .edges
            .iter()
            .find(|e| e.source == stub.id.to_string() && e.target == target.id.to_string());
        assert!(edge.is_some(), "related-prop link must create a graph edge");
    }

    #[test]
    fn rename_propagation_rewrites_prop_links() {
        let (_t, v) = tmp_vault();
        let target = v
            .create_note("", "# 딥러닝\n\nb".into(), crate::memo::NoteFormat::Markdown)
            .unwrap();
        let stub = v
            .create_note("", "# 오류역전파".into(), crate::memo::NoteFormat::Markdown)
            .unwrap();
        v.update_note_with(
            stub.id,
            None,
            None,
            Some(crate::props::PropMutation {
                sets: vec![(
                    "related".into(),
                    crate::props::PropValue::List(vec!["[[딥러닝]]".into()]),
                )],
                removes: vec![],
            }),
        )
        .unwrap();

        // Rename the target note.
        v.update_note(
            target.id,
            Some("# 심층학습\n\nb".into()),
            None,
        )
        .unwrap();

        let reread = v.get_memo(stub.id).unwrap();
        assert_eq!(
            reread.props.get("related"),
            Some(&crate::props::PropValue::List(vec!["[[심층학습]]".into()])),
            "rename must rewrite [[..]] inside property values"
        );
    }

    #[test]
    fn rename_propagation_rewrites_links() {
        let (_t, v) = tmp_vault();
        // Create target note.
        let target = v
            .create_note(
                "",
                "# Old Title\n\nbody".into(),
                crate::memo::NoteFormat::Markdown,
            )
            .unwrap();
        // Create a note that links to it.
        let linker = v
            .create_note(
                "",
                "# Linker\n\nSee [[Old Title]] for more".into(),
                crate::memo::NoteFormat::Markdown,
            )
            .unwrap();

        // Rename target by changing its H1.
        v.update_note(target.id, Some("# New Title\n\nbody".into()), None)
            .unwrap();

        // The linker's body should now reference [[New Title]].
        let updated = v.get_memo(linker.id).unwrap();
        assert!(
            updated.body.contains("[[New Title]]"),
            "link should be updated, got: {}",
            updated.body
        );
        assert!(
            !updated.body.contains("[[Old Title]]"),
            "old link should be gone, got: {}",
            updated.body
        );

        // The linker's index record title must be its own ("Linker"), not
        // the renamed note's title ("New Title") — regression guard for a
        // bug that corrupted search titles during rename propagation.
        let summary = v.get_note_summary(linker.id).unwrap();
        assert_eq!(
            summary.title.as_deref(),
            Some("Linker"),
            "linker's search title must not be corrupted by rename propagation"
        );
    }
    #[test]
    fn html_note_roundtrip_via_vault() {
        let (_t, v) = tmp_vault();
        v.ensure_initialized().unwrap();
        let body =
            "<h1>HTML 제목</h1>\n<p>본문 <a href=\"#\">링크</a></p>\n<p>#태그</p>".to_string();
        let n = v
            .create_note("", body, crate::memo::NoteFormat::Html)
            .unwrap();

        // File landed as .html and reads back identically.
        let rec = v.with_redb(|idx| idx.get(n.id)).unwrap().unwrap();
        assert!(rec.path.ends_with(".html"), "path: {}", rec.path);
        assert_eq!(rec.title.as_deref(), Some("HTML 제목"));
        assert!(rec.preview.contains("본문"), "preview: {}", rec.preview);

        // Tags extracted from the html body.
        assert!(n.tags.contains(&"태그".to_string()));

        // Search finds the visible text.
        let hits = v.search_memos("본문", 10).unwrap();
        assert!(hits.iter().any(|m| m.id == n.id));
    }

    #[test]
    fn create_note_auto_follows_folder_template() {
        let (_t, v) = tmp_vault();
        v.ensure_initialized().unwrap();
        v.create_folder("web").unwrap();
        std::fs::write(
            v.paths.vault.join("web/TEMPLATE.html"),
            "<h1>{{date}} 노트</h1>\n<p></p>",
        )
        .unwrap();

        // Blank body → html template applied → html file.
        let n = v.create_note_auto("web", String::new()).unwrap();
        let rec = v.with_redb(|idx| idx.get(n.id)).unwrap().unwrap();
        assert!(rec.path.starts_with("web/"), "path: {}", rec.path);
        assert!(rec.path.ends_with(".html"), "path: {}", rec.path);
        assert!(n.body.contains("<h1>"), "body: {}", n.body);
        assert!(n.body.contains("노트"));

        // Folders without an html template stay markdown.
        let md = v.create_note_auto("", "# 그냥 메모".into()).unwrap();
        let rec2 = v.with_redb(|idx| idx.get(md.id)).unwrap().unwrap();
        assert!(rec2.path.ends_with(".md"), "path: {}", rec2.path);
    }

    #[test]
    fn html_frontmatter_comment_not_scanned_for_links() {
        let (_t, v) = tmp_vault();
        v.ensure_initialized().unwrap();
        // Frontmatter inside an html comment contains a wiki-link-looking
        // string; it must not create graph edges or backlinks.
        let target = v
            .create_note(
                "",
                "# Target\n\nx".into(),
                crate::memo::NoteFormat::Markdown,
            )
            .unwrap();
        let body = "<!--\n+++\ntitle = \"see [[Target]] inside\"\n+++\n-->\n<h1>Page</h1>\n<p>no links</p>"
            .to_string();
        let src = v
            .create_note("", body, crate::memo::NoteFormat::Html)
            .unwrap();

        let links = v.get_backlinks(target.id).unwrap();
        assert!(
            links.iter().all(|b| b.id != src.id.to_string()),
            "frontmatter comment must not count as a backlink"
        );
    }
    #[test]
    fn note_dto_derives_placement() {
        let (_t, v) = tmp_vault();
        v.ensure_initialized().unwrap();
        v.create_folder("web").unwrap();
        let n = v
            .create_note(
                "web",
                "<h1>페이지</h1>\n<p>#html</p>".into(),
                crate::memo::NoteFormat::Html,
            )
            .unwrap();

        let dto = v.note_dto(&n);
        assert_eq!(dto.id, n.id);
        assert_eq!(dto.title.as_deref(), Some("페이지"));
        assert_eq!(dto.folder, "web");
        assert!(dto.path.starts_with("web/") && dto.path.ends_with(".html"));
        assert_eq!(dto.format, crate::memo::NoteFormat::Html);
        assert_eq!(dto.body, n.body);

        // Root markdown note: folder empty, format markdown.
        let m = v
            .create_note("", "# MD\n\nx".into(), crate::memo::NoteFormat::Markdown)
            .unwrap();
        let d2 = v.note_dto(&m);
        assert_eq!(d2.folder, "");
        assert_eq!(d2.format, crate::memo::NoteFormat::Markdown);
        assert_eq!(d2.title.as_deref(), Some("MD"));
    }

    #[test]
    fn open_daily_creates_then_is_idempotent() {
        let (_t, v) = tmp_vault();
        v.ensure_initialized().unwrap();
        let (m1, created) = v.open_daily("2026-08-21").unwrap();
        assert!(created, "first open mints the note");
        assert_eq!(m1.body.lines().next(), Some("# 2026-08-21"));
        let rec = v.with_redb(|i| i.get(m1.id)).unwrap().unwrap();
        assert_eq!(rec.path, "daily/2026-08-21.md");
        // Re-open returns the SAME note, never a duplicate — and reports
        // created=false so an untouched close never discards it.
        let (m2, created2) = v.open_daily("2026-08-21").unwrap();
        assert_eq!(m1.id, m2.id);
        assert!(!created2);
    }

    #[test]
    fn open_daily_applies_template_with_caller_date() {
        let (_t, v) = tmp_vault();
        v.ensure_initialized().unwrap();
        v.create_folder("daily").unwrap();
        std::fs::write(
            v.paths().vault.join("daily/TEMPLATE.md"),
            "# {{date}} {{weekday}}\n\n- ",
        )
        .unwrap();
        let (m, _) = v.open_daily("2026-08-21").unwrap();
        // The normalized H1 is the date so the filename is canonical;
        // the template body (weekday line, "- " prompt) is preserved below.
        assert_eq!(m.body.lines().next(), Some("# 2026-08-21"));
        assert!(m.body.contains("# 2026-08-21 금"));
        let rec = v.with_redb(|i| i.get(m.id)).unwrap().unwrap();
        assert_eq!(rec.path, "daily/2026-08-21.md");
    }

    #[test]
    fn open_daily_normalizes_nonmatching_template_h1() {
        let (_t, v) = tmp_vault();
        v.ensure_initialized().unwrap();
        v.create_folder("daily").unwrap();
        // Template H1 is NOT the date — the note must still land at the
        // canonical path (deterministic filename, spec §2).
        std::fs::write(v.paths().vault.join("daily/TEMPLATE.md"), "# 일지\n\n내용").unwrap();
        let (m, _) = v.open_daily("2026-08-21").unwrap();
        let rec = v.with_redb(|i| i.get(m.id)).unwrap().unwrap();
        assert_eq!(rec.path, "daily/2026-08-21.md");
    }
    #[test]
    fn open_daily_respects_configured_folder() {
        // tmp_vault opens with default config; write the toml BEFORE
        // opening so Vault::open loads the override.
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(
            dir.path().join("oximemo.toml"),
            "[daily]\nfolder = \"journal\"\n",
        )
        .unwrap();
        let v = Vault::open(Some(dir.path())).unwrap();
        v.ensure_initialized().unwrap();
        let (m, _) = v.open_daily("2026-08-21").unwrap();
        let rec = v.with_redb(|i| i.get(m.id)).unwrap().unwrap();
        assert_eq!(rec.path, "journal/2026-08-21.md");
        let _ = dir; // keep alive
    }

    #[test]
    fn open_daily_rejects_invalid_dates() {
        let (_t, v) = tmp_vault();
        v.ensure_initialized().unwrap();
        assert!(v.open_daily("21-08-2026").is_err());
        assert!(v.open_daily("2026-13-01").is_err());
        assert!(v.open_daily("").is_err());
    }

    #[test]
    fn open_daily_adopts_existing_file() {
        let (_t, v) = tmp_vault();
        v.ensure_initialized().unwrap();
        let manual = v
            .create_note(
                "daily",
                "# 2026-08-21\n수동으로 만든 파일".into(),
                crate::memo::NoteFormat::Markdown,
            )
            .unwrap();
        let (m, created) = v.open_daily("2026-08-21").unwrap();
        assert_eq!(m.id, manual.id, "must adopt, not duplicate");
        assert!(!created, "adoption must not mark the note discardable");
    }

    #[test]
    fn open_daily_adopts_unindexed_file_on_disk() {
        // Watcher debounce / startup lag: the canonical file exists on
        // disk but the index is cold. open_daily must adopt THAT file,
        // not let create_note write a `-2` sibling.
        let (_t, v) = tmp_vault();
        v.ensure_initialized().unwrap();
        v.create_folder("daily").unwrap();
        std::fs::write(
            v.paths().vault.join("daily/2026-08-21.md"),
            "# 2026-08-21\n직접 쓴 파일\n",
        )
        .unwrap();
        let (m, _) = v.open_daily("2026-08-21").unwrap();
        assert_eq!(m.body, "# 2026-08-21\n직접 쓴 파일\n");
        let rec = v.with_redb(|i| i.get(m.id)).unwrap().unwrap();
        assert_eq!(rec.path, "daily/2026-08-21.md");
        assert!(
            !v.paths().vault.join("daily/2026-08-21-2.md").exists(),
            "no suffixed sibling"
        );
        // Adoption is now indexed: re-open returns the same note.
        let (m2, _) = v.open_daily("2026-08-21").unwrap();
        assert_eq!(m.id, m2.id);
    }

    #[test]
    fn open_daily_adopts_unindexed_frontmatter_file() {
        // Same cold-index situation, but the file carries frontmatter
        // (e.g. synced from another machine): adopted with its own id.
        let (_t, v) = tmp_vault();
        v.ensure_initialized().unwrap();
        v.create_folder("daily").unwrap();
        std::fs::write(
            v.paths().vault.join("daily/2026-08-21.md"),
            "---\nid: 017f22e2-79b6-749e-8c01-0f99a2217673\ncreated: 2026-08-20T00:00:00Z\nupdated: 2026-08-20T00:00:00Z\n---\n\n# 2026-08-21\n동기화된 파일\n",
        )
        .unwrap();
        let (m, _) = v.open_daily("2026-08-21").unwrap();
        assert_eq!(m.id.to_string(), "017f22e2-79b6-749e-8c01-0f99a2217673");
        assert!(m.body.contains("동기화된 파일"));
        let rec = v.with_redb(|i| i.get(m.id)).unwrap().unwrap();
        assert_eq!(rec.path, "daily/2026-08-21.md");
        assert!(!v.paths().vault.join("daily/2026-08-21-2.md").exists());
    }

    #[test]
    fn open_daily_clamps_trailing_slash_and_rejects_empty_folder() {
        // Trailing slash would otherwise build "daily//2026-08-21.md".
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(
            dir.path().join("oximemo.toml"),
            "[daily]\nfolder = \"daily/\"\n",
        )
        .unwrap();
        let v = Vault::open(Some(dir.path())).unwrap();
        v.ensure_initialized().unwrap();
        let (m, _) = v.open_daily("2026-08-21").unwrap();
        let rec = v.with_redb(|i| i.get(m.id)).unwrap().unwrap();
        assert_eq!(rec.path, "daily/2026-08-21.md");

        // Empty folder would build "/2026-08-21.md" at the vault root.
        let dir2 = tempfile::TempDir::new().unwrap();
        std::fs::write(dir2.path().join("oximemo.toml"), "[daily]\nfolder = \"\"\n").unwrap();
        let v2 = Vault::open(Some(dir2.path())).unwrap();
        v2.ensure_initialized().unwrap();
        let err = v2.open_daily("2026-08-21").unwrap_err();
        assert!(err.to_string().contains("[daily] folder must not be empty"));
        let _ = (dir, dir2); // keep alive
    }

    #[test]
    fn open_daily_html_template_folder() {
        let (_t, v) = tmp_vault();
        v.ensure_initialized().unwrap();
        v.create_folder("daily").unwrap();
        std::fs::write(v.paths().vault.join("daily/TEMPLATE.html"), "<h1>일지</h1>").unwrap();
        let (m, _) = v.open_daily("2026-08-21").unwrap();
        let rec = v.with_redb(|i| i.get(m.id)).unwrap().unwrap();
        assert_eq!(rec.path, "daily/2026-08-21.html");
        assert!(m.body.contains("<h1>2026-08-21</h1>"));
    }

    // -- brain registration on open (task 7) --------------------------

    fn fresh_recorder() -> (
        std::sync::Arc<crate::brain::RecordingBrainRegistrar>,
        tempfile::TempDir,
    ) {
        // No global reset: each test uses a unique tempdir, so its
        // `(vault, space, socket)` tuple never collides with another
        // test's memo entry. The per-tuple `reset_registration_memo_for_test`
        // is used only by tests that intentionally re-open the same
        // vault across two scopes (see `open_without_recorder_under_cfg_test_is_a_noop`).
        (
            crate::brain::RecordingBrainRegistrar::new(),
            tempfile::tempdir().unwrap(),
        )
    }
    #[test]
    fn registers_vault_when_brain_enabled() {
        let (recorder, dir) = fresh_recorder();
        let home = dir.path().to_path_buf();
        let expected_vault = dir.path().join("vault");
        std::fs::create_dir_all(&expected_vault).unwrap();
        std::fs::write(
            expected_vault.join("oximemo.toml"),
            "[brain]\nenabled = true\nspace = \"personal\"\nsocket = \"\"\n",
        )
        .unwrap();
        crate::brain::with_test_recorder(recorder.clone(), || {
            crate::migrate_vault::with_home(&home, || {
                let _v = Vault::open(Some(&expected_vault)).unwrap();
            });
        });
        let calls = recorder.calls.lock();
        assert_eq!(calls.len(), 1, "exactly one registration");
        assert_eq!(calls[0].vault, expected_vault);
        assert_eq!(calls[0].space, "personal");
        assert_eq!(calls[0].socket, "");
    }

    #[test]
    fn brain_disabled_means_no_registration() {
        let (recorder, dir) = fresh_recorder();
        let home = dir.path().to_path_buf();
        let expected_vault = dir.path().join("vault");
        std::fs::create_dir_all(&expected_vault).unwrap();
        std::fs::write(
            expected_vault.join("oximemo.toml"),
            "[brain]\nenabled = false\n",
        )
        .unwrap();
        crate::brain::with_test_recorder(recorder.clone(), || {
            crate::migrate_vault::with_home(&home, || {
                let _v = Vault::open(Some(&expected_vault)).unwrap();
            });
        });
        assert_eq!(recorder.calls.lock().len(), 0);
    }

    #[test]
    fn ecosystem_space_overrides_vault_local_space() {
        let (recorder, dir) = fresh_recorder();
        let home = dir.path().to_path_buf();
        let expected_vault = dir.path().join("vault");
        std::fs::create_dir_all(&expected_vault).unwrap();
        std::fs::create_dir_all(home.join(".oxi")).unwrap();
        std::fs::write(home.join(".oxi/config.toml"), "[vault]\nspace = \"work\"\n").unwrap();
        std::fs::write(
            expected_vault.join("oximemo.toml"),
            "[brain]\nenabled = true\nspace = \"personal\"\n",
        )
        .unwrap();
        crate::brain::with_test_recorder(recorder.clone(), || {
            crate::migrate_vault::with_home(&home, || {
                let _v = Vault::open(Some(&expected_vault)).unwrap();
            });
        });
        let calls = recorder.calls.lock();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].space, "work", "ecosystem wins over vault-local");
    }

    #[test]
    fn unreachable_socket_does_not_block_open() {
        let (_recorder, dir) = fresh_recorder();
        let home = dir.path().to_path_buf();
        let expected_vault = dir.path().join("vault");
        std::fs::create_dir_all(&expected_vault).unwrap();
        std::fs::write(
            expected_vault.join("oximemo.toml"),
            "[brain]\nenabled = true\nsocket = \"/tmp/oximemo-test-nonexistent-socket.sock\"\n",
        )
        .unwrap();
        crate::migrate_vault::with_home(&home, || {
            let v = Vault::open(Some(&expected_vault));
            assert!(v.is_ok(), "open must succeed despite unreachable daemon");
        });
    }

    #[test]
    fn repeated_open_same_tuple_registers_only_once() {
        // Important #1: the memo in `register_vault` collapses identical
        // (vault, space, socket) tuples so the daemon isn't spammed by
        // reopens (e.g. the watcher's per-debounced reopen path).
        let (recorder, dir) = fresh_recorder();
        let home = dir.path().to_path_buf();
        let expected_vault = dir.path().join("vault");
        std::fs::create_dir_all(&expected_vault).unwrap();
        std::fs::write(
            expected_vault.join("oximemo.toml"),
            "[brain]\nenabled = true\nspace = \"personal\"\nsocket = \"\"\n",
        )
        .unwrap();
        crate::brain::with_test_recorder(recorder.clone(), || {
            crate::migrate_vault::with_home(&home, || {
                let _ = Vault::open(Some(&expected_vault)).unwrap();
                let _ = Vault::open(Some(&expected_vault)).unwrap();
                let _ = Vault::open(Some(&expected_vault)).unwrap();
            });
        });
        let calls = recorder.calls.lock();
        assert_eq!(calls.len(), 1, "memo: identical tuple → one call");
    }

    #[test]
    fn open_without_recorder_under_cfg_test_is_a_noop() {
        // Important #2: under cfg(test), `current_registrar()` returns
        // `NoopBrainRegistrar` unless a recorder is installed. This
        // stands between unrelated tests and the developer's live
        // daemon. The test exercises an existing-style `Vault::open`
        // path (no recorder) and asserts the open itself succeeds; the
        // follow-up reinstalls a recorder and confirms a fresh open
        // does get through (i.e. the memo didn't bake in a stale
        // no-op decision).
        let (_recorder, dir) = fresh_recorder();
        let home = dir.path().to_path_buf();
        let expected_vault = dir.path().join("vault");
        std::fs::create_dir_all(&expected_vault).unwrap();
        std::fs::write(
            expected_vault.join("oximemo.toml"),
            "[brain]\nenabled = true\nspace = \"personal\"\n",
        )
        .unwrap();
        // First: no recorder installed — the cfg(test) default is the
        // no-op, and the memo caches the registration so it can't fire
        // again even if a recorder is later installed.
        crate::migrate_vault::with_home(&home, || {
            let v = Vault::open(Some(&expected_vault)).unwrap();
            assert!(v.paths().vault.ends_with("vault"));
        });
        // Reset the memo (only if it matches this test's tuple — see
        // round-2 #2) and reinstall a recorder: a fresh open MUST
        // reach the recorder. If `current_registrar()` were still
        // returning `RealBrainRegistrar` under cfg(test), the call to
        // `connect_default` here would hit the developer's live daemon
        // — this assertion proves the no-op gate is in place.
        let rec = crate::brain::RecordingBrainRegistrar::new();
        crate::brain::reset_registration_memo_for_test(&crate::brain::Registration {
            vault: expected_vault.clone(),
            space: "personal".into(),
            socket: String::new(),
        });
        crate::brain::with_test_recorder(rec.clone(), || {
            crate::migrate_vault::with_home(&home, || {
                let _ = Vault::open(Some(&expected_vault)).unwrap();
            });
        });
        assert_eq!(rec.calls.lock().len(), 1);
    }
}
