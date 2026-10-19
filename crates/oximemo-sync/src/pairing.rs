//! Ephemeral connection bootstrap, outside the document plane. Codes carry a
//! tailnet address and a random capability, never the reusable sync token.
use crate::{PROTOCOL, endpoint_url};
use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use std::time::Duration;

pub const PAIRING_TTL: u64 = 600;
const PREFIX: &str = "OM1:";

#[derive(Clone, Serialize, Deserialize)]
pub struct PairingCode {
    pub endpoint: String,
    pub secret: String,
}

impl PairingCode {
    pub fn new(endpoint: &str) -> Result<Self> {
        let endpoint = endpoint_url(endpoint)?.to_string();
        let mut random = [0u8; 16];
        getrandom::fill(&mut random)
            .map_err(|e| anyhow::anyhow!("could not generate pairing randomness: {e}"))?;
        let secret = random.iter().map(|b| format!("{b:02x}")).collect();
        Ok(Self { endpoint, secret })
    }
    pub fn encode(&self) -> Result<String> {
        let url = endpoint_url(&self.endpoint)?;
        validate_secret(&self.secret)?;
        let grouped = self
            .secret
            .as_bytes()
            .chunks(4)
            .map(|part| std::str::from_utf8(part).unwrap())
            .collect::<Vec<_>>()
            .join("-");
        Ok(format!("{PREFIX}{}#{grouped}", url.host_str().unwrap()))
    }
    pub fn parse(input: &str) -> Result<Self> {
        let input = input.trim();
        if input.len() > 512 {
            bail!("연결 코드가 너무 깁니다.");
        }
        let (host, secret) = input
            .strip_prefix(PREFIX)
            .and_then(|s| s.split_once('#'))
            .ok_or_else(|| {
                anyhow::anyhow!("OxiMemo 연결 QR 또는 OM1: 연결 코드를 입력해 주세요.")
            })?;
        // Host-only syntax excludes ports, credentials, paths and fragments.
        if host.is_empty()
            || !host
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        {
            bail!("연결 코드의 PC 주소가 올바르지 않습니다.");
        }
        let endpoint = endpoint_url(&format!("https://{host}/"))?.to_string();
        let secret = secret.replace('-', "").to_ascii_lowercase();
        validate_secret(&secret)?;
        Ok(Self { endpoint, secret })
    }
}

pub fn validate_secret(secret: &str) -> Result<()> {
    if secret.len() != 32
        || !secret
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        bail!("연결 코드가 올바르지 않습니다. PC에서 새 코드를 만들어 주세요.");
    }
    Ok(())
}

pub fn validate_token(token: &str) -> Result<()> {
    if !(32..=256).contains(&token.len())
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        bail!("연결 토큰이 올바르지 않습니다.");
    }
    Ok(())
}

#[derive(Clone, Serialize, Deserialize)]
pub struct PairingRequest {
    pub secret: String,
    pub request_id: String,
    pub expected_vault_id: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct PairingResponse {
    pub protocol: String,
    pub vault_id: String,
    pub token: String,
}
#[derive(Serialize, Deserialize)]
pub struct PairingOffer {
    pub code: String,
    pub expires_in_seconds: u64,
}

pub fn exchange(code: &PairingCode, request: &PairingRequest) -> Result<PairingResponse> {
    let url = endpoint_url(&code.endpoint)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .connect_timeout(Duration::from_secs(5))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let response = client.post(url.join("v1/pair")?).json(request).send()?;
    if !response.status().is_success() {
        // Do not reflect code, token, or raw server content into WebView errors.
        bail!(
            "연결하지 못했습니다 ({}). Tailscale 연결을 확인하거나 PC에서 새 코드를 만들어 주세요.",
            response.status()
        );
    }
    let value: PairingResponse = response.json()?;
    if value.protocol != PROTOCOL || value.vault_id.is_empty() {
        bail!("지원하지 않는 연결 서버입니다.");
    }
    if request
        .expected_vault_id
        .as_ref()
        .is_some_and(|id| id != &value.vault_id)
    {
        bail!("기존 메모와 다른 vault입니다. 초안을 유지했습니다.");
    }
    validate_token(&value.token)?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn codes_roundtrip_without_reusable_credentials() {
        let code = PairingCode::new("https://pc.tail123.ts.net").unwrap();
        let encoded = code.encode().unwrap();
        let parsed = PairingCode::parse(&encoded).unwrap();
        assert_eq!(parsed.endpoint, code.endpoint);
        assert_eq!(parsed.secret, code.secret);
        assert_eq!(parsed.secret.len(), 32);
        assert_ne!(
            PairingCode::new(&code.endpoint).unwrap().secret,
            code.secret
        );
        assert_eq!(
            PairingCode::parse(&encoded.to_uppercase()).unwrap().secret,
            code.secret
        );
    }
    #[test]
    fn codes_reject_non_tailnet_and_malformed_payloads() {
        for input in [
            "123456",
            "OM1:example.com#0123456789abcdef0123456789abcdef",
            "OM1:user@pc.tail.ts.net#0123456789abcdef0123456789abcdef",
            "OM1:pc.tail.ts.net/path#0123456789abcdef0123456789abcdef",
            "OM1:pc.tail.ts.net#short",
            "OM1:pc.tail.ts.net#0123456789abcdef0123456789abcdef#extra",
        ] {
            assert!(PairingCode::parse(input).is_err(), "{input}");
        }
    }
}
