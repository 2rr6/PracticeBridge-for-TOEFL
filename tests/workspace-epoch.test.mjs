import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createStore,atomicWrite} from '../src/store.mjs';

const root=path.resolve('test-results/workspace-epoch');
async function fixture(t){
  await fs.mkdir(root,{recursive:true});
  const dataDir=await fs.mkdtemp(path.join(root,'run-'));
  t.after(async()=>{assert.ok(path.resolve(dataDir).startsWith(root+path.sep));await fs.rm(dataDir,{recursive:true,force:true});});
  return dataDir;
}
const legacy=()=>({schemaVersion:1,libraries:[],attempts:[],sessions:[],jobs:[],recordings:{},blobs:{},materials:[]});
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

test('upgrade preserves exact pre-upgrade state bytes and immutable library snapshots',async t=>{
  const dataDir=await fixture(t),old=legacy();
  old.libraries.push({libraryId:'self-authored',contentHash:'unchanged-hash',originalPack:{schemaVersion:1,title:'Original snapshot',groups:[]}});
  const bytes=Buffer.from(JSON.stringify(old,null,4)+'\r\n');
  await fs.writeFile(path.join(dataDir,'state.json'),bytes);
  const store=await createStore({dataDir});t.after(()=>store.close());
  assert.equal(store.read().schemaVersion,2,'old writers must refuse the upgraded format');
  assert.deepEqual(store.read().libraries,old.libraries);
  const saved=await fs.readFile(path.join(dataDir,'upgrades',`before-0.5.0-${sha(bytes)}.json`));
  assert.deepEqual(saved,bytes,'upgrade snapshot preserves the actual original bytes');
  assert.equal(sha(saved),sha(bytes));
  const epoch=store.read().workspaceEpoch;
  await store.close();const reopened=await createStore({dataDir});t.after(()=>reopened.close());
  assert.equal(reopened.read().workspaceEpoch,epoch,'ordinary restart does not pretend another restore occurred');
});

test('a command scoped before an await cannot write after restore even when entity IDs match',async t=>{
  const store=await createStore({dataDir:await fixture(t)});t.after(()=>store.close());
  const epoch=store.read().workspaceEpoch;assert.equal(typeof store.withEpoch,'function');
  let release;const wait=new Promise(resolve=>{release=resolve;});
  const oldCommand=store.withEpoch(epoch,async()=>{await wait;return store.transact(state=>{state.oldCommandWasApplied=true;});});
  const restore=await store.beginRestore(epoch);
  try{await restore.publish(restore.snapshot);}finally{restore.release();}
  assert.notEqual(store.read().workspaceEpoch,epoch);
  release();await assert.rejects(oldCommand,error=>error.status===409);
  assert.equal(store.read().oldCommandWasApplied,undefined);
  assert.throws(()=>store.withEpoch(undefined,()=>{}),error=>error.status===428);
});

test('restore barrier drains started writes but rejects a queued old write before the stable snapshot',async t=>{
  const store=await createStore({dataDir:await fixture(t)});t.after(()=>store.close());
  assert.equal(typeof store.beginRestore,'function');
  let started,release;const entered=new Promise(resolve=>{started=resolve;});
  const wait=new Promise(resolve=>{release=resolve;});
  const first=store.transact(async state=>{started();await wait;state.first='committed before snapshot';});await entered;
  const queued=store.transact(state=>{state.queued='must not cross restore';});
  const queuedResult=assert.rejects(queued,error=>error.status===503);
  const restoring=store.beginRestore(store.read().workspaceEpoch);release();await first;
  const restore=await restoring;await queuedResult;
  assert.equal(restore.snapshot.first,'committed before snapshot');assert.equal(restore.snapshot.queued,undefined);
  try{await restore.publish(restore.snapshot);}finally{restore.release();}
  assert.equal(store.read().queued,undefined);
});

test('failed restore publication leaves prior state active and releases only its own barrier',async t=>{
  const dataDir=await fixture(t);let failPublication=false;
  const store=await createStore({dataDir,atomicWriter:async(filename,bytes)=>{if(failPublication&&path.basename(filename)==='state.json')throw new Error('Synthetic publication failure');return atomicWrite(filename,bytes);}});t.after(()=>store.close());
  assert.equal(typeof store.beginRestore,'function');
  const before=store.read(),restore=await store.beginRestore(before.workspaceEpoch);
  failPublication=true;
  try{await assert.rejects(restore.publish({...before,restoredValue:'must not appear'}),/Synthetic publication failure/);}finally{restore.release();failPublication=false;}
  assert.deepEqual(store.read(),before);
  await store.transact(state=>{state.stillUsable=true;});assert.equal(store.read().stillUsable,true);
});

test('releasing a restore permit before its queued publication prevents that publication',async t=>{
  const store=await createStore({dataDir:await fixture(t)});t.after(()=>store.close());
  const before=store.read(),restore=await store.beginRestore(before.workspaceEpoch);
  const queued=restore.publish({...before,revokedPublication:true});restore.release();
  await assert.rejects(queued,error=>error.status===409);
  assert.deepEqual(store.read(),before);
});

test('restore host preparation uses the actual new epoch inside its one publication',async t=>{
  const store=await createStore({dataDir:await fixture(t)});t.after(()=>store.close());
  const old=store.read(),permit=await store.beginRestore(old.workspaceEpoch);let seen;
  try{await permit.publish(old,{prepareState:next=>{seen=next.workspaceEpoch;assert.notEqual(seen,old.workspaceEpoch);assert.equal(store.read().workspaceEpoch,old.workspaceEpoch);next.restoredJob={workspaceEpoch:seen,generation:2};}});}finally{permit.release();}
  assert.equal(store.read().restoredJob?.workspaceEpoch,store.read().workspaceEpoch);assert.equal(store.read().workspaceEpoch,seen);
});

test('invalid or failed restore preparation preserves committed state bytes',async t=>{
  const dataDir=await fixture(t),store=await createStore({dataDir});t.after(()=>store.close());
  const before=await fs.readFile(path.join(dataDir,'state.json')),state=store.read();
  for(const prepareState of [()=>{throw new Error('Synthetic host preparation failed');},()=>Promise.resolve(),next=>{next.workspaceEpoch=state.workspaceEpoch;}]){
    const permit=await store.beginRestore(state.workspaceEpoch);try{await assert.rejects(permit.publish(state,{prepareState}));}finally{permit.release();}
    assert.deepEqual(await fs.readFile(path.join(dataDir,'state.json')),before);
  }
});

test('rejected async restore preparation leaves the service alive and its barrier reusable',async t=>{
  const dataDir=await fixture(t);
  const child=spawnSync(process.execPath,['--unhandled-rejections=strict','--input-type=module'],{
    encoding:'utf8',timeout:20_000,
    input:`
      import assert from 'node:assert/strict';
      import fs from 'node:fs/promises';
      import path from 'node:path';
      import {createStore} from ${JSON.stringify(new URL('../src/store.mjs',import.meta.url).href)};
      const dataDir=${JSON.stringify(dataDir)},store=await createStore({dataDir});
      const before=await fs.readFile(path.join(dataDir,'state.json')),state=store.read();
      for(const prepareState of [async()=>{throw new Error('Synthetic rejected preparation');},()=>({then(resolve,reject){reject(new Error('Synthetic rejected thenable'));}})]){
        const permit=await store.beginRestore(state.workspaceEpoch);
        try{await assert.rejects(permit.publish({...state,shouldNotPublish:true},{prepareState}),error=>error.status===500);}finally{permit.release();}
        await new Promise(resolve=>setImmediate(resolve));
        assert.deepEqual(await fs.readFile(path.join(dataDir,'state.json')),before);
        assert.equal(store.read().shouldNotPublish,undefined);
      }
      await store.transact(next=>{next.stillUsable=true;});
      assert.equal(store.read().stillUsable,true);
      await store.close();
      process.stdout.write('survived');
    `,
  });
  assert.equal(child.error,undefined);
  assert.equal(child.status,0,child.stderr);
  assert.equal(child.stdout,'survived');
});
