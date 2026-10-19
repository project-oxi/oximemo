# Playground workbench verification

Date: 2026-09-27

The playground now prioritizes the document editor, provides persistent compact navigation on narrow screens, and exposes the optional context panel through a labeled toggle. The shared shell stacks support panels at intermediate widths. Atomic content typography is explicitly bound to Garden tokens.

## Observed checks

- Browser: 320, 375, 414, 768, 1024, and 1280 CSS pixels. Document scroll width equaled viewport width at every size.
- English/Korean controls and light/dark themes rendered successfully. Mobile settings remained accessible from navigation.
- Command palette: filtered for settings and executed with Enter; General settings opened.
- Editor: appended text through the editable surface and confirmed it appeared in preserved source.
- Composer: submitted a message and observed it in the activity status; empty composer disabled submission.
- Context toggle: opened the labeled complementary panel.
- Computed editor body font size: 14px at every checked width.
- UI and editor TypeScript builds passed; playground TypeScript and Vite production build passed.
- `garden doctor`: healthy.

The playground remains session-only. The production build retains its existing large-bundle advisory; code splitting was outside this visual change.
