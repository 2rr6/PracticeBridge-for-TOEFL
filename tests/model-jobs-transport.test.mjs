import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createModels} from '../src/models.mjs';

const root=path.resolve('test-results/model-job-transport');
const schema={name:'source_proposal',schema:{type:'object',additionalProperties:false,required:['text'],properties:{text:{type:'string'}}}};
const messages=[{role:'system',content:'Extract selected source only.'},{role:'user',content:'Repeated shared passage. Question 1.'}];
const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const stopped=(text='{"text":"source"}',usage={prompt_tokens:100,completion_tokens:20})=>response({choices:[{finish_reason:'stop',message:{content:text}}],usage});
async function fixture(t,fetchImpl,options={}){await fs.mkdir(root,{recursive:true});const dataDir=await fs.mkdtemp(path.join(root,'case-'));t.after(async()=>{assert.ok(path.resolve(dataDir).startsWith(root+path.sep));await fs.rm(dataDir,{recursive:true,force:true});});const models=createModels({dataDir,fetchImpl,...options});await models.updateSettings({provider:'compatible',baseUrl:'https://example.test/v1',model:'self-authored-double',apiKey:'not-a-real-key',structuredOutput:'json_object',maxOutputTokens:700});return models;}
const prepare=models=>models.prepareStructured({messages,schema,expectedBinding:models.binding(),outputLimit:500});

test('prepared estimate covers actual JSON-mode augmentation and send uses exactly the frozen body',async t=>{
  let sent,calls=0;const models=await fixture(t,async(url,options)=>{calls++;sent=JSON.parse(options.body);return stopped();});
  const prepared=await prepare(models);assert.equal(calls,0);
  assert.ok(prepared.requestArtifact.messages[0].content.includes('JSON Schema'));
  assert.ok(prepared.inputEstimate.tokens>=Buffer.byteLength(JSON.stringify(prepared.requestArtifact)));
  prepared.requestArtifact.messages[0].content='MUTATED';
  const output=await models.sendPrepared(prepared.handle,{consent:true});
  assert.equal(output.kind,'completed');assert.equal(output.usageKnown,true);assert.deepEqual(output.usage,{inputTokens:100,outputTokens:20});
  assert.notEqual(sent.messages[0].content,'MUTATED');assert.equal(sent.max_tokens,500);assert.deepEqual(sent.tools,[]);
  assert.equal(JSON.stringify(prepared).includes('not-a-real-key'),false);
  await assert.rejects(models.sendPrepared(prepared.handle,{consent:true}),/已使用|无效/);
});

test('prepared jobs and invocation-scoped ordinary chat reject key/model/binding changes before fetch',async t=>{
  let calls=0;const models=await fixture(t,async()=>{calls++;return stopped();});
  const prepared=await prepare(models),oldBinding=models.binding();
  await models.updateSettings({apiKey:'replacement-not-real'});
  assert.notEqual(models.binding().credentialVersion,oldBinding.credentialVersion);
  const output=await models.sendPrepared(prepared.handle,{consent:true});assert.equal(output.code,'binding_changed');assert.equal(output.requestStarted,false);assert.equal(calls,0);
  await assert.rejects(models.chat({message:'old consent',consent:true,expectedBinding:oldBinding}),error=>error.code==='binding_changed');assert.equal(calls,0);
  const next=await prepare(models);await models.updateSettings({model:'another-model'});
  assert.equal((await models.sendPrepared(next.handle,{consent:true})).code,'binding_changed');assert.equal(calls,0);
});

test('structured transport never sends without explicit consent and does not let callers invent a handle',async t=>{
  let calls=0;const models=await fixture(t,async()=>{calls++;return stopped();});
  const p=await prepare(models);const result=await models.sendPrepared(p.handle,{consent:false});
  assert.equal(result.code,'consent_required');assert.equal(result.requestStarted,false);assert.equal(calls,0);
  await assert.rejects(models.sendPrepared({}, {consent:true}),/无效/);
  await assert.rejects(models.prepareStructured({messages,schema}),error=>error.status===428);
});

test('outer metadata keeps length, tool calls, refusal, empty, HTTP and malformed JSON distinct',async t=>{
  const cases=[
    [()=>response({choices:[{finish_reason:'length',message:{content:'{"text":'}}],usage:{prompt_tokens:101,completion_tokens:500}}),'length',true],
    [()=>response({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{function:{name:'shell',arguments:'rm'}}]}}]}),'unsupported_tool_calls',false],
    [()=>response({choices:[{finish_reason:'stop',message:{refusal:'untrusted provider content'}}]}),'refusal',false],
    [()=>stopped(''),'empty',true],
    [()=>response({error:{message:'secret must not escape'}},429),'http_error',false],
    [()=>response({error:{message:'secret must not escape'}},401),'http_error',false],
    [()=>new Response('{bad'),'invalid_envelope',false],
  ];
  for(const [reply,kind,known] of cases){const models=await fixture(t,async()=>reply());const p=await prepare(models),out=await models.sendPrepared(p.handle,{consent:true});assert.equal(out.kind,kind);assert.equal(out.usageKnown,known);assert.equal(JSON.stringify(out).includes('secret must not escape'),false);assert.equal(JSON.stringify(out).includes('rm'),false);if(kind==='http_error')assert.ok([429,401].includes(out.httpStatus));}
});

test('Responses strict schema retains usage and refusal/incomplete reason without switching endpoint',async t=>{
  let body,url;const models=await fixture(t,async(u,o)=>{url=u;body=JSON.parse(o.body);return response({status:'incomplete',incomplete_details:{reason:'max_output_tokens'},usage:{input_tokens:9,output_tokens:500},output:[{type:'message',content:[{type:'output_text',text:'{"text":'}]}]});});
  await models.updateSettings({provider:'openai',baseUrl:'https://api.openai.com/v1',apiKey:'official-test-only'});
  const p=await prepare(models),out=await models.sendPrepared(p.handle,{consent:true});assert.equal(out.kind,'length');assert.deepEqual(out.usage,{inputTokens:9,outputTokens:500});assert.equal(body.text.format.strict,true);assert.equal(url,'https://api.openai.com/v1/responses');
});

test('lost response and deadline timeout retain unknown outcome; late ignored-abort success is not candidate output',async t=>{
  const models=await fixture(t,async()=>{throw new TypeError('private network diagnostic');});
  const p=await prepare(models),out=await models.sendPrepared(p.handle,{consent:true});assert.equal(out.kind,'network_error');assert.equal(out.outcomeUnknown,true);assert.equal(out.requestStarted,true);assert.equal(out.usage,null);assert.equal(JSON.stringify(out).includes('private network'),false);
  const waiting=await fixture(t,()=>new Promise(()=>{}));const w=await prepare(waiting);
  const timed=await waiting.sendPrepared(w.handle,{consent:true,deadlineAt:Date.now()+20});assert.equal(timed.kind,'timeout');assert.equal(timed.outcomeUnknown,true);
  let release;const delayed=await fixture(t,()=>new Promise(resolve=>{release=resolve;}));const d=await prepare(delayed);const sent=delayed.sendPrepared(d.handle,{consent:true});
  await new Promise(resolve=>setImmediate(resolve));delayed.cancelRequests('workspace_restore');release(stopped());
  const cancelled=await sent;assert.equal(cancelled.kind,'cancelled');assert.equal(cancelled.text,undefined);
});

test('host request scope is rechecked after preparation before every actual API dispatch',async t=>{
  let current=true,calls=0;const models=await fixture(t,async()=>{calls++;return stopped();},{assertRequestScope:()=>{if(!current)throw Object.assign(new Error('old workspace scope'),{status:409});}});
  const prepared=await prepare(models);current=false;
  const result=await models.sendPrepared(prepared.handle,{consent:true});assert.equal(result.requestStarted,false);assert.equal(result.code,'request_scope_changed');
  await assert.rejects(models.chat({message:'late old payload',consent:true,expectedBinding:models.binding()}),/old workspace scope/);assert.equal(calls,0);
});
