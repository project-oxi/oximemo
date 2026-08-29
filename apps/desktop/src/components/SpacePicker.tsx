/**
 * Space switcher (spec 2026-08-28 §4): sidebar-header button showing the
 * active space; the popover lists spaces (check on current), offers
 * "새 space…" with a name input (client-side validation mirrors the
 * backend rule), and restarts into a different selection. Filesystem-
 * backed via space_list — works with the brain uninstalled.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Plus } from "lucide-react";
import { useState } from "react";
import { spaceCreate, spaceList, spaceSwitch } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useUI } from "../stores/ui";

/** Same rule the backend enforces (letters/digits/-/_ after trim, 1..=64). */
export function validSpaceName(raw: string): boolean {
  const name = raw.trim();
  if (name.length < 1 || name.length > 64) return false;
  return /^[\p{L}\p{N}\-_]+$/u.test(name);
}

export function SpacePicker() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const setError = useUI((s) => s.setError);
  const open = useUI((s) => s.spacePickerOpen);
  const setOpen = useUI((s) => s.setSpacePickerOpen);
  const createMode = useUI((s) => s.spacePickerCreate);
  const consumeCreate = useUI((s) => s.consumeSpaceCreate);
  const spaces = useQuery({ queryKey: ["spaces"], queryFn: spaceList });
  const [name, setName] = useState("");

  const current = spaces.data?.find((s) => s.current)?.name ?? "personal";
  const badName = name.trim().length > 0 && !validSpaceName(name);

  const pick = (n: string) => {
    if (n === current) {
      setOpen(false);
      return;
    }
    void spaceSwitch(n).catch((e) => setError(String(e).split("\n")[0]));
    // app restarts; no local state to clean up on success
  };

  const create = () => {
    if (!validSpaceName(name)) return;
    void spaceCreate(name.trim())
      .then(() => {
        setName("");
        setOpen(false);
        consumeCreate();
        void qc.invalidateQueries({ queryKey: ["spaces"] });
        // Stay in the current space after create; switching is explicit.
      })
      .catch((e) => setError(String(e).split("\n")[0]));
  };

  return (
    <div className="relative px-3 pb-1" data-tauri-drag-region={false}>
      <button
        type="button"
        onClick={() => {
          setOpen(!open);
          if (!open) consumeCreate();
        }}
        className="flex w-full items-center justify-between rounded-md px-2 py-1 text-[12px] font-medium text-text transition-colors hover:bg-surface-muted"
      >
        <span className="flex items-center gap-1.5 truncate">
          <span className="font-mono">{current}</span>
        </span>
        <ChevronDown size={12} className="text-text-subtle" />
      </button>
      {open && (
        <div className="absolute left-3 right-3 top-full z-40 rounded-lg border border-line bg-surface-raised p-1 shadow-lg">
          {spaces.data?.map((s) => (
            <button
              key={s.name}
              type="button"
              onClick={() => pick(s.name)}
              className="flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-[12px] text-text transition-colors hover:bg-surface-muted"
            >
              <span className="font-mono">{s.name}</span>
              {s.current && <Check size={12} className="text-text-subtle" />}
            </button>
          ))}
          <div className="mt-1 border-t border-line pt-1">
            {createMode ? (
              <div className="flex items-center gap-1 px-1 py-0.5">
                <input
                  autoFocus
                  value={name}
                  placeholder={t.space_name_ph}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") create();
                    if (e.key === "Escape") {
                      setOpen(false);
                      consumeCreate();
                    }
                  }}
                  className={`w-full rounded-md bg-surface-sunken px-2 py-1 font-mono text-[12px] text-text outline-none focus:ring-1 ${badName ? "ring-hue-red" : "focus:ring-line"}`}
                />
                <button
                  type="button"
                  onClick={create}
                  disabled={!validSpaceName(name)}
                  className="shrink-0 rounded-md bg-interactive-primary px-2 py-1 text-[11px] font-medium text-interactive-primary-foreground disabled:opacity-40"
                >
                  {t.space_create_confirm}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => useUI.getState().requestSpaceCreate()}
                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] text-text-subtle transition-colors hover:bg-surface-muted hover:text-text"
              >
                <Plus size={12} />
                {t.space_new}
              </button>
            )}
            {badName && (
              <p className="px-2 pb-1 pt-0.5 text-[10px] text-hue-red">{t.space_name_invalid}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
