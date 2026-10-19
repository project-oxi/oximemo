# OxiMemo interface

The desktop interface follows a restrained interpretation of macOS 27 Liquid
Glass. This document governs the shell and every desktop view. The webview
implements the material with CSS; it does not claim to use native Liquid Glass.

## Structure

Modern minimal workbench: an integrated navigation panel and title bar, a
compact location heading and view toolbar, and an uninterrupted content area.
The native window supplies the outer corners; the webview does not draw a second
rounded window inside it.
Opening a note reveals a reading sheet aligned to the right of the workbench.
The header's expand action switches to an opaque, edge-to-edge immersive view;
the matching collapse action restores the sheet. The app remembers this layout
choice across notes and restarts. Markdown properties and body share a centered
760px measure in immersive view; HTML keeps the available workspace width.
Changing layout keeps the same editor mounted, including its draft and undo history.
Settings use a category rail beside a reading pane; compact windows use a 48px
horizontal category strip. Capture stays a single bottom-anchored input with an
opaque writing surface in its existing window.

- `CardGrid.tsx`: workspace shell, search, location heading, view controls.
- `Sidebar.tsx`: note destinations, folders, queries, tasks and tags; recent notes
  open on demand from a footer popover with location and recency metadata.
- `MemoDetail.tsx`: note sheet, existing guarded editor, context and history.
- `SettingsMenu.tsx`: preferences category rail and active pane.
- `GalleryView.tsx`: asset workspace.
- `PdcView.tsx`: document inventory and guarded source workspace.
- `BaseView.tsx` and `views/`: table, list, tasks, timeline, calendar, graph, shelf.
- `CaptureOverlay.tsx`: quick capture.
- `CommandPalette.tsx` and `CopilotPanel.tsx`: transient tools.

## Material and color

The root `tokens.css` is the shared token source, layered onto existing Oxi
semantic names. `apps/desktop/src/liquid-glass.css` owns component treatments.
Glass appears on navigation, toolbars, menus and transient tools. Reading and
editing surfaces stay opaque. A fine inner highlight and a soft contact shadow
describe glass edges; no decorative colored blooms or wallpaper are added.

Light mode uses white and silver paper; dark mode uses charcoal and smoked
chrome. App-owned colors are achromatic, including folder markers, status
indicators, selections, links and editor syntax. Primary actions use inverse
neutral fills. Garden controls use a visible neutral keyboard-focus outline.
Folder colors remain stored as user preferences; shell markers display gray.
High contrast, reduced transparency, reduced motion and missing backdrop-filter
support have explicit fallbacks.

## Type, space and interaction

System sans is the primary font, with the installed SUIT face as a Korean
fallback. Geist Mono remains the code face. Location titles are 22px, note titles
14px, navigation 13px, body controls 13px. Spacing uses the named 4px scale in
`tokens.css`; content insets are 24px, navigation rows 32px.
Controls use 6px corners, cards 8px, menus 10px and sheets 12px. Main panes are
flush with the native window and have no additional corner rounding. The new-note action uses a
compact icon button with a separate format menu. Toolbar controls share a 30px
height. The sidebar has no app title; its top strip reserves native window
controls. Buttons retain accessible labels and visible focus.

Properties and body are separated by 32px. Editor-owned folder/image controls
render in the note header. Backlinks, Brain, save status and history share a 28px
footer; history opens above it. Copilot is a toolbar action, without a floating
chat button.

No page-load reveals. Motion follows the reviewed Garden 0.1.0 vocabulary:
150ms entry, 100ms exit and 200ms movement. `workspace-motion.css` owns Base UI
transitions; Motion reads the same CSS tokens for sidebar, Copilot and property
disclosures. Immersive transitions animate frame geometry without scaling text.
Exiting controls are inert, and reduced motion makes all changes immediate.
Garden Button, Tooltip, SegmentedControl, Switch, Input, settings groups/rows
and GPage are integrated through the public `@garden/ui` package. The app-owned
`garden-adapter.css` connects their semantic variables to Oxi Glass; manifest
exceptions retain this shell, modal ownership and native host. See
`docs/GARDEN-UI-ASSESSMENT.md` for integration evidence and boundaries.
At narrow widths the navigation panel opens as a drawer,
the toolbar wraps, and the note sheet occupies the viewport with safe insets.
Keyboard navigation, capture shortcuts, drag/drop and note save guards retain
their existing component ownership. Pointer selections keep their clicked
position. Keyboard movement and focused editor resizing measure the settled
preview and expose the caret with a small margin. Typed emphasis closers advance
through existing syntax; IME confirmation never invokes save/close shortcuts.
Compact daily-note headers wrap the action group together. Compact navigation
has a close action and Escape support with focus return. Theme detection defaults
to system and follows OS changes in both main and capture windows; explicit
manual choices override detection and synchronize between windows.

## Mobile

The iPhone app is a document library, dedicated search mode and a focused
reader/editor. The owner requested the iOS 27 Liquid Glass direction on
2026-10-18. The mobile variant uses silver/white paper and charcoal/smoked
surfaces, system rounded display text and system sans reading text. Touch layout
is independent of desktop control density. This is a CSS material treatment in
the existing webview, not native UIGlassEffect.

Glass is limited to navigation controls and search, with a fine inner highlight
and a small contact shadow. The main list is one continuous paper group with
fine separators; individual notes are not floating glass cards. Reading and
writing stay opaque. Search matches use a restrained warm highlight. All theme
and accessibility variants have explicit material fallbacks.

The fixed library heading contains Settings and a clearly labeled **새 메모**
action at the top right. Search stays directly under the heading. Activating it replaces the heading
with a pinned search field and Cancel action. Empty search offers a compact
instruction and five browsable notes; typed search shows a count and literal
match highlights. The note/draft and folder selectors scroll with the normal
list and are omitted in search mode. Search results, query and list position
survive a round trip through a note. There is no bottom tab bar or persistent status footer.
Settings owns PC connection and trash. Buttons, browser history and both
screen-edge gestures share an explicit route stack. An edge pan must start
within 24px and travel deliberately horizontally; vertical scrolling, cancelled
or multi-finger touches and editor/code interactions do not navigate. WebKit's
native gesture list stays disabled because its SPA forward behavior was
inconsistent in simulator testing. Route history contains identifiers and
presentation state, never bodies or unsaved drafts. Guarded save-and-leave
replaces the draft route with the saved identity before moving back. Normal synchronization stays quiet; progress, rejected documents and
connection failures remain discoverable and actionable.

List titles use approximately 17pt, excerpts 14pt and context 12pt at the default
system size, with up to two title and excerpt lines. The open reader uses a 28pt
title and 17pt body with a 1.75 line height. Type is expressed relative to the
system body font (`-apple-system-body` on iOS) so text can enlarge. Large type can
reflow the heading actions into a second row. Actual touch targets remain at
least 44px even where the visible symbol is smaller.

Opening a note starts in reading mode. **편집** in the fixed header enters the
source editor and exposes the keyboard. New notes start with a title field;
Return moves to the body. **미리보기** shows the current draft without writing,
and **편집** returns to that exact draft. **저장** first persists locally, then
syncs if paired, while keeping the saved note open. A transient, explicit native
key mapping follows a new draft's PC-assigned identity, including partial sync
failure. This mapping changes no source or cache format. Leaving unsaved edits
requires saving, continuing or explicitly discarding the transient edit.

Reading scrolls the document. Writing keeps the navigation, title and preview
action above a bounded textarea that scrolls internally above the keyboard.
The outer document cannot scroll. Input fields keep at least a 16px font even
at the smallest system text size, preventing focus zoom from moving navigation.
Appending at the end reveals the last line inside the textarea. The native
caret indicates focus; buttons retain visible keyboard focus rings. File paths
and raw-file controls live in **문서 정보** away from ordinary reading. A new
note's format selector is in the writing toolbar. HTML and unsupported/legacy sources retain the
existing source fallback and read-only guards; HTML editing must be explicitly
entered too. Markdown preview remains sanitized and source-preserving.

Saved PC credentials never imply a live connection. The connection screen owns
sync timestamps, pending counts, retry and pairing controls. The separately authorized physical pairing on 2026-10-18 configured a private
PC LaunchAgent and tailnet-only HTTPS; existing Serve routes were preserved.
See `docs/MOBILE-SYNC-2026-10-18.md`.

`apps/mobile/src/tokens.css` contains the mobile type tokens, `iphone.css` owns the iPhone keyboard/layout foundation, and
`liquid-glass.css` adds the new material and search treatments. The older shell
styles remain intact. Root `tokens.css` exports the mobile material variables
without changing desktop's semantic aliases.
No decorative imagery or page-load reveals. Verification and its exact physical
device limits are recorded in `docs/MOBILE-REDESIGN-2026-10-18.md` and
`docs/MOBILE-GLASS-2026-10-19.md`.

## Copilot preferences

Desktop settings and the conversation share one accessible model picker. The
selected default is stored in vault preferences, survives new chats/restarts,
and is passed to adapters with a per-turn model flag. Empty follows the agent's
own default. oxios also changes its global default through its own config tool;
its picker explicitly states that scope. Selecting a model never changes
credentials. Agent changes clear incompatible defaults; stale picker writes
are rejected. Settings edits preserve the executable activation stamp.

A failed or interrupted turn retains its exact context for an explicit retry.
Partial responses remain visible. Conversation scrolling follows new responses
only while the owner is already at the end, with an explicit latest-response
action otherwise. Model selection and new chat remain disabled during a turn.

## Document boundary

This redesign keeps the document format and write authority unchanged. Canonical source, sanitization,
source snapshots, write guards, legacy visibility, link resolution and HTML
isolation remain governed by PDC and `docs/PDC-MIGRATION.md`. Authored HTML and
document bodies do not receive shell glass styling.

## Exports

CSS tokens: [`tokens.css`](tokens.css). Existing Tailwind utilities keep their
semantic names and resolve to the same values; new components consume these
variables directly. Fonts, light/dark colors, spacing, radii and motion are
exported in that file.

Copyable export adapters (keep `tokens.css` beside the destination stylesheet):

```css
/* Plain CSS */
@import "./tokens.css";
```

```css
/* Tailwind v4: map into the destination's utility names. */
@theme inline {
  --color-background: var(--color-paper);
  --color-foreground: var(--color-ink);
  --color-primary: var(--color-accent);
  --color-primary-foreground: var(--color-interactive-primary-foreground);
  --color-border: var(--color-rule);
  --font-body: var(--font-sans);
  --spacing-content: var(--space-6);
  --radius-panel: var(--radius-2xl);
}
```

```json
{
  "color": {
    "paper": { "$type": "color", "$value": { "colorSpace": "oklch", "components": [0.99, 0, 0], "alpha": 1 } },
    "ink": { "$type": "color", "$value": { "colorSpace": "oklch", "components": [0.25, 0, 0], "alpha": 1 } },
    "accent": { "$type": "color", "$value": { "colorSpace": "oklch", "components": [0.28, 0, 0], "alpha": 1 } }
  },
  "radius": {
    "control": { "$type": "dimension", "$value": { "value": 6, "unit": "px" } },
    "card": { "$type": "dimension", "$value": { "value": 8, "unit": "px" } },
    "panel": { "$type": "dimension", "$value": { "value": 12, "unit": "px" } }
  }
}
```

```css
/* shadcn adapter: use the destination's existing OKLCH convention. */
:root {
  --background: var(--color-paper);
  --foreground: var(--color-ink);
  --card: var(--color-surface-raised);
  --card-foreground: var(--color-ink);
  --popover: var(--color-glass-solid);
  --popover-foreground: var(--color-ink);
  --primary: var(--color-accent);
  --primary-foreground: var(--color-interactive-primary-foreground);
  --muted: var(--color-paper-2);
  --muted-foreground: var(--color-text-subtle);
  --border: var(--color-rule);
  --input: var(--color-rule);
  --ring: var(--color-focus);
  --radius: var(--radius-md);
}
```

## References

- [Apple: materials](https://developer.apple.com/design/human-interface-guidelines/materials)
- [Apple: macOS 27 design updates](https://developer.apple.com/videos/play/wwdc2026/289/)
