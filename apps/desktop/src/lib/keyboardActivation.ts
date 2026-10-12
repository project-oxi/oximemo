import type { KeyboardEvent } from "react";

/** Give a composite clickable surface button keys without intercepting its
 * child buttons, rename input, or portalled context menu. */
export function activateOnKey(
  event: KeyboardEvent<HTMLElement>,
  activate: () => void,
): void {
  if (
    event.target !== event.currentTarget ||
    event.defaultPrevented ||
    event.nativeEvent.isComposing ||
    event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
    (event.key !== "Enter" && event.key !== " ")
  ) return;

  event.preventDefault();
  if (!event.repeat) activate();
}
