// Final-package capability gates. This entry never launches source Electron,
// imports production modules, substitutes workers, or discovers host tools.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {_electron as electron} from 'playwright';
import * as asar from '@electron/asar';
import {ZipReader,Uint8ArrayReader,Uint8ArrayWriter} from '@zip.js/zip.js';

const HELP=`Final portable capability validation (Windows, actual packaged EXE only).
Required:
  --packaged <new package directory or PracticeBridge.exe>
  --expected-exe-sha256 <reviewed final EXE SHA-256>
  --expected-asar-sha256 <reviewed final resources/app.asar SHA-256>
Optional capability inputs (missing inputs yield PARTIAL, exit 2):
  --media-config <JSON containing ffmpegPath and ffprobePath>
  --asr-config <JSON containing cpu and gpu production ASR configurations>
  --g4-wav <the unchanged G4 fractional-fixture-v1 WAV>
The working directory is the final source checkout. No fallback package,
downloads, installs, private materials, or external provider requests are used.
Exit 0 means every requested gate passed; exit 1 means failure; exit 2 means
G10/G12/G18/G19 coverage is incomplete. --help never launches an application.`;
const allowed=new Set(['--packaged','--expected-exe-sha256','--expected-asar-sha256','--media-config','--asr-config','--g4-wav']);
function argumentsOf(values){
  if(values.length===1&&values[0]==='--help')return null;
  const args={};
  for(let i=0;i<values.length;i+=2){assert.ok(allowed.has(values[i]),`Unknown option ${values[i]}`);assert.ok(values[i+1]&&!values[i+1].startsWith('--'),`Missing value for ${values[i]}`);assert.equal(args[values[i]],undefined,`Duplicate option ${values[i]}`);args[values[i]]=values[i+1];}
  for(const name of ['--packaged','--expected-exe-sha256','--expected-asar-sha256'])assert.ok(args[name],`${name} is required; source/default-package fallback is forbidden`);
  for(const name of ['--expected-exe-sha256','--expected-asar-sha256'])assert.match(args[name],/^[a-f0-9]{64}$/i,`${name} must be a SHA-256`);
  return args;
}
let args;
try{args=argumentsOf(process.argv.slice(2));}catch(error){console.error(error.message+'\nUse --help for the explicit final-package contract.');process.exit(1);}
if(args===null){console.log(HELP);process.exit(0);}
const root=process.cwd(),sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const reference='Alice does not need twenty tickets. The train leaves at nine thirty.';
const g4={hash:'9640fbefad26767c16f1d422d528a11314e9b7521c15c193e9a2df2e3a3a903c',bytes:204630,requestedRange:{startSeconds:0.25049,endSeconds:6.3933125},decodedRange:{startSeconds:0.2504375,endSeconds:6.3933125},samples:98286,rate:16000};
const criticalFiles=['package.json','desktop/main.cjs','desktop/secret-store.cjs','src/server.mjs','src/store.mjs','src/models.mjs','src/model-transport.mjs','src/materials.mjs','src/material-processing.mjs','src/material-candidates.mjs','src/material-compiler.mjs','src/material-jobs.mjs','src/material-execution-ledger.mjs','src/material-job-source.mjs','src/material-tools.mjs','src/material-tool-runtime.mjs','src/media-manifest.mjs','src/asr-provider.mjs','src/asr-checks.mjs','src/asr-mapping.mjs','src/workers/host.mjs','src/workers/media.mjs','src/workers/asr.mjs','public/app.mjs','public/material-jobs.mjs','public/material-candidates.mjs','public/asr-review.mjs','tools/asr-worker/worker.py','tools/asr-worker/models.json'];
const run=path.resolve(root,'test-results','portable-capabilities',`run-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`),dataDir=path.join(run,'data');
const report={version:1,startedAt:new Date().toISOString(),gates:{},launches:[],checks:[],pageErrors:[],unexpectedRendererRequests:[],httpTrace:[],limitations:['Synthetic speech verifies execution and evidence binding, not transcription accuracy or pronunciation scoring.','Local/offline production settings and a zero-request provider trap are checked; OS-wide network isolation is not claimed.']};
const sentinel='pb-portable-'+crypto.randomBytes(32).toString('hex'),sentinelHash=sha(sentinel);
const scrub=value=>String(value).replaceAll(sentinel,'[TEST SECRET REDACTED]');
const pass=(name,value={})=>{report.checks.push({name,...value});console.log('PASS '+name);};
const save=async(name,value)=>{const text=JSON.stringify(value,null,2);assert.equal(text.includes(sentinel),false,'A generated report contains the test secret');await fs.writeFile(path.join(run,name),text);};
const optional=(gate,reason)=>{report.gates[gate]={status:'partial',reason};console.log('PARTIAL '+gate+': '+reason);};
let active=null,trap=null,trapRequests=0,packageIdentity,observedProcesses=new Map(),inspectionErrors=[],runCreated=false;
async function fileHash(filename){const digest=crypto.createHash('sha256');for await(const chunk of createReadStream(filename))digest.update(chunk);return digest.digest('hex');}
async function regular(filename){assert.ok(path.isAbsolute(filename),'Explicit paths must be absolute');const stat=await fs.lstat(filename);assert.equal(stat.isFile()&&!stat.isSymbolicLink(),true,`Not a regular file: ${filename}`);return stat;}
async function command(executable,commandArgs,{timeoutMs=15000,maxBytes=8*1024*1024}={}){
  return new Promise((resolve,reject)=>{const child=spawn(executable,commandArgs,{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});let out=[],err=[],size=0,timer;
    const collect=target=>chunk=>{size+=chunk.length;if(size>maxBytes){child.kill();reject(Error('Bounded helper output exceeded'));}else target.push(chunk);};
    child.stdout.on('data',collect(out));child.stderr.on('data',collect(err));child.once('error',reject);child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout:Buffer.concat(out),stderr:Buffer.concat(err)});});
    timer=setTimeout(()=>{child.kill();reject(Error('Bounded helper timed out'));},timeoutMs);
  });
}
async function processTree(rootPids){
  assert.ok(rootPids.every(pid=>Number.isSafeInteger(pid)&&pid>0));
  if(!rootPids.length)return [];
  // Only this run's PIDs and their descendants are returned from the OS query.
  const code=`[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $all = @(Get-CimInstance Win32_Process -ErrorAction Stop); $ids = [System.Collections.Generic.HashSet[int]]::new(); @(${rootPids.join(',')}) | ForEach-Object { [void]$ids.Add([int]$_) }; do { $added = 0; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) { $added++ } } } while ($added -gt 0); @($all | Where-Object { $ids.Contains([int]$_.ProcessId) } | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,@{Name='CreationTime';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}}) | ConvertTo-Json -Compress`;
  const result=await command('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',code]);assert.equal(result.code,0,scrub(result.stderr));const value=JSON.parse(result.stdout.toString('utf8')||'[]');return Array.isArray(value)?value:[value];
}
function processFingerprint(item){
  if(!item||!Number.isSafeInteger(item.ProcessId)||item.ProcessId<1||!Number.isFinite(Date.parse(item.CreationTime))||typeof item.ExecutablePath!=='string'||!item.ExecutablePath||typeof item.CommandLine!=='string'||!item.CommandLine)return null;
  return sha(JSON.stringify([item.ProcessId,Date.parse(item.CreationTime),path.resolve(item.ExecutablePath).toLowerCase(),item.CommandLine]));
}
function classifyProcessSnapshot(records,{known,launches,executable,liveRootPid=null}){
  const owned=new Map(),excluded=new Set(),knownPids=new Set(known.map(item=>item.ProcessId)),knownIdentities=new Set(known.map(processFingerprint).filter(Boolean));
  for(const item of records){const fingerprint=processFingerprint(item);if(fingerprint&&knownIdentities.has(fingerprint))owned.set(item.ProcessId,item);}
  // A new root needs its live held handle, program path and launch-time identity.
  // Windows' CMD wrapper additionally needs the verified main EXE and parent link.
  for(const launch of launches){const item=records.find(item=>item.ProcessId===launch.pid),fingerprint=processFingerprint(item);if(!fingerprint)continue;
    const created=Date.parse(item.CreationTime),start=Date.parse(launch.requestedAt),returned=Date.parse(launch.startedAt);
    const main=records.find(item=>item.ProcessId===launch.mainPid),mainIdentity=processFingerprint(main),mainCreated=Date.parse(main?.CreationTime);
    const direct=(launch.mainPid===undefined||launch.mainPid===launch.pid)&&path.resolve(item.ExecutablePath).toLowerCase()===path.resolve(executable).toLowerCase();
    const wrapped=mainIdentity&&typeof launch.launcherExecutable==='string'&&path.isAbsolute(launch.launcherExecutable)
      &&path.resolve(item.ExecutablePath).toLowerCase()===path.resolve(launch.launcherExecutable).toLowerCase()
      &&path.resolve(main.ExecutablePath).toLowerCase()===path.resolve(executable).toLowerCase()
      &&main.ParentProcessId===launch.pid&&launch.mainParentPid===launch.pid
      &&mainCreated>=created&&mainCreated>=start-1000&&mainCreated<=returned+1000;
    if(fingerprint===launch.processIdentity||launch.pid===liveRootPid&&(direct||wrapped)&&created>=start-1000&&created<=returned+1000){launch.processIdentity=fingerprint;if(wrapped)launch.mainProcessIdentity=mainIdentity;owned.set(item.ProcessId,item);}
  }
  for(const item of records)if(knownPids.has(item.ProcessId)&&!owned.has(item.ProcessId)&&processFingerprint(item))excluded.add(item.ProcessId);
  // Follow only a currently confirmed parent. An unseen orphan is uncertain,
  // never silently adopted just because an old parent PID happens to match.
  let changed=true;while(changed){changed=false;for(const item of records){if(owned.has(item.ProcessId)||excluded.has(item.ProcessId))continue;
    const parent=owned.get(item.ParentProcessId);if(parent&&processFingerprint(item)&&Date.parse(item.CreationTime)>=Date.parse(parent.CreationTime)){owned.set(item.ProcessId,item);changed=true;}
    else if(excluded.has(item.ParentProcessId)){
      // An older unseen worker can retain the PID of a now-replaced parent.
      const replacementParent=records.find(parent=>parent.ProcessId===item.ParentProcessId);
      if(processFingerprint(item)&&Date.parse(item.CreationTime)>Date.parse(replacementParent?.CreationTime)){excluded.add(item.ProcessId);changed=true;}
    }
  }}
  return {owned:[...owned.values()],reusedPids:[...excluded],unverified:records.filter(item=>!owned.has(item.ProcessId)&&!excluded.has(item.ProcessId)).map(item=>({ProcessId:item.ProcessId,ParentProcessId:item.ParentProcessId,CreationTime:item.CreationTime??null,reason:'Process identity or current parent ownership could not be confirmed'}))};
}
function processRoots(){return [...new Set([...report.launches.map(item=>item.pid),...[...observedProcesses.values()].map(item=>item.ProcessId)].filter(pid=>Number.isSafeInteger(pid)&&pid>0))];}
function adoptProcessSnapshot(records){
  const liveRootPid=active&&active.app.process().exitCode===null?active.entry.pid:null;
  const classified=classifyProcessSnapshot(records,{known:[...observedProcesses.values()],launches:report.launches,executable:packageIdentity.executable,liveRootPid});
  for(const item of classified.owned){const identity=processFingerprint(item),previous=observedProcesses.get(identity);observedProcesses.set(identity,{...item,firstObservedAt:previous?.firstObservedAt||new Date().toISOString(),lastObservedAt:new Date().toISOString()});}
  return classified;
}
async function sampleProcesses(){
  try{adoptProcessSnapshot(await processTree(processRoots()));}
  catch(error){if(!inspectionErrors.includes(error.message))inspectionErrors.push(scrub(error.message));}
}
async function finalizeProcessChecks({timeoutMs=15000}={}){
  const final={status:'not_started',observed:[],inspectionErrors:[...inspectionErrors],residue:[],unverified:[],reusedPids:[],termination:'No PID-based termination. Electron is closed through its owned Playwright handle; uncertain or surviving descendants fail this run.'};
  if(report.launches.length){const began=Date.now();try{
    for(;;){const snapshot=adoptProcessSnapshot(await processTree(processRoots()));final.residue=snapshot.owned;final.unverified=snapshot.unverified;final.reusedPids=snapshot.reusedPids;
      final.unverifiedLaunches=report.launches.filter(launch=>!launch.processIdentity).map(launch=>({number:launch.number,pid:launch.pid??null,requestedAt:launch.requestedAt,reason:'The launched root was never confirmed by OS process identity'}));
      final.status=final.residue.length?'residue':final.unverified.length||final.unverifiedLaunches.length?'unverified':'clean';
      if(final.status==='clean'||Date.now()-began>=timeoutMs)break;await sleep(200);
    }
  }catch(error){final.status='unverified';final.queryError=scrub(error.message);final.residue=null;}}
  final.observed=[...observedProcesses.values()];final.finishedAt=new Date().toISOString();report.processes=final;
  if(!['clean','not_started'].includes(final.status)){report.status='failed';process.exitCode=1;report.processCleanupError='Owned desktop/worker exit could not be confirmed; see processes in this report.';}
  return final;
}
async function until(read,predicate,{timeoutMs=30000,label='condition',sample=false}={}){
  const began=Date.now();let lastSample=0;
  for(;;){const value=await read();if(predicate(value))return value;if(Date.now()-began>timeoutMs)throw Error(`${label} did not settle within ${timeoutMs} ms`);if(sample&&Date.now()-lastSample>1200){lastSample=Date.now();await sampleProcesses();}await sleep(120);}
}
async function zipFiles(bytes){const reader=new ZipReader(new Uint8ArrayReader(bytes));try{const files=new Map();for(const entry of await reader.getEntries())if(!entry.directory){assert.equal(files.has(entry.filename),false,'Duplicate backup/export path');files.set(entry.filename,Buffer.from(await entry.getData(new Uint8ArrayWriter())));}return files;}finally{await reader.close();}}
async function scanBytes(bytes,label){assert.equal(bytes.includes(Buffer.from(sentinel)),false,`Plaintext secret in ${label}`);assert.equal(bytes.includes(Buffer.from(sentinel,'utf16le')),false,`UTF-16 plaintext secret in ${label}`);}
async function scanFiles(directory){
  let count=0;
  for(const entry of await fs.readdir(directory,{withFileTypes:true}).catch(error=>error.code==='ENOENT'?[]:Promise.reject(error))){const filename=path.join(directory,entry.name);assert.equal(entry.isSymbolicLink(),false,'Fresh test data contains a symbolic link');if(entry.isDirectory())count+=await scanFiles(filename);else if(entry.isFile()){await scanBytes(await fs.readFile(filename),path.relative(run,filename));count++;}}
  return count;
}
function verifyPackagedSource(name,source,packaged){
  let expected=source;
  if(name==='package.json'){const runtime=JSON.parse(source);for(const key of ['private','scripts','devDependencies'])delete runtime[key];expected=Buffer.from(JSON.stringify(runtime,null,2)+'\n');}
  assert.equal(sha(packaged),sha(expected),`Final package is stale: ${name}`);
  return {sourceSha256:sha(source),packagedSha256:sha(packaged),expectedPackagedSha256:sha(expected),projection:name==='package.json'?'omit-private-scripts-devDependencies; JSON 2 spaces + LF':'identity'};
}
async function verifyPackage(){
  assert.equal(process.platform,'win32','The portable capability contract requires Windows');
  const supplied=path.resolve(args['--packaged']),stat=await fs.lstat(supplied);assert.equal(stat.isSymbolicLink(),false);
  const executable=stat.isDirectory()?path.join(supplied,'PracticeBridge.exe'):supplied,archive=path.join(path.dirname(executable),'resources','app.asar');await regular(executable);await regular(archive);
  assert.notEqual(path.resolve(executable),path.resolve(root,'node_modules/electron/dist/electron.exe'));
  const exeHash=await fileHash(executable),asarHash=await fileHash(archive);assert.equal(exeHash,args['--expected-exe-sha256'].toLowerCase(),'Final EXE hash differs from the approved artifact');assert.equal(asarHash,args['--expected-asar-sha256'].toLowerCase(),'Final ASAR hash differs from the approved artifact');
  const packagedVersion=JSON.parse(asar.extractFile(archive,path.normalize('package.json'))).version;assert.equal(packagedVersion,'0.5.2');
  const sources={};let packageManifest;for(const name of criticalFiles){const source=await fs.readFile(path.join(root,name)),packaged=asar.extractFile(archive,path.normalize(name)),verified=verifyPackagedSource(name,source,packaged);sources[name]=verified.sourceSha256;if(name==='package.json')packageManifest=verified;}
  const worker='tools/asr-worker/worker.py';assert.equal(asar.statFile(archive,path.normalize(worker)).unpacked,true,'Python cannot execute a file trapped inside ASAR');const unpackedWorker=path.join(archive+'.unpacked',...worker.split('/'));await regular(unpackedWorker);assert.equal(await fileHash(unpackedWorker),sources[worker]);
  packageIdentity={executable,archive,exeHash,asarHash,packagedVersion,sources,packageManifest,unpackedWorker,profiles:JSON.parse(asar.extractFile(archive,path.normalize('tools/asr-worker/models.json')))};report.package={...packageIdentity};pass('reviewed final EXE/ASAR, explicit manifest projection, production source bytes and unpacked Python worker agree');
}
async function launch(){
  const env={...process.env,PRACTICEBRIDGE_DATA_DIR:dataDir,PRACTICEBRIDGE_TEST_HIDDEN:'1'};delete env.ELECTRON_RUN_AS_NODE;
  const entry={number:report.launches.length+1,requestedAt:new Date().toISOString()},logs=[];report.launches.push(entry);
  const app=await electron.launch({executablePath:packageIdentity.executable,args:['--autoplay-policy=no-user-gesture-required','--mute-audio'],env,timeout:45000});
  entry.pid=app.process().pid;entry.startedAt=new Date().toISOString();entry.launcherExecutable=app.process().spawnfile;
  let logSize=0;for(const [stream,label] of [[app.process().stdout,'stdout'],[app.process().stderr,'stderr']])stream?.on('data',chunk=>{logSize+=chunk.length;if(logSize>8*1024*1024)entry.logOverflow=true;else logs.push({label,bytes:Buffer.from(chunk)});});
  const session={app,page:null,entry,logs};active=session;
  assert.ok(path.isAbsolute(entry.launcherExecutable),'The held launcher program must be explicit');
  await sampleProcesses();
  const page=await app.firstWindow({timeout:30000});session.page=page;page.on('pageerror',error=>report.pageErrors.push(scrub(error.message)));
  await page.locator('.hero').waitFor({timeout:30000});const origin=new URL(page.url()).origin;assert.equal(new URL(origin).hostname,'127.0.0.1');session.origin=origin;
  await page.context().route('**/*',async route=>{const url=new URL(route.request().url());if(['http:','https:'].includes(url.protocol)&&url.origin!==origin){report.unexpectedRendererRequests.push({method:route.request().method(),origin:url.origin,pathname:url.pathname});await route.abort();}else await route.continue();});
  entry.runtime=await app.evaluate(({app,BrowserWindow})=>({pid:process.pid,ppid:process.ppid,isPackaged:app.isPackaged,version:app.getVersion(),appPath:app.getAppPath(),userData:app.getPath('userData'),execPath:process.execPath,electron:process.versions.electron,node:process.versions.node,preferences:BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()}));
  const runtime=entry.runtime;assert.equal(runtime.isPackaged,true);assert.equal(runtime.version,'0.5.2');assert.equal(path.resolve(runtime.appPath),path.resolve(packageIdentity.archive));assert.equal(path.resolve(runtime.execPath),path.resolve(packageIdentity.executable));assert.equal(path.resolve(runtime.userData),path.join(dataDir,'desktop-profile'));
  for(const [name,value] of Object.entries({nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,allowRunningInsecureContent:false}))assert.equal(runtime.preferences[name],value,`Renderer preference changed: ${name}`);
  assert.ok(Number.isSafeInteger(runtime.pid)&&runtime.pid>0);assert.ok(Number.isSafeInteger(runtime.ppid)&&runtime.ppid>0);entry.mainPid=runtime.pid;entry.mainParentPid=runtime.ppid;
  await sampleProcesses();return session;
}
async function closeWindow(){
  if(!active)return;
  const {app,entry,logs}=active,process=app.process(),closed=app.waitForEvent('close',{timeout:45000});
  const exited=process.exitCode!==null?Promise.resolve([process.exitCode,process.signalCode]):once(process,'exit');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());await closed;const [exitCode,signal]=await exited;entry.exit={code:exitCode,signal,normalWindowClose:true,at:new Date().toISOString()};active=null;
  assert.equal(exitCode,0,'Final desktop process did not exit cleanly');assert.equal(entry.logOverflow,undefined,'Desktop log exceeded the checked bound');
  const data=Buffer.concat(logs.map(item=>item.bytes));await scanBytes(data,'desktop stdout/stderr');await fs.writeFile(path.join(run,`desktop-${entry.number}.log`),data);entry.logSha256=sha(data);entry.plaintextScan={files:await scanFiles(dataDir),passed:true};
}
async function capture(name){const encoded=await active.app.evaluate(async({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0],shown=window.isVisible();window.showInactive();await new Promise(resolve=>setTimeout(resolve,250));const bytes=(await window.webContents.capturePage()).toPNG().toString('base64');if(!shown)window.hide();return bytes;});await fs.writeFile(path.join(run,name),Buffer.from(encoded,'base64'));}
async function request(route,body,{binary=false}={}){
  assert.ok(active?.origin);const origin=active.origin,headers={'X-PracticeBridge':'1'},start=Date.now();
  if(body!==undefined){const response=await fetch(origin+'/api/bootstrap',{headers:{'X-PracticeBridge':'1',Origin:origin},redirect:'error'});assert.equal(response.status,200);const guard=await response.json();Object.assign(headers,{'Content-Type':'application/json','X-PracticeBridge-Token':guard.bootToken,'X-PracticeBridge-Epoch':guard.workspaceEpoch});}
  const response=await fetch(origin+'/api'+route,{method:body===undefined?'GET':'POST',headers,redirect:'error',...(body===undefined?{}:{body:JSON.stringify(body)})});report.httpTrace.push({method:body===undefined?'GET':'POST',route,status:response.status,elapsedMs:Date.now()-start});
  if(!response.ok)throw Error(`HTTP ${response.status} at ${route}: ${scrub(await response.text())}`);return binary?Buffer.from(await response.arrayBuffer()):response.json();
}
const candidates=id=>request(`/materials/${id}/candidates?author=1`);
async function artifact(ref){assert.match(ref,/^[a-f0-9]{64}$/);const bytes=await fs.readFile(path.join(dataDir,'processing-artifacts',ref));assert.equal(sha(bytes),ref);return JSON.parse(bytes);}
async function backup(name){const bytes=await request('/backup',undefined,{binary:true}),files=await zipFiles(bytes);await scanBytes(bytes,name);for(const [filename,value] of files)await scanBytes(value,name+'/'+filename);await fs.writeFile(path.join(run,name),bytes);return {bytes,files};}
async function restore(saved){const result=await request('/restore',{file:{name:'self-authored-portable-backup.zip',data:saved.bytes.toString('base64')}});await active.page.goto(active.origin+'/#dashboard');await active.page.reload();await active.page.locator('.hero').waitFor();return result;}
async function openJobs(id){const url=active.origin+'/#material-jobs/'+id;if(active.page.url()===url)await active.page.reload();else await active.page.goto(url);await active.page.locator('#prepare-local-material-tool').waitFor();}
async function playAsset(materialId,assetId,name){
  await openJobs(materialId);await active.page.locator('#material-tool-asset').selectOption(assetId);const audio=active.page.locator('#material-tool-audio');await audio.waitFor({state:'visible'});
  await audio.evaluate(async element=>{element.currentTime=0;await element.play();});await until(()=>audio.evaluate(element=>({time:element.currentTime,ready:element.readyState,error:element.error?.code||null})),value=>value.time>0.15&&value.ready>=2,{label:'actual packaged audio playback'});
  const playback=await audio.evaluate(element=>{element.pause();return {src:element.currentSrc,currentTime:element.currentTime,duration:element.duration,readyState:element.readyState,error:element.error?.code||null};});assert.equal(playback.error,null);assert.ok(Number.isFinite(playback.duration)&&playback.duration>0);await capture(name);return playback;
}
function packFor(name,transcript,title){return {schemaVersion:1,title,version:'1',groups:[{id:'g',title:'Self-authored source',section:'listening',taskKind:'listen_response',questions:[{id:'q',type:'single_choice',prompt:'Which source is supplied?',options:[{id:'A',text:'This source.'},{id:'B',text:'Another source.'}],answer:null,explanation:'',transcript,audio:name}]}]};}
async function receive(name,audio,{title='Self-authored final portable media',transcript='Self-authored tone; no semantic speech transcript is claimed.',extras=[]}={}){
  const pack=packFor(name,transcript,title),result=await request('/materials',{title,files:[{name:'self-authored.json',data:Buffer.from(JSON.stringify(pack)).toString('base64')},{name,data:audio.toString('base64')},...extras.map(([name,data])=>({name,data:data.toString('base64')}))]});
  await request('/materials/'+result.material.id+'/assess',{useAI:false});await request('/materials/'+result.material.id+'/convert',{useAI:false});return result.material;
}
async function localJob(materialId,localTool,{timeoutMs=30000,sample=false}={}){
  const route='/materials/'+materialId,description=await request(route+'/jobs'),scope={expectedEpoch:description.expectedEpoch,expectedBinding:description.binding};
  const preview=await request(route+'/jobs/prepare',{...scope,localTool});assert.equal(preview.remoteInput,'none_local_tool_only');
  const started=await request(route+'/jobs/start',{...scope,previewId:preview.previewId,scopeDigest:preview.scopeDigest,consent:true});
  const job=await until(async()=>(await request(route+'/jobs/'+started.job.jobId)).job,value=>!['queued','running'].includes(value.state),{timeoutMs,label:localTool.toolId,sample});assert.equal(job.budget.requestCount,0);return {job,preview};
}
async function compile(materialId,candidate,loaded){const compiled=await request('/materials/'+materialId+'/compile',{expectedEpoch:loaded.expectedEpoch,sourceRevision:loaded.sourceRevision,candidateRevisions:{[candidate.candidateId]:candidate.revision},selectedIds:[candidate.candidateId],importOperationId:crypto.randomUUID()});return {libraryId:compiled.receipt.libraryId,files:await zipFiles(await request('/library/'+compiled.receipt.libraryId+'/export',undefined,{binary:true}))};}

async function credentialsGate(){
  trap=http.createServer((request,response)=>{trapRequests++;request.resume();response.writeHead(503);response.end('No model service is enabled in this test.');});trap.listen(0,'127.0.0.1');await once(trap,'listening');const target=`http://127.0.0.1:${trap.address().port}/v1`;
  await launch();const state=await request('/state');assert.equal(state.libraries.length,0);const initial=state.settings;
  if(!initial.credential?.available){optional('G19','Actual Windows safeStorage is unavailable; encrypted save/restart/delete was not proven.');await closeWindow();await launch();return;}
  const page=active.page;await page.goto(active.origin+'/#settings');await page.locator('#provider').selectOption('compatible');await page.locator('#baseUrl').fill(target);await page.locator('#model').fill('self-authored-no-provider');await page.locator('#credentialMode').selectOption('encrypted');await page.locator('#apiKey').fill(sentinel);await page.locator('#settings-form button[type=submit]').click();await page.locator('#settings-result .success').waitFor();
  const saved=(await request('/state')).settings;assert.equal(saved.hasApiKey,true);assert.equal(saved.credential.saved,true);assert.equal(saved.credential.mode,'encrypted');assert.equal(await page.locator('#apiKey').inputValue(),'');assert.equal(trapRequests,0);
  const slots=(await fs.readdir(path.join(dataDir,'credentials'))).filter(name=>name.endsWith('.bin'));assert.equal(slots.length,1);const slot=path.join(dataDir,'credentials',slots[0]),cipherHash=await fileHash(slot);await scanBytes(await fs.readFile(slot),'encrypted credential slot');
  const decrypted=await active.app.evaluate(async({safeStorage},{slot,expectedHash})=>{const fs=process.getBuiltinModule('node:fs/promises'),crypto=process.getBuiltinModule('node:crypto');const {result}=await safeStorage.decryptStringAsync(await fs.readFile(slot));const value=JSON.parse(result);return {available:await safeStorage.isAsyncEncryptionAvailable(),version:value.version,secretHashMatches:crypto.createHash('sha256').update(value.secret).digest('hex')===expectedHash};},{slot,expectedHash:sentinelHash});assert.deepEqual(decrypted,{available:true,version:1,secretHashMatches:true});
  const withSecret=await backup('credentials-backup.zip');const manifest=JSON.parse(withSecret.files.get('practicebridge-backup.json'));assert.equal(Object.keys(manifest).some(key=>/credential|secret/i.test(key)),false);await capture('credentials-saved.png');await closeWindow();
  await launch();const restored=(await request('/state')).settings;assert.equal(restored.hasApiKey,true);assert.equal(restored.credential.saved,true);assert.equal(await fileHash(slot),cipherHash);await active.page.goto(active.origin+'/#settings');assert.equal(await active.page.locator('#apiKey').inputValue(),'');await active.page.locator('#clearApiKey').check();await active.page.locator('#settings-form button[type=submit]').click();await active.page.locator('#settings-result .success').waitFor();assert.equal((await request('/state')).settings.hasApiKey,false);assert.equal((await fs.readdir(path.join(dataDir,'credentials'))).filter(name=>name.endsWith('.bin')).length,0);await capture('credentials-deleted.png');await closeWindow();
  await launch();assert.equal((await request('/state')).settings.hasApiKey,false);assert.equal(trapRequests,0);report.gates.G19={status:'passed',safeStorage:decrypted,secretFingerprint:sentinelHash,ciphertextSha256:cipherHash,saveRestartDeleteRestart:true,backupFilesScanned:withSecret.files.size,providerTrapRequests:0};pass('G19 final desktop safeStorage saves, survives normal restart, deletes and stays deleted');
}
function wave(){const rate=16000,samples=rate*4,bytes=Buffer.alloc(44+samples*2);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(rate,24);bytes.writeUInt32LE(rate*2,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(samples*2,40);for(let i=0;i<samples;i++)bytes.writeInt16LE(Math.round(8000*Math.sin(i*2*Math.PI*440/rate)),44+i*2);return bytes;}
async function mediaGates(){
  if(!args['--media-config']){optional('G10','No explicit media configuration supplied.');optional('G12','No explicit media configuration supplied.');return;}
  const configuration=JSON.parse(await fs.readFile(path.resolve(args['--media-config']),'utf8'));assert.deepEqual(Object.keys(configuration).sort(),['ffmpegPath','ffprobePath']);for(const filename of Object.values(configuration))await regular(filename);await request('/material-tools/media-configuration',{...configuration,confirmed:true});
  const input=wave(),wavPath=path.join(run,'self-authored-tone.wav'),mp3Path=path.join(run,'self-authored-tone.mp3');await fs.writeFile(wavPath,input);const encoded=await command(configuration.ffmpegPath,['-hide_banner','-v','error','-nostdin','-f','wav','-i',wavPath,'-map','0:a:0','-c:a','libmp3lame','-b:a','128k','-write_xing','1','-f','mp3',mp3Path]);assert.equal(encoded.code,0,scrub(encoded.stderr));const mp3=await fs.readFile(mp3Path),broken=mp3.subarray(0,Math.floor(mp3.length*.6));
  const aliasMaterial=await receive('question-2.ogg',mp3,{extras:[['broken.ogg',broken]]}),aliasSet=await candidates(aliasMaterial.id),alias=aliasSet.candidates[0];assert.equal(alias.fields.audio,'question-2.mp3');assert.equal(alias.readiness.canAnswer,true);assert.equal(alias.readiness.canScore,false);
  const mapping=alias.mappings.find(value=>value.targetId==='audio'),media=aliasSet.artifactIndex[mapping.assetId];assert.equal(mapping.mappingState,'applied');assert.equal(mapping.contentCheckState,'notChecked');assert.equal(media.value.blob.id,sha(mp3));assert.equal(media.value.evidence.decodeState,'playable');assert.equal(media.value.evidence.decoderMetadata.engine,'ffprobe+ffmpeg');assert.equal(media.value.evidence.codec,'mp3');assert.equal(media.value.evidence.derivedFrom,sha(mp3));assert.equal(sha(await fs.readFile(path.join(dataDir,'input-blobs',sha(mp3)))),sha(mp3));assert.deepEqual(await request(`/materials/${aliasMaterial.id}/candidates/media/${mapping.assetId}`,undefined,{binary:true}),mp3);
  const aliasPlayback=await playAsset(aliasMaterial.id,sha(mp3),'media-alias-playback.png'),aliasFormal=await compile(aliasMaterial.id,alias,aliasSet);assert.deepEqual(aliasFormal.files.get('question-2.mp3'),mp3);
  const damaged=await localJob(aliasMaterial.id,{toolId:'media.canonicalize',inputAssetIds:[sha(broken)],parameters:{outputFormat:'mp3'}});assert.equal(damaged.job.state,'completed_with_pending');const damagedCheckpoint=await artifact(damaged.job.chunks[0].checkpointRef);assert.equal(damagedCheckpoint.result.state,'partial');assert.deepEqual(damagedCheckpoint.result.artifactRefs,[]);assert.equal(damagedCheckpoint.result.evidence[0].decodeState,'partial');assert.equal(damagedCheckpoint.result.evidence[0].missingLocationState,'unknown');assert.equal(Object.values((await candidates(aliasMaterial.id)).artifactIndex).some(value=>value.kind==='media'&&value.value.blob.id===sha(broken)),false);assert.equal(sha(await fs.readFile(path.join(dataDir,'input-blobs',sha(broken)))),sha(broken));
  report.gates.G10={status:'passed',originalHash:sha(mp3),aliasName:alias.fields.audio,aliasMapping:mapping,aliasMedia:media,playback:aliasPlayback,exportByteIdentical:true,damagedHash:sha(broken),damagedJob:damaged.job,damagedCheckpoint,originalsUnchanged:true};pass('G10 final package plays/exports the truthful alias and keeps truncated audio partial');
  const material=await receive('source.wav',input),before=await candidates(material.id),old=before.candidates[0],oldMapping=old.mappings.find(value=>value.targetId==='audio'),checked=await request(`/materials/${material.id}/candidates/${old.candidateId}/patch`,{expectedEpoch:before.expectedEpoch,expectedRevision:old.revision,fields:{},mapping:{targetId:'audio',assetId:oldMapping.assetId,contentChecked:true}});assert.equal(checked.candidate.mappings[0].contentCheckState,'matched');
  const derivativeJob=await localJob(material.id,{toolId:'media.canonicalize',inputAssetIds:[sha(input)],parameters:{outputFormat:'mp3'}});assert.equal(derivativeJob.job.state,'completed');const checkpoint=await artifact(derivativeJob.job.chunks[0].checkpointRef),derivativeRef=checkpoint.result.artifactRefs[0],derivative=await artifact(derivativeRef);assert.equal(derivative.kind,'media-derivative');assert.equal(derivative.value.parentHash,sha(input));assert.equal(derivative.value.recipeVersion,'ffmpeg-playback-mp3-v1');
  const registered=await candidates(material.id),entry=Object.entries(registered.artifactIndex).find(([,value])=>value.kind==='media'&&value.value.blob.id===derivative.value.blob.id);assert.ok(entry,'Real derivative is not available for mapping');const [mediaRef,derivativeMedia]=entry;assert.ok(derivativeMedia.dependencyRefs.includes(derivativeRef));assert.equal(derivativeMedia.value.evidence.derivedFrom,sha(input));assert.deepEqual(derivativeMedia.value.evidence.sourceRange,{startSeconds:0,endSeconds:4});assert.equal(derivativeMedia.value.evidence.decoderMetadata.engine,'ffprobe+ffmpeg');
  const current=registered.candidates[0],mapped=await request(`/materials/${material.id}/candidates/${current.candidateId}/patch`,{expectedEpoch:registered.expectedEpoch,expectedRevision:current.revision,fields:{},mapping:{targetId:'audio',assetId:mediaRef,contentChecked:false}});assert.equal(mapped.candidate.mappings[0].contentCheckState,'notChecked');assert.equal(mapped.candidate.mappings[0].assetId,mediaRef);assert.equal(mapped.candidate.revision,current.revision+1);
  const bytes=await request(`/materials/${material.id}/candidates/media/${mediaRef}`,undefined,{binary:true});assert.equal(sha(bytes),derivative.value.blob.id);const derivativePlayback=await playAsset(material.id,derivative.value.blob.id,'media-derivative-playback.png'),formal=await compile(material.id,mapped.candidate,registered);assert.deepEqual(formal.files.get(derivativeMedia.value.name),bytes);
  const saved=await backup('media-derivative-backup.zip'),manifest=JSON.parse(saved.files.get('practicebridge-backup.json'));assert.ok(manifest.processingArtifacts[derivativeRef]);assert.deepEqual(saved.files.get('blobs/'+derivative.value.blob.id),bytes);await restore(saved);const restored=await candidates(material.id);assert.notEqual(restored.expectedEpoch,registered.expectedEpoch);assert.deepEqual(restored.artifactIndex[mediaRef],derivativeMedia);assert.equal(restored.candidates[0].mappings[0].assetId,mediaRef);assert.deepEqual(await request(`/materials/${material.id}/candidates/media/${mediaRef}`,undefined,{binary:true}),bytes);assert.deepEqual((await zipFiles(await request(`/library/${formal.libraryId}/export`,undefined,{binary:true}))).get(derivativeMedia.value.name),bytes);assert.equal(sha(await fs.readFile(path.join(dataDir,'input-blobs',sha(input)))),sha(input));
  const restoredPlayback=await playAsset(material.id,derivative.value.blob.id,'media-restored-playback.png');report.gates.G12={status:'passed',sourceHash:sha(input),derivativeRef,derivative,mediaRef,media:derivativeMedia,derivativePlayback,restoredPlayback,exportAndRestoreByteIdentical:true,restoredEpoch:restored.expectedEpoch,originalUnchanged:true};pass('G12 final package maps, plays, compiles, exports and restores the real derivative with provenance');
}

async function asrGates(){
  if(!args['--asr-config']||!args['--g4-wav']){optional('G18','Both an explicit cpu/gpu ASR configuration and unchanged G4 v1 WAV are required.');return;}
  const configurations=JSON.parse(await fs.readFile(path.resolve(args['--asr-config']),'utf8')),inputPath=path.resolve(args['--g4-wav']);await regular(inputPath);const input=await fs.readFile(inputPath);assert.equal(input.length,g4.bytes);assert.equal(sha(input),g4.hash,'ASR must use the identical G4 v1 fixture, not a replacement');
  const routes={};report.gates.G18={status:'running',routes,inputHash:g4.hash,requestedRange:g4.requestedRange,expectedDecodedRange:g4.decodedRange,source:'Windows-SAPI synthetic speech, not human or private audio',adapter:'Final EXE default production adapter, no worker/model injection'};
  for(const route of ['cpu','gpu']){
    const configuration=configurations[route];if(!configuration){routes[route]={status:'partial',reason:'This explicit route configuration is missing.'};continue;}
    assert.equal(configuration.device,route==='cpu'?'cpu':'cuda');assert.equal(configuration.modelId,route==='cpu'?'base':'large-v3');assert.equal(configuration.computeType,route==='cpu'?'int8_float32':'float16');await regular(configuration.interpreter);assert.ok(path.isAbsolute(configuration.modelDirectory));assert.equal((await fs.lstat(configuration.modelDirectory)).isDirectory(),true);for(const directory of configuration.dllDirectories||[])assert.ok(path.isAbsolute(directory));
    const material=await receive('synthetic-speech.wav',input,{title:`G18 ${route} unchanged synthetic G4 v1`,transcript:reference}),before=await candidates(material.id),candidate=before.candidates[0],mapping=candidate.mappings.find(value=>value.targetId==='audio');assert.equal(mapping.mappingState,'applied');assert.equal(before.artifactIndex[mapping.assetId].value.blob.id,g4.hash);assert.equal(candidate.fields.transcript,reference);
    console.log('RUN G18 '+route+' actual local self-test');await request('/asr/configure',{...configuration,confirmed:true});const selfTestBegan=Date.now();await request('/asr/test',{});const selftest=await until(()=>request('/asr'),value=>['ready','unavailable'].includes(value.state),{timeoutMs:210000,label:route+' actual ASR self-test',sample:true});assert.equal(selftest.state,'ready',selftest.detail);assert.equal(selftest.result.actual.device,configuration.device);assert.equal(selftest.result.actual.computeType,configuration.computeType);
    console.log('RUN G18 '+route+' actual synthetic speech');const inferenceBegan=Date.now(),execution=await localJob(material.id,{toolId:'media.transcribe',inputAssetIds:[g4.hash],parameters:g4.requestedRange,target:{candidateId:candidate.candidateId,candidateRevision:candidate.revision,targetId:'audio'}},{timeoutMs:240000,sample:true}),{job,preview}=execution;assert.equal(job.state,'completed',JSON.stringify(job.lastError));assert.equal(preview.localOperation.budget.maxOutputBytes,1048576);assert.equal(Object.hasOwn(preview.localOperation.budget,'maxPixels'),false);
    const evidence=await request(`/materials/${material.id}/tool-evidence?author=1`),after=await candidates(material.id),comparison=evidence.evidence.find(value=>value.kind==='asr-comparison');assert.ok(comparison);assert.equal(comparison.checkApplied,true);const check=after.artifactIndex[comparison.evidenceRef],wrapper=after.artifactIndex[check.value.asrEvidenceRef],raw=wrapper.value;
    assert.equal(check.kind,'asr-comparison');assert.equal(wrapper.kind,'asr-segments');assert.ok(check.dependencyRefs.includes(check.value.asrEvidenceRef));assert.equal(raw.state,'completed');assert.equal(raw.protocolVersion,1);assert.ok(raw.segments.length>0);assert.equal(raw.transcript,raw.segments.map(value=>value.text).join('').trim());assert.equal(raw.originalAssetId,g4.hash);assert.equal(raw.sourceRevision,preview.sourceRevision);assert.deepEqual(raw.timeRange,g4.requestedRange);assert.deepEqual(raw.requestedRange,g4.requestedRange);assert.deepEqual(raw.decodedRange,g4.decodedRange);assert.equal(raw.rangeComplete,true);assert.equal(raw.rangePrecision,'pcm-16000-floor-v1');assert.equal(raw.durationSeconds,g4.samples/g4.rate);assert.equal(raw.issues.some(value=>value.code==='segment_outside_audio'),false);
    assert.equal(raw.actual.engine,'faster-whisper');assert.equal(raw.actual.device,configuration.device);assert.equal(raw.actual.computeType,configuration.computeType);assert.equal(raw.actual.modelId,packageIdentity.profiles[configuration.modelId].model_id);assert.equal(raw.actual.modelRevision,packageIdentity.profiles[configuration.modelId].revision);assert.equal(check.value.binding.workspaceEpoch,before.expectedEpoch);assert.equal(check.value.binding.candidateRevision,after.candidates[0].revision);assert.equal(check.value.preparedBinding.candidateRevision,candidate.revision);assert.deepEqual(check.value.binding.requestedRange,g4.requestedRange);assert.deepEqual(check.value.sourceRange,g4.decodedRange);assert.equal(check.value.reference,reference);assert.equal(after.candidates[0].fields.transcript,reference);assert.equal(after.candidates[0].mappings[0].contentCheckRef,comparison.evidenceRef);assert.equal(after.candidates[0].mappings[0].contentCheckState,comparison.state);
    assert.equal(check.value.binding.materialId,material.id);assert.equal(check.value.binding.candidateId,candidate.candidateId);assert.equal(check.value.binding.sourceRevision,preview.sourceRevision);assert.equal(check.value.binding.mappingAssetRef,mapping.assetId);assert.equal(check.value.binding.assetHash,g4.hash);assert.equal(check.value.binding.mappingRevision,after.candidates[0].revision);assert.deepEqual(check.value.binding.sourceRange,g4.decodedRange);assert.equal(check.value.binding.rangePrecision,'pcm-16000-floor-v1');assert.equal(check.value.transcript,raw.transcript);
    await openJobs(material.id);await active.page.locator('#material-evidence-author').check();await active.page.locator('.asr-comparison').waitFor();const visible=await active.page.locator('.asr-comparison').innerText();for(const text of [reference,raw.transcript,String(g4.requestedRange.startSeconds),String(g4.decodedRange.startSeconds)])assert.ok(visible.includes(text));await capture(`asr-${route}-current.png`);
    // First edit a currently applicable comparison, then restore a backup which
    // still contains its earlier current relation. Each operation independently
    // invalidates the decision while retaining the immutable reference/ASR text.
    const snapshot=await backup(`asr-${route}-current-backup.zip`),oldEpoch=after.expectedEpoch,current=after.candidates[0];await request(`/materials/${material.id}/candidates/${current.candidateId}/patch`,{expectedEpoch:after.expectedEpoch,expectedRevision:current.revision,fields:{transcript:reference+' An authored later edit.'}});const historical=(await request(`/materials/${material.id}/tool-evidence?author=1`)).evidence.find(value=>value.evidenceRef===comparison.evidenceRef);assert.equal(historical.checkApplied,false);assert.equal(historical.state,'notChecked');assert.equal(historical.evidence.reference,reference);assert.equal(historical.evidence.transcript,raw.transcript);await openJobs(material.id);await active.page.locator('#material-evidence-author').check();await active.page.getByText('历史证据 · 当前尚未核对',{exact:true}).waitFor();await capture(`asr-${route}-historical-edit.png`);
    await restore(snapshot);const restored=await candidates(material.id),restoredEvidence=(await request(`/materials/${material.id}/tool-evidence?author=1`)).evidence.find(value=>value.evidenceRef===comparison.evidenceRef);assert.notEqual(restored.expectedEpoch,oldEpoch);assert.deepEqual(restored.artifactIndex[comparison.evidenceRef],check);assert.equal(restoredEvidence.checkApplied,false);assert.equal(restoredEvidence.state,'notChecked');assert.equal(restored.candidates[0].mappings[0].contentCheckState,'notChecked');assert.equal(restored.candidates[0].fields.transcript,reference);await openJobs(material.id);await active.page.locator('#material-evidence-author').check();await active.page.getByText('历史证据 · 当前尚未核对',{exact:true}).waitFor();await capture(`asr-${route}-historical-restore.png`);
    assert.equal(sha(await fs.readFile(path.join(dataDir,'input-blobs',g4.hash))),g4.hash);assert.equal(await fileHash(inputPath),g4.hash);routes[route]={status:'passed',configuration,selftest,selftestWallMs:inferenceBegan-selfTestBegan,jobWallMs:Date.now()-inferenceBegan,job,preview,actual:raw.actual,raw,comparison,comparisonArtifact:check,segmentsWrapper:wrapper,visibleRequestedAndDecodedRanges:true,restoredEpoch:restored.expectedEpoch,currentCheckInvalidatedByEdit:true,currentCheckInvalidatedByRestore:true,historicalTextRetained:true,originalUnchanged:true};await save(`asr-${route}-evidence.json`,routes[route]);pass('G18 '+route+' final default worker executes identical audio and preserves valid/historical evidence relations');
  }
  report.gates.G18.status=Object.values(routes).every(value=>value.status==='passed')&&Object.keys(routes).length===2?'passed':'partial';
}

try{
  await fs.mkdir(path.dirname(run),{recursive:true});await fs.mkdir(run);runCreated=true;report.harness={path:'tests/portable-capabilities-ui.mjs',sha256:await fileHash(path.join(root,'tests/portable-capabilities-ui.mjs'))};await verifyPackage();await credentialsGate();await mediaGates();await asrGates();await closeWindow();
  assert.equal(trapRequests,0,'A model-provider request was sent');assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.unexpectedRendererRequests,[]);
  if(report.gates.G18?.status==='passed'){
    const workerPath=path.resolve(packageIdentity.unpackedWorker).toLowerCase(),actualWorkers=[...observedProcesses.values()].filter(value=>String(value.CommandLine||'').toLowerCase().replaceAll('/','\\').includes(workerPath.replaceAll('/','\\')));
    assert.ok(actualWorkers.length>0,'No actual Python command using the final unpacked worker was observed');report.gates.G18.actualUnpackedWorkerProcesses=actualWorkers;
  }
  assert.equal(await fileHash(packageIdentity.executable),packageIdentity.exeHash);assert.equal(await fileHash(packageIdentity.archive),packageIdentity.asarHash);for(const [name,expected] of Object.entries(packageIdentity.sources))assert.equal(await fileHash(path.join(root,name)),expected,`Source changed while final evidence was running: ${name}`);assert.equal(await fileHash(packageIdentity.unpackedWorker),packageIdentity.sources['tools/asr-worker/worker.py']);
  assert.equal(await fileHash(path.join(root,report.harness.path)),report.harness.sha256);report.finalArtifactHashesUnchanged=true;report.providerTrapRequests=trapRequests;report.finalDataFilesScanned=await scanFiles(dataDir);report.status=Object.values(report.gates).every(value=>value.status==='passed')&&Object.keys(report.gates).length===4?'passed':'partial';process.exitCode=report.status==='passed'?0:2;
}catch(error){report.status='failed';report.error={name:error.name,message:scrub(error.message),stack:scrub(error.stack)};process.exitCode=1;console.error('FAIL '+report.error.message);}
finally{
  if(active){await sampleProcesses();try{await closeWindow();}catch(error){report.cleanupError=scrub(error.message);await active?.app.close().catch(closeError=>{report.fallbackCloseError=scrub(closeError.message);});active=null;process.exitCode=1;report.status='failed';}}
  await finalizeProcessChecks();
  if(report.status!=='failed')pass('normal final-window shutdown, zero owned residue, secret scans and unchanged package hashes');
  if(trap)await new Promise(resolve=>trap.close(resolve));report.providerTrapRequests=trapRequests;report.finishedAt=new Date().toISOString();if(runCreated){await save('result.json',report);console.log('RESULT_DIR '+run);}console.log('RESULT '+report.status.toUpperCase());
}
