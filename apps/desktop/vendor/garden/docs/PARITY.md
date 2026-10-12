# Garden UI Contract Map

Garden v0 has one shared UI implementation: React components in a Tauri 2 WebView. `contracts/ui-spec` is the layout contract; `contracts/behavior` is the interaction and feedback contract; `contracts/tokens/garden.tokens.json` is the token source. This file maps those contracts to the package exports and records the color vocabulary decision.

## Token vocabulary

Garden preserves three layers in one generated CSS sheet:

| Layer | Purpose | Examples |
| --- | --- | --- |
| Garden semantic | Stable token API generated from the contract | `--g-ink`, `--g-surface`, `--g-primary`, `--g-accent` |
| beautifului compatibility | Keeps the preserved MIT components usable | `--ink`, `--surface`, `--accent`, `--green` |
| shadcn compatibility | Supports the re-tokened primitive components | `--background`, `--foreground`, `--primary`, `--ring` |

The `--accent` collision is resolved deliberately. beautifului uses blue for focus and links; shadcn uses accent for hover fill. Garden emits beautifului's `--accent` as a compatibility value, leaves shadcn `--accent` undefined, and uses `--hover` for neutral hover states. Garden-owned focus indicators override blue field rings with neutral focus behavior; accent remains available for links and selection. Do not change the token resolution without a recorded token migration because both existing component families depend on it.

Garden primary actions use the inverse monochrome tokens. Text fields use caret and neutral background focus; keyboard-operable controls have a visible neutral-ink focus indicator. Links and selection may use the accent token. Borders use the existing alpha-mixed line tokens. Components use the CSS variables and spacing/radius/motion definitions generated from the token source; do not add one-off palette values to shell components.

## Shared component surface

| Export | Contract |
| --- | --- |
| `GAppShell` | Accessible app identity, localized landmarks, standard pane toggles and command launcher, context slots, sidebar, main content, right panel, bottom panel and composer. |
| `GTitleBar` | 46px toolbar with `left`, `center`, and `right` slots and a noninteractive Tauri drag surface. The host sets a macOS traffic-light inset when needed. |
| `GSettings` | Left section navigation and right content panel with tab semantics and keyboard movement. |
| `GCommandPalette` | Controlled or local open state, required localized string props, command list, filtering, Meta/Control+P, keyboard execution, focus containment, and focus restoration. |
| `Button`, `Badge`, `Card*`, form primitives | Small semantic surfaces; application copy and labels are supplied by the caller. |

Do not export the old product-specific cards, chat examples, sample tasks, or other demo components as general framework APIs. They remain available only in the playground's legacy route. New app copy belongs in the app's locale catalog. The component package must not contain Korean or English defaults for visible or accessible text.

## Layout measurements

The Codex app-bundle extraction is the source for the 46px toolbar, tokenized sidebar clamp, compact row density, inverse action, and feedback-channel behavior. Live Cassette and Obsidian captures, recorded in [the UI spec](../contracts/ui-spec/README.md), support keeping toolbar, navigation, ribbon, and document panes independent. Those captures are physical-pixel screenshots and do not supply CSS measurements.

## Generated bindings and vendoring

`contracts/tokens/garden.tokens.json` generates `packages/ui/src/styles/garden.css` and `packages/ui/src/tokens.generated.ts`. `node scripts/build-tokens.mjs --check` fails if either committed output differs from generated content. The vendor stylesheet and MIT notice stay in `packages/ui/vendor` and `docs/LICENSE-beautifului.txt`. Garden-owned token and shell rules are generated or maintained beside the package; upstream vendor text is left intact.

Generated templates copy the package and contract files into the application repository. Library internals use relative imports so a vendored package does not rely on the private Garden workspace or an implicit `@/` alias.
