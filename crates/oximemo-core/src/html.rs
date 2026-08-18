//! HTML note primitives: frontmatter-in-comment parsing, text extraction,
//! and title derivation (spec 2026-08-18 §3).
//!
//! An HTML note keeps the same TOML frontmatter as a markdown note, wrapped
//! in a leading HTML comment so the file stays valid, browser-renderable
//! HTML:
//!
//! ```html
//! <!--
//! +++
//! id = "…"
//! +++
//! -->
//! <h1>Title</h1>
//! ```
//!
//! All functions are pure text scanners — no external HTML parser, keeping
//! the core dependency footprint flat. The goal is indexing/preview-quality
//! text extraction, not DOM fidelity.

/// Result of splitting an HTML note into frontmatter + body.
#[derive(Debug, PartialEq, Eq)]
pub enum HtmlFrontmatterSplit<'a> {
    /// A leading comment containing a `+++ … +++` TOML block.
    Some { toml_text: &'a str, body: &'a str },
    /// No frontmatter comment. The whole content is the body.
    None { body: &'a str },
}

/// Split an HTML note's content into frontmatter + body.
///
/// Rules:
/// 1. Leading whitespace is skipped.
/// 2. If the content does not start with `<!--`, there is no frontmatter.
/// 3. The comment runs to the first `-->`. Its inner text must start with a
///    `+++` line and contain a closing `+++` line to count as frontmatter
///    (a plain comment — e.g. a normal web page's license banner — does not).
/// 4. The body is everything after the comment, with one leading newline
///    trimmed.
pub fn split_frontmatter(content: &str) -> HtmlFrontmatterSplit<'_> {
    let trimmed = content.trim_start();
    let Some(rest) = trimmed.strip_prefix("<!--") else {
        return HtmlFrontmatterSplit::None { body: content };
    };
    let Some(end) = rest.find("-->") else {
        // Unterminated comment: treat the whole file as body — the file is
        // malformed HTML, but we never lose user content.
        return HtmlFrontmatterSplit::None { body: content };
    };
    let inner = &rest[..end];
    let after = &rest[end + 3..];
    let body = after.strip_prefix('\n').unwrap_or(after);

    // The inner text must be a `+++ … +++` block.
    let inner_trimmed = inner.trim_start_matches('\n');
    let Some(toml_text) = inner_trimmed.strip_prefix("+++\n") else {
        return HtmlFrontmatterSplit::None { body: content };
    };
    let toml_text = match toml_text.strip_suffix("+++\n") {
        Some(t) => t,
        None => match toml_text.strip_suffix("+++") {
            Some(t) => t.strip_suffix('\n').unwrap_or(t),
            None => return HtmlFrontmatterSplit::None { body: content },
        },
    };

    HtmlFrontmatterSplit::Some { toml_text, body }
}

/// Serialize an HTML note: frontmatter TOML wrapped in a leading comment,
/// followed by the body. Canonical inverse of [`split_frontmatter`].
pub fn serialize_frontmatter(toml_text: &str, body: &str) -> String {
    let mut out = String::with_capacity(toml_text.len() + body.len() + 24);
    out.push_str("<!--\n+++\n");
    out.push_str(toml_text);
    out.push_str("+++\n-->\n");
    out.push_str(body);
    out
}

/// Extract indexable plain text from HTML: comments, `<script>` and
/// `<style>` contents are dropped, tags are stripped, entities decoded,
/// and runs of whitespace collapsed to single spaces (block tags act as
/// word separators via the surrounding whitespace they introduce).
pub fn html_to_text(html: &str) -> String {
    let no_comments = strip_comments(html);
    let mut out = String::with_capacity(no_comments.len());
    let chars: Vec<char> = no_comments.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '<' {
            // Find the tag name.
            let mut j = i + 1;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            let name_start = j;
            while j < chars.len()
                && (chars[j].is_alphanumeric()
                    || chars[j] == '-'
                    || chars[j] == '!'
                    || chars[j] == '/')
            {
                j += 1;
            }
            let name: String = chars[name_start..j]
                .iter()
                .filter(|c| c.is_alphanumeric() || **c == '-')
                .collect::<String>()
                .to_ascii_lowercase();
            // Consume up to '>'.
            let mut k = j;
            while k < chars.len() && chars[k] != '>' {
                k += 1;
            }
            if k >= chars.len() {
                // Unterminated tag: drop the rest.
                break;
            }
            // For script/style, skip until the matching closing tag.
            if name == "script" || name == "style" {
                let close = format!("</{name}");
                let rest: String = chars[k + 1..].iter().collect();
                if let Some(pos) = rest.to_ascii_lowercase().find(&close) {
                    // Continue scanning after the closing tag's '>'.
                    let after_close = k + 1 + rest[..pos].chars().count() + close.chars().count();
                    let mut m = after_close;
                    while m < chars.len() && chars[m] != '>' {
                        m += 1;
                    }
                    i = if m < chars.len() { m + 1 } else { chars.len() };
                    // Block elements separate words.
                    out.push(' ');
                } else {
                    break; // No closing tag: drop the rest.
                }
            } else {
                i = k + 1;
                // Block-level tags act as separators.
                if is_block_tag(&name) {
                    out.push(' ');
                }
            }
        } else if c == '&' {
            // Entity: try named/numeric forms.
            let (decoded, next) = decode_entity(&chars[i..]);
            match decoded {
                Some(text) => {
                    out.push_str(&text);
                    i += next;
                }
                None => {
                    out.push(c);
                    i += 1;
                }
            }
        } else {
            out.push(c);
            i += 1;
        }
    }
    // Collapse whitespace runs into single spaces, then trim.
    let mut collapsed = String::with_capacity(out.len());
    let mut last_space = true; // leading trim
    for c in out.chars() {
        if c.is_whitespace() {
            if !last_space {
                collapsed.push(' ');
                last_space = true;
            }
        } else {
            collapsed.push(c);
            last_space = false;
        }
    }
    collapsed.trim_end().to_string()
}

/// Remove all HTML comments (`<!-- … -->`). Unterminated comments swallow
/// the remainder. Used before wiki-link scanning so frontmatter comments
/// cannot hide `[[…]]` text.
pub fn strip_comments(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let bytes = html.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'<' && html[i..].starts_with("<!--") {
            match html[i + 4..].find("-->") {
                Some(end) => {
                    i = i + 4 + end + 3;
                }
                None => break,
            }
        } else {
            let ch = html[i..].chars().next().expect("non-empty slice");
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

/// Derive a note title from an HTML body: the first `<h1>` heading's text
/// (inner tags stripped, entities decoded), falling back to `<title>`.
/// Tag matching is case-insensitive; attribute-bearing tags
/// (`<h1 class="x">`) are handled.
pub fn derive_title(body: &str) -> Option<String> {
    first_tag_text(body, "h1")
        .or_else(|| first_tag_text(body, "title"))
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
}

fn is_block_tag(name: &str) -> bool {
    matches!(
        name,
        "p" | "div"
            | "br"
            | "hr"
            | "section"
            | "article"
            | "header"
            | "footer"
            | "main"
            | "nav"
            | "aside"
            | "blockquote"
            | "ul"
            | "ol"
            | "li"
            | "dl"
            | "dt"
            | "dd"
            | "table"
            | "thead"
            | "tbody"
            | "tr"
            | "td"
            | "th"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "pre"
            | "figure"
            | "figcaption"
            | "form"
            | "fieldset"
            | "address"
            | "html"
            | "body"
            | "head"
            | "title"
            | "details"
            | "summary"
            | "dialog"
    )
}

/// Decode an HTML entity at the start of `chars` (which begins with `&`).
/// Returns the decoded text and the number of chars consumed, or `None`
/// when the sequence is not a recognized entity.
fn decode_entity(chars: &[char]) -> (Option<String>, usize) {
    let max = chars.len().min(12);
    let mut semi = None;
    for (j, &c) in chars.iter().enumerate().take(max).skip(1) {
        if c == ';' {
            semi = Some(j);
            break;
        }
        if c == '&' || c == '<' {
            break;
        }
    }
    let Some(semi) = semi else {
        return (None, 0);
    };
    let name: String = chars[1..semi].iter().collect();
    let decoded = match name.as_str() {
        "amp" => Some("&".to_string()),
        "lt" => Some("<".to_string()),
        "gt" => Some(">".to_string()),
        "quot" => Some("\"".to_string()),
        "apos" => Some("'".to_string()),
        "nbsp" => Some("\u{a0}".to_string()),
        _ => {
            if let Some(num) = name.strip_prefix('#') {
                let code =
                    if let Some(hex) = num.strip_prefix('x').or_else(|| num.strip_prefix('X')) {
                        u32::from_str_radix(hex, 16).ok()
                    } else {
                        num.parse::<u32>().ok()
                    };
                code.and_then(char::from_u32).map(|c| c.to_string())
            } else {
                None
            }
        }
    };
    match decoded {
        Some(text) => (Some(text), semi + 1),
        None => (None, 0),
    }
}

/// Find the first `<tag …>…</tag>` and return its inner text with nested
/// tags stripped and entities decoded. Case-insensitive.
fn first_tag_text(html: &str, tag: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let open = format!("<{tag}");
    let close = format!("</{tag}");
    let mut search_from = 0;
    while let Some(rel) = lower[search_from..].find(&open) {
        let open_start = search_from + rel;
        // Must be followed by '>', whitespace, or an attribute boundary —
        // `<h1` must not match `<h10`.
        let after = &lower[open_start + open.len()..];
        let next_char_ok = after
            .chars()
            .next()
            .is_some_and(|c| c == '>' || c == '/' || c.is_whitespace());
        if next_char_ok {
            let open_end = lower[open_start..].find('>')? + open_start;
            let inner_start = open_end + 1;
            let close_rel = lower[inner_start..].find(&close)?;
            let inner = &html[inner_start..inner_start + close_rel];
            return Some(html_to_text(inner));
        }
        search_from = open_start + open.len();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "<!--\n+++\nid = \"x\"\n+++\n-->\n<h1>제목</h1>\n<p>본문</p>";

    #[test]
    fn split_parses_frontmatter_comment() {
        let HtmlFrontmatterSplit::Some { toml_text, body } = split_frontmatter(SAMPLE) else {
            panic!("expected Some");
        };
        assert_eq!(toml_text, "id = \"x\"\n");
        assert_eq!(body, "<h1>제목</h1>\n<p>본문</p>");
    }

    #[test]
    fn split_none_without_comment() {
        let HtmlFrontmatterSplit::None { body } = split_frontmatter("<p>hi</p>") else {
            panic!("expected None");
        };
        assert_eq!(body, "<p>hi</p>");
    }

    #[test]
    fn split_none_for_plain_comment() {
        // A comment that isn't a frontmatter block keeps the whole content.
        let HtmlFrontmatterSplit::None { body } =
            split_frontmatter("<!-- license note -->\n<p>hi</p>")
        else {
            panic!("expected None");
        };
        assert!(body.contains("license note"));
        assert!(body.contains("<p>hi</p>"));
    }

    #[test]
    fn roundtrip_serialize_split() {
        let toml = "id = \"x\"\n";
        let body = "<h1>T</h1>";
        let file = serialize_frontmatter(toml, body);
        let HtmlFrontmatterSplit::Some { toml_text, body: b } = split_frontmatter(&file) else {
            panic!("expected Some");
        };
        assert_eq!(toml_text, toml);
        assert_eq!(b, body);
    }

    #[test]
    fn to_text_strips_tags_and_decodes_entities() {
        let html = "<p>A &amp; B</p>\n<h2>C &lt;D&gt;</h2>";
        assert_eq!(html_to_text(html), "A & B C <D>");
    }

    #[test]
    fn to_text_drops_script_and_style() {
        let html = "<style>p { color: red }</style><p>keep</p><script>bad()</script><p>this</p>";
        assert_eq!(html_to_text(html), "keep this");
    }

    #[test]
    fn to_text_drops_comments() {
        assert_eq!(html_to_text("<p>a</p><!-- hidden -->"), "a");
    }

    #[test]
    fn to_text_numeric_entities() {
        assert_eq!(html_to_text("&#65;&#x42;"), "AB");
    }

    #[test]
    fn to_text_separates_inline_tags() {
        assert_eq!(html_to_text("<b>bold</b><i>it</i>"), "boldit");
        assert_eq!(html_to_text("<b>bold</b> <i>it</i>"), "bold it");
    }

    #[test]
    fn to_text_unterminated_comment_drops_rest() {
        assert_eq!(html_to_text("a<!-- forever"), "a");
    }

    #[test]
    fn title_from_first_h1() {
        assert_eq!(
            derive_title("<p>x</p><h1>첫 제목</h1><h1>둘째</h1>").as_deref(),
            Some("첫 제목")
        );
    }

    #[test]
    fn title_h1_with_attributes_and_inner_tags() {
        assert_eq!(
            derive_title("<h1 class=\"main\" id=\"t\">Hello <em>world</em> &amp; more</h1>")
                .as_deref(),
            Some("Hello world & more")
        );
    }

    #[test]
    fn title_falls_back_to_title_tag() {
        assert_eq!(
            derive_title("<!DOCTYPE html><html><head><title>문서 제목</title></head><body><p>x</p></body></html>").as_deref(),
            Some("문서 제목")
        );
    }

    #[test]
    fn title_none_without_headings() {
        assert_eq!(derive_title("<p>제목 없음</p>"), None);
    }

    #[test]
    fn title_case_insensitive_tags() {
        assert_eq!(derive_title("<H1>Upper</H1>").as_deref(), Some("Upper"));
    }

    #[test]
    fn title_h1_not_confused_with_h10() {
        // `<h1` must not match a hypothetical `<h10>` open tag.
        assert_eq!(
            derive_title("<h10>fake</h10><h1>real</h1>").as_deref(),
            Some("real")
        );
    }

    #[test]
    fn strip_comments_removes_all() {
        assert_eq!(strip_comments("a<!-- x -->b<!-- y -->c"), "abc");
        assert_eq!(strip_comments("no comments"), "no comments");
    }

    #[test]
    fn full_document_frontmatter_before_doctype() {
        let file = "<!--\n+++\nid = \"y\"\n+++\n-->\n<!DOCTYPE html>\n<html><body><h1>Doc</h1></body></html>";
        let HtmlFrontmatterSplit::Some { toml_text, body } = split_frontmatter(file) else {
            panic!("expected Some");
        };
        assert_eq!(toml_text, "id = \"y\"\n");
        assert!(body.starts_with("<!DOCTYPE html>"));
        assert_eq!(derive_title(body).as_deref(), Some("Doc"));
    }
}
