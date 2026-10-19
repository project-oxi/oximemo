# Garden application layout

Status: normative, `garden-ui/1`.

The token source is `contracts/tokens/garden.tokens.json`. Run `node scripts/build-tokens.mjs` after changing it. Applications consume generated variables; they must not redefine spacing or focus rules in page styles.

## Surfaces and ownership

- The OS owns the outer desktop window and native macOS traffic lights. The toolbar is 46 CSS px.
- `GAppShell` owns the primary activity rail, contextual navigation sidebar, main region, composer, right support panel, and bottom activity panel. Multi-workspace apps MUST keep the rail and sidebar as separate regions; collapsing the sidebar does not hide the rail. Every region has `min-width: 0`; main, panel, and settings content own their scrolling.
- Full-height conversations use `contentLayout="fill"` and `contentPadding="none"`. `GConversation` owns one transcript scrollbar and its bottom composer; both share the reading-width token. The shell retains navigation and optional support-region ownership.
- Documents are a continuous canvas. A document is not a card inside another card. Properties precede the editable body. Technical envelope fields belong in a disclosure, not in the initial writing surface.
- The right panel is optional and controlled. It presents context tied to the current selection, has a labeled close action, and does not cover the editor. It stacks beneath the task when available width cannot support both panes.
- Compact navigation remains reachable on narrow screens. Each action has a text or localized accessible label; selected state is conveyed with ARIA as well as appearance.
- Settings reuse the same section/group/row components in a host-created settings window or the playground's embedded preview. The playground is not evidence that a browser page creates native windows.

## Spacing and type

| Role | Token | CSS px |
| --- | --- | ---: |
| Base spacing | `--g-space-1` | 4 |
| Related controls / field label gap | `--g-layout-field-gap` | 8 |
| Row / compact gutter | `--g-layout-row-gap`, `--g-layout-page-gutter-compact` | 16 |
| Related groups | `--g-layout-group-gap` | 24 |
| Page gutter / section separation | `--g-layout-page-gutter`, `--g-layout-section-gap` | 32 |
| General page max width | `--g-layout-content-max` | 960 |
| Document reading max width | `--g-layout-document-max` | 760 |
| Settings form max width | `--g-layout-settings-max` | 760 |
| Settings navigation width | `--g-layout-settings-nav` | 240 |
| Global activity rail | `--g-layout-rail-width` | 52 |
| Desktop settings top inset | `--g-layout-settings-top-padding` | 72 |
| Context panel width | `--g-layout-panel-width` | 300 |
| Property label column | `--g-layout-property-label-width` | 144 |
| Minimum settings row | `--g-layout-settings-row-min-height` | 64 |

Use the 4/8/12/16/20/24/32/40/48/64 spacing scale. UI copy uses 13px, body 14px, code 12px, caption 12px; headings use the existing 18/20/24px scale. Long values wrap or scroll within their region; they must not enlarge the application viewport.

## Settings

`GSettings` provides section navigation and one active panel. Each `GSettingsGroup` has a heading and optional description; each `GSettingsRow` pairs a visible label/description with its control. Rows use hairline separators, not separate cards. Controls align consistently at the trailing edge and stack below labels in narrow containers. Native inputs must have associated labels. Immediate preferences apply on change; multi-field transactions need explicit Save, pending, and local failure feedback.

## Focus and state

Text editing does not change the background of a field, document, card, or panel. Focus does not remove or recolor its border. The caret and text selection identify the editing position; keyboard actions retain a visible neutral outline. Focus must not change layout or trigger a card elevation. Selection, hover, disabled, pending, and error are distinct states. `prefers-reduced-motion` disables nonessential motion.

Native selects and noneditable comboboxes have no caret and retain the neutral keyboard outline. Closing a support panel returns keyboard focus to its controlling button. Document-local property drafts must reset when document identity changes; committing a list item must retain the list input's focus.

## Component responsibility

Reusable page and navigation APIs, composition examples and the boundary between
public components and preserved specimens are defined in [components.md](./components.md).
`GPage` constrains width without adding gutters. `GPageHeader` owns heading/action
flow. `GSplitLayout` handles page-local support content and stacks at 780px of
available container width. `GNavigation` and `GActivityRail` own reusable
navigation presentation; apps supply destinations and labels.

| Component | Responsibility | Application responsibility |
| --- | --- | --- |
| `GAppShell`, `GTitleBar` | Region geometry, toolbar, scroll ownership | Region content, commands, native host |
| `GPanel` | Context header, close control, scroll body | Selected item's details and visibility |
| `GSettings` | Section selection and keyboard navigation | Sections, controlled active section |
| `GSettingsGroup`, `GSettingsRow` | Form hierarchy and consistent spacing | Labels, descriptions, form state |
| `GDocumentEditor` | Properties/body/source presentation | Source ownership and guarded persistence |
| `GDocumentProperties` | Standalone typed metadata projection using the same guarded source patches | Full source ownership, identity and persistence |
| `GQueryView` | Read-only query results and diagnostics | Explicit enablement and document scope |
| Primitive inputs, buttons, switches | Control state and token styling | Localized accessible names and actions |

## Evidence

Existing Codex extraction: `docs/EXPERIENCE.md` and the installed `codex-design` recipes. On 2026-09-27 Computer Use denied access to `com.openai.codex`; no new live Codex measurements are claimed here. The spacing table above is Garden's normative design choice, not a claim about measured Codex pixels. The running playground verifies Garden's implementation.

## User screenshot adoption (2026-09-27)

Six user-provided Codex captures show a persistent global icon rail, independently collapsible contextual sidebar, constrained reading column, inset support card, broad library surface, and settings with full-height left navigation and a centered form. These are observations from supplied images, not live Computer Use measurements. Approximate proportions are normalized to existing CSS tokens; OS chrome and exact screenshot pixels are not copied into web content.

`GAppShell.activityRail` accepts application-owned labeled navigation. `sidebarOpen` controls contextual navigation separately; the host must retain an accessible toggle when collapsed. `rightPanelPresentation="inset"` selects a content-height context card; `docked` remains the default for tools needing the full height. The rail remains available in settings. Settings navigation is flush to the left of the available surface; only the form is constrained. Grouped rows share one rounded surface and inset separators. Library-width content uses the general page profile rather than the reading profile. No fictional library or chat data is added simply to mimic the screenshots.

## Continuous desktop chrome

The activity rail, navigation, and titlebar share `--g-page` without dividing strokes. The main workspace is one rounded `--g-canvas` surface inset by the shared 8px spacing token. Its main content, supporting panel, composer, and activity region share one clipping/scroll ownership boundary. Never give the titlebar a separate canvas stripe. Keep reading width independent of overall workspace width.

The standard toolbar has a left navigation toggle and an upper-right command field followed by a right pane toggle when that pane exists. `GAppShell` supplies these controls; app slots add actual history or task context. The command field and keyboard shortcut open the same registry. No app title, logo or wordmark appears in titlebars, headers, sidebars or activity rails. Language and theme are preferences inside settings, not persistent toolbar buttons. Global icon navigation retains accessible labels and current state.

Page headers default to a concise task title and relevant actions. Do not add greetings, conversational filler, promotional claims or a subtitle that merely restates the title. Optional descriptions must convey a concrete constraint or consequence. Keep implementation details in explicit reference/technical views. See the [framework standard](../framework/README.md) for the complete prohibited-pattern list and exception mechanism.

## Product references

- User-supplied Codex screenshots establish chrome continuity and constrained working surfaces; no live-app access was used.
- [Obsidian properties](https://obsidian.md/help/properties) informs typed rows and an explicit property type chooser.
- [Notion properties](https://www.notion.com/help/database-properties) informs name/type/value creation flow.
- [Beautiful UI](https://www.beautifului.dev/) is the origin of the existing AI component demos. Keep the actual catalog reachable within the shared shell; do not replace it with a handful of generic controls or hide it behind a legacy route.

## Form control detail

Shared single-choice fields use `SelectField` (or the composable Select primitives): a 32px trigger, tokenized field surface, 6px popup offset, a checked-item indicator, and a filled keyboard-active row. Compact triggers are 28px. Arrow keys, typeahead, Enter, and Escape remain owned by the accessible primitive. Callers supply the accessible name and option text. Native select integrations use `data-slot="native-select"` for the same field treatment while retaining platform popup behavior.

Checkboxes use an 18px token-rounded well and inverse monochrome selection, with a check for selected and a dash for indeterminate. Both controlled and uncontrolled indeterminate states must display the dash. Native integrations use `data-slot="native-checkbox"`. Switches use a 36×22px track and an 18px thumb, with equal end insets. Radio groups retain circular indicators. Disabled controls remain legible, invalid fields retain a separate error border, and keyboard focus does not darken the surrounding card. Reduced-motion and forced-colors preferences are respected. Group labels should extend the practical activation area around compact controls.

## Navigation selection shape

Settings sections and sidebar document links share `g-navigation-item`: a pill radius, 32px minimum height, 5px vertical and 10px horizontal padding, and the same quiet hover and selected surfaces. Use `aria-selected="true"` for selected tabs and a non-false `aria-current` for current navigation destinations. Keep this shared style for single-selection navigation; dense data-table rows retain their table-specific treatment. Icon-only activity-rail actions remain distinct controls.
