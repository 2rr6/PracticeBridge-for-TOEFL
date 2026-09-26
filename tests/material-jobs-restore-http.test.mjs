import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startServer} from '../src/server.mjs';
import {createModels} from '../src/models.mjs';
import {readZip} from '../src/package.mjs';
import {appFetch} from './auth-client.mjs';

test('real job ZIP restore retains newer known and unknown charges, exact earlier checkpoints, and requires explicit Continue',async t=>{
  const base=path.resolve('test-results/material-jobs-restore-http');await fs.mkdir(base,{recursive:true});const dataDir=await fs.mkdtemp(path.join(base,'run-'));let calls=0;
  const models=createModels({dataDir,fetchImpl:async(_url,options)=>{
    calls++;if(calls===3)return new Response('',{status:401});if(calls===5)throw Error('Self-authored fixture loses the response after request admission');
    const wire=JSON.parse(options.body),input=JSON.parse(wire.messages.at(-1).content);
    const proposals=input.questions.map(question=>({sourceId:question.sourceId,taskKind:question.taskKind,answerType:question.answerType,fields:{prompt:null,options:null,answer:null,explanation:null,transcript:null},evidence:[]}));
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({proposals})}}],usage:{prompt_tokens:300,completion_tokens:50}}));
  }});
  await models.updateSettings({provider:'compatible',baseUrl:'https://authored.invalid/v1',model:'scoped-protocol-only',structuredOutput:'json_object',maxOutputTokens:700});
  const app=await startServer({dataDir,models});t.after(async()=>{await app.close();assert.equal(path.dirname(path.resolve(dataDir)),base);await fs.rm(dataDir,{recursive:true,force:true});});
  const post=async(route,body)=>{const response=await appFetch(app.url+route,{method:'POST',headers:{'Content-Type':'application/json','X-PracticeBridge':'1'},body:JSON.stringify(body)});const value=await response.json();return {response,value};};
  const get=async route=>{const response=await appFetch(app.url+route);assert.equal(response.status,200);return response.json();};
  const backup=async()=>{const response=await appFetch(app.url+'/api/backup');assert.equal(response.status,200,await response.clone().text());const bytes=Buffer.from(await response.arrayBuffer());return {bytes,manifest:JSON.parse((await readZip(bytes)).get('practicebridge-backup.json'))};};
  const restore=bytes=>post('/api/restore',{file:{name:'authored-job-backup.zip',data:bytes.toString('base64')}});
  const empty=await backup();
  const pack={schemaVersion:1,id:'authored-restore-jobs',title:'Authored restore jobs',version:'1',groups:[1,2,3,4].map(n=>({id:'g'+n,title:'Task '+n,section:'reading',taskKind:'read_daily',passage:'The complete shared article for gate '+n+' remains intact.',questions:[{id:'q'+n,type:'single_choice',prompt:'When does gate '+n+' open?',options:[{id:'A',text:'At nine.'},{id:'B',text:'At ten.'}],answer:null,explanation:''}]}))};
  const received=await post('/api/materials',{files:[{name:'authored-jobs.json',data:Buffer.from(JSON.stringify(pack)).toString('base64')}]});assert.equal(received.response.status,200);
  const materialId=received.value.material.id,route='/api/materials/'+materialId,initial=await get(route+'/jobs'),scope={expectedEpoch:initial.expectedEpoch,expectedBinding:initial.binding};
  const ocrSummary=await get(route+'/ocr');assert.equal(ocrSummary.materialId,materialId);assert.deepEqual(ocrSummary.entries,[]);assert.equal(calls,0,'OCR summary is a local metadata operation');
  const preview=await post(route+'/jobs/prepare',scope);assert.equal(preview.response.status,200,JSON.stringify(preview.value));
  const started=await post(route+'/jobs/start',{...scope,previewId:preview.value.previewId,scopeDigest:preview.value.scopeDigest,consent:true});assert.equal(started.response.status,202,JSON.stringify(started.value));const jobId=started.value.job.jobId;
  await app.materialJobs.awaitIdle();assert.equal(calls,3);const older=await backup(),oldJob=older.manifest.state.materialJobs[jobId],completed=oldJob.chunks.filter(chunk=>chunk.state==='completed').map(chunk=>chunk.checkpointRef);assert.equal(completed.length,2);
  const continued=await post(route+'/jobs/'+jobId+'/continue',{...scope,expectedGeneration:oldJob.generation,consent:true});assert.equal(continued.response.status,202,JSON.stringify(continued.value));await app.materialJobs.awaitIdle();assert.equal(calls,5);
  const newer=await backup(),spent=newer.manifest.state.materialJobs[jobId].budget;assert.equal(spent.requestCount,5);assert.equal(app.materialJobs.view(jobId).unknownRequests,1);
  const restored=await restore(older.bytes);assert.equal(restored.response.status,200,JSON.stringify(restored.value));
  let current=(await get(route+'/jobs')).jobs.find(job=>job.jobId===jobId);assert.notEqual(current.workspaceEpoch,scope.expectedEpoch);assert.equal(current.budget.requestCount,5);assert.deepEqual(current.budget,spent);assert.equal(current.unknownRequests,1,'ledger-only lost response must require fresh acknowledgement');assert.equal(calls,5);
  assert.deepEqual(current.chunks.filter(chunk=>chunk.state==='completed').map(chunk=>chunk.checkpointRef),completed);
  const incompleteAck=await post(route+'/jobs/'+jobId+'/continue',{expectedEpoch:current.workspaceEpoch,expectedBinding:initial.binding,expectedGeneration:current.generation,consent:true});assert.equal(incompleteAck.response.status,400);assert.equal(calls,5);
  const stale=await post(route+'/jobs/'+jobId+'/continue',{...scope,expectedGeneration:oldJob.generation,consent:true,acknowledgeUnknown:true});assert.equal(stale.response.status,409);assert.equal(calls,5);
  // A replacement with no material/job must not erase the grant. Restoring the
  // same earlier job again still sees executions absent from that backup.
  assert.equal((await restore(empty.bytes)).response.status,200);assert.equal((await get('/api/state')).materials.length,0);assert.equal(calls,5);
  assert.equal((await restore(older.bytes)).response.status,200);current=(await get(route+'/jobs')).jobs.find(job=>job.jobId===jobId);assert.equal(current.budget.requestCount,5);assert.equal(current.unknownRequests,1);
  const finish=await post(route+'/jobs/'+jobId+'/continue',{expectedEpoch:current.workspaceEpoch,expectedBinding:initial.binding,expectedGeneration:current.generation,consent:true,acknowledgeUnknown:true});assert.equal(finish.response.status,202,JSON.stringify(finish.value));await app.materialJobs.awaitIdle();assert.equal(calls,7);
  const final=await backup(),finalJob=final.manifest.state.materialJobs[jobId];assert.equal(finalJob.state,'completed');assert.equal(finalJob.budget.requestCount,7);assert.equal(finalJob.requests.length,5,'restored learning checkpoints and retained execution ledger have distinct scopes');assert.deepEqual(finalJob.chunks.slice(0,2).map(chunk=>chunk.checkpointRef),completed);
  assert.equal(Object.keys(final.manifest.state.materialExecutionLedger.grants[jobId].requests).length,7);
  for(const checkpoint of finalJob.chunks.map(chunk=>chunk.checkpointRef))assert.ok(checkpoint&&Object.hasOwn(final.manifest.processingArtifacts,checkpoint),'all completed checkpoints belong to the exported CAS closure');
});
