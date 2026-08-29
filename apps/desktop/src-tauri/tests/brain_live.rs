//! Live oxibrain integration over the caller-owned stdio transport
//! (brain 0.10 cutover). Spawns the real `oxibrain admin serve --stdio`
//! child exactly the way the `brain_status` / `brain_gather` commands
//! do. Requires the `oxibrain` binary on PATH and a store at
//! `~/.oxi/brain`; run with `cargo test -p oximemo-desktop --ignored`.
//!
//! Skips cleanly (not a failure) when the binary is absent — CI and
//! contributor machines without oxibrain stay green.

use oxibrain_client::BrainClient;

fn oxibrain_available() -> bool {
    // `is_ok()` on a bare spawn probe would start a real child; instead
    // ask the OS to resolve the name via `which`.
    std::process::Command::new("which")
        .arg("oxibrain")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

#[tokio::test]
#[ignore = "requires the oxibrain binary on PATH and a store at ~/.oxi/brain"]
async fn live_status_and_recall() {
    if !oxibrain_available() {
        eprintln!("oxibrain not on PATH; skipping");
        return;
    }
    let endpoint = oxibrain_client::LocalProcessEndpoint::new(
        "oxibrain",
        oximemo_core::brain::brain_dir(),
    );
    let mut client = BrainClient::spawn_local(endpoint).await.expect("spawn child");
    let caps = client
        .handshake(oxibrain_client::default_client_hello("oximemo live-test"))
        .await
        .expect("handshake");
    assert!(!caps.server_version.is_empty());

    // The spaces model keeps space dirs at `~/.oxi/vault/<name>/`; this
    // machine's provisioned space is `personal` (the flat root was
    // rewritten during the spaces design verification). The derivation
    // the app uses is the opened vault's basename — for the full
    // flat→space migration see the 2026-08-28 spaces plan.
    let space = "personal";
    // `stats` is a native JSON-RPC method in oxibrain ≥ 0.10 — the
    // client 0.10.x helper routes it through tools/call, which the
    // server rejects, so call the native method directly.
    let stats = client
        .call_rpc_json("stats", serde_json::json!({ "space": space }))
        .await
        .expect("stats");
    // Lenient shape check: a successful op returns the count keys.
    assert!(stats.get("episodes").is_some() || stats.get("documents").is_some());

    let recall = client
        .recall("smoke", &space, 512)
        .await
        .expect("recall envelope");
    assert!(recall.is_object(), "recall must return the op envelope");
}
