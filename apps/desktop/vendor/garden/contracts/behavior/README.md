# UI Behavior Contract

This contract is the shared behavior layer consumed by `@garden/ui` and the app playbook. [contract.json](./contract.json) is the machine-readable channel and keyboard summary. User-facing copy comes from app locale catalogs or explicit component props.

## Feedback channel selection

Choose the smallest surface that matches the lifetime and scope of the feedback:

| Trigger | Surface | Required behavior |
| --- | --- | --- |
| Reversible change completed | Toast | State what changed. Offer Undo when useful. Dismiss after five seconds when idle. |
| Warning remains relevant | One banner slot | Keep one persistent message visible in the affected window. Dismiss only when the condition clears or the user can safely dismiss it. |
| A section or form operation fails | Inline error | Place the cause near the failing section. Keep retry and pending state local. |
| A blocking decision is needed | Modal overlay | Keep focus inside, name the decision, support Escape when safe, and restore focus to the trigger. |
| No items match or content is absent | Empty state | Explain the situation in the affected content area and give a useful next step. |

Do not show a toast, banner, and inline error for the same event. A failure is data attached to the operation or section; it is not a new global state for the whole app. Keep destructive recovery screens outside ordinary overlays.

## Keyboard and focus

The command palette uses Meta+P on macOS and Control+P elsewhere. Up and Down move the active command, Enter runs it, and Escape closes the palette. The search field receives initial focus. Tab and Shift+Tab remain within the dialog, and dismissal restores focus to the element active before opening. Native titlebar actions stay outside the drag region.

For settings section navigation, expose tab semantics and support Up/Down. Text inputs, textareas, and editable text use the caret without changing the surface or border and without a perimeter ring. Keyboard-focused selects, noneditable comboboxes, buttons, links, tabs, and other actions keep a visible neutral-ink outline; accent color remains available for links and selection. Respect `prefers-reduced-motion` by removing nonessential transitions and animations. Do not use color alone to signal selected, failed, or pending state.

## Localization and accessibility

Framework components do not supply hidden Korean or English defaults for labels, placeholders, close actions, or empty states. Callers pass localized strings. Applications keep `locales/ko.json` and `locales/en.json`; English is the fallback for missing keys. Icon-only controls and landmarks have accessible names, icon glyphs are hidden from assistive technology when adjacent text already names them, and every dialog has a localized accessible name.
