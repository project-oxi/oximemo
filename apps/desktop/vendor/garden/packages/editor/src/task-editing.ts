import { EditorSelection, EditorState, type Transaction } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';

type SyntaxNode = ReturnType<typeof syntaxTree>['topNode'];

export interface TaskLine {
  lineFrom: number;
  lineTo: number;
  taskMarkerFrom: number;
  taskMarkerTo: number;
  contentFrom: number;
  marker: string;
  markerSpacing: string;
  taskSpacing: string;
  beforeMarker: string;
  quotePrefix: string;
  outdentPrefix: string;
  nested: boolean;
  contentIsEmpty: boolean;
  checked: boolean;
}

const protectedSyntax = new Set([
  'GardenEnvelope', 'FencedCode', 'CodeBlock', 'CodeSpan', 'CodeMark', 'CodeText',
  'Table', 'HTMLBlock', 'HTMLTag', 'HTMLText', 'HTMLComment', 'InlineHTML',
  'GardenMathBlock', 'GardenMathInline', 'GardenComment', 'GardenFootnoteDefinition',
]);

function isProtected(node: SyntaxNode | null): boolean {
  let parent = node;
  while (parent) {
    if (protectedSyntax.has(parent.name) || parent.name.startsWith('HTML') ||
        parent.name.startsWith('ATXHeading') || parent.name.startsWith('SetextHeading')) return true;
    parent = parent.parent;
  }
  return false;
}

function ancestor(node: SyntaxNode | null, name: string): SyntaxNode | null {
  let parent = node;
  while (parent) {
    if (parent.name === name) return parent;
    parent = parent.parent;
  }
  return null;
}

/**
 * Find the GFM task item at a source position. The syntax tree is the gate:
 * marker-shaped text in fenced code, frontmatter, or ordinary prose is ignored.
 */
export function taskLineAt(state: EditorState, position: number): TaskLine | null {
  const line = state.doc.lineAt(position);
  const tree = syntaxTree(state);
  const taskMarkers: SyntaxNode[] = [];

  tree.iterate({
    from: line.from,
    to: line.to,
    enter(cursor) {
      if (cursor.name === 'TaskMarker' && state.doc.lineAt(cursor.from).number === line.number) {
        taskMarkers.push(cursor.node);
        return false;
      }
    },
  });
  const taskMarker = taskMarkers[0];
  if (!taskMarker) return null;
  if (isProtected(taskMarker) || hasRawHtmlIn(state, line.from, line.to)) return null;

  let listItem: SyntaxNode | null = null;
  let parent: SyntaxNode | null = taskMarker;
  while (parent) {
    if (parent.name === 'ListItem' && !listItem) {
      listItem = parent;
    }
    parent = parent.parent;
  }
  if (!listItem) return null;

  const listMarks: SyntaxNode[] = [];
  const quoteMarkEnds: number[] = [];
  tree.iterate({
    from: line.from,
    to: line.to,
    enter(cursor) {
      if (cursor.name === 'ListMark' && cursor.node.parent?.name === 'ListItem' &&
          cursor.node.parent.from === listItem!.from && cursor.node.parent.to === listItem!.to) listMarks.push(cursor.node);
      if (cursor.name === 'QuoteMark' && cursor.from < taskMarker.from) quoteMarkEnds.push(cursor.to);
    },
  });
  const listMark = listMarks[0];
  if (!listMark) return null;

  const beforeMarker = state.doc.sliceString(line.from, listMark.from);
  const marker = state.doc.sliceString(listMark.from, listMark.to);
  const markerSpacing = state.doc.sliceString(listMark.to, taskMarker.from);
  if (!marker || !/^[\t ]+$/.test(markerSpacing)) return null;

  let contentFrom = taskMarker.to;
  while (contentFrom < line.to && /[\t ]/.test(state.doc.sliceString(contentFrom, contentFrom + 1))) contentFrom++;
  const taskSpacing = state.doc.sliceString(taskMarker.to, contentFrom);
  const content = state.doc.sliceString(contentFrom, line.to);

  let quotePrefix = '';
  const quoteMarkEnd = quoteMarkEnds.at(-1) ?? -1;
  if (quoteMarkEnd >= line.from) {
    let prefixEnd = quoteMarkEnd;
    if (prefixEnd < line.to && /[\t ]/.test(state.doc.sliceString(prefixEnd, prefixEnd + 1))) prefixEnd++;
    quotePrefix = state.doc.sliceString(line.from, prefixEnd);
  }

  const parentListItem = listItem.parent?.parent?.name === 'ListItem' ? listItem.parent.parent : null;
  let outdentPrefix = '';
  if (parentListItem) {
    const parentLine = state.doc.lineAt(parentListItem.from);
    const parentListMarks: SyntaxNode[] = [];
    tree.iterate({
      from: parentLine.from,
      to: parentLine.to,
      enter(cursor) {
        if (cursor.name === 'ListMark' && cursor.node.parent?.name === 'ListItem' &&
            cursor.node.parent.from === parentListItem.from && cursor.node.parent.to === parentListItem.to) {
          parentListMarks.push(cursor.node);
        }
      },
    });
    const parentListMark = parentListMarks[0];
    if (parentListMark) outdentPrefix = state.doc.sliceString(parentLine.from, parentListMark.from);
  }
  const nested = parentListItem !== null;
  return {
    lineFrom: line.from,
    lineTo: line.to,
    taskMarkerFrom: taskMarker.from,
    taskMarkerTo: taskMarker.to,
    contentFrom,
    marker,
    markerSpacing,
    taskSpacing,
    beforeMarker,
    quotePrefix,
    outdentPrefix,
    nested,
    contentIsEmpty: !content.trim(),
    checked: /\[x\]/i.test(state.doc.sliceString(taskMarker.from, taskMarker.to)),
  };
}

function hasRawHtmlIn(state: EditorState, from: number, to: number): boolean {
  let found = false;
  syntaxTree(state).iterate({ from, to, enter(cursor) {
    if (cursor.name.startsWith('HTML') || cursor.name === 'InlineHTML') {
      found = true;
      return false;
    }
  } });
  return found;
}

function listItemAt(state: EditorState, position: number): { lineFrom: number; from: number; to: number; contentFrom: number } | null {
  const line = state.doc.lineAt(position);
  if (hasRawHtmlIn(state, line.from, line.to)) return null;
  const tree = syntaxTree(state);
  const marks: SyntaxNode[] = [];
  tree.iterate({ from: line.from, to: line.to, enter(cursor) {
    if (cursor.name === 'ListMark' && cursor.node.parent?.name === 'ListItem') marks.push(cursor.node);
  } });
  const mark = marks.find((node) => !isProtected(node));
  if (!mark) return null;
  const item = ancestor(mark, 'ListItem');
  if (!item || state.doc.lineAt(item.from).number !== line.number) return null;
  let contentFrom = mark.to;
  while (contentFrom < line.to && /[\t ]/.test(state.doc.sliceString(contentFrom, contentFrom + 1))) contentFrom++;
  return { lineFrom: line.from, from: mark.from, to: mark.to, contentFrom };
}

function paragraphAt(state: EditorState, position: number): { from: number; to: number } | null {
  const tree = syntaxTree(state);
  const resolved = tree.resolve(position, -1);
  if (isProtected(resolved) || ancestor(resolved, 'ListItem')) return null;
  const paragraph = ancestor(resolved, 'Paragraph');
  if (!paragraph || hasRawHtmlIn(state, paragraph.from, paragraph.to)) return null;
  return { from: paragraph.from, to: paragraph.to };
}

function paragraphPrefixTo(state: EditorState, lineFrom: number, lineTo: number): number {
  const tree = syntaxTree(state);
  const quoteMarks: SyntaxNode[] = [];
  tree.iterate({ from: lineFrom, to: lineTo, enter(cursor) {
    if (cursor.name === 'QuoteMark') quoteMarks.push(cursor.node);
  } });
  let prefixTo = quoteMarks.at(-1)?.to ?? lineFrom;
  if (quoteMarks.length) {
    while (prefixTo < lineTo && /[\t ]/.test(state.doc.sliceString(prefixTo, prefixTo + 1))) prefixTo++;
  } else {
    while (prefixTo < lineTo && /[\t ]/.test(state.doc.sliceString(prefixTo, prefixTo + 1))) prefixTo++;
  }
  return prefixTo;
}

/** Toggle a parsed task or turn the current paragraph/list item into a task. */
export function toggleOrCreateTask(state: EditorState): Transaction | null {
  if (state.facet(EditorState.readOnly)) return null;
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  const editKeys = new Set<string>();

  for (const range of state.selection.ranges) {
    if (!range.empty || isProtected(syntaxTree(state).resolve(range.head, -1))) return null;
    const task = taskLineAt(state, range.head);
    let change: { from: number; to: number; insert: string } | null = null;
    if (task) {
      change = {
        from: task.taskMarkerFrom,
        to: task.taskMarkerTo,
        insert: task.checked ? '[ ]' : '[x]',
      };
    } else {
      const listItem = listItemAt(state, range.head);
      if (listItem) {
        const spacing = state.doc.sliceString(listItem.to, listItem.contentFrom);
        change = {
          from: listItem.to,
          to: listItem.contentFrom,
          insert: `${spacing || ' '}[ ] `,
        };
      } else {
        const paragraph = paragraphAt(state, range.head);
        if (paragraph) {
          const firstLine = state.doc.lineAt(paragraph.from);
          const prefixTo = paragraphPrefixTo(state, firstLine.from, firstLine.to);
          change = {
            from: firstLine.from,
            to: prefixTo,
            insert: `${state.doc.sliceString(firstLine.from, prefixTo)}- [ ] `,
          };
        }
      }
    }
    if (!change) return null;
    const key = `${change.from}:${change.to}`;
    if (editKeys.has(key)) return null;
    editKeys.add(key);
    changes.push(change);
  }

  if (!changes.length) return null;
  return state.update({ changes }, { userEvent: 'input' });
}

function uncheckedMarker(marker: string): string {
  const ordered = /^(\d+)([.)])$/.exec(marker);
  if (!ordered) return marker;
  const number = Number(ordered[1]);
  return `${Number.isSafeInteger(number) && number < 999_999_999 ? number + 1 : number}${ordered[2]}`;
}

function continuationPrefix(task: TaskLine, includeTaskSpacing: boolean): string {
  return `${task.beforeMarker}${uncheckedMarker(task.marker)}${task.markerSpacing}[ ]${includeTaskSpacing ? task.taskSpacing || ' ' : ''}`;
}

function outdentedPrefix(task: TaskLine): string {
  return `${task.outdentPrefix}${task.marker}${task.markerSpacing}[ ] `;
}

/** Build an undoable Enter transaction for task items, or return null to delegate. */
export function continueTaskOnEnter(state: EditorState): Transaction | null {
  if (state.facet(EditorState.readOnly)) return null;
  const tasks = state.selection.ranges.map((range) => {
    const task = range.empty ? taskLineAt(state, range.head) : null;
    return task && (task.contentIsEmpty ? range.head >= task.taskMarkerTo : range.head >= task.contentFrom) ? task : null;
  });
  if (tasks.some((task) => task === null)) return null;

  const edits = new Set<string>();
  const changes = state.changeByRange((range) => {
    const task = taskLineAt(state, range.head)!;
    if (task.contentIsEmpty) {
      const replacement = task.nested ? outdentedPrefix(task) : task.quotePrefix;
      const key = `${task.lineFrom}:${task.lineTo}`;
      if (edits.has(key)) return { range };
      edits.add(key);
      return {
        range: EditorSelection.cursor(task.lineFrom + replacement.length),
        changes: { from: task.lineFrom, to: task.lineTo, insert: replacement },
      };
    }

    const nextSourceCharacter = state.doc.sliceString(range.head, range.head + 1);
    const prefix = continuationPrefix(task, !/[\t ]/.test(nextSourceCharacter));
    const insert = `${state.lineBreak}${prefix}`;
    let separatorLength = 0;
    while (/[\t ]/.test(state.doc.sliceString(range.head + separatorLength, range.head + separatorLength + 1))) {
      separatorLength++;
    }
    const key = `${range.head}:${range.head}`;
    if (edits.has(key)) return { range };
    edits.add(key);
    return {
      range: EditorSelection.cursor(range.head + 1 + prefix.length + separatorLength),
      changes: { from: range.head, insert },
    };
  });

  // Two cursors that request the same replacement cannot produce distinct, stable
  // positions after one line is removed. Let CodeMirror's normal behavior handle it.
  if (edits.size !== tasks.length) return null;
  return state.update(changes, { userEvent: 'input' });
}

/** Remove a task's complete Markdown prefix when Backspace is at content start. */
export function removeTaskPrefixOnBackspace(state: EditorState): Transaction | null {
  if (state.facet(EditorState.readOnly)) return null;
  const tasks = state.selection.ranges.map((range) => {
    const task = range.empty ? taskLineAt(state, range.head) : null;
    return task?.contentFrom === range.head ? task : null;
  });
  if (tasks.some((task) => task === null)) return null;

  const edits = new Set<string>();
  const changes = state.changeByRange((range) => {
    const task = taskLineAt(state, range.head)!;
    const key = `${task.lineFrom}:${task.contentFrom}`;
    if (edits.has(key)) return { range };
    edits.add(key);

    const content = state.doc.sliceString(task.contentFrom, task.lineTo);
    const preservedPrefix = content.trim()
      ? task.nested ? task.beforeMarker : task.quotePrefix
      : task.quotePrefix;
    return {
      range: EditorSelection.cursor(task.lineFrom + preservedPrefix.length),
      changes: { from: task.lineFrom, to: task.contentFrom, insert: preservedPrefix },
    };
  });

  if (edits.size !== tasks.length) return null;
  return state.update(changes, { userEvent: 'input' });
}
