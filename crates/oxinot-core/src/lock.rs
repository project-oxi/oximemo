//! Process-local + cross-process advisory locking (§5.7).
//!
//! redb guarantees a single in-process writer but offers no protection between
//! processes (GUI + CLI sharing one `meta.redb`). We layer an `fs2` flock on a
//! dedicated lock file:
//!
//! - **shared** for reads (multiple readers allowed),
//! - **exclusive** for writes (mutates the index).
//!
//! The memo files themselves are never locked — atomic rename keeps them safe,
//! and external editors/agents may read and write them freely.

use std::fs::{File, OpenOptions};
use std::path::Path;
use std::time::Duration;

use fs2::FileExt;

use crate::error::{CoreError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockKind {
    Shared,
    Exclusive,
}

/// A held advisory lock. Dropping it releases the flock.
pub struct FileLock {
    file: File,
    kind: LockKind,
}

impl FileLock {
    fn acquire(path: &Path, kind: LockKind, timeout: Duration) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(path)?;

        let deadline = std::time::Instant::now() + timeout;
        loop {
            let acquired = match kind {
                LockKind::Shared => file.try_lock_shared().is_ok(),
                LockKind::Exclusive => file.try_lock_exclusive().is_ok(),
            };
            if acquired {
                return Ok(Self { file, kind });
            }
            // Contended (another process holds the lock); retry until deadline.
            if std::time::Instant::now() >= deadline {
                let secs = timeout.as_secs();
                tracing::warn!(lock = %path.display(), "lock acquire timed out");
                return Err(CoreError::LockTimeout(secs.max(1)));
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    pub fn kind(&self) -> LockKind {
        self.kind
    }
}

impl Drop for FileLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

/// Open (creating if needed) and hold a lock file. `timeout` caps contention
/// waits; default policy in callers is 5s (§5.7).
pub fn acquire(path: &Path, kind: LockKind, timeout: Duration) -> Result<FileLock> {
    FileLock::acquire(path, kind, timeout)
}

/// Probe whether an *exclusive* lock is currently held by some process. Used by
/// `oxinot doctor` to report lock contention without blocking.
pub fn is_locked(path: &Path) -> bool {
    let Ok(file) = OpenOptions::new()
        .read(true)
        .write(true)
        .create(false)
        .open(path)
    else {
        return false;
    };
    file.try_lock_exclusive().is_err()
}
