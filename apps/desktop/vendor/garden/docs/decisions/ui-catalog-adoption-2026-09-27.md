# Broad component catalog adoption

Status: implemented selection; runtime evidence is recorded separately.

Garden favors broad, reusable application coverage over the smallest possible catalog. New defaults are public exports of `@garden/ui`, styled by `@garden/ui/styles.css`, and demonstrated in the shared component catalog. They use Garden tokens, caller-owned text, native controls or existing Radix primitives, and reduced-motion behavior. They do not add a second theme system, router, document parser, or animation runtime.

## References and provenance

- [Great UI catalog](https://www.great-ui.com/components): 50 entries reviewed by family on September 27, 2026.
- [Great UI root license](https://github.com/Saurabh-2607/GreatUI/blob/main/LICENSE): the custom license explicitly excludes redistribution as a component library and derivative framework. Some README/component headers still say MIT; those statements are not used to authorize source reuse.
- [Watermelon base catalog](https://ui.watermelon.sh/components), [animated catalog](https://ui.watermelon.sh/animated-components), and [home](https://ui.watermelon.sh/home): application patterns and family coverage references. The live summary reported 851 examples, including 516 base examples and 131 animated examples; these are changing catalog counts, not distinct Garden APIs.
- [Watermelon registry license](https://github.com/WatermelonCorp/watermellon-registry/blob/main/LICENSE) and [platform license](https://github.com/WatermelonCorp/watermelon-platform/blob/main/LICENSE): MIT. A future source import must retain the corresponding copyright and license notice and inspect third-party assets separately.

The components added in this change are original Garden implementations of general UI patterns. No Great UI or Watermelon source, images, logos, stylesheets, registry payloads, or fonts are vendored. Reference links describe design research, not an upstream source fork or API compatibility guarantee.

## Great UI decisions

| Catalog entries | Garden decision and reason |
| --- | --- |
| Avatar Stack | Add `AvatarStack`: bounded visual stack, image fallback, names retained for assistive technology, localized overflow summary. |
| Revision Timeline | Add `RevisionTimeline`: caller order and same-day revisions preserved, controlled or internal selection, keyboard selectors, empty state. The caller renders `ReactNode` content; the component does not invent a Markdown parser. |
| Deployment Checklist | Add domain-neutral `Checklist`: controlled checkboxes, descriptions, disabled/read-only behavior, progress summary. |
| Floating Dock Menu, Floating Menu | Add one `FloatingDock` action toolbar; existing Popover/Dropdown Menu cover disclosure menus. No fixed viewport placement is imposed. |
| Terminal Loader | Add `TerminalOutput` for real host-supplied output and explicit lifecycle state. Existing loading indicators remain available. |
| Scrambled Install Command | Add `CopyCommand`: exact, readable command and reliable copy/error feedback. Do not scramble executable text or execute it. |
| Animated Link | Add a native `AnimatedLink` with restrained underline feedback and normal link behavior. |
| Text Reveal, Blur Scroll Reveal, Split Line Fly In, Word Focus Scroll, Pixel Swipe Text | Provide one optional `TextReveal` mount transition. Keep content intact for reading and assistive technology; do not add five overlapping reveal systems or blur content while scrolling. |
| Button, Minimal Buttons, Aceternity Button | Retain Garden Button and variants: inverse primary fill, native disabled state, Radix composition, compatible existing call sites. Fancy button effects do not replace the base action control. |
| Card, Accordion | Retain existing Card and Radix Accordion. Expose Accordion through the public package entry point. |
| GitHub, Instagram, Facebook, Twitter/X, LinkedIn cards; Team Section | Compose existing Card and AvatarStack with app-owned content. Provider logos, live provider data, marketing copy, and five branded variants are not framework defaults. |
| Macbook Mockup, Mobile Mockup | Exclude device advertising frames from the application-control layer. |
| Pixel to ASCII Image, Image Hover Reveal, Animated Path, Scroll Flying Cards, Radial Gooey Menu | Exclude specialty art, scroll hijacking, and distortion-driven navigation. They do not fill a missing everyday control. |
| Multilingual Quote, Text on Path Scroll | Exclude rotating showcase copy and decorative path text. Localization is explicit; reading order stays stable. |
| Diagonal Marquee Carousel, Vinyl Album Card | Exclude perpetual promotional motion and a domain-specific decorative media card. |
| CrossBlur, Venetian Blinds, Cascade, Sine Wave, Pixel, Sweep, Interlocking, Curtain, Color Wipe, Staggered, Pixel Swipe page transitions | Retain normal host navigation; full-page transition overlays and router coupling are not application defaults. |
| Blur Fade, Split, Circular, Swipe theme transitions | Retain the existing host-controlled theme. Do not introduce competing theme providers or animated full-window wipes. |

## Watermelon decisions

| Family | Garden default |
| --- | --- |
| Breadcrumb | `Breadcrumb`: semantic location trail, ordinary links, current-page text. |
| Button Group | `ButtonGroup`: named group of existing buttons; host owns selection or actions. |
| Calendar, Date Picker | Shared `Calendar` and `DatePicker`: controlled ISO date values, locale formatting, date bounds, keyboard day selection and popover composition. |
| Collapsible | `Collapsible`: native details/summary with keyboard and disclosure semantics. |
| Combobox | `Combobox`: filtered single selection, active descendant, disabled options, empty results, keyboard and outside dismissal. |
| Data Table, Table | `DataTable` adds stable sortable columns; `Table` provides semantic composition. Filtering, pagination and data fetching stay with the host. |
| Form | `FormField`: explicit label/help/error relationships, required state and render-prop control wiring. |
| Input OTP | `InputOTP`: one real numeric-text input preserves paste, autofill and screen-reader editing. No fake multi-input focus trap. |
| Pagination | `Pagination`: bounded page window, current-page state, explicit callbacks and boundary controls. |
| Sheet | `Sheet`: existing Radix Dialog focus management, labelled close control, left/right presentation and narrow-screen bounds. |
| Adaptive Slider | `Slider`: a labelled native range with localized value formatting; no decorative morphing necessary. |
| Accordion, Alerts, Avatar, Badge, Button, Card, Checkbox, Dialog, Dropdown Menu, Popover, Radio Group, Select, Sonner, Switch, Tabs, Textarea, Tooltip | Retain the matching existing Garden primitives or feedback channels. Avoid importing dozens of visual duplicates or a second toast provider. Existing reusable Avatar, Accordion, Tabs, Tooltip, Popover, Progress, RadioGroup, ScrollArea, Alert and Skeleton APIs are made available through the package root. |
| Input Mask | Defer until a concrete locale/domain format is needed. A universal mask can silently damage names, phone numbers, numbers or IME input. |
| Marketing blocks, full dashboards/templates, decorative animated variants | Keep composition in app pages; useful underlying controls are covered above. Do not bake authentication backends, billing flows, fabricated metrics, brand assets or perpetual effects into a control library. |

## Consumer contract

Import components from `@garden/ui` and include `@garden/ui/styles.css` once. Applications supply visible and accessible text through props, plus `en` or `ko` for calendar date formatting. Item IDs and option values must be stable and unique. Controlled values stay with the host. Components never submit to a backend, execute a shell command, fetch profile data, or persist document content.

`FormField` passes ID/ARIA props through its render function; spread them onto the labelled native input. `CopyCommand.onCopy` can bridge a native clipboard and must reject on failure. `TerminalOutput` displays supplied text and status only. `RevisionTimeline.content` is already-rendered content; document rendering remains the host's responsibility. `DataTable` sorts a derived array and preserves caller rows. Optional motion is disabled by `prefers-reduced-motion`.

The playground catalogs 45 existing demos plus 8 patterns and 13 utilities. Reference-derived defaults are reachable through search and categories rather than only through internal source aliases. New example text is in matching English/Korean locale catalogs. Every new family must have a demonstrated running-app happy path; keyboard, empty/disabled and error paths supplement build checks where relevant.
