//! Live smoke test for the brain glue (plan Task 7 Step 4).
//!
//! Connects to the real daemon at the default socket and exercises the same
//! connect → stats / recall path the tauri commands use. Requires a running
//! oxibrain daemon; run with `cargo test -p oximemo-desktop --ignored`.

use oxibrain_client::BrainClient;

#[tokio::test]
#[ignore = "requires a live oxibrain daemon"]
async fn live_daemon_status_and_recall() {
    let (mut client, caps) = BrainClient::connect_default()
        .await
        .expect("daemon at default socket");
    assert!(!caps.server_version.is_empty());

    let stats = client.stats("personal").await.expect("stats");
    let episodes = stats.get("episodes").and_then(|v| v.as_u64());
    println!("server_version={}", caps.server_version);
    println!("stats.episodes={:?}", episodes);
    assert!(episodes.unwrap_or(0) > 0, "personal space should have data");

    let recall = client
        .recall("oximemo 테스트", "personal", 1000)
        .await
        .expect("recall");
    let layers = recall
        .get("layers")
        .and_then(|l| l.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    println!("recall.layers={}", layers);
    assert!(recall.get("layers").is_some(), "recall must return layers");
}
