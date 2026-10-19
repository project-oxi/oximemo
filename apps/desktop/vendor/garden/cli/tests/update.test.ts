import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, copySnapshot, doctor, hash, newProject, update } from '../lib/lifecycle.mjs';

const readJson=(path:string)=>JSON.parse(readFileSync(path,'utf8'));
const writeJson=(path:string,value:unknown)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n');

function frameworkSource(directory:string,version?:string,bun?:string) {
  copySnapshot(ROOT,directory);
  const pinsPath=join(directory,'contracts/pins.json'),pins=readJson(pinsPath);
  if(version) pins.garden=version;
  if(bun) pins.bun=bun;
  pins.npm.react='19.3.1'; pins.npm['react-dom']='19.3.1';
  pins.rustCrates.tauri='2.12.1';
  writeJson(pinsPath,pins);
  for(const file of filesUnder(directory)) {
    if(file.endsWith('/package.json')) {
      const pkg=readJson(file);
      for(const section of ['dependencies','devDependencies','peerDependencies']) {
        if(pkg[section]?.react) pkg[section].react='19.3.1';
        if(pkg[section]?.['react-dom']) pkg[section]['react-dom']='19.3.1';
      }
      if(bun && pkg.packageManager?.startsWith('bun@')) pkg.packageManager=`bun@${bun}`;
      writeJson(file,pkg);
    }
    if(file.endsWith('/Cargo.toml')) writeFileSync(file,readFileSync(file,'utf8').replace('version = "=2.12.0"','version = "=2.12.1"'));
  }
  if(version) {
    mkdirSync(join(directory,'docs/migrations'),{recursive:true});
    writeFileSync(join(directory,'docs/migrations',`${version}.md`),`# ${version}\n\nLifecycle test migration.\n`);
  }
  return directory;
}

function filesUnder(directory:string):string[] {
  return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
    const path=join(directory,entry.name);
    return entry.isDirectory()?filesUnder(path):entry.isFile()?[path]:[];
  });
}

test('newProject stages atomically, derives safe package metadata and reports next actions',()=>{
  const temp=mkdtempSync(join(tmpdir(),'garden-new-core-'));
  try {
    const app=join(temp,'My Notes');
    const result=newProject('desktop',app,{name:'My Notes'});
    expect(result.name).toBe('my-notes');
    expect(result.nextActions).toEqual({dependencies:'garden deps',cli:'garden install',doctor:'garden doctor',run:'garden dev'});
    expect(readJson(join(app,'package.json')).name).toBe('my-notes');
    expect(readJson(join(app,'src-tauri/tauri.conf.json')).productName).toBe('My Notes');
    expect(readJson(join(app,'src-tauri/tauri.conf.json')).identifier).toBe('dev.garden.my.notes');
    expect(readJson(join(app,'src-tauri/tauri.conf.json')).app.windows[0].title).toBe('Garden');
    expect(readFileSync(join(app,'src-tauri/Cargo.toml'),'utf8')).toContain('name = "my-notes"');
    expect(existsSync(join(app,'node_modules'))).toBe(false);
    expect(doctor(app)).toBeUndefined();

    writeFileSync(join(app,'sentinel.txt'),'keep');
    expect(()=>newProject('service',app)).toThrow('Target already exists');
    expect(readFileSync(join(app,'sentinel.txt'),'utf8')).toBe('keep');
  } finally { rmSync(temp,{recursive:true,force:true}); }
});

test('failed project creation removes its sibling staging directory',()=>{
  const temp=mkdtempSync(join(tmpdir(),'garden-new-cleanup-'));
  try {
    const source=join(temp,'incomplete-source'), app=join(temp,'failed-app');
    mkdirSync(join(source,'contracts'),{recursive:true});
    writeJson(join(source,'contracts/pins.json'),{garden:'0.1.0'});
    expect(()=>newProject('service',app,{source})).toThrow();
    expect(existsSync(app)).toBe(false);
    expect(readdirSync(temp).some(name=>name.startsWith('.failed-app.garden-new-'))).toBe(false);
  } finally { rmSync(temp,{recursive:true,force:true}); }
});

test('copySnapshot skips symlinks and build/cache dependency directories',()=>{
  const temp=mkdtempSync(join(tmpdir(),'garden-copy-filter-'));
  try {
    const source=join(temp,'source'), destination=join(temp,'copied');
    frameworkSource(source);
    const contracts=join(source,'contracts');
    for(const directory of ['build','node_modules','.git','.cache','cache','npm-cache']) {
      mkdirSync(join(contracts,directory),{recursive:true});
      writeFileSync(join(contracts,directory,'outside.txt'),'must not copy');
    }
    const outside=join(temp,'outside.txt'); writeFileSync(outside,'external');
    symlinkSync(outside,join(contracts,'external-link'));
    copySnapshot(source,destination);
    expect(existsSync(join(destination,'contracts/garden.schema.json'))).toBe(true);
    for(const directory of ['build','node_modules','.git','.cache','cache','npm-cache']) expect(existsSync(join(destination,'contracts',directory))).toBe(false);
    expect(existsSync(join(destination,'contracts/external-link'))).toBe(false);
    if(existsSync(join(ROOT,'scripts/build-garden-plugin.mjs'))) expect(existsSync(join(destination,'scripts/build-garden-plugin.mjs'))).toBe(false);
    const externalDirectory=join(temp,'external-directory'); mkdirSync(externalDirectory);
    const linkedDestination=join(temp,'linked-destination'); symlinkSync(externalDirectory,linkedDestination);
    expect(()=>copySnapshot(source,linkedDestination)).toThrow('real directory');
  } finally { rmSync(temp,{recursive:true,force:true}); }
});

test('update dry-run plans same-version content changes without writes; identical content is a no-op',()=>{
  const temp=mkdtempSync(join(tmpdir(),'garden-update-content-'));
  try {
    const app=join(temp,'app'), source=frameworkSource(join(temp,'source'));
    newProject('service',app);
    const frameworkReadme=join(source,'contracts/framework/README.md');
    writeFileSync(frameworkReadme,readFileSync(frameworkReadme,'utf8')+'\nSame-version managed update fixture.\n');
    const manifestBefore=readFileSync(join(app,'garden.json'));
    const lockBefore=readFileSync(join(app,'garden.lock.json'));
    const plan=update(app,source,{dryRun:true});
    expect(plan.action).toBe('update');
    expect(plan.fromVersion).toBe(plan.toVersion);
    expect(plan.changedFiles).toContain('vendor/garden/contracts/framework/README.md');
    expect(plan.dryRun).toBe(true);
    expect(readFileSync(join(app,'garden.json'))).toEqual(manifestBefore);
    expect(readFileSync(join(app,'garden.lock.json'))).toEqual(lockBefore);
    expect(existsSync(join(app,'vendor/.garden-next'))).toBe(false);
    expect(existsSync(join(app,'vendor/.garden-previous'))).toBe(false);

    expect(update(app,source).action).toBe('updated');
    expect(readFileSync(join(app,'vendor/garden/contracts/framework/README.md'),'utf8')).toContain('Same-version managed update fixture.');
    expect(doctor(app)).toBeUndefined();
    const installedLock=readFileSync(join(app,'garden.lock.json'));
    expect(update(app,source).action).toBe('noop');
    expect(readFileSync(join(app,'garden.lock.json'))).toEqual(installedLock);
  } finally { rmSync(temp,{recursive:true,force:true}); }
});

test('update advances pins, rotates recovery snapshots, rejects downgrades and honors vendored doctor version',()=>{
  const temp=mkdtempSync(join(tmpdir(),'garden-update-history-'));
  try {
    const app=join(temp,'app'); newProject('desktop',app,{name:'My Notes'});
    mkdirSync(join(app,'docs/migrations'),{recursive:true});
    writeFileSync(join(app,'docs/migrations/0.1.1.md'),'Local migration guidance must remain intact.\n');
    const first=frameworkSource(join(temp,'next-0.1.1'),'0.1.1','1.4.3');
    expect(update(app,first).action).toBe('updated');
    expect(readJson(join(app,'garden.json')).garden).toBe('0.1.1');
    expect(readJson(join(app,'package.json')).packageManager).toBe('bun@1.4.3');
    expect(readFileSync(join(app,'docs/migrations/0.1.1.md'),'utf8')).toBe('Local migration guidance must remain intact.\n');
    expect(readJson(join(app,'vendor/garden/contracts/pins.json')).bun).toBe('1.4.3');
    expect(readJson(join(app,'vendor/.garden-previous/contracts/pins.json')).garden).toBe('0.1.0');

    const second=frameworkSource(join(temp,'next-0.1.2'),'0.1.2','1.4.3');
    expect(update(app,second).action).toBe('updated');
    expect(readJson(join(app,'garden.json')).garden).toBe('0.1.2');
    expect(readJson(join(app,'vendor/.garden-previous/contracts/pins.json')).garden).toBe('0.1.1');
    const history=join(app,'vendor/.garden-history');
    const archived=readdirSync(history);
    expect(archived).toHaveLength(1);
    expect(readJson(join(history,archived[0],'contracts/pins.json')).garden).toBe('0.1.0');
    expect(doctor(app)).toBeUndefined();

    const manifestBefore=readFileSync(join(app,'garden.json'));
    expect(()=>update(app,ROOT)).toThrow('downgrade');
    expect(readFileSync(join(app,'garden.json'))).toEqual(manifestBefore);
  } finally { rmSync(temp,{recursive:true,force:true}); }
});

test('doctor checks the vendored framework pin and updates refuse symlinked write paths',()=>{
  const temp=mkdtempSync(join(tmpdir(),'garden-update-guards-'));
  try {
    const oldSource=frameworkSource(join(temp,'older'),'0.0.9');
    const oldApp=join(temp,'old-app'); newProject('service',oldApp,{source:oldSource});
    expect(readJson(join(oldApp,'garden.json')).garden).toBe('0.0.9');
    expect(readJson(join(oldApp,'garden.lock.json')).version).toBe('0.0.9');
    expect(doctor(oldApp)).toBeUndefined();

    const app=join(temp,'app'); newProject('service',app);
    const source=frameworkSource(join(temp,'next'),'0.1.1');
    const outside=join(temp,'outside-migrations'); mkdirSync(outside);
    rmSync(join(app,'docs/migrations'),{recursive:true,force:true});
    symlinkSync(outside,join(app,'docs/migrations'));
    expect(()=>update(app,source)).toThrow('symbolic link');
    expect(readJson(join(app,'garden.json')).garden).toBe('0.1.0');
    expect(readdirSync(outside)).toHaveLength(0);
  } finally { rmSync(temp,{recursive:true,force:true}); }
});

test('update applies package pins when the project path itself contains vendor',()=>{
  const temp=mkdtempSync(join(tmpdir(),'garden-vendor-parent-'));
  try {
    const app=join(temp,'vendor','app'); newProject('desktop',app,{name:'my-notes'});
    const source=frameworkSource(join(temp,'next'),'0.1.1','1.4.3');
    expect(update(app,source).action).toBe('updated');
    expect(readJson(join(app,'package.json')).name).toBe('my-notes');
    expect(readJson(join(app,'package.json')).packageManager).toBe('bun@1.4.3');
    expect(readJson(join(app,'package.json')).dependencies.react).toBe('19.3.1');
    expect(readFileSync(join(app,'src-tauri/Cargo.toml'),'utf8')).toContain('version = "=2.12.1"');
  } finally { rmSync(temp,{recursive:true,force:true}); }
});

test('doctor accepts a locked legacy builder file and update removes it from the managed snapshot',()=>{
  const temp=mkdtempSync(join(tmpdir(),'garden-legacy-builder-'));
  try {
    const app=join(temp,'app'); newProject('service',app);
    const builder=join(app,'vendor/garden/scripts/build-garden-plugin.mjs');
    writeFileSync(builder,readFileSync(join(ROOT,'scripts/build-garden-plugin.mjs')));
    const lockPath=join(app,'garden.lock.json'),lock=readJson(lockPath);
    lock.files['vendor/garden/scripts/build-garden-plugin.mjs']=hash(builder);
    writeJson(lockPath,lock);

    expect(doctor(app)).toBeUndefined();
    const plan=update(app,ROOT,{dryRun:true});
    expect(plan.changedFiles).toContain('vendor/garden/scripts/build-garden-plugin.mjs');
    expect(existsSync(builder)).toBe(true);
    expect(update(app,ROOT).action).toBe('updated');
    expect(existsSync(builder)).toBe(false);
    expect(existsSync(join(app,'vendor/.garden-previous/scripts/build-garden-plugin.mjs'))).toBe(true);
    expect(doctor(app)).toBeUndefined();
  } finally { rmSync(temp,{recursive:true,force:true}); }
});
