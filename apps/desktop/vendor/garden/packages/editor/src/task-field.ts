import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { parseTaskMetadata, type TaskMetadataField } from '@garden/markdown';
import { EditorSelection, EditorState, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view';
import type { ViewUpdate } from '@codemirror/view';
import { taskLineAt } from './task-editing.js';

export interface TaskLabels {
  /** Localized checkbox state word used only in its accessible name. */
  todo: string;
  /** Localized checkbox state word used only in its accessible name. */
  done: string;
  /** Localized action name used in its accessible name. */
  toggle: string;
}

class TaskStatusWidget extends WidgetType {
  constructor(private readonly label: string, private readonly checked: boolean) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof TaskStatusWidget && other.label === this.label && other.checked === this.checked;
  }

  toDOM(view: EditorView): HTMLElement {
    const status = view.dom.ownerDocument.createElement('span');
    status.className = 'garden-task-status';
    status.dataset.status = this.checked ? 'done' : 'todo';
    status.textContent = this.label;
    status.setAttribute('aria-hidden', 'true');
    status.setAttribute('contenteditable', 'false');
    return status;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class TaskMetadataWidget extends WidgetType {
  constructor(private readonly field: TaskMetadataField, private readonly sourceFrom: number) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof TaskMetadataWidget && other.field.key === this.field.key &&
      other.field.value === this.field.value && other.sourceFrom === this.sourceFrom;
  }

  toDOM(view: EditorView): HTMLElement {
    const chip = view.dom.ownerDocument.createElement('span');
    chip.className = 'garden-task-metadata';
    chip.dataset.field = this.field.key;
    chip.textContent = `${this.field.key} ${this.field.value ?? this.field.rawValue}`;
    chip.setAttribute('role', 'button');
    chip.setAttribute('aria-label', `${this.field.key} ${this.field.value ?? this.field.rawValue}`);
    chip.tabIndex = 0;
    chip.setAttribute('contenteditable', 'false');
    const revealSource = () => {
      const valuePosition = this.sourceFrom + this.field.valueRange.from - this.field.range.from;
      view.dispatch({ selection: EditorSelection.cursor(valuePosition) });
      view.focus();
    };
    chip.addEventListener('mousedown', (event) => event.preventDefault());
    chip.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      revealSource();
    });
    chip.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      revealSource();
    });
    return chip;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function activeLines(view: EditorView): Set<number> {
  const lines = new Set<number>();
  if (!view.hasFocus || view.state.facet(EditorState.readOnly)) return lines;
  for (const range of view.state.selection.ranges) {
    const firstLine = view.state.doc.lineAt(range.from).number;
    const lastLine = view.state.doc.lineAt(range.to).number;
    for (let line = firstLine; line <= lastLine; line += 1) lines.add(line);
  }
  return lines;
}

function taskDecorations(view: EditorView, labels?: TaskLabels): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const seen = new Set<number>();
  const tree = ensureSyntaxTree(view.state, view.state.doc.length, 200) ?? syntaxTree(view.state);
  const active = activeLines(view);
  tree.iterate({ enter(cursor) {
    if (cursor.name !== 'TaskMarker' || seen.has(cursor.from)) return;
    seen.add(cursor.from);
    const task = taskLineAt(view.state, cursor.from);
    if (!task) return;
    const line = view.state.doc.lineAt(task.lineFrom);
    if (!active.has(line.number)) {
      const label = task.checked ? 'DONE' : 'TODO';
      const hasTrailingSpace = task.taskMarkerTo < view.state.doc.length &&
        view.state.doc.sliceString(task.taskMarkerTo, task.taskMarkerTo + 1) === ' ';
      const afterCheckbox = task.taskMarkerTo + Number(hasTrailingSpace);
      decorations.push(Decoration.widget({
        widget: new TaskStatusWidget(label, task.checked),
        side: 1,
      }).range(afterCheckbox));

      const parsed = parseTaskMetadata(line.text);
      const duplicated = new Set(parsed.issues.filter((issue) => issue.code === 'duplicate-field').map((issue) => issue.key));
      for (const field of parsed.fields) {
        if (!field.valid || duplicated.has(field.key)) continue;
        const sourceFrom = line.from + field.range.from;
        decorations.push(Decoration.replace({ widget: new TaskMetadataWidget(field, sourceFrom) })
          .range(sourceFrom, line.from + field.range.to));
      }
    }
  } });
  return Decoration.set(decorations, true);
}

function accessibleTaskName(view: EditorView, position: number, labels?: TaskLabels): string {
  const task = taskLineAt(view.state, position);
  if (!task) return '';
  const status = task.checked ? labels?.done : labels?.todo;
  const source = view.state.doc.sliceString(task.contentFrom, task.lineTo);
  const parsed = parseTaskMetadata(source);
  const duplicated = new Set(parsed.issues.filter((issue) => issue.code === 'duplicate-field').map((issue) => issue.key));
  const presentable = parsed.fields.filter((field) => field.valid && !duplicated.has(field.key));
  let text = source;
  for (const field of [...presentable].reverse()) {
    text = text.slice(0, field.range.from) + ' ' + text.slice(field.range.to);
  }
  const metadata = presentable.map((field) => `${field.key} ${field.value ?? field.rawValue}`);
  return [status, text, ...metadata, labels?.toggle].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

class TaskFieldView {
  decorations: DecorationSet;

  constructor(view: EditorView, private readonly labels?: TaskLabels) {
    this.decorations = taskDecorations(view, labels);
    view.requestMeasure({ read: () => undefined, write: () => this.updateCheckboxLabels(view) });
  }

  update(update: ViewUpdate): void {
    const treeChanged = syntaxTree(update.startState) !== syntaxTree(update.state);
    const readOnlyChanged = update.startState.facet(EditorState.readOnly) !== update.state.facet(EditorState.readOnly);
    if (update.docChanged || update.selectionSet || update.focusChanged || readOnlyChanged || treeChanged) {
      this.decorations = taskDecorations(update.view, this.labels);
    }
    if (update.docChanged || update.selectionSet || update.focusChanged || readOnlyChanged || treeChanged) {
      update.view.requestMeasure({ read: () => undefined, write: () => this.updateCheckboxLabels(update.view) });
    }
  }

  docViewUpdate(view: EditorView): void {
    this.updateCheckboxLabels(view);
  }

  private updateCheckboxLabels(view: EditorView): void {
    for (const checkbox of view.dom.querySelectorAll<HTMLInputElement>('.cm-atomic-task-checkbox')) {
      const position = view.posAtDOM(checkbox);
      const label = position < 0 ? '' : accessibleTaskName(view, position, this.labels);
      if (label) {
        checkbox.setAttribute('aria-label', label);
        checkbox.title = label;
      } else {
        checkbox.removeAttribute('aria-label');
        checkbox.removeAttribute('title');
      }
    }
  }
}

/** Adds localized, non-interactive status text beside Atomic's native task checkbox. */
export function taskField(labels?: TaskLabels) {
  return ViewPlugin.define(
    (view) => new TaskFieldView(view, labels),
    { decorations: (field) => field.decorations },
  );
}
