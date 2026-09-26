import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createOcrService} from '../src/ocr-service.mjs';

test('workspace reset drains the owned optional OCR operation and clears its old result without installing or restarting anything',async t=>{
  const base=path.resolve('test-results/ocr-service-reset');await fs.mkdir(base,{recursive:true});const dataDir=await fs.mkdtemp(path.join(base,'run-'));
  let epoch=randomUUID(),calls=0,finished=false;
  const service=createOcrService({dataDir,getEpoch:()=>epoch,inspectAssets:async()=>({available:false,detail:'Synthetic absent optional assets.'}),installLanguage:async({signal})=>{calls++;await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));await new Promise(resolve=>setImmediate(resolve));finished=true;throw Error('cancelled authored operation');}});
  t.after(async()=>{await service.close();assert.ok(dataDir.startsWith(base+path.sep));await fs.rm(dataDir,{recursive:true,force:true});});
  const before=await service.status();await service.start('install',{expectedEpoch:epoch,confirmed:true,previewId:before.preview.previewId});assert.equal(calls,1);
  await service.reset();assert.equal(finished,true);epoch=randomUUID();const after=await service.status();assert.equal(after.active,null);assert.equal(after.last,null);assert.equal(after.expectedEpoch,epoch);assert.equal(calls,1);
});
