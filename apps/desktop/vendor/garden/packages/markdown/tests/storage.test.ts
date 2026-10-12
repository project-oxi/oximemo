import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,readFile,rm,stat,symlink,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readSourceSnapshot,writeSourceAtomically,SourceConflictError} from '../src/storage';
test('source writes preserve no-op bytes and block external changes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'garden-source-'));
 try {
  const path=join(dir,'note.md');await writeFile(path,'# Before\r\n');await chmod(path,0o664);
  const snapshot=await readSourceSnapshot(path), before=await stat(path);
  expect(await writeSourceAtomically(path,snapshot.digest,snapshot.source)).toEqual(snapshot);
  expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  await writeFile(path,'External edit');
  await expect(writeSourceAtomically(path,snapshot.digest,'Lost update')).rejects.toBeInstanceOf(SourceConflictError);
  expect(await readFile(path,'utf8')).toBe('External edit');
  const current=await readSourceSnapshot(path);
  await writeSourceAtomically(path,current.digest,'# After\n');
  expect(await readFile(path,'utf8')).toBe('# After\n');expect((await stat(path)).mode & 0o777).toBe(0o664);
 } finally {await rm(dir,{recursive:true,force:true});}
});
test('source adapter refuses symbolic-link targets',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'garden-symlink-'));
 try {
  const target=join(dir,'original.md'),link=join(dir,'link.md');await writeFile(target,'untouched');await symlink(target,link);
  await expect(readSourceSnapshot(link)).rejects.toThrow('regular file');
  expect(await readFile(target,'utf8')).toBe('untouched');
 } finally {await rm(dir,{recursive:true,force:true});}
});
test('snapshot preserves BOM for the parser to diagnose and rejects invalid UTF-8',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'garden-encoding-'));
 try {
  const path=join(dir,'note.md');await writeFile(path,Buffer.from([0xef,0xbb,0xbf,0x23,0x20,0x41]));
  const snapshot=await readSourceSnapshot(path);expect(snapshot.source.charCodeAt(0)).toBe(0xfeff);
  await writeSourceAtomically(path,snapshot.digest,snapshot.source);
  expect((await readFile(path))[0]).toBe(0xef);
  await writeFile(path,Buffer.from([0xff]));await expect(readSourceSnapshot(path)).rejects.toThrow();
 } finally {await rm(dir,{recursive:true,force:true});}
});
