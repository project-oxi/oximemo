//! Tauri 2 desktop app entry point. The app hosts:
//! - A "main" window with the card grid (React).
//! - A "capture" overlay window (positioned off-screen at startup for warm-up).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Windows GUI launches carry no `HOME`; every home lookup in the app
    // (vault, session sources, copilot) reads it, so mirror USERPROFILE once
    // here before any thread starts.
    #[cfg(windows)]
    if std::env::var_os("HOME").is_none_or(|h| h.is_empty())
        && let Some(profile) = std::env::var_os("USERPROFILE")
    {
        unsafe { std::env::set_var("HOME", profile) };
    }
    oximemo_desktop::run();
}
