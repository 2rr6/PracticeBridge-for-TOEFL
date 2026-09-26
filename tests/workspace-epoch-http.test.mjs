import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {startServer} from '../src/server.mjs';

const root=path.resolve('test-results/workspace-epoch-http');
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function harness(t,models){
  await fs.mkdir(root,{recursive:true});const dataDir=await fs.mkdtemp(path.join(root,'run-'));
  const instance=await startServer({dataDir,...(models?{models}:{})});
  t.after(async()=>{await instance.close();assert.ok(path.resolve(dataDir).startsWith(root+path.sep));await fs.rm(dataDir,{recursive:true,force:true});});
  const state=()=>fetch(instance.url+'/api/state').then(r=>r.json());
  const bootstrap=async()=>{const r=await fetch(instance.url+'/api/bootstrap',{headers:{'X-PracticeBridge':'1',Origin:instance.url}});assert.equal(r.status,200);return r.json();};
  const client=async()=>{const connection=await bootstrap();const epoch=connection.workspaceEpoch??(await state()).workspaceEpoch;return {'X-PracticeBridge':'1','Content-Type':'application/json','X-PracticeBridge-Token':connection.bootToken,'X-PracticeBridge-Epoch':epoch};};
  const post=async(route,body,headers)=>{const r=await fetch(instance.url+'/api'+route,{method:'POST',headers,body:JSON.stringify(body)});return {status:r.status,headers:r.headers,body:await r.json()};};
  const backup=async()=>Buffer.from(await(await fetch(instance.url+'/api/backup')).arrayBuffer());
  const restore=(bytes,headers)=>post('/restore',{file:{name:'self-authored-backup.zip',data:bytes.toString('base64')}},headers);
  return {instance,state,bootstrap,client,post,backup,restore};
}

test('bootstrap exposes the persisted epoch and all ordinary mutations require it',async t=>{
  const h=await harness(t),connection=await h.bootstrap(),state=await h.state();
  assert.match(connection.workspaceEpoch||'',/^[a-f0-9-]{36}$/);
  assert.equal(connection.workspaceEpoch,state.workspaceEpoch);
  const headers=await h.client();delete headers['X-PracticeBridge-Epoch'];
  for(const route of ['/materials','/settings','/assistant/preferences','/asr/disable','/recordings']){
    const result=await h.post(route,{text:'Self-authored missing epoch'},headers);
    assert.equal(result.status,428,route+': '+JSON.stringify(result.body));
  }
  assert.equal((await h.state()).materials.length,0);
});

test('restore keeps boot authentication separate and refuses captured old commands',async t=>{
  const h=await harness(t),old=await h.client(),bytes=await h.backup();
  assert.equal((await h.restore(bytes,old)).status,200);
  const fresh=await h.client();
  assert.equal(old['X-PracticeBridge-Token'],fresh['X-PracticeBridge-Token']);
  assert.notEqual(old['X-PracticeBridge-Epoch'],fresh['X-PracticeBridge-Epoch']);
  const stale=await h.post('/materials',{text:'Old command must not be adopted'},old);
  assert.equal(stale.status,409);assert.equal(stale.headers.get('X-PracticeBridge-Epoch'),fresh['X-PracticeBridge-Epoch']);
  assert.equal((await h.post('/materials',{text:'New explicit page command'},fresh)).status,200);
  assert.equal((await h.state()).materials.length,1);
});

test('a body that finishes after restore retains its original request epoch',async t=>{
  const h=await harness(t),headers=await h.client(),bytes=await h.backup();
  const body=JSON.stringify({text:'A delayed old request body'});
  let pendingRequest;
  const result=new Promise((resolve,reject)=>{
    pendingRequest=http.request(h.instance.url+'/api/materials',{method:'POST',headers:{...headers,Expect:'100-continue','Content-Length':Buffer.byteLength(body)}},response=>{
      const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,body:JSON.parse(Buffer.concat(chunks).toString())}));
    });pendingRequest.once('error',reject);
  });
  const continued=once(pendingRequest,'continue');pendingRequest.flushHeaders();await continued;
  assert.equal((await h.restore(bytes,headers)).status,200);
  pendingRequest.end(body);const stale=await result;
  assert.equal(stale.status,409,JSON.stringify(stale.body));
  assert.equal((await h.state()).materials.length,0);
});

test('restore cannot cross an in-flight model configuration write outside the state store',async t=>{
  const entered=deferred(),release=deferred();
  t.after(()=>release.resolve());
  const models={publicSettings:()=>({provider:'none',capabilities:{}}),updateSettings:async()=>{entered.resolve();await release.promise;return {provider:'none',capabilities:{}};}};
  const h=await harness(t,models),headers=await h.client(),bytes=await h.backup();
  const save=h.post('/settings',{provider:'none'},headers);await entered.promise;
  const refused=await h.restore(bytes,headers);assert.equal(refused.status,409);
  assert.equal((await h.client())['X-PracticeBridge-Epoch'],headers['X-PracticeBridge-Epoch']);
  release.resolve();assert.equal((await save).status,200);
  assert.equal((await h.restore(bytes,headers)).status,200);
});
