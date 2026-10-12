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

## Document boundary

This redesign changes presentation only. Canonical source, sanitization,
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
