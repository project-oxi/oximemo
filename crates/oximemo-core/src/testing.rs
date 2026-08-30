//! In-crate test support for the migration fixtures (`cfg(test)`
//! only): hermetic git fixtures and permission checks that degrade
//! gracefully on machines/filesystems without git or working chmod.

use std::path::Path;
use std::process::{Command, Stdio};

/// Whether a usable `git` binary exists (fixtures skip otherwise).
pub(crate) fn git_available() -> bool {
    Command::new("git")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// A `git` command rooted at `dir` with a hermetic identity and
/// config: no developer `~/.gitconfig` (gpg signing, hooks, aliases)
/// may fail or alter a fixture.
fn git_command(dir: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let tmp = std::env::temp_dir().join(format!("oximemo-gitcfg-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&tmp);
    let global = tmp.join("gitconfig-empty");
    if !global.exists() {
        let _ = std::fs::File::create(&global);
    }
    cmd.env("GIT_CONFIG_GLOBAL", &global);
    cmd.env(
        "GIT_CONFIG_SYSTEM",
        if cfg!(windows) { "NUL" } else { "/dev/null" },
    );
    cmd.env("GIT_AUTHOR_NAME", "oximemo-test");
    cmd.env("GIT_AUTHOR_EMAIL", "test@oximemo.invalid");
    cmd.env("GIT_COMMITTER_NAME", "oximemo-test");
    cmd.env("GIT_COMMITTER_EMAIL", "test@oximemo.invalid");
    cmd
}

fn status_ok(status: Option<std::process::ExitStatus>) -> bool {
    status.is_some_and(|s| s.success())
}

/// Create a real git repository with one commit at `dir`.
/// Returns the commit's `rev-parse HEAD`; `None` when git is missing
/// or any step fails (fixtures then skip).
pub(crate) fn git_init_commit(dir: &Path) -> Option<String> {
    if !git_available() {
        return None;
    }
    if !status_ok(git_command(dir).args(["init", "--quiet"]).status().ok()) {
        return None;
    }
    std::fs::write(dir.join("seed.md"), "seed\n").ok()?;
    if !status_ok(git_command(dir).args(["add", "."]).status().ok()) {
        return None;
    }
    if !status_ok(
        git_command(dir)
            .args([
                "commit",
                "--quiet",
                "-m",
                "seed",
                "--no-verify",
                "--no-gpg-sign",
            ])
            .status()
            .ok(),
    ) {
        return None;
    }
    git_head(dir)
}

/// `rev-parse HEAD` of the repo at `dir`, or `None` when git fails
/// (missing binary, broken repo).
pub(crate) fn git_head(dir: &Path) -> Option<String> {
    if !git_available() {
        return None;
    }
    let out = git_command(dir)
        .stdout(Stdio::piped())
        .args(["rev-parse", "HEAD"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Whether chmod actually sticks at `path` (no-op on FAT/exFAT-style
/// mounts — fixtures skip the assertion then).
#[cfg(unix)]
pub(crate) fn chmod_supported(path: &Path, mode: u32) -> bool {
    use std::os::unix::fs::PermissionsExt;
    if std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).is_err() {
        return false;
    }
    std::fs::metadata(path)
        .map(|m| m.permissions().mode() & 0o777 == mode)
        .unwrap_or(false)
}

/// Mode bits of `path` (unix).
#[cfg(unix)]
pub(crate) fn mode_of(path: &Path) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .ok()
        .map(|m| m.permissions().mode() & 0o777)
}
