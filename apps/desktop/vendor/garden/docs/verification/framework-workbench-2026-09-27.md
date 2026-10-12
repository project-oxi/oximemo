# Framework workbench verification — 2026-09-27

## Scope

Shared app shell, settings navigation/groups/rows, optional support panel, stable text focus, generated layout spacing, PDC document property/body projection, and portable query playground. Normative contracts: `contracts/ui-spec/layout.md` and `contracts/markdown/presentation.md`, selected in `contracts/adoptions.json`.

## Automated checks

- Entire repository suite: `bun test cli/tests packages/markdown/tests packages/editor/tests packages/daemon-kit/tests` — **95 passed, 0 failed**, 285 assertions. Daemon tests required permission to bind local sockets.
- UI, Markdown, editor, and playground builds — passed. Vite still reports its large-chunk advisory (approximately 1.42 MB uncompressed application JS).
- Token regeneration check — current. `garden doctor` — healthy. English/Korean locale key parity — passed.
- Preservation regressions cover multiline values and keys, YAML-sensitive strings, arrays and trailing comments, LF/CRLF handling, unchanged body bytes, no-op and monotonic timestamps, mixed-newline rejection, and active HTML rejection.

## Browser checks

Executed against `http://127.0.0.1:5174/?lang=ko` using the in-app Browser.

- Settings: desktop section layout, mobile horizontal tabs, ArrowDown/ArrowRight navigation, selected tab and corresponding panel.
- Properties: adding tags, switching documents with an uncommitted tag (draft cleared), first alias insertion without losing input focus, editing status and observing query results update.
- Editor: body-only text editing and undo; no validation alert on a normal edit. Light/dark editor backgrounds stay transparent before and after focus. Shared Input computed background, border and inset shadow remain identical on focus.
- Panel: open/close works; keyboard close returns focus to the opener. At 1280px the panel is 300px beside the document; at narrower widths it stacks below.
- Responsive geometry checked at 320, 375, 414, 768, 1024 and 1280px: document scroll width equals viewport width. Mobile navigation opens and Escape closes it.
- Queries: all documents (3, priority sum 6), formula scores (sum 60), property filter (2 rows, then 1 after editing a document's status), framework list (2), result-to-document navigation, disabled execution, invalid YAML, and valid-but-unsupported grouping. Edited tag values appear in results.
- Independent review findings on cross-document drafts, alias focus, select focus, and panel focus restoration were fixed.

Pointer clicks through the browser adapter did not reliably match the inspected tab during this run. Keyboard activation and semantic form operations were used for the recorded interaction checks. Screenshots provide visual evidence, not a claim that all pointer paths were exercised.

## Evidence

- [Desktop settings](renders/framework-settings-light.png)
- [Mobile settings](renders/framework-settings-mobile.png)
- [Document and panel](renders/framework-document-light.png)
- [Dark document](renders/framework-document-dark.png)
- [Mobile document](renders/framework-document-mobile.png)
- [Query results](renders/framework-query-light.png)

## Limits

Computer Use explicitly blocked access to `com.openai.codex`; no fresh live Codex measurements were obtained or claimed. Layout decisions use the existing repository observations and extracted design tokens/recipes. Playground documents and preferences are session-only. Tables and advanced compatibility syntax retain readable source where specialized rendering is absent. HTML/Djot profiles are read-only fallbacks; this does not claim complete PDC Reader/Writer or Bases compatibility, filesystem persistence, or vault-wide discovery.

## Follow-up: supplied Codex screenshots

Implemented an optional 52px global rail (44px compact), independently controlled sidebar, and inset support-card presentation in GAppShell. Settings now use full-width navigation placement with a 240px sidebar and a centered 760px form, 72px desktop top inset, separate page heading, and grouped surfaces. Dark navigation/group surfaces use the existing #212121 semantic surface value. Playground defaults to dark; explicit `theme=light` remains supported.

UI and playground builds passed after integration. Token generation and garden doctor passed. Independent review identified viewport-relative mobile menu sizing; changed it to containing-block sizing and verified at 320px (menu x52..292, viewport width320). At 1280x500 the inset panel body has clientHeight326, scrollHeight349, and overflow:auto. Sidebar collapse leaves the rail usable. Settings geometry at1800px: navigation x52..292, centered form width760. Light/dark rendering checked. Compact back-label hidden to avoid header-button overlap. These are layout changes; the earlier 95-test preservation run was not repeated since document/query logic was unchanged.

Evidence: [Dark settings](renders/codex-reference-settings.png), [Light settings](renders/codex-reference-settings-light.png). Screenshot-derived geometry is approximate, not a fresh direct measurement of the Codex app.
