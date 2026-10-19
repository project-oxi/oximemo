import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const artifacts = [
  {
    input: "../../../contracts/markdown/envelope-2.schema.json",
    output: "../src/generated/envelope-schema.ts",
    exportName: "envelopeSchema",
  },
  {
    input: "../../../contracts/markdown/query-capabilities.json",
    output: "../src/generated/query-capabilities.ts",
    exportName: "queryCapabilities",
  },
];
let stale = false;

for (const artifact of artifacts) {
  const sourcePath = path.resolve(here, artifact.input);
  const outputPath = path.resolve(here, artifact.output);
  const contract = JSON.parse(await readFile(sourcePath, "utf8"));
  const generated = `// Generated from ${path.relative(path.resolve(here, "../.."), sourcePath)}. Do not edit.\nexport const ${artifact.exportName} = ${JSON.stringify(contract, null, 2)} as const;\n`;
  if (process.argv.includes("--check")) {
    const current = await readFile(outputPath, "utf8").catch(() => "");
    if (current !== generated) {
      console.error(`${path.basename(outputPath)} is stale; run the package build to refresh generated contract metadata.`);
      stale = true;
    }
  } else {
    await writeFile(outputPath, generated, "utf8");
  }
}
if (stale) process.exitCode = 1;
