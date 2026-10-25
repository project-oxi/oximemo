//! Quick capture owns its feedback and returns focus to the interrupted app.
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::AppState;

const RECEIPT_IDLE: Duration = Duration::from_secs(5);

#[derive(Default)]
pub(crate) struct Session {
    generation: u64,
    previous_pid: Option<i32>,
    receipt: Option<String>,
    deadline: Option<Instant>,
    shortcut_registered: bool,
    closing: bool,
}

impl Session {
    pub(crate) fn has_receipt(&self) -> bool {
        self.receipt.is_some()
    }

    pub(crate) fn is_closing(&self) -> bool {
        self.closing
    }

    fn can_finish_dismissal(&self, generation: u64) -> bool {
        self.closing && self.generation == generation
    }

    fn finish(&mut self, generation: u64, id: String) -> bool {
        if self.generation != generation || self.receipt.is_some() || self.closing {
            return false;
        }
        self.receipt = Some(id);
        self.deadline = Some(Instant::now() + RECEIPT_IDLE);
        true
    }

    fn expired(&self, generation: u64, now: Instant) -> bool {
        self.generation == generation
            && self.has_receipt()
            && self.deadline.is_some_and(|deadline| now >= deadline)
    }
}

fn open_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::SUPER), Code::Enter)
}

fn release_shortcut(app: &AppHandle) {
    let registered = {
        let state = app.state::<AppState>();
        std::mem::take(&mut state.capture_session.lock().shortcut_registered)
    };
    if registered && let Err(error) = app.global_shortcut().unregister(open_shortcut()) {
        tracing::warn!(%error, "capture: could not release open shortcut");
    }
}

pub(crate) fn begin(app: &AppHandle) -> u64 {
    release_shortcut(app);
    let state = app.state::<AppState>();
    let mut session = state.capture_session.lock();
    session.generation += 1;
    session.previous_pid = previous_app_pid().or(session.previous_pid);
    session.receipt = None;
    session.deadline = None;
    session.closing = false;
    session.generation
}

pub(crate) fn dismiss(app: &AppHandle, generation: Option<u64>, restore: bool) {
    let (previous, closing_generation) = {
        let state = app.state::<AppState>();
        let mut session = state.capture_session.lock();
        if session.closing || generation.is_some_and(|generation| generation != session.generation)
        {
            return;
        }
        session.generation += 1;
        session.receipt = None;
        session.deadline = None;
        session.closing = true;
        (session.previous_pid.take(), session.generation)
    };
    release_shortcut(app);
    app.state::<AppState>()
        .capture_focused
        .store(false, std::sync::atomic::Ordering::Relaxed);
    let _ = app.emit("capture:closing", closing_generation);
    if restore {
        restore_previous_app(previous);
    }
    // The renderer acknowledges its exit animation. A fallback still parks
    // the native window if that renderer is unresponsive or has been reloaded.
    let timer_app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
        let app = timer_app.clone();
        let _ = timer_app.run_on_main_thread(move || {
            finish_capture_dismissal(app, closing_generation);
        });
    });
}

#[tauri::command]
pub(crate) fn finish_capture_dismissal(app: AppHandle, generation: u64) {
    {
        let state = app.state::<AppState>();
        let mut session = state.capture_session.lock();
        if !session.can_finish_dismissal(generation) {
            return;
        }
        session.closing = false;
    }
    if let Some(window) = app.get_webview_window("capture") {
        let _ = window.hide();
    }
    let _ = app.emit("capture:hide", ());
}

#[tauri::command]
pub(crate) fn dismiss_capture(app: AppHandle, generation: u64) {
    dismiss(&app, Some(generation), true);
}

/// Display feedback in the existing window. No show/focus call is needed:
/// keeping the window visible avoids briefly activating the main window.
#[tauri::command]
pub(crate) fn complete_capture(app: AppHandle, generation: u64, id: String) -> bool {
    let previous = {
        let state = app.state::<AppState>();
        let mut session = state.capture_session.lock();
        if !session.finish(generation, id) {
            return false;
        }
        session.previous_pid
    };
    let registered = app
        .global_shortcut()
        .on_shortcut(open_shortcut(), |app, _, event| {
            if event.state() == ShortcutState::Pressed {
                let app_copy = app.clone();
                let _ = app.run_on_main_thread(move || open_latest(&app_copy));
            }
        });
    let shortcut_registered = registered.is_ok();
    if let Err(error) = registered {
        tracing::warn!(%error, "capture: open shortcut unavailable");
    }
    app.state::<AppState>()
        .capture_session
        .lock()
        .shortcut_registered = shortcut_registered;
    restore_previous_app(previous);

    let timer_app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(250)).await;
            let (current, expired) = {
                let state = timer_app.state::<AppState>();
                let session = state.capture_session.lock();
                (
                    session.generation == generation,
                    session.expired(generation, Instant::now()),
                )
            };
            if !current {
                break;
            }
            if expired {
                let app = timer_app.clone();
                let _ = timer_app.run_on_main_thread(move || {
                    // A hover or a new capture may have arrived while queued.
                    let expired = app
                        .state::<AppState>()
                        .capture_session
                        .lock()
                        .expired(generation, Instant::now());
                    if expired {
                        dismiss(&app, Some(generation), true);
                    }
                });
            }
        }
    });
    shortcut_registered
}

#[tauri::command]
pub(crate) fn hold_capture_receipt(app: AppHandle, generation: u64, hold: bool) {
    let state = app.state::<AppState>();
    let mut session = state.capture_session.lock();
    if session.generation == generation && session.has_receipt() {
        session.deadline = (!hold).then(|| Instant::now() + RECEIPT_IDLE);
    }
}

fn open_latest(app: &AppHandle) {
    let generation = app.state::<AppState>().capture_session.lock().generation;
    open_captured_note(app.clone(), generation);
}

#[tauri::command]
pub(crate) fn open_captured_note(app: AppHandle, generation: u64) {
    let id = {
        let state = app.state::<AppState>();
        let session = state.capture_session.lock();
        if session.generation != generation {
            return;
        }
        session.receipt.clone()
    };
    let Some(id) = id else { return };
    dismiss(&app, Some(generation), false);
    let _ = app.emit_to("main", "capture:open-note", id);
    crate::show_main_window(&app);
}

#[cfg(target_os = "macos")]
fn previous_app_pid() -> Option<i32> {
    let app = objc2_app_kit::NSWorkspace::sharedWorkspace().frontmostApplication()?;
    let pid = app.processIdentifier();
    (pid != std::process::id() as i32).then_some(pid)
}

#[cfg(target_os = "macos")]
fn restore_previous_app(pid: Option<i32>) {
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};
    let current = NSRunningApplication::currentApplication();
    // Never steal focus if the user switched apps while the save was pending.
    if current.isActive()
        && let Some(previous) =
            pid.and_then(NSRunningApplication::runningApplicationWithProcessIdentifier)
    {
        previous.activateWithOptions(NSApplicationActivationOptions::empty());
    }
}

#[cfg(not(target_os = "macos"))]
fn previous_app_pid() -> Option<i32> {
    None
}

#[cfg(not(target_os = "macos"))]
fn restore_previous_app(_pid: Option<i32>) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn late_save_cannot_replace_new_capture_or_duplicate_receipt() {
        let mut session = Session {
            generation: 4,
            ..Session::default()
        };
        assert!(!session.finish(3, "old".into()));
        assert!(!session.has_receipt());
        assert!(session.finish(4, "new".into()));
        assert!(!session.finish(4, "duplicate".into()));
        assert_eq!(session.receipt.as_deref(), Some("new"));
    }

    #[test]
    fn receipt_expires_only_in_its_session_and_while_idle() {
        let mut session = Session {
            generation: 4,
            ..Session::default()
        };
        session.finish(4, "note".into());
        let deadline = session.deadline.unwrap();
        assert!(!session.expired(4, deadline - Duration::from_millis(1)));
        assert!(session.expired(4, deadline));
        assert!(!session.expired(5, deadline));
        session.deadline = None;
        assert!(!session.expired(4, deadline + RECEIPT_IDLE));
    }

    #[test]
    fn late_exit_acknowledgement_cannot_hide_a_reopened_capture() {
        let mut session = Session {
            generation: 4,
            closing: true,
            ..Session::default()
        };
        assert!(session.can_finish_dismissal(4));
        assert!(!session.finish(4, "late save".into()));
        session.generation = 5;
        session.closing = false;
        assert!(!session.can_finish_dismissal(4));
        assert!(!session.can_finish_dismissal(5));
        assert!(session.finish(5, "new capture".into()));
    }
}
