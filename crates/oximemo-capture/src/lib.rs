//! macOS global Option double-tap monitor (§6.1).
//!
//! The macOS implementation spawns a dedicated thread with its own
//! `NSRunLoop` and registers a passive `NSEvent` global monitor for
//! `.flagsChanged` events. The Option key keeps working normally in every
//! other app; we only observe.
//!
//! On non-macOS targets, [`CaptureMonitor::start`] returns
//! [`CaptureError::Os`] so dependent crates compile everywhere.

#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "macos")]
pub use macos::CaptureMonitorImpl;

/// A handle to the running global monitor. Dropping it stops monitoring.
pub struct CaptureMonitor {
    #[cfg(target_os = "macos")]
    inner: Option<macos::CaptureMonitorImpl>,
}

/// Errors from starting the monitor.
#[derive(Debug)]
pub enum CaptureError {
    /// macOS Accessibility/Input Monitoring permission not granted.
    PermissionDenied,
    /// Underlying OS error.
    Os(String),
}

impl std::fmt::Display for CaptureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PermissionDenied => {
                f.write_str("macOS Accessibility/Input Monitoring permission denied")
            }
            Self::Os(s) => write!(f, "capture OS error: {s}"),
        }
    }
}

impl std::error::Error for CaptureError {}

impl CaptureMonitor {
    /// Start watching for an Option-key double-tap.
    ///
    /// - `threshold_ms`: max interval between two Option-only press/release
    ///   pairs to count as a double-tap.
    /// - `on_trigger`: invoked on the monitor's thread when a double-tap is
    ///   detected. Implementations should hand off to the main app (e.g.
    ///   emit a Tauri event) rather than do heavy work inline.
    #[cfg(target_os = "macos")]
    pub fn start(
        threshold_ms: u32,
        on_trigger: Box<dyn Fn() + Send + 'static>,
    ) -> Result<Self, CaptureError> {
        let inner = macos::CaptureMonitorImpl::start(threshold_ms, on_trigger)?;
        Ok(Self { inner: Some(inner) })
    }

    #[cfg(not(target_os = "macos"))]
    pub fn start(
        _threshold_ms: u32,
        _on_trigger: Box<dyn Fn() + Send + 'static>,
    ) -> Result<Self, CaptureError> {
        Err(CaptureError::Os("capture only supported on macOS".into()))
    }
}

impl Drop for CaptureMonitor {
    fn drop(&mut self) {
        #[cfg(target_os = "macos")]
        {
            self.inner.take();
        }
    }
}
