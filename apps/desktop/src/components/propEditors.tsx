/**
 * Typed property-value editors shared by PropertyPanel and TableView
 * (query views spec §4). Extracted verbatim from PropertyPanel so table
 * cells and the side panel commit through the identical interaction set.
 */
import { Popover } from "@base-ui-components/react";
import { Check, ChevronDown, Plus, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useI18n } from "../lib/i18n";
import { badgeTone, propValueLabel } from "../lib/propDisplay";
import { inferredType } from "../lib/tableModel";
import type { PropValue, SchemaPropertyDef } from "../lib/types";

function members(v: PropValue | undefined): string[] {
  if (!v) return [];
  if ("List" in v) return v.List;
  if ("Str" in v) return [v.Str];
  if ("Bool" in v) return [String(v.Bool)];
  return [];
}

export function SelectEditor({
  propKey,
  value,
  options,
  preset,
  colors,
  onChange,
}: {
  propKey: string;
  value: string;
  options: string[];
  preset?: string;
  /** Schema color tokens (value → tone) for the badge treatment (§4). */
  colors?: Record<string, string>;
  onChange: (next: string | null) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const tone = badgeTone(colors?.[value]);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <button
            type="button"
            className={`inline-flex items-center gap-1 rounded-[var(--tag-radius)] px-1 text-left text-[12px] transition-colors duration-150 hover:bg-surface-muted ${
              value ? "text-text" : "text-text-subtle"
            }`}
          >
            {value ? (
              tone ? (
                <span className={`rounded-[var(--tag-radius)] px-1.5 py-px font-semibold ${tone}`}>
                  {propValueLabel(propKey, value, t, preset)}
                </span>
              ) : (
                propValueLabel(propKey, value, t, preset)
              )
            ) : (
              "—"
            )}
            <ChevronDown size={10} aria-hidden className="text-text-subtle" />
          </button>
        }
      />
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={2} className="z-[70]">
          <Popover.Popup data-table-portal className="max-h-60 min-w-36 overflow-y-auto rounded-[var(--popover-radius)] border border-line bg-surface-raised p-1 shadow-lg animate-popover-in">
            <ul role="listbox">
              {value && (
                <li>
                  <button
                    type="button"
                    role="option"
                    onClick={() => {
                      onChange(null);
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] text-text-subtle transition-colors duration-150 hover:bg-surface-muted hover:text-text"
                  >
                    <X size={11} aria-hidden className="shrink-0" />
                    {t.prop_clear}
                  </button>
                </li>
              )}
              {options.map((o) => {
                const selected = o === value;
                return (
                  <li key={o}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => {
                        onChange(o);
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
                      {propValueLabel(propKey, o, t, preset)}
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

/** multiselect — chips + inline input with autocomplete of the remaining
 *  options (Obsidian list-property behavior). Enter adds the typed value
 *  (or the highlighted suggestion), Backspace on empty removes the last
 *  chip, chip × removes that member. */
export function ChipsEditor({
  propKey,
  values,
  options,
  preset,
  onChange,
}: {
  propKey: string;
  values: string[];
  options: string[];
  preset?: string;
  onChange: (next: string[] | null) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const remaining = options.filter((o) => !values.includes(o));
  const matches = useMemo(() => {
    const q = draft.trim().toLowerCase();
    const pool = options.length ? remaining : values.concat([]); // free keys: no suggestions
    return options.length && q
      ? pool.filter((o) => o.toLowerCase().includes(q))
      : options.length
        ? pool
        : [];
  }, [draft, options.length, remaining, values]);
  const top = matches[0];

  const add = (v: string) => {
    const clean = v.trim();
    if (!clean || values.includes(clean)) return;
    onChange([...values, clean]);
    setDraft("");
  };

  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
      {values.map((v) => (
        <span
          key={v}
          className="inline-flex items-center gap-0.5 rounded-[var(--tag-radius)] bg-surface-muted px-1.5 py-0.5 text-[11px] text-text"
        >
          {propValueLabel(propKey, v, t, preset)}
          <button
            type="button"
            aria-label={`${t.prop_remove}: ${v}`}
            onClick={() => {
              const next = values.filter((x) => x !== v);
              onChange(next.length ? next : null);
            }}
            className="text-text-subtle transition-colors duration-150 hover:text-text"
          >
            <X size={10} />
          </button>
        </span>
      ))}
      <Popover.Root open={menuOpen && (matches.length > 0 || draft.trim().length > 0)} onOpenChange={setMenuOpen}>
        <Popover.Trigger
          render={
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={() => setMenuOpen(true)}
              onBlur={() => window.setTimeout(() => setMenuOpen(false), 120)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add(top && !options.includes(draft.trim()) ? top : draft || top || "");
                } else if (e.key === "Backspace" && draft === "" && values.length > 0) {
                  const next = values.slice(0, -1);
                  onChange(next.length ? next : null);
                }
              }}
              placeholder={t.prop_value_placeholder}
              className="min-w-14 flex-1 bg-transparent px-0.5 py-0 text-[12px] text-text outline-none placeholder:text-text-subtle/70"
            />
          }
        />
        {(matches.length > 0 || draft.trim().length > 0) && (
          <Popover.Portal>
            <Popover.Positioner side="bottom" align="start" sideOffset={2} className="z-[70]">
              <Popover.Popup data-table-portal className="max-h-48 min-w-32 overflow-y-auto rounded-[var(--popover-radius)] border border-line bg-surface-raised p-1 shadow-lg animate-popover-in">
                <ul role="listbox">
                  {matches.slice(0, 8).map((o, i) => (
                    <li key={o}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={i === 0}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => add(o)}
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] transition-colors duration-150 ${
                          i === 0
                            ? "bg-surface-muted font-semibold text-text"
                            : "text-text-muted hover:bg-surface-muted hover:text-text"
                        }`}
                      >
                        <Check size={11} aria-hidden className={i === 0 ? "shrink-0 text-text" : "shrink-0 text-transparent"} />
                        {propValueLabel(propKey, o, t, preset)}
                      </button>
                    </li>
                  ))}
                  {matches.length === 0 && draft.trim() && (
                    <li>
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => add(draft)}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] text-interactive-primary transition-colors duration-150 hover:bg-surface-muted"
                      >
                        <Plus size={11} aria-hidden className="shrink-0" />
                        {draft.trim()}
                      </button>
                    </li>
                  )}
                </ul>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        )}
      </Popover.Root>
    </div>
  );
}

export interface PropCellEditorProps {
  propKey: string;
  def: SchemaPropertyDef | undefined;
  stored: PropValue | undefined;
  /** Folder preset id for propValueLabel's first-party vocabulary. */
  preset?: string;
  /** String-list commits (select/multiselect/date/text); null clears. */
  onCommit: (next: string[] | null) => void;
  /** Bool commits bypass the string[] contract via a dedicated setter. */
  onBool: (b: boolean) => void;
}

/** One property cell: picks the editor from the schema def (or the stored
 *  envelope for schema-less keys) — PropertyPanel's valueEditor branch
 *  chain lifted unchanged (query views spec §4). */
export function PropCellEditor({
  propKey,
  def,
  stored,
  preset,
  onCommit,
  onBool,
}: PropCellEditorProps) {
  const type = def?.prop_type ?? inferredType(stored);
  const options = def?.options ?? [];
  const values = members(stored);

  if (type === "select") {
    return (
      <SelectEditor
        propKey={propKey}
        value={values[0] ?? ""}
        options={options}
        preset={preset}
        colors={def?.colors}
        onChange={(v) => onCommit(v === null ? null : [v])}
      />
    );
  }
  if (type === "multiselect") {
    return (
      <ChipsEditor propKey={propKey} values={values} options={options} preset={preset} onChange={onCommit} />
    );
  }
  if (type === "date") {
    return (
      <input
        type="date"
        value={values[0] ?? ""}
        onChange={(e) => onCommit(e.target.value ? [e.target.value] : null)}
        className="bg-transparent px-1 py-0 text-[12px] text-text outline-none"
      />
    );
  }
  if (type === "bool") {
    return (
      <button
        type="button"
        role="switch"
        aria-checked={stored && "Bool" in stored ? stored.Bool : false}
        onClick={() => onBool(!(stored && "Bool" in stored ? stored.Bool : false))}
        className="relative inline-flex h-4 w-7 items-center rounded-full bg-surface-muted transition-colors duration-150 aria-checked:bg-hue-blue/70"
      >
        <span
          aria-hidden
          className={`inline-block size-3 rounded-full bg-surface-raised shadow-sm transition-transform duration-150 ${
            stored && "Bool" in stored && stored.Bool ? "translate-x-3.5" : "translate-x-0.5"
          }`}
        />
      </button>
    );
  }
  return (
    <>
      <input
        value={values[0] ?? ""}
        list={options.length ? `prop-${propKey}-list` : undefined}
        placeholder="—"
        onChange={(e) => {
          const v = e.target.value;
          onCommit(v.trim() ? [v] : null);
        }}
        className="min-w-0 flex-1 bg-transparent px-1 py-0 text-[12px] text-text outline-none placeholder:text-text-subtle/70"
      />
      {options.length > 0 && (
        <datalist id={`prop-${propKey}-list`}>
          {options.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
      )}
    </>
  );
}
