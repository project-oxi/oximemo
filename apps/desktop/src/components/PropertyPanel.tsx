/**
 * Property panel (design 2026-08-23 §7.1): the note's frontmatter
 * properties, edited in place above the body. Schema folders get typed
 * editors (select / multiselect chips / date / text) with warning-level
 * validation; schema-less folders get a free key/value editor.
 *
 * Edits commit immediately through `update_memo` with a minimal
 * set/remove diff — the backend applies folder-schema transitions
 * (peak_status, status_changed) and the semantic NoOp contract keeps
 * same-value re-saves from touching the file.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { folderSchema, updateMemo } from "../lib/api";
import { useI18n } from "../lib/i18n";
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
  if (!schema?.properties) return [];
  const out: { key: string; reason: string }[] = [];
  for (const [key, def] of Object.entries(schema.properties)) {
    const ms = members(props[key]);
    if (ms.length === 0) {
      if (def.required) out.push({ key, reason: "required" });
      continue;
    }
    const opts = def.options ?? [];
    if (opts.length && def.prop_type !== "text") {
      for (const m of ms) {
        if (!opts.includes(m)) out.push({ key, reason: `not allowed: ${m}` });
      }
    }
    if (def.prop_type === "date" && ms.some((m) => !/^\d{4}-\d{2}-\d{2}$/.test(m))) {
      out.push({ key, reason: "expected YYYY-MM-DD" });
    }
  }
  return out;
}

interface RowProps {
  label: string;
  def: SchemaPropertyDef | undefined;
  values: string[];
  violation?: string;
  onCommit: (next: string[] | null) => void;
}

function PropertyRow({ label, def, values, violation, onCommit }: RowProps) {
  const { t } = useI18n();
  const type = def?.prop_type ?? "text";
  const options = def?.options ?? [];
  const pending = useRef<string | null>(null);
  const pickerOnly = type === "select" || (type === "multiselect" && options.length > 0);
  const picker = (
    <select
      value={values[0] ?? ""}
      onChange={(e) => onCommit(e.target.value === "" ? null : [e.target.value])}
      className="min-w-0 flex-1 rounded-[var(--tag-radius)] border border-line bg-surface px-1.5 py-0.5 text-xs text-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring"
    >
      <option value="">—</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
      {values[0] && !options.includes(values[0]) && (
        <option value={values[0]}>{values[0]}</option>
      )}
    </select>
  );

  const text = (
    <input
      type={type === "date" ? "date" : "text"}
      value={values[0] ?? ""}
      list={options.length ? `prop-${label}-list` : undefined}
      onChange={(e) => {
        const v = e.target.value;
        pending.current = v;
      }}
      onBlur={() => {
        const v = pending.current;
        pending.current = null;
        if (v !== null && v !== (values[0] ?? "")) onCommit(v === "" ? null : [v]);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      className="min-w-0 flex-1 rounded-[var(--tag-radius)] border border-line bg-surface px-1.5 py-0.5 text-xs text-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring"
    />
  );
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 text-[11px] font-medium text-text-subtle">{label}</span>
        {pickerOnly ? picker : text}
        {type === "multiselect" && values.length > 0 && (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {values.map((v) => (
              <span
                key={v}
                className="inline-flex items-center gap-0.5 rounded-[var(--tag-radius)] bg-surface-muted px-1.5 py-0.5 text-[11px] text-text"
              >
                {v}
                <button
                  type="button"
                  aria-label={`${t.prop_remove}: ${v}`}
                  onClick={() => {
                    const next = values.filter((x) => x !== v);
                    onCommit(next.length ? next : null);
                  }}
                  className="text-text-subtle hover:text-text"
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
      {violation && (
        <span className="pl-1 text-[10px] text-hue-red">
          {label}: {violation}
        </span>
      )}
      {type === "multiselect" && options.length > 0 && values.length > 0 && (
        <select
          value=""
          onChange={(e) => e.target.value && onCommit([...values, e.target.value])}
          className="self-start rounded-[var(--tag-radius)] border border-line bg-surface px-1 py-0.5 text-[11px] text-text-subtle"
        >
          <option value="">{t.prop_add_value}</option>
          {options
            .filter((o) => !values.includes(o))
            .map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
        </select>
      )}
      {options.length > 0 && type !== "select" && type !== "multiselect" && (
        <datalist id={`prop-${label}-list`}>
          {options.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
      )}
    </div>
  );
}

export function PropertyPanel({ memo, folder }: { memo: Memo; folder: string }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const schema = useQuery({
    queryKey: ["folder-schema", folder],
    queryFn: () => folderSchema(folder),
  });
  const [props, setProps] = useState<Props>(memo.props ?? {});
  const [expanded, setExpanded] = useState(true);
  useEffect(() => setProps(memo.props ?? {}), [memo.id, memo.props]);

  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");

  const commit = async (mutation: PropMutation) => {
    try {
      const updated = await updateMemo(memo.id, null, null, mutation);
      setProps(updated.props ?? {});
      await qc.invalidateQueries({ queryKey: ["memos"] });
      await qc.invalidateQueries({ queryKey: ["memo", memo.id] });
    } catch {
      /* the grid surfaces IPC errors; the panel stays on its last state */
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
      label={key}
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
        className="flex items-center gap-1 self-start text-[11px] font-medium text-text-subtle hover:text-text"
      >
        <Plus size={11} className={expanded ? "rotate-45 transition-transform" : "transition-transform"} />
        {defs ? t.prop_schema_title : t.prop_free_title}
      </button>
      {expanded && (
        <>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-1.5">{rows}</div>
          <div className="flex items-center gap-1.5">
            <input
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder={t.prop_new_key}
              className="w-24 rounded-[var(--tag-radius)] border border-line bg-surface px-1.5 py-0.5 text-[11px] text-text"
            />
            <input
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              placeholder={t.prop_new_value}
              className="min-w-0 flex-1 rounded-[var(--tag-radius)] border border-line bg-surface px-1.5 py-0.5 text-[11px] text-text"
              onKeyDown={(e) => {
                if (e.key !== "Enter" || !newKey.trim()) return;
                const value = newValue.includes(",")
                  ? { List: newValue.split(",").map((s) => s.trim()).filter(Boolean) }
                  : { Str: newValue.trim() };
                void commit({ sets: [[newKey.trim(), value]], removes: [] });
                setNewKey("");
                setNewValue("");
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
