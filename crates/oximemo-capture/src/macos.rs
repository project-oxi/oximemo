//! macOS implementation of the passive Option-key double-tap monitor.

use super::CaptureError;
use block2::RcBlock;
use objc2::runtime::AnyObject;
use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags};
use objc2_foundation::{NSDate, NSDefaultRunLoopMode, NSRunLoop, NSTimer};
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
    // A global `NSEvent` monitor attaches no run-loop source, so the
    // default mode is empty and every `runMode` call returns instantly with
    // `kCFRunLoopRunFinished` — the poll below then busy-spins a whole core
    // (~25-75% measured at idle). This far-future timer exists only to keep
    // the default mode non-empty, so `runUntilDate` sleeps the poll
    // interval out in the kernel instead of spinning.
    // SAFETY: the block matches the `timerWithTimeInterval:repeats:block:`
    // signature; the timer copies it, and it stays on this thread's loop.
    let heartbeat = unsafe {
        NSTimer::timerWithTimeInterval_repeats_block(
            3600.0,
            true,
            &RcBlock::new(|_timer: std::ptr::NonNull<NSTimer>| {}),
        )
    };
    // SAFETY: `addTimer_forMode` is an ObjC call; the mode is the
    // Foundation `NSDefaultRunLoopMode` constant.
    unsafe { run_loop.addTimer_forMode(&heartbeat, NSDefaultRunLoopMode) };

    // 20 ms poll: kernel sleeps costing ~0.02% CPU that also bound event
    // service and shutdown latency.
    while !stop.load(Ordering::Acquire) {
        let deadline = NSDate::dateWithTimeIntervalSinceNow(0.02);
        run_loop.runUntilDate(&deadline);
    }

    // SAFETY: `monitor` is the token returned by the matching AppKit registration call.
    unsafe { NSEvent::removeMonitor(&monitor) };
}

// Keep the Objective-C token type explicit in this module's API boundary.
const _: Option<&AnyObject> = None;

#[cfg(test)]
mod tests {
    use super::*;

    /// Dropping the monitor must terminate the worker promptly. A
    /// regression here either deadlocks shutdown or busy-spins a core.
    #[test]
    fn drop_stops_worker_promptly() {
        let monitor = match CaptureMonitorImpl::start(350, Box::new(|| {})) {
            Ok(monitor) => monitor,
            // Headless CI runners lack Input Monitoring permission.
            Err(CaptureError::PermissionDenied) => return,
            Err(error) => panic!("{error}"),
        };
        let (done_tx, done_rx) = mpsc::channel();
        std::thread::spawn(move || {
            drop(monitor);
            let _ = done_tx.send(());
        });
        assert!(
            done_rx.recv_timeout(Duration::from_secs(3)).is_ok(),
            "CaptureMonitorImpl::drop hung instead of stopping the worker"
        );
    }
}
