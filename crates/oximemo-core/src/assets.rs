//! Image asset storage for the vault.
//!
//! Images live as real files under `<vault>/assets/<blake3hex16>.<ext>`, keyed
//! by a content hash of their bytes so identical images dedup automatically.
//! Memos reference them with the app-relative `oximg://<name>` scheme, which the
//! Tauri shell resolves to the file (and browser-dev mode resolves to an
//! IndexedDB blob) — see the frontend `lib/assets.ts`.
//!
//! Only the file store is touched (no index, no lock): assets are content
//! addressed, so concurrent writers that produce the same bytes collide on the
//! same filename harmlessly, and a partial write is simply overwritten.

use std::collections::HashSet;
use serde::{Deserialize, Serialize};

use time::OffsetDateTime;

use crate::error::{CoreError, Result};

/// File-name stem length for a content-hashed asset (first 16 hex chars of a
/// blake3 digest). 16 hex = 64 bits — ample collision resistance for a single
/// user's image library, and short enough to stay readable in raw markdown.
pub const HASH_LEN: usize = 16;

/// Extensions the WKWebView can render inline. HEIC/RAW are excluded on
/// purpose; convert upstream (or add a converter) before widening this set.
pub const ALLOWED_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp"];

/// A reference returned to the frontend after saving an image. `url` is the
/// exact string to drop into markdown (`oximg://<name>`); `name` is the bare
/// `<hash>.<ext>` used by the gallery and GC.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetRef {
    pub url: String,
    pub name: String,
}

/// One row of the gallery: a discoverable asset plus its size and mtime.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetInfo {
    pub name: String,
    pub url: String,
    pub ext: String,
    pub bytes: u64,
    #[serde(with = "time::serde::rfc3339")]
    pub modified: OffsetDateTime,
}

/// Normalize an extension to lowercase ASCII without a leading dot, or reject
/// anything outside the whitelist.
pub fn normalize_ext(ext: &str) -> Result<&'static str> {
    let e = ext.trim().trim_start_matches('.').to_ascii_lowercase();
    let allowed = ALLOWED_EXTS
        .iter()
        .copied()
        .find(|a| *a == e)
        .ok_or_else(|| CoreError::AssetRejected(format!("unsupported extension: .{e}")))?;
    Ok(allowed)
}

/// Content-hash raw image bytes to a bare asset name (`<hex16>.<ext>`).
pub fn asset_name(bytes: &[u8], ext: &str) -> String {
    let hex = blake3::hash(bytes).to_hex();
    let stem = &hex.as_str()[..HASH_LEN];
    format!("{stem}.{ext}")
}

/// Strict validator for a served asset name. Permits only `<hex16>.<allowed>`
/// — no path separators, no `..`, no query/fragment. The protocol handler and
/// the GC both gate on this.
pub fn valid_name(name: &str) -> bool {
    let Some((stem, ext)) = name.split_once('.') else {
        return false;
    };
    stem.len() == HASH_LEN
        && stem.bytes().all(|b| b.is_ascii_hexdigit())
        && ALLOWED_EXTS.contains(&ext)
        && !name.contains('/')
        && !name.contains('\\')
}

/// Content-Type for a whitelisted extension.
pub fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

/// The extension portion of a validated asset name (without the dot), or `None`
/// if the name is malformed.
pub fn ext_of(name: &str) -> Option<&'static str> {
    let ext = name.split('.').nth(1)?;
    ALLOWED_EXTS.iter().copied().find(|a| *a == ext)
}

/// Extract every `oximg://<name>` reference from a memo body. Used by the GC to
/// decide which assets are still live. `OXIMG_RE` is deliberately permissive on
/// the markdown wrapper (`![alt](…)`, bare URL, or `](…)`-less fragments) so a
/// reference survives even if a user hand-edits the alt text.
pub fn refs_in_body(body: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    let mut rest = body;
    while let Some(start) = rest.find("oximg://") {
        rest = &rest[start + "oximg://".len()..];
        // Canonical form is `oximg://localhost/<name>` (host is `localhost` so
        // the name lands in the path, per RFC 3986 / Tauri's macOS origin).
        // Tolerate a bare `oximg://<name>` too by skipping an optional host.
        if let Some(after) = rest.strip_prefix("localhost/") {
            rest = after;
        }
        // The name runs until the first char that cannot belong to it — i.e.
        // anything that is not alphanumeric or `.` (parens, spaces, `#`, `?`,
        // slashes). Extension letters like `png` are alphabetic, so they must
        // be included; `valid_name` then rejects malformed candidates.
        let end = rest
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '.'))
            .unwrap_or(rest.len());
        let candidate = &rest[..end];
        if valid_name(candidate) {
            out.insert(candidate.to_string());
        }
        rest = &rest[end..];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_rejects_unknown() {
        assert_eq!(normalize_ext("PNG").unwrap(), "png");
        assert!(normalize_ext("heic").is_err());
        assert!(normalize_ext("").is_err());
    }

    #[test]
    fn name_round_trips_validation() {
        let bytes = b"hello";
        let name = asset_name(bytes, "png");
        assert!(valid_name(&name));
        assert_eq!(ext_of(&name), Some("png"));
        assert_eq!(name.split('.').next().unwrap().len(), HASH_LEN);
    }

    #[test]
    fn valid_name_rejects_traversal() {
        assert!(!valid_name("../etc/passwd"));
        assert!(!valid_name("abc.png"));
        assert!(!valid_name("deadbeefdeadbeef.exe"));
        assert!(!valid_name("deadbeefdeadbeef.png/../../x"));
        assert!(valid_name("deadbeefdeadbeef.png"));
    }

    #[test]
    fn refs_extract_markdown_and_bare() {
        let body = "see ![shot](oximg://localhost/deadbeefdeadbeef.png) and \
                    oximg://localhost/cafef00dcafef00d.gif trailing";
        let refs = refs_in_body(body);
        assert_eq!(refs.len(), 2);
        assert!(refs.contains("deadbeefdeadbeef.png"));
        assert!(refs.contains("cafef00dcafef00d.gif"));
    }

    #[test]
    fn refs_ignore_width_fragment_and_query() {
        // `#w=400` must terminate the name, not be absorbed into it.
        let body = "![](oximg://localhost/deadbeefdeadbeef.png#w=400)";
        let refs = refs_in_body(body);
        assert!(refs.contains("deadbeefdeadbeef.png"));
        assert_eq!(refs.len(), 1);
    }

    #[test]
    fn mime_mapping() {
        assert_eq!(mime_for_ext("png"), "image/png");
        assert_eq!(mime_for_ext("jpeg"), "image/jpeg");
        assert_eq!(mime_for_ext("webp"), "image/webp");
    }

    #[test]
    fn dedup_is_content_addressed() {
        let bytes = b"identical";
        assert_eq!(asset_name(bytes, "png"), asset_name(bytes, "png"));
    }
}
