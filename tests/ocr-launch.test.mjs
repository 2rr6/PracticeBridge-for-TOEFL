import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createOcrLaunchSpec,verifyOcrLaunchSpec,validateOcrLaunchSpec,ocrExecutionRoot,ocrLaunchForJob,ocrLaunchEnvironment,assertOcrLaunchModule,OCR_LAUNCH_PROJECT_FILES,OCR_LAUNCH_LOCK} from '../src/ocr-launch.mjs';
import {ocrEnvironment,runOcrProcess} from '../src/workers/ocr.mjs';
import {hash} from '../src/ocr-policy.mjs';
import {ocrRuntimePackageBytes} from '../scripts/lock-ocr-launch.mjs';
// Windows CI temp dirs can be 8.3 short paths; the OCR link check compares real paths.
const tmpRoot=await fs.realpath(os.tmpdir());

const root=path.resolve(fileURLToPath(new URL('../',import.meta.url)));
const local=(dir,name)=>path.join(dir,name);
const rejected=code=>error=>error.code===code;
const childResult=(executable,args,options,input)=>new Promise((resolve,reject)=>{
  const child=spawn(executable,args,{...options,windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
  const timer=setTimeout(()=>child.kill('SIGKILL'),5000);child.on('error',reject);child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  child.on('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});child.stdin.end(JSON.stringify(input));
});

test('one frozen launch binds physical root, exact entries, job directory and clean environment',async()=>{
  const spec=await createOcrLaunchSpec();assert.ok(Object.isFrozen(spec));assert.equal(spec.profile,'development');assert.equal(spec.executionRoot,root);
  assert.equal(ocrExecutionRoot(path.join(root,'resources','app.asar')),path.join(root,'resources','app.asar.unpacked'));
  for(const change of [{cwd:path.dirname(root)},{entryPath:path.join(root,'other.mjs')},{runtimeRoot:path.join(root,'other_modules')},{workerPath:path.join(root,'worker.mjs')},{executable:path.join(root,'node.exe')},{specHash:'0'.repeat(64)}])assert.throws(()=>validateOcrLaunchSpec({...spec,...change}),rejected('OCR_LAUNCH_INVALID'));
  const bound=ocrLaunchForJob(spec,path.join(tmpRoot,'pb-ocr-job-a'));assert.equal(bound.writableJobDir,path.join(tmpRoot,'pb-ocr-job-a'));assert.ok(Object.isFrozen(bound));
  assert.throws(()=>ocrLaunchForJob(bound,path.join(tmpRoot,'pb-ocr-job-b')),rejected('OCR_LAUNCH_INVALID'));
  const environment={SystemRoot:'C:\\Windows',TEMP:'C:\\Temp',LANG:'en_US.UTF-8',PATH:'must not inherit',NODE_PATH:'must not inherit',NODE_OPTIONS:'--require must-not-execute.cjs',ELECTRON_RUN_AS_NODE:'inherited forbidden',PRACTICEBRIDGE_OCR_RUNTIME:'untrusted'};
  assert.deepEqual(ocrLaunchEnvironment(environment),{SystemRoot:'C:\\Windows',TEMP:'C:\\Temp',LANG:'en_US.UTF-8'});assert.deepEqual(ocrEnvironment(environment),ocrLaunchEnvironment(environment));
  let spawned=false;await assert.rejects(runOcrProcess({config:{budget:{}},spawnProcess:()=>{spawned=true;}}),rejected('OCR_LAUNCH_INVALID'));assert.equal(spawned,false);
});

test('fixed original-path physical closure rejects missing leaves, ancestor resolution and mixed profiles before execution',{skip:process.platform!=='win32'||process.arch!=='x64'},async t=>{
  const dir=await fs.mkdtemp(path.join(tmpRoot,'pb-ocr-launch-')),applicationRoot=path.join(dir,'app.asar'),executionRoot=ocrExecutionRoot(applicationRoot),lockBytes=await fs.readFile(path.join(root,OCR_LAUNCH_LOCK)),lock=JSON.parse(lockBytes);
  const devPackage=await fs.readFile(path.join(root,'package.json'));
  try{
    await fs.mkdir(path.join(applicationRoot,'assets'),{recursive:true});await fs.writeFile(path.join(applicationRoot,OCR_LAUNCH_LOCK),lockBytes);
    for(const file of lock.files){const target=local(executionRoot,file.path);await fs.mkdir(path.dirname(target),{recursive:true});const original=await fs.readFile(local(root,file.path)),bytes=file.path==='package.json'?ocrRuntimePackageBytes(original):original;assert.equal(bytes.length,file.bytes);assert.equal(hash(bytes),file.sha256);await fs.writeFile(target,bytes);}
    const spec=await createOcrLaunchSpec({applicationRoot});assert.equal(spec.profile,'runtime');assert.equal(spec.executionRoot,executionRoot);
    const verified=await verifyOcrLaunchSpec(spec);assert.equal(verified.lock.files.length,lock.files.length);
    const caseAlias=await createOcrLaunchSpec({applicationRoot,executionRoot:executionRoot.toLowerCase()});await verifyOcrLaunchSpec(caseAlias);
    assert.equal(assertOcrLaunchModule(verified,pathToFileURL(local(executionRoot,'node_modules/@napi-rs/canvas/index.js')).href,'@napi-rs/canvas'),pathToFileURL(local(executionRoot,'node_modules/@napi-rs/canvas/index.js')).href);
    assert.throws(()=>assertOcrLaunchModule({...verified},pathToFileURL(local(executionRoot,'node_modules/@napi-rs/canvas/index.js')).href,'@napi-rs/canvas'),rejected('OCR_LAUNCH_INVALID'));
    assert.throws(()=>assertOcrLaunchModule(verified,pathToFileURL(local(dir,'node_modules/@napi-rs/canvas/index.js')).href,'@napi-rs/canvas'),rejected('OCR_RUNTIME_RESOLUTION_ESCAPE'));

    await t.test('the required ASR physical companion coexists only with its exact reviewed bytes',async()=>{
      const name='tools/asr-worker/worker.py',target=local(executionRoot,name),source=await fs.readFile(local(root,name)),original=await fs.readFile(target).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});
      await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,source);
      try{
        await verifyOcrLaunchSpec(spec);
        assert.deepEqual(lock.physicalCompanions,[{path:name,role:'asr-worker',bytes:source.length,sha256:hash(source)}]);assert.equal(OCR_LAUNCH_PROJECT_FILES.includes(name),false);
        const changed=Buffer.from(source);changed[0]^=1;await fs.writeFile(target,changed);try{await assert.rejects(verifyOcrLaunchSpec(spec),rejected('OCR_RUNTIME_CHANGED'));}finally{await fs.writeFile(target,source);}
        await fs.unlink(target);try{await assert.rejects(verifyOcrLaunchSpec(spec),rejected('OCR_RUNTIME_INCOMPLETE'));}finally{await fs.writeFile(target,source);}
        const extra=local(executionRoot,'tools/asr-worker/unreviewed.py');await fs.writeFile(extra,'# inert unregistered companion\n');try{await assert.rejects(verifyOcrLaunchSpec(spec),rejected('OCR_RUNTIME_CHANGED'));}finally{await fs.unlink(extra);}
      }finally{if(original)await fs.writeFile(target,original);else await fs.unlink(target);}
    });

    await t.test('every project import and non-code data leaf is physically registered',async()=>{
      assert.equal(OCR_LAUNCH_PROJECT_FILES.length,16);
      for(const name of OCR_LAUNCH_PROJECT_FILES.filter(name=>/\.(mjs|cjs)$/.test(name))){
        const source=await fs.readFile(local(executionRoot,name),'utf8');
        for(const match of source.matchAll(/(?:from\s*|import\s*\()(['"])(\.[^'"\r\n]+)\1/g)){
          const relative=path.relative(executionRoot,path.resolve(path.dirname(local(executionRoot,name)),match[2])).replaceAll('\\','/');assert.ok(OCR_LAUNCH_PROJECT_FILES.includes(relative),`${name} imports unregistered ${relative}`);
        }
      }
      for(const name of ['src/workers/ocr-child.mjs','src/workers/ocr-thread.cjs','src/workers/ocr-resolve.cjs','docs/practicebridge.v2.schema.json','node_modules/@napi-rs/canvas-win32-x64-msvc/skia.win32-x64-msvc.node']){
        const target=local(executionRoot,name),bytes=await fs.readFile(target);await fs.unlink(target);try{await assert.rejects(verifyOcrLaunchSpec(spec),rejected('OCR_RUNTIME_INCOMPLETE'));}finally{await fs.writeFile(target,bytes);}
      }
    });

    await t.test('resolver uses the same physical cwd and refuses a mixed root',async()=>{
      const payload={runtimeRoot:spec.runtimeRoot,requests:[{from:'tesseract.js',dependency:'bmp-js'}],launch:{executionRoot,executable:spec.executable,entryPath:spec.resolverPath}},options={cwd:executionRoot,env:ocrLaunchEnvironment()};
      const good=await childResult(spec.executable,[spec.resolverPath],options,payload);assert.equal(good.code,0);assert.equal(JSON.parse(good.stdout).results[0].entry,path.join(spec.runtimeRoot,'bmp-js','index.js'));
      const builtin=await childResult(spec.executable,[spec.resolverPath],options,{...payload,requests:[{from:'readable-stream',dependency:'string_decoder'}]});assert.equal(builtin.code,0);assert.equal(JSON.parse(builtin.stdout).results[0].entry,'string_decoder');
      const wrong=await childResult(spec.executable,[spec.resolverPath],{...options,cwd:dir},payload);assert.equal(wrong.code,1);assert.equal(wrong.stdout,'');
    });

    await t.test('missing local dependency cannot execute its available ancestor marker',async()=>{
      const ancestor=path.join(dir,'node_modules','bmp-js'),marker=path.join(ancestor,'executed.txt');await fs.mkdir(ancestor,{recursive:true});await fs.writeFile(path.join(ancestor,'package.json'),JSON.stringify({name:'bmp-js',version:'0.1.0',main:'index.js'}));await fs.writeFile(path.join(ancestor,'index.js'),"require('node:fs').writeFileSync(require('node:path').join(__dirname,'executed.txt'),'ancestor executed');module.exports={};");
      const leaf=path.join(spec.runtimeRoot,'bmp-js','package.json'),body=await fs.readFile(leaf),entry=path.join(spec.runtimeRoot,'bmp-js','index.js'),entryBytes=await fs.readFile(entry);await fs.unlink(leaf);await fs.unlink(entry);
      try{
        const raw=await childResult(spec.executable,[spec.resolverPath],{cwd:executionRoot,env:ocrLaunchEnvironment()},{runtimeRoot:spec.runtimeRoot,requests:[{from:'tesseract.js',dependency:'bmp-js'}],launch:{executionRoot,executable:spec.executable,entryPath:spec.resolverPath}});
        assert.equal(raw.code,0);assert.equal(JSON.parse(raw.stdout).results[0].entry,path.join(ancestor,'index.js'),'fixture must expose a real Node ancestor fallback');
        await assert.rejects(verifyOcrLaunchSpec(spec),rejected('OCR_RUNTIME_INCOMPLETE'));await assert.rejects(fs.stat(marker),error=>error.code==='ENOENT');
      }finally{await fs.writeFile(leaf,body);await fs.writeFile(entry,entryBytes);}
      await verifyOcrLaunchSpec(spec);await assert.rejects(fs.stat(marker),error=>error.code==='ENOENT');
    });

    await t.test('extra physical code and wrong package transformation cannot pass',async()=>{
      const extra=path.join(executionRoot,'extra.mjs');await fs.writeFile(extra,'throw Error("unlisted executable");');try{await assert.rejects(verifyOcrLaunchSpec(spec),rejected('OCR_RUNTIME_CHANGED'));}finally{await fs.unlink(extra);}
      const packagePath=path.join(executionRoot,'package.json'),runtimePackage=await fs.readFile(packagePath);await fs.writeFile(packagePath,devPackage);
      try{await assert.rejects(verifyOcrLaunchSpec(spec),rejected('OCR_RUNTIME_CHANGED'));}finally{await fs.writeFile(packagePath,runtimePackage);}
      const copiedLock=path.join(executionRoot,OCR_LAUNCH_LOCK);await fs.writeFile(copiedLock,lockBytes);const development=await createOcrLaunchSpec({applicationRoot:executionRoot});
      try{await assert.rejects(verifyOcrLaunchSpec(development),rejected('OCR_RUNTIME_CHANGED'));await fs.writeFile(packagePath,devPackage);await verifyOcrLaunchSpec(development);}finally{await fs.writeFile(packagePath,runtimePackage);await fs.unlink(copiedLock);}
    });
    await verifyOcrLaunchSpec(spec);
  }finally{const target=path.resolve(dir);assert.equal(path.dirname(target),path.resolve(tmpRoot));assert.ok(path.basename(target).startsWith('pb-ocr-launch-'));await fs.rm(target,{recursive:true,force:true});}
});
