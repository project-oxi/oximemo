# Installed iPhone UI verification

These XCTest cases exercise the installed `com.oximemo.mobile` app through its
actual accessibility tree and software keyboard. They never save test content
or activate pairing/sync controls. Normal startup sync may still run if a PC
was already registered. Generated edits are explicitly discarded. Existing
notes are opened without changes. On a real device, leave it unlocked and idle
for roughly one minute; concurrent device use invalidates the input checks.

The larger-text case uses a process-local UIKit preference and restores a
normal launch afterward. It does not change iOS Settings. Device orientation
is restored when it was known at the beginning of the test.

The writing case requires actual software keyboard keys and a hittable Save
button above the keyboard after long input. It captures the full screen and
uses local Vision text recognition to check that the last typed line is visible;
checking only the textarea's complete accessibility value would miss clipping.

From the repository root, with XcodeGen installed and a matching development
team/signing identity configured:

```sh
mkdir -p target/mobile-device-qa
xcodegen generate --spec apps/mobile/qa/ios/project.yml --project target/mobile-device-qa
cp apps/mobile/qa/ios/ReadingWritingTests.swift target/mobile-device-qa/ReadingWritingTests.swift
xcodebuild test \
  -project target/mobile-device-qa/OxiMemoDeviceQA.xcodeproj \
  -scheme DeviceQA \
  -destination 'platform=iOS,name=iPhone14' \
  -derivedDataPath target/mobile-device-qa/DerivedData \
  -resultBundlePath target/mobile-device-qa/result.xcresult \
  -allowProvisioningUpdates
xcrun xcresulttool export attachments \
  --path target/mobile-device-qa/result.xcresult \
  --output-path target/mobile-device-qa/screenshots
```

Use the intended device's exact name or ID in `-destination`. Override
`DEVELOPMENT_TEAM` if needed. The source copy keeps generated project references
inside the ignored output directory. Result paths must be fresh for each run.
Screenshots may contain private note content and system overlays; keep them
local. Before and after physical installation/tests, privately copy the app's
`Library/Application Support/com.oximemo.mobile/cache.json` and compare bytes.

The same cases can run against an installed simulator build by selecting an
iOS Simulator destination and passing `CODE_SIGNING_ALLOWED=NO`. Simulator
results are distinct from physical-device results. The small-text writing case
repeats the keyboard flow at UIKit XS, without changing the system preference.
Browser QA supports `?scale=0.82`, `?scale=2` and `?theme=light` for independent text/layout checks; those fixtures
are not imported by the production build.


## Opt-in live sync test

`PCSyncTests.swift`, `sync-project.yml` and `run_sync_check.py` are a separate,
explicitly mutating test. They require a private `SyncFixture.json`, a real
endpoint/token, host CLI and an idle, connected physical device. Unlike the
reading/writing suite, this test saves a uniquely named synthetic phone note,
uploads existing queued drafts during pairing, and digest-guards a host update
of only that synthetic note. The code is cleared from the fixture afterward.
Do not run it against a live vault without the owner's authorization. Its result
and screenshots are private. See `docs/MOBILE-SYNC-2026-10-18.md`.

`testNativeEdgeHistoryAndUnsavedGuard` uses actual edge drags in the native iOS
host. Its name describes the test surface; SPA transitions are owned by the app,
not UINavigationController or WKWebView's default gesture list. It checks two
backward and two forward hops, followed by continue/discard protection of an
unsaved draft. The suite never saves this draft.
