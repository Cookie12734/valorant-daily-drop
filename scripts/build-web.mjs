import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const web = fileURLToPath(new URL('../web/', import.meta.url));
const result = spawnSync(process.execPath, ['scripts/run-framework.mjs','build'], {cwd:web,stdio:'inherit'});
if(result.status !== 0) process.exit(result.status || 1);
// Keep the desktop's dist assets; only add the hosted Worker output.
for(const name of ['server','client','.openai']) {
 const target = fileURLToPath(new URL(`../dist/${name}/`,import.meta.url));
 mkdirSync(target,{recursive:true}); cpSync(`${web}/dist/${name}`,target,{recursive:true});
}
