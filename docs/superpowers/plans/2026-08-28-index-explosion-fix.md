# Index Explosion Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the `~/Library/Application Support/com.oximemo.app/index/by-vault/` directory from growing without bound (measured: 267 dirs / 365 MB in one day on the dev machine).

**Architecture:** Three independent mechanisms. (1) `Paths::resolve(Some(v))` normalizes an explicitly-passed default vault back to the top-level index — fixes the GUI watcher writing to an index nobody reads. (2) A process-global test-only index-root override, consulted only by the `Some` branch of `resolve`, stops `cargo test` runs from leaking one 1.2 MB redb namespace per test into the real user's Application Support. (3) `Vault::gc_stale_namespaces(min_age)` deletes stale namespaces (mtime-age threshold + non-blocking flock in-flight guard + self-exclusion), wired to GUI startup (7-day age) and `doctor --fix` (1-hour age).

**Tech Stack:** Rust (workspace crates `oximemo-core`, `oximemo-cli`, desktop `src-tauri`), redb, fs2 flock, tempfile.

## Global Constraints

- Derived data only: by-vault namespaces are rebuildable indexes — GC must never touch note files, the top-level `index/meta.redb`, `index/search/`, or the current vault's own namespace.
- No new crate dependencies.
- `clippy -D warnings` clean; all existing tests keep passing.
- The main working tree has unrelated uncommitted work (`paths.rs` in-progress spaces paste) — all work happens in the `.worktrees/fix-index-explosion` worktree off `main` (4b2a328).
- Test isolation must NOT alter `resolve(None)` behavior: migrate-vault tests swap `HOME` and assert default-index placement; the override therefore applies only to the `Some(v)` (custom vault) branch.

---

### Task 1: Default-vault normalization in `Paths::resolve`

**Files:**
- Modify: `crates/oximemo-core/src/paths.rs` (resolve `Some` branch + new `lexical_abs` helper + tests)

**Interfaces:**
- Produces: `fn lexical_abs(p: &Path) -> PathBuf` (private, paths.rs); `Paths::resolve(Some(<default vault path>))` now returns the same `index_dir` as `resolve(None)`.

- [x] **Step 1: Write the failing tests** (append to `mod tests` in paths.rs)

```rust
#[test]
fn explicit_default_vault_shares_top_level_index() {
    // The GUI watcher opens Vault::open(Some(<default vault>)) per fs
    // event; that must map to the SAME index the app reads via
    // open(None), or watcher reindexes land in an index nobody reads.
    let none = Paths::resolve(None);
    let explicit = Paths::resolve(Some(&default_vault_dir()));
    assert_eq!(explicit.index_dir, none.index_dir);
    assert_eq!(explicit.vault, none.vault);

    // Lexical variants of the same path must not fork a namespace.
    let trailing = PathBuf::from(format!("{}/", default_vault_dir().display()));
    assert_eq!(Paths::resolve(Some(&trailing)).index_dir, none.index_dir);
    let mut dotted = default_vault_dir();
    dotted.push(".");
    dotted.push("..");
    dotted.push("vault");
    assert_eq!(Paths::resolve(Some(&dotted)).index_dir, none.index_dir);
}

#[test]
fn custom_vaults_still_get_hash_namespaces() {
    let a = Paths::resolve(Some(Path::new("/tmp/some-other-vault")));
    let none = Paths::resolve(None);
    assert!(a.index_dir.ends_with(BY_VAULT_SUBDIR));
    assert_ne!(a.index_dir, none.index_dir);
    assert_eq!(a.vault, PathBuf::from("/tmp/some-other-vault"));
}
```

- [x] **Step 2: Run to verify RED**

Run: `cargo test -p oximemo-core --lib paths::tests::explicit_default_vault 2>&1 | tail -5`
Expected: FAIL — `explicit.index_dir` ends with `by-vault/<hash>` instead of the top-level `index`.

- [x] **Step 3: Implement**

```rust
/// Lexically absolutize and normalize `p` without touching the
/// filesystem: relative paths resolve against the CWD, `.` drops, and
/// `..` collapses against the previous component. Symlinks are NOT
/// resolved — both sides of the default-vault comparison derive from
/// the same `$HOME` string, so lexical equality is exact.
fn lexical_abs(p: &Path) -> PathBuf {
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(p)
    };
    let mut out = PathBuf::new();
    for c in abs.components() {
        match c {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}
```

In `resolve`, `Some(v)` branch (before namespace hashing):

```rust
Some(v) => {
    // An explicitly-passed default vault (the GUI watcher opens
    // `Some(paths().vault)` on every fs event) must share the
    // top-level index — a by-vault namespace here would fork the
    // index: watcher reindexes land where open(None) never reads.
    if lexical_abs(v) == lexical_abs(&default_vault_dir()) {
        let vault = default_vault_dir();
        return Self { vault, index_dir: support.join(INDEX_SUBDIR) };
    }
    // … existing namespace branch unchanged …
}
```

- [x] **Step 4: Run to verify GREEN** — `cargo test -p oximemo-core --lib paths::` all pass.

- [x] **Step 5: Commit** — `git commit -m "fix(core): explicit default vault maps to the top-level index"`

### Task 2: Test-only index-root override (leak channel closed)

**Files:**
- Modify: `crates/oximemo-core/src/paths.rs` (`TEST_INDEX_ROOT` OnceLock + `isolate_index_root_for_tests()` + `Some`-branch consult + `by_vault_root()` helper; wire `tmp_vault()` in vault.rs tests)

**Interfaces:**
- Produces:
  - `#[doc(hidden)] pub fn isolate_index_root_for_tests() -> PathBuf` — first call creates `std::env::temp_dir()/oximemo-test-index-<pid>` and wins; later calls return it.
  - `pub fn by_vault_root() -> PathBuf` — `app_support_dir()/index/by-vault` (honors the override the same way the `Some` branch does).
- Consumes: Task 4's GC scans `by_vault_root()`; Task 3/6 test helpers call `isolate_index_root_for_tests()`.

- [x] **Step 1: Failing test** (paths.rs tests)

```rust
#[test]
fn test_override_redirects_custom_vault_namespaces_only() {
    let root = isolate_index_root_for_tests();
    let custom = Paths::resolve(Some(Path::new("/tmp/leak-check-vault")));
    assert!(custom.index_dir.starts_with(&root), "custom namespace must land under the override root");
    // resolve(None) stays HOME-based: migrate tests swap HOME and rely on it.
    let none = Paths::resolve(None);
    assert!(!none.index_dir.starts_with(&root) || root == app_support_dir());
    assert!(none.index_dir.ends_with(INDEX_SUBDIR));
}
```

(Run in isolation this is meaningful; in the shared test binary the OnceLock is already set by whichever test ran first — the first assertion is the contract.)

- [x] **Step 2: Verify RED** — `isolate_index_root_for_tests` does not exist → compile error (acceptable RED for API-creation).

- [x] **Step 3: Implement**

```rust
/// Process-global override consulted ONLY by the custom-vault branch of
/// [`Paths::resolve`] (and [`by_vault_root`]). Test binaries call
/// [`isolate_index_root_for_tests`] once so `Vault::open(Some(temp))`
/// namespaces land under a per-process tempdir instead of the real
/// `~/Library/Application Support`. Production never sets it; the
/// `resolve(None)` branch is deliberately unaffected because
/// migrate-vault tests assert HOME-based default placement.
static TEST_INDEX_ROOT: OnceLock<PathBuf> = OnceLock::new();

/// # Test-only
/// Redirect custom-vault index namespaces into
/// `$TMPDIR/oximemo-test-index-<pid>`. Idempotent; first call wins.
#[doc(hidden)]
pub fn isolate_index_root_for_tests() -> PathBuf {
    TEST_INDEX_ROOT
        .get_or_init(|| {
            let root = std::env::temp_dir()
                .join(format!("oximemo-test-index-{}", std::process::id()));
            let _ = std::fs::create_dir_all(&root);
            root
        })
        .clone()
}

fn custom_index_support() -> PathBuf {
    TEST_INDEX_ROOT.get().cloned().unwrap_or_else(app_support_dir)
}

/// Root holding per-custom-vault index namespaces (`index/by-vault`).
/// GC target; honors the test override for the same reason resolve does.
pub fn by_vault_root() -> PathBuf {
    custom_index_support().join(INDEX_SUBDIR).join(BY_VAULT_SUBDIR)
}
```

`resolve`'s `Some` branch switches its support computation from `support` (app_support_dir) to `custom_index_support()` — including the normalized-default early return, which must still return the HOME-based top-level (it already does: `support` stays `app_support_dir()`). Wire `vault.rs` test helper `tmp_vault()`:

```rust
fn tmp_vault() -> (TempDir, Vault) {
    let _ = crate::paths::isolate_index_root_for_tests();
    let dir = TempDir::new().unwrap();
    let v = Vault::open(Some(dir.path())).unwrap();
    (dir, v)
}
```

- [x] **Step 4: Verify GREEN** — paths + vault tests pass.

- [x] **Step 5: Commit** — `git commit -m "test(core): isolate by-vault index namespaces from real Application Support"`

### Task 3: CLI + desktop test helpers adopt the isolation

**Files:**
- Modify: `crates/oximemo-cli/src/commands.rs` (`TmpVault::new` first line)
- Modify: `apps/desktop/src-tauri/src/lib.rs` tests (every `Vault::open(Some(...))` site), `copilot.rs` test at the tempdir-vault site

**Interfaces:** Consumes `oximemo_core::paths::isolate_index_root_for_tests`.

- [x] **Step 1:** Add `let _ = oximemo_core::paths::isolate_index_root_for_tests();` as the first line of `TmpVault::new()` and of each desktop test that constructs a tempdir vault (sites found by `grep 'Vault::open(Some' apps/desktop/src-tauri/src`).
- [x] **Step 2:** Run `cargo test -p oximemo-cli` and the desktop crate tests; both green.
- [x] **Step 3:** Commit — `git commit -m "test: stop CLI/desktop suites leaking index namespaces into real App Support"`

### Task 4: `Vault::gc_stale_namespaces`

**Files:**
- Modify: `crates/oximemo-core/src/vault.rs` (new pub method + tests)

**Interfaces:**
- Produces: `pub fn gc_stale_namespaces(&self, min_age: std::time::Duration) -> Result<u64>` — deleted-namespace count. A namespace `<by-vault>/<hash>` is deleted iff: its dir != `self.paths.index_dir`, its `meta.redb` mtime (dir mtime fallback) is older than `min_age`, and `lock::acquire(<ns>/meta.redb.lock, Exclusive, ZERO)` succeeds (in-flight guard, immediately released).

- [x] **Step 1: Failing tests** (vault.rs tests)

```rust
#[test]
fn gc_stale_namespaces_removes_only_old_unlocked_foreign_ones() {
    let _ = crate::paths::isolate_index_root_for_tests();
    let root = crate::paths::by_vault_root();
    std::fs::create_dir_all(&root).unwrap();

    let mk = |name: &str, age: Duration| {
        let d = root.join(name);
        std::fs::create_dir_all(&d).unwrap();
        let f = std::fs::File::create(d.join(crate::paths::META_DB_NAME)).unwrap();
        f.set_modified(SystemTime::now() - age).unwrap();
    };
    mk("stale", Duration::from_secs(2 * 3600));
    mk("fresh", Duration::from_secs(60));
    mk("locked", Duration::from_secs(2 * 3600));
    // Own namespace: fresh by construction (just resolved), must never be touched.

    let (_t, v) = tmp_vault();
    let guard = crate::lock::acquire(
        &root.join("locked").join(crate::paths::META_LOCK_NAME),
        LockKind::Exclusive,
        Duration::from_secs(1),
    )
    .unwrap();

    assert_eq!(v.gc_stale_namespaces(Duration::from_secs(3600)).unwrap(), 1);
    assert!(!root.join("stale").exists());
    assert!(root.join("fresh").exists());
    assert!(root.join("locked").exists(), "in-flight namespace must be skipped");

    drop(guard);
    assert_eq!(v.gc_stale_namespaces(Duration::from_secs(3600)).unwrap(), 1);
    assert!(!root.join("locked").exists());
}
```

- [x] **Step 2: Verify RED** — method missing, compile error.
- [x] **Step 3: Implement** — iterate `by_vault_root()`, skip `.`/`..` and `self.paths.index_dir` equality, mtime gate, `acquire(..., Exclusive, Duration::ZERO)` Ok→delete `remove_dir_all` (errors warn+continue), count.
- [x] **Step 4: Verify GREEN.**
- [x] **Step 5: Commit** — `git commit -m "feat(core): gc_stale_namespaces — age+flock-guarded sweep of by-vault index debris"`

### Task 5: `doctor` reports and fixes stale namespaces

**Files:**
- Modify: `crates/oximemo-core/src/vault.rs` (`doctor` + `DoctorReport` field)

**Interfaces:**
- Produces: `DoctorReport.stale_index_namespaces: u64` (count of namespaces stale by the 1-hour doctor threshold; when `fix`, they are removed and the count reports what was swept).

- [x] **Step 1: Failing test** — same fixture shape as Task 4; `doctor(false)` reports `stale_index_namespaces == 1`; `doctor(true)` removes it and re-report is 0.
- [x] **Step 2: Verify RED.**
- [x] **Step 3: Implement** — in `doctor`, before building the report: `let stale = self.gc_stale_namespaces_counted(Duration::from_secs(3600), fix)?;` (GC internals refactored so fix=false only counts). Field `#[serde(default)] pub stale_index_namespaces: u64`.
- [x] **Step 4: Verify GREEN** — plus `cargo test -p oximemo-cli` (doctor JSON still serializes).
- [x] **Step 5: Commit** — `git commit -m "feat(core): doctor reports and sweeps stale by-vault namespaces"`

### Task 6: GUI startup GC + CHANGELOG

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs` setup (after `ensure_initialized`/`migrate`)
- Modify: `CHANGELOG.md`

- [x] **Step 1:** In setup, spawn a detached thread holding an `Arc` clone of the vault:

```rust
// by-vault index GC: custom-vault namespaces idle >7 days are derived
// debris (one-off --vault opens, test leaks); sweep off the startup path.
{
    let v = vault.clone();
    std::thread::spawn(move || match v.gc_stale_namespaces(Duration::from_secs(7 * 24 * 3600)) {
        Ok(n) if n > 0 => tracing::info!(namespaces = n, "gc: removed stale by-vault index namespaces"),
        Ok(_) => {}
        Err(e) => tracing::warn!(error = %e, "gc: by-vault namespace sweep failed"),
    });
}
```

- [x] **Step 2:** `cargo test` desktop crate + `cargo clippy -D warnings` across the three crates.
- [x] **Step 3:** CHANGELOG entry under the existing unreleased section.
- [x] **Step 4: Commit** — `git commit -m "feat(desktop): sweep stale by-vault index namespaces on startup"`

### Task 7: End-to-end verification

- [x] Full suites: `cargo test -p oximemo-core -p oximemo-cli` + desktop crate tests; `cargo clippy --workspace --all-targets -- -D warnings` (worktree-scoped).
- [x] Leak proof: record `ls ~/Library/Application Support/com.oximemo.app/index/by-vault | wc -l` before and after the full test run — count must not grow.
- [x] Real-machine relief: `cargo run -p oximemo-cli -- doctor --fix` (min_age 1 h) against the real HOME; if the concurrent dev session's test debris is younger than 1 h, record the deferred cleanup instead of forcing deletion.
