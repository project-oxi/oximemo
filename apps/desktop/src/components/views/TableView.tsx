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
 *
 * Plan C: rows are `BaseRow`s, keyed by the generation-scoped `row_id`
 * (spec §4: `n:<memo_id>` for note rows, `t:<memo_id>:<line>` for task
 * rows). Two task rows under one parent stay distinct by row_id; a
 * freeze map keyed by note id would collapse them. Local patched/frozen
 * state clears when `BasePage.result_key` changes — the new content may
 * have reordered task rows or remapped line numbers, so the prior
 * snapshot is no longer a valid index. Task cells (`task.*` columns) are
 * editable through guarded `patch_task` (Task 6); the checkbox toggle
 * commits `Toggle` per `row.task.task_ref`.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight, Star } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { patchTask, updateMemo } from "../../lib/api";
import { isoToLocalDate, todayLocalISO } from "../../lib/dates";
import { useI18n } from "../../lib/i18n";
import { propValueLabel } from "../../lib/propDisplay";
import { dayTone, relativeDayLabel, useTodayKey } from "../../lib/relativeDay";
import {
  applyFrozenOrderByRowId, buildColumns, defaultSummaryFn, formatBaseValue, groupRows,
  reconcileRow, summarize, type SummaryFn, type TableColumn,
} from "../../lib/tableModel";
import { editForCell } from "../../lib/taskCellCommit";
import type { BaseCell, BaseRow, FolderSchema, MemoSummary, PropMutation, PropValue, TaskEdit, TaskDto } from "../../lib/types";
import { useUI } from "../../stores/ui";
import { TaskCellEditor } from "../TaskCellEditor";
import { TaskCheckbox } from "../TaskCheckbox";
import { TaskFieldChip } from "../TaskFieldChip";
import { PropCellEditor } from "../propEditors";

const GROUP_H = 28;
const ROW_H = 34;

export interface TableViewProps {
  /** Latest listing rows (BaseRow[]; spec §4 row_id is the identity). */
  items: BaseRow[];
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
  /**
   * Result-cache fingerprint from `BasePage.result_key`. When it changes,
   * the new content may have reordered task rows or remapped line
   * numbers — clear local patched/frozen state so the prior snapshot
   * stops pointing at rows that may no longer exist (spec §4).
   */
  resultKey?: string;
}

type Entry =
  | { type: "group"; key: string; count: number }
  | { type: "note"; row: BaseRow };

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
  resultKey,
}: TableViewProps) {
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const setToast = useUI((s) => s.setToast);
  const todayISO = useTodayKey();

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
  /** row_id → patched MemoSummary from a returned `update_memo` NoteDto. */
  const [patched, setPatched] = useState<Record<string, MemoSummary>>({});
  // Column drag-reorder session state (spec §4: not persisted for folders).
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropEdge, setDropEdge] = useState<number | null>(null);

  // Spec §4: clear local patched/frozen state when the result cache key
  // changes — the new content may have reordered task rows or remapped
  // line numbers, so the prior snapshot is no longer a valid index.
  const resultKeyRef = useRef<string | undefined>(resultKey);
  if (resultKey !== undefined && resultKey !== resultKeyRef.current) {
    resultKeyRef.current = resultKey;
    setPatched({});
    setFrozenIds(null);
  }

  // Rows: server items overlaid with locally reconciled NoteDto patches
  // (summary only — task content rides the unchanged BaseRow.task),
  // displayed in the row_id-frozen order while an editor is focused.
  const rows = useMemo(() => {
    const out: BaseRow[] = items.map((r) => {
      const p = patched[r.row_id];
      return p ? { ...r, summary: p } : r;
    });
    return applyFrozenOrderByRowId(out, frozenIds);
  }, [items, patched, frozenIds]);

  const rowsForGroup = useMemo(() => rows.map((r) => r.summary), [rows]);
  const groups = useMemo(() => groupRows(rowsForGroup, groupBy), [rowsForGroup, groupBy]);
  const entries = useMemo(() => {
    const out: Entry[] = [];
    for (const g of groups) {
      if (groupBy !== null) out.push({ type: "group", key: g.key, count: g.rows.length });
      if (groupBy !== null && collapsed.has(g.key)) continue;
      const groupIds = new Set(g.rows.map((s) => s.id));
      for (const r of rows) {
        if (groupIds.has(r.summary.id)) out.push({ type: "note", row: r });
      }
    }
    return out;
  }, [groups, groupBy, collapsed, rows]);

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

  /** Commit a note-prop edit through `update_memo`. The BaseRow's
   *  `row_id` is the slot identity, not the memo id (task rows under
   *  one parent share the memo id but live at distinct row_ids); the
   *  previous `rows.find((r) => r.summary.id === row.id)?.row_id`
   *  first-match lookup collapsed two tasks onto one slot, so the
   *  row is now passed in directly. */
  const commitCell = async (row: BaseRow, mutation: PropMutation) => {
    try {
      const dto = await updateMemo(row.summary.id, null, null, mutation);
      setPatched((p) => ({ ...p, [row.row_id]: reconcileRow(p[row.row_id] ?? row.summary, dto) }));
      // Query-view result caches key on the index generation (spec §4).
      void qc.invalidateQueries({ queryKey: ["base"] });
    } catch (e) {
      setToast(String(e).split("\n")[0] ?? String(e));
    }
  };
  const onPropCommit = (row: BaseRow, key: string) => (next: string[] | null) =>
    void commitCell(row, next === null
      ? { sets: [], removes: [key] }
      : { sets: [[key, next.length === 1 ? { Str: next[0] } : { List: next }]], removes: [] });
  const onPropBool = (row: BaseRow, key: string) => (b: boolean) =>
    void commitCell(row, { sets: [[key, { Bool: b }]], removes: [] });

  /** Commit one task edit through guarded `patch_task`. The optimistic-
   *  lock guard is the kernel's responsibility (TaskConflict surfaced
   *  as a localized toast here). The wire serializes as
   *  "task conflict: note ..." (Rust `CoreError::TaskConflict` display);
   *  we match that prefix and use the i18n key from Task 3
   *  (`task_conflict_reload`) plus an `["base"]` invalidate so the
   *  view catches up. */
  const commitTaskCell = async (row: BaseRow, edit: TaskEdit) => {
    if (!row.task) return;
    try {
      await patchTask({ Exact: row.task.task_ref }, edit, todayLocalISO());
      void qc.invalidateQueries({ queryKey: ["base"] });
    } catch (e) {
      const msg = String(e);
      if (msg.includes("task conflict")) setToast(t.task_conflict_reload);
      else setToast(msg.split("\n")[0] ?? msg);
      void qc.invalidateQueries({ queryKey: ["base"] });
    }
  };
  const onTaskEdit = (row: BaseRow, key: string) => (value: string | null) => {
    const edit = editForCell(`task.${key}`, value);
    if (edit === undefined) return;
    void commitTaskCell(row, edit);
  };
  /** Checkbox toggle: send `Toggle` so the kernel resolves the next
   *  symbol from its effective status table (no client-side `next`
   *  resolution needed). */
  const onTaskToggle = (row: BaseRow) => () => void commitTaskCell(row, "Toggle");

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
      : col.kind === "task" ? `task.${col.key}`
      : col.key;
  };

  const footerCell = (col: TableColumn): string | null => {
    if (col.kind === "name") return null;
    if (col.kind === "tags") {
      return summarize(rowsForGroup.flatMap((r) => (r.tags.length ? [{ List: r.tags } as PropValue] : [])), "unique");
    }
    if (col.kind === "updated") {
      return summarize(rowsForGroup.map((r) => ({ Str: r.updated_at } as PropValue)), "filled");
    }
    // Task columns: footer stays empty (spec §4 reserves the slot for
    // declared summaries, but task cells have no aggregate semantics —
    // the kernel recomputes when the view re-runs).
    if (col.kind === "task") return null;
    if (col.kind !== "prop") return null;
    const vals = rowsForGroup.map((r) => r.props?.[col.key]);
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
            // Task columns are not groupable from the header — task
            // grouping is a board-level construct (see BoardView's
            // drag-handle commit; the table view doesn't drop on cells).
            const groupable = !baseMode && col.kind === "prop" && groupCandidates.includes(col.key);
            return (
              <div
                key={col.kind === "prop" ? `p:${col.key}`
                  : col.kind === "task" ? `tk:${col.key}`
                  : col.kind}
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
          if (frozenIds === null) setFrozenIds(rows.map((r) => r.row_id));
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
                key={row.row_id}
                style={{ position: "absolute", top: 0, left: 0, transform: `translateY(${v.start}px)`, width: "100%", height: ROW_H }}
                className="group/row"
              >
                <div
                  role="row"
                  className="grid h-full items-center border-b border-line/40 transition-colors duration-100 hover:bg-surface-muted/40"
                  style={{ gridTemplateColumns: gridTemplate }}
                >
                  <div className="sticky left-0 z-10 flex min-w-0 items-center gap-1 bg-surface px-2">
                    <TaskRowNameCell
                      row={row}
                      todayISO={todayISO}
                      locale={locale}
                      onSelect={onSelect}
                      onToggleFavorite={onToggleFavorite}
                      onToggleTask={onTaskToggle(row)}
                    />
                  </div>
                  {cols.slice(1).map((col) => {
                    if (col.kind === "tags") {
                      return (
                        <div key={col.kind} className="flex min-w-0 items-center gap-1 overflow-hidden px-2">
                          {(row.task?.tags.length ? row.task.tags : row.summary.tags).slice(0, 3).map((tag) => (
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
                          {isoToLocalDate(row.summary.updated_at)}
                        </div>
                      );
                    }
                    if (col.kind === "formula") {
                      const cell = formulaCell?.(row.row_id, col.key);
                      return (
                        <div
                          key={`f:${col.key}`}
                          title={cell?.error ?? undefined}
                          className="flex min-w-0 items-center px-2 text-[12px] text-text-muted"
                        >
                          {cell?.error ? (
                            <span className="text-status-error">�︎</span>
                          ) : (
                            <span className="truncate">{formatBaseValue(cell?.value ?? null)}</span>
                          )}
                        </div>
                      );
                    }
                    // Task columns: typed task editor over `row.task`.
                    // Note rows render empty (spec §4 "view-only on note
                    // rows"; `row.task` is null and `editForCell` would
                    // never be reached from the editor anyway).
                    if (col.kind === "task") {
                      if (!row.task) {
                        return (
                          <div key={`tk:${col.key}`} className="flex min-w-0 items-center px-2 text-[12px] text-text-subtle">
                            —
                          </div>
                        );
                      }
                      return (
                        <div key={`tk:${col.key}`} className="flex min-w-0 items-center px-1">
                          <TaskCellEditor
                            row={row}
                            propKey={col.key}
                            onChange={onTaskEdit(row, col.key)}
                          />
                        </div>
                      );
                    }
                    if (col.kind !== "prop") return null; // name never slices past index 0
                    const def = schemas[row.summary.folder]?.properties?.[col.key];
                    return (
                      <div key={`p:${col.key}`} className="flex min-w-0 items-center px-1">
                        <PropCellEditor
                          propKey={col.key}
                          def={def}
                          stored={row.summary.props?.[col.key]}
                          preset={schemas[row.summary.folder]?.meta?.preset ?? preset}
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
              key={col.kind === "prop" ? `p:${col.key}`
                : col.kind === "task" ? `tk:${col.key}`
                : col.kind}
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

/** First-cell content: note rows show the note title + favorite star;
 *  task rows show `TaskCheckbox` + task text + field chips + parent
 *  breadcrumb (spec §7.0). The checkbox click commits `Toggle` via
 *  guarded `patch_task` (Task 6 wires the click handler here). */
function TaskRowNameCell({
  row,
  todayISO,
  locale,
  onSelect,
  onToggleFavorite,
  onToggleTask,
}: {
  row: BaseRow;
  todayISO: string;
  locale: "ko" | "en";
  onSelect: (id: string) => void;
  onToggleFavorite: (m: MemoSummary) => void;
  onToggleTask: () => void;
}) {
  const emptyFallback = "—";
  if (!row.task) {
    const title = row.summary.title ?? row.summary.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? emptyFallback;
    return (
      <>
        <button
          type="button"
          onClick={() => onSelect(row.summary.id)}
          className="truncate text-left text-[12px] text-text hover:underline"
        >
          {title}
        </button>
        <button
          type="button"
          aria-label="favorite"
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite(row.summary);
          }}
          className={`shrink-0 transition-opacity duration-150 ${
            row.summary.favorite ? "opacity-100" : "opacity-0 group-hover/row:opacity-60"
          }`}
        >
          <Star
            size={11}
            aria-hidden
            className={row.summary.favorite ? "fill-hue-amber text-hue-amber" : "text-text-subtle"}
          />
        </button>
      </>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-2">
      <TaskCheckbox
        statusType={row.task.status_type}
        label={row.task.text}
        onToggle={onToggleTask}
      />
      <button
        type="button"
        onClick={() => onSelect(row.summary.id)}
        className="min-w-0 truncate text-left text-[12px] text-text hover:underline"
        title={row.task.text}
      >
        {row.task.text || emptyFallback}
      </button>
      <TaskRowChips task={row.task} todayISO={todayISO} locale={locale} />
      <span className="shrink-0 truncate text-[10px] text-text-subtle" title={row.summary.title ?? row.summary.path}>
        @ {row.summary.title ?? row.summary.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? emptyFallback}
      </span>
    </div>
  );
}

/** Field chips for one task row (spec §7.0). Only renders the chips whose
 *  field is non-null; the locale-aware relative-day label is shared with
 *  the CM6 widget (lib/relativeDay.ts). */
function TaskRowChips({
  task,
  todayISO,
  locale,
}: {
  task: TaskDto;
  todayISO: string;
  locale: "ko" | "en";
}) {
  const priorityField =
    task.priority === "highest" ? "priority-highest"
      : task.priority === "high" ? "priority-high"
      : task.priority === "medium" ? "priority-medium"
      : task.priority === "low" ? "priority-low"
      : task.priority === "lowest" ? "priority-lowest"
      : null;
  return (
    <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
      {task.scheduled && (
        <TaskFieldChip
          field="scheduled"
          value={relativeDayLabel(task.scheduled, todayISO, locale)}
          tone={dayTone(task.scheduled, todayISO)}
        />
      )}
      {task.due && (
        <TaskFieldChip
          field="due"
          value={relativeDayLabel(task.due, todayISO, locale)}
          tone={dayTone(task.due, todayISO)}
        />
      )}
      {priorityField && <TaskFieldChip field={priorityField} value="" />}
      {task.recurrence && <TaskFieldChip field="recurrence" value={task.recurrence} />}
    </span>
  );
}