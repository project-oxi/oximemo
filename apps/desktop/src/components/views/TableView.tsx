/**
 * TableView — spreadsheet-style property table (query views spec §4).
 * Virtualized rows inside the shared CardGrid scroller, sticky header with
 * HTML5 column drag-reorder (session-only in folder mode; query views
 * write back to YAML — Plan C), frozen first column (file.name → opens
 * the note), collapsible group sections, sticky summary footer.
 *
 * All row/column math lives in lib/tableModel.ts (pure, tested). This
 * component is rendering + the commit path: prop cells edit through the
 * shared PropCellEditor and reconcile from the returned NoteDto, with the
 * displayed row order frozen while an editor is focused (spec §4).
 */
import { useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight, Star } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { updateMemo } from "../../lib/api";
import { isoToLocalDate } from "../../lib/dates";
import { useI18n } from "../../lib/i18n";
import { propValueLabel } from "../../lib/propDisplay";
import {
  applyFrozenOrder, buildColumns, defaultSummaryFn, formatBaseValue, groupRows,
  reconcileRow, summarize, type SummaryFn, type TableColumn,
} from "../../lib/tableModel";
import type { BaseCell, FolderSchema, MemoSummary, PropMutation, PropValue } from "../../lib/types";
import { useUI } from "../../stores/ui";
import { PropCellEditor } from "../propEditors";

const GROUP_H = 28;
const ROW_H = 34;

export interface TableViewProps {
  /** Latest listing rows (CardGrid `items`). */
  items: MemoSummary[];
  /** Folder → schema map (useSchemaInfo). Drives columns + per-row editors. */
  schemas: Record<string, FolderSchema | null>;
  /** Folder appearance order for column building (encounter order). */
  folderOrder: string[];
  /** Preset id when every row shares one schema folder, else undefined. */
  preset?: string;
  /** The CardGrid scroller — the virtualizer measures against it. */
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  /** Infinite-list hook: called when the table nears its last rows. */
  onLoadMore?: () => void;
  onSelect: (id: string) => void;
  onToggleFavorite: (m: MemoSummary) => void;
  // --- Base mode (query views spec §4): explicit columns from the view
  // def replace the schema-derived folder set. Drag persists via
  // onColumnsReordered (YAML write-back); formula columns are read-only
  // engine cells; declared summaries override the type-derived defaults.
  columns?: TableColumn[];
  formulaCell?: (rowId: string, key: string) => BaseCell | undefined;
  summaryFns?: Record<string, SummaryFn>;
  labelFor?: (col: TableColumn) => string | undefined;
  onColumnsReordered?: (cols: TableColumn[]) => void;
}

type Entry =
  | { type: "group"; key: string; count: number }
  | { type: "note"; row: MemoSummary };

export function TableView({
  items,
  schemas,
  folderOrder,
  preset,
  scrollerRef,
  onLoadMore,
  onSelect,
  onToggleFavorite,
  columns,
  formulaCell,
  summaryFns,
  labelFor,
  onColumnsReordered,
}: TableViewProps) {
  const { t } = useI18n();
  const qc = useQueryClient();

  const built = useMemo(
    () => (columns !== undefined ? columns : buildColumns(schemas, folderOrder)),
    [columns, schemas, folderOrder],
  );
  const [userOrder, setUserOrder] = useState<TableColumn[] | null>(null);
  // Reset on the derived column SET, never on object identity: folder mode
  // gets fresh array identities on every listing refetch, which would
  // silently wipe the user's drag order after any cell edit.
  const colsSig = JSON.stringify(built);
  const [seenSig, setSeenSig] = useState(colsSig);
  if (colsSig !== seenSig) {
    setSeenSig(colsSig);
    setUserOrder(null);
  }
  const cols = userOrder ?? built;
  const setCols = (next: TableColumn[]) => {
    setUserOrder(next);
    onColumnsReordered?.(next);
  };
  const baseMode = columns !== undefined;
  const [groupBy, setGroupBy] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [frozenIds, setFrozenIds] = useState<string[] | null>(null);
  const [patched, setPatched] = useState<Record<string, MemoSummary>>({});
  // Column drag-reorder session state (spec §4: not persisted for folders).
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropEdge, setDropEdge] = useState<number | null>(null);

  // Rows: server items overlaid with locally reconciled NoteDto patches,
  // displayed in the frozen order while an editor is focused.
  const rows = useMemo(() => {
    const byId = new Map(items.map((r) => [r.id, r]));
    for (const [id, p] of Object.entries(patched)) if (byId.has(id)) byId.set(id, p);
    return applyFrozenOrder([...byId.values()], frozenIds);
  }, [items, patched, frozenIds]);

  const groups = useMemo(() => groupRows(rows, groupBy), [rows, groupBy]);
  const entries = useMemo(() => {
    const out: Entry[] = [];
    for (const g of groups) {
      if (groupBy !== null) out.push({ type: "group", key: g.key, count: g.rows.length });
      if (groupBy !== null && collapsed.has(g.key)) continue;
      for (const r of g.rows) out.push({ type: "note", row: r });
    }
    return out;
  }, [groups, groupBy, collapsed]);

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: (i) => (entries[i]?.type === "group" ? GROUP_H : ROW_H),
    overscan: 8,
  });
  const last = virtualizer.getVirtualItems().at(-1);
  useEffect(() => {
    if (last && last.index >= entries.length - 2) onLoadMore?.();
  }, [last, entries.length, onLoadMore]);

  const gridTemplate = useMemo(() => {
    const middle = "minmax(96px, 1fr)";
    const n = Math.max(0, cols.length - 2);
    return `minmax(140px, 1.6fr) ${Array(n).fill(middle).join(" ")} minmax(84px, 0.7fr)`;
  }, [cols]);

  const groupCandidates = useMemo(() => {
    const keys: { key: string; scalar: boolean }[] = [];
    const seen = new Set<string>();
    for (const f of folderOrder) {
      for (const [k, def] of Object.entries(schemas[f]?.properties ?? {})) {
        if (seen.has(k)) continue;
        seen.add(k);
        keys.push({ key: k, scalar: def.prop_type === "select" || def.prop_type === "bool" });
      }
    }
    const scalar = keys.filter((k) => k.scalar);
    // Fall back to text-ish keys when the schema has no scalar select/bool.
    return (scalar.length ? scalar : keys).map((k) => k.key);
  }, [schemas, folderOrder]);

  const commitCell = async (row: MemoSummary, mutation: PropMutation) => {
    try {
      const dto = await updateMemo(row.id, null, null, mutation);
      setPatched((p) => ({ ...p, [row.id]: reconcileRow(p[row.id] ?? row, dto) }));
      // Query-view result caches key on the index generation (spec §4).
      void qc.invalidateQueries({ queryKey: ["base"] });
    } catch (e) {
      useUI.getState().setToast(String(e).split("\n")[0] ?? String(e));
    }
  };

  const onPropCommit = (row: MemoSummary, key: string) => (next: string[] | null) =>
    void commitCell(row, next === null
      ? { sets: [], removes: [key] }
      : { sets: [[key, next.length === 1 ? { Str: next[0] } : { List: next }]], removes: [] });
  const onPropBool = (row: MemoSummary, key: string) => (b: boolean) =>
    void commitCell(row, { sets: [[key, { Bool: b }]], removes: [] });

  const firstDef = (key: string) => {
    for (const f of folderOrder) {
      const def = schemas[f]?.properties?.[key];
      if (def) return def;
    }
    return undefined;
  };

  const headerLabel = (col: TableColumn): string => {
    const override = labelFor?.(col);
    if (override) return override;
    return col.kind === "name" ? t.table_col_name
      : col.kind === "tags" ? t.table_col_tags
      : col.kind === "updated" ? t.prop_updated
      : col.key;
  };

  const footerCell = (col: TableColumn): string | null => {
    if (col.kind === "name") return null;
    if (col.kind === "tags") {
      return summarize(rows.flatMap((r) => (r.tags.length ? [{ List: r.tags } as PropValue] : [])), "unique");
    }
    if (col.kind === "updated") {
      return summarize(rows.map((r) => ({ Str: r.updated_at } as PropValue)), "filled");
    }
    if (col.kind !== "prop") return null;
    const vals = rows.map((r) => r.props?.[col.key]);
    const declared =
      col.kind === "prop" ? summaryFns?.[col.key] ?? summaryFns?.[`note.${col.key}`] : undefined;
    return summarize(vals as PropValue[], declared ?? defaultSummaryFn(firstDef(col.key)));
  };

  const resetDrag = () => {
    setDragFrom(null);
    setDropEdge(null);
  };
  const onDrop = (to: number) => {
    if (dragFrom === null || dragFrom === to) return resetDrag();
    const next = [...cols];
    const [moved] = next.splice(dragFrom, 1);
    next.splice(to, 0, moved);
    setCols(next);
    resetDrag();
  };

  return (
    <div className="min-w-[560px] pb-1">
      {/* Sticky header: frozen name cell + draggable prop columns. */}
      <div className="sticky top-0 z-10 border-b border-line bg-surface">
        <div role="row" className="grid items-center" style={{ gridTemplateColumns: gridTemplate }}>
          <div className="sticky left-0 z-20 flex items-center gap-1 bg-surface px-2 py-1.5 text-[11px] font-semibold text-text-subtle">
            {groupBy !== null && (
              <button
                type="button"
                aria-label={t.table_group_none}
                title={t.table_group_none}
                onClick={() => {
                  setGroupBy(null);
                  setCollapsed(new Set());
                }}
                className="shrink-0 text-text-subtle transition-colors duration-150 hover:text-text"
              >
                <ChevronRight size={12} aria-hidden />
              </button>
            )}
            <span className="truncate">{t.table_col_name}</span>
          </div>
          {cols.slice(1).map((col, i) => {
            const idx = i + 1;
            const isLast = idx === cols.length - 1;
            const isGroupKey = col.kind === "prop" && groupBy === col.key;
            const groupable = !baseMode && col.kind === "prop" && groupCandidates.includes(col.key);
            return (
              <div
                key={col.kind === "prop" ? `p:${col.key}` : col.kind}
                role="columnheader"
                draggable={!isLast}
                onDragStart={() => setDragFrom(idx)}
                onDragOver={(e) => {
                  if (dragFrom === null || isLast) return;
                  e.preventDefault();
                  setDropEdge(idx);
                }}
                onDragEnd={resetDrag}
                onDrop={(e) => {
                  e.preventDefault();
                  onDrop(idx);
                }}
                className={`flex items-center gap-0.5 px-2 py-1.5 text-[11px] font-semibold text-text-subtle ${
                  isLast ? "" : "cursor-grab"
                } ${dropEdge === idx && dragFrom !== null && dragFrom !== idx ? "ring-2 ring-inset ring-hue-blue/40" : ""}`}
              >
                {groupable ? (
                  <button
                    type="button"
                    aria-pressed={isGroupKey}
                    title={t.table_group}
                    onClick={() => {
                      setGroupBy((g) => (g === col.key && col.kind === "prop" ? null : col.kind === "prop" ? col.key : null));
                      setCollapsed(new Set());
                    }}
                    className={`shrink-0 transition-colors duration-150 ${
                      isGroupKey ? "text-hue-blue" : "text-text-subtle/50 hover:text-text"
                    }`}
                  >
                    <ChevronDown size={11} aria-hidden />
                  </button>
                ) : null}
                <span className="truncate">{headerLabel(col)}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Virtualized body. Focus capture freezes the row order while a cell
       * editor is open; blur outside the table releases it (spec §4). */}
      <div
        onFocusCapture={() => {
          if (frozenIds === null) setFrozenIds(rows.map((r) => r.id));
        }}
        onBlurCapture={(e) => {
          const to = e.relatedTarget as Node | null;
          // Editor popovers portal to document.body; focus moving into
          // one is still "inside" the table (spec §4 freeze).
          const inside =
            to !== null &&
            (e.currentTarget.contains(to) || (to instanceof Element && to.closest("[data-table-portal]") !== null));
          if (!inside) {
            setFrozenIds(null);
            setPatched({});
          }
        }}
      >
        <div style={{ height: virtualizer.getTotalSize() }} className="relative w-full">
          {virtualizer.getVirtualItems().map((v) => {
            const entry = entries[v.index];
            if (!entry) return null;
            if (entry.type === "group") {
              const isCollapsed = collapsed.has(entry.key);
              return (
                <div
                  key={`g:${entry.key}:${v.key}`}
                  style={{ position: "absolute", top: 0, left: 0, transform: `translateY(${v.start}px)`, width: "100%", height: GROUP_H }}
                  className="flex items-center gap-1 border-b border-line/60 bg-surface-muted/40 px-2"
                >
                  <button
                    type="button"
                    aria-expanded={!isCollapsed}
                    onClick={() =>
                      setCollapsed((c) => {
                        const next = new Set(c);
                        if (next.has(entry.key)) next.delete(entry.key);
                        else next.add(entry.key);
                        return next;
                      })
                    }
                    className="flex items-center gap-1 text-[11px] font-semibold text-text-muted transition-colors duration-150 hover:text-text"
                  >
                    {isCollapsed ? <ChevronRight size={12} aria-hidden /> : <ChevronDown size={12} aria-hidden />}
                    {entry.key === "" ? t.group_none : propValueLabel(groupBy ?? "", entry.key, t, preset)}
                    <span className="text-text-subtle">{entry.count}</span>
                  </button>
                </div>
              );
            }
            const row = entry.row;
            return (
              <div
                key={`n:${row.id}`}
                style={{ position: "absolute", top: 0, left: 0, transform: `translateY(${v.start}px)`, width: "100%", height: ROW_H }}
                className="group/row"
              >
                <div
                  role="row"
                  className="grid h-full items-center border-b border-line/40 transition-colors duration-100 hover:bg-surface-muted/40"
                  style={{ gridTemplateColumns: gridTemplate }}
                >
                  <div className="sticky left-0 z-10 flex min-w-0 items-center gap-1 bg-surface px-2">
                    <button
                      type="button"
                      onClick={() => onSelect(row.id)}
                      className="truncate text-left text-[12px] text-text hover:underline"
                    >
                      {row.title ?? row.path.split("/").pop()?.replace(/\.[^.]+$/, "")}
                    </button>
                    <button
                      type="button"
                      aria-label="favorite"
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggleFavorite(row);
                      }}
                      className={`shrink-0 transition-opacity duration-150 ${
                        row.favorite ? "opacity-100" : "opacity-0 group-hover/row:opacity-60"
                      }`}
                    >
                      <Star
                        size={11}
                        aria-hidden
                        className={row.favorite ? "fill-hue-amber text-hue-amber" : "text-text-subtle"}
                      />
                    </button>
                  </div>
                  {cols.slice(1).map((col) => {
                    if (col.kind === "tags") {
                      return (
                        <div key={col.kind} className="flex min-w-0 items-center gap-1 overflow-hidden px-2">
                          {row.tags.slice(0, 3).map((tag) => (
                            <span key={tag} className="truncate rounded-[var(--tag-radius)] bg-surface-muted px-1 py-0.5 text-[10px] text-text-muted">
                              {tag}
                            </span>
                          ))}
                        </div>
                      );
                    }
                    if (col.kind === "updated") {
                      return (
                        <div key={col.kind} className="truncate px-2 text-[11px] text-text-subtle tabular-nums">
                          {isoToLocalDate(row.updated_at)}
                        </div>
                      );
                    }
                    if (col.kind === "formula") {
                      const cell = formulaCell?.(row.id, col.key);
                      return (
                        <div
                          key={`f:${col.key}`}
                          title={cell?.error ?? undefined}
                          className="flex min-w-0 items-center px-2 text-[12px] text-text-muted"
                        >
                          {cell?.error ? (
                            <span className="text-status-error">⚠︎</span>
                          ) : (
                            <span className="truncate">{formatBaseValue(cell?.value ?? null)}</span>
                          )}
                        </div>
                      );
                    }
                    if (col.kind !== "prop") return null; // name never slices past index 0
                    const def = schemas[row.folder]?.properties?.[col.key];
                    return (
                      <div key={`p:${col.key}`} className="flex min-w-0 items-center px-1">
                        <PropCellEditor
                          propKey={col.key}
                          def={def}
                          stored={row.props?.[col.key]}
                          preset={schemas[row.folder]?.meta?.preset ?? preset}
                          onCommit={onPropCommit(row, col.key)}
                          onBool={onPropBool(row, col.key)}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Sticky summary footer (spec §4). */}
      <div className="sticky bottom-0 z-10 border-t border-line bg-surface">
        <div role="row" className="grid items-center" style={{ gridTemplateColumns: gridTemplate }}>
          <div className="sticky left-0 z-10 bg-surface px-2 py-1 text-[10px] text-text-subtle tabular-nums">
            {t.table_rows_n.replace("{n}", String(rows.length))}
          </div>
          {cols.slice(1).map((col) => (
            <div
              key={col.kind === "prop" ? `p:${col.key}` : col.kind}
              className="truncate px-2 py-1 text-[10px] text-text-subtle tabular-nums"
            >
              {footerCell(col) ?? ""}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
