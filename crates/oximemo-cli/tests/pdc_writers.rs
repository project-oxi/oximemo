//! Exercise the actual CLI dispatcher and its shipping writer capabilities.
use std::fs;
use std::process::{Command, Output};

use oxi_frontmatter::pdc::{Classification, DocumentExt, PdcDocument, classify};
use serde_json::Value;
use tempfile::TempDir;

struct Fixture {
    root: TempDir,
}

impl Fixture {
    fn new() -> Self {
        let fixture = Self {
            root: tempfile::tempdir().unwrap(),
        };
        fs::create_dir(fixture.vault()).unwrap();
        fixture
    }

    fn vault(&self) -> std::path::PathBuf {
        self.root.path().join("vault")
    }

    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_oximemo"));
        command
            .env_remove("OXIMEMO_SPACE")
            .env_remove("OXIMEMO_VAULT")
            .env("OXI_HOME", self.root.path().join("oxi"))
            .arg("--vault")
            .arg(self.vault());
        command
    }

    fn run(&self, args: &[&str]) -> String {
        let output = self.command().args(args).output().unwrap();
        assert!(output.status.success(), "{args:?}: {}", stderr(&output));
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    }

    fn json(&self, args: &[&str]) -> Value {
        serde_json::from_str(&self.run(args)).unwrap()
    }

    fn path_for(&self, id: &str) -> String {
        let inventory = self.json(&["pdc", "list"]);
        inventory["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["document_id"].as_str() == Some(id))
            .unwrap_or_else(|| panic!("missing canonical ID {id}: {inventory}"))["path"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn canonical(&self, path: &str) -> PdcDocument {
        let bytes = fs::read(self.vault().join(path)).unwrap();
        let ext = if path.ends_with(".html") {
            DocumentExt::Html
        } else {
            DocumentExt::Markdown
        };
        match classify(ext, &bytes) {
            Classification::Valid(document) if !document.legacy => document,
            outcome => panic!("{path} is not PDC 2: {outcome:?}"),
        }
    }
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

#[test]
fn capabilities_match_markdown_html_and_collection_writers() {
    let fixture = Fixture::new();
    let capabilities = fixture.json(&["pdc", "capabilities"]);
    assert_eq!(capabilities["document_contract"], "pdc-document/2");
    assert_eq!(capabilities["writers"]["new"], true);
    assert_eq!(capabilities["writers"]["collection_templates"], true);
    assert!(fs::read_dir(fixture.vault()).unwrap().next().is_none());

    for args in [
        vec!["new", "# Markdown\n\nBody", "--tag", "rust"],
        vec!["new", "<h1>HTML</h1><p>Body</p>", "--html"],
    ] {
        let id = fixture.run(&args);
        assert_eq!(uuid::Uuid::parse_str(&id).unwrap().get_version_num(), 7);
        let path = fixture.path_for(&id);
        let document = fixture.canonical(&path);
        assert_eq!(document.id, id);
        let created = document.envelope.get("created").unwrap().as_str().unwrap();
        assert_eq!(created.len(), 24, "UTC milliseconds are required");
        assert!(created.ends_with('Z'));
    }

    fixture.run(&["collection", "install", "book", "books"]);
    let template = fixture.canonical("books/TEMPLATE.md");
    assert_eq!(
        template.envelope.get("status").unwrap().as_str(),
        Some("reading")
    );
    let bytes = fs::read(fixture.vault().join("books/TEMPLATE.md")).unwrap();
    fixture.run(&["collection", "install", "book", "books"]);
    assert_eq!(
        fs::read(fixture.vault().join("books/TEMPLATE.md")).unwrap(),
        bytes
    );
    let id = fixture.run(&["new", "# Book review", "--folder", "books"]);
    let note = fixture.canonical(&fixture.path_for(&id));
    assert_eq!(
        note.envelope.get("status").unwrap().as_str(),
        Some("reading")
    );
    assert_ne!(note.id, template.id);
    let manifest: Value =
        serde_json::from_slice(&fs::read(fixture.vault().join(".pdc/vault.json")).unwrap())
            .unwrap();
    assert_eq!(manifest["format"], "pdc-vault/1");
}

#[test]
fn source_update_preserves_unknown_metadata_and_refuses_stale_digest() {
    let fixture = Fixture::new();
    let receipt = fixture.json(&[
        "pdc",
        "create",
        "--title",
        "Structured",
        "--profile",
        "html",
        "--set",
        "review={\"nested\":[1,true,null]}",
        "--body",
        "<!-- authored --><h1>Original</h1>",
    ]);
    let path = receipt["path"].as_str().unwrap();
    let file = fixture.vault().join(path);
    let source = fs::read_to_string(&file)
        .unwrap()
        .replace("title:", "# keep comment\ntitle:");
    fs::write(&file, source).unwrap();
    let snapshot = fixture.json(&["pdc", "read", path, "--json"]);
    let digest = snapshot["sha256"].as_str().unwrap();
    fixture.run(&[
        "pdc", "update", path, "--sha256", digest, "--title", "Renamed",
    ]);
    let after = fixture.json(&["pdc", "read", path, "--json"]);
    assert_eq!(snapshot["editable_body"], after["editable_body"]);
    let canonical = fixture.canonical(path);
    assert!(canonical.envelope.get("review").is_some());
    assert!(
        after["content"]
            .as_str()
            .unwrap()
            .contains("# keep comment")
    );
    let before_conflict = fs::read(&file).unwrap();
    let conflict = fixture
        .command()
        .args([
            "pdc",
            "update",
            path,
            "--sha256",
            digest,
            "--body",
            "stale edit",
        ])
        .output()
        .unwrap();
    assert!(!conflict.status.success());
    assert!(stderr(&conflict).contains("external_change_conflict"));
    assert_eq!(fs::read(&file).unwrap(), before_conflict);
}

#[test]
fn task_capture_and_completion_keep_the_canonical_envelope() {
    let fixture = Fixture::new();
    let created = fixture.json(&["task", "add", "Inbox task", "--inbox"]);
    let task_ref = &created["task"]["task_ref"];
    let id = task_ref["memo_id"].as_str().unwrap();
    let path = fixture.path_for(id);
    fixture.canonical(&path);
    let file = fixture.vault().join(&path);
    let source = fs::read_to_string(&file)
        .unwrap()
        .replace("title:", "# keep envelope bytes\ntitle:")
        .replace("oximemo_editor:", "tags: [envelope-only]\noximemo_editor:");
    fs::write(&file, source).unwrap();
    let before = fixture.canonical(&path);
    fixture.run(&[
        "task",
        "done",
        id,
        &task_ref["line"].to_string(),
        "--hash",
        task_ref["line_hash"].as_str().unwrap(),
    ]);
    let after = fixture.canonical(&path);
    assert_eq!(before.id, after.id);
    assert_eq!(before.envelope.get("tags"), after.envelope.get("tags"));
    assert!(
        fs::read_to_string(file)
            .unwrap()
            .contains("# keep envelope bytes")
    );
}

#[test]
fn reads_do_not_install_templates_or_convert_legacy_sources() {
    let fixture = Fixture::new();
    let file = fixture.vault().join("legacy.md");
    let original = b"# Plain legacy\n\nKeep every byte.\n";
    fs::write(&file, original).unwrap();
    let path = fixture.run(&["vault", "path"]);
    assert_eq!(path, fixture.vault().to_string_lossy());
    assert!(!fixture.root.path().join("oxi").exists());
    for args in [
        vec!["list", "--format", "json"],
        vec!["search", "legacy", "--format", "json"],
        vec!["schema"],
        vec!["folders", "--format", "json"],
    ] {
        fixture.run(&args);
        assert_eq!(fs::read(&file).unwrap(), original);
        assert!(!fixture.vault().join("knowledge/TEMPLATE.md").exists());
        assert!(!fixture.vault().join(".pdc/vault.json").exists());
    }
}

#[test]
fn task_add_does_not_adopt_or_rewrite_a_legacy_note() {
    let fixture = Fixture::new();
    let id = "018f47c6-4a77-7c52-9db8-0e5f9bcb17db";
    let file = fixture.vault().join("legacy.md");
    let original = format!(
        "---\nid: {id}\ncreated: 2026-09-14T12:34:56Z\nupdated: 2026-09-14T12:34:56Z\n---\n# Legacy\n"
    );
    fs::write(&file, &original).unwrap();
    let output = fixture
        .command()
        .args(["task", "add", "Must not write", "--note", id])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(stderr(&output).contains("unsupported_lossless_edit"));
    assert_eq!(fs::read_to_string(file).unwrap(), original);
}

#[test]
fn memo_body_replacement_requires_the_original_source_digest() {
    let fixture = Fixture::new();
    let id = fixture.run(&["new", "# Original\n\nBody"]);
    let path = fixture.path_for(&id);
    let file = fixture.vault().join(&path);
    let before = fs::read(&file).unwrap();
    let output = fixture
        .command()
        .args(["update", &id, "--body", "unguarded"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(stderr(&output).contains("requires --sha256"));
    assert_eq!(fs::read(&file).unwrap(), before);
    let source = fixture.json(&["pdc", "read", &path, "--json"]);
    let token = source["sha256"].as_str().unwrap();
    fixture.run(&[
        "update",
        &id,
        "--sha256",
        token,
        "--body",
        "# Original\n\nChanged",
    ]);
    let after = fs::read(&file).unwrap();
    let stale = fixture
        .command()
        .args(["update", &id, "--sha256", token, "--favorite"])
        .output()
        .unwrap();
    assert!(!stale.status.success());
    assert!(stderr(&stale).contains("external_change_conflict"));
    assert_eq!(fs::read(&file).unwrap(), after);
    fixture.canonical(&path);
}

#[test]
fn space_reads_leave_an_old_flat_vault_in_place() {
    let fixture = Fixture::new();
    let oxi = fixture.root.path().join("oxi");
    fs::create_dir_all(oxi.join("vault")).unwrap();
    let old = oxi.join("vault/legacy.md");
    fs::write(&old, "# Old home\n").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_oximemo"))
        .env_remove("OXIMEMO_VAULT")
        .env_remove("OXIMEMO_SPACE")
        .env("OXI_HOME", &oxi)
        .args(["--space", "personal", "list", "--format", "json"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", stderr(&output));
    assert_eq!(fs::read_to_string(old).unwrap(), "# Old home\n");
    assert!(!oxi.join("spaces/personal/vault/legacy.md").exists());
}

#[test]
fn rollover_preview_does_not_install_presets() {
    let fixture = Fixture::new();
    assert_eq!(
        fixture.json(&["task", "rollover", "--dry-run"]),
        serde_json::json!([])
    );
    for entry in fs::read_dir(fixture.vault()).unwrap() {
        let path = entry.unwrap().path();
        assert!(path.is_dir(), "preview created a source file");
        assert!(
            fs::read_dir(path).unwrap().next().is_none(),
            "preview installed documents"
        );
    }
}

#[test]
fn rollover_rejects_a_legacy_source_before_creating_its_destination() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.vault().join("daily")).unwrap();
    let file = fixture.vault().join("daily/2026-10-17.md");
    let source = "---\nid: 018f47c6-4a77-7c52-9db8-0e5f9bcb17db\ncreated: 2026-09-14T12:34:56Z\nupdated: 2026-09-14T12:34:56Z\n---\n# Legacy daily\n\n- [ ] Keep me here\n";
    fs::write(&file, source).unwrap();
    let output = fixture
        .command()
        .args([
            "task",
            "rollover",
            "--from",
            "2026-10-17",
            "--to",
            "2026-10-18",
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(stderr(&output).contains("unsupported_lossless_edit"));
    assert_eq!(fs::read_to_string(file).unwrap(), source);
    assert!(!fixture.vault().join("daily/2026-10-18.md").exists());
}
