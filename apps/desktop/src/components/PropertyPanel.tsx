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
import { Popover, } from "@base-ui-components/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Calendar, Check, ChevronDown, ChevronRight, ListChecks, Pencil, Plus, Sparkles, SquareCheck, Tags, TriangleAlert, Type, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  folderSchema,
  getConfig,
  searchBookMetadata,
  searchMovieMetadata,
  stampMetadata,
  updateMemo,
  type MetaHit,
} from "../lib/api";
import { effectiveRegion, metadataDomainOf } from "../lib/metadataRegion";
import { useI18n } from "../lib/i18n";
import { useUI } from "../stores/ui";
import { isoToLocalDate, todayLocalISO } from "../lib/dates";
import { propKeyLabel, propValueLabel } from "../lib/propDisplay";
import type {
  FolderSchema,
  Memo,
  PropMutation,
  PropValue,
  Props,
  SchemaPropertyDef,
} from "../lib/types";

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

/** Editor type for a schema-less (custom) key, inferred from the stored
 *  envelope: Bool → toggle, List → chips, ISO-date Str → date input.
 *  Keeps the type the user picked at creation time stable across
 *  reloads without inventing a sidecar store. */
function inferredType(v: PropValue | undefined): "text" | "multiselect" | "date" | "bool" {
  if (!v) return "text";
  if ("Bool" in v) return "bool";
  if ("List" in v) return "multiselect";
  if ("Str" in v && /^\d{4}-\d{2}-\d{2}$/.test(v.Str)) return "date";
  return "text";
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

/** Add-property type choice; "schema" = use the declared def's type. */
type PropTypeChoice = "text" | "list" | "date" | "bool" | "schema";

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
  stored,
  violation,
  onCommit,
  onBool,
  onRename,
}: {
  propKey: string;
  def: SchemaPropertyDef | undefined;
  stored: PropValue | undefined;
  violation?: string;
  onCommit: (next: string[] | null) => void;
  /** Bool-typed commits (toggle) — distinct envelope from string lists. */
  onBool?: (b: boolean) => void;
  /** Custom (schema-less) keys rename in place; schema keys are fixed. */
  onRename?: (nextKey: string) => void;
}) {
  const { t } = useI18n();
  const type = def?.prop_type ?? inferredType(stored);
  const options = def?.options ?? [];
  const label = propKeyLabel(propKey, t);
  const values = members(stored);
  const [naming, setNaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(propKey);
  const onCommitBool = (b: boolean) => {
    // Bool commits bypass the string[] contract via a dedicated setter.
    onBool?.(b);
  };

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
    if (type === "multiselect") {
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
    if (type === "bool") {
      return (
        <button
          type="button"
          role="switch"
          aria-checked={stored && "Bool" in stored ? stored.Bool : false}
          onClick={() => onCommitBool(!(stored && "Bool" in stored ? stored.Bool : false))}
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

  const TypeIcon =
    type === "text"
      ? Type
      : type === "select"
        ? ListChecks
        : type === "multiselect"
          ? Tags
          : type === "date"
            ? Calendar
            : SquareCheck;

  return (
    <div className="group grid grid-cols-[1rem_6.5rem_minmax(0,1fr)_1.25rem] items-start gap-1 rounded-md px-1 py-1 transition-colors duration-150 hover:bg-surface-muted/60">
      <TypeIcon
        size={12}
        aria-hidden
        className="mt-1 shrink-0 text-text-subtle/70"
      />
      {naming ? (
        <input
          autoFocus
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => {
            const v = nameDraft.trim();
            setNaming(false);
            if (v && v !== propKey) onRename?.(v);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape") {
              setNameDraft(propKey);
              setNaming(false);
            }
          }}
          className="w-full bg-transparent px-0.5 py-0 text-[12px] font-medium text-text outline-none"
        />
      ) : onRename ? (
        <button
          type="button"
          title={t.prop_rename_hint}
          onClick={() => {
            setNameDraft(propKey);
            setNaming(true);
          }}
          className="group/name flex min-w-0 items-center gap-0.5 truncate py-0.5 text-left text-[12px] text-text-subtle transition-colors duration-150 hover:text-text"
        >
          <span className="truncate">{label}</span>
          <Pencil
            size={9}
            aria-hidden
            className="shrink-0 opacity-0 transition-opacity duration-150 group-hover/name:opacity-100"
          />
        </button>
      ) : (
        <span className="truncate py-0.5 text-[12px] text-text-subtle" title={propKey}>
          {label}
        </span>
      )}
      <div className="flex min-w-0 flex-col gap-0.5">
        {valueEditor()}
        {violation && (
          <span className="inline-flex items-center gap-0.5 pl-1 text-[10px] leading-tight text-hue-red">
            <TriangleAlert size={9} aria-hidden className="shrink-0" />
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
  onAdd,
}: {
  defs: Record<string, SchemaPropertyDef> | null;
  usedKeys: string[];
  /** Add `key` with the schema's type (declared keys) or the picked
   *  type (custom keys) — Obsidian's name → type → value flow. */
  onAdd: (key: string, type: PropTypeChoice) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<PropTypeChoice>("text");
  const nameTaken = !name.trim() || usedKeys.includes(name.trim()) || (defs ? name.trim() in defs : false);

  const TYPES: { value: PropTypeChoice; label: string }[] = [
    { value: "text", label: t.prop_type_text },
    { value: "list", label: t.prop_type_list },
    { value: "date", label: t.prop_type_date },
    { value: "bool", label: t.prop_type_bool },
  ];

  const reset = () => {
    setName("");
    setType("text");
  };

  return (
    <div className="mt-0.5 border-t border-line/70 pt-1">
      <Popover.Root
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) reset();
        }}
      >
        <Popover.Trigger
          render={
            <button
              type="button"
              className="group/add flex items-center gap-1.5 rounded-md px-1 py-1 text-[12px] text-text-subtle transition-colors duration-150 hover:text-text"
            >
              <span className="grid size-4 place-items-center rounded-full border border-line text-text-subtle transition-colors duration-150 group-hover/add:border-line-strong group-hover/add:text-text">
                <Plus size={9} />
              </span>
              {t.prop_add_row}
            </button>
          }
        />
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={2} className="z-[70]">
          <Popover.Popup className="w-64 rounded-[var(--popover-radius)] border border-line bg-surface-raised p-2 shadow-lg animate-popover-in">
            <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-text-subtle">
              {t.prop_new_section}
            </p>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !nameTaken) {
                  onAdd(name.trim(), type);
                  setOpen(false);
                }
              }}
              placeholder={t.prop_new_key}
              className="w-full rounded-[var(--input-radius)] bg-surface-sunken px-2 py-1 text-[12px] text-text shadow-[var(--input-shadow)] outline-none placeholder:text-text-subtle/70 focus-visible:shadow-[var(--input-shadow-focus)]"
            />
            <div className="mt-1.5 flex items-center gap-1">
              {TYPES.map((ty) => (
                <button
                  key={ty.value}
                  type="button"
                  aria-pressed={type === ty.value}
                  onClick={() => setType(ty.value)}
                  className={`rounded-full px-2 py-0.5 text-[11px] transition-colors duration-150 ${
                    type === ty.value
                      ? "bg-surface-muted font-semibold text-text"
                      : "text-text-subtle hover:bg-surface-muted/60 hover:text-text"
                  }`}
                >
                  {ty.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              disabled={nameTaken}
              onClick={() => {
                onAdd(name.trim(), type);
                setOpen(false);
              }}
              className="mt-2 w-full rounded-[var(--button-radius)] bg-interactive-primary px-2 py-1 text-[12px] font-medium text-interactive-primary-foreground transition-colors duration-150 hover:bg-interactive-primary/90 disabled:opacity-40"
            >
              {t.prop_add_confirm}
            </button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

/**
 * "메타데이터 채우기" (spec §3.5): a search popover under the
 * property rows. Gated by the folder schema declaring at least one
 * `metadata`-mapped prop; the domain (book/movie) comes from the
 * preset marker with field-vocabulary fallback. Choosing a hit stamps
 * via the backend — only empty schema-declared props fill, existing
 * values and the user's judgment (rating/status) stay untouched.
 */
function MetadataFill({
  memo,
  schema,
  region,
  onApplied,
}: {
  memo: Memo;
  schema: FolderSchema | null | undefined;
  region: string | undefined;
  onApplied: (props: Props) => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<MetaHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState<string | null>(null);

  const domain = useMemo(() => metadataDomainOf(schema), [schema]);

  const run = async () => {
    if (!q.trim() || !domain) return;
    setBusy(true);
    try {
      const list =
        domain === "book"
          ? await searchBookMetadata(q, region)
          : await searchMovieMetadata(q, region);
      setHits(list);
    } catch {
      setHits([]);
    } finally {
      setBusy(false);
    }
  };

  const apply = async (hit: MetaHit) => {
    setApplying(hit.url ?? hit.title);
    try {
      const dto = await stampMetadata(memo.id, hit);
      if (!dto) return;
      qc.setQueryData(["memo", memo.id], dto);
      onApplied(dto.props ?? {});
      void qc.invalidateQueries({ queryKey: ["memos"] });
      setOpen(false);
      setHits(null);
      setQ("");
    } finally {
      setApplying(null);
    }
  };

  if (!domain) return null;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <button
            type="button"
            className="flex items-center gap-1 self-start rounded-md px-1 py-0.5 text-[11px] font-medium text-interactive-primary transition-colors duration-150 hover:bg-interactive-primary/10"
          >
            <Sparkles size={11} aria-hidden />
            {t.metadata_fill}
          </button>
        }
      />
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={4} className="z-[70]">
          <Popover.Popup className="w-72 rounded-[var(--popover-radius)] border border-line bg-surface-raised p-2 shadow-lg animate-popover-in">
            <form
              className="flex gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                void run();
              }}
            >
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t.metadata_fill_query}
                className="min-w-0 flex-1 rounded-md bg-surface-sunken px-2 py-1 text-[12px] text-text outline-none placeholder:text-text-subtle focus:ring-1 focus:ring-line"
              />
              <button
                type="submit"
                disabled={busy || !q.trim()}
                className="rounded-md bg-interactive-primary px-2 py-1 text-[11px] font-medium text-interactive-primary-foreground transition-colors hover:bg-interactive-primary-hover disabled:opacity-50"
              >
                {busy ? "…" : t.metadata_fill_search}
              </button>
            </form>
            <div className="mt-1.5 max-h-56 overflow-y-auto">
              {hits === null ? null : hits.length === 0 ? (
                <p className="px-1 py-2 text-[11px] leading-relaxed text-text-subtle">{t.metadata_fill_empty}</p>
              ) : (
                <ul role="listbox">
                  {hits.map((h) => (
                    <li key={`${h.provider}:${h.url ?? h.title}:${h.subtitle ?? ""}`}>
                      <button
                        type="button"
                        disabled={applying !== null}
                        onClick={() => void apply(h)}
                        className="flex w-full flex-col items-start gap-0.5 rounded-md px-1.5 py-1.5 text-left transition-colors duration-100 hover:bg-surface-muted disabled:opacity-50"
                      >
                        <span className="line-clamp-1 text-[12px] font-medium text-text">{h.title}</span>
                        {h.subtitle && (
                          <span className="line-clamp-1 text-[10px] text-text-subtle">{h.subtitle}</span>
                        )}
                        <span className="text-[9px] uppercase tracking-wide text-text-subtle/80">
                          {t.metadata_fill_provider}: {h.provider}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function PropertyPanel({ memo, folder }: { memo: Memo; folder: string }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const draftId = useUI((s) => s.draftId);
  const setDraftId = useUI((s) => s.setDraftId);
  const schema = useQuery({
    queryKey: ["folder-schema", folder],
    queryFn: () => folderSchema(folder),
    staleTime: 30_000,
  });
  const config = useQuery({
    queryKey: ["config"],
    queryFn: getConfig,
    staleTime: 60_000,
  });
  // Auto ("") region resolves through Intl here; an explicit stored
  // choice rides the config into the backend and stays undefined.
  const fillRegion = config.data?.metadata?.region
    ? undefined
    : effectiveRegion("") || undefined;

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
      // A property write means the user touched this note: a session
      // draft (fresh daily note, blank capture) must no longer be
      // discarded on close — only body-pristine drafts are (user prompt
      // 2026-08-23: setting just the mood must keep the day's note).
      if (draftId === memo.id) setDraftId(null);
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
      stored={props[key]}
      violation={violationOf(key)}
      onCommit={(next) =>
        commit(
          next === null
            ? { sets: [], removes: [key] }
            : { sets: [[key, toValue(next)]], removes: [] },
        )
      }
      onBool={(b) => void commit({ sets: [[key, { Bool: b }]], removes: [] })}
      onRename={
        defs && key in defs
          ? undefined
          : (nextKey) =>
              void commit({
                sets: [[nextKey, props[key] ?? { Str: "" }]],
                removes: [key],
              })
      }
    />
  ));

  return (
    <div className="flex max-h-[60%] min-h-0 shrink flex-col gap-1.5 overflow-y-auto border-b border-line pb-2.5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1 self-start text-[10px] font-semibold uppercase tracking-wide text-text-subtle transition-colors duration-150 hover:text-text"
      >
        <ChevronRight
          size={11}
          aria-hidden
          className={expanded ? "rotate-90 transition-transform duration-150" : "transition-transform duration-150"}
        />
        {defs ? t.prop_schema_title : t.prop_free_title}
        {keys.length > 0 && (
          <span className="rounded-full border border-line bg-surface-muted px-1.5 text-[9px] font-semibold normal-case tracking-normal tabular-nums text-text-subtle">
            {keys.length}
          </span>
        )}
      </button>
      {expanded && (
        <>
          {rows.length > 0 ? (
            <div className="flex flex-col">{rows}</div>
          ) : (
            <p className="px-1 text-[12px] text-text-subtle">{t.prop_empty_list}</p>
          )}
          <MetadataFill
            memo={memo}
            schema={schema.data}
            region={fillRegion}
            onApplied={(p) => setProps(p)}
          />
          <AddPropertyRow
            defs={defs}
            usedKeys={keys}
            onAdd={(key, type) => {
              const initial: PropValue =
                type === "list"
                  ? { List: [] }
                  : type === "date"
                    ? { Str: todayLocalISO() }
                    : type === "bool"
                      ? { Bool: false }
                      : { Str: "" };
              void commit({ sets: [[key, initial]], removes: [] });
            }}
          />
          {/* Core timestamps as a quiet read-only footer (user prompt
           * 2026-08-23): every note shows when it was made and last
           *  edited — displayed from the core keys, never re-stored. */}
          <div className="flex items-center gap-2 px-1 pt-0.5 text-[10px] text-text-subtle/70">
            <span className="tabular-nums">
              {t.prop_created} {isoToLocalDate(memo.created_at)}
            </span>
            <span aria-hidden>·</span>
            <span className="tabular-nums">
              {t.prop_updated} {isoToLocalDate(memo.updated_at)}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
