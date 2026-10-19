import { test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root=resolve(import.meta.dir,'../..');
function run(...args:string[]) {
 const result=Bun.spawnSync(['node',join(root,'cli/garden.mjs'),...args],{stdout:'pipe',stderr:'pipe'});
 return {code:result.exitCode,output:new TextDecoder().decode(result.stdout)+new TextDecoder().decode(result.stderr)};
}
test('new creates a self-contained project; doctor rejects drift and recovers after sync',()=>{
 const temp=mkdtempSync(join(tmpdir(),'garden-cli-'));
 try {
  const app=join(temp,'service');
  expect(run('new','service',app).code).toBe(0);
  expect(JSON.parse(readFileSync(join(app,'garden.json'),'utf8')).standards).toEqual({profile:'garden-personal/1',exceptions:[]});
  expect(run('doctor',app).code).toBe(0);
  const agents=join(app,'AGENTS.md'); writeFileSync(agents,'changed');
  expect(run('doctor',app).output).toContain('AGENTS.md drift');
  expect(run('sync',app).code).toBe(0);
  expect(run('doctor',app).code).toBe(0);
  const manifest=join(app,'garden.json'),original=readFileSync(manifest,'utf8');
  writeFileSync(manifest,original.replace('0.1.0','99.0.0'));
  expect(run('doctor',app).code).toBe(1); writeFileSync(manifest,original);
  expect(run('doctor',app).code).toBe(0);
  expect(run('new','service',app).code).toBe(1);
  const uiContract=join(app,'vendor/garden/contracts/ui-spec/contract.json'),contractBytes=readFileSync(uiContract);
  const invalidContract=JSON.parse(contractBytes.toString());invalidContract.version='unknown-ui/9';writeFileSync(uiContract,JSON.stringify(invalidContract));
  expect(run('doctor',app).output).toContain('ui-spec/contract.json.version: unsupported constant');
  writeFileSync(uiContract,contractBytes);
  const lock=join(app,'garden.lock.json'),lockBytes=readFileSync(lock); rmSync(lock);
  expect(run('doctor',app).output).toContain('Missing garden.lock'); writeFileSync(lock,lockBytes);
  const extra=join(app,'vendor/garden/custom.txt');writeFileSync(extra,'local addition');
  expect(run('update',app,root).output).toContain('Untracked managed file');rmSync(extra);
 } finally {rmSync(temp,{recursive:true,force:true});}
});
test('new desktop and service projects pass standard stack and native configuration checks',()=>{
 const temp=mkdtempSync(join(tmpdir(),'garden-standards-'));
 try {
  for(const track of ['desktop','service']) {
   const app=join(temp,track);
   expect(run('new',track,app).code).toBe(0);
   const result=run('doctor',app);
   expect(result.code).toBe(0);
   expect(result.output).toContain('garden doctor: healthy');
  }
 } finally {rmSync(temp,{recursive:true,force:true});}
});
test('doctor rejects malformed standards profile and exceptions',()=>{
 const temp=mkdtempSync(join(tmpdir(),'garden-exceptions-'));
 try {
  const app=join(temp,'service');expect(run('new','service',app).code).toBe(0);
  const manifest=join(app,'garden.json');
  const read=()=>JSON.parse(readFileSync(manifest,'utf8'));
  const write=value=>writeFileSync(manifest,JSON.stringify(value,null,2)+'\n');
  let data=read();delete data.standards;write(data);
  expect(run('doctor',app).output).toContain('garden.json: missing standards');
  data=read();data.standards={profile:'garden-personal/1',exceptions:[]};data.standards.profile='garden-personal/99';write(data);
  expect(run('doctor',app).output).toContain('garden.json.standards.profile');
  data=read();data.standards.profile='garden-personal/1';
  data.standards.exceptions=[{rule:'stack.unknown',reason:'Unknown framework rule.',decision:'docs/decisions/0001-garden-v0.md'}];write(data);
  expect(run('doctor',app).output).toContain('known overridable framework rule');
  data=read();
  data.standards.exceptions=[{rule:'documents.integrity',reason:'Legacy service protocol is fixed.',decision:'docs/decisions/0001-garden-v0.md'}];write(data);
  expect(run('doctor',app).output).toContain('known overridable framework rule');
  data.standards.exceptions=[{rule:'stack.service',reason:'   ',decision:'docs/decisions/0001-garden-v0.md'}];write(data);
  expect(run('doctor',app).output).toContain('reason must be nonblank');
  data.standards.exceptions=[
   {rule:'stack.service',reason:'Keep service dependencies temporarily minimal.',decision:'docs/decisions/0001-garden-v0.md'},
   {rule:'stack.service',reason:'Duplicate exception.',decision:'docs/decisions/0001-garden-v0.md'}
  ];write(data);
  expect(run('doctor',app).output).toContain('rule is duplicated');
 } finally {rmSync(temp,{recursive:true,force:true});}
});
test('invalid or escaping exception evidence cannot waive its stack rule',()=>{
 const temp=mkdtempSync(join(tmpdir(),'garden-exception-guard-'));
 try {
  const app=join(temp,'service');expect(run('new','service',app).code).toBe(0);
  const packagePath=join(app,'package.json'),pkg=JSON.parse(readFileSync(packagePath,'utf8'));
  delete pkg.dependencies['@garden/daemon-kit'];writeFileSync(packagePath,JSON.stringify(pkg,null,2)+'\n');
  const manifestPath=join(app,'garden.json'),manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  manifest.standards.exceptions=[{rule:'stack.service',reason:'Temporary alternate runtime.',decision:'docs/decisions/../../outside.md'}];
  writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
  let result=run('doctor',app);
  expect(result.output).toContain('project-local docs/decisions/*.md path');
  expect(result.output).toContain('stack.service requires @garden/daemon-kit');
  const outside=join(temp,'outside.md');writeFileSync(outside,'# External decision\n');
  const link=join(app,'docs/decisions/0002-external.md');symlinkSync(outside,link);
  manifest.standards.exceptions=[{rule:'stack.service',reason:'Temporary alternate runtime.',decision:'docs/decisions/0002-external.md'}];
  writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
  result=run('doctor',app);
  expect(result.output).toContain('resolves outside the project docs/decisions directory');
  expect(result.output).toContain('stack.service requires @garden/daemon-kit');
  manifest.standards.exceptions=[{rule:'stack.service',reason:'Temporary alternate runtime.',decision:'docs/decisions/0001-garden-v0.md'}];
  writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
  result=run('doctor',app);
  expect(result.code).toBe(0);
  expect(result.output).toContain('garden doctor: active exception stack.service');
 } finally {rmSync(temp,{recursive:true,force:true});}
});
test('desktop exception waives native checks only; UI stack checks remain active',()=>{
 const temp=mkdtempSync(join(tmpdir(),'garden-stack-scope-'));
 try {
  const app=join(temp,'desktop');expect(run('new','desktop',app).code).toBe(0);
  const configPath=join(app,'src-tauri/tauri.conf.json'),config=JSON.parse(readFileSync(configPath,'utf8'));
  config.app.windows[0].decorations=true;writeFileSync(configPath,JSON.stringify(config,null,2)+'\n');
  expect(run('doctor',app).output).toContain('undecorated windows outside macOS');
  const packagePath=join(app,'package.json'),pkg=JSON.parse(readFileSync(packagePath,'utf8'));
  delete pkg.dependencies.react;writeFileSync(packagePath,JSON.stringify(pkg,null,2)+'\n');
  const manifestPath=join(app,'garden.json'),manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  manifest.standards.exceptions=[{rule:'stack.desktop',reason:'The native host is under active migration.',decision:'docs/decisions/0001-garden-v0.md'}];
  writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
  const result=run('doctor',app);
  expect(result.output).toContain('garden doctor: active exception stack.desktop');
  expect(result.output).toContain('stack.ui requires react');
  expect(result.output).not.toContain('undecorated windows outside macOS');
  manifest.adoptions=manifest.adoptions.filter(adoption=>adoption!=='ui');
  writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
  expect(run('doctor',app).output).toContain('stack.ui requires ui adoption');
 } finally {rmSync(temp,{recursive:true,force:true});}
});
test('update refuses modified managed files and missing migration notes',()=>{
 const temp=mkdtempSync(join(tmpdir(),'garden-update-'));
 try {
  const app=join(temp,'app'); expect(run('new','service',app).code).toBe(0);
  const snapshot=join(temp,'snapshot'); mkdirSync(join(snapshot,'contracts'),{recursive:true});
  cpSync(join(root,'contracts/pins.json'),join(snapshot,'contracts/pins.json'));
  expect(run('update',app,snapshot).output).toContain('migration notes');
  const managed=join(app,'vendor/garden/playbook/testing.md');writeFileSync(managed,'local policy');
  expect(run('update',app,root).output).toContain('Managed file drift');
  expect(readFileSync(managed,'utf8')).toBe('local policy');
 } finally {rmSync(temp,{recursive:true,force:true});}
});
test('update installs new npm/Rust pins and retains recovery copy',()=>{
 const temp=mkdtempSync(join(tmpdir(),'garden-upgrade-'));
 try {
  const app=join(temp,'app'); expect(run('new','desktop',app).code).toBe(0);
  const source=join(temp,'next'); cpSync(join(app,'vendor/garden'),source,{recursive:true});
  const pins=join(source,'contracts/pins.json'); const data=JSON.parse(readFileSync(pins,'utf8'));data.garden='0.1.1';data.npm.react='19.3.1';data.rustCrates.tauri='2.12.1';writeFileSync(pins,JSON.stringify(data));
  for(const rel of ['packages/ui/package.json','packages/editor/package.json','templates/desktop/package.json']) {const file=join(source,rel);writeFileSync(file,readFileSync(file,'utf8').replaceAll('19.3.0','19.3.1'));}
  // Keep React DOM pin coherent after the synthetic package fixtures changed both peers.
  data.npm['react-dom']='19.3.1';writeFileSync(pins,JSON.stringify(data));
  const cargo=join(source,'templates/desktop/src-tauri/Cargo.toml');writeFileSync(cargo,readFileSync(cargo,'utf8').replace('=2.12.0','=2.12.1'));
  mkdirSync(join(source,'docs/migrations'),{recursive:true});writeFileSync(join(source,'docs/migrations/0.1.1.md'),'# 0.1.1\n\nVerification fixture update.\n');
  const result=run('update',app,source);expect(result.output).toContain('Updated to 0.1.1');expect(result.code).toBe(0);
  expect(JSON.parse(readFileSync(join(app,'garden.json'),'utf8')).garden).toBe('0.1.1');
  expect(JSON.parse(readFileSync(join(app,'package.json'),'utf8')).dependencies.react).toBe('19.3.1');
  expect(readFileSync(join(app,'src-tauri/Cargo.toml'),'utf8')).toContain('=2.12.1');
  expect(JSON.parse(readFileSync(join(app,'vendor/.garden-previous/contracts/pins.json'),'utf8')).garden).toBe('0.1.0');
  const nextDoctor=Bun.spawnSync(['node',join(app,'vendor/garden/cli/garden.mjs'),'doctor',app]);expect(nextDoctor.exitCode).toBe(0);
 } finally {rmSync(temp,{recursive:true,force:true});}
});
test('update refuses a project unhealthy under its installed snapshot contracts',()=>{
 const temp=mkdtempSync(join(tmpdir(),'garden-preflight-'));
 try {
  const app=join(temp,'app'); expect(run('new','desktop',app).code).toBe(0);
  rmSync(join(app,'vendor/garden/contracts/framework'),{recursive:true,force:true});
  const result=run('update',app,root); expect(result.code).toBe(1);
  expect(result.output).toContain('healthy under its installed framework contracts');
  expect(result.output).toContain('Framework contract validation failed');
  expect(readFileSync(join(app,'garden.lock.json'),'utf8')).toContain('0.1.0');
 } finally {rmSync(temp,{recursive:true,force:true});}
});
test('update applies a same-version snapshot to a legacy project and adopts the standard profile',()=>{
 const temp=mkdtempSync(join(tmpdir(),'garden-legacy-'));
 try {
  const app=join(temp,'app'); expect(run('new','desktop',app).code).toBe(0);
  rmSync(join(app,'vendor/garden/contracts/framework'),{recursive:true,force:true});
  const manifest=join(app,'garden.json'); const data=JSON.parse(readFileSync(manifest,'utf8'));
  delete data.standards; writeFileSync(manifest,JSON.stringify(data,null,2)+'\n');
  const lockFile=join(app,'garden.lock.json'); const lock=JSON.parse(readFileSync(lockFile,'utf8'));
  lock.files=Object.fromEntries(Object.entries(lock.files).filter(([path])=>!path.startsWith('vendor/garden/contracts/framework/'))); writeFileSync(lockFile,JSON.stringify(lock,null,2)+'\n');
  writeFileSync(join(app,'vendor/garden/cli/garden.mjs'),"const [command]=process.argv.slice(2);\nif(command==='doctor') { console.log('garden doctor: healthy'); }\n");
  const pkgFile=join(app,'package.json'); const pkg=JSON.parse(readFileSync(pkgFile,'utf8'));
  pkg.dependencies['@garden/markdown']='workspace:*'; writeFileSync(pkgFile,JSON.stringify(pkg,null,2)+'\n');
  const result=run('update',app,root); expect(result.code).toBe(0);
  expect(result.output).toContain('Updated to 0.1.0');
  expect(result.output).toContain('Adopted framework standard profile garden-personal/1');
  const updated=JSON.parse(readFileSync(manifest,'utf8'));
  expect(updated.standards).toEqual({profile:'garden-personal/1',exceptions:[]});
  expect(readFileSync(join(app,'AGENTS.md'),'utf8')).toContain('contracts/framework/contract.json');
  const doctor=Bun.spawnSync(['node',join(app,'vendor/garden/cli/garden.mjs'),'doctor',app]);expect(doctor.exitCode).toBe(0);
 } finally {rmSync(temp,{recursive:true,force:true});}
});
