/** Shared query-collection creation (query views spec §5 creation paths —
 *  sidebar 「+」, palette 새 쿼리, chip-bar save-as all funnel here). */
import { listBases, saveBase } from "./api";

/** Create `queries/<unique-stem>.query` with the given YAML body.
 *  Resolves the vault-relative path of the created file. */
export async function createQueryCollection(stemBase: string, yaml: string): Promise<string> {
  const bases = await listBases().catch(() => []);
  const taken = new Set(bases.map((b) => b.name));
  let stem = stemBase;
  for (let n = 2; taken.has(stem); n++) stem = `${stemBase} ${n}`;
  const path = `queries/${stem}.query`;
  await saveBase(path, yaml);
  return path;
}

/** One default table view — the body every creation path starts from. */
export function defaultQueryYaml(viewName: string): string {
  return `views:\n  - type: table\n    name: ${viewName}\n`;
}

const esc = (s: string): string => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** YAML for the chip-bar save-as: and over include-tags, negated
 *  exclude-tags (match-all toggles and/or grouping, spec §1 union). */
export function tagFilterYaml(include: string[], exclude: string[], matchAll: boolean): string {
  const conds = [
    ...include.map((t) => `file.hasTag("${esc(t)}")`),
    ...exclude.map((t) => `!file.hasTag("${esc(t)}")`),
  ];
  if (conds.length === 0) return "views: []\n";
  const join = matchAll ? "and" : "or";
  const body = conds.map((c) => `      - '${c.replace(/'/g, "''")}'`).join("\n");
  return `filters:\n  ${join}:\n${body}\nviews: []\n`;
}
