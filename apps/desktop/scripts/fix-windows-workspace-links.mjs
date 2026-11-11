import { lstatSync, readFileSync, readlinkSync, renameSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

if (process.platform === "win32") {
  const root = resolve(import.meta.dirname, "..");
  const workspace = join(root, "vendor", "garden", "packages", "ui");
  const store = join(root, "node_modules", ".bun");
  const { dependencies, devDependencies, peerDependencies } = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8"));
  let repaired = 0;

  for (const name of Object.keys({ ...dependencies, ...devDependencies, ...peerDependencies })) {
    const link = join(workspace, "node_modules", name);
    if (!lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) continue;

    try {
      statSync(link);
      continue;
    } catch (error) {
      if (error.code !== "EPERM") throw error;
    }

    // Node can read the installed files, but cannot stat Bun's relative link
    // from the nested workspace. Keep its exact target using a junction.
    const target = resolve(dirname(link), readlinkSync(link));
    const inStore = relative(store, target);
    if (!inStore || inStore.startsWith("..") || isAbsolute(inStore) || !statSync(target).isDirectory()) {
      throw new Error(`Unexpected Bun workspace link target for ${name}`);
    }
    const backup = `${link}.bun-link`;
    renameSync(link, backup);
    try {
      symlinkSync(target, link, "junction");
    } catch (error) {
      renameSync(backup, link);
      throw error;
    }
    unlinkSync(backup);
    repaired += 1;
  }
  console.log(`Repaired ${repaired} Windows Garden workspace links`);
}
