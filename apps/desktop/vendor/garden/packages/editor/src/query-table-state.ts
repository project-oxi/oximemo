import type { QueryEvaluation } from '@garden/markdown';

type QueryRow = QueryEvaluation['views'][number]['rows'][number];

export type QueryTableFilterOperator =
  | 'contains'
  | 'equals'
  | 'notEquals'
  | 'isEmpty'
  | 'isNotEmpty'
  | 'greaterThan'
  | 'lessThan';

export interface QueryTableFilter {
  id: number;
  column: string;
  operator: QueryTableFilterOperator;
  value: string;
}

export interface QueryTableSort {
  column: string;
  direction: 'ascending' | 'descending';
}

export interface QueryTableState {
  search: string;
  filters: QueryTableFilter[];
  sort: QueryTableSort | null;
  hiddenColumns: string[];
}

export const EMPTY_QUERY_TABLE_STATE: QueryTableState = {
  search: '',
  filters: [],
  sort: null,
  hiddenColumns: [],
};

function valueText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(valueText).join(' ');
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value) ?? '';
    } catch {
      return '';
    }
  }
  return String(value);
}

function isEmpty(value: unknown): boolean {
  return value === null
    || value === undefined
    || (typeof value === 'string' && value.trim() === '')
    || (Array.isArray(value) && value.length === 0);
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function matchesFilter(value: unknown, filter: QueryTableFilter): boolean {
  const expected = filter.value.trim();
  const actual = valueText(value);
  const normalizedExpected = expected.toLocaleLowerCase();
  const normalizedActual = actual.toLocaleLowerCase();
  const candidates = Array.isArray(value) ? value : [value];

  switch (filter.operator) {
    case 'contains':
      return candidates.some((candidate) => valueText(candidate).toLocaleLowerCase().includes(normalizedExpected));
    case 'equals':
      return candidates.some((candidate) => valueText(candidate).toLocaleLowerCase() === normalizedExpected);
    case 'notEquals':
      return candidates.every((candidate) => valueText(candidate).toLocaleLowerCase() !== normalizedExpected);
    case 'isEmpty':
      return isEmpty(value);
    case 'isNotEmpty':
      return !isEmpty(value);
    case 'greaterThan': {
      const actualNumber = numberValue(value);
      const expectedNumber = numberValue(expected);
      return actualNumber !== null && expectedNumber !== null && actualNumber > expectedNumber;
    }
    case 'lessThan': {
      const actualNumber = numberValue(value);
      const expectedNumber = numberValue(expected);
      return actualNumber !== null && expectedNumber !== null && actualNumber < expectedNumber;
    }
    default:
      return normalizedActual.includes(normalizedExpected);
  }
}

function compareValues(left: unknown, right: unknown): number {
  const leftEmpty = isEmpty(left);
  const rightEmpty = isEmpty(right);
  if (leftEmpty || rightEmpty) {
    if (leftEmpty === rightEmpty) return 0;
    return leftEmpty ? 1 : -1;
  }

  const leftNumber = numberValue(left);
  const rightNumber = numberValue(right);
  if (leftNumber !== null && rightNumber !== null) return leftNumber - rightNumber;

  return valueText(left).localeCompare(valueText(right), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

/** Applies transient table controls without changing the evaluated query or its source. */
export function applyQueryTableState(
  rows: readonly QueryRow[],
  columns: readonly string[],
  state: QueryTableState,
): QueryRow[] {
  const search = state.search.trim().toLocaleLowerCase();
  let result = rows.filter((row) => {
    if (search) {
      const searchable = [row.title, row.path, ...columns.map((column) => valueText(row.values[column]))]
        .join(' ')
        .toLocaleLowerCase();
      if (!searchable.includes(search)) return false;
    }
    return state.filters.every((filter) => matchesFilter(row.values[filter.column], filter));
  });

  if (state.sort) {
    const { column, direction } = state.sort;
    const sign = direction === 'ascending' ? 1 : -1;
    result = result
      .map((row, index) => ({ row, index }))
      .sort((left, right) => {
        const leftValue = left.row.values[column];
        const rightValue = right.row.values[column];
        const comparison = compareValues(leftValue, rightValue);
        // Keep blank values last in either direction.
        if (isEmpty(leftValue) !== isEmpty(rightValue)) return isEmpty(leftValue) ? 1 : -1;
        return comparison * sign || left.index - right.index;
      })
      .map(({ row }) => row);
  }

  return result;
}

/** Only offer numeric operators for columns whose populated values are all numeric. */
export function isNumericQueryColumn(rows: readonly QueryRow[], column: string): boolean {
  const values = rows.map((row) => row.values[column]).filter((value) => !isEmpty(value));
  return values.length > 0 && values.every((value) => numberValue(value) !== null);
}
