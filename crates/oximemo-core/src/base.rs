//! `.query` file model — load, validate, serialize.
//!
//! The schema mirrors Obsidian Bases / Notion database views (spec §1).
//! This module owns the YAML model + load-time validation only; runtime
//! evaluation lives behind [`crate::expr`].
pub(crate) mod cache;
pub(crate) mod exec;
pub(crate) mod files;

use serde::de::{self, Deserializer};
use std::collections::{BTreeMap, BTreeSet, HashSet};

use serde::{Deserialize, Serialize};

pub(crate) use cache::SharedResultCache;
pub use exec::{
    BaseCell, BasePage, BaseRow, BaseSource, EvalClockDto, GroupCount, PropInfo, RunBaseReq,
    SummaryValue, default_columns,
};
pub use files::BaseInfo;

use crate::error::CoreError;
use crate::expr::parser::{Expr, parse_expr};

/// Which dataset a base iterates (spec §4): `notes` (the default — one
/// row per indexed note) or `tasks` (one row per indexed task; `file.*`
/// still serves the parent note). Unknown YAML values are load-time
/// errors via serde.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BaseSourceKind {
    #[default]
    Notes,
    Tasks,
}

/// The full `.query` document.
///
/// `views` is required after normalization (see [`parse_base`]); callers
/// always see at least one materialised view.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BaseDef {
    #[serde(default)]
    pub source: BaseSourceKind,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub filters: Option<FilterSpec>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub formulas: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub properties: Option<BTreeMap<String, ColumnMeta>>,
    #[serde(default)]
    pub views: Vec<BaseViewDef>,
    /// Forward-compat catch-all for unknown top-level keys (spec §1).
    #[serde(flatten)]
    pub extra: serde_yaml_ng::Mapping,
}

/// Display-only metadata for a column.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub display_name: Option<String>,
}

/// Filters are either a bare expression string or a grouped `and`/`or`/`not`
/// block (single-element list for `not`, spec §1).
///
/// Deserialization is hand-rolled because an `#[serde(untagged)]` enum
/// cannot decide between a bare string and a map-with-one-of-`and|or|not`
/// key when both appear inside a heterogeneous YAML sequence — exactly the
/// shape spec §1 mandates.
#[derive(Debug, Clone)]
pub enum FilterSpec {
    Expr(String),
    Group(FilterGroup),
}

#[derive(Debug, Clone)]
pub enum FilterGroup {
    And(Vec<FilterSpec>),
    Or(Vec<FilterSpec>),
    /// Spec §1: `not:` is a single-element list (`not: ['expr']`).
    Not(Vec<FilterSpec>),
}

impl<'de> Deserialize<'de> for FilterSpec {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = serde_yaml_ng::Value::deserialize(d)?;
        filter_spec_from_value(v).map_err(de::Error::custom)
    }
}

fn filter_spec_from_value(v: serde_yaml_ng::Value) -> Result<FilterSpec, String> {
    let v = strip_tags(v);
    match v {
        serde_yaml_ng::Value::String(s) => Ok(FilterSpec::Expr(s)),
        serde_yaml_ng::Value::Mapping(map) => {
            if map.len() != 1 {
                return Err(format!(
                    "filter group must have exactly one key (and/or/not); got {}",
                    map.len()
                ));
            }
            let (key, val) = map.into_iter().next().unwrap();
            let key = key
                .as_str()
                .ok_or_else(|| "filter group key must be a string".to_string())?
                .to_string();
            let items = match strip_tags(val) {
                serde_yaml_ng::Value::Sequence(seq) => seq,
                other => return Err(format!("`{key}` filter body must be a list, got {other:?}")),
            };
            let mut children = Vec::with_capacity(items.len());
            for item in items {
                children.push(filter_spec_from_value(item)?);
            }
            match key.as_str() {
                "and" => Ok(FilterSpec::Group(FilterGroup::And(children))),
                "or" => Ok(FilterSpec::Group(FilterGroup::Or(children))),
                "not" => Ok(FilterSpec::Group(FilterGroup::Not(children))),
                other => Err(format!("unknown filter group `{other}`")),
            }
        }
        other => Err(format!("filter must be string or group map; got {other:?}")),
    }
}

fn strip_tags(v: serde_yaml_ng::Value) -> serde_yaml_ng::Value {
    match v {
        serde_yaml_ng::Value::Tagged(t) => strip_tags(t.value),
        serde_yaml_ng::Value::Sequence(seq) => {
            serde_yaml_ng::Value::Sequence(seq.into_iter().map(strip_tags).collect())
        }
        serde_yaml_ng::Value::Mapping(map) => serde_yaml_ng::Value::Mapping(
            map.into_iter().map(|(k, v)| (k, strip_tags(v))).collect(),
        ),
        other => other,
    }
}

impl Serialize for FilterGroup {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut map = s.serialize_map(Some(1))?;
        let (key, items) = match self {
            FilterGroup::And(xs) => ("and", xs),
            FilterGroup::Or(xs) => ("or", xs),
            FilterGroup::Not(xs) => ("not", xs),
        };
        map.serialize_key(key)?;
        map.serialize_value(items)?;
        map.end()
    }
}

impl Serialize for FilterSpec {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            FilterSpec::Expr(s) => serde::Serialize::serialize(s, serializer),
            FilterSpec::Group(g) => g.serialize(serializer),
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BaseViewDef {
    pub r#type: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub filters: Option<FilterSpec>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub order: Option<Vec<OrderSpec>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub columns: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub group_by: Option<GroupBySpec>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub summaries: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub limit: Option<u32>,
    #[serde(flatten)]
    pub extra: serde_yaml_ng::Mapping,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderSpec {
    pub property: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub direction: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupBySpec {
    pub property: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub direction: Option<String>,
}

/// View types that the renderer actually understands. Anything else is
/// preserved verbatim and reported as a warning so the frontend can show
/// a skipped tab.
pub const KNOWN_VIEW_TYPES: [&str; 5] = ["table", "board", "cards", "list", "tasks"];

/// The spec §1 example, embedded verbatim for round-trip tests.
pub const SPEC_EXAMPLE: &str = r#"filters:
  and:
    - 'status != "done"'
    - or:
        - 'file.inFolder("book")'
        - 'file.favorite == true'
formulas:
  age: '(now() - file.created).days()'
properties:
  status: { displayName: 상태 }
views:
  - type: table
    name: 읽는 중
    filters:
      and:
        - 'rating >= 4'
        - 'file.hasTag("소설")'
    order:
      - { property: note.updated, direction: desc }
    columns: [file.name, status, note.rating, formula.age]
    groupBy: { property: status, direction: asc }
    summaries: { note.rating: Average }
    limit: 500
"#;

/// Parse a `.query` document. The empty / missing `views` array is
/// normalised in place to a single default `table` view (spec §1).
pub fn parse_base(yaml: &str) -> Result<BaseDef, CoreError> {
    let mut def: BaseDef =
        serde_yaml_ng::from_str(yaml).map_err(|e| map_yaml_err(&e, "parse_base"))?;
    if def.views.is_empty() {
        def.views.push(BaseViewDef {
            r#type: "table".to_string(),
            name: Some("Table".to_string()),
            ..BaseViewDef::default()
        });
    }
    Ok(def)
}

/// Serialize a [`BaseDef`] back to YAML.
pub fn write_base(def: &BaseDef) -> Result<String, CoreError> {
    serde_yaml_ng::to_string(def).map_err(|e| map_yaml_err(&e, "write_base"))
}

/// Run load-time validation. Returns warnings on Ok; cycles and unresolved
/// `formula.*` references are hard errors (`Err`).
pub fn validate(def: &BaseDef) -> Result<Vec<String>, CoreError> {
    let mut warnings: Vec<String> = Vec::new();

    // 1. Formula cycles.
    // Build the graph unconditionally; absence of a `formulas:` block just
    // means step 2 has nothing to compare against.
    let mut graph: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    if let Some(formulas) = &def.formulas {
        for (name, expr_src) in formulas {
            let deps = formula_deps(expr_src)?;
            graph.insert(name.clone(), deps);
        }
    }
    // Single DFS pass with a shared `finished` set: a node whose post-order
    // walk completed without a back-edge is acyclic and is never re-walked,
    // so diamond/chain graphs of thousands of formulas stay linear rather
    // than exponential. (Fix: cycle DFS exponential on diamond graphs.)
    let mut on_stack: HashSet<&str> = HashSet::new();
    let mut finished: HashSet<&str> = HashSet::new();
    let names: Vec<&str> = graph.keys().map(String::as_str).collect();
    for name in names {
        if finished.contains(name) {
            continue;
        }
        let mut path: Vec<&str> = Vec::new();
        if let Some(cycle) = dfs_cycle(name, &graph, &mut path, &mut on_stack, &mut finished) {
            return Err(CoreError::Expr {
                message: format!("formula cycle: {cycle}"),
                line: 0,
                col: 0,
            });
        }
    }
    // 2. Unresolved `formula.*` references are hard errors (spec §2):
    //    in formula BODIES here, and in view fields below. The cycle
    //    DFS above skips unknown deps, so this is their error surface.
    let known: BTreeSet<&str> = def
        .formulas
        .as_ref()
        .map(|m| m.keys().map(String::as_str).collect())
        .unwrap_or_default();
    for (name, deps) in &graph {
        for dep in deps {
            if !known.contains(dep.as_str()) {
                return Err(CoreError::Expr {
                    message: format!("formula `{name}` references unknown formula `formula.{dep}`"),
                    line: 0,
                    col: 0,
                });
            }
        }
    }

    // 3. columns / order / groupBy / summaries reference an unknown formula?
    //    Always runs — a stray `formula.x` in any view field is a hard Err
    //    even with no `formulas:` block (spec §1). (Fix: unresolved refs.)
    for (i, view) in def.views.iter().enumerate() {
        let v_label = view_label(view, i);
        if let Some(cols) = &view.columns {
            for col in cols {
                check_formula_ref(col, &known, &v_label, "columns")?;
            }
        }
        if let Some(orders) = &view.order {
            for (j, ord) in orders.iter().enumerate() {
                check_formula_ref(&ord.property, &known, &v_label, &format!("order[{j}]"))?;
            }
        }
        if let Some(gb) = &view.group_by {
            check_formula_ref(&gb.property, &known, &v_label, "groupBy")?;
        }
        if let Some(sums) = &view.summaries {
            for key in sums.keys() {
                check_formula_ref(key, &known, &v_label, "summaries")?;
            }
        }
    }

    // 4. Warning: filter that depends on `this.note.*` outside an embed.
    for (i, view) in def.views.iter().enumerate() {
        let v_label = view_label(view, i);
        if let Some(f) = &view.filters {
            collect_this_warnings(f, &format!("views[{v_label}].filters"), &mut warnings);
        }
    }
    if let Some(f) = &def.filters {
        collect_this_warnings(f, "filters", &mut warnings);
    }
    // 5. Warning: unknown view type.
    for (i, view) in def.views.iter().enumerate() {
        let t = &view.r#type;
        if !KNOWN_VIEW_TYPES.contains(&t.as_str()) {
            warnings.push(format!(
                "views[{i}].type `{t}` is not recognised; renderer will skip this tab"
            ));
        }
    }

    // 6. Warning: view type / dataset mismatch (spec §4).
    for (i, view) in def.views.iter().enumerate() {
        let v_label = view_label(view, i);
        match def.source {
            BaseSourceKind::Notes => {
                if view.r#type == "tasks" {
                    warnings.push(format!(
                        "view {v_label}: type `tasks` requires source: tasks"
                    ));
                }
            }
            BaseSourceKind::Tasks => {
                if !matches!(
                    view.r#type.as_str(),
                    "tasks" | "table" | "board" | "list" | "cards"
                ) {
                    warnings.push(format!(
                        "view {v_label}: source: tasks supports tasks/table/board/list/cards"
                    ));
                }
            }
        }
    }

    Ok(warnings)
}

// --- helpers --------------------------------------------------------------

fn map_yaml_err(e: &serde_yaml_ng::Error, op: &'static str) -> CoreError {
    if let Some(loc) = e.location() {
        CoreError::Expr {
            message: format!("{op}: {e}"),
            line: loc.line() as u32,
            col: loc.column() as u32,
        }
    } else {
        CoreError::Expr {
            message: format!("{op}: {e}"),
            line: 0,
            col: 0,
        }
    }
}

/// Pull every `formula.<name>` segment out of an expression string.
fn formula_deps(expr_src: &str) -> Result<BTreeSet<String>, CoreError> {
    let ast = parse_expr(expr_src)?;
    let mut out = BTreeSet::new();
    walk_formula(&ast, &mut out);
    Ok(out)
}

fn walk_formula(e: &Expr, out: &mut BTreeSet<String>) {
    match e {
        Expr::Lit(_) => {}
        Expr::Path(segs) => {
            if segs.len() == 2 && segs[0] == "formula" {
                out.insert(segs[1].clone());
            }
        }
        Expr::Call { args, .. } => {
            for a in args {
                walk_formula(a, out);
            }
        }
        Expr::Method { target, args, .. } => {
            walk_formula(target, out);
            for a in args {
                walk_formula(a, out);
            }
        }
        Expr::Index { target, index } => {
            walk_formula(target, out);
            walk_formula(index, out);
        }
        Expr::Unary { expr, .. } => walk_formula(expr, out),
        Expr::Binary { lhs, rhs, .. } => {
            walk_formula(lhs, out);
            walk_formula(rhs, out);
        }
    }
}

fn dfs_cycle<'a>(
    node: &'a str,
    graph: &'a BTreeMap<String, BTreeSet<String>>,
    path: &mut Vec<&'a str>,
    on_stack: &mut HashSet<&'a str>,
    finished: &mut HashSet<&'a str>,
) -> Option<String> {
    if finished.contains(node) {
        return None;
    }
    if on_stack.contains(node) {
        if let Some(pos) = path.iter().position(|p| *p == node) {
            let mut parts: Vec<String> = path[pos..].iter().map(|s| s.to_string()).collect();
            parts.push(node.to_string());
            return Some(parts.join(" -> "));
        }
        return None;
    }
    if !graph.contains_key(node) {
        return None;
    }
    path.push(node);
    on_stack.insert(node);
    let deps = graph.get(node).cloned().unwrap_or_default();
    for d in deps {
        let key = match graph.get_key_value(&d) {
            Some((k, _)) => k,
            None => continue,
        };
        if let Some(c) = dfs_cycle(key, graph, path, on_stack, finished) {
            return Some(c);
        }
    }
    on_stack.remove(node);
    path.pop();
    finished.insert(node);
    None
}
fn check_formula_ref(
    prop: &str,
    known: &BTreeSet<&str>,
    view: &str,
    field: &str,
) -> Result<(), CoreError> {
    // Only treat a property as a formula reference if it has the literal
    // `formula.` prefix — bare properties live on `note.*`/`file.*`.
    let Some(rest) = prop.strip_prefix("formula.") else {
        return Ok(());
    };
    if rest.is_empty() || rest.contains('.') || !known.contains(rest) {
        return Err(CoreError::Expr {
            message: format!("{view}.{field} references unknown formula `{prop}`"),
            line: 0,
            col: 0,
        });
    }
    Ok(())
}

fn collect_this_warnings(spec: &FilterSpec, where_: &str, out: &mut Vec<String>) {
    match spec {
        FilterSpec::Expr(src) => {
            if let Ok(ast) = parse_expr(src) {
                let mut touched = false;
                walk_this(&ast, &mut touched);
                if touched {
                    out.push(format!(
                        "{where_} references `this.note.*`; will evaluate to Null outside an embed"
                    ));
                }
            }
        }
        FilterSpec::Group(FilterGroup::And(xs))
        | FilterSpec::Group(FilterGroup::Or(xs))
        | FilterSpec::Group(FilterGroup::Not(xs)) => {
            for (i, x) in xs.iter().enumerate() {
                collect_this_warnings(x, &format!("{where_}[{i}]"), out);
            }
        }
    }
}

fn walk_this(e: &Expr, touched: &mut bool) {
    match e {
        Expr::Lit(_) => {}
        Expr::Path(segs) => {
            // spec §1: full-screen `this.file.*` is synthesised from the
            // `.query` file's own metadata, so it is meaningful outside an
            // embed. Only `this.note.*` (and bare `this`) is `Null` and is
            // therefore a load-time warning.
            let first = segs.first().map(String::as_str);
            let second = segs.get(1).map(String::as_str);
            match (first, second) {
                (Some("this"), Some("note")) => *touched = true,
                (Some("this"), None) if segs.len() == 1 => *touched = true,
                _ => {}
            }
        }
        Expr::Call { args, .. } => {
            for a in args {
                walk_this(a, touched);
            }
        }
        Expr::Method { target, args, .. } => {
            walk_this(target, touched);
            for a in args {
                walk_this(a, touched);
            }
        }
        Expr::Index { target, index } => {
            walk_this(target, touched);
            walk_this(index, touched);
        }
        Expr::Unary { expr, .. } => walk_this(expr, touched),
        Expr::Binary { lhs, rhs, .. } => {
            walk_this(lhs, touched);
            walk_this(rhs, touched);
        }
    }
}

fn view_label(view: &BaseViewDef, i: usize) -> String {
    match &view.name {
        Some(n) => format!("{i}({n})"),
        None => i.to_string(),
    }
}

// --- tests ----------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_spec_example() {
        let def = parse_base(SPEC_EXAMPLE).expect("parse");
        let yaml = write_base(&def).expect("write");
        let def2 = parse_base(&yaml).expect("re-parse");
        assert_eq!(def.views.len(), def2.views.len());
        let gb = def2.views[0]
            .group_by
            .as_ref()
            .expect("group_by present after round-trip");
        assert_eq!(gb.property, "status");
    }

    #[test]
    fn preserves_unknown_top_level_key() {
        let raw = "future: 1\nviews:\n  - type: table\n";
        let def = parse_base(raw).expect("parse");
        let yaml = write_base(&def).expect("write");
        // The unknown key must survive a round-trip.
        let parsed = serde_yaml_ng::from_str::<serde_yaml_ng::Value>(&yaml).expect("yaml parse");
        let mapping = parsed.as_mapping().expect("top-level mapping");
        let has_future = mapping.iter().any(|(k, _)| k.as_str() == Some("future"));
        assert!(has_future, "unknown `future` key lost: {yaml}");
    }

    #[test]
    fn detects_formula_cycle() {
        let yaml = r#"
formulas:
  a: 'formula.b == 1'
  b: 'formula.a == 1'
views:
  - type: table
"#;
        let def = parse_base(yaml).unwrap();
        let err = validate(&def).unwrap_err();
        let msg = format!("{err}");
        assert!(msg.contains("formula cycle"), "got: {msg}");
    }

    #[test]
    fn rejects_unresolved_formula_reference() {
        let yaml = r#"
formulas:
  age: '1'
views:
  - type: table
    columns: [formula.nope]
"#;
        let def = parse_base(yaml).unwrap();
        let err = validate(&def).unwrap_err();
        let msg = format!("{err}");
        assert!(
            msg.contains("formula.nope") && msg.contains("unknown"),
            "got: {msg}"
        );
    }

    /// Spec §2 makes an unresolved `formula.*` reference a load-time
    /// error — including references inside another formula's body, not
    /// just view fields (whole-branch review finding).
    #[test]
    fn rejects_unknown_formula_ref_inside_formula_body() {
        let yaml = r#"
formulas:
  a: 'formula.ghost + 1'
views:
  - type: table
"#;
        let def = parse_base(yaml).unwrap();
        let err = validate(&def).unwrap_err();
        let msg = format!("{err}");
        assert!(
            msg.contains("formula.ghost") && msg.contains("unknown"),
            "got: {msg}"
        );
    }

    #[test]
    fn defined_formula_chain_validates() {
        let yaml = r#"
formulas:
  a: 'formula.b + 1'
  b: 'note.rating * 2'
views:
  - type: table
    columns: [formula.a]
"#;
        let def = parse_base(yaml).unwrap();
        assert!(validate(&def).is_ok(), "defined chain must validate");
    }

    #[test]
    fn materialises_default_view_when_empty() {
        let def = parse_base("filters: 'true == true'\n").expect("parse");
        assert_eq!(def.views.len(), 1);
        assert_eq!(def.views[0].r#type, "table");
        assert_eq!(def.views[0].name.as_deref(), Some("Table"));
    }

    #[test]
    fn unknown_view_type_parses_and_warns() {
        let yaml = "views:\n  - type: gantt\n    name: G\n";
        let def = parse_base(yaml).expect("parse gantt");
        assert_eq!(def.views[0].r#type, "gantt");
        let warnings = validate(&def).expect("validate ok");
        assert!(
            warnings.iter().any(|w| w.contains("gantt")),
            "expected warning mentioning gantt; got {warnings:?}"
        );
    }

    #[test]
    fn camel_case_keys_round_trip() {
        let yaml = "views:\n  - type: table\n    groupBy: { property: status, direction: asc }\n";
        let def = parse_base(yaml).expect("parse");
        let gb = def.views[0].group_by.as_ref().expect("group_by");
        assert_eq!(gb.property, "status");
        assert_eq!(gb.direction.as_deref(), Some("asc"));
    }

    #[test]
    fn parse_error_carries_line_column() {
        let yaml = "views:\n  - type: table\n    columns: [\n";
        let err = parse_base(yaml).unwrap_err();
        match err {
            CoreError::Expr { line, col, .. } => {
                assert!(
                    line > 0 && col > 0,
                    "expected real location, got {line}:{col}"
                );
            }
            other => panic!("expected Expr error, got {other:?}"),
        }
    }

    #[test]
    fn filter_with_this_produces_warning() {
        let yaml = "filters: 'this.note.title == \"x\"'\nviews:\n  - type: table\n";
        let def = parse_base(yaml).unwrap();
        let warnings = validate(&def).unwrap();
        assert!(
            warnings.iter().any(|w| w.contains("this")),
            "expected this.* warning; got {warnings:?}"
        );
    }

    #[test]
    fn filter_group_and_or_not_parses() {
        let yaml = r#"
filters:
  and:
    - 'a == 1'
    - or:
        - 'b == 2'
        - not:
            - 'c == 3'
views:
  - type: table
"#;
        let def = parse_base(yaml).expect("parse");
        let g = match def.filters.as_ref().expect("filters") {
            FilterSpec::Group(g) => g,
            _ => panic!("expected group"),
        };
        let FilterGroup::And(children) = g else {
            panic!("expected and");
        };
        assert_eq!(children.len(), 2);
    }

    /// Fix #1: `columns: [formula.x]` with no `formulas:` block must Err.
    #[test]
    fn formula_ref_without_formulas_block_is_error() {
        let yaml = r#"
views:
  - type: table
    columns: [formula.nope]
"#;
        let def = parse_base(yaml).expect("parse");
        let err = validate(&def).unwrap_err();
        let msg = format!("{err}");
        assert!(
            msg.contains("formula.nope") && msg.contains("unknown"),
            "got: {msg}"
        );
    }

    /// Fix #2: `this.file.*` is synthesised from the .query file itself
    /// (spec §1), so it must NOT trigger a warning.
    #[test]
    fn this_file_does_not_warn() {
        let yaml = "filters: 'this.file.folder == \"book\"'\nviews:\n  - type: table\n";
        let def = parse_base(yaml).expect("parse");
        let warnings = validate(&def).expect("validate ok");
        assert!(
            warnings.iter().all(|w| !w.contains("this")),
            "this.file.* must not warn; got {warnings:?}"
        );
    }

    /// Fix #2 (positive): `this.note.*` resolves to Null outside embeds and
    /// remains a load-time warning.
    #[test]
    fn this_note_produces_warning() {
        let yaml = "filters: 'this.note.x == 1'\nviews:\n  - type: table\n";
        let def = parse_base(yaml).expect("parse");
        let warnings = validate(&def).expect("validate ok");
        assert!(
            warnings.iter().any(|w| w.contains("this.note")),
            "expected this.note.* warning; got {warnings:?}"
        );
    }

    /// Fix #3: a 60-node acyclic diamond formula graph must validate in
    /// linear time (structural assertion: Ok + empty warnings, not timing).
    #[test]
    fn cycle_dfs_handles_large_acyclic_graph() {
        let mut formulas = std::collections::BTreeMap::new();
        for i in 0..20 {
            // Keys are bare names (the YAML `formulas:` mapping
            // convention); bodies reference them as `formula.<name>`.
            let a = format!("a{i}");
            let b = format!("b{i}");
            let c = format!("c{i}");
            formulas.insert(
                format!("p{i}"),
                format!("formula.{a} == 1 && formula.{b} == 1"),
            );
            formulas.insert(a, "'x' == 'y'".to_string());
            formulas.insert(b, format!("formula.{c} == 1"));
            formulas.insert(c, "1 == 1".to_string());
        }
        let def = BaseDef {
            formulas: Some(formulas),
            views: vec![BaseViewDef {
                r#type: "table".to_string(),
                ..BaseViewDef::default()
            }],
            ..BaseDef::default()
        };
        let warnings = validate(&def).expect("acyclic graph validates");
        assert!(
            warnings.is_empty(),
            "no warnings expected on acyclic graph; got {warnings:?}"
        );
    }

    #[test]
    fn source_defaults_to_notes_and_parses_tasks() {
        let d = parse_base("views:\n  - type: table\n").unwrap();
        assert!(matches!(d.source, BaseSourceKind::Notes));
        let d = parse_base("source: tasks\nviews:\n  - type: table\n").unwrap();
        assert!(matches!(d.source, BaseSourceKind::Tasks));
        // round-trip keeps the field
        let yaml = write_base(&d).unwrap();
        assert!(yaml.contains("source: tasks"));
    }

    #[test]
    fn unknown_source_is_a_load_time_error() {
        let err = parse_base("source: bogus\nviews:\n  - type: table\n").unwrap_err();
        assert!(
            err.to_string().to_lowercase().contains("source"),
            "error names the field: {err}"
        );
    }

    #[test]
    fn validate_warns_on_source_view_type_mismatch() {
        // notes source + tasks view -> warning
        let d = parse_base("views:\n  - type: tasks\n").unwrap();
        let warns = validate(&d).unwrap();
        assert!(warns.iter().any(|w| w.contains("requires source: tasks")));
        // tasks source + unsupported view type -> warning
        let d = parse_base("source: tasks\nviews:\n  - type: gantt\n").unwrap();
        let warns = validate(&d).unwrap();
        assert!(
            warns.iter().any(|w| w.contains("source: tasks supports")),
            "gantt under source: tasks must warn; got {warns:?}"
        );
        // tasks source + tasks/table/board/list/cards -> no source warnings
        for ty in ["tasks", "table", "board", "list", "cards"] {
            let d = parse_base(&format!("source: tasks\nviews:\n  - type: {ty}\n")).unwrap();
            let warns = validate(&d).unwrap();
            assert!(
                !warns.iter().any(|w| w.contains("source")),
                "{ty}: {warns:?}"
            );
        }
    }
}
