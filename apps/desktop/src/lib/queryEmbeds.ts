/**
 * Query embed extension (query views spec §6): live query results inside
 * notes. Two forms — `![[query:이름]]` / `![[query:path.query]]` markers
 * (single-line block replace, like memo embeds) and ```query fenced
 * blocks (result rendered as a widget BELOW the fence; the YAML stays
 * visible and editable — Obsidian Bases' model).
 *
 * Orchestration mirrors embeds.ts: a StateField holds resolved entries +
 * decorations, a ViewPlugin resolves visible unresolved targets (widgets
 * never fetch), results arrive via a StateEffect. `bases:changed` /
 * `memos:changed` clear the cache so a `.query` edit or index write can
 * never serve a stale widget (spec §6/§7); the backend result cache makes
 * re-resolution cheap. Requests pin the embedding note (`thisId`) so two
 * embeds of one query in different notes never share cells.
 */
import {
  type EditorState,
  type Extension,
  type Range,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import { listBases, runBase } from "./api";
import { formatBaseValue } from "./tableModel";
import { listen } from "./tauri";
import { useUI } from "../stores/ui";
import type { BasePage, BaseSource, RunBaseReq } from "./types";

const MARKER_RE = /^\s*!\[\[query:([^\]\n|]+)\]\]\s*$/;
const FENCE_OPEN_RE = /^\s*```query\s*$/;
const FENCE_CLOSE_RE = /^\s*```\s*$/;
const EMBED_LIMIT = 10;
const EMBED_COLUMNS = 4; // file.name + up to 3 more

export interface QueryEmbedLabels {
  results_n: string;
  open_full: string;
  loading: string;
  error: string;
  ambiguous: string;
}

interface Source {
  kind: "marker" | "fence";
  /** Marker: stem or vault-relative path. Fence: the raw YAML body. */
  key: string;
  thisId: string | null;
}

interface QueryEmbedEntry {
  status: "loading" | "resolved" | "error";
  total?: number;
  title?: string;
  /** Marker form: resolved vault path for 「전체 열기」. */
  path?: string;
  columns?: string[];
  rows?: { id: string; label: string; cells: string[] }[];
  error?: string;
}

interface QueryEmbedResolvedEffect {
  source: string; // fingerprint key
  entry: QueryEmbedEntry;
}

const queryEmbedResolved = StateEffect.define<QueryEmbedResolvedEffect>();
const queryEmbedClearAll = StateEffect.define<null>();

const fingerprint = (s: Source): string =>
  `${s.kind}:${s.key}\u0000${s.thisId ?? ""}`;

/** Fences + markers in the doc, in order, with their line spans. */
interface QueryBlock {
  source: Source;
  from: number;
  to: number;
  /** Widget anchor: markers replace [from,to]; fences insert after `to`. */
}

function scanBlocks(state: EditorState, thisId: string | null): QueryBlock[] {
  const blocks: QueryBlock[] = [];
  const doc = state.doc;
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    const marker = MARKER_RE.exec(line.text);
    if (marker) {
      blocks.push({
        source: { kind: "marker", key: marker[1].trim(), thisId },
        from: line.from,
        to: line.to,
      });
      continue;
    }
    if (!FENCE_OPEN_RE.test(line.text)) continue;
    let end = n;
    while (end < doc.lines && !FENCE_CLOSE_RE.test(doc.line(end + 1).text)) end++;
    if (end >= doc.lines) continue; // unterminated fence: leave as plain code
    const close = doc.line(end + 1);
    const yaml = doc.sliceString(line.to, close.from);
    blocks.push({
      source: { kind: "fence", key: yaml, thisId },
      from: line.from,
      to: close.to,
    });
    n = end + 1;
  }
  return blocks;
}

class QueryEmbedWidget extends WidgetType {
  constructor(
    readonly source: Source,
    readonly entry: QueryEmbedEntry | undefined,
    readonly labels: QueryEmbedLabels,
  ) {
    super();
  }
  eq(other: QueryEmbedWidget) {
    return (
      fingerprint(other.source) === fingerprint(this.source) &&
      (other.entry?.status ?? "loading") === (this.entry?.status ?? "loading")
    );
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "ox-query-embed";
    const status = this.entry?.status ?? "loading";
    wrap.classList.add(`ox-query-embed-${status}`);

    const hdr = document.createElement("div");
    hdr.className = "ox-query-embed-hdr";
    if (status === "loading") hdr.textContent = this.labels.loading;
    else if (status === "error") {
      hdr.textContent = `⚠ ${this.entry?.error ?? this.labels.error}`;
      wrap.append(hdr);
      return wrap;
    } else {
      // Spec §6: the title lives in the header, the count + open action
      // share the footer row — 「N개 결과 · 전체 열기」.
      hdr.textContent = this.entry?.title ?? "query";
    }
    wrap.append(hdr);

    const table = document.createElement("div");
    table.className = "ox-query-embed-rows";
    for (const row of this.entry?.rows ?? []) {
      const rowEl = document.createElement("button");
      rowEl.type = "button";
      rowEl.className = "ox-query-embed-row";
      const name = document.createElement("span");
      name.className = "ox-query-embed-name";
      name.textContent = row.label;
      rowEl.append(name);
      for (const cell of row.cells) {
        const c = document.createElement("span");
        c.className = "ox-query-embed-cell";
        c.textContent = cell;
        rowEl.append(c);
      }
      rowEl.addEventListener("click", () => useUI.getState().select(row.id));
      table.append(rowEl);
    }
    wrap.append(table);

    const footer = document.createElement("button");
    footer.type = "button";
    footer.className = "ox-query-embed-open";
    footer.textContent =
      this.labels.results_n.replace("{n}", String(this.entry?.total ?? 0)) +
      " · " +
      this.labels.open_full;
    footer.addEventListener("click", () => {
      const src = this.source;
      if (src.kind === "marker") {
        const path = this.entry?.path ?? (src.key.includes("/") || src.key.endsWith(".query") ? src.key : undefined);
        if (path) useUI.getState().openBase({ path });
      } else {
        useUI.getState().openBase({ inline: src.key });
      }
    });
    wrap.append(footer);
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}

function buildDecorations(
  state: EditorState,
  resolved: Map<string, QueryEmbedEntry>,
  thisId: string | null,
  labels: QueryEmbedLabels,
) {
  const decos: Range<Decoration>[] = [];
  for (const block of scanBlocks(state, thisId)) {
    const key = fingerprint(block.source);
    const widget = new QueryEmbedWidget(block.source, resolved.get(key), labels);
    if (block.source.kind === "marker") {
      decos.push(Decoration.replace({ block: true, widget }).range(block.from, block.to));
    } else {
      // Widget below the fence; the YAML stays visible and editable.
      decos.push(
        Decoration.widget({ block: true, side: 1, widget }).range(
          Math.min(block.to + 1, state.doc.length),
        ),
      );
    }
  }
  return Decoration.set(decos, true);
}

/** Resolves visible, unresolved embeds. Marker keys resolve through
 *  list_bases (unique stem, explicit path, or an ambiguity error). */
class QueryEmbedResolverPlugin {
  readonly pending = new Set<string>();
  destroyed = false;
  private unlisten: (() => void) | null = null;

  constructor(
    readonly view: EditorView,
    readonly field: StateField<QueryEmbedField>,
  ) {
    this.resolveVisible();
    // .query edits and index writes invalidate every embed (spec §6/§7);
    // the backend result cache makes the re-run cheap.
    void listen("bases:changed", () => this.clear()).then((u) => {
      if (this.destroyed) u?.();
      else this.unlisten = u ?? null;
    });
    void listen("memos:changed", () => this.clear()).then((u) => {
      if (this.destroyed) u?.();
      else this.unlisten = u ?? null;
    });
  }
  update(update: { docChanged: boolean; viewportChanged: boolean }) {
    if (update.docChanged || update.viewportChanged) this.resolveVisible();
  }
  destroy() {
    this.destroyed = true;
    this.unlisten?.();
  }
  clear() {
    if (this.destroyed) return;
    this.view.dispatch({ effects: queryEmbedClearAll.of(null) });
  }
  resolveVisible() {
    const { doc } = this.view.state;
    const resolved = this.view.state.field(this.field).resolved;
    const seen = new Set<string>();
    for (const { from, to } of this.view.visibleRanges) {
      for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) {
        const line = doc.line(n);
        const marker = MARKER_RE.exec(line.text);
        if (marker) {
          const source: Source = {
            kind: "marker",
            key: marker[1].trim(),
            thisId: this.view.state.field(this.field).thisId,
          };
          const key = fingerprint(source);
          if (!seen.has(key) && !resolved.has(key) && !this.pending.has(key)) {
            seen.add(key);
            void this.resolve(source, key);
          }
          continue;
        }
        if (!FENCE_OPEN_RE.test(line.text)) continue;
        // Resolve a fence only when its closing line is visible too —
        // the block scan in buildDecorations handles the doc-wide view.
      }
      // Fences: scan whole doc (cheap, bounded by doc size) for entries
      // whose span intersects the visible ranges.
      const fieldThis = this.view.state.field(this.field).thisId;
      for (const block of scanBlocks(this.view.state, fieldThis)) {
        if (block.source.kind !== "fence") continue;
        if (block.to < from || block.from > to) continue;
        const key = fingerprint(block.source);
        if (seen.has(key) || resolved.has(key) || this.pending.has(key)) continue;
        seen.add(key);
        void this.resolve(block.source, key);
      }
    }
  }
  async resolve(source: Source, key: string) {
    this.pending.add(key);
    let resolvedPath: string | undefined;
    try {
      let wire: BaseSource;
      let title = "query";
      if (source.kind === "marker") {
        const bases = await listBases();
        const k = source.key;
        const matches =
          k.includes("/") || k.endsWith(".query")
            ? bases.filter((b) => b.path === k || b.path === `${k}.query`)
            : bases.filter((b) => b.name === k);
        if (matches.length === 0) {
          this.dispatch(key, { status: "error", error: this.labels.error });
          return;
        }
        if (matches.length > 1) {
          this.dispatch(key, {
            status: "error",
            error: `${this.labels.ambiguous}: ${matches.map((m) => m.path).join(", ")}`,
          });
          return;
        }
        wire = { Path: matches[0].path };
        title = matches[0].name;
        resolvedPath = matches[0].path;
      } else {
        wire = { Inline: { yaml: source.key } };
        title = "query";
      }
      const req: RunBaseReq = {
        viewIndex: 0,
        offset: 0,
        limit: EMBED_LIMIT,
        group: null,
        nowMs: null,
        localOffsetSeconds: null,
        includeGroupCounts: false,
        includeSummaries: false,
        thisId: source.thisId,
      };
      const page: BasePage = await runBase(wire, req);
      const columns = (page.rows[0]?.cells.length ?? 0);
      const rows = page.rows.map((r) => ({
        id: r.summary.id,
        label: r.summary.title ?? r.summary.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "",
        cells: r.cells
          .slice(1, Math.min(columns, EMBED_COLUMNS))
          .map((c) => (c.error ? "⚠︎" : formatBaseValue(c.value))),
      }));
      this.dispatch(key, { status: "resolved", total: page.total, title, path: resolvedPath, rows });
    } catch (e) {
      this.dispatch(key, { status: "error", error: String(e).split("\n")[0] });
    } finally {
      this.pending.delete(key);
    }
  }
  dispatch(key: string, entry: QueryEmbedEntry) {
    if (this.destroyed) return;
    this.view.dispatch({ effects: queryEmbedResolved.of({ source: key, entry }) });
  }
  private get labels(): QueryEmbedLabels {
    return this.view.state.field(this.field).labels;
  }
}

interface QueryEmbedField {
  resolved: Map<string, QueryEmbedEntry>;
  decorations: DecorationSet;
  labels: QueryEmbedLabels;
  thisId: string | null;
}

export function queryEmbedExtension(opts: {
  thisId: string | null;
  labels: QueryEmbedLabels;
}): Extension[] {
  const field = StateField.define<QueryEmbedField>({
    create: (state) => ({
      resolved: new Map(),
      decorations: buildDecorations(state, new Map(), opts.thisId, opts.labels),
      labels: opts.labels,
      thisId: opts.thisId,
    }),
    update: (value, tr) => {
      let resolved = value.resolved;
      for (const eff of tr.effects) {
        if (eff.is(queryEmbedResolved)) {
          if (resolved === value.resolved) resolved = new Map(resolved);
          resolved.set(eff.value.source, eff.value.entry);
        } else if (eff.is(queryEmbedClearAll)) {
          resolved = new Map();
        }
      }
      const cleared = resolved !== value.resolved;
      if (cleared || tr.docChanged) {
        return {
          ...value,
          resolved,
          decorations: buildDecorations(tr.state, resolved, value.thisId, value.labels),
        };
      }
      return { ...value, resolved, decorations: value.decorations.map(tr.changes) };
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.decorations),
  });
  return [
    field,
    ViewPlugin.define((view) => new QueryEmbedResolverPlugin(view, field)),
  ];
}
