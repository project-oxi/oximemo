# Personal framework standard verification

Date: 2026-09-27

## Scope

Implemented `garden-personal/1` as the common stack/layout/document standard,
manifest exceptions and doctor enforcement; migrated the shared shell and
playground; exposed standalone properties and values; aligned browser-package
TypeScript configuration. Existing uncommitted framework migration work was
preserved. The standard and its allowed deviations are documented in
`contracts/framework`; no user vault was converted and nothing was published.

## Automated evidence

- `bun run build`: passed for native bindings, UI, Markdown, editor, daemon-kit
  and the playground production bundle. Vite retains a non-failing large-chunk
  warning for the complete reference gallery.
- Full suite: `bun test cli/tests packages/markdown/tests packages/editor/tests
  packages/daemon-kit/tests packages/ui/tests`: **183 passed, 0 failed, 838
  assertions**, across 24 files.
- CLI lifecycle subset: **7 passed, 50 assertions**. It exercises generated
  desktop/service health, stack/native violations, exact/scoped exceptions,
  invalid/non-overridable/duplicate rules, missing evidence and symlink escapes.
- Editor subset: **63 passed, 437 assertions**, including source/model behavior
  and the exported property rendering surface.
- `node cli/garden.mjs doctor`: healthy. `node --check cli/garden.mjs` and
  `git diff --check`: passed.
- Independent fresh desktop/service generation, offline dependency installation,
  and each generated app's doctor/build: passed. The final desktop was generated
  at `/private/tmp/garden-personal-verify-20260927190220-68417/desktop`;
  the service at `/private/tmp/garden-personal-verify-20260927185747-59447/service`.

The initial service test run was blocked by the execution sandbox's local Unix
socket permission. Rerunning with local socket access passed all 10 daemon tests
and the complete suite. The initial editor build exposed a pre-existing NodeNext
versus browser-source module-resolution mismatch; UI/editor now extend the
shared bundler/noEmit configuration and the normal build passes.
Generated-app package installation and localhost preview binding also needed
sandbox escalation; the successful installs used only the local offline cache.

## Running browser paths

The running Vite playground was inspected using the in-app browser:

- Standard toolbar: exactly one command field, labeled left/right toggles,
  collapse/reopen, hidden navigation absent from the accessible tree.
- Command palette: visible launcher, Meta+P, filtering, Enter navigation to
  settings, Escape dismissal and return to the launcher.
- Right-panel close: focus returns to its controlling toolbar toggle.
- Compact layouts: settings at 375px and the document at 320px retain controls
  and no document-level horizontal overflow.
- Queries: real table/summary rendering, disabled source fallback and unsupported
  grouping with an explicit unexecuted diagnostic instead of empty results.
- Standalone `/tests/properties.html`: editing updates the read-only sheet;
  body, untouched YAML spelling, aliases and nested values remain unchanged.
  Tag entry retains focus. A text-to-number conversion that would lose meaning
  retains the text and reports `unsupported_lossless_edit`. Read-only sheets
  expose no editable textboxes.
- `/tests/shell-standard.html`: host-controlled closure from a focused sidebar
  input returns focus to the left toggle; the equivalent context input returns
  focus to the right toggle. Closing from a main-region button keeps that button
  focused. At 660px with an 80px native inset, the leading control starts at
  x=88px, preserving the compact gutter and native traffic-light space.
- Fresh generated desktop at port 1421: canonical document renders; changing
  title and adding a tag updates the full source while retaining the body.
  Navigation closes/reopens, commands open settings, the labeled theme switch
  enables dark mode, and the Documents command returns with the edited title
  and tags retained. No alert or horizontal overflow at 1280px.

The first generated desktop passed compilation but failed during browser
initialization: its sample passed reserved `tags`/`favorite` fields through the
creator's user-properties argument. The template now creates the document and
applies those standard fields through `patchMarkdownEnvelope`. A second fresh
generation, installation, build, doctor and the browser path above passed.

Screenshots: [framework standard](renders/personal-framework-standard-2026-09-27.png),
[generated desktop](renders/personal-framework-starter-2026-09-27.png).

An independent review found the compact native-inset and controlled-pane focus
issues; both were fixed and the follow-up review reported no remaining material
findings. Native AppKit/window controls were not launched again in this run;
the native-inset assertion measures CSS in the browser and does not claim an
OS-window execution result. The existing macOS overlay configuration is retained.

## Capability boundaries

Doctor checks structural declarations, configuration, pins and snapshot drift.
It does not claim automated understanding of prose, screenshot conformance or
Full PDC Reader/Writer capability. HTML/legacy source fallbacks, host-owned vault
and storage responsibilities, query capability limits and explicit enablement
remain documented and unchanged.
