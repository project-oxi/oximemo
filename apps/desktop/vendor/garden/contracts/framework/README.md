# Garden personal framework standard

Status: normative. Profile: `garden-personal/1`. Contract: `garden-framework/1`.

Garden is an opinionated personal application framework. Its defaults include the
application layout, controls, document plane, native host, engineering workflow
and project structure. An adopter starts with these decisions already made.
The playground is an executable reference; it does not independently define the
standard. Public distribution and compatibility with arbitrary stacks are not
design goals. Local, self-contained snapshots keep personal apps reproducible.

## Authority and scope

Read this contract for every Garden project, then the contracts selected by
`garden.json`. [contract.json](./contract.json) assigns stable rule IDs and states
how each rule is checked. [pins.json](../pins.json) owns tool and library versions.
The [UI contract](../ui-spec/README.md), [layout](../ui-spec/layout.md),
[component map](../ui-spec/components.md), [behavior](../behavior/README.md) and
[document presentation](../markdown/presentation.md) supply detailed requirements.
PDC remains the syntax and data-integrity authority; Garden specifies its adoption
and presentation without changing that grammar.

`required` rules apply within their stated scope. `default` rules are the starting
composition for every applicable app. Both remain in force until an allowed,
specific exception is recorded. A service with no UI does not need a titlebar.
A UI app without durable documents does not need a document plane. Optional
regions such as a right pane are omitted when the task has no use for them.

## Standard stack and package boundaries

| Concern | Standard | Owner |
| --- | --- | --- |
| Application UI | React + TypeScript, Vite, Tailwind CSS | App composes public package APIs |
| Controls | Garden's shadcn/ui-style, Radix-backed primitives | `@garden/ui`; reuse before adding another component system |
| Desktop | Tauri 2 + Rust, custom application titlebar | Native host and typed `@garden/native` bridge |
| Service | Bun + TypeScript, `garden-daemon/1` | `@garden/daemon-kit`; Rust supervises desktop services |
| Design | Generated semantic tokens, light/dark, monochrome chrome | `contracts/tokens`; never page-local substitutes |
| Documents | PDC 2 Markdown and first-class HTML; readable PDC 1 | `@garden/markdown` syntax/model/storage boundaries |
| Editor | CodeMirror 6 with the pinned Atomic integration | `@garden/editor`; source stays authoritative |
| Properties | `GDocumentProperties`, `GPropertyValue`, composed by `GDocumentEditor` | Shared typed metadata editing and read-only values |
| Query | PDC Query 1, `.base` and fenced `base` | `parseQuery`, `evaluateQuery`, `GQueryView` |
| Verification | Bun tests, package typechecks/build, running-path evidence | `garden doctor`, CI and the app |

shadcn/ui is an adopted component implementation/composition model, not an npm
package an app must install. Garden owns those components centrally. Apps must
not run a second shadcn generator into a competing local primitive directory or
copy a specimen as a replacement for an existing public component. Versions are
resolved from pins and package manifests, not prose in this document.

## Primary application layout

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ [left pane] [history/context]          [Search commands… ⌘P] [right pane]│
├──────┬────────────────┬─────────────────────────────────────────────────┤
│ rail │ navigation     │ inset workspace                               │
│      │                │ page / document / conversation │ context      │
│      │                │                                │ (optional)   │
│      │                │ composer (optional)            │              │
│      │                │ activity / terminal (optional)                │
└──────┴────────────────┴─────────────────────────────────────────────────┘
```

Use `GAppShell`. Its standard toolbar supplies pane toggles and the command
palette entry; do not rebuild them in each app. The left toggle controls the
contextual navigation sidebar and remains reachable when that sidebar is closed,
including compact windows. The right toggle exists when a right region exists.
Both report expanded state and control the actual region. Closing a region
restores focus to its controlling action when needed.

Multi-workspace apps MUST pair `GActivityRail` with `GNavigation`: the rail
selects the major workspace and the independently collapsible sidebar shows
destinations within that workspace. The two regions are different levels of
classification: the sidebar reflects the rail's current selection, never
re-lists every workspace's destinations, and major workspaces are never
flattened into a single sidebar list. Closing the sidebar never hides the rail.
Single-workspace apps, including the basic desktop starter, MAY omit the rail.
The rail is navigation, not a branding strip.

The titlebar is 46 CSS px and shares the navigation/rail surface. The command
entry sits at the upper right: a field-like button with a search icon, localized
label and platform shortcut, opening the one shell command palette. It is not a
second editable search input. Compact layouts may shorten its visual label but
retain its accessible name and action. Context/history slots identify the current
task or actual workspace, never repeat the app name.

On macOS, retain native traffic lights and OS-owned window corners inside the
Tauri overlay titlebar. Other desktop platforms use an undecorated native window
and host-controlled window actions. Browser previews do not draw fake OS controls.
Only empty titlebar areas drag; controls remain interactive. Settings/theme/locale
preferences belong in settings and commands, not permanent toolbar switches.

The workspace is one rounded, inset canvas. `GPage` owns width; the shell owns
gutters. Settings and full-height conversations opt out of shell padding and own
their geometry. Reading content uses 760px, ordinary pages 960px; wide data views
can use full width. Main content and support regions have explicit scroll owners.
Right context stacks at compact widths instead of covering the primary task.
Use a bottom panel only for actual diagnostics, activity or terminal output.

## Prohibited product patterns

| Do not | Use instead |
| --- | --- |
| Repeat the app title, logo or wordmark in a titlebar, header, sidebar or rail | OS/app metadata, launcher icon, About; actual workspace/document names when useful |
| Add a greeting or filler sentence below every page title | Task title and relevant actions; operational help beside the field or decision it explains |
| Put “Manage your …”, “Everything you need …” or implementation narration on ordinary pages | Specific labels, counts, status, constraints and actionable error copy |
| Show package names, contract versions or transport details in ordinary app flows | Developer/reference views or a deliberate technical disclosure |
| Rebuild shell/pane/search/settings geometry with per-app CSS | Shared shell, page, navigation, settings and panel compositions |
| Nest cards around continuous documents, every settings row or entire conversations | Continuous canvas, grouped settings rows, shared conversation layout |
| Add duplicate page gutters, nested main landmarks or competing transcript scrollbars | One owner for each region's geometry and scrolling |
| Invent control radii, focus effects, colored chrome or blue primary actions | Semantic tokens, stable text surfaces, neutral keyboard focus, inverse primary fill |
| Ship enabled decorative controls, unexplained icons or hover-only essential actions | Observable actions, localized accessible names and keyboard access |
| Add a competing Markdown/SQL/Dataview/JavaScript query dialect | PDC source and declared query capabilities |
| Save editor JSON/DOM as the only user document or coerce unknown metadata | Source-preserving patches and readable fallbacks |
| Hide unsupported documents/queries or present unsupported execution as zero results | Explicit source, read-only/unexecuted state and local diagnostics |

Useful help is allowed: a destructive-action consequence, required input format,
empty-state next step or query scope changes a decision. A sentence merely
restating the title does not. `GPageHeader` therefore has no default subtitle;
any supplied description needs an operational purpose. The developer playground
may show actual framework reference material in labeled reference views.

## Document plane and composition

Durable user-authored notes use the [PDC adoption](../markdown/README.md).
Repository docs, logs, caches, generated reports and export-only content are out
of scope. New ordinary notes are `pdc-document/2` + `pdc-markdown/1`; authored HTML
remains `pdc-html/1`. Legacy PDC 1 Djot/HTML remains visible and byte-stable.
Opening an old file never authorizes conversion.

`@garden/markdown` provides transport/envelope parsing, shared syntax, source
patching and query evaluation. `@garden/editor` provides `GMarkdownEditor` for
source-body editing, `GDocumentProperties` for source-backed metadata,
`GDocumentEditor` for the complete document composition, `GPropertyValue` for
read-only parsed values, and `GQueryView` for read-only results. Use the complete
composition by default; use separate public pieces when an app needs another
arrangement. Do not import private
editor helpers or create a second property type system.

Properties precede the body. Tags and aliases are string lists; user properties
retain their actual YAML-compatible type. Nested and unsupported values remain
readable. Standard fields keep their PDC type. Type conversions are explicit and
lossless; technical fields and complete source are disclosed after the body.
Metadata edits preserve untouched body/envelope spelling. No-op access changes
no bytes and no timestamp. The syntax/support matrix and task metadata extension
are documented in [presentation.md](../markdown/presentation.md).

Query enablement is explicit. Production vaults declare `query: pdc-query/1`;
an in-memory demonstration declares its narrower collection. Supported views,
functions and keys come from [query-capabilities.json](../markdown/query-capabilities.json).
`order` selects columns, not row sorting. Unsupported constructs remain
unexecuted; evaluating a query cannot write, fetch, launch a process or authorize
an action. Result selection is a host callback.

Apps own vault discovery, containment, UUID/link/asset resolution, external
resource policy and snapshot-guarded persistence. The storage adapter offers
digest-guarded atomic replacement; it does not validate documents or implement
an entire vault. Current packages do not claim Full PDC Reader/Writer conformance:
HTML and legacy profiles have explicit read-only source fallbacks and vault
capabilities remain host work. Never advertise those capabilities merely because
the editor rendered one sample successfully.

## Application structure

```text
garden.json                 profile, adoptions, deliberate exceptions
garden.lock.json            vendored snapshot drift check (adopted apps)
AGENTS.md                   generated routing
AGENTS.local.md             optional app instructions
src/                        app composition, domain state, host adapters
locales/en.json, ko.json     localized product copy with matching keys
src-tauri/                  desktop native host only
vendor/garden/              contracts, playbook, shared packages, generators
docs/decisions/             app-specific decisions and exception evidence
```

Dependencies flow app → framework package → contract. Framework React controls
do not import Tauri or daemon implementations. Apps own fetching, domain state,
storage, error recovery and command registries. Pure decisions stay separate
from IO. Public package exports are the supported integration surface; preserved
BeautifulUI examples and the legacy gallery are reference specimens.

## Deliberate deviations

An exception is an engineering decision, not an extra approval workflow. When a
different layout or stack is justified, record the exact overridable rule,
reason and local ADR in `garden.json`:

```json
{
  "standards": {
    "profile": "garden-personal/1",
    "exceptions": [{
      "rule": "shell.layout",
      "reason": "The canvas tool uses a full-window drawing surface.",
      "decision": "docs/decisions/0002-canvas-layout.md"
    }]
  }
}
```

The ADR describes the replacement behavior, affected surfaces and verification.
Exceptions are local and narrow; they do not edit vendored contracts or silently
change every other app. Use the shell's explicit custom-toolbar mode only for a
recorded layout exception. Omitting an unused pane or passing context actions is
ordinary composition, not an exception. Non-overridable preservation, query
safety and accessibility requirements cannot be waived through this mechanism.

## Verification and adoption

`garden new desktop` and `garden new service` start with this profile. `garden
sync` regenerates bindings/routing; `garden doctor` validates the manifest,
exception records, applicable stack/adoption/native configuration, pins, locales,
contracts and generated/snapshot drift. It reports active exceptions. It does
not prove semantic copy quality, visual conformity, keyboard behavior or full
PDC conformance; those remain running-app, review and corpus checks as classified
in the rule registry.

The lock detects accidental drift against the project-local manifest; it does
not authenticate a hostile project that ships a forged lock alongside its own
vendored code. Cloning an untrusted project is the trust boundary: run lifecycle
commands through your own trusted Garden source.

Before claiming an app standardized, exercise pane collapse/reopen, command
search and focus return, settings, light/dark and compact layouts, plus the
changed document/query/property path when adopted. Check useful/no-content,
failure, read-only and unsupported states. Record what actually ran. Run builds
and the relevant tests once the integrated implementation is stable.

Existing apps adopt through explicit manifest and source changes. New defaults
do not authorize overwriting domain code, user files or local modifications.
Retain snapshot checks and migration notes when updating a vendored framework.
