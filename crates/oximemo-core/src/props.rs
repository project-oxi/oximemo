//! Generic note properties (frontmatter keys beyond the core schema).
//!
//! A note's *properties* are every frontmatter key except the five core
//! keys (`id`, `created`, `updated`, `favorite`, `deleted`). They are
//! schema-free at this layer: parsing, filtering, sorting, and the
//! indexed snapshot. Folder-level schemas (SCHEMA.toml) live in
//! [`crate::schema`] and consume these types; this module must stay
//! schema-ignorant (design 2026-08-23 §5).

use std::collections::BTreeMap;

use oxi_frontmatter::{Table, Value};
use serde::{Deserialize, Serialize};

use crate::error::{CoreError, Result};
use crate::memo::{MemoFilter, MemoSummary};

/// The five core frontmatter keys managed by the file contract itself.
pub const CORE_KEYS: [&str; 5] = ["id", "created", "updated", "favorite", "deleted"];

/// A property map: key → 1-dimensional value, deterministically ordered
/// (BTreeMap so hashing and serialization are stable).
pub type Props = BTreeMap<String, PropValue>;

/// A property value. Deliberately small (design §5.1): scalars and lists
/// only. `number` is absent until numeric sorting is actually needed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum PropValue {
    Str(String),
    Bool(bool),
    List(Vec<String>),
}

impl PropValue {
    /// Render as the string used for hashing and search indexing.
    pub fn as_hash_str(&self) -> String {
        match self {
            PropValue::Str(s) => format!("s:{s}"),
            PropValue::Bool(b) => format!("b:{b}"),
            PropValue::List(items) => format!("l:{}", items.join("\x1e")),
        }
    }

    /// Convert back into a frontmatter [`Value`] for `set_props` writes.
    pub fn to_frontmatter(&self) -> Value {
        match self {
            PropValue::Str(s) => Value::Str(s.clone()),
            PropValue::Bool(b) => Value::Bool(*b),
            PropValue::List(items) => Value::Array(items.clone()),
        }
    }
}

/// Extract the property map from a parsed frontmatter table: every
/// non-core key with a 1-dimensional value. `Map` values are preserved on
/// disk by the write path but are not queryable, so they are skipped here.
pub fn props_from_table(table: &Table) -> Props {
    let mut out = Props::new();
    for (k, v) in table {
        if CORE_KEYS.contains(&k.as_str()) {
            continue;
        }
        let prop = match v {
            Value::Str(s) => PropValue::Str(s.clone()),
            Value::Bool(b) => PropValue::Bool(*b),
            Value::Array(items) => PropValue::List(items.clone()),
            Value::Map(_) => continue,
        };
        out.insert(k.clone(), prop);
    }
    out
}

/// The note's `aliases` values (Obsidian-compatible convention key):
/// a list, or a single scalar promoted to a one-element list.
pub fn aliases_of(props: &Props) -> Vec<String> {
    match props.get("aliases") {
        Some(PropValue::List(items)) => items.clone(),
        Some(PropValue::Str(s)) if !s.is_empty() => vec![s.clone()],
        _ => Vec::new(),
    }
}

/// Concatenate all 1-dimensional property values into one string for
/// wiki-link scanning (design §5.3: `[[..]]` inside property values count
/// as links). List items are joined with newlines.
pub fn props_link_text(props: &Props) -> String {
    let mut parts = Vec::new();
    for v in props.values() {
        match v {
            PropValue::Str(s) => parts.push(s.clone()),
            PropValue::List(items) => parts.extend(items.iter().cloned()),
            PropValue::Bool(b) => {
                let _ = b; // booleans never contain links
            }
        }
    }
    parts.join("\n")
}

// ---- Query ----------------------------------------------------------------

/// How a property predicate compares the stored value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum PropOp {
    /// Scalar equality; for lists, any member equals.
    Eq,
    /// Value set membership: the stored value (or any list member) is one
    /// of `values`.
    In,
    /// List membership (`subdomain~AI`): any list member equals the value.
    /// On scalars, falls back to substring containment.
    Contains,
}

/// A single property filter condition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PropPredicate {
    pub key: String,
    pub op: PropOp,
    pub values: Vec<String>,
}

impl PropPredicate {
    fn hit_scalar(&self, s: &str) -> bool {
        match self.op {
            PropOp::Eq => s == self.values.first().map(|v| v.as_str()).unwrap_or(""),
            PropOp::In => self.values.iter().any(|v| v == s),
            PropOp::Contains => self
                .values
                .first()
                .map(|v| s.contains(v.as_str()))
                .unwrap_or(false),
        }
    }

    /// Check this predicate against a property map.
    pub fn matches(&self, props: &Props) -> bool {
        match props.get(&self.key) {
            Some(PropValue::Str(s)) => self.hit_scalar(s),
            Some(PropValue::Bool(b)) => self.hit_scalar(if *b { "true" } else { "false" }),
            Some(PropValue::List(items)) => {
                if self.op == PropOp::Contains {
                    let v = self.values.first().map(|v| v.as_str()).unwrap_or("");
                    items.iter().any(|i| i == v)
                } else {
                    items.iter().any(|i| self.hit_scalar(i))
                }
            }
            None => false,
        }
    }
}

/// Parse a `--where KEY=VAL` / `KEY~VAL` expression. Comma-separated
/// values become `In`. Returns a precise error for malformed input.
pub fn parse_where(raw: &str) -> Result<PropPredicate> {
    let (key, op, value) = if let Some((k, v)) = raw.split_once('~') {
        (k, PropOp::Contains, v)
    } else if let Some((k, v)) = raw.split_once('=') {
        (k, PropOp::Eq, v)
    } else {
        return Err(CoreError::other(format!(
            "invalid --where expression {raw:?}: expected KEY=VAL or KEY~VAL"
        )));
    };
    let key = key.trim();
    if key.is_empty() {
        return Err(CoreError::other(format!(
            "invalid --where expression {raw:?}: empty key"
        )));
    }
    let values: Vec<String> = if op == PropOp::Contains {
        vec![value.to_string()]
    } else {
        value.split(',').map(|s| s.trim().to_string()).collect()
    };
    if values.iter().any(|v| v.is_empty()) || values.is_empty() {
        return Err(CoreError::other(format!(
            "invalid --where expression {raw:?}: empty value"
        )));
    }
    let op = if op == PropOp::Eq && values.len() > 1 {
        PropOp::In
    } else {
        op
    };
    Ok(PropPredicate {
        key: key.to_string(),
        op,
        values,
    })
}

/// Sort specification for [`NoteQuery`]. The default listing path
/// (`list_memos`) stays cursor-paginated newest-first; only explicit
/// sorts use this.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum SortSpec {
    #[default]
    UpdatedDesc,
    UpdatedAsc,
    /// Ascending by property key (missing values sort last).
    PropAsc(String),
}

/// Parse a `--sort` expression: `updated`, `updated:desc`, or a property
/// key (ascending).
pub fn parse_sort(raw: &str) -> Result<SortSpec> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(CoreError::other("invalid --sort: empty"));
    }
    if let Some((key, dir)) = raw.split_once(':') {
        if key.trim() == "updated" {
            return match dir.trim() {
                "asc" => Ok(SortSpec::UpdatedAsc),
                "desc" => Ok(SortSpec::UpdatedDesc),
                other => Err(CoreError::other(format!(
                    "invalid --sort direction {other:?}: expected asc|desc"
                ))),
            };
        }
        return Err(CoreError::other(format!(
            "invalid --sort {raw:?}: only `updated` supports :asc/:desc"
        )));
    }
    match raw {
        "updated" => Ok(SortSpec::UpdatedAsc),
        other => Ok(SortSpec::PropAsc(other.to_string())),
    }
}

/// An offset-paginated property query (design §5.2). In-memory filter +
/// sort over the index snapshot; never reads note files.
#[derive(Debug, Clone, Default)]
pub struct NoteQuery {
    pub filter: MemoFilter,
    pub props: Vec<PropPredicate>,
    pub sort: SortSpec,
    pub offset: usize,
    pub limit: u32,
}

impl NoteQuery {
    /// Apply the query to pre-loaded summaries. Returns (matched, total).
    pub fn apply(&self, summaries: Vec<MemoSummary>) -> (Vec<MemoSummary>, usize) {
        let mut matched: Vec<MemoSummary> = summaries
            .into_iter()
            .filter(|s| self.filter.matches(s) && self.props.iter().all(|p| p.matches(&s.props)))
            .collect();
        match &self.sort {
            SortSpec::UpdatedDesc => matched.sort_by(|a, b| {
                b.updated_at
                    .cmp(&a.updated_at)
                    .then_with(|| b.id.cmp(&a.id))
            }),
            SortSpec::UpdatedAsc => matched.sort_by(|a, b| {
                a.updated_at
                    .cmp(&b.updated_at)
                    .then_with(|| a.id.cmp(&b.id))
            }),
            SortSpec::PropAsc(key) => matched.sort_by(|a, b| {
                let av = a.props.get(key).map(prop_sort_key);
                let bv = b.props.get(key).map(prop_sort_key);
                match (av, bv) {
                    (Some(x), Some(y)) => x.cmp(&y),
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    (None, None) => a.id.cmp(&b.id),
                }
            }),
        }
        let total = matched.len();
        let items = matched
            .into_iter()
            .skip(self.offset)
            .take(self.limit.max(1) as usize)
            .collect();
        (items, total)
    }
}

/// Sort key for a property value: lists sort by their first member,
/// bools by their literal. String comparison is plain lexicographic —
/// numeric-aware ordering arrives with `PropValue::Num` (design §10).
fn prop_sort_key(v: &PropValue) -> String {
    match v {
        PropValue::Str(s) => s.clone(),
        PropValue::Bool(b) => b.to_string(),
        PropValue::List(items) => items.first().cloned().unwrap_or_default(),
    }
}

/// One page of a [`NoteQuery`] result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryPage {
    pub items: Vec<MemoSummary>,
    pub total: usize,
}

/// A property write request: set these keys, remove those. Used by the
/// editor's property panel, CLI `--set/--unset`, and transitions.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PropMutation {
    #[serde(default)]
    pub sets: Vec<(String, PropValue)>,
    #[serde(default)]
    pub removes: Vec<String>,
}

impl PropMutation {
    pub fn is_empty(&self) -> bool {
        self.sets.is_empty() && self.removes.is_empty()
    }

    /// Merge into `set_props` entries (set wins over remove for the same
    /// key — last write wins, matching panel semantics). Callers collect
    /// these into `Mutation::set_props` via `Default` + `insert`, so this
    /// crate needs no indexmap dependency.
    pub fn to_set_props(&self) -> Vec<(String, Option<Value>)> {
        let mut out: Vec<(String, Option<Value>)> = Vec::new();
        for k in &self.removes {
            out.push((k.clone(), None));
        }
        for (k, v) in &self.sets {
            out.retain(|(key, _)| key != k);
            out.push((k.clone(), Some(v.to_frontmatter())));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxi_frontmatter::parse;

    fn table(src: &str) -> Table {
        let parsed = parse(src, oxi_frontmatter::NoteFormat::Markdown).unwrap();
        match parsed {
            oxi_frontmatter::Parsed::Memo { table, .. } => table,
            _ => panic!("expected memo"),
        }
    }

    #[test]
    fn props_from_table_excludes_core_and_maps() {
        let t = table(
            "---\nid: x\ncreated: 2026-01-01T00:00:00Z\nupdated: 2026-01-01T00:00:00Z\nfavorite: true\nstatus: stub\ndomain: TECH\nsubdomain: [AI, SEC]\nrelated: [\"[[딥러닝]]\"]\npublished: false\noxios:\n  author: agent\n---\nb",
        );
        let props = props_from_table(&t);
        assert_eq!(props.len(), 5);
        assert_eq!(props["status"], PropValue::Str("stub".into()));
        assert_eq!(
            props["subdomain"],
            PropValue::List(vec!["AI".into(), "SEC".into()])
        );
        assert_eq!(props["published"], PropValue::Bool(false));
        assert!(!props.contains_key("id"));
        assert!(!props.contains_key("oxios"));
    }

    #[test]
    fn aliases_of_promotes_scalar() {
        let mut props = Props::new();
        assert!(aliases_of(&props).is_empty());
        props.insert("aliases".into(), PropValue::Str("ML".into()));
        assert_eq!(aliases_of(&props), vec!["ML".to_string()]);
        props.insert(
            "aliases".into(),
            PropValue::List(vec!["ML".into(), "기계학습".into()]),
        );
        assert_eq!(aliases_of(&props).len(), 2);
    }

    #[test]
    fn props_link_text_joins_lists() {
        let mut props = Props::new();
        props.insert(
            "related".into(),
            PropValue::List(vec!["[[딥러닝]]".into(), "[[경사하강법]]".into()]),
        );
        props.insert("source".into(), PropValue::Str("책".into()));
        let text = props_link_text(&props);
        assert!(text.contains("[[딥러닝]]"));
        assert!(text.contains("책"));
    }

    #[test]
    fn parse_where_forms() {
        assert_eq!(
            parse_where("status=stub").unwrap(),
            PropPredicate {
                key: "status".into(),
                op: PropOp::Eq,
                values: vec!["stub".into()]
            }
        );
        // comma → In
        let p = parse_where("domain=TECH,MATH").unwrap();
        assert_eq!(p.op, PropOp::In);
        assert_eq!(p.values, vec!["TECH", "MATH"]);
        // ~ → Contains
        let p = parse_where("subdomain~AI").unwrap();
        assert_eq!(p.op, PropOp::Contains);
        assert!(parse_where("noequals").is_err());
        assert!(parse_where("=x").is_err());
        assert!(parse_where("a=").is_err());
    }

    #[test]
    fn predicate_matching() {
        let mut props = Props::new();
        props.insert("status".into(), PropValue::Str("understood".into()));
        props.insert(
            "subdomain".into(),
            PropValue::List(vec!["AI".into(), "SEC".into()]),
        );
        props.insert("done".into(), PropValue::Bool(true));

        assert!(parse_where("status=understood").unwrap().matches(&props));
        assert!(!parse_where("status=stub").unwrap().matches(&props));
        assert!(
            parse_where("status=stub,vague,understood")
                .unwrap()
                .matches(&props)
        );
        assert!(parse_where("subdomain~AI").unwrap().matches(&props));
        assert!(!parse_where("subdomain~DATA").unwrap().matches(&props));
        assert!(parse_where("done=true").unwrap().matches(&props));
        assert!(!parse_where("missing=x").unwrap().matches(&props));
    }

    #[test]
    fn parse_sort_forms() {
        assert_eq!(parse_sort("updated").unwrap(), SortSpec::UpdatedAsc);
        assert_eq!(parse_sort("updated:desc").unwrap(), SortSpec::UpdatedDesc);
        assert_eq!(
            parse_sort("status_changed").unwrap(),
            SortSpec::PropAsc("status_changed".into())
        );
        assert!(parse_sort("other:desc").is_err());
        assert!(parse_sort("").is_err());
    }

    #[test]
    fn prop_mutation_to_set_props() {
        let m = PropMutation {
            sets: vec![("status".into(), PropValue::Str("stub".into()))],
            removes: vec!["tags".into()],
        };
        let sp = m.to_set_props();
        assert_eq!(
            sp.iter().find(|(k, _)| k == "tags").map(|(_, v)| v.clone()),
            Some(None),
            "removed key must map to None"
        );
        assert_eq!(
            sp.iter()
                .find(|(k, _)| k == "status")
                .map(|(_, v)| v.clone()),
            Some(Some(Value::Str("stub".into())))
        );
        // Set wins over remove for the same key.
        let m2 = PropMutation {
            sets: vec![("x".into(), PropValue::Str("1".into()))],
            removes: vec!["x".into()],
        };
        assert!(matches!(m2.to_set_props().as_slice(), [(_, Some(_))]));
    }
}
