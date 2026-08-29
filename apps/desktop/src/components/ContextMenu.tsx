/**
 * Styled wrappers around Base UI `ContextMenu` AND `Menu`. One shared visual
 * vocabulary so every right-click menu AND every left-click popover menu in
 * the app looks consistent (round/border/dark-mode matching the existing
 * Popover + Card styling).
 *
 * Usage (right-click):
 *   <CtxRoot>
 *     <CtxTrigger render={<button ... />}>        // or default <div>
 *       {content}
 *       <CtxMenu>...CtxItem / CtxSeparator / CtxSubmenu...</CtxMenu>
 *     </CtxTrigger>
 *   </CtxRoot>
 *
 * Usage (left-click — e.g. a MoreHorizontal button):
 *   <BtnMenuRoot>
 *     <BtnMenuTrigger render={<button ... />}>
 *       <BtnMenuPopup>...BtnMenuItem / BtnMenuSeparator...</BtnMenuPopup>
 *     </BtnMenuTrigger>
 *   </BtnMenuRoot>
 *
 * The popup portals teleport to <body>, but stay React descendants of Root,
 * so nesting them inside the trigger is correct. For grid/flex children,
 * pass a `render` element to merge the trigger onto the existing node (no
 * wrapper div).
 */
import { ContextMenu, Menu } from "@base-ui-components/react";
import { Check, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/** Context provider — renders no HTML. Must wrap a Trigger + its CtxMenu. */
export const CtxRoot = ContextMenu.Root;

/** Trigger area — opens on right-click/long-press. Default <div>; pass `render`
 *  to merge onto an existing element (button/article) and avoid a wrapper div. */
export const CtxTrigger = ContextMenu.Trigger;

const POPUP_CLS =
  "min-w-44 rounded-lg border border-line bg-surface-raised p-1 text-sm text-text shadow-lg outline-none";

/** Portal + Positioner (z-70, above Dialog z-50 and Popover z-60) + Popup. */
export function CtxMenu({ children }: { children: ReactNode }) {
  return (
    <ContextMenu.Portal>
      <ContextMenu.Positioner className="z-[70]">
        {/* Menu items portal to <body>, but React synthetic events still
            bubble through the React tree — an item click would reach the
            trigger element's own onClick (e.g. open folder / select note).
            Stop propagation at the popup so item clicks do only their item. */}
        <ContextMenu.Popup className={POPUP_CLS} onClick={(e) => e.stopPropagation()}>
          {children}
        </ContextMenu.Popup>
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
  swatch,
  active,
  title,
  keepOpen,
}: {
  icon?: LucideIcon;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** CSS color rendered as a leading dot (takes precedence over `icon`). */
  swatch?: string;
  /** Show a trailing check (e.g. the currently-selected value). */
  active?: boolean;
  /** Native tooltip (e.g. the armed-delete confirmation wording). */
  title?: string;
  /** Keep the menu open after this item's click (e.g. the delete arm —
   *  the confirm must appear in the SAME session, closing would reset it). */
  keepOpen?: boolean;
}) {
  return (
    <ContextMenu.Item
      onClick={onClick}
      disabled={disabled}
      title={title}
      closeOnClick={keepOpen === true ? false : undefined}
      className={
        "flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 outline-none data-[highlighted]:bg-surface-muted disabled:pointer-events-none disabled:opacity-30 " +
        (danger ? "text-status-error" : "")
      }
    >
      {swatch !== undefined ? (
        <span
          className="h-3.5 w-3.5 shrink-0 rounded-full border border-line"
          style={{ backgroundColor: swatch }}
        />
      ) : Icon ? (
        <Icon size={14} className="shrink-0" />
      ) : null}
      <span className="flex-1">{label}</span>
      {active && <Check size={14} className="shrink-0 text-text-subtle" />}
    </ContextMenu.Item>
  );
}

export function CtxSeparator() {
  return (
    <ContextMenu.Separator className="my-1 h-px bg-line" />
  );
}

export function CtxGroupLabel({ children }: { children: ReactNode }) {
  return (
    <ContextMenu.GroupLabel className="px-2.5 py-1 text-[11px] font-medium uppercase tracking-wider text-text-subtle">
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
      <ContextMenu.SubmenuTrigger className="flex w-full cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 outline-none data-[highlighted]:bg-surface-muted">
        {Icon && <Icon size={14} className="shrink-0" />}
        <span className="flex-1 text-left">{label}</span>
        <span className="text-text-subtle">▸</span>
      </ContextMenu.SubmenuTrigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner align="start" sideOffset={4} className="z-[70]">
          <ContextMenu.Popup className={POPUP_CLS}>{children}</ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.SubmenuRoot>
  );
}

/* ---------------------------------------------------------------------
 * Left-click popover menu (Base UI `Menu`). Used by the "�" affordance on
 * sidebar rows and any other button-driven dropdown that needs the same
 * visual vocabulary as CtxMenu. Same POPUP_CLS, same item chrome — only
 * the trigger semantics differ (left-click vs right-click).
 * ------------------------------------------------------------------- */

/** Context provider — renders no HTML. Must wrap a Trigger + its popup. */
export const BtnMenuRoot = Menu.Root;

/** Trigger — opens on left-click / Enter / Space. Pass `render` to merge
 *  onto an existing element (e.g. a positioned icon button). */
export const BtnMenuTrigger = Menu.Trigger;

/** Portal + Positioner (z-70) + Popup. Items inside share the CtxItem
 *  chrome via `BtnMenuItem`. */
export function BtnMenuPopup({ children }: { children: ReactNode }) {
  return (
    <Menu.Portal>
      <Menu.Positioner sideOffset={4} className="z-[70]">
        {/* Stop propagation at the popup so an item click never reaches the
            trigger's own onClick (e.g. the query row's openBase click). */}
        <Menu.Popup className={POPUP_CLS} onClick={(e) => e.stopPropagation()}>
          {children}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  );
}

export function BtnMenuItem({
  icon: Icon,
  label,
  onClick,
  disabled,
  danger,
  keepOpen,
}: {
  icon?: LucideIcon;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** Keep the menu open after this item's click (mirror of CtxItem's flag). */
  keepOpen?: boolean;
}) {
  return (
    <Menu.Item
      onClick={onClick}
      disabled={disabled}
      closeOnClick={keepOpen === true ? false : undefined}
      className={
        "flex cursor-default items-center gap-2 rounded-md px-2.5 py-1.5 outline-none data-[highlighted]:bg-surface-muted disabled:pointer-events-none disabled:opacity-30 " +
        (danger ? "text-status-error" : "")
      }
    >
      {Icon && <Icon size={14} className="shrink-0" />}
      <span className="flex-1">{label}</span>
    </Menu.Item>
  );
}

export function BtnMenuSeparator() {
  return <Menu.Separator className="my-1 h-px bg-line" />;
}
