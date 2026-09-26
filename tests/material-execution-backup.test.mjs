import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {startServer} from '../src/server.mjs';
import {emptyState} from '../src/store.mjs';
import {readZip} from '../src/package.mjs';
import {appFetch} from './auth-client.mjs';
import ZipFixture from './helpers/zip-fixture.mjs';

test('production HTTP ZIP backup preserves retained charges even without jobs, rejects private extra fields, and unions older ledgers on restore',async t=>{
  const base=path.resolve('test-results/material-execution-backup');await fs.mkdir(base,{recursive:true});const dataDir=await fs.mkdtemp(path.join(base,'run-'));
  const grantId=randomUUID(),state=emptyState();state.materialExecutionLedger={version:1,grants:{[grantId]:{identityHash:'a'.repeat(64),elapsedMs:100,requests:Object.fromEntries(Array.from({length:10},(_,i)=>[`request-${i+1}`,{requestDigest:(i+1).toString(16).padStart(64,'0'),reservation:{input:200,output:80},state:'settled',usage:{inputTokens:100,outputTokens:20},acknowledgedAt:null}]))}}};
  await fs.writeFile(path.join(dataDir,'state.json'),JSON.stringify(state));const instance=await startServer({dataDir});
  t.after(async()=>{await instance.close();assert.ok(dataDir.startsWith(base+path.sep));await fs.rm(dataDir,{recursive:true,force:true});});
  const backup=async()=>{const response=await appFetch(instance.url+'/api/backup');assert.equal(response.status,200);const bytes=Buffer.from(await response.arrayBuffer());return {bytes,manifest:JSON.parse((await readZip(bytes)).get('practicebridge-backup.json'))};};
  const restore=async bytes=>appFetch(instance.url+'/api/restore',{method:'POST',headers:{'Content-Type':'application/json','X-PracticeBridge':'1'},body:JSON.stringify({file:{name:'authored-budget-backup.zip',data:bytes.toString('base64')}})});
  const saved=await backup();assert.deepEqual(saved.manifest.state.materialExecutionLedger,state.materialExecutionLedger);assert.deepEqual(saved.manifest.state.materialJobs,{});
  const privateZip=await ZipFixture.from(saved.bytes),privateManifest=structuredClone(saved.manifest);privateManifest.state.materialExecutionLedger.grants[grantId].requests['request-1'].apiKey='synthetic-credential-must-not-persist';privateZip.updateFile('practicebridge-backup.json',Buffer.from(JSON.stringify(privateManifest)));
  const before=await fs.readFile(path.join(dataDir,'state.json')),refused=await restore(privateZip.toBuffer());assert.equal(refused.status,400);assert.deepEqual(await fs.readFile(path.join(dataDir,'state.json')),before);
  const olderZip=await ZipFixture.from(saved.bytes),older=structuredClone(saved.manifest);for(let i=3;i<=10;i++)delete older.state.materialExecutionLedger.grants[grantId].requests[`request-${i}`];older.state.materialExecutionLedger.grants[grantId].elapsedMs=20;olderZip.updateFile('practicebridge-backup.json',Buffer.from(JSON.stringify(older)));
  const restored=await restore(olderZip.toBuffer());assert.equal(restored.status,200,await restored.text());const roundTrip=await backup();assert.deepEqual(roundTrip.manifest.state.materialExecutionLedger,state.materialExecutionLedger);
  const legacyZip=await ZipFixture.from(saved.bytes),legacy=structuredClone(saved.manifest);delete legacy.state.materialExecutionLedger;legacyZip.updateFile('practicebridge-backup.json',Buffer.from(JSON.stringify(legacy)));assert.equal((await restore(legacyZip.toBuffer())).status,200);assert.deepEqual((await backup()).manifest.state.materialExecutionLedger,state.materialExecutionLedger);
});
