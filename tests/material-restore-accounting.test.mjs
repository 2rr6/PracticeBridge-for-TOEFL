import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startServer} from '../src/server.mjs';
import {createModels} from '../src/models.mjs';
import {readZip} from '../src/package.mjs';
import {appFetch} from './auth-client.mjs';
import ZipFixture from './helpers/zip-fixture.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
async function fixture(t,{lost=false}={}){
  const base=path.resolve('test-results/material-restore-accounting');await fs.mkdir(base,{recursive:true});const dataDir=await fs.mkdtemp(path.join(base,'run-')),entered=deferred(),release=deferred();let calls=0;
  const models=createModels({dataDir,fetchImpl:async(_url,options)=>{calls++;entered.resolve();if(lost)throw Error('Self-authored response loss; no actual network');await release.promise;const input=JSON.parse(JSON.parse(options.body).messages.at(-1).content);return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({proposals:input.questions.map(question=>({sourceId:question.sourceId,taskKind:question.taskKind,answerType:question.answerType,fields:{prompt:null,options:null,answer:null,explanation:null,transcript:null},evidence:[]}))})}}],usage:{prompt_tokens:300,completion_tokens:50}}));}});
  await models.updateSettings({provider:'compatible',baseUrl:'https://fixture.invalid/v1',model:'restore-accounting',structuredOutput:'json_object',maxOutputTokens:700});
  const app=await startServer({dataDir,models});t.after(async()=>{release.resolve();await app.close();assert.equal(path.dirname(path.resolve(dataDir)),base);await fs.rm(dataDir,{recursive:true,force:true});});
  const api=async(route,body)=>{const response=await appFetch(app.url+'/api'+route,{...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-PracticeBridge':'1'},body:JSON.stringify(body)})});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;};
  const backup=async()=>{const response=await appFetch(app.url+'/api/backup');assert.equal(response.status,200);const bytes=Buffer.from(await response.arrayBuffer());return {bytes,manifest:JSON.parse((await readZip(bytes)).get('practicebridge-backup.json'))};};
  const restore=bytes=>api('/restore',{file:{name:'authored-accounting-backup.zip',data:bytes.toString('base64')}}),empty=await backup();
  const pack={schemaVersion:1,title:'Authored accounting fixture',version:'1',groups:[{id:'g',section:'reading',taskKind:'read_daily',passage:'A notice says the blue door is open. The red door is closed.',questions:[{id:'q',type:'single_choice',prompt:'Which door is open?',options:[{id:'A',text:'Blue.'},{id:'B',text:'Red.'}],answer:null,explanation:''}]}]};
  const received=await api('/materials',{files:[{name:'authored.json',data:Buffer.from(JSON.stringify(pack)).toString('base64')}]}),route='/materials/'+received.material.id,description=await api(route+'/jobs'),scope={expectedEpoch:description.expectedEpoch,expectedBinding:description.binding};
  const preview=await api(route+'/jobs/prepare',{...scope,limits:{maxDurationMs:5000}}),started=await api(route+'/jobs/start',{...scope,previewId:preview.previewId,scopeDigest:preview.scopeDigest,consent:true});await entered.promise;
  return {app,dataDir,api,backup,restore,empty,jobId:started.job.jobId,release:release.resolve,calls:()=>calls,view:()=>app.materialJobs.view(started.job.jobId)};
}

test('restoring an old running backup repeatedly or through an empty workspace cannot charge offline time or revive a settled unknown outcome',async t=>{
  const f=await fixture(t);await new Promise(done=>setTimeout(done,10));
  const liveBefore=await fs.readFile(path.join(f.dataDir,'state.json')),running=await f.backup();assert.deepEqual(await fs.readFile(path.join(f.dataDir,'state.json')),liveBefore,'capturing elapsed time is a pure export calculation');
  assert.ok(running.manifest.state.materialJobs[f.jobId].run);
  f.release();await f.app.materialJobs.awaitIdle();const settled=f.view();assert.equal(settled.state,'completed');assert.equal(settled.unknownRequests,0);assert.ok(settled.budget.elapsedMs>0);
  for(let index=0;index<3;index++){
    await f.restore(running.bytes);const current=f.view();assert.deepEqual(current.budget,settled.budget,'no execution occurred after the known settlement');assert.equal(current.state,'interrupted');assert.equal(current.unknownRequests,0);assert.ok(current.chunks.every(chunk=>chunk.state!=='request_outcome_unknown'));assert.equal(f.calls(),1);
  }
  await f.restore(f.empty.bytes);await f.restore(running.bytes);assert.deepEqual(f.view().budget,settled.budget);assert.equal(f.view().state,'interrupted');assert.equal(f.view().unknownRequests,0);assert.equal(f.calls(),1);
});

test('restored claims of not_sent or zero usage cannot refund a locally observed unknown request',async t=>{
  const f=await fixture(t,{lost:true});await f.app.materialJobs.awaitIdle();const before=f.view(),original=await f.backup();assert.equal(before.unknownRequests,1);assert.equal(before.budget.requestCount,1);assert.ok(before.budget.unknownInput>0);
  for(const claimed of ['not_sent','settled']){
    const zip=await ZipFixture.from(original.bytes),manifest=structuredClone(original.manifest),job=manifest.state.materialJobs[f.jobId],request=job.requests[0],record=manifest.state.materialExecutionLedger.grants[f.jobId].requests[request.requestId];
    request.state=claimed;request.outcomeUnknown=false;request.usageKnown=claimed==='settled';request.usage=claimed==='settled'?{inputTokens:0,outputTokens:0}:null;request.code=null;record.state=claimed;record.usage=structuredClone(request.usage);
    job.state='failed';job.lastError=null;for(const chunk of job.chunks){chunk.state='failed';chunk.lastError=null;}
    for(const key of Object.keys(job.budget))if(!['elapsedMs','limits'].includes(key))job.budget[key]=0;job.budget.requestCount=claimed==='settled'?1:0;
    zip.updateFile('practicebridge-backup.json',Buffer.from(JSON.stringify(manifest)));await f.restore(zip.toBuffer());
    assert.deepEqual(f.view().budget,before.budget);assert.equal(f.view().unknownRequests,1);assert.equal(f.view().state,'request_outcome_unknown');assert.equal(f.calls(),1);
    const roundTrip=await f.backup(),live=roundTrip.manifest.state.materialJobs[f.jobId].requests[0];assert.equal(live.state,'outcome_unknown');assert.equal(live.outcomeUnknown,true);assert.equal(live.usageKnown,false);
  }
  await f.restore(f.empty.bytes);await f.restore(original.bytes);assert.deepEqual(f.view().budget,before.budget);assert.equal(f.view().unknownRequests,1);assert.equal(f.calls(),1);
});
