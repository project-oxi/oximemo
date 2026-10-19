# Conversation layout verification

Date: 2026-09-27.

## Scope

The assistant scene now consumes public `GConversation`,
`GConversationMessage`, `GConversationActivity`, `TurnStream` and the conversation
variant of `GComposer`. Sample state stays in `AssistantScene`. No model service,
storage format, or document behavior changes. The broad framework migration in
the working tree predates this task.

The supplied Codex desktop screenshot informed the continuous transcript, right
aligned user bubble, quiet activity disclosure and bottom composer. Existing
Garden tokens and controls remain authoritative. Layout adoption and a complete
composition example are recorded in `contracts/ui-spec/components.md`.

## Checks

- `bun run --filter @garden/ui build`: passed.
- `bun run --filter @garden/playground build`: passed. Existing large-bundle
  advisory remains; no compilation errors.
- `bun test packages/ui/tests`: 11 passed, 0 failed, 58 assertions.
- English/Korean showcase catalog key parity: passed.

## Running browser observations

Verified in the local playground at port 5198 through the in-app browser:

| Flow | Observed result |
| --- | --- |
| Entry | `?view=assistant` opens the new scene directly. Component reference panel starts closed and can still be opened through the shell. |
| Composer | Shift+Enter retains a newline; Enter adds one user turn and sample acknowledgement, clears the draft and disables empty sending. User message line breaks are preserved. |
| Sources | Second source can be checked; Clear updates to zero; disabling sources shows Restore; Restore returns the picker. Escape closes the popover and returns focus to its trigger. |
| Activity | Summary starts closed. Opening it exposes the three modes; Output displays the localized command result. Closing it removes those controls from view. |
| Copy | Copy action changes to the localized copied state. |
| Approval | Allow and Deny show their result. Keyboard focus moves to Review approval; activating that returns focus to Allow. Scope selection uses the shared select. |
| Scrolling | Repeated sends grow only the transcript; the composer remains visible. After scrolling back, adding another turn retained scrollTop 368 while content height grew from 2002 to 2154. Jump to latest returned to the bottom (within one pixel). |
| Long drafts | Narrowing a populated draft changed its textarea from 71px to the 200px cap, with internal scrolling for 239px of content. No text is silently clipped. |
| Default composer | In the existing catalog, manually resized the default textarea from 80px to 159px, typed a new draft, and observed it remain 159px. Pause entry disables the input. |
| Responsive | At widths 320, 375, 414, 768 and 1440, document scrollWidth equaled viewport width and the composer remained visible. |
| Themes/locales | Korean dark and English light scenes were visually inspected. |

An independent review found draft resizing and approval focus issues; both were
fixed and exercised in the running app. The original IME submission guards are
preserved; actual platform IME composition was not automated.

## Visual evidence

- [Before](./conversation-2026-09-27/before.png)
- [Desktop dark](./conversation-2026-09-27/dark-1440.png)
- [English light](./conversation-2026-09-27/light-en.png)
- [320px](./conversation-2026-09-27/dark-320.png),
  [375px](./conversation-2026-09-27/dark-375.png),
  [414px](./conversation-2026-09-27/dark-414.png),
  [768px](./conversation-2026-09-27/dark-768.png)
