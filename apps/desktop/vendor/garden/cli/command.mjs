import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, version, doctor, newProject, sync, update } from './lib/lifecycle.mjs';
import { adopt } from './lib/adopt.mjs';
import { installCommand } from './lib/installation.mjs';

const HELP = `Garden — personal application framework

Usage: garden <command> [options]

  new <name>                  Create a desktop app and install dependencies
  new <name> --template service  Create a Bun service
  init [path]                 Adopt Garden in an existing app (alias: migrate)
  update [path]               Update from the installed framework source
  doctor [path]               Check the project's contracts and configuration
  sync [path]                 Regenerate tokens, bindings, and agent routing
  dev [path]                  Run the desktop app or service
  dev [path] --web             Preview a desktop app in the browser
  build [path]                Run the project build
  test [path]                 Run the project tests
  deps [path]                 Install project dependencies
  source                      Show the active framework source
  install                     Put garden in ~/.local/bin

Options:
  --template desktop|service  Choose a project template (new defaults to desktop)
  --source <path>             Use a different local framework snapshot
  --dry-run                   Preview new/init/update without changing files
  --no-install                Skip dependency installation during new
  --install                   Install dependencies after init/update
  --offline                   Use Bun's local dependency cache
  --name <name>               Set the new application's name
  --bin-dir <path>            Choose the install destination directory
  --json                     Machine-readable output for source
  -h, --help                  Show this help
  -v, --version               Print the framework version

Examples:
  garden new my-app
  garden new my-worker --template service
  garden init --dry-run
  garden init
  garden update

init installs framework infrastructure and writes an adoption report.
Use the Garden skill to complete app-specific code and layout migration.
Legacy: garden new desktop <path> and garden update <path> <source> still work.
`;

const valueFlags = new Set(['template', 'source', 'name', 'bin-dir']);
const booleanFlags = new Set(['help', 'version', 'dry-run', 'no-install', 'install', 'offline', 'json', 'web']);
const allowed = {
  new: ['template', 'source', 'name', 'dry-run', 'no-install', 'install', 'offline'],
  init: ['template', 'source', 'dry-run', 'install', 'offline'],
  update: ['source', 'dry-run', 'install', 'offline'],
  doctor: [], sync: [], dev: ['web'], build: [], test: [], deps: ['offline'],
  source: ['source', 'json'], install: ['bin-dir'],
};

function parseArguments(args) {
  const flags = {}, positionals = [];
  let literal = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (literal) { positionals.push(arg); continue; }
    if (arg === '--') { literal = true; continue; }
    if (arg === '-h') { flags.help = true; continue; }
    if (arg === '-v') { flags.version = true; continue; }
    if (!arg.startsWith('-')) { positionals.push(arg); continue; }
    if (!arg.startsWith('--')) throw Error(`Unknown option ${arg}. Run garden --help.`);
    const equal = arg.indexOf('=');
    const key = arg.slice(2, equal < 0 ? undefined : equal);
    if (Object.hasOwn(flags, key)) throw Error(`Option --${key} was supplied more than once.`);
    if (valueFlags.has(key)) {
      const value = equal < 0 ? args[++index] : arg.slice(equal + 1);
      if (!value || value.startsWith('--')) throw Error(`--${key} requires a value.`);
      flags[key] = value;
    } else if (booleanFlags.has(key)) {
      if (equal >= 0) throw Error(`--${key} does not accept a value.`);
      flags[key] = true;
    } else throw Error(`Unknown option --${key}. Run garden --help.`);
  }
  return { flags, positionals };
}

function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

function selectSource(value, forUpdate = false) {
  const source = resolve(value || process.env.GARDEN_SOURCE || ROOT);
  if (forUpdate && existsSync(join(source, 'contracts/pins.json'))) {
    const nextVersion = readJson(join(source, 'contracts/pins.json')).garden;
    if (typeof nextVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(nextVersion)) throw Error('Invalid target framework version.');
    if (!existsSync(join(source, 'docs/migrations', `${nextVersion}.md`))) throw Error('Target snapshot must include versioned migration notes.');
  }
  for (const file of ['contracts/pins.json', 'cli/garden.mjs', 'templates/desktop/package.json', 'templates/service/package.json']) {
    if (!existsSync(join(source, file))) throw Error(`${source} is not a complete Garden framework source (missing ${file}).`);
  }
  return realpathSync(source);
}

function projectRoot(value) {
  const start = resolve(value || '.');
  let directory = start;
  do {
    if (existsSync(join(directory, 'garden.json'))) return directory;
    if (value) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  } while (true);
  throw Error(`No Garden project found at ${start}. Run garden init in your app or garden new <name>.`);
}

function runBun(root, args) {
  const result = spawnSync('bun', args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw Error(`Unable to run Bun: ${result.error.message}. Install the version in contracts/pins.json.`);
  if (result.status !== 0) throw Error(`bun ${args.join(' ')} ${result.signal ? `stopped (${result.signal})` : `failed (exit ${result.status})`}. Project files are retained at ${root}.`);
}

function installDependencies(root, flags) {
  runBun(root, ['install', ...(flags.offline ? ['--offline'] : [])]);
}

function runProject(root, command, flags) {
  const manifest = readJson(join(root, 'garden.json'));
  const pkg = readJson(join(root, 'package.json'));
  let script = command;
  if (command === 'dev') script = flags.web || manifest.track === 'framework' ? 'dev' : manifest.track === 'desktop' ? 'desktop' : 'start';
  if (!pkg.scripts?.[script] && pkg.scripts?.[`garden:${script}`]) script = `garden:${script}`;
  if (!pkg.scripts?.[script]) throw Error(`Missing package.json script "${script}". Complete the app's Garden adoption report first.`);
  runBun(root, ['run', script]);
}

function printAdoption(result, dryRun) {
  console.log(`${dryRun ? 'Planned' : result.alreadyAdopted ? 'Existing' : 'Applied'} ${result.template || ''} adoption: ${result.root}`);
  for (const change of result.changes || []) console.log(`  ${typeof change === 'string' ? change : JSON.stringify(change)}`);
  if (result.remaining?.length) {
    console.log('\nApp integration remaining:');
    for (const task of result.remaining) console.log(`  - ${typeof task === 'string' ? task : JSON.stringify(task)}`);
  }
  if (!dryRun) console.log('\nUse the Garden skill to finish app-specific migration. Then run garden deps, garden doctor, garden build, and garden test.');
}

export function main(args = process.argv.slice(2)) {
  const { flags, positionals } = parseArguments(args);
  if (flags.help || positionals[0] === 'help' || (!positionals.length && !flags.version)) { console.log(HELP); return; }
  if (flags.version) { console.log(version); return; }
  let command = positionals.shift();
  if (command === 'migrate') command = 'init';
  if (!Object.hasOwn(allowed, command)) throw Error(`Unknown command "${command}". Run garden --help.`);
  for (const key of Object.keys(flags)) if (!allowed[command].includes(key)) throw Error(`--${key} is not supported by garden ${command}.`);
  if (flags.install && flags['no-install']) throw Error('Choose either --install or --no-install.');
  if (flags['dry-run'] && flags.install) throw Error('--dry-run cannot be combined with --install.');
  if (flags.template && !['desktop', 'service'].includes(flags.template)) throw Error('Template must be desktop or service.');

  if (command === 'new') {
    const legacy = positionals.length === 2 && ['desktop', 'service'].includes(positionals[0]);
    if ((legacy && flags.template) || (!legacy && positionals.length !== 1)) throw Error('Usage: garden new <name> [--template desktop|service]');
    const template = flags.template || (legacy ? positionals.shift() : 'desktop');
    const target = resolve(positionals[0]);
    const source = selectSource(flags.source);
    if (flags['dry-run']) {
      if (existsSync(target)) throw Error(`Target already exists: ${target}`);
      console.log(`Would create ${template} app at ${target}\nFramework: ${source}`);
      return;
    }
    newProject(template, target, { source, name: flags.name });
    if (!flags['no-install'] && (!legacy || flags.install)) installDependencies(target, flags);
    console.log(`\nReady: ${target}\nNext: cd ${shellQuote(target)}\n      garden ${template === 'desktop' ? 'dev --web' : 'dev'}`);
    if (flags['no-install'] || (legacy && !flags.install)) console.log('Install dependencies first: garden deps');
    return;
  }
  if (command === 'source') {
    if (positionals.length) throw Error('Usage: garden source [--source path] [--json]');
    const source = selectSource(flags.source);
    const result = { source, version: readJson(join(source, 'contracts/pins.json')).garden };
    console.log(flags.json ? JSON.stringify(result) : `${result.source}\nGarden ${result.version}`);
    return;
  }
  if (command === 'install') {
    if (positionals.length) throw Error('Usage: garden install [--bin-dir path]');
    const result = installCommand(join(ROOT, 'cli/garden.mjs'), flags['bin-dir']);
    console.log(`Installed ${result.executable}\nFramework: ${ROOT}`);
    if (!result.onPath) console.log(`Add ${dirname(result.executable)} to PATH to use garden from any directory.`);
    return;
  }
  if (command === 'init') {
    if (positionals.length > 1) throw Error('Usage: garden init [path] [--template desktop|service]');
    const root = resolve(positionals[0] || '.');
    const result = adopt(root, { source: selectSource(flags.source), template: flags.template, dryRun: Boolean(flags['dry-run']) });
    printAdoption(result, flags['dry-run']);
    if (flags.install && !flags['dry-run']) installDependencies(root, flags);
    return;
  }
  if (positionals.length > (command === 'update' ? 2 : 1)) throw Error(`Too many arguments for garden ${command}.`);
  const root = projectRoot(positionals[0]);
  if (command === 'update') {
    if (positionals[1] && flags.source) throw Error('Supply the update source once, with --source or the legacy positional argument.');
    const source = selectSource(flags.source || positionals[1], true);
    const result = update(root, source, { dryRun: Boolean(flags['dry-run']) });
    if (flags['dry-run'] && result) console.log(JSON.stringify(result, null, 2));
    else if (flags.install) installDependencies(root, flags);
    return;
  }
  if (command === 'doctor') return doctor(root);
  if (command === 'sync') return sync(root);
  if (command === 'deps') return installDependencies(root, flags);
  return runProject(root, command, flags);
}
