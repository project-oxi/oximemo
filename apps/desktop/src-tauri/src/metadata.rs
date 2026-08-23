//! Metadata provider adapters (spec 2026-08-23 §3.1–§3.5). Each
//! provider has a thin `search*` function that returns `Vec<MetaHit>`.
//! HTTP plumbing is uninteresting; the field-mapping logic is the
//! part that's worth pinning down with tests — it must produce the
//! canonical `MetaField` vocabulary regardless of the provider's
//! payload shape so the core's `stamp_targets` walker can match
//! against schema declarations.
//!
//! Key gating lives in `enabled_providers` (the `MetadataConfig` decides
//! who runs and who stays hidden); the search command returns an empty
//! list when metadata is disabled.

use std::collections::BTreeMap;
use std::sync::LazyLock;
use std::time::Duration;

use serde::Deserialize;

use oximemo_core::config::MetadataConfig;
use oximemo_core::metadata::{
    MetaField, MetaHit, PROVIDER_CATALOG, ProviderDomain, ProviderInfo, provider_order,
};

/// Shared HTTP client: 8s timeout per provider call (search fans out
/// sequentially, so three slow providers must not freeze the palette),
/// a descriptive UA (Open Library rejects bare defaults), and rustls
/// (no native TLS linkage surprises on macOS).
static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent(concat!("oximemo/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("reqwest client with rustls")
});

/// GET + decode JSON into the provider DTO. Errors bubble to the
/// adapter, which converts them to "no hits from this provider" —
/// one dead provider never blanks the whole search.
async fn fetch_json<T: for<'de> Deserialize<'de>>(url: &str) -> anyhow::Result<T> {
    Ok(HTTP
        .get(url)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?)
}

/// Return the list of providers that should run for a given domain and
/// region — filtered by `[metadata] enabled` and per-provider key
/// presence. Keyless providers (Open Library, DNB, conditional NDL)
/// always qualify; keyed ones only when their key is set.
pub fn enabled_providers(
    cfg: &MetadataConfig,
    domain: ProviderDomain,
) -> Vec<&'static ProviderInfo> {
    if !cfg.enabled {
        return Vec::new();
    }
    let order = provider_order(domain, &cfg.region);
    let mut out: Vec<&'static ProviderInfo> = PROVIDER_CATALOG
        .iter()
        .filter(|p| p.domain == domain && provider_key(cfg, p.id).is_some())
        .collect();
    // Region priority: stable sort by the index each id has in `order`.
    out.sort_by_key(|p| {
        order
            .iter()
            .position(|id| *id == p.id)
            .unwrap_or(usize::MAX)
    });
    out
}

fn provider_key<'a>(cfg: &'a MetadataConfig, id: &str) -> Option<&'a str> {
    match id {
        "google_books" => nonempty(&cfg.google_books_key),
        "aladin" => nonempty(&cfg.aladin_key),
        "tmdb" => nonempty(&cfg.tmdb_key),
        "omdb" => nonempty(&cfg.omdb_key),
        "kmdb" => nonempty(&cfg.kmdb_key),
        // keyless + conditional: always present; the badge in the UI
        // distinguishes them by access class.
        "open_library" | "dnb_sru" | "ndl_search" => Some(""),
        _ => None,
    }
}

fn nonempty(s: &str) -> Option<&str> {
    if s.is_empty() { None } else { Some(s) }
}

/// Public search entry: takes a query + the config, fans out to the
/// domain's providers, and merges hits. Per-provider HTTP calls run
/// sequentially (reqwest async inside tokio::spawn is the
/// production-quality path; the fallback browser uses no network).
pub async fn search_books(cfg: &MetadataConfig, query: &str) -> Vec<MetaHit> {
    if query.trim().is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for p in enabled_providers(cfg, ProviderDomain::Book) {
        match p.id {
            "open_library" => out.extend(open_library_search(query).await),
            "google_books" => {
                if let Some(key) = provider_key(cfg, "google_books") {
                    out.extend(google_books_search(query, key).await);
                }
            }
            "aladin" => {
                if let Some(key) = provider_key(cfg, "aladin") {
                    out.extend(aladin_search(query, key).await);
                }
            }
            "ndl_search" => out.extend(ndl_search(query).await),
            "dnb_sru" => out.extend(dnb_search(query).await),
            _ => {}
        }
    }
    out
}

pub async fn search_movies(cfg: &MetadataConfig, query: &str) -> Vec<MetaHit> {
    if query.trim().is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for p in enabled_providers(cfg, ProviderDomain::Movie) {
        match p.id {
            "tmdb" => {
                if let Some(key) = provider_key(cfg, "tmdb") {
                    out.extend(tmdb_search(query, key).await);
                }
            }
            "omdb" => {
                if let Some(key) = provider_key(cfg, "omdb") {
                    out.extend(omdb_search(query, key).await);
                }
            }
            "kmdb" => {
                if let Some(key) = provider_key(cfg, "kmdb") {
                    out.extend(kmdb_search(query, key).await);
                }
            }
            _ => {}
        }
    }
    out
}

// ---- Per-provider adapters (HTTP plumbing) --------------------------------
//
// All adapters share the same shape: build a request URL with the
// provider's expected parameters, fetch JSON (or XML for DNB), then
// normalize into `MetaHit` via a small fixture-mapping helper. The
// adapter bodies are intentionally short — the tests cover the
// normalization (the only piece that affects correctness) with canned
// payloads so network changes don't change the contract.

pub async fn open_library_search(query: &str) -> Vec<MetaHit> {
    let url = format!(
        "https://openlibrary.org/search.json?q={}&limit=10",
        urlencoded(query)
    );
    fetch_open_library(&url).await.unwrap_or_default()
}

pub async fn google_books_search(query: &str, key: &str) -> Vec<MetaHit> {
    let url = format!(
        "https://www.googleapis.com/books/v1/volumes?q={}&key={}&maxResults=10",
        urlencoded(query),
        urlencoded(key),
    );
    fetch_google_books(&url).await.unwrap_or_default()
}

pub async fn aladin_search(query: &str, ttbkey: &str) -> Vec<MetaHit> {
    let url = format!(
        "https://www.aladin.co.kr/ttb/api/ItemSearch.aspx?ttbkey={}&Query={}&QueryType=Title&MaxResults=10&start=1&SearchTarget=Book&output=js&Version=20131101",
        urlencoded(ttbkey),
        urlencoded(query),
    );
    fetch_aladin(&url).await.unwrap_or_default()
}

pub async fn ndl_search(query: &str) -> Vec<MetaHit> {
    let url = format!(
        "https://ndlsearch.ndl.go.jp/api/open_search?query={}&format=json",
        urlencoded(query),
    );
    fetch_ndl(&url).await.unwrap_or_default()
}

pub async fn dnb_search(query: &str) -> Vec<MetaHit> {
    let url = format!(
        "https://services.dnb.de/sru/dnb?version=1.1&operation=searchRetrieve&query={}&maximumRecords=10",
        urlencoded(query),
    );
    fetch_dnb(&url).await.unwrap_or_default()
}

pub async fn tmdb_search(query: &str, api_key: &str) -> Vec<MetaHit> {
    let url = format!(
        "https://api.themoviedb.org/3/search/movie?api_key={}&query={}&language=ko",
        urlencoded(api_key),
        urlencoded(query),
    );
    fetch_tmdb(&url).await.unwrap_or_default()
}

pub async fn omdb_search(query: &str, api_key: &str) -> Vec<MetaHit> {
    let url = format!(
        "https://www.omdbapi.com/?apikey={}&s={}",
        urlencoded(api_key),
        urlencoded(query),
    );
    fetch_omdb(&url).await.unwrap_or_default()
}

pub async fn kmdb_search(query: &str, service_key: &str) -> Vec<MetaHit> {
    let url = format!(
        "http://api.koreafilm.or.kr/openapi-data2/wisenut/search_api/search_json.jsp?collection=kmdb_new&detailSearch=Y&query={}&ServiceKey={}",
        urlencoded(query),
        urlencoded(service_key),
    );
    fetch_kmdb(&url).await.unwrap_or_default()
}

fn urlencoded(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// ---- Normalization (public for testing) -----------------------------------

pub fn map_ol_hits(payload: &OlPayload) -> Vec<MetaHit> {
    payload
        .docs
        .iter()
        .map(|d| MetaHit {
            provider: "open_library".into(),
            title: d.title.clone().unwrap_or_default(),
            subtitle: d.first_publish_year.map(|y| y.to_string()),
            url: d
                .key
                .as_ref()
                .map(|k| format!("https://openlibrary.org{k}")),
            cover_url: d
                .cover_i
                .map(|c| format!("https://covers.openlibrary.org/b/id/{c}-M.jpg")),
            fields: ol_fields(d),
        })
        .collect()
}
async fn fetch_open_library(url: &str) -> anyhow::Result<Vec<MetaHit>> {
    Ok(map_ol_hits(&fetch_json::<OlPayload>(url).await?))
}
async fn fetch_google_books(url: &str) -> anyhow::Result<Vec<MetaHit>> {
    Ok(map_google_books(&fetch_json::<GbPayload>(url).await?))
}
async fn fetch_aladin(url: &str) -> anyhow::Result<Vec<MetaHit>> {
    Ok(map_aladin(&fetch_json::<AladinPayload>(url).await?))
}
// NDL Search and DNB SRU answer in XML (OpenSearch / SRW). No XML
// dependency yet — they stay silent until a quick-xml follow-up maps
// them; keyless badge in settings keeps expectations honest.
async fn fetch_ndl(_url: &str) -> anyhow::Result<Vec<MetaHit>> {
    Ok(Vec::new())
}
async fn fetch_dnb(_url: &str) -> anyhow::Result<Vec<MetaHit>> {
    Ok(Vec::new())
}
async fn fetch_tmdb(url: &str) -> anyhow::Result<Vec<MetaHit>> {
    Ok(map_tmdb(&fetch_json::<TmdbPayload>(url).await?))
}
async fn fetch_omdb(url: &str) -> anyhow::Result<Vec<MetaHit>> {
    Ok(map_omdb(&fetch_json::<OmdbPayload>(url).await?))
}
// KMDB wraps results in a nested Data[0].Result envelope and requires
// an approved developer account — adapter lands with the approval.
async fn fetch_kmdb(_url: &str) -> anyhow::Result<Vec<MetaHit>> {
    Ok(Vec::new())
}

fn ol_fields(d: &OlDoc) -> BTreeMap<MetaField, String> {
    let mut m = BTreeMap::new();
    if let Some(a) = d.author_name.as_ref().and_then(|a| a.first().cloned()) {
        m.insert(MetaField::Author, a);
    }
    if let Some(i) = d.isbn.as_ref().and_then(|i| i.first().cloned()) {
        m.insert(MetaField::Isbn, i);
    }
    if let Some(p) = d.number_of_pages_median {
        m.insert(MetaField::PageCount, p.to_string());
    }
    if let Some(y) = d.first_publish_year {
        m.insert(MetaField::PublishedDate, format!("{y}-01-01"));
    }
    m
}

pub fn map_google_books(payload: &GbPayload) -> Vec<MetaHit> {
    payload
        .items
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .map(|it| {
            let vi = &it.volume_info;
            MetaHit {
                provider: "google_books".into(),
                title: vi.title.clone().unwrap_or_default(),
                subtitle: vi.published_date.clone(),
                url: vi.info_link.clone(),
                cover_url: vi
                    .image_links
                    .as_ref()
                    .and_then(|l| l.thumbnail.clone())
                    .map(|t| t.replace("http://", "https://")),
                fields: gb_fields(vi),
            }
        })
        .collect()
}

fn gb_fields(vi: &GbVolumeInfo) -> BTreeMap<MetaField, String> {
    let mut m = BTreeMap::new();
    if let Some(a) = vi.authors.as_ref().and_then(|a| a.first().cloned()) {
        m.insert(MetaField::Author, a);
    }
    if let Some(d) = vi.published_date.clone() {
        m.insert(MetaField::PublishedDate, d);
    }
    if let Some(p) = vi.page_count {
        m.insert(MetaField::PageCount, p.to_string());
    }
    if let Some(i) = vi.isbn_13.clone().or(vi.isbn_10.clone()) {
        m.insert(MetaField::Isbn, i);
    }
    if let Some(t) = vi.original_title.clone() {
        m.insert(MetaField::OriginalTitle, t);
    }
    m
}

pub fn map_aladin(payload: &AladinPayload) -> Vec<MetaHit> {
    payload
        .item
        .iter()
        .map(|it| MetaHit {
            provider: "aladin".into(),
            title: it.title.clone().unwrap_or_default(),
            subtitle: it.pub_date.clone(),
            url: it.link.clone(),
            cover_url: it.cover.clone(),
            fields: {
                let mut m = BTreeMap::new();
                if let Some(a) = it.author.clone() {
                    m.insert(MetaField::Author, a);
                }
                if let Some(i) = it.isbn13.clone().or(it.isbn.clone()) {
                    m.insert(MetaField::Isbn, i);
                }
                if let Some(d) = it.pub_date.clone() {
                    m.insert(MetaField::PublishedDate, d);
                }
                m
            },
        })
        .collect()
}

pub fn map_tmdb(payload: &TmdbPayload) -> Vec<MetaHit> {
    payload
        .results
        .iter()
        .map(|r| MetaHit {
            provider: "tmdb".into(),
            title: r.title.clone().unwrap_or_default(),
            subtitle: r.release_date.clone(),
            url: None,
            cover_url: r
                .poster_path
                .as_ref()
                .map(|p| format!("https://image.tmdb.org/t/p/w342{p}")),
            fields: {
                let mut m = BTreeMap::new();
                if let Some(d) = r.release_date.clone() {
                    m.insert(MetaField::ReleaseDate, d);
                }
                if let Some(t) = r.original_title.clone() {
                    m.insert(MetaField::OriginalTitle, t);
                }
                m
            },
        })
        .collect()
}

pub fn map_omdb(payload: &OmdbPayload) -> Vec<MetaHit> {
    payload
        .search
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .map(|s| MetaHit {
            provider: "omdb".into(),
            title: s.title.clone().unwrap_or_default(),
            subtitle: s.year.clone(),
            url: s
                .imdb_id
                .as_ref()
                .map(|i| format!("https://www.imdb.com/title/{i}/")),
            cover_url: s.poster.clone().filter(|p| p != "N/A"),
            fields: {
                let mut m = BTreeMap::new();
                if let Some(y) = s.year.clone() {
                    m.insert(MetaField::ReleaseDate, format!("{y}-01-01"));
                }
                if let Some(t) = s.title.clone() {
                    m.insert(MetaField::OriginalTitle, t);
                }
                m
            },
        })
        .collect()
}

// ---- Cached DTO shapes (deserialized from each provider's JSON/XML) -------

#[derive(Debug, Deserialize)]
pub struct OlPayload {
    #[serde(default)]
    pub docs: Vec<OlDoc>,
}
#[derive(Debug, Default, Deserialize)]
pub struct OlDoc {
    pub title: Option<String>,
    pub author_name: Option<Vec<String>>,
    pub first_publish_year: Option<i32>,
    pub isbn: Option<Vec<String>>,
    pub number_of_pages_median: Option<i32>,
    pub key: Option<String>,
    #[serde(default)]
    pub cover_i: Option<i64>,
}
#[derive(Debug, Deserialize)]
pub struct GbPayload {
    pub items: Option<Vec<GbItem>>,
}
#[derive(Debug, Default, Deserialize)]
pub struct GbItem {
    pub volume_info: GbVolumeInfo,
}
#[derive(Debug, Default, Deserialize)]
pub struct GbVolumeInfo {
    pub title: Option<String>,
    pub authors: Option<Vec<String>>,
    pub published_date: Option<String>,
    pub page_count: Option<i32>,
    pub isbn_10: Option<String>,
    pub isbn_13: Option<String>,
    pub info_link: Option<String>,
    pub original_title: Option<String>,
    #[serde(default)]
    pub image_links: Option<GbImageLinks>,
}
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GbImageLinks {
    pub thumbnail: Option<String>,
}
#[derive(Debug, Deserialize)]
pub struct AladinPayload {
    #[serde(default)]
    pub item: Vec<AladinItem>,
}
#[derive(Debug, Default, Deserialize)]
pub struct AladinItem {
    pub title: Option<String>,
    pub author: Option<String>,
    pub isbn: Option<String>,
    pub isbn13: Option<String>,
    pub pub_date: Option<String>,
    pub link: Option<String>,
    #[serde(default)]
    pub cover: Option<String>,
}
#[derive(Debug, Deserialize)]
pub struct TmdbPayload {
    #[serde(default)]
    pub results: Vec<TmdbResult>,
}
#[derive(Debug, Default, Deserialize)]
pub struct TmdbResult {
    pub title: Option<String>,
    pub original_title: Option<String>,
    pub release_date: Option<String>,
    #[serde(default)]
    pub poster_path: Option<String>,
}
#[derive(Debug, Deserialize)]
pub struct OmdbPayload {
    pub search: Option<Vec<OmdbItem>>,
}
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct OmdbItem {
    pub title: Option<String>,
    pub year: Option<String>,
    pub imdb_id: Option<String>,
    #[serde(default)]
    pub poster: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_library_normalizes_to_canonical_fields() {
        let json = r#"{
            "docs": [
                {
                    "title": "Sapiens",
                    "author_name": ["Yuval Noah Harari"],
                    "first_publish_year": 2011,
                    "isbn": ["9780062316097"],
                    "number_of_pages_median": 464,
                    "key": "/works/OL1"
                }
            ]
        }"#;
        let p: OlPayload = serde_json::from_str(json).unwrap();
        let hits = map_ol_hits(&p);
        assert_eq!(hits.len(), 1);
        let h = &hits[0];
        assert_eq!(h.provider, "open_library");
        assert_eq!(
            h.fields.get(&MetaField::Author).map(String::as_str),
            Some("Yuval Noah Harari")
        );
        assert_eq!(
            h.fields.get(&MetaField::Isbn).map(String::as_str),
            Some("9780062316097")
        );
        assert_eq!(
            h.fields.get(&MetaField::PageCount).map(String::as_str),
            Some("464")
        );
        assert_eq!(
            h.fields.get(&MetaField::PublishedDate).map(String::as_str),
            Some("2011-01-01")
        );
    }

    #[test]
    fn google_books_picks_isbn13_over_isbn10() {
        let json = r#"{"items":[{"volume_info":{"title":"X","authors":["A"],"isbn_10":"0","isbn_13":"978X","page_count":100,"published_date":"2020"}}]}"#;
        let p: GbPayload = serde_json::from_str(json).unwrap();
        let hits = map_google_books(&p);
        assert_eq!(
            hits[0].fields.get(&MetaField::Isbn).map(String::as_str),
            Some("978X")
        );
    }

    #[test]
    fn aladin_uses_isbn13_when_present() {
        let json = r#"{"item":[{"title":"책","author":"지은이","isbn":"89","isbn13":"97889","pub_date":"2024-01-01","link":"https://aladin"}]}"#;
        let p: AladinPayload = serde_json::from_str(json).unwrap();
        let hits = map_aladin(&p);
        assert_eq!(
            hits[0].fields.get(&MetaField::Isbn).map(String::as_str),
            Some("97889")
        );
    }

    #[test]
    fn tmdb_stamps_release_date() {
        let json = r#"{"results":[{"title":"Inception","original_title":"Inception","release_date":"2010-07-15"}]}"#;
        let p: TmdbPayload = serde_json::from_str(json).unwrap();
        let hits = map_tmdb(&p);
        assert_eq!(
            hits[0]
                .fields
                .get(&MetaField::ReleaseDate)
                .map(String::as_str),
            Some("2010-07-15")
        );
    }

    #[test]
    fn omdb_expands_year_to_release_date() {
        let json = r#"{"search":[{"Title":"Arrival","Year":"2016","imdbID":"tt2543164"}]}"#;
        let p: OmdbPayload = serde_json::from_str(json).unwrap();
        let hits = map_omdb(&p);
        assert_eq!(
            hits[0]
                .fields
                .get(&MetaField::ReleaseDate)
                .map(String::as_str),
            Some("2016-01-01")
        );
    }

    #[test]
    fn provider_order_is_respected_when_keys_present() {
        let mut cfg = MetadataConfig::default();
        cfg.region = "KR".into();
        cfg.google_books_key = "g".into();
        cfg.aladin_key = "a".into();
        let providers = enabled_providers(&cfg, ProviderDomain::Book);
        let ids: Vec<&str> = providers.iter().map(|p| p.id).collect();
        assert_eq!(ids.first(), Some(&"aladin"));
    }

    #[test]
    fn keyed_provider_without_key_is_hidden() {
        let cfg = MetadataConfig::default();
        let providers = enabled_providers(&cfg, ProviderDomain::Movie);
        assert!(
            providers.is_empty(),
            "keyed providers with empty keys must not surface"
        );
    }
}
