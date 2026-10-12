import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applyTheme, followTheme, loadTheme, saveTheme } from "./theme";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
let systemDark = false;
let stored: string | null = null;
let blockedStorage = false;
let dark = false;
const listeners = new Set<() => void>();
const style = { colorScheme: "" };

beforeEach(() => {
  systemDark = false;
  stored = null;
  blockedStorage = false;
  dark = false;
  style.colorScheme = "";
  listeners.clear();
  const preference = {
    get matches() { return systemDark; },
    addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      matchMedia: () => preference,
      localStorage: {
        getItem: () => { if (blockedStorage) throw new Error("blocked"); return stored; },
        setItem: (_key: string, value: string) => { if (blockedStorage) throw new Error("blocked"); stored = value; },
      },
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { documentElement: { classList: { toggle: (_name: string, value: boolean) => { dark = value; } }, style } },
  });
});

afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
  else Reflect.deleteProperty(globalThis, "document");
});

function changeSystem(value: boolean) {
  systemDark = value;
  for (const listener of listeners) listener();
}

describe("theme preference precedence", () => {
  test("new, invalid and unavailable preferences default to system detection", () => {
    expect(loadTheme()).toBe("system");
    stored = "obsolete";
    expect(loadTheme()).toBe("system");
    blockedStorage = true;
    expect(loadTheme()).toBe("system");
    changeSystem(true);
    applyTheme(loadTheme());
    expect(dark).toBe(true);
  });

  test("system follows live changes and releases the observer when detached", () => {
    const stop = followTheme("system");
    expect(dark).toBe(false);
    changeSystem(true);
    expect(dark).toBe(true);
    expect(style.colorScheme).toBe("dark");
    changeSystem(false);
    expect(dark).toBe(false);
    expect(style.colorScheme).toBe("light");
    stop();
    changeSystem(true);
    expect(dark).toBe(false);
  });

  test("saved manual themes override the OS without subscribing", () => {
    changeSystem(true);
    saveTheme("light");
    const stop = followTheme(loadTheme());
    expect(dark).toBe(false);
    expect(style.colorScheme).toBe("light");
    changeSystem(false);
    changeSystem(true);
    expect(dark).toBe(false);
    expect(listeners.size).toBe(0);
    stop();
    saveTheme("dark");
    changeSystem(false);
    followTheme(loadTheme());
    expect(dark).toBe(true);
  });

  test("a blocked preferences store still permits immediate selection", () => {
    blockedStorage = true;
    expect(() => saveTheme("dark")).not.toThrow();
    followTheme("dark");
    expect(dark).toBe(true);
  });
});
