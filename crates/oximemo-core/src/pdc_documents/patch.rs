//! Source-range edits over validated YAML. JSON Pointer addresses semantic
//! values; the parser's markers locate only the source being changed.
use std::ops::Range;

use serde_json::Value;
use yaml_rust2::parser::{Event, Parser};
use yaml_rust2::scanner::TScalarStyle;

use super::{PdcMetadataEdit, read_only};
use crate::Result;

#[derive(Debug)]
struct Node {
    span: Range<usize>,
    close: Option<usize>,
    kind: Kind,
}
#[derive(Debug)]
enum Kind {
    Scalar(String),
    Map(Vec<(Node, Node)>),
    Seq(Vec<Node>),
}

pub(super) fn pointer(key: &str) -> String {
    format!("/{}", key.replace('~', "~0").replace('/', "~1"))
}

fn segments(pointer: &str) -> Result<Vec<String>> {
    if !pointer.starts_with('/') {
        return Err(read_only("metadata paths must be nonempty JSON Pointers"));
    }
    let mut parts = Vec::new();
    for part in pointer[1..].split('/') {
        let mut decoded = String::new();
        let mut chars = part.chars();
        while let Some(c) = chars.next() {
            decoded.push(if c == '~' {
                match chars.next() {
                    Some('0') => '~',
                    Some('1') => '/',
                    _ => return Err(read_only("invalid JSON Pointer escape")),
                }
            } else {
                c
            });
        }
        if decoded.is_empty() {
            return Err(read_only("empty metadata path component"));
        }
        parts.push(decoded);
    }
    if parts.len() > 32 {
        return Err(read_only("metadata path is too deep"));
    }
    Ok(parts)
}

pub(super) fn validate_path(path: &str) -> Result<()> {
    let parts = segments(path)?;
    if matches!(
        parts[0].as_str(),
        "format"
            | "body"
            | "id"
            | "created"
            | "updated"
            | "title"
            | "profile"
            | "lang"
            | "aliases"
            | "cssclasses"
            | "favorite"
            | "deleted"
            | "deleted_at"
    ) {
        return Err(read_only(
            "reserved envelope field; use its dedicated operation",
        ));
    }
    Ok(())
}

fn array_index(text: &str, len: usize, append: bool) -> Result<usize> {
    if append && text == "-" {
        return Ok(len);
    }
    if text != "0" && text.starts_with('0') {
        return Err(read_only("array indices cannot have leading zeros"));
    }
    if !text.bytes().all(|c| c.is_ascii_digit()) {
        return Err(read_only("invalid array index"));
    }
    let index = text
        .parse::<usize>()
        .map_err(|_| read_only("invalid array index"))?;
    if index > len || (!append && index == len) {
        return Err(read_only("array index is out of bounds"));
    }
    Ok(index)
}

pub(super) fn apply(envelope: &str, edits: &[PdcMetadataEdit]) -> Result<String> {
    let mut source = envelope.to_string();
    for edit in edits {
        validate_path(&edit.path)?;
        let parts = segments(&edit.path)?;
        let mut expected: Value = serde_yaml_ng::from_str(&source)
            .map_err(|e| read_only(format!("cannot project metadata: {e}")))?;
        let (last, parents) = parts.split_last().expect("nonempty pointer");
        let mut parent = &mut expected;
        for part in parents {
            parent = match parent {
                Value::Object(map) => map.get_mut(part),
                Value::Array(items) => {
                    let index = array_index(part, items.len(), false)?;
                    items.get_mut(index)
                }
                _ => None,
            }
            .ok_or_else(|| read_only("metadata parent does not exist or is not a container"))?;
        }
        let changed = match parent {
            Value::Object(map) => match &edit.value {
                Some(value) => {
                    if map.get(last) == Some(value) {
                        false
                    } else {
                        map.insert(last.clone(), value.clone());
                        true
                    }
                }
                None => map.remove(last).is_some(),
            },
            Value::Array(items) => {
                let index = array_index(last, items.len(), edit.value.is_some())?;
                match &edit.value {
                    Some(value) if index == items.len() => {
                        items.push(value.clone());
                        true
                    }
                    Some(value) if items[index] == *value => false,
                    Some(value) => {
                        items[index] = value.clone();
                        true
                    }
                    None => {
                        items.remove(index);
                        true
                    }
                }
            }
            _ => return Err(read_only("metadata parent is not a container")),
        };
        if !changed {
            continue;
        }
        let tree = parse(&source)?;
        let parent_node = find(&tree, parents)?;
        let mut replacements = edit_at(&source, parent_node, last, edit.value.as_ref())?;
        replacements.sort_by_key(|(range, _)| std::cmp::Reverse(range.start));
        let mut candidate = source.clone();
        for (range, replacement) in replacements {
            candidate.replace_range(range, &replacement);
        }
        // A range must never silently change a sibling, a scalar type, or a
        // parent shape. Failure leaves the entire on-disk transaction untouched.
        let actual: Value = serde_yaml_ng::from_str(&candidate)
            .map_err(|e| read_only(format!("cannot preserve this YAML presentation: {e}")))?;
        if actual != expected {
            return Err(read_only(
                "cannot preserve this YAML presentation losslessly",
            ));
        }
        oxi_frontmatter::pdc::yaml::parse_document(&candidate).map_err(|e| read_only(e.reason))?;
        source = candidate;
    }
    Ok(source)
}

fn find<'a>(mut node: &'a Node, path: &[String]) -> Result<&'a Node> {
    for part in path {
        node = match &node.kind {
            Kind::Map(entries) => entries
                .iter()
                .find(|(key, _)| scalar_key(key) == part)
                .map(|(_, value)| value),
            Kind::Seq(items) => items.get(array_index(part, items.len(), false)?),
            _ => None,
        }
        .ok_or_else(|| read_only("metadata parent was not found"))?;
    }
    Ok(node)
}
fn scalar_key(node: &Node) -> &str {
    match &node.kind {
        Kind::Scalar(key) => key,
        _ => "",
    }
}
fn render(value: &Value) -> String {
    serde_json::to_string(value).expect("JSON value serialization is infallible")
}
fn line_start(source: &str, index: usize) -> usize {
    source[..index].rfind('\n').map_or(0, |i| i + 1)
}
fn line_end(source: &str, index: usize) -> usize {
    source[index..]
        .find('\n')
        .map_or(source.len(), |i| index + i + 1)
}
fn eol(source: &str) -> &str {
    crate::tasks::preferred_line_ending(source)
}
fn key_source(key: &str) -> String {
    if key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !matches!(key.to_ascii_lowercase().as_str(), "true" | "false" | "null")
        && key
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
    {
        key.to_string()
    } else {
        render(&Value::String(key.to_string()))
    }
}

type Replacements = Vec<(Range<usize>, String)>;
fn edit_at(source: &str, parent: &Node, key: &str, value: Option<&Value>) -> Result<Replacements> {
    match &parent.kind {
        Kind::Map(entries) => {
            if let Some(index) = entries.iter().position(|(k, _)| scalar_key(k) == key) {
                let (key_node, node) = &entries[index];
                if let Some(value) = value {
                    return Ok(vec![(
                        node.span.clone(),
                        format!(
                            "{}{}",
                            if node.span.is_empty() { " " } else { "" },
                            render(value)
                        ),
                    )]);
                }
                if entries.len() == 1 {
                    return Ok(vec![(parent.span.clone(), "{}".into())]);
                }
                if let Some(close) = parent.close {
                    return flow_remove(
                        source,
                        key_node.span.start..node.span.end,
                        index,
                        &entries
                            .iter()
                            .map(|(k, v)| k.span.start..v.span.end)
                            .collect::<Vec<_>>(),
                        close,
                    );
                }
                let start = line_start(source, key_node.span.start);
                if !source[start..key_node.span.start].trim().is_empty() {
                    return Err(read_only(
                        "removing a compact mapping key requires a source edit",
                    ));
                }
                Ok(vec![(
                    start..line_end(source, node.span.end),
                    String::new(),
                )])
            } else {
                let value = value.ok_or_else(|| read_only("missing metadata key"))?;
                let pair = format!("{}: {}", key_source(key), render(value));
                append(source, parent, entries.last().map(|(_, v)| v), &pair, false)
            }
        }
        Kind::Seq(items) => {
            let index = array_index(key, items.len(), value.is_some())?;
            if index == items.len() {
                return append(
                    source,
                    parent,
                    items.last(),
                    &render(value.expect("append value")),
                    true,
                );
            }
            let node = &items[index];
            if let Some(value) = value {
                return Ok(vec![(
                    node.span.clone(),
                    format!(
                        "{}{}",
                        if node.span.is_empty() { " " } else { "" },
                        render(value)
                    ),
                )]);
            }
            if items.len() == 1 {
                return Ok(vec![(parent.span.clone(), "[]".into())]);
            }
            if let Some(close) = parent.close {
                return flow_remove(
                    source,
                    node.span.clone(),
                    index,
                    &items.iter().map(|v| v.span.clone()).collect::<Vec<_>>(),
                    close,
                );
            }
            let start = line_start(source, node.span.start);
            let prefix = source[start..node.span.start].trim();
            if prefix != "-" {
                return Err(read_only("cannot locate the block sequence item"));
            }
            Ok(vec![(
                start..line_end(source, node.span.end),
                String::new(),
            )])
        }
        _ => Err(read_only("metadata parent is not a container")),
    }
}

fn append(
    source: &str,
    parent: &Node,
    last: Option<&Node>,
    text: &str,
    sequence: bool,
) -> Result<Replacements> {
    if let Some(close) = parent.close {
        let comma = last.is_some_and(|last| comma_in(&source[last.span.end..close]).is_none());
        return Ok(vec![(
            close..close,
            format!("{}{text}", if comma { ", " } else { " " }),
        )]);
    }
    let last = last.ok_or_else(|| read_only("cannot locate an empty block container"))?;
    let index = line_end(source, last.span.end);
    let indent = parent.span.start - line_start(source, parent.span.start);
    let prefix = if index > 0 && !source[..index].ends_with('\n') {
        eol(source)
    } else {
        ""
    };
    let text = if sequence {
        format!("- {text}")
    } else {
        text.to_string()
    };
    Ok(vec![(
        index..index,
        format!("{prefix}{}{text}{}", " ".repeat(indent), eol(source)),
    )])
}

fn comma_in(source: &str) -> Option<usize> {
    let mut comment = false;
    for (i, c) in source.char_indices() {
        if c == '\n' {
            comment = false;
        }
        if c == '#' {
            comment = true;
        }
        if c == ',' && !comment {
            return Some(i);
        }
    }
    None
}
fn flow_remove(
    source: &str,
    span: Range<usize>,
    index: usize,
    siblings: &[Range<usize>],
    close: usize,
) -> Result<Replacements> {
    let comma = if index + 1 < siblings.len() {
        let gap = span.end..siblings[index + 1].start;
        comma_in(&source[gap.clone()]).map(|i| gap.start + i)
    } else {
        let gap = siblings[index - 1].end..span.start;
        comma_in(&source[gap.clone()]).map(|i| gap.start + i)
    }
    .ok_or_else(|| read_only("cannot locate a flow separator"))?;
    let mut result = vec![
        (span.clone(), String::new()),
        (comma..comma + 1, String::new()),
    ];
    // A trailing comma belongs to the removed final element as well.
    if index + 1 == siblings.len()
        && let Some(extra) = comma_in(&source[span.end..close])
    {
        let at = span.end + extra;
        result.push((at..at + 1, String::new()));
    }
    Ok(result)
}

fn parse(source: &str) -> Result<Node> {
    // yaml-rust2 0.13 advances Marker::index per char despite its byte-offset
    // documentation. Convert explicitly before slicing UTF-8 source.
    let offsets: Vec<_> = source
        .char_indices()
        .map(|(i, _)| i)
        .chain(std::iter::once(source.len()))
        .collect();
    let mut parser = Parser::new_from_str(source);
    let mut events = Vec::new();
    loop {
        let (event, marker) = parser.next_token().map_err(|e| read_only(e.to_string()))?;
        if matches!(event, Event::StreamEnd) {
            break;
        }
        if !matches!(
            event,
            Event::StreamStart | Event::DocumentStart | Event::DocumentEnd
        ) {
            events.push((event, offsets[marker.index()]));
        }
    }
    node(source, &events, &mut 0, false)
}
fn node(
    source: &str,
    events: &[(Event, usize)],
    cursor: &mut usize,
    in_flow: bool,
) -> Result<Node> {
    let (event, start) = events
        .get(*cursor)
        .ok_or_else(|| read_only("incomplete YAML node"))?;
    *cursor += 1;
    let start = *start;
    match event {
        Event::Scalar(value, style, ..) => Ok(Node {
            span: start..scalar_end(source, start, *style, in_flow),
            close: None,
            kind: Kind::Scalar(value.clone()),
        }),
        Event::MappingStart(..) | Event::SequenceStart(..) => {
            let mapping = matches!(event, Event::MappingStart(..));
            let flow = source
                .as_bytes()
                .get(start)
                .is_some_and(|b| *b == b'{' || *b == b'[');
            let mut entries = Vec::new();
            let mut items = Vec::new();
            while !events
                .get(*cursor)
                .is_some_and(|(e, _)| matches!(e, Event::MappingEnd | Event::SequenceEnd))
            {
                let child = node(source, events, cursor, flow)?;
                if mapping {
                    let empty = events.get(*cursor).is_some_and(|(event,_)|
                        matches!(event, Event::Scalar(value, TScalarStyle::Plain, ..) if value.is_empty()));
                    let mut value = node(source, events, cursor, flow)?;
                    if empty {
                        let colon = child.span.end
                            + source[child.span.end..]
                                .find(':')
                                .ok_or_else(|| read_only("mapping has no value indicator"))?;
                        value.span = colon + 1..colon + 1;
                    }
                    entries.push((child, value));
                } else {
                    items.push(child);
                }
            }
            let close = events[*cursor].1;
            *cursor += 1;
            let end = if flow {
                close + 1
            } else if mapping {
                entries.last().map_or(start, |(_, v)| v.span.end)
            } else {
                items.last().map_or(start, |v| v.span.end)
            };
            let start = if !flow && mapping {
                entries.first().map_or(start, |(key, _)| key.span.start)
            } else {
                start
            };
            Ok(Node {
                span: start..end,
                close: flow.then_some(close),
                kind: if mapping {
                    Kind::Map(entries)
                } else {
                    Kind::Seq(items)
                },
            })
        }
        _ => Err(read_only("unsupported YAML node")),
    }
}

fn scalar_end(source: &str, start: usize, style: TScalarStyle, flow: bool) -> usize {
    let tail = &source[start..];
    if matches!(
        style,
        TScalarStyle::SingleQuoted | TScalarStyle::DoubleQuoted
    ) {
        let quote = if style == TScalarStyle::SingleQuoted {
            '\''
        } else {
            '"'
        };
        let mut chars = tail.char_indices().skip(1).peekable();
        while let Some((i, c)) = chars.next() {
            if quote == '"' && c == '\\' {
                chars.next();
                continue;
            }
            if c == quote {
                if quote == '\'' && chars.peek().is_some_and(|(_, c)| *c == '\'') {
                    chars.next();
                } else {
                    return start + i + 1;
                }
            }
        }
        return source.len();
    }
    let first_end = line_end(source, start);
    let parent_indent = source[line_start(source, start)..]
        .chars()
        .take_while(|c| *c == ' ')
        .count();
    if matches!(style, TScalarStyle::Literal | TScalarStyle::Folded) {
        let mut end = first_end;
        for line in source[first_end..].split_inclusive('\n') {
            let indent = line.chars().take_while(|c| *c == ' ').count();
            if !line.trim().is_empty() && indent <= parent_indent {
                break;
            }
            end += line.len();
        }
        return source[..end].trim_end_matches(['\r', '\n']).len();
    }
    let mut end = start;
    let mut previous_space = true;
    for (i, c) in tail.char_indices() {
        if c == '\n'
            || c == '\r'
            || (flow && matches!(c, ',' | ']' | '}'))
            || (c == '#' && previous_space)
            || (c == ':'
                && tail[i + 1..]
                    .chars()
                    .next()
                    .is_none_or(|c| c.is_whitespace() || matches!(c, ',' | ']' | '}')))
        {
            break;
        }
        end = start + i + c.len_utf8();
        previous_space = c.is_whitespace();
    }
    source[..end].trim_end_matches([' ', '\t']).len().max(start)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn set(path: &str, value: Value) -> PdcMetadataEdit {
        PdcMetadataEdit {
            path: path.into(),
            value: Some(value),
        }
    }
    fn remove(path: &str) -> PdcMetadataEdit {
        PdcMetadataEdit {
            path: path.into(),
            value: None,
        }
    }
    #[test]
    fn nested_block_and_flow_edits_preserve_siblings_comments_and_types() {
        let source = "# header\r\nreview:\r\n  status: 'old' # field comment\r\n  owner: \"한글\" # sibling\r\n  nested: {yes: true, list: [1, null, \"x\"]}\r\nother: |\r\n  leave this\r\n  exactly\r\n";
        let out = apply(
            source,
            &[
                set("/review/status", json!("done")),
                set("/review/nested/list/1", json!({"ok":false})),
            ],
        )
        .unwrap();
        assert!(out.contains("  status: \"done\" # field comment\r\n"));
        assert!(out.contains("  owner: \"한글\" # sibling\r\n"));
        assert!(out.ends_with("other: |\r\n  leave this\r\n  exactly\r\n"));
        assert!(out.contains("nested: {yes: true, list: [1, {\"ok\":false}, \"x\"]}"));
    }
    #[test]
    fn additions_removals_escaped_keys_and_null_are_distinct() {
        let source = "review:\n  list: [1, 2, 3,]\n  old: true\n  keep: 'yes'\n'a/b~c': false\n";
        let out = apply(
            source,
            &[
                set("/review/new", json!(null)),
                remove("/review/old"),
                remove("/review/list/2"),
                set("/review/list/-", json!(4)),
                set("/a~1b~0c", json!(true)),
            ],
        )
        .unwrap();
        assert!(out.contains("keep: 'yes'\n"));
        let value: Value = serde_yaml_ng::from_str(&out).unwrap();
        assert_eq!(
            value,
            json!({"review":{"list":[1,2,4],"keep":"yes","new":null}, "a/b~c":true})
        );
    }
    #[test]
    fn block_arrays_and_flow_maps_can_be_appended_and_removed() {
        for source in ["review: {a: 1, b: 2}\n", "review:\n  a: 1\n  b: 2\n"] {
            let out = apply(
                source,
                &[remove("/review/a"), set("/review/c", json!([true, null]))],
            )
            .unwrap();
            let value: Value = serde_yaml_ng::from_str(&out).unwrap();
            assert_eq!(value, json!({"review":{"b":2,"c":[true,null]}}));
        }
        let source = "review:\n  - 'one' # keep\n  - two\n";
        let out = apply(
            source,
            &[remove("/review/1"), set("/review/-", json!({"x":1}))],
        )
        .unwrap();
        assert!(out.contains("  - 'one' # keep\n"));
        assert_eq!(
            serde_yaml_ng::from_str::<Value>(&out).unwrap(),
            json!({"review":["one",{"x":1}]})
        );
    }
    #[test]
    fn implicit_null_and_empty_containers_can_be_replaced() {
        for source in [
            "value:\nkeep: true\n",
            "value: # comment\nkeep: true\n",
            "value: []\nkeep: true\n",
            "value: {}\nkeep: true\n",
        ] {
            let out = apply(source, &[set("/value", json!([false, null]))]).unwrap();
            assert_eq!(
                serde_yaml_ng::from_str::<Value>(&out).unwrap(),
                json!({"value":[false,null],"keep":true})
            );
        }
    }
    #[test]
    fn semantic_noops_leave_every_byte_unchanged() {
        let source = "tags: ['work'] # preserved\nvalue: {count: 0x10, flag: TRUE}\n";
        assert_eq!(
            apply(
                source,
                &[
                    set("/value/count", json!(16)),
                    set("/value/flag", json!(true)),
                    remove("/absent")
                ]
            )
            .unwrap(),
            source
        );
    }
    #[test]
    fn reserved_fields_and_invalid_paths_are_rejected() {
        for path in [
            "/id",
            "/created",
            "/body",
            "",
            "review/x",
            "/review/~2",
            "/review//x",
            "/review/missing/x",
            "/review/items/01",
        ] {
            assert!(
                apply("review: {items: [1]}\n", &[set(path, json!(1))]).is_err(),
                "{path}"
            );
        }
    }
}
