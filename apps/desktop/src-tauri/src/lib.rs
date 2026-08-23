//! oximemo desktop backend — Tauri 2.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
// NDL/DNB (XML) and KMDB (approval-gated) adapters stay stubs — see
// the fetch_* bodies in metadata.rs for the follow-up notes.
mod metadata;

pub struct AppState {
    pub vault: Arc<oximemo_core::Vault>,
    pub capture_monitor: Mutex<Option<oximemo_capture::CaptureMonitor>>,
    pub watcher: Mutex<Option<oximemo_core::watcher::MemoWatcher>>,
    /// Whether the capture overlay currently holds window focus. Drives the
    /// click-outside-to-close behavior: a `Focused(false)` only hides the
    /// overlay when it had previously gained focus, so the show→focus
    /// sequence can't trip a spurious self-dismiss.
    pub capture_focused: AtomicBool,
    /// Active tray-menu language ("ko" / "en"). Updated from the renderer's
    /// chosen locale via `set_menu_locale`; defaults to the system locale.
    pub menu_locale: Mutex<String>,
    /// Held for the app lifetime so the menu-bar tray icon is not reclaimed
    /// (TrayIcon is reference-counted and removed when the last clone drops).
    pub tray: Mutex<Option<tauri::tray::TrayIcon>>,
}

impl AppState {
    fn new(vault: oximemo_core::Vault) -> Self {
        Self {
            vault: Arc::new(vault),
            capture_monitor: Mutex::new(None),
            watcher: Mutex::new(None),
            capture_focused: AtomicBool::new(false),
            menu_locale: Mutex::new(default_locale()),
            tray: Mutex::new(None),
        }
    }
}

pub fn run() {
    init_tracing();

    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .register_uri_scheme_protocol("oximg", |ctx, request| {
            // Serve a content-addressed image from `<vault>/assets/`. The path is
            // the bare `<hash>.<ext>` name; `read_asset` re-validates it (no
            // traversal, whitelisted ext) before touching the filesystem, so a
            // crafted URL cannot escape the assets dir.
            let name = request.uri().path().trim_start_matches('/');
            let vault = &ctx.app_handle().state::<AppState>().vault;
            match vault.read_asset(name) {
                Some((bytes, mime)) => tauri::http::Response::builder()
                    .status(tauri::http::StatusCode::OK)
                    .header(tauri::http::header::CONTENT_TYPE, mime)
                    .header(
                        tauri::http::header::CACHE_CONTROL,
                        "max-age=31536000, immutable",
                    )
                    .header(tauri::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                    .body(bytes)
                    .unwrap(),
                None => tauri::http::Response::builder()
                    .status(tauri::http::StatusCode::NOT_FOUND)
                    .header(tauri::http::header::CONTENT_TYPE, "text/plain")
                    .body(Vec::new())
                    .unwrap(),
            }
        })
        .setup(|app| {
            // Build the main window in code rather than from tauri.conf.json so
            // we can set the traffic-light inset: the config schema has no
            // trafficLightPosition key, and only the builder reaches tao's
            // resize-persistent positioning. Lowering the lights aligns them
            // with the 48px header instead of the default top-of-window spot.
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("oximemo")
            .inner_size(1100.0, 720.0)
            .min_inner_size(720.0, 480.0)
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(20.0, 26.0))
            .build()?;
            let cli_vault = std::env::var("OXIMEMO_VAULT")
                .ok()
                .map(PathBuf::from)
                .or_else(parse_vault_arg);
            let vault = oximemo_core::Vault::open(cli_vault.as_deref())?;
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
            let monitor = oximemo_capture::CaptureMonitor::start(
                capture_state
                    .vault
                    .with_config(|c| c.capture.double_tap_threshold_ms),
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

            // Menu bar (status bar) tray icon. Left-click opens the dropdown
            // menu (show_menu_on_left_click); the icon is a monochrome template
            // so it adapts to light/dark. Held in AppState for the app lifetime.
            let tray_handle = app.handle().clone();
            let tray_menu = build_tray_menu(&tray_handle)?;
            let tray = TrayIconBuilder::with_id("main-tray")
                .icon(Image::from_bytes(include_bytes!(
                    "../icons/tray-template.png"
                ))?)
                .icon_as_template(true)
                .menu(&tray_menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "capture" => show_capture(app),
                    "show" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(&tray_handle)?;
            app.state::<AppState>().tray.lock().replace(tray);

            // Dock icon visibility from config; the tray icon remains
            // either way (the tray is the app's resident surface).
            let dock = app
                .state::<AppState>()
                .vault
                .with_config(|c| c.appearance.show_dock_icon);
            #[cfg(target_os = "macos")]
            app.handle()
                .set_activation_policy(if dock {
                    tauri::ActivationPolicy::Regular
                } else {
                    tauri::ActivationPolicy::Accessory
                })
                .ok();

            Ok(())
        })
        .on_window_event(|window, event| match event {
            // The main window never really closes. macOS keeps an app alive
            // after its last window is dismissed; intercept the red traffic
            // light so the window (and its React state) is only hidden, not
            // destroyed. `RunEvent::Reopen` (dock icon) and the tray's "Show
            // Main Window" then bring it straight back via `show_main_window`.
            // Without this the window is torn down and cannot be re-shown.
            WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                api.prevent_close();
                let _ = window.hide();
            }
            WindowEvent::Focused(true) if window.label() == "capture" => {
                if let Some(s) = window.app_handle().try_state::<AppState>() {
                    s.capture_focused.store(true, Ordering::Relaxed);
                }
            }
            WindowEvent::Focused(false) if window.label() == "capture" => {
                let hide = window
                    .app_handle()
                    .try_state::<AppState>()
                    .is_some_and(|s| s.capture_focused.swap(false, Ordering::Relaxed));
                if hide {
                    let _ = window.hide();
                    let _ = window.app_handle().emit("capture:hide", ());
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            commands::query_notes,
            commands::folder_schema,
            commands::set_metadata_config,
            commands::search_book_metadata,
            commands::search_movie_metadata,
            commands::install_collection,
            commands::list_memos,
            commands::get_memo,
            commands::create_memo,
            commands::open_daily_note,
            commands::update_memo,
            commands::delete_memo,
            commands::reset_vault,
            commands::search_memos,
            commands::export_manifest,
            commands::reindex,
            commands::doctor,
            commands::vault_path,
            commands::memo_stats,
            commands::list_facets,
            commands::list_folders,
            commands::folder_children,
            commands::create_folder,
            commands::delete_folder,
            commands::rename_folder,
            commands::move_folder,
            commands::restore_notes,
            commands::graph_data,
            commands::get_config,
            commands::set_folder_view,
            commands::set_folder_pinned,
            commands::set_pin_order,
            commands::rename_tag,
            commands::move_note,
            commands::brain_status,
            commands::brain_gather,
            commands::brain_list_spaces,
            commands::set_brain_config,
            commands::set_general_config,
            commands::set_capture_config,
            commands::set_index_config,
            commands::set_appearance_config,
            commands::set_daily_config,
            commands::stamp_metadata,
            commands::set_menu_locale,
            commands::get_backlinks,
            commands::save_image_bytes,
            commands::list_assets,
            commands::gc_assets,
            commands::memo_for_asset,
            commands::cli_status,
            commands::install_cli,
            commands::uninstall_cli,
            commands::show_capture_window,
        ])
        .build(tauri::generate_context!())
        .expect("error while building oximemo desktop app")
        .run(|handle, event| match event {
            // macOS fires `applicationShouldHandleReopen` when the user clicks
            // the dock icon. With the main window hidden on close there are no
            // visible windows to auto-restore, so re-show it here — this is
            // what makes the dock icon reopen the window after the X dismisses
            // it. Guarded on `has_visible_windows` to match native reopen
            // semantics (do nothing when a window is already on screen).
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } if !has_visible_windows => {
                show_main_window(handle);
            }
            _ => {}
        });
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
    let debounce =
        Duration::from_millis(state.vault.with_config(|c| c.index.watcher_debounce_ms) as u64);
    let emit_handle = handle.clone();
    let on_change: oximemo_core::watcher::OnChange = Arc::new(move |path| {
        if let Ok(v) = oximemo_core::Vault::open(Some(&vault_path)) {
            v.reindex_path(&path);
        }
        let _ = emit_handle.emit("memos:changed", ());
    });
    match oximemo_core::watcher::MemoWatcher::spawn(
        vec![
            state.vault.paths().vault.clone(),
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

    // Toggle: a repeated trigger (shortcut, Option double-tap, or the tray
    // "Quick Capture" item) dismisses an already-visible overlay instead of
    // repositioning/refreshing it. The window is parked (hidden), never
    // destroyed, mirroring Escape.
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
        let _ = handle.emit("capture:hide", ());
        return;
    }

    // Anchor the overlay to the monitor the main window sits on — that's the
    // screen the user runs the app on and expects the overlay to appear. The
    // capture window's own `current_monitor()` is None (it is parked off-screen
    // at -9999,-9999 while hidden), and `cursor_position()` is unreliable on a
    // hidden window, so neither can place it. On multi-display setups where the
    // user works on a secondary screen, putting the overlay on the OS "primary"
    // (which may be an unused/asleep display) means it never composites and the
    // user sees nothing. Fall back to the primary monitor only as a last resort.
    const W: f64 = 560.0;
    // Overlay height follows `[capture] overlay_max_height` (TOML ⇄ GUI
    // parity), clamped to a sane composer range.
    let h = handle
        .try_state::<AppState>()
        .map(|s| s.vault.with_config(|c| c.capture.overlay_max_height))
        .unwrap_or(400);
    let h_px: f64 = (h.clamp(120, 600)) as f64;
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
    let y = pos.y as f64 / sf + mh - h_px - BOTTOM_GAP;
    tracing::info!(
        target_x = x,
        target_y = y,
        sf,
        "capture: positioning overlay"
    );
    if let Err(e) = win.set_size(LogicalSize::new(W, h_px)) {
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

fn show_main_window(handle: &AppHandle) {
    if let Some(win) = handle.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Detect the tray-menu locale from the environment, mirroring the
/// renderer's `detectInitial`: Korean when the system language is Korean,
/// English otherwise. `LANG` is unreliable in macOS GUI launches, but the
/// renderer reconciles via `set_menu_locale` within ~300ms — this only
/// labels the (lazy, click-opened) menu before then.
fn default_locale() -> String {
    let lang = std::env::var("LANG").unwrap_or_default();
    if lang.starts_with("ko") {
        "ko".into()
    } else {
        "en".into()
    }
}

fn tray_labels(locale: &str) -> (&'static str, &'static str, &'static str) {
    if locale == "en" {
        ("Quick Capture", "Show Main Window", "Quit oximemo")
    } else {
        ("빠른 캡처", "메인 창 보기", "종료")
    }
}

fn build_tray_menu(handle: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let locale = handle
        .try_state::<AppState>()
        .map(|s| s.menu_locale.lock().clone())
        .unwrap_or_else(default_locale);
    let (cap, show, quit) = tray_labels(&locale);
    let menu = Menu::new(handle)?;
    menu.append(&MenuItem::with_id(
        handle,
        "capture",
        cap,
        true,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(
        handle,
        "show",
        show,
        true,
        None::<&str>,
    )?)?;
    menu.append(&PredefinedMenuItem::separator(handle)?)?;
    menu.append(&MenuItem::with_id(
        handle,
        "quit",
        quit,
        true,
        None::<&str>,
    )?)?;
    Ok(menu)
}

fn init_tracing() {
    use tracing_subscriber::EnvFilter;
    let _ = tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .try_init();
}

/// Resolved oxibrain connection settings from `[brain]` config: an explicit
/// socket path wins; empty uses the daemon default location.
struct BrainEndpointConf {
    enabled: bool,
    socket: String,
    space: String,
}

impl BrainEndpointConf {
    fn from_brain(b: &oximemo_core::config::BrainConfig) -> Self {
        Self {
            enabled: b.enabled,
            socket: b.socket.clone(),
            space: b.space.clone(),
        }
    }
}

async fn brain_connect(
    cfg: &BrainEndpointConf,
) -> anyhow::Result<(
    oxibrain_client::BrainClient,
    oxibrain_client::BrainCapabilities,
)> {
    if cfg.socket.is_empty() {
        oxibrain_client::BrainClient::connect_default().await
    } else {
        let mut client = oxibrain_client::BrainClient::connect(&cfg.socket).await?;
        let caps = client
            .handshake(oxibrain_client::default_client_hello(concat!(
                env!("CARGO_PKG_NAME"),
                " ",
                env!("CARGO_PKG_VERSION")
            )))
            .await?;
        Ok((client, caps))
    }
}

mod commands {
    use oximemo_core::memo::{Cursor, MemoFilter, MemoId};
    use crate::metadata;
    use oximemo_core::sync::ManifestRecord;
    use time::format_description::well_known::Rfc3339;
    use tauri::{AppHandle, Emitter, State};

    use super::AppState;

    /// One row of `list_folders`. Serialized as an object so the JS side can
    /// rely on `entry.path` (Rust tuples serialize as JSON arrays, which would
    /// be `[path, note_count]` and lose the key).
    #[derive(serde::Serialize)]
    pub struct ListFolderResult {
        pub path: String,
        pub note_count: u32,
    }

    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    pub fn list_memos(
        state: State<'_, AppState>,
        after: Option<String>,
        limit: u32,
        include_tags: Vec<String>,
        exclude_tags: Vec<String>,
        match_all: bool,
        folder: Option<String>,
        favorites_only: bool,
        immediate: Option<bool>,
    ) -> Result<oximemo_core::Page<oximemo_core::MemoSummary>, String> {
        let after = match after {
            Some(s) => Some(Cursor::parse(&s).map_err(|e| e.to_string())?),
            None => None,
        };
        let filter = MemoFilter {
            include_tags,
            exclude_tags,
            match_all,
            folder,
            favorites_only,
            include_deleted: false,
            immediate: immediate.unwrap_or(false),
        };
        state
            .vault
            .list_memos(after, limit, filter)
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn get_memo(
        state: State<'_, AppState>,
        id: String,
    ) -> Result<oximemo_core::memo::NoteDto, String> {
        let id = MemoId::parse(&id).map_err(|e| e.to_string())?;
        let memo = state.vault.get_memo(id).map_err(|e| e.to_string())?;
        Ok(state.vault.note_dto(&memo))
    }

    #[tauri::command]
    pub fn create_memo(
        state: State<'_, AppState>,
        app: AppHandle,
        body: String,
        folder: Option<String>,
        format: Option<String>,
    ) -> Result<oximemo_core::memo::NoteDto, String> {
        let fmt = match format.as_deref() {
            Some("html") => oximemo_core::memo::NoteFormat::Html,
            _ => oximemo_core::memo::NoteFormat::Markdown,
        };
        // Explicit format wins; without one the folder's templates decide
        // (TEMPLATE.html-only folders produce html notes, spec D8).
        let memo = if format.is_some() {
            state
                .vault
                .create_note(folder.as_deref().unwrap_or(""), body, fmt)
                .map_err(|e| e.to_string())?
        } else {
            state
                .vault
                .create_note_auto(folder.as_deref().unwrap_or(""), body)
                .map_err(|e| e.to_string())?
        };
        let _ = app.emit("memos:changed", ());
        Ok(state.vault.note_dto(&memo))
    }

    /// Payload of `open_daily_note`: the note plus whether THIS call
    /// minted it. The frontend discards a freshly created daily note on
    /// close-untouched; adopted/visited notes must never be.
    #[derive(serde::Serialize)]
    pub struct DailyOpenDto {
        pub memo: oximemo_core::memo::NoteDto,
        pub created: bool,
    }

    #[tauri::command]
    pub fn open_daily_note(
        state: State<'_, AppState>,
        app: AppHandle,
        date: String,
    ) -> Result<DailyOpenDto, String> {
        let (memo, created) = state.vault.open_daily(&date).map_err(|e| e.to_string())?;
        let _ = app.emit("memos:changed", ());
        Ok(DailyOpenDto {
            memo: state.vault.note_dto(&memo),
            created,
        })
    }

    #[tauri::command]
    pub fn update_memo(
        state: State<'_, AppState>,
        app: AppHandle,
        id: String,
        body: Option<String>,
        favorite: Option<bool>,
        props: Option<oximemo_core::PropMutation>,
    ) -> Result<oximemo_core::memo::NoteDto, String> {
        let id = MemoId::parse(&id).map_err(|e| e.to_string())?;
        let memo = state
            .vault
            .update_note_with(id, body, favorite, props)
            .map_err(|e| e.to_string())?;
        let _ = app.emit("memos:changed", ());
        Ok(state.vault.note_dto(&memo))
    }

    /// Offset-paginated property query (design 2026-08-23 §5.2). The
    /// payload mirrors `oximemo_core::NoteQuery` (serde on the core type).
    #[tauri::command]
    pub fn query_notes(
        state: State<'_, AppState>,
        filter: Option<oximemo_core::MemoFilter>,
        props: Option<Vec<oximemo_core::PropPredicate>>,
        sort: Option<oximemo_core::SortSpec>,
        offset: Option<usize>,
        limit: Option<u32>,
    ) -> Result<oximemo_core::QueryPage, String> {
        let query = oximemo_core::NoteQuery {
            filter: filter.unwrap_or_default(),
            props: props.unwrap_or_default(),
            sort: sort.unwrap_or_default(),
            offset: offset.unwrap_or(0),
            limit: limit.unwrap_or(50),
        };
        state.vault.query_notes(&query).map_err(|e| e.to_string())
    }

    /// The folder's property schema, or `null` in free-property mode.
    #[tauri::command]
    pub fn folder_schema(
        state: State<'_, AppState>,
        folder: String,
    ) -> Result<Option<oximemo_core::FolderSchema>, String> {
        state.vault.folder_schema(&folder).map_err(|e| e.to_string())
    }

    /// Install the knowledge preset (TEMPLATE.md + SCHEMA.toml) into a
    /// freshly created folder (design §6.3).
    #[tauri::command]
    pub fn install_collection(
        state: State<'_, AppState>,
        app: AppHandle,
        preset_id: String,
        folder: String,
    ) -> Result<(), String> {
        state
            .vault
            .install_collection(&preset_id, &folder)
            .map_err(|e| e.to_string())?;
        let _ = app.emit("memos:changed", ());
        Ok(())
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
    pub fn reset_vault(state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
        state.vault.reset().map_err(|e| e.to_string())?;
        let _ = app.emit("memos:changed", ());
        Ok(())
    }

    #[tauri::command]
    pub fn search_memos(
        state: State<'_, AppState>,
        query: String,
        limit: u32,
    ) -> Result<Vec<oximemo_core::MemoSummary>, String> {
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
    ) -> Result<oximemo_core::IndexStats, String> {
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
    pub fn memo_stats(state: State<'_, AppState>) -> Result<oximemo_core::MemoStats, String> {
        state.vault.memo_stats().map_err(|e| e.to_string())
    }
    #[tauri::command]
    pub fn list_facets(state: State<'_, AppState>) -> Result<oximemo_core::Facets, String> {
        state.vault.list_facets().map_err(|e| e.to_string())
    }

    // -- folders ----------------------------------------------------------

    #[tauri::command]
    pub fn list_folders(state: State<'_, AppState>) -> Result<Vec<ListFolderResult>, String> {
        state
            .vault
            .list_folders()
            .map(|rows| {
                rows.into_iter()
                    .map(|(path, note_count)| ListFolderResult { path, note_count })
                    .collect()
            })
            .map_err(|e| e.to_string())
    }

    /// Folder cards for the Finder-style browser: direct + recursive counts
    /// and a sample of recent note titles for each kid of `path`.
    #[tauri::command]
    pub fn folder_children(
        state: State<'_, AppState>,
        path: String,
    ) -> Result<Vec<oximemo_core::FolderCard>, String> {
        state
            .vault
            .folder_children(&path)
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn create_folder(
        state: State<'_, AppState>,
        app: AppHandle,
        path: String,
    ) -> Result<(), String> {
        state
            .vault
            .create_folder(&path)
            .map_err(|e| e.to_string())?;
        let _ = app.emit("memos:changed", ());
        Ok(())
    }

    #[tauri::command]
    pub fn delete_folder(
        state: State<'_, AppState>,
        app: AppHandle,
        path: String,
    ) -> Result<Vec<String>, String> {
        let ids = state
            .vault
            .delete_folder(&path)
            .map_err(|e| e.to_string())?;
        let _ = app.emit("memos:changed", ());
        Ok(ids.into_iter().map(|id| id.to_string()).collect())
    }

    /// Undo for `delete_folder`: bring the trashed notes back live.
    #[tauri::command]
    pub fn restore_notes(
        state: State<'_, AppState>,
        app: AppHandle,
        ids: Vec<String>,
    ) -> Result<Vec<String>, String> {
        let parsed: Vec<MemoId> = ids
            .iter()
            .map(|s| MemoId::parse(s).map_err(|e| e.to_string()))
            .collect::<Result<_, String>>()?;
        let restored = state
            .vault
            .restore_notes(&parsed)
            .map_err(|e| e.to_string())?;
        let _ = app.emit("memos:changed", ());
        Ok(restored.into_iter().map(|id| id.to_string()).collect())
    }
    #[tauri::command]
    pub fn rename_folder(
        state: State<'_, AppState>,
        app: AppHandle,
        from: String,
        to: String,
    ) -> Result<(), String> {
        state
            .vault
            .rename_folder(&from, &to)
            .map_err(|e| e.to_string())?;
        let _ = app.emit("memos:changed", ());
        Ok(())
    }

    #[tauri::command]
    pub fn move_folder(
        state: State<'_, AppState>,
        app: AppHandle,
        path: String,
        dest: String,
    ) -> Result<(), String> {
        state
            .vault
            .move_folder(&path, &dest)
            .map_err(|e| e.to_string())?;
        let _ = app.emit("memos:changed", ());
        Ok(())
    }

    // -- graph + config (§6 graph view, §6.3 folder views) ----------------

    #[tauri::command]
    pub fn graph_data(state: State<'_, AppState>) -> Result<oximemo_core::GraphData, String> {
        state.vault.graph_data().map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn get_config(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
        Ok(state.vault.config_json())
    }

    #[tauri::command]
    pub fn set_folder_view(
        state: State<'_, AppState>,
        path: String,
        view: Option<oximemo_core::ViewMode>,
    ) -> Result<(), String> {
        state
            .vault
            .set_folder_view(&path, view)
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn set_folder_pinned(
        state: State<'_, AppState>,
        path: String,
        pinned: bool,
    ) -> Result<(), String> {
        state
            .vault
            .set_folder_pinned(&path, pinned)
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn set_pin_order(
        state: State<'_, AppState>,
        app: AppHandle,
        order: Vec<String>,
    ) -> Result<(), String> {
        state
            .vault
            .set_pin_order(&order)
            .map_err(|e| e.to_string())?;
        let _ = app.emit("config:changed", ());
        Ok(())
    }

    #[tauri::command]
    pub fn rename_tag(
        state: State<'_, AppState>,
        app: AppHandle,
        old: String,
        new: String,
    ) -> Result<u64, String> {
        let n = state
            .vault
            .rename_tag(&old, &new)
            .map_err(|e| e.to_string())?;
        let _ = app.emit("memos:changed", ());
        Ok(n)
    }

    #[tauri::command]
    pub fn move_note(
        state: State<'_, AppState>,
        app: AppHandle,
        id: String,
        folder: String,
    ) -> Result<oximemo_core::memo::NoteDto, String> {
        let id = MemoId::parse(&id).map_err(|e| e.to_string())?;
        let memo = state
            .vault
            .move_note(id, &folder)
            .map_err(|e| e.to_string())?;
        let _ = app.emit("memos:changed", ());
        Ok(state.vault.note_dto(&memo))
    }

    /// oxibrain daemon health + counts for the panel's status dot. Daemon
    /// down is a normal state, not an error: `{online: false, ...}`.
    #[tauri::command]
    pub async fn brain_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
        let cfg = state
            .vault
            .with_config(|c| crate::BrainEndpointConf::from_brain(&c.brain));
        if !cfg.enabled {
            return Ok(serde_json::json!({"online": false, "disabled": true}));
        }
        let (mut client, caps) = match crate::brain_connect(&cfg).await {
            Ok(c) => c,
            Err(e) => {
                tracing::debug!(error = %e, "brain: daemon unreachable");
                return Ok(serde_json::json!({"online": false}));
            }
        };
        let stats = match client.stats(&cfg.space).await {
            Ok(v) => v,
            Err(e) => {
                tracing::debug!(error = %e, "brain: stats failed");
                return Ok(serde_json::json!({"online": false}));
            }
        };
        let count = |k: &str| stats.get(k).and_then(|v| v.as_u64());
        Ok(serde_json::json!({
            "online": true,
            "server_version": caps.server_version,
            "episodes": count("episodes"),
            "entities": count("entities"),
            "statements": count("statements"),
            "contradictions": count("contradictions"),
        }))
    }

    /// Assemble recall layers for a query. Daemon down → Err so the panel
    /// can show its offline line; the note editor itself is unaffected.
    #[tauri::command]
    pub async fn brain_gather(
        state: State<'_, AppState>,
        query: String,
        budget: Option<u32>,
    ) -> Result<serde_json::Value, String> {
        let cfg = state
            .vault
            .with_config(|c| crate::BrainEndpointConf::from_brain(&c.brain));
        if !cfg.enabled {
            return Err("brain disabled in config".to_string());
        }
        let (mut client, _caps) = crate::brain_connect(&cfg)
            .await
            .map_err(|e| format!("brain offline: {e}"))?;
        client
            .recall(&query, &cfg.space, budget.unwrap_or(4000) as usize)
            .await
            .map_err(|e| format!("brain recall failed: {e}"))
    }

    /// Spaces the daemon exposes, for the settings picker. Offline is a
    /// normal state (C1): `{online: false, spaces: []}` — the UI falls back
    /// to a free-text input.
    #[tauri::command]
    pub async fn brain_list_spaces(
        state: State<'_, AppState>,
    ) -> Result<serde_json::Value, String> {
        let cfg = state
            .vault
            .with_config(|c| crate::BrainEndpointConf::from_brain(&c.brain));
        if !cfg.enabled {
            return Ok(serde_json::json!({ "online": false, "spaces": [] }));
        }
        let (mut client, _caps) = match crate::brain_connect(&cfg).await {
            Ok(c) => c,
            Err(_) => return Ok(serde_json::json!({ "online": false, "spaces": [] })),
        };
        match client.list_spaces().await {
            Ok(list) => Ok(serde_json::json!({
                "online": true,
                "spaces": list
                    .iter()
                    .map(|s| serde_json::json!({
                        "name": s.name,
                        "episodes": s.episode_count,
                    }))
                    .collect::<Vec<_>>(),
            })),
            Err(_) => Ok(serde_json::json!({ "online": false, "spaces": [] })),
        }
    }

    // -- config sections (TOML ⇄ GUI parity) --------------------------------

    #[tauri::command]
    pub fn set_brain_config(
        state: State<'_, AppState>,
        brain: oximemo_core::config::BrainConfig,
    ) -> Result<(), String> {
        state
            .vault
            .set_brain_config(brain)
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn set_general_config(
        state: State<'_, AppState>,
        general: oximemo_core::config::GeneralConfig,
    ) -> Result<(), String> {
        state
            .vault
            .set_general_config(general)
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn set_metadata_config(
        state: State<'_, AppState>,
        metadata: oximemo_core::config::MetadataConfig,
    ) -> Result<(), String> {
        state
            .vault
            .set_metadata_config(metadata)
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub async fn search_book_metadata(
        state: State<'_, AppState>,
        query: String,
        region: Option<String>,
    ) -> Result<Vec<oximemo_core::metadata::MetaHit>, String> {
        let cfg = {
            let v = state.vault.clone();
            tokio::task::spawn_blocking(move || v.with_config(|c| c.metadata.clone()))
                .await
                .map_err(|e| e.to_string())?
        };
        // `region` carries the auto-detected locale when the stored
        // config is "" (auto): the renderer resolves Intl there, the
        // Rust side has no locale to consult.
        let cfg = match region {
            Some(r) if !r.is_empty() => oximemo_core::config::MetadataConfig { region: r, ..cfg },
            _ => cfg,
        };
        Ok(metadata::search_books(&cfg, &query).await)
    }

    #[tauri::command]
    pub async fn search_movie_metadata(
        state: State<'_, AppState>,
        query: String,
        region: Option<String>,
    ) -> Result<Vec<oximemo_core::metadata::MetaHit>, String> {
        let cfg = {
            let v = state.vault.clone();
            tokio::task::spawn_blocking(move || v.with_config(|c| c.metadata.clone()))
                .await
                .map_err(|e| e.to_string())?
        };
        let cfg = match region {
            Some(r) if !r.is_empty() => oximemo_core::config::MetadataConfig { region: r, ..cfg },
            _ => cfg,
        };
        Ok(metadata::search_movies(&cfg, &query).await)
    }

    /// Stamp a chosen `MetaHit` onto a note (spec §3.5): fills only
    /// schema-declared metadata props that are still empty, plus
    /// `source_url` (attribution link) when the schema declares it.
    /// Existing values are never overwritten — the core walker owns
    /// that contract.
    #[tauri::command]
    pub fn stamp_metadata(
        state: State<'_, AppState>,
        app: AppHandle,
        id: String,
        hit: oximemo_core::metadata::MetaHit,
    ) -> Result<oximemo_core::memo::NoteDto, String> {
        let mid = oximemo_core::MemoId::parse(&id).map_err(|e| e.to_string())?;
        let memo = state.vault.get_memo(mid).map_err(|e| e.to_string())?;
        let dto = state.vault.note_dto(&memo);
        let schema = state
            .vault
            .folder_schema(&dto.folder)
            .map_err(|e| e.to_string())?
            .unwrap_or_default();
        let mut sets: Vec<(String, oximemo_core::PropValue)> =
            oximemo_core::metadata::stamp_targets(&schema, &hit)
                .into_iter()
                .filter(|(k, _)| !memo.props.contains_key(k))
                .collect();
        if let (Some(url), false) = (&hit.url, memo.props.contains_key("source_url")) {
            if schema.properties.contains_key("source_url") {
                sets.push(("source_url".into(), oximemo_core::PropValue::Str(url.clone())));
            }
        }
        if sets.is_empty() {
            return Ok(dto);
        }
        let memo = state
            .vault
            .update_note_with(mid, None, None, Some(oximemo_core::PropMutation { sets, removes: Vec::new() }))
            .map_err(|e| e.to_string())?;
        let _ = app.emit("memos:changed", ());
        Ok(state.vault.note_dto(&memo))
    }
    #[tauri::command]
    pub fn set_daily_config(
        state: State<'_, AppState>,
        daily: oximemo_core::config::DailyConfig,
    ) -> Result<(), String> {
        state
            .vault
            .set_daily_config(daily)
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn set_capture_config(
        state: State<'_, AppState>,
        capture: oximemo_core::config::CaptureConfig,
    ) -> Result<(), String> {
        state
            .vault
            .set_capture_config(capture)
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn set_index_config(
        state: State<'_, AppState>,
        index: oximemo_core::config::IndexConfig,
    ) -> Result<(), String> {
        state
            .vault
            .set_index_config(index)
            .map_err(|e| e.to_string())
    }

    /// `[appearance]` — applies the dock-icon policy immediately after save.
    #[tauri::command]
    pub fn set_appearance_config(
        app: AppHandle,
        state: State<'_, AppState>,
        appearance: oximemo_core::config::AppearanceConfig,
    ) -> Result<(), String> {
        state
            .vault
            .set_appearance_config(appearance)
            .map_err(|e| e.to_string())?;
        #[cfg(target_os = "macos")]
        app.set_activation_policy(
            if state.vault.with_config(|c| c.appearance.show_dock_icon) {
                tauri::ActivationPolicy::Regular
            } else {
                tauri::ActivationPolicy::Accessory
            },
        )
        .map_err(|e| e.to_string())?;
        #[cfg(not(target_os = "macos"))]
        let _ = app;
        Ok(())
    }

    #[tauri::command]
    pub fn get_backlinks(
        state: State<'_, AppState>,
        id: String,
    ) -> Result<Vec<oximemo_core::BacklinkInfo>, String> {
        let id = MemoId::parse(&id).map_err(|e| e.to_string())?;
        state.vault.get_backlinks(id).map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn set_menu_locale(
        app: AppHandle,
        state: State<'_, AppState>,
        locale: String,
    ) -> Result<(), String> {
        {
            let mut g = state.menu_locale.lock();
            if *g == locale {
                return Ok(());
            }
            *g = locale;
        }
        let menu = super::build_tray_menu(&app).map_err(|e| e.to_string())?;
        if let Some(tray) = app.tray_by_id("main-tray") {
            tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    // -- image assets ----------------------------------------------------

    #[tauri::command]
    pub fn save_image_bytes(
        state: State<'_, AppState>,
        base64_data: String,
        ext: String,
    ) -> Result<oximemo_core::AssetRef, String> {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(base64_data.as_bytes())
            .map_err(|e| e.to_string())?;
        state
            .vault
            .save_asset(&bytes, &ext)
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn list_assets(state: State<'_, AppState>) -> Result<Vec<oximemo_core::AssetInfo>, String> {
        state.vault.list_assets().map_err(|e| e.to_string())
    }

    /// Delete assets referenced by no memo (gallery "clean up"). Returns the
    /// count removed.
    #[tauri::command]
    pub fn gc_assets(state: State<'_, AppState>) -> Result<u64, String> {
        state.vault.gc_assets().map_err(|e| e.to_string())
    }

    /// First memo whose body references asset `name` (gallery "open memo").
    #[tauri::command]
    pub fn memo_for_asset(
        state: State<'_, AppState>,
        name: String,
    ) -> Result<Option<String>, String> {
        Ok(state
            .vault
            .find_memo_by_asset(&name)
            .map_err(|e| e.to_string())?
            .map(|id| id.0.to_string()))
    }

    // -- CLI command install ------------------------------------------------
    // The app ships the `oximemo` CLI as a Tauri externalBin sidecar; these
    // expose it on PATH via an explicit Settings action (macOS auth dialog).

    /// State of the `oximemo` shell command on `/usr/local/bin`.
    #[derive(serde::Serialize)]
    #[serde(rename_all = "lowercase")]
    pub enum CliState {
        /// Symlink present and points at this app's bundled CLI.
        Installed,
        /// No symlink present.
        NotInstalled,
        /// Symlink missing or points elsewhere (e.g. app moved post-install).
        Stale,
    }

    /// Path of the bundled CLI, derived from the running executable so it
    /// tracks wherever the user installed the `.app`. `None` only if the exe
    /// path can't be resolved.
    fn bundled_cli_path() -> Option<std::path::PathBuf> {
        let exe = std::env::current_exe().ok()?;
        let dir = exe.parent()?;
        // The externalBin sidecar lands in Contents/MacOS/ next to the main
        // binary, under its base name — Tauri strips the `-<triple>` suffix
        // during bundling (input `oximemo-<triple>` → bundled `oximemo`).
        Some(dir.join("oximemo"))
    }

    #[tauri::command]
    pub fn cli_status() -> Result<CliState, String> {
        let link = std::path::Path::new("/usr/local/bin/oximemo");
        let Some(bundled) = bundled_cli_path() else {
            return Ok(CliState::NotInstalled);
        };
        let same = |a: &std::path::Path, b: &std::path::Path| {
            std::fs::canonicalize(a).ok() == std::fs::canonicalize(b).ok()
        };
        match std::fs::read_link(link) {
            Ok(target) if same(&target, &bundled) => Ok(CliState::Installed),
            Ok(_) => Ok(CliState::Stale),
            // Not a symlink: absent → NotInstalled, a stray copy → Stale.
            Err(_) => Ok(if link.exists() {
                CliState::Stale
            } else {
                CliState::NotInstalled
            }),
        }
    }

    #[tauri::command]
    pub fn install_cli() -> Result<(), String> {
        let target =
            bundled_cli_path().ok_or_else(|| "could not locate the app bundle".to_string())?;
        if !target.exists() {
            return Err("bundled CLI binary is missing".to_string());
        }
        // Shell-quote the path; app-bundle paths never contain a quote, guard.
        let q = target.display().to_string().replace('\'', "'\"'\"'");
        run_admin(&format!("ln -sf '{q}' /usr/local/bin/oximemo"))
    }

    #[tauri::command]
    pub fn uninstall_cli() -> Result<(), String> {
        run_admin("rm -f /usr/local/bin/oximemo")
    }

    /// Show (or dismiss, when already visible) the quick-capture overlay.
    /// Same toggle path as the ⌘⇧N global shortcut and the tray item —
    /// exposed as a command so the renderer's ⌘K palette can trigger it.
    #[tauri::command]
    pub fn show_capture_window(app: AppHandle) {
        crate::show_capture(&app);
    }

    /// Run a shell snippet with administrator privileges via osascript. macOS
    /// shows its standard auth dialog once; cancelling surfaces as an error.
    fn run_admin(shell_script: &str) -> Result<(), String> {
        let output = std::process::Command::new("osascript")
            .arg("-e")
            .arg(format!(
                "do shell script {} with administrator privileges",
                applescript_string(shell_script)
            ))
            .output()
            .map_err(|e| e.to_string())?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    }

    /// Quote `s` as an AppleScript double-quoted string literal.
    fn applescript_string(s: &str) -> String {
        let mut out = String::from("\"");
        for ch in s.chars() {
            match ch {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                _ => out.push(ch),
            }
        }
        out.push('"');
        out
    }
}

#[cfg(test)]
mod tests {
    use super::commands::ListFolderResult;

    /// `list_folders` must serialize as `[{"path":"…","note_count":N}]`, NOT
    /// `[["…",N]]`. The JS side reaches `entry.path` directly; a tuple-as-array
    /// shape would silently make every entry `path: undefined` and crash the
    /// sidebar tree.
    #[test]
    fn list_folders_serializes_as_objects() {
        let rows = vec![
            ListFolderResult {
                path: String::new(),
                note_count: 3,
            },
            ListFolderResult {
                path: "novel".into(),
                note_count: 2,
            },
        ];
        let json = serde_json::to_string(&rows).unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();

        let arr = v.as_array().expect("top-level must be an array");
        assert_eq!(arr.len(), 2);
        for (i, item) in arr.iter().enumerate() {
            let obj = item
                .as_object()
                .unwrap_or_else(|| panic!("entry {i} should be object, got {item}"));
            assert!(obj.contains_key("path"), "entry {i} missing `path` key");
            assert!(
                obj.contains_key("note_count"),
                "entry {i} missing `note_count` key"
            );
        }
        assert_eq!(arr[0]["path"], serde_json::Value::String(String::new()));
        assert_eq!(arr[0]["note_count"], serde_json::json!(3));
        assert_eq!(arr[1]["path"], serde_json::Value::String("novel".into()));
        assert_eq!(arr[1]["note_count"], serde_json::json!(2));
    }
}
