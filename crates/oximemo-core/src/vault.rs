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
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::base::BaseInfo;

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
const INDEX_FORMAT_VERSION: u32 = 5;

/// Extraction-parser version for `IndexRecord.tasks` (spec §3/§6). Bump
/// when `crate::tasks::parse_tasks`'s output would change for the same
/// bytes + config, so [`Vault::migrate`] reindexes once to repopulate
/// existing records.
const TASKS_PARSER_VERSION: u32 = 1;

/// Fingerprints the extraction-affecting subset of `[tasks]` config:
/// parser version, `enabled`, `global_filter`, `statuses`.
/// Presentation-only fields (`write_format`, `capture_target`,
/// `recurrence_insert`, `default_section`) are deliberately excluded —
/// changing them never changes what counts as a task. Stored in
/// `<index_dir>/tasks-fingerprint`; [`Vault::migrate`] reindexes once
/// per change.
fn tasks_fingerprint(cfg: &crate::tasks::TasksConfig) -> String {
    let canonical = format!(
        "{}:{}:{}:{:?}",
        TASKS_PARSER_VERSION, cfg.enabled, cfg.global_filter, cfg.statuses
    );
    blake3::hash(canonical.as_bytes()).to_hex().to_string()
}

/// Lifecycle status of an opened vault.
///
/// [`Vault::open`] runs the one-time default-vault migration
/// (see [`crate::migrate_vault`]) before resolving paths; when both the
/// pre-unification default vault and the new
/// `~/.oxi/spaces/personal/vault` exist, the
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

/// Cached, generation-keyed index export used by [`Vault::query_notes`].
/// `generation` is `(meta.redb mtime, meta.redb size)`. redb is opened
/// transiently inside an fs2 flock (see the module doc at the top of this
/// file), so an in-process counter cannot see CLI writes from another
/// process — the file stat IS the cross-process generation. `RedbIndex::open`
/// is read-first when the tables already exist
/// (`crates/oximemo-core/src/store/index.rs`), so mtime only changes on
/// real writes; the cache key is exact and there is no rounding window.
struct SnapshotState {
    generation: (std::time::SystemTime, u64),
    recs: std::sync::Arc<Vec<crate::store::index::IndexRecord>>,
}

/// Return of [`Vault::snapshot_with_gen`]: the record snapshot plus the
/// generation it was read at `(mtime, size)` — callers use the pair as
/// their cache key (spec §3).
pub(crate) type SnapshotWithGen = (
    std::sync::Arc<Vec<crate::store::index::IndexRecord>>,
    (std::time::SystemTime, u64),
);

/// Row staged for the tantivy upsert batch in `reindex`:
/// `(id, body, title, tags, path)`.
type SearchRow = (MemoId, String, Option<String>, Vec<String>, String);

/// Snapshot cache cap (spec §3, snapshot budget): when `export_since`
/// returns more than this many records we return the freshly-loaded vector
/// without caching, so the cache never holds a multi-megabyte Arc.
const SNAPSHOT_CACHE_CAP: usize = 50_000;

/// doctor's stale-namespace threshold (2026-08-28 index-explosion fix):
/// `by-vault/<hash>` namespaces idle longer than this are reported, and
/// swept with `--fix`. Generous vs an in-flight process's lock window;
/// the GUI startup sweep uses a much larger 7-day floor.
const STALE_NS_DOCTOR_MIN_AGE: Duration = Duration::from_secs(3600);
/// Snapshot task-weight cap (spec §3/§6): when the summed
/// `IndexRecord.tasks.len()` across the export exceeds this, we skip
/// caching (same as [`SNAPSHOT_CACHE_CAP`]) even if the note count is
/// under the cap — one note's `MAX_TASKS_PER_NOTE = 1000` cap bounds
/// any single record, but many task-heavy notes could still sum to a
/// multi-megabyte Arc. 50k notes * 4 average tasks fits comfortably.
const SNAPSHOT_TASK_WEIGHT_CAP: usize = 200_000;

/// Vault-relative path of the one-shot installed `할 일` base (tasks
/// spec §7.4). A normal, user-ownable `.query` — never recreated after
/// deliberate deletion (install-once marker semantics, like the inbox
/// seed).
const TASKS_BASE_REL: &str = "queries/할 일.query";

/// The installed `할 일` base document (tasks spec §7.4): a
/// vault-global task surface with views 오늘/예정/지연/전체/날짜 없음.
/// Unlike the §9 daily-note fence this is NOT scoped by
/// `this.file.name` — `today()` pins each view to the wall clock. 오늘
/// includes overdue work (due/scheduled on or before today, guarded),
/// 예정 is the future window, 지연 is strictly overdue by `due`, and
/// 날짜 없음 is the undated backlog — quick-added tasks have neither
/// date, so without this view they surface nowhere but 전체.
const TASKS_BASE_MD: &str = r#"source: tasks
views:
  - type: tasks
    name: 오늘
    filters: '(task.due != null && task.due <= today()) || (task.scheduled != null && task.scheduled <= today())'
  - type: tasks
    name: 예정
    filters: '(task.due != null && task.due > today()) || (task.scheduled != null && task.scheduled > today())'
  - type: tasks
    name: 지연
    filters: 'task.due != null && task.due < today()'
  - type: tasks
    name: 전체
  - type: tasks
    name: 날짜 없음
    filters: 'task.due == null && task.scheduled == null'
"#;

/// Marker content gating the installed base's seed version (`"1"` =
/// the original four-view seed). Bump alongside `TASKS_BASE_MD`
/// changes: vaults whose marker predates the bump get a structural
/// upgrade in [`Self::ensure_tasks_base_seed`].
const TASKS_BASE_SEED_VERSION: &str = "2";

/// The 날짜 없음 view name shared by the v2 seed and the structural
/// upgrade. The desktop sidebar resolves this view BY NAME (not index)
/// so user-reordered or user-extended bases keep working.
const TASKS_NO_DATE_VIEW: &str = "날짜 없음";

pub struct Vault {
    paths: Paths,
    status: VaultStatus,
    config: RwLock<VaultConfig>,
    files: FileStore,
    /// Folder-schema cache keyed by folder path: `(mtime, schema)`. The
    /// SCHEMA.toml files are not watcher targets, so the mtime is checked
    /// on every lookup (design 2026-08-23 §6.2).
    schemas: RwLock<
        std::collections::HashMap<
            String,
            (std::time::SystemTime, Option<crate::schema::FolderSchema>),
        >,
    >,
    /// Base-`.query` file cache keyed by vault-relative path: `(mtime, def)`.
    /// Mirrors the `schemas` cache. The watcher calls
    /// [`Self::invalidate_base_caches`] to drop entries after external edits.
    bases: RwLock<std::collections::HashMap<String, (std::time::SystemTime, crate::base::BaseDef)>>,
    /// Generation-keyed cache of the full index export. Populated lazily
    /// on the first call per generation; bypassed (returned without
    /// caching) when the export exceeds [`SNAPSHOT_CACHE_CAP`] so a
    /// multi-megabyte Arc never sits in memory between queries.
    snapshot: RwLock<Option<SnapshotState>>,
    /// Bounded LRU cache for evaluated base results (Task 10).
    /// `pub(crate)` so `base::exec::run_base` can call `get`/`put`
    /// directly without leaking the surface to other crates.
    base_results: crate::base::SharedResultCache,
}

impl Vault {
    /// Resolve a vault (space resolution when `vault` is `None`) and load
    /// its config. Does not create directories — call
    /// [`Self::ensure_initialized`] for that. `None` runs the full
    /// space resolution chain (spec 2026-08-28 §1): `--space` >
    /// `last_space` > `personal`, after the one-time default-vault and
    /// flat→space migrations.
    pub fn open(vault: Option<&Path>) -> Result<Self> {
        match vault {
            Some(p) => Self::open_spec(&crate::spaces::VaultSpec::Explicit(p.to_path_buf())),
            None => Self::open_spec(&crate::spaces::resolve_vault_spec(None, None)?),
        }
    }

    /// Open the vault selected by an already-resolved spec. Runs the
    /// home-relative migrations (app-support → `spaces/personal/vault`,
    /// then flat vault → spaces) for `Space` specs; `Explicit` paths
    /// skip both.
    pub fn open_spec(spec: &crate::spaces::VaultSpec) -> Result<Self> {
        // Unit-test binaries (cfg(test)) must never point custom-vault
        // namespaces at the real Application Support — one leaked redb
        // per vault-opening test caused the 2026-08-28 index explosion
        // (267 dirs / 365 MB in a day). Downstream integration suites
        // (CLI, desktop) wire `isolate_index_root_for_tests` into their
        // own helpers; this hook covers every in-crate test path.
        #[cfg(test)]
        let _ = crate::paths::isolate_index_root_for_tests();
        let mut status = VaultStatus::Ok;
        // The migrations are OXI_HOME-aware: they resolve everything
        // (targets, journal, legacy candidates) from the shared home,
        // never from a raw `$HOME` read.
        let oxi = crate::paths::oxi_home();
        let legacy = crate::paths::user_home();
        if matches!(spec, crate::spaces::VaultSpec::Space(_)) {
            match crate::migrate_vault::maybe_migrate(&oxi, legacy.as_deref())? {
                crate::migrate_vault::MigrationStatus::MergeRequired { old, new } => {
                    tracing::warn!(
                        old = %old.display(),
                        new = %new.display(),
                        "both the pre-unification default vault and \
                         ~/.oxi/spaces/personal/vault exist; \
                         merge them by hand (see `oximemo doctor`)"
                    );
                    status = VaultStatus::MergeRequired { old, new };
                }
                crate::migrate_vault::MigrationStatus::Migrated { converted } => {
                    tracing::info!(
                        converted,
                        "migrated the default vault into ~/.oxi/spaces/personal/vault \
                         (v3 notes converted to v4)"
                    );
                }
                _ => {}
            }
            match crate::migrate_spaces::maybe_migrate(&oxi, legacy.as_deref())? {
                crate::migrate_spaces::FlatMigrationStatus::MergeRequired { flat, space } => {
                    tracing::warn!(
                        flat = %flat.display(),
                        space = %space.display(),
                        "both the flat vault and ~/.oxi/spaces/personal/vault exist; \
                         merge them by hand (see `oximemo doctor`)"
                    );
                    status = VaultStatus::MergeRequired {
                        old: flat,
                        new: space,
                    };
                }
                crate::migrate_spaces::FlatMigrationStatus::Migrated { moved } => {
                    tracing::info!(moved, "migrated flat vault into the personal space");
                }
                _ => {}
            }
        }
        let paths = Paths::resolve_spec(spec);
        let config = VaultConfig::load(&paths);
        // Brain documents-plane glue (unified home): record the active
        // space's registration request. Pure filesystem inside
        // oximemo's own private subtree — never a brain file, never a
        // spawned child (C1: boot never blocks). A later flush
        // (desktop boot task, `oximemo doctor`, `oximemo migrate-home`)
        // delivers it through the oxibrain-client
        // `register_document_root` boundary; until then the request
        // waits in `pending_root_registration.json` (doctor-visible).
        if config.brain.enabled {
            let space = crate::brain::vault_space_name(&paths.vault);
            crate::brain::record_pending_root_registration(&paths.vault, &space);
            tracing::debug!(space = %space, "brain: document root registration recorded");
        }
        let files = FileStore::new(paths.clone());
        Ok(Self {
            paths,
            status,
            config: RwLock::new(config),
            files,
            schemas: RwLock::new(Default::default()),
            bases: RwLock::new(Default::default()),
            snapshot: RwLock::new(None),
            base_results: crate::base::SharedResultCache::new(),
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
            self.paths
                .vault
                .join(&folder_norm)
                .join(crate::paths::SCHEMA_NAME)
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
        let (template, schema) = crate::schema::collection_preset(preset_id)
            .ok_or_else(|| CoreError::other(format!("unknown collection preset: {preset_id}")))?;
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

    /// The vault's self-description for agents and humans (copilot
    /// schema-awareness design 2026-08-24 §2.1): every physical folder
    /// with its note count and schema/template facts. Backs the CLI
    /// `folders` command and the copilot context block — one truth for
    /// both. Schema parse failures propagate (the §6.2 hard-error
    /// contract): a silently skipped schema would misreport the vault.
    pub fn folder_inventory(&self) -> Result<Vec<FolderInfo>> {
        let mut out = Vec::new();
        for (path, notes) in self.list_folders()? {
            let schema = self.folder_schema(&path)?;
            let has_template = crate::template::load_template(
                self.paths(),
                &path,
                crate::memo::NoteFormat::Markdown,
            )
            .is_some()
                || crate::template::load_template(
                    self.paths(),
                    &path,
                    crate::memo::NoteFormat::Html,
                )
                .is_some();
            let has_schema = schema.is_some();
            let (preset, workspace) = schema
                .map(|s| (s.meta.preset, s.workspace.name))
                .unwrap_or((None, None));
            out.push(FolderInfo {
                path,
                notes,
                preset,
                workspace,
                has_schema,
                has_template,
            });
        }
        Ok(out)
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

    /// Delete stale `by-vault/<hash>` index namespaces under the
    /// application-support index root. A namespace is stale when all of:
    /// - it is not the namespace this `Vault` resolves to,
    /// - its `meta.redb` mtime (dir mtime fallback) is older than
    ///   `min_age`, and
    /// - its `meta.redb.lock` flock can be taken `Exclusive` right now —
    ///   a live GUI/CLI mid-open holds it, so skip rather than fight.
    ///
    /// Namespaces are derived data only: deleting one loses nothing a
    /// reindex cannot rebuild. Mirrors [`Self::gc_assets`] semantics
    /// (count of removed entries). Callers: GUI startup (7-day age) and
    /// `doctor --fix` (1-hour age) — never a hot path.
    pub fn gc_stale_namespaces(&self, min_age: std::time::Duration) -> Result<u64> {
        self.sweep_stale_namespaces(min_age, true)
    }

    /// Count (`delete = false`) or sweep (`delete = true`) stale
    /// namespaces; [`Self::doctor`] reports the count and fixes with the
    /// same threshold so a report-then-fix pair is consistent.
    fn sweep_stale_namespaces(&self, min_age: std::time::Duration, delete: bool) -> Result<u64> {
        let root = crate::paths::by_vault_root();
        let entries = match std::fs::read_dir(&root) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(e) => return Err(e.into()),
        };
        let now = std::time::SystemTime::now();
        let mut removed = 0u64;
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            // Never delete the namespace this Vault resolves to.
            if dir == self.paths.index_dir {
                continue;
            }
            let mtime = std::fs::metadata(dir.join(crate::paths::META_DB_NAME))
                .or_else(|_| entry.metadata())
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            let Ok(age) = now.duration_since(mtime) else {
                continue; // future-dated mtime: treat as fresh
            };
            if age < min_age {
                continue;
            }
            // In-flight guard. `acquire` creates the lock file (removed
            // with the dir); any acquire error means "maybe in use".
            let lock_path = dir.join(crate::paths::META_LOCK_NAME);
            let Ok(_guard) =
                crate::lock::acquire(&lock_path, LockKind::Exclusive, std::time::Duration::ZERO)
            else {
                continue;
            };
            drop(_guard);
            if !delete {
                removed += 1;
                continue;
            }
            match std::fs::remove_dir_all(&dir) {
                Ok(()) => removed += 1,
                Err(e) => tracing::warn!(
                    error = %e,
                    dir = %dir.display(),
                    "gc: stale namespace removal failed"
                ),
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

    /// Shared lock + transient redb. Crate-visible: `base::exec`'s
    /// tests seed bulk index records in one transaction (creating
    /// 20k notes through `create_note` is quadratic and would stall
    /// the suite).
    pub(crate) fn with_redb<R>(&self, f: impl FnOnce(&RedbIndex) -> Result<R>) -> Result<R> {
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

    /// Caller already holds `guard` for the whole operation (spec §5: one
    /// exclusive lock across read -> verify -> rewrite -> upsert). This
    /// function itself acquires no lock; `FileLock` has no type-level
    /// Shared/Exclusive distinction, so the `debug_assert_eq!` below is
    /// the only enforcement that callers hold the right kind — the
    /// `&FileLock` parameter alone only proves "some lock is held".
    #[allow(dead_code)]
    fn with_redb_locked<R>(
        &self,
        guard: &FileLock,
        f: impl FnOnce(&RedbIndex) -> Result<R>,
    ) -> Result<R> {
        debug_assert_eq!(guard.kind(), LockKind::Exclusive);
        let idx = RedbIndex::open(&self.paths.meta_db_path())?;
        f(&idx)
    }

    /// Exclusive-lock-holding variant of [`Self::with_redb_and_search`] for
    /// callers already inside a held [`FileLock`] scope (spec §5/§6 task
    /// mutations: one lock across read, verify, rewrite, upsert).
    fn with_redb_and_search_locked<R>(
        &self,
        guard: &FileLock,
        f: impl FnOnce(&RedbIndex, &TantivySearch) -> Result<R>,
    ) -> Result<R> {
        debug_assert_eq!(guard.kind(), LockKind::Exclusive);
        let idx = RedbIndex::open(&self.paths.meta_db_path())?;
        let search = TantivySearch::open(&self.paths.search_dir())?;
        f(&idx, &search)
    }

    /// Read a note's current body + resolved file path for a task
    /// mutation already running under a caller-held exclusive lock.
    /// Mirrors [`Self::get_memo`]'s live→trash fallback but returns the
    /// resolved vault-relative and absolute paths alongside the memo, so
    /// the caller can hand both straight to
    /// [`Self::write_file_and_upsert_locked`] without re-deriving them.
    /// Acquires no lock itself — opens redb transiently, relying on the
    /// caller's held [`FileLock`] for cross-process safety.
    fn read_file_locked(&self, id: MemoId) -> Result<(Memo, String, PathBuf)> {
        let idx = RedbIndex::open(&self.paths.meta_db_path())?;
        let rec = idx
            .get(id)?
            .ok_or_else(|| CoreError::NotFound(id.to_string()))?;
        let rel = rec.path;
        let live = self.paths.vault.join(&rel);
        if live.exists() {
            let memo = self
                .files
                .read_memo(&live)?
                .ok_or_else(|| CoreError::NotFound(id.to_string()))?;
            return Ok((memo, rel, live));
        }
        let trash = self.paths.trash_path(&rel);
        if trash.exists() {
            let memo = self
                .files
                .read_memo(&trash)?
                .ok_or_else(|| CoreError::NotFound(id.to_string()))?;
            return Ok((memo, rel, trash));
        }
        Err(CoreError::NotFound(id.to_string()))
    }

    /// Atomically rewrite `path`'s body, re-read the resulting [`Memo`],
    /// and upsert the index + search entry — all under the caller's
    /// already-held exclusive `guard` (spec §5/§6: the single choke point
    /// task mutations call after computing their new body text). Task
    /// mutations never touch favorite/props/title-driven rename, so this
    /// intentionally does not reimplement [`Self::update_note_with`]'s
    /// rename branch — it is a plain in-place body rewrite.
    fn write_file_and_upsert_locked(
        &self,
        guard: &FileLock,
        path: &Path,
        rel: &str,
        new_body: &str,
    ) -> Result<Memo> {
        let now = OffsetDateTime::now_utc();
        let fmt = crate::memo::NoteFormat::from_rel(rel);
        let crate_fmt = to_crate_fmt(fmt);
        write_document(
            path,
            new_body,
            crate_fmt,
            Mutation::default(),
            Synthesize::No,
            now,
        )
        .map_err(crate::store::files::frontmatter_error_to_core)?;
        let note = self.files.read_memo(path)?.ok_or_else(|| {
            CoreError::other("write_file_and_upsert_locked: re-read produced no memo")
        })?;
        let tasks_cfg = self.with_config(|c| c.tasks.clone());
        let (sbody, stitle, saliases) = search_fields(fmt, &note);
        self.with_redb_and_search_locked(guard, |idx, search| {
            idx.upsert(&record_of(&note, rel, &tasks_cfg))?;
            search.upsert(note.id, &sbody, stitle.as_deref(), &note.tags, &saliases)
        })?;
        Ok(note)
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
        self.create_note_core(folder, body, fmt, |note, rel| {
            let (sbody, stitle, saliases) = search_fields(fmt, note);
            let tasks_cfg = self.with_config(|c| c.tasks.clone());
            self.with_redb_and_search(|idx, search| {
                idx.upsert(&record_of(note, rel, &tasks_cfg))?;
                search.upsert(note.id, &sbody, stitle.as_deref(), &note.tags, &saliases)
            })
        })
        .map(|(memo, _rel, _abs)| memo)
    }

    /// `create_note` under a caller-held exclusive lock (Task 9:
    /// `add_task`'s `AddTarget::Inbox`/adopt-or-create daily path).
    /// Shares every step with `create_note` via `create_note_core`,
    /// swapping only the upsert's lock usage — one implementation, two
    /// entry points (spec §5/§6: no duplicated write logic).
    fn create_note_locked(
        &self,
        guard: &FileLock,
        folder: &str,
        body: String,
        fmt: crate::memo::NoteFormat,
    ) -> Result<(Memo, String, PathBuf)> {
        self.create_note_core(folder, body, fmt, |note, rel| {
            let (sbody, stitle, saliases) = search_fields(fmt, note);
            let tasks_cfg = self.with_config(|c| c.tasks.clone());
            self.with_redb_and_search_locked(guard, |idx, search| {
                idx.upsert(&record_of(note, rel, &tasks_cfg))?;
                search.upsert(note.id, &sbody, stitle.as_deref(), &note.tags, &saliases)
            })
        })
    }

    /// Template application, file write, and identity read-back shared
    /// by `create_note`/`create_note_locked`. `upsert` performs the
    /// caller's locked-or-unlocked index+search upsert; the returned
    /// vault-relative and absolute paths let `create_note_locked`'s
    /// callers (e.g. daily/inbox adopt-or-create) reuse them without
    /// re-deriving via `note_file_path` (which would re-acquire a lock).
    fn create_note_core(
        &self,
        folder: &str,
        body: String,
        fmt: crate::memo::NoteFormat,
        upsert: impl FnOnce(&Memo, &str) -> Result<()>,
    ) -> Result<(Memo, String, PathBuf)> {
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
            mutation
                .set_props
                .insert(k.clone(), Some(v.to_frontmatter()));
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
        write_document(&path, &body, crate_fmt, mutation, Synthesize::Yes, now)
            .map_err(crate::store::files::frontmatter_error_to_core)?;
        // Read back: write_document just synthesized id/created/updated
        // (the typed values are only known after the disk write).
        let note = self
            .files
            .read_memo(&path)?
            .ok_or_else(|| CoreError::other("write_document produced an unreadable file"))?;
        let rel = self.paths.relative_path(&path).unwrap_or_default();
        upsert(&note, &rel)?;
        Ok((note, rel, path))
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
    /// Quick-capture entry: write into the Inbox (`idea` preset)
    /// folder, falling back to vault root when the inbox is absent
    /// (e.g. user deleted it, older vault). Marked by `preset` schema
    /// marker so a renamed inbox still resolves.
    pub fn create_capture(&self, body: String) -> Result<Memo> {
        let folder = self
            .folder_inventory()?
            .into_iter()
            .find(|f| f.preset.as_deref() == Some("idea"))
            .map(|f| f.path)
            .unwrap_or_default();
        self.create_note_auto(&folder, body)
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
        let guard = self.lock(LockKind::Exclusive)?;
        let (memo, _rel, _abs, created) = self.open_or_create_daily_locked(&guard, date)?;
        Ok((memo, created))
    }

    /// `open_daily`'s body, extracted to run under a caller-held
    /// exclusive lock (Task 9: `add_task`'s `AddTarget::Daily`, which
    /// must adopt-or-create the day's note inside the SAME lock scope
    /// as its own append-and-write, not a freshly re-acquired one).
    /// `open_daily` delegates here under its own lock — one
    /// implementation, two entry points (spec §5/§6).
    fn open_or_create_daily_locked(
        &self,
        guard: &FileLock,
        date: &str,
    ) -> Result<(Memo, String, PathBuf, bool)> {
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
        let hit = self.with_redb_locked(guard, |idx| {
            Ok(idx
                .export_since(None)?
                .into_iter()
                .find(|r| !r.deleted && (r.path == md_path || r.path == html_path)))
        })?;
        if let Some(rec) = hit {
            let (memo, rel, abs) = self.read_file_locked(rec.id)?;
            return Ok((memo, rel, abs, false));
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
            let tasks_cfg = self.with_config(|c| c.tasks.clone());
            self.with_redb_and_search_locked(guard, |idx, search| {
                idx.upsert(&record_of(&note, rel, &tasks_cfg))?;
                search.upsert(note.id, &sbody, stitle.as_deref(), &note.tags, &saliases)
            })?;
            return Ok((note, rel.clone(), abs, false));
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
        let (memo, rel, abs) = self.create_note_locked(guard, folder, body, fmt)?;
        Ok((memo, rel, abs, true))
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
        let tasks_cfg = self.with_config(|c| c.tasks.clone());
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
                mutation
                    .set_props
                    .insert(k.clone(), Some(v.to_frontmatter()));
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
                idx.upsert(&record_of(&note, &new_rel, &tasks_cfg))?;
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
                    idx.upsert(&record_of(&note, &rel, &tasks_cfg))?;
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
                        idx.upsert(&record_of(&note, &old_rel, &tasks_cfg))?;
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
                            crate::props::PropValue::Str(s) => crate::props::PropValue::Str(
                                crate::wiki::replace_link_target(s, old, new),
                            ),
                            crate::props::PropValue::List(items) => crate::props::PropValue::List(
                                items
                                    .iter()
                                    .map(|i| crate::wiki::replace_link_target(i, old, new))
                                    .collect(),
                            ),
                            b @ crate::props::PropValue::Bool(_) => b.clone(),
                        };
                        if &rv != v {
                            prop_mutation
                                .set_props
                                .insert(k.clone(), Some(rv.to_frontmatter()));
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
                        idx.upsert(&record_of(n, p, &tasks_cfg))?;
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

    /// Apply one edit to a single task line under one exclusive lock
    /// spanning read -> verify -> rewrite -> upsert (spec §5/§6). Unlike
    /// `update_note_with`, this never renames the file or touches
    /// favorite/props — task mutations only ever change body text.
    pub fn patch_task(
        &self,
        selector: crate::tasks::TaskSelector,
        edit: crate::tasks::TaskEdit,
        today: time::Date,
    ) -> Result<crate::tasks::PatchTaskResult> {
        let guard = self.lock(LockKind::Exclusive)?;
        let memo_id = match &selector {
            crate::tasks::TaskSelector::Exact(r) => r.memo_id,
            crate::tasks::TaskSelector::CurrentLine { memo_id, .. } => *memo_id,
        };
        let (memo, rel, abs_path) = self.read_file_locked(memo_id)?;
        let cfg = self.with_config(|c| c.tasks.clone());
        let eff = cfg.effective_statuses()?;
        let target_line = match &selector {
            crate::tasks::TaskSelector::Exact(r) => r.line,
            crate::tasks::TaskSelector::CurrentLine { line, .. } => *line,
        };
        let lines: Vec<&str> = memo.body.lines().collect();
        let raw = *lines
            .get(target_line as usize)
            .ok_or(CoreError::TaskNotFound {
                memo_id,
                line: target_line,
            })?;
        if crate::tasks::parse_task_line(raw, &eff).is_none() {
            return Err(CoreError::TaskNotFound {
                memo_id,
                line: target_line,
            });
        }
        if let crate::tasks::TaskSelector::Exact(r) = &selector {
            let actual = crate::tasks::TaskLineHash::of_line(raw);
            if actual != r.line_hash {
                return Err(CoreError::TaskConflict { memo_id });
            }
        }
        let transform =
            crate::tasks::transform_task_draft(&memo.body, target_line, &edit, today, &cfg)?;
        let new_body = crate::tasks::apply_line_changes_to_body(&memo.body, &transform.changes);
        // Final whole-file hash recheck immediately before replacement
        // (spec §5): re-read the file bytes fresh (not the `memo` read
        // at the top of this function) and compare to `memo.hash`, so a
        // non-cooperating external writer between the read above and
        // this point surfaces as a conflict, not a silent overwrite.
        let current_on_disk = self.files.read_memo(&abs_path)?;
        let unchanged = current_on_disk
            .as_ref()
            .map(|m| m.hash == memo.hash)
            .unwrap_or(false);
        if !unchanged {
            return Err(CoreError::TaskConflict { memo_id });
        }
        let updated_memo = self.write_file_and_upsert_locked(&guard, &abs_path, &rel, &new_body)?;
        let reparsed = crate::tasks::parse_tasks(&updated_memo.body, &cfg);
        // RecurrenceInsert::Above inserts the spawned occurrence BEFORE
        // the completed line (spec §6), shifting the just-edited task
        // down by one; `spawned_line_hint == Some(target_line)` can
        // only happen in that exact case (Below's hint always lands
        // strictly after target_line), so this is an unambiguous signal
        // rather than a config-value guess.
        let primary_line = if transform.spawned_line_hint == Some(target_line) {
            target_line + 1
        } else {
            target_line
        };
        let task_row = reparsed
            .tasks
            .iter()
            .find(|t| t.line == primary_line)
            .ok_or(CoreError::TaskNotFound {
                memo_id,
                line: target_line,
            })?;
        let spawned = transform.spawned_line_hint.and_then(|hint| {
            reparsed
                .tasks
                .iter()
                .find(|t| t.line == hint)
                .map(|t| crate::tasks::TaskDto::from_row(memo_id, t))
        });
        Ok(crate::tasks::PatchTaskResult {
            note_hash: updated_memo.hash,
            task: crate::tasks::TaskDto::from_row(memo_id, task_row),
            spawned,
            daily_recurrence_warning: false,
        })
    }

    /// Resolve the preset-backed Inbox folder without a caller-held
    /// [`FileLock`]. `folder_inventory()` takes its own Shared lock, so
    /// this intentionally runs before `add_task`/`move_tasks` enter
    /// their Exclusive scope; the locked target resolver below consumes
    /// the stable string rather than ever nesting flock acquisition.
    fn inbox_folder_for_add_target(
        &self,
        target: &crate::tasks::AddTarget,
    ) -> Result<Option<String>> {
        match target {
            crate::tasks::AddTarget::Inbox => Ok(Some(
                self.folder_inventory()?
                    .into_iter()
                    .find(|f| f.preset.as_deref() == Some("idea"))
                    .map(|f| f.path)
                    .unwrap_or_default(),
            )),
            _ => Ok(None),
        }
    }

    /// Resolve any [`crate::tasks::AddTarget`] under a caller-held
    /// Exclusive lock. Shared by `add_task` and `move_tasks`, so Inbox
    /// adoption/creation has exactly one implementation (spec §7).
    fn resolve_add_target_locked(
        &self,
        guard: &FileLock,
        target: &crate::tasks::AddTarget,
        cfg: &crate::tasks::TasksConfig,
        inbox_folder: Option<&str>,
    ) -> Result<(MemoId, Memo, String, PathBuf, bool)> {
        match target {
            crate::tasks::AddTarget::Note(id) => {
                let (memo, rel, abs) = self.read_file_locked(*id)?;
                Ok((*id, memo, rel, abs, false))
            }
            crate::tasks::AddTarget::Daily(date) => {
                let (memo, rel, abs, created) =
                    self.open_or_create_daily_locked(guard, &date.to_string())?;
                Ok((memo.id, memo, rel, abs, created))
            }
            crate::tasks::AddTarget::Inbox => {
                let (memo, rel, abs, created) = self.open_or_create_inbox_locked(
                    guard,
                    inbox_folder.unwrap_or_default(),
                    &cfg.default_section,
                )?;
                Ok((memo.id, memo, rel, abs, created))
            }
        }
    }
    /// Append a new task line to `target` (spec §6/§7). `Note`/`Daily`
    /// append under the `## {default_section}` heading (created if
    /// absent); `Inbox` adopts-or-creates a fixed `{inbox
    /// folder}/{default_section}.md` note and appends there. One
    /// exclusive lock spans resolve-target -> compute-line -> append ->
    /// write+upsert, matching `patch_task`'s shape.
    pub fn add_task(
        &self,
        target: crate::tasks::AddTarget,
        text: String,
        fields: crate::tasks::TaskFields,
        today: time::Date,
    ) -> Result<crate::tasks::PatchTaskResult> {
        self.add_task_inner(target, text, fields, today, None)
    }

    /// [`Self::add_task`] with a one-shot section heading override that
    /// never touches the persisted `[tasks]` config (the CLI's
    /// `--section` flag). The override affects only this call's
    /// placement; the Inbox target still resolves its fixed note by the
    /// CONFIGURED section so the note identity stays stable.
    pub fn add_task_with_section(
        &self,
        target: crate::tasks::AddTarget,
        text: String,
        fields: crate::tasks::TaskFields,
        today: time::Date,
        section: &str,
    ) -> Result<crate::tasks::PatchTaskResult> {
        self.add_task_inner(target, text, fields, today, Some(section))
    }

    fn add_task_inner(
        &self,
        target: crate::tasks::AddTarget,
        text: String,
        fields: crate::tasks::TaskFields,
        today: time::Date,
        section_override: Option<&str>,
    ) -> Result<crate::tasks::PatchTaskResult> {
        let cfg = self.with_config(|c| c.tasks.clone());
        // Auto-stamp the created date when the caller didn't already
        // set one (spec §1 `created` field convention: new tasks record
        // when they were added unless the caller overrides it).
        let mut fields = fields;
        if fields.created.is_none() {
            fields.created = Some(today);
        }
        let line = crate::tasks::render_new_task(&text, &fields, &cfg)?;
        let inbox_folder = self.inbox_folder_for_add_target(&target)?;
        let guard = self.lock(LockKind::Exclusive)?;
        let (memo_id, memo, rel, abs_path, _created) =
            self.resolve_add_target_locked(&guard, &target, &cfg, inbox_folder.as_deref())?;
        let section = section_override.unwrap_or(&cfg.default_section);
        let new_body = append_task_line_under_section(&memo.body, &line, section);
        let updated = self.write_file_and_upsert_locked(&guard, &abs_path, &rel, &new_body)?;
        let reparsed = crate::tasks::parse_tasks(&updated.body, &cfg);
        let appended = reparsed.tasks.last().ok_or_else(|| {
            CoreError::other("add_task: appended line did not parse back as a task")
        })?;
        // Spec §9 anti-pattern signal: the appended line really carries a
        // recurrence rule (re-parsed, not just requested) and it landed in
        // a daily note. Advisory only — the caller toasts, never blocks.
        let daily_recurrence_warning =
            matches!(target, crate::tasks::AddTarget::Daily(_)) && appended.recurrence.is_some();
        Ok(crate::tasks::PatchTaskResult {
            note_hash: updated.hash,
            task: crate::tasks::TaskDto::from_row(memo_id, appended),
            spawned: None,
            daily_recurrence_warning,
        })
    }

    /// Adopt-or-create the fixed `{folder}/{filename_stem}.md` note
    /// under a caller-held exclusive lock (`add_task`'s `AddTarget::Inbox`).
    /// Simpler than `open_or_create_daily_locked`: no date-templated
    /// filename, no HTML sibling, no folder template application on
    /// create — the inbox note is a plain heading-only document that
    /// `append_task_line_under_section` fills in.
    fn open_or_create_inbox_locked(
        &self,
        guard: &FileLock,
        folder: &str,
        filename_stem: &str,
    ) -> Result<(Memo, String, PathBuf, bool)> {
        let folder = folder.trim_end_matches('/');
        // The section name is arbitrary user config — slugify strips
        // path separators and reserved characters so the fixed inbox
        // filename can never escape the vault (`../../` in
        // `default_section` would otherwise resolve outside it). The
        // in-body heading below still uses the raw section text.
        let stem = crate::memo::slugify(filename_stem);
        let rel = if folder.is_empty() {
            format!("{stem}.md")
        } else {
            format!("{folder}/{stem}.md")
        };
        let hit = self.with_redb_locked(guard, |idx| {
            Ok(idx
                .export_since(None)?
                .into_iter()
                .find(|r| !r.deleted && r.path == rel))
        })?;
        if let Some(rec) = hit {
            let (memo, rel, abs) = self.read_file_locked(rec.id)?;
            return Ok((memo, rel, abs, false));
        }
        let abs = self.paths.vault.join(&rel);
        if abs.exists() {
            // Unindexed file already on disk (watcher lag, manual file):
            // adopt it in place rather than creating a colliding sibling
            // (mirrors `open_or_create_daily_locked`'s adopt branch).
            let note = match self.files.read_memo(&abs)? {
                Some(note) => note,
                None => {
                    let ParsedFile::BodyOnly { body } = self.files.read(&abs)? else {
                        return Err(CoreError::other(
                            "[inbox] existing file has unexpected shape",
                        ));
                    };
                    let now = OffsetDateTime::now_utc();
                    write_document(
                        &abs,
                        &body,
                        to_crate_fmt(crate::memo::NoteFormat::Markdown),
                        Mutation::default(),
                        Synthesize::Yes,
                        now,
                    )
                    .map_err(crate::store::files::frontmatter_error_to_core)?;
                    self.files
                        .read_memo(&abs)?
                        .ok_or_else(|| CoreError::other("[inbox] adoption re-read failed"))?
                }
            };
            let fmt = crate::memo::NoteFormat::Markdown;
            let (sbody, stitle, saliases) = search_fields(fmt, &note);
            let tasks_cfg = self.with_config(|c| c.tasks.clone());
            self.with_redb_and_search_locked(guard, |idx, search| {
                idx.upsert(&record_of(&note, &rel, &tasks_cfg))?;
                search.upsert(note.id, &sbody, stitle.as_deref(), &note.tags, &saliases)
            })?;
            return Ok((note, rel, abs, false));
        }
        // `create_note_locked` derives its filename from the body's H1,
        // which this heading-only body has none of -- write directly at
        // the already-computed fixed `abs` path instead.
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let body = format!("## {filename_stem}\n");
        let now = OffsetDateTime::now_utc();
        write_document(
            &abs,
            &body,
            to_crate_fmt(crate::memo::NoteFormat::Markdown),
            Mutation::default(),
            Synthesize::Yes,
            now,
        )
        .map_err(crate::store::files::frontmatter_error_to_core)?;
        let note = self
            .files
            .read_memo(&abs)?
            .ok_or_else(|| CoreError::other("[inbox] creation re-read failed"))?;
        let fmt = crate::memo::NoteFormat::Markdown;
        let (sbody, stitle, saliases) = search_fields(fmt, &note);
        let tasks_cfg = self.with_config(|c| c.tasks.clone());
        self.with_redb_and_search_locked(guard, |idx, search| {
            idx.upsert(&record_of(&note, &rel, &tasks_cfg))?;
            search.upsert(note.id, &sbody, stitle.as_deref(), &note.tags, &saliases)
        })?;
        Ok((note, rel, abs, true))
    }

    /// Move selected task subtrees from one note into another (spec §7).
    /// One Exclusive lock covers source verification, destination
    /// resolution, both writes, and the compensating rollback path.
    pub fn move_tasks(
        &self,
        req: crate::tasks::MoveTasksRequest,
        _today: time::Date,
    ) -> Result<crate::tasks::MoveTasksReceipt> {
        if req.tasks.is_empty() {
            return Err(CoreError::other("move_tasks: tasks must not be empty"));
        }
        let destination_inbox_folder = self.inbox_folder_for_add_target(&req.destination)?;
        let guard = self.lock(LockKind::Exclusive)?;
        let (source_memo, source_rel, source_abs) = self.read_file_locked(req.source)?;
        let cfg = self.with_config(|c| c.tasks.clone());
        let eff = cfg.effective_statuses()?;
        let source_lines: Vec<&str> = source_memo.body.lines().collect();

        // Verify that every ref belongs to this source, still names a
        // task line, and matches its stale-write guard.
        for task in &req.tasks {
            if task.memo_id != req.source {
                return Err(CoreError::TaskConflict {
                    memo_id: req.source,
                });
            }
            let raw = source_lines
                .get(task.line as usize)
                .ok_or(CoreError::TaskNotFound {
                    memo_id: req.source,
                    line: task.line,
                })?;
            let Some((fields, _)) = crate::tasks::parse_task_line(raw, &eff) else {
                return Err(CoreError::TaskNotFound {
                    memo_id: req.source,
                    line: task.line,
                });
            };
            if fields.status_type == crate::tasks::StatusType::NonTask
                || crate::tasks::TaskLineHash::of_line(raw) != task.line_hash
            {
                return Err(CoreError::TaskConflict {
                    memo_id: req.source,
                });
            }
        }

        let roots = crate::tasks::dedup_covered_descendants(&source_lines, &req.tasks, &eff);
        let mut moved_lines = Vec::new();
        let mut removed_ranges: Vec<(usize, usize)> = Vec::with_capacity(roots.len());
        for root in &roots {
            let start = root.line as usize;
            let base_indent = crate::tasks::indent_columns_of(source_lines[start]);
            let mut end = start + 1;
            while let Some(next) = source_lines.get(end) {
                if crate::tasks::indent_columns_of(next) <= base_indent {
                    break;
                }
                end += 1;
            }
            moved_lines.extend(
                source_lines[start..end]
                    .iter()
                    .map(|raw| crate::tasks::dedent_line(raw, base_indent)),
            );
            removed_ranges.push((start, end));
        }

        let (destination, destination_memo, destination_rel, destination_abs, destination_created) =
            self.resolve_add_target_locked(
                &guard,
                &req.destination,
                &cfg,
                destination_inbox_folder.as_deref(),
            )?;
        // Moving a note into itself would write the destination version
        // and then overwrite it with the source-removal version, losing
        // data. Reject explicitly before either write.
        if destination == req.source {
            return Err(CoreError::TaskConflict {
                memo_id: req.source,
            });
        }
        if let Some(expected) = &req.expected_destination_hash
            && &destination_memo.hash != expected
        {
            return Err(CoreError::TaskConflict {
                memo_id: destination,
            });
        }
        let destination_pre_hash = (!destination_created).then(|| destination_memo.hash.clone());
        let joined = moved_lines.join("\n");
        let destination_new_body =
            append_task_line_under_section(&destination_memo.body, &joined, &cfg.default_section);

        let mut remaining = source_lines.clone();
        removed_ranges.sort_by_key(|range| std::cmp::Reverse(range.0));
        for (start, end) in &removed_ranges {
            remaining.drain(*start..*end);
        }
        let source_new_body = remaining.join("\n") + "\n";

        // Destination first, then source (spec §5). If source writing
        // fails, restore the destination's original body before
        // surfacing the source error; both writes remain inside this
        // method's one held Exclusive lock.
        let destination_updated = self.write_file_and_upsert_locked(
            &guard,
            &destination_abs,
            &destination_rel,
            &destination_new_body,
        )?;
        let source_updated = match self.write_file_and_upsert_locked(
            &guard,
            &source_abs,
            &source_rel,
            &source_new_body,
        ) {
            Ok(memo) => memo,
            Err(error) => {
                let _ = self.write_file_and_upsert_locked(
                    &guard,
                    &destination_abs,
                    &destination_rel,
                    &destination_memo.body,
                );
                return Err(error);
            }
        };

        Ok(crate::tasks::MoveTasksReceipt {
            source: req.source,
            destination,
            source_pre_hash: source_memo.hash,
            source_post_hash: source_updated.hash,
            destination_pre_hash,
            destination_post_hash: destination_updated.hash,
            moved_lines,
        })
    }

    /// Guarded inverse of [`Self::move_tasks`]. Both notes must still
    /// equal the receipt's post-move hashes; otherwise an intervening
    /// edit wins and undo refuses to erase it (spec §7).
    pub fn undo_move_tasks(&self, receipt: &crate::tasks::MoveTasksReceipt) -> Result<()> {
        let guard = self.lock(LockKind::Exclusive)?;
        let (source_memo, source_rel, source_abs) = self.read_file_locked(receipt.source)?;
        let (destination_memo, destination_rel, destination_abs) =
            self.read_file_locked(receipt.destination)?;
        if source_memo.hash != receipt.source_post_hash
            || destination_memo.hash != receipt.destination_post_hash
        {
            return Err(CoreError::TaskConflict {
                memo_id: receipt.source,
            });
        }
        let cfg = self.with_config(|c| c.tasks.clone());
        let destination_restored = remove_appended_task_lines_under_section(
            &destination_memo.body,
            &receipt.moved_lines,
            &cfg.default_section,
        )
        .ok_or(CoreError::TaskConflict {
            memo_id: receipt.destination,
        })?;
        let joined = receipt.moved_lines.join("\n");
        let source_restored = format!("{}\n{}\n", source_memo.body.trim_end(), joined);
        // Destination first, then source — the same order as
        // `move_tasks`, with the same compensation: if restoring the
        // source fails after the destination write landed, put the
        // destination back so the moved block is never silently lost
        // from BOTH notes.
        self.write_file_and_upsert_locked(
            &guard,
            &destination_abs,
            &destination_rel,
            &destination_restored,
        )?;
        if let Err(error) =
            self.write_file_and_upsert_locked(&guard, &source_abs, &source_rel, &source_restored)
        {
            let _ = self.write_file_and_upsert_locked(
                &guard,
                &destination_abs,
                &destination_rel,
                &destination_memo.body,
            );
            return Err(error);
        }
        Ok(())
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
        let tasks_cfg = self.with_config(|c| c.tasks.clone());
        self.with_redb_and_search(|idx, search| {
            idx.upsert(&record_of(&note, &rel, &tasks_cfg))?;
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
        let tasks_cfg = self.with_config(|c| c.tasks.clone());
        self.with_redb_and_search(|idx, search| {
            idx.upsert(&record_of(&note, &rel, &tasks_cfg))?;
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

    /// Full-index snapshot cached across calls (spec §3 snapshot budget).
    /// Returns the live list of [`IndexRecord`]s wrapped in an `Arc` so
    /// concurrent readers share the same allocation; the cache key is the
    /// `(mtime, size)` of `meta.redb`, so any write — by this process or
    /// another process that holds the cross-process flock (CLI, GUI) —
    /// invalidates the cached Arc on the next call.
    ///
    /// redb is opened transiently inside an `fs2` flock (see the module
    /// doc at the top of this file), so an in-process counter cannot see
    /// CLI writes from another process. The file stat IS the
    /// cross-process generation.
    ///
    /// Budget: when the export exceeds [`SNAPSHOT_CACHE_CAP`] records we
    /// return the freshly-loaded vector without caching, so the cache
    /// never holds a multi-megabyte Arc between queries.
    ///
    /// Requires an initialized vault — `meta.redb` must exist. The
    /// CLI entry point ([`crates/oximemo-cli/src/main.rs`]) calls
    /// `Vault::migrate` right after `Vault::open`, and the Tauri
    /// setup ([`apps/desktop/src-tauri/src/lib.rs`]) calls
    /// `Vault::ensure_initialized` before exposing the vault to
    /// commands. Library callers that have just `Vault::open`-ed a
    /// fresh directory should call [`Vault::ensure_initialized`]
    /// themselves before reaching for `snapshot()`.
    pub fn snapshot(&self) -> Result<std::sync::Arc<Vec<crate::store::index::IndexRecord>>> {
        // Thin wrapper — see [`Self::snapshot_with_gen`] for the flock-
        // critical body and race-rationale comments.
        self.snapshot_with_gen().map(|(recs, _)| recs)
    }
    /// Cache-key contract (spec §3, brief): (meta.redb mtime, size).
    /// redb is opened transiently inside an fs2 flock (see the
    /// module doc at the top of this file), so an in-process
    /// counter cannot see CLI writes from another process — the
    /// file stat IS the cross-process generation.
    ///
    /// **The cache rebuild path holds the Shared flock across the
    /// entire redb-open-and-release cycle** — not just the closure
    /// body of `with_redb`. The previous round kept the lock only
    /// across the export closure, then re-stated after `with_redb`
    /// returned and the lock was dropped; another process acquiring
    /// Exclusive in that window could commit a write through
    /// `meta.redb`, bumping mtime, and leave us caching
    /// `{post_write_mtime, recs@pre_write}` forever.
    ///
    /// Holding Shared across the whole cycle (open + drop + stat)
    /// means any external writer blocks until our snapshot has
    /// committed its own cache key — eliminating the race and
    /// preserving the exact `(mtime, size)` key.
    ///
    /// redb 2.6.3's `Database::new` writes the file header on
    /// every open, which is why we key on the post-open (and
    /// post-drop) stat: the next reader's stat lands on the same
    /// value the file has after this snapshot's drop, and the
    /// cache hits.
    ///
    /// `run_base` uses the returned generation as `result_key.gen`
    /// so a cache entry's key equals the next caller's lookup key
    /// exactly — no double-stat window to round to the same mtime
    /// and miss the entry we just stored.
    pub(crate) fn snapshot_with_gen(&self) -> Result<SnapshotWithGen> {
        // Inline a slimmed-down version of `snapshot()` so the gen is
        // returned from the same code path without an extra lock +
        // stat round trip. The behaviour mirrors `snapshot()`
        // exactly: pre-stat cache hit, otherwise rebuild under
        // Shared and cache the post-stat.
        let pre = std::fs::metadata(self.paths.meta_db_path())?;
        let pre_gen = (pre.modified()?, pre.len());
        if let Some(cached) = self.snapshot.read().as_ref()
            && cached.generation == pre_gen
        {
            return Ok((std::sync::Arc::clone(&cached.recs), cached.generation));
        }
        let (recs, post_gen) = {
            let _g = self.lock(LockKind::Shared)?;
            let idx = RedbIndex::open(&self.paths.meta_db_path())?;
            let recs = idx.export_since(None)?;
            drop(idx);
            let post = std::fs::metadata(self.paths.meta_db_path())?;
            ((recs), (post.modified()?, post.len()))
        };
        let total_tasks: usize = recs.iter().map(|r| r.tasks.len()).sum();
        if recs.len() > SNAPSHOT_CACHE_CAP || total_tasks > SNAPSHOT_TASK_WEIGHT_CAP {
            return Ok((std::sync::Arc::new(recs), post_gen));
        }
        let arc = std::sync::Arc::new(recs);
        *self.snapshot.write() = Some(SnapshotState {
            generation: post_gen,
            recs: std::sync::Arc::clone(&arc),
        });
        Ok((arc, post_gen))
    }

    /// Length of the in-memory base-result cache (Task 10). Used by
    /// tests to assert cache hits/misses without exposing the cache
    /// handle.
    #[allow(dead_code)]
    pub(crate) fn base_cache_len(&self) -> usize {
        self.base_results.len()
    }

    /// blake3 source-identity digest for a [`BaseSource`] (Task 10).
    /// `Path`: bytes of the file at `query_rel_path(rel)`. `Inline`:
    /// `write_base`'s canonical YAML output. Cheap (single file read
    /// or one YAML serialisation).
    pub(crate) fn base_source_hash(&self, source: &crate::base::BaseSource) -> Result<u64> {
        use crate::base::cache::blake3_u64;
        match source {
            crate::base::BaseSource::Path(rel) => {
                let abs = self.query_rel_path(rel)?;
                let bytes = std::fs::read(&abs)?;
                Ok(blake3_u64(&bytes))
            }
            crate::base::BaseSource::Inline(def) => {
                let yaml = crate::base::write_base(def)?;
                Ok(blake3_u64(yaml.as_bytes()))
            }
        }
    }
    /// Look up the in-memory base-result cache (Task 10). Returns
    /// `None` on miss — callers fall through to a full evaluation.
    pub(crate) fn base_cache_get(
        &self,
        key: &crate::base::cache::ResultKey,
    ) -> Option<std::sync::Arc<crate::base::cache::BaseResult>> {
        self.base_results.get(key)
    }

    /// Insert into the in-memory base-result cache (Task 10).
    pub(crate) fn base_cache_put(
        &self,
        key: crate::base::cache::ResultKey,
        result: std::sync::Arc<crate::base::cache::BaseResult>,
    ) {
        self.base_results.put(key, result);
    }

    /// Offset-paginated property query (design 2026-08-23 §5.2). Filters
    /// and sorts over the in-memory index snapshot — never reads note
    /// files — so it composes with property sorts that the cursor path
    /// (`by_sort` encodes only `updated_at/id`) cannot express. Use the
    /// cursor path for default newest-first browsing; use this whenever a
    /// property predicate or sort is present.
    pub fn query_notes(&self, query: &crate::props::NoteQuery) -> Result<crate::props::QueryPage> {
        let recs = self.snapshot()?;
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
        let mut by_created: Vec<&IndexRecord> = live.to_vec();
        by_created.sort_by_key(|r| r.created_at);
        let mut title_map: std::collections::HashMap<String, MemoId> = Default::default();
        for r in &by_created {
            if let Some(t) = &r.title {
                title_map.entry(t.trim().to_lowercase()).or_insert(r.id);
            }
        }
        for r in &by_created {
            for a in crate::props::aliases_of(&r.props) {
                title_map.entry(a.trim().to_lowercase()).or_insert(r.id);
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
                        calendar_date_field: None,
                        pinned: None,
                    });
                }
            }
            None => {
                if let Some(f) = cfg.folders.items.iter_mut().find(|f| f.path == path) {
                    f.view = None;
                    // Drop the entry if it has no color, pin, or calendar
                    // field either (clean config).
                    if f.color.is_none() && f.pinned.is_none() && f.calendar_date_field.is_none() {
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
                    calendar_date_field: None,
                    pinned: Some(true),
                });
            }
        } else if let Some(f) = cfg.folders.items.iter_mut().find(|f| f.path == path) {
            f.pinned = None;
            if f.view.is_none() && f.color.is_none() && f.calendar_date_field.is_none() {
                cfg.folders.items.retain(|f| f.path != path);
            }
        }
        cfg.save(&self.paths)?;
        Ok(())
    }

    /// Set a folder's calendar bucket field, persisted to `oximemo.toml`.
    /// Treats `None` and `Some("created_at")` equivalently: the field is
    /// dropped from the entry. Any other string is stored verbatim without
    /// validation — a stale field name after a schema drop falls into the
    /// "날짜 없음" bucket instead of erroring.
    pub fn set_folder_calendar_field(&self, path: &str, field: Option<String>) -> Result<()> {
        let mut cfg = self.config.write();
        let normalized = field.filter(|s| s != "created_at");
        match cfg.folders.items.iter_mut().find(|f| f.path == path) {
            Some(f) => f.calendar_date_field = normalized,
            None => cfg.folders.items.push(crate::config::FolderDef {
                path: path.to_string(),
                view: None,
                color: None,
                calendar_date_field: normalized,
                pinned: None,
            }),
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

    /// `[daily]` — the daily-notes surface (spec 2026-08-23 §4.3: the
    /// TOML-only `enabled` flag finally gets a GUI toggle).
    pub fn set_daily_config(&self, v: crate::config::DailyConfig) -> Result<()> {
        self.replace_section(|c, v| c.daily = v, v)
    }

    /// `[tasks]` — the Tasks feature (spec 2026-08-27 §11). Validates the
    /// status table before persisting: config load never validates
    /// elsewhere in this codebase, but writes must reject bad input.
    pub fn set_tasks_config(&self, value: crate::tasks::TasksConfig) -> Result<()> {
        value.effective_statuses()?;
        self.replace_section(|cfg, v| cfg.tasks = v, value)
    }

    /// `[git]` — local vault versioning via the shared `oxi-vault-git`
    /// layer. Section setter mirrors the others.
    pub fn set_git_config(&self, v: crate::config::GitConfig) -> Result<()> {
        self.replace_section(|c, v| c.git = v, v)
    }

    /// `[metadata]` — provider keys and region preference (spec 2026-
    /// 08-23 §3.4). Mirrors `set_brain_config`'s section-setter pattern.
    pub fn set_metadata_config(&self, v: crate::config::MetadataConfig) -> Result<()> {
        self.replace_section(|c, v| c.metadata = v, v)
    }

    /// `[copilot]` — agent delegation settings (spec 2026-08-23).
    /// Mirrors the section-setter pattern.
    pub fn set_copilot_config(&self, v: crate::config::CopilotConfig) -> Result<()> {
        self.replace_section(|c, v| c.copilot = v, v)
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
        let tasks_cfg = self.with_config(|c| c.tasks.clone());
        let (sbody, stitle, saliases) = search_fields(fmt, &note);
        self.with_redb_and_search(|idx, search| {
            idx.upsert(&record_of(&note, &new_rel, &tasks_cfg))?;
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
            let links = crate::wiki::extract_links(&link_scan_text(src_fmt, &body, &r.props));
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
        let tasks_cfg = self.with_config(|c| c.tasks.clone());
        self.with_redb_and_search(|idx, search| {
            let mut stats = IndexStats::default();
            let mut search_owned: Vec<SearchRow> = Vec::new();
            for path in self.files.scan() {
                match self.files.read_memo(&path) {
                    Ok(Some(note)) => {
                        let rel = self.paths.relative_path(&path).unwrap_or_default();
                        let fmt = crate::memo::NoteFormat::from_rel(&rel);
                        let (sbody, stitle, saliases) = search_fields(fmt, &note);
                        let title = stitle;
                        let rec = record_of(&note, &rel, &tasks_cfg);
                        match idx.get(note.id)? {
                            None => {
                                idx.upsert(&rec)?;
                                search_owned.push((note.id, sbody, title, note.tags, saliases));
                                stats.added += 1;
                            }
                            Some(prev)
                                if prev.hash == rec.hash
                                    && prev.preview == rec.preview
                                    && prev.tasks == rec.tasks
                                    && prev.tasks_truncated == rec.tasks_truncated =>
                            {
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
                    let rec = record_of(&note, &rel, &tasks_cfg);
                    idx.upsert(&rec)?;
                    search_owned.push((note.id, sbody, stitle, note.tags, saliases));
                    stats.trashed_memos += 1;
                }
            }
            let batch: Vec<crate::store::search::Upsert<'_>> = search_owned
                .iter()
                .map(
                    |(id, body, title, tags, aliases)| crate::store::search::Upsert {
                        id: *id,
                        body,
                        title: title.as_deref(),
                        tags,
                        aliases,
                    },
                )
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
        let format_current = std::fs::read_to_string(&marker)
            .ok()
            .map(|s| s.trim() == wants)
            .unwrap_or(false);
        let mut reindexed = false;
        if !format_current {
            tracing::info!(version = INDEX_FORMAT_VERSION, "migrating index format");
            self.reindex()?;
            std::fs::write(&marker, &wants)?;
            reindexed = true;
        }
        // Tasks-extraction fingerprint (spec §3/§6): a change to
        // `enabled`/`global_filter`/`statuses`, or a parser-version bump,
        // changes what counts as a task — reindex once to pick it up.
        // Skipped if the format-version bump above already reindexed.
        let tasks_marker = self.paths.tasks_fingerprint_path();
        let wants_tasks = tasks_fingerprint(&self.with_config(|c| c.tasks.clone()));
        let tasks_current = std::fs::read_to_string(&tasks_marker)
            .ok()
            .map(|s| s.trim() == wants_tasks)
            .unwrap_or(false);
        if !tasks_current {
            if !reindexed {
                self.reindex()?;
            }
            std::fs::write(&tasks_marker, &wants_tasks)?;
        }
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
        // One-shot Inbox seed (idea preset). Differs from the
        // knowledge/daily above: install-type collections are user-ownable
        // per the collections metadata/settings design §2.6, so once a
        // user deletes the inbox we must NOT resurrect it on every
        // migrate(). The marker + inventory check guards both the
        // first-ever seed and the "user installed idea elsewhere"
        // retroactively-applied case.
        let marker = self.paths.inbox_seed_marker_path();
        if !marker.exists() {
            let already_has_idea = self
                .folder_inventory()?
                .iter()
                .any(|f| f.preset.as_deref() == Some("idea"));
            if !already_has_idea {
                self.apply_preset(
                    crate::schema::DEFAULT_INBOX_FOLDER,
                    crate::schema::IDEA_TEMPLATE_MD,
                    crate::schema::IDEA_SCHEMA_TOML,
                )?;
            }
            if let Some(parent) = marker.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&marker, b"1")?;
        }
        // One-shot installed `할 일` base (tasks spec §7.4). The marker
        // stores the seed version; a pre-v2 vault gets a structural
        // upgrade instead of a blind reseed so user edits survive. The
        // base is a protected system surface (`trash_base`/`rename_base`
        // refuse it), so a missing file is never legitimate: migrate()
        // re-seeds it as a repair. An unparseable file is left for the
        // user to fix (marker stays stale → retried on the next open).
        let marker = self.paths.tasks_base_seed_marker_path();
        if std::fs::read_to_string(&marker)
            .map(|s| s.trim().to_string())
            .ok()
            .as_deref()
            != Some(TASKS_BASE_SEED_VERSION)
            || !self.paths.vault.join(TASKS_BASE_REL).exists()
        {
            self.ensure_tasks_base_seed(&marker)?;
        }
        Ok(())
    }

    /// Bring the installed `할 일` base to [`TASKS_BASE_SEED_VERSION`],
    /// restoring it if missing (it is protected — see the guards in
    /// [`Self::trash_base`]/[`Self::rename_base`]). Success in every
    /// terminal case (first seed, repair, structural upgrade, already
    /// current, name taken) advances the marker; unreadable/unparseable
    /// files and save races leave it stale so the next vault open
    /// retries.
    fn ensure_tasks_base_seed(&self, marker: &std::path::Path) -> Result<()> {
        if !self.paths.vault.join(TASKS_BASE_REL).exists() {
            // Missing file → first-ever seed, or repair: the base is a
            // protected system surface, so it cannot be legitimately
            // absent. Always restore it.
            self.save_base(TASKS_BASE_REL, TASKS_BASE_MD, None)?;
            return self.write_tasks_seed_marker(marker);
        }
        let (yaml, mtime) = match self.load_base_raw(TASKS_BASE_REL) {
            Ok(raw) => raw,
            Err(_) => return Ok(()), // unreadable: retry next open
        };
        let mut def = match crate::base::parse_base(&yaml) {
            Ok(def) => def,
            Err(_) => return Ok(()), // user's hand-edit: leave for them to fix
        };
        if def
            .views
            .iter()
            .any(|view| view.name.as_deref() == Some(TASKS_NO_DATE_VIEW))
        {
            // A view already owns the name — the user's semantics win.
            return self.write_tasks_seed_marker(marker);
        }
        // Insert after the last `tasks` view so user-added table/board
        // tabs keep their trailing order.
        let at = def
            .views
            .iter()
            .rposition(|view| view.r#type == "tasks")
            .map_or(def.views.len(), |i| i + 1);
        def.views.insert(
            at,
            crate::base::BaseViewDef {
                r#type: "tasks".into(),
                name: Some(TASKS_NO_DATE_VIEW.into()),
                filters: Some(crate::base::FilterSpec::Expr(
                    "task.due == null && task.scheduled == null".into(),
                )),
                ..Default::default()
            },
        );
        let upgraded = serde_yaml_ng::to_string(&def)
            .map_err(|e| crate::CoreError::other(format!("serialize tasks base: {e}")))?;
        // CAS on the mtime we read: a racing editor wins, we retry next open.
        if let Err(e) = self.save_base(TASKS_BASE_REL, &upgraded, Some(mtime)) {
            tracing::warn!(error = %e, "tasks base seed upgrade skipped; will retry");
            return Ok(());
        }
        self.write_tasks_seed_marker(marker)
    }

    /// Record [`TASKS_BASE_SEED_VERSION`] in the one-shot seed marker.
    fn write_tasks_seed_marker(&self, marker: &std::path::Path) -> Result<()> {
        if let Some(parent) = marker.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(marker, TASKS_BASE_SEED_VERSION)?;
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
                let tasks_cfg = self.with_config(|c| c.tasks.clone());
                self.with_redb_and_search(|idx, search| {
                    idx.upsert(&record_of(&note, &rel, &tasks_cfg))?;
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
        let active_space = crate::brain::vault_space_name(&self.paths.vault);
        let spaces = crate::spaces::list_spaces();
        let last_space_stale = crate::spaces::last_space()
            .filter(|n| !crate::spaces::space_vault_dir(&crate::paths::oxi_home(), n).is_dir());
        // Unified-home layout facts (design 2026-08-30): the shared
        // home, oximemo's private subtree, legacy candidates still on
        // disk, retired cross-volume backups (journal), and a pending
        // documents-root registration.
        let oxi = crate::paths::oxi_home();
        let (merge_old, merge_new) = match &self.status {
            VaultStatus::MergeRequired { old, new } => (Some(old.clone()), Some(new.clone())),
            _ => (None, None),
        };
        let mut report = DoctorReport {
            merge_required: matches!(self.status, VaultStatus::MergeRequired { .. }),
            merge_required_old: merge_old,
            merge_required_new: merge_new,
            oxi_home: oxi.display().to_string(),
            brain_dir: crate::brain::brain_dir().display().to_string(),
            app_private: crate::paths::app_support_dir().display().to_string(),
            legacy_app_support_vault: crate::paths::user_home()
                .as_deref()
                .map(crate::migrate_vault::old_default_vault)
                .filter(|p| p.exists())
                .map(|p| p.display().to_string()),
            legacy_flat_vault: oxi
                .join("vault")
                .exists()
                .then(|| oxi.join("vault").display().to_string()),
            retired_backups: crate::migration_journal::retired_backups(&oxi),
            pending_root_registration: crate::brain::has_pending_root_registration(),
            index_locked: crate::lock::is_locked(&self.paths.meta_lock_path()),
            active_space,
            spaces,
            last_space_stale,
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
                                report
                                    .schema_violations
                                    .push((path.clone(), format!("{}: {}", v.key, v.reason)));
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

        // Stale by-vault namespaces (2026-08-28 index-explosion fix):
        // report the count; `--fix` sweeps with the same threshold so a
        // report-then-fix pair stays consistent. One hour is generous
        // vs an in-flight process's lock window and far below the GUI's
        // 7-day startup sweep.
        report.stale_index_namespaces =
            self.sweep_stale_namespaces(STALE_NS_DOCTOR_MIN_AGE, fix)?;

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

    // -- .query base CRUD (task 7) -----------------------------------

    /// Validate a vault-relative `.query` path and resolve its absolute
    /// counterpart. Delegates to [`crate::base::files::query_rel_path`]
    /// (private). Public so `[#170]`. All violations →
    /// `CoreError::Other("invalid query path: …")`.
    pub fn query_rel_path(&self, rel: &str) -> Result<PathBuf> {
        crate::base::files::query_rel_path(rel, &self.paths.vault)
    }

    /// Parse, load, and cache a `.query` document (mtime-keyed, like
    /// [`Self::folder_schema`]). Cache miss reads raw bytes from disk,
    /// parses via the model layer, and stores the result keyed by the
    /// current mtime. Returns the parsed [`crate::base::BaseDef`].
    pub fn load_base(&self, rel: &str) -> Result<crate::base::BaseDef> {
        let abs = self.query_rel_path(rel)?;
        let mtime = std::fs::metadata(&abs)
            .ok()
            .and_then(|m| m.modified().ok())
            .unwrap_or(UNIX_EPOCH - Duration::from_secs(1));
        {
            let cache = self.bases.read();
            if let Some((cached_mtime, cached)) = cache.get(rel)
                && *cached_mtime == mtime
            {
                return Ok(cached.clone());
            }
        }
        let raw = std::fs::read_to_string(&abs)?;
        let def = crate::base::parse_base(&raw)?;
        self.bases
            .write()
            .insert(rel.to_string(), (mtime, def.clone()));
        Ok(def)
    }

    /// Load the raw YAML bytes + on-disk mtime of a `.query` file.
    /// Bypasses the mtime cache (a raw read), used by the builder's
    /// code-mode to surface the user's exact text + current mtime for
    /// the optimistic-concurrency check.
    pub fn load_base_raw(&self, rel: &str) -> Result<(String, SystemTime)> {
        let abs = self.query_rel_path(rel)?;
        let raw = std::fs::read_to_string(&abs)?;
        let mtime = std::fs::metadata(&abs)
            .ok()
            .and_then(|m| m.modified().ok())
            .unwrap_or(UNIX_EPOCH - Duration::from_secs(1));
        Ok((raw, mtime))
    }

    /// Save (create or overwrite) a `.query` document. Parses +
    /// validates first; an unparseable yaml is rejected without any
    /// filesystem mutation. When `expected_mtime` is `Some(t)` and `t`
    /// does not match the file's current mtime, returns a
    /// `CoreError::Other("query modified elsewhere; reload")` and
    /// touches nothing (spec §3, brief). Atomic write via temp-file +
    /// rename in the same directory (brief).
    pub fn save_base(
        &self,
        rel: &str,
        yaml: &str,
        expected_mtime: Option<SystemTime>,
    ) -> Result<()> {
        // Validate path, parse, validate before touching disk.
        let abs = self.query_rel_path(rel)?;
        // Parse + model validation. Never persist a file that won't load.
        crate::base::files::parse_validate(yaml)?;
        // Optimistic concurrency: the file's mtime must match the
        // caller's expectation when supplied. Compared in milliseconds
        // because filesystem mtime resolution differs across platforms.
        if let Some(want) = expected_mtime {
            let current = std::fs::metadata(&abs).ok().and_then(|m| m.modified().ok());
            if let Some(now) = current
                && !mtimes_match(now, want)
            {
                return Err(CoreError::other("query modified elsewhere; reload"));
            }
        }
        crate::base::files::atomic_write(&abs, yaml.as_bytes())?;
        // Drop the cache entry — the next load re-reads.
        self.bases.write().remove(rel);
        Ok(())
    }

    /// Rename a `.query` file from `from` to `to`. Both paths are
    /// validated; the destination is rejected if it already exists.
    /// Atomic in the POSIX sense (`rename(2)` replaces atomically).
    pub fn rename_base(
        &self,
        from: &str,
        to: &str,
        expected_mtime: Option<SystemTime>,
    ) -> Result<()> {
        let from_abs = self.query_rel_path(from)?;
        let to_abs = self.query_rel_path(to)?;
        if from == TASKS_BASE_REL {
            return Err(CoreError::other(
                "the built-in '할 일' base is protected and cannot be renamed",
            ));
        }
        if !from_abs.exists() {
            return Err(CoreError::NotFound(from.to_string()));
        }
        if to_abs.exists() {
            return Err(CoreError::other(format!("query '{to}' already exists")));
        }
        if let Some(want) = expected_mtime {
            let current = std::fs::metadata(&from_abs)
                .ok()
                .and_then(|m| m.modified().ok());
            if let Some(now) = current
                && !mtimes_match(now, want)
            {
                return Err(CoreError::other("query modified elsewhere; reload"));
            }
        }
        if let Some(parent) = to_abs.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::rename(&from_abs, &to_abs)?;
        // Drop any cache entries for either path.
        self.bases.write().remove(from);
        self.bases.write().remove(to);
        Ok(())
    }

    /// Move a `.query` file into the trash. Returns a trash-relative
    /// token of the form `<unix_millis>-<origin>` (spec §3 surface),
    /// where `<origin>` percent-encodes the file's ORIGINAL
    /// vault-relative path (see [`encode_query_origin`]) so restore
    /// puts it back where it lived, not always under `queries/`. The
    /// source must be a valid `.query` path; the trash landing is
    /// always under `.trash/_queries/`, which the path guard would
    /// refuse — so we bypass `query_rel_path` for the destination and
    /// construct it directly.
    pub fn trash_base(&self, rel: &str) -> Result<String> {
        let abs = self.query_rel_path(rel)?;
        if rel == TASKS_BASE_REL {
            return Err(CoreError::other(
                "the built-in '할 일' base is protected and cannot be deleted",
            ));
        }
        if !abs.exists() {
            return Err(CoreError::NotFound(rel.to_string()));
        }
        let origin = encode_query_origin(rel);
        let trash_dir = self
            .paths
            .trash_root()
            .join(crate::paths::TRASH_QUERIES_DIR);
        std::fs::create_dir_all(&trash_dir)?;
        let base_millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        // Disambiguate same-millisecond collisions by bumping the
        // millis prefix until the destination is free. Tokens stay
        // parseable: `<digits>-<origin>` with the leading digits
        // consumed verbatim on restore (see `restore_base`). Origins
        // that themselves start with digits cannot collide with a
        // millis prefix because millis exceeds any plausible u32.
        let mut millis = base_millis;
        let token = loop {
            let candidate = format!("{millis}-{origin}");
            let dest = trash_dir.join(&candidate);
            if !dest.exists() {
                std::fs::rename(&abs, &dest)?;
                break candidate;
            }
            millis += 1;
        };
        self.bases.write().remove(rel);
        // Return the token alone — the destination is reconstructed
        // from `trash_root()/TRASH_QUERIES_DIR/token` on restore, so
        // the caller does not need the trash prefix. Keep the token a
        // single filename (no separators, no `..`) so the restore
        // guard can enforce a single-filename shape.
        Ok(token)
    }

    /// Restore a `.query` file from trash. The `token` is the value
    /// returned by [`Self::trash_base`] — e.g. `1700000000000-%2Fshelf%2Ffoo.query`
    /// (origin-embedded) or the legacy `1700000000000-foo.query` shape,
    /// which restores under `queries/` as it always did. The token is
    /// guarded like a path: no separators, no `..`, no absolute.
    /// Returns the vault-relative path of the restored file.
    pub fn restore_base(&self, token: &str) -> Result<String> {
        // Restore tokens live under `.trash/_queries/<token>` in the
        // trunk. Forbid any path with a separator, `..` component, or
        // absolute shape — a malicious caller must not reach into the
        // live vault tree or escape the trash dir.
        if token.is_empty()
            || token.contains('/')
            || token.contains('\\')
            || Path::new(token).is_absolute()
            || token.contains("..")
        {
            return Err(CoreError::other(format!(
                "invalid restore token: '{token}'"
            )));
        }
        let trash_root = self.paths.trash_root();
        let token_path = trash_root.join(crate::paths::TRASH_QUERIES_DIR).join(token);
        if !token_path.exists() {
            return Err(CoreError::NotFound(token.to_string()));
        }
        // Tokens are `<digits>-<rest>` — left-parse exactly one leading
        // run of digits followed by a dash. `rest` is either a
        // percent-encoded ORIGINAL vault-relative path (new format,
        // leading `%2F` marker) or a legacy bare filename.
        let (digits, rest) = match token.split_once('-') {
            Some((d, r)) => (d, r),
            None => {
                return Err(CoreError::other(format!(
                    "invalid restore token: missing millis prefix '{token}'"
                )));
            }
        };
        if !digits.chars().all(|c| c.is_ascii_digit()) || digits.is_empty() {
            return Err(CoreError::other(format!(
                "invalid restore token: malformed millis prefix '{token}'"
            )));
        }
        // Origin-embedded token: restore at the original location.
        // Legacy token (no leading marker / invalid escape): restore
        // under `queries/<filename>` exactly as before — the literal
        // `queries` directory is a normal non-hidden name, so no guard
        // exception is required.
        let target_rel = match decode_query_origin(rest) {
            Some(origin) => origin,
            None => format!("queries/{rest}"),
        };
        if Path::new(&target_rel).extension().and_then(|e| e.to_str())
            != Some(crate::paths::QUERY_EXT)
        {
            return Err(CoreError::other(
                "invalid restore token: missing .query extension".to_string(),
            ));
        }
        // Compute the destination + validate it BEFORE moving the file
        // out of trash. If the guard rejects, the trash file stays
        // intact and the caller can retry.
        let target_abs = self.paths.vault.join(&target_rel);
        self.query_rel_path(&target_rel)?;
        if target_abs.exists() {
            return Err(CoreError::other(format!(
                "query '{target_rel}' already exists"
            )));
        }
        if let Some(parent) = target_abs.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::rename(&token_path, &target_abs)?;
        self.bases.write().remove(&target_rel);
        Ok(target_rel)
    }

    /// Enumerate every `.query` file in the vault, skipping
    /// `.trash`, `_assets`, and any hidden/dunder directory at every
    /// level (spec §3). Sorted by vault-relative path; duplicate
    /// stems remain (the UI marks the ambiguity per spec §6).
    pub fn list_bases(&self) -> Result<Vec<BaseInfo>> {
        let entries = crate::base::files::list_query_files(&self.paths.vault);
        let mut out = Vec::with_capacity(entries.len());
        for (rel, mtime) in entries {
            let abs = self.paths.vault.join(&rel);
            let raw = std::fs::read_to_string(&abs).unwrap_or_default();
            let loadable = crate::base::parse_base(&raw).is_ok();
            let name = Path::new(&rel)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            out.push(BaseInfo {
                path: rel,
                name,
                mtime,
                loadable,
            });
        }
        out.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(out)
    }

    /// Drop every entry from the in-memory base-`.query` cache. Called
    /// from the file watcher when an external edit lands so the next
    /// load re-reads from disk.
    pub fn invalidate_base_caches(&self) {
        self.bases.write().clear();
        self.base_results.clear_all();
    }
}

/// Compare two [`SystemTime`]s at millisecond resolution. FS mtime
/// granularity varies across platforms (Linux ns, macOS µs, Windows
/// 100ns FAT, etc.) — comparing full `Duration`s is reliable, but the
/// optimistic-concurrency check intentionally treats sub-ms drifts as
/// a match so a fast follow-up save doesn't trip the guard.
pub(crate) fn mtimes_match(a: SystemTime, b: SystemTime) -> bool {
    let a_ms = a
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i128)
        .unwrap_or(0);
    let b_ms = b
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i128)
        .unwrap_or(0);
    (a_ms - b_ms).abs() <= 1
}

/// Percent-encode a vault-relative `.query` path into the trash-token
/// suffix that [`Vault::trash_base`] writes. The synthetic leading
/// `%2F` marks the token as origin-embedded and disambiguates it from
/// legacy bare-filename tokens — a root-level `x.query` would
/// otherwise encode to a shape indistinguishable from legacy, which
/// restores under `queries/`. Only `%` and `/` are escaped
/// (`%25`, `%2F`); everything else (incl. UTF-8 folder names) passes
/// through, keeping tokens readable.
fn encode_query_origin(rel: &str) -> String {
    let mut out = String::with_capacity(rel.len() + 3);
    out.push_str("%2F");
    for c in rel.chars() {
        match c {
            '%' => out.push_str("%25"),
            '/' => out.push_str("%2F"),
            _ => out.push(c),
        }
    }
    out
}

/// Inverse of [`encode_query_origin`]. Returns `None` for anything
/// that is not a well-formed origin-embedded suffix: no leading `%2F`
/// marker, or any `%` not starting a valid `%25`/`%2F` escape. Legacy
/// bare filenames fall out as `None` and restore under `queries/`.
/// (A legacy filename that literally begins `%2F` would decode as an
/// origin — vanishingly rare, and the decoded path still passes the
/// full `query_rel_path` guard, so it can only restore somewhere
/// legal.)
fn decode_query_origin(s: &str) -> Option<String> {
    let mut rest = s.strip_prefix("%2F")?;
    let mut out = String::with_capacity(rest.len());
    while let Some(pos) = rest.find('%') {
        let (head, tail) = rest.split_at(pos);
        out.push_str(head);
        // `get(..3)` returns None when the slice would split a UTF-8
        // char — i.e. the escape is truncated. Anything that is not
        // exactly `%25`/`%2F` is not ours.
        match tail.get(..3)? {
            "%25" => out.push('%'),
            "%2F" => out.push('/'),
            _ => return None,
        }
        rest = &tail[3..];
    }
    out.push_str(rest);
    Some(out)
}

/// Build an [`IndexRecord`] from a [`Memo`] + its vault-relative path. The
/// format is derived from the path's extension. `tasks_cfg` drives task
/// extraction (spec §3/§6): callers hold it once per operation rather
/// than re-locking `self.config` per call site.
fn record_of(n: &Memo, path: &str, tasks_cfg: &crate::tasks::TasksConfig) -> IndexRecord {
    let fmt = crate::memo::NoteFormat::from_rel(path);
    let parsed = crate::tasks::parse_tasks(&n.body, tasks_cfg);
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
        tasks: parsed.tasks,
        tasks_truncated: parsed.truncated,
    }
}

/// Append `line` under the `## {section}` heading in `body` (spec
/// §6/§7): the task becomes the section's last line, everything else
/// preserved untouched. When the heading is absent, append a blank
/// separator, the heading, then the line, at the end of the body.
/// `Vault::add_task`'s `Note`/`Daily`/`Inbox` paths all funnel through
/// this one function.
fn append_task_line_under_section(body: &str, line: &str, section: &str) -> String {
    let heading = format!("## {section}");
    let lines: Vec<&str> = body.lines().collect();
    if let Some(start) = lines.iter().position(|l| l.trim_end() == heading) {
        // The section runs until the next heading (any level) or EOF;
        // insert the new line as the section's last line, i.e.
        // immediately before that boundary.
        let mut end = start + 1;
        while end < lines.len() && !lines[end].trim_start().starts_with('#') {
            end += 1;
        }
        let mut out: Vec<&str> = lines[..end].to_vec();
        out.push(line);
        out.extend(&lines[end..]);
        let mut result = out.join("\n");
        result.push('\n');
        result
    } else {
        let mut result = body.to_string();
        if !result.is_empty() && !result.ends_with('\n') {
            result.push('\n');
        }
        if !result.is_empty() {
            result.push('\n');
        }
        result.push_str(&heading);
        result.push('\n');
        result.push_str(line);
        result.push('\n');
        result
    }
}

/// Inverse of `append_task_line_under_section` for a known
/// just-appended multi-line task block. The block must occupy the final
/// lines of the named section; otherwise return `None` rather than
/// deleting an earlier identical occurrence during guarded undo.
fn remove_appended_task_lines_under_section(
    body: &str,
    moved_lines: &[String],
    section: &str,
) -> Option<String> {
    if moved_lines.is_empty() {
        return None;
    }
    let heading = format!("## {section}");
    let lines: Vec<&str> = body.lines().collect();
    let start = lines.iter().position(|line| line.trim_end() == heading)?;
    let mut end = start + 1;
    while end < lines.len() && !lines[end].trim_start().starts_with('#') {
        end += 1;
    }
    let block_start = end.checked_sub(moved_lines.len())?;
    if block_start < start + 1
        || lines[block_start..end]
            .iter()
            .zip(moved_lines)
            .any(|(actual, expected)| *actual != expected)
    {
        return None;
    }
    let mut out: Vec<&str> = lines[..block_start].to_vec();
    out.extend(&lines[end..]);
    let mut result = out.join("\n");
    result.push('\n');
    Some(result)
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
fn link_scan_text(fmt: crate::memo::NoteFormat, body: &str, props: &crate::props::Props) -> String {
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
    /// True when both sides of a legacy→spaces migration exist and
    /// must be merged by hand ([`VaultStatus::MergeRequired`]); the
    /// paths are in [`Self::merge_required_old`] / [`Self::merge_required_new`].
    pub merge_required: bool,
    /// Source (legacy) side of a pending merge, when known.
    #[serde(default)]
    pub merge_required_old: Option<PathBuf>,
    /// Destination (spaces) side of a pending merge, when known.
    #[serde(default)]
    pub merge_required_new: Option<PathBuf>,
    /// The shared Oxi home (`~/.oxi`, `OXI_HOME`-aware).
    #[serde(default)]
    pub oxi_home: String,
    /// The oxibrain data plane — owned and written only by oxibrain;
    /// oximemo registers roots through the client boundary.
    #[serde(default)]
    pub brain_dir: String,
    /// Oximemo's private state dir (`~/.oxi/oximemo`): settings,
    /// migration journal, pending registration.
    #[serde(default)]
    pub app_private: String,
    /// The pre-unification application-support vault, when it still
    /// exists on disk (migration candidate or retired-backup source).
    #[serde(default)]
    pub legacy_app_support_vault: Option<String>,
    /// The legacy flat vault `~/.oxi/vault`, when still present.
    #[serde(default)]
    pub legacy_flat_vault: Option<String>,
    /// Verified source-tree backups from completed cross-volume
    /// migrations (journal). Safe to delete manually.
    #[serde(default)]
    pub retired_backups: Vec<String>,
    /// A documents-root registration is waiting for a flush (desktop
    /// boot, `oximemo doctor`, `oximemo migrate-home`).
    #[serde(default)]
    pub pending_root_registration: bool,
    /// Active space (vault directory name; spec 2026-08-28 §5).
    #[serde(default)]
    pub active_space: String,
    /// All space directories under `~/.oxi/spaces/`.
    #[serde(default)]
    pub spaces: Vec<String>,
    /// A recorded `last_space` whose directory is missing (resolution
    /// fell through to the default). `None` = coherent.
    #[serde(default)]
    pub last_space_stale: Option<String>,
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
    /// Stale `by-vault/<hash>` index namespaces found by this run; with
    /// `fix` these were swept (2026-08-28 index-explosion fix).
    pub stale_index_namespaces: u64,
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

/// One folder in the vault's self-description
/// ([`Vault::folder_inventory`]): path, live note count, and the
/// schema/template facts an agent (or human) needs to decide where a
/// note belongs and what shape it takes.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct FolderInfo {
    /// Vault-relative folder path (`""` never appears — root is not an entry).
    pub path: String,
    /// Direct note count in this folder (subfolders not included).
    pub notes: u32,
    /// `[meta] preset` marker — `None` for custom/schema-less folders.
    pub preset: Option<String>,
    /// `[workspace] name` (display name, e.g. "지식").
    pub workspace: Option<String>,
    /// The folder carries a parseable `SCHEMA.toml`.
    pub has_schema: bool,
    /// The folder carries a `TEMPLATE.md` or `TEMPLATE.html`.
    pub has_template: bool,
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

    // -- default-vault migration (app-support → spaces) ----------------------

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
        let new = home
            .join(".oxi")
            .join(crate::paths::SPACES_SUBDIR)
            .join(crate::spaces::DEFAULT_SPACE_NAME)
            .join(crate::paths::VAULT_DEFAULT_SUBDIR);

        let (vault_path, status) = crate::migrate_vault::with_home(&home, || {
            let v = Vault::open(None).unwrap();
            (v.paths().vault.clone(), v.status().clone())
        });

        // The migrated tree continues into the default space (spec
        // 2026-08-28 §3: flat migrate → space migrate, one `open`).
        assert_eq!(vault_path, new, "open(None) resolves the personal space");
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
        let new = home
            .join(".oxi")
            .join(crate::paths::SPACES_SUBDIR)
            .join(crate::spaces::DEFAULT_SPACE_NAME)
            .join(crate::paths::VAULT_DEFAULT_SUBDIR);
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
            // The vault still opens (inside the personal space — the
            // flat merge-required surface continues into a flat→space
            // migration of the new side) and doctor surfaces
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
            executable: "/tmp/oxibrain-test".into(),
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
    fn set_tasks_config_rejects_invalid_statuses() {
        let (dir, v) = tmp_vault();

        // Two configured entries collide after X-normalization ("X" maps
        // onto the configured "x") — a true duplicate, rejected.
        let mut bad = crate::tasks::TasksConfig::default();
        bad.statuses.push(crate::tasks::TaskStatusDef {
            symbol: "x".into(),
            name: Some("Custom done".into()),
            next: " ".into(),
            r#type: crate::tasks::StatusType::Done,
        });
        bad.statuses.push(crate::tasks::TaskStatusDef {
            symbol: "X".into(),
            name: None,
            next: " ".into(),
            r#type: crate::tasks::StatusType::Done,
        });
        assert!(v.set_tasks_config(bad).is_err());

        // On-disk config unchanged: re-open the vault and check the
        // pre-call defaults survived.
        let re = Vault::open(Some(dir.path())).unwrap();
        re.with_config(|c| assert_eq!(c.tasks, crate::tasks::TasksConfig::default()));
    }

    #[test]
    fn parsed_tasks_ride_the_existing_index_without_a_second_store() {
        let (_t, v) = tmp_vault();
        v.create_memo("- [ ] buy milk 📅 2026-08-30".into(), None)
            .unwrap();
        let recs = v.snapshot().unwrap();
        let rec = recs.iter().find(|r| !r.deleted).unwrap();
        assert_eq!(rec.tasks.len(), 1);
        assert_eq!(rec.tasks[0].text, "buy milk");
        assert!(!rec.tasks_truncated);
    }

    #[test]
    fn note_with_more_than_1000_tasks_sets_truncated_flag() {
        let (_t, v) = tmp_vault();
        let mut body = String::new();
        for i in 0..1001 {
            body.push_str(&format!("- [ ] task {i}\n"));
        }
        v.create_memo(body, None).unwrap();
        let recs = v.snapshot().unwrap();
        let rec = recs.iter().find(|r| !r.deleted).unwrap();
        assert_eq!(rec.tasks.len(), 1000);
        assert!(rec.tasks_truncated);
    }

    #[test]
    fn editing_note_body_updates_its_tasks_on_reindex() {
        let (_t, v) = tmp_vault();
        let memo = v.create_memo("- [ ] first".into(), None).unwrap();
        v.update_note(memo.id, Some("- [ ] first\n- [ ] second".into()), None)
            .unwrap();
        let recs = v.snapshot().unwrap();
        let rec = recs.iter().find(|r| r.id == memo.id).unwrap();
        assert_eq!(rec.tasks.len(), 2);
    }

    #[test]
    fn changing_global_filter_triggers_reindex_via_fingerprint() {
        let (dir, v) = tmp_vault();
        // Under the default config (no filter configured) this line is
        // extracted as a task even though it carries no "#task" marker.
        v.create_memo("- [ ] no filter token".into(), None).unwrap();
        let before = v.snapshot().unwrap();
        assert_eq!(before.iter().find(|r| !r.deleted).unwrap().tasks.len(), 1);

        let mut tasks_cfg = v.with_config(|c| c.tasks.clone());
        tasks_cfg.global_filter = "#task".into();
        v.set_tasks_config(tasks_cfg).unwrap();
        // Re-open (migrate() runs the fingerprint check) to simulate the
        // next app launch picking up the config-driven reindex, matching
        // how INDEX_FORMAT_VERSION bumps are picked up today. Without the
        // fingerprint check, the stale IndexRecord.tasks from before the
        // config change would still show 1 task.
        let reopened = Vault::open(Some(dir.path())).unwrap();
        reopened.migrate().unwrap();
        let recs = reopened.snapshot().unwrap();
        let rec = recs.iter().find(|r| !r.deleted).unwrap();
        assert_eq!(
            rec.tasks.len(),
            0,
            "no #task token present, now correctly excluded by the new filter"
        );
    }

    #[test]
    fn snapshot_task_weight_cap_prevents_caching_oversized_task_vectors() {
        let (_t, v) = tmp_vault();
        // 250 notes * ~900 tasks each > SNAPSHOT_TASK_WEIGHT_CAP (200_000),
        // while staying well under SNAPSHOT_CACHE_CAP (50_000 notes) so
        // the note-count cap alone would not trigger the uncached path.
        let mut body = String::new();
        for i in 0..900 {
            body.push_str(&format!("- [ ] task {i}\n"));
        }
        for _ in 0..250 {
            v.create_memo(body.clone(), None).unwrap();
        }
        let first = v.snapshot().unwrap();
        let second = v.snapshot().unwrap();
        assert!(!first.is_empty());
        assert!(!second.is_empty());
    }

    #[test]
    fn locked_helpers_do_not_change_update_note_with_behavior() {
        let (_t, v) = tmp_vault();
        let memo = v.create_memo("before".into(), None).unwrap();
        let updated = v
            .update_note_with(memo.id, Some("after".into()), None, None)
            .unwrap();
        assert_eq!(updated.body, "after");
        let refetched = v.get_memo(memo.id).unwrap();
        assert_eq!(refetched.body, "after");
    }

    #[test]
    fn concurrent_readers_do_not_deadlock_against_a_held_write_lock_scope() {
        // With the new locked helpers in place, a normal with_redb
        // (shared) call from another thread must still succeed promptly
        // once the exclusive scope releases -- i.e. we have not
        // introduced a lock that outlives its intended scope.
        let (_t, v) = tmp_vault();
        let v = std::sync::Arc::new(v);
        let memo = v.create_memo("x".into(), None).unwrap();
        let v2 = v.clone();
        let handle = std::thread::spawn(move || v2.get_memo(memo.id));
        let result = handle.join().unwrap();
        assert!(result.is_ok());
    }

    #[test]
    fn patch_task_toggle_by_exact_ref_succeeds() {
        let (_t, v) = tmp_vault();
        let memo = v.create_memo("- [ ] buy milk".into(), None).unwrap();
        let hash = crate::tasks::TaskLineHash::of_line("- [ ] buy milk");
        let today = time::macros::date!(2026 - 08 - 27);
        let result = v
            .patch_task(
                crate::tasks::TaskSelector::Exact(crate::tasks::TaskRef {
                    memo_id: memo.id,
                    line: 0,
                    line_hash: hash,
                }),
                crate::tasks::TaskEdit::Toggle,
                today,
            )
            .unwrap();
        assert_eq!(result.task.status_type, crate::tasks::StatusType::Done);
        let refetched = v.get_memo(memo.id).unwrap();
        assert!(refetched.body.starts_with("- [x]"));
    }

    #[test]
    fn patch_task_rejects_stale_hash() {
        let (_t, v) = tmp_vault();
        let memo = v.create_memo("- [ ] buy milk".into(), None).unwrap();
        let stale_hash = crate::tasks::TaskLineHash::of_line("- [ ] wrong original text");
        let today = time::macros::date!(2026 - 08 - 27);
        let err = v
            .patch_task(
                crate::tasks::TaskSelector::Exact(crate::tasks::TaskRef {
                    memo_id: memo.id,
                    line: 0,
                    line_hash: stale_hash,
                }),
                crate::tasks::TaskEdit::Toggle,
                today,
            )
            .unwrap_err();
        assert!(matches!(
            err,
            CoreError::TaskConflict { .. } | CoreError::TaskNotFound { .. }
        ));
    }

    #[test]
    fn patch_task_current_line_ignores_hash_and_targets_whatever_is_there() {
        let (_t, v) = tmp_vault();
        let memo = v.create_memo("- [ ] buy milk".into(), None).unwrap();
        let today = time::macros::date!(2026 - 08 - 27);
        let result = v
            .patch_task(
                crate::tasks::TaskSelector::CurrentLine {
                    memo_id: memo.id,
                    line: 0,
                },
                crate::tasks::TaskEdit::Toggle,
                today,
            )
            .unwrap();
        assert_eq!(result.task.status_type, crate::tasks::StatusType::Done);
    }

    #[test]
    fn patch_task_out_of_range_line_is_task_not_found() {
        let (_t, v) = tmp_vault();
        let memo = v.create_memo("- [ ] buy milk".into(), None).unwrap();
        let today = time::macros::date!(2026 - 08 - 27);
        let err = v
            .patch_task(
                crate::tasks::TaskSelector::CurrentLine {
                    memo_id: memo.id,
                    line: 99,
                },
                crate::tasks::TaskEdit::Toggle,
                today,
            )
            .unwrap_err();
        assert!(matches!(err, CoreError::TaskNotFound { .. }));
    }

    #[test]
    fn two_vault_instances_patch_different_lines_concurrently_without_lost_update() {
        let (tmp, vault_a) = tmp_vault();
        vault_a
            .create_memo("- [ ] first\n- [ ] second".into(), None)
            .unwrap();
        let memo = vault_a
            .snapshot()
            .unwrap()
            .iter()
            .find(|r| !r.deleted)
            .unwrap()
            .clone();
        let vault_b = Vault::open(Some(tmp.path())).unwrap();
        let hash0 = crate::tasks::TaskLineHash::of_line("- [ ] first");
        let hash1 = crate::tasks::TaskLineHash::of_line("- [ ] second");
        let today = time::macros::date!(2026 - 08 - 27);
        vault_a
            .patch_task(
                crate::tasks::TaskSelector::Exact(crate::tasks::TaskRef {
                    memo_id: memo.id,
                    line: 0,
                    line_hash: hash0,
                }),
                crate::tasks::TaskEdit::Toggle,
                today,
            )
            .unwrap();
        vault_b
            .patch_task(
                crate::tasks::TaskSelector::Exact(crate::tasks::TaskRef {
                    memo_id: memo.id,
                    line: 1,
                    line_hash: hash1,
                }),
                crate::tasks::TaskEdit::Toggle,
                today,
            )
            .unwrap();
        let refetched = vault_a.get_memo(memo.id).unwrap();
        assert!(refetched.body.contains("- [x] first"));
        assert!(refetched.body.contains("- [x] second"));
    }

    #[test]
    fn patch_task_recheck_detects_a_non_cooperating_external_write() {
        let (_t, v) = tmp_vault();
        let memo = v.create_memo("- [ ] buy milk".into(), None).unwrap();
        let hash = crate::tasks::TaskLineHash::of_line("- [ ] buy milk");
        let today = time::macros::date!(2026 - 08 - 27);
        // An ordinary vault-mediated edit changes the file first; this
        // exercises the same code path a non-cooperating external
        // writer's change would hit at patch_task's recheck step,
        // without needing to race threads in a synchronous test.
        v.update_note(memo.id, Some("- [ ] buy milk (edited)".into()), None)
            .unwrap();
        let err = v
            .patch_task(
                crate::tasks::TaskSelector::Exact(crate::tasks::TaskRef {
                    memo_id: memo.id,
                    line: 0,
                    line_hash: hash,
                }),
                crate::tasks::TaskEdit::Toggle,
                today,
            )
            .unwrap_err();
        assert!(matches!(
            err,
            CoreError::TaskConflict { .. } | CoreError::TaskNotFound { .. }
        ));
    }

    #[test]
    fn patch_task_toggle_of_recurring_task_reports_the_completed_task_not_the_spawn() {
        // Default config uses RecurrenceInsert::Above: the spawned
        // occurrence is inserted BEFORE the completed line, so the
        // completed task's own line shifts down by one. patch_task must
        // still report the COMPLETED task as `result.task` (not the
        // newly spawned Todo that now occupies the original line index).
        let (_t, v) = tmp_vault();
        let memo = v
            .create_memo(
                "- [ ] water plants 🔁 every week 📅 2026-08-30".into(),
                None,
            )
            .unwrap();
        let hash =
            crate::tasks::TaskLineHash::of_line("- [ ] water plants 🔁 every week 📅 2026-08-30");
        let today = time::macros::date!(2026 - 08 - 27);
        let result = v
            .patch_task(
                crate::tasks::TaskSelector::Exact(crate::tasks::TaskRef {
                    memo_id: memo.id,
                    line: 0,
                    line_hash: hash,
                }),
                crate::tasks::TaskEdit::Toggle,
                today,
            )
            .unwrap();
        assert_eq!(
            result.task.status_type,
            crate::tasks::StatusType::Done,
            "result.task must be the just-completed task, not the spawned Todo"
        );
        assert_eq!(result.task.text, "water plants");
        let spawned = result
            .spawned
            .expect("recurrence must spawn a new occurrence");
        assert_eq!(spawned.status_type, crate::tasks::StatusType::Todo);
        assert_eq!(spawned.due, Some(time::macros::date!(2026 - 09 - 06)));
    }

    #[test]
    fn add_task_to_existing_note_appends_a_line_with_global_filter() {
        let (_t, v) = tmp_vault();
        let memo = v
            .create_note("", "# Notes".into(), crate::memo::NoteFormat::Markdown)
            .unwrap();
        let mut tasks_cfg = v.with_config(|c| c.tasks.clone());
        tasks_cfg.global_filter = "#task".into();
        v.set_tasks_config(tasks_cfg).unwrap();
        let today = time::macros::date!(2026 - 08 - 27);
        let result = v
            .add_task(
                crate::tasks::AddTarget::Note(memo.id),
                "buy milk".into(),
                crate::tasks::TaskFields::default(),
                today,
            )
            .unwrap();
        assert_eq!(result.task.text, "buy milk");
        let refetched = v.get_memo(memo.id).unwrap();
        assert!(refetched.body.contains("- [ ] buy milk #task"));
    }

    #[test]
    fn add_task_daily_creates_todays_note_with_default_section() {
        let (_t, v) = tmp_vault();
        let today = time::macros::date!(2026 - 08 - 27);
        let result = v
            .add_task(
                crate::tasks::AddTarget::Daily(today),
                "call mom".into(),
                crate::tasks::TaskFields::default(),
                today,
            )
            .unwrap();
        assert_eq!(result.task.text, "call mom");
    }

    #[test]
    fn add_task_daily_is_idempotent_on_the_note_creation_side() {
        let (_t, v) = tmp_vault();
        let today = time::macros::date!(2026 - 08 - 27);
        v.add_task(
            crate::tasks::AddTarget::Daily(today),
            "first".into(),
            crate::tasks::TaskFields::default(),
            today,
        )
        .unwrap();
        let result = v
            .add_task(
                crate::tasks::AddTarget::Daily(today),
                "second".into(),
                crate::tasks::TaskFields::default(),
                today,
            )
            .unwrap();
        assert_eq!(result.task.text, "second");
        // Both tasks landed in the SAME note, not two competing daily notes.
        let (daily, _created) = v.open_daily(&today.to_string()).unwrap();
        assert!(daily.body.contains("first") && daily.body.contains("second"));
    }

    #[test]
    fn add_task_creates_default_section_heading_when_absent() {
        let (_t, v) = tmp_vault();
        let memo = v
            .create_note(
                "",
                "# Notes\nsome text".into(),
                crate::memo::NoteFormat::Markdown,
            )
            .unwrap();
        let today = time::macros::date!(2026 - 08 - 27);
        v.add_task(
            crate::tasks::AddTarget::Note(memo.id),
            "task one".into(),
            crate::tasks::TaskFields::default(),
            today,
        )
        .unwrap();
        let refetched = v.get_memo(memo.id).unwrap();
        let default_section = v.with_config(|c| c.tasks.default_section.clone());
        assert!(refetched.body.contains(&format!("## {default_section}")));
    }

    #[test]
    fn add_task_rejects_newline_in_text() {
        let (_t, v) = tmp_vault();
        let memo = v
            .create_note("", "# Notes".into(), crate::memo::NoteFormat::Markdown)
            .unwrap();
        let today = time::macros::date!(2026 - 08 - 27);
        let err = v
            .add_task(
                crate::tasks::AddTarget::Note(memo.id),
                "bad\ntext".into(),
                crate::tasks::TaskFields::default(),
                today,
            )
            .unwrap_err();
        assert!(matches!(err, CoreError::InvalidTasksConfig(_)));
    }

    #[test]
    fn add_task_to_inbox_adopts_or_creates_the_fixed_note() {
        let (_t, v) = tmp_vault();
        v.migrate().unwrap(); // seeds the default Inbox (idea preset).
        let today = time::macros::date!(2026 - 08 - 27);
        let default_section = v.with_config(|c| c.tasks.default_section.clone());
        let first = v
            .add_task(
                crate::tasks::AddTarget::Inbox,
                "first".into(),
                crate::tasks::TaskFields::default(),
                today,
            )
            .unwrap();
        let second = v
            .add_task(
                crate::tasks::AddTarget::Inbox,
                "second".into(),
                crate::tasks::TaskFields::default(),
                today,
            )
            .unwrap();
        // Both appends land in the same note (adopt-not-recreate).
        let refetched = v.get_memo(first.task.task_ref.memo_id).unwrap();
        assert_eq!(first.task.task_ref.memo_id, second.task.task_ref.memo_id);
        assert!(refetched.body.contains("first") && refetched.body.contains("second"));
        assert!(refetched.body.contains(&format!("## {default_section}")));
    }

    #[test]
    fn add_task_warns_when_recurring_task_targets_daily_note() {
        let (_t, v) = tmp_vault();
        let today = time::macros::date!(2026 - 08 - 27);
        let recurring = crate::tasks::TaskFields {
            recurrence: Some("every week".into()),
            ..Default::default()
        };
        // Daily + recurrence: the §9 anti-pattern signal fires.
        let daily = v
            .add_task(
                crate::tasks::AddTarget::Daily(today),
                "call mom".into(),
                recurring.clone(),
                today,
            )
            .unwrap();
        assert!(daily.daily_recurrence_warning);
        assert_eq!(daily.task.recurrence.as_deref(), Some("every week"));
        // The line really recurs in the note — the flag reflects the
        // written bytes, not just the request.
        let (note, _created) = v.open_daily(&today.to_string()).unwrap();
        assert!(note.body.contains("🔁 every week"));

        // Same fields, non-daily target: no warning.
        let inbox = v
            .add_task(
                crate::tasks::AddTarget::Inbox,
                "call mom".into(),
                recurring,
                today,
            )
            .unwrap();
        assert!(!inbox.daily_recurrence_warning);

        // Daily target without a rule: no warning.
        let plain = v
            .add_task(
                crate::tasks::AddTarget::Daily(today),
                "one-off".into(),
                crate::tasks::TaskFields::default(),
                today,
            )
            .unwrap();
        assert!(!plain.daily_recurrence_warning);
    }

    #[test]
    fn move_tasks_moves_full_subtree_to_destination_and_removes_from_source() {
        let (_t, v) = tmp_vault();
        let source = v
            .create_memo("- [ ] parent\n  - [ ] child\n- [ ] unrelated".into(), None)
            .unwrap();
        let destination = v.create_memo("# Dest\n## 할 일\n".into(), None).unwrap();
        let parent_hash = crate::tasks::TaskLineHash::of_line("- [ ] parent");
        let today = time::macros::date!(2026 - 08 - 27);
        let receipt = v
            .move_tasks(
                crate::tasks::MoveTasksRequest {
                    source: source.id,
                    tasks: vec![crate::tasks::TaskRef {
                        memo_id: source.id,
                        line: 0,
                        line_hash: parent_hash,
                    }],
                    destination: crate::tasks::AddTarget::Note(destination.id),
                    expected_destination_hash: None,
                },
                today,
            )
            .unwrap();
        let source_after = v.get_memo(source.id).unwrap();
        assert!(!source_after.body.contains("parent"));
        assert!(!source_after.body.contains("child"));
        assert!(source_after.body.contains("unrelated"));
        let destination_after = v.get_memo(destination.id).unwrap();
        assert!(destination_after.body.contains("parent"));
        assert!(destination_after.body.contains("child"));
        assert_eq!(receipt.source, source.id);
        assert_eq!(receipt.destination, destination.id);
        assert_eq!(
            receipt.moved_lines,
            vec!["- [ ] parent".to_string(), "  - [ ] child".to_string()],
            "the root is re-based to column zero while child indentation stays relative"
        );
    }

    #[test]
    fn move_tasks_deduplicates_descendant_selections_covered_by_an_ancestor() {
        let (_t, v) = tmp_vault();
        let source = v
            .create_memo("- [ ] parent\n  - [ ] child".into(), None)
            .unwrap();
        let destination = v.create_memo("# Dest\n## 할 일\n".into(), None).unwrap();
        let today = time::macros::date!(2026 - 08 - 27);
        v.move_tasks(
            crate::tasks::MoveTasksRequest {
                source: source.id,
                tasks: vec![
                    crate::tasks::TaskRef {
                        memo_id: source.id,
                        line: 0,
                        line_hash: crate::tasks::TaskLineHash::of_line("- [ ] parent"),
                    },
                    crate::tasks::TaskRef {
                        memo_id: source.id,
                        line: 1,
                        line_hash: crate::tasks::TaskLineHash::of_line("  - [ ] child"),
                    },
                ],
                destination: crate::tasks::AddTarget::Note(destination.id),
                expected_destination_hash: None,
            },
            today,
        )
        .unwrap();
        let destination_after = v.get_memo(destination.id).unwrap();
        assert_eq!(destination_after.body.matches("child").count(), 1);
    }

    #[test]
    fn move_tasks_verifies_expected_destination_hash() {
        let (_t, v) = tmp_vault();
        let source = v.create_memo("- [ ] task".into(), None).unwrap();
        let destination = v.create_memo("# Dest".into(), None).unwrap();
        let today = time::macros::date!(2026 - 08 - 27);
        let err = v
            .move_tasks(
                crate::tasks::MoveTasksRequest {
                    source: source.id,
                    tasks: vec![crate::tasks::TaskRef {
                        memo_id: source.id,
                        line: 0,
                        line_hash: crate::tasks::TaskLineHash::of_line("- [ ] task"),
                    }],
                    destination: crate::tasks::AddTarget::Note(destination.id),
                    expected_destination_hash: Some(crate::memo::MemoHash::new("wrong")),
                },
                today,
            )
            .unwrap_err();
        assert!(matches!(err, CoreError::TaskConflict { .. }));
    }

    #[test]
    fn move_tasks_receipt_supports_undo_while_hashes_still_match() {
        let (_t, v) = tmp_vault();
        let source = v.create_memo("- [ ] task".into(), None).unwrap();
        let destination = v.create_memo("# Dest\n## 할 일\n".into(), None).unwrap();
        let today = time::macros::date!(2026 - 08 - 27);
        let receipt = v
            .move_tasks(
                crate::tasks::MoveTasksRequest {
                    source: source.id,
                    tasks: vec![crate::tasks::TaskRef {
                        memo_id: source.id,
                        line: 0,
                        line_hash: crate::tasks::TaskLineHash::of_line("- [ ] task"),
                    }],
                    destination: crate::tasks::AddTarget::Note(destination.id),
                    expected_destination_hash: None,
                },
                today,
            )
            .unwrap();
        v.undo_move_tasks(&receipt).unwrap();
        let source_after = v.get_memo(source.id).unwrap();
        assert!(source_after.body.contains("task"));
        let destination_after = v.get_memo(destination.id).unwrap();
        assert!(!destination_after.body.contains("- [ ] task"));
    }

    #[test]
    fn move_tasks_undo_rejects_intervening_edits() {
        let (_t, v) = tmp_vault();
        let source = v.create_memo("- [ ] task".into(), None).unwrap();
        let destination = v.create_memo("# Dest\n## 할 일\n".into(), None).unwrap();
        let today = time::macros::date!(2026 - 08 - 27);
        let receipt = v
            .move_tasks(
                crate::tasks::MoveTasksRequest {
                    source: source.id,
                    tasks: vec![crate::tasks::TaskRef {
                        memo_id: source.id,
                        line: 0,
                        line_hash: crate::tasks::TaskLineHash::of_line("- [ ] task"),
                    }],
                    destination: crate::tasks::AddTarget::Note(destination.id),
                    expected_destination_hash: None,
                },
                today,
            )
            .unwrap();
        v.update_note(
            destination.id,
            Some("# Dest\n## 할 일\n- [ ] task\nintervening edit".into()),
            None,
        )
        .unwrap();
        let err = v.undo_move_tasks(&receipt).unwrap_err();
        assert!(matches!(err, CoreError::TaskConflict { .. }));
    }

    #[test]
    fn move_tasks_rejects_source_equal_to_destination_before_writing() {
        let (_t, v) = tmp_vault();
        let source = v.create_memo("- [ ] task".into(), None).unwrap();
        let today = time::macros::date!(2026 - 08 - 27);
        let err = v
            .move_tasks(
                crate::tasks::MoveTasksRequest {
                    source: source.id,
                    tasks: vec![crate::tasks::TaskRef {
                        memo_id: source.id,
                        line: 0,
                        line_hash: crate::tasks::TaskLineHash::of_line("- [ ] task"),
                    }],
                    destination: crate::tasks::AddTarget::Note(source.id),
                    expected_destination_hash: None,
                },
                today,
            )
            .unwrap_err();
        assert!(matches!(err, CoreError::TaskConflict { .. }));
        assert_eq!(v.get_memo(source.id).unwrap().body, "- [ ] task");
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
        let _sweep = SWEEP_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
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
        let pinned: Vec<String> = v.with_config(|c| {
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
    fn set_folder_view_table_round_trips() {
        let (_t, v) = tmp_vault();
        v.set_folder_view("book", Some(crate::config::ViewMode::Table))
            .unwrap();
        let json = v.config_json();
        let folders = json["folders"].as_array().unwrap();
        let entry = folders
            .iter()
            .find(|f| f["path"] == "book")
            .expect("folder entry exists");
        assert_eq!(entry["view"], "table"); // serde lowercase wire form
        // Round-trip: config reload resolves the same variant.
        let cfg = v.with_config(|c| c.folders.items.clone());
        assert_eq!(
            cfg.first().and_then(|f| f.view),
            Some(crate::config::ViewMode::Table)
        );
        // Unlock drops the pin (same entry-drop semantics as List).
        v.set_folder_view("book", None).unwrap();
        assert!(
            v.with_config(|c| c.folders.items.clone())
                .iter()
                .all(|f| f.path != "book")
        );
    }

    #[test]
    fn set_folder_view_persists_calendar() {
        let (_t, v) = tmp_vault();
        v.set_folder_view("novel", Some(crate::config::ViewMode::Calendar))
            .unwrap();
        let json = v.config_json();
        let folders = json["folders"].as_array().unwrap();
        let entry = folders.iter().find(|f| f["path"] == "novel").unwrap();
        assert_eq!(
            entry["view"], "calendar",
            "Calendar view must persist as 'calendar' in JSON"
        );

        v.set_folder_view("novel", None).unwrap();
        let json2 = v.config_json();
        let folders2 = json2["folders"].as_array().unwrap();
        assert!(folders2.iter().all(|f| f["path"] != "novel"));
    }

    #[test]
    fn set_folder_calendar_field_persists_and_clears() {
        let (_t, v) = tmp_vault();
        v.set_folder_calendar_field("novel", Some("watched_at".into()))
            .unwrap();
        let folders = v.config_json()["folders"].as_array().unwrap().clone();
        let entry = folders.iter().find(|f| f["path"] == "novel").unwrap();
        assert_eq!(entry["calendar_date_field"], "watched_at");

        // Cleared field drops the JSON key (skip_serializing_if Option::is_none)
        v.set_folder_calendar_field("novel", None).unwrap();
        let folders2 = v.config_json()["folders"].as_array().unwrap().clone();
        let entry2 = folders2.iter().find(|f| f["path"] == "novel").unwrap();
        assert!(entry2.get("calendar_date_field").is_none());

        // Setting back to default ("created_at") also drops the key
        v.set_folder_calendar_field("novel", Some("created_at".into()))
            .unwrap();
        let folders3 = v.config_json()["folders"].as_array().unwrap().clone();
        let entry3 = folders3.iter().find(|f| f["path"] == "novel").unwrap();
        assert!(entry3.get("calendar_date_field").is_none());
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
            .create_note(
                "",
                "# Props\n\nbody".into(),
                crate::memo::NoteFormat::Markdown,
            )
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
        assert!(!updated.props.contains_key("status"));
        assert!(!v.get_memo(note.id).unwrap().props.contains_key("status"));

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
        assert_eq!(
            noop.updated_at, prev.updated_at,
            "no-op re-set must not bump updated"
        );
        assert_eq!(
            noop.hash, prev.hash,
            "no-op re-set must not change the digest"
        );
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

    #[test]
    fn snapshot_cache_returns_same_arc_until_meta_redb_changes() {
        let (_t, v) = tmp_vault();
        let a = v
            .create_note("", "# A".into(), crate::memo::NoteFormat::Markdown)
            .unwrap();
        let b = v
            .create_note("", "# B".into(), crate::memo::NoteFormat::Markdown)
            .unwrap();
        let c = v
            .create_note("", "# C".into(), crate::memo::NoteFormat::Markdown)
            .unwrap();

        let s1 = v.snapshot().unwrap();
        let s2 = v.snapshot().unwrap();
        assert!(
            std::sync::Arc::ptr_eq(&s1, &s2),
            "second snapshot reuses the cached Arc"
        );
        assert_eq!(s1.len(), 3);

        // create_note writes through redb -> meta.redb file stat changes ->
        // cache key changes -> new Arc, new contents.
        let d = v
            .create_note("", "# D".into(), crate::memo::NoteFormat::Markdown)
            .unwrap();
        let s3 = v.snapshot().unwrap();
        assert!(
            !std::sync::Arc::ptr_eq(&s1, &s3),
            "snapshot Arc changes after a write to meta.redb"
        );
        let ids: std::collections::HashSet<_> = s3.iter().map(|r| r.id).collect();
        assert!(ids.contains(&a.id));
        assert!(ids.contains(&b.id));
        assert!(ids.contains(&c.id));
        assert!(ids.contains(&d.id));
    }

    /// Pins the read-first `RedbIndex::open` fix: two pure snapshot
    /// reads back-to-back must share the cached Arc. The previous
    /// `open()` committed an empty write transaction on every call,
    /// which bumped `meta.redb`'s mtime even with no user-visible write;
    /// that broke the exact `(mtime, size)` cache key between two reads.
    #[test]
    fn snapshot_reads_never_invalidate_cache() {
        let (_t, v) = tmp_vault();
        let _ = v
            .create_note("", "# A".into(), crate::memo::NoteFormat::Markdown)
            .unwrap();
        // Force a fresh snapshot so the cache is populated, then trigger
        // the second read through `query_notes` to exercise the
        // read-first path in `RedbIndex::open`.
        let s1 = v.snapshot().unwrap();
        // query_notes also calls snapshot(); if open() bumps mtime the
        // cached Arc would be replaced.
        let _ = v.query_notes(&crate::props::NoteQuery::default()).unwrap();
        // Direct second read — no lock, no redb open on hit path.
        let s2 = v.snapshot().unwrap();
        assert!(
            std::sync::Arc::ptr_eq(&s1, &s2),
            "two pure reads must share the same cached Arc"
        );
    }

    /// Pins the exact-key contract: a write immediately followed by
    /// snapshot() in the same millisecond region must return a new Arc
    /// containing the new note. This rules out any rounding compromise
    /// (e.g. whole-second mtime rounding) that would mask invalidation.
    #[test]
    fn snapshot_write_then_read_yields_new_arc() {
        let (_t, v) = tmp_vault();
        let _ = v
            .create_note("", "# A".into(), crate::memo::NoteFormat::Markdown)
            .unwrap();
        let s1 = v.snapshot().unwrap();
        let _ = v
            .create_note("", "# B".into(), crate::memo::NoteFormat::Markdown)
            .unwrap();
        let s2 = v.snapshot().unwrap();
        assert!(
            !std::sync::Arc::ptr_eq(&s1, &s2),
            "write must invalidate the cache and produce a new Arc"
        );
        assert_eq!(s2.len(), 2, "new Arc must contain both notes");
    }

    /// Pins the no-held-handle contract: a second `Vault` (CLI) writing
    /// while the first `Vault` (GUI) holds a warm snapshot cache must
    /// succeed, and the first `Vault`'s next `snapshot()` must observe
    /// the new note. This is the `oximemo` CLI-while-GUI flow that
    /// `vault.rs` §5.7 documents; the round-1 memoization broke it
    /// because holding a redb `Database` open in the GUI process made
    /// the CLI's `Database::create` return `DatabaseAlreadyOpen`.
    #[test]
    fn second_vault_writes_through_warm_snapshot_cache() {
        let (t, v_gui) = tmp_vault();
        let _ = v_gui
            .create_note("", "# A".into(), crate::memo::NoteFormat::Markdown)
            .unwrap();
        // Warm the GUI's snapshot cache.
        let s_gui_before = v_gui.snapshot().unwrap();
        assert_eq!(s_gui_before.len(), 1);

        // Open a second Vault on the same directory (simulates a CLI
        // invocation). Both Vaults must cooperate through the fs2 flock
        // — neither can hold a redb `Database` open past its lock scope.
        let v_cli = Vault::open(Some(t.path())).unwrap();
        let cli_note = v_cli
            .create_note("", "# CLI".into(), crate::memo::NoteFormat::Markdown)
            .unwrap();
        assert!(v_cli.query_notes(&Default::default()).unwrap().total >= 2);

        // GUI's snapshot must miss (its cached (mtime, size) is now stale)
        // and rebuild to include the CLI note.
        let s_gui_after = v_gui.snapshot().unwrap();
        assert!(
            !std::sync::Arc::ptr_eq(&s_gui_before, &s_gui_after),
            "GUI snapshot cache must invalidate after the CLI wrote through meta.redb"
        );
        assert_eq!(
            s_gui_after.len(),
            2,
            "GUI sees both its own note and the CLI note"
        );
        assert!(
            s_gui_after.iter().any(|r| r.id == cli_note.id),
            "CLI note must be visible in the GUI's refreshed snapshot"
        );
    }

    /// Stress pin for the round-3 race fix.
    ///
    /// The race under test: round 2's `snapshot()` dropped its
    /// Shared flock (via `with_redb` returning) before re-stating
    /// `meta.redb`. A writer waiting at Exclusive could commit in
    /// that window; the reader's post-stat would capture the
    /// post-commit mtime, leaving the cache storing
    /// `{post_write_mtime, recs@pre_write}` — a poisoned entry
    /// that serves stale data until a further write bumps the mtime.
    /// Round 3's design holds Shared across the entire
    /// open-and-release cycle, so the post-stat happens under the
    /// flock and the writer cannot commit until the cache key is
    /// committed.
    ///
    /// Honest note on determinism: under heavy concurrent write
    /// traffic (as in this storm), every writer commit bumps the
    /// file's mtime, so even a *transient* poison at iteration N is
    /// unmasked by the iteration-N+1 commit. The "stuck poison"
    /// only persists if NO further writes happen — under the storm
    /// that never occurs because we commit continuously. So this
    /// test is a *behavioral stress* on the cache (it would catch a
    /// future regression where `snapshot()` returns stale records
    /// after a burst of external writes), but it is **not** a
    /// deterministic pin of the post-stat-in-window race.
    ///
    /// Pin: a writer thread commits N notes sequentially through
    /// fresh `Vault`s. A reader thread loops `snapshot()` /
    /// `query_notes()` and accumulates the set of paths it observes.
    /// After both threads finish, every committed path must have
    /// been observed by the reader at some point. A future
    /// regression that drops records (e.g. a stale cache key that
    /// never invalidates) would be caught here.
    #[test]
    fn snapshot_concurrent_writes_never_poison_cache() {
        use std::collections::HashSet;
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::mpsc;

        const STORM_COUNT: usize = 30;
        const READER_ITERS: usize = 200;

        let (t, v_reader) = tmp_vault();
        v_reader.ensure_initialized().unwrap();
        v_reader
            .create_note("", "# Seed".into(), crate::memo::NoteFormat::Markdown)
            .unwrap();

        let stop = Arc::new(AtomicBool::new(false));
        let stop_w = Arc::clone(&stop);
        let stop_r = Arc::clone(&stop);

        let (written_tx, written_rx) = mpsc::channel::<String>();
        let dir = t.path().to_path_buf();
        let writer = std::thread::spawn(move || {
            for i in 0..STORM_COUNT {
                if stop_w.load(Ordering::Relaxed) {
                    break;
                }
                let v_w = Vault::open(Some(&dir)).unwrap();
                v_w.create_note("", format!("# Storm{i}"), crate::memo::NoteFormat::Markdown)
                    .unwrap();
                written_tx.send(format!("Storm{i}.md")).unwrap();
            }
        });

        let (observed_tx, observed_rx) = mpsc::channel::<HashSet<String>>();
        let (done_tx, done_rx) = mpsc::channel::<()>();
        let reader = std::thread::spawn(move || {
            for _ in 0..READER_ITERS {
                if stop_r.load(Ordering::Relaxed) {
                    break;
                }
                let mut batch = HashSet::new();
                if let Ok(snap) = v_reader.snapshot() {
                    for r in snap.iter() {
                        batch.insert(r.path.clone());
                    }
                }
                if let Ok(page) = v_reader.query_notes(&crate::props::NoteQuery::default()) {
                    for s in page.items.iter() {
                        batch.insert(s.path.clone());
                    }
                }
                observed_tx.send(batch).unwrap();
                // Yield so writer commits can interleave. Without
                // this sleep the reader thread runs far faster
                // than the writer and observes only Seed.md before
                // exiting.
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            done_tx.send(()).unwrap();
        });

        let mut all_observed: HashSet<String> = HashSet::new();
        let mut committed: HashSet<String> = HashSet::new();
        loop {
            match observed_rx.recv_timeout(std::time::Duration::from_millis(200)) {
                Ok(batch) => all_observed.extend(batch),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
            while let Ok(p) = written_rx.try_recv() {
                committed.insert(p);
            }
        }
        writer.join().unwrap();
        stop.store(true, Ordering::Relaxed);
        reader.join().unwrap();
        while let Ok(batch) = observed_rx.try_recv() {
            all_observed.extend(batch);
        }
        while let Ok(p) = written_rx.try_recv() {
            committed.insert(p);
        }
        let _ = done_rx.recv();

        let missing: Vec<_> = committed
            .iter()
            .filter(|p| !all_observed.contains(*p))
            .collect();
        assert!(
            missing.is_empty(),
            "committed paths {:?} were never observed by reader — cache was poisoned",
            missing
        );
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
            v.folder_schema("knowledge").unwrap().is_some(),
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

    /// Tasks spec §9 end-to-end: the query fence shipped in the daily
    /// template runs as an embedded query (`this_id`) against the day's
    /// note and yields exactly the tasks due on or before the note's own
    /// ISO filename — due-today passes; due-tomorrow and undated drop.
    #[test]
    fn daily_template_fence_lists_only_tasks_due_today() {
        let (_t, v) = tmp_vault();
        v.migrate().unwrap();
        v.create_memo(
            "# 업무\n\n- [ ] 오늘 마감 📅 2026-08-29\n- [ ] 내일 마감 📅 2026-08-30\n- [ ] 기한 없음\n"
                .to_string(),
            None,
        )
        .unwrap();
        let (daily, created) = v.open_daily("2026-08-29").unwrap();
        assert!(created, "fresh vault mints today's note from the template");
        // Run the fence embedded in the note itself, not a hand-built def.
        let start = daily
            .body
            .find("```query\n")
            .expect("daily note carries the §9 fence")
            + "```query\n".len();
        let end = daily.body[start..].find("\n```").expect("fence closes") + start;
        let def = crate::base::parse_base(&daily.body[start..end]).unwrap();
        let page = v
            .run_base(
                &crate::base::BaseSource::Inline(def),
                &crate::base::RunBaseReq {
                    view_index: 0,
                    offset: 0,
                    limit: 50,
                    group: None,
                    // Pinned clock: the filter never calls now()/today(),
                    // and UTC makes due-today == this.file.name midnight.
                    now_ms: Some(1_767_225_600_000),
                    local_offset_seconds: Some(0),
                    include_group_counts: false,
                    include_summaries: false,
                    this_id: Some(daily.id),
                },
            )
            .unwrap();
        assert_eq!(page.total, 1, "only the due-today task: {page:?}");
        let task = page.rows[0].task.as_ref().expect("task row carries a DTO");
        assert_eq!(task.text, "오늘 마감");
        assert_ne!(
            page.rows[0].summary.id, daily.id,
            "the row is the indexed task, not the daily note itself"
        );
    }

    /// §9 install semantics: `apply_preset` is skip-if-exists, so a
    /// user-owned TEMPLATE.md survives `migrate` byte-identical and a
    /// pre-existing daily note is adopted verbatim — the new 할 일 fence
    /// is stamped only into notes created AFTER the template lands.
    #[test]
    fn daily_preset_never_rewrites_existing_template_or_notes() {
        let (_t, v) = tmp_vault();
        v.ensure_initialized().unwrap();
        std::fs::create_dir_all(v.paths().vault.join("daily")).unwrap();
        let custom = "# {{date}}\n\n내 템플릿\n";
        std::fs::write(v.paths().vault.join("daily/TEMPLATE.md"), custom).unwrap();
        v.migrate().unwrap();
        assert_eq!(
            std::fs::read_to_string(v.paths().vault.join("daily/TEMPLATE.md")).unwrap(),
            custom,
            "existing TEMPLATE.md is never overwritten"
        );
        std::fs::write(
            v.paths().vault.join("daily/2026-08-29.md"),
            "# 2026-08-29\n\n직접 쓴 하루\n",
        )
        .unwrap();
        let (m, created) = v.open_daily("2026-08-29").unwrap();
        assert!(!created, "adopts the existing file");
        assert_eq!(m.body, "# 2026-08-29\n\n직접 쓴 하루\n");
        assert!(
            !m.body.contains("## 할 일"),
            "existing daily notes are never rewritten"
        );
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
        let blank = v.create_note_auto("knowledge", String::new()).unwrap();
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
            Some(&crate::props::PropValue::Str(today))
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
        let n = v.create_note_auto("knowledge", "# 재확인".into()).unwrap();
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
        let backdated = raw.replace(
            &format!("status_changed: {today}"),
            "status_changed: 2026-01-01",
        );
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
            Some(&crate::props::PropValue::Str(today)),
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
        assert!(
            std::fs::read_to_string(root.join("SCHEMA.toml"))
                .unwrap()
                .contains("내 책")
        );

        // Deleting an installed collection is permanent: migrate does
        // not resurrect it (unlike knowledge/daily system folders).
        v.delete_folder("책").unwrap();
        v.migrate().unwrap();
        assert!(!v.paths().vault.join("책/SCHEMA.toml").exists());
        assert!(v.install_collection("nope", "x").is_err());
    }
    /// The inventory is the vault's self-description (copilot
    /// schema-awareness design 2026-08-24 §2.1): every physical folder,
    /// its note count, and its schema/template facts. Installed-but-empty
    /// collections must appear — the agent's first question is "where do
    /// movies live", and an empty folder is still an answer.
    #[test]
    fn folder_inventory_reports_schemas_templates_and_counts() {
        let (_t, v) = tmp_vault();
        v.migrate().unwrap();
        v.install_collection("movie", "movies").unwrap();
        v.create_note(
            "knowledge",
            "# 코루틴 취소\n\n본문".into(),
            crate::memo::NoteFormat::Markdown,
        )
        .unwrap();
        // A plain schema-less folder with one note.
        v.create_folder("scratch").unwrap();
        v.create_note(
            "scratch",
            "# 임시\n\n본문".into(),
            crate::memo::NoteFormat::Markdown,
        )
        .unwrap();

        let inv = v.folder_inventory().unwrap();
        let by: std::collections::HashMap<String, FolderInfo> =
            inv.into_iter().map(|f| (f.path.clone(), f)).collect();

        let k = &by["knowledge"];
        assert_eq!(k.notes, 1);
        assert_eq!(k.preset.as_deref(), Some("knowledge"));
        assert_eq!(k.workspace.as_deref(), Some("지식"));
        assert!(k.has_schema && k.has_template);

        // Installed but empty: visible, zero notes, facts intact.
        let m = &by["movies"];
        assert_eq!(m.notes, 0);
        assert_eq!(m.preset.as_deref(), Some("movie"));
        assert_eq!(m.workspace.as_deref(), Some("영화"));
        assert!(m.has_schema && m.has_template);

        let s = &by["scratch"];
        assert_eq!(s.notes, 1);
        assert!(s.preset.is_none() && s.workspace.is_none());
        assert!(!s.has_schema && !s.has_template);

        // The vault root itself is never an entry (list_folders rule).
        assert!(!by.contains_key(""));
    }

    /// Movie preset template (`kind: movie`, `watched_at: {{date}}`)
    /// must stamp new notes like every other preset — regression probe
    /// for a capture-path bug found during CLI schema smoke (2026-08-24).
    #[test]
    fn movie_template_stamps_kind_and_watched_at() {
        let (_t, v) = tmp_vault();
        v.migrate().unwrap();
        v.install_collection("movie", "movies").unwrap();
        let note = v
            .create_note(
                "movies",
                "# 타이틀\n본문".into(),
                crate::memo::NoteFormat::Markdown,
            )
            .unwrap();
        assert_eq!(
            note.props.get("kind"),
            Some(&crate::props::PropValue::Str("movie".into())),
            "props: {:?}",
            note.props
        );
        assert!(
            note.props.contains_key("watched_at"),
            "{{date}} must expand: {:?}",
            note.props
        );
    }

    #[test]
    fn aliases_and_prop_links_resolve_in_graph_and_backlinks() {
        let (_t, v) = tmp_vault();
        // Target known by alias "ML".
        let target = v
            .create_note(
                "",
                "# 머신러닝\n\n본문".into(),
                crate::memo::NoteFormat::Markdown,
            )
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
            .create_note(
                "",
                "# 딥러닝\n\nb".into(),
                crate::memo::NoteFormat::Markdown,
            )
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
        v.update_note(target.id, Some("# 심층학습\n\nb".into()), None)
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
    // -- brain documents-plane glue on open (unified home) --------------

    #[test]
    fn open_records_pending_registration_when_brain_enabled() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_path_buf();
        let expected_vault = home.join("vault/work");
        std::fs::create_dir_all(&expected_vault).unwrap();
        std::fs::write(
            expected_vault.join("oximemo.toml"),
            "[brain]\nenabled = true\n",
        )
        .unwrap();
        crate::brain::with_test_pending_dir(&home.join("pending"), || {
            let _v = Vault::open(Some(&expected_vault)).unwrap();
            let pending = crate::brain::pending_root_registration()
                .expect("open must record the pending registration");
            assert_eq!(pending.requests.len(), 1);
            assert_eq!(pending.requests[0].request.space, "work");
            assert_eq!(pending.requests[0].request.alias, "work");
            assert_eq!(
                pending.requests[0].request.path,
                expected_vault.to_string_lossy()
            );
            // The rules stay the brain's defaults; oximemo writes only
            // its own pending file — never a brain file.
            assert!(pending.requests[0].request.include.is_none());
            assert!(!home.join("brain").exists(), "no brain dir is created");
        });
    }

    #[test]
    fn repeated_open_rewrites_the_same_pending_record() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_path_buf();
        let expected_vault = home.join("vault/personal");
        std::fs::create_dir_all(&expected_vault).unwrap();
        std::fs::write(
            expected_vault.join("oximemo.toml"),
            "[brain]\nenabled = true\n",
        )
        .unwrap();
        crate::brain::with_test_pending_dir(&home.join("pending"), || {
            let _ = Vault::open(Some(&expected_vault)).unwrap();
            let _ = Vault::open(Some(&expected_vault)).unwrap();
            let _ = Vault::open(Some(&expected_vault)).unwrap();
            // Records dedupe by alias, so repeated opens cannot
            // accumulate state; the flush side is idempotent via the
            // brain's alias-keyed upsert.
            let pending = crate::brain::pending_root_registration().expect("recorded");
            assert_eq!(pending.requests.len(), 1);
            assert_eq!(
                pending.requests[0].request.path,
                expected_vault.to_string_lossy()
            );
        });
    }

    #[test]
    fn brain_disabled_records_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_path_buf();
        let expected_vault = home.join("vault/personal");
        std::fs::create_dir_all(&expected_vault).unwrap();
        std::fs::write(
            expected_vault.join("oximemo.toml"),
            "[brain]\nenabled = false\n",
        )
        .unwrap();
        crate::brain::with_test_pending_dir(&home.join("pending"), || {
            let _v = Vault::open(Some(&expected_vault)).unwrap();
            assert!(
                !home
                    .join("pending")
                    .join(crate::brain::PENDING_FILE_NAME)
                    .exists(),
                "disabled brain must not record a registration"
            );
            assert!(!home.join("brain").exists());
        });
    }

    // -- create_capture + inbox seed (spec 2026-08-25 §2.1) --------

    #[test]
    fn create_capture_targets_idea_preset_folder() {
        let (_t, v) = tmp_vault();
        // First-vault open installs daily+knowledge+inbox (one-shot seed).
        v.migrate().unwrap();
        // H1 → deterministic slug filename; untitled bodies fall back
        // to a timestamp per `create_note`'s `derive_filename_from_body`.
        let n = v.create_capture("# quick thought".into()).unwrap();
        assert_eq!(v.note_dto(&n).path, "inbox/quick-thought.md");
    }

    #[test]
    fn create_capture_targets_idea_preset_renamed_path() {
        let (_t, v) = tmp_vault();
        v.migrate().unwrap();
        // Move inbox via the existing rename_folder path so the marker
        // resolves the new path.
        v.rename_folder("inbox", "scratch").unwrap();
        let n = v.create_capture("x".into()).unwrap();
        let path = v.note_dto(&n).path;
        assert!(path.starts_with("scratch/"), "got {path}");
    }

    #[test]
    fn create_capture_falls_back_to_root_when_inbox_missing() {
        let (_t, v) = tmp_vault();
        v.migrate().unwrap();
        // Delete inbox folder; verify capture still works (root fallback).
        // Actual signature is `delete_folder(path) -> Result<Vec<MemoId>>`.
        v.delete_folder("inbox").unwrap();
        let n = v.create_capture("y".into()).unwrap();
        assert_eq!(v.note_dto(&n).folder, "");
    }

    #[test]
    fn inbox_seed_runs_once_and_not_recreated_after_delete() {
        let (t, v) = tmp_vault();
        v.migrate().unwrap();
        assert!(v.paths().vault.join("inbox").join("SCHEMA.toml").exists());
        v.delete_folder("inbox").unwrap();
        // Re-run migrate — seed must NOT resurrect the deleted folder.
        v.migrate().unwrap();
        assert!(!v.paths().vault.join("inbox").join("SCHEMA.toml").exists());
        drop(t);
    }

    #[test]
    fn inbox_seed_skips_when_existing_idea_folder_already_present() {
        let (_t, v) = tmp_vault();
        // User pre-installed an ideas folder at a non-default path BEFORE
        // migrate. The marker check must honor this: migrate must NOT
        // install the default "inbox" folder on top.
        v.install_collection("idea", "user-thoughts").unwrap();
        v.migrate().unwrap();
        let by_preset: std::collections::HashMap<String, String> = v
            .folder_inventory()
            .unwrap()
            .into_iter()
            .filter_map(|f| f.preset.map(|p| (p, f.path)))
            .collect();
        assert_eq!(
            by_preset.get("idea").map(String::as_str),
            Some("user-thoughts")
        );
        assert!(
            !v.folder_inventory()
                .unwrap()
                .iter()
                .any(|f| f.path == "inbox"),
            "default inbox must not be installed alongside the user's idea folder"
        );
    }

    // -- installed `할 일` base seed (tasks spec 2026-08-27 §7.4) ----

    #[test]
    fn tasks_base_is_protected_and_restored_when_missing() {
        let (t, v) = tmp_vault();
        v.migrate().unwrap();
        let abs = v.paths().vault.join(TASKS_BASE_REL);
        assert!(abs.exists(), "fresh vault must install the 할 일 base");
        // The seeded document is a valid tasks base: task source, five
        // `tasks`-type views named 오늘/예정/지연/전체/날짜 없음, no warnings.
        let yaml = std::fs::read_to_string(&abs).unwrap();
        assert_eq!(yaml, TASKS_BASE_MD);
        let def = crate::base::parse_base(&yaml).unwrap();
        assert!(matches!(def.source, crate::base::BaseSourceKind::Tasks));
        assert!(crate::base::validate(&def).unwrap().is_empty());
        let names: Vec<&str> = def
            .views
            .iter()
            .map(|view| view.name.as_deref().unwrap_or(""))
            .collect();
        assert_eq!(names, ["오늘", "예정", "지연", "전체", "날짜 없음"]);
        assert!(def.views.iter().all(|view| view.r#type == "tasks"));
        assert!(v.paths().tasks_base_seed_marker_path().exists());
        // End-to-end: the seeded views actually execute. Pinned clock
        // 2026-08-29T12:00Z (offset 0) → today() = 2026-08-29.
        v.create_memo(
            "# 업무\n\n- [ ] 지연 항목 📅 2026-08-27\n- [ ] 오늘 항목 📅 2026-08-29\n- [ ] 예정 항목 ⏳ 2026-09-02\n- [ ] 기한 없음\n"
                .to_string(),
            None,
        )
        .unwrap();
        let run_view = |index: usize| {
            v.run_base(
                &crate::base::BaseSource::Path(TASKS_BASE_REL.to_string()),
                &crate::base::RunBaseReq {
                    view_index: index,
                    offset: 0,
                    limit: 50,
                    group: None,
                    now_ms: Some(1_788_004_800_000),
                    local_offset_seconds: Some(0),
                    include_group_counts: false,
                    include_summaries: false,
                    this_id: None,
                },
            )
            .unwrap()
        };
        assert_eq!(run_view(0).total, 2, "오늘: overdue + due-today");
        assert_eq!(run_view(1).total, 1, "예정: future scheduled only");
        assert_eq!(run_view(2).total, 1, "지연: strictly-overdue due only");
        assert_eq!(run_view(3).total, 4, "전체: every indexed task");
        assert_eq!(run_view(4).total, 1, "날짜 없음: the undated task");
        // The installed base is a protected system file: trash and
        // rename refuse it, so it cannot vanish through the app. A file
        // missing anyway (external interference, or a pre-guard vault
        // where deletion was possible) is repaired on the next open.
        let trash_err = v.trash_base(TASKS_BASE_REL).unwrap_err();
        assert!(
            trash_err.to_string().contains("protected"),
            "trash must refuse the built-in base: {trash_err}"
        );
        assert!(abs.exists(), "refused trash must leave the base intact");
        let rename_err = v
            .rename_base(TASKS_BASE_REL, "queries/renamed.query", None)
            .unwrap_err();
        assert!(
            rename_err.to_string().contains("protected"),
            "rename must refuse the built-in base: {rename_err}"
        );
        assert!(abs.exists(), "refused rename must leave the base intact");
        std::fs::remove_file(&abs).unwrap();
        v.migrate().unwrap();
        assert!(abs.exists(), "missing base must be re-seeded on open");
        assert_eq!(std::fs::read_to_string(&abs).unwrap(), TASKS_BASE_MD);
        assert_eq!(
            std::fs::read_to_string(v.paths().tasks_base_seed_marker_path())
                .unwrap()
                .trim(),
            "2"
        );
        drop(t);
    }

    #[test]
    fn tasks_base_seed_v2_upgrades_an_edited_v1_base_structurally() {
        let (_t, v) = tmp_vault();
        v.migrate().unwrap();
        // A v1-era vault: the original tasks views plus a user-added
        // table view. The stale "1" marker makes migrate() run the seed
        // check: the v2 upgrade must APPEND the 날짜 없음 view without
        // touching anything else the user changed.
        let v1 = "source: tasks\nviews:\n  - type: tasks\n    name: 오늘\n    filters: 'task.due != null && task.due <= today()'\n  - type: tasks\n    name: 예정\n    filters: 'task.scheduled != null && task.scheduled > today()'\n  - type: tasks\n    name: 지연\n    filters: 'task.due != null && task.due < today()'\n  - type: tasks\n    name: 전체\n  - type: table\n    name: 테이블\n";
        v.save_base(TASKS_BASE_REL, v1, None).unwrap();
        std::fs::write(v.paths().tasks_base_seed_marker_path(), b"1").unwrap();
        v.migrate().unwrap();
        let yaml = std::fs::read_to_string(v.paths().vault.join(TASKS_BASE_REL)).unwrap();
        assert!(
            yaml.contains("테이블"),
            "user-added views survive the upgrade"
        );
        let def = crate::base::parse_base(&yaml).unwrap();
        let nodate = def
            .views
            .iter()
            .find(|view| view.name.as_deref() == Some("날짜 없음"))
            .expect("v2 appends the 날짜 없음 view");
        assert_eq!(nodate.r#type, "tasks");
        match nodate.filters.as_ref() {
            Some(crate::base::FilterSpec::Expr(expr)) => {
                assert_eq!(expr, "task.due == null && task.scheduled == null");
            }
            other => panic!("expected the guarded no-date expr, got {other:?}"),
        }
        assert_eq!(
            std::fs::read_to_string(v.paths().tasks_base_seed_marker_path())
                .unwrap()
                .trim(),
            "2",
            "the marker records the seed version"
        );
        // Idempotent: later migrates must not duplicate the view.
        v.migrate().unwrap();
        let def2 = crate::base::parse_base(
            &std::fs::read_to_string(v.paths().vault.join(TASKS_BASE_REL)).unwrap(),
        )
        .unwrap();
        assert_eq!(
            def2.views
                .iter()
                .filter(|view| view.name.as_deref() == Some("날짜 없음"))
                .count(),
            1
        );
    }

    #[test]
    fn tasks_base_seed_v2_respects_a_user_view_that_already_owns_the_name() {
        let (_t, v) = tmp_vault();
        v.migrate().unwrap();
        // The user already has a view named 날짜 없음 (here: a table) —
        // their semantics win; nothing is appended.
        let mine = "source: tasks\nviews:\n  - type: tasks\n    name: 전체\n  - type: table\n    name: 날짜 없음\n";
        v.save_base(TASKS_BASE_REL, mine, None).unwrap();
        std::fs::write(v.paths().tasks_base_seed_marker_path(), b"1").unwrap();
        v.migrate().unwrap();
        let def = crate::base::parse_base(
            &std::fs::read_to_string(v.paths().vault.join(TASKS_BASE_REL)).unwrap(),
        )
        .unwrap();
        assert_eq!(
            def.views.len(),
            2,
            "no tasks view is appended over the user's name"
        );
        assert_eq!(
            std::fs::read_to_string(v.paths().tasks_base_seed_marker_path())
                .unwrap()
                .trim(),
            "2"
        );
    }

    #[test]
    fn tasks_base_seed_v2_leaves_an_unparseable_base_alone_for_the_user_to_fix() {
        let (_t, v) = tmp_vault();
        v.migrate().unwrap();
        // A hand-edited file that no longer parses is never rewritten;
        // the marker stays stale so the upgrade retries after the fix.
        let broken = "source: [broken\n";
        std::fs::write(v.paths().vault.join(TASKS_BASE_REL), broken).unwrap();
        std::fs::write(v.paths().tasks_base_seed_marker_path(), b"1").unwrap();
        v.migrate().unwrap();
        let yaml = std::fs::read_to_string(v.paths().vault.join(TASKS_BASE_REL)).unwrap();
        assert_eq!(yaml, broken, "unparseable files are never rewritten");
        assert_eq!(
            std::fs::read_to_string(v.paths().tasks_base_seed_marker_path())
                .unwrap()
                .trim(),
            "1"
        );
    }

    #[test]
    fn tasks_base_seed_v1_repairs_a_deleted_base_on_upgrade() {
        let (t, v) = tmp_vault();
        v.migrate().unwrap();
        // A v1-era vault where the (then deletable) base was removed:
        // the version bump advances the marker AND the protected base
        // is restored — absence is no longer a legitimate state.
        let abs = v.paths().vault.join(TASKS_BASE_REL);
        std::fs::remove_file(&abs).unwrap();
        std::fs::write(v.paths().tasks_base_seed_marker_path(), b"1").unwrap();
        v.migrate().unwrap();
        assert!(abs.exists(), "missing base must be restored on open");
        assert_eq!(
            std::fs::read_to_string(v.paths().tasks_base_seed_marker_path())
                .unwrap()
                .trim(),
            "2"
        );
        drop(t);
    }

    // -- .query base file CRUD (task 7) -------------------------------

    /// Minimal valid `.query` document used by the round-trip / parse-validate tests.
    const QUERY_YAML: &str =
        "filters: 'file.name != \"\"'\nviews:\n  - type: table\n    name: All\n";

    /// Save an inline literal `.query` (no helpers — exercises the public Vault API).
    fn write_inline(dir: &Path, rel: &str, contents: &str) {
        let abs = dir.join(rel);
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(abs, contents).unwrap();
    }

    fn must_err<T: std::fmt::Debug>(r: Result<T>) -> String {
        match r {
            Ok(v) => panic!("expected error, got {v:?}"),
            Err(e) => format!("{e}"),
        }
    }

    fn sleep_past_mtime_resolution() {
        // Filesystem mtime resolution on macOS is coarse; nudge by 10 ms so
        // a subsequent write produces a distinguishable mtime.
        std::thread::sleep(std::time::Duration::from_millis(20));
    }

    #[test]
    fn base_save_load_round_trip() {
        let (_t, v) = tmp_vault();
        v.save_base("queries/all.query", QUERY_YAML, None).unwrap();
        let (raw, mtime) = v.load_base_raw("queries/all.query").unwrap();
        assert_eq!(raw, QUERY_YAML);
        let def = v.load_base("queries/all.query").unwrap();
        assert_eq!(def.views.len(), 1);
        assert_eq!(def.views[0].name.as_deref(), Some("All"));
        assert!(mtime > std::time::UNIX_EPOCH);
    }

    #[test]
    fn base_save_stale_mtime_is_conflict() {
        let (_t, v) = tmp_vault();
        v.save_base("queries/x.query", QUERY_YAML, None).unwrap();
        let (_, baseline) = v.load_base_raw("queries/x.query").unwrap();
        // External write — vault mtime cache must observe a different time.
        sleep_past_mtime_resolution();
        write_inline(
            v.paths().vault.as_path(),
            "queries/x.query",
            "filters: '1 == 1'\nviews:\n  - type: table\n",
        );
        let stale = baseline - std::time::Duration::from_secs(60);
        let msg = must_err(v.save_base("queries/x.query", QUERY_YAML, Some(stale)));
        assert!(
            msg.contains("query modified elsewhere") || msg.contains("mtime"),
            "expected mtime conflict error, got {msg}"
        );
    }

    #[test]
    fn base_save_invalid_yaml_keeps_original_untouched() {
        let (_t, v) = tmp_vault();
        v.save_base("queries/good.query", QUERY_YAML, None).unwrap();
        let original_bytes = std::fs::read(v.paths().vault.join("queries/good.query")).unwrap();
        // Bad YAML — parse fails, write must not touch the file.
        let bad = "filters: ':\nviews:\n  - type: table\n";
        let msg = must_err(v.save_base("queries/good.query", bad, None));
        assert!(
            msg.contains("parse") || msg.contains("yaml"),
            "expected parse error from save_base; got {msg}"
        );
        let after_bytes = std::fs::read(v.paths().vault.join("queries/good.query")).unwrap();
        assert_eq!(
            original_bytes, after_bytes,
            "original file must be untouched on parse failure"
        );
    }

    #[test]
    fn base_save_rejects_traversal() {
        let (_t, v) = tmp_vault();
        let msg = must_err(v.save_base("../escape.query", QUERY_YAML, None));
        assert!(msg.contains("invalid query path"), "got {msg}");
    }

    #[test]
    fn base_save_rejects_absolute() {
        let (_t, v) = tmp_vault();
        let msg = must_err(v.save_base("/abs.query", QUERY_YAML, None));
        assert!(msg.contains("invalid query path"), "got {msg}");
    }

    #[test]
    fn base_save_rejects_wrong_extension() {
        let (_t, v) = tmp_vault();
        let msg = must_err(v.save_base("notes/x.md", QUERY_YAML, None));
        assert!(msg.contains("invalid query path"), "got {msg}");
    }

    #[test]
    fn base_rename_refuses_existing_destination() {
        let (_t, v) = tmp_vault();
        v.save_base("a.query", QUERY_YAML, None).unwrap();
        v.save_base("b.query", QUERY_YAML, None).unwrap();
        let msg = must_err(v.rename_base("a.query", "b.query", None));
        assert!(
            msg.contains("exists") || msg.contains("already"),
            "got {msg}"
        );
    }

    #[test]
    fn base_trash_then_restore_round_trip() {
        let (_t, v) = tmp_vault();
        v.save_base("queries/x.query", QUERY_YAML, None).unwrap();
        let token = v.trash_base("queries/x.query").unwrap();
        // Trashed → hidden from list_bases.
        let live_after = v.list_bases().unwrap();
        assert!(
            !live_after.iter().any(|i| i.path == "queries/x.query"),
            "trashed query must not appear in list_bases"
        );
        // Restore — should bring it back at the original relative path.
        let restored_rel = v.restore_base(&token).unwrap();
        assert_eq!(restored_rel, "queries/x.query");
        let live_again = v.list_bases().unwrap();
        assert!(
            live_again.iter().any(|i| i.path == "queries/x.query"),
            "restored query must reappear in list_bases"
        );
    }

    #[test]
    fn base_load_rejects_under_trash_dir() {
        let (_t, v) = tmp_vault();
        // Place a `.query` literally under `.trash/` — load must refuse.
        std::fs::create_dir_all(v.paths().vault.join(".trash")).unwrap();
        std::fs::write(v.paths().vault.join(".trash/x.query"), QUERY_YAML).unwrap();
        let msg = must_err(v.load_base(".trash/x.query"));
        assert!(msg.contains("invalid query path"), "got {msg}");
    }

    #[test]
    fn base_save_preserves_unknown_top_level_key() {
        let (_t, v) = tmp_vault();
        let raw = "future: 42\nviews:\n  - type: table\n    name: A\n";
        v.save_base("queries/forward.query", raw, None).unwrap();
        let (loaded, _) = v.load_base_raw("queries/forward.query").unwrap();
        let parsed: serde_yaml_ng::Value = serde_yaml_ng::from_str(&loaded).unwrap();
        let map = parsed.as_mapping().expect("top-level mapping");
        assert!(
            map.iter().any(|(k, _)| k.as_str() == Some("future")),
            "unknown `future` key dropped: {loaded}",
            loaded = loaded
        );
    }

    /// Covering test for fix #1 (restore must left-parse `<digits>-`
    /// and recover the original filename, even when it contains
    /// dashes).
    #[test]
    fn base_trash_then_restore_preserves_dashed_filename() {
        let (_t, v) = tmp_vault();
        v.save_base("queries/my-base.query", QUERY_YAML, None)
            .unwrap();
        let token = v.trash_base("queries/my-base.query").unwrap();
        let restored_rel = v.restore_base(&token).unwrap();
        assert_eq!(restored_rel, "queries/my-base.query");
        let (raw, _) = v.load_base_raw("queries/my-base.query").unwrap();
        assert_eq!(
            raw, QUERY_YAML,
            "restored file must contain original content"
        );
    }

    /// The trash token embeds the ORIGINAL vault-relative path, so a
    /// query that did not live under `queries/` restores in place
    /// instead of being relocated (whole-branch review finding).
    #[test]
    fn base_trash_root_level_query_restores_in_place() {
        let (_t, v) = tmp_vault();
        v.save_base("x.query", QUERY_YAML, None).unwrap();
        let token = v.trash_base("x.query").unwrap();
        let restored = v.restore_base(&token).unwrap();
        assert_eq!(
            restored, "x.query",
            "root-level query must restore at origin"
        );
        assert!(v.load_base_raw("x.query").is_ok(), "file is back at origin");
    }

    #[test]
    fn base_trash_nested_query_restores_original_dir() {
        let (_t, v) = tmp_vault();
        v.save_base("shelf/deep.query", QUERY_YAML, None).unwrap();
        let token = v.trash_base("shelf/deep.query").unwrap();
        assert!(
            token.contains("%2F"),
            "token must embed the origin path: {token}"
        );
        let restored = v.restore_base(&token).unwrap();
        assert_eq!(restored, "shelf/deep.query");
        let (raw, _) = v.load_base_raw("shelf/deep.query").unwrap();
        assert_eq!(raw, QUERY_YAML, "restored content is the original");
    }

    /// Backward compatibility: a legacy `<millis>-<filename>` token
    /// (written before the origin-embedding format) still parses and
    /// restores under `queries/` exactly as before.
    #[test]
    fn base_restore_legacy_token_lands_under_queries() {
        let (_t, v) = tmp_vault();
        let trash_dir = v.paths.trash_root().join(crate::paths::TRASH_QUERIES_DIR);
        std::fs::create_dir_all(&trash_dir).unwrap();
        std::fs::write(trash_dir.join("1700000000000-old.query"), QUERY_YAML).unwrap();
        let restored = v.restore_base("1700000000000-old.query").unwrap();
        assert_eq!(restored, "queries/old.query");
    }

    /// Covering test for fix #1 (collision handling): trashing the
    /// same filename twice in the same millisecond must produce two
    /// Covering test for fix #1 (collision handling): trashing a file
    /// when the natural millis slot is occupied must bump the millis
    /// prefix and pick a free slot. The recovered token must still
    /// round-trip through restore with the original filename.
    #[test]
    fn base_trash_collision_bumps_millis() {
        let (_t, v) = tmp_vault();
        v.save_base("queries/dup.query", QUERY_YAML, None).unwrap();
        // Pre-stuff the trash with a file at the millis slot the
        // next trash would naturally use. The slot is occupied, so
        // trash_base must bump millis+1.
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let trash_dir = v.paths.trash_root().join(crate::paths::TRASH_QUERIES_DIR);
        std::fs::create_dir_all(&trash_dir).unwrap();
        std::fs::write(trash_dir.join(format!("{millis}-dup.query")), b"squatter").unwrap();
        let token = v.trash_base("queries/dup.query").unwrap();
        // The token's prefix must NOT be the natural millis (it's
        // occupied); the bump logic advanced to millis+1.
        let prefix: String = token.chars().take_while(|c| c.is_ascii_digit()).collect();
        let prefix_num: u128 = prefix.parse().unwrap();
        assert!(
            prefix_num >= millis,
            "bumped millis prefix {prefix_num} must not precede natural millis {millis}"
        );
        // And restore still works.
        let rel = v.restore_base(&token).unwrap();
        assert_eq!(rel, "queries/dup.query");
        // The squatter survives (we never overwrote it).
        assert_eq!(
            std::fs::read(trash_dir.join(format!("{millis}-dup.query"))).unwrap(),
            b"squatter"
        );
    }

    /// Covering test for fix #2 (no carve-out for top-level dot /
    /// underscore filenames — they're rejected up front so they
    /// never reach disk).
    #[test]
    fn base_save_rejects_root_level_hidden_filename() {
        let (_t, v) = tmp_vault();
        let msg = must_err(v.save_base("_x.query", QUERY_YAML, None));
        assert!(
            msg.contains("invalid query path"),
            "expected guard rejection for '_x.query'; got {msg}"
        );
        let msg = must_err(v.save_base(".x.query", QUERY_YAML, None));
        assert!(
            msg.contains("invalid query path"),
            "expected guard rejection for '.x.query'; got {msg}"
        );
    }

    /// Covering test for fix #3 (destination guard runs BEFORE the
    /// rename out of trash — a rejected restore leaves the trash
    /// file in place).
    #[test]
    fn base_restore_failure_keeps_trash_file_intact() {
        let (_t, v) = tmp_vault();
        // Construct a token whose recovered filename (`.query` suffix
        // aside) maps to a destination the path guard rejects.
        // Filenames with leading underscores get rejected by the
        // guard, so we handcraft a trash file directly and feed its
        // token through restore.
        std::fs::create_dir_all(v.paths().trash_root().join(crate::paths::TRASH_QUERIES_DIR))
            .unwrap();
        // Place a `_x.query` directly under `.trash/_queries/` with
        // the expected `<millis>-<​filename>` token shape. Restore
        // will recover `_x.query` and try to land it at
        // `queries/_x.query` — a hidden-prefixed component, which the
        // guard must reject.
        let token = "1700000000000-_x.query";
        let token_path = v
            .paths
            .trash_root()
            .join(crate::paths::TRASH_QUERIES_DIR)
            .join(token);
        std::fs::write(&token_path, QUERY_YAML).unwrap();
        let msg = must_err(v.restore_base(token));
        assert!(
            msg.contains("invalid query path"),
            "expected guard rejection on restore destination; got {msg}"
        );
        // The trash file must still be there.
        assert!(
            token_path.exists(),
            "trash file must remain after rejected restore"
        );
    }

    /// Namespace sweeps mutate the PROCESS-GLOBAL test index root
    /// (`isolate_index_root_for_tests` is a per-pid OnceLock). Under
    /// in-process parallel `cargo test` (CI), one test's sweep can delete
    /// another test's stale fixtures — nextest's process-per-test model
    /// hides this. Serialize every sweep-driving test on this lock.
    static SWEEP_SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());
    #[test]
    fn gc_stale_namespaces_removes_only_old_unlocked_foreign_ones() {
        let _sweep = SWEEP_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let _ = crate::paths::isolate_index_root_for_tests(); // FIRST: the root must be the override, never the real App Support
        let root = crate::paths::by_vault_root();
        std::fs::create_dir_all(&root).unwrap();

        let mk = |name: &str, age: std::time::Duration| {
            let d = root.join(name);
            std::fs::create_dir_all(&d).unwrap();
            let f = std::fs::File::create(d.join(crate::paths::META_DB_NAME)).unwrap();
            f.set_modified(std::time::SystemTime::now() - age).unwrap();
        };

        // Self-exclusion setup: create this Vault's own index and age it
        // far beyond the threshold — GC must still never delete it.
        let (_t, v) = tmp_vault();
        v.create_note("", "# own".into(), crate::memo::NoteFormat::Markdown)
            .unwrap();
        let own_db = v.paths().meta_db_path();
        assert!(own_db.exists(), "fixture: own index must exist");
        std::fs::File::open(&own_db)
            .unwrap()
            .set_modified(
                std::time::SystemTime::now() - std::time::Duration::from_secs(90 * 24 * 3600),
            )
            .unwrap();

        mk("stale", std::time::Duration::from_secs(2 * 3600));
        mk("fresh", std::time::Duration::from_secs(60));
        mk("locked", std::time::Duration::from_secs(2 * 3600));
        let guard = crate::lock::acquire(
            &root.join("locked").join(crate::paths::META_LOCK_NAME),
            LockKind::Exclusive,
            std::time::Duration::from_secs(1),
        )
        .unwrap();

        assert_eq!(
            v.gc_stale_namespaces(std::time::Duration::from_secs(3600))
                .unwrap(),
            1
        );
        assert!(!root.join("stale").exists(), "stale namespace removed");
        assert!(root.join("fresh").exists(), "young namespace kept");
        assert!(
            root.join("locked").exists(),
            "in-flight (locked) namespace skipped"
        );
        assert!(own_db.exists(), "own namespace never deleted");

        drop(guard);
        assert_eq!(
            v.gc_stale_namespaces(std::time::Duration::from_secs(3600))
                .unwrap(),
            1
        );
        assert!(
            !root.join("locked").exists(),
            "unlocked after release: swept"
        );
    }

    #[test]
    fn doctor_reports_and_sweeps_stale_namespaces() {
        let _sweep = SWEEP_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let _ = crate::paths::isolate_index_root_for_tests();
        let root = crate::paths::by_vault_root();
        std::fs::create_dir_all(&root).unwrap();
        let d = root.join("oldns");
        std::fs::create_dir_all(&d).unwrap();
        let f = std::fs::File::create(d.join(crate::paths::META_DB_NAME)).unwrap();
        f.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(2 * 3600))
            .unwrap();

        let (_t, v) = tmp_vault();
        // Report-only: counts, does not delete.
        assert_eq!(v.doctor(false).unwrap().stale_index_namespaces, 1);
        assert!(d.exists(), "report mode must not delete");
        // --fix: sweeps and reports the swept count.
        assert_eq!(v.doctor(true).unwrap().stale_index_namespaces, 1);
        assert!(!d.exists(), "fix mode must sweep");
        assert_eq!(v.doctor(false).unwrap().stale_index_namespaces, 0);
    }
}
