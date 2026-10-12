import { useId, useMemo, useState, type ChangeEvent } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Columns3, Filter, RotateCcw, Search, X } from 'lucide-react';
import {
  Button,
  Checkbox,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SelectField,
} from '@garden/ui';
import {
  evaluateQuery,
  parseQuery,
  type MarkdownDiagnostic,
  type ParsedQuery,
  type QueryDocument,
  type QueryEvaluation,
} from '@garden/markdown';
import {
  applyQueryTableState,
  EMPTY_QUERY_TABLE_STATE,
  isNumericQueryColumn,
  type QueryTableFilterOperator,
  type QueryTableState,
} from './query-table-state.js';
import './query-view.css';

export interface GQueryTableStrings {
  search: string;
  searchPlaceholder: string;
  filter: string;
  filterColumn: string;
  filterOperator: string;
  filterValue: string;
  addFilter: string;
  clearFilters: string;
  columns: string;
  contains: string;
  equals: string;
  notEquals: string;
  isEmpty: string;
  isNotEmpty: string;
  greaterThan: string;
  lessThan: string;
  sortAscending: string;
  sortDescending: string;
  ascending: string;
  descending: string;
  fullResultSummaries: string;
  resetView: string;
  sort: string;
  sortColumn: string;
  sortDirection: string;
  applySort: string;
  visibleCount: (visible: number, total: number) => string;
  removeFilter: (column: string, value: string) => string;
}

export interface GQueryViewStrings {
  disabled: string;
  invalid: string;
  unexecuted: string;
  diagnostic: (diagnostic: MarkdownDiagnostic) => string;
  source: string;
  emptyResults: string;
  emptyValue: string;
  summaries: string;
  openDocumentColumn: string;
  openDocument: (documentTitle: string) => string;
  /** Optional so existing hosts can adopt the interactive table incrementally. */
  tableControls?: GQueryTableStrings;
}

export interface GQueryViewProps {
  /** The YAML body of a `.base` file or an inline `base` fence. */
  source: string;
  /** Documents already discovered by the host; the query view performs no I/O. */
  documents: QueryDocument[];
  /** True only when the host has explicitly enabled `pdc-query/1`. */
  enabled: boolean;
  /** All framework-owned labels are supplied by the host locale. */
  strings: GQueryViewStrings;
  /** Opens a result by its stable document id when provided. */
  onOpenDocument?: (documentId: string) => void;
}

type QueryViewResult = QueryEvaluation['views'][number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function propertyLabel(query: ParsedQuery, property: string): string {
  const properties = query.document?.properties;
  if (!isRecord(properties)) return property;
  const metadata = properties[property];
  if (!isRecord(metadata) || typeof metadata.displayName !== 'string') return property;
  return metadata.displayName;
}

function displayValue(value: unknown, emptyValue: string): string {
  if (value === null || value === undefined || value === '') return emptyValue;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value) ?? emptyValue;
  } catch {
    return emptyValue;
  }
}

function documentLabel(row: QueryViewResult['rows'][number]): string {
  return row.title || row.path || row.id;
}

function QueryFallback({
  source,
  message,
  diagnostic,
  strings,
}: {
  source: string;
  message: string;
  diagnostic?: MarkdownDiagnostic;
  strings: GQueryViewStrings;
}) {
  return (
    <div className="garden-query-view__fallback" role="status">
      <p className="garden-query-view__status">{message}</p>
      {diagnostic && (
        <p className="garden-query-view__diagnostic">
          <span className="garden-query-view__diagnostic-label">{strings.diagnostic(diagnostic)}</span>
        </p>
      )}
      <pre className="garden-query-view__source" aria-label={strings.source}>
        <code>{source}</code>
      </pre>
    </div>
  );
}

function QuerySummaries({
  view,
  query,
  strings,
  fullResults,
}: {
  view: QueryViewResult;
  query: ParsedQuery;
  strings: GQueryViewStrings;
  fullResults: boolean;
}) {
  const entries = Object.entries(view.summaries);
  if (!entries.length) return null;
  const heading = fullResults && strings.tableControls
    ? strings.tableControls.fullResultSummaries
    : strings.summaries;

  return (
    <section className="garden-query-view__summaries" aria-label={heading}>
      <h3 className="garden-query-view__summaries-title">{heading}</h3>
      <dl className="garden-query-view__summary-list">
        {entries.map(([property, value]) => (
          <div className="garden-query-view__summary" key={property}>
            <dt>{propertyLabel(query, property)}</dt>
            <dd>{displayValue(value, strings.emptyValue)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function DocumentAction({
  row,
  onOpenDocument,
  strings,
}: {
  row: QueryViewResult['rows'][number];
  onOpenDocument?: (documentId: string) => void;
  strings: GQueryViewStrings;
}) {
  if (!onOpenDocument) return null;
  const label = documentLabel(row);
  return (
    <button
      type="button"
      className="garden-query-view__document-action"
      aria-label={strings.openDocument(label)}
      onClick={() => onOpenDocument(row.id)}
    >
      {strings.openDocument(label)}
    </button>
  );
}

function TableView({
  view,
  query,
  strings,
  onOpenDocument,
  headingId,
}: {
  view: QueryViewResult;
  query: ParsedQuery;
  strings: GQueryViewStrings;
  onOpenDocument?: (documentId: string) => void;
  headingId: string;
}) {
  const controls = strings.tableControls;
  const [state, setState] = useState<QueryTableState>(EMPTY_QUERY_TABLE_STATE);
  const visibleColumns = view.columns.filter((column) => !state.hiddenColumns.includes(column));
  const rows = useMemo(
    () => applyQueryTableState(view.rows, view.columns, state),
    [view.rows, view.columns, state],
  );
  const isFiltered = Boolean(state.search.trim() || state.filters.length);
  const columnCount = Math.max(1, visibleColumns.length + Number(Boolean(onOpenDocument)));
  const reset = () => setState(EMPTY_QUERY_TABLE_STATE);

  return (
    <>
    <div className="garden-query-view__table-region">
      {controls && (
        <div className="garden-query-view__toolbar">
          <label className="garden-query-view__search">
            <Search aria-hidden="true" />
            <Input
              type="search"
              aria-label={controls.search}
              placeholder={controls.searchPlaceholder}
              value={state.search}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                const search = event.currentTarget.value;
                setState((previous) => ({ ...previous, search }));
              }}
            />
          </label>

          {view.columns.length > 0 && (
            <Popover>
              <PopoverTrigger asChild>
                <Button type="button" variant="outline" className="garden-query-view__tool-button">
                  <Filter aria-hidden="true" />
                  {controls.filter}
                  {state.filters.length > 0 && <span className="garden-query-view__tool-count">{state.filters.length}</span>}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="garden-query-view__popover">
                <FilterEditor
                  view={view}
                  query={query}
                  strings={controls}
                  onAdd={(column, operator, value) => setState((previous) => ({
                    ...previous,
                    filters: [...previous.filters, {
                      id: previous.filters.reduce((max, filter) => Math.max(max, filter.id), 0) + 1,
                      column,
                      operator,
                      value,
                    }],
                  }))}
                  onClear={() => setState((previous) => ({ ...previous, filters: [] }))}
                  filterCount={state.filters.length}
                />
              </PopoverContent>
            </Popover>
          )}

          {view.columns.length > 0 && (
            <Popover>
              <PopoverTrigger asChild>
                <Button type="button" variant="outline" className="garden-query-view__tool-button">
                  <ArrowUpDown aria-hidden="true" />
                  {controls.sort}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="garden-query-view__popover">
                <SortEditor
                  view={view}
                  query={query}
                  strings={controls}
                  sort={state.sort}
                  onApply={(column, direction) => setState((previous) => ({ ...previous, sort: { column, direction } }))}
                />
              </PopoverContent>
            </Popover>
          )}

          {view.columns.length > 0 && (
            <Popover>
              <PopoverTrigger asChild>
                <Button type="button" variant="outline" className="garden-query-view__tool-button">
                  <Columns3 aria-hidden="true" />
                  {controls.columns}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="garden-query-view__popover">
                <div className="garden-query-view__column-options" aria-label={controls.columns}>
                  {view.columns.map((column) => {
                    const visible = visibleColumns.includes(column);
                    return (
                      <label className="garden-query-view__column-option" key={column}>
                        <Checkbox
                          checked={visible}
                          disabled={visible && visibleColumns.length === 1}
                          aria-label={propertyLabel(query, column)}
                          onCheckedChange={(checked: boolean | 'indeterminate') => setState((previous) => ({
                            ...previous,
                            hiddenColumns: checked === true
                              ? previous.hiddenColumns.filter((hidden) => hidden !== column)
                              : [...previous.hiddenColumns, column],
                          }))}
                        />
                        <span>{propertyLabel(query, column)}</span>
                      </label>
                    );
                  })}
                </div>
              </PopoverContent>
            </Popover>
          )}

          <span className="garden-query-view__row-count" aria-live="polite">
            {controls.visibleCount(rows.length, view.rows.length)}
          </span>
          {(state.search || state.filters.length > 0 || state.sort || state.hiddenColumns.length > 0) && (
            <Button type="button" variant="ghost" className="garden-query-view__reset" onClick={reset}>
              <RotateCcw aria-hidden="true" />
              {controls.resetView}
            </Button>
          )}
        </div>
      )}

      {controls && state.filters.length > 0 && (
        <div className="garden-query-view__filter-chips" aria-label={controls.filter}>
          {state.filters.map((filter) => {
            const column = propertyLabel(query, filter.column);
            const value = filter.value || strings.emptyValue;
            return (
              <Button
                key={filter.id}
                type="button"
                variant="secondary"
                size="sm"
                className="garden-query-view__filter-chip"
                aria-label={controls.removeFilter(column, value)}
                onClick={() => setState((previous) => ({ ...previous, filters: previous.filters.filter((item) => item.id !== filter.id) }))}
              >
                <span>{column} {controls[filter.operator]} {value}</span>
                <X aria-hidden="true" />
              </Button>
            );
          })}
        </div>
      )}

      <div className="records-scroll garden-query-view__table-scroll" tabIndex={0} aria-labelledby={headingId}>
        <table className="records-table garden-query-view__table" aria-labelledby={headingId}>
          <thead>
            <tr>
              {visibleColumns.map((column) => {
                const label = propertyLabel(query, column);
                const direction = state.sort?.column === column ? state.sort.direction : null;
                const nextDirectionLabel = direction === 'ascending' ? controls?.sortDescending : controls?.sortAscending;
                return (
                  <th className="records-cell" scope="col" key={column} aria-sort={direction ?? 'none'}>
                    {controls ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="garden-query-view__sort-header"
                        aria-label={`${label}, ${nextDirectionLabel ?? controls.sortAscending}`}
                        onClick={() => setState((previous) => ({
                          ...previous,
                          sort: {
                            column,
                            direction: previous.sort?.column === column && previous.sort.direction === 'ascending' ? 'descending' : 'ascending',
                          },
                        }))}
                      >
                        <span>{label}</span>
                        {direction === 'ascending' ? <ArrowUp aria-hidden="true" /> : direction === 'descending' ? <ArrowDown aria-hidden="true" /> : <ArrowUpDown aria-hidden="true" />}
                      </Button>
                    ) : label}
                  </th>
                );
              })}
              {onOpenDocument && <th className="records-cell" scope="col">{strings.openDocumentColumn}</th>}
            </tr>
          </thead>
          <tbody>
            {rows.length ? rows.map((row) => (
              <tr className="records-row" key={row.id}>
                {visibleColumns.map((column) => (
                  <td className="records-cell" key={column}><QueryValue value={row.values[column]} emptyValue={strings.emptyValue} /></td>
                ))}
                {onOpenDocument && (
                  <td className="records-cell garden-query-view__action-cell">
                    <DocumentAction row={row} onOpenDocument={onOpenDocument} strings={strings} />
                  </td>
                )}
              </tr>
            )) : (
              <tr>
                <td className="records-cell garden-query-view__empty" colSpan={columnCount}>{strings.emptyResults}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
    <QuerySummaries
      view={view}
      query={query}
      strings={strings}
      fullResults={isFiltered}
    />
    </>
  );
}

function SortEditor({
  view,
  query,
  strings,
  sort,
  onApply,
}: {
  view: QueryViewResult;
  query: ParsedQuery;
  strings: GQueryTableStrings;
  sort: QueryTableState['sort'];
  onApply: (column: string, direction: 'ascending' | 'descending') => void;
}) {
  const [column, setColumn] = useState(sort?.column ?? view.columns[0] ?? '');
  const [direction, setDirection] = useState<'ascending' | 'descending'>(sort?.direction ?? 'ascending');

  return (
    <div className="garden-query-view__filter-editor">
      <div className="garden-query-view__popover-fields">
        <SelectField
          label={strings.sortColumn}
          value={column}
          onValueChange={(nextColumn: string) => setColumn(nextColumn)}
          options={view.columns.map((item) => ({ value: item, label: propertyLabel(query, item) }))}
        />
        <SelectField
          label={strings.sortDirection}
          value={direction}
          onValueChange={(nextDirection: string) => setDirection(nextDirection as 'ascending' | 'descending')}
          options={[
            { value: 'ascending', label: strings.ascending },
            { value: 'descending', label: strings.descending },
          ]}
        />
      </div>
      <div className="garden-query-view__filter-actions">
        <Button type="button" size="sm" disabled={!column} onClick={() => onApply(column, direction)}>{strings.applySort}</Button>
      </div>
    </div>
  );
}

function FilterEditor({
  view,
  query,
  strings,
  onAdd,
  onClear,
  filterCount,
}: {
  view: QueryViewResult;
  query: ParsedQuery;
  strings: GQueryTableStrings;
  onAdd: (column: string, operator: QueryTableFilterOperator, value: string) => void;
  onClear: () => void;
  filterCount: number;
}) {
  const [column, setColumn] = useState(view.columns[0] ?? '');
  const [operator, setOperator] = useState<QueryTableFilterOperator>('contains');
  const [value, setValue] = useState('');
  const suggestionsId = useId();
  const numeric = isNumericQueryColumn(view.rows, column);
  const operators: QueryTableFilterOperator[] = [
    'contains', 'equals', 'notEquals', 'isEmpty', 'isNotEmpty',
    ...(numeric ? ['greaterThan' as const, 'lessThan' as const] : []),
  ];
  const needsValue = operator !== 'isEmpty' && operator !== 'isNotEmpty';
  const suggestions = [...new Set(view.rows.flatMap((row) => {
    const raw = row.values[column];
    const candidates = Array.isArray(raw) ? raw : [raw];
    return candidates
      .filter((item) => item !== null && item !== undefined && String(item).trim() !== '')
      .map((item) => displayValue(item, strings.filterValue));
  }))].slice(0, 30);

  return (
    <div className="garden-query-view__filter-editor">
      <div className="garden-query-view__popover-fields">
        <SelectField
          label={strings.filterColumn}
          value={column}
          onValueChange={(nextColumn: string) => {
            setColumn(nextColumn);
            setOperator('contains');
            setValue('');
          }}
          options={view.columns.map((item) => ({ value: item, label: propertyLabel(query, item) }))}
        />
        <SelectField
          label={strings.filterOperator}
          value={operator}
          onValueChange={(nextOperator: string) => setOperator(nextOperator as QueryTableFilterOperator)}
          options={operators.map((item) => ({ value: item, label: strings[item] }))}
        />
        {needsValue && (
          <label className="garden-query-view__filter-value">
            <span>{strings.filterValue}</span>
            <Input
              type={operator === 'greaterThan' || operator === 'lessThan' ? 'number' : 'text'}
              step={operator === 'greaterThan' || operator === 'lessThan' ? 'any' : undefined}
              aria-label={strings.filterValue}
              list={operator === 'greaterThan' || operator === 'lessThan' ? undefined : suggestionsId}
              value={value}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setValue(event.currentTarget.value)}
            />
            {operator !== 'greaterThan' && operator !== 'lessThan' && (
              <datalist id={suggestionsId}>{suggestions.map((suggestion) => <option key={suggestion} value={suggestion} />)}</datalist>
            )}
          </label>
        )}
      </div>
      <div className="garden-query-view__filter-actions">
        {filterCount > 0 && <Button type="button" variant="ghost" size="sm" onClick={onClear}>{strings.clearFilters}</Button>}
        <Button type="button" size="sm" disabled={!column || (needsValue && !value.trim())} onClick={() => { onAdd(column, operator, value); setValue(''); }}>
          {strings.addFilter}
        </Button>
      </div>
    </div>
  );
}

function QueryValue({ value, emptyValue }: { value: unknown; emptyValue: string }) {
  if (Array.isArray(value)) {
    if (!value.length) return <span>{emptyValue}</span>;
    return (
      <span className="garden-query-view__tags">
        {value.map((item, index) => <span className="garden-query-view__tag" key={`${String(item)}-${index}`}>{displayValue(item, emptyValue)}</span>)}
      </span>
    );
  }
  return <span>{displayValue(value, emptyValue)}</span>;
}

function ListView({
  view,
  query,
  strings,
  onOpenDocument,
}: {
  view: QueryViewResult;
  query: ParsedQuery;
  strings: GQueryViewStrings;
  onOpenDocument?: (documentId: string) => void;
}) {
  if (!view.rows.length) {
    return <p className="garden-query-view__empty-list">{strings.emptyResults}</p>;
  }

  return (
    <ul className="garden-query-view__list">
      {view.rows.map((row) => {
        const label = documentLabel(row);
        return (
          <li className="garden-query-view__list-item" key={row.id}>
            <article>
              <h3 className="garden-query-view__document-title">
                {onOpenDocument ? (
                  <button
                    type="button"
                    className="garden-query-view__document-action"
                    aria-label={strings.openDocument(label)}
                    onClick={() => onOpenDocument(row.id)}
                  >
                    {label}
                  </button>
                ) : label}
              </h3>
              {view.columns.length > 0 && (
                <dl className="garden-query-view__properties">
                  {view.columns.map((column) => (
                    <div className="garden-query-view__property" key={column}>
                      <dt>{propertyLabel(query, column)}</dt>
                      <dd>{displayValue(row.values[column], strings.emptyValue)}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </article>
          </li>
        );
      })}
    </ul>
  );
}

/** Renders only explicitly enabled, read-only queries using the shared PDC parser/evaluator. */
export function GQueryView({
  source,
  documents,
  enabled,
  strings,
  onOpenDocument,
}: GQueryViewProps) {
  const parsedQuery = useMemo(
    () => enabled ? parseQuery(source, { inline: true }) : undefined,
    [enabled, source],
  );
  const evaluation = useMemo(
    () => parsedQuery ? evaluateQuery(parsedQuery, documents) : undefined,
    [parsedQuery, documents],
  );
  const id = useId();

  if (!enabled || !parsedQuery || !evaluation) {
    return <QueryFallback source={source} message={strings.disabled} strings={strings} />;
  }
  if (parsedQuery.status === 'invalid_query' || evaluation.status === 'invalid_query') {
    return (
      <QueryFallback
        source={source}
        message={strings.invalid}
        diagnostic={evaluation.diagnostic ?? parsedQuery.diagnostic}
        strings={strings}
      />
    );
  }
  if (parsedQuery.status === 'valid_unexecuted' || evaluation.status === 'valid_unexecuted') {
    return (
      <QueryFallback
        source={source}
        message={strings.unexecuted}
        diagnostic={evaluation.diagnostic ?? parsedQuery.diagnostic}
        strings={strings}
      />
    );
  }

  return (
    <div className="garden-query-view">
      {evaluation.views.map((view, index) => {
        const headingId = `${id}-view-${index}`;
        return (
          <section className={`garden-query-view__view${view.type === 'table' ? ' records-shell' : ''}`} aria-labelledby={headingId} key={`${view.name}-${index}`}>
            <header className="garden-query-view__view-header">
              <h2 id={headingId}>{view.name}</h2>
            </header>
            {view.type === 'table' ? (
              <TableView
                key={JSON.stringify([source, index, view.name, view.type, view.columns])}
                view={view}
                query={parsedQuery}
                strings={strings}
                onOpenDocument={onOpenDocument}
                headingId={headingId}
              />
            ) : (
              <>
                <div className="garden-query-view__list-content">
                  <ListView view={view} query={parsedQuery} strings={strings} onOpenDocument={onOpenDocument} />
                </div>
                <QuerySummaries view={view} query={parsedQuery} strings={strings} fullResults={false} />
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}
