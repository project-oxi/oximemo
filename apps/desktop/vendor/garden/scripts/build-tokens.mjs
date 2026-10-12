#!/usr/bin/env node
/**
 * Garden UI token generator — single source of truth → platform bindings.
 *
 *   contracts/tokens/garden.tokens.json → packages/ui/src/styles/garden.css
 *                                       → packages/ui/src/tokens.generated.ts
 *
 * VOCABULARY COLLISION: shadcn --accent (hover bg) vs beautifului --accent (focus
 * blue). Garden keeps a neutral --g-* semantic layer; both vocabularies alias it.
 * shadcn --accent is intentionally NOT emitted — use bg-hover (see PARITY.md).
 *
 * Zero dependencies. Deterministic. Run: node scripts/build-tokens.mjs
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const tokensPath = join(ROOT, "contracts/tokens/garden.tokens.json");
const tokens = JSON.parse(readFileSync(tokensPath, "utf8"));
const S = tokens.color.semantic;
const P = tokens.color.primitive;

// ── helpers ────────────────────────────────────────────────────────────────
const cssName = (s) => s.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
const G = (key) => `--g-${cssName(key)}`;

/** value for a theme ("light"|"dark") → { kind: "hex"|"mix", hex?, alpha?, ref? } */
function resolveValue(def, theme) {
  if (def.expr) return { kind: "mix", ref: def.expr.ref, alpha: def.expr.alpha };
  const v = def[theme];
  if (typeof v === "string") return { kind: "hex", hex: v };
  if (v && v.hex && v.alpha != null) return { kind: "mix", ref: null, hex: v.hex, alpha: v.alpha };
  throw new Error(`unresolvable ${theme} for ${JSON.stringify(def)}`);
}

function cssValue(def, theme) {
  const v = resolveValue(def, theme);
  if (v.kind === "hex") return v.hex;
  if (v.ref) return `color-mix(in srgb, var(${G(v.ref)}) ${Math.round(v.alpha * 100)}%, transparent)`;
  return `color-mix(in srgb, ${v.hex} ${Math.round(v.alpha * 100)}%, transparent)`;
}

/** beautifului alias name for a semantic key, if any */
function buiAlias(key) {
  const m = S[key]?.maps?.beautifului;
  return m && m !== "—" ? `--${m}` : null;
}

// ── web binding ────────────────────────────────────────────────────────────
function webBlock(selector, theme, isRoot) {
  const lines = [];
  for (const [key, def] of Object.entries(S)) {
    lines.push(`  ${G(key)}: ${cssValue(def, theme)};`);
    if (isRoot) {
      const alias = buiAlias(key);
      if (alias && alias !== G(key)) lines.push(`  ${alias}: var(${G(key)});`);
    }
  }
  if (isRoot) {
    // shadcn vocabulary (aliases into --g-*; --accent intentionally omitted)
    const sh = {
      "--background": "var(--g-canvas)",
      "--foreground": "var(--g-ink)",
      "--card": "var(--g-surface)",
      "--card-foreground": "var(--g-ink)",
      "--popover": "var(--g-surface)",
      "--popover-foreground": "var(--g-ink)",
      "--primary": "var(--g-primary)",
      "--primary-foreground": "var(--g-primary-ink)",
      "--secondary": "var(--g-inset)",
      "--secondary-foreground": "var(--g-ink)",
      "--muted": "var(--g-inset)",
      "--muted-foreground": "var(--g-ink2)",
      "--destructive": "var(--g-danger)",
      "--destructive-foreground": "var(--g-primary-ink)",
      "--border": "var(--g-line)",
      "--input": "var(--g-line-strong)",
      "--ring": "var(--g-accent)",
      "--chart-1": "var(--g-accent)",
      "--chart-2": "var(--g-success)",
      "--chart-4": "var(--g-brand)",
      "--chart-5": "var(--g-danger)",
    };
    for (const [k, v] of Object.entries(sh)) lines.push(`  ${k}: ${v};`);
  }
  return `${selector} {\n${lines.join("\n")}\n}`;
}

function shadowCSS(spec) {
  return spec.replaceAll("<line>", "var(--g-line)").replaceAll("<lineStrong>", "var(--g-line-strong)");
}

const webShadows = Object.entries(tokens.shadow)
  .filter(([k]) => k !== "note")
  .map(([k, v]) => `  --shadow-${cssName(k)}: ${shadowCSS(v)};`);

const webLayout = [
  ...tokens.spacing.grid.map((value) => `  --g-space-${value / tokens.spacing.unit_px}: ${value}px;`),
  ...Object.entries(tokens.spacing.layout).map(([key, value]) => `  --g-layout-${cssName(key)}: ${value}px;`),
  ...Object.entries(tokens.spacing.component).map(([key, value]) => `  --g-${cssName(key)}: ${typeof value === "number" ? `${value}px` : value};`),
].join("\n");

const webTypographyTheme = [
  ...Object.entries(tokens.typography.family).map(([key, value]) => `  --font-${key}: ${value.web};`),
  ...(tokens.typography.family.ui ? ["  --font-sans: var(--font-ui);"] : []),
  ...Object.entries(tokens.typography.scale_px).flatMap(([key, value]) => [
    `  --text-${key}: ${value.size}px;`,
    `  --text-${key}--line-height: ${value.line};`,
  ]),
  ...Object.entries(tokens.typography.weights).map(([key, value]) => `  --font-weight-${key}: ${value};`),
  ...Object.entries(tokens.typography.tracking).map(([key, value]) => `  --tracking-${key}: ${value};`),
];

const webRadiusTheme = [
  ...Object.entries(tokens.radius)
    .filter(([key]) => key !== "note")
    .map(([key, value]) => `  --radius-${key}: ${value}px;`),
  "  --radius: var(--radius-control);",
  "  --radius-base: var(--radius-control);",
  "  --radius-sm: calc(var(--radius-control) - 4px);",
  "  --radius-md: var(--radius-chip);",
];

const webMotionTheme = [
  ...Object.entries(tokens.motion.durations_ms).map(([key, value]) => `  --duration-${key}: ${value}ms;`),
  ...Object.entries(tokens.motion.curves).map(([key, value]) => `  --ease-${key}: ${value.css};`),
];

const webThemeStatic = `
/* Garden typography, radius, and motion tokens. These values are emitted even
 * when authored CSS references them without a matching Tailwind utility. */
@theme static {
${[...webTypographyTheme, ...webRadiusTheme, ...webMotionTheme].join("\n")}
}

:root {
  --g-motion-default: ${tokens.motion.default};
}
`;

const webThemeInline = `
/* Garden additions exposed as Tailwind utilities */
@theme inline {
  --color-primary-solid: var(--g-primary);
  --color-primary-ink: var(--g-primary-ink);
  --color-success: var(--g-success);
  --color-warning: var(--g-warning);
  --color-danger: var(--g-danger);
}

/* shadcn utilities (--accent omitted: use bg-hover per PARITY.md) */
@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
}
`;

// Vendored beautifului stylesheet: keep everything from its `@theme inline` onward
// (mapping, body, keyframes, atom + records/insight CSS); token blocks above are Garden's.
// Rules extracted into the standalone table stylesheet have one owner. Remove
// only exact whole-line duplicates, preserving the vendored source on disk.
const vendor = readFileSync(join(ROOT, "packages/ui/vendor/beautifului-globals.css"), "utf8");
const cut = vendor.indexOf("/* Expose the tokens as Tailwind utilities. */");
if (cut < 0) throw new Error("vendor globals.css marker not found");
const sharedTableRules = new Set(
  readFileSync(join(ROOT, "packages/ui/src/styles/table.css"), "utf8")
    .split("\n")
    .filter((line) => line.startsWith(".records-") && line.endsWith("}"))
);
const vendorRest = vendor.slice(cut).split("\n")
  .filter((line) => !sharedTableRules.has(line)).join("\n");

const cssOut = `/* Garden UI — generated web binding. DO NOT EDIT.
 * Source of truth: contracts/tokens/garden.tokens.json (run scripts/build-tokens.mjs)
 * Token vocabulary 1: beautifului components (page/canvas/surface/ink/line/…) — MIT, beautifului.dev
 * Token vocabulary 2: shadcn/ui (background/foreground/primary/…)
 * Neutral layer: --g-* (Garden semantic)
 * Philosophy: Codex-extracted monochrome system (see DESIGN.md)
 */
@import "tailwindcss";

@custom-variant dark (&:where(.dark, .dark *));

/* ── Garden neutral layer + vocabulary aliases (light) ── */
${webBlock(":root", "light", true)}

:root {
${webShadows.join("\n")}
${webLayout}
}

/* ── dark theme overrides ── */
${webBlock(".dark", "dark", false)}
${webThemeInline}
${vendorRest}
${webThemeStatic}
/* ── Garden overrides on vendored demo CSS ──
 * beautifului's Records demo ships a blue action button; Garden identity forbids
 * blue actions (inverse primary only). Re-skinned here, vendored file untouched. */
.records-primary-button { background: var(--g-primary); color: var(--g-primary-ink); }

/* ── beautifului primitive utilities ──
 * Upstream defines these in site-level CSS that is absent from the vendored
 * globals; without them card padding collapses (recommendation/fine-tune/
 * diff-table). Values follow the upstream demo proportions on the 4px grid. */
.primitive-card-bar { padding: 10px 12px; }
.primitive-card-pad { padding: 12px; }
.primitive-card-footer { padding: 10px 12px; }
.primitive-icon-button {
  width: 28px; height: 28px;
  display: inline-flex; align-items: center; justify-content: center;
  flex-shrink: 0; border-radius: var(--radius-control); cursor: pointer;
}
.primitive-table-cell { padding: 7px 10px; text-align: left; vertical-align: middle; }

@keyframes accordion-down { from { height: 0 } to { height: var(--radix-accordion-content-height) } }
@keyframes accordion-up { from { height: var(--radix-accordion-content-height) } to { height: 0 } }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
}
`;



const cssPath = join(ROOT, "packages/ui/src/styles/garden.css");
const typescriptPath = join(ROOT, "packages/ui/src/tokens.generated.ts");
const typescriptOut = `// Garden token bindings — generated. DO NOT EDIT.
// Source of truth: contracts/tokens/garden.tokens.json (run scripts/build-tokens.mjs)
export const gardenTokens = ${JSON.stringify(tokens, null, 2)} as const;
export type GardenTokens = typeof gardenTokens;
`;

const outputs = [
  [cssPath, cssOut],
  [typescriptPath, typescriptOut],
];
const check = process.argv.includes("--check");
if (process.argv.slice(2).some((arg) => arg !== "--check")) {
  throw new Error(`unknown argument: ${process.argv.slice(2).find((arg) => arg !== "--check")}`);
}

if (check) {
  const stale = outputs
    .filter(([path, expected]) => !existsSync(path) || readFileSync(path, "utf8") !== expected)
    .map(([path]) => path.slice(ROOT.length + 1));
  if (stale.length > 0) {
    console.error(`Generated token bindings are out of date:\n${stale.map((path) => `  - ${path}`).join("\n")}\nRun: node scripts/build-tokens.mjs`);
    process.exitCode = 1;
  } else {
    console.log(`token bindings current: ${outputs.map(([path]) => path.slice(ROOT.length + 1)).join(", ")}`);
  }
} else {
  for (const [path, contents] of outputs) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  console.log(
    `garden.css: ${cssOut.length}B → packages/ui/src/styles/garden.css\n` +
    `tokens.generated.ts: ${typescriptOut.length}B → packages/ui/src/tokens.generated.ts\n` +
    `semantic tokens: ${Object.keys(S).length}, primitive ramps: ${Object.keys(P).length}`
  );
}
