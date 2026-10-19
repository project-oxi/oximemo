# Garden UI integration · 2026-10-12

Garden 0.1.0 is now vendored in `apps/desktop/vendor/garden`, with a managed
snapshot lock, the `ui` adoption, and a local `@garden/ui` Bun workspace.
The installed plugin CLI supplied the snapshot. Application imports use the
public package root and stylesheet; managed framework source remains unchanged.

## Components in use

| Public component | Running surface |
| --- | --- |
| `Button` | New note, workspace tools, note actions, settings and compact navigation close |
| `Tooltip` / `TooltipProvider` | Localized icon tools; one shared provider, keyboard focus and modal-safe portal |
| `SegmentedControl` | Grid/list choices, theme, language, task options and collection default view |
| `Switch` | Existing boolean preference rows, retaining their commit callbacks |
| `Input` | Numeric and text preferences, retaining blur/Enter commit and Escape cancellation |
| `GSettingsGroup` / `GSettingsRow` | Appearance group and labeled preference rows |
| `GPage` | 760px immersive Markdown measure and full-width HTML workspace |

The app-owned `src/garden-adapter.css` maps semantic variables to Oxi Glass.
The system/SUIT fonts and 6px controls, 8px cards, 10px menus and 12px sheets
remain. The owner-selected palette is now achromatic, including inverse primary
actions, folder markers, selections and Markdown syntax. Garden supplies radio semantics, switch behavior, button and
field primitives, tooltips and width composition. The existing workbench and
Base UI modal/popup ownership remain through explicit `shell.layout`, `ui.tokens`,
`stack.ui` and `stack.desktop` exceptions. See
[the integration ADR](../apps/desktop/docs/decisions/0001-garden-ui-integration.md).

Base UI stops document key events used by Radix RadioGroup inside its modal.
The settings composition adapts arrow, Home and End selection through the public
control API. Keyboard selection and focus were exercised after that fix. The
workspace radio group retains standard Radix behavior.

Product copy now uses paired `locales/en.json` and `ko.json`; TypeScript paths
remain typed compatibility exports. Catalog values were preserved. React and
React DOM use the Garden 19.3.0 pins and Vite deduplication. The app typecheck
retains strict app diagnostics and vendor type errors, excluding only vendor
unused-import diagnostics because Garden exports TypeScript source.

## Layout and theme

- System detection is the default. Missing, invalid and blocked preference
  storage falls back to the OS. Main and capture windows follow live light/dark
  changes; saved manual choices override detection and synchronize between
  windows. Native control color scheme follows the resolved theme.
- Settings choices reflow above their controls in compact panes; labels wrap
  and switches remain beside their label. Numeric and text controls use the
  same 28px field height and 44px minimum row density. Compact settings navigation
  uses a 48px horizontal strip, including keyboard focus and automatic scrolling.
- Both note layouts keep one mounted editor. Immersive Markdown uses a maximum
  760px measure and keeps 32px between properties and body. HTML uses the
  available width and retains its internal editor/preview scroll owners.
- Note actions form one group. Compact daily-note headers wrap that group onto
  a second row rather than clipping the date or actions. Compact navigation
  has a visible close button, Escape behavior and focus return to its toggle;
  resizing preserves focus in existing navigation controls and open popups.
- Existing 150ms entry, 100ms exit and 200ms movement tokens remain. Reduced
  motion, inert exiting controls and stable reading surfaces are preserved.

## Editor input

The existing source-preserving Atomic/CodeMirror editor remains in place. App-owned
extensions keep pointer selections at their clicked position, measure keyboard
caret scrolling after preview layout, and keep a focused caret visible when
resizing. Directly typed closing emphasis markers advance through parsed closing
syntax without duplicating stars or underscores; code and literal underscores
remain unchanged. The editor consumes Cmd/Ctrl+Enter before CodeMirror's blank-line
command, then invokes the existing guarded save-and-close path. IME and repeating
key events cannot invoke duplicate saves or global shortcuts.

Quick capture now binds its textarea to draft state. Reopening the native capture
window clears its displayed test text. Its writing surface is opaque while the
outer material retains glass edges. Canonical preset emission was advanced through
the shared note writer before these input changes; see the staged PDC plan.

## Verification

- Frontend production build passed, including strict app and imported vendor
  typechecks. The existing bundle-size warning remains.
- Bun tests: 657 passed, 3 skipped across 40 files, including the PDC corpus,
  caret bounds, emphasis syntax, IME and shortcut ownership.
- Rust core: 599 passed. Desktop: 57 passed, 5 ignored. Locked desktop Clippy
  passed for all targets with warnings denied. New Rust 1.98 lint findings in
  index chunk iteration and session formatting were resolved without changing
  the index representation.
- Garden sync passed and doctor is healthy. Rust dependencies now use exact
  `tauri = 2.12.0` and `tauri-build = 2.7.0` pins. Managed framework source is
  unchanged; custom shell, tokens, popup ownership and host exceptions remain.
- Browser input was exercised through clicks, direct Markdown typing, left/right
  and up/down keys, selection, list continuation and exit, undo/redo, layout
  changes and save/reopen. A saved three-line note reopened with exactly three
  editor lines after Cmd+Enter.
- Focused input resized through 320×640, 375×812, 414×736, 768×800 and 1280×800.
  The caret stayed visible and none of these viewports had horizontal overflow.
  Earlier shell/settings checks also covered 600, 900, 1024 and 1600px widths.
- Real isolated Tauri bundles were built and run at 480×360, 600×480, 1100×720
  and 1280×800. Native OS window controls also moved/resized a running note to
  960×525 on another monitor. Compact settings navigation, native preference
  persistence, sheet and immersive layouts, daily tools and theme choices were
  exercised. Native window-control space is reserved in compact layouts.
- The final native editor accepted direct emphasis typing at 480×360, retained
  its content through undo/redo and immersive switching, and saved the authored
  paragraphs, code, block ID and user property. The final 1280×800 build's
  Cmd+Enter closed the editor without changing any source bytes.
- Native capture appearance and draft clearing were observed. The macOS
  controller reactivates the main window for keyboard actions in the auxiliary
  capture window, so those actions do not establish capture-save behavior. IME
  composition guards have boundary tests; native OS composition was not automated.
- Tests used browser scratch notes and an explicit disposable native vault.
  The seven baseline native note/template files remain byte-identical. No real
  user vault was changed and no application was installed into /Applications.

Proof images and input viewport measurements are in
`/Users/garden/Documents/Codex/oximemo-ui-2026-10-12`. Native bundles and exact
verification logs are under the ignored repository `target/` directory.

This records actual UI and native verification with explicit test limits. It does
not claim complete Garden standardization or completion of the PDC migration.
