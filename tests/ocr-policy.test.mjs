import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateOcrRequest, OCR_LIMITS, OCR_PACKAGES, OCR_CORE_FILES, inspectOcrAssets } from '../src/ocr-policy.mjs';
import {createOcrWorker,runOcrProcess} from '../src/workers/ocr.mjs';
import {hash} from '../src/ocr-policy.mjs';
import {authoredOcrPdf} from './helpers/ocr-fixture.mjs';
import {ocrInstallPreview,installOcrLanguage,languageFromArchive} from '../src/ocr-install.mjs';
import {createOcrService} from '../src/ocr-service.mjs';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {collectOcrRuntimeLock} from '../scripts/lock-ocr-runtime.mjs';
import {createOcrLaunchSpec,verifyOcrLaunchSpec} from '../src/ocr-launch.mjs';
// Windows CI temp dirs can be 8.3 short paths; the OCR link check compares real paths.
const tmpRoot=await fs.realpath(os.tmpdir());

const request = () => ({jobId:'ocr-test',expectedEpoch:'00000000-0000-4000-8000-000000000000',sourceRevision:'a'.repeat(64),toolId:'document.ocr',inputAssetIds:['b'.repeat(64)],parameters:{pages:[{page:1,region:{x:0,y:0,width:1,height:1}}],language:'eng'},budget:{timeoutMs:30000,maxPixels:4000000,maxPages:2,maxOutputBytes:1048576,maxMemoryBytes:512*1024*1024}});
const inertCorePairs=()=>Object.fromEntries(OCR_CORE_FILES.map(name=>[name,'inert selector-pair policy fixture; never executed']));
const fixedWindowsOcr=process.platform==='win32'&&process.arch==='x64';
const realOcrPlatform={skip:fixedWindowsOcr?false:'The fixed OCR/PDF execution closure is validated only on Windows x64.'};
test('OCR fixed tool contract rejects paths, URLs, excess pages and unbounded rectangles',()=>{
  assert.equal(validateOcrRequest(request()).parameters.language,'eng');
  for(const bad of [r=>r.parameters.path='C:/private',r=>r.inputAssetIds=['https://example.com'],r=>r.parameters.pages[0].region.width=2,r=>r.parameters.pages.push({page:2},{page:3}),r=>r.budget.maxPixels=OCR_LIMITS.maxPixels+1,r=>r.parameters.language='eng+chi_sim']){const r=request();bad(r);assert.throws(()=>validateOcrRequest(r));}
});
test('missing optional installation remains unavailable and performs no download',async()=>{
  const dir=await fs.mkdtemp(path.join(tmpRoot,'pb-ocr-policy-'));
  try{const s=await inspectOcrAssets({assetDir:dir});assert.equal(s.state,'unavailable');assert.equal(s.code,'OCR_ASSETS_MISSING');assert.deepEqual(await fs.readdir(dir),[]);}finally{await fs.rm(dir,{recursive:true,force:true});}
});

for(const kind of ['text','scan','mixed','hidden'])test(`real PDF.js ${kind} document is bounded and absent OCR does not break text`,realOcrPlatform,async()=>{
  const dir=await fs.mkdtemp(path.join(tmpRoot,'pb-ocr-document-'));
  try{
    const bytes=authoredOcrPdf(kind),id=hash(bytes),input=path.join(dir,'original.pdf');await fs.writeFile(input,bytes);
    const worker=createOcrWorker({assetDir:path.join(dir,'optional'),artifactDir:path.join(dir,'cas'),resolveAsset:async()=>({path:input,hash:id,size:bytes.length}),checkGuard:async()=>{}});
    const r=request();r.inputAssetIds=[id];r.budget.maxMemoryBytes=768*1024*1024;
    if(kind==='mixed')r.parameters.pages[0].region={x:0,y:0,width:1,height:0.15};
    const result=await worker.runMaterialTool(r);
    assert.ok(result.rssPeak>0,'real OS RSS monitor must start before document processing');
    assert.equal(result.evidence[0].state,['scan','hidden'].includes(kind)?'unavailable':'text_layer');
    if(['scan','hidden'].includes(kind))assert.ok(result.evidence[0].imageRef);else assert.equal(result.evidence[0].imageRef,null);
    assert.equal(hash(await fs.readFile(input)),id);assert.ok((await fs.readdir(path.join(dir,'cas'))).every(n=>/^[a-f0-9]{64}$/.test(n)));
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('a bad selected page does not clear an earlier successful page',realOcrPlatform,async()=>{
  const dir=await fs.mkdtemp(path.join(tmpRoot,'pb-ocr-pages-'));
  try{const bytes=authoredOcrPdf('text'),id=hash(bytes),input=path.join(dir,'original.pdf');await fs.writeFile(input,bytes);const w=createOcrWorker({assetDir:path.join(dir,'optional'),artifactDir:path.join(dir,'cas'),resolveAsset:async()=>({path:input,hash:id,size:bytes.length}),checkGuard:async()=>{}});const r=request();r.inputAssetIds=[id];r.parameters.pages.push({page:2});r.budget.maxMemoryBytes=768*1024*1024;const out=await w.runMaterialTool(r);assert.deepEqual(out.evidence.map(e=>e.state),['text_layer','failed']);assert.equal(out.state,'completed');}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('pre-aborted OCR does not launch a process',async()=>{
  let called=false;const controller=new AbortController();controller.abort();await assert.rejects(runOcrProcess({config:{budget:request().budget},signal:controller.signal,spawnProcess:()=>{called=true;}}),e=>e.code==='OCR_CANCELLED');assert.equal(called,false);
});

test('an unsupported host explicitly refuses the fixed Windows OCR execution closure',{skip:fixedWindowsOcr?'This host is the supported Windows x64 target.':false},async()=>{
  const spec=await createOcrLaunchSpec();await assert.rejects(verifyOcrLaunchSpec(spec),error=>error.code==='OCR_LAUNCH_PLATFORM');
});
test('installer requires exact preview and verified runtime before any network',async()=>{
  const dir=await fs.mkdtemp(path.join(tmpRoot,'pb-ocr-install-'));let calls=0;
  try{const preview=ocrInstallPreview(dir),fetchImpl=()=>{calls++;throw Error('must not fetch');};await assert.rejects(installOcrLanguage({assetDir:dir,previewId:preview.previewId,confirmed:false,fetchImpl}),e=>e.code==='OCR_INSTALL_CONFIRMATION');await assert.rejects(installOcrLanguage({assetDir:dir,previewId:'wrong',confirmed:true,fetchImpl}),e=>e.code==='OCR_INSTALL_CONFIRMATION');await assert.rejects(installOcrLanguage({assetDir:dir,previewId:preview.previewId,confirmed:true,fetchImpl,runtimeLockPath:path.join(dir,'absent.json')}),e=>e.code==='OCR_RUNTIME_UNAVAILABLE');assert.equal(calls,0);await assert.rejects(languageFromArchive(Buffer.from('wrong bytes')),e=>e.code==='OCR_DOWNLOAD_INTEGRITY');}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('service absent assets, epoch guard, cancellation and disable remain independent from ordinary practice',async()=>{
  const dir=await fs.mkdtemp(path.join(tmpRoot,'pb-ocr-service-'));let epoch=request().expectedEpoch,calls=0;
  const service=createOcrService({dataDir:dir,getEpoch:()=>epoch,installLanguage:async({signal})=>{calls++;await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));throw Error('cancelled');}});
  try{const status=await service.status();assert.equal(status.state,'unavailable');await assert.rejects(service.configure({enabled:true,expectedEpoch:epoch}),e=>e.code==='OCR_ASSETS_MISSING');await assert.rejects(service.start('selftest',{expectedEpoch:epoch}),e=>e.code==='OCR_ASSETS_MISSING');const started=await service.start('install',{expectedEpoch:epoch,confirmed:true,previewId:status.preview.previewId});assert.equal(calls,1);await service.cancel({expectedEpoch:epoch,operationId:started.operation.id});await service.close();assert.equal((await service.status()).last.state,'cancelled');const old=epoch;epoch='11111111-1111-4111-8111-111111111111';await assert.rejects(service.configure({enabled:false,expectedEpoch:old}),e=>e.code==='OCR_STALE_WORKSPACE');assert.equal((await service.configure({enabled:false,expectedEpoch:epoch})).enabled,false);}finally{await service.close();await fs.rm(dir,{recursive:true,force:true});}
});
for(const mode of ['timeout','cancel','memory','output'])test(`owned OCR process terminates on ${mode} without launching an OCR engine`,async()=>{
  const dir=await fs.mkdtemp(path.join(tmpRoot,'pb-ocr-process-'));let ownedPid;
  try{
    const script=path.join(dir,'bounded-fixture.mjs');await fs.writeFile(script,`process.stdin.resume();process.stdin.on('end',()=>{${mode==='memory'?"globalThis.fixture=Buffer.alloc(100*1024*1024,1);":mode==='output'?"process.stdout.write('x'.repeat(4096));":''}setInterval(()=>{},1000);});`);
    const controller=new AbortController(),budget={...request().budget,timeoutMs:mode==='timeout'?700:10000,maxMemoryBytes:mode==='memory'?64*1024*1024:512*1024*1024,maxOutputBytes:mode==='output'?1024:1048576};
    const task=runOcrProcess({config:{budget},childPath:script,signal:controller.signal,spawnProcess:(executable,args,options)=>{const child=spawn(executable,args,options);if(args.includes(script)){child.once('spawn',()=>{ownedPid=child.pid;});}return child;}});
    const cancelTimer=mode==='cancel'?setTimeout(()=>controller.abort(),500):null;
    try{await assert.rejects(task,e=>e.code===({timeout:'OCR_TIMEOUT',cancel:'OCR_CANCELLED',memory:'OCR_MEMORY_LIMIT',output:'OCR_OUTPUT_LIMIT'})[mode]);}finally{clearTimeout(cancelTimer);}
    assert.ok(ownedPid);assert.throws(()=>process.kill(ownedPid,0),'owned helper has exited before returning');
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('synthetic runtime manifest policy rejects unexpected sidecars and changed language hashes',async()=>{
  const dir=await fs.mkdtemp(path.join(tmpRoot,'pb-ocr-lock-'));
  try{
    const runtimeRoot=path.join(dir,'node_modules'),assetDir=path.join(dir,'optional'),runtimeLockPath=path.join(dir,'lock.json'),language=Buffer.from('synthetic language policy bytes'),languageHash=hash(language);await fs.mkdir(assetDir,{recursive:true});await fs.writeFile(path.join(assetDir,'eng.traineddata.gz'),language);await fs.writeFile(path.join(assetDir,'installation.json'),JSON.stringify({version:1,language:'eng',packageIntegrity:OCR_PACKAGES[2].integrity,languageHash}));
    const values={'tesseract.js/package.json':JSON.stringify({name:'tesseract.js',version:'7.0.0',main:'src/index.js',dependencies:{'tesseract.js-core':'7.0.0'}}),'tesseract.js/src/index.js':'// synthetic policy fixture','tesseract.js/src/worker-script/node/index.js':'// synthetic policy fixture','tesseract.js/src/worker-script/node/getCore.js':'// synthetic policy fixture','tesseract.js-core/package.json':JSON.stringify({name:'tesseract.js-core',version:'7.0.0',main:'index.js'}),'tesseract.js-core/index.js':'// inert',...inertCorePairs()};
    for(const [name,value] of Object.entries(values)){await fs.mkdir(path.dirname(path.join(runtimeRoot,name)),{recursive:true});await fs.writeFile(path.join(runtimeRoot,name),value);}
    const lock={version:1,packageVersion:'7.0.0',coreVersion:'7.0.0',languageHash,packages:OCR_PACKAGES.slice(0,2),files:Object.entries(values).map(([name,value])=>({path:name,sha256:hash(Buffer.from(value))}))};await fs.writeFile(runtimeLockPath,JSON.stringify(lock));
    assert.equal((await inspectOcrAssets({assetDir,runtimeRoot,runtimeLockPath})).available,true,'manifest policy only; no fixture module is executed');
    for(const missing of ['tesseract.js-core/tesseract-core-relaxedsimd-lstm.js','tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm']){
      await fs.writeFile(runtimeLockPath,JSON.stringify({...lock,files:lock.files.filter(f=>f.path!==missing)}));
      assert.equal((await inspectOcrAssets({assetDir,runtimeRoot,runtimeLockPath})).code,'OCR_RUNTIME_UNAVAILABLE','both actual Node entry and external WASM must be pinned');
    }
    await fs.writeFile(runtimeLockPath,JSON.stringify(lock));
    await fs.writeFile(path.join(runtimeRoot,'tesseract.js','unreviewed-sidecar.js'),'not pinned');assert.equal((await inspectOcrAssets({assetDir,runtimeRoot,runtimeLockPath})).code,'OCR_ASSET_INVALID');await fs.unlink(path.join(runtimeRoot,'tesseract.js','unreviewed-sidecar.js'));
    await fs.writeFile(path.join(assetDir,'eng.traineddata.gz'),'modified');assert.equal((await inspectOcrAssets({assetDir,runtimeRoot,runtimeLockPath})).code,'OCR_ASSET_INVALID');
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

for(const [axis,region] of [['horizontal',{x:0.066,y:0.03,width:0.025,height:0.03}],['vertical',{x:0.04,y:0.04,width:0.8,height:0.005}]])test(`real PDF ${axis} partial text item cannot return the out-of-region sentence or bypass OCR`,realOcrPlatform,async()=>{
  const dir=await fs.mkdtemp(path.join(tmpRoot,'pb-ocr-crop-'));
  try{
    const bytes=authoredOcrPdf('text'),id=hash(bytes),input=path.join(dir,'original.pdf'),artifactDir=path.join(dir,'cas');await fs.writeFile(input,bytes);
    const worker=createOcrWorker({assetDir:path.join(dir,'optional'),artifactDir,resolveAsset:async()=>({path:input,hash:id,size:bytes.length}),checkGuard:async()=>{}});
    const r=request();r.inputAssetIds=[id];r.parameters.pages[0].region=region;r.budget.maxMemoryBytes=768*1024*1024;
    const result=await worker.runMaterialTool(r);assert.notEqual(result.evidence[0].state,'text_layer');assert.ok(result.evidence[0].imageRef,'selected crop must remain available');
    const evidence=JSON.parse(await fs.readFile(path.join(artifactDir,result.evidence[0].ref),'utf8'));
    assert.equal(evidence.textLayer,'');assert.ok(evidence.issues.some(i=>i.code==='ocr_region_partial_text'));assert.equal(hash(await fs.readFile(input)),id);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

async function runtimeResolutionFixture(dir,scoped=false){
  const runtimeRoot=path.join(dir,'node_modules'),assetDir=path.join(dir,'optional'),runtimeLockPath=path.join(dir,'lock.json'),language=Buffer.from('inert resolution policy fixture'),languageHash=hash(language);await fs.mkdir(assetDir,{recursive:true});await fs.writeFile(path.join(assetDir,'eng.traineddata.gz'),language);await fs.writeFile(path.join(assetDir,'installation.json'),JSON.stringify({version:1,language:'eng',packageIntegrity:OCR_PACKAGES[2].integrity,languageHash}));
  const values={'tesseract.js/package.json':JSON.stringify({name:'tesseract.js',version:'7.0.0',main:'src/index.js',dependencies:{'tesseract.js-core':'7.0.0',...(scoped?{'@fixture/consumer':'1.0.0'}:{})}}),'tesseract.js/src/index.js':'// inert fixture; never executed','tesseract.js/src/worker-script/node/index.js':'// inert','tesseract.js/src/worker-script/node/getCore.js':'// inert','tesseract.js-core/package.json':JSON.stringify({name:'tesseract.js-core',version:'7.0.0',main:'index.js'}),'tesseract.js-core/index.js':'// pinned inert core entry',...inertCorePairs()};
  if(scoped){values['@fixture/consumer/package.json']=JSON.stringify({name:'@fixture/consumer',version:'1.0.0',main:'index.js',dependencies:{'tesseract.js-core':'7.0.0'}});values['@fixture/consumer/index.js']='// inert';}
  for(const [name,value] of Object.entries(values)){await fs.mkdir(path.dirname(path.join(runtimeRoot,name)),{recursive:true});await fs.writeFile(path.join(runtimeRoot,name),value);}
  const lock={version:1,packageVersion:'7.0.0',coreVersion:'7.0.0',languageHash,packages:[...OCR_PACKAGES.slice(0,2),...(scoped?[{name:'@fixture/consumer',version:'1.0.0',integrity:'sha512-Zml4dHVyZQ==',url:'https://registry.npmjs.org/@fixture/consumer/-/consumer-1.0.0.tgz'}]:[])],files:Object.entries(values).map(([name,value])=>({path:name,sha256:hash(Buffer.from(value))}))};await fs.writeFile(runtimeLockPath,JSON.stringify(lock));
  await fs.writeFile(path.join(dir,'package-lock.json'),JSON.stringify({packages:Object.fromEntries(lock.packages.map(p=>[`node_modules/${p.name}`,{version:p.version,integrity:p.integrity,resolved:p.url}]))}));
  return {runtimeRoot,assetDir,runtimeLockPath,lock};
}
for(const kind of ['package-root-junction','runtime-root-junction','scoped-parent-junction','scoped-parent-shadow'])test(`runtime closure rejects ${kind} before any module execution`,async()=>{
  const dir=await fs.mkdtemp(path.join(tmpRoot,'pb-ocr-resolution-'));
  try{
    const f=await runtimeResolutionFixture(dir,kind.startsWith('scoped'));assert.equal((await inspectOcrAssets(f)).available,true,'unmodified inert fixture is initially valid');assert.equal((await collectOcrRuntimeLock({root:dir,languageFile:path.join(f.assetDir,'eng.traineddata.gz')})).packages.length,f.lock.packages.length,'same build-time checker accepts unmodified inert closure');
    if(kind==='package-root-junction'){
      const original=path.join(f.runtimeRoot,'tesseract.js'),relocated=path.join(f.runtimeRoot,'.shadow','tesseract.js');await fs.mkdir(path.dirname(relocated),{recursive:true});await fs.rename(original,relocated);await fs.symlink(relocated,original,process.platform==='win32'?'junction':'dir');
      const shadow=path.join(f.runtimeRoot,'.shadow','node_modules','tesseract.js-core');await fs.mkdir(shadow,{recursive:true});await fs.writeFile(path.join(shadow,'index.js'),'// unpinned inert shadow; never executed');
      const resolved=createRequire(await fs.realpath(path.join(original,'src/index.js'))).resolve('tesseract.js-core');assert.equal(resolved,path.join(shadow,'index.js'));
    }else if(kind==='runtime-root-junction'){
      const relocated=path.join(dir,'relocated-runtime');await fs.rename(f.runtimeRoot,relocated);await fs.symlink(relocated,f.runtimeRoot,process.platform==='win32'?'junction':'dir');
    }else if(kind==='scoped-parent-junction'){
      const original=path.join(f.runtimeRoot,'@fixture'),relocated=path.join(f.runtimeRoot,'.relocated-scope');await fs.rename(original,relocated);await fs.symlink(relocated,original,process.platform==='win32'?'junction':'dir');
    }else{
      const shadow=path.join(f.runtimeRoot,'@fixture','node_modules','tesseract.js-core');await fs.mkdir(shadow,{recursive:true});await fs.writeFile(path.join(shadow,'index.js'),'// unpinned inert shadow; never executed');
      assert.equal(createRequire(path.join(f.runtimeRoot,'@fixture','consumer','index.js')).resolve('tesseract.js-core'),path.join(shadow,'index.js'));
    }
    const result=await inspectOcrAssets(f);assert.equal(result.available,false,JSON.stringify(result));assert.ok(['OCR_ASSET_INVALID','OCR_RUNTIME_UNAVAILABLE'].includes(result.code));await assert.rejects(collectOcrRuntimeLock({root:dir,languageFile:path.join(f.assetDir,'eng.traineddata.gz')}),e=>['OCR_ASSET_INVALID','OCR_RUNTIME_UNAVAILABLE'].includes(e.code));
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
