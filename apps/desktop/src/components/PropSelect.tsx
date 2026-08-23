/**
 * Designed select for the schema toolbar (filters + sort) — replaces the
 * native <select>, which broke the surface's polish. Base UI Popover per
 * the SegmentPopover pattern; trigger is a compact chip, options are a
 * checkmark list.
 */
import { Popover } from "@base-ui-components/react";
import { Check, ChevronDown } from "lucide-react";
import { useState } from "react";

export interface SelectOption {
  value: string;
  label: string;
}

export function PropSelect({
  label,
  value,
  options,
  onChange,
}: {
  /** Chip caption (the property's display name or "정렬"). */
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <button
            type="button"
            className={`inline-flex items-center gap-1 rounded-[var(--tag-radius)] border px-1.5 py-0.5 text-[11px] transition-colors duration-150 ${
              current && current.value !== ""
                ? "border-line-strong bg-surface-muted text-text"
                : "border-line bg-surface text-text-subtle hover:border-line-strong hover:text-text"
            }`}
          >
            <span className="font-medium">{label}</span>
            {current && current.value !== "" && <span aria-hidden>·</span>}
            {current && current.value !== "" && (
              <span className="font-semibold text-text">{current.label}</span>
            )}
            <ChevronDown size={10} aria-hidden className="text-text-subtle" />
          </button>
        }
      />
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={3} className="z-50">
          <Popover.Popup className="min-w-40 max-h-64 overflow-y-auto rounded-[var(--popover-radius)] border border-line bg-surface-raised p-1 shadow-lg animate-popover-in">
            <ul role="listbox">
              {options.map((o) => {
                const selected = o.value === value;
                return (
                  <li key={o.value || "__all__"}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => {
                        onChange(o.value);
                        setOpen(false);
                      }}
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] transition-colors duration-150 ${
                        selected
                          ? "bg-surface-muted font-semibold text-text"
                          : "text-text-muted hover:bg-surface-muted hover:text-text"
                      }`}
                    >
                      <Check
                        size={11}
                        aria-hidden
                        className={`shrink-0 ${selected ? "text-text" : "text-transparent"}`}
                      />
                      {o.label}
                    </button>
                  </li>
                );
              })}
            </ul>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
