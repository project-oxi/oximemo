//! oxinot desktop backend — Tauri 2.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

pub struct AppState {
    pub vault: Arc<oxinot_core::Vault>,
    pub capture_monitor: Mutex<Option<oxinot_capture::CaptureMonitor>>,
    pub watcher: Mutex<Option<oxinot_core::watcher::MemoWatcher>>,
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
            // Regenerate cached card previews once when the indexed preview
            // format changes (e.g. line-break preservation). No-op when current.
            if let Err(e) = vault.migrate() {
                tracing::warn!(error = %e, "index preview migration failed");
            }
            app.manage(AppState::new(vault));
            let wstate = app.state::<AppState>();
            spawn_watcher(&wstate, app.handle());

            let handle = app.handle().clone();
            app.global_shortcut()
                .on_shortcut(default_shortcut(), move |_app, _sc, event| {
                    if event.state() == ShortcutState::Pressed {
                        tracing::info!("capture: Cmd+Shift+N pressed");
                        show_capture(&handle);
                    }
                })?;

            let capture_state = app.state::<AppState>();
            let monitor = oxinot_capture::CaptureMonitor::start(
                capture_state.vault.with_config(|c| c.capture.double_tap_threshold_ms),
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
            commands::list_memos,
            commands::get_memo,
            commands::create_memo,
            commands::update_memo,
            commands::delete_memo,
            commands::search_memos,
            commands::export_manifest,
            commands::reindex,
            commands::doctor,
            commands::vault_path,
            commands::memo_stats,
            commands::list_facets,
            commands::list_categories,
            commands::create_category,
            commands::update_category,
            commands::rename_category,
            commands::delete_category,
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
/// re-indexes the file and broadcasts `memos:changed` so every window can
/// refresh its query cache. The handle lives in `AppState` for the app
/// lifetime — dropping it would stop watching.
fn spawn_watcher(state: &AppState, handle: &AppHandle) {
    let vault_path = state.vault.paths().vault.clone();
    let debounce = Duration::from_millis(state.vault.with_config(|c| c.index.watcher_debounce_ms) as u64);
    let emit_handle = handle.clone();
    let on_change: oxinot_core::watcher::OnChange = Arc::new(move |path| {
        if let Ok(v) = oxinot_core::Vault::open(Some(&vault_path)) {
            v.reindex_path(&path);
        }
        let _ = emit_handle.emit("memos:changed", ());
    });
    match oxinot_core::watcher::MemoWatcher::spawn(
        vec![
            state.vault.paths().memos_root(),
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
    use tauri::{LogicalPosition, LogicalSize};

    let Some(win) = handle.get_webview_window("capture") else {
        tracing::warn!("capture: overlay window not found");
        return;
    };

    // Anchor the overlay to the monitor the main window sits on — that's the
    // screen the user runs the app on and expects the overlay to appear. The
    // capture window's own `current_monitor()` is None (it is parked off-screen
    // at -9999,-9999 while hidden), and `cursor_position()` is unreliable on a
    // hidden window, so neither can place it. On multi-display setups where the
    // user works on a secondary screen, putting the overlay on the OS "primary"
    // (which may be an unused/asleep display) means it never composites and the
    // user sees nothing. Fall back to the primary monitor only as a last resort.
    const W: f64 = 560.0;
    const H: f64 = 200.0;
    const BOTTOM_GAP: f64 = 24.0;
    let monitor = handle
        .get_webview_window("main")
        .and_then(|w| w.current_monitor().ok().flatten())
        .or_else(|| win.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        tracing::warn!("capture: no monitor available; cannot position overlay");
        if let Err(e) = win.show() {
            tracing::warn!(error = ?e, "capture: show failed");
        }
        let _ = win.set_focus();
        let _ = handle.emit("capture:show", ());
        return;
    };
    let pos = monitor.position();
    let sf = monitor.scale_factor();
    let mw = monitor.size().width as f64 / sf;
    let mh = monitor.size().height as f64 / sf;
    // Bottom-center composer pill: centered horizontally, 24px above the
    // bottom edge. JS auto-grows the height on input and re-anchors the
    // bottom edge on every resize.
    let x = pos.x as f64 / sf + mw / 2.0 - W / 2.0;
    let y = pos.y as f64 / sf + mh - H - BOTTOM_GAP;
    tracing::info!(target_x = x, target_y = y, sf, "capture: positioning overlay");
    if let Err(e) = win.set_size(LogicalSize::new(W, H)) {
        tracing::warn!(error = ?e, "capture: set_size failed");
    }
    if let Err(e) = win.set_position(LogicalPosition::new(x, y)) {
        tracing::warn!(error = ?e, "capture: set_position failed");
    }
    if let Err(e) = win.show() {
        tracing::warn!(error = ?e, "capture: show failed");
    } else {
        tracing::info!("capture: overlay shown");
    }
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
    use oxinot_core::memo::{Cursor, MemoFilter, MemoId};
    use oxinot_core::sync::ManifestRecord;
    use tauri::{AppHandle, Emitter, State};
    use time::format_description::well_known::Rfc3339;

    use super::AppState;

    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    pub fn list_memos(
        state: State<'_, AppState>,
        after: Option<String>,
        limit: u32,
        include_tags: Vec<String>,
        exclude_tags: Vec<String>,
        match_all: bool,
        categories: Vec<String>,
        favorites_only: bool,
    ) -> Result<oxinot_core::Page<oxinot_core::MemoSummary>, String> {
        let after = match after {
            Some(s) => Some(Cursor::parse(&s).map_err(|e| e.to_string())?),
            None => None,
        };
        let filter = MemoFilter {
            include_tags,
            exclude_tags,
            match_all,
            categories,
            favorites_only,
            include_deleted: false,
        };
        state
            .vault
            .list_memos(after, limit, filter)
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn get_memo(state: State<'_, AppState>, id: String) -> Result<oxinot_core::Memo, String> {
        let id = MemoId::parse(&id).map_err(|e| e.to_string())?;
        state.vault.get_memo(id).map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn create_memo(
        state: State<'_, AppState>,
        app: AppHandle,
        body: String,
        category: Option<String>,
    ) -> Result<oxinot_core::Memo, String> {
        let memo = state
            .vault
            .create_memo(body, category)
            .map_err(|e| e.to_string())?;
        let _ = app.emit("memos:changed", ());
        Ok(memo)
    }

    #[tauri::command]
    pub fn update_memo(
        state: State<'_, AppState>,
        app: AppHandle,
        id: String,
        body: Option<String>,
        favorite: Option<bool>,
        category: Option<String>,
    ) -> Result<oxinot_core::Memo, String> {
        let id = MemoId::parse(&id).map_err(|e| e.to_string())?;
        let memo = state
            .vault
            .update_memo(id, body, favorite, category)
            .map_err(|e| e.to_string())?;
        let _ = app.emit("memos:changed", ());
        Ok(memo)
    }

    #[tauri::command]
    pub fn delete_memo(
        state: State<'_, AppState>,
        app: AppHandle,
        id: String,
    ) -> Result<(), String> {
        let id = MemoId::parse(&id).map_err(|e| e.to_string())?;
        state.vault.delete_memo(id).map_err(|e| e.to_string())?;
        let _ = app.emit("memos:changed", ());
        Ok(())
    }

    #[tauri::command]
    pub fn search_memos(
        state: State<'_, AppState>,
        query: String,
        limit: u32,
    ) -> Result<Vec<oxinot_core::MemoSummary>, String> {
        state
            .vault
            .search_memos(&query, limit)
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
        let _ = app.emit("memos:changed", ());
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
    pub fn memo_stats(state: State<'_, AppState>) -> Result<oxinot_core::MemoStats, String> {
        state.vault.memo_stats().map_err(|e| e.to_string())
    }
    #[tauri::command]
    pub fn list_facets(state: State<'_, AppState>) -> Result<oxinot_core::Facets, String> {
        state.vault.list_facets().map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn list_categories(
        state: State<'_, AppState>,
    ) -> Result<Vec<oxinot_core::config::CategoryDef>, String> {
        Ok(state.vault.categories())
    }

    #[tauri::command]
    pub fn create_category(
        state: State<'_, AppState>,
        app: AppHandle,
        id: String,
        color: Option<String>,
    ) -> Result<oxinot_core::config::CategoryDef, String> {
        let def = state
            .vault
            .create_category(id, color)
            .map_err(|e| e.to_string())?;
        let _ = app.emit("memos:changed", ());
        Ok(def)
    }

    #[tauri::command]
    pub fn update_category(
        state: State<'_, AppState>,
        app: AppHandle,
        id: String,
        color: String,
    ) -> Result<(), String> {
        state.vault.update_category(id, color).map_err(|e| e.to_string())?;
        let _ = app.emit("memos:changed", ());
        Ok(())
    }

    #[tauri::command]
    pub fn rename_category(
        state: State<'_, AppState>,
        app: AppHandle,
        old: String,
        new: String,
    ) -> Result<u64, String> {
        let n = state.vault.rename_category(old, new).map_err(|e| e.to_string())?;
        let _ = app.emit("memos:changed", ());
        Ok(n)
    }

    #[tauri::command]
    pub fn delete_category(
        state: State<'_, AppState>,
        app: AppHandle,
        id: String,
    ) -> Result<(), String> {
        state.vault.delete_category(id).map_err(|e| e.to_string())?;
        let _ = app.emit("memos:changed", ());
        Ok(())
    }
}
