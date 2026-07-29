/**
 * Slim status footer: vault health dot (from a doctor pass on mount) and
 * live note/pinned counts. Counts refresh on `notes:changed` so captures
 * from the overlay window show up immediately.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { doctor, noteStats } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { listen } from "../lib/tauri";

export function StatusBar() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [health, setHealth] = useState<"unknown" | "ok" | "warn">("unknown");

  const stats = useQuery({ queryKey: ["stats"], queryFn: noteStats });

  // One doctor pass on mount to seed the health dot (read-only, `fix=false`).
  useEffect(() => {
    doctor(false)
      .then((r) => {
        const issues =
          r.corrupt_frontmatter.length +
          r.orphan_index_records.length +
          r.orphan_files.length +
          r.hash_mismatches.length +
          r.invalid_colors.length;
        setHealth(issues === 0 && !r.index_locked ? "ok" : "warn");
      })
      .catch(() => setHealth("warn"));
  }, []);

  useEffect(() => {
    let un: (() => void) | undefined;
    void listen("notes:changed", () => {
      qc.invalidateQueries({ queryKey: ["stats"] });
    }).then((u) => {
      un = u;
    });
    return () => un?.();
  }, [qc]);

  const dot =
    health === "ok"
      ? "bg-emerald-500"
      : health === "warn"
        ? "bg-amber-500"
        : "bg-zinc-300 dark:bg-zinc-600";

  return (
    <footer className="flex h-7 shrink-0 items-center justify-between border-t border-zinc-200 bg-white/60 px-4 text-[11px] text-zinc-400 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-zinc-500">
      <span className="flex items-center gap-1.5">
        <span className={"h-1.5 w-1.5 rounded-full transition-colors " + dot} />
        {health === "ok" ? t.vault_ok : health === "warn" ? t.vault_issues : "…"}
      </span>
      <span className="flex items-center gap-3 tabular-nums">
        <span>{t.pinned_count.replace("{n}", String(stats.data?.pinned ?? 0))}</span>
        <span>{t.note_count.replace("{n}", String(stats.data?.notes ?? 0))}</span>
      </span>
    </footer>
  );
}
