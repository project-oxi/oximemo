import { useMemo, useRef, useSyncExternalStore } from "react";

const reducedMotion = typeof window === "undefined" ? null : window.matchMedia("(prefers-reduced-motion: reduce)");
const subscribe = (notify: () => void) => {
  reducedMotion?.addEventListener("change", notify);
  return () => reducedMotion?.removeEventListener("change", notify);
};
const snapshot = () => reducedMotion?.matches ?? false;

/** True once `value` has differed from its first render. Gates one-shot
 * feedback motion (check pop, star pop) to real user changes: virtualized
 * rows remount on scroll, and a mount-time animation would replay on every
 * row that scrolls into view. */
export function useChangedSinceMount<T>(value: T): boolean {
  const first = useRef(value);
  const changed = useRef(false);
  if (value !== first.current) changed.current = true;
  return changed.current;
}

/** CSS is the single timing source for both native transitions and Motion. */
export function useWorkspaceMotion() {
  const reduce = useSyncExternalStore(subscribe, snapshot, () => false);
  return useMemo(() => {
    const styles = typeof document === "undefined" ? null : getComputedStyle(document.documentElement);
    const duration = (name: string, fallback: number) => {
      if (reduce) return 0;
      const value = styles?.getPropertyValue(name).trim();
      return value ? parseFloat(value) / (value.endsWith("ms") ? 1000 : 1) : fallback;
    };
    const curve = (name: string, fallback: [number, number, number, number]) => {
      const values = styles?.getPropertyValue(name).match(/cubic-bezier\(([^)]+)\)/)?.[1].split(",").map(Number);
      return values?.length === 4 && values.every(Number.isFinite) ? values as [number, number, number, number] : fallback;
    };
    return {
      reduce,
      enter: { duration: duration("--dur-fast", 0.15), ease: curve("--ease-enter", [0.19, 1, 0.22, 1]) },
      exit: { duration: duration("--dur-exit", 0.1), ease: curve("--ease-exit", [0.8, 0, 0.4, 1]) },
      move: { duration: duration("--dur-base", 0.2), ease: curve("--ease-move", [0.65, 0, 0.35, 1]) },
    };
  }, [reduce]);
}
