//! Vault file watcher (§5.5).
//!
//! Watches the notes and trash trees. Events are coalesced through a debounce
//! window (default 300 ms) so a burst of writes from an editor's
//! swap-and-rename produces a single re-index call per path. The caller
//! supplies the per-path handler (the [`Vault`] re-indexes the file).

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crate::error::Result;

/// A callback invoked once a path has settled (debounced). The handler owns the
/// parse + re-index logic, including retries (§5.5).
pub type OnChange = Arc<dyn Fn(PathBuf) + Send + Sync>;

/// Holds the underlying watcher alive. Dropping stops watching.
pub struct MemoWatcher {
    _watcher: RecommendedWatcher,
}

impl MemoWatcher {
    /// Begin watching `roots` (recursively). Returns a handle that must be kept
    /// alive for the lifetime of the watch.
    pub fn spawn(roots: Vec<PathBuf>, debounce: Duration, on_change: OnChange) -> Result<Self> {
        let (tx, rx) = mpsc::channel::<PathBuf>();
        std::thread::spawn(move || debounce_loop(rx, debounce, on_change));

        let mut watcher =
            notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
                if let Ok(ev) = res {
                    // Ignore purely-access (open/close) chatter; only act on
                    // creation/modification/removal.
                    let relevant = matches!(
                        ev.kind,
                        EventKind::Create(_)
                            | EventKind::Modify(_)
                            | EventKind::Remove(_)
                            | EventKind::Any
                    );
                    if !relevant {
                        return;
                    }
                    for p in ev.paths {
                        if is_user_content(&p) {
                            let _ = tx.send(p);
                        }
                    }
                }
            })?;

        for root in &roots {
            if root.exists() {
                watcher.watch(root, RecursiveMode::Recursive)?;
            }
        }
        Ok(Self { _watcher: watcher })
    }
}

/// Coalesce events: a path fires only after `debounce` of quiet following its
/// last change. Repeated changes within the window reset its timer.
fn debounce_loop(rx: mpsc::Receiver<PathBuf>, debounce: Duration, on_change: OnChange) {
    let mut pending: HashMap<PathBuf, Instant> = HashMap::new();

    loop {
        let now = Instant::now();
        // Earliest due time across pending paths.
        let next_due = pending.values().copied().min();

        let timeout = match next_due {
            Some(due) if due > now => Some(due - now),
            _ => Some(Duration::from_millis(10)),
        };

        match rx.recv_timeout(timeout.unwrap_or(Duration::from_millis(10))) {
            Ok(path) => {
                pending.insert(path, Instant::now() + debounce);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // Fire any path whose debounce has elapsed.
                let now = Instant::now();
                let due: Vec<PathBuf> = pending
                    .iter()
                    .filter(|entry| *entry.1 <= now)
                    .map(|(p, _)| p.clone())
                    .collect();
                for p in due {
                    pending.remove(&p);
                    on_change(p);
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
}

/// Truth-half file extensions under version control: markdown notes
/// (`.md`), HTML notes (`.html`), and the vault config (`.toml`). Asset
/// files under `_assets/` are excluded by the watcher's root scope, so
/// arbitrary binary commits never land.
fn is_user_content(p: &Path) -> bool {
    matches!(
        p.extension().and_then(|e| e.to_str()),
        Some("md" | "html" | "markdown" | "htm")
    ) || p
        .file_name()
        .is_some_and(|n| n == "oximemo.toml")
}
