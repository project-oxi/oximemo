import { expect, test } from 'bun:test';
import type { QueryEvaluation } from '@garden/markdown';
import { applyQueryTableState, EMPTY_QUERY_TABLE_STATE, isNumericQueryColumn } from '../src/query-table-state.js';

type QueryRow = QueryEvaluation['views'][number]['rows'][number];

const rows: QueryRow[] = [
  { id: '1', path: 'notes/plan.md', title: 'Launch plan', values: { status: 'ready', priority: 10, tags: ['design', 'garden'] } },
  { id: '2', path: 'notes/draft.md', title: 'Draft notes', values: { status: 'draft', priority: 2, tags: ['writing'] } },
  { id: '3', path: 'notes/empty.md', title: 'Untitled', values: { status: '', priority: null, tags: [] } },
  { id: '4', path: 'notes/follow-up.md', title: 'Follow up', values: { status: 'ready', priority: 3, tags: ['design'] } },
];

const columns = ['status', 'priority', 'tags'];

test('search covers titles, paths, and column values without changing source rows', () => {
  const result = applyQueryTableState(rows, columns, { ...EMPTY_QUERY_TABLE_STATE, search: 'DRAFT' });
  expect(result.map((row) => row.id)).toEqual(['2']);
  expect(rows.map((row) => row.id)).toEqual(['1', '2', '3', '4']);
});

test('column filters combine with AND and support tag equality or partial matching', () => {
  const result = applyQueryTableState(rows, columns, {
    ...EMPTY_QUERY_TABLE_STATE,
    filters: [
      { id: 1, column: 'status', operator: 'equals', value: 'READY' },
      { id: 2, column: 'tags', operator: 'contains', value: 'gard' },
    ],
  });
  expect(result.map((row) => row.id)).toEqual(['1']);

  const exactTag = applyQueryTableState(rows, columns, {
    ...EMPTY_QUERY_TABLE_STATE,
    filters: [{ id: 1, column: 'tags', operator: 'equals', value: 'design' }],
  });
  expect(exactTag.map((row) => row.id)).toEqual(['1', '4']);
});

test('empty and numeric operators handle blank cells and numeric strings', () => {
  const empty = applyQueryTableState(rows, columns, {
    ...EMPTY_QUERY_TABLE_STATE,
    filters: [{ id: 1, column: 'priority', operator: 'isEmpty', value: '' }],
  });
  expect(empty.map((row) => row.id)).toEqual(['3']);

  const lessThan = applyQueryTableState(rows, columns, {
    ...EMPTY_QUERY_TABLE_STATE,
    filters: [{ id: 1, column: 'priority', operator: 'lessThan', value: '4' }],
  });
  expect(lessThan.map((row) => row.id)).toEqual(['2', '4']);
  expect(isNumericQueryColumn(rows, 'priority')).toBe(true);
  expect(isNumericQueryColumn(rows, 'status')).toBe(false);
});

test('sorting uses numeric order, keeps empty values last both ways, and remains stable for ties', () => {
  const ascending = applyQueryTableState(rows, columns, {
    ...EMPTY_QUERY_TABLE_STATE,
    sort: { column: 'priority', direction: 'ascending' },
  });
  expect(ascending.map((row) => row.id)).toEqual(['2', '4', '1', '3']);

  const descending = applyQueryTableState(rows, columns, {
    ...EMPTY_QUERY_TABLE_STATE,
    sort: { column: 'priority', direction: 'descending' },
  });
  expect(descending.map((row) => row.id)).toEqual(['1', '4', '2', '3']);

  const tied = applyQueryTableState(rows, columns, {
    ...EMPTY_QUERY_TABLE_STATE,
    sort: { column: 'status', direction: 'ascending' },
  });
  expect(tied.map((row) => row.id)).toEqual(['2', '1', '4', '3']);
});
