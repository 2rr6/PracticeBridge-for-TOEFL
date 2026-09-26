const {app,safeStorage}=require('electron');
const {createSecretStore}=require('../../desktop/secret-store.cjs');
const path=require('node:path');
const fs=require('node:fs/promises');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {pathToFileURL}=require('node:url');
const run=path.resolve(process.argv[2]),phase=process.argv[3],dataDir=path.join(run,'data');
app.disableHardwareAcceleration();
app.setPath('userData',path.join(dataDir,'desktop-profile'));
let server;
app.whenReady().then(async()=>{
 assert.equal(process.versions.electron,'44.3.0');
 const {startServer}=await import(pathToFileURL(path.resolve(__dirname,'../../src/server.mjs')).href);
 const {readZip}=await import(pathToFileURL(path.resolve(__dirname,'../../src/package.mjs')).href);
 const secretStore=createSecretStore({directory:path.join(dataDir,'credentials'),safeStorage});
 assert.equal((await secretStore.capabilities()).available,true);
 server=await startServer({dataDir,secretStore});
 const {bootToken,workspaceEpoch}=await (await fetch(server.url+'/api/bootstrap',{headers:{'X-PracticeBridge':'1',Origin:server.url}})).json();
 const state=async()=> (await (await fetch(server.url+'/api/state')).json()).settings;
 const settings=async body=>{const response=await fetch(server.url+'/api/settings',{method:'POST',headers:{'X-PracticeBridge':'1','X-PracticeBridge-Token':bootToken,'X-PracticeBridge-Epoch':workspaceEpoch,'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200);return (await response.json()).settings;};
 const checks=[];
 if(phase==='save'){
  const sentinel='SYNTHETIC-'+randomUUID();
  const saved=await settings({provider:'openai',model:'synthetic-no-call',apiKey:sentinel,credentialMode:'encrypted'});
  assert.equal(saved.credential.saved,true);assert.equal(saved.hasApiKey,true);checks.push('OS encrypted save');
  const files=await fs.readdir(path.join(dataDir,'credentials'));assert.equal(files.length,1);
  assert.equal((await fs.readFile(path.join(dataDir,'credentials',files[0]))).includes(Buffer.from(sentinel)),false);checks.push('ciphertext excludes sentinel');
  assert.equal(JSON.stringify(await state()).includes(sentinel),false);checks.push('public state excludes sentinel');
  const backup=Buffer.from(await (await fetch(server.url+'/api/backup')).arrayBuffer());
  for(const bytes of (await readZip(backup)).values())assert.equal(bytes.includes(Buffer.from(sentinel)),false);checks.push('backup entries exclude sentinel');
 }else if(phase==='restore-delete'){
  assert.equal((await state()).hasApiKey,true);assert.equal((await state()).credential.saved,true);checks.push('restart restores credential');
  const deleted=await settings({clearApiKey:true});assert.equal(deleted.hasApiKey,false);assert.equal(deleted.credential.state,'ready');assert.equal((await fs.readdir(path.join(dataDir,'credentials'))).length,0);checks.push('delete clears disk and memory');
 }else{assert.equal((await state()).hasApiKey,false);checks.push('second restart has no credential');}
 await fs.writeFile(path.join(run,phase+'.json'),JSON.stringify({phase,electron:process.versions.electron,checks,providerCalls:0},null,2));
 await server.close();app.exit(0);
}).catch(async error=>{console.error(error);await server?.close();app.exit(1);});
