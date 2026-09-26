import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import http from 'node:http';
import {startServer} from '../src/server.mjs';
import {appFetch} from './auth-client.mjs';

test('production restore drains a cancelled old archive before publication and refuses new archive admission',async t=>{
  const base=path.resolve('test-results/archive-restore-race');await fs.mkdir(base,{recursive:true});const dataDir=await fs.mkdtemp(path.join(base,'run-')),instance=await startServer({dataDir});
  const originalRead=fs.readFile,original=Buffer.from('Self-authored archive race source.\n'),assetId=createHash('sha256').update(original).digest('hex'),heldPath=path.join(dataDir,'input-blobs',assetId);
  let release,entered,hold=true,restoreFinished=false,oldRequest,restoreRequest;const enteredPromise=new Promise(resolve=>{entered=resolve;});
  const post=(route,body)=>appFetch(instance.url+route,{method:'POST',headers:{'Content-Type':'application/json','X-PracticeBridge':'1'},body:JSON.stringify(body)});
  t.after(async()=>{release?.();fs.readFile=originalRead;await Promise.allSettled([oldRequest,restoreRequest].filter(Boolean));await instance.close();assert.ok(dataDir.startsWith(base+path.sep));await fs.rm(dataDir,{recursive:true,force:true});});
  const empty=Buffer.from(await (await appFetch(instance.url+'/api/backup')).arrayBuffer());assert.equal((await post('/api/materials',{files:[{name:'authored.txt',data:original.toString('base64')}]})).status,200);
  fs.readFile=async function(filename,...args){if(hold&&typeof filename==='string'&&path.resolve(filename)===heldPath){hold=false;entered();await new Promise(resolve=>{release=resolve;});}return originalRead.call(fs,filename,...args);};
  oldRequest=appFetch(instance.url+'/api/backup');await enteredPromise;
  restoreRequest=post('/api/restore',{file:{name:'empty-workspace.zip',data:empty.toString('base64')}}).then(response=>{restoreFinished=true;return response;});
  const deadline=Date.now()+3000;let gated=false;
  while(Date.now()<deadline&&!gated){const response=await appFetch(instance.url+'/api/backup');gated=response.status===503;await response.arrayBuffer();if(!gated)await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(gated,true,'new archive work must be refused while restore is closing old operations');assert.equal(restoreFinished,false,'restore must await the old archive completion callback');
  assert.equal((await (await appFetch(instance.url+'/api/state')).json()).materials.length,1,'old complete workspace remains published while archive drains');
  release();const cancelled=await oldRequest;assert.equal(cancelled.status,409,await cancelled.text());const restored=await restoreRequest;assert.equal(restored.status,200,await restored.text());
  assert.equal((await (await appFetch(instance.url+'/api/state')).json()).materials.length,0);assert.equal((await appFetch(instance.url+'/api/backup')).status,200);
});

test('an archive body admitted before shutdown cannot start a model after the shutdown gate closes',async t=>{
  const base=path.resolve('test-results/archive-shutdown-race');await fs.mkdir(base,{recursive:true});const dataDir=await fs.mkdtemp(path.join(base,'run-'));
  let calls=0,cancelled;const stopping=new Promise(resolve=>{cancelled=resolve;});
  const models={publicSettings:()=>({provider:'none'}),cancelRequests:()=>cancelled(),structure:async()=>{calls++;return {pack:{schemaVersion:1,id:'authored-close',version:'1',title:'Authored close',groups:[{id:'g',section:'reading',passage:'The lamp is blue.',questions:[{id:'q',type:'single_choice',prompt:'Which color?',options:[{id:'A',text:'Blue'},{id:'B',text:'Red'}],answer:null}]}]}};}};
  const instance=await startServer({dataDir,models});let request,closePromise;
  t.after(async()=>{request?.destroy();await (closePromise||instance.close());assert.ok(dataDir.startsWith(base+path.sep));await fs.rm(dataDir,{recursive:true,force:true});});
  const boot=await (await fetch(instance.url+'/api/bootstrap',{headers:{'X-PracticeBridge':'1',Origin:instance.url}})).json(),body=JSON.stringify({text:'Self-authored source for delayed archive preview.',useAI:true,consent:true});
  let ready;const admitted=new Promise(resolve=>{ready=resolve;});
  const response=new Promise((resolve,reject)=>{request=http.request(instance.url+'/api/import/preview',{method:'POST',headers:{'Content-Type':'application/json','X-PracticeBridge':'1','X-PracticeBridge-Token':boot.bootToken,'X-PracticeBridge-Epoch':boot.workspaceEpoch,'Content-Length':Buffer.byteLength(body),Expect:'100-continue'}},reply=>{const chunks=[];reply.on('data',chunk=>chunks.push(chunk));reply.on('end',()=>resolve({status:reply.statusCode,body:Buffer.concat(chunks).toString('utf8')}));});request.on('error',reject);request.once('continue',ready);request.flushHeaders();});
  await admitted;closePromise=instance.close();await stopping;request.end(body);const result=await response;await closePromise;assert.equal(calls,0,'shutdown must precede model admission even for an earlier request header');assert.equal(result.status,503,result.body);
});
