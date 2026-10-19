# Copilot assessment — 2026-10-14

Scope: desktop conversation state, context attachment, subprocess ownership,
cancellation and timeout handling. This is a reliability assessment, not a
benchmark of model answer quality. Existing unrelated working-tree changes were
retained. No user vault was modified; UI checks used the browser fallback.

## Findings and changes

| Priority | Finding | Implemented behavior |
| --- | --- | --- |
| High | Cancel removed the busy slot before the old turn finished collecting results. A second turn could start, then lose its slot when the old guard dropped. Cancellation during preparation was discarded. | A turn guard owns preparation, execution and finalization. Cancel is latched before spawn and never releases ownership. Only guard disposal releases the slot. |
| High | Context was written to stdin before output draining and before the timeout started. Large context could block indefinitely if the agent did not read stdin. | Stdin, stdout and stderr run concurrently with the process deadline. Pipe tasks are aborted when no longer needed; output joins are bounded and concurrent. |
| High | New chat cleared frontend busy state while its native process continued. Its late response/session could then populate the new conversation. | Busy follows the outstanding request. Conversation epochs discard old responses and errors; duplicate sends are synchronously rejected. New chat and model selection are disabled during execution. |
| Medium | Switching notes retained the old active-note object until the next read completed. A late rejected read could also clear a newer attachment. | Active-note reads use the selected note's query key and verify its ID before attaching it. |
| Medium | Closing the panel discarded the draft and referenced notes, and reversed the user's active-note detachment. | Draft, references and detachment live in the transient store and survive remounts. New chat clears all three. They are not persisted to disk or localStorage. |
| Medium | A detached note could still drive command text; its selection chip could imply attachment even though it was not sent. Reattaching from the mention menu left the mention token in the request. | Command context and selection visibility follow attachment state. Reattachment consumes the mention token. The close button uses the localized label. |

The existing architecture already provides per-agent adapters, bounded reference
counts, selection size limits, sanitized chat Markdown, explicit provider
disclosure and a changed-note list that describes observation rather than
claiming the agent caused every change. These surfaces remain in place.

## Verification

- `bun test src/lib/copilotTurn.test.ts src/lib/copilotCommands.test.ts src/lib/copilotMention.test.ts src/stores/ui.test.ts`: 23 passed.
- `bun run build`: typecheck and production build passed; Vite retains its
  existing large-bundle advisory.
- `cargo test --locked -p oximemo-desktop --lib copilot::tests`: 43 passed,
  5 real-model tests intentionally ignored. Added tests execute real local
  `sleep` and `cat` processes for preparation cancellation, running cancellation,
  large bidirectional IO and a blocked-stdin deadline.
- `cargo clippy --locked -p oximemo-desktop --all-targets -- -D warnings`: passed.
- Garden sync and doctor: healthy.
- Running browser fallback at `127.0.0.1:5187`: entered a request, closed and
  reopened the panel, and observed the request retained. Sent it and observed
  disabled new-chat/model controls while busy, followed by a rendered response.
  Created a browser-only test note, detached its implicit context, attached it
  explicitly through mention search, then closed/reopened and verified both
  the reference chip and draft remained. New chat cleared the transcript.
  Reattaching the open note through mention search consumed the search token
  and restored the active-note chip with an empty composer.

## Remaining evaluation limits

- No paid external model request or production-vault mutation was performed.
  Browser responses are explicitly labeled fallback data; they do not establish
  model quality or current CLI compatibility. Agent adapters retain their
  existing fixture coverage.
- Conversation and draft recovery lasts only for the current app process.
  Persistence would require a deliberate privacy and retention decision.
- Responses arrive after the subprocess completes. Streaming progress and
  model-specific tool activity are separate product work.
- External agents retain their existing filesystem capabilities. The copilot
  lifecycle fixes do not enforce the PDC mutation contract on arbitrary agent
  file writes. Document-plane work must continue at the earliest open gate in
  `PDC-MIGRATION.md` (Stage 2) before a competing storage/editor redesign.
