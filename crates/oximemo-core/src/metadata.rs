//! Metadata provider contracts (spec 2026-08-23 §3.1): the pure, network-
//! free core layer that the src-tauri adapters and the front-end stamp
//! flow both consume.
//!
//! `ProviderInfo` is the static catalog (no network, no app state). The
//! `stamp_targets` walker is the only place that maps a `MetaHit` back
//! onto a schema's property envelopes — ratings never map, only
//! descriptive fields. Anything beyond that (network, key plumbing) lives
//! in `src-tauri/metadata.rs`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::props::{PropValue, Props};
use crate::schema::FolderSchema;


/// The objective fields a metadata provider can fill — anything else
/// (ratings, status, badges) is the user's judgment and never maps.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MetaField {
    Author,
    Isbn,
    PageCount,
    PublishedDate,
    Director,
    ReleaseDate,
    RuntimeMin,
    OriginalTitle,
}

/// A single search hit. `fields` is the per-field string the walker
/// matches against the schema's `metadata = "..."` declarations; unknown
/// fields silently drop (so adapters can over-deliver).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MetaHit {
    pub provider: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub url: Option<String>,
    /// Poster/cover image URL — descriptive like `url`, never mapped
    /// through `fields`; the stamp flow writes it to a schema-declared
    /// `cover_url` prop (same special case as source_url).
    pub cover_url: Option<String>,
    pub fields: BTreeMap<MetaField, String>,
}

/// Provider-level access rules (T7 surfaces these as badges in the
/// settings pane — TMDB needs a key, Open Library never does).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderAccess {
    /// No key, no registration. Always available.
    Keyless,
    /// Free for non-commercial/open-licensed data; some uses need
    /// registration. Render with a tooltip explaining the condition.
    ConditionalKeyless,
    /// Free key issued immediately on signup.
    Keyed,
    /// Key issued after a human review (1–2 days). UI shows a "awaiting
    /// approval" hint when the key is empty.
    KeyedWithApproval,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderDomain {
    Book,
    Movie,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProviderInfo {
    pub id: &'static str,
    pub domain: ProviderDomain,
    pub access: ProviderAccess,
    pub regions: &'static [&'static str],
}

/// v1 catalog (spec §3.2, all eight providers verified).
pub const PROVIDER_CATALOG: &[ProviderInfo] = &[
    // Books
    ProviderInfo { id: "open_library", domain: ProviderDomain::Book, access: ProviderAccess::Keyless, regions: &[] },
    ProviderInfo { id: "google_books", domain: ProviderDomain::Book, access: ProviderAccess::Keyed, regions: &[] },
    ProviderInfo { id: "aladin", domain: ProviderDomain::Book, access: ProviderAccess::Keyed, regions: &["KR"] },
    ProviderInfo { id: "ndl_search", domain: ProviderDomain::Book, access: ProviderAccess::ConditionalKeyless, regions: &["JP"] },
    ProviderInfo { id: "dnb_sru", domain: ProviderDomain::Book, access: ProviderAccess::Keyless, regions: &["DE"] },
    // Movies
    ProviderInfo { id: "tmdb", domain: ProviderDomain::Movie, access: ProviderAccess::Keyed, regions: &[] },
    ProviderInfo { id: "omdb", domain: ProviderDomain::Movie, access: ProviderAccess::Keyed, regions: &[] },
    ProviderInfo { id: "kmdb", domain: ProviderDomain::Movie, access: ProviderAccess::KeyedWithApproval, regions: &["KR"] },
];

/// Provider priority per (domain, region). Region-specific lists
/// override the global default — the search command runs only providers
/// the user has a key for (or keyless ones) in priority order.
pub fn provider_order(domain: ProviderDomain, region: &str) -> Vec<&'static str> {
    match (domain, region) {
        (ProviderDomain::Book, "KR") => vec!["aladin", "google_books", "open_library"],
        (ProviderDomain::Book, "JP") => vec!["ndl_search", "google_books", "open_library"],
        (ProviderDomain::Book, "DE") => vec!["dnb_sru", "google_books", "open_library"],
        (ProviderDomain::Book, _) => vec!["google_books", "open_library"],
        (ProviderDomain::Movie, "KR") => vec!["tmdb", "kmdb", "omdb"],
        (ProviderDomain::Movie, "JP") => vec!["tmdb", "omdb"],
        (ProviderDomain::Movie, "DE") => vec!["tmdb", "omdb"],
        (ProviderDomain::Movie, _) => vec!["tmdb", "omdb"],
    }
}

/// `MetaField` name as it appears in `[properties.X] metadata = "..."`.
/// Stable across providers — adapters normalize to these names so the
/// walker can match without provider-specific logic.
pub fn meta_field_name(f: MetaField) -> &'static str {
    match f {
        MetaField::Author => "author",
        MetaField::Isbn => "isbn",
        MetaField::PageCount => "page_count",
        MetaField::PublishedDate => "published_date",
        MetaField::Director => "director",
        MetaField::ReleaseDate => "release_date",
        MetaField::RuntimeMin => "runtime_min",
        MetaField::OriginalTitle => "original_title",
    }
}

/// Walk the schema for properties that declare a metadata mapping and
/// produce the `(key, value)` stamps for the user to commit. Only
/// mapped fields with matching hit values land here — ratings and other
/// unmapped props never appear even if the adapter delivered them.
pub fn stamp_targets(schema: &FolderSchema, hit: &MetaHit) -> Vec<(String, PropValue)> {
    let mut out: Vec<(String, PropValue)> = Vec::new();
    for (key, def) in &schema.properties {
        let Some(mapped) = def.metadata.as_deref() else { continue };
        for (field, value) in &hit.fields {
            if meta_field_name(*field) == mapped {
                out.push((key.clone(), PropValue::Str(value.clone())));
            }
        }
    }
    out
}

/// Apply a `MetaHit` to an existing `Props` map and return the merged
/// result (existing user-written values are preserved — metadata never
/// overwrites). Convenience wrapper around `stamp_targets`.
pub fn stamp_into(schema: &FolderSchema, hit: &MetaHit, base: &Props) -> Props {
    let mut next = base.clone();
    for (key, value) in stamp_targets(schema, hit) {
        // Preserve user-written values — metadata fills blanks, never
        // overwrites (the doc contract this fn has always claimed).
        next.entry(key).or_insert(value);
    }
    next
}

/// `true` when the schema declares at least one property with a
/// `metadata` mapping — used by the property panel to gate the
/// "메타데이터 채우기" affordance.
pub fn has_metadata_targets(schema: &FolderSchema) -> bool {
    schema.properties.values().any(|d| d.metadata.is_some())
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{parse_schema, BOOK_SCHEMA_TOML, IDEA_SCHEMA_TOML, MOVIE_SCHEMA_TOML};

    #[test]
    fn provider_order_resolves_every_region_table() {
        for d in [ProviderDomain::Book, ProviderDomain::Movie] {
            for r in ["", "KR", "JP", "DE", "US"] {
                assert!(!provider_order(d, r).is_empty(), "{d:?}/{r} must have a default");
            }
        }
    }

    #[test]
    fn catalog_lists_eight_providers() {
        assert_eq!(PROVIDER_CATALOG.len(), 8);
        assert!(PROVIDER_CATALOG.iter().any(|p| p.id == "open_library"));
        assert!(PROVIDER_CATALOG.iter().any(|p| p.id == "tmdb"));
        assert!(PROVIDER_CATALOG.iter().any(|p| p.id == "kmdb"));
    }

    #[test]
    fn stamp_targets_fills_only_mapped_fields() {
        let schema = parse_schema(BOOK_SCHEMA_TOML).unwrap();
        let hit = MetaHit {
            provider: "open_library".into(),
            title: "Sapiens".into(),
            url: Some("https://openlibrary.org/works/OL1".into()),
            fields: BTreeMap::from([
                (MetaField::Author, "Yuval Noah Harari".into()),
                (MetaField::Isbn, "9780062316097".into()),
                (MetaField::PageCount, "464".into()),
            ]),
            ..Default::default()
        };
        let stamps = stamp_targets(&schema, &hit);
        // author/isbn/page_count are declared with metadata mappings
        // (published_date missing from the hit drops out silently).
        assert_eq!(stamps.len(), 3);
        assert_eq!(stamps[0].0, "author");
        assert_eq!(stamps[0].1, PropValue::Str("Yuval Noah Harari".into()));
        assert!(stamps.iter().any(|(k, _)| k == "isbn"));
        assert!(stamps.iter().any(|(k, _)| k == "page_count"));
    }

    #[test]
    fn stamp_into_preserves_user_values() {
        let schema = parse_schema(BOOK_SCHEMA_TOML).unwrap();
        let mut base = Props::new();
        base.insert("rating".into(), PropValue::Str("5".into()));
        let hit = MetaHit {
            provider: "open_library".into(),
            title: "X".into(),
            fields: BTreeMap::from([(MetaField::Author, "Test".into())]),
            ..Default::default()
        };
        let next = stamp_into(&schema, &hit, &base);
        assert_eq!(next.get("rating").and_then(|v| if let PropValue::Str(s) = v { Some(s.as_str()) } else { None }), Some("5"));
        assert_eq!(next.get("author").and_then(|v| if let PropValue::Str(s) = v { Some(s.as_str()) } else { None }), Some("Test"));
    }
    #[test]
    fn movie_preset_maps_director_and_runtime() {
        // The movie preset now declares the metadata vocabulary the
        // adapters deliver — director/release_date/runtime_min/
        // original_title — so the panel surfaces 채우기 for movies too.
        let schema = parse_schema(MOVIE_SCHEMA_TOML).unwrap();
        let hit = MetaHit {
            provider: "tmdb".into(),
            title: "Inception".into(),
            fields: BTreeMap::from([
                (MetaField::Director, "Christopher Nolan".into()),
                (MetaField::RuntimeMin, "148".into()),
            ]),
            ..Default::default()
        };
        let stamps = stamp_targets(&schema, &hit);
        assert_eq!(stamps.len(), 2);
        assert!(stamps.iter().any(|(k, _)| k == "director"));
        assert!(stamps.iter().any(|(k, _)| k == "runtime_min"));
        assert!(has_metadata_targets(&schema));
    }

    #[test]
    fn stamp_into_never_overwrites_existing_values() {
        let schema = parse_schema(BOOK_SCHEMA_TOML).unwrap();
        let mut base = Props::new();
        base.insert("author".into(), PropValue::Str("내가 쓴 저자".into()));
        let hit = MetaHit {
            provider: "open_library".into(),
            title: "X".into(),
            fields: BTreeMap::from([(MetaField::Author, "External".into())]),
            ..Default::default()
        };
        let next = stamp_into(&schema, &hit, &base);
        assert_eq!(
            next.get("author"),
            Some(&PropValue::Str("내가 쓴 저자".into()))
        );
    }

    #[test]
    fn idea_preset_has_no_metadata_mappings() {
        // Ideas capture is the user's own — no auto-fill.
        let schema = parse_schema(IDEA_SCHEMA_TOML).unwrap();
        assert!(!has_metadata_targets(&schema));
    }
}
