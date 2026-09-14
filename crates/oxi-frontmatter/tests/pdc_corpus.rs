//! Stage 0 gate: the vendored PDC conformance corpus must pass.
//!
//! The corpus under `tests/fixtures/pdc-corpus-r3/` is a verbatim copy
//! of conformance revision 3 from the `portable-document-contract`
//! repository. It must stay byte-identical to the upstream tree; when
//! upstream bumps the revision, re-vendor and bump
//! [`oxi_frontmatter::pdc::CORPUS_REVISION`] in one commit.

use oxi_frontmatter::pdc::{self, CORPUS_REVISION, Classification, DiagnosticKind, DocumentExt};

const CORPUS_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/pdc-corpus-r3");

fn read(rel: &str) -> Vec<u8> {
    std::fs::read(format!("{CORPUS_DIR}/{rel}")).expect("corpus fixture present")
}

fn read_text(rel: &str) -> String {
    String::from_utf8(read(rel)).expect("corpus fixture is UTF-8")
}

fn ext_of(path: &str) -> DocumentExt {
    if path.ends_with(".html") {
        DocumentExt::Html
    } else {
        DocumentExt::Djot
    }
}

/// Assert a classification against a corpus `expect` value.
fn assert_expect(id: &str, expect: &str, got: &Classification) {
    match expect {
        "valid" => assert!(
            matches!(got, Classification::Valid(_)),
            "{id}: expected valid, got {got:?}"
        ),
        "legacy_html" => assert!(
            matches!(got, Classification::LegacyHtml),
            "{id}: expected legacy_html, got {got:?}"
        ),
        diagnostic => assert_eq!(
            got.invalid_kind().map(DiagnosticKind::as_str),
            Some(diagnostic),
            "{id}: expected {diagnostic}, got {got:?}"
        ),
    }
}

#[test]
fn corpus_revision_is_pinned() {
    let corpus: serde_json::Value =
        serde_json::from_str(&read_text("corpus.json")).expect("corpus.json parses");
    assert_eq!(corpus["format"], "pdc-document-conformance/1");
    assert_eq!(corpus["revision"], CORPUS_REVISION);
}

#[test]
fn all_corpus_cases_pass() {
    let corpus: serde_json::Value =
        serde_json::from_str(&read_text("corpus.json")).expect("corpus.json parses");
    let cases = corpus["cases"].as_array().expect("cases array");
    assert!(!cases.is_empty(), "corpus must not be empty");

    for case in cases {
        let id = case["id"].as_str().expect("case id");
        match case["kind"].as_str().expect("case kind") {
            "file" => {
                let path = case["path"].as_str().expect("path");
                let bytes = read(path);
                let got = pdc::classify(ext_of(path), &bytes);
                assert_expect(id, case["expect"].as_str().expect("expect"), &got);
            }
            "set" => {
                let paths = case["paths"].as_array().expect("paths");
                let ids: Vec<String> = paths
                    .iter()
                    .filter_map(|p| p.as_str())
                    .map(|path| (path, pdc::classify(ext_of(path), &read(path))))
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
            "operation" => run_operation(id, case),
            other => panic!("{id}: unknown corpus case kind `{other}`"),
        }
    }
}

/// Execute one `operation` corpus case.
fn run_operation(id: &str, case: &serde_json::Value) {
    let op = case["operation"].as_str().expect("operation");
    let input = case["input"].as_str().expect("input");
    let bytes = read(input);
    let ext = ext_of(input);
    match op {
        "prefix-source-bytes" => {
            let hex = case["prefixHex"].as_str().expect("prefixHex");
            let prefix = decode_hex(hex);
            let mut mutated = prefix;
            mutated.extend_from_slice(&bytes);
            let got = pdc::classify(ext, &mutated);
            assert_expect(id, case["expect"].as_str().unwrap(), &got);
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
            let expected = read(case["expected"].as_str().expect("expected"));
            assert_eq!(
                out, expected,
                "{id}: patched bytes must equal the expected fixture"
            );
        }
        "external-change-before-save" => {
            assert_eq!(case["expect"].as_str(), Some("external_change_conflict"));
            let external = read(case["external"].as_str().expect("external"));
            let err = pdc::save_guarded(&bytes, &external, Vec::new())
                .expect_err("guarded save must refuse");
            assert_eq!(err.kind, DiagnosticKind::ExternalChangeConflict, "{id}");
        }
        other => panic!("{id}: unknown operation `{other}`"),
    }
}

fn decode_hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex byte"))
        .collect()
}
