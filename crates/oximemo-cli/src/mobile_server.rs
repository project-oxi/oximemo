//! Opt-in, loopback-only PC adapter. Tailscale Serve terminates HTTPS.
use anyhow::{Result, bail};
use oximemo_core::{Paths, pdc_documents as documents, pdc_inventory};
use oximemo_sync::pairing::{
    PAIRING_TTL, PairingCode, PairingOffer, PairingRequest, PairingResponse,
};
use oximemo_sync::{Change, Entry, Manifest, Operation, PROTOCOL, Source, atomic_json};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};
use std::{fs, io::Read, net::SocketAddr, path::Path};
use tiny_http::{Header, Method, Response, Server, StatusCode};
use uuid::Uuid;

struct PairingSession {
    code: PairingCode,
    deadline: Instant,
    redeemed_by: Option<String>,
    failures: u8,
}
impl PairingSession {
    fn new(endpoint: &str) -> Result<Self> {
        Ok(Self {
            code: PairingCode::new(endpoint)?,
            deadline: Instant::now() + Duration::from_secs(PAIRING_TTL),
            redeemed_by: None,
            failures: 0,
        })
    }
    fn redeem(
        &mut self,
        request: PairingRequest,
        vault_id: &str,
        token: &str,
    ) -> Result<PairingResponse> {
        if Instant::now() >= self.deadline || self.failures >= 20 {
            bail!("pairing code expired or locked");
        }
        let valid_id = Uuid::parse_str(&request.request_id)
            .is_ok_and(|id| id.to_string() == request.request_id);
        if !valid_id || !token_matches(&format!("Bearer {}", request.secret), &self.code.secret) {
            self.failures = self.failures.saturating_add(1);
            bail!("invalid pairing request");
        }
        if request
            .expected_vault_id
            .as_ref()
            .is_some_and(|id| id != vault_id)
        {
            bail!("wrong vault identity");
        }
        if self
            .redeemed_by
            .as_ref()
            .is_some_and(|id| id != &request.request_id)
        {
            bail!("pairing code already used");
        }
        // Identical request retries recover a lost response until expiry.
        self.redeemed_by = Some(request.request_id);
        Ok(PairingResponse {
            protocol: PROTOCOL.into(),
            vault_id: vault_id.into(),
            token: token.into(),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Journal {
    operation: Operation,
    prepared: Option<documents::PreparedPdcDocument>,
    update: Option<(String, String, Vec<u8>)>,
    completed: Option<Source>,
}

pub fn run(paths: &Paths, bind: SocketAddr, token_file: &Path) -> Result<()> {
    if !bind.ip().is_loopback() {
        bail!("mobile server must bind to loopback; expose it with Tailscale Serve");
    }
    let token = read_token(token_file)?;
    fs::create_dir_all(&paths.index_dir)?;
    let _server_lock = oximemo_core::lock::acquire(
        &paths.index_dir.join("mobile-server.lock"),
        oximemo_core::lock::LockKind::Exclusive,
        std::time::Duration::from_secs(1),
    )?;
    documents::ensure_manifest(&paths.vault)?;
    prune_stale_receipts(paths)?;
    let vault_id = vault_id(paths)?;
    let server = Server::http(bind).map_err(|e| anyhow::anyhow!(e.to_string()))?;
    let mut pairing: Option<PairingSession> = None;
    eprintln!("OxiMemo mobile server listening on http://{bind}");
    eprintln!("Expose within your tailnet: tailscale serve --bg http://{bind}");
    for mut request in server.incoming_requests() {
        let authorized = request
            .headers()
            .iter()
            .any(|h| h.field.equiv("Authorization") && token_matches(h.value.as_str(), &token));
        let browser_origin = request.headers().iter().any(|h| h.field.equiv("Origin"));
        let pair_exchange = request.method() == &Method::Post && request.url() == "/v1/pair";
        let (status, body) = if browser_origin || (!authorized && !pair_exchange) {
            (401, json!({"error":"unauthorized"}))
        } else {
            let method = request.method().clone();
            let route = request.url().to_string();
            let limit = if route.starts_with("/v1/pair") {
                4096
            } else {
                oximemo_sync::MAX_REQUEST
            };
            let size = request.body_length().unwrap_or(0);
            if size > limit {
                (413, json!({"error":"request too large"}))
            } else {
                let mut bytes = Vec::new();
                let read = request
                    .as_reader()
                    .take((limit + 1) as u64)
                    .read_to_end(&mut bytes);
                if read.is_err() || bytes.len() > limit {
                    (413, json!({"error":"request too large or unreadable"}))
                } else if route == "/v1/pair" {
                    let result = (|| -> Result<PairingResponse> {
                        if self::vault_id(paths)? != vault_id {
                            bail!("vault identity changed");
                        }
                        let request = serde_json::from_slice(&bytes)?;
                        pairing
                            .as_mut()
                            .ok_or_else(|| anyhow::anyhow!("no active pairing code"))?
                            .redeem(request, &vault_id, &token)
                    })();
                    match result {
                        Ok(response) => (200, serde_json::to_value(response)?),
                        Err(_) => (
                            403,
                            json!({"error":"pairing unavailable; generate a new code on PC"}),
                        ),
                    }
                } else if method == Method::Post && route == "/v1/pairing/new" {
                    let result = (|| -> Result<PairingOffer> {
                        let value: Value = serde_json::from_slice(&bytes)?;
                        let endpoint = value
                            .get("endpoint")
                            .and_then(Value::as_str)
                            .ok_or_else(|| anyhow::anyhow!("missing endpoint"))?;
                        let session = PairingSession::new(endpoint)?;
                        let offer = PairingOffer {
                            code: session.code.encode()?,
                            expires_in_seconds: PAIRING_TTL,
                        };
                        pairing = Some(session);
                        Ok(offer)
                    })();
                    match result {
                        Ok(offer) => (200, serde_json::to_value(offer)?),
                        Err(_) => (422, json!({"error":"invalid tailnet endpoint"})),
                    }
                } else {
                    match route_request(paths, &vault_id, &method, &route, &bytes) {
                        Ok(value) => (200, value),
                        Err(error) => {
                            let message = error.to_string();
                            let status = if message.contains("uncertain_commit:") {
                                503
                            } else if message.contains("external_change_conflict")
                                || message.contains("duplicate_document_id")
                            {
                                409
                            } else {
                                422
                            };
                            (status, json!({"error":message}))
                        }
                    }
                }
            }
        };
        // Serialize once to bytes; building a String through the Value
        // tree doubled the transient allocation for multi-MB manifests.
        let response = Response::from_data(serde_json::to_vec(&body)?)
            .with_status_code(StatusCode(status))
            .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
            .with_header(Header::from_bytes("Cache-Control", "no-store").unwrap())
            .with_header(Header::from_bytes("X-Content-Type-Options", "nosniff").unwrap());
        let _ = request.respond(response);
    }
    Ok(())
}

/// Delete mobile write receipts older than 30 days. Receipts exist so a
/// phone can retry an uncertain operation idempotently; after a month a
/// device has either confirmed or moved on, and each receipt holds a
/// full document copy that would otherwise grow the private index
/// directory forever.
fn prune_stale_receipts(paths: &Paths) -> Result<()> {
    let dir = paths.index_dir.join("mobile-receipts");
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let cutoff = std::time::SystemTime::now() - Duration::from_secs(30 * 24 * 60 * 60);
    for entry in entries {
        let entry = entry?;
        let stale = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .is_ok_and(|modified| modified < cutoff);
        if stale {
            let _ = fs::remove_file(entry.path());
        }
    }
    Ok(())
}

fn read_token(token_file: &Path) -> Result<String> {
    let metadata = fs::symlink_metadata(token_file)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        bail!("token file must be a regular file");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            bail!("token file must have owner-only permissions (chmod 600)");
        }
    }
    let token = fs::read_to_string(token_file)?.trim().to_string();
    if token.len() < 32
        || token.len() > 256
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        bail!("token must contain 32–256 ASCII letters/digits, '-' or '_'");
    }
    Ok(token)
}

fn vault_id(paths: &Paths) -> Result<String> {
    let manifest: Value = serde_json::from_slice(&fs::read(paths.vault.join(".pdc/vault.json"))?)?;
    Ok(manifest
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("vault has no identity"))?
        .to_string())
}

fn token_matches(header: &str, token: &str) -> bool {
    let Some(candidate) = header.strip_prefix("Bearer ") else {
        return false;
    };
    let left = Sha256::digest(candidate.as_bytes());
    let right = Sha256::digest(token.as_bytes());
    left.iter()
        .zip(right.iter())
        .fold(0u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

fn source(paths: &Paths, path: &str) -> Result<Source> {
    Ok(serde_json::from_value(serde_json::to_value(
        documents::read_document(paths, path)?,
    )?)?)
}

fn route_request(
    paths: &Paths,
    id: &str,
    method: &Method,
    route: &str,
    body: &[u8],
) -> Result<Value> {
    if vault_id(paths)? != id {
        bail!("server vault identity changed; restart before synchronizing");
    }
    match (method, route) {
        (&Method::Get, "/v1/manifest") => {
            // One read-only scan: class, tombstone flag, and source hash
            // all come from the inventory pass over bytes it already read.
            let inventory = pdc_inventory::scan(paths)?;
            let entries = inventory
                .items
                .iter()
                .map(|item| {
                    Ok(Entry {
                        path: item.path.clone(),
                        class: item.class.as_str().to_string(),
                        document_id: item.document_id.clone(),
                        title: item.title.clone(),
                        diagnostic: item
                            .diagnostic
                            .as_ref()
                            .map(serde_json::to_value)
                            .transpose()?,
                        deleted: item.deleted,
                        broken_document_links: item.broken_document_links.clone(),
                        missing_assets: item.missing_assets.clone(),
                        sha256: item.sha256.clone(),
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            Ok(serde_json::to_value(Manifest {
                protocol: PROTOCOL.into(),
                vault_id: id.into(),
                entries,
                duplicate_ids: inventory
                    .duplicate_ids
                    .iter()
                    .map(serde_json::to_value)
                    .collect::<std::result::Result<Vec<_>, _>>()?,
                manifest_diagnostic: inventory
                    .manifest_diagnostic
                    .as_ref()
                    .map(serde_json::to_value)
                    .transpose()?,
            })?)
        }
        (&Method::Post, "/v1/source") => {
            let request: Value = serde_json::from_slice(body)?;
            let path = request
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("missing source path"))?;
            Ok(serde_json::to_value(source(paths, path)?)?)
        }
        (&Method::Post, "/v1/apply") => {
            let operation: Operation = serde_json::from_slice(body)?;
            Ok(serde_json::to_value(apply(paths, id, operation)?)?)
        }
        _ => bail!("unknown sync route"),
    }
}

fn apply(paths: &Paths, id: &str, operation: Operation) -> Result<Source> {
    if operation.vault_id != id {
        bail!("wrong vault identity");
    }
    let uuid = Uuid::parse_str(&operation.operation_id)?;
    if uuid.to_string() != operation.operation_id {
        bail!("noncanonical operation ID");
    }
    let journal_path = paths
        .index_dir
        .join("mobile-receipts")
        .join(format!("{uuid}.json"));
    let mut journal: Journal = match fs::read(&journal_path) {
        Ok(bytes) => {
            let journal: Journal = serde_json::from_slice(&bytes)?;
            if journal.operation != operation {
                bail!("operation ID was already used with different content");
            }
            journal
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut journal = Journal {
                operation: operation.clone(),
                prepared: None,
                update: None,
                completed: None,
            };
            match &operation.change {
                Change::Create {
                    title,
                    body,
                    body_profile,
                } => {
                    let profile = match body_profile.as_str() {
                        "pdc-markdown/1" => documents::PdcBodyProfile::Markdown,
                        "pdc-html/1" => documents::PdcBodyProfile::Html,
                        _ => bail!("unsupported canonical profile"),
                    };
                    journal.prepared = Some(documents::prepare_document(
                        paths,
                        documents::PdcCreateRequest {
                            folder: String::new(),
                            title: title.clone(),
                            body: body.clone(),
                            body_profile: profile,
                            tags: vec![],
                            properties: vec![documents::PdcProperty {
                                key: "oximemo_editor".into(),
                                value: json!("source"),
                            }],
                        },
                    )?);
                }
                Change::Update {
                    document_id,
                    expected_sha256,
                    title,
                    body,
                } => {
                    let inventory = pdc_inventory::scan(paths)?;
                    let matches: Vec<_> = inventory
                        .items
                        .iter()
                        .filter(|entry| entry.document_id.as_deref() == Some(document_id))
                        .collect();
                    if matches.len() > 1 {
                        bail!("duplicate_document_id: resolve duplicate paths on PC first");
                    }
                    let entry = matches.first().ok_or_else(|| anyhow::anyhow!("external_change_conflict: document was removed or is no longer canonical"))?;
                    let before = documents::read_document(paths, &entry.path)?;
                    if &before.sha256 != expected_sha256 {
                        bail!(
                            "external_change_conflict: PC document changed; mobile draft was retained"
                        );
                    }
                    let candidate =
                        documents::prepare_update_source(&before, Some(title), Some(body), &[])?;
                    journal.update = Some((
                        entry.path.clone(),
                        expected_sha256.clone(),
                        candidate.unwrap_or_else(|| before.content.into_bytes()),
                    ));
                }
            }
            // Persist immutable candidate bytes BEFORE the canonical write.
            atomic_json(&journal_path, &journal)?;
            journal
        }
        Err(error) => return Err(error.into()),
    };
    if let Some(completed) = journal.completed {
        return Ok(completed);
    }
    let committed_result: Result<Source> = (|| {
        if let Some(prepared) = &journal.prepared {
            let receipt = documents::create_prepared_document(paths, prepared)?;
            source(paths, &receipt.path)
        } else if let Some((path, expected, candidate)) = &journal.update {
            Ok(serde_json::from_value(serde_json::to_value(
                documents::update_prepared_document(paths, path, expected, candidate)?,
            )?)?)
        } else {
            bail!("invalid prepared sync receipt");
        }
    })();
    let committed = committed_result.map_err(|error| {
        if error.to_string().contains("external_change_conflict") {
            error
        } else {
            anyhow::anyhow!("uncertain_commit: retry the same request: {error}")
        }
    })?;
    journal.completed = Some(committed.clone());
    atomic_json(&journal_path, &journal)
        .map_err(|error| anyhow::anyhow!("uncertain_commit: retry the same request: {error}"))?;
    Ok(committed)
}

pub fn show_pairing(
    endpoint: &str,
    token_file: &Path,
    server: SocketAddr,
    qr_file: Option<&Path>,
) -> Result<()> {
    use qrcode::{Color, QrCode, render::unicode};
    use std::io::{IsTerminal, Write};
    if !server.ip().is_loopback() {
        bail!("pairing management must use the local loopback server");
    }
    let endpoint = oximemo_sync::endpoint_url(endpoint)?.to_string();
    let token = read_token(token_file)?;
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(10))
        .redirects(0)
        .build();
    let response = agent
        .post(&format!("http://{server}/v1/pairing/new"))
        .set("Authorization", &format!("Bearer {token}"))
        .set("Content-Type", "application/json")
        .send_string(&json!({"endpoint":endpoint}).to_string())?;
    let offer: PairingOffer = serde_json::from_reader(response.into_reader())?;
    // Validate the returned code before displaying it or constructing HTML.
    let parsed = PairingCode::parse(&offer.code)?;
    if parsed.endpoint != endpoint {
        bail!("pairing server returned a different PC address");
    }
    let qr = QrCode::new(offer.code.as_bytes())?;
    println!(
        "모바일 앱의 PC 연결 → QR 스캔에서 스캔하세요. 코드 유효 시간: {}분",
        offer.expires_in_seconds / 60
    );
    let terminal_qr = qr.render::<unicode::Dense1x2>().quiet_zone(true).build();
    if std::io::stdout().is_terminal() {
        // Keep QR ink black on white regardless of the terminal theme.
        println!("\x1b[30;47m{terminal_qr}\x1b[0m");
    } else {
        println!("{terminal_qr}");
    }
    println!("연결 코드 (복사해 붙여넣기):\n{}", offer.code);
    if let Some(path) = qr_file {
        let size = qr.width() + 8;
        let mut cells = String::new();
        for y in 0..qr.width() {
            for x in 0..qr.width() {
                if qr[(x, y)] == Color::Dark {
                    cells.push_str(&format!("M{} {}h1v1h-1z", x + 4, y + 4));
                }
            }
        }
        let html = format!(
            r#"<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OxiMemo PC 연결</title><style>body{{font:16px/1.6 system-ui;max-width:540px;margin:40px auto;padding:24px;color:#222;background:#fff}}svg{{width:100%;max-width:380px;image-rendering:pixelated}}code{{display:block;overflow-wrap:anywhere;padding:16px;background:#f3f3f3}}h1{{font-size:24px}}</style><h1>휴대폰에서 이 PC 연결</h1><p>{endpoint}</p><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" role="img" aria-label="OxiMemo 연결 QR"><rect width="{size}" height="{size}" fill="white"/><path d="{cells}" fill="black"/></svg><p>앱의 PC 연결 → QR 스캔으로 스캔하거나 아래 코드를 복사하세요.</p><code>{}</code><p>생성 후 10분 동안 유효하며 한 기기를 연결하면 사용이 완료됩니다. 새 코드를 만들면 이전 코드는 만료됩니다.</p></html>"#,
            offer.code
        );
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(path)?;
        file.write_all(html.as_bytes())?;
        file.sync_all()?;
        println!("QR 페이지: {}", path.display());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pairing_is_single_use_but_identical_retries_recover_the_response() {
        let mut session = PairingSession::new("https://pc.tail123.ts.net").unwrap();
        let request = PairingRequest {
            secret: session.code.secret.clone(),
            request_id: Uuid::now_v7().to_string(),
            expected_vault_id: Some("vault".into()),
        };
        let first = session
            .redeem(request.clone(), "vault", "credential")
            .unwrap();
        assert_eq!(first.token, "credential");
        assert_eq!(
            session
                .redeem(request.clone(), "vault", "credential")
                .unwrap()
                .token,
            first.token
        );
        let mut other = request.clone();
        other.request_id = Uuid::now_v7().to_string();
        assert!(session.redeem(other, "vault", "credential").is_err());
        session.deadline = Instant::now();
        assert!(session.redeem(request, "vault", "credential").is_err());
    }
    #[test]
    fn pairing_rejects_wrong_vault_and_locks_after_failed_attempts() {
        let mut session = PairingSession::new("https://pc.tail123.ts.net").unwrap();
        let mut request = PairingRequest {
            secret: session.code.secret.clone(),
            request_id: Uuid::now_v7().to_string(),
            expected_vault_id: Some("other-vault".into()),
        };
        assert!(
            session
                .redeem(request.clone(), "vault", "credential")
                .is_err()
        );
        assert!(session.redeemed_by.is_none());
        request.expected_vault_id = None;
        let correct = request.clone();
        request.secret = "wrong".into();
        for _ in 0..20 {
            assert!(
                session
                    .redeem(request.clone(), "vault", "credential")
                    .is_err()
            );
        }
        assert!(session.redeem(correct, "vault", "credential").is_err());
    }
    fn paths(dir: &Path) -> Paths {
        Paths {
            vault: dir.join("vault"),
            index_dir: dir.join("private"),
        }
    }
    fn create(id: &str) -> Operation {
        Operation {
            operation_id: Uuid::now_v7().to_string(),
            vault_id: id.into(),
            change: Change::Create {
                title: "Mobile".into(),
                body: "# Mobile\n\n==preserve==".into(),
                body_profile: "pdc-markdown/1".into(),
            },
        }
    }
    #[test]
    fn retries_do_not_duplicate_notes_and_reject_changed_payload() {
        let dir = tempfile::tempdir().unwrap();
        let paths = paths(dir.path());
        documents::ensure_manifest(&paths.vault).unwrap();
        let id = vault_id(&paths).unwrap();
        let operation = create(&id);
        let first = apply(&paths, &id, operation.clone()).unwrap();
        let replay = apply(&paths, &id, operation.clone()).unwrap();
        assert_eq!(first, replay);
        assert_eq!(pdc_inventory::scan(&paths).unwrap().items.len(), 1);
        let mut changed = operation;
        changed.change = Change::Create {
            title: "Different".into(),
            body: "x".into(),
            body_profile: "pdc-markdown/1".into(),
        };
        assert!(apply(&paths, &id, changed).is_err());
    }
    #[test]
    fn stale_update_is_blocked_and_unknown_properties_survive() {
        let dir = tempfile::tempdir().unwrap();
        let paths = paths(dir.path());
        documents::ensure_manifest(&paths.vault).unwrap();
        let id = vault_id(&paths).unwrap();
        let first = apply(&paths, &id, create(&id)).unwrap();
        let file = paths.vault.join(&first.path);
        let decorated = first.content.replace(
            "oximemo_editor: source",
            "oximemo_editor: source\n# owned comment\ncustom: {nested: [one, two]}",
        );
        fs::write(&file, &decorated).unwrap();
        let operation = Operation {
            operation_id: Uuid::now_v7().to_string(),
            vault_id: id.clone(),
            change: Change::Update {
                document_id: first.document_id.clone().unwrap(),
                expected_sha256: first.sha256,
                title: "Mobile".into(),
                body: "new".into(),
            },
        };
        assert!(
            apply(&paths, &id, operation)
                .unwrap_err()
                .to_string()
                .contains("external_change_conflict")
        );
        assert_eq!(fs::read_to_string(&file).unwrap(), decorated);
        let snapshot = source(&paths, &first.path).unwrap();
        let update = Operation {
            operation_id: Uuid::now_v7().to_string(),
            vault_id: id.clone(),
            change: Change::Update {
                document_id: snapshot.document_id.unwrap(),
                expected_sha256: snapshot.sha256,
                title: "Changed".into(),
                body: "new".into(),
            },
        };
        let result = apply(&paths, &id, update.clone()).unwrap();
        assert!(
            result
                .content
                .contains("# owned comment\ncustom: {nested: [one, two]}")
        );
        assert_eq!(apply(&paths, &id, update).unwrap(), result);
    }
    #[test]
    fn auth_and_source_containment() {
        assert!(token_matches("Bearer secret", "secret"));
        assert!(!token_matches("Bearer wrong", "secret"));
        let dir = tempfile::tempdir().unwrap();
        let paths = paths(dir.path());
        documents::ensure_manifest(&paths.vault).unwrap();
        for path in [
            "../secret.md",
            ".pdc/vault.json",
            "/etc/passwd",
            "folder/../../secret.md",
        ] {
            assert!(source(&paths, path).is_err());
        }
    }
    #[test]
    fn manifest_reports_hashes_and_tombstones_from_one_scan() {
        let dir = tempfile::tempdir().unwrap();
        let paths = paths(dir.path());
        documents::ensure_manifest(&paths.vault).unwrap();
        let id = vault_id(&paths).unwrap();
        let created = apply(&paths, &id, create(&id)).unwrap();

        // A second document carrying a canonical tombstone pair
        // (`deleted: true` + `deleted_at`), as the PC writer emits.
        let tombstoned = created.content.replacen(
            "---\n",
            "---\ndeleted: true\ndeleted_at: 2026-10-18T00:00:00.000Z\n",
            1,
        );
        fs::write(paths.vault.join("gone.md"), &tombstoned).unwrap();

        let value = route_request(&paths, &id, &Method::Get, "/v1/manifest", &[]).unwrap();
        let entries = value.get("entries").and_then(Value::as_array).unwrap();
        assert_eq!(entries.len(), 2);
        let by_path = |path: &str| {
            entries
                .iter()
                .find(|entry| entry.get("path").and_then(Value::as_str) == Some(path))
                .unwrap()
                .clone()
        };
        let live = by_path(&created.path);
        assert_eq!(
            live.get("deleted").and_then(Value::as_bool),
            Some(false),
            "live document must not be flagged deleted"
        );
        let expected_hash = source(&paths, &created.path).unwrap().sha256;
        assert_eq!(
            live.get("sha256").and_then(Value::as_str),
            Some(expected_hash.as_str()),
            "manifest hash must equal the guarded source hash"
        );
        let gone = by_path("gone.md");
        assert_eq!(
            gone.get("deleted").and_then(Value::as_bool),
            Some(true),
            "envelope deleted: true must surface as a tombstone"
        );
        assert!(gone.get("sha256").and_then(Value::as_str).is_some());
    }
}
