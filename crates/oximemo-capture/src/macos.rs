//! macOS implementation of the passive Option-key double-tap monitor.

use super::CaptureError;
use block2::RcBlock;
use objc2::runtime::AnyObject;
use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags};
use objc2_foundation::{NSDate, NSRunLoop};
use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// The running monitor and its worker-thread shutdown signal.
pub struct CaptureMonitorImpl {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl CaptureMonitorImpl {
    pub fn start(
        threshold_ms: u32,
        on_trigger: Box<dyn Fn() + Send + 'static>,
    ) -> Result<Self, CaptureError> {
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop);
        let thread = std::thread::Builder::new()
            .name("oximemo-capture".into())
            .spawn(move || worker(ready_tx, worker_stop, threshold_ms, on_trigger))
            .map_err(|error| CaptureError::Os(format!("spawn monitor thread: {error}")))?;

        match ready_rx.recv_timeout(Duration::from_secs(2)) {
            Ok(Ok(())) => Ok(Self {
                stop,
                thread: Some(thread),
            }),
            Ok(Err(error)) => {
                let _ = thread.join();
                Err(error)
            }
            Err(error) => {
                stop.store(true, Ordering::Release);
                let _ = thread.join();
                Err(CaptureError::Os(format!(
                    "monitor thread did not initialize: {error}"
                )))
            }
        }
    }
}

impl Drop for CaptureMonitorImpl {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take()
            && thread.thread().id() != std::thread::current().id()
        {
            let _ = thread.join();
        }
    }
}

struct TapState {
    option_down_alone: bool,
    last_release: Option<Instant>,
}

fn worker(
    ready_tx: mpsc::SyncSender<Result<(), CaptureError>>,
    stop: Arc<AtomicBool>,
    threshold_ms: u32,
    on_trigger: Box<dyn Fn() + Send + 'static>,
) {
    let state = RefCell::new(TapState {
        option_down_alone: false,
        last_release: None,
    });
    let threshold = Duration::from_millis(u64::from(threshold_ms));
    let handler = RcBlock::new(move |event: std::ptr::NonNull<NSEvent>| {
        // SAFETY: AppKit supplies a valid NSEvent pointer for the duration of this callback.
        let event = unsafe { event.as_ref() };
        let flags = event.modifierFlags();
        let device_independent = flags & NSEventModifierFlags::DeviceIndependentFlagsMask;
        let option_only = device_independent == NSEventModifierFlags::Option;
        let mut state = state.borrow_mut();

        if option_only {
            state.option_down_alone = true;
            return;
        }

        if device_independent.is_empty() && state.option_down_alone {
            state.option_down_alone = false;
            let now = Instant::now();
            if state
                .last_release
                .is_some_and(|last| now.duration_since(last) <= threshold)
            {
                state.last_release = None;
                on_trigger();
            } else {
                state.last_release = Some(now);
            }
        } else {
            state.option_down_alone = false;
            state.last_release = None;
        }
    });

    let Some(monitor) =
        NSEvent::addGlobalMonitorForEventsMatchingMask_handler(NSEventMask::FlagsChanged, &handler)
    else {
        let _ = ready_tx.send(Err(CaptureError::PermissionDenied));
        return;
    };

    let _ = ready_tx.send(Ok(()));
    let run_loop = NSRunLoop::currentRunLoop();
    while !stop.load(Ordering::Acquire) {
        let deadline = NSDate::dateWithTimeIntervalSinceNow(0.05);
        run_loop.runUntilDate(&deadline);
    }

    // SAFETY: `monitor` is the token returned by the matching AppKit registration call.
    unsafe { NSEvent::removeMonitor(&monitor) };
}

// Keep the Objective-C token type explicit in this module's API boundary.
const _: Option<&AnyObject> = None;
