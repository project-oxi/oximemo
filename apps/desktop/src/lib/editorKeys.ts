type InputKey = Pick<KeyboardEvent, "isComposing" | "keyCode">;
type ShortcutKey = InputKey & Pick<KeyboardEvent,
  "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "repeat" | "defaultPrevented"
>;

/** WebKit can report the composition-confirming key with keyCode 229. */
export function isComposingKey(event: InputKey): boolean {
  return event.isComposing || event.keyCode === 229;
}

export function isSaveAndCloseChord(event: ShortcutKey): boolean {
  return (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey
    && event.key === "Enter";
}

export function isSaveAndCloseKey(event: ShortcutKey): boolean {
  return !event.defaultPrevented && !event.repeat && !isComposingKey(event)
    && isSaveAndCloseChord(event);
}
