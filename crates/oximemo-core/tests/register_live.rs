//! Cross-process live test for the unified-home registration boundary
//! (P0-1). Exercises the REAL `oxibrain admin serve --stdio` child the
//! way production does:
//!
//! 1. `record_pending_root_registration` (what `Vault::open_spec` does)
//!    writes the pending file — and must NOT touch any brain file;
//! 2. `flush_pending_registrations` registers the root through the
//!    oxibrain-client boundary, clears the pending file, and the
//!    brain's `documents.toml` carries alias + path;
//! 3. a direct rerun of `register_document_root` reports `unchanged`
//!    (idempotent alias-keyed upsert).
//!
//! Everything runs under a leaked temp `OXI_HOME`, so the developer's
//! real `~/.oxi` is never touched. Skips cleanly (pass, with a note)
//! when no oxibrain binary is available, or when the auto-discovered
//! PATH binary predates `register_document_root` (the flush then
//! fails, which is the C1 offline behavior). Set `OXIBRAIN_BIN` to
//! point at a capable binary (e.g. a fresh
//! `../oxibrain/target/debug/oxibrain`) — an explicit override MUST
//! work; failure is a hard error.

use std::path::PathBuf;

use parking_lot::Mutex;

static ENV_LOCK: Mutex<()> = Mutex::new(());

/// `(path, explicit)` — `explicit` is true when `OXIBRAIN_BIN` named
/// the binary, in which case a capability failure is a hard error
/// instead of a skip.
fn oxibrain_bin() -> Option<(PathBuf, bool)> {
    if let Ok(p) = std::env::var("OXIBRAIN_BIN") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some((p, true));
        }
    }
    // PATH probe via `which` — a bare spawn would start a real child.
    let out = std::process::Command::new("which")
        .arg("oxibrain")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let path = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
    path.is_file().then_some((path, false))
}

#[test]
fn register_document_root_cross_process() {
    let Some((bin, explicit)) = oxibrain_bin() else {
        eprintln!(
            "oxibrain binary not found (set OXIBRAIN_BIN, e.g. \
             ../oxibrain/target/debug/oxibrain); skipping live registration test"
        );
        return;
    };

    // Serialize the process-global OXI_HOME swap (one test per binary,
    // but stay principled).
    let _guard = ENV_LOCK.lock();

    // A leaked temp dir keeps the store alive for the whole test; the
    // OS temp reaper owns reclamation.
    let dir = tempfile::TempDir::new().unwrap();
    let home = dir.keep();
    // SAFETY: single-threaded test process; the leaked dir outlives the
    // test either way, so the env is not restored by hand.
    unsafe { std::env::set_var("OXI_HOME", &home) };

    let vault = home.join("spaces/personal/vault");
    std::fs::create_dir_all(&vault).unwrap();
    std::fs::write(
        vault.join("note.md"),
        "---\nid: a\ncreated: t\nupdated: t\n---\nhello\n",
    )
    .unwrap();

    // 1. The open-time record: pending file inside oximemo's private
    //    subtree, zero brain files.
    oximemo_core::brain::record_pending_root_registration(&vault, "personal");
    let pending = home
        .join("oximemo")
        .join(oximemo_core::brain::PENDING_FILE_NAME);
    assert!(
        pending.is_file(),
        "the open-time record must write the pending file"
    );
    assert!(
        !home.join("brain/documents.toml").exists(),
        "oximemo must never write brain files directly"
    );
    // block_on inside the sync test keeps the ENV_LOCK guard out of an
    // await point (clippy::await_holding_lock).
    let flushed = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(oximemo_core::brain::flush_pending_registrations(&bin))
        .expect("flush must not error while the brain is reachable");
    let Some(outcome) = flushed else {
        if pending.is_file() && !explicit {
            eprintln!(
                "PATH oxibrain at {} did not deliver the registration \
                 (likely a build predating register_document_root); skipping",
                bin.display()
            );
            return;
        }
        panic!(
            "flush against the explicit OXIBRAIN_BIN binary produced no outcome \
             (pending file restored: {})",
            pending.is_file()
        );
    };
    assert_eq!(outcome.outcome, "added");
    assert_eq!(outcome.root.alias, "personal");
    assert_eq!(outcome.root.space, "personal");
    assert_eq!(outcome.root.path, vault.to_string_lossy());
    assert!(
        !pending.exists(),
        "a successful flush clears the pending file"
    );

    // 3. The brain's canonical store now carries the root.
    let doc = std::fs::read_to_string(home.join("brain/documents.toml")).unwrap();
    assert!(doc.contains("alias = \"personal\""), "doc: {doc}");
    assert!(
        doc.contains(&format!("path = \"{}\"", vault.display())),
        "doc: {doc}"
    );

    // 4. Idempotency: the same request through the client boundary
    //    again reports `unchanged`, not `added`.
    let request = oximemo_core::brain::document_root_request(&vault, "personal");
    let again = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(oximemo_core::brain::register_document_root(&bin, &request))
        .expect("rerun registration");
    assert_eq!(again.outcome, "unchanged");

    unsafe { std::env::remove_var("OXI_HOME") };
}
