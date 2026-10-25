/**
 * Loading skeletons — Garden `Skeleton` (shimmer sweep) composed into the
 * shapes of the surfaces they stand in for. One component per surface
 * class; row count is the only knob.
 */
import { Skeleton } from "@garden/ui";

/** Main-surface grid: card-shaped blocks matching a GridView row (~176px). */
export function GridSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="grid gap-3 pt-1"
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}
    >
      {Array.from({ length: 12 }).map((_, i) => (
        <div key={i} className="flex h-[176px] flex-col gap-2 rounded-xl border border-line bg-surface p-4">
          <Skeleton className="h-4 w-2/5" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-11/12" />
          <Skeleton className="h-3 w-4/5" />
          <div className="mt-auto flex gap-1.5">
            <Skeleton className="h-5 w-14 rounded-full" />
            <Skeleton className="h-5 w-10 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Flat divided rows: note list, backlinks, history, PDC inventory. */
export function ListSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <ul aria-hidden="true" className="divide-y divide-line">
      {Array.from({ length: rows }).map((_, i) => (
        <li key={i} className="flex flex-col gap-1.5 py-2.5">
          <Skeleton className="h-3.5 w-1/3" />
          <Skeleton className="h-3 w-3/4" />
        </li>
      ))}
    </ul>
  );
}

/** Bordered card rows: session recorder list, trash. */
export function RowsSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <ul aria-hidden="true" className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <li key={i} className="flex items-start gap-3 rounded-lg border border-line bg-surface p-3">
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3 w-2/5" />
            <Skeleton className="h-2.5 w-1/4" />
          </div>
          <Skeleton className="h-2.5 w-20" />
        </li>
      ))}
    </ul>
  );
}
