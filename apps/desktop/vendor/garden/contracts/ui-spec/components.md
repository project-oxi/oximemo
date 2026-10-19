# Component selection and composition

Status: normative, `garden-ui/1`.

The playground's current shell and working scenes are the visual baseline. Reuse
public `@garden/ui` components in those scenes and in adopting applications.
The package root is the supported API boundary. A file in `src/components` is not
automatically a recommended framework API: the preserved BeautifulUI specimens
also live there. Do not import their internal paths into a new application.

## Choose by responsibility

| Need | Use | Selection rule |
| --- | --- | --- |
| Primary application frame | `GAppShell`, `GTitleBar` | Own chrome, scrolling, gutters, pane toggles and top-right command launcher. Native window behavior stays in the host. No app branding in chrome. |
| Page width and heading | `GPage`, `GPageHeader` | Content = 960px, reading = 760px, full = available width. Header actions wrap and remain reachable. No default subtitle or filler explanation. |
| Page-local supporting content | `GSplitLayout` | Main content then a 300px support column; stack at 780px available container width. Use shell `rightPanel` for persistent workspace tools. |
| Navigation | `GActivityRail`, `GActivityRailItem`, `GNavigation`, `GNavigationGroup`, `GNavigationItem` | Multi-workspace apps MUST pair the rail for major workspace selection with a contextual sidebar for destinations in the selected workspace; rail and sidebar are different classification levels, so the sidebar never re-lists every workspace's destinations. The sidebar may collapse independently. Single-workspace apps may use `GNavigation` alone. Use `asChild` with an anchor/router link for URLs, buttons for local view changes. |
| Settings | `GSettings`, `GSettingsGroup`, `GSettingsRow` | Full settings owns its gutters; grouped rows also work in a page-local section. Associate controls with `htmlFor`. |
| Actions | `Button` | One inverse primary action per decision group; outline/secondary for alternatives, ghost for quiet tools. Use `type="button"` for non-submit actions in forms. |
| Field input | `Input`, `Textarea`, `FormField` | FormField associates label/help/error. SettingsRow provides settings alignment. Host owns validation and saving. |
| Single choice | `SelectField`, `Combobox`, `RadioGroup` | Select for compact lists, Combobox for search, radios when choices need simultaneous visibility. |
| Compact exclusive choice | `SegmentedControl` | One value: mode, scope or filter. Radio semantics and arrow navigation; `Tabs` remains for switching tab panels. |
| Boolean/multiple choice | `Switch`, `Checkbox` | Switch for an immediate preference; Checkbox for independently selected items or mixed state. |
| Message draft | `GComposer` | Controlled text, caller labels and footer. Enter submits, Shift+Enter inserts a newline, composition does not submit. Host owns sending, clearing, pending and failures. |
| Conversation layout | `GConversation`, `GConversationMessage`, `GConversationActivity` | One scrolling transcript, a shared reading width, and a docked composer. User messages use a trailing bubble; assistant responses remain open prose. Completed activity is disclosed on demand. |
| Native data table | `Table` family | Custom cells, explicit selection buttons and host-owned filtering. No div-based imitation table. |
| Sortable records | `DataTable` | Add local stable sorting when needed. Host owns fetching, filtering and pagination. No second table sorting engine. |
| Card | `Card` family | Bounded object or summary. Do not wrap a continuous document or every settings row in cards. |
| Persistent support | `GPanel` | Header, scroll body and optional labeled close action. Respect shell focus return. |
| Document editing | `GDocumentEditor` from `@garden/editor` | Full source-backed title/properties/body with technical/source disclosures; host owns guarded persistence. |
| Standalone properties | `GDocumentProperties` from `@garden/editor` | Reuse the document editor's property behavior in a panel; keep full PDC source authoritative. |
| Portable queries | `GQueryView` from `@garden/editor` | Explicitly enabled, read-only `.base` projections; unknown syntax remains visible and unexecuted. |
| Application command search | `GAppShell`, `GCommandPalette` | The shell owns the visible launcher and one Meta/Control+P registry. Embedded examples set `bindShortcut={false}`. |
| Blocking task/decision | `Dialog` family or `Sheet` | Accessible title, focus trap and return; localized close label. Sheet is for longer side content. |
| Anchored surface/action list | `Popover` / `DropdownMenu` | Popover for arbitrary short content; menu for actions. Keep the trigger and keyboard behavior from the primitive. |
| Feedback | `ToastProvider`, `Banner`, `InlineError`, `EmptyState` | Follow the lifetime/scope rules in [behavior](../behavior/README.md). Caller supplies dismissal, retry and region labels. |

## Styling ownership

Tokens define values. Shared components define control geometry and state.
Applications compose them and supply content; app CSS may style domain-specific
cells, previews and illustrations. It must not restyle a shared primitive with
an alternative radius, focus ring, selected surface or page gutter.

`GPage` owns width only. It adds no gutter, card or scroll container. Place it in
the default shell content region. `GSettings` owns its own geometry, so mount it
with shell `contentPadding="none"`. `GSplitLayout` stays in normal page flow and
does not introduce a nested scrolling pane. Never nest an additional `<main>`
inside the shell's main region.

Use the existing token scale, neutral keyboard focus, inverse primary fill,
stable text-editing surface and reduced-motion rules. The framework does not
require an application to reproduce the playground's sample cards or content.

## Conversation composition

Use the conversation layout as the default for an application's assistant/chat
screen. Mount `GConversation` in `GAppShell` with `contentPadding="none"` and
`contentLayout="fill"`, or another parent with a bounded height. The conversation
owns its internal gutters and scrolling; do not add a `GPage`, enclosing card,
second transcript scrollbar, or a second shell composer around it.

```tsx
<GAppShell contentPadding="none" contentLayout="fill" {...shellProps}>
  <GConversation label={labels.conversation}
    transcriptLabel={labels.history} jumpToLatestLabel={labels.latest}
    scrollKey={messages.length}
    composer={<GComposer variant="conversation" value={draft}
      onValueChange={setDraft} onSubmit={send} label={labels.message}
      placeholder={labels.placeholder} submitLabel={labels.send} />}>
    {messages.map(message => <GConversationMessage key={message.id}
      role={message.role} label={labels[message.role]}>
      {message.content}
    </GConversationMessage>)}
  </GConversation>
</GAppShell>
```

The transcript and composer share the 760px reading-width token. The composer
stays in normal flex layout beneath the scroll region, so it never covers a
message. The reader can scroll back without incoming content pulling them down;
the labeled latest-message action resumes following. Hosts change `scrollKey`
for new turns. A resize observer follows growing responses while the reader is
at the end. Message actions and disclosures stay keyboard reachable.

Use `GConversationActivity` for completed reasoning/tool details. `TurnStream`
renders the same supplied steps at prose, command, or execution density; pass
localized `strings` explicitly. Keep active approval decisions visible beside
the affected turn, using shared `Card`, `SelectField`, and `Button` controls.
Context selection belongs in a shared `Popover` beside the composer or an optional
shell panel. Do not show a competing support column by default merely to fill
space. Framework-reference metadata is separate from conversation content.

`GComposer`'s `conversation` variant has an accessible hidden input label, an
auto-growing textarea, and a circular inverse send action. `footer` supplies
leading tools, `trailing` supplies secondary controls beside send, and `inputRef`
lets the host restore input focus. The default variant retains its visible label.
All request state, message content, tool results, labels, persistence and model
integration belong to the host; these primitives do not simulate an AI service.

### Shared component tone

Use semantic radius names for public primitives: `chip` (6px) for compact
controls, `control` (8px) for fields and actions, `card` (10px) for cards,
feedback plates and anchored popups, and `xl` (15px) for dialogs and sheets.
The `lg` (12.5px) scale remains available for grouped layout surfaces. Circular
indicators and pill navigation retain their shape. Avoid depending on legacy
`sm`/`md` radius aliases when a semantic name exists.

Action labels, field values, menu rows and feedback copy use `text-ui` (13px).
The 20px compact button and secondary descriptions may use `text-caption`
(12px). Card and dialog headings use `text-headingSm` (18px) with the scale's
line height, so multiline titles remain legible; their ordinary content uses
`text-body` (14px). Typography, radius and motion
bindings are generated from the token source, including variables consumed by
ordinary CSS; vendored theme declarations must not override them.
Class merging must register the generated typography scale as font sizes so
text-color utilities cannot discard the selected type size.

Feedback surfaces share neutral backgrounds, readable foreground copy and
status icons. Reserve status color for the icon rather than coloring an entire
message. Banner, toast and inline-error actions reuse `Button`; narrow layouts
wrap the action below the copy while keeping dismissal available. Alert titles
wrap instead of truncating. Channel lifetime, announcements and retry behavior
remain governed by the behavior contract.

## Reference-only specimens and compatibility

`LegacyGallery` and the BeautifulUI catalog preserve source provenance and
specialized agent visual examples. `TaskRows`, `SidebarNav`, `RecordsTable`,
`FilterTable`, `Chat`, `PromptBar` and `GardenComposer` contain demo-specific
state, actions or copy. They remain reference specimens, not competing defaults
for application navigation, tables or input. Their preservation is deliberate;
do not delete them merely because a framework primitive is preferred.

The old internal `CommandMenu` is a deprecated adapter to `GCommandPalette`.
It maps `commands[].onRun` to `items[].onSelect` and array shortcuts to a text
hint. There is one command-palette behavior implementation. New code uses
`GCommandPalette` and supplies all strings. Public feedback components likewise
require caller text for actions that are rendered.

Before promoting another specimen, compare it with the existing primitive,
separate example data from reusable behavior, localize its API, and exercise it
in a running playground scene. Record adopt/merge/reference-only decisions in
the [standardization decision](../../docs/decisions/ui-standardization-2026-09-27.md).

## Boundary behavior

- Pass the `FormField` render props through to its control. They include native
  `required` and help/error associations. `SelectField` accepts these props and
  `name`/`form` for native form submission; application validation remains owned
  by the caller.
- `Progress` uses `value / max`. An absent or invalid value is indeterminate;
  reduced motion must retain a visible indication without animation.
- Use a shared `TooltipProvider` to configure delays across a group. Standalone
  tooltips remain supported.
- Modal and anchored content must fit the available viewport and allow scrolling
  to every action. Search popups use collision-aware portals. Composition keys
  must not dismiss them or submit a value.
- A horizontally overflowing table must be keyboard-scrollable. Grid and flex
  parents must allow children to shrink (`minmax(0, 1fr)` / `min-width: 0`).
- Collapsed content must leave the accessibility tree and tab order. Animating
  opacity or height alone does not hide interactive descendants.
- Mobile shell navigation closes on links, `GNavigationItem`, or an explicit
  `data-navigation-dismiss` destination. Changing a sidebar preference does not
  dismiss navigation.
- Reference specimens may contain disabled feature previews; enabled controls
  must have an observable action. Timed demonstrations must cancel stale work
  when users navigate or replace their content.
