import {readdirSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
function files(dir){return readdirSync(dir).flatMap(n=>{const p=resolve(dir,n);return statSync(p).isDirectory()?files(p):/\.(mjs|cjs)$/.test(p)?[p]:[];});}
for(const f of ['src','public','desktop','scripts'].flatMap(files)){const r=spawnSync(process.execPath,['--check',f],{stdio:'inherit',windowsHide:true});if(r.status!==0)process.exit(r.status||1);}
console.log('All JavaScript source files passed syntax checks.');
