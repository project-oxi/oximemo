#!/usr/bin/env python3
"""Run natural-language requests in ephemeral Codex sessions and isolated vaults.

Example: python3 skills/oximemo/evals/run.py --cli target/debug/oximemo
Use --skill-dir to compare a saved previous skill, and --cases to select cases.
No model override is supplied. Traces, CLI calls, assertions and usage are saved.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import time


SKILL = Path(__file__).resolve().parents[1]
REPO = SKILL.parents[1]


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def command(cli, env, *args):
    result = subprocess.run([str(cli), *args], env=env, capture_output=True,
                            text=True, timeout=30)
    if result.returncode:
        raise RuntimeError(f"Fixture command {args}: {result.stderr}")
    return result.stdout.strip()


def inventory(cli, env):
    return json.loads(command(cli, env, "pdc", "list"))


def documents(cli, env):
    return [item for item in inventory(cli, env)["items"]
            if item["class"] == "document" and not item["path"].endswith("TEMPLATE.md")]


def hashes(vault):
    return {str(p.relative_to(vault)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in vault.rglob("*") if p.is_file()}


def setup(case, work, cli, env):
    vault = work / "vault"
    vault.mkdir()
    (work / "README.md").write_text("# OldProject\n\nA small example project.\n")
    context = {}
    if case in ("recall", "html_edit", "conflict"):
        title, body = {
            "recall": ("취소 메모", "# 취소 메모\n\n취소 토큰은 협력적으로 확인한다.\n"),
            "html_edit": ("실험 기록", '<!-- keep this comment -->\n<h1 style="color: red">실험 기록</h1>\n<p>이전 설명</p>\n'),
            "conflict": ("충돌 기록", "# 충돌 기록\n\n기존 설명\n"),
        }[case]
        args = ["pdc", "create", "--title", title, "--body", body,
                "--set", 'review={"nested":[1,true,null]}']
        if case == "html_edit":
            args += ["--profile", "html"]
        receipt = json.loads(command(cli, env, *args))
        context = {"path": receipt["path"], "id": receipt["document_id"], "body": body}
        path = vault / receipt["path"]
        path.write_text(path.read_text().replace("title:", "# preserve envelope comment\ntitle:", 1))
        context["source"] = path.read_text()
    elif case == "legacy":
        source = REPO / "crates/oxi-frontmatter/tests/fixtures/pdc-corpus-v2-r2/fixtures/valid/semantics.djot"
        shutil.copyfile(source, vault / "legacy.djot")
        (vault / "plain.md").write_text("# Plain note\n\nThis is a legacy Markdown memo.\n")
    elif case == "task":
        doc_id = command(cli, env, "new", "# 할 일 연습\n")
        command(cli, env, "task", "add", "인보이스 정리", "--note", doc_id,
                "--repeat", "every week", "--due", "2026-10-20")
        item = next(i for i in documents(cli, env) if i.get("document_id") == doc_id)
        context = {"path": item["path"], "id": doc_id}
    context["before"] = hashes(vault)
    return context


def wrapper(work, cli, context, conflict):
    """Restrict the CLI to the fixture and inject a reproducible concurrent edit."""
    bindir = work / "bin"
    bindir.mkdir()
    config = {"cli": str(cli), "vault": str(work / "vault"),
              "oxi": str(work / "oxi"), "log": str(work / ".eval/cli.jsonl"),
              "marker": str(work / ".eval/conflict-injected"),
              "conflict_path": context.get("path") if conflict else None}
    source = '''#!/usr/bin/env python3
import json, os, pathlib, subprocess, sys
CONFIG = __CONFIG__
args = sys.argv[1:]
for index, value in enumerate(args):
    if value == "--space" or value.startswith("--space="):
        raise SystemExit("Evaluation is restricted to its fixture vault")
    if value == "--vault":
        if pathlib.Path(args[index + 1]).resolve() != pathlib.Path(CONFIG["vault"]):
            raise SystemExit("Evaluation is restricted to its fixture vault")
    if value.startswith("--vault=") and pathlib.Path(value.split("=", 1)[1]).resolve() != pathlib.Path(CONFIG["vault"]):
        raise SystemExit("Evaluation is restricted to its fixture vault")
env = os.environ.copy()
env.pop("OXIMEMO_SPACE", None)
env["OXIMEMO_VAULT"] = CONFIG["vault"]
env["OXI_HOME"] = CONFIG["oxi"]
marker = pathlib.Path(CONFIG["marker"])
if CONFIG["conflict_path"] and "pdc" in args and "update" in args and not marker.exists():
    path = pathlib.Path(CONFIG["vault"]) / CONFIG["conflict_path"]
    with path.open("a") as stream:
        stream.write("\\nExternal author: keep me.\\n")
    marker.write_text("injected before the first guarded update\\n")
result = subprocess.run([CONFIG["cli"], *args], env=env, text=True, capture_output=True)
with pathlib.Path(CONFIG["log"]).open("a") as stream:
    stream.write(json.dumps({"args": args, "returncode": result.returncode}, ensure_ascii=False) + "\\n")
sys.stdout.write(result.stdout)
sys.stderr.write(result.stderr)
raise SystemExit(result.returncode)
'''.replace("__CONFIG__", repr(config))
    path = bindir / "oximemo"
    path.write_text(source)
    path.chmod(0o755)
    return bindir


def body_slice(content):
    if content.startswith("<!--\n---\n"):
        return content.split("---\n-->\n", 1)[1]
    return content.split("---\n", 2)[2]


def grade(case, work, cli, env, context, final, calls):
    result = {}
    vault = work / "vault"
    items = documents(cli, env)
    if case == "capture":
        matches = [i for i in items if "Rust의 취소는 협력적이다." in (vault / i["path"]).read_text()]
        result["one_canonical_capture"] = len(matches) == 1
        result["requested_tag"] = bool(matches and "rust" in (vault / matches[0]["path"]).read_text())
        result["receipt_in_response"] = bool(matches and matches[0]["document_id"] in final and matches[0]["path"] in final)
    elif case in ("html_edit", "conflict"):
        content = (vault / context["path"]).read_text()
        item = next((i for i in items if i["path"] == context["path"]), {})
        result["identity_preserved"] = item.get("document_id") == context["id"]
        result["unknown_metadata_preserved"] = "nested:" in content and "# preserve envelope comment" in content
        def untouched_envelope(text):
            envelope = text.split("---\n", 2)[1]
            return re.sub(r"^updated:.*\n", "", envelope, flags=re.M)
        result["untouched_envelope_bytes_preserved"] = untouched_envelope(context["source"]) == untouched_envelope(content)
        updates = [call for call in calls if "pdc" in call["args"] and "update" in call["args"]]
        result["guarded_cli_edit"] = bool(updates and all("--sha256" in call["args"] for call in updates))
        if case == "html_edit":
            result["only_requested_body_change"] = body_slice(content) == context["body"].replace("<p>이전 설명</p>", "<p>새 설명</p>")
        else:
            result["concurrent_change_retained"] = "External author: keep me." in content
            result["requested_edit_applied"] = "수정한 설명" in content and "기존 설명" not in content
            result["conflict_observed_then_recovered"] = bool(updates and updates[0]["returncode"] != 0 and updates[-1]["returncode"] == 0)
    elif case in ("recall", "legacy", "readme"):
        result["vault_unchanged"] = hashes(vault) == context["before"]
        if case == "recall":
            result["recalled_fixture"] = "취소" in final and "협력" in final
        elif case == "legacy":
            result["both_sources_read"] = "legacy.djot" in final and "plain.md" in final
        else:
            result["readme_updated"] = (work / "README.md").read_text() == "# NewProject\n\nA small example project.\n"
            result["no_memo_commands"] = not calls
    elif case == "collection":
        template = next((i for i in inventory(cli, env)["items"] if i["path"] == "books/TEMPLATE.md"), {})
        result["canonical_collection_template"] = template.get("class") == "document"
        notes = [i for i in items if i["path"].startswith("books/")]
        result["one_book_note"] = len(notes) == 1
        source = (vault / notes[0]["path"]).read_text() if notes else ""
        result["schema_defaults_and_content"] = all(s in source for s in ("status: reading", "kind: book", "세계관이 인상적이다."))
    elif case == "task":
        source = (vault / context["path"]).read_text()
        result["canonical_identity_preserved"] = any(i.get("document_id") == context["id"] for i in items)
        result["task_completed"] = "- [x] 인보이스 정리" in source or "- [X] 인보이스 정리" in source
        task_lines = [line for line in source.splitlines() if "인보이스 정리" in line]
        result["next_recurring_task_created"] = len(task_lines) == 2 and any("- [ ]" in line for line in task_lines)
        rows = json.loads(command(cli, env, "task", "list", "--note", context["id"], "--format", "json"))
        result["completion_date_recorded"] = any(row.get("done") for row in rows)
        result["next_due_date_correct"] = any(row.get("due") == "2026-10-27" and row.get("symbol") == " " for row in rows)
        result["native_guarded_task_command"] = any("done" in c["args"] and "--hash" in c["args"] and c["returncode"] == 0 for c in calls)
    return result


def run_case(case, args, cli, skill, output):
    case_dir = output / case["id"]
    case_dir.mkdir()
    work = case_dir / "workspace"
    work.mkdir()
    (work / ".eval").mkdir()
    local_skill = work / ".agents/skills/oximemo"
    local_skill.parent.mkdir(parents=True)
    shutil.copytree(skill, local_skill, ignore=shutil.ignore_patterns("evals", "BUILD_INSTALL.md"))
    subprocess.run(["git", "init", "-q", str(work)], check=True)
    env = os.environ.copy()
    env.pop("OXIMEMO_SPACE", None)
    env["OXIMEMO_VAULT"] = str(work / "vault")
    env["OXI_HOME"] = str(work / "oxi")
    context = setup(case["id"], work, cli, env)
    write_json(case_dir / "fixture.json", context)
    bindir = wrapper(work, cli, context, case["id"] == "conflict")
    env["PATH"] = str(bindir) + os.pathsep + env["PATH"]
    (work / "AGENTS.md").write_text(
        "This is an isolated evaluation workspace. Work only with files in this directory. "
        "The configured memo vault is supplied by OXIMEMO_VAULT; OXI_HOME also points here. "
        f"The supplied Oximemo executable is {bindir / 'oximemo'}. Use that exact "
        "executable for memo operations. Do not install software, access "
        "real user vaults, modify bin/, .eval/, .agents/, or change environment selectors.\n"
    )
    disabled = "[" + ",".join(
        "{path=" + json.dumps(str(path)) + ",enabled=false}"
        for path in (SKILL / "SKILL.md", Path.home() / ".agents/skills/oximemo/SKILL.md")
    ) + "]"
    cmd = ["codex", "--no-daemon", "exec", "--ephemeral", "--ignore-user-config",
           "--json", "--sandbox", "workspace-write", "--skip-git-repo-check",
           "-c", "approval_policy=\"never\"", "-c", "skills.config=" + disabled,
           "-c", "shell_environment_policy.inherit=\"all\"", "-C", str(work),
           "-o", str(work / ".eval/final.txt"), "-"]
    started = time.monotonic()
    with (case_dir / "trace.jsonl").open("w") as trace, (case_dir / "stderr.txt").open("w") as errors:
        process = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=trace, stderr=errors,
                                   text=True, env=env, start_new_session=True)
        try:
            process.communicate(case["prompt"], timeout=args.timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=10)
    elapsed = round(time.monotonic() - started, 2)
    events = []
    for line in (case_dir / "trace.jsonl").read_text().splitlines():
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    commands = [event.get("item", {}).get("command", "") for event in events
                if event.get("type") == "item.completed"]
    loaded = any("oximemo" in cmd and "SKILL.md" in cmd for cmd in commands)
    final_file = work / ".eval/final.txt"
    final = final_file.read_text() if final_file.exists() else ""
    call_file = work / ".eval/cli.jsonl"
    calls = [json.loads(line) for line in call_file.read_text().splitlines()] if call_file.exists() else []
    checks = grade(case["id"], work, cli, env, context, final, calls)
    if case["skill"]:
        checks["tested_executable_used"] = bool(calls)
    checks["skill_trigger_matches_request"] = loaded == case["skill"]
    checks["agent_run_completed"] = process.returncode == 0
    usage = next((e.get("usage", {}) for e in reversed(events) if e.get("type") == "turn.completed"), {})
    started_turn = any(event.get("type") == "turn.started" for event in events)
    result = {"case": case["id"], "prompt": case["prompt"], "passed": all(checks.values()),
              "run_status": "evaluated" if started_turn else "infrastructure_error",
              "checks": checks, "skill_loaded": loaded, "seconds": elapsed,
              "command_count": len([cmd for cmd in commands if cmd]), "usage": usage,
              "exit_code": process.returncode, "artifact_dir": str(case_dir)}
    write_json(case_dir / "result.json", result)
    return result


def write_report(output, provenance, results):
    passed = sum(result["passed"] for result in results)
    report = ["# Oximemo request evaluation", "",
              f"Passed: {passed}/{len(results)}. One retained run per request is shown, using isolated vaults.",
              "These are observed scenario results, not a statistical reliability estimate.", "",
              f"CLI: `{provenance['cli']}`", f"CLI SHA-256: `{provenance['cli_sha256']}`",
              f"Skill SHA-256: `{provenance['skill_sha256']}`", "",
              "| Request | Result | Skill loaded | Seconds | Evidence |",
              "| --- | --- | --- | --- | --- |"]
    for result in results:
        report.append(f"| {result['case']} | {'PASS' if result['passed'] else 'FAIL'} | "
                      f"{result['skill_loaded']} | {result['seconds']} | "
                      f"[Assertions and trace]({result['artifact_dir']}/result.json) |")
    report += ["", "## Checks", ""]
    for result in results:
        report += [f"### {result['case']}", "", result["prompt"], ""]
        report += [f"- {'PASS' if value else 'FAIL'}: {name}"
                   for name, value in result["checks"].items()]
        report.append("")
    (output / "REPORT.md").write_text("\n".join(report) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli", type=Path, default=REPO / "target/debug/oximemo")
    parser.add_argument("--skill-dir", type=Path, default=SKILL)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--cases", help="Comma-separated case IDs")
    parser.add_argument("--timeout", type=int, default=240)
    args = parser.parse_args()
    cli = args.cli.resolve(strict=True)
    skill = args.skill_dir.resolve(strict=True)
    output = (args.output or REPO / "target/oximemo-skill-evals" / time.strftime("run-%Y%m%d-%H%M%S")).resolve()
    output.mkdir(parents=True, exist_ok=False)
    cases = json.loads((SKILL / "evals/cases.json").read_text())
    if args.cases:
        cases = [case for case in cases if case["id"] in args.cases.split(",")]
    if not cases:
        raise SystemExit("No evaluation cases selected")
    results = []
    provenance = {"cli": str(cli), "cli_sha256": hashlib.sha256(cli.read_bytes()).hexdigest(),
                  "cli_version": command(cli, os.environ.copy(), "--version"),
                  "skill": str(skill), "skill_sha256": hashlib.sha256((skill / "SKILL.md").read_bytes()).hexdigest()}
    for case in cases:
        print(f"Running {case['id']}...", flush=True)
        result = run_case(case, args, cli, skill, output)
        results.append(result)
        write_json(output / "summary.json", {**provenance, "results": results})
        print(json.dumps(result, ensure_ascii=False), flush=True)
    passed = sum(result["passed"] for result in results)
    write_report(output, provenance, results)
    print(f"{passed}/{len(results)} passed. Artifacts: {output}", flush=True)
    raise SystemExit(0 if passed == len(results) else 1)


if __name__ == "__main__":
    main()
