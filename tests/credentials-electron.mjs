import electronPath from 'electron';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const run=path.join(root,'test-results',`credentials-runtime-${Date.now()}`);
await mkdir(run,{recursive:true});
const results=[];
for(const phase of ['save','restore-delete','empty']){
 await new Promise((resolve,reject)=>{
  const child=spawn(electronPath,[path.join(root,'tests/fixtures/credentials-runtime.cjs'),run,phase],{cwd:root,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{output+=b;});
  const timer=setTimeout(()=>{child.kill();reject(Error('Electron runtime check timed out'));},30000);
  child.on('error',reject);child.on('close',code=>{clearTimeout(timer);if(code===0)resolve();else reject(Error('Electron runtime check failed: '+output));});
 });
 results.push(JSON.parse(await readFile(path.join(run,phase+'.json'),'utf8')));
 console.log('PASS Windows credential runtime '+phase);
}
await writeFile(path.join(run,'evidence.json'),JSON.stringify(results,null,2));console.log(JSON.stringify({run,results}));console.log('RESULT_DIR '+run);
