import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createModels} from '../src/models.mjs';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {readdir,writeFile} from 'node:fs/promises';

test('system store encrypts, binds ciphertext to its service, preserves old data on failure and deletes',async t=>{
 const {createSecretStore}=await import('../desktop/secret-store.cjs');
 const directory=await mkdtemp(path.join(os.tmpdir(),'pb-vault-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const key=randomBytes(32);let failEncryption=false;
 const safeStorage={isAsyncEncryptionAvailable:async()=>true,encryptStringAsync:async text=>{if(failEncryption)throw Error('private failure');const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,c.update(text),c.final(),c.getAuthTag()]);},decryptStringAsync:async bytes=>{const c=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));c.setAuthTag(bytes.subarray(-16));return {result:Buffer.concat([c.update(bytes.subarray(12,-16)),c.final()]).toString(),shouldReEncrypt:false};}};
 const store=createSecretStore({directory,safeStorage,platform:'win32'});
 assert.equal((await store.save('compatible\nhttps://example.invalid/v1','SENTINEL-OS')).saved,true);
 let [file]=await readdir(directory);const encrypted=await readFile(path.join(directory,file));assert.equal(encrypted.includes(Buffer.from('SENTINEL-OS')),false);
 assert.equal(await createSecretStore({directory,safeStorage,platform:'win32'}).load('compatible\nhttps://example.invalid/v1'),'SENTINEL-OS');
 failEncryption=true;assert.equal((await store.save('compatible\nhttps://example.invalid/v1','NEW')).saved,false);assert.deepEqual(await readFile(path.join(directory,file)),encrypted);
 failEncryption=false;await store.save('compatible\nhttps://example.invalid/v2','OTHER');const other=(await readdir(directory)).find(x=>x!==file);await writeFile(path.join(directory,other),encrypted);
 await assert.rejects(store.load('compatible\nhttps://example.invalid/v2'),/无法读取/);
 assert.equal((await store.delete('compatible\nhttps://example.invalid/v1')).deleted,true);assert.equal(await store.load('compatible\nhttps://example.invalid/v1'),null);
 assert.equal((await createSecretStore({directory,safeStorage:{...safeStorage,getSelectedStorageBackend:()=> 'basic_text'},platform:'linux'}).capabilities()).available,false);
});

test('explicit encrypted save restores on restart while session-only deletes the saved slot',async t=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'pb-secret-'));
 t.after(()=>rm(dataDir,{recursive:true,force:true}));
 const slots=new Map();
 const secretStore={capabilities:async()=>({available:true}),load:async k=>slots.get(k)||null,save:async(k,v)=>{slots.set(k,v);return {saved:true};},delete:async k=>{slots.delete(k);return {deleted:true};}};
 let models=createModels({dataDir,secretStore});await models.ready;
 await models.updateSettings({provider:'openai',baseUrl:'https://api.openai.com/v1',model:'synthetic',apiKey:'SENTINEL-T09',credentialMode:'encrypted'});
 assert.equal(slots.size,1);
 assert.equal((await readFile(path.join(dataDir,'model-settings.json'),'utf8')).includes('SENTINEL-T09'),false);
 models=createModels({dataDir,secretStore});await models.ready;
 assert.equal(models.publicSettings().hasApiKey,true);
 await models.updateSettings({model:'another'});assert.equal(models.publicSettings().hasApiKey,true);
 await models.updateSettings({credentialMode:'session'});assert.equal(slots.size,0);assert.equal(models.publicSettings().hasApiKey,true);
 await models.updateSettings({clearApiKey:true});assert.equal(models.publicSettings().hasApiKey,false);
});

test('failed saves keep the session usable and failed deletion truthfully clears memory; slow loads cannot replace edits',async t=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'pb-secret-fail-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 let release;const loading=new Promise(r=>{release=r;});let sent;
 const secretStore={capabilities:async()=>({available:true}),load:async()=>{await loading;return 'OLD';},save:async()=>({saved:false}),delete:async()=>({deleted:false})};
 const models=createModels({dataDir,secretStore,fetchImpl:async(url,options)=>{sent=options;return new Response(JSON.stringify({output_text:'OK'}));}});
 assert.equal(models.publicSettings().credential.state,'loading');
 const edit=models.updateSettings({provider:'openai',model:'synthetic',apiKey:'SENTINEL-NEW',credentialMode:'encrypted'});release();await edit;
 assert.equal(models.publicSettings().credential.state,'failed');assert.equal(models.publicSettings().hasApiKey,true);
 await models.test({consent:true});assert.equal(sent.headers.Authorization,'Bearer SENTINEL-NEW');assert.equal(sent.body.includes('SENTINEL-NEW'),false);
 await models.updateSettings({clearApiKey:true});assert.equal(models.publicSettings().hasApiKey,false);assert.equal(models.publicSettings().credential.state,'failed');assert.match(models.publicSettings().credential.detail,/删除失败/);
});

test('clearing credentials rejects even a late provider response that ignores cancellation',async t=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'pb-secret-cancel-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 let release,started;const entered=new Promise(r=>{started=r;});
 const models=createModels({dataDir,fetchImpl:async()=>{started();return new Promise(r=>{release=()=>r(new Response(JSON.stringify({output_text:'OK'})));});}});
 await models.updateSettings({provider:'openai',model:'synthetic',apiKey:'SENTINEL'});
 const pending=models.test({consent:true});await entered;
 await models.updateSettings({clearApiKey:true});release();
 await assert.rejects(pending,error=>error.code==='model_cancelled');
});

test('encryption selection without a key preserves keyless compatible and disabled model settings',async t=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'pb-secret-keyless-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 const secretStore={capabilities:async()=>({available:true}),load:async()=>null,save:async()=>{throw Error('must not store an empty secret');},delete:async()=>({deleted:true})};
 const models=createModels({dataDir,secretStore});
 for(const provider of ['none','compatible']){
  const result=await models.updateSettings({provider,model:'synthetic',credentialMode:'encrypted'});
  assert.equal(result.credential.state,'ready');assert.equal(result.credential.saved,false);
 }
});
