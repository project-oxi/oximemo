/**
 * Styled wrappers around Base UI `ContextMenu`. One shared visual vocabulary so
 * every right-click menu in the app looks consistent (round/border/dark-mode
 * matching the existing Popover + Card styling).
 *
 * Usage:
 *   <CtxRoot>
 *     <CtxTrigger render={<button ... />}>        // or default <div>
 *       {content}
 *       <CtxMenu>...CtxItem / CtxSeparator / CtxSubmenu...</CtxMenu>
 *     </CtxTrigger>
 *   </CtxRoot>
 *
 * The CtxMenu portal teleports to <body>, but stays a React descendant of Root,
 * so nesting it inside the trigger is correct. For grid/flex children, pass a
 * `render` element to merge the trigger onto the existing node (no wrapper div).
 */
import { ContextMenu } from "@base-ui-components/react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/** Context provider — renders no HTML. Must wrap a Trigger + its CtxMenu. */
export const CtxRoot = ContextMenu.Root;

/** Trigger area — opens on right-click/long-press. Default <div>; pass `render`
 *  to merge onto an existing element (button/article) and avoid a wrapper div. */
export const CtxTrigger = ContextMenu.Trigger;

const POPUP_CLS =
  "min-w-44 rounded-lg border border-zinc-200 bg-white p-1 text-sm text-zinc-700 shadow-xl outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200";

/** Portal + Positioner (z-70, above Dialog z-50 and Popover z-60) + Popup. */
export function CtxMenu({ children }: { children: ReactNode }) {
  return (
    <ContextMenu.Portal>
      <ContextMenu.Positioner className="z-[70]">
        <ContextMenu.Popup className={POPUP_CLS}>{children}</ContextMenu.Popup>
      </ContextMenu.Positioner>
    </ContextMenu.Portal>
  );
}

export function CtxItem({
  icon: Icon,
  label,
  onClick,
  disabled,
  danger,
}: {
  icon?: LucideIcon;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <ContextMenu.Item
      onClick={onClick}
      disabled={disabled}
      className={
        "flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 outline-none data-[highlighted]:bg-zinc-100 disabled:pointer-events-none disabled:opacity-30 dark:data-[highlighted]:bg-zinc-800 " +
        (danger ? "text-red-600 dark:text-red-400" : "")
      }
    >
      {Icon && <Icon size={14} className="shrink-0" />}
      <span className="flex-1">{label}</span>
    </ContextMenu.Item>
  );
}

export function CtxSeparator() {
  return (
    <ContextMenu.Separator className="my-1 h-px bg-zinc-200 dark:bg-zinc-700" />
  );
}

export function CtxGroupLabel({ children }: { children: ReactNode }) {
  return (
    <ContextMenu.GroupLabel className="px-2.5 py-1 text-[11px] font-medium uppercase tracking-wider text-zinc-400">
      {children}
    </ContextMenu.GroupLabel>
  );
}

/** Submenu (▸). children = nested CtxItem list. */
export function CtxSubmenu({
  label,
  icon: Icon,
  children,
}: {
  label: string;
  icon?: LucideIcon;
  children: ReactNode;
}) {
  return (
    <ContextMenu.SubmenuRoot>
      <ContextMenu.SubmenuTrigger className="flex w-full cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 outline-none data-[highlighted]:bg-zinc-100 dark:data-[highlighted]:bg-zinc-800">
        {Icon && <Icon size={14} className="shrink-0" />}
        <span className="flex-1 text-left">{label}</span>
        <span className="text-zinc-400">▸</span>
      </ContextMenu.SubmenuTrigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner align="start" sideOffset={4} className="z-[70]">
          <ContextMenu.Popup className={POPUP_CLS}>{children}</ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.SubmenuRoot>
  );
}
