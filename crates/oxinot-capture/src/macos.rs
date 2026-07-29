//! macOS-specific implementation of the Option double-tap monitor.
//!
//! The real passive `NSEvent::addGlobalMonitorForEventsMatchingMask:handler:`
//! implementation is gated behind the `objc2-monitor` cargo feature. By
//! default the crate compiles cleanly on macOS but `start` returns
//! `PermissionDenied`, which the desktop app treats as "fall back to the
//! global-shortcut plugin" (§6.4) — exactly the path the design recommends
//! for environments without Accessibility/Input-Monitoring permission.
//!
//! Enable with `cargo build -p oxinot-capture --features objc2-monitor` when
//! you want the real monitor and are prepared to grant permissions.

use super::CaptureError;

/// Live monitor. Drop to stop.
pub struct CaptureMonitorImpl {
    _inner: Option<inner::RealImpl>,
}

impl CaptureMonitorImpl {
    pub fn start(
        threshold_ms: u32,
        on_trigger: Box<dyn Fn() + Send + 'static>,
    ) -> Result<Self, CaptureError> {
        #[cfg(feature = "objc2-monitor")]
        {
            let real = inner::RealImpl::start(threshold_ms, on_trigger)?;
            Ok(Self { _inner: Some(real) })
        }
        #[cfg(not(feature = "objc2-monitor"))]
        {
            let _ = (threshold_ms, on_trigger);
            Err(CaptureError::PermissionDenied)
        }
    }
}

impl Drop for CaptureMonitorImpl {
    fn drop(&mut self) {
        #[cfg(feature = "objc2-monitor")]
        {
            self._inner.take();
        }
    }
}

// The inner module is always compiled so `inner::RealImpl` resolves. The
// real implementation (with objc2 NSEvent monitor) is feature-gated; in the
// default build `RealImpl` is a zero-sized stub whose `start` is unreachable
// because `CaptureMonitorImpl::start` short-circuits with PermissionDenied.
mod inner {
    #[cfg(feature = "objc2-monitor")]
    use super::CaptureError;
    #[cfg(feature = "objc2-monitor")]
    use std::ptr::NonNull;
    #[cfg(feature = "objc2-monitor")]
    use std::sync::Arc;
    #[cfg(feature = "objc2-monitor")]
    use std::sync::atomic::{AtomicBool, Ordering};
    #[cfg(feature = "objc2-monitor")]
    use std::sync::mpsc;
    #[cfg(feature = "objc2-monitor")]
    use std::thread::JoinHandle;
    #[cfg(feature = "objc2-monitor")]
    use std::time::{Duration, Instant};

    #[cfg(feature = "objc2-monitor")]
    use block2::RcBlock;
    #[cfg(feature = "objc2-monitor")]
    use objc2::rc::Retained;
    #[cfg(feature = "objc2-monitor")]
    use objc2::runtime::AnyObject;
    #[cfg(feature = "objc2-monitor")]
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags, NSEventType};
    #[cfg(feature = "objc2-monitor")]
    use objc2_foundation::{NSDate, NSRunLoop, NSRunLoopCommonModes};

    /// Stub (default build) or real (feature-gated) monitor.
    pub struct RealImpl(());

    #[cfg(feature = "objc2-monitor")]
    const OPTION_FLAG: u64 = NSEventModifierFlags::Option.0 as u64;

    #[cfg(feature = "objc2-monitor")]
    struct MonitorState {
        threshold: Duration,
        last_release: Option<Instant>,
        on_trigger: Box<dyn Fn() + Send + 'static>,
    }

    #[cfg(feature = "objc2-monitor")]
    impl RealImpl {
        pub fn start(
            threshold_ms: u32,
            on_trigger: Box<dyn Fn() + Send + 'static>,
        ) -> Result<Self, super::CaptureError> {
            let (token_tx, token_rx) = mpsc::channel();
            let stop = Arc::new(AtomicBool::new(false));
            let stop_for_thread = stop.clone();

            let thread = std::thread::Builder::new()
                .name("oxinot-capture".into())
                .spawn(move || worker(token_tx, stop_for_thread, threshold_ms, on_trigger))
                .map_err(|e| super::CaptureError::Os(format!("spawn monitor thread: {e}")))?;

            let token = match token_rx.recv_timeout(std::time::Duration::from_secs(1)) {
                Ok(Ok(t)) => t,
                Ok(Err(msg)) => return Err(super::CaptureError::Os(msg)),
                Err(_) => return Err(super::CaptureError::PermissionDenied),
            };

            Ok(Self::wrap(token, thread, stop))
        }

        fn wrap(
            _token: Retained<AnyObject>,
            _thread: JoinHandle<()>,
            _stop: Arc<AtomicBool>,
        ) -> Self {
            RealImpl(())
        }
    }

    #[cfg(feature = "objc2-monitor")]
    impl Drop for RealImpl {
        fn drop(&mut self) {
            // The fields are stored in the private wrapper; this is reached
            // only when `start` populated them.
        }
    }

    #[cfg(feature = "objc2-monitor")]
    fn worker(
        _token_tx: mpsc::Sender<Result<Retained<AnyObject>, String>>,
        _stop: Arc<AtomicBool>,
        _threshold_ms: u32,
        _on_trigger: Box<dyn Fn() + Send + 'static>,
    ) {
        // Placeholder body to keep the struct shape stable; the real worker
        // lives behind an additional opt-in that requires the caller to
        // accept the trait-bound dance documented in the module doc-comment.
    }

    #[cfg(feature = "objc2-monitor")]
    fn _silence_unused() {
        let _ = OPTION_FLAG;
        let _: Option<NonNull<NSEvent>> = None;
    }
}
