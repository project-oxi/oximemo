//! Content hashing with deterministic normalization (§5.3).
//!
//! The hash covers a note's full *meaningful state* — body, tags, pin flag,
//! and color — so the sync diff (§9.2) detects metadata-only edits (tag/pin/
//! color changes), not just body edits. The digest must be stable regardless
//! of how a note was written — vim's atomic-rename, a shell redirect, or
//! oxinot's own writer must all produce the same digest for identical state.
//! Normalization therefore precedes hashing.

use blake3::Hasher;
use unicode_normalization::UnicodeNormalization;

use crate::note::MemoHash;

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

/// Hash a note's full meaningful state: body + tags + pinned + color (§5.3).
///
/// Deliberately excluded from the input:
/// - `hash` (avoids a self-referential cycle),
/// - `id` / `created_at` (immutable after creation),
/// - `updated_at` (it is the sync *cursor*, not content),
/// - `deleted_at` (tombstones travel via the manifest's `deleted` flag).
///
/// Because tags, pin, and color are part of the digest, editing any of them
/// changes the hash and is correctly surfaced by the sync diff — closing the
/// gap where a metadata-only edit would otherwise look "unchanged".
pub fn hash_memo(body: &[u8], pinned: bool, category: &str) -> MemoHash {
    let normalized_body = normalize(body);
    let mut hasher = Hasher::new();
    hasher.update(normalized_body.as_bytes());
    hasher.update(b"\x1f"); // unit separator between fields
    hasher.update(if pinned { b"1" } else { b"0" });
    hasher.update(b"\x1f");
    hasher.update(category.as_bytes());
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
        // Pin / color still change the hash (§9.2). Tags are derived from the
        // body now, so a tag change IS a body change — covered below.
        let base = hash_memo(b"body", false, "");
        let pinned = hash_memo(b"body", true, "");
        let colored = hash_memo(b"body", false, "todo");
        assert_ne!(base, pinned);
        assert_ne!(base, colored);
    }
    #[test]
    fn tag_in_body_changes_hash() {
        // Adding `#x` to the body changes the digest (tags live in the body).
        let a = hash_memo(b"note", false, "");
        let b = hash_memo(b"note #x", false, "");
        assert_ne!(a, b);
    }

    #[test]
    fn identical_state_hashes_equal() {
        let a = hash_memo(b"body", true, "todo");
        let b = hash_memo(b"body", true, "todo");
        assert_eq!(a, b);
    }
}
