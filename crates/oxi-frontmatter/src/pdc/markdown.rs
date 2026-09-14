//! `pdc-markdown/1` body scanning (PDC 2 §6.1, §7.2, §11).
//!
//! A lexical Stage 0 gate over the CommonMark 0.31.2 + GFM baseline:
//! caret block IDs and raw-HTML `b-<uuid>` targets are collected for
//! duplicate detection, active constructs (`<script>`, event handlers,
//! `javascript:`/`vbscript:` URLs) are `unsafe_content`, and any other
//! raw HTML is flagged preview-unsafe while the source stays canonical
//! and untouched. Fenced code blocks are opaque body content; a fence
//! whose info string is exactly `base` carries a `pdc-query/1` block
//! that this scanner never interprets.
//!
//! This is deliberately not a CommonMark parser; the conformance corpus
//! is the authority for Stage 0 behavior, and a full parsing model
//! (including the 256-level block-depth rule, which requires parsing)
//! arrives with the Stage 1 Reader.

use super::{HtmlScan, find_backtick_run, scan_tag};

/// Outcome of scanning one `pdc-markdown/1` body.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct MarkdownScan {
    /// Caret block IDs and raw-HTML `b-<uuid>` targets, in source order.
    pub block_ids: Vec<String>,
    /// Benign raw HTML is present: preserved in source, inert in preview.
    pub has_raw_html: bool,
    /// Active or executable constructs are present (`unsafe_content`).
    pub unsafe_found: bool,
    /// Fenced code blocks whose info string is exactly `base`.
    pub query_fences: usize,
}

/// Scan one Markdown body.
pub(super) fn scan_markdown_body(body: &str) -> MarkdownScan {
    let mut scan = MarkdownScan::default();
    let mut fence: Option<(char, usize)> = None;
    for line in body.lines() {
        match fence {
            Some((open_char, open_len)) => {
                if is_fence_close(line, open_char, open_len) {
                    fence = None;
                }
                // Fence contents are opaque, including `base` queries.
                continue;
            }
            None => {
                if let Some((open_char, open_len, info)) = fence_open(line) {
                    if info == "base" {
                        scan.query_fences += 1;
                    }
                    fence = Some((open_char, open_len));
                    continue;
                }
            }
        }
        scan_line(line, &mut scan);
    }
    scan
}

/// Opening fenced code block on this line: `(fence char, run length,
/// info string)` — CommonMark §4.5 (up to three spaces of indentation,
/// at least three fence characters, no backtick inside a backtick fence
/// info string).
fn fence_open(line: &str) -> Option<(char, usize, &str)> {
    let indent = line.len() - line.trim_start_matches(' ').len();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let c = rest.chars().next()?;
    if c != '`' && c != '~' {
        return None;
    }
    let run = rest.chars().take_while(|x| *x == c).count();
    if run < 3 {
        return None;
    }
    let info = rest[run..].trim();
    if c == '`' && info.contains('`') {
        return None;
    }
    Some((c, run, info))
}

/// Closing fence: same character, at least the opening run length,
/// nothing but whitespace after.
fn is_fence_close(line: &str, c: char, open_len: usize) -> bool {
    let indent = line.len() - line.trim_start_matches(' ').len();
    if indent > 3 {
        return false;
    }
    let rest = &line[indent..];
    let run = rest.chars().take_while(|x| *x == c).count();
    run >= open_len && rest[run..].trim().is_empty()
}

/// Scan one body line outside fences: collect a trailing caret block ID
/// and classify raw HTML constructs outside inline code spans.
fn scan_line(line: &str, scan: &mut MarkdownScan) {
    let visible = strip_inline_code(line);
    if let Some(id) = caret_id_of_line(&visible) {
        scan.block_ids.push(id);
    }
    scan_raw_html(&visible, scan);
}

/// Remove inline code span contents so code samples never contribute
/// block IDs or raw HTML (unmatched backtick runs are literal text).
fn strip_inline_code(line: &str) -> String {
    let bytes = line.as_bytes();
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'`' {
            let run = bytes[i..].iter().take_while(|b| **b == b'`').count();
            match find_backtick_run(bytes, i + run, run) {
                Some(next) => i = next,
                None => {
                    out.push_str(&line[i..]);
                    break;
                }
            }
        } else {
            let ch = line[i..].chars().next().expect("char boundary");
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

/// The trailing caret block ID of a line, `^` + `[A-Za-z0-9-]+`
/// (PDC 2 §7.2), when the last whitespace-separated token is one.
fn caret_id_of_line(visible: &str) -> Option<String> {
    let token = visible.split_whitespace().last()?;
    let id = token.strip_prefix('^')?;
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return None;
    }
    Some(id.to_owned())
}

/// Walk one line for tag-like raw HTML outside code spans, mirroring the
/// HTML body scan: unsafe elements, event handlers, and unsafe URL
/// schemes are `unsafe_content`; every other raw form only flags
/// preview-unsafety; `id="b-<uuid>"` targets are collected. Autolinks
/// (`<https://…>`) are not raw.
fn scan_raw_html(visible: &str, scan: &mut MarkdownScan) {
    let bytes = visible.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }
        match bytes.get(i + 1) {
            None => return,
            Some(b'/') | Some(b'!') => {}
            Some(c) if c.is_ascii_alphanumeric() => {
                // An autolink is `<scheme:` with no space before the
                // colon; consume it whole so its `>` is not a tag end.
                let rest = &visible[i + 1..];
                let scheme_len = rest
                    .chars()
                    .take_while(|x| x.is_ascii_alphanumeric() || matches!(x, '-' | '.' | '+'))
                    .count();
                if rest.as_bytes().get(scheme_len) == Some(&b':') {
                    i = match find_sub(bytes, i + 1, b">") {
                        Some(p) => p + 1,
                        None => return,
                    };
                    continue;
                }
            }
            _ => {
                i += 1;
                continue;
            }
        }
        // Tag-like raw HTML: classify up to the closing `>` of this tag.
        scan.has_raw_html = true;
        let end = tag_end(bytes, i);
        let inner = &visible[i + 1..end.min(visible.len())];
        let mut tag_scan = HtmlScan::default();
        scan_tag(inner, &mut tag_scan);
        if tag_scan.unsafe_found {
            scan.unsafe_found = true;
        }
        scan.block_ids.append(&mut tag_scan.block_ids);
        if end >= bytes.len() {
            return;
        }
        i = end + 1;
    }
}

/// Byte offset of the `>` closing the tag opening at `open`, or the
/// slice length when the tag is unterminated on this line.
fn tag_end(bytes: &[u8], open: usize) -> usize {
    let mut quote: Option<u8> = None;
    for (off, b) in bytes[open..].iter().enumerate() {
        match (quote, b) {
            (Some(q), b) if *b == q => quote = None,
            (None, b'"' | b'\'') => quote = Some(*b),
            (None, b'>') => return open + off,
            _ => {}
        }
    }
    bytes.len()
}

/// First byte offset of `needle` in `bytes` at or after `from`.
fn find_sub(bytes: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || bytes.len() < needle.len() {
        return None;
    }
    (from..=bytes.len() - needle.len()).find(|i| &bytes[*i..i + needle.len()] == needle)
}
