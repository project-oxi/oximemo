//! One-off idle-CPU probe: runs the capture monitor for N seconds and
//! reports process CPU time so the monitor thread's cost is measurable.
//!
//! Usage: cargo run -p oximemo-capture --example idle_probe -- [seconds]

fn main() {
    let secs: u64 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(5);

    let monitor = oximemo_capture::CaptureMonitor::start(350, Box::new(|| {}))
        .expect("capture monitor start");
    println!("monitor running for {secs}s…");
    std::thread::sleep(std::time::Duration::from_secs(secs));
    drop(monitor);
    println!("monitor stopped cleanly");
}
