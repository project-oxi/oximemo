//! Folder-level property schemas: `SCHEMA.toml` (design 2026-08-23 §6.2).
//!
//! A folder that carries a `SCHEMA.toml` declares property types, allowed
//! values, badge display, state transitions, and (optionally) a review
//! queue. This layer knows nothing about UI: it parses, validates, and
//! executes transitions. [`crate::vault::Vault`] dispatches to it; the
//! frontend consumes the serialized [`FolderSchema`].
//!
//! Validation is warning-level by contract — a violation never blocks a
//! save (quick capture and external editors stay unrestricted).

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, Result};
use crate::props::{PropValue, Props};

// ---- Model -----------------------------------------------------------------

/// The schema document. Mirrors the on-disk TOML shape 1:1.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FolderSchema {
    #[serde(default)]
    pub workspace: WorkspaceDef,
    #[serde(default)]
    pub meta: SchemaMeta,
    #[serde(default)]
    pub properties: BTreeMap<String, PropertyDef>,
    #[serde(default)]
    pub transitions: Vec<TransitionRule>,
    #[serde(default)]
    pub review: Option<ReviewDef>,
}

/// `[workspace]` — display-only metadata.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceDef {
    /// Display name for the folder's workspace surfaces (optional).
    #[serde(default)]
    pub name: Option<String>,
}

/// `[meta]` — provenance marker. Preset-installed schemas carry
/// `preset = "<id>"` so the UI can tell managed collections apart from
/// user-authored custom schemas. Existing files predate this marker and
/// are never rewritten; consumers fall back to path matching.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SchemaMeta {
    /// Preset id (`book`, `movie`, `knowledge`, …). `None` = custom.
    #[serde(default)]
    pub preset: Option<String>,
}

/// Editor type of one property (§6.2: `text | select | multiselect |
/// date`, plus `bool` for checkbox-typed presets like movie `series`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PropType {
    #[default]
    Text,
    Select,
    Multiselect,
    Date,
    Bool,
}

/// `[properties.<key>]`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PropertyDef {
    #[serde(rename = "type", default)]
    pub prop_type: PropType,
    /// Allowed values. Empty = free-form. Declaration order doubles as
    /// the ranking used by `merge = "max"` transitions.
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub required: bool,
    /// Expose this select's value as a badge on cards/lists/graph nodes.
    #[serde(default)]
    pub badge: bool,
    /// Value → design-token color for badge rendering. Values without an
    /// entry fall back to a declaration-order palette.
    #[serde(default)]
    pub colors: BTreeMap<String, String>,
    /// Metadata-provider field this property auto-fills from (e.g.
    /// `metadata = "author"`). Declared by collection presets; the
    /// stamp flow fills only mapped fields (ratings never map).
    #[serde(default)]
    pub metadata: Option<String>,
}

/// The default knowledge folder's vault-relative path — a system folder
/// that ships with every vault (created by `Vault::migrate`, design
/// 2026-08-23 + user prompt: "지식 폴더도 초기부터 있게, 데일리 폴더처럼").
/// The physical name stays stable for grep/CLI parity; the UI displays a
/// localized name (macOS `~/Desktop` → "데스크톱" convention).
pub const DEFAULT_KNOWLEDGE_FOLDER: &str = "knowledge";
/// Default Inbox folder's vault-relative path — the quick-capture
/// destination (the `idea` preset). Installed on first `migrate()`
/// (one-shot seed gated by [`crate::path::Paths::inbox_seed_marker_path`],
/// design 2026-08-25); never recreated after the user deletes it
/// (install-type collection contract, §2.6 of the collections design).
pub const DEFAULT_INBOX_FOLDER: &str = "inbox";

/// When a transition rule fires.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OnKind {
    /// Fire only when the value actually changed (default).
    #[default]
    Change,
    /// Fire on any save where the key holds one of the `to` values —
    /// including a same-value reassert (the review queue's
    /// "설명 가능함" action).
    Write,
}

/// How `copy_from`/`into` merges with an existing value.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MergeKind {
    /// Overwrite unconditionally (default).
    #[default]
    Replace,
    /// Keep whichever value ranks higher in the source property's
    /// `options` order — the `peak_status` "all-time high" semantic.
    Max,
}

/// `[[transitions]]`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TransitionRule {
    /// The property whose writes fire this rule.
    pub key: String,
    /// Optional gate on the PREVIOUS value (empty = any).
    #[serde(default)]
    pub from: Vec<String>,
    /// Fire when the new value is one of these.
    pub to: Vec<String>,
    #[serde(default)]
    pub on: OnKind,
    /// Copy the post-transition value of this property…
    #[serde(default)]
    pub copy_from: Option<String>,
    /// …into this property.
    #[serde(default)]
    pub into: Option<String>,
    #[serde(default)]
    pub merge: Option<MergeKind>,
    /// Stamp today's date (`YYYY-MM-DD`) into this date property.
    #[serde(default)]
    pub stamp_date: Option<String>,
}
/// `[review]` — declares the folder's review queue. The queue UI exists
/// iff this block is present; nothing else (no folder-name or kind
/// marker) may turn it on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewDef {
    /// The property the queue filters (e.g. `status`).
    pub property: String,
    /// Values considered "due for review" (e.g. understood/mastered).
    pub due_values: Vec<String>,
    /// Sort key (a date property). Missing/empty values fall back to the
    /// core `updated_at` so the queue never silently misorders.
    pub order_by: Option<String>,
    /// The value the "막힘" action transitions to (e.g. decayed).
    pub decay_to: String,
    /// Optional promote action (spec 2026-08-23 §2.3, ideas): moves the
    /// note into another folder and stamps it — the queue then renders
    /// "승격" instead of the default reassert pair.
    #[serde(default)]
    pub promote: Option<PromoteDef>,
}

/// `[review.promote]` — where a promoted note lands.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PromoteDef {
    /// Destination folder (vault-relative, e.g. `knowledge`).
    pub into: String,
    /// `kind` value stamped on arrival (e.g. `knowledge`).
    pub kind: String,
    /// Starting value for the destination folder's status ladder.
    pub start_status: Option<String>,
}

// ---- Parsing ----------------------------------------------------------------

/// Parse a `SCHEMA.toml` document.
pub fn parse_schema(src: &str) -> Result<FolderSchema> {
    let schema: FolderSchema = toml::from_str(src)
        .map_err(|e| CoreError::other(format!("invalid SCHEMA.toml: {e}")))?;
    for rule in &schema.transitions {
        if rule.key.is_empty() || rule.to.is_empty() {
            return Err(CoreError::other(format!(
                "invalid SCHEMA.toml transition: `key` and `to` are required"
            )));
        }
        if (rule.copy_from.is_some() || rule.into.is_some() || rule.merge.is_some())
            && !(rule.copy_from.is_some() && rule.into.is_some())
        {
            return Err(CoreError::other(format!(
                "invalid SCHEMA.toml transition on `{}`: copy_from and into go together",
                rule.key
            )));
        }
    }
    if let Some(r) = &schema.review
        && (r.property.is_empty() || r.due_values.is_empty() || r.decay_to.is_empty())
    {
        return Err(CoreError::other(
            "invalid SCHEMA.toml [review]: property, due_values, decay_to are required",
        ));
    }
    Ok(schema)
}

/// Read and parse the SCHEMA.toml under `folder` (vault-root-relative).
/// `None` when the folder has no schema (free-property mode).
pub fn read_schema(vault_root: &Path, folder: &str) -> Result<Option<FolderSchema>> {
    let folder = folder.trim_end_matches('/');
    let path = if folder.is_empty() {
        vault_root.join(crate::paths::SCHEMA_NAME)
    } else {
        vault_root.join(folder).join(crate::paths::SCHEMA_NAME)
    };
    let Ok(src) = std::fs::read_to_string(&path) else {
        return Ok(None);
    };
    Ok(Some(parse_schema(&src)?))
}

// ---- Validation --------------------------------------------------------------

/// One warning-level schema violation. Never blocks a save.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Violation {
    pub key: String,
    pub reason: String,
}

/// Check a property map against the schema. Warning-level by contract.
pub fn validate(schema: &FolderSchema, props: &Props) -> Vec<Violation> {
    let mut out = Vec::new();
    for (key, def) in &schema.properties {
        let value = match props.get(key) {
            Some(v) => v,
            None => {
                if def.required {
                    out.push(Violation {
                        key: key.clone(),
                        reason: "required property is missing".into(),
                    });
                }
                continue;
            }
        };
        let members: Vec<&str> = match value {
            PropValue::Str(s) => vec![s],
            PropValue::Bool(b) => vec![if *b { "true" } else { "false" }],
            PropValue::List(items) => items.iter().map(|s| s.as_str()).collect(),
        };
        match def.prop_type {
            PropType::Text | PropType::Multiselect => {
                if def.prop_type == PropType::Multiselect && !def.options.is_empty() {
                    for m in &members {
                        if !def.options.iter().any(|o| o == m) {
                            out.push(Violation {
                                key: key.clone(),
                                reason: format!("{m:?} is not an allowed value"),
                            });
                        }
                    }
                }
            }
            PropType::Select => {
                if members.len() > 1 {
                    out.push(Violation {
                        key: key.clone(),
                        reason: "select property must hold a single value".into(),
                    });
                }
                if !def.options.is_empty() {
                    for m in &members {
                        if !def.options.iter().any(|o| o == m) {
                            out.push(Violation {
                                key: key.clone(),
                                reason: format!("{m:?} is not an allowed value"),
                            });
                        }
                    }
                }
            }
            PropType::Date => {
                for m in &members {
                    if crate::template::parse_iso_date(m).is_none() {
                        out.push(Violation {
                            key: key.clone(),
                            reason: format!("{m:?} is not a YYYY-MM-DD date"),
                        });
                    }
                }
            }
            PropType::Bool => {
                if !matches!(value, PropValue::Bool(_)) {
                    out.push(Violation {
                        key: key.clone(),
                        reason: "bool property must be true/false".into(),
                    });
                }
            }
        }
    }
    out
}

// ---- Transition execution -----------------------------------------------------

/// Execute the schema's transition rules over a property edit and return
/// the final property map (user edits + side effects). `old` is the
/// pre-edit snapshot; `new` already contains the user's changes.
///
/// Rule semantics (§6.2): rules apply in declaration order; the default
/// trigger is `on = "change"` (the key's value actually changed);
/// `on = "write"` also fires on a same-value reassert save.
/// `merge = "max"` keeps whichever of old/new `into`-value ranks higher
/// in the source property's `options` order.
pub fn apply_transitions(schema: &FolderSchema, old: &Props, new: &Props) -> Props {
    let mut out = new.clone();
    let today = time::OffsetDateTime::now_utc().date();
    let today_str = today.to_string();

    for rule in &schema.transitions {
        let new_val = out.get(&rule.key).cloned();
        let old_val = old.get(&rule.key).cloned();

        let new_str = new_val.as_ref().map(value_str);
        let fired_on_value = new_str
            .as_deref()
            .is_some_and(|s| rule.to.iter().any(|t| t == s));
        if !fired_on_value {
            continue;
        }
        let changed = new_val != old_val;
        match rule.on {
            OnKind::Change => {
                if !changed {
                    continue;
                }
                // Optional previous-value gate.
                if !rule.from.is_empty() {
                    let old_s = old_val.as_ref().map(value_str);
                    let gated = old_s
                        .as_deref()
                        .is_some_and(|s| rule.from.iter().any(|f| f == s))
                        || (old_s.is_none() && rule.from.iter().any(|f| f.is_empty()));
                    if !gated {
                        continue;
                    }
                }
            }
            OnKind::Write => {}
        }

        if let Some(dest) = &rule.stamp_date {
            out.insert(dest.clone(), PropValue::Str(today_str.clone()));
        }

        if let (Some(src), Some(dest)) = (&rule.copy_from, &rule.into) {
            let Some(src_val) = out.get(src).cloned() else {
                continue;
            };
            let incoming = value_str(&src_val);
            let merge = rule.merge.unwrap_or(MergeKind::Replace);
            match out.get(dest).cloned() {
                Some(existing) => {
                    let existing_str = value_str(&existing);
                    let keep = match merge {
                        MergeKind::Replace => incoming.clone(),
                        MergeKind::Max => {
                            let rank = rank_of(schema, src, &existing_str);
                            let new_rank = rank_of(schema, src, &incoming);
                            if new_rank >= rank {
                                incoming.clone()
                            } else {
                                existing_str
                            }
                        }
                    };
                    out.insert(dest.clone(), PropValue::Str(keep));
                }
                None => {
                    out.insert(dest.clone(), PropValue::Str(incoming.clone()));
                }
            }
        }
    }
    out
}

/// The scalar string of a property value (lists → first member; bools →
/// literal). Transitions compare scalars.
fn value_str(v: &PropValue) -> String {
    match v {
        PropValue::Str(s) => s.clone(),
        PropValue::Bool(b) => b.to_string(),
        PropValue::List(items) => items.first().cloned().unwrap_or_default(),
    }
}

/// Rank of `value` within `schema.properties[key].options` (declaration
/// order). Unknown values rank below everything known (`-1`... but treat
/// existing-known vs incoming-unknown carefully: unknown → `usize::MAX`
/// would keep unknown; the knowledge preset always knows its values).
fn rank_of(schema: &FolderSchema, key: &str, value: &str) -> usize {
    match schema.properties.get(key) {
        Some(def) => def
            .options
            .iter()
            .position(|o| o == value)
            .unwrap_or(usize::MAX),
        None => usize::MAX,
    }
}

// ---- Knowledge preset ----------------------------------------------------------

/// The knowledge preset's `TEMPLATE.md` (design §6.3): a stub skeleton
/// whose frontmatter carries the initial properties.
pub const KNOWLEDGE_TEMPLATE_MD: &str = "---\nkind: knowledge\nstatus: stub\n---\n\n# \n";

/// The knowledge preset's `SCHEMA.toml`: status lifecycle, domains
/// (required 7 + optional 3 as a commented line), TECH subdomain codes,
/// peak-preserving transitions, and the review queue.
pub const KNOWLEDGE_SCHEMA_TOML: &str = r#"[meta]
preset = "knowledge"

[workspace]
name = "지식"

[properties.kind]
type = "select"
options = ["note", "knowledge", "daily", "book", "movie", "blog", "novel", "idea"]

[properties.status]
type = "select"
options = ["stub", "vague", "understood", "mastered", "decayed"]
required = true
badge = true
[properties.status.colors]
stub = "neutral"
vague = "muted"
understood = "info"
mastered = "success"
decayed = "warning"

[properties.peak_status]
type = "select"
options = ["understood", "mastered"]

[properties.domain]
type = "select"
options = ["SCI", "MATH", "TECH", "SOC", "CULT", "HIST", "FIN"]
# optional domains: ["SCI", "MATH", "TECH", "SOC", "CULT", "HIST", "FIN", "PHIL", "LANG", "LIFE"]
required = true

[properties.subdomain]
type = "multiselect"
options = ["SW", "AI", "DATA", "SEC", "HW", "SYS"]

[properties.aliases]
type = "multiselect"

[properties.related]
type = "multiselect"

[properties.source]
type = "text"

[properties.status_changed]
type = "date"

[[transitions]]
key = "status"
to = ["understood", "mastered"]
copy_from = "status"
into = "peak_status"
merge = "max"

[[transitions]]
key = "status"
to = ["stub", "vague", "understood", "mastered", "decayed"]
on = "write"
stamp_date = "status_changed"

[review]
property = "status"
due_values = ["understood", "mastered"]
order_by = "status_changed"
decay_to = "decayed"
"#;

/// The daily preset's `TEMPLATE.md` (user prompt 2026-08-23): frontmatter
/// stamps the document kind; the H1 normalizes to the date at creation
/// (`open_daily`), so `{{date}}` here matches the canonical form.
pub const DAILY_TEMPLATE_MD: &str = "---\nkind: daily\n---\n# {{date}}\n";

/// The daily preset's `SCHEMA.toml`: a lightweight journaling schema —
/// mood (badge → calendar dot colors) and energy, both optional so
/// pre-preset notes never warn. Applied to the *configured* daily
/// folder (`[daily] folder`), not a hardcoded path.
pub const DAILY_SCHEMA_TOML: &str = r#"[meta]
preset = "daily"

[workspace]
name = "데일리"

[properties.kind]
type = "select"
options = ["note", "knowledge", "daily", "book", "movie", "blog", "novel", "idea"]

[properties.mood]
type = "select"
options = ["great", "good", "okay", "low", "bad"]
badge = true
[properties.mood.colors]
great = "success"
good = "info"
okay = "neutral"
low = "warning"
bad = "error"

[properties.energy]
type = "select"
options = ["high", "medium", "low"]
"#;

// ---- Installable collection presets (spec 2026-08-23 §2.2) -------------------
//
// Knowledge/daily ship with every vault (system folders); these five
// install on demand (`install_collection`). Every SCHEMA carries the
// `[meta] preset` marker so settings can tell managed collections
// apart from user-authored custom schemas.

/// Books: reading lifecycle + highlight review. `author` auto-fills
/// from the metadata providers (`metadata = "author"`).
pub const BOOK_TEMPLATE_MD: &str = "---\nkind: book\nstatus: reading\n---\n\n# \n";

pub const BOOK_SCHEMA_TOML: &str = r#"[meta]
preset = "book"

[workspace]
name = "책"

[properties.kind]
type = "select"
options = ["note", "knowledge", "daily", "book", "movie", "blog", "novel", "idea"]

[properties.status]
type = "select"
options = ["reading", "done", "paused", "abandoned"]
badge = true
[properties.status.colors]
reading = "info"
done = "success"
paused = "neutral"
abandoned = "muted"

[properties.rating]
type = "select"
options = ["1", "2", "3", "4", "5"]

[properties.author]
type = "text"
metadata = "author"

[properties.isbn]
type = "text"
metadata = "isbn"

[properties.published_date]
type = "text"
metadata = "published_date"

[properties.page_count]
type = "text"
metadata = "page_count"

[properties.source_url]
type = "text"

[properties.cover_url]
type = "text"

[review]
property = "status"
due_values = ["done"]
decay_to = "reading"
"#;

/// Movies/series: watched-date log. `series` is a real checkbox
/// (`type = "bool"` → toggle editor, Bool envelope). The `{{date}}`
/// default is QUOTED — a bare `{{…}}` is a YAML flow-mapping start and
/// a hard parse error in the frontmatter subset, which silently killed
/// the whole template stamp (found via the CLI schema smoke, 2026-08-24;
/// regression test `movie_template_stamps_kind_and_watched_at`).
pub const MOVIE_TEMPLATE_MD: &str = "---\nkind: movie\nwatched_at: \"{{date}}\"\n---\n\n# \n";

pub const MOVIE_SCHEMA_TOML: &str = r#"[meta]
preset = "movie"

[workspace]
name = "영화"

[properties.kind]
type = "select"
options = ["note", "knowledge", "daily", "book", "movie", "blog", "novel", "idea"]

[properties.watched_at]
type = "date"

[properties.rating]
type = "select"
options = ["1", "2", "3", "4", "5"]

[properties.series]
type = "bool"

[properties.director]
type = "text"
metadata = "director"

[properties.release_date]
type = "text"
metadata = "release_date"

[properties.runtime_min]
type = "text"
metadata = "runtime_min"

[properties.original_title]
type = "text"
metadata = "original_title"

[properties.source_url]
type = "text"

[properties.cover_url]
type = "text"
"#;

/// Blog: a writing pipeline (초고 → 수정 → 예약 → 발행).
pub const BLOG_TEMPLATE_MD: &str = "---\nkind: blog\nstatus: draft\n---\n\n# \n";

pub const BLOG_SCHEMA_TOML: &str = r#"[meta]
preset = "blog"

[workspace]
name = "블로그"

[properties.kind]
type = "select"
options = ["note", "knowledge", "daily", "book", "movie", "blog", "novel", "idea"]

[properties.status]
type = "select"
options = ["draft", "revising", "scheduled", "published"]
badge = true
[properties.status.colors]
draft = "neutral"
revising = "warning"
scheduled = "info"
published = "success"

[properties.platform]
type = "text"

[properties.published_at]
type = "date"
"#;

/// Novel — 집필 (manuscript writing): project folder, chapters as notes,
/// chapter status. Renamed from "소설" (2026-08-24): the writing
/// collection must not read as a reading one next to 책. Long-form
/// dedicated views stay out of scope (spec §7).
pub const NOVEL_TEMPLATE_MD: &str = "---\nkind: novel\nstatus: outline\n---\n\n# \n";

pub const NOVEL_SCHEMA_TOML: &str = r#"[meta]
preset = "novel"

[workspace]
name = "집필"

[properties.kind]
type = "select"
options = ["note", "knowledge", "daily", "book", "movie", "blog", "novel", "idea"]

[properties.status]
type = "select"
options = ["outline", "draft", "rev1", "done"]
badge = true
[properties.status.colors]
outline = "neutral"
draft = "info"
rev1 = "warning"
done = "success"
"#;

/// Inbox (display name; preset id `idea` is stable data vocabulary per
/// spec 2026-08-25): the quick-capture destination. Notes land here with
/// `kind: idea` and `status: fleeting`; the review queue promotes
/// keepers to `knowledge` (folder move + status stamp) and archives
/// the rest via `[review] decay_to`.
pub const IDEA_TEMPLATE_MD: &str = "---\nkind: idea\nstatus: fleeting\n---\n\n# \n";

pub const IDEA_SCHEMA_TOML: &str = r#"[meta]
preset = "idea"

[workspace]
name = "인박스"

[properties.kind]
type = "select"
options = ["note", "knowledge", "daily", "book", "movie", "blog", "novel", "idea"]

[properties.status]
type = "select"
options = ["fleeting", "archived"]
badge = true
[properties.status.colors]
fleeting = "info"
archived = "neutral"

[properties.source]
type = "text"

[review]
property = "status"
due_values = ["fleeting"]
decay_to = "archived"

[review.promote]
into = "knowledge"
kind = "knowledge"
start_status = "stub"
"#;

/// Preset id → (TEMPLATE.md, SCHEMA.toml) for every managed preset —
/// the default-shipped pair included, so `install_collection` is the
/// single entry point and the settings catalog has one source of ids.
pub fn collection_preset(id: &str) -> Option<(&'static str, &'static str)> {
    match id {
        "knowledge" => Some((KNOWLEDGE_TEMPLATE_MD, KNOWLEDGE_SCHEMA_TOML)),
        "daily" => Some((DAILY_TEMPLATE_MD, DAILY_SCHEMA_TOML)),
        "book" => Some((BOOK_TEMPLATE_MD, BOOK_SCHEMA_TOML)),
        "movie" => Some((MOVIE_TEMPLATE_MD, MOVIE_SCHEMA_TOML)),
        "blog" => Some((BLOG_TEMPLATE_MD, BLOG_SCHEMA_TOML)),
        "novel" => Some((NOVEL_TEMPLATE_MD, NOVEL_SCHEMA_TOML)),
        "idea" => Some((IDEA_TEMPLATE_MD, IDEA_SCHEMA_TOML)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn knowledge() -> FolderSchema {
        parse_schema(KNOWLEDGE_SCHEMA_TOML).unwrap()
    }

    fn props(pairs: &[(&str, &str)]) -> Props {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), PropValue::Str(v.to_string())))
            .collect()
    }

    #[test]
    fn knowledge_preset_parses() {
        let s = knowledge();
        assert_eq!(s.workspace.name.as_deref(), Some("지식"));
        assert!(s.properties["status"].badge);
        assert_eq!(s.properties["status"].options.len(), 5);
        assert_eq!(s.transitions.len(), 2);
        let review = s.review.as_ref().unwrap();
        assert_eq!(review.property, "status");
        assert_eq!(review.decay_to, "decayed");
    }

    #[test]
    fn collection_presets_parse_with_marker() {
        for (id, (_, schema_toml)) in [
            ("knowledge", (KNOWLEDGE_TEMPLATE_MD, KNOWLEDGE_SCHEMA_TOML)),
            ("daily", (DAILY_TEMPLATE_MD, DAILY_SCHEMA_TOML)),
            ("book", (BOOK_TEMPLATE_MD, BOOK_SCHEMA_TOML)),
            ("movie", (MOVIE_TEMPLATE_MD, MOVIE_SCHEMA_TOML)),
            ("blog", (BLOG_TEMPLATE_MD, BLOG_SCHEMA_TOML)),
            ("novel", (NOVEL_TEMPLATE_MD, NOVEL_SCHEMA_TOML)),
            ("idea", (IDEA_TEMPLATE_MD, IDEA_SCHEMA_TOML)),
        ] {
            let s = parse_schema(schema_toml)
                .unwrap_or_else(|e| panic!("{id} preset must parse: {e}"));
            assert_eq!(s.meta.preset.as_deref(), Some(id), "{id} carries the marker");
            let kind = &s.properties["kind"];
            assert!(kind.options.contains(&"note".to_string()));
            assert!(kind.options.contains(&id.to_string()));
            assert_eq!(collection_preset(id).map(|(_, sc)| sc), Some(schema_toml));
        }
        assert!(collection_preset("nope").is_none());
    }

    #[test]
    fn idea_preset_declares_promote_and_metadata_maps() {
        let s = parse_schema(IDEA_SCHEMA_TOML).unwrap();
        let review = s.review.as_ref().unwrap();
        let promote = review.promote.as_ref().expect("ideas declare promote");
        assert_eq!(promote.into, "knowledge");
        assert_eq!(promote.kind, "knowledge");
        assert_eq!(promote.start_status.as_deref(), Some("stub"));

        let book = parse_schema(BOOK_SCHEMA_TOML).unwrap();
        assert_eq!(book.properties["author"].metadata.as_deref(), Some("author"));
        assert!(book.properties["rating"].metadata.is_none(), "ratings never map");

        let movie = parse_schema(MOVIE_SCHEMA_TOML).unwrap();
        assert_eq!(movie.properties["series"].prop_type, PropType::Bool);
    }

    #[test]
    fn parse_rejects_bad_transitions() {
        assert!(parse_schema("[[transitions]]\nkey = \"x\"\nto = []\n").is_err());
        assert!(parse_schema("[[transitions]]\nkey = \"x\"\nto = [\"a\"]\ninto = \"y\"\n").is_err());
        assert!(parse_schema("[review]\nproperty = \"status\"\n").is_err());
    }

    #[test]
    fn validate_reports_required_and_option_violations() {
        let s = knowledge();
        // Empty props: missing required status + domain.
        let vs = validate(&s, &Props::new());
        assert!(vs.iter().any(|v| v.key == "status"));
        assert!(vs.iter().any(|v| v.key == "domain"));

        // Bad option value.
        let mut p = props(&[("status", " mastered "), ("domain", "TECH")]);
        p.insert("status".into(), PropValue::Str("guru".into()));
        let vs = validate(&s, &p);
        assert!(vs.iter().any(|v| v.key == "status" && v.reason.contains("guru")));

        // Bad date.
        let mut p2 = props(&[("status", "stub"), ("domain", "TECH")]);
        p2.insert("status_changed".into(), PropValue::Str("2026-13-99".into()));
        let vs = validate(&s, &p2);
        assert!(vs.iter().any(|v| v.key == "status_changed"));

        // Clean props validate.
        let mut p3 = props(&[("status", "stub"), ("domain", "TECH")]);
        p3.insert(
            "status_changed".into(),
            PropValue::Str("2026-08-23".into()),
        );
        assert!(validate(&s, &p3).is_empty(), "{p3:?}");
    }

    #[test]
    fn entry_transition_records_all_time_high_peak() {
        let s = knowledge();
        // stub → understood: peak recorded.
        let old = props(&[("status", "stub")]);
        let new = props(&[("status", "understood")]);
        let out = apply_transitions(&s, &old, &new);
        assert_eq!(
            out.get("peak_status"),
            Some(&PropValue::Str("understood".into()))
        );
        assert!(out.get("status_changed").is_some());

        // mastered entry keeps peak at mastered.
        let new2 = props(&[("status", "mastered")]);
        let out2 = apply_transitions(&s, &out, &new2);
        assert_eq!(
            out2.get("peak_status"),
            Some(&PropValue::Str("mastered".into()))
        );

        // Collapse to decayed then re-learn to understood: peak stays
        // mastered (all-time high, never downgraded).
        let decayed = props(&[("status", "decayed"), ("peak_status", "mastered")]);
        let relearn = props(&[("status", "understood"), ("peak_status", "mastered")]);
        let out3 = apply_transitions(&s, &decayed, &relearn);
        assert_eq!(
            out3.get("peak_status"),
            Some(&PropValue::Str("mastered".into())),
            "merge=max must preserve the historical peak"
        );
    }

    #[test]
    fn write_trigger_fires_on_reassert() {
        let s = knowledge();
        // Same value reasserted (the review queue's "설명 가능함").
        let old = props(&[("status", "understood"), ("status_changed", "2026-01-01")]);
        let new = props(&[("status", "understood"), ("status_changed", "2026-01-01")]);
        let out = apply_transitions(&s, &old, &new);
        let stamped = out.get("status_changed").unwrap();
        let today = time::OffsetDateTime::now_utc().date().to_string();
        assert_eq!(stamped, &PropValue::Str(today));
        // Change-triggered copy rule did NOT fire (no value change):
        // peak_status untouched (absent here).
        assert!(!out.contains_key("peak_status"));
    }

    #[test]
    fn change_trigger_skips_unchanged_saves() {
        let s = knowledge();
        let old = props(&[("status", "stub"), ("status_changed", "2026-01-01")]);
        // The `to`-gated stamp rule is on="write" in the preset; swap to a
        // synthetic on="change"-only rule set to prove the default.
        let src = r#"
[[transitions]]
key = "status"
to = ["stub"]
stamp_date = "status_changed"
"#;
        let s2 = parse_schema(src).unwrap();
        let new = old.clone();
        let out = apply_transitions(&s2, &old, &new);
        assert_eq!(
            out.get("status_changed"),
            Some(&PropValue::Str("2026-01-01".into())),
            "on=change must not fire on an unchanged value"
        );
        let _ = s;
    }

    #[test]
    fn from_gate_restricts_source_values() {
        let src = r#"
[[transitions]]
key = "status"
from = ["understood", "mastered"]
to = ["decayed"]
copy_from = "status"
into = "peak_status"
"#;
        let s = parse_schema(src).unwrap();
        // understood → decayed: fires.
        let out = apply_transitions(
            &s,
            &props(&[("status", "understood")]),
            &props(&[("status", "decayed")]),
        );
        assert_eq!(
            out.get("peak_status"),
            Some(&PropValue::Str("decayed".into()))
        );
        // vague → decayed: from-gate blocks.
        let out2 = apply_transitions(
            &s,
            &props(&[("status", "vague")]),
            &props(&[("status", "decayed")]),
        );
        assert!(!out2.contains_key("peak_status"));
    }
}
