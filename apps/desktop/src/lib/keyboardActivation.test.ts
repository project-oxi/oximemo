import { expect, test } from "bun:test";
import type { KeyboardEvent } from "react";
import { activateOnKey } from "./keyboardActivation";

function keyEvent(key: string, overrides: Partial<KeyboardEvent<HTMLElement>> = {}) {
  const surface = {};
  let prevented = false;
  const event = {
    key, target: surface, currentTarget: surface,
    defaultPrevented: false, repeat: false,
    nativeEvent: { isComposing: false },
    preventDefault: () => { prevented = true; },
    ...overrides,
  } as KeyboardEvent<HTMLElement>;
  return { event, prevented: () => prevented };
}

test("Enter and Space open the focused surface and prevent scrolling", () => {
  for (const key of ["Enter", " "]) {
    const input = keyEvent(key);
    let opens = 0;
    activateOnKey(input.event, () => { opens++; });
    expect(opens).toBe(1);
    expect(input.prevented()).toBe(true);
  }
});

test("child controls and portalled menu items never open their parent", () => {
  for (const key of ["Enter", " "]) {
    const input = keyEvent(key, { target: {} as HTMLElement });
    let opens = 0;
    activateOnKey(input.event, () => { opens++; });
    expect(opens).toBe(0);
    expect(input.prevented()).toBe(false);
  }
});

test("holding an activation key does not repeatedly open the surface", () => {
  const input = keyEvent(" ", { repeat: true });
  let opens = 0;
  activateOnKey(input.event, () => { opens++; });
  expect(opens).toBe(0);
  expect(input.prevented()).toBe(true);
});

test("IME confirmation, shortcuts and handled keys retain their behavior", () => {
  const variants = [
    keyEvent("Enter", { nativeEvent: { isComposing: true } as globalThis.KeyboardEvent }),
    keyEvent("Enter", { defaultPrevented: true }),
    keyEvent("Enter", { metaKey: true }),
    keyEvent("Enter", { ctrlKey: true }),
    keyEvent("Enter", { altKey: true }),
    keyEvent("Enter", { shiftKey: true }),
    keyEvent("Tab"),
  ];
  for (const input of variants) {
    let opens = 0;
    activateOnKey(input.event, () => { opens++; });
    expect(opens).toBe(0);
    expect(input.prevented()).toBe(false);
  }
});
