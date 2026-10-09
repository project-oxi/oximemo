# Assistant Session Recorder

## Scope

The session recorder imports explicitly exported `cassette-session-export/1` JSON files into reviewable vault records. It also supports two metadata-only adapters: an explicitly installed Codex `SessionEnd` hook and explicitly registered Git repositories. The hook records lifecycle metadata but never opens a transcript; the Git scanner reads commit metadata and changed paths but no diffs or file contents. Export auto-import and Git auto-scan are off by default.

The recorder has two persistence planes:

- Imported export payloads, Codex/Git activity metadata, queue state, provider results, review receipts, and source registrations live in app-private state under `OXI_HOME/recorder/by-vault/<vault-index-hash>/`.
- Generated summaries, decisions, and tasks are canonical PDC 2 Markdown documents under the vault's `sessions/` directory. They use PDC document identity and source-digest-guarded writes; they are not Oximemo memos and do not enter the memo index. Codex/Git activity is database-only and never enters the transcript-processing queue.

This file is repository documentation, not a PDC document. PDC applies to the durable session documents written into a user's vault, not to source-controlled guides.

## Import workflow

### One file

Select a `*.cassette-session.json` file in the desktop app, or run:

```sh
oximemo session import /path/to/session.cassette-session.json
```

Import validates the strict export schema and bounds the file to 4 MiB, 5,000 messages, and 512 KiB per message. Duplicate source identity and revision are idempotent; different content for the same identity and revision is rejected. Original export files are never modified.

### Registered folders

Only folders explicitly added by the user are considered. Discovery is non-recursive, skips hidden entries, and accepts only immediate `*.cassette-session.json` children. A preview is report-only: it does not import sessions, update scan receipts, or change source registrations. The report shows filenames and metadata, not transcript text.

```sh
oximemo session source add /path/to/exports
oximemo session source list
# Use an ID from the list to pause, resume, or remove one registration.
oximemo session source set-enabled SOURCE_ID --disabled
oximemo session source set-enabled SOURCE_ID
oximemo session source remove SOURCE_ID
oximemo session source preview > session-preview.json
# Inspect the metadata-only report.
oximemo session source import session-preview.json
```

The desktop app provides the same two-step preview and import flow, plus per-folder enable, disable, and remove controls. It imports only entries marked `ready`. Import re-reads each file and checks the exact source-file SHA-256 from the preview; changed files, disabled registrations, duplicates, conflicts, invalid exports, and missing files are not silently imported. Removing a registration deletes only its scan receipts; previously imported sessions remain. One preview is limited to 500 exports and each directory scan is limited to 10,000 immediate entries.

Preview metadata can include the export title and external session ID. Treat the preview JSON accordingly; it contains no message text or absolute source-folder path.

## Optional automatic collection

Automatic collection is off by default. **Settings → Session recorder** has independent controls for export-folder auto-import and Git metadata auto-scan.

Export auto-import scans only enabled, explicitly registered folders. The desktop app scans at startup and every 60 seconds; `oximemo session process` also scans first when the setting is enabled. The CLI has no background poller.

Git auto-scan reads only enabled, explicitly registered repositories. It captures commit hash, author, subject, author time, and changed paths; it never reads diffs or file contents. The desktop app scans at startup and every 60 seconds; the CLI scans before `session process` when enabled.

### Codex SessionEnd hook

The hook is not installed by default. Install it from **Settings → Session recorder** or run:

```sh
oximemo session activity codex-install
```

The Settings button asks for confirmation before changing the hooks file. The explicit CLI install command proceeds immediately. Installation backs up the current hooks file once as `hooks.json.oximemo.bak` and adds only Oximemo's command to `~/.codex/hooks.json`. Existing Codex hooks are preserved. The hook stores session ID, working directory, transcript path, and end reason. The path is inert metadata: Oximemo never opens or reads the transcript.

Remove only Oximemo's command with the Settings button or `oximemo session activity codex-uninstall`.

### Git metadata sources

Register a repository explicitly:

```sh
oximemo session activity git add /path/to/repository
oximemo session activity git list
oximemo session activity git scan
oximemo session activity list
```

The Settings auto-scan toggle controls background collection. `set-enabled --disabled` pauses one registration; `remove` stops future collection but leaves captured activity in the local activity ledger. Codex and Git activity remain local and are not submitted to the summary provider.

The export scanner uses the same preview validation, ready-state filter, source-digest check, and import path as manual folder import. It reads no unregistered folder, hidden file, nested directory, or private application store. It imports into Oximemo's local queue and never invokes a provider automatically. Provider processing remains a separate explicit action.

## Processing and provider consent

The provider is OpenAI-compatible and is configured in the active vault's `oximemo.toml`:

```toml
[session]
endpoint = "http://127.0.0.1:1234/v1/chat/completions"
model = "local-model"
api_key_env = "OXIMEMO_SESSION_API_KEY"
allow_external = false
auto_import_sources = false
auto_scan_git_sources = false
```

Loopback HTTP endpoints are allowed. A non-loopback endpoint must use HTTPS and set `allow_external = true`. The credential value is read from the named environment variable; it is never stored in `oximemo.toml`. Provider redirects are disabled and transcript requests bypass proxy configuration.

Remote provider processing also requires per-operation consent. The desktop app displays a confirmation immediately before processing. CLI processing fails closed and leaves the queue untouched unless the command includes the explicit flag:

```sh
oximemo session process --confirm-external
```

Only imported session transcript chunks are sent to the provider. Codex and Git activity remains in the local activity ledger and is never submitted. Transcript content is untrusted input: the system prompt tells the model not to follow instructions in it, to ground each statement in evidence, and not to repeat secrets. This is a prompt boundary, not a guarantee that a model will behave correctly. Provider responses are bounded and validated before persistence.

## Queue policy and generated records

The processing policy is `automatic`, `review`, or `capture_only`:

- `automatic` writes generated records with `recorded` status.
- `review` writes records with `review` status; the user must inspect the PDC source and accept it before it becomes `recorded`.
- `capture_only` retains imports without sending them to a provider.

Incomplete exports remain `capture_only`. With no configured provider, complete exports remain queued. Provider failures are reported per session and retryable up to five attempts. A configured retention period is recorded as policy only; this recorder does not delete data automatically.

Generated output is structured model output, not a transcript-file copy. Each PDC document carries session provenance properties and a source footer. PDC source is displayed as inert text before review acceptance. Record revisions are retained in app-private history; rollback uses compare-and-swap against the current PDC digest.

Useful commands:

```sh
oximemo session list
oximemo session activity list
oximemo session policy --mode review
oximemo session review list
oximemo session review accept <RECORD_ID> --sha256 <CURRENT_PDC_SHA256>
oximemo session history <RECORD_ID>
oximemo session rollback <RECORD_ID> --target-sha256 <TARGET_SHA256> --base-sha256 <CURRENT_SHA256> --request-key <UNIQUE_KEY>
```

## Secret quarantine and data boundaries

A heuristic detector checks imported export JSON and captured activity metadata for known credential patterns. Suspected payloads are not stored in SQLite or sent to a provider. They are written to an app-private quarantine file with user-only permissions on Unix systems. The activity list hides quarantined metadata; users can discard the quarantine item. For session exports, the UI and list commands expose metadata only, and a user can apply a separately selected, redacted export with matching source identity and revision.

Detection is heuristic; it cannot guarantee that every credential is found. Review exports before import. Quarantine files contain sensitive input and remain in app-private storage until the user applies a redaction or discards the item.

The recorder never infers a Cassette storage path, recursively searches a home directory, or reads transcript contents. Export auto-import is limited to visible files in explicitly registered, enabled folders; Git scanning is limited to enabled, explicitly registered repositories; Codex metadata arrives only through the hook that the user explicitly installs. Disabling an auto-scan setting stops future background collection but retains already captured records.
