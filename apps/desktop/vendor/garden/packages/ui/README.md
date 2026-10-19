# @garden/ui

Garden's React component library uses the shared token and behavior contracts. Import public components from the package root and load the stylesheet once:

```tsx
import { Button, FormField, Input, Checklist } from "@garden/ui"
import "@garden/ui/styles.css"
```

The package expects the workspace's React 19 and Tailwind 4 setup. Its shared primitives adopt shadcn/ui composition and Radix behavior; apps reuse these implementations rather than generating a competing local control library. It adds no theme provider; the host controls the existing `.dark` appearance. Visible text, empty states, accessible names and action labels are caller-owned. See the [complete framework standard](../../contracts/framework/README.md) and [UI contract](../../contracts/ui-spec/README.md).

## Standard application shell

`GAppShell` provides the standard titlebar without app-owned search/toggle markup:
the left pane toggle, upper-right command field and right pane toggle (when the
region exists). Supply localized `sidebarToggleLabel`, `rightPanelToggleLabel`
and command-palette strings. `appName` is accessible identity only, never visible
app branding. `titleBar.left`, `center` and `right` add contextual controls/content.
Do not repeat the app title/logo in headers, navigation or activity rails.

`sidebarOpen` / `onSidebarOpenChange` and `rightPanelOpen` /
`onRightPanelOpenChange` support host-owned state; omitted state is handled by the
shell. One `commandItems` registry powers the visible launcher and Meta/Control+P.
`titleBarMode="custom"` is the explicit escape hatch for a recorded `shell.layout`
exception. The host then owns reachable pane and command controls. Page headers
have no default subtitle; descriptions are for concrete operational constraints.

Multi-workspace apps compose `GAppShell` with both `GActivityRail` and
`GNavigation`: the rail selects a major workspace, while the independently
collapsible sidebar lists that workspace's destinations. Keep the active rail
item aligned with the current route. Single-workspace apps may use only
`GNavigation`; the desktop starter demonstrates that case.

## Recommended components

The [component selection contract](../../contracts/ui-spec/components.md) is the
starting point for application authors. The playground's working scenes use the
same public APIs. The [comparison record](../../docs/decisions/ui-standardization-2026-09-27.md)
explains which duplicate implementations were merged, adopted or retained as
reference specimens.

## Page and application composition

```tsx
import {
  GPage, GPageHeader, GSplitLayout, GNavigation, GNavigationGroup,
  GNavigationItem, GSettingsGroup, GSettingsRow, Switch,
} from "@garden/ui"

// Inside GAppShell's default content region: no second gutter or <main>.
<GPage>
  <GPageHeader title={t.projects} actions={<Button onClick={create}>{t.create}</Button>} />
  <GSplitLayout asideLabel={t.details} aside={<ProjectDetails project={selected} />}>
    <ProjectTable projects={projects} />
  </GSplitLayout>
</GPage>

<GNavigation label={t.navigation}>
  <GNavigationGroup label={t.workspace}>
    <GNavigationItem asChild current={pathname === "/projects"}>
      <a href="/projects">{t.projects}</a>
    </GNavigationItem>
  </GNavigationGroup>
</GNavigation>

<GSettingsGroup title={t.notifications}>
  <GSettingsRow label={t.updates} htmlFor="updates">
    <Switch id="updates" checked={updates} onCheckedChange={setUpdates} />
  </GSettingsRow>
</GSettingsGroup>
```

`GPage` selects `content` (960px), `reading` (760px), or `full` width. The shell
owns gutters and scrolling. `GPageHeader` wraps actions without hiding them.
`GSplitLayout` uses the 300px panel token and stacks support content after the
main task below 780px of available width. It adds no scroll container. Keep
persistent context in the shell's `rightPanel` with `GPanel`. Use
`contentPadding="none"` only when a layout such as `GSettings` owns its gutters.

`GActivityRail` takes a localized `label`, children and an explicit `footer`.
Each `GActivityRailItem` requires a `label`; both navigation item families support
`current` and `asChild` for router/native links. Local view changes use buttons.

## Framework and specimen boundary

Import from `@garden/ui`, not the playground's internal `@/components` alias.
The BeautifulUI gallery retains examples with sample-specific data and actions.
Its SidebarNav, TaskRows, FilterTable, RecordsTable, Chat, PromptBar and
GardenComposer are visual references, not alternative public app defaults.
Use the navigation, table and composer APIs described here for new applications.

## Catalog additions

| Area | Public components |
| --- | --- |
| People and activity | `AvatarStack`, `RevisionTimeline`, `Checklist` |
| Compact actions | `FloatingDock`, `AnimatedLink`, `CopyCommand` |
| Presentation | `TextReveal`, `TerminalOutput` |
| Navigation | `Breadcrumb`, `Pagination`, `ButtonGroup`, `Collapsible`, `Sheet` |
| Selection | `Combobox`, `Calendar`, `DatePicker`, `Slider`, `InputOTP` |
| Forms and data | `FormField`, `Table` family, `DataTable` |

These APIs are original Garden implementations. The [adoption decision](../../docs/decisions/ui-catalog-adoption-2026-09-27.md) records Great UI and Watermelon references, license findings and exclusions. Existing `Avatar`, `Accordion`, `Tabs`, `Tooltip`, `Popover`, `Progress`, `RadioGroup`, `ScrollArea`, `Alert` and `Skeleton` families are also exported from the package root.

## Form composition

```tsx
<FormField label={t.projectName} description={t.nameHelp} error={nameError} required>
  {control => <Input {...control} required value={name} onChange={e => setName(e.target.value)} />}
</FormField>
```

Spread the supplied control props on the labelled input. `required` on `FormField` provides accessible metadata; pass native `required` to the control when browser submission validation is wanted. The host owns validation, errors and submission. `InputOTP` keeps one native input for numeric code entry, paste and one-time-code autofill. It never requests or submits a code. `Slider` uses the browser's native range behavior and supports a localized `formatValue`.

## Selection and navigation

`Calendar` and `DatePicker` exchange local calendar dates as `YYYY-MM-DD` strings, not timestamps. Use `""` for a controlled empty value. `min` and `max` bound selection; `defaultMonth` is an initial browsing month. `locale` supplies `en`/`ko` date formatting; all other labels are props. Calendar supports arrows, Home/End, PageUp/PageDown and Shift+PageUp/PageDown. DatePicker adds a named popover, focus return and explicit clear action.

`Combobox` takes `{value, label, disabled?}` options and a controlled `value`. Typing filters; Enter or pointer selection commits. Escape or dismissal restores the selected label. It does not allow arbitrary free text. Use `Select` for a compact non-searchable choice.

`Pagination` controls a one-based page and displays a bounded number of buttons even for large totals. `FloatingDock` uses Left/Right/Home/End to focus enabled actions and Enter/Space to activate them. `Breadcrumb` uses ordinary links for ancestor items and current-page text for the last item. `Sheet` requires a trigger element, controlled open state, title and localized close label; its modal behavior comes from the existing Radix Dialog dependency.

## Tables

```tsx
<DataTable
  label={t.projects}
  rows={projects}
  getRowId={row => row.id}
  emptyLabel={t.noProjects}
  columns={[
    { id: "name", header: t.name, cell: row => row.name, sortValue: row => row.name },
    { id: "tasks", header: t.tasks, cell: row => row.tasks, sortValue: row => row.tasks },
  ]}
/>
```

Sortable headers cycle ascending → descending → caller order. Equal keys remain stable and null/NaN remain last. Numeric keys sort numerically; strings use deterministic lexical order. Supply a numeric key when a displayed string needs numeric ordering. The input rows are never mutated. Filtering, pagination and fetching are composed by the host. Use `Table`, `TableHeader`, `TableBody`, `TableFooter`, `TableRow`, `TableHead`, `TableCell` and `TableCaption` for custom native table markup.

## Activity and output

`RevisionTimeline` preserves caller order and all revision IDs, including entries with the same date. Its content is `ReactNode`; it neither parses nor stores document formats. `Checklist` takes controlled item state and becomes read-only when no change callback is supplied. `AvatarStack` retains every member's name for assistive technology while limiting visible avatars.

`CopyCommand` copies exactly the displayed string. Its optional asynchronous `onCopy` bridges a host clipboard; reject the promise on failure. Clipboard errors use the supplied error label. `TerminalOutput` renders host-supplied lines and an explicit status; neither component runs commands or synthesizes real progress. `TextReveal` is optional, preserves one reading order, and replays when remounted with a new React key.

## Examples and verification

Run `bun run dev` from the repository root and open `?view=components&category=framework` for the recommended building blocks, `category=patterns` for application patterns, or `category=utilities` for utility controls. `lang=ko` and `theme=light` select localized/light previews. Categories and search include all new APIs. The Standards view explains component selection and layout recommendations. Run `bun run --filter @garden/ui build`, `bun run --filter @garden/playground build`, and `bun test packages/ui/tests` for the relevant checks. `/tests/framework.html` is a live regression fixture for palette selection during parent rerenders.

## Exclusive selection and message composition

```tsx
<SegmentedControl
  aria-label={t.detailMode}
  value={mode}
  onValueChange={setMode}
  options={[
    { value: "summary", label: t.summary },
    { value: "output", label: t.output },
  ]}
/>

<GComposer
  value={draft}
  onValueChange={setDraft}
  onSubmit={send}
  label={t.message}
  placeholder={t.messagePlaceholder}
  submitLabel={t.send}
  pending={sending}
  footer={<Badge variant="outline">{workspaceName}</Badge>}
/>
```

`SegmentedControl` uses radio semantics, arrow navigation and disabled options.
`variant="filter"` is the quieter filter-row treatment; option `count` remains
part of its accessible name. Use `Tabs` for actual tab panels and `ButtonGroup`
for a group of independent actions.

`GComposer` submits trimmed, nonempty text. Enter submits; Shift+Enter preserves
newlines; composition Enter is ignored. `disabled` and `pending` disable text
entry and submission. The callback does not clear the draft: the application
chooses when successful sending clears it and how failures are presented.

For descriptive tables that should wrap prose, use `<Table layout="fixed">`.
The default `auto` layout retains intrinsic widths and horizontal scrolling for
wide data. Selection buttons, row highlighting and column content remain caller-owned.

## Public feedback and overlays

```tsx
<ToastProvider closeLabel={t.dismiss} regionLabel={t.notifications}>
  <AppContent />
</ToastProvider>

<Banner onDismiss={dismissWarning} dismissLabel={t.dismiss}>{t.warning}</Banner>
<InlineError onRetry={retry} retryLabel={pending ? t.retrying : t.retry} pending={pending}>
  {t.failure}
</InlineError>
```

The package root exports the Dialog and DropdownMenu families, Banner,
InlineError, ToastProvider and useToast. `DialogContent` requires `closeLabel`
when its built-in close button is shown; use `showCloseButton={false}` with an
explicit localized close action otherwise. Mount one shell command registry;
embedded `GCommandPalette` previews use `bindShortcut={false}` so they cannot
compete for the application shortcut. The internal CommandMenu adapter is
retained only for migration, not as a second public palette API.
