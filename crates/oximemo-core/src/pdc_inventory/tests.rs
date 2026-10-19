//! Focused deterministic tests for the Stage 1 read-only inventory.

use std::fs;

use super::*;
use crate::paths::Paths;

const ID_A: &str = "018f47c6-4a77-7c52-9db8-0e5f9bcb17db";
const ID_B: &str = "3c2f1a9e-1111-7222-8333-444455556666";

fn temp_vault(name: &str) -> (Paths, tempfile::TempDir) {
    let temp = tempfile::Builder::new()
        .prefix(&format!("oximemo-pdc-inv-{name}-"))
        .tempdir()
        .expect("create temp vault");
    let root = temp.path().to_path_buf();
    (
        Paths {
            vault: root.clone(),
            index_dir: root.join("index-unused"),
        },
        temp,
    )
}

fn write_vault(paths: &Paths, rel: &str, content: &str) {
    write_vault_bytes(paths, rel, content.as_bytes());
}

fn write_vault_bytes(paths: &Paths, rel: &str, content: &[u8]) {
    let full = paths.vault.join(rel);
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).expect("create dir");
    }
    fs::write(&full, content).expect("write file");
}

fn canonical_md(id: &str, title: &str, body: &str) -> String {
    format!(
        "---\nformat: pdc-document/2\nbody: pdc-markdown/1\nid: {id}\n\
         created: 2026-09-14T12:34:56.789Z\nupdated: 2026-09-14T12:34:56.789Z\n\
         title: {title}\n---\n{body}"
    )
}

#[test]
fn wiki_display_titles_resolve_without_rewriting_and_ambiguity_stays_visible() {
    let (paths, _temp) = temp_vault("wiki-display-titles");
    let target = canonical_md(ID_B, "''", "# Display title\n\nTarget body\n");
    write_vault(&paths, "different-filename.md", &target);
    write_vault(
        &paths,
        "source.md",
        &canonical_md(ID_A, "Source", "[[Display title]]\n"),
    );
    assert!(
        entry(&scan(&paths).unwrap(), "source.md")
            .broken_document_links
            .is_empty()
    );
    assert_eq!(
        fs::read_to_string(paths.vault.join("different-filename.md")).unwrap(),
        target
    );
    write_vault(
        &paths,
        "duplicate.md",
        &canonical_md(
            "99999999-9999-7999-8999-999999999999",
            "Display title",
            "Other\n",
        ),
    );
    assert_eq!(
        entry(&scan(&paths).unwrap(), "source.md").broken_document_links,
        ["[[Display title]]"]
    );
}

fn entry<'a>(inv: &'a PdcInventory, path: &str) -> &'a PdcInventoryEntry {
    inv.items
        .iter()
        .find(|e| e.path == path)
        .unwrap_or_else(|| panic!("no entry for {path}"))
}

#[test]
fn classifies_canonical_legacy_invalid_and_unsupported() {
    let (paths, _guard) = temp_vault("classes");
    write_vault(
        &paths,
        "canon.md",
        &canonical_md(ID_A, "Canon", "body text\n"),
    );
    write_vault(&paths, "plain.md", "# just markdown\n");
    write_vault(&paths, "plain.html", "<p>not pdc</p>\n");
    write_vault(
        &paths,
        "legacy.djot",
        "---\nformat: pdc-document/1\nbody: pdc-djot/1\n\
         id: 11111111-2222-7333-8444-555555555555\n\
         created: 2026-09-13T12:34:56.789Z\n\
         updated: 2026-09-13T12:34:56.789Z\n\
         title: Legacy document\n---\n# Legacy document\n",
    );
    write_vault_bytes(
        &paths,
        "bom.md",
        b"\xEF\xBB\xBF---\nformat: pdc-document/2\n",
    );
    write_vault(
        &paths,
        "future.md",
        &canonical_md(ID_B, "Future", "x\n").replace("pdc-document/2", "pdc-document/9"),
    );

    let inv = scan(&paths).expect("scan");
    assert_eq!(entry(&inv, "canon.md").class, PdcEntryClass::Document);
    assert_eq!(entry(&inv, "canon.md").document_id.as_deref(), Some(ID_A));
    assert_eq!(entry(&inv, "canon.md").title.as_deref(), Some("Canon"));
    assert_eq!(
        entry(&inv, "canon.md").body_profile.as_deref(),
        Some("pdc-markdown/1")
    );
    assert_eq!(entry(&inv, "plain.md").class, PdcEntryClass::LegacyMarkdown);
    assert_eq!(entry(&inv, "plain.html").class, PdcEntryClass::LegacyHtml);
    assert_eq!(
        entry(&inv, "legacy.djot").class,
        PdcEntryClass::LegacyDocument
    );
    assert_eq!(
        entry(&inv, "legacy.djot").body_profile.as_deref(),
        Some("pdc-djot/1")
    );
    let bom = entry(&inv, "bom.md");
    assert_eq!(bom.class, PdcEntryClass::Invalid);
    assert_eq!(
        bom.diagnostic.as_ref().expect("diagnostic").code,
        "invalid_transport"
    );
    assert_eq!(entry(&inv, "future.md").class, PdcEntryClass::Unsupported);
    assert_eq!(
        entry(&inv, "future.md")
            .diagnostic
            .as_ref()
            .expect("diagnostic")
            .code,
        "unsupported_document_version"
    );
    assert_eq!(inv.items.len(), 6);
}

#[test]
fn dot_and_hidden_paths_are_excluded() {
    let (paths, _root) = temp_vault("exclusions");
    write_vault(&paths, "visible.md", &canonical_md(ID_A, "V", "b\n"));
    write_vault(&paths, "Meeting.md", &canonical_md(ID_B, "Meeting", "b\n"));
    write_vault(&paths, ".pdc/vault.json", "{}");
    write_vault(&paths, ".hidden/note.md", "hidden\n");
    write_vault(&paths, "UPPER.MD", "uppercase extension\n");

    let inv = scan(&paths).expect("scan");
    let names: Vec<&str> = inv.items.iter().map(|e| e.path.as_str()).collect();
    assert_eq!(names, ["Meeting.md", "visible.md"]);
}

#[test]
fn memo_plane_guard_ignores_nested_format_properties() {
    assert!(!is_pdc_document(
        "---\ncustom:\n  format: pdc-document/2\n---\n"
    ));
}

#[test]
fn inventory_paths_are_forward_slash_and_readable() {
    let (paths, _guard) = temp_vault("portable-path");
    write_vault(
        &paths,
        "Folder/Note.md",
        &canonical_md(ID_A, "Nested", "body\n"),
    );

    let inventory = scan(&paths).expect("scan");
    let note = inventory
        .items
        .iter()
        .find(|item| item.document_id.as_deref() == Some(ID_A))
        .expect("nested note");
    assert_eq!(note.path, "Folder/Note.md");
    assert!(!note.path.contains('\\'));
    assert_eq!(
        read_source(&paths, &note.path)
            .expect("read inventory path")
            .content,
        canonical_md(ID_A, "Nested", "body\n")
    );
}

#[cfg(unix)]
#[test]
fn symlinked_paths_are_excluded() {
    let (paths, root) = temp_vault("symlink-exclusions");
    write_vault(&paths, "visible.md", &canonical_md(ID_A, "V", "b\n"));
    write_vault(&paths, "Meeting.md", &canonical_md(ID_B, "Meeting", "b\n"));
    // Symlinked file and directory are never followed.
    std::os::unix::fs::symlink(root.path().join("visible.md"), root.path().join("link.md"))
        .expect("symlink file");
    fs::create_dir_all(root.path().join("sub")).expect("create sub");
    std::os::unix::fs::symlink(
        root.path().join("visible.md"),
        root.path().join("sub/note.md"),
    )
    .expect("symlink into subdir");

    let inv = scan(&paths).expect("scan");
    let names: Vec<&str> = inv.items.iter().map(|e| e.path.as_str()).collect();
    assert_eq!(names, ["Meeting.md", "visible.md"]);
}

#[test]
fn detects_duplicate_canonical_ids() {
    let (paths, _guard) = temp_vault("dupes");
    write_vault(&paths, "a/one.md", &canonical_md(ID_A, "One", "x\n"));
    write_vault(&paths, "b/two.md", &canonical_md(ID_A, "Two", "y\n"));
    write_vault(&paths, "c/three.md", &canonical_md(ID_B, "Three", "z\n"));

    let inv = scan(&paths).expect("scan");
    assert_eq!(inv.duplicate_ids.len(), 1);
    let dup = &inv.duplicate_ids[0];
    assert_eq!(dup.document_id, ID_A);
    assert_eq!(dup.paths, ["a/one.md", "b/two.md"]);
}

#[test]
fn query_gate_and_base_outcomes() {
    let (paths, _guard) = temp_vault("query");
    // No manifest at all: no `.pdc`, plain vault, no diagnostic.
    write_vault(
        &paths,
        "q/base.base",
        "filters: {and: []}\nviews:\n  - type: table\n    name: Base\n",
    );
    let inv = scan(&paths).expect("scan");
    assert!(!inv.query_enabled);
    assert!(inv.manifest_diagnostic.is_none());
    assert_eq!(entry(&inv, "q/base.base").class, PdcEntryClass::Query);

    // Declared gate: `.base` visible and classified, still not executed.
    write_vault(
        &paths,
        ".pdc/vault.json",
        r#"{"format":"pdc-vault/1","id":"018f47c6-4a77-7c52-9db8-0e5f9bcb17db","created":"2026-09-14T12:34:56.789Z","query":"pdc-query/1"}"#,
    );
    let inv = scan(&paths).expect("scan");
    assert!(inv.query_enabled);
    assert_eq!(entry(&inv, "q/base.base").class, PdcEntryClass::Query);

    // Unknown view key: parses but unexecuted.
    write_vault(
        &paths,
        "q/unknown.base",
        "views:\n  - type: table\n    warp: 9\n",
    );
    // Malformed query.
    write_vault(&paths, "q/bad.base", "filters: [broken\n");
    let inv = scan(&paths).expect("scan");
    assert_eq!(
        entry(&inv, "q/unknown.base").class,
        PdcEntryClass::QueryValidUnexecuted
    );
    assert_eq!(entry(&inv, "q/bad.base").class, PdcEntryClass::InvalidQuery);
    assert_eq!(
        entry(&inv, "q/bad.base")
            .diagnostic
            .as_ref()
            .expect("diagnostic")
            .code,
        "invalid_query"
    );
}

#[test]
fn manifest_states_are_surfaced() {
    let (paths, _guard) = temp_vault("manifest");
    // `.pdc` exists but the manifest is missing.
    write_vault(&paths, "n.md", "x\n");
    write_vault(&paths, ".pdc/keep.txt", "not a manifest\n");
    let inv = scan(&paths).expect("scan");
    assert_eq!(
        inv.manifest_diagnostic.as_ref().expect("diagnostic").code,
        "missing_manifest"
    );

    // Malformed JSON.
    write_vault(&paths, ".pdc/vault.json", "{not json");
    let inv = scan(&paths).expect("scan");
    assert_eq!(
        inv.manifest_diagnostic.as_ref().expect("diagnostic").code,
        "invalid_manifest"
    );
    // The required PDC vault identity and timestamp are validated too.
    write_vault(&paths, ".pdc/vault.json", "{}");
    let inv = scan(&paths).expect("scan");
    assert_eq!(
        inv.manifest_diagnostic.as_ref().expect("diagnostic").code,
        "invalid_manifest"
    );

    // Wrong query value.
    write_vault(
        &paths,
        ".pdc/vault.json",
        r#"{"format":"pdc-vault/1","id":"018f47c6-4a77-7c52-9db8-0e5f9bcb17db","created":"2026-09-14T12:34:56.789Z","query":"pdc-query/9"}"#,
    );
    let inv = scan(&paths).expect("scan");
    assert!(!inv.query_enabled);
    assert_eq!(
        inv.manifest_diagnostic.as_ref().expect("diagnostic").code,
        "invalid_manifest"
    );
}

#[test]
fn valid_manifest_without_query_keeps_queries_visible_but_disabled() {
    let (paths, _guard) = temp_vault("manifest-no-query");
    write_vault(
        &paths,
        ".pdc/vault.json",
        r#"{"format":"pdc-vault/1","id":"018f47c6-4a77-7c52-9db8-0e5f9bcb17db","created":"2026-09-14T12:34:56.789Z"}"#,
    );
    write_vault(
        &paths,
        "view.base",
        "filters: {and: []}\nviews:\n  - type: table\n    name: View\n",
    );

    let inv = scan(&paths).expect("scan");
    assert!(!inv.query_enabled);
    assert!(inv.manifest_diagnostic.is_none());
    assert_eq!(entry(&inv, "view.base").class, PdcEntryClass::Query);
}

#[cfg(unix)]
#[test]
fn manifest_symlinks_are_rejected() {
    let (paths, root) = temp_vault("manifest-dir-symlink");
    let target = root.path().join("control");
    fs::create_dir_all(&target).expect("create control dir");
    fs::write(
        target.join("vault.json"),
        r#"{"format":"pdc-vault/1","id":"018f47c6-4a77-7c52-9db8-0e5f9bcb17db","created":"2026-09-14T12:34:56.789Z"}"#,
    )
    .expect("write manifest");
    std::os::unix::fs::symlink(&target, root.path().join(".pdc")).expect("symlink pdc dir");
    assert_eq!(
        scan(&paths)
            .expect("scan symlinked control dir")
            .manifest_diagnostic
            .expect("manifest diagnostic")
            .code,
        "invalid_manifest"
    );

    let (paths, root) = temp_vault("manifest-file-symlink");
    fs::create_dir_all(root.path().join(".pdc")).expect("create pdc dir");
    let target = root.path().join("vault.json");
    fs::write(
        &target,
        r#"{"format":"pdc-vault/1","id":"018f47c6-4a77-7c52-9db8-0e5f9bcb17db","created":"2026-09-14T12:34:56.789Z"}"#,
    )
    .expect("write manifest target");
    std::os::unix::fs::symlink(&target, root.path().join(".pdc/vault.json"))
        .expect("symlink manifest");
    assert_eq!(
        scan(&paths)
            .expect("scan symlinked manifest")
            .manifest_diagnostic
            .expect("manifest diagnostic")
            .code,
        "invalid_manifest"
    );
}

#[test]
fn document_and_asset_references_are_resolved() {
    use sha2::{Digest, Sha256};
    let (paths, _guard) = temp_vault("refs");
    let good_digest = format!("{:x}", Sha256::digest(b"stored asset bytes"));
    let bad_digest = "0".repeat(64); // canonical shape, no such asset
    let short_digest = "abcd"; // non-canonical shape

    // Managed asset stored at the canonical layout only.
    write_vault_bytes(
        &paths,
        &format!(".pdc/assets/sha256/{}/{}", &good_digest[..2], good_digest),
        b"stored asset bytes",
    );
    // Digest-mismatched asset: exists but hashes differently.
    write_vault_bytes(
        &paths,
        &format!(".pdc/assets/sha256/{}/{}", &bad_digest[..2], bad_digest),
        b"some other bytes",
    );
    // Also referenced: an existing relative document, a missing one,
    // a missing relative image, and a wiki link with no target.
    write_vault(&paths, "target.md", &canonical_md(ID_B, "Target", "b\n"));
    let missing_id = "99999999-9999-7999-8999-999999999999";
    write_vault(
        &paths,
        "notes.md",
        &canonical_md(
            ID_A,
            "Links",
            &format!(
                "docs: [a](pdc://document/{ID_B}) broken: [b](pdc://document/{missing_id}#b-abc) \
                 frag-ok: [c](pdc://document/{ID_A}#b-{ID_A})\n\
                 rel-doc: [d](target.md) rel-missing: [e](../gone.md)\n\
                 img: ![](img/{short_digest}.png) managed: ![](pdc://asset/sha256/{good_digest})\n\
                 managed-bad: ![](pdc://asset/sha256/{bad_digest})\n\
                 wiki: [[Nowhere]]\n^b-{ID_A}\n"
            ),
        ),
    );

    let inv = scan(&paths).expect("scan");
    let e = entry(&inv, "notes.md");
    // Document pass first, then relative refs, then wiki links. The
    // fragment form of a known ID (`ID_A#b-…`) resolves.
    assert_eq!(
        e.broken_document_links,
        [
            format!("pdc://document/{missing_id}#b-abc"),
            "../gone.md".to_string(),
            "[[Nowhere]]".to_string(),
        ]
    );
    // `pdc://document/<ID_A>#b-def…` resolves (ID_A is in the inventory).
    assert!(
        e.missing_assets
            .contains(&format!("pdc://asset/sha256/{bad_digest}"))
    );
    assert!(
        e.missing_assets
            .contains(&format!("img/{short_digest}.png"))
    );
    assert_eq!(e.missing_assets.len(), 2);
}

#[test]
fn resolves_html_and_wiki_references_without_scanning_examples() {
    let (paths, _root) = temp_vault("html-wiki-refs");
    let block_id = format!("b-{ID_B}");
    write_vault(
        &paths,
        "Folder/Target.md",
        &canonical_md(ID_B, "Target", &format!("Target block ^{block_id}\n")),
    );
    write_vault(&paths, "Folder/image.png", "image bytes");
    write_vault(&paths, "a/Ambiguous.md", "# A\n");
    write_vault(&paths, "b/Ambiguous.md", "# B\n");
    write_vault(
        &paths,
        "source.html",
        &format!(
            "<a href=\"Folder/Target.md#^{block_id}\">relative</a>\
             <a href=\"pdc://document/{ID_B}#{block_id}\">stable</a>\
             <a href=\"pdc://document/{ID_B}#b-abc\">bad block</a>\
             <a href=\"file:///tmp/outside.md\">file</a>\
             <a href=\"/absolute.md\">absolute</a>\
             <a href=\"https://example.test/external.md\">external</a>\
             <a href=\"mailto:person@example.test\">mail</a>\
             <img src=\"Folder/image.png\">\
             <img src=\"data:image/png;base64,AAAA\">\
             [[Target]] [[Target#^{block_id}]] [[Ambiguous]]\
             ![[Folder/image.png]] ![[missing.png]]\
             <pre><a href=\"hidden.md\">[hidden](bad.md) [[Hidden]]</a></pre>\
             <!-- <a href=\"comment.md\">[[Comment]]</a> -->\
             ` [inline](inline-missing.md) [[Inline]] `"
        ),
    );

    let inventory = scan(&paths).expect("scan");
    let source = entry(&inventory, "source.html");
    assert!(
        source
            .broken_document_links
            .contains(&format!("pdc://document/{ID_B}#b-abc"))
    );
    assert!(
        source
            .broken_document_links
            .contains(&"file:///tmp/outside.md".to_string())
    );
    assert!(
        source
            .broken_document_links
            .contains(&"/absolute.md".to_string())
    );
    assert!(
        source
            .broken_document_links
            .contains(&"[[Ambiguous]]".to_string())
    );
    let valid_uri = format!("pdc://document/{ID_B}#{block_id}");
    assert!(!source.broken_document_links.contains(&valid_uri));
    assert!(
        !source
            .broken_document_links
            .contains(&format!("Folder/Target.md#^{block_id}"))
    );
    assert!(
        !source
            .broken_document_links
            .contains(&"[[Target]]".to_string())
    );
    assert!(
        !source
            .broken_document_links
            .contains(&format!("[[Target#^{block_id}]]"))
    );
    assert!(
        !source
            .broken_document_links
            .iter()
            .any(|link| link.contains("hidden.md")
                || link.contains("bad.md")
                || link.contains("comment.md")
                || link.contains("inline-missing.md"))
    );
    assert!(
        source
            .missing_assets
            .contains(&"data:image/png;base64,AAAA".to_string())
    );
    assert!(
        source
            .missing_assets
            .contains(&"[[missing.png]]".to_string())
    );
    assert!(
        !source
            .missing_assets
            .contains(&"Folder/image.png".to_string())
    );
}

#[cfg(unix)]
#[test]
fn symlinked_document_references_are_broken() {
    let (paths, root) = temp_vault("html-wiki-symlink");
    write_vault(
        &paths,
        "Folder/Target.md",
        &canonical_md(ID_B, "Target", "x\n"),
    );
    std::os::unix::fs::symlink(
        root.path().join("Folder/Target.md"),
        root.path().join("shortcut.md"),
    )
    .expect("symlink document target");
    write_vault(&paths, "source.html", "<a href=\"shortcut.md\">symlink</a>");

    let inventory = scan(&paths).expect("scan");
    let source = entry(&inventory, "source.html");
    assert!(
        source
            .broken_document_links
            .contains(&"shortcut.md".to_string())
    );
}

#[test]
fn digest_mismatch_is_reported() {
    use sha2::{Digest, Sha256};
    let (paths, _guard) = temp_vault("digest");
    let promised = format!("{:x}", Sha256::digest(b"original bytes"));
    write_vault_bytes(
        &paths,
        &format!(".pdc/assets/sha256/{}/{}", &promised[..2], promised),
        b"tampered bytes",
    );
    write_vault(
        &paths,
        "n.md",
        &canonical_md(
            ID_A,
            "Assets",
            &format!("![](pdc://asset/sha256/{promised})"),
        ),
    );

    let inv = scan(&paths).expect("scan");
    let e = entry(&inv, "n.md");
    assert_eq!(e.missing_assets, [format!("pdc://asset/sha256/{promised}")]);
}

#[test]
fn read_source_is_contained() {
    let (paths, root) = temp_vault("containment");
    write_vault(&paths, "dir/note.md", &canonical_md(ID_A, "N", "hello\n"));
    write_vault(&paths, "outside/secret.txt", "secret\n");
    write_vault(&paths, "outside/secret.md", "secret\n");
    write_vault(&paths, ".hidden/note.md", "hidden\n");

    let src = read_source(&paths, "dir/note.md").expect("read");
    assert_eq!(src.path, "dir/note.md");
    assert!(src.content.contains("hello"));

    // Only visible inventory files are readable.
    assert!(read_source(&paths, "outside/secret.txt").is_err());
    assert!(read_source(&paths, ".pdc/vault.json").is_err());
    assert!(read_source(&paths, ".hidden/note.md").is_err());
    // Absolute paths and traversal.
    assert!(
        read_source(
            &paths,
            root.path().join("outside/secret.md").to_str().unwrap()
        )
        .is_err()
    );
    assert!(read_source(&paths, "../outside/secret.md").is_err());
    assert!(read_source(&paths, "dir/../../outside/secret.md").is_err());
    assert!(read_source(&paths, "dir/../../../etc/passwd").is_err());
    assert!(read_source(&paths, "dir/./note.md").is_err());
    assert!(read_source(&paths, "dir//note.md").is_err());
    assert!(read_source(&paths, "dir\\note.md").is_err());
    assert!(read_source(&paths, "").is_err());
    // Missing and non-file targets.
    assert!(read_source(&paths, "dir").is_err());
    assert!(read_source(&paths, "dir/nope.md").is_err());

    let oversized = vec![b'x'; oxi_frontmatter::pdc::MAX_DOCUMENT_BYTES + 1];
    write_vault_bytes(&paths, "large.md", &oversized);
    assert!(read_source(&paths, "large.md").is_err());
}

#[cfg(unix)]
#[test]
fn read_source_rejects_symlinks() {
    let (paths, root) = temp_vault("containment-symlinks");
    write_vault(&paths, "dir/note.md", &canonical_md(ID_A, "N", "hello\n"));
    write_vault(&paths, "outside/secret.md", "secret\n");
    // Symlink in the chain is rejected, never followed.
    std::os::unix::fs::symlink(
        root.path().join("outside/secret.md"),
        root.path().join("dir/link.md"),
    )
    .expect("symlink");
    assert!(read_source(&paths, "dir/link.md").is_err());
    std::os::unix::fs::symlink(root.path().join("outside"), root.path().join("dir/escape"))
        .expect("symlink dir");
    assert!(read_source(&paths, "dir/escape/secret.md").is_err());
}

#[test]
fn scan_reports_oversized_sources_without_parsing_them() {
    let (paths, _guard) = temp_vault("oversized");
    let contents = vec![b'x'; oxi_frontmatter::pdc::MAX_DOCUMENT_BYTES + 1];
    write_vault_bytes(&paths, "large.md", &contents);

    let inventory = scan(&paths).expect("scan");
    let large = entry(&inventory, "large.md");
    assert_eq!(large.class, PdcEntryClass::Invalid);
    assert_eq!(large.size_bytes, contents.len() as u64);
    assert_eq!(
        large.diagnostic.as_ref().expect("size diagnostic").code,
        "file_too_large"
    );
}

#[cfg(unix)]
#[test]
fn scan_rejects_a_symlinked_vault_root() {
    let (target, _target_guard) = temp_vault("real-root");
    let (paths, root) = temp_vault("symlink-root");
    let alias = root.path().join("alias");
    std::os::unix::fs::symlink(&target.vault, &alias).expect("symlink vault root");
    let linked_paths = Paths {
        vault: alias,
        index_dir: paths.index_dir,
    };

    assert!(scan(&linked_paths).is_err());
}

#[test]
fn fixture_corpus_sources_read_back_byte_identically() {
    let vault = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../oxi-frontmatter/tests/fixtures/pdc-corpus-v2-r2/fixtures");
    let paths = Paths {
        index_dir: vault.join("index-unused"),
        vault: vault.clone(),
    };
    let inventory = scan(&paths).expect("scan PDC fixture corpus");
    assert!(!inventory.items.is_empty());

    for item in &inventory.items {
        let source_before = fs::read(vault.join(&item.path)).expect("read fixture bytes");
        let source = read_source(&paths, &item.path).expect("read inventory source");
        assert_eq!(source.content.as_bytes(), source_before);
        assert_eq!(
            fs::read(vault.join(&item.path)).expect("re-read fixture bytes"),
            source_before
        );
    }
}

#[test]
fn scan_preserves_every_byte_and_never_executes_queries() {
    let (paths, _guard) = temp_vault("bytes");
    let doc = canonical_md(ID_A, "Canon", "body\n");
    write_vault(&paths, "canon.md", &doc);
    let query =
        "filters:\n  and:\n    - {column: title, op: ==, value: x}\nviews:\n  - type: table\n";
    write_vault(&paths, "view.base", query);

    let before_doc = fs::read(paths.vault.join("canon.md")).unwrap();
    let before_query = fs::read(paths.vault.join("view.base")).unwrap();
    let before_manifest: Option<Vec<u8>> = fs::read(paths.vault.join(".pdc/vault.json")).ok();

    let inv = scan(&paths).expect("scan").clone();

    assert_eq!(fs::read(paths.vault.join("canon.md")).unwrap(), before_doc);
    assert_eq!(
        fs::read(paths.vault.join("view.base")).unwrap(),
        before_query
    );
    assert_eq!(
        fs::read(paths.vault.join(".pdc/vault.json")).ok(),
        before_manifest
    );
    assert_eq!(inv.items.len(), 2);
}

/// The serde DTO shape is what the desktop integrator consumes; pin it.
#[test]
fn inventory_serializes_stable_shape() {
    let (paths, _guard) = temp_vault("serde");
    write_vault(&paths, "a.md", "plain\n");
    let inv = scan(&paths).expect("scan");
    let json = serde_json::to_value(&inv).expect("serialize");
    assert_eq!(json["query_enabled"], serde_json::Value::Bool(false));
    assert!(json["duplicate_ids"].is_array());
    let item = &json["items"][0];
    for key in [
        "path",
        "class",
        "size_bytes",
        "broken_document_links",
        "missing_assets",
    ] {
        assert!(json["items"][0].get(key).is_some(), "missing {key}");
    }
    assert_eq!(item["class"], "legacy_markdown");
    // Optional fields are omitted, never null.
    assert!(item.get("document_id").is_none());
    assert!(item.get("diagnostic").is_none());
}

/// The memo-plane gate keys on the explicit PDC marker, not on the
/// classifier: ordinary Oximemo `---` frontmatter is not PDC.
#[test]
fn marker_detection_distinguishes_pdc_from_oximemo_frontmatter() {
    // Ordinary Oximemo note: `---` frontmatter, no `format` marker.
    assert!(!is_pdc_document(
        "---\nid: 0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee\ncreated: x\nupdated: y\n---\nbody\n"
    ));
    // Canonical PDC marker (any position inside the envelope).
    assert!(is_pdc_document(&canonical_md(ID_A, "T", "b\n")));
    // Unsupported future PDC version is still PDC-marked.
    assert!(is_pdc_document("---\nformat: pdc-document/9\n---\nx\n"));
    // Quoted value.
    assert!(is_pdc_document("---\nformat: \"pdc-document/2\"\n---\nx\n"));
    // A `format` field that is not pdc-document is not PDC.
    assert!(!is_pdc_document("---\nformat: other/1\n---\nx\n"));
    // HTML transport with the PDC marker.
    assert!(is_pdc_document(
        "<!--\n---\nformat: pdc-document/2\n---\n-->\n<p>x</p>\n"
    ));
    // HTML transport without the marker (plain Oximemo HTML note).
    assert!(!is_pdc_document(
        "<!--\nid: 0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee\n---\n<p>x</p>\n-->\n"
    ));
    // Plain HTML and body-only markdown.
    assert!(!is_pdc_document("<p>plain</p>\n"));
    assert!(!is_pdc_document("no frontmatter\n"));
}

#[test]
fn unmarked_frontmatter_notes_are_legacy_without_rewriting() {
    let dir = tempfile::tempdir().unwrap();
    let paths = Paths::resolve(Some(dir.path()));
    let cases = [
        (
            "note.md",
            "---\nid: 018f47c6-1199-72b3-87de-344e5a493e27\ncreated: 2026-10-11T00:00:00.123456Z\nupdated: 2026-10-11T00:00:00.123456Z\n---\n# Memo\n",
            PdcEntryClass::LegacyMarkdown,
        ),
        (
            "TEMPLATE.md",
            "---\nkind: daily\n---\n# Daily\n",
            PdcEntryClass::LegacyMarkdown,
        ),
        (
            "note.html",
            "<!--\n---\nid: 018f47c6-1199-72b3-87de-344e5a493e27\n---\n-->\n<h1>HTML</h1>\n",
            PdcEntryClass::LegacyHtml,
        ),
    ];
    for (name, source, class) in cases {
        fs::write(dir.path().join(name), source).unwrap();
        let (entry, _, _) = classify_entry(
            name,
            source.as_bytes(),
            if name.ends_with(".html") {
                DocumentExt::Html
            } else {
                DocumentExt::Markdown
            },
            source.len() as u64,
        );
        assert_eq!(entry.class, class);
        assert!(entry.diagnostic.is_none());
        let read = read_source(&paths, name).unwrap();
        assert_eq!(read.content, source);
        assert!(read.editable_body.is_none());
        assert_eq!(fs::read(dir.path().join(name)).unwrap(), source.as_bytes());
    }
}

#[test]
fn declared_pdc_with_missing_format_is_still_invalid() {
    let source =
        "---\nbody: pdc-markdown/1\nid: 018f47c6-1199-72b3-87de-344e5a493e27\n---\n# Broken PDC\n";
    let (entry, _, _) = classify_entry(
        "broken.md",
        source.as_bytes(),
        DocumentExt::Markdown,
        source.len() as u64,
    );
    assert_eq!(entry.class, PdcEntryClass::Invalid);
    assert_eq!(entry.diagnostic.unwrap().code, "invalid_envelope");
}
