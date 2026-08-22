//! Content hashing with deterministic normalization (§5.3).
//!
//! The hash covers a memo's full *meaningful state* — body, tags, favorite flag,
//! and color — so the sync diff (§9.2) detects metadata-only edits (tag/favorite/
//! color changes), not just body edits. The digest must be stable regardless
//! of how a memo was written — vim's atomic-rename, a shell redirect, or
//! oximemo's own writer must all produce the same digest for identical state.
//! Normalization therefore precedes hashing.

use blake3::Hasher;
use unicode_normalization::UnicodeNormalization;

use crate::memo::MemoHash;

/// Normalize note body bytes before hashing.
///
/// Rules (§5.3):
/// 1. newlines normalized to `\n`
/// 2. trailing whitespace stripped from each line
/// 3. text Unicode-NFC normalized
/// 4. exactly one trailing newline
///
/// Input is treated as UTF-8; replacement chars are used for invalid bytes so
/// hashing never fails on a partially-written file.
pub fn normalize(input: &[u8]) -> String {
    let text = String::from_utf8_lossy(input);

    // 1. normalize newlines
    let text = text.replace("\r\n", "\n").replace('\r', "\n");

    // 2. + 3. strip trailing whitespace per line, then NFC
    let mut out = String::with_capacity(text.len());
    for line in text.split('\n') {
        let trimmed = line.trim_end();
        let nfc: String = trimmed.nfc().collect();
        out.push_str(&nfc);
        out.push('\n');
    }

    // 4. collapse multiple trailing newlines to exactly one
    while out.ends_with("\n\n") {
        out.pop();
    }
    if !out.ends_with('\n') {
        out.push('\n');
    }
    // empty file → single newline
    if out == "\n" && text.is_empty() {
        // keep as-is: empty body normalizes to one newline
    }
    out
}

/// Hash normalized content, returning a prefixed `b3:` digest.
pub fn hash_content(input: &[u8]) -> MemoHash {
    let normalized = normalize(input);
    let mut hasher = Hasher::new();
    hasher.update(normalized.as_bytes());
    MemoHash::new(hasher.finalize().to_hex().to_string())
}

/// Hash an already-normalized string. Used internally when the body has been
/// produced by our own writer and is known-normal.
pub fn hash_normalized(normalized: &str) -> MemoHash {
    let mut hasher = Hasher::new();
    hasher.update(normalized.as_bytes());
    MemoHash::new(hasher.finalize().to_hex().to_string())
}

/// Hash a memo's full meaningful state: body + favorite flag + properties
/// (design 2026-08-23 §5.1).
///
/// Deliberately excluded from the input:
/// - `hash` (avoids a self-referential cycle),
/// - `id` / `created_at` (immutable after creation),
/// - `updated_at` (it is the sync *cursor*, not content),
/// - `deleted_at` (tombstones travel via the manifest's `deleted` flag).
/// - `path` / `title` (derived from location + body, not intrinsic state).
///
/// Because the favorite flag and every property are part of the digest,
/// toggling favorite or changing `status` changes the hash and is correctly
/// surfaced by the sync diff. Tags live in the body, so a tag change IS a
/// body change. Properties hash through their canonical `as_hash_str`
/// rendering over a BTreeMap, so key order can never desynchronize two
/// semantically equal property sets.
pub fn hash_memo(body: &[u8], favorite: bool, props: &crate::props::Props) -> MemoHash {
    let normalized_body = normalize(body);
    let mut hasher = Hasher::new();
    hasher.update(normalized_body.as_bytes());
    hasher.update(b"\x1f"); // unit separator between fields
    hasher.update(if favorite { b"1" } else { b"0" });
    for (key, value) in props {
        hasher.update(b"\x1f");
        hasher.update(key.as_bytes());
        hasher.update(b"=");
        hasher.update(value.as_hash_str().as_bytes());
    }
    MemoHash::new(hasher.finalize().to_hex().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crlf_and_lf_hash_equal() {
        let a = hash_content(b"hello\nworld");
        let b = hash_content(b"hello\r\nworld");
        assert_eq!(a, b);
    }

    #[test]
    fn trailing_whitespace_ignored() {
        let a = hash_content(b"line one   \nline two");
        let b = hash_content(b"line one\nline two");
        assert_eq!(a, b);
    }

    #[test]
    fn trailing_newline_normalized() {
        let a = hash_content(b"text\n\n\n");
        let b = hash_content(b"text");
        assert_eq!(a, b);
    }

    #[test]
    fn nfc_normalization() {
        // U+0041 U+0301 (A + combining acute) vs U+00C1 (precomposed Á)
        let a = hash_content("A\u{301}".as_bytes());
        let b = hash_content("\u{C1}".as_bytes());
        assert_eq!(a, b);
    }

    #[test]
    fn hash_is_prefixed() {
        let h = hash_content(b"x");
        assert!(h.as_str().starts_with("b3:"));
    }

    #[test]
    fn metadata_only_edit_changes_hash() {
        // Favorite flag still changes the hash (§9.2). Tags are derived from the
        // body now, so a tag change IS a body change — covered below.
        let base = hash_memo(b"body", false, &Default::default());
        let favorite = hash_memo(b"body", true, &Default::default());
        assert_ne!(base, favorite);
    }
    #[test]
    fn tag_in_body_changes_hash() {
        // Adding `#x` to the body changes the digest (tags live in the body).
        let a = hash_memo(b"note", false, &Default::default());
        let b = hash_memo(b"note #x", false, &Default::default());
        assert_ne!(a, b);
    }

    #[test]
    fn property_change_changes_digest() {
        let mut props = crate::props::Props::new();
        let a = hash_memo(b"body", false, &props);
        props.insert("status".into(), crate::props::PropValue::Str("stub".into()));
        let b = hash_memo(b"body", false, &props);
        assert_ne!(a, b, "a property-only edit must surface in the sync diff");
    }

#[test]
    fn identical_state_hashes_equal() {
        let a = hash_memo(b"body", true, &Default::default());
        let b = hash_memo(b"body", true, &Default::default());
        assert_eq!(a, b);
    }
}
