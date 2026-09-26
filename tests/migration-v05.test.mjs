import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {startServer} from '../src/server.mjs';
import {readZip} from '../src/package.mjs';
import {appFetch} from './auth-client.mjs';
import ZipFixture from './helpers/zip-fixture.mjs';
import {inspectProcessingSnapshot,readProcessingBytes} from '../src/processing-backup.mjs';

const root=path.resolve('test-results/migration-v05'),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const upload=(name,bytes)=>({name,data:bytes.toString('base64')});
function wav(){const b=Buffer.alloc(16044);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(16000,40);return b;}
async function harness(t){
  await fs.mkdir(root,{recursive:true});const dataDir=await fs.mkdtemp(path.join(root,'run-')),instance=await startServer({dataDir});
  t.after(async()=>{await instance.close();assert.ok(path.resolve(dataDir).startsWith(root+path.sep));await fs.rm(dataDir,{recursive:true,force:true});});
  const state=()=>fs.readFile(path.join(dataDir,'state.json')).then(b=>JSON.parse(b));
  const post=async(route,body)=>{const r=await appFetch(instance.url+'/api'+route,{method:'POST',headers:{'X-PracticeBridge':'1','Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  const ok=async(route,body)=>{const result=await post(route,body);assert.equal(result.status,200,JSON.stringify(result));return result.body;};
  const backup=async()=>{const r=await fetch(instance.url+'/api/backup');assert.equal(r.status,200,await r.clone().text());return Buffer.from(await r.arrayBuffer());};
  const restore=bytes=>post('/restore',{file:upload('self-authored-backup.zip',bytes)});
  return {instance,dataDir,state,post,ok,backup,restore};
}
async function candidateFixture(h){
  const sound=wav(),question=(id,extra={})=>({id,type:'single_choice',prompt:'Choose the flag color.',options:[{id:'A',text:'Blue'},{id:'B',text:'Red'}],answer:'A',...extra});
  const pack={schemaVersion:1,id:'restore-source',version:'1',title:'Self-authored restore source',groups:[{id:'notice',title:'Complete notice',section:'reading',taskKind:'read_daily',passage:'The flag is blue. Keep this entire shared passage.',questions:[question('first'),question('second',{audio:'second.wav'})]}]};
  const {material}=await h.ok('/materials',{files:[upload('practicebridge.json',Buffer.from(JSON.stringify(pack))),upload('second.wav',sound)]});
  await h.ok(`/materials/${material.id}/assess`,{useAI:false});await h.ok(`/materials/${material.id}/convert`,{useAI:false});
  let state=await h.state(),set=state.candidateSets[material.id],first=set.candidates[0];
  await h.ok(`/materials/${material.id}/candidates/${first.candidateId}/patch`,{expectedRevision:first.revision,expectedEpoch:state.workspaceEpoch,fields:{prompt:'Human-corrected question.'}});
  state=await h.state();set=state.candidateSets[material.id];first=set.candidates[0];
  const compilation={sourceRevision:set.sourceRevision,selectedIds:[first.candidateId],candidateRevisions:{[first.candidateId]:first.revision},expectedEpoch:state.workspaceEpoch,importOperationId:'initial-subset'};
  await h.ok(`/materials/${material.id}/compile`,compilation);
  state=await h.state();assert.equal(state.blobs[hash(sound)],undefined,'unselected candidate media is outside the old library blob index');
  return {materialId:material.id,soundId:hash(sound),compilation};
}

test('v0.5 backup retains candidate history, subset lineage, receipts and unselected media',async t=>{
  const h=await harness(t),fixture=await candidateFixture(h),before=await h.state();
  const bytes=await h.backup(),files=await readZip(bytes),manifest=JSON.parse(files.get('practicebridge-backup.json'));
  assert.equal(manifest.version,2);assert.equal(manifest.state.schemaVersion,2);
  assert.ok(files.has('blobs/'+fixture.soundId));assert.ok(files.has('processing-artifacts/'+before.candidateSets[fixture.materialId].history[0].candidates[0].ref));
  await h.ok('/materials',{text:'This later work belongs in the automatic pre-restore backup.'});
  const restored=await h.restore(bytes);assert.equal(restored.status,200,JSON.stringify(restored));const after=await h.state();
  assert.notEqual(after.workspaceEpoch,before.workspaceEpoch);assert.deepEqual(after.candidateSets,before.candidateSets);assert.deepEqual(after.importReceipts,before.importReceipts);assert.deepEqual(after.libraries,before.libraries);
  assert.equal(after.blobs[fixture.soundId].id,fixture.soundId);assert.deepEqual(await fs.readFile(path.join(h.dataDir,'blobs',fixture.soundId)),wav());
  const deduplicated=await h.ok(`/materials/${fixture.materialId}/compile`,{...fixture.compilation,expectedEpoch:after.workspaceEpoch,importOperationId:'new-page-dedup'});assert.equal(deduplicated.receipt.added,0);assert.equal((await h.state()).libraries.length,1);
  const snapshots=await fs.readdir(path.join(h.dataDir,'backups'));assert.equal(snapshots.length,1);const previous=JSON.parse((await readZip(await fs.readFile(path.join(h.dataDir,'backups',snapshots[0])))).get('practicebridge-backup.json'));assert.equal(previous.state.materials.length,2);assert.deepEqual(previous.state.candidateSets,before.candidateSets);
});

test('missing historical CAS, missing pending media, tampered bytes and forged lineage refuse atomically',async t=>{
  const h=await harness(t),fixture=await candidateFixture(h),before=await h.state(),bytes=await h.backup();
  const statePath=path.join(h.dataDir,'state.json'),original=await fs.readFile(statePath),historical=before.candidateSets[fixture.materialId].history[0].candidates[0].ref;
  const cases=[
    zip=>zip.deleteFile('processing-artifacts/'+historical),
    zip=>zip.deleteFile('blobs/'+fixture.soundId),
    zip=>zip.updateFile('processing-artifacts/'+historical,Buffer.from('{"tampered":true}')),
    zip=>{const manifest=JSON.parse(zip.getEntry('practicebridge-backup.json').getData());manifest.state.libraries[0].lineage.candidates[0].revision=999;zip.updateFile('practicebridge-backup.json',Buffer.from(JSON.stringify(manifest)));},
    zip=>{const manifest=JSON.parse(zip.getEntry('practicebridge-backup.json').getData());manifest.state.modelSettings={apiKey:'SYNTHETIC_UNDECLARED_SETTING'};zip.updateFile('practicebridge-backup.json',Buffer.from(JSON.stringify(manifest)));},
    zip=>{const manifest=JSON.parse(zip.getEntry('practicebridge-backup.json').getData());manifest.state.materialJobs=[];zip.updateFile('practicebridge-backup.json',Buffer.from(JSON.stringify(manifest)));},
    zip=>{const manifest=JSON.parse(zip.getEntry('practicebridge-backup.json').getData());delete manifest.state.materialJobs;zip.updateFile('practicebridge-backup.json',Buffer.from(JSON.stringify(manifest)));},
    zip=>{const manifest=JSON.parse(zip.getEntry('practicebridge-backup.json').getData());manifest.state.importReceipts['initial-subset'].receipt.selectionKey='f'.repeat(64);zip.updateFile('practicebridge-backup.json',Buffer.from(JSON.stringify(manifest)));},
    zip=>{const manifest=JSON.parse(zip.getEntry('practicebridge-backup.json').getData()),stored=manifest.state.importReceipts['initial-subset'];stored.receipt.added=2;stored.receipt.selected=2;stored.completeness.selected=2;zip.updateFile('practicebridge-backup.json',Buffer.from(JSON.stringify(manifest)));},
  ];
  for(const change of cases){const zip=await ZipFixture.from(bytes);change(zip);const result=await h.restore(zip.toBuffer());assert.equal(result.status,400,JSON.stringify(result));assert.deepEqual(await fs.readFile(statePath),original);}
});

test('legacy v1 backups still restore without inventing candidate history',async t=>{
  const h=await harness(t);await h.ok('/materials',{text:'Self-authored original legacy material.'});
  const files=await readZip(await h.backup()),manifest=JSON.parse(files.get('practicebridge-backup.json'));
  manifest.version=1;manifest.state.schemaVersion=1;for(const key of ['workspaceEpoch','candidateSets','importReceipts','materialJobs'])delete manifest.state[key];delete manifest.processingArtifacts;
  const zip=new ZipFixture();for(const [name,bytes] of files)if(!name.startsWith('processing-artifacts/'))zip.addFile(name,name==='practicebridge-backup.json'?Buffer.from(JSON.stringify(manifest)):bytes);
  assert.equal((await h.restore(zip.toBuffer())).status,200);const after=await h.state();assert.equal(after.materials[0].text,'Self-authored original legacy material.');assert.deepEqual(after.candidateSets,{});assert.deepEqual(after.importReceipts,{});
});

test('a backup reference snapshot stays fixed while a candidate writer publishes a new revision',async t=>{
  const h=await harness(t),fixture=await candidateFixture(h),snapshot=await h.state(),set=snapshot.candidateSets[fixture.materialId];
  let signalEntered,release;const entered=new Promise(resolve=>signalEntered=resolve),held=new Promise(resolve=>release=resolve);
  const pending=inspectProcessingSnapshot(snapshot,{readBytes:async ref=>{if(ref===set.artifactIndexRef){signalEntered();await held;}return readProcessingBytes(h.dataDir,ref);}});
  await entered;
  try{await h.ok(`/materials/${fixture.materialId}/candidates/${set.candidates[0].candidateId}/patch`,{expectedEpoch:snapshot.workspaceEpoch,expectedRevision:set.candidates[0].revision,fields:{prompt:'A concurrent revision after backup captured its roots.'}});}finally{release();}
  const current=await h.state(),captured=await pending,newRef=current.candidateSets[fixture.materialId].candidates[0].ref;
  assert.notEqual(newRef,set.candidates[0].ref);assert.equal(captured.files.has(set.candidates[0].ref),true);assert.equal(captured.files.has(newRef),false);
});

test('zero-added receipts may cover a subset or several previously imported libraries',async t=>{
  const h=await harness(t),fixture=await candidateFixture(h);let state=await h.state();const set=state.candidateSets[fixture.materialId],second=set.candidates[1];
  await h.ok(`/materials/${fixture.materialId}/compile`,{sourceRevision:set.sourceRevision,selectedIds:[second.candidateId],candidateRevisions:{[second.candidateId]:second.revision},expectedEpoch:state.workspaceEpoch,importOperationId:'second-subset'});
  const joined=await h.ok(`/materials/${fixture.materialId}/compile`,{sourceRevision:set.sourceRevision,selectedIds:set.candidates.map(c=>c.candidateId),candidateRevisions:Object.fromEntries(set.candidates.map(c=>[c.candidateId,c.revision])),expectedEpoch:state.workspaceEpoch,importOperationId:'joined-dedup'});
  const single=await h.ok(`/materials/${fixture.materialId}/compile`,{...fixture.compilation,importOperationId:'single-dedup'});
  assert.equal(joined.receipt.added,0);assert.equal(joined.receipt.libraryIds.length,2);assert.equal(single.receipt.added,0);
  state=await h.state();assert.notEqual(joined.receipt.selectionKey,state.libraries.find(l=>l.libraryId===joined.receipt.libraryId).lineage.selectionKey);
  assert.equal((await h.restore(await h.backup())).status,200);assert.deepEqual((await h.state()).importReceipts,state.importReceipts);
});
