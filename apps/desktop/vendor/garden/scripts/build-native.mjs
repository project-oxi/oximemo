import {readFileSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const contract=JSON.parse(readFileSync(resolve(root,'contracts/native/commands.json'),'utf8'));
const source='// Generated from contracts/native/commands.json. DO NOT EDIT.\n'+
'export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;\n'+
Object.entries(contract.commands).map(([name,shape])=>`export function ${name}(invoke: Invoke): Promise<${shape.result}> { return invoke<${shape.result}>("${name}"); }`).join('\n')+'\n';
const path=resolve(root,'packages/native/src/commands.ts');
if(process.argv.includes('--check')) { if(readFileSync(path,'utf8')!==source) throw Error('Native binding drift'); }
else writeFileSync(path,source);
