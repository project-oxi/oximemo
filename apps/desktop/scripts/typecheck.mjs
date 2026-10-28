import ts from "typescript";
import { resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const configPath = resolve(root, "tsconfig.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const vendorRoot = resolve(root, "vendor", "garden") + sep;

// Garden exports TypeScript source instead of declarations. Its own compiler
// permits unused imports; app-owned source retains noUnusedLocals. Suppress
// only that vendor diagnostic, never vendor type errors or app diagnostics.
const diagnostics = [config.error, ...parsed.errors, ...ts.getPreEmitDiagnostics(program)]
  .filter(Boolean)
  // TypeScript reports `/`-separated names even on Windows; resolve() maps
  // them onto `sep` so the prefix test matches there too.
  .filter((diagnostic) => !(diagnostic.code === 6133 && diagnostic.file && resolve(diagnostic.file.fileName).startsWith(vendorRoot)));

if (diagnostics.length) {
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => root,
    getCanonicalFileName: (name) => name,
    getNewLine: () => "\n",
  }));
  process.exitCode = 1;
}
