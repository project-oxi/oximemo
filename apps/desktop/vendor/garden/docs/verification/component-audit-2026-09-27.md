# Component audit — 2026-09-27

Scope: all 80 files under `packages/ui/src/components`, their shared styles, and
all 70 catalog demos. The existing playground is the visual baseline. This audit
preserves the pre-existing package migration and the BeautifulUI sample data and
provenance; it does not promote reference specimens into framework defaults.

## Improvements

- Shared forms now propagate native required validation, submission names and
  help/error associations. Progress handles custom maxima and indeterminate
  state. Tooltip providers preserve caller configuration.
- The command palette uses the same Radix modality foundation as other dialogs:
  portal, focus containment/return, background accessibility exclusion, scroll
  lock, composition guards and one active modal shortcut owner.
- Dialogs, popovers and toasts fit short/narrow viewports. Combobox popups escape
  clipping parents, flip at viewport edges and retain input focus. Long segmented
  choices and empty-state text wrap. Keyboard focus uses one neutral marker.
- Overflowing tables enter the tab order and support native keyboard scrolling;
  empty-column data tables show an explicit empty state. Settings retain a tab
  entry point if the controlled section disappears. Panel close finds its opener
  independently of the pointer's focus behavior. Mobile sidebar preferences no
  longer dismiss navigation.
- Specimen fixes include IME-aware entry, cancellation of approval auto-advance,
  generation-aware streaming completion, inert collapsed regions, accessible
  search/filter results and record selection/sorting, clipboard feedback,
  keyboard chart inspection, explicit failure/diff markers and disabled preview
  controls for unimplemented actions. Fine-tune selection and approval scope reuse
  public primitives. The streaming-text example finishes once and offers replay,
  so its controls do not disappear on an automatic loop.

## Coverage inventory

Each file was inspected. “Retained” means no concrete defect was confirmed in
this pass; it does not claim exhaustive verification of every browser/prop input.

| Source (`packages/ui/src/components/`) | Result |
| --- | --- |
| `GAppShell.tsx` | destination-only mobile dismissal |
| `GCommandPalette.tsx` | Radix modal, focus, shortcut and composition handling |
| `GComposer.tsx` | Retained after inspection |
| `GNavigation.tsx` | Retained after inspection |
| `GPage.tsx` | Retained after inspection |
| `GPanel.tsx` | ref-based opener lookup |
| `GSettings.tsx` | named tablist and fallback keyboard entry |
| `GTitleBar.tsx` | Retained after inspection |
| `approval-card.tsx` | cancel stale auto-advance |
| `approval-decision.tsx` | shared scope selection and width bound |
| `atoms/Shimmer.tsx` | Retained after inspection |
| `atoms/StreamText.tsx` | completion by text generation |
| `chat.tsx` | composition and disabled preview actions |
| `code-block.tsx` | clipboard failure and valid preformatted markup |
| `context-cards.tsx` | Retained after inspection |
| `diff-table.tsx` | Retained after inspection |
| `filter-table.tsx` | native table and filtered row semantics |
| `fine-tune-card.tsx` | shared SelectField |
| `garden-composer.tsx` | disabled previews, composition guard, wrapping toolbar |
| `insight-cards.tsx` | keyboard chart inspection |
| `loading-state.tsx` | Retained after inspection |
| `prompt-bar.tsx` | composition, separate Connect action, normal Tab |
| `recommendation-card.tsx` | inert alternatives and focus return |
| `records-table.tsx` | mixed selection, recency sort, honest links/headers |
| `search.tsx` | short-query empty results |
| `selection-actions.tsx` | bounded toolbar, inert groups, explicit unavailable preview |
| `sidebar-nav.tsx` | named working filter |
| `streaming-text.tsx` | inert hidden controls, stable completion/replay |
| `task-rows.tsx` | inert collapsed details |
| `thinking.tsx` | inert trace and focus return |
| `tool-chips.tsx` | inert details and static file summaries |
| `turn-stream.tsx` | named failure status and focusable output |
| `ui/accordion.tsx` | Retained after inspection |
| `ui/alert.tsx` | Retained after inspection |
| `ui/animated-link.tsx` | Retained after inspection |
| `ui/avatar-stack.tsx` | Retained after inspection |
| `ui/avatar.tsx` | Retained after inspection |
| `ui/badge.tsx` | Retained after inspection |
| `ui/banner.tsx` | Retained after inspection |
| `ui/breadcrumb.tsx` | Retained after inspection |
| `ui/button.tsx` | Retained after inspection |
| `ui/calendar-date.ts` | Retained after inspection |
| `ui/calendar.tsx` | Retained after inspection |
| `ui/card.tsx` | Retained after inspection |
| `ui/checkbox.tsx` | Retained after inspection |
| `ui/checklist.tsx` | Retained after inspection |
| `ui/collapsible.tsx` | Retained after inspection |
| `ui/combobox.tsx` | collision-aware portal, composition guard |
| `ui/command-menu.tsx` | Retained after inspection |
| `ui/copy-command.tsx` | Retained after inspection |
| `ui/data-table.tsx` | empty column handling |
| `ui/date-picker.tsx` | Retained after inspection |
| `ui/dialog.tsx` | viewport height and scroll |
| `ui/diff.tsx` | visible add/delete symbols and named scroll region |
| `ui/dropdown-menu.tsx` | Retained after inspection |
| `ui/empty-state.tsx` | long text wrapping |
| `ui/floating-dock.tsx` | Retained after inspection |
| `ui/form-patterns.tsx` | native required |
| `ui/inline-error.tsx` | Retained after inspection |
| `ui/input.tsx` | Retained after inspection |
| `ui/label.tsx` | Retained after inspection |
| `ui/pagination.tsx` | Retained after inspection |
| `ui/popover.tsx` | viewport size limits |
| `ui/progress.tsx` | max and indeterminate behavior |
| `ui/radio-group.tsx` | Retained after inspection |
| `ui/revision-timeline.tsx` | Retained after inspection |
| `ui/scroll-area.tsx` | Retained after inspection |
| `ui/segmented-control.tsx` | long-label wrapping in shared style |
| `ui/select.tsx` | form and ARIA forwarding |
| `ui/separator.tsx` | Retained after inspection |
| `ui/sheet.tsx` | Explicit modal semantics |
| `ui/skeleton.tsx` | Retained after inspection |
| `ui/switch.tsx` | Retained after inspection |
| `ui/table.tsx` | overflow keyboard access |
| `ui/tabs.tsx` | Retained after inspection |
| `ui/terminal-output.tsx` | Retained after inspection |
| `ui/text-reveal.tsx` | Retained after inspection |
| `ui/textarea.tsx` | Retained after inspection |
| `ui/toast.tsx` | viewport bound and long action wrapping |
| `ui/tooltip.tsx` | provider composition |

## Live verification

Fixtures: `/tests/ui-audit.html` mounts the complete catalog independently of the
editor; `/tests/ui-regressions.html` exercises boundary props and native forms;
`?case=shell` covers mobile navigation, settings and panel focus. The existing
`/tests/framework.html` covers command selection across parent rerenders.

Observed in the in-app browser:

- Required empty form remained unsubmitted and focused its project input; after
  filling and selecting Garden, FormData contained project and owner values.
  Select trigger referenced both help and error text.
- Progress 25 of 50 filled 50%; null/out-of-range values were indeterminate with
  no false `aria-valuenow`.
- Palette hid the background root, locked scrolling, skipped a disabled command,
  executed the second command and restored focus to its opener.
- At 280×440, long dialog bounds were x16–264 and y16–424; its final action was
  reachable. Nested combobox selection worked and Escape dismissed the popup
  before the dialog. Long toast and popover stayed within the viewport; the
  wrapped toast action ran successfully.
- A combobox inside an overflow-hidden container portaled above its input near
  the bottom edge (320px popup height), filtered Alex, and selected with Enter.
- Wide table received Tab focus; ArrowRight changed scrollLeft from 0 to 40.
  A table with rows and zero columns displayed “No visible data”.
- At 390×844, toggling a sidebar preference kept navigation open; choosing a
  destination closed it. Closing the context panel focused “Open details”.
- The full Korean playground loaded after concurrent editor work restored its
  missing module. Owner search selected Mina and task sorting updated aria-sort;
  the document width stayed 390px.
- Insight comparison chart responded to ArrowRight with index 1 and announced
  “Mint Chip -3.40%, Pistachio +0.58%”.

Native Tauri window behavior, physical Korean/Japanese IME composition, touch-only
platform behavior and screen-reader speech output were not exercised. Composition
checks were reviewed in source; browser checks use DOM semantics and real keyboard
interaction, not a claim of native IME verification.

Additional observed regressions:

- Streaming generations A → interrupted B → A incremented completion from 2 to
  3. Selecting approval question 1 and immediately navigating to question 3 left
  question 3 displayed after the auto-advance deadline.
- Selection toolbar stayed at document width 390px when collapsed, expanded,
  executing Shorten and showing Keep/Discard. Keep returned to the input state.
- Sidebar query `zz` showed a named empty status. Search query `z` showed “No
  results found”. FilterTable's Completed filter rendered exactly one body row.
- RecordsTable announced its header checkbox as mixed after partial selection.
  Ascending interaction age began with 9 days, 15 days, 3 weeks, then about one
  month. Sort headers now expose their direction through `aria-sort`.
- Selecting a recommendation alternative restored focus to Alternatives; Tab
  skipped the inert drawer and reached the primary action. Fine-tune selected
  Seasonal through the shared selector. Code copying showed Copied.
- PromptBar's source menu exposed Gmail selection and Connect Gmail as separate
  buttons. Reference-source labels/data remain in their original specimen copy.

## Automated verification

- UI TypeScript build: passed, including a repeat after the final sort ARIA change.
- Playground TypeScript/Vite production build: passed (3,586 modules).
- Temporary extended TypeScript config including every playground test fixture:
  passed. The normal playground config excludes these fixture files.
- `bun test packages/ui/tests`: 8 passed; `bun test cli/tests`: 3 passed.
- Token regeneration check: current. `garden doctor`: healthy.
- Locale parity: playground 253/253 keys; desktop template 19/19 keys.
- `git diff --check`: passed.

Vite retains its non-blocking large-chunk advisory (about 1.64 MB minified JS).
This component pass did not change the application's code-splitting architecture.
Independent review found the Combobox composition-dismissal and StreamText
recompletion issues; both were corrected. Clipboard denial feedback was reviewed
but the live browser granted the tested clipboard operation.

Final application checks also uncovered that this installed Radix Dialog does not
emit `aria-modal` itself. Garden Dialog now mirrors its `modal` prop, while Sheet
and GCommandPalette explicitly mark their always-modal content. In the running
catalog, Control+P with a modal open left exactly that one dialog; after closing
it, the shell command button opened the palette normally. Modal=false consumers
retain non-modal semantics. The final gallery pass also named crop selection,
water-schedule radio groups, progress indicators and tabs, connected the popover
Cancel action, and removed an obsolete blue-focus tooltip description.

Screenshots: [dark desktop](renders/component-audit-dark.png).

The final feedback fixture rendered a named Failed status, visible failure mark,
keyboard-focusable command output and separate +/− diff markers. Final production
build and fixture typecheck were repeated after gallery labels and modal semantics
changed; both passed. [Light desktop screenshot](renders/component-audit-light.png).
