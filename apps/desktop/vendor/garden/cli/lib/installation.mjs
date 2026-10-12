import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

/** Install a local executable without changing shell startup files or replacing another tool. */
export function installCommand(entry, binDirectory = join(homedir(), '.local', 'bin')) {
  const executable = realpathSync(entry);
  const directory = resolve(binDirectory);
  const destination = join(directory, 'garden');
  let current;
  try { current = lstatSync(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (current) {
    if (!current.isSymbolicLink() || !existsSync(destination) || realpathSync(destination) !== executable) {
      throw Error(`${destination} already exists and is not this Garden installation. Choose another --bin-dir.`);
    }
  } else {
    mkdirSync(directory, { recursive: true });
    symlinkSync(executable, destination);
  }
  chmodSync(executable, 0o755);
  const onPath = (process.env.PATH || '').split(delimiter).some(path => resolve(path) === directory);
  return { executable: destination, source: executable, onPath };
}
