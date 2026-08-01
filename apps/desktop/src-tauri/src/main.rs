//! Tauri 2 desktop app entry point. The app hosts:
//! - A "main" window with the card grid (React).
//! - A "capture" overlay window (positioned off-screen at startup for warm-up).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    oximemo_desktop::run();
}
