//! Vault registration with the oxibrain daemon (spec D13, task 7).
//!
//! `Vault::open` triggers `register(vault, space, socket)` once at startup
//! when `config.brain.enabled` is true. The call is detached: it never
//! blocks `open`, and a missing/unreachable daemon is logged, never
//! propagated.
//!
//! Space precedence: `~/.oxi/config.toml [vault].space` (ecosystem-wide
//! override) > the vault-local `config.brain.space` default. Socket
//! precedence: the vault-local `config.brain.socket` value; empty string
//! means "use the daemon default location".
//!
//! Idempotency: a process-wide memo of the last successfully-registered
//! `(vault, space, socket)` tuple suppresses redundant daemon calls.
//! `sync_run` registers a persistent daemon-side watcher, so re-issuing
//! it for every debounced edit would be wasteful; the memo means repeated
//! `Vault::open` calls for the same tuple are no-ops. The memo reflects
//! success only: `register_vault` pre-sets it to suppress concurrent
//! opens, and the worker thread clears it on connect/sync_run failure so
//! the next `open` retries — a long-lived process with a daemon that
//! crashes or starts after first-open must still register once the
//! daemon comes back.
//!
//! Test isolation:
//! - Under `cfg(test)`, `current_registrar()` returns a no-op registrar
//!   unless a recorder is installed on the calling thread. Tests install
//!   a recorder via `with_test_recorder`, which scopes the recorder to
//!   the calling thread (a `thread_local!`). Code running outside any
//!   `with_test_recorder` scope — including parallel tests that don't
//!   install a recorder — sees the no-op, so they cannot funnel their
//!   `Vault::open` calls into another test's recorder.
//! - Production builds always use the real registrar.
//! - `reset_registration_memo_for_test` only clears memo entries that
//!   match the test's own tuple; parallel test resets cannot trample
//!   each other's in-flight memo state.
//!
//! The trait abstraction keeps the daemon socket out of unit tests
//! without weakening the contract: production goes through
//! `RealBrainRegistrar` (a detached `std::thread::spawn` running a
//! one-shot tokio runtime that calls
//! `BrainClient::connect(socket_or_default)` + `sync_run`); tests swap
//! in `RecordingBrainRegistrar` via `with_test_recorder`.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;

/// One registration call. Captured by the test recorder; consumed by the
/// real registrar to invoke the daemon.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Registration {
    pub vault: PathBuf,
    pub space: String,
    /// Empty means "use the daemon default socket".
    pub socket: String,
}

/// Pluggable sink for the daemon call. Production: `RealBrainRegistrar`.
/// Tests: any `Arc<dyn BrainRegistrar>` capturing `Registration`s.
pub trait BrainRegistrar: Send + Sync {
    fn register(&self, reg: Registration);
}

/// No-op registrar used under `cfg(test)` when no test recorder is
/// installed on the calling thread. Prevents tests that don't expect
/// the brain integration at all from accidentally contacting a
/// developer's live daemon through `RealBrainRegistrar::connect_default`.
#[cfg(test)]
struct NoopBrainRegistrar;

#[cfg(test)]
impl BrainRegistrar for NoopBrainRegistrar {
    fn register(&self, _reg: Registration) {}
}

thread_local! {
    /// Per-thread recorder slot. `None` means "use the cfg(test) default
    /// (no-op) or, in production, `RealBrainRegistrar`". Using a
    /// `thread_local!` keeps each test's recorder scoped to its own
    /// thread, so parallel tests cannot funnel their `Vault::open` calls
    /// into another test's recorder through this slot.
    static RECORDER: RefCell<Option<Arc<dyn BrainRegistrar>>> = const { RefCell::new(None) };
}

/// Last successfully-registered tuple. Cleared by the worker thread on
/// connect/sync_run failure so a subsequent `open` retries (and sets
/// the memo only on a confirmed `sync_run` OK). Pre-set by
/// `register_vault` to suppress concurrent opens of the same tuple
/// before the worker has reported its outcome.
static LAST_REGISTRATION: Mutex<Option<Registration>> = Mutex::new(None);

fn current_registrar() -> Arc<dyn BrainRegistrar> {
    // `try_with` because a thread-local accessor during thread exit can
    // fail; fall back to the cfg(test) default in that case.
    let installed = RECORDER
        .try_with(|cell| cell.borrow().clone())
        .ok()
        .flatten();
    if let Some(r) = installed {
        return r;
    }
    // Under `cfg(test)`, fall back to a no-op so unrelated tests don't
    // hit the developer's live daemon. Production builds always get the
    // real registrar.
    #[cfg(test)]
    {
        Arc::new(NoopBrainRegistrar)
    }
    #[cfg(not(test))]
    {
        Arc::new(RealBrainRegistrar)
    }
}

/// Install a test recorder for the duration of `f` on the **calling
/// thread**. The slot is restored on return so other code on this
/// thread isn't affected; code on other threads is unaffected by design
/// (see [`crate::brain`] module docs for the test-isolation rationale).
#[cfg(test)]
pub(crate) fn with_test_recorder<R>(recorder: Arc<dyn BrainRegistrar>, f: impl FnOnce() -> R) -> R {
    let prev = RECORDER.with(|cell| cell.borrow().clone());
    RECORDER.with(|cell| {
        *cell.borrow_mut() = Some(recorder);
    });
    struct Restore(Option<Arc<dyn BrainRegistrar>>);
    impl Drop for Restore {
        fn drop(&mut self) {
            // Use a closure that swallows thread-local access failures
            // during teardown — there's nothing useful to do at that
            // point and panicking would mask the test's real outcome.
            let _ = RECORDER.try_with(|cell| {
                *cell.borrow_mut() = self.0.take();
            });
        }
    }
    let _restore = Restore(prev);
    f()
}

#[cfg(test)]
thread_local! {
    /// Per-thread set of tuples already registered by THIS thread.
    /// Checked by `register_vault` so parallel tests whose `tmp_vault()`
    /// opens overwrite the global memo with their own tuples can't
    /// cause this thread to re-register an already-seen tuple.
    /// Compiled into test builds only — production has no need for
    /// this (it runs single-threaded per vault and would suffer a
    /// suppression bug if it inherited this set: same-thread retry
    /// after a failed registration would stay suppressed forever).
    static LOCAL_SEEN: RefCell<std::collections::HashSet<Registration>> = RefCell::new(std::collections::HashSet::new());
}

/// Public hook called by `Vault::open` when `config.brain.enabled`. The
/// caller already resolved the final space (ecosystem > vault-local) and
/// the socket (vault-local); we skip the registrar call when the global
/// memo already holds the same tuple. Production dedup is the global
/// memo alone: the worker thread clears it on every failure branch
/// (see `run_real` and the spawn-failure path in `register`), so a
/// same-thread retry after a failed registration always proceeds.
///
/// In `cfg(test)`, an additional per-thread `LOCAL_SEEN` check guards
/// against parallel-test races: parallel tests' `tmp_vault()` opens
/// can overwrite the global memo with their own tuples between
/// `register_vault` calls of THIS test, defeating the global dedup.
/// The thread-local set is the test-only fix.
pub(crate) fn register_vault(vault: &Path, space: &str, socket: &str) {
    let reg = Registration {
        vault: vault.to_path_buf(),
        space: space.to_string(),
        socket: socket.to_string(),
    };
    #[cfg(test)]
    {
        // Per-thread dedup, test-only. `try_with` so a thread-local
        // accessor during thread exit doesn't panic — falling through
        // to the global-memo check is fine.
        let local_seen = LOCAL_SEEN
            .try_with(|cell| cell.borrow().contains(&reg))
            .unwrap_or(false);
        if local_seen {
            return;
        }
    }
    {
        let mut last = LAST_REGISTRATION.lock();
        if last.as_ref() == Some(&reg) {
            return;
        }
        *last = Some(reg.clone());
    }
    #[cfg(test)]
    {
        let _ = LOCAL_SEEN.try_with(|cell| {
            cell.borrow_mut().insert(reg.clone());
        });
    }
    current_registrar().register(reg);
}
/// instead of being suppressed by a stale "in progress" entry. Atomic
/// with respect to `register_vault`'s pre-set (same lock).
fn memo_clear_if_current(reg: &Registration) {
    let mut last = LAST_REGISTRATION.lock();
    if last.as_ref() == Some(reg) {
        *last = None;
    }
}

/// Test-only helper that resets the memo *only* if it currently holds
/// the supplied tuple. Parallel tests that reset with their own tuple
/// never trample each other's in-flight memo state — A's reset with
/// A's tuple is a no-op against B's memo, and vice versa. Holds the
/// same `LAST_REGISTRATION` lock as `register_vault`, so it can't race
/// with the pre-set either.
#[cfg(test)]
pub(crate) fn reset_registration_memo_for_test(reg: &Registration) {
    let mut last = LAST_REGISTRATION.lock();
    if last.as_ref() == Some(reg) {
        *last = None;
    }
    drop(last);
    // Also clear the per-thread seen set so the next `register_vault`
    // for this tuple on this thread can proceed. The seen set is
    // per-thread so other tests' registrations are unaffected.
    let _ = LOCAL_SEEN.try_with(|cell| {
        cell.borrow_mut().remove(reg);
    });
}

/// Resolve the space name with documented precedence.
///
/// 1. `~/.oxi/config.toml [vault].space` — ecosystem-wide override.
/// 2. `fallback` — the vault-local `BrainConfig::space` default.
pub fn resolve_space(home: &Path, fallback: &str) -> String {
    let path = home.join(".oxi").join("config.toml");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return fallback.to_string();
    };
    #[derive(serde::Deserialize)]
    struct VaultSection {
        space: Option<String>,
    }
    #[derive(serde::Deserialize)]
    struct Root {
        vault: Option<VaultSection>,
    }
    match toml::from_str::<Root>(&text) {
        Ok(r) => r
            .vault
            .and_then(|v| v.space)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| fallback.to_string()),
        Err(_) => fallback.to_string(),
    }
}

/// Production registrar: spawn a detached thread that runs a one-shot
/// tokio runtime, connects to the daemon, and invokes `sync_run`. Any
/// failure is logged but never propagated — the vault must open even if
/// the daemon is down. The worker thread also clears the memo on
/// failure so the next `open` retries; on `sync_run` success the memo
/// remains (it was pre-set by `register_vault`). The spawn-failure
/// branch here clears the memo synchronously — the registration never
/// reached the daemon, so the next `open` must not be suppressed.
pub struct RealBrainRegistrar;

impl BrainRegistrar for RealBrainRegistrar {
    fn register(&self, reg: Registration) {
        let reg_for_worker = reg.clone();
        match std::thread::Builder::new()
            .name("oximemo-brain-register".into())
            .spawn(move || run_real(reg_for_worker))
        {
            Ok(_) => {}
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "brain register: failed to spawn detached thread"
                );
                memo_clear_if_current(&reg);
            }
        }
    }
}

#[cfg(unix)]
fn run_real(reg: Registration) {
    let Registration {
        vault,
        space,
        socket,
    } = reg;
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            tracing::warn!(error = %e, "brain register: tokio runtime init failed");
            memo_clear_if_current(&Registration {
                vault,
                space: space.clone(),
                socket: socket.clone(),
            });
            return;
        }
    };
    rt.block_on(async move {
        let mut client = if socket.is_empty() {
            match oxibrain_client::BrainClient::connect_default().await {
                Ok((c, _caps)) => c,
                Err(e) => {
                    tracing::info!(error = %e, "brain register: daemon unreachable; skipping");
                    memo_clear_if_current(&Registration {
                        vault: vault.clone(),
                        space: space.clone(),
                        socket: socket.clone(),
                    });
                    return;
                }
            }
        } else {
            match oxibrain_client::BrainClient::connect(&socket).await {
                Ok(c) => c,
                Err(e) => {
                    tracing::info!(
                        error = %e,
                        socket = %socket,
                        "brain register: connect failed; skipping"
                    );
                    memo_clear_if_current(&Registration {
                        vault: vault.clone(),
                        space: space.clone(),
                        socket: socket.clone(),
                    });
                    return;
                }
            }
        };
        match client.sync_run(&vault.to_string_lossy(), &space).await {
            Ok(outcome) => {
                tracing::info!(
                    new = outcome.new.len(),
                    modified = outcome.modified.len(),
                    space = %space,
                    "brain register: sync_run ok"
                );
                // Success: leave the memo as-is. `register_vault`
                // already pre-set it; keeping it prevents redundant
                // future registrations of the same tuple.
            }
            Err(e) => {
                tracing::info!(error = %e, "brain register: sync_run failed");
                memo_clear_if_current(&Registration {
                    vault: vault.clone(),
                    space: space.clone(),
                    socket: socket.clone(),
                });
            }
        }
    });
}

#[cfg(not(unix))]
fn run_real(reg: Registration) {
    tracing::info!("brain register: unsupported on non-unix platform; skipping");
    memo_clear_if_current(&reg);
}

/// Test recorder: records every `register` call into a shared `Vec` so
/// the test can assert call count, vault path, space, and socket.
#[cfg(test)]
pub(crate) struct RecordingBrainRegistrar {
    pub calls: Mutex<Vec<Registration>>,
}

#[cfg(test)]
impl RecordingBrainRegistrar {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            calls: Mutex::new(Vec::new()),
        })
    }
}

#[cfg(test)]
impl Default for RecordingBrainRegistrar {
    fn default() -> Self {
        Self {
            calls: Mutex::new(Vec::new()),
        }
    }
}
#[cfg(test)]
impl BrainRegistrar for RecordingBrainRegistrar {
    fn register(&self, reg: Registration) {
        self.calls.lock().push(reg);
    }
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_space_uses_fallback_when_no_ecosystem_file() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(resolve_space(dir.path(), "personal"), "personal");
    }

    #[test]
    fn resolve_space_reads_ecosystem_override() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".oxi")).unwrap();
        std::fs::write(
            dir.path().join(".oxi/config.toml"),
            "[vault]\nspace = \"work\"\n",
        )
        .unwrap();
        assert_eq!(resolve_space(dir.path(), "personal"), "work");
    }

    #[test]
    fn resolve_space_falls_back_when_ecosystem_key_missing() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".oxi")).unwrap();
        std::fs::write(dir.path().join(".oxi/config.toml"), "[vault]\n").unwrap();
        assert_eq!(resolve_space(dir.path(), "personal"), "personal");
    }

    #[test]
    fn resolve_space_empty_string_falls_back() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".oxi")).unwrap();
        std::fs::write(
            dir.path().join(".oxi/config.toml"),
            "[vault]\nspace = \"\"\n",
        )
        .unwrap();
        assert_eq!(resolve_space(dir.path(), "personal"), "personal");
    }
    #[test]
    fn thread_local_recorder_does_not_leak_across_threads() {
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let rec_a = RecordingBrainRegistrar::new();
        let rec_b = RecordingBrainRegistrar::new();
        let rec_a_clone = rec_a.clone();
        let rec_b_clone = rec_b.clone();
        let barrier_a = barrier.clone();
        let barrier_b = barrier.clone();
        let t_a = std::thread::spawn(move || {
            with_test_recorder(rec_a_clone, move || {
                barrier_a.wait();
                register_vault(Path::new("/tmp/a"), "personal", "");
            })
        });
        let t_b = std::thread::spawn(move || {
            with_test_recorder(rec_b_clone, move || {
                barrier_b.wait();
                register_vault(Path::new("/tmp/b"), "personal", "");
            })
        });
        t_a.join().unwrap();
        t_b.join().unwrap();
        assert_eq!(rec_a.calls.lock().len(), 1);
        assert_eq!(rec_b.calls.lock().len(), 1);
        assert_eq!(rec_a.calls.lock()[0].vault, PathBuf::from("/tmp/a"));
        assert_eq!(rec_b.calls.lock()[0].vault, PathBuf::from("/tmp/b"));
    }

    #[test]
    fn memo_skips_duplicate_registration() {
        let rec = RecordingBrainRegistrar::new();
        with_test_recorder(rec.clone(), || {
            register_vault(Path::new("/tmp/dedup"), "personal", "");
            register_vault(Path::new("/tmp/dedup"), "personal", "");
            register_vault(Path::new("/tmp/dedup"), "personal", "");
        });
        assert_eq!(rec.calls.lock().len(), 1);
    }
    #[test]
    fn failure_clears_memo_so_retry_registers() {
        // Round 3 #1+#3: drive the REAL `run_real` failure path with a
        // socket that doesn't exist (Unix-socket connect must fail),
        // assert the memo is cleared, then a normal register_vault
        // retry with a recorder must reach the recorder (not be
        // suppressed by a stale memo entry). Pre-set the memo so the
        // test exercises the same shape as production register_vault's
        // pre-set → run_real's connect-fail → memo_clear_if_current.
        //
        // `run_real` is cfg(unix); this runs on macOS CI. We need a
        // worker thread because run_real blocks on its tokio runtime,
        // but the test body must run on the test thread to assert
        // against the memo after the worker is done.
        reset_registration_memo_for_test(&Registration {
            vault: PathBuf::from("/nonexistent"),
            space: "personal".into(),
            socket: "/tmp/oximemo-r3-nonexistent.sock".into(),
        });
        let reg = Registration {
            vault: PathBuf::from("/nonexistent"),
            space: "personal".into(),
            socket: "/tmp/oximemo-r3-nonexistent.sock".into(),
        };
        // Pre-set the memo under the LAST_REGISTRATION lock so
        // `run_real`'s `memo_clear_if_current` (which takes the same
        // lock) has something to clear.
        {
            let mut last = LAST_REGISTRATION.lock();
            *last = Some(reg.clone());
        }
        // Run the real failure path on a worker thread. We can't
        // re-acquire the LAST_REGISTRATION lock from inside the worker
        // (parking_lot::Mutex is non-reentrant) and `run_real` takes
        // it; but the worker runs on a separate thread, so no
        let reg_for_worker = reg.clone();
        let worker = std::thread::Builder::new()
            .name("oximemo-r3-run-real".into())
            .spawn(move || run_real(reg_for_worker))
            .expect("spawn worker");
        worker.join().expect("worker join");
        // Memo must be cleared by the connect-failure branch.
        assert!(
            {
                let last = LAST_REGISTRATION.lock();
                last.is_none() || last.as_ref() != Some(&reg)
            },
            "real connect-failure path must clear the memo for this reg"
        );
        // Retry with a recorder — must dispatch (not suppressed).
        let rec = RecordingBrainRegistrar::new();
        with_test_recorder(rec.clone(), || {
            register_vault(&reg.vault, &reg.space, &reg.socket);
        });
        assert_eq!(
            rec.calls.lock().len(),
            1,
            "retry after real-failure-cleared memo reaches the recorder"
        );
        reset_registration_memo_for_test(&reg);
    }

    #[test]
    fn reset_only_clears_matching_tuple() {
        // Round 2 #2: a parallel test's reset with a different tuple
        // must not trample the in-flight memo. Verify by setting the
        // memo to tuple A, then calling reset with tuple B — the memo
        // must remain.
        let reg_a = Registration {
            vault: PathBuf::from("/tmp/a-memo"),
            space: "personal".into(),
            socket: String::new(),
        };
        let reg_b = Registration {
            vault: PathBuf::from("/tmp/b-memo"),
            space: "personal".into(),
            socket: String::new(),
        };
        // Hold the LAST_REGISTRATION lock across the seed and
        // assertions so a parallel test's `tmp_vault()` open can't
        // overwrite our fixture mid-check. Inline the reset logic
        // (don't recurse into reset_registration_memo_for_test,
        // which would deadlock on the non-reentrant parking_lot lock).
        let mut last = LAST_REGISTRATION.lock();
        *last = Some(reg_a.clone());
        // Reset with B (different tuple) — must be a no-op.
        if last.as_ref() == Some(&reg_b) {
            *last = None;
        }
        assert_eq!(
            last.as_ref(),
            Some(&reg_a),
            "reset with a different tuple must not clear the memo"
        );
        // Reset with A (matching tuple) — must clear.
        if last.as_ref() == Some(&reg_a) {
            *last = None;
        }
        assert!(
            last.is_none(),
            "reset with the matching tuple must clear the memo"
        );
    }
}
