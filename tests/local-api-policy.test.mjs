import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {startServer} from '../src/server.mjs';
import http from 'node:http';

test('boot authentication rejects marker-only and stale tokens before mutations',async t=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'pb-auth-'));
 let mutations=0;
 const models={publicSettings:()=>({}),updateSettings:()=>{mutations++;return {};}};
 let server=await startServer({dataDir,models});
 t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
 let workspaceEpoch;
 const post=token=>fetch(server.url+'/api/settings',{method:'POST',headers:{'X-PracticeBridge':'1','X-PracticeBridge-Token':token||'','X-PracticeBridge-Epoch':workspaceEpoch||'','Content-Type':'application/json'},body:'{}'});
 assert.equal((await post()).status,403);
 const bootstrap=async(headers={})=>fetch(server.url+'/api/bootstrap',{headers:{'X-PracticeBridge':'1',Origin:server.url,...headers}});
 assert.equal((await bootstrap({Origin:'https://evil.example'})).status,403);
 const forgedHost=await new Promise((resolve,reject)=>{const req=http.get(server.url+'/api/bootstrap',{headers:{Host:'evil.example','X-PracticeBridge':'1',Origin:server.url}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});
 assert.equal(forgedHost,403);
 assert.equal((await fetch(server.url+'/api/bootstrap')).status,403);
 const response=await bootstrap();assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/no-store/);
 const connection=await response.json();const {bootToken}=connection;workspaceEpoch=connection.workspaceEpoch;assert.match(bootToken,/^[a-f0-9]{64}$/);assert.match(workspaceEpoch,/^[a-f0-9-]{36}$/);
 assert.equal((await post(bootToken)).status,200);assert.equal(mutations,1);
 await server.close();server=await startServer({dataDir,models});
 assert.equal((await post(bootToken)).status,403);assert.equal(mutations,1);
});
