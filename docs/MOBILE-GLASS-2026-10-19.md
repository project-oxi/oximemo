# iPhone navigation, search and Copilot — 2026-10-19

The owner requested iPhone back/forward swipes, better search selection UI,
persistent Copilot model selection and an iOS 27 Liquid Glass interpretation.
The phone was disconnected for the night. Existing unrelated repository work
and the running desktop conversation were preserved.

## Delivered behavior

Mobile keeps the labeled top-right New Note action. Silver/smoked navigation
controls and search use a restrained CSS glass material; the grouped list and
reading/writing surfaces remain opaque. System-relative typography, the 16px
input floor, safe-area layout and bounded textarea remain intact. There is no
bottom compose button or tab bar.

Search becomes a pinned, focused mode with Cancel, count and literal title/body
excerpt highlights. Empty search offers five browsable notes. Search terms,
filters and list position return after reading a result. Redundant no-result
reset buttons were removed; clear and cancel stay in the search field row.

Both edge directions, navigation buttons and browser history use one route
stack. A deliberate pan must begin within 24px of an edge; vertical scrolling,
short/cancelled gestures, multi-touch, text fields and code scrolling are
excluded. Dirty edits require save, continue or explicit discard. Save-and-leave
updates the route to the saved identity before traversing history, so forward
opens the saved document. Bodies and drafts never enter history state or URLs.
The native WKWebView gesture list was evaluated and rejected for these SPA
routes: forward movement was inconsistent. App-owned edge handling is the
verified implementation; no UINavigationController implementation is claimed.

Desktop settings and Copilot now share a model picker with search, keyboard
radio selection, selected-state feedback, local error/retry and focus return.
The default persists in vault preferences across new chats and process restarts;
per-turn adapters receive it unless explicitly overridden. Agent changes clear
incompatible defaults, and stale picker writes are rejected. oxios retains its
explicitly disclosed global-default scope. Providers come from the configured
selector, not guessed names. Existing activation stamps survive settings edits.
Interrupted/nonzero results retain their exact retry context and partial output.
Reading old conversation content no longer forces autoscroll on new responses.

## Verification

- Mobile frontend: **27 passed**, including actual history traversal, search
  round trip, exact dirty-draft retention/discard and save/back/forward identity.
- iPhone 14 / iOS 27 simulator: **5 passed**, 142.056 seconds, exercising real
  touch drags, software-keyboard long writing, visible final-line OCR, internal
  textarea scrolling, XS/XXXL type and search/settings navigation. A final
  no-result visual refinement was followed by a passing targeted native search
  check on the delivery build.
- Browser: **32 layout combinations** (320/375/414/768px × light/dark × library,
  search, reader, settings) had no horizontal overflow or visible control below
  44px. Additional 0.82×/2× text checks retained the input font floor and reachability.
  Reduced-transparency/high-contrast styles removed blur; sampled list and
  compose text contrast was 6.19:1 or higher in both themes.
- Copilot frontend: **24 passed**. Native Copilot: **48 passed**, 7 opt-in cases
  ignored in the ordinary run. The saved-default real OMP case ran separately
  and passed: preferences were saved/reloaded, `zai/glm-5.3-flash` actually served
  the synthetic request, and the expected response was returned. No user notes
  were attached. Core preferences restart/clear/old-config coverage passed.
- Mobile native: **13 passed** (12 sync, 1 mobile). Locked Clippy for both hosts,
  Garden doctor and frontend production builds passed. The desktop build keeps
  its existing large-bundle advisory.
- Signed physical iPhone IPA prepared. **Not installed or physically tested**
  after this redesign because the owner disconnected the phone. The earlier
  actual PC/iPhone round trip remains separately documented in
  `MOBILE-SYNC-2026-10-18.md`; it is not evidence for new gesture/UI behavior.

Private evidence is in ignored `target/mobile-glass-20261018/`: result bundles,
exported native screenshots, browser layout/contrast reports, process logs,
`ready-build.json` and the extracted device-ready app. Synthetic simulator notes
are isolated from the real vault. No bulk conversion or user-document cleanup
was performed. `DESIGN.md` and the mobile token layer record the visual contract.

## Local desktop installation

The Release app was signed through Tauri with the existing local Developer ID
identity. Strict/deep signature verification and matching team/identifier checks
passed. `/Applications/OxiMemo.app` was atomically replaced, retaining the old
bundle at `target/mobile-glass-20261018/desktop-previous.app`. The running app
was not restarted, preserving its open editor/conversation; the new controls take
effect at the next launch. `desktop-install.json` records the installed binary
hash. This local build was not notarized or published as an external release.
No credentials were rotated or read from organization secrets.

## Next physical connection

1. Privately back up phone cache/connection state before installing the prepared
   `com.oximemo.mobile` app; retain the established pairing.
2. Verify both edge directions through search → note → settings/connection,
   interrupted pans and unsaved continue/save/discard with the software keyboard.
3. Repeat XS long writing, last-line visibility and Save reachability on hardware.
4. Confirm an actual PC note update is pulled and a new phone edit returns to
   the same PC identity. Remove the old sync-test runner after verification.

No future automation or phone interaction was scheduled. The owner's existing
PC sync LaunchAgent remains running.

## Design references

- [Apple: Adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass)
- [Apple: Searching](https://developer.apple.com/design/human-interface-guidelines/searching)
- [Apple: Materials](https://developer.apple.com/design/human-interface-guidelines/materials)

The existing webview interprets the material in CSS. Functional navigation and
content legibility take priority over decorative transparency. System fonts and
consistent app structure intentionally follow the owner's platform brief; the
marketing-oriented font/structure rotation checks do not apply to this app variant.
