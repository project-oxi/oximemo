export type TableSortDirection = "ascending" | "descending"
export type TableSortValue = string | number | null

function isLastValue(value: TableSortValue): boolean {
  return value === null || (typeof value === "number" && Number.isNaN(value))
}

function compareSortValues(left: TableSortValue, right: TableSortValue): number {
  const leftIsLast = isLastValue(left)
  const rightIsLast = isLastValue(right)

  if (leftIsLast || rightIsLast) {
    if (leftIsLast === rightIsLast) return 0
    return leftIsLast ? 1 : -1
  }

  if (typeof left === "number" && typeof right === "number") {
    if (left < right) return -1
    if (left > right) return 1
    return 0
  }

  if (typeof left === "string" && typeof right === "string") {
    if (left < right) return -1
    if (left > right) return 1
    return 0
  }

  // A fixed type order keeps mixed columns transitive in either direction.
  return typeof left === "number" ? -1 : 1
}

/** Sorts a copy of rows; null and NaN remain stable at the end in both directions. */
export function sortTableRows<T>(
  rows: readonly T[],
  getSortValue: (row: T) => TableSortValue,
  direction: TableSortDirection | null
): readonly T[] {
  if (direction === null) return rows

  const directionFactor = direction === "ascending" ? 1 : -1

  return rows
    .map((row, index) => ({ row, index, value: getSortValue(row) }))
    .sort((left, right) => {
      const byValue = compareSortValues(left.value, right.value)
      if (byValue !== 0) {
        if (isLastValue(left.value) || isLastValue(right.value)) return byValue
        return byValue * directionFactor
      }
      return left.index - right.index
    })
    .map(({ row }) => row)
}
