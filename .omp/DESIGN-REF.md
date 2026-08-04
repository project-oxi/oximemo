# Design System Reference

> **Pointer file** — this project follows the **Oxi Ecosystem Unified Design System**.

`project-oxi/.github/DESIGN.md` — the unified design system for the oxi ecosystem (oximemo · oxipage · oxios).
v1.0 · 2026-07-31.

> Project-local snapshot of the same system (pre-canonical, design-farmer Phase 4.5): `doc/UNIFIED-DESIGN.md` — kept for reference; the canonical source is the path above.

It defines, with OKLCH values verified against real CSS across all three projects:

- **Color** — 3-tier OKLCH tokens (primitive → semantic → component), 6-hue label palette, APCA-optimized status colors, interactive-primary button fill
- **Typography** — SUIT (body) + SUITE (headline) + Geist Mono (code); no serif
- **Spacing / Radius / Elevation** — 4px grid, tier-based radius, 4-level shadows
- **Components** — Card, Button, Input, Dialog, Badge, Sidebar, Popover specs
- **Theming** — `.dark` class single trigger, `oxi-theme` storage key, FOUC prevention
- **Motion** — duration/easing tokens, reduced-motion fallbacks
- **Project adaptations** — §11 (oximemo is the primary reference)

## This project (oximemo)

oximemo is the **primary style reference** for the ecosystem. Its OKLCH 6-hue label palette
(`apps/desktop/src/lib/color.ts`) is the source of the shared label system.

- Product/data/CLI design: `doc/DESIGN.md` (§7.1.1 now cross-references the unified typography)
- Visual tokens: this unified system

## Migration status

**Done (2026-08-04).** The desktop frontend is on the oxi token system:
`apps/desktop/src/tokens/` holds the primitive → dark-override → component tiers
(`primitives.css`, `semantic-dark.css`, `components.css`), and the Tailwind
`@theme`/`@custom-variant` exposure lives directly in `apps/desktop/src/app.css`
(this Tailwind v4 build does not process `@theme`/`@custom-variant` inside an
`@import`ed file, and `@theme` color values must reference primitives, not
themselves, for utilities to generate). Fonts are self-hosted (SUIT/SUITE woff2
in `public/fonts/`; Geist Mono via `@fontsource-variable/geist-mono`), with a
FOUC script in `index.html` keyed on `oxi-theme`. All 16 components consume
semantic utilities only — no `dark:` variants, no `zinc-*`/hex in component code
(the single exception is `bg-black/40` on the `MemoDetail` dialog backdrop,
which §6.7 of the design system prescribes verbatim). The `oxi-theme` storage
key replaces the former `oximemo.theme`.
