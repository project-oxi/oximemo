/**
 * OKLCH color swatches (§7.7): a "no color" option and six perceptually-
 * uniform presets. Emits a full `oklch(...)` string (or "" for none). The
 * fine-tune sliders were dropped — the presets cover what we need.
 */
import { COLOR_PRESETS, paperFor, presetToString } from "../lib/color";
import { useI18n, type Dict } from "../lib/i18n";

const COLOR_NAME: Record<string, keyof Dict> = {
  red: "color_red",
  amber: "color_amber",
  green: "color_green",
  teal: "color_teal",
  blue: "color_blue",
  purple: "color_purple",
};

interface Props {
  value: string;
  onChange: (oklch: string) => void;
}

/** Inline swatch cluster: "no color" + six presets. Stays together as a unit. */
export function ColorSwatches({ value, onChange }: Props) {
  const { t } = useI18n();
  return (
    <div className="flex flex-none items-center gap-2">
      <button
        type="button"
        aria-label={t.no_color}
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
            aria-label={t[COLOR_NAME[p.id]]}
            onClick={() => onChange(s)}
            style={{ background: paperFor(s) }}
            className={`h-6 w-6 rounded-full border border-black/10 transition-transform hover:scale-110 dark:border-white/10 ${
              active ? "ring-2 ring-zinc-400 ring-offset-1 dark:ring-offset-zinc-900" : ""
            }`}
          />
        );
      })}
    </div>
  );
}
