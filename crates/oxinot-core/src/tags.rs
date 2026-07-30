//! Inline `#tag` extraction from note bodies (§3).
//!
//! A `#` starts a tag only when it is NOT immediately preceded by a Unicode
//! letter or digit — so chord symbols like `C#m7` / `F#m7` are not tagged,
//! while `#악보` at a word boundary is. Markdown headings (`# Title`) never
//! match because the `#` is followed by whitespace. No `regex` crate: a small
//! hand-rolled char scanner keeps the dependency footprint flat and avoids
//! unicode-feature uncertainty. The TypeScript mirror in
//! `apps/desktop/src/lib/tags.ts` MUST implement the identical algorithm.

use unicode_normalization::UnicodeNormalization;

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Extract, NFC-normalize, and lowercase the inline `#tags` in `body`.
/// Order = first occurrence; duplicates removed after normalization. The
/// body's display casing is NOT altered here (the highlighter preserves it).
pub fn extract_tags(body: &str) -> Vec<String> {
    let chars: Vec<char> = body.chars().collect();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '#' {
            let prev_ok = i == 0 || !is_word(chars[i - 1]);
            if prev_ok {
                let start = i + 1;
                let mut j = start;
                while j < chars.len() && is_word(chars[j]) {
                    j += 1;
                }
                if j > start {
                    let token: String = chars[start..j].iter().collect();
                    let norm: String = token.nfc().collect::<String>().to_lowercase();
                    if !out.iter().any(|t| t == &norm) {
                        out.push(norm);
                    }
                }
                i = j;
                continue;
            }
        }
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_basic_tags() {
        assert_eq!(
            extract_tags("#악보 #장범준 #기타"),
            vec!["악보", "장범준", "기타"]
        );
    }

    #[test]
    fn chord_symbols_are_not_tags() {
        // User's real data: chords must not become tags.
        assert_eq!(
            extract_tags("간주 DM7 AM7 C#m7 F#m7 Bm7 E"),
            Vec::<String>::new()
        );
    }

    #[test]
    fn markdown_heading_is_not_a_tag() {
        assert_eq!(extract_tags("# Heading\nbody #real"), vec!["real"]);
    }

    #[test]
    fn korean_and_case_normalization() {
        assert_eq!(extract_tags("#IDEA #Idea #idea"), vec!["idea"]);
    }

    #[test]
    fn punctuation_truncates_token() {
        assert_eq!(
            extract_tags("메모 #태그, 그리고 #업무!"),
            vec!["태그", "업무"]
        );
    }

    #[test]
    fn adjacent_hashes_keep_first_only() {
        // `#a#b`: `#b`'s preceding char is letter `a` → not a tag.
        assert_eq!(extract_tags("#a#b"), vec!["a"]);
    }

    #[test]
    fn empty_and_no_hash() {
        assert_eq!(extract_tags(""), Vec::<String>::new());
        assert_eq!(extract_tags("no tags here"), Vec::<String>::new());
    }

    #[test]
    fn hash_at_line_start() {
        assert_eq!(extract_tags("line1\n#two"), vec!["two"]);
    }
}
