import * as React from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"

import { cn } from "../../lib/utils"

export type PaginationProps = {
  label: string
  page: number
  pageCount: number
  onPageChange: (page: number) => void
  previousLabel: string
  nextLabel: string
  pageLabel: (page: number) => string
  className?: string
}

type PageToken = number | "leading-ellipsis" | "trailing-ellipsis"

function getPageTokens(currentPage: number, pageCount: number): PageToken[] {
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, index) => index + 1)
  }

  let windowStart = Math.max(2, currentPage - 2)
  let windowEnd = Math.min(pageCount - 1, windowStart + 4)
  windowStart = Math.max(2, windowEnd - 4)

  const tokens: PageToken[] = [1]
  if (windowStart > 2) tokens.push("leading-ellipsis")
  for (let pageNumber = windowStart; pageNumber <= windowEnd; pageNumber += 1) {
    tokens.push(pageNumber)
  }
  if (windowEnd < pageCount - 1) tokens.push("trailing-ellipsis")
  tokens.push(pageCount)

  return tokens
}

function Pagination({
  label,
  page,
  pageCount,
  onPageChange,
  previousLabel,
  nextLabel,
  pageLabel,
  className,
}: PaginationProps) {
  const normalizedPageCount = Number.isFinite(pageCount)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(pageCount)))
    : 0
  const requestedPage = Number.isFinite(page) ? Math.floor(page) : 1
  const currentPage =
    normalizedPageCount === 0
      ? 0
      : Math.min(normalizedPageCount, Math.max(1, requestedPage))
  const pageTokens = getPageTokens(currentPage, normalizedPageCount)

  return (
    <nav
      aria-label={label}
      className={cn("g-pagination", className)}
      data-slot="pagination"
    >
      <ul className="g-pagination__list">
        <li>
          <button
            type="button"
            className="g-pagination__button g-pagination__direction"
            aria-label={previousLabel}
            disabled={currentPage <= 1}
            onClick={() => onPageChange(Math.max(1, currentPage - 1))}
          >
            <ChevronLeft aria-hidden="true" />
          </button>
        </li>
        {pageTokens.map((token) =>
          typeof token === "number" ? (
            <li key={`page-${token}`}>
              <button
                type="button"
                className="g-pagination__button"
                aria-label={pageLabel(token)}
                aria-current={token === currentPage ? "page" : undefined}
                onClick={() => onPageChange(token)}
              >
                {token}
              </button>
            </li>
          ) : (
            <li key={token}>
              <span className="g-pagination__ellipsis" aria-hidden="true">
                …
              </span>
            </li>
          )
        )}
        <li>
          <button
            type="button"
            className="g-pagination__button g-pagination__direction"
            aria-label={nextLabel}
            disabled={currentPage === 0 || currentPage >= normalizedPageCount}
            onClick={() =>
              onPageChange(Math.min(normalizedPageCount, currentPage + 1))
            }
          >
            <ChevronRight aria-hidden="true" />
          </button>
        </li>
      </ul>
    </nav>
  )
}

export { Pagination }
