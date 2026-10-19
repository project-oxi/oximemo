import {
  lstatSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  mkdtempSync,
  rmdirSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  ROOT,
  copySnapshot,
  doctor,
  json,
  snapshot,
  sync,
} from './lifecycle.mjs';

const WORKSPACE = 'vendor/garden/packages/*';
const DEFAULT_ADOPTIONS = {
  desktop: ['ui', 'markdown'],
  service: ['daemon'],
};
const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const PINNED_DEPENDENCIES = {
  desktop: ['react', 'react-dom', '@atomic-editor/editor', '@tauri-apps/api', '@tauri-apps/cli'],
  service: [],
};
const SYNC_COMMAND = 'node vendor/garden/cli/garden.mjs sync';
const DOCTOR_COMMAND = 'node vendor/garden/cli/garden.mjs doctor';

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw Error(`${label} is malformed JSON: ${error.message}`);
  }
}

function readPackage(root) {
  const path = join(root, 'package.json');
  if (!pathExists(path)) throw Error('Existing projects need a package.json before Garden adoption');
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw Error('Refusing package.json symlink');
  if (!stat.isFile()) throw Error('package.json must be a regular file');
  const pkg = readJson(path, 'package.json');
  if (!record(pkg)) throw Error('package.json must contain an object');
  for (const field of DEPENDENCY_SECTIONS) {
    if (pkg[field] === undefined) continue;
    if (!record(pkg[field])) throw Error(`package.json.${field} must contain an object`);
    for (const [name, value] of Object.entries(pkg[field])) {
      if (typeof value !== 'string') throw Error(`package.json.${field}.${name} must be a string`);
    }
  }
  if (pkg.scripts !== undefined) {
    if (!record(pkg.scripts)) throw Error('package.json.scripts must contain an object');
    for (const [name, value] of Object.entries(pkg.scripts)) {
      if (typeof value !== 'string') throw Error(`package.json.scripts.${name} must be a string`);
    }
  }
  if (pkg.packageManager !== undefined && typeof pkg.packageManager !== 'string') {
    throw Error('package.json.packageManager must be a string');
  }
  if (pkg.workspaces !== undefined) {
    const packages = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
    if (!Array.isArray(packages) || packages.some(item => typeof item !== 'string')) {
      throw Error('package.json.workspaces must be a string array or an object with a string packages array');
    }
  }
  if (pkg.name !== undefined && typeof pkg.name !== 'string') throw Error('package.json.name must be a string');
  if (pkg.version !== undefined && typeof pkg.version !== 'string') throw Error('package.json.version must be a string');
  return pkg;
}

function packageDeclares(pkg, dependency) {
  return DEPENDENCY_SECTIONS.some(section => Object.hasOwn(pkg[section] || {}, dependency));
}

function inferTemplate(root, pkg) {
  const hasDesktop = pathExists(join(root, 'src-tauri')) ||
    ['react', 'react-dom', '@tauri-apps/api', '@tauri-apps/cli'].some(name => packageDeclares(pkg, name));
  const hasService = packageDeclares(pkg, '@garden/daemon-kit') ||
    /\bbun\s+(?:run|--hot)\b/.test(pkg.scripts?.start || '') ||
    (!hasDesktop && pkg.packageManager?.startsWith('bun@') === true);
  if (hasDesktop && hasService) throw Error('Could not infer one Garden track; pass --template desktop or --template service');
  if (hasDesktop) return 'desktop';
  if (hasService) return 'service';
  throw Error('Could not infer the Garden track; pass --template desktop or --template service');
}

function validateManifestShape(manifest) {
  if (!record(manifest) || Object.keys(manifest).sort().join(',') !== 'adoptions,garden,standards,track') return false;
  if (typeof manifest.garden !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.garden)) return false;
  if (!['desktop', 'service'].includes(manifest.track)) return false;
  if (!Array.isArray(manifest.adoptions) || manifest.adoptions.some(item => typeof item !== 'string')) return false;
  if (new Set(manifest.adoptions).size !== manifest.adoptions.length) return false;
  if (manifest.adoptions.some(item => !['ui', 'markdown', 'daemon'].includes(item))) return false;
  const standards = manifest.standards;
  if (!record(standards) || Object.keys(standards).sort().join(',') !== 'exceptions,profile') return false;
  if (standards.profile !== 'garden-personal/1' || !Array.isArray(standards.exceptions)) return false;
  return standards.exceptions.every(entry => record(entry) &&
    Object.keys(entry).sort().join(',') === 'decision,reason,rule' &&
    typeof entry.rule === 'string' && /^[a-z]+\.[a-z-]+$/.test(entry.rule) &&
    typeof entry.reason === 'string' && /\S/.test(entry.reason) &&
    typeof entry.decision === 'string' && /^docs\/decisions\/[^/]+\.md$/.test(entry.decision));
}

function alreadyAdopted(root, requestedTemplate) {
  const manifestPath = join(root, 'garden.json');
  if (!pathExists(manifestPath)) return null;
  const stat = lstatSync(manifestPath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw Error('garden.json exists and is not a regular file; refusing adoption');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw Error(`garden.json exists but is malformed; refusing adoption: ${error.message}`);
  }
  if (!validateManifestShape(manifest)) throw Error('garden.json exists but is unrelated or invalid; refusing adoption');
  if (requestedTemplate && requestedTemplate !== manifest.track) {
    throw Error(`Project is already adopted as ${manifest.track}; refusing ${requestedTemplate} re-adoption`);
  }
  const vendorParent = join(root, 'vendor');
  if (pathExists(vendorParent) && lstatSync(vendorParent).isSymbolicLink()) {
    throw Error('vendor is a symlink; refusing adoption');
  }
  const vendor = join(root, 'vendor', 'garden');
  if (!pathExists(vendor)) return null;
  if (lstatSync(vendor).isSymbolicLink() || !lstatSync(vendor).isDirectory()) {
    throw Error('vendor/garden exists but is not a regular directory; refusing adoption');
  }
  const pinsPath = join(vendor, 'contracts', 'pins.json');
  if (!pathExists(pinsPath) || lstatSync(pinsPath).isSymbolicLink() || !lstatSync(pinsPath).isFile()) return null;
  let snapshotVersion;
  try {
    snapshotVersion = json(pinsPath).garden;
  } catch {
    return null;
  }
  if (snapshotVersion !== manifest.garden) return null;
  return manifest;
}

function assertNoSymlinkAndShape(root, relativePath, finalKind) {
  const parts = relativePath.split('/');
  let cursor = root;
  for (const [index, part] of parts.entries()) {
    cursor = join(cursor, part);
    if (!pathExists(cursor)) continue;
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw Error(`Refusing symlink in adoption path: ${relativePath}`);
    const final = index === parts.length - 1;
    if (!final && !stat.isDirectory()) throw Error(`Adoption path component is not a directory: ${relative(cursor, join(root, relativePath))}`);
    if (finalKind === 'file' && final && !stat.isFile()) throw Error(`Adoption target is not a regular file: ${relativePath}`);
    if (finalKind === 'directory' && final && !stat.isDirectory()) throw Error(`Adoption target is not a directory: ${relativePath}`);
  }
}

function inspectSnapshotTree(path) {
  const entries = readdirSync(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(path, entry.name);
    const stat = lstatSync(child);
    if (stat.isSymbolicLink()) throw Error(`Framework snapshot contains a symlink: ${child}`);
    if (stat.isDirectory()) inspectSnapshotTree(child);
    else if (!stat.isFile()) throw Error(`Framework snapshot contains a special file: ${child}`);
  }
}

function findDependency(pkg, name) {
  return DEPENDENCY_SECTIONS.find(section => Object.hasOwn(pkg[section] || {}, name)) || null;
}

function addScriptAlias(scripts, baseName, command) {
  if (!Object.hasOwn(scripts, baseName)) {
    scripts[baseName] = command;
    return baseName;
  }
  if (scripts[baseName] === command) return baseName;
  let name = `${baseName}:framework`;
  let suffix = 2;
  while (Object.hasOwn(scripts, name) && scripts[name] !== command) name = `${baseName}:framework:${suffix++}`;
  scripts[name] = command;
  return name;
}

function preparePackage(pkg, track, source, pins, report) {
  const updated = structuredClone(pkg);
  const changes = [];
  if (updated.workspaces === undefined) updated.workspaces = [];
  const workspaces = updated.workspaces;
  const workspacePackages = Array.isArray(workspaces) ? workspaces : workspaces.packages;
  if (!workspacePackages.includes(WORKSPACE)) {
    workspacePackages.push(WORKSPACE);
    changes.push(`package.json: added workspace ${WORKSPACE}`);
  }
  if (record(workspaces) && updated.packageManager?.startsWith('bun@')) {
    report.push('The existing workspaces object was preserved; verify Bun recognizes its packages array.');
  }

  const templatePackage = readPackage(join(source, 'templates', track));
  for (const section of ['dependencies', 'devDependencies']) {
    const defaults = templatePackage[section] || {};
    for (const [name, value] of Object.entries(defaults)) {
      const existingSection = findDependency(updated, name);
      if (existingSection) {
        if (name.startsWith('@garden/') && updated[existingSection][name] !== 'workspace:*') {
          changes.push(`package.json: set ${name} to workspace:*`);
          updated[existingSection][name] = 'workspace:*';
        }
      } else {
        updated[section] ||= {};
        updated[section][name] = value;
        changes.push(`package.json: added ${name}`);
      }
    }
  }

  for (const name of PINNED_DEPENDENCIES[track]) {
    const pin = pins.npm?.[name];
    if (typeof pin !== 'string') continue;
    for (const section of DEPENDENCY_SECTIONS) {
      if (!Object.hasOwn(updated[section] || {}, name) || updated[section][name] === pin) continue;
      const prior = updated[section][name];
      updated[section][name] = pin;
      changes.push(`package.json: pinned ${name} ${prior} → ${pin}`);
    }
  }

  if (updated.packageManager === undefined) {
    updated.packageManager = `bun@${pins.bun}`;
    changes.push(`package.json: set packageManager to bun@${pins.bun}`);
  } else if (updated.packageManager.startsWith('bun@') && updated.packageManager !== `bun@${pins.bun}`) {
    changes.push(`package.json: pinned packageManager ${updated.packageManager} → bun@${pins.bun}`);
    updated.packageManager = `bun@${pins.bun}`;
  }

  updated.scripts ||= {};
  const syncName = addScriptAlias(updated.scripts, 'garden:sync', SYNC_COMMAND);
  const doctorName = addScriptAlias(updated.scripts, 'garden:doctor', DOCTOR_COMMAND);
  for (const [name, command] of [[syncName, SYNC_COMMAND], [doctorName, DOCTOR_COMMAND]]) {
    if (pkg.scripts?.[name] !== command) changes.push(`package.json: added ${name}`);
  }
  return { package: updated, changes, syncName, doctorName };
}

function semanticTasks(track) {
  const tasks = track === 'desktop' ? [
    'Compose the existing React application with @garden/ui and GAppShell; the CLI did not rewrite application source.',
    'Connect the existing document flow to @garden/editor and @garden/markdown while preserving its data and source files.',
    'Exercise pane collapse and reopen, command search and focus return, settings, themes, compact layouts, and changed document paths.',
  ] : [
    'Connect the existing service handlers to @garden/daemon-kit and the garden-daemon/1 protocol; the CLI did not rewrite application source.',
    'Run and verify handshake, health, product RPCs, error handling, lifecycle behavior, and filesystem boundaries.',
  ];
  tasks.push('Record actual build, test, and running-path evidence before claiming semantic or runtime conformance.');
  return tasks;
}

function makeMigrationNote(track, gardenVersion, remaining) {
  return `# Garden adoption setup\n\n` +
    `The Garden ${track} infrastructure was initialized for framework version ${gardenVersion}. ` +
    `This records CLI setup only. It does not claim that the existing application has been migrated to Garden APIs or conforms to the semantic and runtime requirements.\n\n` +
    `## Remaining work\n\n${remaining.map(item => `- ${item}`).join('\n')}\n`;
}

function doctorRemaining(root) {
  try {
    doctor(root);
    return ['garden doctor: healthy for checked infrastructure; semantic and runtime integration remain unverified.'];
  } catch (error) {
    return String(error.message || error).split('\n').filter(Boolean).map(line => `garden doctor: ${line}`);
  }
}

function packageChangeSummary(changes) {
  return changes.length ? ['package.json', ...changes] : [];
}

function ensureDirectory(root, relativePath, createdDirectories) {
  const target = join(root, relativePath);
  if (pathExists(target)) {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) throw Error(`Refusing symlink in adoption path: ${relativePath}`);
    if (!stat.isDirectory()) throw Error(`Adoption path is not a directory: ${relativePath}`);
    return;
  }
  const parentRelative = relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/')) : '';
  if (parentRelative) ensureDirectory(root, parentRelative, createdDirectories);
  mkdirSync(target);
  createdDirectories.push(target);
}

function writeTracked(root, relativePath, data, backups, createdFiles) {
  const path = join(root, relativePath);
  if (!backups.has(path) && pathExists(path)) backups.set(path, readFileSync(path));
  if (!pathExists(path)) createdFiles.add(path);
  writeFileSync(path, data);
}

function rollback(backups, createdFiles, createdDirectories, snapshotPath) {
  const errors = [];
  for (const [path, bytes] of [...backups.entries()].reverse()) {
    try {
      writeFileSync(path, bytes);
    } catch (error) {
      errors.push(`restore ${path}: ${error.message}`);
    }
  }
  if (snapshotPath && pathExists(snapshotPath)) {
    try {
      rmSync(snapshotPath, { recursive: true, force: true });
    } catch (error) {
      errors.push(`remove ${snapshotPath}: ${error.message}`);
    }
  }
  for (const path of [...createdFiles].reverse()) {
    if (snapshotPath && (path === snapshotPath || path.startsWith(`${snapshotPath}${sep}`))) continue;
    try {
      rmSync(path, { recursive: true, force: true });
    } catch (error) {
      errors.push(`remove ${path}: ${error.message}`);
    }
  }
  for (const path of [...createdDirectories].reverse()) {
    try {
      rmdirSync(path);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') {
        errors.push(`remove directory ${path}: ${error.message}`);
      }
    }
  }
  return errors;
}

function validateProjectRoot(inputRoot) {
  if (typeof inputRoot !== 'string' || !inputRoot) throw Error('Adoption requires an existing project directory');
  const root = resolve(inputRoot);
  if (!pathExists(root)) throw Error(`Adoption project directory does not exist: ${root}`);
  const stat = lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error('Adoption target must be a regular existing directory');
  return root;
}

function existingAdoptionResult(root, manifest) {
  const remaining = semanticTasks(manifest.track);
  remaining.push(...doctorRemaining(root));
  return {
    root,
    template: manifest.track,
    changes: [],
    remaining,
    alreadyAdopted: true,
  };
}

export function adopt(inputRoot, { source = ROOT, template, dryRun = false } = {}) {
  const root = validateProjectRoot(inputRoot);
  if (template !== undefined && !['desktop', 'service'].includes(template)) {
    throw Error('Template must be desktop or service');
  }
  const adopted = alreadyAdopted(root, template);
  if (adopted) return existingAdoptionResult(root, adopted);

  for (const candidate of ['garden.json', 'vendor/garden', 'garden.lock.json']) {
    assertNoSymlinkAndShape(root, candidate, candidate === 'vendor/garden' ? 'directory' : 'file');
  }
  if (pathExists(join(root, 'garden.json'))) throw Error('garden.json exists but is unrelated or incomplete; refusing adoption');
  if (pathExists(join(root, 'vendor/garden'))) throw Error('vendor/garden already exists; refusing to overwrite it');
  if (pathExists(join(root, 'garden.lock.json'))) throw Error('garden.lock.json exists without a valid adoption; refusing to overwrite it');

  const pkg = readPackage(root);
  const track = template || inferTemplate(root, pkg);
  const sourceRoot = resolve(source);
  if (!pathExists(sourceRoot) || lstatSync(sourceRoot).isSymbolicLink() || !lstatSync(sourceRoot).isDirectory()) {
    throw Error(`Framework source is not a regular directory: ${sourceRoot}`);
  }
  const pins = json(join(sourceRoot, 'contracts/pins.json'));
  if (!record(pins) || typeof pins.garden !== 'string' || !/^\d+\.\d+\.\d+$/.test(pins.garden)) {
    throw Error('Framework source has invalid contracts/pins.json');
  }
  if (typeof pins.bun !== 'string') throw Error('Framework source has no Bun pin');

  const remaining = semanticTasks(track);
  const prepared = preparePackage(pkg, track, sourceRoot, pins, remaining);
  const changes = [
    'vendor/garden (self-contained framework snapshot)',
    `garden.json (track ${track}, framework ${pins.garden})`,
    ...packageChangeSummary(prepared.changes),
  ];

  const sourceAgents = join(root, 'AGENTS.md');
  const localAgents = join(root, 'AGENTS.local.md');
  let importedAgents = null;
  if (pathExists(sourceAgents)) {
    const stat = lstatSync(sourceAgents);
    if (stat.isSymbolicLink() || !stat.isFile()) throw Error('AGENTS.md must be a regular file before adoption');
    importedAgents = readFileSync(sourceAgents);
    if (pathExists(localAgents)) {
      const localStat = lstatSync(localAgents);
      if (localStat.isSymbolicLink() || !localStat.isFile()) throw Error('AGENTS.local.md must be a regular file before adoption');
      const localBytes = readFileSync(localAgents);
      const separator = Buffer.from('\n\n<!-- Existing AGENTS.md content preserved during Garden adoption -->\n\n');
      importedAgents = Buffer.concat([localBytes, separator, importedAgents]);
    }
    changes.push('AGENTS.md (generated by sync; previous contents preserved in AGENTS.local.md)');
    changes.push('AGENTS.local.md (preserved previous agent instructions)');
  } else {
    changes.push('AGENTS.md (generated by sync)');
  }

  const defaultFiles = [
    ['README.md', 'README.md'],
    ['CONTRIBUTING.md', 'CONTRIBUTING.md'],
    ['CHANGELOG.md', 'CHANGELOG.md'],
    ['rust-toolchain.toml', 'rust-toolchain.toml'],
  ];
  const addDefaults = [];
  for (const [projectPath, sourcePath] of defaultFiles) {
    const target = join(root, projectPath);
    if (pathExists(target)) continue;
    const sourceFile = join(sourceRoot, sourcePath);
    if (!pathExists(sourceFile) || !lstatSync(sourceFile).isFile()) continue;
    assertNoSymlinkAndShape(root, projectPath, 'file');
    addDefaults.push([projectPath, sourceFile]);
    changes.push(`${projectPath} (added framework default)`);
  }

  const decisionsDir = join(root, 'docs/decisions');
  const migrationsDir = join(root, 'docs/migrations');
  const migrationPath = join(root, 'docs/migrations/garden-adoption.md');
  if (pathExists(migrationPath)) throw Error('docs/migrations/garden-adoption.md already exists; refusing to overwrite it');
  for (const rel of ['package.json', 'garden.json', 'garden.lock.json', 'AGENTS.md', 'docs/decisions', 'docs/migrations/garden-adoption.md']) {
    assertNoSymlinkAndShape(root, rel, rel === 'docs/decisions' ? 'directory' : 'file');
  }
  if (importedAgents !== null) assertNoSymlinkAndShape(root, 'AGENTS.local.md', 'file');
  if (pathExists(decisionsDir) && !lstatSync(decisionsDir).isDirectory()) throw Error('docs/decisions must be a directory');
  if (pathExists(migrationsDir) && !lstatSync(migrationsDir).isDirectory()) throw Error('docs/migrations must be a directory');
  if (pathExists(join(root, 'vendor')) && !lstatSync(join(root, 'vendor')).isDirectory()) throw Error('vendor must be a directory');
  assertNoSymlinkAndShape(root, 'vendor/garden', 'directory');

  for (const [path] of addDefaults) assertNoSymlinkAndShape(root, path, 'file');

  changes.push('docs/migrations/garden-adoption.md (remaining semantic tasks and doctor diagnostics)');
  if (!pathExists(decisionsDir)) changes.push('docs/decisions/ (created for local decision records)');

  if (dryRun) return { root, template: track, changes, remaining };

  const stageParent = dirname(root);
  const stage = mkdtempSync(join(stageParent, '.garden-adopt-'));
  const stagedSnapshot = join(stage, 'garden');
  const vendorPath = join(root, 'vendor');
  const installedSnapshot = join(vendorPath, 'garden');
  const backups = new Map();
  const createdFiles = new Set();
  const createdDirectories = [];
  let snapshotCreated = false;
  try {
    copySnapshot(sourceRoot, stagedSnapshot);
    inspectSnapshotTree(stagedSnapshot);
    ensureDirectory(root, 'vendor', createdDirectories);

    ensureDirectory(root, 'docs/decisions', createdDirectories);
    ensureDirectory(root, 'docs/migrations', createdDirectories);
    if (importedAgents !== null) writeTracked(root, 'AGENTS.local.md', importedAgents, backups, createdFiles);
    for (const [path, sourceFile] of addDefaults) {
      const bytes = readFileSync(sourceFile);
      writeTracked(root, path, bytes, backups, createdFiles);
    }
    writeTracked(root, 'package.json', `${JSON.stringify(prepared.package, null, 2)}\n`, backups, createdFiles);
    writeTracked(root, 'garden.json', `${JSON.stringify({
      garden: pins.garden,
      track,
      adoptions: DEFAULT_ADOPTIONS[track],
      standards: { profile: 'garden-personal/1', exceptions: [] },
    }, null, 2)}\n`, backups, createdFiles);

    renameSync(stagedSnapshot, installedSnapshot);
    snapshotCreated = true;
    const agentsPath = join(root, 'AGENTS.md');
    if (pathExists(agentsPath)) backups.set(agentsPath, readFileSync(agentsPath));
    else createdFiles.add(agentsPath);
    sync(root);
    createdFiles.add(join(root, 'garden.lock.json'));
    snapshot(root);

    const diagnostics = doctorRemaining(root);
    remaining.push(...diagnostics);
    writeTracked(root, 'docs/migrations/garden-adoption.md', makeMigrationNote(track, pins.garden, remaining), backups, createdFiles);
    changes.push(...diagnostics.map(item => `remaining: ${item}`));
    return { root, template: track, changes, remaining };
  } catch (error) {
    const failures = rollback(backups, createdFiles, createdDirectories, snapshotCreated ? installedSnapshot : null);
    if (failures.length) throw Error(`${error.message}\nRollback was incomplete: ${failures.join('; ')}`);
    throw error;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
