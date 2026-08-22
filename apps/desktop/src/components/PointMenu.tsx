import { useEffect, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/**
 * PointMenu — fixed-position popup for right-clicks that originate OUTSIDE
 * React's tree (CM6-managed DOM, canvas/SVG hit surfaces). Same visual
 * vocabulary as ContextMenu's CtxMenu (round/border/dark-mode tokens);
 * closes on outside pointerdown, Escape, scroll, or any item click.
 *
 * Usage:
 *   const [pt, setPt] = useState<{x:number;y:number}|null>(null);
 *   <PointMenu x={pt.x} y={pt.y} onClose={() => setPt(null)}>
 *     <PointItem icon={Trash2} label="삭제" danger onClick={...} />
 *   </PointMenu>
 */

export function PointMenu({
  x,
  y,
  onClose,
  children,
}: {
  x: number;
  y: number;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest("[data-point-menu]")) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);
  return (
    <div
      data-point-menu
      className="fixed z-[70] min-w-44 rounded-lg border border-line bg-surface-raised p-1 text-sm text-text shadow-lg"
      style={{
        left: Math.min(x, window.innerWidth - 200),
        top: Math.min(y, window.innerHeight - 160),
      }}
    >
      {children}
    </div>
  );
}

export function PointItem({
  icon: Icon,
  label,
  danger,
  onClick,
}: {
  icon?: LucideIcon;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 text-left outline-none hover:bg-surface-muted ${
        danger ? "text-hue-red" : "text-text"
      }`}
    >
      {Icon && <Icon size={14} className="shrink-0" />}
      {label}
    </button>
  );
}
