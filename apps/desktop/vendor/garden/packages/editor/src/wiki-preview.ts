import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { EditorSelection, StateEffect, StateField } from '@codemirror/state';
import type { EditorState, Extension, Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { renderWikiNode } from './wiki-render.js';

type MarkdownTree = ReturnType<typeof syntaxTree>;
type SyntaxNode = MarkdownTree['topNode'];

export interface WikiPreviewNode {
  name: string;
  from: number;
  to: number;
  raw: string;
  /** Callout markers are source-active across their containing blockquote. */
  activeFrom?: number;
  activeTo?: number;
  blockquoteFrom?: number;
  blockquoteTo?: number;
}

export interface WikiPreviewOptions {
  /** The host routes note, heading, and block references. No href is created. */
  onLinkOpen?: (target: string) => void;
  footnoteLabel?: (label: string) => string;
  footnoteBacklinkLabel?: (label: string, index: number, total: number) => string;
}

const WIKI_NODE_NAMES = new Set([
  'GardenWikiLink', 'GardenCalloutMarker', 'GardenComment', 'GardenMathInline', 'GardenMathBlock',
  'GardenFootnoteReference', 'GardenFootnoteDefinition', 'GardenTag', 'GardenBlockId',
]);

const PROTECTED_ANCESTORS = new Set([
  'FencedCode', 'CodeBlock', 'InlineCode', 'Link', 'Image', 'Autolink', 'URL', 'LinkReference',
  'HTMLBlock', 'HTMLTag', 'HTMLText', 'HTMLComment', 'InlineHTML', 'GardenEnvelope',
  'GardenComment', 'GardenMathInline', 'GardenMathBlock', 'GardenWikiEmbed', 'GardenFootnoteDefinition',
]);

function hasProtectedAncestor(node: SyntaxNode): boolean {
  let ancestor = node.parent;
  while (ancestor) {
    if (PROTECTED_ANCESTORS.has(ancestor.name)) return true;
    ancestor = ancestor.parent;
  }
  return false;
}

function nearestAncestor(node: SyntaxNode, name: string): SyntaxNode | null {
  let ancestor = node.parent;
  while (ancestor) {
    if (ancestor.name === name) return ancestor;
    ancestor = ancestor.parent;
  }
  return null;
}

/** Reads only the shared Garden AST nodes and leaves every raw source range intact. */
export function parseWikiPreviewNodes(source: string, tree: MarkdownTree): WikiPreviewNode[] {
  const nodes: WikiPreviewNode[] = [];
  tree.iterate({
    enter(cursor) {
      const node = cursor.node;
      if (node.name === 'GardenWikiEmbed') return false;
      if (!WIKI_NODE_NAMES.has(node.name)) return undefined;
      if (hasProtectedAncestor(node)) return false;
      const item: WikiPreviewNode = {
        name: node.name,
        from: node.from,
        to: node.to,
        raw: source.slice(node.from, node.to),
      };
      if (node.name === 'GardenCalloutMarker') {
        const blockquote = nearestAncestor(node, 'Blockquote');
        if (!blockquote) return false;
        item.activeFrom = blockquote.from;
        item.activeTo = blockquote.to;
        item.blockquoteFrom = blockquote.from;
        item.blockquoteTo = blockquote.to;
      }
      nodes.push(item);
      // Definitions and math blocks own their complete source range. Do not add
      // inline previews for any parser children they may contain.
      if (node.name === 'GardenFootnoteDefinition' || node.name === 'GardenMathBlock' || node.name === 'GardenComment') return false;
      return undefined;
    },
  });
  return nodes;
}

function normalizedFootnoteLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

function footnoteReferenceLabel(raw: string): string | null {
  return /^\[\^([A-Za-z0-9_-]+)\]$/.exec(raw)?.[1] ?? null;
}

function footnoteDefinitionLabel(raw: string): string | null {
  return /^\[\^([A-Za-z0-9_-]+)\]:/.exec(raw)?.[1] ?? null;
}

function calloutType(raw: string): string | null {
  return /^\[!([A-Za-z][A-Za-z0-9_-]*)\]$/.exec(raw)?.[1] ?? null;
}

function sourceIsActive(state: EditorState, node: WikiPreviewNode, focused: boolean): boolean {
  if (!focused) return false;
  const from = node.activeFrom ?? node.from;
  const to = node.activeTo ?? node.to;
  const firstLine = state.doc.lineAt(from).number;
  const lastLine = state.doc.lineAt(Math.max(from, to - 1)).number;
  return state.selection.ranges.some((range) => {
    const selectionFirst = state.doc.lineAt(range.from).number;
    const selectionLast = state.doc.lineAt(range.to).number;
    return selectionFirst <= lastLine && selectionLast >= firstLine;
  });
}

function sourceLineIsWhole(state: EditorState, node: WikiPreviewNode): boolean {
  const first = state.doc.lineAt(node.from);
  const last = state.doc.lineAt(node.to);
  return first.from === node.from && last.to === node.to;
}

function revealSource(view: EditorView, from: number): void {
  view.dispatch({ selection: EditorSelection.cursor(from), scrollIntoView: true });
  view.focus();
}

class WikiNodeWidget extends WidgetType {
  constructor(
    private readonly node: WikiPreviewNode,
    private readonly options: WikiPreviewOptions,
    private readonly definitionFrom?: number,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof WikiNodeWidget &&
      other.node.name === this.node.name && other.node.from === this.node.from &&
      other.node.to === this.node.to && other.node.raw === this.node.raw &&
      other.definitionFrom === this.definitionFrom &&
      other.options.onLinkOpen === this.options.onLinkOpen &&
      other.options.footnoteLabel === this.options.footnoteLabel;
  }

  ignoreEvent(): boolean {
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const document = view.dom.ownerDocument;
    const element = renderWikiNode(document, this.node.name, this.node.raw, this.options.onLinkOpen) ??
      document.createElement('span');
    if (!element.textContent) element.textContent = this.node.raw;

    if (this.node.name === 'GardenFootnoteReference' && this.definitionFrom !== undefined) {
      const label = footnoteReferenceLabel(this.node.raw) ?? this.node.raw;
      element.setAttribute('role', 'link');
      element.tabIndex = 0;
      element.setAttribute('aria-label', this.options.footnoteLabel?.(label) ?? `Footnote ${label}`);
      element.addEventListener('mousedown', (event) => event.preventDefault());
      element.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        revealSource(view, this.definitionFrom!);
      });
      element.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        event.stopPropagation();
        revealSource(view, this.definitionFrom!);
      });
      return element;
    }

    if (this.node.name !== 'GardenWikiLink' || !this.options.onLinkOpen) {
      element.setAttribute('role', 'button');
      element.setAttribute('aria-label', this.node.raw);
      element.tabIndex = 0;
      element.addEventListener('mousedown', (event) => event.preventDefault());
      const activate = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        revealSource(view, this.node.from);
      };
      element.addEventListener('click', activate);
      element.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        activate(event);
      });
    }
    return element;
  }
}

interface FootnoteBacklink {
  from: number;
  to: number;
}

class FootnoteBacklinksWidget extends WidgetType {
  constructor(
    private readonly label: string,
    private readonly references: readonly FootnoteBacklink[],
    private readonly options: WikiPreviewOptions,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof FootnoteBacklinksWidget && other.label === this.label &&
      other.options.footnoteBacklinkLabel === this.options.footnoteBacklinkLabel &&
      other.references.length === this.references.length &&
      other.references.every((reference, index) => reference.from === this.references[index]?.from && reference.to === this.references[index]?.to);
  }

  ignoreEvent(): boolean {
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const document = view.dom.ownerDocument;
    const group = document.createElement('span');
    group.className = 'garden-wiki-footnote-backlinks';
    this.references.forEach((reference, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'garden-wiki-footnote-backlink';
      button.textContent = '↩';
      button.setAttribute('aria-label', this.options.footnoteBacklinkLabel?.(this.label, index + 1, this.references.length) ?? `Back to footnote ${this.label}`);
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        revealSource(view, reference.from);
      });
      group.appendChild(button);
    });
    return group;
  }
}

interface WikiPreviewState {
  nodes: WikiPreviewNode[];
  decorations: ReturnType<typeof Decoration.set>;
  focused: boolean;
}

function buildWikiPreviewState(state: EditorState, options: WikiPreviewOptions, focused: boolean): WikiPreviewState {
  const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
  const source = state.doc.toString();
  const nodes = parseWikiPreviewNodes(source, tree);
  const definitions = new Map<string, WikiPreviewNode>();
  const references = new Map<string, Array<WikiPreviewNode & { footnoteLabel: string }>>();
  for (const node of nodes) {
    if (node.name === 'GardenFootnoteDefinition') {
      const label = footnoteDefinitionLabel(node.raw);
      if (label) {
        const key = normalizedFootnoteLabel(label);
        if (!definitions.has(key)) definitions.set(key, node);
      }
    } else if (node.name === 'GardenFootnoteReference') {
      const label = footnoteReferenceLabel(node.raw);
      if (label) {
        const key = normalizedFootnoteLabel(label);
        const found = references.get(key) ?? [];
        found.push({ ...node, footnoteLabel: label });
        references.set(key, found);
      }
    }
  }

  const decorations: Range<Decoration>[] = [];
  const lineClasses = new Map<number, Set<string>>();
  const lineAttributes = new Map<number, Map<string, string>>();
  const addLineDecoration = (node: WikiPreviewNode, className: string, attribute?: [string, string]) => {
    const first = state.doc.lineAt(node.from).number;
    const last = state.doc.lineAt(Math.max(node.from, node.to - 1)).number;
    for (let number = first; number <= last; number += 1) {
      const classes = lineClasses.get(number) ?? new Set<string>();
      classes.add(className);
      lineClasses.set(number, classes);
      if (attribute) {
        const attributes = lineAttributes.get(number) ?? new Map<string, string>();
        attributes.set(attribute[0], attribute[1]);
        lineAttributes.set(number, attributes);
      }
    }
  };

  for (const node of nodes) {
    if (node.name === 'GardenCalloutMarker') {
      const type = calloutType(node.raw);
      if (!type) continue;
      if (node.blockquoteFrom !== undefined && node.blockquoteTo !== undefined) {
        const first = state.doc.lineAt(node.blockquoteFrom).number;
        const last = state.doc.lineAt(Math.max(node.blockquoteFrom, node.blockquoteTo - 1)).number;
        const typeClass = type.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
        for (let number = first; number <= last; number += 1) {
          const classes = lineClasses.get(number) ?? new Set<string>();
          classes.add('garden-wiki-callout');
          classes.add(`garden-wiki-callout-${typeClass}`);
          lineClasses.set(number, classes);
          const attributes = lineAttributes.get(number) ?? new Map<string, string>();
          attributes.set('data-callout-type', type.toLowerCase());
          lineAttributes.set(number, attributes);
        }
      }
    }
    if (node.name === 'GardenFootnoteDefinition') addLineDecoration(node, 'garden-wiki-footnote-definition');
    if (sourceIsActive(state, node, focused)) continue;
    if (node.name === 'GardenFootnoteDefinition') {
      const label = footnoteDefinitionLabel(node.raw);
      const found = label ? references.get(normalizedFootnoteLabel(label)) : undefined;
      if (label && found?.length) {
        decorations.push(Decoration.widget({
          widget: new FootnoteBacklinksWidget(label, found.map((reference) => ({ from: reference.from, to: reference.to })), options),
          side: 1,
        }).range(node.to));
      }
      continue;
    }
    const blockPreview = node.name === 'GardenMathBlock' || (node.name === 'GardenComment' && node.raw.includes('\n'));
    if (blockPreview && !sourceLineIsWhole(state, node)) continue;
    const label = node.name === 'GardenFootnoteReference' ? footnoteReferenceLabel(node.raw) : null;
    const definition = label ? definitions.get(normalizedFootnoteLabel(label)) : undefined;
    const widget = new WikiNodeWidget(node, options, definition?.from);
    decorations.push(Decoration.replace({
      widget,
      block: blockPreview,
    }).range(node.from, node.to));
  }

  for (const [number, classes] of lineClasses) {
    const attributes = Object.fromEntries(lineAttributes.get(number) ?? []);
    decorations.push(Decoration.line({
      class: [...classes].join(' '),
      attributes,
    }).range(state.doc.line(number).from));
  }

  return { nodes, decorations: Decoration.set(decorations, true), focused };
}

/** Previews the shared Garden wiki grammar while retaining each original source range. */
export function wikiPreview(options: WikiPreviewOptions = {}): Extension {
  const field = StateField.define<WikiPreviewState>({
    create: (state) => buildWikiPreviewState(state, options, false),
    update(value, transaction) {
      const focusEffect = transaction.effects.find((effect) => effect.is(wikiPreviewFocusEffect));
      const focused = focusEffect ? focusEffect.value : value.focused;
      if (transaction.docChanged || focused !== value.focused) {
        return buildWikiPreviewState(transaction.state, options, focused);
      }
      if (!value.focused || transaction.startState.selection.eq(transaction.state.selection)) return value;
      return buildWikiPreviewState(transaction.state, options, focused);
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
  });

  const focusHandlers = EditorView.domEventHandlers({
    focusin(_event, view) {
      view.dispatch({ effects: wikiPreviewFocusEffect.of(true) });
      return false;
    },
    focusout(event, view) {
      const nextTarget = event.relatedTarget as Node | null;
      if (nextTarget && view.dom.contains(nextTarget)) return false;
      view.dispatch({ effects: wikiPreviewFocusEffect.of(false) });
      return false;
    },
  });
  return [field, focusHandlers];
}

export const wikiPreviewFocusEffect = StateEffect.define<boolean>();
