//! Stage 0 gate: the vendored PDC conformance corpora must pass.
//!
//! Two corpora are vendored verbatim from the
//! `portable-document-contract` repository and must stay byte-identical
//! to the upstream tree:
//!
//! - `tests/fixtures/pdc-corpus-r3` — the frozen legacy v1 corpus
//!   (`pdc-document-conformance/1`, revision 3);
//! - `tests/fixtures/pdc-corpus-v2-r2` — the Markdown-first corpus
//!   (`pdc-document-conformance/2`, revision 2, upstream commit
//!   `0ee51ea`, tag `v2.0.0-draft.2`), which also carries v1
//!   readability cases and `pdc-query/1` classification cases.
//!
//! When upstream bumps a revision, re-vendor and bump the matching
//! [`oxi_frontmatter::pdc`] pin in one commit.

use oxi_frontmatter::pdc::{
    self, CORPUS_REVISION, CORPUS_V2_FORMAT, CORPUS_V2_REVISION, Classification, DiagnosticKind,
    DocumentExt, QueryClassification, classify_query,
};
use serde_json::Value as Json;

const CORPUS_V1_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/pdc-corpus-r3");
const CORPUS_V2_DIR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/pdc-corpus-v2-r2"
);

fn read_in(dir: &str, rel: &str) -> Vec<u8> {
    std::fs::read(format!("{dir}/{rel}")).expect("corpus fixture present")
}

fn read_text_in(dir: &str, rel: &str) -> String {
    String::from_utf8(read_in(dir, rel)).expect("corpus fixture is UTF-8")
}

fn decode_hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex byte"))
        .collect()
}

/// v1 corpus extension mapping: Djot and HTML transports only.
fn ext_v1(path: &str) -> DocumentExt {
    if path.ends_with(".html") {
        DocumentExt::Html
    } else {
        DocumentExt::Djot
    }
}

/// v2 corpus extension mapping: lowercase `.md`, `.html`, `.djot`;
/// `.base` files are query-plane cases handled by the caller.
fn ext_v2(path: &str) -> DocumentExt {
    match path.rsplit('.').next() {
        Some("html") => DocumentExt::Html,
        Some("md") => DocumentExt::Markdown,
        _ => DocumentExt::Djot,
    }
}

#[test]
fn corpus_revision_is_pinned() {
    let corpus: Json = serde_json::from_str(&read_text_in(CORPUS_V1_DIR, "corpus.json")).unwrap();
    assert_eq!(corpus["format"], "pdc-document-conformance/1");
    assert_eq!(corpus["revision"], CORPUS_REVISION);
}

#[test]
fn v2_corpus_revision_is_pinned() {
    let corpus: Json = serde_json::from_str(&read_text_in(CORPUS_V2_DIR, "corpus.json")).unwrap();
    assert_eq!(corpus["format"], CORPUS_V2_FORMAT);
    assert_eq!(corpus["revision"], CORPUS_V2_REVISION);
    assert_eq!(corpus["queryContract"], "pdc-query/1");
}

#[test]
fn all_v1_corpus_cases_pass() {
    run_corpus(
        CORPUS_V1_DIR,
        "pdc-document-conformance/1",
        CORPUS_REVISION,
        ext_v1,
        true,
    );
}

#[test]
fn all_v2_corpus_cases_pass() {
    run_corpus(
        CORPUS_V2_DIR,
        CORPUS_V2_FORMAT,
        CORPUS_V2_REVISION,
        ext_v2,
        false,
    );
}

fn run_corpus(
    dir: &str,
    format: &str,
    revision: u64,
    ext_of: fn(&str) -> DocumentExt,
    // The v1 corpus predates the legacy flag: its `valid` expectation
    // covers legacy-readable documents too.
    valid_allows_legacy: bool,
) {
    let corpus: Json =
        serde_json::from_str(&read_text_in(dir, "corpus.json")).expect("corpus.json parses");
    assert_eq!(corpus["format"], format);
    assert_eq!(corpus["revision"], revision);
    let cases = corpus["cases"].as_array().expect("cases array");
    assert!(!cases.is_empty(), "corpus must not be empty");

    for case in cases {
        let id = case["id"].as_str().expect("case id");
        match case["kind"].as_str().expect("case kind") {
            "file" => {
                let path = case["path"].as_str().expect("path");
                let bytes = read_in(dir, path);
                let got = if path.ends_with(".base") {
                    // Query-plane case: expectations are query classes.
                    match (classify_query(&bytes), case["expect"].as_str().unwrap()) {
                        (QueryClassification::Valid, "valid") => continue,
                        (QueryClassification::ValidUnexecuted, "valid_unexecuted") => continue,
                        (QueryClassification::Invalid(d), "invalid_query") => {
                            assert_eq!(d.kind, DiagnosticKind::InvalidQuery, "{id}");
                            continue;
                        }
                        (got, expect) => panic!("{id}: expected {expect}, got {got:?}"),
                    }
                } else {
                    pdc::classify(ext_of(path), &bytes)
                };
                assert_expect(
                    id,
                    case["expect"].as_str().expect("expect"),
                    &got,
                    valid_allows_legacy,
                );
            }
            "set" => {
                let paths = case["paths"].as_array().expect("paths");
                let ids: Vec<String> = paths
                    .iter()
                    .filter_map(|p| p.as_str())
                    .map(|path| (path, pdc::classify(ext_of(path), &read_in(dir, path))))
                    .map(|(path, got)| match got {
                        Classification::Valid(doc) => doc.id,
                        other => panic!("{id}: {path} in a set case must be valid: {other:?}"),
                    })
                    .collect();
                let unique: std::collections::HashSet<&String> = ids.iter().collect();
                assert_ne!(
                    ids.len(),
                    unique.len(),
                    "{id}: set must contain duplicate document IDs"
                );
                assert_eq!(case["expect"].as_str(), Some("duplicate_document_id"));
            }
            "operation" => run_operation(id, case, dir, ext_of, valid_allows_legacy),
            other => panic!("{id}: unknown corpus case kind `{other}`"),
        }
    }
}

/// Assert a classification against a corpus `expect` value.
fn assert_expect(id: &str, expect: &str, got: &Classification, valid_allows_legacy: bool) {
    match expect {
        "valid" => assert!(
            matches!(got, Classification::Valid(doc) if valid_allows_legacy || !doc.legacy),
            "{id}: expected valid, got {got:?}"
        ),
        "legacy_valid" => assert!(
            matches!(got, Classification::Valid(doc) if doc.legacy),
            "{id}: expected legacy_valid, got {got:?}"
        ),
        "legacy_html" => assert!(
            matches!(got, Classification::LegacyHtml),
            "{id}: expected legacy_html, got {got:?}"
        ),
        "legacy_markdown" => assert!(
            matches!(got, Classification::LegacyMarkdown),
            "{id}: expected legacy_markdown, got {got:?}"
        ),
        diagnostic => assert_eq!(
            got.invalid_kind().map(DiagnosticKind::as_str),
            Some(diagnostic),
            "{id}: expected {diagnostic}, got {got:?}"
        ),
    }
}

/// Execute one `operation` corpus case.
fn run_operation(
    id: &str,
    case: &Json,
    dir: &str,
    ext_of: fn(&str) -> DocumentExt,
    valid_allows_legacy: bool,
) {
    let op = case["operation"].as_str().expect("operation");
    let input = case["input"].as_str().expect("input");
    let bytes = read_in(dir, input);
    let ext = ext_of(input);
    match op {
        "prefix-source-bytes" => {
            let hex = case["prefixHex"].as_str().expect("prefixHex");
            let prefix = decode_hex(hex);
            let mut mutated = prefix;
            mutated.extend_from_slice(&bytes);
            let got = pdc::classify(ext, &mutated);
            assert_expect(
                id,
                case["expect"].as_str().unwrap(),
                &got,
                valid_allows_legacy,
            );
        }
        "pad-body-to-total-bytes" => {
            let total = case["totalBytes"].as_u64().expect("totalBytes") as usize;
            assert_eq!(case["expect"].as_str(), Some("document_too_large"));
            let mut padded = bytes.clone();
            while padded.len() < total {
                padded.push(b'\n');
            }
            assert!(padded.len() > pdc::MAX_DOCUMENT_BYTES);
            let got = pdc::classify(ext, &padded);
            assert_eq!(
                got.invalid_kind(),
                Some(DiagnosticKind::DocumentTooLarge),
                "{id}"
            );
        }
        "replace-envelope-with-yaml-mapping-depth" => {
            let depth = case["depth"].as_u64().expect("depth") as usize;
            assert_eq!(case["expect"].as_str(), Some("document_too_complex"));
            let over = yaml_mapping_envelope(depth);
            let got = pdc::classify(ext, &over);
            assert_eq!(
                got.invalid_kind(),
                Some(DiagnosticKind::DocumentTooComplex),
                "{id}: depth {depth} must exceed the YAML nesting cap"
            );
            // The same envelope at the cap is not rejected for complexity.
            let legal = yaml_mapping_envelope(depth - 1);
            assert_ne!(
                pdc::classify(ext, &legal).invalid_kind(),
                Some(DiagnosticKind::DocumentTooComplex),
                "{id}: depth {} must stay within the cap",
                depth - 1
            );
        }
        "replace-body-with-nested-block-quotes" => {
            let depth = case["containerDepth"].as_u64().expect("containerDepth") as usize;
            assert_eq!(case["expect"].as_str(), Some("document_too_complex"));
            let Classification::Valid(doc) = pdc::classify(ext, &bytes) else {
                panic!("{id}: operation input must classify valid");
            };
            let mut mutated = bytes[..doc.body_range.start].to_vec();
            mutated.extend_from_slice(format!("{}deep\n", "> ".repeat(depth)).as_bytes());
            let got = pdc::classify(ext, &mutated);
            assert_eq!(
                got.invalid_kind(),
                Some(DiagnosticKind::DocumentTooComplex),
                "{id}"
            );
            // The same envelope at the legal depth stays valid.
            let mut legal = bytes[..doc.body_range.start].to_vec();
            legal.extend_from_slice(format!("{}deep\n", "> ".repeat(depth - 1)).as_bytes());
            assert!(
                matches!(pdc::classify(ext, &legal), Classification::Valid(_)),
                "{id}: depth {depth}-1 must stay legal"
            );
        }
        "no-op-round-trip" => {
            assert_eq!(case["expect"].as_str(), Some("byte-identical"));
            assert!(
                matches!(pdc::classify(ext, &bytes), Classification::Valid(_)),
                "{id}: no-op input must classify valid"
            );
            let out = pdc::patch_metadata(ext, &bytes, &[]).expect("no-op patch succeeds");
            assert_eq!(out, bytes, "{id}: a no-op must be byte-identical");
        }
        "metadata-patch" => {
            assert_eq!(case["expect"].as_str(), Some("byte-identical"));
            let patch_json = case["patch"].as_object().expect("patch object");
            let patch: Vec<(&str, &str)> = patch_json
                .iter()
                .map(|(k, v)| (k.as_str(), v.as_str().expect("string patch value")))
                .collect();
            let out = pdc::patch_metadata(ext, &bytes, &patch)
                .unwrap_or_else(|e| panic!("{id}: metadata patch failed: {e}"));
            let expected = read_in(dir, case["expected"].as_str().expect("expected"));
            assert_eq!(
                out, expected,
                "{id}: patched bytes must equal the expected fixture"
            );
        }
        "external-change-before-save" => {
            assert_eq!(case["expect"].as_str(), Some("external_change_conflict"));
            let external = read_in(dir, case["external"].as_str().expect("external"));
            let err = pdc::save_guarded(&bytes, &external, Vec::new())
                .expect_err("guarded save must refuse");
            assert_eq!(err.kind, DiagnosticKind::ExternalChangeConflict, "{id}");
        }
        other => panic!("{id}: unknown operation `{other}`"),
    }
}

/// Build a Markdown transport document whose envelope is a single YAML
/// mapping chain of exactly `depth` combined levels (root included).
fn yaml_mapping_envelope(depth: usize) -> Vec<u8> {
    let mut text = String::from("---\na:\n");
    for level in 1..=(depth.saturating_sub(2)) {
        text.push_str(&" ".repeat(2 * level));
        text.push_str("b:\n");
    }
    text.push_str(&" ".repeat(2 * (depth - 1)));
    text.push_str("leaf: 1\n---\n\nbody\n");
    text.into_bytes()
}
