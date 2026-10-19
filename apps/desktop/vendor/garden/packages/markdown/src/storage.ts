/** Node/Bun host adapter. Keep this module outside browser bundles. */
import { createHash, randomUUID } from 'node:crypto';
import { open, lstat, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, basename, join, resolve } from 'node:path';

export class SourceConflictError extends Error {
  readonly code = 'external_change_conflict';
}
export interface SourceSnapshot { source: string; digest: string }
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export async function readSourceSnapshot(path: string): Promise<SourceSnapshot> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Document target must be a regular file');
  const bytes = await readFile(path);
  return { source: new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(bytes), digest:digest(bytes) };
}

/**
 * Replace an existing source only if its snapshot still matches. Callers must
 * validate content and update document metadata before calling this IO adapter.
 * The lock serializes cooperating garden writers; external editors are checked
 * again immediately before atomic rename. An unchanged source is a true no-op.
 */
export async function writeSourceAtomically(path: string, expectedDigest: string, source: string): Promise<SourceSnapshot> {
  const target = resolve(path), folder = dirname(target);
  const lockPath = join(folder, `.${basename(target)}.garden-write-lock`);
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new SourceConflictError('Another writer holds the document lock; inspect stale locks explicitly');
    throw error;
  }
  const temp = join(folder, `.${basename(target)}.${randomUUID()}.tmp`);
  let temporaryCreated = false;
  try {
    const before = await lstat(target);
    if (!before.isFile() || before.isSymbolicLink()) throw new SourceConflictError('Document target is no longer a regular file');
    const current = await readSourceSnapshot(target);
    if (current.digest !== expectedDigest) throw new SourceConflictError('The source changed outside this edit session');
    if (current.source === source) return current;
    const bytes = Buffer.from(source, 'utf8');
    if (new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(bytes) !== source) throw new Error('Source contains an invalid Unicode scalar');
    const file = await open(temp, 'wx', before.mode & 0o777);
    temporaryCreated = true;
    try { await file.chmod(before.mode & 0o777); await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    const latestInfo = await lstat(target);
    const latest = await readSourceSnapshot(target);
    if (latestInfo.ino !== before.ino || latestInfo.dev !== before.dev || latest.digest !== expectedDigest) {
      throw new SourceConflictError('The source changed before replacement');
    }
    await rename(temp, target); temporaryCreated = false;
    // Directory fsync is best-effort on platforms/filesystems that reject it.
    try { const directory = await open(folder, 'r'); try { await directory.sync(); } finally { await directory.close(); } } catch {}
    return {source, digest:digest(bytes)};
  } finally {
    if (temporaryCreated) await unlink(temp).catch(() => {});
    await lock.close();
    await unlink(lockPath);
  }
}
