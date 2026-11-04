import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Bun's Windows isolated installer can populate its store without creating
// the nested Garden workspace links. Restore them from the frozen install.
const root = resolve(import.meta.dirname, "..");
const workspace = join(root, "vendor", "garden", "packages", "ui");
const store = join(root, "node_modules", ".bun");
const readPackage = (directory) => JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
const { dependencies, devDependencies } = readPackage(workspace);
const storeEntries = readdirSync(store);
let linked = 0;

for (const [name, version] of Object.entries({ ...dependencies, ...devDependencies })) {
  const link = join(workspace, "node_modules", name);
  if (existsSync(join(link, "package.json"))) continue;
  const matching = (directory) => {
    if (!existsSync(join(directory, "package.json"))) return false;
    const candidate = readPackage(directory);
    return candidate.name === name && candidate.version === version;
  };
  const storeLink = join(store, "node_modules", name);
  const candidates = matching(storeLink) ? [realpathSync(storeLink)] : [...new Set(storeEntries
    .map((entry) => join(store, entry, "node_modules", name))
    .filter(matching)
    .map((directory) => realpathSync(directory)))];
  if (candidates.length !== 1) {
    throw new Error(`Expected one installed Garden dependency ${name}@${version}, found ${candidates.length}`);
  }
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(candidates[0], link, process.platform === "win32" ? "junction" : "dir");
  linked += 1;
}

console.log(`Restored ${linked} Garden workspace dependency links`);
