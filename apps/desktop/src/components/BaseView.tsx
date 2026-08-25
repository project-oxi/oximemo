/**
 * BaseView — full-screen query collection surface (query views spec §5).
 * View tabs from the parsed `.query` def, run_base data through the shared
 * TableView (per-row editors + YAML column write-back), YAML code editor
 * with mtime-conflict handling, and the spec §1 degenerate-case handling:
 * parse failure → code mode with the error, unknown view type → errored
 * tab, duplicate names → `(2)` tab suffix, `views: []` → one default
 * table view materialized in memory.
 */
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Code2, Database, Plus, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import YAML from "yaml";
import { defaultKeymap } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { yaml as yamlLang } from "@codemirror/lang-yaml";
import { EditorView, keymap, lineNumbers, type ViewUpdate } from "@codemirror/view";
import { loadBase, runBase, saveBase } from "../lib/api";
import { parseFilters, serializeFilters, type FilterNode } from "../lib/filterTree";
import { useI18n } from "../lib/i18n";
import type { BaseCell, BaseDef, BasePage, BaseViewDef, FolderDef, FolderEntry, MemoSummary, RunBaseReq } from "../lib/types";
import { type SummaryFn, type TableColumn } from "../lib/tableModel";
import { useUI } from "../stores/ui";
import { TableView } from "./views/TableView";
import { BoardView } from "./views/BoardView";
import { BaseCardsAdapter, BaseListAdapter } from "./views/BaseAdapters";
import { listFolders } from "../lib/api";
import { FilterBuilder } from "./FilterBuilder";

const PAGE = 100;
const KNOWN_TYPES: Record<string, true | undefined> = { table: true, board: true, cards: true, list: true };

interface Props {
  source: { path: string } | { inline: string };
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  onSelect: (id: string) => void;
}

const DEFAULT_VIEW: BaseViewDef = { type: "table" };

/** Minimal FolderDef view of list_folders rows for the cards adapter. */
function folderDefsOf(entries: FolderEntry[] | undefined): FolderDef[] {
  return (entries ?? []).map((e) => ({ path: e.path }));
}

/** Parse the def; a parse failure is a load-time error (spec §2) — the
 *  surface opens in code mode with the message instead of a half view. */
function parseDef(yamlText: string): { def: BaseDef } | { error: string } {
  try {
    const raw = YAML.parse(yamlText);
    if (raw === null || raw === undefined) return { def: {} };
    if (typeof raw !== "object") return { error: "top level must be a mapping" };
    return { def: raw as BaseDef };
  } catch (e) {
    return { error: String(e) };
  }
}

function columnOf(id: string): TableColumn | null {
  if (id === "file.name") return { kind: "name" };
  if (id === "tags") return { kind: "tags" };
  if (id === "file.updated") return { kind: "updated" };
  if (id.startsWith("formula.")) return { kind: "formula", key: id.slice("formula.".length) };
  if (id.startsWith("file.")) return null; // other core fields: not table columns
  return { kind: "prop", key: id.startsWith("note.") ? id.slice("note.".length) : id };
}
const columnId = (c: TableColumn): string =>
  c.kind === "prop" ? c.key : c.kind === "formula" ? `formula.${c.key}` : c.kind;

function tabNames(views: BaseViewDef[]): string[] {
  const seen = new Map<string, number>();
  return views.map((v) => {
    const base = v.name?.trim() || v.type;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });
}

export function BaseView({ source, scrollerRef, onSelect }: Props) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const setToast = useUI((s) => s.setToast);
  const exitBase = useUI((s) => s.exitBase);
  const readOnly = "inline" in source;
  const sourceKey = "path" in source ? source.path : `inline:${source.inline.length}:${(source.inline.length * 2654435761) >>> 0}`;

  const defQ = useQuery({
    queryKey: ["bases", "def", sourceKey],
    queryFn: () => ("path" in source ? loadBase(source.path) : Promise.resolve({ yaml: source.inline, mtimeMs: 0 })),
    enabled: true,
  });
  const yamlText = defQ.data?.yaml ?? "";
  const parsed = useMemo(() => parseDef(yamlText), [yamlText]);
  const foldersQ = useQuery({ queryKey: ["folders"], queryFn: listFolders });
  const [viewIndex, setViewIndex] = useState(0);
  const [showCode, setShowCode] = useState(false);
  useEffect(() => {
    if ("error" in parsed) setShowCode(true);
  }, [parsed]);

  const views = useMemo<BaseViewDef[]>(() => {
    if ("error" in parsed) return [];
    return parsed.def.views?.length ? parsed.def.views : [DEFAULT_VIEW];
  }, [parsed]);
  const idx = Math.min(viewIndex, Math.max(0, views.length - 1));
  const view = views[idx];
  const names = useMemo(() => tabNames(views), [views]);

  // Column model from the view def; formula cells ride the rows' cells
  // array (positional over the same column list, Plan A exec contract).
  const columns = useMemo(
    () => (view?.columns ?? ["file.name", "tags", "file.updated"]).map(columnOf).filter((c): c is TableColumn => c !== null),
    [view],
  );
  const columnIds = useMemo(() => columns.map(columnId), [columns]);

  // Pinned clock (spec §2): page 1 lets the server pin now(); later pages
  // and refreshes reuse the same instant so rows don't shuffle mid-session.
  const clockRef = useRef<{ nowMs: number; localOffsetSeconds: number } | null>(null);

  const runQ = useInfiniteQuery({
    queryKey: ["base", sourceKey, idx, readOnly ? yamlText.length : defQ.data?.mtimeMs],
    queryFn: ({ pageParam }) => {
      const pinned = clockRef.current;
      const req: RunBaseReq = {
        viewIndex: idx,
        offset: pageParam,
        limit: PAGE,
        group: null,
        nowMs: pinned?.nowMs ?? null,
        localOffsetSeconds: pinned?.localOffsetSeconds ?? null,
        includeGroupCounts: false,
        includeSummaries: true,
        thisId: null,
      };
      return runBase("path" in source ? { Path: source.path } : { Inline: { yaml: source.inline } }, req);
    },
    initialPageParam: 0,
    getNextPageParam: (last: BasePage, all) => {
      const loaded = all.reduce((n, p) => n + p.rows.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
    enabled: "error" in parsed ? false : !!view && KNOWN_TYPES[view.type] === true,
  });

  useEffect(() => {
    const page1 = runQ.data?.pages[0];
    if (page1 && !clockRef.current) {
      clockRef.current = {
        nowMs: Date.parse(page1.clock.now_utc),
        localOffsetSeconds: page1.clock.local_offset_seconds,
      };
    }
  }, [runQ.data]);

  const rows: MemoSummary[] = useMemo(
    () => runQ.data?.pages.flatMap((p) => p.rows.map((r) => r.summary)) ?? [],
    [runQ.data],
  );
  // (rowId, formulaKey) → BaseCell, from positional cells over columnIds.
  const formulaCells = useMemo(() => {
    const map = new Map<string, Record<string, BaseCell>>();
    for (const page of runQ.data?.pages ?? []) {
      for (const row of page.rows) {
        const byKey: Record<string, BaseCell> = {};
        columnIds.forEach((id, i) => {
          if (id.startsWith("formula.")) byKey[id.slice("formula.".length)] = row.cells[i];
        });
        map.set(row.summary.id, byKey);
      }
    }
    return map;
  }, [runQ.data, columnIds]);

  // View-declared summaries (spec §1 `summaries`): "note.rating: Average"
  // → SummaryFn per column path.
  const { summaryFns, summaryWarnings } = useMemo(() => {
    const out: Record<string, SummaryFn> = {};
    const known = new Set<SummaryFn>(["all","checked","unchecked","empty","filled","unique","average","sum","min","max","median"]);
    const warns: string[] = [];
    for (const [k, v] of Object.entries(view?.summaries ?? {})) {
      const fn = v?.toLowerCase() as SummaryFn;
      if (!fn) continue;
      if (!known.has(fn)) { warns.push(`${k}: ${v}`); continue; }
      out[k] = fn;
    }
    return { summaryFns: out, summaryWarnings: warns };
  }, [view]);

  const labelFor = (col: TableColumn): string | undefined => {
    if ("error" in parsed) return undefined;
    const key = col.kind === "formula" ? col.key : col.kind === "prop" ? col.key : null;
    if (!key) return undefined;
    return parsed.def.properties?.[key]?.displayName;
  };

  /** Edit-and-save: mutate the parsed def, re-serialize, save (spec §5).
   *  Inline sources are read-only — editing happens after saving. */
  const saveYaml = (mutate: (def: BaseDef) => void) => {
    if ("error" in parsed || readOnly || !("path" in source)) return;
    const def = structuredClone(parsed.def);
    mutate(def);
    const text = YAML.stringify(def);
    saveBase(source.path, text, defQ.data?.mtimeMs)
      .then(() => {
        void qc.invalidateQueries({ queryKey: ["bases"] });
        void qc.invalidateQueries({ queryKey: ["base"] });
      })
      .catch((e) => setToast(String(e).split("\n")[0]));
  };
  const onColumnsReordered = (cols: TableColumn[]) =>
    saveYaml((def) => {
      def.views ??= [DEFAULT_VIEW];
      def.views[idx] = { ...def.views[idx], columns: cols.map(columnId) };
    });
  const addView = () =>
    saveYaml((def) => {
      def.views ??= [];
      def.views.push({ type: "table", name: t.view_table });
    });

  const baseFilter: FilterNode | null = "error" in parsed ? null : parseFilters(parsed.def.filters);
  const viewFilter: FilterNode | null = "error" in parsed || !view ? null : parseFilters(view.filters);
  const total = runQ.data?.pages[0]?.total ?? 0;
  const warnings = [...(runQ.data?.pages.flatMap((p) => p.warnings) ?? []), ...summaryWarnings];
  const parseError = "error" in parsed ? parsed.error : null;

  return (
    <div className="flex min-h-full flex-col">
      {/* Base header: name + view tabs + 새 뷰 추가 + 코드 (spec §5). */}
      <div className="flex flex-wrap items-center gap-2 px-4 pb-2">
        <span className="flex items-center gap-1.5 text-sm font-semibold text-text">
          <Database size={14} className="text-text-subtle" />
          {"path" in source ? source.path.split("/").at(-1)?.replace(/\.query$/, "") : t.query_inline}
        </span>
        {names.map((name, i) => (
          <button
            key={`${name}:${i}`}
            type="button"
            aria-pressed={i === idx}
            onClick={() => {
              clockRef.current = null;
              setViewIndex(i);
            }}
            className={`rounded-[var(--tag-radius)] px-2.5 py-1 text-xs transition-colors duration-150 ${
              i === idx
                ? "bg-surface-muted font-semibold text-text"
                : "text-text-muted hover:bg-surface-muted hover:text-text"
            }`}
          >
            {name}
            {views[i] && KNOWN_TYPES[views[i].type] !== true && (
              <TriangleAlert size={10} className="ml-1 inline text-hue-amber" aria-label={t.query_unknown_view_type} />
          )}
          </button>
        ))}
        {!readOnly && (
          <button
            type="button"
            onClick={addView}
            aria-label={t.query_new_view}
            title={t.query_new_view}
            className="rounded-[var(--tag-radius)] p-1 text-text-subtle transition-colors duration-150 hover:bg-surface-muted hover:text-text"
          >
            <Plus size={12} />
          </button>
        )}
        <span className="ml-auto flex items-center gap-2">
          {readOnly ? null : (
            <FilterBuilder
              baseNode={baseFilter}
              viewNode={viewFilter}
              onSave={(level, node) =>
                saveYaml((def) => {
                  def.views ??= [DEFAULT_VIEW];
                  if (level === "base") {
                    if (node) def.filters = serializeFilters(node);
                    else delete def.filters;
                  } else {
                    const v = def.views[idx];
                    if (node) def.views[idx] = { ...v, filters: serializeFilters(node) };
                    else {
                      const { filters: _drop, ...rest } = v;
                      def.views[idx] = rest;
                    }
                  }
                })
              }
            />
          )}
          <button
            type="button"
            aria-pressed={showCode}
            onClick={() => setShowCode((v) => !v)}
            className={`flex items-center gap-1 rounded-[var(--button-radius)] border border-line px-2.5 py-1 text-xs transition-colors duration-150 ${
              showCode ? "bg-surface-muted text-text" : "text-text-muted hover:bg-surface-muted"
            }`}
          >
            <Code2 size={12} /> {t.query_code}
          </button>
          <button
            type="button"
            onClick={exitBase}
            className="rounded-[var(--button-radius)] border border-line px-2.5 py-1 text-xs text-text-muted transition-colors duration-150 hover:bg-surface-muted hover:text-text"
          >
            {t.base_exit}
          </button>
        </span>
      </div>

      {parseError && (
        <div className="mx-4 mb-2 rounded-[var(--tag-radius)] border border-status-error/40 bg-status-error/10 px-3 py-2 text-xs text-status-error">
          {t.query_error_parse}: {parseError}
        </div>
      )}
      {warnings.length > 0 && (
        <div className="mx-4 mb-2 px-1 text-[11px] text-text-subtle">{warnings.join(" · ")}</div>
      )}

      {showCode ? (
        <div className="px-4 pb-4">
          {readOnly ? (
            <p className="text-xs text-text-subtle">{t.query_code_inline_readonly}</p>
          ) : (
            <BaseCodeEditor path={(source as { path: string }).path} initialYaml={yamlText} mtimeMs={defQ.data?.mtimeMs} />
          )}
        </div>
      ) : parseError ? null : !view || KNOWN_TYPES[view.type] !== true ? (
        <div className="mt-16 flex flex-col items-center gap-2 text-center">
          <p className="text-sm text-text-subtle">{t.query_unknown_view_type}</p>
        </div>
      ) : view.type === "board" ? (
        <BoardView
          source={"path" in source ? { Path: source.path } : { Inline: { yaml: source.inline } }}
          sourceKey={sourceKey}
          viewIndex={idx}
          groupByProp={view.groupBy?.property ?? null}
          preset={undefined}
          onSelect={onSelect}
        />
      ) : view.type === "cards" ? (
        <BaseCardsAdapter
          rows={runQ.data?.pages.flatMap((pg) => pg.rows) ?? []}
          folders={folderDefsOf(foldersQ.data)}
          folderEntries={foldersQ.data ?? []}
          onSelect={onSelect}
          onToggleFavorite={() => {}}
        />
      ) : view.type === "list" ? (
        <BaseListAdapter rows={runQ.data?.pages.flatMap((pg) => pg.rows) ?? []} onSelect={onSelect} />
      ) : runQ.isError ? (
        <div className="mt-16 flex flex-col items-center gap-3 px-6 text-center">
          <p className="text-sm font-medium text-status-error">{t.query_error_filter}</p>
          <p className="max-w-lg break-words text-xs text-text-subtle">{String(runQ.error)}</p>
          <button
            type="button"
            onClick={() => void runQ.refetch()}
            className="rounded-[var(--button-radius)] bg-interactive-primary px-4 py-2 text-sm text-interactive-primary-foreground"
          >
            {t.retry}
          </button>
        </div>
      ) : (
        <>
          <TableView
            items={rows}
            schemas={{}}
            folderOrder={[]}
            columns={columns}
            formulaCell={(rowId, key) => formulaCells.get(rowId)?.[key]}
            summaryFns={summaryFns}
            labelFor={labelFor}
            onColumnsReordered={onColumnsReordered}
            scrollerRef={scrollerRef}
            onLoadMore={() => {
              if (runQ.hasNextPage) void runQ.fetchNextPage();
            }}
            onSelect={onSelect}
            onToggleFavorite={() => {}}
          />
          {runQ.hasNextPage && (
            <div className="flex justify-center py-3">
              <button
                type="button"
                onClick={() => void runQ.fetchNextPage()}
                className="rounded-[var(--button-radius)] border border-line px-3 py-1.5 text-xs text-text-muted hover:bg-surface-muted"
              >
                {t.query_results_n.replace("{n}", String(total))}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** CodeMirror YAML editor (spec §5 「코드」): ⌘S saves through save_base;
 *  an mtime mismatch toasts the reload conflict; parse errors surface as
 *  the save failure message (CodeMirror lint wiring can follow). */
function BaseCodeEditor({
  path,
  initialYaml,
  mtimeMs,
}: {
  path: string;
  initialYaml: string;
  mtimeMs: number | undefined;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const setToast = useUI((s) => s.setToast);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!hostRef.current) return;
    const save = () => {
      const text = viewRef.current?.state.doc.toString() ?? "";
      saveBase(path, text, mtimeMs)
        .then(() => {
          setDirty(false);
          void qc.invalidateQueries({ queryKey: ["bases"] });
          void qc.invalidateQueries({ queryKey: ["base"] });
        })
        .catch((e) => {
          setToast(String(e).split("\n")[0], {
            label: t.query_conflict_reload,
            onClick: () => {
              void qc.invalidateQueries({ queryKey: ["bases"] });
            },
          });
        });
    };
    const view = new EditorView({
      state: EditorState.create({
        doc: initialYaml,
        extensions: [
          lineNumbers(),
          yamlLang(),
          keymap.of([
            ...defaultKeymap,
            { key: "Mod-s", preventDefault: true, run: () => (save(), true) },
          ]),
          EditorView.updateListener.of((u: ViewUpdate) => {
            if (u.docChanged) setDirty(true);
          }),
        ],
      }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Re-mount only when the file identity changes; external content
    // refreshes arrive through the conflict-reload path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] text-text-subtle">{dirty ? t.query_code_dirty : t.query_code_saved}</span>
        <span className="text-[11px] text-text-subtle">⌘S</span>
      </div>
      <div
        ref={hostRef}
        className="overflow-x-auto rounded-[var(--input-radius)] border border-line bg-surface-raised px-2 py-1 text-[12px]"
      />
    </div>
  );
}
