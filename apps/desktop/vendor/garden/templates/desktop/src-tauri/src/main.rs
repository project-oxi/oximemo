#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use tauri::Manager;

#[tauri::command]
fn open_settings(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") {
        window.unminimize().map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let builder = tauri::WebviewWindowBuilder::new(
        &app,
        "settings",
        tauri::WebviewUrl::App("index.html?view=settings".into()),
    )
    .title("Garden")
    .inner_size(860.0, 620.0)
    .min_inner_size(640.0, 440.0)
    .decorations(false);
    // NSWindow owns corner geometry, shadow, fullscreen behavior and traffic lights.
    #[cfg(target_os = "macos")]
    let builder = builder.decorations(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(14.0, 20.0));
    builder.build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The endpoint is app-owned; renderer input cannot select arbitrary sockets.
#[tauri::command]
fn daemon_health() -> Result<serde_json::Value, String> {
    let hello = daemon_request("handshake")?;
    if hello.get("protocol").and_then(|v| v.as_str()) != Some("garden-daemon/1") {
        return Err("Unsupported daemon protocol".into());
    }
    let health = daemon_request("health")?;
    if health.get("status").and_then(|v| v.as_str()) != Some("ok") {
        return Err("Daemon health is not ok".into());
    }
    Ok(health)
}

#[cfg(unix)]
fn daemon_request(method: &str) -> Result<serde_json::Value, String> {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::os::unix::net::UnixStream;
    let path =
        std::env::var("GARDEN_DAEMON_SOCKET").map_err(|_| "Daemon endpoint is not configured")?;
    let mut stream = UnixStream::connect(path).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(2)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(std::time::Duration::from_secs(2)))
        .map_err(|e| e.to_string())?;
    let id = format!("desktop-{method}");
    let request = serde_json::json!({"id": id, "method": method, "params": {}});
    writeln!(stream, "{request}").map_err(|e| e.to_string())?;
    let mut line = String::new();
    BufReader::new(stream)
        .take(1048577)
        .read_line(&mut line)
        .map_err(|e| e.to_string())?;
    if line.len() > 1048576 || !line.ends_with('\n') {
        return Err("Invalid daemon frame".into());
    }
    let reply: serde_json::Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
    if reply.get("id").and_then(|v| v.as_str()) != Some(&id)
        || reply.get("ok").and_then(|v| v.as_bool()) != Some(true)
    {
        return Err("Daemon rejected request or returned mismatched response".into());
    }
    reply
        .get("result")
        .cloned()
        .ok_or_else(|| "Missing daemon result".into())
}
#[cfg(not(unix))]
fn daemon_request(_method: &str) -> Result<serde_json::Value, String> {
    Err("garden v0 daemon transport requires a Unix host".into())
}

fn main() {
    if std::env::args().any(|arg| arg == "--daemon-probe") {
        match daemon_health() {
            Ok(health) => println!("{health}"),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        return;
    }
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![open_settings, daemon_health])
        .run(tauri::generate_context!())
        .expect("desktop runtime failed");
}
