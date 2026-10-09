# ADR 0001: Session collection boundaries

- Status: Accepted
- Date: 2026-09-29

## Context

Oximemo replaces Cassette as the user-facing session recorder while retaining compatible `cassette-session-export/1` imports. Cassette also captures Codex lifecycle metadata and Git commit activity. These sources have different sensitivity and content boundaries: exported sessions contain conversation text, while the Codex hook and Git adapter need only metadata.

The quick-capture path must remain immediate and independent. Raw imported transcripts must remain local unless the user configures a provider, allows remote processing, and confirms each operation. Generated durable records must use the existing PDC 2 Markdown writer.

## Decision

- Keep explicit export-file import and non-recursive scans of user-registered export folders. Export auto-import is off by default and only stages local queue items.
- Add an optional Codex `SessionEnd` hook. Installation is an explicit user action that preserves unrelated hooks. Capture the session ID, working directory, transcript path, and end reason as metadata; never open or read the transcript.
- Add opt-in Git metadata capture for explicitly registered repositories. Capture commit hash, author, subject, author time, and changed paths; never read diffs or file contents.
- Keep Codex and Git activity in the app-private activity ledger, separate from the transcript-processing queue and PDC document plane. Do not send activity metadata to the summary provider.
- Keep export auto-import and Git auto-scan off by default. Keep provider processing separate and consent-gated.
- Write accepted summaries, decisions, and tasks as PDC 2 Markdown documents under `sessions/`. Do not alter Oximemo's quick-capture or memo-index contract.

## Consequences

- Cassette's private store and OS transcript history are not migration inputs. Users can supply compatible exports or explicitly register sources in Oximemo.
- Codex/Git collection can operate without a configured model provider and does not imply transcript access.
- The activity ledger is app-private database state, not a PDC document; PDC applies to the durable generated records only.
- Export and activity retention remain user-controlled. Disabling a source stops future collection but does not delete already captured records.
- The implementation and CLI/UI workflows are documented in [`docs/SESSION-RECORDER.md`](../SESSION-RECORDER.md).
