import * as React from "react"

import { cn } from "../../lib/utils"
import { sortTableRows } from "../../lib/table-sort"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./table"

export interface DataTableColumn<T> {
  id: string
  header: string
  cell: (row: T) => React.ReactNode
  sortValue?: (row: T) => string | number | null
}

export interface DataTableProps<T> {
  label: string
  rows: readonly T[]
  columns: readonly DataTableColumn<T>[]
  getRowId: (row: T) => string
  emptyLabel: string
  className?: string
}

type SortDirection = "ascending" | "descending"
type SortState = { columnId: string; direction: SortDirection } | null

function DataTable<T>({
  label,
  rows,
  columns,
  getRowId,
  emptyLabel,
  className,
}: DataTableProps<T>) {
  const [sorting, setSorting] = React.useState<SortState>(null)
  const activeColumn = sorting
    ? columns.find(
        (column) => column.id === sorting.columnId && column.sortValue
      )
    : undefined

  React.useEffect(() => {
    if (
      sorting &&
      !columns.some(
        (column) => column.id === sorting.columnId && column.sortValue
      )
    ) {
      setSorting(null)
    }
  }, [columns, sorting])

  const sortedRows = React.useMemo(() => {
    if (!activeColumn?.sortValue) return rows
    return sortTableRows(
      rows,
      activeColumn.sortValue,
      sorting?.direction ?? null
    )
  }, [rows, activeColumn, sorting?.direction])

  function toggleSort(column: DataTableColumn<T>) {
    if (!column.sortValue) return
    setSorting((current) => {
      if (current?.columnId !== column.id) {
        return { columnId: column.id, direction: "ascending" }
      }
      if (current.direction === "ascending") {
        return { columnId: column.id, direction: "descending" }
      }
      return null
    })
  }

  return (
    <div data-slot="data-table" className={cn("g-data-table", className)}>
      <Table aria-label={label} className="g-data-table__table">
        {columns.length > 0 && <TableHeader>
          <TableRow>
            {columns.map((column) => {
              const isSortable = Boolean(column.sortValue)
              const direction =
                activeColumn?.id === column.id ? sorting?.direction : undefined

              return (
                <TableHead
                  key={column.id}
                  aria-sort={direction ?? "none"}
                  data-sort-direction={direction}
                >
                  {isSortable ? (
                    <button
                      type="button"
                      data-slot="data-table-sort"
                      className="g-data-table__sort"
                      onClick={() => toggleSort(column)}
                    >
                      <span>{column.header}</span>
                      <span className="g-data-table__sort-indicator" aria-hidden="true">
                        {direction === "ascending"
                          ? "↑"
                          : direction === "descending"
                            ? "↓"
                            : "↕"}
                      </span>
                    </button>
                  ) : (
                    column.header
                  )}
                </TableHead>
              )
            })}
          </TableRow>
        </TableHeader>}
        <TableBody>
          {sortedRows.length === 0 || columns.length === 0 ? (
            <TableRow data-slot="data-table-empty-row">
              <TableCell
                colSpan={Math.max(columns.length, 1)}
                className="g-data-table__empty"
              >
                {emptyLabel}
              </TableCell>
            </TableRow>
          ) : (
            sortedRows.map((row) => (
              <TableRow key={getRowId(row)}>
                {columns.map((column) => (
                  <TableCell key={column.id}>{column.cell(row)}</TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  )
}

export { DataTable }
