import { useLayoutEffect, useRef } from "react";

type Entry<T> = { session: string; index: number; route: T };

/** Route history shared by edge gestures, buttons and browser navigation.
 * Only identifiers and list position enter history; draft/source never do. */
export function useNavigation<T>(read: () => T, apply: (route: T) => void,
  blocked: () => boolean, onBlocked: (proceed: () => void) => void) {
  const callbacks = useRef({ read, apply, blocked, onBlocked });
  callbacks.current = { read, apply, blocked, onBlocked };
  const controller = useRef<{
    push: (route: T) => void; replace: (route?: T) => void; back: () => void; forward: () => void;
  } | null>(null);
  useLayoutEffect(() => {
    const history = window.history;
    const session = crypto.randomUUID();
    let index = 0;
    let last = 0;
    let restoring = false;
    let approved = false;
    let queued: (() => void) | undefined;
    const replace = (route?: T) => history.replaceState({ oximemo: { session, index, route: route ?? callbacks.current.read() } }, "");
    replace();
    const go = (target: number) => {
      const proceed = () => {
        const run = () => { approved = true; history.go(target - index); };
        if (restoring) queued = run; else run();
      };
      if (callbacks.current.blocked()) callbacks.current.onBlocked(proceed);
      else proceed();
    };
    const pop = (event: PopStateEvent) => {
      const entry = event.state?.oximemo as Entry<T> | undefined;
      if (entry?.session !== session) return;
      if (restoring) {
        restoring = false;
        const next = queued; queued = undefined; next?.();
        return;
      }
      if (!approved && callbacks.current.blocked()) {
        const target = entry.index;
        restoring = true;
        history.go(index - target);
        callbacks.current.onBlocked(() => {
          const run = () => { approved = true; history.go(target - index); };
          if (restoring) queued = run; else run();
        });
        return;
      }
      approved = false;
      index = entry.index;
      callbacks.current.apply(entry.route);
    };
    window.addEventListener("popstate", pop);
    // WKWebView's native gesture list can skip SPA entries, especially in
    // the forward direction. Handle app-route edge pans consistently here;
    // native back/forward gestures stay disabled so there is only one owner.
    let edge: { x: number; y: number; index: number; back: boolean; dx: number } | undefined;
    const start = (event: TouchEvent) => {
      edge = undefined;
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch || (event.target as Element)?.closest("input, textarea, select, pre, dialog")) return;
      const back = touch.clientX <= 24;
      if (!(back && index > 0) && !(touch.clientX >= window.innerWidth - 24 && index < last)) return;
      edge = { x: touch.clientX, y: touch.clientY, index, back, dx: 0 };
    };
    const move = (event: TouchEvent) => {
      if (!edge) return;
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch) { edge = undefined; return; }
      const dx = touch.clientX - edge.x;
      const dy = touch.clientY - edge.y;
      if (Math.abs(dy) > 20 && Math.abs(dy) > Math.abs(dx)) { edge = undefined; return; }
      edge.dx = edge.back ? dx : -dx;
      if (edge.dx > 16 && Math.abs(dx) > Math.abs(dy) * 1.5 && event.cancelable) event.preventDefault();
    };
    const end = () => {
      const gesture = edge; edge = undefined;
      if (gesture && gesture.index === index && gesture.dx > Math.max(72, window.innerWidth * .24)) {
        replace(); go(index + (gesture.back ? -1 : 1));
      }
    };
    const cancel = () => { edge = undefined; };
    window.addEventListener("touchstart", start, { passive: true });
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("touchend", end);
    window.addEventListener("touchcancel", cancel);
    controller.current = {
      replace,
      push: route => {
        const proceed = () => {
          replace();
          index++; last = index;
          // Never put document content or identifiers in the URL.
          history.pushState({ oximemo: { session, index, route } }, "", `#view-${session}-${index}`);
          callbacks.current.apply(route);
        };
        if (callbacks.current.blocked()) callbacks.current.onBlocked(proceed);
        else proceed();
      },
      back: () => { if (index > 0) { replace(); go(index - 1); } },
      forward: () => { if (index < last) { replace(); go(index + 1); } },
    };
    return () => {
      window.removeEventListener("popstate", pop);
      window.removeEventListener("touchstart", start); window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", end); window.removeEventListener("touchcancel", cancel);
      controller.current = null;
    };
  }, []);
  return {
    push: (route: T) => controller.current?.push(route),
    replace: (route?: T) => controller.current?.replace(route),
    back: () => controller.current?.back(),
    forward: () => controller.current?.forward(),
  };
}
