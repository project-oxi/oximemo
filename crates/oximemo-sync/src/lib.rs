//! Mobile transport and durable offline projection. Canonical documents are
//! exact server source snapshots; drafts are separate editor state.
use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fs, io::Write, path::Path, time::Duration};
use uuid::Uuid;

pub mod pairing;

pub const PROTOCOL: &str = "oximemo-sync/1";
pub const MAX_REQUEST: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Entry {
    pub path: String,
    pub class: String,
    pub document_id: Option<String>,
    pub title: Option<String>,
    pub diagnostic: Option<Value>,
    #[serde(default)]
    pub deleted: bool,
    #[serde(default)]
    pub broken_document_links: Vec<String>,
    #[serde(default)]
    pub missing_assets: Vec<String>,
    #[serde(default)]
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Source {
    pub path: String,
    pub content: String,
    pub sha256: String,
    pub document_id: Option<String>,
    pub editable_body: Option<String>,
    pub title: Option<String>,
    pub body_profile: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub protocol: String,
    pub vault_id: String,
    pub entries: Vec<Entry>,
    pub duplicate_ids: Vec<Value>,
    pub manifest_diagnostic: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Change {
    Create {
        title: String,
        body: String,
        body_profile: String,
    },
    Update {
        document_id: String,
        expected_sha256: String,
        title: String,
        body: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Operation {
    pub operation_id: String,
    pub vault_id: String,
    pub change: Change,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CachedDocument {
    pub key: String,
    pub entry: Option<Entry>,
    pub source: Option<Source>,
    pub pending: Option<Operation>,
    pub error: Option<String>,
    #[serde(default)]
    pub attempted: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Cache {
    pub vault_id: Option<String>,
    pub documents: Vec<CachedDocument>,
    pub last_sync: Option<String>,
    pub diagnostics: Vec<Value>,
}

impl Cache {
    pub fn load(path: &Path) -> Result<Self> {
        match fs::read(path) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(e.into()),
        }
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        atomic_json(path, self)
    }

    pub fn queue(
        &mut self,
        key: Option<&str>,
        title: String,
        body: String,
        profile: String,
    ) -> Result<String> {
        if title.contains(['\n', '\r']) || title.len() > 1024 || body.len() > 4 * 1024 * 1024 {
            bail!("제목 또는 본문이 허용 범위를 넘었습니다.");
        }
        let vault_id = self.vault_id.clone().unwrap_or_default();
        let operation_id = Uuid::now_v7().to_string();
        if let Some(key) = key {
            let document = self
                .documents
                .iter_mut()
                .find(|d| d.key == key)
                .ok_or_else(|| anyhow::anyhow!("메모를 찾을 수 없습니다."))?;
            // An operation with an uncertain response must be immutable. Sync
            // retries exactly that payload before any further edit is queued.
            if document.pending.is_some() && document.attempted {
                bail!("이 초안을 먼저 동기화하거나 별도 메모로 보관해 주세요.");
            }
            if let Some(operation) = &document.pending
                && let Change::Create { body_profile, .. } = &operation.change
            {
                let profile = body_profile.clone();
                document.pending = Some(Operation {
                    operation_id,
                    vault_id,
                    change: Change::Create {
                        title,
                        body,
                        body_profile: profile,
                    },
                });
                return Ok(key.to_string());
            }
            let source = document
                .source
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("원문이 없습니다."))?;
            if source.editable_body.is_none()
                || document
                    .entry
                    .as_ref()
                    .is_none_or(|e| e.class != "document")
            {
                bail!("이 형식은 읽기 전용입니다.");
            }
            if document.entry.as_ref().is_some_and(|e| e.deleted) {
                bail!("휴지통 메모는 읽기 전용입니다. PC에서 복원해 주세요.");
            }
            let id = source
                .document_id
                .clone()
                .ok_or_else(|| anyhow::anyhow!("문서 ID가 없습니다."))?;
            if source.title.as_deref() == Some(&title)
                && source.editable_body.as_deref() == Some(&body)
            {
                // Reverting an unsent edit cancels it. The exact original
                // snapshot is already durable and needs no server write.
                document.pending = None;
                document.error = None;
                document.attempted = false;
                return Ok(key.to_string());
            }
            document.pending = Some(Operation {
                operation_id,
                vault_id,
                change: Change::Update {
                    document_id: id,
                    expected_sha256: source.sha256.clone(),
                    title,
                    body,
                },
            });
            document.error = None;
            Ok(key.to_string())
        } else {
            if !matches!(profile.as_str(), "pdc-markdown/1" | "pdc-html/1") {
                bail!("지원하지 않는 본문 형식입니다.");
            }
            let key = format!("draft:{operation_id}");
            self.documents.push(CachedDocument {
                key: key.clone(),
                pending: Some(Operation {
                    operation_id,
                    vault_id,
                    change: Change::Create {
                        title,
                        body,
                        body_profile: profile,
                    },
                }),
                ..Default::default()
            });
            Ok(key)
        }
    }

    pub fn keep_as_new(&mut self, key: &str) -> Result<String> {
        let document = self
            .documents
            .iter()
            .find(|d| d.key == key)
            .ok_or_else(|| anyhow::anyhow!("초안이 없습니다."))?;
        let operation = document
            .pending
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("초안이 없습니다."))?;
        let (title, body, profile) = match &operation.change {
            Change::Create {
                title,
                body,
                body_profile,
            } => (title.clone(), body.clone(), body_profile.clone()),
            Change::Update { title, body, .. } => (
                title.clone(),
                body.clone(),
                document
                    .source
                    .as_ref()
                    .and_then(|s| s.body_profile.clone())
                    .unwrap_or_else(|| "pdc-markdown/1".into()),
            ),
        };
        // Only a confirmed server rejection permits abandoning a request;
        // connection failures may have committed it already.
        if document
            .error
            .as_deref()
            .is_none_or(|e| !e.starts_with("rejected:"))
        {
            bail!("서버에서 충돌을 확인한 뒤 복사본을 만들 수 있습니다.");
        }
        let new_key = self.queue(None, title, body, profile)?;
        self.discard(key)?;
        Ok(new_key)
    }

    pub fn discard(&mut self, key: &str) -> Result<()> {
        let document = self
            .documents
            .iter_mut()
            .find(|d| d.key == key)
            .ok_or_else(|| anyhow::anyhow!("초안이 없습니다."))?;
        if document
            .error
            .as_deref()
            .is_none_or(|e| !e.starts_with("rejected:"))
        {
            bail!("결과를 확인할 수 없는 요청은 먼저 다시 동기화해 주세요.");
        }
        document.pending = None;
        document.error = None;
        document.attempted = false;
        Ok(())
    }
}

/// Atomically persist private state, with owner-only permissions on Unix.
pub fn atomic_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("missing state directory"))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".{}.tmp", Uuid::now_v7()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| -> Result<()> {
        let mut file = options.open(&temporary)?;
        file.write_all(&serde_json::to_vec(value)?)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        fs::File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

/// Accept tailnet HTTPS endpoints only; credentials never enter the WebView.
pub fn endpoint_url(input: &str) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(input.trim())?;
    let host = url.host_str().unwrap_or_default();
    if url.scheme() != "https"
        || !host.ends_with(".ts.net")
        || host == "ts.net"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || url.port().is_some_and(|p| p != 443)
    {
        bail!("Tailscale Serve의 https://PC.타일넷.ts.net 주소를 입력해 주세요.");
    }
    Ok(url)
}

pub fn synchronize(
    cache: &mut Cache,
    cache_path: &Path,
    endpoint: &str,
    token: &str,
) -> Result<()> {
    synchronize_reporting_keys(cache, cache_path, endpoint, token, &mut Default::default())
}

/// Session-only identity handoff for an open draft after PC creation.
/// Never stored in the vault or cache; available after partial errors too.
pub fn synchronize_reporting_keys(
    cache: &mut Cache,
    cache_path: &Path,
    endpoint: &str,
    token: &str,
    key_updates: &mut std::collections::BTreeMap<String, String>,
) -> Result<()> {
    let base = endpoint_url(endpoint)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    synchronize_with_transport_reporting_keys(cache, cache_path, &base, token, &client, key_updates)
}

// Kept private: the public entry always enforces tailnet HTTPS. Tests exercise
// this exact synchronization pipeline against a disposable loopback server.
#[cfg(test)]
fn synchronize_with_transport(
    cache: &mut Cache,
    cache_path: &Path,
    base: &reqwest::Url,
    token: &str,
    client: &reqwest::blocking::Client,
) -> Result<()> {
    synchronize_with_transport_reporting_keys(
        cache,
        cache_path,
        base,
        token,
        client,
        &mut Default::default(),
    )
}

fn synchronize_with_transport_reporting_keys(
    cache: &mut Cache,
    cache_path: &Path,
    base: &reqwest::Url,
    token: &str,
    client: &reqwest::blocking::Client,
    key_updates: &mut std::collections::BTreeMap<String, String>,
) -> Result<()> {
    let fetch_manifest = || -> Result<Manifest> {
        Ok(client
            .get(base.join("v1/manifest")?)
            .bearer_auth(token)
            .send()?
            .error_for_status()?
            .json()?)
    };
    let manifest = fetch_manifest()?;
    if manifest.protocol != PROTOCOL {
        bail!("지원하지 않는 동기화 서버 버전입니다.");
    }
    if cache
        .vault_id
        .as_ref()
        .is_some_and(|id| id != &manifest.vault_id)
    {
        bail!("다른 vault에 연결되었습니다. 기존 캐시와 초안을 유지했습니다.");
    }
    cache.vault_id = Some(manifest.vault_id.clone());
    cache.save(cache_path)?;
    let mut applied_any = false;
    for i in 0..cache.documents.len() {
        let Some(mut operation) = cache.documents[i].pending.clone() else {
            continue;
        };
        if operation.vault_id.is_empty() {
            operation.vault_id = manifest.vault_id.clone();
        }
        cache.documents[i].pending = Some(operation.clone());
        cache.documents[i].attempted = true;
        cache.save(cache_path)?;
        let response = match client
            .post(base.join("v1/apply")?)
            .bearer_auth(token)
            .json(&operation)
            .send()
        {
            Ok(response) => {
                applied_any = true;
                response
            }
            Err(error) => {
                cache.documents[i].error =
                    Some(format!("연결을 확인하고 다시 동기화해 주세요: {error}"));
                cache.save(cache_path)?;
                return Err(error.into());
            }
        };
        if !response.status().is_success() {
            let status = response.status();
            let message: Value = response.json().unwrap_or(Value::Null);
            let reason = message
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("서버 요청 실패");
            let prefix = if matches!(status.as_u16(), 409 | 422) {
                "rejected: "
            } else {
                "전송 결과를 다시 확인해 주세요: "
            };
            cache.documents[i].error = Some(format!("{prefix}{status} · {reason}"));
        } else {
            let source: Source = response.json()?;
            let previous_key = cache.documents[i].key.clone();
            cache.documents[i].key = source
                .document_id
                .clone()
                .unwrap_or_else(|| source.path.clone());
            if previous_key != cache.documents[i].key {
                key_updates.insert(previous_key, cache.documents[i].key.clone());
            }
            cache.documents[i].source = Some(source);
            cache.documents[i].pending = None;
            cache.documents[i].error = None;
            cache.documents[i].attempted = false;
        }
    }
    // Durably record apply results before the freshness manifest fetch.
    // Receipts make a retried operation idempotent if this sync aborts
    // between the server ack and the next save.
    cache.save(cache_path)?;
    // No apply was sent, so no PC write happened through us and the first
    // manifest is still current: skip the second full-manifest fetch that
    // every resume sync otherwise paid.
    let manifest = if applied_any {
        let manifest = fetch_manifest()?;
        if manifest.vault_id != cache.vault_id.clone().unwrap_or_default()
            || manifest.protocol != PROTOCOL
        {
            bail!("동기화 도중 서버 vault가 바뀌었습니다.");
        }
        manifest
    } else {
        manifest
    };

    reconcile(cache, &manifest);
    cache.save(cache_path)?;
    for i in 0..cache.documents.len() {
        if cache.documents[i].pending.is_some() {
            continue;
        }
        let Some(entry) = cache.documents[i].entry.clone() else {
            continue;
        };
        let Some(hash) = &entry.sha256 else {
            continue;
        };
        if cache.documents[i]
            .source
            .as_ref()
            .is_some_and(|s| &s.sha256 == hash)
        {
            continue;
        }
        let response = client
            .post(base.join("v1/source")?)
            .bearer_auth(token)
            .json(&serde_json::json!({"path":entry.path}))
            .send()?;
        if response.status().is_success() {
            cache.documents[i].source = Some(response.json()?);
            cache.documents[i].error = None;
        } else {
            cache.documents[i].error =
                Some(format!("원문을 가져올 수 없습니다: {}", response.status()));
        }
    }
    cache.last_sync = Some(format!(
        "{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs()
    ));
    cache.save(cache_path)
}

#[cfg(test)]
mod transport_tests;

pub fn reconcile(cache: &mut Cache, manifest: &Manifest) {
    cache.diagnostics = manifest.duplicate_ids.clone();
    if let Some(diagnostic) = &manifest.manifest_diagnostic {
        cache.diagnostics.push(diagnostic.clone());
    }
    let duplicate_ids: std::collections::HashSet<&str> = manifest
        .duplicate_ids
        .iter()
        .filter_map(|v| v.get("document_id").and_then(Value::as_str))
        .collect();
    let key_of = |entry: &Entry| -> String {
        // Duplicates are separate visible entries, never silently pick one.
        if entry
            .document_id
            .as_deref()
            .is_some_and(|id| duplicate_ids.contains(id))
        {
            format!("path:{}", entry.path)
        } else {
            entry
                .document_id
                .clone()
                .unwrap_or_else(|| format!("path:{}", entry.path))
        }
    };
    // One pass builds the key index so retain and the update loop are
    // lookups instead of O(documents × entries) scans with per-pair clones.
    let entry_keys: Vec<String> = manifest.entries.iter().map(key_of).collect();
    let live_keys: std::collections::HashSet<&str> =
        entry_keys.iter().map(String::as_str).collect();
    cache
        .documents
        .retain(|d| d.pending.is_some() || live_keys.contains(d.key.as_str()));
    let mut position: std::collections::HashMap<String, usize> =
        std::collections::HashMap::with_capacity(cache.documents.len());
    for (index, document) in cache.documents.iter().enumerate() {
        position.entry(document.key.clone()).or_insert(index);
    }
    for (entry, key) in manifest.entries.iter().zip(entry_keys.iter()) {
        match position.get(key.as_str()) {
            Some(&index) => {
                let document = &mut cache.documents[index];
                document.entry = Some(entry.clone());
                // Keep the exact editor snapshot until the pending operation is
                // resolved, even if PC moved, deleted, or changed the document.
                if document.pending.is_none()
                    && let Some(source) = &mut document.source
                {
                    source.path = entry.path.clone();
                }
            }
            None => {
                position.insert(key.clone(), cache.documents.len());
                cache.documents.push(CachedDocument {
                    key: key.clone(),
                    entry: Some(entry.clone()),
                    ..Default::default()
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn endpoints_reject_credentials_http_and_non_tailnet_hosts() {
        assert!(endpoint_url("https://desktop.tail123.ts.net").is_ok());
        for url in [
            "http://desktop.tail123.ts.net",
            "https://example.com",
            "https://u:p@pc.tail.ts.net",
            "https://pc.tail.ts.net/redirect",
            "https://pc.tail.ts.net:8443",
            "https://pc.tail.ts.net/?x=1",
        ] {
            assert!(endpoint_url(url).is_err(), "{url}");
        }
    }
    #[test]
    fn drafts_survive_restart_and_remote_removal() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("cache.json");
        let mut cache = Cache::default();
        let key = cache
            .queue(
                None,
                "제목".into(),
                "==원문==\n%%보존%%".into(),
                "pdc-markdown/1".into(),
            )
            .unwrap();
        cache.save(&path).unwrap();
        let mut restored = Cache::load(&path).unwrap();
        reconcile(
            &mut restored,
            &Manifest {
                protocol: PROTOCOL.into(),
                vault_id: "vault".into(),
                entries: vec![],
                duplicate_ids: vec![],
                manifest_diagnostic: None,
            },
        );
        assert_eq!(restored.documents[0].key, key);
        assert_eq!(restored.documents[0].pending, cache.documents[0].pending);
        assert!(restored.discard(&key).is_err());
    }
    #[test]
    fn conflict_copy_preserves_draft_and_profile() {
        let mut cache = Cache::default();
        let key = cache
            .queue(
                None,
                "HTML".into(),
                "<p>text</p>".into(),
                "pdc-html/1".into(),
            )
            .unwrap();
        cache.documents[0].error = Some("rejected: 409".into());
        let copy = cache.keep_as_new(&key).unwrap();
        assert_ne!(copy, key);
        assert!(cache.documents[0].pending.is_none());
        assert!(!cache.documents[0].attempted);
        assert!(
            matches!(&cache.documents[1].pending.as_ref().unwrap().change, Change::Create { body_profile, .. } if body_profile == "pdc-html/1")
        );
    }

    #[test]
    fn unsent_drafts_remain_editable_but_attempted_payloads_are_immutable() {
        let mut cache = Cache::default();
        let key = cache
            .queue(None, "First".into(), "one".into(), "pdc-markdown/1".into())
            .unwrap();
        cache
            .queue(
                Some(&key),
                "Second".into(),
                "two".into(),
                "pdc-markdown/1".into(),
            )
            .unwrap();
        let pending = cache.documents[0].pending.clone();
        assert!(
            matches!(pending.as_ref().unwrap().change, Change::Create { ref title, .. } if title == "Second")
        );
        cache.documents[0].attempted = true;
        assert!(
            cache
                .queue(
                    Some(&key),
                    "Third".into(),
                    "three".into(),
                    "pdc-markdown/1".into()
                )
                .is_err()
        );
        assert_eq!(cache.documents[0].pending, pending);
        cache.documents[0].error = Some("rejected: 409".into());
        cache.discard(&key).unwrap();
        assert!(!cache.documents[0].attempted);
    }

    #[test]
    fn rename_keeps_uuid_and_remote_change_does_not_replace_an_edit_snapshot() {
        let entry = Entry {
            path: "old.md".into(),
            class: "document".into(),
            document_id: Some("stable-id".into()),
            title: Some("".into()),
            diagnostic: None,
            deleted: false,
            broken_document_links: vec![],
            missing_assets: vec![],
            sha256: Some("original".into()),
        };
        let source = Source {
            path: entry.path.clone(),
            content: "exact\r\nsource".into(),
            sha256: "original".into(),
            document_id: entry.document_id.clone(),
            editable_body: Some("body".into()),
            title: Some("".into()),
            body_profile: Some("pdc-markdown/1".into()),
        };
        let mut cache = Cache {
            documents: vec![CachedDocument {
                key: "stable-id".into(),
                entry: Some(entry.clone()),
                source: Some(source.clone()),
                ..Default::default()
            }],
            ..Default::default()
        };
        cache
            .queue(
                Some("stable-id"),
                "".into(),
                "edited".into(),
                "pdc-markdown/1".into(),
            )
            .unwrap();
        let mut renamed = entry;
        renamed.path = "renamed.md".into();
        renamed.sha256 = Some("remote-change".into());
        reconcile(
            &mut cache,
            &Manifest {
                protocol: PROTOCOL.into(),
                vault_id: "vault".into(),
                entries: vec![renamed],
                duplicate_ids: vec![],
                manifest_diagnostic: None,
            },
        );
        assert_eq!(cache.documents.len(), 1);
        assert_eq!(cache.documents[0].source, Some(source));
        assert_eq!(
            cache.documents[0].entry.as_ref().unwrap().path,
            "renamed.md"
        );
        assert!(
            matches!(&cache.documents[0].pending.as_ref().unwrap().change, Change::Update { expected_sha256, title, .. } if expected_sha256 == "original" && title.is_empty())
        );
        cache
            .queue(
                Some("stable-id"),
                "".into(),
                "body".into(),
                "pdc-markdown/1".into(),
            )
            .unwrap();
        assert!(cache.documents[0].pending.is_none());
    }
}
