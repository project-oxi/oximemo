//! oxinot desktop backend — Tauri 2.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, LogicalPosition, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

pub struct AppState {
    pub vault: Arc<oxinot_core::Vault>,
    pub capture_monitor: Mutex<Option<oxinot_capture::CaptureMonitor>>,
    pub watcher: Mutex<Option<oxinot_core::watcher::NoteWatcher>>,
}

impl AppState {
    fn new(vault: oxinot_core::Vault) -> Self {
        Self {
            vault: Arc::new(vault),
            capture_monitor: Mutex::new(None),
            watcher: Mutex::new(None),
        }
    }
}

pub fn run() {
    init_tracing();

    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let cli_vault = std::env::var("OXINOT_VAULT")
                .ok()
                .map(PathBuf::from)
                .or_else(parse_vault_arg);
            let vault = oxinot_core::Vault::open(cli_vault.as_deref())?;
            vault.ensure_initialized()?;
            app.manage(AppState::new(vault));
            let wstate = app.state::<AppState>();
            spawn_watcher(&wstate, app.handle());

            let handle = app.handle().clone();
            app.global_shortcut()
                .on_shortcut(default_shortcut(), move |_app, _sc, event| {
                    if event.state() == ShortcutState::Pressed {
                        show_capture(&handle);
                    }
                })?;

            let capture_state = app.state::<AppState>();
            let monitor = oxinot_capture::CaptureMonitor::start(
                capture_state.vault.config().capture.double_tap_threshold_ms,
                Box::new({
                    let h = app.handle().clone();
                    move || show_capture(&h)
                }),
            );
            if let Ok(m) = monitor {
                *capture_state.capture_monitor.lock() = Some(m);
            } else {
                tracing::info!("option double-tap monitor not available; using global shortcut");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_notes,
            commands::get_note,
            commands::create_note,
            commands::update_note,
            commands::delete_note,
            commands::search_notes,
            commands::export_manifest,
            commands::reindex,
            commands::doctor,
            commands::vault_path,
            commands::note_stats,
        ])
        .run(tauri::generate_context!())
        .expect("error while running oxinot desktop app");
}

fn parse_vault_arg() -> Option<PathBuf> {
    let mut args = std::env::args_os().skip(1);
    while let Some(a) = args.next() {
        if a == "--vault" {
            return args.next().map(PathBuf::from);
        }
    }
    None
}

fn default_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyN)
}

/// Start the vault file watcher (§5.5, §7.4). On each settled change it
/// re-indexes the file and broadcasts `notes:changed` so every window can
/// refresh its query cache. The handle lives in `AppState` for the app
/// lifetime — dropping it would stop watching.
fn spawn_watcher(state: &AppState, handle: &AppHandle) {
    let vault_path = state.vault.paths().vault.clone();
    let debounce =
        Duration::from_millis(state.vault.config().index.watcher_debounce_ms as u64);
    let emit_handle = handle.clone();
    let on_change: oxinot_core::watcher::OnChange = Arc::new(move |path| {
        if let Ok(v) = oxinot_core::Vault::open(Some(&vault_path)) {
            v.reindex_path(&path);
        }
        let _ = emit_handle.emit("notes:changed", ());
    });
    match oxinot_core::watcher::NoteWatcher::spawn(
        vec![
            state.vault.paths().notes_root(),
            state.vault.paths().trash_root(),
        ],
        debounce,
        on_change,
    ) {
        Ok(w) => *state.watcher.lock() = Some(w),
        Err(e) => tracing::warn!(error = %e, "vault watcher failed to start"),
    }
}
fn show_capture(handle: &AppHandle) {
    let Some(win) = handle.get_webview_window("capture") else {
        return;
    };
    if let Ok(mouse) = handle.cursor_position() {
        let _ = win.set_position(LogicalPosition::new(mouse.x - 280.0, 80.0));
    }
    let _ = win.show();
    let _ = win.set_focus();
    let _ = handle.emit("capture:show", ());
}

fn init_tracing() {
    use tracing_subscriber::EnvFilter;
    let _ = tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .try_init();
}

mod commands {
    use oxinot_core::note::{Cursor, NoteFilter, NoteId};
    use oxinot_core::sync::ManifestRecord;
    use tauri::{AppHandle, Emitter, State};
    use time::format_description::well_known::Rfc3339;

    use super::AppState;

    #[tauri::command]
    pub fn list_notes(
        state: State<'_, AppState>,
        after: Option<String>,
        limit: u32,
        tag: Option<String>,
        pinned_only: bool,
    ) -> Result<oxinot_core::Page<oxinot_core::NoteSummary>, String> {
        let after = match after {
            Some(s) => Some(Cursor::parse(&s).map_err(|e| e.to_string())?),
            None => None,
        };
        let filter = NoteFilter {
            tag,
            pinned_only,
            include_deleted: false,
        };
        state
            .vault
            .list_notes(after, limit, filter)
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn get_note(state: State<'_, AppState>, id: String) -> Result<oxinot_core::Note, String> {
        let id = NoteId::parse(&id).map_err(|e| e.to_string())?;
        state.vault.get_note(id).map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn create_note(
        state: State<'_, AppState>,
        app: AppHandle,
        body: String,
        tags: Vec<String>,
        color: Option<String>,
    ) -> Result<oxinot_core::Note, String> {
        let note = state
            .vault
            .create_note(body, tags, color)
            .map_err(|e| e.to_string())?;
        let _ = app.emit("notes:changed", ());
        Ok(note)
    }

    #[tauri::command]
    pub fn update_note(
        state: State<'_, AppState>,
        app: AppHandle,
        id: String,
        body: Option<String>,
        tags: Option<Vec<String>>,
        pinned: Option<bool>,
        color: Option<String>,
    ) -> Result<oxinot_core::Note, String> {
        let id = NoteId::parse(&id).map_err(|e| e.to_string())?;
        let note = state
            .vault
            .update_note(id, body, tags, pinned, color)
            .map_err(|e| e.to_string())?;
        let _ = app.emit("notes:changed", ());
        Ok(note)
    }

    #[tauri::command]
    pub fn delete_note(
        state: State<'_, AppState>,
        app: AppHandle,
        id: String,
    ) -> Result<(), String> {
        let id = NoteId::parse(&id).map_err(|e| e.to_string())?;
        state.vault.delete_note(id).map_err(|e| e.to_string())?;
        let _ = app.emit("notes:changed", ());
        Ok(())
    }

    #[tauri::command]
    pub fn search_notes(
        state: State<'_, AppState>,
        query: String,
        limit: u32,
    ) -> Result<Vec<oxinot_core::NoteSummary>, String> {
        state
            .vault
            .search_notes(&query, limit)
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn export_manifest(
        state: State<'_, AppState>,
        since: Option<String>,
    ) -> Result<Vec<ManifestRecord>, String> {
        let since = match since {
            Some(s) => Some(time::OffsetDateTime::parse(&s, &Rfc3339).map_err(|e| e.to_string())?),
            None => None,
        };
        state
            .vault
            .export_manifest(since)
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn reindex(
        state: State<'_, AppState>,
        app: AppHandle,
    ) -> Result<oxinot_core::IndexStats, String> {
        let stats = state.vault.reindex().map_err(|e| e.to_string())?;
        let _ = app.emit("notes:changed", ());
        Ok(stats)
    }

    #[tauri::command]
    pub fn doctor(state: State<'_, AppState>, fix: bool) -> Result<serde_json::Value, String> {
        let r = state.vault.doctor(fix).map_err(|e| e.to_string())?;
        serde_json::to_value(r).map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn vault_path(state: State<'_, AppState>) -> Result<String, String> {
        Ok(state.vault.paths().vault.display().to_string())
    }

    #[tauri::command]
    pub fn note_stats(state: State<'_, AppState>) -> Result<oxinot_core::NoteStats, String> {
        state.vault.note_stats().map_err(|e| e.to_string())
    }
}
