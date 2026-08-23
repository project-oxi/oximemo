/**
 * Property panel (design 2026-08-23 §7.1, refined to an Obsidian-style
 * two-column table): the note's frontmatter properties edited in place
 * above the body. Schema folders get typed editors — select opens an
 * option popover, multiselect is chips + an always-visible inline
 * autocomplete input, date/text are borderless inputs — with
 * warning-level validation; schema-less folders get the same table in
 * free key/value mode.
 *
 * Edits commit immediately through `update_memo` with a minimal
 * set/remove diff — the backend applies folder-schema transitions
 * (peak_status, status_changed) and the semantic NoOp contract keeps
 * same-value re-saves from touching the file.
 */
import { Popover } from "@base-ui-components/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Plus, Search, X } from "lucide-react";
import { folderSchema, updateMemo } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { propKeyLabel, propValueLabel } from "../lib/propDisplay";
import type {
  FolderSchema,
  Memo,
  PropMutation,
  PropValue,
  Props,
  SchemaPropertyDef,
} from "../lib/types";

/** Unwrap a PropValue envelope into display strings. */
function members(v: PropValue | undefined): string[] {
  if (!v) return [];
  if ("List" in v) return v.List;
  if ("Str" in v) return [v.Str];
  if ("Bool" in v) return [String(v.Bool)];
  return [];
}

function toValue(items: string[]): PropValue {
  return items.length === 1 ? { Str: items[0] } : { List: items };
}

/** Client-side warning-level validation (§6.2 — never blocks a save). */
function violationsOf(
  schema: FolderSchema | null,
  props: Props,
): { key: string; reason: string }[] {
  const out: { key: string; reason: string }[] = [];
  if (!schema?.properties) return out;
  for (const [key, def] of Object.entries(schema.properties)) {
    const ms = members(props[key]);
    if (def.required && ms.length === 0) {
      out.push({ key, reason: "required" });
      continue;
    }
    const opts = def.options ?? [];
    if (opts.length && def.prop_type !== "text") {
      for (const m of ms) {
        if (!opts.includes(m)) out.push({ key, reason: `not allowed: ${m}` });
      }
    }
  }
  return out;
}

// --- Typed value editors ----------------------------------------------------

/** select — borderless current-value button → option popover. */
function SelectEditor({
  propKey,
  value,
  options,
  onChange,
}: {
  propKey: string;
  value: string;
  options: string[];
  onChange: (next: string | null) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
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
            {value ? propValueLabel(propKey, value, t) : "—"}
            <ChevronDown size={10} aria-hidden className="text-text-subtle" />
          </button>
        }
      />
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={2} className="z-[70]">
          <Popover.Popup className="max-h-60 min-w-36 overflow-y-auto rounded-[var(--popover-radius)] border border-line bg-surface-raised p-1 shadow-lg animate-popover-in">
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
                      {propValueLabel(propKey, o, t)}
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
function ChipsEditor({
  propKey,
  values,
  options,
  onChange,
}: {
  propKey: string;
  values: string[];
  options: string[];
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
          {propValueLabel(propKey, v, t)}
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
              <Popover.Popup className="max-h-48 min-w-32 overflow-y-auto rounded-[var(--popover-radius)] border border-line bg-surface-raised p-1 shadow-lg animate-popover-in">
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
                        {propValueLabel(propKey, o, t)}
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

// --- One table row -----------------------------------------------------------

function PropertyRow({
  propKey,
  def,
  values,
  violation,
  onCommit,
}: {
  propKey: string;
  def: SchemaPropertyDef | undefined;
  values: string[];
  violation?: string;
  onCommit: (next: string[] | null) => void;
}) {
  const { t } = useI18n();
  const type = def?.prop_type ?? "text";
  const options = def?.options ?? [];
  const label = propKeyLabel(propKey, t);

  const valueEditor = () => {
    if (type === "select") {
      return (
        <SelectEditor
          propKey={propKey}
          value={values[0] ?? ""}
          options={options}
          onChange={(v) => onCommit(v === null ? null : [v])}
        />
      );
    }
    if (type === "multiselect" || (type !== "date" && values.length > 1)) {
      return (
        <ChipsEditor propKey={propKey} values={values} options={options} onChange={onCommit} />
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
    return (
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
    );
  };

  return (
    <div className="group grid grid-cols-[7rem_minmax(0,1fr)_1.25rem] items-start gap-1 rounded-md px-1 py-0.5 transition-colors duration-150 hover:bg-surface-muted/60">
      <span className="truncate py-0.5 text-[12px] text-text-subtle" title={propKey}>
        {label}
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        {valueEditor()}
        {violation && (
          <span className="pl-1 text-[10px] leading-tight text-hue-red">
            {violation === "required"
              ? t.prop_violation_required
              : violation.startsWith("not allowed: ")
                ? t.prop_violation_not_allowed.replace(
                    "{v}",
                    violation.slice("not allowed: ".length),
                  )
                : violation}
          </span>
        )}
      </div>
      {values.length > 0 ? (
        <button
          type="button"
          aria-label={`${t.prop_remove}: ${label}`}
          title={`${t.prop_remove}: ${label}`}
          onClick={() => onCommit(null)}
          className="mt-0.5 grid size-5 place-items-center rounded-sm text-text-subtle opacity-0 transition-opacity duration-150 hover:text-text focus-visible:opacity-100 group-hover:opacity-100"
        >
          <X size={11} />
        </button>
      ) : (
        <span aria-hidden />
      )}
      {options.length > 0 && type === "text" && (
        <datalist id={`prop-${propKey}-list`}>
          {options.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
      )}
    </div>
  );
}

// --- Add-property row --------------------------------------------------------

function AddPropertyRow({
  defs,
  usedKeys,
  onPick,
}: {
  defs: Record<string, SchemaPropertyDef> | null;
  usedKeys: string[];
  onPick: (key: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const unused = useMemo(() => {
    const declared = defs ? Object.keys(defs) : [];
    const pool = declared.filter((k) => !usedKeys.includes(k));
    const query = q.trim().toLowerCase();
    return query ? pool.filter((k) => k.toLowerCase().includes(query) || propKeyLabel(k, t).toLowerCase().includes(query)) : pool;
  }, [defs, usedKeys, q, t]);
  const custom = q.trim() && !usedKeys.includes(q.trim()) && !(defs && q.trim() in defs);

  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQ("");
      }}
    >
      <Popover.Trigger
        render={
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[12px] text-text-subtle transition-colors duration-150 hover:bg-surface-muted/60 hover:text-text"
          >
            <Plus size={11} />
            {t.prop_add_row}
          </button>
        }
      />
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={2} className="z-[70]">
          <Popover.Popup className="min-w-52 rounded-[var(--popover-radius)] border border-line bg-surface-raised p-1 shadow-lg animate-popover-in">
            <div className="flex items-center gap-1.5 px-1 pb-1">
              <Search size={11} aria-hidden className="text-text-subtle" />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t.prop_search_keys}
                className="w-full bg-transparent py-0.5 text-[12px] text-text outline-none placeholder:text-text-subtle/70"
              />
            </div>
            <ul role="listbox" className="max-h-56 overflow-y-auto">
              {unused.map((k) => (
                <li key={k}>
                  <button
                    type="button"
                    role="option"
                    onClick={() => {
                      onPick(k);
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] text-text-muted transition-colors duration-150 hover:bg-surface-muted hover:text-text"
                  >
                    <span aria-hidden className="size-1 rounded-full bg-text-subtle/50" />
                    {propKeyLabel(k, t)}
                  </button>
                </li>
              ))}
              {custom && (
                <li>
                  <button
                    type="button"
                    onClick={() => {
                      onPick(q.trim());
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] text-interactive-primary transition-colors duration-150 hover:bg-surface-muted"
                  >
                    <Plus size={11} aria-hidden className="shrink-0" />
                    {q.trim()}
                  </button>
                </li>
              )}
              {unused.length === 0 && !custom && (
                <li className="px-2 py-1 text-[12px] text-text-subtle">{t.folder_empty}</li>
              )}
            </ul>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

// --- Panel -------------------------------------------------------------------

export function PropertyPanel({ memo, folder }: { memo: Memo; folder: string }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const schema = useQuery({
    queryKey: ["folder-schema", folder],
    queryFn: () => folderSchema(folder),
    staleTime: 30_000,
  });

  const [props, setProps] = useState<Props>(memo.props ?? {});
  const [expanded, setExpanded] = useState(true);
  useEffect(() => setProps(memo.props ?? {}), [memo.id, memo.props]);

  const commit = async (mutation: PropMutation) => {
    // Optimistic local state; the grid surfaces IPC errors.
    if (mutation.removes.length) {
      setProps((p) => {
        const next = { ...p };
        for (const k of mutation.removes) delete next[k];
        return next;
      });
    }
    if (mutation.sets.length) {
      setProps((p) => {
        const next = { ...p };
        for (const [k, v] of mutation.sets) next[k] = v;
        return next;
      });
    }
    try {
      const n = await updateMemo(memo.id, null, null, mutation);
      qc.setQueryData(["memo", memo.id], n);
      setProps(n.props ?? {});
    } catch {
      setProps(memo.props ?? {});
    }
  };

  const defs = schema.data?.properties ?? null;
  const violations = useMemo(() => violationsOf(schema.data ?? null, props), [schema.data, props]);
  const violationOf = (key: string) => violations.find((v) => v.key === key)?.reason;
  const keys = useMemo(() => {
    const fromSchema = defs ? Object.keys(defs) : [];
    const present = Object.keys(props);
    return [...new Set([...fromSchema, ...present])].sort();
  }, [defs, props]);

  const rows = keys.map((key) => (
    <PropertyRow
      key={key}
      propKey={key}
      def={defs?.[key]}
      values={members(props[key])}
      violation={violationOf(key)}
      onCommit={(next) =>
        commit(
          next === null
            ? { sets: [], removes: [key] }
            : { sets: [[key, toValue(next)]], removes: [] },
        )
      }
    />
  ));

  return (
    <div className="flex flex-col gap-1 border-b border-line pb-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1 self-start text-[11px] font-medium text-text-subtle transition-colors duration-150 hover:text-text"
      >
        <Plus size={11} className={expanded ? "rotate-45 transition-transform" : "transition-transform"} />
        {defs ? t.prop_schema_title : t.prop_free_title}
        <span className="tabular-nums">{keys.length > 0 ? ` ${keys.length}` : ""}</span>
      </button>
      {expanded && (
        <>
          {rows.length > 0 ? (
            <div className="flex flex-col">{rows}</div>
          ) : (
            <p className="px-1 text-[12px] text-text-subtle">{t.prop_empty_list}</p>
          )}
          <AddPropertyRow
            defs={defs}
            usedKeys={keys}
            onPick={(key) => void commit({ sets: [[key, { Str: "" }]], removes: [] })}
          />
        </>
      )}
    </div>
  );
}
