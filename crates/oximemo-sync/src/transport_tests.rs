use super::*;
use serde_json::json;
use std::thread;
use tiny_http::{Header, Response, Server, StatusCode};

type RequestLog = Vec<(String, Value)>;

fn server(
    steps: Vec<(&'static str, u16, Value)>,
) -> (reqwest::Url, thread::JoinHandle<RequestLog>) {
    let server = Server::http("127.0.0.1:0").unwrap();
    let base = reqwest::Url::parse(&format!("http://{}/", server.server_addr())).unwrap();
    let handle = thread::spawn(move || {
        let mut log = vec![];
        for (route, status, body) in steps {
            let mut request = server
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .expect("missing client request");
            assert_eq!(request.url(), route);
            assert!(
                request
                    .headers()
                    .iter()
                    .any(|header| header.field.equiv("Authorization")
                        && header.value.as_str() == "Bearer test-credential")
            );
            let mut bytes = String::new();
            request.as_reader().read_to_string(&mut bytes).unwrap();
            log.push((
                route.to_string(),
                serde_json::from_str(&bytes).unwrap_or(Value::Null),
            ));
            request
                .respond(
                    Response::from_string(body.to_string())
                        .with_status_code(StatusCode(status))
                        .with_header(
                            Header::from_bytes("Content-Type", "application/json").unwrap(),
                        ),
                )
                .unwrap();
        }
        log
    });
    (base, handle)
}

fn manifest(entries: Vec<Value>) -> Value {
    json!({"protocol": PROTOCOL, "vault_id": "test-vault", "entries": entries, "duplicate_ids": [], "manifest_diagnostic": null})
}

fn source() -> Value {
    json!({"path": "phone.md", "content": "exact envelope\n**Phone**\n", "sha256": "sha256:confirmed", "document_id": "phone-id", "editable_body": "**Phone**\n", "title": "Phone", "body_profile": "pdc-markdown/1"})
}

fn entry() -> Value {
    json!({"path": "phone.md", "class": "document", "document_id": "phone-id", "title": "Phone", "diagnostic": null, "sha256": "sha256:confirmed"})
}

fn client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
}

#[test]
fn http_client_sends_offline_draft_and_pulls_exact_legacy_source() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("cache.json");
    let mut cache = Cache::default();
    cache
        .queue(
            None,
            "Phone".into(),
            "**Phone**\n".into(),
            "pdc-markdown/1".into(),
        )
        .unwrap();
    let legacy_entry = json!({"path": "legacy.md", "class": "legacy_markdown", "document_id": null, "title": "Legacy", "diagnostic": null, "sha256": "sha256:legacy"});
    let legacy_source = json!({"path": "legacy.md", "content": "# Legacy\r\n\r\n%% unchanged %%\r\n", "sha256": "sha256:legacy", "document_id": null, "editable_body": null, "title": null, "body_profile": null});
    let (base, handle) = server(vec![
        ("/v1/manifest", 200, manifest(vec![legacy_entry.clone()])),
        ("/v1/apply", 200, source()),
        ("/v1/manifest", 200, manifest(vec![entry(), legacy_entry])),
        ("/v1/source", 200, legacy_source.clone()),
    ]);
    let draft_key = cache.documents[0].key.clone();
    let mut key_updates = Default::default();
    synchronize_with_transport_reporting_keys(
        &mut cache,
        &path,
        &base,
        "test-credential",
        &client(),
        &mut key_updates,
    )
    .unwrap();
    assert_eq!(
        key_updates.get(&draft_key).map(String::as_str),
        Some("phone-id")
    );
    let requests = handle.join().unwrap();
    assert_eq!(requests[1].1["vault_id"], "test-vault");
    assert_eq!(requests[1].1["change"]["body"], "**Phone**\n");
    assert!(
        cache
            .documents
            .iter()
            .all(|document| document.pending.is_none())
    );
    assert_eq!(
        cache.documents[1].source.as_ref().unwrap().content,
        legacy_source["content"]
    );
    let restored = Cache::load(&path).unwrap();
    assert_eq!(
        serde_json::to_value(&restored.documents).unwrap(),
        serde_json::to_value(&cache.documents).unwrap()
    );
    assert!(restored.last_sync.is_some());
}

#[test]
fn open_draft_identity_survives_a_later_manifest_failure() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("cache.json");
    let mut cache = Cache::default();
    let draft_key = cache
        .queue(
            None,
            "Phone".into(),
            "**Phone**\n".into(),
            "pdc-markdown/1".into(),
        )
        .unwrap();
    let (base, handle) = server(vec![
        ("/v1/manifest", 200, manifest(vec![])),
        ("/v1/apply", 200, source()),
        ("/v1/manifest", 503, json!({"error": "temporary outage"})),
    ]);
    let mut updates = Default::default();
    assert!(
        synchronize_with_transport_reporting_keys(
            &mut cache,
            &path,
            &base,
            "test-credential",
            &client(),
            &mut updates
        )
        .is_err()
    );
    assert_eq!(
        updates.get(&draft_key).map(String::as_str),
        Some("phone-id")
    );
    assert_eq!(Cache::load(&path).unwrap().documents[0].key, "phone-id");
    assert!(cache.documents[0].pending.is_none());
    handle.join().unwrap();
}

#[test]
fn http_retry_reuses_the_immutable_operation_until_acknowledged() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("cache.json");
    let mut cache = Cache::default();
    let key = cache
        .queue(
            None,
            "Phone".into(),
            "**Phone**\n".into(),
            "pdc-markdown/1".into(),
        )
        .unwrap();
    let (base, handle) = server(vec![
        ("/v1/manifest", 200, manifest(vec![])),
        ("/v1/apply", 500, json!({"error": "response uncertain"})),
        ("/v1/manifest", 200, manifest(vec![])),
        ("/v1/manifest", 200, manifest(vec![])),
        ("/v1/apply", 200, source()),
        ("/v1/manifest", 200, manifest(vec![entry()])),
    ]);
    let client = client();
    synchronize_with_transport(&mut cache, &path, &base, "test-credential", &client).unwrap();
    cache = Cache::load(&path).unwrap();
    assert!(cache.documents[0].attempted);
    assert!(
        cache
            .queue(
                Some(&key),
                "Changed".into(),
                "Other".into(),
                "pdc-markdown/1".into()
            )
            .is_err()
    );
    synchronize_with_transport(&mut cache, &path, &base, "test-credential", &client).unwrap();
    let requests = handle.join().unwrap();
    assert_eq!(requests[1].1, requests[4].1);
    assert_eq!(cache.documents.len(), 1);
    assert!(cache.documents[0].pending.is_none());
    assert!(!cache.documents[0].attempted);
}

#[test]
fn http_conflict_retains_the_source_snapshot_and_draft() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("cache.json");
    let original: Source = serde_json::from_value(source()).unwrap();
    let mut cache = Cache {
        vault_id: Some("test-vault".into()),
        documents: vec![CachedDocument {
            key: "phone-id".into(),
            entry: Some(serde_json::from_value(entry()).unwrap()),
            source: Some(original.clone()),
            ..Default::default()
        }],
        ..Default::default()
    };
    cache
        .queue(
            Some("phone-id"),
            "Phone".into(),
            "local draft".into(),
            "pdc-markdown/1".into(),
        )
        .unwrap();
    let mut changed = entry();
    changed["sha256"] = json!("sha256:pc-changed");
    let (base, handle) = server(vec![
        ("/v1/manifest", 200, manifest(vec![changed.clone()])),
        (
            "/v1/apply",
            409,
            json!({"error": "external_change_conflict"}),
        ),
        ("/v1/manifest", 200, manifest(vec![changed])),
    ]);
    synchronize_with_transport(&mut cache, &path, &base, "test-credential", &client()).unwrap();
    handle.join().unwrap();
    assert_eq!(cache.documents[0].source.as_ref(), Some(&original));
    assert!(
        cache.documents[0]
            .error
            .as_ref()
            .unwrap()
            .starts_with("rejected:")
    );
    assert!(
        matches!(&cache.documents[0].pending.as_ref().unwrap().change, Change::Update { body, .. } if body == "local draft")
    );
    assert_eq!(
        serde_json::to_value(Cache::load(&path).unwrap().documents).unwrap(),
        serde_json::to_value(&cache.documents).unwrap()
    );
}

#[test]
fn http_auth_failure_does_not_mark_the_draft_as_sent_or_record_success() {
    let directory = tempfile::tempdir().unwrap();
    let mut cache = Cache::default();
    cache
        .queue(
            None,
            "Phone".into(),
            "**Phone**\n".into(),
            "pdc-markdown/1".into(),
        )
        .unwrap();
    let before = cache.documents.clone();
    let (base, handle) = server(vec![("/v1/manifest", 401, json!({"error":"unauthorized"}))]);
    assert!(
        synchronize_with_transport(
            &mut cache,
            &directory.path().join("cache.json"),
            &base,
            "test-credential",
            &client()
        )
        .is_err()
    );
    handle.join().unwrap();
    assert_eq!(
        serde_json::to_value(&cache.documents).unwrap(),
        serde_json::to_value(before).unwrap()
    );
    assert!(cache.last_sync.is_none());
}
