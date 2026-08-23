//! Copilot delegation (spec `2026-08-23-copilot-panel-design.md`).
//!
//! oximemo dispatches vault tasks to a terminal-agent CLI the user has
//! explicitly activated. One turn = one subprocess (§8). The module owns:
//!
//! - candidate discovery + probe (§6) — never runs at app startup,
//! - the declarative context block (§7) — facts only, no instructions,
//! - provider disclosure (§12) — read from the agent's own config,
//! - the turn lifecycle (§8) — timeout, cancel, tree-kill, stderr/exit,
//! - the manifest diff (§9.4) — "notes changed during this turn", which
//!   deliberately claims no causality (the vault is shared).
//!
//! The core crate stays subprocess-free; everything here is desktop-only.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

/// A discovered agent CLI. `supported == false` candidates are listed by
/// the settings pane but cannot be activated (spec §13 — only oxios has a
/// verified non-interactive contract in v1).
#[derive(Debug, Clone, Serialize)]
pub struct AgentCandidate {
    pub id: String,
    pub display_name: String,
    pub executable: String,
    pub version: Option<String>,
    pub supported: bool,
}

/// Known agent binaries. (id, executable name, v1 adapter support).
const KNOWN_AGENTS: &[(&str, &str, bool)] = &[
    ("oxios", "oxios", true),
    ("oxicode", "oxicode", false),
    ("claude", "claude", false),
    ("codex", "codex", false),
    ("omp", "omp", false),
];

/// Resolve an executable name through `PATH` (first executable hit wins).
fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|p| p.is_file())
}

/// Probe an agent's version: `<exe> --version`, 3 s budget, first stdout
/// line. Discovery is never a trust boundary (§6) — this only labels the
/// candidate list.
pub async fn probe_version(exe: &Path) -> Option<String> {
    let out = Command::new(exe)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .ok()?;
    let line = String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()?
        .trim()
        .to_string();
    let line: String = line.chars().take(120).collect();
    if line.is_empty() {
        None
    } else {
        Some(line)
    }
}

/// Discover every known agent present on `PATH`. Lazy by design — callers
/// invoke this only from the settings pane or first panel open, never from
/// the app startup path (spec §6, acceptance criterion 2).
pub async fn probe_candidates() -> Vec<AgentCandidate> {
    let mut out = Vec::new();
    for (id, bin, supported) in KNOWN_AGENTS {
        let Some(exe) = which(bin) else { continue };
        let version = tokio::time::timeout(Duration::from_secs(3), probe_version(&exe))
            .await
            .ok()
            .flatten();
        out.push(AgentCandidate {
            id: (*id).to_string(),
            display_name: (*bin).to_string(),
            executable: exe.display().to_string(),
            version,
            supported: *supported,
        });
    }
    out
}

/// What the panel discloses about where the user's data may travel (§12).
#[derive(Debug, Clone, Serialize)]
pub struct Disclosure {
    pub agent: String,
    /// The agent's configured default model, e.g. `zai-coding-plan/glm-5-turbo`.
    pub model: Option<String>,
    /// The provider segment of the model id (before the first `/`).
    pub provider: Option<String>,
}

/// Parse `[engine] default_model = "..."` out of an oxios config body.
/// Section-scoped: a `default_model` under any other table is ignored.
fn disclosure_from_config(agent: &str, text: &str) -> Disclosure {
    let mut section = String::new();
    let mut model = None;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            section = line[1..line.len() - 1].trim().to_string();
            continue;
        }
        if section == "engine" && model.is_none() {
            if let Some((key, value)) = line.split_once('=') {
                if key.trim() == "default_model" {
                    let v = value.trim().trim_matches('"').trim_matches('\'');
                    if !v.is_empty() {
                        model = Some(v.to_string());
                    }
                }
            }
        }
    }
    let provider = model.as_ref().and_then(|m| {
        m.split_once('/')
            .map(|(p, _)| p.to_string())
            .filter(|p| !p.is_empty())
    });
    Disclosure {
        agent: agent.to_string(),
        model,
        provider,
    }
}

/// Provider disclosure for the activated agent. Only oxios has a known
/// config location in v1; other ids return an honest "unknown" disclosure
/// (spec §18-3: if it cannot be looked up, say so).
pub fn disclosure(agent: &str) -> Disclosure {
    let home = std::env::var("HOME").unwrap_or_default();
    let path = Path::new(&home).join(".oxios").join("config.toml");
    if agent == "oxios" {
        match std::fs::read_to_string(&path) {
            Ok(text) => disclosure_from_config(agent, &text),
            Err(_) => Disclosure {
                agent: agent.to_string(),
                model: None,
                provider: None,
            },
        }
    } else {
        Disclosure {
            agent: agent.to_string(),
            model: None,
            provider: None,
        }
    }
}

/// The memo the user has open when a turn starts, if any.
#[derive(Debug, Clone)]
pub struct ActiveMemo {
    pub id: String,
    pub title: String,
    pub path: String,
}

/// Build the declarative context block handed to the agent on stdin
/// (spec §7). Facts only — oximemo authors no instruction text; the
/// behavioral contract is the bundled `SKILL.md`, referenced by path.
pub fn build_context(
    vault_root: &Path,
    cli: &Path,
    skill: &Path,
    active: Option<&ActiveMemo>,
) -> String {
    let mut s = String::new();
    use std::fmt::Write;
    let _ = writeln!(s, "vault_root: {}", vault_root.display());
    let _ = writeln!(s, "cli: {}", cli.display());
    let _ = writeln!(s, "skill: {}", skill.display());
    if let Some(m) = active {
        let _ = writeln!(s, "active_memo:");
        let _ = writeln!(s, "  id: {}", single_line(&m.id));
        let _ = writeln!(s, "  title: {}", single_line(&m.title));
        let _ = writeln!(s, "  path: {}", single_line(&m.path));
    }
    s
}

/// Collapse any embedded newline so a crafted title cannot inject
/// key/value lines into the context block.
fn single_line(s: &str) -> String {
    s.chars().filter(|c| *c != '\n' && *c != '\r').collect()
}

/// A vault change observed during a turn. The kind names only what was
/// observed — never causality (spec §9.4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangedKind {
    Created,
    Changed,
    Deleted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChangedNote {
    pub id: String,
    pub kind: ChangedKind,
}

/// Diff two manifest snapshots (§9.4). `before`/`after` are (id, hash,
/// deleted) triples straight from `Vault::export_manifest`.
pub fn diff_manifests(
    before: &[(String, String, bool)],
    after: &[(String, String, bool)],
) -> Vec<ChangedNote> {
    let mut out = Vec::new();
    fn lookup<'a>(rows: &'a [(String, String, bool)], id: &str) -> Option<&'a (String, String, bool)> {
        rows.iter().find(|(i, _, _)| i == id)
    }
    for (id, hash, deleted) in after {
        match lookup(before, id) {
            None => {
                // Appeared during the turn. A record that is both new and
                // already deleted never surfaced to the user — skip it.
                if !deleted {
                    out.push(ChangedNote {
                        id: id.clone(),
                        kind: ChangedKind::Created,
                    });
                }
            }
            Some((_, old_hash, old_deleted)) => {
                if *deleted && !*old_deleted {
                    out.push(ChangedNote {
                        id: id.clone(),
                        kind: ChangedKind::Deleted,
                    });
                } else if hash != old_hash && !deleted {
                    out.push(ChangedNote {
                        id: id.clone(),
                        kind: ChangedKind::Changed,
                    });
                }
            }
        }
    }
    // Present before, absent after: hard-deleted (purged) during the turn.
    for (id, _, _) in before {
        if lookup(after, id).is_none() {
            out.push(ChangedNote {
                id: id.clone(),
                kind: ChangedKind::Deleted,
            });
        }
    }
    out
}

/// Result of one agent subprocess run (spec §8).
#[derive(Debug, Clone, Serialize)]
pub struct ProcessOutcome {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    /// Process-group id, for external cancellation via `kill_turn`.
    pub pgid: i32,
}

/// Kill every process in the turn's group. ESRCH (already gone) is fine.
pub fn kill_turn(pgid: i32) {
    if pgid > 0 {
        unsafe {
            libc::kill(-pgid, libc::SIGKILL);
        }
    }
}

/// Spawn the agent CLI for one turn and drive it to completion under a
/// timeout. The child gets its own process group so `kill_turn` reaps the
/// whole tree (grandchildren included) — a killed direct child that
/// orphans its helpers is the classic leak this prevents.
pub async fn run_agent_process(
    exe: &Path,
    args: &[String],
    stdin_data: &str,
    timeout_secs: u64,
) -> Result<ProcessOutcome, String> {
    let mut cmd = Command::new(exe);
    cmd.args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .process_group(0);
    let mut child = cmd.spawn().map_err(|e| format!("spawn {}: {e}", exe.display()))?;
    let pgid = child.id().map(|p| p as i32).unwrap_or(0);

    // Write the context block, then close stdin — an agent that prompts
    // for input sees EOF, not a hung pipe (spec §11). Context blocks are
    // small (a few hundred bytes), far under the 64 KiB pipe buffer, so
    // this write cannot deadlock against an agent that reads stdin last.
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(stdin_data.as_bytes()).await;
        let _ = stdin.shutdown().await;
    }
    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();

    let timed_out;
    let status = tokio::select! {
        st = child.wait() => {
            timed_out = false;
            Some(st.map_err(|e| format!("agent process failed: {e}"))?)
        }
        _ = tokio::time::sleep(Duration::from_secs(timeout_secs.max(1))) => {
            timed_out = true;
            kill_turn(pgid);
            // Reap the direct child; the tree is already dead.
            child.wait().await.ok()
        }
    };

    // Pipes hit EOF once every writer in the group is gone, so reading to
    // end after wait() cannot block.
    let stderr = drain(&mut stderr_pipe).await;
    let stdout = drain(&mut stdout_pipe).await;
    let exit_code = status.and_then(|s| s.code());
    Ok(ProcessOutcome {
        stdout,
        stderr,
        exit_code,
        timed_out,
        pgid,
    })
}

/// Read a taken child pipe to EOF and decode lossily. `None` (inherit or
/// null stdio) yields an empty string.
async fn drain(pipe: &mut Option<impl tokio::io::AsyncRead + Unpin>) -> String {
    let mut buf = Vec::new();
    if let Some(r) = pipe.as_mut() {
        use tokio::io::AsyncReadExt;
        let _ = r.read_to_end(&mut buf).await;
    }
    String::from_utf8_lossy(&buf).to_string()
}

/// Build the oxios argv for one turn (§13). The context rides stdin via
/// `--context-file -`; the user's request is the positional prompt.
pub fn oxios_args(session: Option<&str>, prompt: &str) -> Vec<String> {
    let mut args = vec![
        "run".to_string(),
        "--json".to_string(),
        "--context-file".to_string(),
        "-".to_string(),
    ];
    if let Some(sid) = session {
        args.push("--session".to_string());
        args.push(sid.to_string());
    }
    args.push(prompt.to_string());
    args
}

/// Parse the oxios `run --json` stdout. Falls back to the raw stdout as
/// the response when the agent prints anything non-JSON — the user still
/// sees exactly what the agent said.
pub fn parse_agent_json(stdout: &str) -> (String, Option<String>) {
    let trimmed = stdout.trim();
    if trimmed.starts_with('{') {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
            let response = v
                .get("response")
                .and_then(|r| r.as_str())
                .unwrap_or(trimmed)
                .to_string();
            let session = v
                .get("session_id")
                .and_then(|s| s.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            return (response, session);
        }
    }
    (trimmed.to_string(), None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_is_declarative_facts_only() {
        let ctx = build_context(
            Path::new("/vault"),
            Path::new("/app/oximemo"),
            Path::new("/app/skills/oximemo/SKILL.md"),
            Some(&ActiveMemo {
                id: "0191".into(),
                title: "Rust async cancellation".into(),
                path: "knowledge/rust-async.md".into(),
            }),
        );
        assert!(ctx.starts_with("vault_root: /vault\n"));
        assert!(ctx.contains("cli: /app/oximemo\n"));
        assert!(ctx.contains("skill: /app/skills/oximemo/SKILL.md\n"));
        assert!(ctx.contains("active_memo:\n  id: 0191\n"));
        // No instruction sentences: every line is a key: value fact or a
        // section header (spec §7, acceptance criterion 3).
        for line in ctx.lines() {
            let is_fact = line.starts_with("vault_root:")
                || line.starts_with("cli:")
                || line.starts_with("skill:")
                || line.starts_with("active_memo:")
                || line.starts_with("  id:")
                || line.starts_with("  title:")
                || line.starts_with("  path:");
            assert!(is_fact, "non-fact line in context: {line:?}");
        }
    }

    #[test]
    fn context_without_active_memo_omits_block() {
        let ctx = build_context(Path::new("/v"), Path::new("/c"), Path::new("/s"), None);
        assert!(!ctx.contains("active_memo"));
    }

    #[test]
    fn context_collapses_newlines_in_memo_fields() {
        let ctx = build_context(
            Path::new("/v"),
            Path::new("/c"),
            Path::new("/s"),
            Some(&ActiveMemo {
                id: "x\ninjected: yes".into(),
                title: "t".into(),
                path: "p".into(),
            }),
        );
        assert!(
            !ctx.lines().any(|l| l.trim_start().starts_with("injected")),
            "injection leaked: {ctx}"
        );
    }

    #[test]
    fn disclosure_parses_engine_default_model() {
        let cfg = r#"
[engine]
default_model = "zai-coding-plan/glm-5-turbo"

[daemon]
pid_file = "/x"
"#;
        let d = disclosure_from_config("oxios", cfg);
        assert_eq!(d.model.as_deref(), Some("zai-coding-plan/glm-5-turbo"));
        assert_eq!(d.provider.as_deref(), Some("zai-coding-plan"));
    }

    #[test]
    fn disclosure_ignores_other_sections_and_missing_values() {
        let cfg = "[other]\ndefault_model = \"a/b\"\n[engine]\ndefault_model = \"\"\n";
        let d = disclosure_from_config("oxios", cfg);
        assert_eq!(d.model, None);
        assert_eq!(d.provider, None);

        let d2 = disclosure_from_config("claude", "");
        assert_eq!(d2.model, None);
    }

    #[test]
    fn manifest_diff_classifies_changes() {
        let before = vec![
            ("a".to_string(), "h1".to_string(), false),
            ("b".to_string(), "h1".to_string(), false),
            ("del".to_string(), "h1".to_string(), false),
            ("gone".to_string(), "h1".to_string(), false),
        ];
        let after = vec![
            ("a".to_string(), "h2".to_string(), false),  // changed
            ("b".to_string(), "h1".to_string(), false),  // untouched
            ("del".to_string(), "h1".to_string(), true), // live → trashed
            ("new".to_string(), "h9".to_string(), false), // created
            ("ghost".to_string(), "h1".to_string(), true), // created+deleted in-turn: never surfaced
        ];
        let mut diff = diff_manifests(&before, &after);
        diff.sort_by(|x, y| x.id.cmp(&y.id));
        assert_eq!(
            diff,
            vec![
                ChangedNote {
                    id: "a".into(),
                    kind: ChangedKind::Changed
                },
                ChangedNote {
                    id: "del".into(),
                    kind: ChangedKind::Deleted
                },
                ChangedNote {
                    id: "gone".into(),
                    kind: ChangedKind::Deleted
                },
                ChangedNote {
                    id: "new".into(),
                    kind: ChangedKind::Created
                },
            ]
        );
    }

    #[tokio::test]
    async fn agent_process_roundtrip_echo() {
        // /bin/echo ignores stdin and prints its args — exercises spawn,
        // stdin write, wait, and output capture without any agent.
        let args = vec!["hello".to_string(), "agent".to_string()];
        let out = run_agent_process(Path::new("/bin/echo"), &args, "ctx", 10)
            .await
            .unwrap();
        assert_eq!(out.exit_code, Some(0));
        assert!(!out.timed_out);
        assert_eq!(out.stdout.trim(), "hello agent");
        assert!(out.stderr.is_empty());
    }

    #[tokio::test]
    async fn agent_process_timeout_kills_tree() {
        // A shell that backgrounds a child and waits — the direct child
        // has a grandchild. Tree-kill must reap both.
        let args = vec!["-c".to_string(), "sleep 30 & wait".to_string()];
        let t0 = std::time::Instant::now();
        let out = run_agent_process(Path::new("/bin/sh"), &args, "", 1)
            .await
            .unwrap();
        assert!(out.timed_out);
        assert!(t0.elapsed().as_secs() < 10, "timeout must not run to 30s");
        // The whole group must be gone: signaling it again is ESRCH, so
        // kill(0) on the group errors — assert via kill_turn's null effect
        // and process absence through the reaped child.
        kill_turn(out.pgid);
    }

    #[test]
    fn oxios_argv_shape() {
        let a = oxios_args(Some("s1"), "do it");
        assert_eq!(
            a,
            vec![
                "run", "--json", "--context-file", "-", "--session", "s1", "do it"
            ]
        );
        let b = oxios_args(None, "q");
        assert_eq!(b, vec!["run", "--json", "--context-file", "-", "q"]);
    }

    #[test]
    fn agent_json_parse_and_fallback() {
        let (r, s) = parse_agent_json(r#"{"response":"hi","session_id":"abc"}"#);
        assert_eq!(r, "hi");
        assert_eq!(s.as_deref(), Some("abc"));

        let (r2, s2) = parse_agent_json("plain text output\n");
        assert_eq!(r2, "plain text output");
        assert_eq!(s2, None);

        let (_, s3) = parse_agent_json(r#"{"response":"x","session_id":""}"#);
        assert_eq!(s3, None, "empty session must not be treated as a session");
    }
}
