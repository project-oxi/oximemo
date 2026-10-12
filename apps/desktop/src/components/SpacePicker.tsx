/**
 * Space switcher (spec 2026-08-28 §4): sidebar-header button showing the
 * active space; the popover lists spaces (check on current), offers
 * "새 space…" with a name input (client-side validation mirrors the
 * backend rule), and restarts into a different selection. Filesystem-
 * backed via space_list — works with the brain uninstalled.
 */
import { Popover } from "@base-ui-components/react";
import { Button, Input } from "@garden/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Plus } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { spaceCreate, spaceList, spaceSwitch } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { validSpaceName } from "../lib/spaceName";
import { useUI } from "../stores/ui";

export function SpacePicker() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const setError = useUI((s) => s.setError);
  const open = useUI((s) => s.spacePickerOpen);
  const setOpen = useUI((s) => s.setSpacePickerOpen);
  const createMode = useUI((s) => s.spacePickerCreate);
  const spaces = useQuery({ queryKey: ["spaces"], queryFn: spaceList });
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const currentRef = useRef<HTMLButtonElement>(null);
  const triggerId = useId();
  const errorId = useId();

  useEffect(() => {
    if (!open) setName("");
    else if (createMode) inputRef.current?.focus({ preventScroll: true });
  }, [open, createMode]);

  const current = spaces.data?.find((s) => s.current)?.name ?? "personal";
  const badName = name.trim().length > 0 && !validSpaceName(name);

  const pick = (n: string) => {
    if (busy.current) return;
    if (n === current) {
      setOpen(false);
      return;
    }
    busy.current = true;
    setPending(true);
    void spaceSwitch(n).catch((e) => {
      busy.current = false;
      setPending(false);
      setError(String(e).split("\n")[0]);
    });
    // app restarts; no local state to clean up on success
  };

  const create = () => {
    if (busy.current || !validSpaceName(name)) return;
    busy.current = true;
    setPending(true);
    void spaceCreate(name.trim())
      .then(() => {
        setName("");
        setOpen(false);
        void qc.invalidateQueries({ queryKey: ["spaces"] });
        // Stay in the current space after create; switching is explicit.
      })
      .catch((e) => setError(String(e).split("\n")[0]))
      .finally(() => {
        busy.current = false;
        setPending(false);
      });
  };

  return (
    <div className="space-picker relative" data-tauri-drag-region={false}>
      <Popover.Root open={open} triggerId={triggerId} onOpenChange={setOpen}>
        <Popover.Trigger
          id={triggerId}
          aria-label={`${t.palette_space_switch}: ${current}`}
          title={current}
          className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-[12px] font-medium text-text transition-colors hover:bg-surface-muted"
        >
          <span className="min-w-0 flex-1 truncate text-left font-mono">{current}</span>
          <ChevronDown size={12} aria-hidden className="shrink-0 text-text-subtle" />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="start" sideOffset={6} collisionPadding={12} className="z-[60]">
            <Popover.Popup
              className="space-picker-popup glass-menu"
              initialFocus={() => (createMode ? inputRef.current : currentRef.current) ?? true}
              finalFocus={() => useUI.getState().sidebarCollapsed ? document.querySelector<HTMLElement>("[data-sidebar-toggle]") : true}
              aria-busy={pending}
            >
              <Popover.Title className="sr-only">{t.palette_space_switch}</Popover.Title>
              <div className="space-picker-list">
                {spaces.data?.map((s) => (
                  <button
                    key={s.name}
                    ref={s.current ? currentRef : undefined}
                    type="button"
                    disabled={pending}
                    aria-pressed={s.current}
                    title={s.name}
                    onClick={() => pick(s.name)}
                    className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-text transition-colors hover:bg-surface-muted disabled:opacity-50"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono">{s.name}</span>
                    {s.current && <Check size={12} aria-hidden className="shrink-0 text-text-subtle" />}
                  </button>
                ))}
              </div>
              <div className="space-picker-actions mt-1 shrink-0 border-t border-line pt-1">
                {createMode ? (
                  <div className="flex min-w-0 items-center gap-2 px-1 py-1">
                    <Input
                      ref={inputRef}
                      value={name}
                      aria-label={t.space_name_ph}
                      aria-invalid={badName}
                      aria-describedby={badName ? errorId : undefined}
                      disabled={pending}
                      placeholder={t.space_name_ph}
                      onChange={(e) => setName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
                          e.preventDefault();
                          create();
                        }
                      }}
                      className="flex-1 px-2 font-mono text-[12px]"
                    />
                    <Button
                      type="button"
                      onClick={create}
                      disabled={pending || !validSpaceName(name)}
                      className="px-2 text-[12px]"
                    >
                      {pending ? t.space_creating : t.space_create_confirm}
                    </Button>
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => useUI.getState().requestSpaceCreate()}
                    className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] text-text-subtle transition-colors hover:bg-surface-muted hover:text-text"
                  >
                    <Plus size={12} aria-hidden className="shrink-0" />
                    {t.space_new}
                  </button>
                )}
                {createMode && badName && (
                  <p id={errorId} className="px-2 pb-1 pt-0.5 text-[11px] text-hue-red">{t.space_name_invalid}</p>
                )}
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
