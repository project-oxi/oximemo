import { renderWikiNode } from './wiki-render.js';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { EditorSelection, StateEffect, StateField } from '@codemirror/state';
import type { EditorState, Extension } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { gardenMarkdownParser as markdownParser, parseWikiTarget } from '@garden/markdown/syntax';

type MarkdownTree = ReturnType<typeof syntaxTree>;
type SyntaxNode = MarkdownTree['topNode'];

export type EmbedResource =
  | { kind: 'image'; url: string; title?: string }
  | { kind: 'audio'; url: string; title?: string }
  | { kind: 'markdown'; source: string; title?: string }
  | { kind: 'html'; source: string; title?: string };

export interface EmbedPreviewOptions {
  /** Resolve a document or asset reference to already-contained source or a trusted URL. */
  resolve?: (ref: string) => EmbedResource | undefined;
  editLabel?: string;
  missingLabel?: string;
  onLinkOpen?: (url: string) => void;
}

export interface MarkdownEmbedBlock {
  from: number;
  to: number;
  raw: string;
  kind: 'wiki' | 'image' | 'html';
  ref?: string;
  title?: string;
}

const SAFE_ELEMENTS = new Set([
  'html', 'head', 'body', 'title', 'main', 'article', 'section', 'header', 'footer', 'div', 'span',
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'em', 'strong', 'b', 'i', 'u', 's', 'del', 'ins', 'mark', 'small', 'sub', 'sup', 'br', 'hr',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'a', 'img',
]);

const DROP_SUBTREE_ELEMENTS = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'input',
  'button', 'textarea', 'select', 'option', 'optgroup', 'meta', 'link', 'base', 'svg', 'math',
  'video', 'audio', 'source', 'track', 'canvas', 'template', 'noscript',
]);

const SAFE_STYLE_PROPERTIES = new Set([
  'background-color', 'border-color', 'border-radius', 'border-style', 'border-width', 'color',
  'display', 'font-family', 'font-size', 'font-style', 'font-weight', 'list-style-type', 'margin',
  'margin-block', 'margin-inline', 'padding', 'padding-block', 'padding-inline', 'text-align',
  'text-decoration', 'white-space',
]);

const SAFE_COMMON_ATTRIBUTES = new Set(['aria-label', 'aria-hidden', 'class', 'dir', 'id', 'lang', 'title']);

const HTML_PREVIEW_BLOCK_STYLES = `
p,h1,h2,h3,h4,h5,h6,ul,ol,blockquote,pre,table { margin-block: .5em; }
h1,h2,h3,h4,h5,h6 { line-height: 1.25; }
li { margin-block: .15em; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; }
img,table { max-width: 100%; }
`;

function safeEmbedUrl(value: string): boolean {
  const url = value.trim();
  if (!url || /[\u0000-\u0020\u007f\\]/.test(url)) return false;
  if (/^(?:javascript|vbscript|data|file):/i.test(url) || url.startsWith('//')) return false;

  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  if (!scheme) return true;
  if (scheme === 'http' || scheme === 'https') {
    try {
      const parsed = new URL(url);
      return Boolean(parsed.hostname);
    } catch {
      return false;
    }
  }
  if (scheme === 'blob') return /^blob:(?:https?:\/\/[^/]+|null)\/.+/i.test(url);
  return false;
}

function sanitizedStyle(styleText: string, element: HTMLElement): void {
  for (const declaration of styleText.split(';')) {
    const separator = declaration.indexOf(':');
    if (separator < 1) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim();
    if (!SAFE_STYLE_PROPERTIES.has(property) || !value || value.length > 160) continue;
    if (/(?:url\s*\(|expression\s*\(|@import|javascript:|vbscript:|data:|\/\*)/i.test(value)) continue;
    element.style.setProperty(property, value);
  }
}

function sanitizeNode(source: Node, parent: Node, document: Document): void {
  if (source.nodeType === 3) {
    parent.appendChild(document.createTextNode(source.nodeValue ?? ''));
    return;
  }
  if (source.nodeType !== 1) return;

  const sourceElement = source as Element;
  const tag = sourceElement.localName.toLowerCase();
  if (DROP_SUBTREE_ELEMENTS.has(tag)) return;
  if (!SAFE_ELEMENTS.has(tag)) {
    for (const child of Array.from(sourceElement.childNodes)) sanitizeNode(child, parent, document);
    return;
  }

  const element = document.createElement(tag);
  for (const attribute of Array.from(sourceElement.attributes)) {
    const name = attribute.name.toLowerCase();
    const value = attribute.value;
    if (name.startsWith('on') || name === 'srcdoc' || name === 'xmlns') continue;
    if (name === 'style') {
      sanitizedStyle(value, element);
    } else if (SAFE_COMMON_ATTRIBUTES.has(name)) {
      element.setAttribute(name, value);
    } else if ((tag === 'img' && name === 'alt') ||
      ((tag === 'img' || tag === 'th' || tag === 'td') && (name === 'width' || name === 'height' || name === 'colspan' || name === 'rowspan')) ||
      (tag === 'th' && name === 'scope')) {
      if (/^(?:width|height|colspan|rowspan)$/.test(name) && !/^\d{1,4}$/.test(value)) continue;
      if (name === 'scope' && !/^(?:row|col|rowgroup|colgroup)$/.test(value)) continue;
      element.setAttribute(name, value);
    } else if (tag === 'ol' && name === 'start' && /^-?\d{1,6}$/.test(value)) {
      element.setAttribute(name, value);
    }
  }

  parent.appendChild(element);
  for (const child of Array.from(sourceElement.childNodes)) sanitizeNode(child, element, document);
}

/** Rebuilds inert HTML from an allowlist. The original source is never rewritten. */
export function sanitizeHtmlEmbed(source: string, ownerDocument: Document): DocumentFragment {
  const template = ownerDocument.createElement('template');
  template.innerHTML = source;
  const inertDocument = template.content.ownerDocument;
  const result = inertDocument.createDocumentFragment();
  for (const child of Array.from(template.content.childNodes)) sanitizeNode(child, result, inertDocument);
  return result;
}

function serializeInertFragment(fragment: DocumentFragment): string {
  const inertDocument = fragment.ownerDocument;
  const wrapper = inertDocument.createElement('div');
  wrapper.appendChild(fragment);
  return wrapper.innerHTML;
}

function childNodes(node: SyntaxNode): SyntaxNode[] {
  const children: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) children.push(child);
  return children;
}

function findDescendant(node: SyntaxNode, name: string): SyntaxNode | undefined {
  for (const child of childNodes(node)) {
    if (child.name === name) return child;
    const nested = findDescendant(child, name);
    if (nested) return nested;
  }
  return undefined;
}

function wholeLineRange(state: EditorState, from: number, to: number): { from: number; to: number } | null {
  const firstLine = state.doc.lineAt(from);
  const lastLine = state.doc.lineAt(to);
  if (firstLine.from !== from || lastLine.to !== to) return null;
  return { from: firstLine.from, to: lastLine.to };
}

function unescapeMarkdown(value: string): string {
  return value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1');
}

function linkTitle(source: string, node: SyntaxNode): string | undefined {
  const titleNode = childNodes(node).find((child) => child.name === 'LinkTitle');
  if (!titleNode) return undefined;
  const raw = source.slice(titleNode.from, titleNode.to);
  const match = /^(?:"([\s\S]*)"|'([\s\S]*)'|\(([\s\S]*)\))$/.exec(raw);
  return unescapeMarkdown(match?.[1] ?? match?.[2] ?? match?.[3] ?? raw);
}

/** Finds only standalone top-level Markdown images/wiki embeds and raw HTML blocks. */
export function parseMarkdownEmbeds(source: string, tree: MarkdownTree): MarkdownEmbedBlock[] {
  const blocks: MarkdownEmbedBlock[] = [];
  tree.iterate({
    enter(cursor) {
      const node = cursor.node;
      if (node.name === 'HTMLBlock' && node.parent?.name === 'Document') {
        const range = wholeLineRangeForSource(source, node.from, node.to);
        if (range) blocks.push({ from: range.from, to: range.to, raw: source.slice(range.from, range.to), kind: 'html' });
        return false;
      }
      if (node.name !== 'Paragraph' || node.parent?.name !== 'Document') return;

      const range = wholeLineRangeForSource(source, node.from, node.to);
      if (!range) return false;
      const raw = source.slice(node.from, node.to);
      const wiki = /^!\[\[([^\]\r\n]+)\]\]$/.exec(raw);
      if (wiki) {
        const target = parseWikiTarget(raw);
        if (target) blocks.push({ from: range.from, to: range.to, raw: source.slice(range.from, range.to), kind: 'wiki', ref: target.target, title: target.alias || undefined });
        return false;
      }

      const children = childNodes(node);
      const image = children.length === 1 && children[0]?.name === 'Image' ? children[0] : undefined;
      if (!image || image.from !== node.from || image.to !== node.to) return false;
      const imageChildren = childNodes(image);
      const urlNode = imageChildren.find((child) => child.name === 'URL') ?? findDescendant(image, 'URL');
      if (!urlNode) return false;
      const marks = imageChildren.filter((child) => child.name === 'LinkMark');
      const alt = marks.length >= 2 ? unescapeMarkdown(source.slice(marks[0]!.to, marks[1]!.from)) : undefined;
      const ref = unescapeMarkdown(source.slice(urlNode.from, urlNode.to).trim());
      if (ref) blocks.push({
        from: range.from,
        to: range.to,
        raw: source.slice(range.from, range.to),
        kind: 'image',
        ref,
        title: linkTitle(source, image) ?? alt,
      });
      return false;
    },
  });
  return blocks;
}

function wholeLineRangeForSource(source: string, from: number, to: number): { from: number; to: number } | null {
  const firstStart = source.lastIndexOf('\n', from - 1) + 1;
  const lastStart = source.lastIndexOf('\n', to - 1) + 1;
  const lastEndAt = source.indexOf('\n', to);
  const lastEnd = (lastEndAt < 0 ? source.length : lastEndAt) - (source[lastEndAt < 0 ? source.length - 1 : lastEndAt - 1] === '\r' ? 1 : 0);
  if (firstStart !== from || lastEnd !== to || lastStart > to) return null;
  return { from: firstStart, to: lastEnd };
}

function selectionReveals(block: MarkdownEmbedBlock, selection: EditorSelection): boolean {
  return selection.ranges.some((range) => range.empty
    ? range.head >= block.from && range.head <= block.to
    : range.from <= block.to && range.to >= block.from);
}

function appendInlineRange(
  document: Document,
  parent: Node,
  source: string,
  from: number,
  to: number,
  nodes: readonly SyntaxNode[],
  onLinkOpen?: EmbedPreviewOptions['onLinkOpen'],
): void {
  let position = from;
  for (const node of nodes) {
    if (node.from < from || node.to > to || node.to <= position) continue;
    if (position < node.from) parent.appendChild(document.createTextNode(source.slice(position, node.from)));
    appendInlineNode(document, parent, source, node, onLinkOpen);
    position = node.to;
  }
  if (position < to) parent.appendChild(document.createTextNode(source.slice(position, to)));
}

function appendInlineNode(
  document: Document,
  parent: Node,
  source: string,
  node: SyntaxNode,
  onLinkOpen?: EmbedPreviewOptions['onLinkOpen'],
): void {
  let ancestor = node.parent;
  while (ancestor && ancestor.name !== 'Blockquote') ancestor = ancestor.parent;
  const wiki = node.name === 'GardenCalloutMarker' && !ancestor ? null
    : renderWikiNode(document, node.name, source.slice(node.from, node.to), onLinkOpen);
  if (wiki) { parent.appendChild(wiki); return; }
  const children = childNodes(node);
  if (node.name === 'InlineCode') {
    const code = document.createElement('code');
    const raw = source.slice(node.from, node.to);
    const fence = /^`+/.exec(raw)?.[0];
    let text = fence && raw.endsWith(fence) ? raw.slice(fence.length, -fence.length).replace(/[\r\n]/g, ' ') : raw;
    if (/^ .* $/.test(text) && !/^ +$/.test(text)) text = text.slice(1, -1);
    code.textContent = text;
    parent.appendChild(code);
    return;
  }
  if (node.name === 'QuoteMark') return;
  if (node.name === 'Escape') {
    parent.appendChild(document.createTextNode(source.slice(node.from + 1, node.to)));
    return;
  }
  if (node.name === 'HardBreak') {
    parent.appendChild(document.createElement('br'));
    return;
  }
  if (node.name === 'Image') {
    const literal = document.createElement('code');
    literal.textContent = source.slice(node.from, node.to);
    parent.appendChild(literal);
    return;
  }
  if (node.name === 'Link') {
    const marks = children.filter((child) => child.name === 'LinkMark');
    if (marks.length < 2) {
      parent.appendChild(document.createTextNode(source.slice(node.from, node.to)));
      return;
    }
    const url = children.find((child) => child.name === 'URL' && child.from >= marks[1]!.to);
    const labelFrom = marks[0]!.to;
    const labelTo = marks[1]!.from;
    const labelNodes = children.filter((child) => child.name !== 'LinkMark' && child.name !== 'URL' && child.name !== 'LinkTitle');
    if (url) {
      const href = unescapeMarkdown(source.slice(url.from, url.to));
      if (safeEmbedUrl(href)) {
        const link = document.createElement('a');
        link.href = href;
        const title = linkTitle(source, node);
        if (title) link.title = title;
        appendInlineRange(document, link, source, labelFrom, labelTo, labelNodes, onLinkOpen);
        link.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          onLinkOpen?.(href);
        });
        parent.appendChild(link);
        return;
      }
    }
    appendInlineRange(document, parent, source, labelFrom, labelTo, labelNodes, onLinkOpen);
    return;
  }
  const inlineTag: Record<string, string> = {
    Emphasis: 'em',
    StrongEmphasis: 'strong',
    Strikethrough: 'del',
    Highlight: 'mark',
  };
  if (inlineTag[node.name]) {
    const marks = children.filter((child) => child.name.endsWith('Mark'));
    if (marks.length >= 2) {
      const wrapper = document.createElement(inlineTag[node.name]!);
      appendInlineRange(document, wrapper, source, marks[0]!.to, marks.at(-1)!.from,
        children.filter((child) => !child.name.endsWith('Mark')), onLinkOpen);
      parent.appendChild(wrapper);
      return;
    }
  }
  if (node.name.startsWith('HTML') || node.name === 'InlineHTML') {
    parent.appendChild(document.createTextNode(source.slice(node.from, node.to)));
    return;
  }
  // Unsupported extension syntax stays literal and readable inside the safe preview.
  parent.appendChild(document.createTextNode(source.slice(node.from, node.to)));
}

function appendMarkdownBlock(
  document: Document,
  parent: Node,
  source: string,
  node: SyntaxNode,
  onLinkOpen?: EmbedPreviewOptions['onLinkOpen'],
): void {
  let ancestor = node.parent;
  while (ancestor && ancestor.name !== 'Blockquote') ancestor = ancestor.parent;
  const wiki = node.name === 'GardenCalloutMarker' && !ancestor ? null
    : renderWikiNode(document, node.name, source.slice(node.from, node.to), onLinkOpen);
  if (wiki) { parent.appendChild(wiki); return; }
  const children = childNodes(node);
  const heading = /^(?:ATXHeading|SetextHeading)([1-6])$/.exec(node.name);
  if (heading) {
    const element = document.createElement(`h${heading[1]}`);
    const contentFrom = children.find((child) => child.name === 'HeaderMark')?.to ?? node.from;
    appendInlineRange(document, element, source, contentFrom, node.to,
      children.filter((child) => child.name !== 'HeaderMark' && !child.name.includes('HeadingMark')), onLinkOpen);
    parent.appendChild(element);
    return;
  }
  if (node.name === 'Paragraph') {
    const paragraph = document.createElement('p');
    appendInlineRange(document, paragraph, source, node.from, node.to, children, onLinkOpen);
    parent.appendChild(paragraph);
    return;
  }
  if (node.name === 'Blockquote') {
    const quote = document.createElement('blockquote');
    if (/^>\s*\[![A-Za-z][A-Za-z0-9_-]*\]/.test(source.slice(node.from, node.to))) quote.className = 'garden-wiki-callout';
    for (const child of children) if (!child.name.endsWith('Mark')) appendMarkdownBlock(document, quote, source, child, onLinkOpen);
    parent.appendChild(quote);
    return;
  }
  if (node.name === 'BulletList' || node.name === 'OrderedList') {
    const list = document.createElement(node.name === 'BulletList' ? 'ul' : 'ol');
    for (const child of children) if (child.name === 'ListItem') appendMarkdownBlock(document, list, source, child, onLinkOpen);
    parent.appendChild(list);
    return;
  }
  if (node.name === 'ListItem') {
    const item = document.createElement('li');
    for (const child of children) {
      if (child.name === 'ListMark') continue;
      if (child.name === 'Task') {
        const raw = source.slice(child.from, child.to);
        const taskMarker = /^\[([ xX])\][\t ]+/.exec(raw);
        if (taskMarker) {
          const paragraph = document.createElement('p');
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.disabled = true;
          checkbox.checked = /x/i.test(taskMarker[1]!);
          checkbox.className = 'garden-markdown-embed-preview-task';
          checkbox.setAttribute('aria-label', source.slice(child.from + taskMarker[0].length, child.to).trim() || 'Task');
          paragraph.appendChild(checkbox);
          const contentFrom = child.from + taskMarker[0].length;
          appendInlineRange(document, paragraph, source, contentFrom, child.to,
            childNodes(child).filter((inline) => inline.from >= contentFrom), onLinkOpen);
          item.appendChild(paragraph);
          continue;
        }
      }
      appendMarkdownBlock(document, item, source, child, onLinkOpen);
    }
    parent.appendChild(item);
    return;
  }
  if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    const codeText = children.filter((child) => child.name === 'CodeText').map((child) => source.slice(child.from, child.to)).join('');
    code.textContent = codeText || source.slice(node.from, node.to);
    pre.appendChild(code);
    parent.appendChild(pre);
    return;
  }
  if (node.name === 'HorizontalRule') {
    parent.appendChild(document.createElement('hr'));
    return;
  }
  // HTML and unfamiliar blocks remain visible as inert source text.
  const literal = document.createElement('pre');
  literal.textContent = source.slice(node.from, node.to);
  parent.appendChild(literal);
}

function renderMarkdownSource(
  source: string,
  document: Document,
  onLinkOpen?: EmbedPreviewOptions['onLinkOpen'],
): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const tree = markdownParser.parse(source).topNode;
  for (let node = tree.firstChild; node; node = node.nextSibling) appendMarkdownBlock(document, fragment, source, node, onLinkOpen);
  return fragment;
}

function resolvedResource(ref: string, resolver: EmbedPreviewOptions['resolve']): EmbedResource | undefined {
  if (!resolver) return undefined;
  try {
    const resource = resolver(ref);
    if (!resource || typeof resource !== 'object') return undefined;
    if ((resource.kind === 'image' || resource.kind === 'audio') && typeof resource.url === 'string' && safeEmbedUrl(resource.url)) return resource;
    if ((resource.kind === 'markdown' || resource.kind === 'html') && typeof resource.source === 'string') return resource;
    return undefined;
  } catch {
    return undefined;
  }
}

function sameResource(left: EmbedResource | undefined, right: EmbedResource | undefined): boolean {
  if (!left || !right) return left === right;
  if (left.kind !== right.kind || left.title !== right.title) return false;
  if (left.kind === 'image' || left.kind === 'audio') {
    return (right.kind === 'image' || right.kind === 'audio') && left.url === right.url;
  }
  return (right.kind === 'markdown' || right.kind === 'html') && left.source === right.source;
}

interface RenderedEmbedBlock extends MarkdownEmbedBlock {
  resource?: EmbedResource;
}

class EmbedPreviewWidget extends WidgetType {
  private readonly iframeMeasurementCleanups = new WeakMap<HTMLElement, () => void>();

  constructor(
    private readonly block: RenderedEmbedBlock,
    private readonly labels: EmbedPreviewOptions,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof EmbedPreviewWidget &&
      other.block.from === this.block.from && other.block.to === this.block.to &&
      other.block.raw === this.block.raw && other.block.kind === this.block.kind &&
      other.block.ref === this.block.ref && other.block.title === this.block.title &&
      sameResource(other.block.resource, this.block.resource) &&
      other.labels.editLabel === this.labels.editLabel && other.labels.missingLabel === this.labels.missingLabel &&
      other.labels.onLinkOpen === this.labels.onLinkOpen;
  }

  ignoreEvent(): boolean {
    return true;
  }

  destroy(dom: HTMLElement): void {
    this.iframeMeasurementCleanups.get(dom)?.();
    this.iframeMeasurementCleanups.delete(dom);
  }

  toDOM(view: EditorView): HTMLElement {
    const document = view.dom.ownerDocument;
    const wrapper = document.createElement('div');
    const resource = this.block.resource;
    const classKind = resource?.kind ?? this.block.kind;
    wrapper.className = `garden-markdown-embed-preview garden-markdown-embed-preview-${classKind}`;

    const revealSource = () => {
      view.dispatch({ selection: EditorSelection.range(this.block.from, this.block.to) });
      view.focus();
    };

    if (this.block.kind === 'html' && !resource) {
      this.appendHtmlFrame(document, wrapper, this.block.raw, undefined);
    } else if (!resource) {
      const missing = document.createElement('div');
      missing.className = 'garden-markdown-embed-preview-missing';
      if (this.labels.missingLabel) {
        const message = document.createElement('span');
        message.textContent = this.labels.missingLabel;
        missing.appendChild(message);
      }
      const source = document.createElement('code');
      source.textContent = this.block.raw;
      missing.appendChild(source);
      wrapper.appendChild(missing);
    } else if (resource.kind === 'image') {
      const image = document.createElement('img');
      image.className = 'garden-markdown-embed-preview-image';
      image.src = resource.url;
      image.alt = resource.title ?? this.block.title ?? '';
      image.loading = 'lazy';
      image.decoding = 'async';
      if (resource.title) image.title = resource.title;
      wrapper.appendChild(image);
    } else if (resource.kind === 'audio') {
      const audio = document.createElement('audio');
      audio.className = 'garden-markdown-embed-preview-audio';
      audio.controls = true;
      audio.preload = 'none';
      audio.src = resource.url;
      if (resource.title) audio.setAttribute('aria-label', resource.title);
      wrapper.appendChild(audio);
    } else if (resource.kind === 'markdown') {
      if (resource.title) this.appendTitle(document, wrapper, resource.title);
      const content = document.createElement('div');
      content.className = 'garden-markdown-embed-preview-markdown-content';
      content.appendChild(renderMarkdownSource(resource.source, document, this.labels.onLinkOpen));
      wrapper.appendChild(content);
    } else {
      this.appendHtmlFrame(document, wrapper, resource.source, resource.title);
    }

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'garden-markdown-embed-preview-edit';
    const editLabel = this.labels.editLabel ?? 'Edit source';
    edit.setAttribute('aria-label', editLabel);
    edit.title = editLabel;
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('width', '14');
    icon.setAttribute('height', '14');
    icon.setAttribute('viewBox', '0 0 16 16');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '1.5');
    icon.setAttribute('stroke-linecap', 'round');
    icon.setAttribute('stroke-linejoin', 'round');
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('focusable', 'false');
    const pencil = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pencil.setAttribute('d', 'm10.9 2.1 3 3M3 13l3-.7 7.7-7.7a1.4 1.4 0 0 0-2-2L4 10.3 3 13Z');
    icon.appendChild(pencil);
    edit.appendChild(icon);
    edit.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      revealSource();
    });
    wrapper.appendChild(edit);
    return wrapper;
  }

  private appendTitle(document: Document, wrapper: HTMLElement, title: string): void {
    const heading = document.createElement('div');
    heading.className = 'garden-markdown-embed-preview-title';
    heading.textContent = title;
    wrapper.appendChild(heading);
  }

  private appendHtmlFrame(
    document: Document,
    wrapper: HTMLElement,
    source: string,
    title: string | undefined,
  ): void {
    const sanitized = sanitizeHtmlEmbed(source, document);
    const serialized = serializeInertFragment(sanitized.cloneNode(true) as DocumentFragment);
    const iframe = document.createElement('iframe');
    iframe.className = 'garden-markdown-embed-preview-html';
    iframe.setAttribute('sandbox', '');
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.setAttribute('loading', 'lazy');
    iframe.setAttribute('scrolling', 'auto');
    iframe.title = title ?? 'HTML embed preview';
    iframe.style.height = '40px';
    iframe.srcdoc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{display:flow-root;font:14px/1.55 system-ui,sans-serif;margin:12px}body>:first-child{margin-block-start:0!important}body>:last-child{margin-block-end:0!important}${HTML_PREVIEW_BLOCK_STYLES}</style></head><body>${serialized}</body></html>`;
    wrapper.appendChild(iframe);
    const measurementHost = document.createElement('div');
    measurementHost.setAttribute('aria-hidden', 'true');
    measurementHost.inert = true;
    const shadow = measurementHost.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      :host { display: block !important; position: absolute !important; inset: 0 auto auto 0 !important; z-index: -1 !important; visibility: hidden !important; pointer-events: none !important; overflow: hidden !important; color: #222; background: #fff; }
      .viewport { display: flow-root; box-sizing: border-box; width: 100%; margin: 0; padding: 12px; font: 14px/1.55 system-ui,sans-serif; }
      .viewport > :first-child { margin-block-start: 0 !important; }
      .viewport > :last-child { margin-block-end: 0 !important; }
      ${HTML_PREVIEW_BLOCK_STYLES}
    `;
    const viewport = document.createElement('div');
    viewport.className = 'viewport';
    viewport.appendChild(sanitized);
    shadow.append(style, viewport);
    wrapper.appendChild(measurementHost);

    let previousWidth = -1;
    const measure = (width: number) => {
      if (!Number.isFinite(width) || width <= 0 || Math.abs(width - previousWidth) < 0.5) return;
      previousWidth = width;
      measurementHost.style.width = `${width}px`;
      const contentHeight = Math.max(viewport.scrollHeight, viewport.getBoundingClientRect().height);
      const frameHeight = Math.max(40, Math.min(1200, Math.ceil(contentHeight)));
      iframe.style.height = `${frameHeight}px`;
    };

    const view = document.defaultView;
    const ResizeObserverConstructor = view && (view as Window & typeof globalThis).ResizeObserver;
    let observer: ResizeObserver | undefined;
    let fallbackFrame = 0;
    if (ResizeObserverConstructor) {
      observer = new ResizeObserverConstructor((entries) => {
        const entry = entries.find((candidate) => candidate.target === iframe);
        if (entry) measure(entry.contentRect.width);
      });
      observer.observe(iframe);
    } else if (view) {
      fallbackFrame = view.requestAnimationFrame(() => measure(iframe.getBoundingClientRect().width));
    }
    this.iframeMeasurementCleanups.set(wrapper, () => {
      observer?.disconnect();
      if (fallbackFrame && view) view.cancelAnimationFrame(fallbackFrame);
      measurementHost.remove();
    });
  }
}

interface EmbedPreviewState {
  blocks: RenderedEmbedBlock[];
  decorations: ReturnType<typeof Decoration.set>;
  focused: boolean;
}

export const embedPreviewFocusEffect = StateEffect.define<boolean>();
export const embedPreviewRefreshEffect = StateEffect.define<null>();

function buildEmbedPreviewState(
  state: EditorState,
  options: EmbedPreviewOptions,
  focused: boolean,
): EmbedPreviewState {
  const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
  const source = state.doc.toString();
  const blocks = parseMarkdownEmbeds(source, tree).map((block): RenderedEmbedBlock => ({
    ...block,
    resource: block.ref ? resolvedResource(block.ref, options.resolve) : undefined,
  }));
  const ranges = blocks
    .filter((block) => !focused || !selectionReveals(block, state.selection))
    .map((block) => Decoration.replace({
      widget: new EmbedPreviewWidget(block, options),
      block: true,
    }).range(block.from, block.to));
  return { blocks, decorations: Decoration.set(ranges, true), focused };
}

/** Previews resolved standalone embeds and sanitized top-level HTML without changing source. */
export function embedPreview(options: EmbedPreviewOptions = {}): Extension {
  const field = StateField.define<EmbedPreviewState>({
    create: (state) => buildEmbedPreviewState(state, options, false),
    update(value, transaction) {
      const focusEffect = transaction.effects.find((effect) => effect.is(embedPreviewFocusEffect));
      const focused = focusEffect ? focusEffect.value : value.focused;
      const refresh = transaction.effects.some((effect) => effect.is(embedPreviewRefreshEffect));
      if (transaction.docChanged || focused !== value.focused || refresh) {
        return buildEmbedPreviewState(transaction.state, options, focused);
      }
      if (transaction.startState.selection.eq(transaction.state.selection)) return value;
      const visibilityChanged = value.blocks.some((block) =>
        selectionReveals(block, transaction.startState.selection) !== selectionReveals(block, transaction.state.selection),
      );
      return value.focused && visibilityChanged
        ? buildEmbedPreviewState(transaction.state, options, focused)
        : value;
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
  });

  const focusHandlers = EditorView.domEventHandlers({
    focusin(_event, view) {
      view.dispatch({ effects: embedPreviewFocusEffect.of(true) });
      return false;
    },
    focusout(event, view) {
      const nextTarget = event.relatedTarget as Node | null;
      if (nextTarget && view.dom.contains(nextTarget)) return false;
      view.dispatch({ effects: embedPreviewFocusEffect.of(false) });
      return false;
    },
  });
  return [field, focusHandlers];
}
