import { Globe } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { FolderChipBar } from "../FolderChipBar";
import { graphData } from "../../lib/api";
import type { FolderCard, FolderDef, GraphData, MemoSummary } from "../../lib/types";
import { colorForFolder } from "../../lib/color";
import { useI18n } from "../../lib/i18n";
import { useUI } from "../../stores/ui";


interface SimNode {
  id: string;
  title: string;
  folder: string;
  color: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface Props {
  items?: MemoSummary[];
  folders?: FolderDef[];
  folderCards?: FolderCard[];
  onOpenFolder?: (path: string) => void;
  onNewFolder?: () => void;
}

function emptyBrowserGraph(items: MemoSummary[] = []): GraphData {
  const nodeMap = new Map<string, { id: string; title: string; folder: string }>();
  const edges: Array<{ source: string; target: string }> = [];
  const titleToId = new Map<string, string>();
  for (const n of items) {
    const title = n.title || n.id.slice(0, 8);
    nodeMap.set(n.id, { id: n.id, title, folder: n.folder });
    titleToId.set(title.toLowerCase(), n.id);
  }
  // Note: we don't have bodies here, so the browser fallback can only draw
  // nodes — link edges come from the Rust `graph_data` command. This is fine
  // because graph view is most useful inside the desktop app.
  return {
    nodes: [...nodeMap.values()].map((n) => ({
      id: n.id,
      title: n.title,
      folder: n.folder,
      connections: 0,
      color: "oklch(0.72 0.14 250)",
    })),
    edges,
  };
}

export function GraphView({
  items = [],
  folders = [],
  folderCards = [],
  onOpenFolder,
  onNewFolder,
}: Props) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 480 });
  const select = useUI((s) => s.select);

  const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const graphQ = useQuery<GraphData>({
    queryKey: ["graph"],
    queryFn: () =>
      inTauri ? graphData() : Promise.resolve(emptyBrowserGraph(items)),
    enabled: inTauri || items.length > 0,
  });
  const data: GraphData = graphQ.data ?? { nodes: [], edges: [] };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const nodes = useMemo<SimNode[]>(
    () =>
      data.nodes.map((n) => ({
        id: n.id,
        title: n.title,
        folder: n.folder,
        color: colorForFolder(n.folder),
        x: size.w / 2 + (Math.random() - 0.5) * 200,
        y: size.h / 2 + (Math.random() - 0.5) * 200,
        vx: 0,
        vy: 0,
      })),
    [data.nodes, size.w, size.h],
  );
  const indexById = useMemo(() => {
    const m = new Map<string, number>();
    nodes.forEach((n, i) => m.set(n.id, i));
    return m;
  }, [nodes]);

  const [, force] = useState(() => ({ tick: 0 }));

  useEffect(() => {
    if (nodes.length === 0) return;
    let raf = 0;
    let prev = nodes;
    const step = () => {
      const next = prev.map((n) => ({ ...n }));
      const k = 0.02;
      const repulse = 8000;
      const center = 0.005;
      // Repulsion between every pair.
      for (let i = 0; i < next.length; i++) {
        for (let j = i + 1; j < next.length; j++) {
          const a = next[i];
          const b = next[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const force = repulse / (dist * dist);
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          a.vx += fx;
          a.vy += fy;
          b.vx -= fx;
          b.vy -= fy;
        }
        const n = next[i];
        n.vx += (size.w / 2 - n.x) * center;
        n.vy += (size.h / 2 - n.y) * center;
      }
      // Spring on edges.
      for (const e of data.edges) {
        const si = indexById.get(e.source);
        const ti = indexById.get(e.target);
        if (si === undefined || ti === undefined) continue;
        const a = next[si];
        const b = next[ti];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const desired = 90;
        const diff = (dist - desired) * k;
        const fx = (dx / dist) * diff;
        const fy = (dy / dist) * diff;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
      for (const n of next) {
        n.vx *= 0.85;
        n.vy *= 0.85;
        n.x += n.vx;
        n.y += n.vy;
        if (n.x < 10) n.x = 10;
        if (n.x > size.w - 10) n.x = size.w - 10;
        if (n.y < 10) n.y = 10;
        if (n.y > size.h - 10) n.y = size.h - 10;
      }
      prev = next;
      force((f) => ({ tick: f.tick + 1 }));
      raf = window.requestAnimationFrame(step);
    };
    raf = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(raf);
  }, [data.edges, indexById, size.w, size.h, nodes.length]);

  if (nodes.length === 0) {
    return (
      <div ref={ref} className="flex h-full items-center justify-center text-sm text-text-subtle">
        No notes to graph yet.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <FolderChipBar
        cards={folderCards}
        folderDefs={folders}
        onOpen={(p) => onOpenFolder?.(p)}
        onNewFolder={() => onNewFolder?.()}
      />
      <div ref={ref} className="relative min-h-0 flex-1 overflow-hidden rounded-[var(--card-radius)] border border-line bg-surface-raised">
        <span
          data-global-badge
          className="absolute right-2.5 top-2.5 z-10 inline-flex items-center gap-1.5 rounded-[var(--tag-radius)] border border-line-strong bg-surface-muted px-2.5 py-1 text-[11px] text-text-muted"
          title={t.global_badge_tooltip}
        >
          <Globe size={11} /> {t.global_badge}
        </span>
        <svg width="100%" height="100%" className="absolute inset-0 h-full w-full">
          <g>
            {data.edges.map((e, i) => {
              const s = nodes[indexById.get(e.source) ?? -1];
              const t2 = nodes[indexById.get(e.target) ?? -1];
              if (!s || !t2) return null;
              return (
                <line
                  key={i}
                  x1={s.x}
                  y1={s.y}
                  x2={t2.x}
                  y2={t2.y}
                  stroke="currentColor"
                  strokeOpacity={0.2}
                  strokeWidth={1}
                />
              );
            })}
            {nodes.map((n) => (
              <g
                key={n.id}
                transform={`translate(${n.x},${n.y})`}
                style={{ cursor: "pointer" }}
                onClick={() => select(n.id)}
              >
                <circle r={5} fill={n.color || "currentColor"} stroke="var(--color-surface)" strokeWidth={1.5} />
                <text
                  x={9}
                  y={4}
                  fontSize={10}
                  fill="currentColor"
                  opacity={0.7}
                  style={{ pointerEvents: "none" }}
                >
                  {n.title.length > 28 ? `${n.title.slice(0, 28)}…` : n.title}
                </text>
              </g>
            ))}
          </g>
        </svg>
      </div>
    </div>
  );
}
