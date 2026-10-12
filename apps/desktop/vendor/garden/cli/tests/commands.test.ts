import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const source = resolve(import.meta.dir, '../..');
const cli = join(source, 'cli/garden.mjs');
function run(args: string[], cwd = source) {
  const result = Bun.spawnSync(['node', cli, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return { code: result.exitCode, output: new TextDecoder().decode(result.stdout), error: new TextDecoder().decode(result.stderr) };
}

test('CLI help, version, source and errors work outside a Garden project', () => {
  const temp = mkdtempSync(join(tmpdir(), 'garden-command-'));
  try {
    expect(run(['--help'], temp).code).toBe(0);
    expect(run(['--version'], temp).output.trim()).toBe(JSON.parse(readFileSync(join(source, 'contracts/pins.json'), 'utf8')).garden);
    expect(JSON.parse(run(['source', '--json'], temp).output).source).toBe(source);
    expect(run(['update', '--wat'], temp).code).toBe(1);
    expect(run(['doctor'], temp).error).toContain('garden init');
    expect(run(['new', 'unused', '--template'], temp).code).toBe(1);
    expect(existsSync(join(temp, 'unused'))).toBe(false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('short new command creates a named app; preview makes no target', () => {
  const temp = mkdtempSync(join(tmpdir(), 'garden-short-new-'));
  try {
    const app = join(temp, 'my-notes');
    expect(run(['new', app, '--dry-run']).code).toBe(0);
    expect(existsSync(app)).toBe(false);
    const result = run(['new', app, '--no-install']);
    expect(result.code).toBe(0);
    const manifest = JSON.parse(readFileSync(join(app, 'garden.json'), 'utf8'));
    expect(manifest.track).toBe('desktop');
    expect(JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')).name).toBe('my-notes');
    expect(JSON.parse(readFileSync(join(app, 'src-tauri/tauri.conf.json'), 'utf8')).identifier).not.toBe('dev.garden.template');
    expect(run(['doctor'], app).code).toBe(0);
    expect(run(['new', app, '--no-install']).code).toBe(1);
    expect(existsSync(join(app, 'src/main.tsx'))).toBe(true);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('project commands resolve upward and execute the owning app script', () => {
  const temp = mkdtempSync(join(tmpdir(), 'garden-script-'));
  try {
    const app = join(temp, 'worker');
    expect(run(['new', app, '--template', 'service', '--no-install']).code).toBe(0);
    const packagePath = join(app, 'package.json');
    const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
    pkg.scripts.build = 'node verify-cwd.cjs';
    writeFileSync(packagePath, JSON.stringify(pkg));
    writeFileSync(join(app, 'verify-cwd.cjs'), 'process.stdout.write(process.cwd())');
    const nested = join(app, 'src/deep');
    mkdirSync(nested, { recursive: true });
    const result = run(['build'], nested);
    expect(result.code).toBe(0);
    expect(result.output).toContain(app);
    expect(run(['doctor'], nested).code).toBe(0);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('local install works from arbitrary cwd and refuses an unrelated executable', () => {
  const temp = mkdtempSync(join(tmpdir(), 'garden-install-'));
  try {
    const bin = join(temp, 'my bin');
    expect(run(['install', '--bin-dir', bin]).code).toBe(0);
    expect(run(['install', '--bin-dir', bin]).code).toBe(0);
    const result = Bun.spawnSync([join(bin, 'garden'), 'source', '--json'], { cwd: temp, stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(result.stdout)).source).toBe(source);
    const conflict = join(temp, 'other');
    mkdirSync(conflict);
    writeFileSync(join(conflict, 'garden'), 'keep existing command');
    expect(run(['install', '--bin-dir', conflict]).code).toBe(1);
    expect(readFileSync(join(conflict, 'garden'), 'utf8')).toBe('keep existing command');
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('migrate previews then adopts an existing app without replacing its code', () => {
  const temp = mkdtempSync(join(tmpdir(), 'garden-migrate-command-'));
  try {
    const app = join(temp, 'existing');
    mkdirSync(join(app, 'src'), { recursive: true });
    const pins = JSON.parse(readFileSync(join(source, 'contracts/pins.json'), 'utf8'));
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'existing', packageManager: `bun@${pins.bun}` }));
    writeFileSync(join(app, 'src/index.ts'), 'export const originalBehavior = 42;\n');
    const preview = run(['migrate', '--dry-run'], app);
    expect(preview.code).toBe(0);
    expect(existsSync(join(app, 'garden.json'))).toBe(false);
    const applied = run(['migrate'], app);
    expect(applied.code).toBe(0);
    expect(JSON.parse(readFileSync(join(app, 'garden.json'), 'utf8')).track).toBe('service');
    expect(readFileSync(join(app, 'src/index.ts'), 'utf8')).toBe('export const originalBehavior = 42;\n');
    expect(existsSync(join(app, 'docs/migrations/garden-adoption.md'))).toBe(true);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
