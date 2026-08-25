/**
 * FilterBuilder (query views spec §5): popover editor over the parsed
 * expression tree (lib/filterTree). Edits either level (base filters / view
 * filters); conditions are property/operator/value rows driven by base_props
 * observed types (conflicting types degrade to equality/contains), anything
 * the shape can't express stays a 고급 expression row.
 */
import { useQuery } from "@tanstack/react-query";
import { Popover } from "@base-ui-components/react";
import { Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { baseProps } from "../lib/api";
import { useI18n } from "../lib/i18n";
import {
  CORE_IDENTS, opsForTypes, type CondOp, type CondValue, type FilterNode,
} from "../lib/filterTree";
import type { PropInfo } from "../lib/types";

interface Props {
  baseNode: FilterNode | null;
  viewNode: FilterNode | null;
  /** Apply a level's tree (null clears the level). */
  onSave: (level: "base" | "view", node: FilterNode | null) => void;
}

const clone = (n: FilterNode): FilterNode => structuredClone(n);
const emptyCond = (): FilterNode => ({ kind: "cond", ident: "file.name", op: "==", value: "" });

export function FilterBuilder({ baseNode, viewNode, onSave }: Props) {
  const { t } = useI18n();
  const propsQ = useQuery({ queryKey: ["base-props"], queryFn: baseProps });
  const props: PropInfo[] = propsQ.data ?? [];
  const [level, setLevel] = useState<"base" | "view">("view");
  const [draft, setDraft] = useState<FilterNode | null>(() =>
    level === "base" ? (baseNode ? clone(baseNode) : null) : viewNode ? clone(viewNode) : null,
  );
  const [open, setOpen] = useState(false);

  const root: FilterNode = draft ?? { kind: "and", children: [emptyCond()] };

  const typesOf = (ident: string): string[] | undefined => {
    const core = CORE_IDENTS.find((c) => c.ident === ident);
    if (core) return [core.type];
    return props.find((p) => p.key === ident)?.observedTypes;
  };
  const optionsOf = (ident: string): string[] =>
    props.find((p) => p.key === ident)?.options ?? [];

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <button
            type="button"
            className="rounded-[var(--button-radius)] border border-line px-2.5 py-1 text-xs text-text-muted transition-colors duration-150 hover:bg-surface-muted hover:text-text"
          >
            {t.query_filter}
          </button>
        }
      />
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={4} className="z-[70]">
          <Popover.Popup
            data-table-portal
            className="max-h-[70vh] w-[30rem] overflow-y-auto rounded-[var(--popover-radius)] border border-line bg-surface-raised p-3 shadow-lg animate-popover-in"
          >
            <div className="mb-2 flex items-center gap-2">
              <div className="inline-flex rounded-[var(--tag-radius)] border border-line p-0.5 text-[11px]">
                {(["view", "base"] as const).map((lv) => (
                  <button
                    key={lv}
                    type="button"
                    aria-pressed={level === lv}
                    onClick={() => {
                      setLevel(lv);
                      setDraft(lv === "base" ? (baseNode ? clone(baseNode) : null) : viewNode ? clone(viewNode) : null);
                    }}
                    className={`rounded-[var(--tag-radius)] px-2 py-0.5 ${
                      level === lv ? "bg-surface-muted font-semibold text-text" : "text-text-muted"
                    }`}
                  >
                    {lv === "view" ? t.query_filter_this_view : t.query_filter_base}
                  </button>
                ))}
              </div>
              <span className="ml-auto flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    onSave(level, draft);
                    setOpen(false);
                  }}
                  className="rounded-[var(--button-radius)] bg-interactive-primary px-2.5 py-1 text-[11px] font-medium text-interactive-primary-foreground"
                >
                  {t.capture_save}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDraft(level === "base" ? (baseNode ? clone(baseNode) : null) : viewNode ? clone(viewNode) : null);
                    setOpen(false);
                  }}
                  className="rounded-[var(--button-radius)] border border-line px-2 py-1 text-[11px] text-text-muted"
                >
                  {t.capture_cancel}
                </button>
              </span>
            </div>

            <NodeEditor
              node={root}
              path={[]}
              onChange={(next) => setDraft(next)}
              typesOf={typesOf}
              optionsOf={optionsOf}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

interface Ctx {
  typesOf: (ident: string) => string[] | undefined;
  optionsOf: (ident: string) => string[];
}

/** Recursive tree editor. `path` addresses the node inside the root
 *  ([] = root group). */
function NodeEditor({
  node,
  path,
  onChange,
  typesOf,
  optionsOf,
}: Ctx & {
  node: FilterNode;
  path: number[];
  onChange: (next: FilterNode | null) => void;
}) {
  const { t } = useI18n();
  if (node.kind === "not") {
    return (
      <div className="rounded-[var(--tag-radius)] border border-line/70 p-1.5">
        <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold text-text-subtle">
          {t.query_filter_not}
          <button
            type="button"
            onClick={() => onChange(node.child)}
            className="ml-auto text-text-subtle hover:text-text"
            aria-label={t.query_filter_remove_not}
          >
            <X size={10} />
          </button>
        </div>
        <NodeEditor
          node={node.child}
          path={path}
          onChange={(child) => onChange(child ? { kind: "not", child } : null)}
          typesOf={typesOf}
          optionsOf={optionsOf}
        />
      </div>
    );
  }
  if (node.kind === "cond" || node.kind === "expr") {
    return (
      <RowEditor
        node={node}
        onChange={onChange}
        onRemove={() => onChange(null)}
        typesOf={typesOf}
        optionsOf={optionsOf}
      />
    );
  }
  // Group (and/or): rows + controls.
  const setChild = (i: number, next: FilterNode | null) => {
    const children = node.children.filter((_, idx) => idx !== i || next !== null);
    const replaced = node.children.map((c, idx) => (idx === i ? next : c)).filter((c): c is FilterNode => c !== null);
    const final = children.length ? replaced : [];
    if (final.length === 0) return onChange(null);
    if (final.length === 1) return onChange(final[0]);
    onChange({ ...node, children: final });
  };
  return (
    <div className="flex flex-col gap-1">
      {path.length > 0 && (
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onChange({ ...(node.kind === "and" ? { kind: "or" } : { kind: "and" }), children: node.children })}
            className="rounded-[var(--tag-radius)] bg-surface-muted px-1.5 py-0.5 text-[10px] font-semibold text-text-muted"
          >
            {node.kind === "and" ? t.query_filter_and : t.query_filter_or}
          </button>
          <button
            type="button"
            onClick={() => onChange({ kind: "not", child: node })}
            className="rounded-[var(--tag-radius)] px-1.5 py-0.5 text-[10px] text-text-subtle hover:bg-surface-muted"
          >
            {t.query_filter_not}
          </button>
        </div>
      )}
      {node.children.map((child, i) => (
        <NodeEditor
          key={i}
          node={child}
          path={[...path, i]}
          onChange={(next) => setChild(i, next)}
          typesOf={typesOf}
          optionsOf={optionsOf}
        />
      ))}
      <div className="flex items-center gap-1 pt-1">
        <button
          type="button"
          onClick={() => onChange({ ...node, children: [...node.children, emptyCond()] })}
          className="flex items-center gap-1 rounded-[var(--tag-radius)] border border-dashed border-line px-1.5 py-0.5 text-[10px] text-text-muted hover:text-text"
        >
          <Plus size={10} /> {t.query_builder_add_condition}
        </button>
        <button
          type="button"
          onClick={() =>
            onChange({
              ...node,
              children: [...node.children, { kind: "and", children: [emptyCond()] }],
            })
          }
          className="flex items-center gap-1 rounded-[var(--tag-radius)] border border-dashed border-line px-1.5 py-0.5 text-[10px] text-text-muted hover:text-text"
        >
          <Plus size={10} /> {t.query_filter_group}
        </button>
        <button
          type="button"
          onClick={() => onChange({ ...node, children: [...node.children, { kind: "expr", text: "" }] })}
          className="flex items-center gap-1 rounded-[var(--tag-radius)] border border-dashed border-line px-1.5 py-0.5 text-[10px] text-text-muted hover:text-text"
        >
          <Plus size={10} /> {t.query_builder_advanced}
        </button>
      </div>
    </div>
  );
}

function RowEditor({
  node,
  onChange,
  onRemove,
  typesOf,
  optionsOf,
}: Ctx & {
  node: { kind: "cond"; ident: string; op: CondOp; value: CondValue } | { kind: "expr"; text: string };
  onChange: (next: FilterNode) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  if (node.kind === "expr") {
    return (
      <div className="flex items-center gap-1">
        <input
          value={node.text}
          onChange={(e) => onChange({ kind: "expr", text: e.target.value })}
          placeholder='예: (now() - file.created).days() > 7'
          className="min-w-0 flex-1 rounded-[var(--input-radius)] border border-line bg-surface px-1.5 py-1 text-[11px] outline-none"
        />
        <button type="button" onClick={onRemove} aria-label={t.query_delete} className="text-text-subtle hover:text-status-error">
          <Trash2 size={11} />
        </button>
      </div>
    );
  }
  const ops = opsForTypes(typesOf(node.ident));
  const options = optionsOf(node.ident);
  const core = CORE_IDENTS.find((c) => c.ident === node.ident);
  return (
    <div className="flex items-center gap-1">
      <select
        value={core ? node.ident : node.ident}
        onChange={(e) => onChange({ ...node, ident: e.target.value })}
        className="min-w-0 flex-1 rounded-[var(--input-radius)] border border-line bg-surface px-1 py-1 text-[11px]"
      >
        {!core && <option value={node.ident}>{node.ident}</option>}
        {CORE_IDENTS.map((c) => (
          <option key={c.ident} value={c.ident}>
            {c.ident}
          </option>
        ))}
        <optgroup label="props">
          <PropOptions selected={node.ident} />
        </optgroup>
      </select>
      <select
        value={node.op}
        onChange={(e) => onChange({ ...node, op: e.target.value as CondOp })}
        className="rounded-[var(--input-radius)] border border-line bg-surface px-1 py-1 text-[11px]"
      >
        {ops.map((op) => (
          <option key={op} value={op}>
            {op}
          </option>
        ))}
        {!ops.includes(node.op) && <option value={node.op}>{node.op}</option>}
      </select>
      <input
        value={node.value === null ? "" : String(node.value)}
        list={options.length ? `fb-${node.ident}` : undefined}
        onChange={(e) => {
          const v = e.target.value;
          onChange({ ...node, value: v === "" ? null : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v });
        }}
        className="min-w-0 flex-1 rounded-[var(--input-radius)] border border-line bg-surface px-1.5 py-1 text-[11px]"
      />
      {options.length > 0 && (
        <datalist id={`fb-${node.ident}`}>
          {options.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
      )}
      <button type="button" onClick={onRemove} aria-label={t.query_delete} className="text-text-subtle hover:text-status-error">
        <Trash2 size={11} />
      </button>
    </div>
  );
}

/** PropInfo keys as select options (base_props catalog). */
function PropOptions({ selected }: { selected: string }) {
  const propsQ = useQuery({ queryKey: ["base-props"], queryFn: baseProps });
  const props = propsQ.data ?? [];
  return (
    <>
      {props.map((p) => (
        <option key={p.key} value={p.key}>
          {p.key}
        </option>
      ))}
      {!props.some((p) => p.key === selected) && selected && !selected.startsWith("file.") && (
        <option value={selected}>{selected}</option>
      )}
    </>
  );
}
