/**
 * Memo embed extension — `![[memo-id]]` block transclusion
 * (spec: 2026-08-01-memo-wiki-links-design.md).
 *
 * A line that is (whitespace +) `![[memo-id]]` is replaced by a read-only
 * block widget rendering the target memo's body inline. Header click opens the
 * source memo. Depth-1 only: nested `![[...]]` in an embedded body render as
 * plain text (no recursion → no cycles).
 *
 * Architecture mirrors `@atomic-editor/editor`'s `wiki-links.js` resolve path:
 *   - StateField: holds the block-replace decorations + a resolved-body cache,
 *     rebuilds on doc change or resolve effect.
 *   - ViewPlugin (orchestrator): scans visible embed targets, fetches via
 *     `getMemo`, dispatches an effect. Emits NO decorations (so it can't trip
 *     CM6's "block decorations may not come from a plugin" rule — block decos
 *     come only from the StateField).
 *
 * Widgets render purely from the cache; they never own a fetch or a `view`.
 */
import {
  type EditorState,
  type Extension,
  type Range,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, type ViewUpdate, ViewPlugin, WidgetType } from "@codemirror/view";
import { marked } from "marked";

import { getMemo } from "./api";

const EMBED_RE = /^\s*!\[\[([^\]\n|]+)\]\]\s*$/;

interface EmbedEntry {
  body: string;
  status: "resolved" | "missing";
}

interface EmbedResolvedEffect {
  target: string;
  entry: EmbedEntry;
}

const embedResolved = StateEffect.define<EmbedResolvedEffect>();

type WidgetStatus = "loading" | "resolved" | "missing";
function statusOf(entry: EmbedEntry | undefined): WidgetStatus {
  return entry ? entry.status : "loading";
}

function renderEmbedBody(el: HTMLElement, entry: EmbedEntry): void {
  if (entry.status === "missing") {
    el.textContent = "삭제된 메모";
    el.classList.add("ox-embed-missing");
    return;
  }
  el.innerHTML = marked.parse(entry.body.slice(0, 800), { async: false }) as string;
}

class EmbedWidget extends WidgetType {
  constructor(readonly id: string, readonly entry: EmbedEntry | undefined, readonly onOpen: (id: string) => void) {
    super();
  }
  // Recreate when the id or resolved-status changes (loading → resolved/missing)
  // so the fetched body replaces the placeholder.
  eq(other: EmbedWidget) {
    return other.id === this.id && statusOf(other.entry) === statusOf(this.entry);
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = `ox-embed ox-embed-${statusOf(this.entry)}`;
    const hdr = document.createElement("button");
    hdr.type = "button";
    hdr.className = "ox-embed-hdr";
    hdr.textContent = "▢ " + this.id.slice(0, 8);
    hdr.title = "메모 열기";
    hdr.addEventListener("click", () => this.onOpen(this.id));
    const body = document.createElement("div");
    body.className = "ox-embed-body";
    wrap.append(hdr, body);

    if (this.entry) renderEmbedBody(body, this.entry);
    else body.textContent = "메모 불러오는 중…";
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}

function buildDecorations(
  state: EditorState,
  resolved: Map<string, EmbedEntry>,
  onOpen: (id: string) => void,
) {
  const decos: Range<Decoration>[] = [];
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    const m = EMBED_RE.exec(line.text);
    if (m) {
      const id = m[1].trim();
      decos.push(
        Decoration.replace({ block: true, widget: new EmbedWidget(id, resolved.get(id), onOpen) }).range(
          line.from,
          line.to,
        ),
      );
    }
  }
  return Decoration.set(decos, true);
}

/** Pure orchestrator: resolves visible, unresolved embed targets and dispatches
 *  the result as an effect. Emits no decorations. */
class EmbedResolverPlugin {
  readonly pending = new Set<string>();
  destroyed = false;
  constructor(readonly view: EditorView, readonly field: StateField<EmbedField>) {
    this.resolveVisibleEmbeds();
  }
  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged) this.resolveVisibleEmbeds();
  }
  destroy() {
    this.destroyed = true;
  }
  resolveVisibleEmbeds() {
    const { doc } = this.view.state;
    const resolved = this.view.state.field(this.field).resolved;
    const seen = new Set<string>();
    for (const { from, to } of this.view.visibleRanges) {
      for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) {
        const m = EMBED_RE.exec(doc.line(n).text);
        if (!m) continue;
        const id = m[1].trim();
        if (seen.has(id) || resolved.has(id) || this.pending.has(id)) continue;
        seen.add(id);
        this.resolve(id);
      }
    }
  }
  resolve(id: string) {
    this.pending.add(id);
    getMemo(id)
      .then((m) => {
        if (this.destroyed) return;
        const entry: EmbedEntry = m.deleted_at
          ? { body: "", status: "missing" }
          : { body: m.body, status: "resolved" };
        this.view.dispatch({ effects: embedResolved.of({ target: id, entry }) });
      })
      .catch(() => {
        if (this.destroyed) return;
        this.view.dispatch({
          effects: embedResolved.of({ target: id, entry: { body: "", status: "missing" } }),
        });
      })
      .finally(() => this.pending.delete(id));
  }
}

interface EmbedField {
  resolved: Map<string, EmbedEntry>;
  decorations: DecorationSet;
}

export function embedExtension(opts: { onOpen: (id: string) => void }): Extension[] {
  const field = StateField.define<EmbedField>({
    create: (state) => ({ resolved: new Map(), decorations: buildDecorations(state, new Map(), opts.onOpen) }),
    update: (value, tr) => {
      let resolved = value.resolved;
      let changed = false;
      for (const eff of tr.effects) {
        if (!eff.is(embedResolved)) continue;
        if (resolved === value.resolved) resolved = new Map(resolved);
        resolved.set(eff.value.target, eff.value.entry);
        changed = true;
      }
      if (changed || tr.docChanged) {
        return { resolved, decorations: buildDecorations(tr.state, resolved, opts.onOpen) };
      }
      return { resolved, decorations: value.decorations.map(tr.changes) };
    },
    provide: (f) => EditorView.decorations.from(f, (v) => v.decorations),
  });
  return [field, ViewPlugin.define((view) => new EmbedResolverPlugin(view, field))];
}
