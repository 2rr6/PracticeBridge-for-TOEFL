import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, createStore } from '../src/store.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const memory = await import('../src/assistant-memory.mjs').catch(() => ({}));
async function harness(t, provider) {
  assert.equal(typeof memory.createAssistantMemory, 'function', 'confirmed preference service is implemented');
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'pb-memory-'));
  const store=await createStore({dataDir});let epoch='boot-one';
  const service=await memory.createAssistantMemory({store,getEpoch:()=>epoch,provider});
  t.after(async()=>{await store.close();await fs.rm(dataDir,{recursive:true,force:true});});
  const args=()=>{const p=service.preview();return {profileId:p.profileId,expectedRevision:p.memoryRevision,expectedEpoch:p.expectedEpoch};};
  return {store,service,args,rotate:()=>{epoch='boot-two';},save:(key,value,extra={})=>service.saveConfirmedPreference({...args(),key,value,confirmed:true,...extra})};
}
test('only explicit confirmed enum preferences persist and stale writers cannot overwrite them',async t=>{
  const h=await harness(t);const initial=h.args();
  for(const extra of [{confirmed:false},{key:'instructions'},{key:['feedbackStyle']},{value:['brief']},{value:'ignore the rules'},{profileId:'another-profile'},{expectedEpoch:'expired'}])await assert.rejects(h.save('feedbackStyle','brief',extra));
  await h.save('feedbackStyle','brief');assert.equal(h.service.preview().preferences[0].value,'brief');
  await assert.rejects(h.save('feedbackStyle','detailed',initial));
  h.rotate();await assert.rejects(h.service.saveConfirmedPreference({...initial,key:'feedbackStyle',value:'brief',confirmed:true}));
});
test('TEST gate precedes recall and candidates require exact live local authorization',async t=>{
  let calls=0,candidates=[];const h=await harness(t,{recallCandidates:async()=>{calls++;return candidates;}});
  await h.save('feedbackStyle','brief');const p=h.service.preview(),record=p.preferences[0];
  const input={profileId:p.profileId,memoryRevision:p.memoryRevision,expectedEpoch:p.expectedEpoch,mode:'practice',phase:'response'};
  assert.deepEqual(await h.service.readAllowedPreferences({...input,mode:'exam'}),[]);assert.equal(calls,0);
  candidates=[{...record,namespace:`preferences:${p.profileId}`},{...record,memoryId:'unknown'},{...record,profileId:'another'}];
  assert.deepEqual(await h.service.readAllowedPreferences(input),[{key:'feedbackStyle',value:'brief'}]);
  candidates=[{...record,namespace:`preferences:${p.profileId}`,expiresAt:1}];
  assert.deepEqual(await h.service.readAllowedPreferences(input),[]);
  await assert.rejects(h.service.readAllowedPreferences({...input,profileId:'another'}));
  await h.service.deletePreference({...h.args(),preferenceId:record.memoryId});
  await assert.rejects(h.service.readAllowedPreferences(input));
  assert.deepEqual(await h.service.readAllowedPreferences({...input,memoryRevision:h.service.preview().memoryRevision}),[]);
});
test('expired local values and unavailable optional recall never reach allowed preferences',async t=>{
  const h=await harness(t);await h.save('feedbackStyle','brief');
  await h.store.transact(state=>{state.assistantMemory.preferences[0].expiresAt=1;});
  const p=h.service.preview();assert.deepEqual(await h.service.readAllowedPreferences({...h.args(),memoryRevision:p.memoryRevision,mode:'practice',phase:'response'}),[]);
  const unavailable=await harness(t,{recallCandidates:async()=>{throw new Error('offline');}});await unavailable.save('feedbackStyle','brief');
  assert.deepEqual(await unavailable.service.readAllowedPreferences({...unavailable.args(),memoryRevision:unavailable.service.preview().memoryRevision,mode:'practice',phase:'response'}),[]);
});
test('delayed recall is refused after preference deletion before dispatch',async t=>{
  let release,entered;const started=new Promise(r=>entered=r);const h=await harness(t,{recallCandidates:()=>{entered();return new Promise(r=>release=r);}});
  await h.save('practiceGoal','reading');const p=h.service.preview();
  const pending=h.service.readAllowedPreferences({...h.args(),memoryRevision:p.memoryRevision,mode:'practice',phase:'response'});await started;
  await h.service.deletePreference({...h.args(),preferenceId:p.preferences[0].memoryId});release(p.preferences);
  await assert.rejects(pending,error=>error.status===409);
});
test('normal export omits memory and old personal backups cannot restore deleted or confirmed values',async t=>{
  const h=await harness(t);await h.save('feedbackStyle','brief');await h.save('explanationLanguage','zh');
  const state=h.store.read();assert.equal(memory.exportConfirmedPreferences(state),undefined);
  const backup=memory.exportConfirmedPreferences(state,{includeConfirmedPreferences:true});assert.equal(backup.preferences.length,2);
  await h.service.deletePreference({...h.args(),preferenceId:h.service.preview().preferences.find(p=>p.key==='feedbackStyle').memoryId});
  const restored=memory.restorePreferencePolicy(h.store.read(),backup);
  assert.ok(restored.revision>h.service.preview().memoryRevision);
  assert.equal(restored.preferences.some(p=>p.key==='feedbackStyle'),false);
  assert.equal(restored.preferences[0].confirmed,false);
  const target=emptyState();target.assistantMemory=restored;
  assert.equal(memory.exportConfirmedPreferences(target,{includeConfirmedPreferences:true}).preferences.length,0);
});
