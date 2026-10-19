"use client";

import { useState } from "react";

/* ─────────────────────────────────────────────────────────
 * FILTER TABLE
 * Status chips directly filter the task table.
 * ───────────────────────────────────────────────────────── */

type Status = "todo" | "progress" | "done";

const FILTERS: { key: "all" | Status; label: string; dot?: string; count: number }[] = [
  { key: "all", label: "All", count: 5 },
  { key: "todo", label: "To do", dot: "#f09a2f", count: 2 },
  { key: "progress", label: "In Progress", dot: "#16a6c7", count: 2 },
  { key: "done", label: "Completed", dot: "#25a878", count: 1 },
];

const ROWS: { task: string; date: string; status: Status; owner: string }[] = [
  { task: "Restock mango sorbet", date: "Dec 03", status: "todo", owner: "Mango Moon Gelato" },
  { task: "Churn black sesame", date: "Sep 22", status: "progress", owner: "Kumo Creamery" },
  { task: "Print summer menu", date: "Jan 02", status: "todo", owner: "Coral Coast Sorbet" },
  { task: "Taste-test batch 42", date: "Nov 08", status: "progress", owner: "Maple Orbit" },
  { task: "Order waffle cones", date: "Apr 14", status: "done", owner: "Aurora Scoops" },
];

const PILLS: Record<Status, { label: string; cls: string }> = {
  todo: { label: "To do", cls: "filter-status-todo" },
  progress: { label: "In Progress", cls: "filter-status-progress" },
  done: { label: "Completed", cls: "filter-status-done" },
};

export default function FilterTable() {
  const [filter, setFilter] = useState<"all" | Status>("all");
  const visibleRows = filter === "all" ? ROWS : ROWS.filter((row) => row.status === filter);

  return (
    <div className="w-full max-w-105">
      {/* filter chips */}
      <div
        className="-mx-1 mb-1 flex items-center gap-1 overflow-x-auto px-1 py-1"
        style={{ scrollbarWidth: "none" }}
      >
        {FILTERS.map((f) => {
          const active = filter === f.key;
          return (
            <button
              key={f.key}
              type="button"
              aria-pressed={active}
              onClick={() => setFilter(f.key)}
              className={`flex h-6.5 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-caption
                font-medium transition-[background-color,box-shadow,color] duration-200
                ${active ? "bg-surface text-ink shadow-btn" : "text-ink-2 hover:bg-hover"}`}
            >
              {f.dot && <span className="size-1.5 rounded-full" style={{ background: f.dot }} />}
              {f.label}
              <span
                className={`rounded-[4px] px-1 text-micro tabular-nums
                  ${active ? "bg-field text-ink-2" : "text-ink-3"}`}
              >
                {f.count}
              </span>
            </button>
          );
        })}
      </div>

      {/* table */}
      <div
        aria-label="Scrollable task table"
        className="overflow-x-auto rounded-card bg-surface shadow-card"
        role="region"
        tabIndex={0}
        style={{ scrollbarWidth: "none" }}
      >
        <table className="min-w-[420px] w-full table-fixed border-collapse text-caption">
          <caption className="sr-only">Tasks filtered by status</caption>
          <colgroup>
            <col style={{ width: "35%" }} />
            <col style={{ width: "16%" }} />
            <col style={{ width: "25%" }} />
            <col style={{ width: "24%" }} />
          </colgroup>
          <thead>
            <tr className="border-b border-line text-left font-medium text-ink-3">
              <th scope="col" className="px-3 py-2">Task name</th>
              <th scope="col" className="px-3 py-2">Date</th>
              <th scope="col" className="px-3 py-2">Status</th>
              <th scope="col" className="px-3 py-2">Advisor</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, index) => {
              const pill = PILLS[row.status];
              const cellBorder = index < visibleRows.length - 1 ? "border-b border-line" : "";
              return (
                <tr key={row.task} className="transition-colors duration-100 hover:bg-hover">
                  <td className={`truncate px-3 py-2 font-medium text-ink ${cellBorder}`}>{row.task}</td>
                  <td className={`whitespace-nowrap px-3 py-2 text-ink-2 tabular-nums ${cellBorder}`}>{row.date}</td>
                  <td className={`px-3 py-2 ${cellBorder}`}>
                    <span
                      className={`inline-flex h-5 items-center rounded-[5px] px-1.5
                        text-micro font-medium ${pill.cls}`}
                    >
                      {pill.label}
                    </span>
                  </td>
                  <td className={`truncate px-3 py-2 text-ink-2 ${cellBorder}`}>{row.owner}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
