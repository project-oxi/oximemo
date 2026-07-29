/**
 * OKLCH color picker (§7.7): a "no color" option, six perceptually-uniform
 * presets, and three L/C/H sliders clamped to a safe range. Emits a full
 * `oklch(...)` string (or "" for none).
 */
import { COLOR_PRESETS, clamp, presetToString } from "../lib/color";

interface Props {
  value: string;
  onChange: (oklch: string) => void;
}

function parseOklch(s: string): { l: number; c: number; h: number } | null {
  const m = s.match(/oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/i);
  if (!m) return null;
  return { l: parseFloat(m[1]), c: parseFloat(m[2]), h: parseFloat(m[3]) };
}

function toStr(l: number, c: number, h: number): string {
  const v = clamp(l, c, h);
  return `oklch(${v.l.toFixed(3)} ${v.c.toFixed(3)} ${v.h.toFixed(1)})`;
}

export function ColorPicker({ value, onChange }: Props) {
  const cur = parseOklch(value);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-label="no color"
          onClick={() => onChange("")}
          className={`grid h-6 w-6 place-items-center rounded-full border text-zinc-400 ${
            value === ""
              ? "border-zinc-500 ring-2 ring-zinc-400 ring-offset-1 dark:ring-offset-zinc-900"
              : "border-dashed border-zinc-300 dark:border-zinc-600"
          }`}
          title="—"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <line x1="2" y1="10" x2="10" y2="2" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
        {COLOR_PRESETS.map((p) => {
          const s = presetToString(p);
          const active = value === s;
          return (
            <button
              key={p.id}
              type="button"
              aria-label={p.id}
              onClick={() => onChange(s)}
              style={{ background: s }}
              className={`h-6 w-6 rounded-full border border-black/10 transition-transform hover:scale-110 dark:border-white/10 ${
                active ? "ring-2 ring-zinc-400 ring-offset-1 dark:ring-offset-zinc-900" : ""
              }`}
            />
          );
        })}
      </div>
      {cur && (
        <div className="flex flex-col gap-1.5">
          {(["l", "c", "h"] as const).map((k) => {
            const next = (n: number) =>
              toStr(
                k === "l" ? n : cur.l,
                k === "c" ? n : cur.c,
                k === "h" ? n : cur.h,
              );
            return (
              <label
                key={k}
                className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-zinc-400"
              >
                <span className="w-3">{k}</span>
                <input
                  type="range"
                  min={k === "l" ? 0.5 : k === "c" ? 0.05 : 0}
                  max={k === "l" ? 0.9 : k === "c" ? 0.25 : 360}
                  step={k === "h" ? 1 : 0.01}
                  value={cur[k]}
                  onChange={(e) => onChange(next(+e.target.value))}
                  className="h-1 flex-1 cursor-pointer accent-zinc-500 dark:accent-zinc-400"
                />
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
