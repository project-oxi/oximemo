# Physical iPhone and PC sync — 2026-10-18

The owner authorized actual pairing, upload of the existing queued draft and a
bidirectional test. This check used the installed iPhone14 app and the actual
PC personal vault. It was completed before the phone was disconnected for the
night. Browser fixtures are not evidence for this result.

## Observed result

- The real iPhone paired with the PC through its authenticated tailnet HTTPS
  endpoint. A PC-created synthetic note and an existing PC note opened on the
  phone.
- A synthetic note saved through the phone UI appeared as a canonical PDC 2
  Markdown document on the PC. The desktop app displayed it too.
- The host appended a unique marker through the CLI's source-digest guarded
  update. The phone pulled and displayed that marker in the same document:
  `01a14f71-4c75-7512-a81c-8e8a0643d828`. No title/body identity inference was used.
- The original queued draft matches exactly one canonical PC document after
  the documented new-document LF/final-newline normalization. Its body and
  pairing credentials are omitted from this report.
- Physical XCTest passed in 71.009 seconds; host orchestration took 76.3 seconds.
  Two clearly named synthetic sync-check notes remain for inspection.

The PC service remains a per-user LaunchAgent (`com.oximemo.mobile-sync`),
serving loopback port 9843. Tailscale Serve supplies tailnet-only HTTPS on 443.
The existing 8443 route was preserved. The token is private (mode 0600), and
neither token nor pairing code is committed. A later live check returned a
successful manifest with no duplicate IDs; unauthenticated and browser-Origin
requests both returned 401. The LaunchAgent was still running.

## Evidence and remaining physical work

Private artifacts are under `target/mobile-pc-sync-20261018/` (ignored, mode
0700): `physical-sync-4.xcresult`, `host-verification.json`, source/guard receipts,
`final-service-verification.json` and exported physical screenshots. The earlier
failed runs were test-harness selector/clear-field errors; the final pass is
separate. Concurrent user Copilot edits were not reverted or attributed to sync.

The phone disconnected immediately afterward, so a post-sync cache copy and
removal of `com.oximemo.mobile.syncqa.xctrunner` remain for the next connection.
Do not represent an absent post-sync cache backup as verified. The subsequent
Liquid Glass/navigation build requires a new physical check; its simulator
results do not replace this physical evidence.
