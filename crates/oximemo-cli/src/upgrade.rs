//! Self-update (`oximemo upgrade`).
//!
//! Checks the same `latest.json` the desktop app's updater polls, then swaps
//! whichever binary is running:
//!
//! - **Inside an `.app` bundle** (the sidecar installed via Settings): downloads
//!   the signed `OxiMemo.app.tar.gz`, verifies its minisign signature, and
//!   replaces the whole bundle. Because the CLI lives inside that bundle, the
//!   GUI and CLI update together.
//! - **Standalone** (a real binary on a headless/agent machine): downloads the
//!   release CLI tarball, verifies its SHA-256, and replaces the binary.
//!
//! Version comparison is `latest.json#version` against `CARGO_PKG_VERSION`.

use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use serde::Deserialize;

/// Where the desktop app's updater also points. Serves the version manifest.
const ENDPOINT: &str =
    "https://github.com/project-oxi/oximemo/releases/latest/download/latest.json";
const REPO: &str = "project-oxi/oximemo";
/// Rust target triple used in the CLI tarball asset name.
const TARGET_TRIPLE: &str = "aarch64-apple-darwin";
/// Key under `platforms` in the manifest that carries the macOS arm64 bundle.
const PLATFORM_KEY: &str = "darwin-aarch64";
/// Minisign public key (the raw key line). Must match the `pubkey` in
/// `tauri.conf.json`. The bundled key is the base64 of the full minisign box;
/// this is its decoded key line.
const PUBKEY: &str = "RWSPFXSR74pl0b+Ssow4gaUe7zr3ftkFG2S1obIcjfFKumljMGOYxgqq";

#[derive(Deserialize)]
struct Manifest {
    version: String,
    #[serde(default)]
    platforms: HashMap<String, PlatformAsset>,
}

#[derive(Deserialize)]
struct PlatformAsset {
    url: String,
    signature: String,
}

/// Entry point for `oximemo upgrade`. `check_only` mirrors `--check`.
pub fn run(check_only: bool) -> Result<()> {
    let current = env!("CARGO_PKG_VERSION");
    println!("Checking for updates…");
    let manifest = fetch_manifest().context("could not check for updates")?;
    let latest = manifest.version.as_str();
    if !is_newer(latest, current) {
        println!("Already up to date (v{current}).");
        return Ok(());
    }
    println!("Update available: v{current} → v{latest}.");
    if check_only {
        return Ok(());
    }

    if let Some(app) = app_bundle_root() {
        upgrade_in_app(&manifest, &app)?;
    } else {
        upgrade_standalone(latest)?;
    }
    Ok(())
}

// --- manifest + version -----------------------------------------------------

fn fetch_manifest() -> Result<Manifest> {
    let resp = ureq::get(ENDPOINT)
        .call()
        .map_err(|e| anyhow!("fetch manifest: {e}"))?;
    let body = resp
        .into_string()
        .map_err(|e| anyhow!("read manifest: {e}"))?;
    serde_json::from_str(&body).map_err(|e| anyhow!("parse manifest: {e}"))
}

/// `true` if `latest` is strictly newer than `current` (X.Y.Z, numeric).
fn is_newer(latest: &str, current: &str) -> bool {
    match (parse_version(latest), parse_version(current)) {
        (Some(l), Some(c)) => l > c,
        // Unparseable → never auto-update on a guess.
        _ => false,
    }
}

fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let v = v.strip_prefix('v').unwrap_or(v);
    let mut it = v.split('.');
    let maj = it.next()?.parse().ok()?;
    let min = it.next()?.parse().ok()?;
    // Tolerate a pre-release suffix on patch (e.g. "0-rc1").
    let patch_raw = it.next().unwrap_or("0");
    let patch = patch_raw.split('-').next()?.parse().ok()?;
    Some((maj, min, patch))
}

// --- context detection ------------------------------------------------------

/// The `.app` bundle the running binary lives in, if any (the sidecar case).
fn app_bundle_root() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| app_bundle_root_of(&exe))
}

/// Factored out of [`app_bundle_root`] for testing on synthetic paths.
fn app_bundle_root_of(exe: &Path) -> Option<PathBuf> {
    for ancestor in exe.ancestors() {
        if ancestor.extension().is_some_and(|e| e == "app") {
            return Some(ancestor.to_path_buf());
        }
    }
    None
}

// --- in-app: replace the whole .app bundle ---------------------------------

fn upgrade_in_app(manifest: &Manifest, app: &Path) -> Result<()> {
    let asset = manifest
        .platforms
        .get(PLATFORM_KEY)
        .ok_or_else(|| anyhow!("manifest has no asset for {PLATFORM_KEY}"))?;
    let parent = app
        .parent()
        .ok_or_else(|| anyhow!("app bundle has no parent directory"))?;
    let work = sibling_tempdir(parent)?;

    let result = (|| -> Result<()> {
        let archive = work.join("bundle.app.tar.gz");
        println!("Downloading {}…", filename_of(&asset.url));
        download(&asset.url, &archive)?;
        let data = fs::read(&archive)?;

        println!("Verifying signature…");
        verify_minisign(&data, &asset.signature)?;

        println!("Installing…");
        extract_tar_gz(&archive, &work)?;
        let new_app = find_entry_with_ext(&work, "app")?;

        // Swap on the same volume (atomic rename). The running GUI/CLI keep
        // their open file descriptors; a restart picks up the new bundle.
        let old = work.join(".previous.app");
        if app.exists() {
            fs::rename(app, &old)
                .with_context(|| format!("move aside {}", app.display()))?;
        }
        fs::rename(&new_app, app)
            .with_context(|| format!("install {}", app.display()))?;
        let _ = fs::remove_dir_all(&old);

        println!(
            "Updated to v{}. Restart OxiMemo to use the new version.",
            manifest.version
        );
        Ok(())
    })();

    let _ = fs::remove_dir_all(&work);
    result
}

// --- standalone: replace the bare binary -----------------------------------

fn upgrade_standalone(latest: &str) -> Result<()> {
    let exe = std::env::current_exe().context("resolve running binary")?;
    let parent = exe
        .parent()
        .ok_or_else(|| anyhow!("binary has no parent directory"))?;
    let work = sibling_tempdir(parent)?;

    let result = (|| -> Result<()> {
        let name = format!("oximemo-{TARGET_TRIPLE}.tar.gz");
        let base = format!("https://github.com/{REPO}/releases/download/v{latest}");
        let url = format!("{base}/{name}");

        let archive = work.join(&name);
        println!("Downloading {name}…");
        download(&url, &archive)?;

        let expected = download_text(&format!("{url}.sha256"))?;
        let expected = expected.split_whitespace().next().unwrap_or("");
        println!("Verifying checksum…");
        let actual = sha256_hex(&archive)?;
        if !expected.eq_ignore_ascii_case(&actual) {
            bail!("checksum mismatch: expected {expected}, got {actual}");
        }

        println!("Installing…");
        extract_tar_gz(&archive, &work)?;
        let new_bin = work.join("oximemo");
        set_executable(&new_bin)?;

        // Rename-over: on Unix the running binary's inode persists until the
        // process exits, so the directory entry can be replaced underneath it.
        let old = work.join(".previous.bin");
        fs::rename(&exe, &old)
            .with_context(|| format!("move aside {}", exe.display()))?;
        fs::rename(&new_bin, &exe)
            .with_context(|| format!("install {}", exe.display()))?;
        let _ = fs::remove_file(&old);

        println!("Updated to v{latest}.");
        Ok(())
    })();

    let _ = fs::remove_dir_all(&work);
    result
}

// --- helpers ---------------------------------------------------------------

/// A temp dir on the same volume as `sibling_of` so renames stay atomic.
fn sibling_tempdir(sibling_of: &Path) -> Result<PathBuf> {
    let dir = sibling_of.join(format!(".oximemo-upgrade-{}", std::process::id()));
    fs::create_dir_all(&dir)
        .with_context(|| format!("create work dir {}", dir.display()))?;
    Ok(dir)
}

fn download(url: &str, dest: &Path) -> Result<()> {
    let resp = ureq::get(url)
        .call()
        .map_err(|e| anyhow!("download {url}: {e}"))?;
    let mut reader = resp.into_reader();
    let mut f = fs::File::create(dest)
        .with_context(|| format!("create {}", dest.display()))?;
    std::io::copy(&mut reader, &mut f)?;
    f.sync_all().ok();
    Ok(())
}

fn download_text(url: &str) -> Result<String> {
    let resp = ureq::get(url)
        .call()
        .map_err(|e| anyhow!("download {url}: {e}"))?;
    resp.into_string()
        .map_err(|e| anyhow!("read {url}: {e}"))
}

fn verify_minisign(data: &[u8], signature_b64: &str) -> Result<()> {
    use base64::Engine as _;
    let raw = base64::engine::general_purpose::STANDARD
        .decode(signature_b64.trim().as_bytes())
        .map_err(|e| anyhow!("decode signature: {e}"))?;
    let sig_box = String::from_utf8(raw).context("signature is not valid utf-8")?;
    let pk = minisign_verify::PublicKey::from_base64(PUBKEY)
        .map_err(|e| anyhow!("parse public key: {e}"))?;
    let sig = minisign_verify::Signature::decode(&sig_box)
        .map_err(|e| anyhow!("parse signature: {e}"))?;
    pk.verify(data, &sig, false)
        .map_err(|e| anyhow!("signature verification failed: {e}"))
}

fn extract_tar_gz(archive: &Path, dest: &Path) -> Result<()> {
    let f = fs::File::open(archive)
        .with_context(|| format!("open {}", archive.display()))?;
    let gz = flate2::read::GzDecoder::new(f);
    let mut tar = tar::Archive::new(gz);
    tar.set_overwrite(true);
    tar.unpack(dest)
        .with_context(|| format!("extract {}", archive.display()))?;
    Ok(())
}

fn sha256_hex(path: &Path) -> Result<String> {
    use sha2::{Digest, Sha256};
    let mut f = fs::File::open(path)
        .with_context(|| format!("open {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf).context("read for hashing")?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(unix)]
fn set_executable(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perm = fs::metadata(path)?.permissions();
    perm.set_mode(0o755);
    fs::set_permissions(path, perm)?;
    Ok(())
}

#[cfg(not(unix))]
fn set_executable(_path: &Path) -> Result<()> {
    Ok(())
}

fn find_entry_with_ext(dir: &Path, ext: &str) -> Result<PathBuf> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if entry.path().extension().is_some_and(|e| e == ext) {
            return Ok(entry.path());
        }
    }
    bail!("extracted archive contained no .{ext}");
}

fn filename_of(url: &str) -> &str {
    url.rsplit('/').next().unwrap_or(url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn parses_plain_versions() {
        assert_eq!(parse_version("0.9.0"), Some((0, 9, 0)));
        assert_eq!(parse_version("v1.2.3"), Some((1, 2, 3)));
        // Pre-release suffix tolerated on patch.
        assert_eq!(parse_version("1.2.3-rc1"), Some((1, 2, 3)));
    }

    #[test]
    fn rejects_garbage_versions() {
        assert_eq!(parse_version("latest"), None);
        assert_eq!(parse_version(""), None);
    }

    #[test]
    fn newer_detection() {
        assert!(is_newer("0.9.1", "0.9.0"));
        assert!(is_newer("1.0.0", "0.9.9")); // numeric, not lexical
        assert!(!is_newer("0.9.0", "0.9.0"));
        assert!(!is_newer("0.8.9", "0.9.0"));
    }

    /// Network test: downloads the live manifest's bundle and confirms the
    /// `PUBKEY` constant verifies Tauri's real signature. Run with
    /// `cargo test -p oximemo-cli upgrade -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn verifies_live_release_signature() {
        let manifest = fetch_manifest().expect("fetch manifest");
        let asset = manifest
            .platforms
            .get(PLATFORM_KEY)
            .expect("manifest has darwin-aarch64 asset");
        let resp = ureq::get(&asset.url).call().expect("download bundle");
        let mut data = Vec::new();
        resp.into_reader()
            .read_to_end(&mut data)
            .expect("read bundle");
        verify_minisign(&data, &asset.signature)
            .expect("PUBKEY verifies the live Tauri signature");
    }

    #[test]
    fn unparseable_never_newer() {
        assert!(!is_newer("oops", "0.9.0"));
        assert!(!is_newer("0.9.1", "oops"));
    }

    #[test]
    fn detects_app_bundle_from_sidecar_path() {
        let exe = PathBuf::from("/Applications/OxiMemo.app/Contents/MacOS/oximemo");
        assert_eq!(
            app_bundle_root_of(&exe),
            Some(PathBuf::from("/Applications/OxiMemo.app"))
        );
    }

    #[test]
    fn no_app_bundle_for_standalone() {
        let exe = PathBuf::from("/Users/x/.cargo/bin/oximemo");
        assert_eq!(app_bundle_root_of(&exe), None);
        // Even a directory literally named "something.app" mid-path is fine;
        // only an actual .app ancestor counts, and there is none here.
        let exe = PathBuf::from("/usr/local/bin/oximemo");
        assert_eq!(app_bundle_root_of(&exe), None);
    }

    #[test]
    fn filename_of_strips_query_and_path() {
        assert_eq!(
            filename_of("https://x/y/OxiMemo.app.tar.gz"),
            "OxiMemo.app.tar.gz"
        );
    }
}
