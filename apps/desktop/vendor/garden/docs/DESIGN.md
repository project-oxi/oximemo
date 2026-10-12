# Garden design

The [personal framework standard](../contracts/framework/README.md) defines the
complete app contract. This page summarizes its visual system. The normative
values live in [garden.tokens.json](../contracts/tokens/garden.tokens.json),
[layout.md](../contracts/ui-spec/layout.md) and
[components.md](../contracts/ui-spec/components.md). Historical extraction
observations remain in [EXPERIENCE.md](./EXPERIENCE.md) and `extraction/`.

## Principles

| Concern | Rule |
| --- | --- |
| Chrome | One continuous monochrome titlebar, rail and sidebar; one inset workspace |
| Identity | No app name, logo or wordmark in app chrome; actual workspace/task names are useful context |
| Toolbar | 46px, left pane toggle, upper-right command field and optional right pane toggle |
| Copy | Concise task titles and actions; no filler subtitle, greeting or promotional narration |
| Primary action | Inverse monochrome; blue never supplies the primary button fill |
| Hierarchy | Semantic surfaces and foreground opacity, with restrained heading sizes |
| Borders | Foreground alpha at 8% or 12%; hairline depth and quiet shadows |
| Text focus | Caret and selection with a stable field surface and border, no perimeter ring |
| Control focus | Visible neutral keyboard indicator; accent reserved for links/selection |
| Geometry | Shared spacing and semantic radius tokens; no page-local primitive overrides |
| Themes | Existing symmetric light/dark ramp; status color limited to semantic indicators |
| Motion | Shared duration/curve tokens and reduced-motion support |

## Token pipeline

```text
contracts/tokens/garden.tokens.json
    → scripts/build-tokens.mjs
        → packages/ui/src/styles/garden.css
        → packages/ui/src/tokens.generated.ts
    → Garden --g-* variables
        → preserved beautifului vocabulary
        → shadcn-compatible vocabulary and Tailwind mappings
```

There is one active React UI implementation. The former SwiftUI implementation
is archived and has no current generated binding. `--accent` retains its blue
compatibility meaning; neutral hover uses `--hover`. See [PARITY.md](./PARITY.md).

Use `chip` (6px), `control` (8px), `card` (10px), `xl` (15px), `composer` (28px)
and pill radii by role. Layout may use the existing `lg` token. The OS owns native
window corners. UI text is 13px, body 14px, caption/code 12px and headings use the
18/20/24px scale. The 4px spacing scale does not imply that every measured control
height must be a multiple of four; the toolbar and navigation have their own
contract values.

## Composition

`GAppShell` owns the titlebar, navigation, inset workspace and scroll regions.
`GPage` owns width. `GSettings` owns settings geometry. `GConversation` owns the
transcript and composer. `GDocumentEditor` owns the continuous properties/body
composition; do not wrap it in an extra card. Field help belongs near the field
and explains a concrete constraint; it is not a required page decoration.

Shared shadcn/Radix controls are maintained inside `@garden/ui`. App styles may
express domain content but must not establish competing focus, spacing, radius,
selection or control rules. Explicit per-app deviations follow the framework's
manifest/ADR mechanism. Preservation and accessibility remain mandatory.

## Provenance

The original visual source is the Codex desktop extraction recorded in
`EXPERIENCE.md`. The preserved BeautifulUI topology and source include their MIT
attribution to Shane Levine. shadcn/ui conventions and Radix accessible primitives
underlie the shared control layer. Garden's current normative choices supersede
historical observations when they differ; no new live Codex measurement is
claimed by this standardization.
