# Standardizing the playground as a framework consumer

Date: 2026-09-27. Status: accepted.

## Problem and decision

The playground had become the visual baseline, but several of its behaviors and
layouts were private implementations beside reusable library components. A new
adopter could choose an older sample component, copy page CSS, or deep-import a
feedback primitive because no public default was clear.

The framework owns shared behavior and geometry. Working playground scenes
consume the public package. Preserve useful visual details from those scenes,
prefer existing semantic/accessibility primitives, and keep domain sample data
in the application. The normative selection guide is
[components.md](../../contracts/ui-spec/components.md).

## Comparison and outcomes

| Area | Playground advantage | Existing shared implementation advantage | Decision |
| --- | --- | --- | --- |
| Page width and headings | Consistent 960/760px widths and compact action headers across scenes | Shell already owns gutters and scroll regions, but no page API | Extract `GPage` and `GPageHeader`; remove competing page/header CSS from App, Showcase and catalog. |
| Page-local support | Conversation and task details remain beside the work and stack on small containers | `GAppShell.rightPanel` and `GPanel` are suitable for persistent workspace tools | Add `GSplitLayout` for normal page flow, sharing the panel token. Keep persistent shell panels distinct. |
| Sidebar and rail | Quiet pill rows, current-page state, persistent global actions | Settings already shares `.g-navigation-item`; old SidebarNav has workspace switching/search/count examples | Extract `GNavigation*`/`GActivityRail*` from the current app pattern. Keep SidebarNav as a richer sample. Explicit rail footer replaces last-item positioning assumptions. |
| Modes, approval scope, filters | Compact inset segments and filter counts fit working scenes | RadioGroup offers exclusive choice, roving keyboard focus and disabled behavior; Tabs owns actual panel switching | Merge current appearance into `SegmentedControl` using Radix radio behavior. Do not use tab semantics for a value filter. |
| Composer | Controlled draft, localized send label, Shift+Enter and composition guard | GardenComposer demonstrates the tokenized composer surface and footer chips, but also hardcodes model/approval/location copy and sample behavior | Promote `GComposer`: controlled text, input label, caller footer, pending/disabled state and guarded submit. Keep GardenComposer as a specimen rather than importing its demo defaults. |
| Conversation | Assistant scene originally nested its transcript, input, sources and approval into competing cards/columns | Shared shell already owns bounded regions; the composer owns input semantics | Add public `GConversation`, `GConversationMessage` and `GConversationActivity`; use one reading column, a bottom composer, source popover and inline approval. Add shell `contentLayout="fill"` for explicit scroll ownership and a compatible conversation composer variant. Promote `TurnStream` as a supplied-data detail renderer; callers pass localized status labels. |
| Workspace table | Selection highlight, custom task/owner/progress cells, host filtering and detail actions | `Table` provides native markup and overflow; `DataTable` provides stable three-state sorting but no selected-row styling API | Adopt `Table` in workspace and standards. Keep domain cell renderers; use `DataTable` only when its sorting model is wanted. |
| Preferences | Feedback demo has working switch and text state | `GSettingsGroup`/`GSettingsRow` already provide consistent grouping, labels and responsive alignment | Adopt existing settings composition in the feedback scene and remove custom row geometry. |
| Commands | Current shell provides searchable app registry and focus return | Old CommandMenu carries array shortcut hints and onRun callbacks but duplicates filtering, keyboard and overlay logic | Adopt `GCommandPalette`; retain only a deprecated adapter for old props. Unique ARIA IDs, disabled skipping and explicit shortcut ownership work for embedded previews. |
| Feedback and overlays | Working scenes already exercise real banner, retry, toast and dialog behavior | Existing components are useful but lack public exports and contain implicit Korean action/region text | Promote existing primitives through `@garden/ui`, require caller labels, preserve the actual implementation. |
| Dense/agent specimens | Specialized visual examples and source provenance remain useful | Generic APIs avoid fixed datasets, fake actions, and product defaults | Keep TaskRows, SidebarNav, FilterTable, RecordsTable, Chat, PromptBar and GardenComposer as references. Do not export them as app defaults. |

`DiffTable` and line-oriented `Diff` are distinct views, not interchangeable
implementations. `Alert` is a static primitive; it does not replace the feedback
channel contract. Optional subcomponents such as `TableFooter`, `SelectGroup`,
`PopoverAnchor` and `ScrollBar` remain available without forcing meaningless use
into the playground.

## Public API and migration

- Load `@garden/ui/styles.css` once. New components use the existing token source;
  there is no second theme or provider system.
- Replace page max-width CSS with `GPage`, header flex rules with `GPageHeader`,
  and page-local support grids with `GSplitLayout`.
- Replace local nav buttons with `GNavigationItem`; use `asChild` for real links.
  Pass labeled `GActivityRailItem` children and an explicit footer.
- Replace exclusive pressed-button groups with `SegmentedControl`. Keep independent
  toggle actions as buttons and panel selection as Tabs.
- Replace custom message-entry markup with `GComposer`; apps retain the draft,
  request, clear-on-success and local failure policy.
- Import feedback and overlays from the package root. Dismissible banners require
  `dismissLabel`; retrying inline errors require `retryLabel`; DialogContent
  requires `closeLabel` unless its close button is omitted; ToastProvider requires
  `closeLabel` and `regionLabel`.
- Only the shell palette binds the global shortcut. Catalog previews set
  `bindShortcut={false}`. The compatibility CommandMenu delegates to this same
  component and requires a strings object.

These changes keep existing data/storage/document semantics intact. The legacy
catalog continues to show provenance and specialized patterns; it is not a
second implementation contract. Future promotions require the same comparison,
caller-owned labels and live verification.

## Verification

See [the verification record](../verification/ui-standardization-2026-09-27.md)
for build, tests and observed playground interactions.
