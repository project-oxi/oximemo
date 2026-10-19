import {
  CompletionContext,
  autocompletion,
  completionKeymap,
  pickedCompletion,
  type Completion,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState, Prec, Text, Transaction, type Extension } from '@codemirror/state';
import { keymap, type KeyBinding } from '@codemirror/view';

export type SlashCommandId =
  | 'task'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'bulletList'
  | 'numberedList'
  | 'quote'
  | 'codeFence'
  | 'table'
  | 'divider'
  | 'link'
  | 'image'
  | 'wikiEmbed'
  | 'wikiLink'
  | 'callout'
  | 'highlight'
  | 'comment'
  | 'footnote'
  | 'inlineMath'
  | 'displayMath'
  | 'tag'
  | 'blockId';

export interface SlashCommandLabel {
  label: string;
  description: string;
}

export type SlashCommandLabels = Partial<Record<SlashCommandId, SlashCommandLabel>>;

interface CommandDefinition {
  id: SlashCommandId;
  label: string;
  description: string;
  aliases: readonly string[];
  icon: string;
  insertion: string;
  selection: { from: number; to: number };
  block: boolean;
}

const definitions: readonly CommandDefinition[] = [
  { id: 'task', label: 'Task', description: 'Create an unchecked task', aliases: ['todo', 'to-do', 'checkbox'], icon: '○', insertion: '- [ ] ', selection: { from: 6, to: 6 }, block: true },
  { id: 'heading1', label: 'Heading 1', description: 'Insert a level 1 heading', aliases: ['h1', 'heading', 'title'], icon: 'H1', insertion: '# ', selection: { from: 2, to: 2 }, block: true },
  { id: 'heading2', label: 'Heading 2', description: 'Insert a level 2 heading', aliases: ['h2', 'heading'], icon: 'H2', insertion: '## ', selection: { from: 3, to: 3 }, block: true },
  { id: 'heading3', label: 'Heading 3', description: 'Insert a level 3 heading', aliases: ['h3', 'heading'], icon: 'H3', insertion: '### ', selection: { from: 4, to: 4 }, block: true },
  { id: 'bulletList', label: 'Bullet list', description: 'Start a bullet list item', aliases: ['bullet', 'unordered list', 'ul', 'list'], icon: '•', insertion: '- ', selection: { from: 2, to: 2 }, block: true },
  { id: 'numberedList', label: 'Numbered list', description: 'Start a numbered list item', aliases: ['numbered', 'ordered list', 'ol'], icon: '1.', insertion: '1. ', selection: { from: 3, to: 3 }, block: true },
  { id: 'quote', label: 'Quote', description: 'Start a block quote', aliases: ['blockquote'], icon: '❞', insertion: '> ', selection: { from: 2, to: 2 }, block: true },
  { id: 'codeFence', label: 'Code block', description: 'Insert an editable code fence', aliases: ['code', 'fenced code', 'fence'], icon: '</>', insertion: '```\n\n```', selection: { from: 4, to: 4 }, block: true },
  { id: 'table', label: 'Table', description: 'Insert a two-column table', aliases: ['gfm table'], icon: '▦', insertion: '| Header 1 | Header 2 |\n| --- | --- |\n|  |  |', selection: { from: 2, to: 10 }, block: true },
  { id: 'divider', label: 'Divider', description: 'Insert a horizontal rule', aliases: ['horizontal rule', 'hr', 'thematic break'], icon: '—', insertion: '***\n', selection: { from: 4, to: 4 }, block: true },
  { id: 'link', label: 'Link', description: 'Insert a Markdown link', aliases: ['markdown link', 'hyperlink'], icon: '↗', insertion: '[link text](url)', selection: { from: 1, to: 10 }, block: false },
  { id: 'image', label: 'Image', description: 'Insert a Markdown image', aliases: ['markdown image'], icon: '▧', insertion: '![alt text](path/to/image)', selection: { from: 2, to: 10 }, block: false },
  { id: 'wikiEmbed', label: 'Wiki embed', description: 'Embed a vault note or asset', aliases: ['embed', 'wiki image', 'transclusion'], icon: '⊞', insertion: '![[Note]]', selection: { from: 3, to: 7 }, block: false },
  { id: 'wikiLink', label: 'Wiki link', description: 'Link to a vault note', aliases: ['wikilink', 'internal link', 'note link'], icon: '↔', insertion: '[[Note|Label]]', selection: { from: 2, to: 6 }, block: false },
  { id: 'callout', label: 'Callout', description: 'Insert a note callout', aliases: ['admonition', 'call-out'], icon: '!', insertion: '> [!note]\n> ', selection: { from: 12, to: 12 }, block: true },
  { id: 'highlight', label: 'Highlight', description: 'Mark highlighted text', aliases: ['mark', 'marked text'], icon: '▧', insertion: '==text==', selection: { from: 2, to: 6 }, block: false },
  { id: 'comment', label: 'Comment', description: 'Insert a hidden Markdown comment', aliases: ['hidden comment', 'markdown comment'], icon: '%', insertion: '%%comment%%', selection: { from: 2, to: 9 }, block: false },
  { id: 'footnote', label: 'Footnote', description: 'Insert a footnote reference and definition', aliases: ['foot note', 'reference note'], icon: '¹', insertion: '', selection: { from: 0, to: 0 }, block: true },
  { id: 'inlineMath', label: 'Inline math', description: 'Insert inline math', aliases: ['math', 'latex'], icon: '∑', insertion: '$x$', selection: { from: 1, to: 2 }, block: false },
  { id: 'displayMath', label: 'Display math', description: 'Insert a display math block', aliases: ['block math', 'math block'], icon: '∫', insertion: '$$\n\n$$', selection: { from: 3, to: 3 }, block: true },
  { id: 'tag', label: 'Tag', description: 'Insert a searchable tag', aliases: ['hashtag'], icon: '#', insertion: '#tag', selection: { from: 1, to: 4 }, block: false },
  { id: 'blockId', label: 'Block ID', description: 'Insert a unique block target', aliases: ['block id', 'anchor'], icon: '¶', insertion: '', selection: { from: 0, to: 0 }, block: true },
];

const protectedNodes = new Set([
  'GardenEnvelope', 'FencedCode', 'CodeBlock', 'CodeSpan', 'CodeMark', 'CodeText',
  'Table', 'HTMLBlock', 'HTMLTag', 'HTMLText', 'HTMLComment', 'InlineHTML',
  'ListItem', 'Blockquote',
  'GardenMathInline', 'GardenMathBlock', 'GardenComment', 'GardenFootnoteDefinition',
  'GardenWikiLink', 'GardenWikiEmbed', 'GardenBlockId', 'GardenTag', 'GardenCallout',
]);

interface SlashCompletion extends Completion {
  commandId: SlashCommandId;
}

interface Replacement {
  text: string;
  selection: { from: number; to: number };
}

function replacementFor(state: EditorState, commandId: SlashCommandId, from: number): Replacement {
  const definition = definitions.find((candidate) => candidate.id === commandId)!;
  const line = state.doc.lineAt(from);
  const previousLine = line.number > 1 ? state.doc.line(line.number - 1) : null;
  const separator = definition.block && previousLine?.text.trim() ? '\n' : '';
  let insertion = definition.insertion;
  let selection = definition.selection;
  if (commandId === 'footnote') {
    const id = nextUnusedId(state.doc.toString(), /\[\^([1-9]\d*)\]/g);
    insertion = `[^${id}]\n\n[^${id}]: \n`;
    const cursor = insertion.indexOf(': ') + 2;
    selection = { from: cursor, to: cursor };
  } else if (commandId === 'blockId') {
    const id = nextUnusedId(state.doc.toString(), /\^block-([1-9]\d*)\b/g);
    insertion = `^block-${id}`;
    selection = { from: 1, to: insertion.length };
  }
  return {
    text: separator + insertion,
    selection: {
      from: separator.length + selection.from,
      to: separator.length + selection.to,
    },
  };
}

function nextUnusedId(source: string, pattern: RegExp): number {
  const used = new Set([...source.matchAll(pattern)].map((match) => Number(match[1])));
  let candidate = 1;
  while (used.has(candidate)) candidate++;
  return candidate;
}

/** Build the one source transaction used when a slash command is picked. */
export function slashCommandTransaction(
  state: EditorState,
  commandId: SlashCommandId,
  from: number,
  to: number,
  completion?: Completion,
): Transaction {
  const replacement = replacementFor(state, commandId, from);
  return state.update({
    changes: { from, to, insert: Text.of(replacement.text.split('\n')) },
    selection: EditorSelection.range(from + replacement.selection.from, from + replacement.selection.to),
    annotations: completion
      ? [pickedCompletion.of(completion), Transaction.userEvent.of('input.complete')]
      : Transaction.userEvent.of('input.complete'),
    scrollIntoView: true,
  });
}

function normalized(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function labelsFor(labels?: SlashCommandLabels): Map<SlashCommandId, SlashCommandLabel> {
  return new Map(definitions.map((definition) => {
    const supplied = labels?.[definition.id];
    return [definition.id, {
      label: supplied?.label?.trim() || definition.label,
      description: supplied?.description?.trim() || definition.description,
    }];
  }));
}

function protectedContext(state: EditorState, position: number): boolean {
  const tree = ensureSyntaxTree(state, position, 50);
  if (!tree) return true;
  let node: ReturnType<typeof syntaxTree>['topNode'] | null = tree.resolve(position, -1);
  let hasParagraph = false;
  while (node) {
    if (protectedNodes.has(node.name) || node.name.startsWith('HTML') ||
        node.name.startsWith('ATXHeading') || node.name.startsWith('SetextHeading')) return true;
    if (node.name === 'Paragraph') hasParagraph = true;
    node = node.parent;
  }
  return !hasParagraph;
}

function slashRange(context: CompletionContext): { from: number; to: number; query: string } | null {
  const { state, pos } = context;
  if (context.view?.composing || context.view?.compositionStarted) return null;
  if (state.facet(EditorState.readOnly) || state.selection.ranges.length !== 1 || !state.selection.main.empty) return null;
  if (state.selection.main.head !== pos) return null;
  const line = state.doc.lineAt(pos);
  if (pos !== line.to) return null;
  const match = /^([ ]{0,3})\/([\p{L}\p{M}\p{N} -]*)$/u.exec(line.text);
  if (!match) return null;
  const slash = line.from + match[1].length;
  if (protectedContext(state, pos)) return null;
  return { from: slash, to: pos, query: match[2] };
}

function commandMatchesQuery(definition: CommandDefinition, label: SlashCommandLabel, query: string): boolean {
  const normalizedQuery = normalized(query);
  return [definition.label, definition.description, label.label, label.description, ...definition.aliases]
    .some((candidate) => normalized(candidate).includes(normalizedQuery));
}

function resultFor(context: CompletionContext, labels: Map<SlashCommandId, SlashCommandLabel>): CompletionResult | null {
  const range = slashRange(context);
  if (!range) return null;
  const options: SlashCompletion[] = [];
  for (const definition of definitions) {
    const localized = labels.get(definition.id)!;
    if (!commandMatchesQuery(definition, localized, range.query)) continue;
    options.push({
      commandId: definition.id,
      label: localized.label,
      detail: localized.description,
      type: definition.id,
      apply: (view, completion, from, to) => {
        if (view.composing || view.compositionStarted || view.state.facet(EditorState.readOnly) ||
            view.state.selection.ranges.length !== 1 ||
            !view.state.selection.main.empty || view.state.selection.main.head !== to) return;
        const currentRange = slashRange(new CompletionContext(view.state, view.state.selection.main.head, false, view));
        if (!currentRange || currentRange.from !== from || currentRange.to !== to ||
            !commandMatchesQuery(definition, localized, currentRange.query)) return;
        const transaction = slashCommandTransaction(view.state, definition.id, from, to, completion);
        view.dispatch(transaction);
      },
    });
  }
  if (!options.length) return null;

  return {
    from: range.from,
    to: range.to,
    options,
    filter: false,
    update(_current, _from, _to, nextContext) {
      return resultFor(nextContext, labels);
    },
  };
}

/** Create the slash-command completion source, useful to compose or test directly. */
export function slashCommandSource(labels?: SlashCommandLabels): CompletionSource {
  const resolvedLabels = labelsFor(labels);
  return (context) => resultFor(context, resolvedLabels);
}

const safeCompletionKeymap: readonly KeyBinding[] = completionKeymap.map((binding) => {
  if (binding.key !== 'Enter' || !binding.run) return binding;
  const accept = binding.run;
  return { ...binding, run: (view) => view.composing || view.compositionStarted ? false : accept(view) };
});

/**
 * Activate Logseq-style Markdown commands after a slash on an otherwise empty
 * paragraph line. A picked option replaces that line's slash query in one
 * undoable source transaction.
 */
export function slashCommands(labels?: SlashCommandLabels): Extension {
  return [
    autocompletion({
      activateOnTyping: true,
      defaultKeymap: false,
      override: [slashCommandSource(labels)],
      tooltipClass: () => 'garden-slash-menu',
      icons: false,
      addToOptions: [{
        position: 20,
        render(completion) {
          const commandId = (completion as SlashCompletion).commandId;
          const icon = definitions.find((definition) => definition.id === commandId)?.icon ?? '·';
          const element = document.createElement('span');
          element.className = 'garden-slash-icon';
          element.setAttribute('aria-hidden', 'true');
          element.textContent = icon;
          return element;
        },
      }],
    }),
    Prec.highest(keymap.of(safeCompletionKeymap)),
  ];
}
