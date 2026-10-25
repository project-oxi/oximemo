//! macOS implementation of the passive Option-key double-tap monitor.

use super::CaptureError;
use block2::RcBlock;
use objc2::runtime::AnyObject;
use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags};
use objc2_core_foundation::CFRunLoop;
use objc2_foundation::{NSDate, NSDefaultRunLoopMode, NSPort, NSRunLoop};
use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// `CFRunLoop` handle passed from the worker to the owner. `CFRunLoopStop`
/// is documented thread-safe, and the handle is only used before the owner
/// joins the worker, so the pointee outlives every use.
struct SendLoop(*mut CFRunLoop);
unsafe impl Send for SendLoop {}

/// The running monitor and its worker-thread shutdown signal.
pub struct CaptureMonitorImpl {
    stop: Arc<AtomicBool>,
    run_loop: Option<SendLoop>,
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
            Ok(Ok(run_loop)) => Ok(Self {
                stop,
                run_loop: Some(run_loop),
                thread: Some(thread),
            }),
            Ok(Err(error)) => {
                // The worker exited before creating its run loop.
                let _ = thread.join();
                Err(error)
            }
            Err(error) => {
                // The worker is still initializing. It always sends its
                // run-loop handle before blocking, so a detached reaper
                // stops the loop as soon as it appears and reaps the
                // thread; joining here could block forever.
                stop.store(true, Ordering::Release);
                std::thread::Builder::new()
                    .name("oximemo-capture-reaper".into())
                    .spawn(move || {
                        if let Ok(Ok(run_loop)) = ready_rx.recv() {
                            stop_run_loop(&run_loop);
                        }
                        let _ = thread.join();
                    })
                    .ok();
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
        if let Some(run_loop) = self.run_loop.take() {
            stop_run_loop(&run_loop);
        }
        if let Some(thread) = self.thread.take()
            && thread.thread().id() != std::thread::current().id()
        {
            let _ = thread.join();
        }
    }
}

/// Wake a worker blocked in `runUntilDate(distantFuture)` so it observes
/// the stop flag. `CFRunLoopStop` makes the pending `runMode` call return,
/// which in turn returns `runUntilDate:`.
fn stop_run_loop(run_loop: &SendLoop) {
    if let Some(cf) = unsafe { run_loop.0.as_ref() } {
        cf.stop();
    }
}

struct TapState {
    option_down_alone: bool,
    last_release: Option<Instant>,
}

fn worker(
    ready_tx: mpsc::SyncSender<Result<SendLoop, CaptureError>>,
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

    let run_loop = NSRunLoop::currentRunLoop();
    // A global event monitor attaches no input source of its own, so an
    // empty run loop makes `runMode:` return false immediately — the
    // spin this thread used to burn a whole core on. A never-signalled
    // port keeps the loop alive so `runUntilDate(distantFuture)` blocks
    // in the kernel until a real FlagsChanged event arrives or the owner
    // calls CFRunLoopStop.
    let keep_alive = NSPort::port();
    unsafe {
        run_loop.addPort_forMode(&keep_alive, NSDefaultRunLoopMode);
    }
    let cf = run_loop.getCFRunLoop();
    let handle = SendLoop(std::ptr::from_ref(&*cf) as *mut CFRunLoop);
    let _ = ready_tx.send(Ok(handle));
    while !stop.load(Ordering::Acquire) {
        run_loop.runUntilDate(&NSDate::distantFuture());
    }

    // SAFETY: `monitor` is the token returned by the matching AppKit registration call.
    unsafe { NSEvent::removeMonitor(&monitor) };
}

// Keep the Objective-C token type explicit in this module's API boundary.
const _: Option<&AnyObject> = None;
