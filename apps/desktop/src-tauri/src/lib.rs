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
mod copilot;

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
    /// Process-group id of the copilot turn currently in flight, if any
    /// (spec §8 — cancellation kills the whole tree via this pgid).
    pub copilot_active: Mutex<Option<i32>>,
    /// Local git versioning layer (oxi-vault-git) — the mechanical
    /// safety net. Constructed once at boot from `[git]` config; a
    /// foreign/corrupt repo degrades to a disabled layer, never blocks
    /// startup.
    pub git: Arc<oxi_vault_git::GitLayer>,
    /// Feed for the git commit consumer. The watcher's debounce thread
    /// sends settled paths here (non-blocking); a dedicated consumer
    /// thread performs the gix commits so no write path ever waits on
    /// git (the ≤16 ms capture budget stays untouched).
    pub git_tx: tokio::sync::mpsc::UnboundedSender<PathBuf>,
}

impl AppState {
    fn new(
        vault: Arc<oximemo_core::Vault>,
        git: Arc<oxi_vault_git::GitLayer>,
        git_tx: tokio::sync::mpsc::UnboundedSender<PathBuf>,
    ) -> Self {
        Self {
            vault,
            capture_monitor: Mutex::new(None),
            watcher: Mutex::new(None),
            copilot_active: Mutex::new(None),
            capture_focused: AtomicBool::new(false),
            menu_locale: Mutex::new(default_locale()),
            tray: Mutex::new(None),
            git,
            git_tx,
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
            // Local git versioning layer (oxi-vault-git): the mechanical
            // safety net. Foreign/corrupt repos degrade to a disabled
            // layer with a loud warn — never blocks boot (mirrors oxios).
            let (git_auto, git_adopt) =
                vault.with_config(|c| (c.git.auto_commit, c.git.adopt_foreign_repo));
            let git = Arc::new(oxi_vault_git::GitLayer::new_for_vault(
                vault.paths().vault.clone(),
                git_auto,
                git_adopt,
            )?);
            let (git_tx, git_rx) = tokio::sync::mpsc::unbounded_channel::<PathBuf>();
            let vault = Arc::new(vault);
            spawn_git_consumer(
                git.clone(),
                vault.clone(),
                vault.paths().vault.clone(),
                git_rx,
            );
            app.manage(AppState::new(vault, git, git_tx));
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
            commands::run_base,
            commands::list_bases,
            commands::load_base,
            commands::save_base,
            commands::rename_base,
            commands::trash_base,
            commands::restore_base,
            commands::base_props,
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
            commands::brain_history,
            commands::set_brain_config,
            commands::set_general_config,
            commands::set_capture_config,
            commands::set_index_config,
            commands::set_appearance_config,
            commands::set_daily_config,
            commands::set_git_config,
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
            commands::copilot_status,
            commands::copilot_probe_agents,
            commands::copilot_disclosure,
            commands::set_copilot_config,
            commands::copilot_activate,
            commands::copilot_models,
            commands::copilot_set_model,
            commands::copilot_send,
            commands::copilot_cancel,
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
            // Quitting mid-turn must not leave the agent's process group
            // running with vault access: kill the whole stored group.
            tauri::RunEvent::ExitRequested { .. } => {
                if let Some(pgid) = handle.state::<AppState>().copilot_active.lock().take() {
                    crate::copilot::kill_turn(pgid);
                }
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
/// re-indexes the file, broadcasts `memos:changed` so every window can
/// refresh its query cache, and queues a git auto-commit (non-blocking —
/// the commit itself runs on the consumer thread, never here). The handle
/// lives in `AppState` for the app lifetime — dropping it would stop watching.
fn spawn_watcher(state: &AppState, handle: &AppHandle) {
    let vault_path = state.vault.paths().vault.clone();
    let debounce =
        Duration::from_millis(state.vault.with_config(|c| c.index.watcher_debounce_ms) as u64);
    let emit_handle = handle.clone();
    let git_tx = state.git_tx.clone();
    let on_change: oximemo_core::watcher::OnChange = Arc::new(move |path| {
        // Saved-query edits are not note content (query views spec §3):
        // broadcast bases:changed and skip reindex + git enqueue
        // entirely. Belt-and-suspenders only: this throwaway Vault does
        // NOT drop the running app's caches — the base and result
        // caches are content/mtime-keyed and self-heal (a changed
        // .query is a natural miss on the next run_base), so the
        // event, not this call, is what refreshes the UI.
        if path.extension().is_some_and(|e| e == "query") {
            if let Ok(v) = oximemo_core::Vault::open(Some(&vault_path)) {
                v.invalidate_base_caches();
            }
            let _ = emit_handle.emit("bases:changed", ());
            return;
        }
        if let Ok(v) = oximemo_core::Vault::open(Some(&vault_path)) {
            v.reindex_path(&path);
        }
        let _ = emit_handle.emit("memos:changed", ());
        // Mechanical safety net: hand the settled path to the git consumer.
        // try_send semantics — a full channel drops, and the next settle
        // (or the next boot's reconcile pass) re-commits. Non-blocking by
        // construction so the capture path budget is untouched.
        let _ = git_tx.send(path);
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

/// Background consumer for vault git auto-commits. Receives settled paths
/// from the watcher thread and performs the gix commit/remove off every
/// interactive path. Coalesces bursts: after a message arrives, drain any
/// queued siblings for 250 ms so a save-burst produces one commit per file
/// state, not per event. `commit_file`'s content dedup makes unchanged

/// Background consumer for vault git auto-commits. Receives settled paths
/// from the watcher thread and performs the gix commit/remove off every
/// interactive path. Coalesces bursts: after a message arrives, drain any
/// queued siblings for 250 ms so a save-burst produces one commit per file
/// state, not per event. `commit_file`'s content dedup makes unchanged
/// re-commits no-ops.
///
/// The toggle is **live-read** on every message: `vault.with_config(|c|
/// c.git.auto_commit)` is consulted so flipping the Settings → Storage
/// switch takes effect on the next settled event (no restart). This
/// mirrors how `brain_gather`, `brain_status`, and `open_daily` read
/// their section on every call — there is no cached config handle here
/// either. `git.is_enabled()` independently gates on construction-time
/// state (foreign / corrupt repos degrade to disabled; not user-toggle).
fn spawn_git_consumer(
    git: Arc<oxi_vault_git::GitLayer>,
    vault: Arc<oximemo_core::Vault>,
    vault_root: PathBuf,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<PathBuf>,
) {
    std::thread::spawn(move || {
        while let Some(path) = rx.blocking_recv() {
            // Live-read the user's auto_commit toggle (analogous to how
            // `brain_gather` re-reads `c.brain` on every call). Toggling
            // OFF in Settings stops the next commit immediately; toggling
            // ON allows the next one. `git.is_enabled()` still gates the
            // construction-time disabled state (foreign / corrupt repo).
            let auto = vault.with_config(|c| c.git.auto_commit);
            if !auto || !git.is_enabled() {
                // NOTE: the dropped fs-event is gone — there is no
                // reconcile-on-re-enable pass. Toggling auto_commit back
                // ON only covers edits made after that point; edits made
                // while it was OFF are never retroactively committed.
                continue;
            }
            // Coalesce the burst behind this event.
            std::thread::sleep(Duration::from_millis(250));
            let mut batch = vec![path];
            while let Ok(next) = rx.try_recv() {
                batch.push(next);
            }
            for path in batch {
                // The git layer expects tree-key paths relative to its
                // root. On macOS (the only supported target today) the
                // vault IS the git root — strip the vault prefix to get
                // the tree key directly. `oxi_vault_git::rel_path` is
                // designed for the legacy nested-layout case and falls
                // back to the input string when `git_root == kb_root`,
                // which would re-emit the absolute path. Do the explicit
                // strip here; revisit if Windows / nested layouts ever ship.
                let rel = match path.strip_prefix(&vault_root) {
                    Ok(p) => p.to_string_lossy().replace(std::path::MAIN_SEPARATOR, "/"),
                    Err(_) => continue,
                };
                let exists = path.exists();
                let msg = if exists {
                    format!("vault: update {rel}")
                } else {
                    format!("vault: delete {rel}")
                };
                let result = if exists {
                    git.commit_file(&rel, &msg)
                } else {
                    git.remove_file(&rel, &msg)
                };
                if let Err(e) = result {
                    tracing::warn!(error = %e, %rel, "vault git commit failed");
                }
            }
        }
    });
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

    /// Resolve the brain endpoint with **ecosystem-canonical** space:
    /// `~/.oxi/config.toml [vault].space` wins over the vault-local
    /// `BrainConfig::space` (ECOSYSTEM.md §C5). All brain_* commands
    /// must use this constructor — they read the same space the daemon's
    /// `register_vault` (vault.rs:117) registered the watcher under. Using
    /// `from_brain` directly silently queries the wrong space when the
    /// operator sets the ecosystem override.
    fn from_vault_config(c: &oximemo_core::config::VaultConfig) -> Self {
        let home = std::env::var("HOME").unwrap_or_default();
        let space = oximemo_core::brain::resolve_space(std::path::Path::new(&home), &c.brain.space);
        Self {
            enabled: c.brain.enabled,
            socket: c.brain.socket.clone(),
            space,
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
    use oximemo_core::Vault;
    use oximemo_core::memo::{Cursor, MemoFilter, MemoId};
    use oximemo_core::base::{BasePage, BaseRow, BaseSource, EvalClockDto, GroupCount, RunBaseReq, SummaryValue};
    use std::collections::BTreeMap;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use oximemo_core::sync::ManifestRecord;
    use std::sync::Arc;
    use tauri::Manager;
    use tauri::{AppHandle, Emitter, State};
    use time::format_description::well_known::Rfc3339;

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

    /// Quick-capture entry — writes into the Inbox (`idea` preset)
    /// folder with root fallback. Identical shape to `create_memo`
    /// but with no `folder`/`format` params: the backend resolves
    /// the destination.
    #[tauri::command]
    pub fn create_capture(
        state: State<'_, AppState>,
        app: AppHandle,
        body: String,
    ) -> Result<oximemo_core::memo::NoteDto, String> {
        let memo = state.vault.create_capture(body).map_err(|e| e.to_string())?;
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

    // -- query views (design 2026-08-25) ----------------------------------

    /// mtime → whole milliseconds since the Unix epoch (pre-epoch → 0).
    pub fn systemtime_to_ms(t: SystemTime) -> u64 {
        t.duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    /// Wire milliseconds → `SystemTime` (the optimistic-concurrency guard).
    pub fn ms_to_systemtime(ms: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_millis(ms)
    }

    /// `run_base` result on the wire: outer fields camelCase per the
    /// reviewed types.ts contract; nested core types (`BaseRow`,
    /// `EvalClockDto`, expr `Value`) keep their own serde casing
    /// (snake_case `now_utc`/`local_offset_seconds`,
    /// `DurationSpec.calendar_months/fixed_millis`) — `rename_all`
    /// never propagates into nested types, which is exactly the
    /// reviewed TS shape.
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct BasePageDto {
        pub rows: Vec<BaseRow>,
        pub total: usize,
        pub group_counts: Option<Vec<GroupCount>>,
        pub summaries: Option<BTreeMap<String, SummaryValue>>,
        pub clock: EvalClockDto,
        pub result_key: String,
        pub warnings: Vec<String>,
    }

    impl From<BasePage> for BasePageDto {
        fn from(p: BasePage) -> Self {
            Self {
                rows: p.rows,
                total: p.total,
                group_counts: p.group_counts,
                summaries: p.summaries,
                clock: p.clock,
                result_key: p.result_key,
                warnings: p.warnings,
            }
        }
    }

    /// One `.query` file for the sidebar list (mtime as wire millis).
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct BaseInfoDto {
        pub path: String,
        pub name: String,
        pub mtime_ms: u64,
        pub loadable: bool,
    }

    /// Raw `.query` text + the mtime guarding the next save.
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct LoadBaseDto {
        pub yaml: String,
        pub mtime_ms: u64,
    }

    /// `run_base` request on the wire (camelCase outer fields).
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct RunBaseReqDto {
        pub view_index: usize,
        pub offset: usize,
        pub limit: u32,
        pub group: Option<String>,
        pub now_ms: Option<i64>,
        pub local_offset_seconds: Option<i32>,
        pub include_group_counts: bool,
        pub include_summaries: bool,
        pub this_id: Option<String>,
    }

    impl RunBaseReqDto {
        pub fn into_core(self) -> Result<RunBaseReq, String> {
            Ok(RunBaseReq {
                view_index: self.view_index,
                offset: self.offset,
                limit: self.limit,
                group: self.group,
                now_ms: self.now_ms,
                local_offset_seconds: self.local_offset_seconds,
                include_group_counts: self.include_group_counts,
                include_summaries: self.include_summaries,
                this_id: match self.this_id {
                    Some(s) => Some(MemoId::parse(&s).map_err(|e| e.to_string())?),
                    None => None,
                },
            })
        }
    }

    /// `run_base` source on the wire: `Inline` carries raw YAML (plain
    /// strings, not nested YAML values), `Path` is vault-relative.
    /// Externally tagged like every Rust enum on this wire.
    #[derive(serde::Deserialize)]
    pub enum BaseSourceDto {
        Inline { yaml: String },
        Path(String),
    }

    impl BaseSourceDto {
        pub fn into_core(self) -> Result<BaseSource, String> {
            match self {
                BaseSourceDto::Inline { yaml } => Ok(BaseSource::Inline(
                    oximemo_core::base::parse_base(&yaml).map_err(|e| e.to_string())?,
                )),
                BaseSourceDto::Path(rel) => Ok(BaseSource::Path(rel)),
            }
        }
    }

    /// Observed property catalog entry (spec §3). Core names the kind
    /// list `kinds`; the spec's wire name `observedTypes` wins
    /// (Controller ruling) — mapped here, not renamed in core.
    #[derive(serde::Serialize)]
    pub struct PropInfoDto {
        pub key: String,
        #[serde(rename = "observedTypes")]
        pub kinds: Vec<String>,
        pub options: Vec<String>,
    }

    /// Execute one page of a base view (spec §3 pipeline; cache-aware).
    #[tauri::command]
    pub fn run_base(
        state: State<'_, AppState>,
        source: BaseSourceDto,
        req: RunBaseReqDto,
    ) -> Result<BasePageDto, String> {
        let source = source.into_core()?;
        let req = req.into_core()?;
        state
            .vault
            .run_base(&source, &req)
            .map(BasePageDto::from)
            .map_err(|e| e.to_string())
    }

    /// Every discoverable `.query` file. Non-loadable ones ride along
    /// with `loadable: false` so the sidebar can flag (⚠) and repair
    /// them instead of hiding.
    #[tauri::command]
    pub fn list_bases(state: State<'_, AppState>) -> Result<Vec<BaseInfoDto>, String> {
        Ok(state
            .vault
            .list_bases()
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|b| BaseInfoDto {
                path: b.path,
                name: b.name,
                mtime_ms: systemtime_to_ms(b.mtime),
                loadable: b.loadable,
            })
            .collect())
    }

    /// Raw `.query` text + current mtime (builder code-mode source of
    /// truth).
    #[tauri::command]
    pub fn load_base(state: State<'_, AppState>, path: String) -> Result<LoadBaseDto, String> {
        let (yaml, mtime) = state.vault.load_base_raw(&path).map_err(|e| e.to_string())?;
        Ok(LoadBaseDto {
            yaml,
            mtime_ms: systemtime_to_ms(mtime),
        })
    }

    /// Save (create or overwrite) a `.query` document. Core parses and
    /// validates first — an unparseable YAML never reaches disk. A
    /// mismatched `expected_mtime_ms` is the reload conflict. Returns
    /// the fresh mtime for the next save.
    #[tauri::command]
    pub fn save_base(
        state: State<'_, AppState>,
        path: String,
        yaml: String,
        expected_mtime_ms: Option<u64>,
    ) -> Result<LoadBaseDto, String> {
        state
            .vault
            .save_base(&path, &yaml, expected_mtime_ms.map(ms_to_systemtime))
            .map_err(|e| e.to_string())?;
        let (raw, mtime) = state.vault.load_base_raw(&path).map_err(|e| e.to_string())?;
        Ok(LoadBaseDto {
            yaml: raw,
            mtime_ms: systemtime_to_ms(mtime),
        })
    }

    /// Rename/move a `.query` file. Emits `bases:changed` so the
    /// sidebar re-lists; in-place saves ride the `.query` file watcher
    /// instead (already emits the same event).
    #[tauri::command]
    pub fn rename_base(
        state: State<'_, AppState>,
        app: AppHandle,
        from: String,
        to: String,
        expected_mtime_ms: Option<u64>,
    ) -> Result<(), String> {
        state
            .vault
            .rename_base(&from, &to, expected_mtime_ms.map(ms_to_systemtime))
            .map_err(|e| e.to_string())?;
        let _ = app.emit("bases:changed", ());
        Ok(())
    }

    /// Move a `.query` file into `.trash/_queries/`; returns the token
    /// `restore_base` consumes.
    #[tauri::command]
    pub fn trash_base(
        state: State<'_, AppState>,
        app: AppHandle,
        path: String,
    ) -> Result<String, String> {
        let token = state.vault.trash_base(&path).map_err(|e| e.to_string())?;
        let _ = app.emit("bases:changed", ());
        Ok(token)
    }

    /// Restore a trashed `.query`; returns the restored vault-relative
    /// path.
    #[tauri::command]
    pub fn restore_base(
        state: State<'_, AppState>,
        app: AppHandle,
        token: String,
    ) -> Result<String, String> {
        let rel = state.vault.restore_base(&token).map_err(|e| e.to_string())?;
        let _ = app.emit("bases:changed", ());
        Ok(rel)
    }

    /// Observed property catalog for the filter builder (spec §3).
    #[tauri::command]
    pub fn base_props(state: State<'_, AppState>) -> Result<Vec<PropInfoDto>, String> {
        Ok(state
            .vault
            .base_props()
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|p| PropInfoDto {
                key: p.key,
                kinds: p.kinds,
                options: p.options,
            })
            .collect())
    }

    /// The folder's property schema, or `null` in free-property mode.
    #[tauri::command]
    pub fn folder_schema(
        state: State<'_, AppState>,
        folder: String,
    ) -> Result<Option<oximemo_core::FolderSchema>, String> {
        state
            .vault
            .folder_schema(&folder)
            .map_err(|e| e.to_string())
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
            .with_config(|c| crate::BrainEndpointConf::from_vault_config(c));
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
            .with_config(|c| crate::BrainEndpointConf::from_vault_config(c));
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

    /// Occurrence-chain history of one note from the brain ledger
    /// (Consumption Contract 1.3): every revision the vault sync ingested,
    /// oldest first, full content. Daemon down → Err so the panel hides
    /// itself; the note editor is unaffected (C1). Mechanical undo is the
    /// local git layer's job — this is the semantic "how it evolved" view.
    #[tauri::command]
    pub async fn brain_history(
        state: State<'_, AppState>,
        path: String,
    ) -> Result<serde_json::Value, String> {
        let cfg = state
            .vault
            .with_config(|c| crate::BrainEndpointConf::from_vault_config(c));
        if !cfg.enabled {
            return Err("brain disabled in config".to_string());
        }
        let dir = state.vault.paths().vault.to_string_lossy().into_owned();
        let (mut client, _caps) = crate::brain_connect(&cfg)
            .await
            .map_err(|e| format!("brain offline: {e}"))?;
        let episodes = client
            .episodes_for_locator(&dir, &path, &cfg.space)
            .await
            .map_err(|e| format!("brain history failed: {e}"))?;
        serde_json::to_value(&episodes).map_err(|e| e.to_string())
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
            .with_config(|c| crate::BrainEndpointConf::from_vault_config(c));
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
        tokio::task::spawn_blocking(move || oximemo_metadata::search_books(&cfg, &query))
            .await
            .map_err(|e| e.to_string())
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
        tokio::task::spawn_blocking(move || oximemo_metadata::search_movies(&cfg, &query))
            .await
            .map_err(|e| e.to_string())
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
        if let (Some(url), false) = (&hit.url, memo.props.contains_key("source_url"))
            && schema.properties.contains_key("source_url")
        {
            sets.push((
                "source_url".into(),
                oximemo_core::PropValue::Str(url.clone()),
            ));
        }
        if let (Some(cover), false) = (&hit.cover_url, memo.props.contains_key("cover_url"))
            && schema.properties.contains_key("cover_url")
        {
            sets.push((
                "cover_url".into(),
                oximemo_core::PropValue::Str(cover.clone()),
            ));
        }
        if sets.is_empty() {
            return Ok(dto);
        }
        let memo = state
            .vault
            .update_note_with(
                mid,
                None,
                None,
                Some(oximemo_core::PropMutation {
                    sets,
                    removes: Vec::new(),
                }),
            )
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
    pub fn set_git_config(
        state: State<'_, AppState>,
        git: oximemo_core::config::GitConfig,
    ) -> Result<(), String> {
        state.vault.set_git_config(git).map_err(|e| e.to_string())
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

    // -- Copilot delegation (spec 2026-08-23) --------------------------------

    /// Panel visibility + activation state for the renderer.
    #[derive(serde::Serialize)]
    pub struct CopilotStatus {
        pub enabled: bool,
        /// True when an agent is activated (entry points become visible).
        pub activated: bool,
        pub agent: String,
        /// Human-facing name ("Oh My Pi"), for panel headers.
        pub agent_name: String,
        /// A turn is currently in flight.
        pub busy: bool,
    }

    #[tauri::command]
    pub fn copilot_status(state: State<'_, AppState>) -> Result<CopilotStatus, String> {
        let cfg = state.vault.with_config(|c| c.copilot.clone());
        Ok(CopilotStatus {
            enabled: cfg.enabled,
            activated: !cfg.agent.is_empty() && !cfg.executable.is_empty(),
            agent_name: crate::copilot::display_name(&cfg.agent).to_string(),
            agent: cfg.agent,
            busy: state.copilot_active.lock().is_some(),
        })
    }

    /// Discover agent CLIs on PATH. Never called from the startup path —
    /// the renderer invokes it on first panel open or settings entry
    /// (spec §6, acceptance criterion 2).
    #[tauri::command]
    pub async fn copilot_probe_agents() -> Result<Vec<crate::copilot::AgentCandidate>, String> {
        Ok(crate::copilot::probe_candidates().await)
    }

    /// Where the activated agent may send the user's data (spec §12).
    #[tauri::command]
    pub fn copilot_disclosure(agent: String) -> Result<crate::copilot::Disclosure, String> {
        Ok(crate::copilot::disclosure(&agent))
    }

    /// `[copilot]` section setter (mirrors `set_brain_config`).
    #[tauri::command]
    pub fn set_copilot_config(
        state: State<'_, AppState>,
        copilot: oximemo_core::config::CopilotConfig,
    ) -> Result<(), String> {
        state
            .vault
            .set_copilot_config(copilot)
            .map_err(|e| e.to_string())
    }

    /// Explicit activation (spec §6): validate that the executable still
    /// probes, then persist the verified absolute path. Returns the
    /// provider disclosure so the consent dialog can show it.
    #[tauri::command]
    pub async fn copilot_activate(
        state: State<'_, AppState>,
        agent: String,
        executable: String,
    ) -> Result<crate::copilot::Disclosure, String> {
        let supported = crate::copilot::KNOWN_AGENTS
            .iter()
            .any(|(id, _, _, ok)| *id == agent && *ok);
        if !supported {
            return Err(format!(
                "agent '{agent}' has no verified non-interactive adapter in this version"
            ));
        }
        let exe = std::path::PathBuf::from(&executable);
        if !exe.is_file() {
            return Err("executable not found — re-run detection".to_string());
        }
        // Re-probe at activation time: the stored probe result is a label,
        // not a trust boundary.
        if crate::copilot::probe_version(&exe).await.is_none() {
            return Err("executable did not answer --version within 3s".to_string());
        }
        let disc = crate::copilot::disclosure(&agent);
        let mut cfg = state.vault.with_config(|c| c.copilot.clone());
        cfg.agent = agent;
        cfg.executable = exe.display().to_string();
        cfg.exe_mtime_secs = std::fs::metadata(&exe)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        state
            .vault
            .set_copilot_config(cfg)
            .map_err(|e| e.to_string())?;
        Ok(disc)
    }

    #[derive(serde::Deserialize)]
    pub struct ActiveMemoArg {
        pub id: String,
        pub title: String,
        pub path: String,
        /// Text currently selected in the note editor, if any.
        pub selection: Option<String>,
    }

    /// A memo the user @-referenced in the composer (revision 2026-08-24).
    /// Facts for the context block's `referenced_memos` section.
    #[derive(serde::Deserialize)]
    pub struct MemoRefArg {
        pub id: String,
        pub title: String,
        pub path: String,
    }

    /// One selectable model for the panel picker.
    #[tauri::command]
    pub async fn copilot_models(
        state: State<'_, AppState>,
    ) -> Result<Vec<crate::copilot::ModelInfo>, String> {
        let cfg = state.vault.with_config(|c| c.copilot.clone());
        if cfg.agent.is_empty() || cfg.executable.is_empty() {
            return Err("copilot agent is not activated".to_string());
        }
        crate::copilot::list_models(&cfg.agent, std::path::Path::new(&cfg.executable)).await
    }

    /// Switch the durable default model. Only oxios needs this — its `run`
    /// has no per-turn model flag, so the picker edits `engine.default_model`
    /// via oxios's own comment-preserving `config set`. omp models are
    /// selected per turn with `--model` in `copilot_send`.
    #[tauri::command]
    pub async fn copilot_set_model(
        state: State<'_, AppState>,
        model: String,
    ) -> Result<crate::copilot::Disclosure, String> {
        let cfg = state.vault.with_config(|c| c.copilot.clone());
        if cfg.agent != "oxios" {
            return Err(format!(
                "agent '{}' selects its model per turn in the panel",
                cfg.agent
            ));
        }
        crate::copilot::oxios_set_default_model(std::path::Path::new(&cfg.executable), &model)
            .await?;
        Ok(crate::copilot::disclosure(&cfg.agent))
    }

    /// One copilot turn result. `changed` lists vault changes observed
    /// during the turn — causality is deliberately not claimed (spec §9.4).
    #[derive(serde::Serialize)]
    pub struct TurnResult {
        pub response: String,
        pub session_id: Option<String>,
        pub exit_code: Option<i32>,
        /// Signal that terminated the agent (user cancel / external kill).
        pub signal: Option<i32>,
        pub stderr: String,
        pub timed_out: bool,
        pub changed: Vec<crate::copilot::ChangedNote>,
        pub duration_ms: u64,
        /// Model/provider ACTUALLY used this turn, when the agent's output
        /// discloses it (omp's JSONL stream and claude's modelUsage do;
        /// oxios's does not).
        pub model: Option<String>,
        pub provider: Option<String>,
        /// Tool requests the agent's OWN permission policy denied this
        /// turn (claude's result JSON discloses them). None = not
        /// measurable for this agent.
        pub denials: Option<Vec<String>>,
    }

    /// Full-vault manifest walk; heavy (redb + per-file read/hash), so
    /// callers run it via `spawn_blocking` to keep the async runtime free.
    fn manifest_snapshot(vault: Arc<Vault>) -> Result<Vec<(String, String, bool)>, String> {
        vault
            .export_manifest(None)
            .map(|recs| {
                recs.into_iter()
                    .map(|r| (r.id.0.to_string(), r.hash.0, r.deleted))
                    .collect()
            })
            .map_err(|e| format!("manifest snapshot failed: {e}"))
    }

    #[tauri::command]
    pub async fn copilot_send(
        app: AppHandle,
        state: State<'_, AppState>,
        message: String,
        active_memo: Option<ActiveMemoArg>,
        referenced: Option<Vec<MemoRefArg>>,
        session: Option<String>,
        model: Option<String>,
    ) -> Result<TurnResult, String> {
        let cfg = state.vault.with_config(|c| c.copilot.clone());
        if !cfg.enabled || cfg.agent.is_empty() || cfg.executable.is_empty() {
            return Err("copilot agent is not activated".to_string());
        }
        let exe = std::path::PathBuf::from(&cfg.executable);
        if !exe.is_file() {
            return Err(
                "activated agent executable is missing — re-activate it in Settings".to_string(),
            );
        }
        // Binary drift (spec §6.4): a replaced/upgraded executable must be
        // re-activated, never silently executed on the old stamp.
        if cfg.exe_mtime_secs != 0 {
            let now = std::fs::metadata(&exe)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            if now != 0 && now != cfg.exe_mtime_secs {
                return Err(
                    "agent executable changed since activation — re-activate it in Settings"
                        .to_string(),
                );
            }
        }
        // Per-turn model (omp only). The id came from the agent's own
        // listing, but re-validate: it goes straight into a subprocess argv.
        if let Some(m) = model.as_deref() {
            if !crate::copilot::valid_model_id(m) {
                return Err("invalid model id".to_string());
            }
        }
        // Atomically claim the busy slot BEFORE any prep work: the old
        // check-then-spawn window let two concurrent sends both pass.
        // Sentinel 0 means "claimed, pgid pending" — `kill_turn` ignores
        // it, and the guard clears the slot on EVERY exit path.
        struct BusyGuard<'a>(&'a parking_lot::Mutex<Option<i32>>);
        impl Drop for BusyGuard<'_> {
            fn drop(&mut self) {
                *self.0.lock() = None;
            }
        }
        {
            let mut slot = state.copilot_active.lock();
            if slot.is_some() {
                return Err("a copilot turn is already running".to_string());
            }
            *slot = Some(0);
        }
        let _busy_guard = BusyGuard(&state.copilot_active);
        let vault_root = state.vault.paths().vault.clone();
        let Some(cli) = bundled_cli_path() else {
            return Err("could not locate the bundled CLI".to_string());
        };
        let skill = app
            .path()
            .resolve(
                "skills/oximemo/SKILL.md",
                tauri::path::BaseDirectory::Resource,
            )
            .map_err(|e| format!("SKILL.md is not bundled: {e}"))?;
        let active = active_memo.as_ref().map(|m| crate::copilot::ActiveMemo {
            id: m.id.clone(),
            title: m.title.clone(),
            path: m.path.clone(),
            selection: m.selection.clone(),
        });
        let refs: Vec<crate::copilot::RefMemo> = referenced
            .unwrap_or_default()
            .iter()
            .map(|r| crate::copilot::RefMemo {
                id: r.id.clone(),
                title: r.title.clone(),
                path: r.path.clone(),
            })
            .collect();
        // The active memo is authoritative for itself; dedupe + cap happen
        // in one place (unit-tested in copilot::tests).
        let refs = crate::copilot::dedupe_references(active.as_ref(), &refs);
        // Folder-map facts (design 2026-08-24 §2.4): computed off the
        // async path (disk walk + schema cache); failures degrade to
        // omission inside folder_facts and never block the turn.
        let map = {
            let v = state.vault.clone();
            tokio::task::spawn_blocking(move || crate::copilot::folder_facts(&v))
                .await
                .map_err(|e| format!("folder facts join: {e}"))?
        };
        let ctx =
            crate::copilot::build_context(&vault_root, &cli, &skill, &map, active.as_ref(), &refs);
        // Adapter dispatch (spec §5): argv shape, cwd, and stdout dialect
        // are per-agent facts. oxios/omp/claude/codex get the context on
        // stdin; oxicode does not read stdin as context (verified
        // 0.76.0) so its prompt embeds the block. Everything except
        // oxios runs with the vault as cwd so file tools land in the
        // right tree. Spec §11: no permission/sandbox flags anywhere.
        let (args, cwd): (Vec<String>, Option<&std::path::Path>) = match cfg.agent.as_str() {
            "oxios" => (
                crate::copilot::oxios_args(session.as_deref(), &message),
                None,
            ),
            "omp" => (
                crate::copilot::omp_args(session.as_deref(), model.as_deref(), &message),
                Some(vault_root.as_path()),
            ),
            "claude" => (
                crate::copilot::claude_args(session.as_deref(), model.as_deref(), &message),
                Some(vault_root.as_path()),
            ),
            "codex" => (
                crate::copilot::codex_args(session.as_deref(), model.as_deref(), &message),
                Some(vault_root.as_path()),
            ),
            "oxicode" => {
                let prompt = crate::copilot::oxicode_prompt(&ctx, &message);
                (
                    crate::copilot::oxicode_args(model.as_deref(), &prompt),
                    Some(vault_root.as_path()),
                )
            }
            other => return Err(format!("no copilot adapter for '{other}'")),
        };
        // oxicode ignores stdin; skip the pipe write entirely.
        let stdin_for_agent = if cfg.agent == "oxicode" {
            ""
        } else {
            ctx.as_str()
        };
        let before = {
            let v = state.vault.clone();
            tokio::task::spawn_blocking(move || manifest_snapshot(v))
                .await
                .map_err(|e| format!("snapshot join: {e}"))??
        };
        let started = std::time::Instant::now();
        let outcome = {
            let busy = &state.copilot_active;
            let out = crate::copilot::run_agent_process(
                &exe,
                &args,
                &stdin_for_agent,
                cwd,
                cfg.timeout_secs,
                move |pgid| {
                    *busy.lock() = Some(pgid);
                },
            )
            .await;
            out?
        };
        let duration_ms = started.elapsed().as_millis() as u64;
        // Raw file writes from the agent land in the index only after the
        // watcher's 300 ms debounce settles — wait it out or creations
        // made moments before exit would be silently omitted.
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        let after = {
            let v = state.vault.clone();
            tokio::task::spawn_blocking(move || manifest_snapshot(v))
                .await
                .map_err(|e| format!("snapshot join: {e}"))?
                // An after-snapshot failure must NOT report the whole
                // vault as deleted: degrade to "no observable changes".
                .unwrap_or_else(|_| before.clone())
        };
        let changed = crate::copilot::diff_manifests(&before, &after);
        if !changed.is_empty() {
            // Refresh the grid: the watcher also reacts, but the panel
            // result lands the moment the process exits.
            let _ = app.emit("memos:changed", ());
        }
        // Response parsing is adapter-dialect work: oxios prints one JSON
        // object, omp/claude/codex/oxicode print event streams. omp and
        // claude also disclose the model/provider ACTUALLY used this
        // turn (spec §12 — measured, not configured); claude additionally
        // discloses permission_denials (its own policy blocking writes).
        let (response, session_id, model, provider, denials) = if outcome.timed_out {
            (String::new(), None, None, None, None)
        } else {
            match cfg.agent.as_str() {
                "omp" => {
                    let t = crate::copilot::parse_omp_jsonl(&outcome.stdout);
                    (t.response, t.session_id, t.model, t.provider, None)
                }
                "claude" => {
                    let t = crate::copilot::parse_claude_result(&outcome.stdout);
                    let denials = if t.denied.is_empty() {
                        None
                    } else {
                        Some(t.denied)
                    };
                    (t.response, t.session_id, t.model, t.provider, denials)
                }
                "codex" => {
                    let t = crate::copilot::parse_codex_jsonl(&outcome.stdout);
                    (t.response, t.session_id, None, None, None)
                }
                "oxicode" => (
                    crate::copilot::parse_oxicode_jsonl(&outcome.stdout),
                    None,
                    None,
                    None,
                    None,
                ),
                _ => {
                    let (r, s) = crate::copilot::parse_agent_json(&outcome.stdout);
                    (r, s, None, None, None)
                }
            }
        };
        Ok(TurnResult {
            response,
            session_id,
            exit_code: outcome.exit_code,
            signal: outcome.signal,
            stderr: outcome.stderr,
            timed_out: outcome.timed_out,
            changed,
            duration_ms,
            model,
            provider,
            denials,
        })
    }

    /// Kill the in-flight turn's whole process tree (spec §8).
    #[tauri::command]
    pub fn copilot_cancel(state: State<'_, AppState>) -> Result<bool, String> {
        let pgid = state.copilot_active.lock().take();
        match pgid {
            // Sentinel: claimed but not yet spawned — nothing to kill,
            // so report "not cancellable" rather than a false success.
            Some(0) => {
                *state.copilot_active.lock() = Some(0);
                Ok(false)
            }
            Some(p) => {
                crate::copilot::kill_turn(p);
                Ok(true)
            }
            None => Ok(false),
        }
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


    // --- query views (design 2026-08-25) wire contract -----------------------
    // The DTOs below mirror apps/desktop/src/lib/types.ts — that file is
    // the reviewed contract: outer command DTOs camelCase, nested core
    // types (BaseRow/MemoSummary, the EvalClockDto clock, expr Values)
    // snake_case.

    use super::commands::{
        BaseInfoDto, BasePageDto, BaseSourceDto, LoadBaseDto, PropInfoDto, RunBaseReqDto,
    };
    use oximemo_core::base::{BaseCell, BasePage, BaseRow, EvalClockDto, GroupCount, SummaryValue};
    use oximemo_core::expr::value::{DurationSpec, Value};
    use oximemo_core::{MemoHash, MemoId, MemoSummary};

    fn summary_fixture() -> MemoSummary {
        MemoSummary {
            id: MemoId::now(),
            created_at: time::OffsetDateTime::now_utc(),
            updated_at: time::OffsetDateTime::now_utc(),
            hash: MemoHash::new("cafe01"),
            favorite: false,
            title: Some("Wire contract".into()),
            path: "inbox/wire.md".into(),
            tags: vec!["draft".into()],
            props: Default::default(),
            preview: "preview".into(),
            deleted: false,
        }
    }

    fn page_fixture() -> BasePage {
        BasePage {
            rows: vec![BaseRow {
                summary: summary_fixture(),
                folder: "inbox".into(),
                format: "markdown".into(),
                cells: vec![
                    BaseCell {
                        value: Some(Value::Duration(DurationSpec {
                            calendar_months: 1,
                            fixed_millis: 500,
                        })),
                        error: None,
                    },
                    BaseCell {
                        value: Some(Value::Date(
                            time::OffsetDateTime::parse(
                                "2025-04-01T13:05:09+09:00",
                                &time::format_description::well_known::Rfc3339,
                            )
                            .unwrap(),
                        )),
                        error: None,
                    },
                    BaseCell {
                        value: None,
                        error: Some("division by zero".into()),
                    },
                ],
            }],
            total: 1,
            group_counts: Some(vec![GroupCount {
                key: "reading".into(),
                count: 1,
            }]),
            summaries: Some(
                vec![(
                    "note.rating".to_string(),
                    SummaryValue {
                        name: "Average".into(),
                        value: Value::Num(4.5),
                    },
                )]
                .into_iter()
                .collect(),
            ),
            clock: EvalClockDto {
                now_utc: "2026-08-25T00:00:00Z".into(),
                local_offset_seconds: 32400,
            },
            result_key: "b3:abc".into(),
            warnings: vec![],
        }
    }

    /// `RunBaseReqDto` reads the camelCase wire shape types.ts sends and
    /// maps losslessly onto the core `RunBaseReq` (incl. `thisId` → MemoId).
    #[test]
    fn run_base_req_dto_reads_camel_case_wire() {
        let json = serde_json::json!({
            "viewIndex": 1,
            "offset": 40,
            "limit": 20,
            "group": "reading",
            "nowMs": 1756084800000_i64,
            "localOffsetSeconds": 32400,
            "includeGroupCounts": true,
            "includeSummaries": false,
            "thisId": null
        });
        let dto: RunBaseReqDto = serde_json::from_value(json).expect("camelCase wire must parse");
        assert_eq!(dto.view_index, 1);
        assert_eq!(dto.offset, 40);
        assert_eq!(dto.limit, 20);
        assert_eq!(dto.group.as_deref(), Some("reading"));
        assert_eq!(dto.now_ms, Some(1756084800000));
        assert_eq!(dto.local_offset_seconds, Some(32400));
        assert!(dto.include_group_counts);
        assert!(!dto.include_summaries);
        assert_eq!(dto.this_id, None);

        let core = dto.into_core().expect("core req");
        assert_eq!(core.view_index, 1);
        assert_eq!(core.group.as_deref(), Some("reading"));
        assert_eq!(core.now_ms, Some(1756084800000));
        assert_eq!(core.local_offset_seconds, Some(32400));
        assert!(core.include_group_counts);
        assert!(!core.include_summaries);
        assert!(core.this_id.is_none());

        // A present `thisId` must parse into a MemoId, not pass through raw.
        let id = MemoId::now();
        let json = serde_json::json!({
            "viewIndex": 0, "offset": 0, "limit": 50, "group": null,
            "nowMs": null, "localOffsetSeconds": null,
            "includeGroupCounts": false, "includeSummaries": false,
            "thisId": id.to_string()
        });
        let dto: RunBaseReqDto = serde_json::from_value(json).expect("parse");
        assert_eq!(dto.into_core().expect("core").this_id, Some(id));
        assert!(MemoId::parse("not-a-uuid").is_err(), "sanity: bad id fails");
    }

    /// `BasePageDto`: outer fields camelCase (`groupCounts`, `resultKey`),
    /// nested core types keep their snake_case serde (`clock.now_utc`,
    /// `clock.local_offset_seconds`, `summary.created_at`,
    /// `Duration.calendar_months/fixed_millis`) — exactly types.ts.
    #[test]
    fn base_page_dto_wire_shape_camel_outer_snake_nested() {
        let json = serde_json::to_value(BasePageDto::from(page_fixture())).unwrap();
        let obj = json.as_object().expect("object");
        let mut keys: Vec<&str> = obj.keys().map(|k| k.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec!["clock", "groupCounts", "resultKey", "rows", "summaries", "total", "warnings"]
        );

        assert_eq!(json["total"], serde_json::json!(1));
        assert_eq!(json["resultKey"], serde_json::json!("b3:abc"));
        assert_eq!(json["clock"]["now_utc"], serde_json::json!("2026-08-25T00:00:00Z"));
        assert_eq!(json["clock"]["local_offset_seconds"], serde_json::json!(32400));
        assert_eq!(json["groupCounts"][0]["key"], serde_json::json!("reading"));
        assert_eq!(json["groupCounts"][0]["count"], serde_json::json!(1));
        assert_eq!(json["summaries"]["note.rating"]["name"], serde_json::json!("Average"));
        assert_eq!(json["summaries"]["note.rating"]["value"]["Num"], serde_json::json!(4.5));

        let row = &json["rows"][0];
        assert_eq!(row["folder"], serde_json::json!("inbox"));
        assert_eq!(row["format"], serde_json::json!("markdown"));
        // Nested MemoSummary stays snake_case (created_at), matching the
        // long-standing MemoSummary wire style.
        assert!(row["summary"].get("created_at").is_some(), "summary.created_at");
        assert_eq!(row["summary"]["path"], serde_json::json!("inbox/wire.md"));
        // Duration cells: externally tagged Value with snake_case fields.
        assert_eq!(
            row["cells"][0]["value"]["Duration"]["calendar_months"],
            serde_json::json!(1)
        );
        assert_eq!(
            row["cells"][0]["value"]["Duration"]["fixed_millis"],
            serde_json::json!(500)
        );
        // Date cells ride the wire as RFC 3339 strings — the SAME
        // single format as clock.now_utc (types.ts documents this
        // contract; the old default serde form
        // `2025-04-01 13:05:09.0 +09:00:00` is gone).
        assert_eq!(
            row["cells"][1]["value"]["Date"],
            serde_json::json!("2025-04-01T13:05:09+09:00")
        );
        // Error cells carry `error` + JSON null value (per-cell ⚠ tooltip).
        assert_eq!(row["cells"][2]["value"], serde_json::Value::Null);
        assert_eq!(row["cells"][2]["error"], serde_json::json!("division by zero"));
    }

    /// `BaseSourceDto` is externally tagged on the wire; `Inline` carries
    /// raw YAML that `into_core` parses via core `parse_base`.
    #[test]
    fn base_source_dto_externally_tagged_inline_parses_yaml() {
        let dto: BaseSourceDto = serde_json::from_value(serde_json::json!({
            "Inline": { "yaml": "filters: 'true == true'\n" }
        }))
        .expect("Inline wire shape");
        match dto.into_core().expect("parse inline yaml") {
            oximemo_core::base::BaseSource::Inline(def) => {
                assert!(def.filters.is_some(), "yaml actually parsed");
            }
            other => panic!("expected Inline, got {other:?}"),
        }

        let dto: BaseSourceDto =
            serde_json::from_value(serde_json::json!({ "Path": "queries/all.query" }))
                .expect("Path wire shape");
        assert!(matches!(
            dto.into_core().expect("path"),
            oximemo_core::base::BaseSource::Path(p) if p == "queries/all.query"
        ));

        // Unparseable inline YAML surfaces the core error string.
        let dto: BaseSourceDto = serde_json::from_value(serde_json::json!({
            "Inline": { "yaml": "views: 3\n" }
        }))
        .unwrap();
        assert!(dto.into_core().is_err(), "bad yaml must fail");
    }

    /// `base_props` wire field is `observedTypes` (spec §3; core names it
    /// `kinds`) — the Controller ruling maps, not renames, the core field.
    #[test]
    fn prop_info_dto_field_is_observed_types() {
        let dto = PropInfoDto {
            key: "status".into(),
            kinds: vec!["select".into()],
            options: vec!["reading".into(), "done".into()],
        };
        let json = serde_json::to_value(&dto).unwrap();
        assert_eq!(json["key"], serde_json::json!("status"));
        assert_eq!(json["observedTypes"], serde_json::json!(["select"]));
        assert_eq!(json["options"], serde_json::json!(["reading", "done"]));
        assert!(json.get("kinds").is_none(), "core field name must not leak");
    }

    /// `list_bases`/`load_base` expose the mtime as `mtimeMs` milliseconds.
    #[test]
    fn base_info_and_load_dto_expose_mtime_ms() {
        let info = serde_json::to_value(&BaseInfoDto {
            path: "queries/all.query".into(),
            name: "all".into(),
            mtime_ms: 1_756_084_800_000,
            loadable: true,
        })
        .unwrap();
        let mut keys: Vec<&str> = info.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["loadable", "mtimeMs", "name", "path"]);
        assert_eq!(info["mtimeMs"], serde_json::json!(1_756_084_800_000_u64));

        let load = serde_json::to_value(&LoadBaseDto {
            yaml: "views: []\n".into(),
            mtime_ms: 42,
        })
        .unwrap();
        assert_eq!(load["yaml"], serde_json::json!("views: []\n"));
        assert_eq!(load["mtimeMs"], serde_json::json!(42));
    }

    /// mtime ↔ millis helpers round-trip exactly (they guard every save).
    #[test]
    fn systemtime_ms_helpers_roundtrip() {
        use super::commands::{ms_to_systemtime, systemtime_to_ms};
        let ms = 1_756_084_800_123_u64;
        assert_eq!(systemtime_to_ms(ms_to_systemtime(ms)), ms);
        // Pre-epoch clamp: SystemTime before UNIX_EPOCH maps to 0, never panics.
        assert_eq!(systemtime_to_ms(std::time::UNIX_EPOCH), 0);
    }

    /// The git auto-commit consumer: a settled path under the vault must
    /// land as a commit; a deleted path must land as a removal. Drives the
    /// REAL `spawn_git_consumer` against a REAL `GitLayer` on disk.
    /// The git auto-commit consumer:
    ///   1. drives the REAL `spawn_git_consumer` against a REAL `GitLayer`
    ///      on disk;
    ///   2. passes a REAL `Vault` handle so the consumer's live
    ///      `c.git.auto_commit` read is exercised;
    ///   3. asserts that toggling `auto_commit` off in the live config

    ///      stops the next commit immediately (C1 regression guard).
    #[test]
    fn git_consumer_commits_and_respects_toggle() {
        let dir = tempfile::tempdir().unwrap();
        let vault_path = dir.path().join("vault");
        std::fs::create_dir_all(&vault_path).unwrap();
        let vault = std::sync::Arc::new(oximemo_core::Vault::open(Some(&vault_path)).unwrap());
        vault.ensure_initialized().unwrap();
        // Default `[git].auto_commit = true`.
        let git = std::sync::Arc::new(
            oxi_vault_git::GitLayer::new_for_vault(vault.paths().vault.clone(), true, false)
                .unwrap(),
        );
        assert!(git.is_enabled(), "fresh vault repo must be enabled");

        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<std::path::PathBuf>();
        super::spawn_git_consumer(git.clone(), vault.clone(), vault.paths().vault.clone(), rx);

        let deadline = || std::time::Instant::now() + std::time::Duration::from_secs(10);
        let poll = |msg: &str, f: &dyn Fn() -> bool| -> bool {
            let d = deadline();
            while !f() {
                assert!(std::time::Instant::now() < d, "{msg}");
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            true
        };

        // Create → commit lands (toggle is ON).
        let note = vault.paths().vault.join("notes/hello.md");
        std::fs::create_dir_all(note.parent().unwrap()).unwrap();
        std::fs::write(&note, "# hello\n").unwrap();
        tx.send(note.clone()).unwrap();
        poll("create commit never landed", &|| {
            !git.log_for_file("notes/hello.md", 10).unwrap().is_empty()
        });

        // Toggle auto_commit OFF at runtime.
        vault
            .set_git_config(oximemo_core::config::GitConfig {
                auto_commit: false,
                adopt_foreign_repo: false,
            })
            .unwrap();

        // Edit the same note while toggle is OFF.
        std::fs::write(&note, "# hello v2\n").unwrap();
        tx.send(note.clone()).unwrap();
        // Wait long enough for the consumer to drain past the 250 ms burst
        // window — if the toggle were a no-op (C1 regression), a fresh
        let log = git.log_for_file("notes/hello.md", 10).unwrap();
        // Filter marker commits so the assertion is stable across crate
        // versions that may add bookkeeping commits alongside user edits.
        let user_commits: Vec<_> = log
            .iter()
            .filter(|e| e.message.starts_with("vault:"))
            .collect();
        assert_eq!(
            user_commits.len(),
            1,
            "toggle OFF must drop the v2 edit; saw {user_commits:?}"
        );
        assert!(
            user_commits[0].message.contains("update notes/hello.md"),
            "unexpected surviving commit message: {}",
            user_commits[0].message
        );

        // Toggle ON again → the next edit commits.
        vault
            .set_git_config(oximemo_core::config::GitConfig {
                auto_commit: true,
                adopt_foreign_repo: false,
            })
            .unwrap();
        std::fs::write(&note, "# hello v3\n").unwrap();
        tx.send(note.clone()).unwrap();
        poll("second commit never landed after toggle ON", &|| {
            git.log_for_file("notes/hello.md", 10).unwrap().len() >= 2
        });
    }

    /// The git auto-commit consumer produces a removal commit when the
    /// file disappears from disk. `log_for_file` only lists commits where
    /// the path still exists in the tree, so the delete commit is
    /// asserted on the full repo log (`log`).
    #[test]
    fn git_consumer_removal_commit_lands() {
        let dir = tempfile::tempdir().unwrap();
        let vault_path = dir.path().join("vault");
        std::fs::create_dir_all(&vault_path).unwrap();
        let vault = std::sync::Arc::new(oximemo_core::Vault::open(Some(&vault_path)).unwrap());
        vault.ensure_initialized().unwrap();
        let git = std::sync::Arc::new(
            oxi_vault_git::GitLayer::new_for_vault(vault.paths().vault.clone(), true, false)
                .unwrap(),
        );

        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<std::path::PathBuf>();
        super::spawn_git_consumer(git.clone(), vault.clone(), vault.paths().vault.clone(), rx);

        let note = vault.paths().vault.join("notes/hello.md");
        std::fs::create_dir_all(note.parent().unwrap()).unwrap();
        std::fs::write(&note, "# hello\n").unwrap();
        tx.send(note.clone()).unwrap();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let log = git.log_for_file("notes/hello.md", 10).unwrap();
            if !log.is_empty() {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "create commit never landed"
            );
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        std::fs::remove_file(&note).unwrap();
        tx.send(note.clone()).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let log = git.log(5).unwrap();
            let removed = log
                .first()
                .is_some_and(|e| e.message.contains("delete notes/hello.md"));
            if removed {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "removal commit never landed; log: {log:?}"
            );
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }
}
