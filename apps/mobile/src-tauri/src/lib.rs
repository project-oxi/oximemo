use oximemo_sync::pairing::{PairingCode, PairingRequest, exchange};
use oximemo_sync::{Cache, atomic_json, endpoint_url, synchronize_reporting_keys};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Mutex};
use tauri::{Manager, State};

#[derive(Default, Serialize, Deserialize)]
struct Connection {
    endpoint: String,
    token: String,
}
impl Connection {
    fn updated(&self, endpoint: &str, token: &str) -> Result<Self, String> {
        let endpoint = endpoint_url(endpoint)
            .map_err(|e| e.to_string())?
            .to_string();
        let token = token.trim();
        if token.is_empty() && endpoint != self.endpoint {
            return Err("PC 주소를 바꿀 때는 해당 PC의 연결 토큰을 입력해 주세요.".into());
        }
        let token = if token.is_empty() {
            self.token.clone()
        } else {
            token.to_string()
        };
        if token.len() < 32
            || token.len() > 256
            || !token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err("PC에서 만든 32자 이상의 연결 토큰을 입력해 주세요.".into());
        }
        Ok(Self { endpoint, token })
    }
}
struct MobileState {
    directory: PathBuf,
    cache: Mutex<Cache>,
    connection: Mutex<Connection>,
    pairing_lock: Mutex<()>,
    key_updates: Mutex<std::collections::BTreeMap<String, String>>,
}
#[derive(Serialize)]
struct View {
    cache: Cache,
    endpoint: String,
    paired: bool,
    key_updates: std::collections::BTreeMap<String, String>,
}

/// Lock a std Mutex, recovering from poison. The guarded state is plain
/// cache/connection data that stays structurally valid after a panic in
/// some other command; without recovery one such panic would brick every
/// command with a raw poison error until the app restarts.
fn lock_ok<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
fn view(state: &MobileState) -> Result<View, String> {
    let cache = lock_ok(&state.cache).clone();
    let connection = lock_ok(&state.connection);
    Ok(View {
        cache,
        endpoint: connection.endpoint.clone(),
        paired: !connection.token.is_empty(),
        key_updates: lock_ok(&state.key_updates).clone(),
    })
}
#[tauri::command]
fn mobile_state(state: State<MobileState>) -> Result<View, String> {
    view(&state)
}
#[tauri::command]
fn mobile_pair_preview(code: String) -> Result<String, String> {
    PairingCode::parse(&code)
        .map(|value| value.endpoint)
        .map_err(|e| e.to_string())
}

#[derive(Serialize, Deserialize)]
struct PendingPair {
    code: String,
    request_id: String,
}

#[tauri::command]
async fn mobile_pair(app: tauri::AppHandle, code: String) -> Result<View, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<MobileState>();
        let _guard = lock_ok(&state.pairing_lock);
        let parsed = PairingCode::parse(&code).map_err(|e| e.to_string())?;
        let canonical_code = parsed.encode().map_err(|e| e.to_string())?;
        let pending_path = state.directory.join("pending-pair.json");
        let previous: Option<PendingPair> = match std::fs::read(&pending_path) {
            Ok(bytes) => Some(
                serde_json::from_slice(&bytes)
                    .map_err(|_| "저장된 연결 요청을 읽을 수 없습니다.".to_string())?,
            ),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.to_string()),
        };
        let pending = previous
            .filter(|p| p.code == canonical_code)
            .unwrap_or_else(|| PendingPair {
                code: canonical_code,
                request_id: uuid::Uuid::now_v7().to_string(),
            });
        atomic_json(&pending_path, &pending).map_err(|e| e.to_string())?;
        let expected_vault_id = state
            .cache
            .lock()
            .map_err(|e| e.to_string())?
            .vault_id
            .clone();
        let response = exchange(
            &parsed,
            &PairingRequest {
                secret: parsed.secret.clone(),
                request_id: pending.request_id,
                expected_vault_id,
            },
        )
        .map_err(|e| e.to_string())?;
        {
            let mut cache = lock_ok(&state.cache);
            if cache
                .vault_id
                .as_ref()
                .is_some_and(|id| id != &response.vault_id)
            {
                return Err("다른 vault입니다. 기존 초안을 유지했습니다.".into());
            }
            let mut candidate = cache.clone();
            candidate.vault_id = Some(response.vault_id);
            candidate
                .save(&state.directory.join("cache.json"))
                .map_err(|e| e.to_string())?;
            *cache = candidate;
        }
        {
            let mut connection = lock_ok(&state.connection);
            let candidate = Connection {
                endpoint: parsed.endpoint,
                token: response.token,
            };
            atomic_json(&state.directory.join("connection.json"), &candidate)
                .map_err(|e| e.to_string())?;
            *connection = candidate;
        }
        // Retain the request nonce in private state, so retrying after a
        // process crash still recovers the identical server redemption.
        view(&state)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn mobile_connect(
    state: State<MobileState>,
    endpoint: String,
    token: String,
) -> Result<View, String> {
    let mut connection = lock_ok(&state.connection);
    let candidate = connection.updated(&endpoint, &token)?;
    atomic_json(&state.directory.join("connection.json"), &candidate).map_err(|e| e.to_string())?;
    *connection = candidate;
    drop(connection);
    view(&state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_connection_reuses_credentials_only_for_the_same_pc() {
        let connection = Connection {
            endpoint: "https://pc.tail123.ts.net/".into(),
            token: "a".repeat(64),
        };
        assert_eq!(
            connection
                .updated("https://pc.tail123.ts.net", "")
                .unwrap()
                .token,
            connection.token
        );
        assert!(
            connection
                .updated("https://other.tail123.ts.net", "")
                .is_err()
        );
        assert!(
            connection
                .updated("https://other.tail123.ts.net", &"b".repeat(64))
                .is_ok()
        );
        assert!(
            connection
                .updated("http://pc.tail123.ts.net", &connection.token)
                .is_err()
        );
        assert!(
            connection
                .updated("https://pc.tail123.ts.net:8443", &connection.token)
                .is_err()
        );
    }
}
#[tauri::command]
fn mobile_save(
    state: State<MobileState>,
    key: Option<String>,
    title: String,
    body: String,
    profile: String,
) -> Result<View, String> {
    let mut cache = lock_ok(&state.cache);
    // Only publish an in-memory edit after durable persistence succeeds.
    let mut candidate = cache.clone();
    candidate
        .queue(key.as_deref(), title, body, profile)
        .map_err(|e| e.to_string())?;
    candidate
        .save(&state.directory.join("cache.json"))
        .map_err(|e| e.to_string())?;
    *cache = candidate;
    drop(cache);
    view(&state)
}
#[tauri::command]
fn mobile_resolve(state: State<MobileState>, key: String, keep: bool) -> Result<View, String> {
    let mut cache = lock_ok(&state.cache);
    let mut candidate = cache.clone();
    if keep {
        candidate.keep_as_new(&key).map_err(|e| e.to_string())?;
    } else {
        candidate.discard(&key).map_err(|e| e.to_string())?;
    }
    candidate
        .save(&state.directory.join("cache.json"))
        .map_err(|e| e.to_string())?;
    *cache = candidate;
    drop(cache);
    view(&state)
}
#[tauri::command]
async fn mobile_sync(app: tauri::AppHandle) -> Result<View, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<MobileState>();
        let (endpoint, token) = {
            let connection = lock_ok(&state.connection);
            (connection.endpoint.clone(), connection.token.clone())
        };
        if token.is_empty() {
            return Err("먼저 PC를 연결해 주세요.".into());
        }
        // Snapshot, sync off-lock, publish under a short lock. Holding the
        // cache mutex across every HTTP round trip blocked mobile_state,
        // mobile_save, and mobile_resolve for the whole network window.
        let snapshot = lock_ok(&state.cache).clone();
        let mut candidate = snapshot.clone();
        let mut key_updates = lock_ok(&state.key_updates).clone();
        let result = synchronize_reporting_keys(
            &mut candidate,
            &state.directory.join("cache.json"),
            &endpoint,
            &token,
            &mut key_updates,
        );
        {
            let mut cache = lock_ok(&state.cache);
            let unchanged = serde_json::to_vec(&*cache).ok() == serde_json::to_vec(&snapshot).ok();
            if unchanged {
                // Publish even on Err: per-document send errors and retry
                // state must stay visible, matching the old lock-held path.
                *cache = candidate;
                drop(cache);
                state
                    .key_updates
                    .lock()
                    .map_err(|e| e.to_string())?
                    .extend(key_updates);
            } else {
                // A concurrent save/pairing won the race; its version is
                // already durable. Keep it and let the next sync re-run.
                return Err("동기화 중 상태가 바뀌었습니다. 다시 동기화해 주세요.".into());
            }
        }
        result.map_err(|e| e.to_string())?;
        view(&state)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(any(target_os = "android", target_os = "ios"))]
            app.handle().plugin(tauri_plugin_barcode_scanner::init())?;
            let directory = app.path().app_data_dir()?;
            std::fs::create_dir_all(&directory)?;
            let cache = Cache::load(&directory.join("cache.json"))?;
            let connection = match std::fs::read(directory.join("connection.json")) {
                Ok(bytes) => serde_json::from_slice(&bytes)?,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Connection::default(),
                Err(e) => return Err(e.into()),
            };
            app.manage(MobileState {
                directory,
                cache: Mutex::new(cache),
                connection: Mutex::new(connection),
                pairing_lock: Mutex::new(()),
                key_updates: Mutex::new(Default::default()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            mobile_state,
            mobile_connect,
            mobile_pair_preview,
            mobile_pair,
            mobile_save,
            mobile_resolve,
            mobile_sync
        ])
        .run(tauri::generate_context!())
        .expect("error while running OxiMemo Mobile");
}
