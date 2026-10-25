"""Explicit live-vault/device test driver. Never prints a token or pairing code.

Requires a prepared private output directory, fixture and signed XCTest project.
Only the uniquely named synthetic iPhone note is edited by the host. All other
PC documents are read-only observations; pairing uploads the phone's drafts.
"""
import argparse
import json
from pathlib import Path
import subprocess
import time
import urllib.request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--token-file", type=Path, required=True)
    parser.add_argument("--vault", type=Path, required=True)
    parser.add_argument("--device", required=True)
    parser.add_argument("--simulator", action="store_true")
    parser.add_argument("--result-name", default="physical-sync")
    args = parser.parse_args()
    output = args.output.resolve()
    fixture_path = output / "SyncFixture.json"
    fixture = json.loads(fixture_path.read_text())
    token = args.token_file.read_text().strip()

    def api(route, value=None, local=False):
        endpoint = "http://127.0.0.1:9843" if local else fixture["endpoint"]
        headers = {"Authorization": "Bearer " + token}
        body = None if value is None else json.dumps(value).encode()
        if body is not None:
            headers["Content-Type"] = "application/json"
        with urllib.request.urlopen(urllib.request.Request(endpoint + route, data=body, headers=headers), timeout=15) as response:
            return json.load(response)

    offer = api("/v1/pairing/new", {"endpoint": fixture["endpoint"]}, local=True)
    fixture["code"] = offer["code"]
    fixture_path.write_text(json.dumps(fixture, ensure_ascii=False, indent=2))
    fixture_path.chmod(0o600)
    command = ["xcodebuild", "test", "-project", str(output / "OxiMemoSyncQA.xcodeproj"),
               "-scheme", "SyncQA", "-destination", ("platform=iOS Simulator,id=" if args.simulator else "platform=iOS,id=") + args.device,
               "-only-testing:PCSyncTests/PCSyncTests/testPairAndRealRoundTrip",
               "-collect-test-diagnostics", "never", "-derivedDataPath", str(output / "DerivedData"),
               "-resultBundlePath", str(output / (args.result_name + ".xcresult")), "-allowProvisioningUpdates"]
    if args.simulator:
        command.append("CODE_SIGNING_ALLOWED=NO")
    report = {"simulator": args.simulator, "endpoint": fixture["endpoint"], "vault": str(args.vault), "host_pc_edit": False}
    log_path = output / (args.result_name + ".log")
    with log_path.open("w") as log:
        log_path.chmod(0o600)
        process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
        started = time.monotonic()
        try:
            while process.poll() is None and time.monotonic() - started < 170:
                if not report["host_pc_edit"]:
                    manifest = api("/v1/manifest")
                    found = [entry for entry in manifest["entries"] if entry.get("title") == fixture["phoneTitle"]]
                    if len(found) > 1:
                        raise RuntimeError("duplicate synthetic phone note")
                    if found:
                        source = api("/v1/source", {"path": found[0]["path"]})
                        # New canonical PDC creation normalizes LF and adds a
                        # final newline; existing-source PC edits stay exact.
                        expected = "**iPhone to PC**\n\n" + fixture["phoneMarker"] + "\n"
                        if source.get("editable_body") != expected or source.get("body_profile") != "pdc-markdown/1":
                            raise RuntimeError("PC source differs from the synthetic iPhone body")
                        (output / "iphone-created-pc-source.json").write_text(json.dumps(source, ensure_ascii=False, indent=2))
                        replacement = expected + "\n" + fixture["pcUpdateMarker"] + "\n"
                        edit = [str(output / "oximemo"), "--vault", str(args.vault), "pdc", "update", source["path"],
                                "--sha256", source["sha256"], "--body-stdin"]
                        result = subprocess.run(edit, input=replacement, text=True, capture_output=True, check=True)
                        (output / "pc-update-receipt.json").write_text(result.stdout)
                        updated = api("/v1/source", {"path": source["path"]})
                        if updated.get("document_id") != source.get("document_id") or updated.get("editable_body") != replacement:
                            raise RuntimeError("PC guarded update did not preserve identity/body")
                        (output / "pc-updated-source.json").write_text(json.dumps(updated, ensure_ascii=False, indent=2))
                        report.update({"host_pc_edit": True, "phone_body_matches_canonical_creation": True,
                                       "stable_document_id": source["document_id"], "phone_note_path": source["path"]})
                        (output / "host-progress.json").write_text(json.dumps(report, indent=2))
                time.sleep(1)
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=15)
                raise RuntimeError("live-device check exceeded its bounded window")
            report["xcode_exit_code"] = process.returncode
            report["elapsed_seconds"] = round(time.monotonic() - started, 2)
        finally:
            if process.poll() is None:
                process.terminate()
            fixture["code"] = ""
            fixture_path.write_text(json.dumps(fixture, ensure_ascii=False, indent=2))
            (output / "host-verification.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report))
    return 0 if report.get("host_pc_edit") and report.get("xcode_exit_code") == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
