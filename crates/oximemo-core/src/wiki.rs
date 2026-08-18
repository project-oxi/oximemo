//! Title-based wiki links: parsing, resolution, and backlink computation (§4).
//!
//! Wiki links use `[[Note Title]]` syntax (or `[[Note Title|label]]` for custom
//! display text). Links resolve by normalizing the target text to a filename
//! and scanning the vault index. This module is pure parsing — resolution
//! against the vault is done by the caller.

use regex::Regex;

/// A parsed wiki link from a note's body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WikiLink {
    /// The raw target text inside `[[...]]`, before the optional `|`.
    pub target: String,
    /// Custom display label after `|`, if present.
    pub label: Option<String>,
    /// `true` for embeds (`![[...]]`), `false` for inline links (`[[...]]`).
    pub is_embed: bool,
}

static LINK_RE: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
    // Matches [[target]] or [[target|label]]. Does NOT match ![[...]] (embeds).
    Regex::new(r"(?P<prefix>!)?\[\[(?P<target>[^\]\n|]+)(?:\|(?P<label>[^\]\n]+))?\]\]")
        .expect("valid wiki link regex")
});

/// Extract all wiki links from a body. Returns links in order of appearance.
/// Deduplicates by target text (first occurrence wins).
pub fn extract_links(body: &str) -> Vec<WikiLink> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for cap in LINK_RE.captures_iter(body) {
        let target = cap
            .name("target")
            .map(|m| m.as_str().trim())
            .unwrap_or("")
            .to_string();
        if target.is_empty() {
            continue;
        }
        let is_embed = cap.name("prefix").is_some();
        let label = cap.name("label").map(|m| m.as_str().trim().to_string());
        if seen.insert(target.clone()) {
            out.push(WikiLink {
                target,
                label,
                is_embed,
            });
        }
    }
    out
}

/// Replace all occurrences of `[[old_title...]]` with `[[new_title...]]` in a
/// body string. Preserves labels and embed prefixes. Used by rename propagation.
pub fn replace_link_target(body: &str, old: &str, new: &str) -> String {
    // Build a regex that matches [[old]] or [[old|label]] (with optional ! prefix).
    let escaped = regex::escape(old);
    let re = Regex::new(&format!(
        r"(?P<embed>!)?\[\[{escaped}(?P<label>\|[^\]\n]+)?\]\]"
    ))
    .expect("valid replacement regex");
    re.replace_all(body, |caps: &regex::Captures| {
        let embed = caps.name("embed").map(|m| m.as_str()).unwrap_or("");
        let label = caps.name("label").map(|m| m.as_str()).unwrap_or("");
        format!("{embed}[[{new}{label}]]")
    })
    .to_string()
}

/// Check if a body contains a link to the given target.
pub fn links_to(body: &str, target: &str) -> bool {
    extract_links(body)
        .iter()
        .any(|l| l.target.eq_ignore_ascii_case(target))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_simple_link() {
        let links = extract_links("See [[폭풍의 밤]] for details");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target, "폭풍의 밤");
        assert!(links[0].label.is_none());
        assert!(!links[0].is_embed);
    }

    #[test]
    fn parse_link_with_label() {
        let links = extract_links("[[Note Title|display text]]");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target, "Note Title");
        assert_eq!(links[0].label.as_deref(), Some("display text"));
    }

    #[test]
    fn parse_embed_link() {
        let links = extract_links("![[embedded note]]");
        assert_eq!(links.len(), 1);
        assert!(links[0].is_embed);
    }

    #[test]
    fn parse_multiple_links() {
        let links = extract_links("[[A]] and [[B]] and [[A]]");
        assert_eq!(links.len(), 2); // deduped
        assert_eq!(links[0].target, "A");
        assert_eq!(links[1].target, "B");
    }

    #[test]
    fn no_links_in_plain_text() {
        assert!(extract_links("just some text").is_empty());
    }

    #[test]
    fn replace_target_preserves_label_and_embed() {
        let body = "See [[Old Title]] and ![[Old Title|embed label]]";
        let result = replace_link_target(body, "Old Title", "New Title");
        assert!(result.contains("[[New Title]]"));
        assert!(result.contains("![[New Title|embed label]]"));
        assert!(!result.contains("Old Title"));
    }

    #[test]
    fn replace_does_not_touch_partial_matches() {
        let body = "[[Old Title Extra]]";
        let result = replace_link_target(body, "Old Title", "New Title");
        assert_eq!(result, body); // unchanged — different target
    }
}
