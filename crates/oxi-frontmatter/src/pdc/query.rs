//! `pdc-query/1` classification for `.base` files (PDC-QUERY-1.0).
//!
//! Stage 0 gate only: a `.base` file is safe general YAML under the same
//! restrictions as a `pdc-document/2` envelope, and its portable Bases
//! subset structure is checked just deeply enough to separate
//! executable-shape queries from unknown-but-preserved ones. There is no
//! evaluation engine here: queries are read-only projections and are
//! never executed, rewritten, or treated as authorization.

use super::yaml::{self, Yaml, YamlErrorKind};
use super::{DiagnosticKind, PdcDiagnostic};

/// 1 MiB `.base` transport limit (PDC-QUERY-1.0 §3.1).
const MAX_QUERY_BYTES: usize = 1024 * 1024;

/// Top-level keys the portable subset defines; everything else is
/// preserved and displayed but marks the query unexecuted.
const KNOWN_TOP_LEVEL: [&str; 5] = ["filters", "formulas", "properties", "summaries", "views"];

/// Keys defined inside a view mapping; anything else marks the whole
/// view an unknown view.
const KNOWN_VIEW_KEYS: [&str; 7] = [
    "type",
    "name",
    "limit",
    "groupBy",
    "filters",
    "order",
    "summaries",
];

/// Outcome of classifying one `.base` file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QueryClassification {
    /// Parses and every known key carries a portable-subset shape; an
    /// app implementing the query contract may evaluate it.
    Valid,
    /// Parses, but carries unknown top-level keys, an unknown view type,
    /// or unknown view keys: preserve, display, never partially execute.
    ValidUnexecuted,
    /// Malformed YAML, forbidden YAML features, wrong root type, or a
    /// known key with an incompatible shape: `invalid_query`.
    Invalid(PdcDiagnostic),
}

/// Classify one `.base` file. Never executes the query and never
/// mutates the input.
pub fn classify_query(bytes: &[u8]) -> QueryClassification {
    if bytes.starts_with(super::BOM) {
        return invalid("byte-order mark present; queries are UTF-8 without a BOM");
    }
    if bytes.len() > MAX_QUERY_BYTES {
        return invalid("query exceeds the 1 MiB `.base` limit");
    }
    let text = match std::str::from_utf8(bytes) {
        Ok(t) => t,
        Err(e) => return invalid(format!("query is not valid UTF-8: {e}")),
    };
    let root = match yaml::parse_document(text) {
        Ok(root) => root,
        Err(e) => {
            return match e.kind {
                YamlErrorKind::Malformed => invalid(e.reason),
                // The document-plane cap diagnostic has no query meaning;
                // an over-cap query is simply malformed input here.
                YamlErrorKind::TooComplex => invalid(e.reason),
            };
        }
    };
    let Yaml::Map(top) = &root else {
        return invalid("query root must be a mapping");
    };

    let mut unexecuted = false;
    for (key, value) in top {
        if !KNOWN_TOP_LEVEL.contains(&key.as_str()) {
            unexecuted = true;
            continue;
        }
        match key.as_str() {
            "filters" => {
                if let Err(reason) = check_filter(value) {
                    return invalid(reason);
                }
            }
            "formulas" | "summaries" => {
                let Yaml::Map(entries) = value else {
                    return invalid(format!("`{key}` must be a mapping of name → expression"));
                };
                for (name, expr) in entries {
                    if matches!(expr, Yaml::Str(_)) {
                        if let Err(reason) = check_expression(expr.as_str().expect("string")) {
                            return invalid(format!("{key}.{name}: {reason}"));
                        }
                    } else {
                        return invalid(format!("`{key}.{name}` must be a string expression"));
                    }
                }
            }
            "properties" => {
                let Yaml::Map(entries) = value else {
                    return invalid(
                        "`properties` must be a mapping of property reference → display metadata",
                    );
                };
                for (property, meta) in entries {
                    if !meta.is_map() {
                        return invalid(format!(
                            "`properties.{property}` must be a display-metadata mapping"
                        ));
                    }
                }
            }
            "views" => {
                let Some(views) = value.as_seq() else {
                    return invalid("`views` must be a sequence of view mappings");
                };
                for (index, view) in views.iter().enumerate() {
                    match check_view(view) {
                        Ok(true) => {}
                        Ok(false) => unexecuted = true,
                        Err(reason) => return invalid(format!("views[{index}]: {reason}")),
                    }
                }
            }
            _ => unreachable!("known key from KNOWN_TOP_LEVEL"),
        }
    }
    if unexecuted {
        QueryClassification::ValidUnexecuted
    } else {
        QueryClassification::Valid
    }
}

/// Check one view mapping; `Ok(false)` marks an unknown view.
fn check_view(view: &Yaml) -> Result<bool, String> {
    let Yaml::Map(entries) = view else {
        return Err("view must be a mapping".into());
    };
    for (key, _) in entries {
        if !KNOWN_VIEW_KEYS.contains(&key.as_str()) {
            return Ok(false); // unknown view key: preserve, never execute
        }
    }
    let get = |key: &str| entries.iter().find(|(k, _)| k == key).map(|(_, v)| v);
    let view_type = get("type").and_then(Yaml::as_str).unwrap_or_default();
    if view_type != "table" && view_type != "list" {
        return Ok(false); // unknown view type (e.g. `cards`)
    }
    if get("name").and_then(Yaml::as_str).is_none() {
        return Err("view requires a string `name`".into());
    }
    if let Some(order) = get("order") {
        let Some(items) = order.as_seq() else {
            return Err("`order` must be a sequence of property references".into());
        };
        if items.iter().any(|item| !matches!(item, Yaml::Str(_))) {
            return Err("`order` entries must be property-reference strings, not mappings".into());
        }
    }
    if let Some(summaries) = get("summaries") {
        let Yaml::Map(summary_entries) = summaries else {
            return Err(
                "view `summaries` must be a mapping of property reference → summary name".into(),
            );
        };
        if summary_entries
            .iter()
            .any(|(_, name)| !matches!(name, Yaml::Str(_)))
        {
            return Err("view `summaries` values must be summary-name strings".into());
        }
    }
    if let Some(limit) = get("limit") {
        let Yaml::Number(limit) = limit else {
            return Err("`limit` must be a non-negative integer".into());
        };
        let decimal = limit.strip_prefix('+').unwrap_or(limit);
        if !decimal.chars().any(|c| c.is_ascii_digit())
            || !decimal.chars().all(|c| c.is_ascii_digit() || c == '_')
        {
            return Err("`limit` must be a non-negative integer".into());
        }
    }
    if let Some(group) = get("groupBy")
        && !group.is_map()
    {
        return Err("`groupBy` must be a `{property, direction}` mapping".into());
    }
    if let Some(filters) = get("filters") {
        check_filter(filters)?;
    }
    Ok(true)
}

/// Check a filter expression: a string, or a recursive mapping with
/// exactly one of `and` / `or` / `not`.
fn check_filter(value: &Yaml) -> Result<(), String> {
    match value {
        Yaml::Str(expr) => check_expression(expr),
        Yaml::Map(entries) => {
            let combinators = ["and", "or", "not"];
            let mut found: Option<&str> = None;
            for (key, _) in entries {
                if !combinators.contains(&key.as_str()) {
                    return Err(format!(
                        "filter mapping key `{key}` is not `and`/`or`/`not`"
                    ));
                }
                if found.replace(key.as_str()).is_some() {
                    return Err(
                        "filter mapping must contain exactly one of `and`/`or`/`not`".into(),
                    );
                }
            }
            let Some(combinator) = found else {
                return Err("filter mapping must contain exactly one of `and`/`or`/`not`".into());
            };
            let value = &entries
                .iter()
                .find(|(k, _)| k == combinator)
                .map(|(_, v)| v)
                .expect("combinator key present");
            let Some(items) = value.as_seq() else {
                return Err(format!(
                    "`{combinator}` must be a sequence of filter expressions"
                ));
            };
            for item in items {
                check_filter(item)?;
            }
            Ok(())
        }
        _ => Err("filter expression must be a string or `and`/`or`/`not` mapping".into()),
    }
}

/// Light expression gate, not an engine: equality must be spelled `==`;
/// a lone `=` (not part of `==`, `!=`, `<=`, `>=`) is rejected instead of
/// being compatibly interpreted.
fn check_expression(expr: &str) -> Result<(), String> {
    let bytes = expr.as_bytes();
    for (i, b) in bytes.iter().enumerate() {
        if *b != b'=' {
            continue;
        }
        let prev = if i == 0 { b'\0' } else { bytes[i - 1] };
        let next = bytes.get(i + 1).copied().unwrap_or(b'\0');
        let paired = next == b'=' || prev == b'=' || prev == b'!' || prev == b'<' || prev == b'>';
        if !paired {
            return Err(format!(
                "expression uses a lone `=`; equality must be spelled `==`: {expr:?}"
            ));
        }
    }
    Ok(())
}

fn invalid(reason: impl Into<String>) -> QueryClassification {
    QueryClassification::Invalid(PdcDiagnostic::new(DiagnosticKind::InvalidQuery, reason))
}
