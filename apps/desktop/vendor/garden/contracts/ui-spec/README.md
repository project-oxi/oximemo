# Garden UI Contract

This contract defines the shared interface for Garden's React applications running in a Tauri 2 webview. The overarching [personal framework standard](../framework/README.md) governs stack, layout, prohibited patterns and deliberate exceptions. Its machine-readable UI summary is [contract.json](./contract.json); color, spacing, radius, and motion values come from [the token source](../tokens/garden.tokens.json). The implementation lives in `@garden/ui`.

## Primary window

The primary window uses a platform-adaptive titlebar. On macOS, retain the decorated `NSWindow` and use Tauri's native titlebar overlay so the operating system owns traffic lights and outer window curvature. On other desktop platforms, use `decorations: false` and Garden's custom titlebar. `GTitleBar` is 46 CSS pixels tall. `GAppShell` supplies a left navigation toggle, an upper-right field-like command launcher and an optional right pane toggle. Additional slots carry history, actual workspace/task context and contextual actions. No slot, app header, sidebar or activity rail may display an app title, logo or wordmark. Only the empty titlebar surface is draggable; controls in all three slots remain clickable. Browser previews do not imitate native traffic lights.

This follows Apple's guidance to use native windows and focus behavior where available, and WCAG's requirement that keyboard focus remain visible: [Apple HIG: Windows](https://developer.apple.com/design/human-interface-guidelines/windows), [Apple HIG: Focus and selection](https://developer.apple.com/design/human-interface-guidelines/focus-and-selection/), and [WCAG 2.1: Focus Visible](https://www.w3.org/WAI/WCAG21/Understanding/focus-visible.html).

Below the titlebar, `GAppShell` arranges optional navigation and support regions around the main content. Multi-workspace apps MUST use a primary activity rail for major workspaces and a separately collapsible sidebar for destinations within the selected workspace. Single-workspace apps may omit the rail.

| Region | Placement and rule |
| --- | --- |
| Activity rail | Primary left edge. Use `GActivityRail` to select a major workspace; it remains visible when the contextual sidebar is collapsed. Omit only when the app has one workspace. |
| Sidebar | Between the activity rail (when present) and main surface. Use for destinations within the selected workspace, not as a replacement for the rail in multi-workspace apps. Rail and sidebar are different levels of classification: the sidebar reflects the rail's current selection and never re-lists every workspace's destinations. The width follows the sidebar token clamp and collapses on narrow windows. |
| Main content | Fills remaining space, owns the primary task, and scrolls independently. Keep minimum width at zero so tables and documents can constrain their own overflow. |
| Right panel | Optional, beside the main content. Reserve it for details tied to the current selection or task. Hide or stack it when the window is narrow. |
| Bottom panel | Optional, below main and right content. Reserve it for terminal output, diagnostics, or task activity. It has one scroll region and a bounded height. |
| Composer | Optional, docked to the bottom of the main region and above the bottom panel. It never covers the sidebar or the right panel. |

Keep surfaces visually connected: a one-step background shift and a hairline are enough to separate the sidebar and support panels. Use tokens for all colors, spacing, corners, and elevation. Primary actions use inverse monochrome fill. Text fields show focus through the caret without changing the surface or border and without a perimeter ring. Keyboard-focused actions and navigation retain a visible neutral-ink indicator; links and selection may use the accent token. Garden controls use existing radius tokens, with a superellipse shape only where the browser supports it. Do not assign a CSS radius to the macOS window itself; its curvature belongs to `NSWindow`.

## Settings window

Settings is a separate Tauri window opened by the host. The content uses `GSettings`: a left section list and a right scrollable form. The section list has a tablist and tab semantics, supports Up/Down movement, and identifies the selected section. Each form groups related values under a visible heading. Keep save behavior explicit: immediate preferences may apply on change, while multi-field forms need a visible save action and pending/error state.

## Command palette

Every Garden UI app mounts one command registry in its primary shell. The shell provides a field-like command launcher at the upper right, wired to the same palette as the shortcut; apps do not duplicate it in navigation. `GCommandPalette` binds Meta+P on macOS and Control+P elsewhere, filters by label, group, description, and keywords, and supports Up/Down, Enter, and Escape. It is modal: focus enters search, remains inside the palette, and returns to its previous element when the palette closes. Every action has a localized visible label; shortcuts are hints, not the only description of an action. The host supplies all labels through its locale catalog.

## Feedback and overlays

Follow [behavior/README.md](../behavior/README.md) for the channel contract:

- Use a toast for a completed reversible action, and include Undo when reversal is useful. Garden toasts dismiss after five seconds unless the user is acting on them.
- Use one banner slot for persistent warnings or service state. Place it above the composer or at the top of the relevant content region; do not stack banners.
- Put an inline error beside the section that failed. Retry stays in that section and reflects pending state.
- Put an empty state inside the content region it explains. Give it a short title and one useful next step.
- Use an overlay for a blocking decision or brief task. Trap and restore focus, close on Escape when the operation allows it, and avoid layering multiple error surfaces for one failure.

The original Codex channel distribution and recovery behavior are documented in `docs/EXPERIENCE.md`. Framework components accept their user-facing text as props. App-owned text belongs in `locales/ko.json` and `locales/en.json`, with English as the missing-key fallback.

## Desktop shell surfaces

| Surface | Tauri mapping | Contract |
| --- | --- | --- |
| Pet overlay | Core `WebviewWindow` configuration and window APIs | A transparent, undecorated, always-on-top window with explicit position, size, and focus policy. Keep it click-through only when the pet is not interactive. |
| Tray | `@tauri-apps/api/tray` / Rust `TrayIconBuilder` | Owns app visibility and a small set of top-level actions. Mirror important actions in the app and command palette. |
| Quick chat | A small core `WebviewWindow` | Reuse the shared composer and command model. Keep keyboard focus behavior explicit when shown and dismissed. |
| Global shortcut | `tauri-plugin-global-shortcut` | Register only user-visible shortcuts. Handle conflicts and allow the user to change or disable them. |
| Window placement persistence | Optional `tauri-plugin-window-state` | Adopt only when restoring position and size is part of the app's behavior; validate restored bounds before showing. |

Window creation and native permissions stay in the Rust host. A web component may request a shell action through the app's typed bridge, but it does not call Tauri internals directly. Review capability permissions in the app manifest whenever a plugin is enabled. Primary references: [Tauri global shortcut](https://v2.tauri.app/plugin/global-shortcut/), [tray API](https://v2.tauri.app/reference/javascript/api/namespacetray/), [WebviewWindow API](https://v2.tauri.app/reference/javascript/api/namespacewebviewwindow/), and [Tauri window configuration](https://v2.tauri.app/reference/config/#windowconfig).

## Reference measurements

Measurements were captured on 2026-09-27. Screenshot dimensions are physical pixels; they are evidence about visual grouping and relative emphasis, not CSS points or values to copy into Garden.

| App and version | Captured image | Observed structure | Design implication |
| --- | --- | --- | --- |
| Codex desktop, ChatGPT.app v26.917.71314 | Source evidence: [EXPERIENCE.md](../../docs/EXPERIENCE.md) and `docs/extraction/*` | Quiet monochrome chrome, a compact floating toolbar, persistent navigation, and content-centered composer. The token recipe records the 46 CSS-pixel toolbar and tokenized sidebar sizing. | Use as the visual and feedback-channel source for the Garden shell. Preserve the inverse primary action and subdued panel boundaries. |
| Cassette | Live capture, 2360×1560 px | Top bar measured about 88 px; sidebar about 488 px. | A persistent top region and broad navigation rail are legible at this image size. These pixel counts do not set CSS dimensions. |
| Obsidian 1.13.7 | Live capture, 2048×1600 px | Toolbar about 80 px; ribbon about 88 px; file pane ends near x=688 px. | Tool rails, navigation, and document panes are independent regions. Garden maps that pattern to optional sidebar and support panels. |

Only app chrome and layout grouping informed this contract. User document contents from the live captures were not copied. Obsidian properties, Dataview, and Bases were investigated for the separate Markdown contract; they do not determine Garden's document syntax.

## Implementation surface

`@garden/ui` exports shell, page, navigation, settings, form, data, composer and feedback components. [components.md](./components.md) defines the recommended component for each responsibility and the boundary between public APIs and reference specimens. The playground renders these APIs in its working scenes and component catalog; `?view=legacy` retains the pre-framework gallery as a migration fixture, not a source of default framework copy.

The public component catalog also includes reusable navigation, calendar/date selection, searchable selection, tables, form helpers, side sheets, and application patterns. [The catalog adoption decision](../../docs/decisions/ui-catalog-adoption-2026-09-27.md) records reference comparisons, provenance, default APIs, and excluded specialty effects. These controls use the same tokens and behavior contract; they do not introduce alternate theme, routing, or document systems.

## Layout primitives and spacing

[layout.md](./layout.md) defines region ownership, settings row composition, spacing tokens, document surfaces, and focus behavior for all adopters. Page-level CSS must not substitute its own shell geometry for these framework rules.
