import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const web = fileURLToPath(new URL('../web/', import.meta.url));
const result = spawnSync(process.execPath, ['scripts/run-framework.mjs','build'], {cwd:web,stdio:'inherit'});
if(result.status !== 0) process.exit(result.status || 1);
// Keep the desktop's dist assets; only add the hosted Worker output.
for(const name of ['server','client','.openai']) {
 const target = fileURLToPath(new URL(`../dist/${name}/`,import.meta.url));
 // These three fixed generated directories live inside this project's dist.
 // Clear stale public files (especially index.html) before copying the build.
 rmSync(target,{recursive:true,force:true});
 mkdirSync(target,{recursive:true}); cpSync(`${web}/dist/${name}`,target,{recursive:true});
}
