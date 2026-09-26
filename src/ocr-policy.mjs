import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { isBuiltin } from 'node:module';
import { InputError } from './package.mjs';
import {createOcrLaunchSpec,verifyOcrLaunchSpec,isVerifiedOcrLaunch,ocrLaunchEnvironment} from './ocr-launch.mjs';

export const OCR_LIMITS = Object.freeze({maxPages:4,maxPixels:16_000_000,maxInputBytes:64*1024*1024,maxOutputBytes:16*1024*1024,maxMemoryBytes:1024*1024*1024,timeoutMs:120000,downloadBytes:96*1024*1024});
export const OCR_PACKAGES = Object.freeze([
  {name:'tesseract.js',version:'7.0.0',url:'https://registry.npmjs.org/tesseract.js/-/tesseract.js-7.0.0.tgz',integrity:'sha512-exPBkd+z+wM1BuMkx/Bjv43OeLBxhL5kKWsz/9JY+DXcXdiBjiAch0V49QR3oAJqCaL5qURE0vx9Eo+G5YE7mA=='},
  {name:'tesseract.js-core',version:'7.0.0',url:'https://registry.npmjs.org/tesseract.js-core/-/tesseract.js-core-7.0.0.tgz',integrity:'sha512-WnNH518NzmbSq9zgTPeoF8c+xmilS8rFIl1YKbk/ptuuc7p6cLNELNuPAzcmsYw450ca6bLa8j3t0VAtq435Vw=='},
  {name:'@tesseract.js-data/eng',version:'1.0.0',url:'https://registry.npmjs.org/@tesseract.js-data/eng/-/eng-1.0.0.tgz',integrity:'sha512-mbTumm6KQPUHyzTPQaF3ObXYnx0SqqfV2nabqFVQBwD6Kl7PhGSLSzOlfFTWy0P3BjghaSKA2W9GB19Jk+ZcTg=='}
]);
// Official 7.0.0 Node entries use "relaxedsimd", and load external WASM.
// Require every selector branch as a pair; the complete package remains hashed.
export const OCR_CORE_FILES = Object.freeze(['tesseract-core','tesseract-core-lstm','tesseract-core-simd','tesseract-core-simd-lstm','tesseract-core-relaxedsimd','tesseract-core-relaxedsimd-lstm'].flatMap(name=>['js','wasm'].map(extension=>`tesseract.js-core/${name}.${extension}`)));
export const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export function ocrError(code,message,status=400){const e=new InputError(message,status);e.code=code;return e;}
const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const keys=(v,allowed)=>plain(v)&&Object.keys(v).every(k=>allowed.includes(k));
const HASH=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function assertOcrCoreSelection(selection,files){
  const core=files.find(f=>f.name===selection?.coreEntry),wasm=files.find(f=>f.name===selection?.wasmEntry);
  if(!core||!wasm||!OCR_CORE_FILES.includes(selection.coreEntry)||!selection.coreEntry.endsWith('.js')||selection.wasmEntry!==selection.coreEntry.slice(0,-3)+'.wasm'||!HASH.test(selection.coreHash||'')||!HASH.test(selection.wasmHash||'')||selection.coreHash!==core.sha256||selection.wasmHash!==wasm.sha256)throw ocrError('OCR_CORE_UNVERIFIED','OCR 实际载入的核心与 WASM 未通过安装清单校验。',503);
  return {coreEntry:selection.coreEntry,coreHash:selection.coreHash,wasmEntry:selection.wasmEntry,wasmHash:selection.wasmHash};
}
export function validateOcrRequest(r){
  const fail=()=>{throw ocrError('OCR_REQUEST_INVALID','OCR 参数必须是本材料资产和有界页码／区域。');};
  if(!keys(r,['jobId','expectedEpoch','sourceRevision','toolId','inputAssetIds','parameters','budget','cancelToken'])||typeof r.jobId!=='string'||!/^[\w:-]{1,200}$/.test(r.jobId)||!UUID.test(r.expectedEpoch)||!HASH.test(r.sourceRevision)||!['document.render','document.ocr'].includes(r.toolId)||!Array.isArray(r.inputAssetIds)||r.inputAssetIds.length!==1||!HASH.test(r.inputAssetIds[0]))fail();
  if(!keys(r.parameters,['pages','language'])||r.parameters.language!=='eng'||!Array.isArray(r.parameters.pages)||r.parameters.pages.length<1||r.parameters.pages.length>OCR_LIMITS.maxPages)fail();
  const selected=new Set();
  for(const p of r.parameters.pages){
    if(!keys(p,['page','region'])||!Number.isInteger(p.page)||p.page<1||p.page>200||selected.has(p.page))fail();selected.add(p.page);
    if(p.region!==undefined){const b=p.region;if(!keys(b,['x','y','width','height'])||!['x','y','width','height'].every(k=>Number.isFinite(b[k]))||b.x<0||b.y<0||b.width<=0||b.height<=0||b.x+b.width>1||b.y+b.height>1)fail();}
  }
  if(!keys(r.budget,['timeoutMs','maxPixels','maxPages','maxOutputBytes','maxMemoryBytes']))fail();
  for(const k of ['timeoutMs','maxPixels','maxPages','maxOutputBytes','maxMemoryBytes'])if(!Number.isInteger(r.budget[k])||r.budget[k]<1||r.budget[k]>OCR_LIMITS[k])fail();
  if(r.budget.timeoutMs<100||r.budget.maxMemoryBytes<64*1024*1024||r.parameters.pages.length>r.budget.maxPages)fail();
  return r;
}

export const DEFAULT_RUNTIME_ROOT=fileURLToPath(new URL('../node_modules/',import.meta.url));
export const DEFAULT_RUNTIME_LOCK=fileURLToPath(new URL('../assets/ocr-runtime-lock.json',import.meta.url));
const equalPath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
/** Reject redirection at any component, including a package root, scope parent
 * or the runtime directory itself. Staying somewhere inside runtimeRoot does
 * not preserve Node's dependency lookup ancestry. */
export async function assertNoOcrPathLinks(absolutePath){
  if(typeof absolutePath!=='string'||!path.isAbsolute(absolutePath))throw ocrError('OCR_ASSET_INVALID','OCR 本地路径无效。',503);
  const resolved=path.resolve(absolutePath),root=path.parse(resolved).root;let current=root;
  for(const part of ['',...path.relative(root,resolved).split(path.sep).filter(Boolean)]){
    if(part)current=path.join(current,part);
    const stat=await fs.lstat(current);if(stat.isSymbolicLink())throw ocrError('OCR_ASSET_INVALID','OCR 路径包含链接或目录重定向。',503);
  }
  if(!equalPath(await fs.realpath(resolved),resolved))throw ocrError('OCR_ASSET_INVALID','OCR 实际路径与固定路径不同。',503);
  return resolved;
}
export async function checkedLocalFile(root,name,expectedHash,maxBytes=64*1024*1024){
  if(typeof name!=='string'||name.includes('\\')||name.split('/').some(p=>!p||p==='.'||p==='..')||path.isAbsolute(name)||!HASH.test(expectedHash))throw ocrError('OCR_ASSET_INVALID','OCR 文件清单无效。',503);
  const absolute=path.resolve(root,name);await assertNoOcrPathLinks(absolute);const realRoot=await fs.realpath(root);const real=await fs.realpath(absolute);
  if(!real.startsWith(realRoot+path.sep))throw ocrError('OCR_ASSET_INVALID','OCR 文件不在已确认的本地目录。',503);
  const stat=await fs.lstat(absolute);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>maxBytes)throw ocrError('OCR_ASSET_INVALID','OCR 文件类型或大小无效。',503);
  const bytes=await fs.readFile(absolute);if(hash(bytes)!==expectedHash)throw ocrError('OCR_ASSET_INVALID','OCR 本地文件校验失败，请重新安装可选组件。',503);
  return {path:absolute,sha256:expectedHash,size:bytes.length};
}

function resolveRuntimeDependencies(runtimeRoot,requests,resolver){
  // A long-lived host's require.resolve cache can retain an earlier good path
  // after an ancestor shadow directory appears. Match the fresh OCR child by
  // resolving in a new fixed Node process, without executing package modules.
  return new Promise((resolve,reject)=>{
    const env=ocrLaunchEnvironment();if(process.versions.electron)env.ELECTRON_RUN_AS_NODE='1';
    const executable=resolver?.executable||process.execPath,entryPath=resolver?.entryPath||fileURLToPath(new URL('./workers/ocr-resolve.cjs',import.meta.url));
    const child=spawn(executable,['--max-old-space-size=64',entryPath],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],env,...(resolver?{cwd:resolver.cwd}:{})});
    let failure=null,size=0;const chunks=[];const stop=()=>{failure=ocrError('OCR_RUNTIME_UNAVAILABLE','OCR 实际依赖解析未能安全完成。',503);try{child.kill('SIGKILL');}catch{}};
    const timer=setTimeout(stop,5000);child.on('error',stop);child.stdin.on('error',()=>{});
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>512*1024)stop();else chunks.push(chunk);});child.stderr.on('data',chunk=>{size+=chunk.length;if(size>512*1024)stop();});
    child.on('close',code=>{clearTimeout(timer);if(failure||code!==0){reject(failure||ocrError('OCR_RUNTIME_UNAVAILABLE','OCR 依赖解析不可用。',503));return;}try{const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!Array.isArray(result.results)||result.results.length!==requests.length)throw Error();resolve(result.results);}catch{reject(ocrError('OCR_RUNTIME_UNAVAILABLE','OCR 依赖解析结果无效。',503));}});
    const input=JSON.stringify({runtimeRoot,requests,...(resolver?{launch:{executionRoot:resolver.cwd,executable,entryPath}}:{})});if(Buffer.byteLength(input)>512*1024){stop();return;}child.stdin.end(input);
  });
}

export async function assertOcrRuntimeClosure(runtimeRoot,lock,{resolver,allowUnlistedFiles=false}={}){
  if(!Array.isArray(lock.packages)||!lock.packages.length||lock.packages.length>50)throw ocrError('OCR_RUNTIME_UNAVAILABLE','OCR 依赖锁缺失。',503);
  if(!lock.packages.some(p=>p.name==='tesseract.js'&&p.version==='7.0.0')||!lock.packages.some(p=>p.name==='tesseract.js-core'&&p.version==='7.0.0')||new Set(lock.packages.map(p=>p.name)).size!==lock.packages.length||new Set(lock.files.map(f=>f.path)).size!==lock.files.length)throw ocrError('OCR_RUNTIME_UNAVAILABLE','OCR 依赖锁不完整或重复。',503);
  await assertNoOcrPathLinks(runtimeRoot);const known=new Set(lock.files.map(f=>f.path)),requests=[];
  const walk=async(dir,prefix)=>{for(const entry of await fs.readdir(dir,{withFileTypes:true})){const name=`${prefix}/${entry.name}`;if(entry.isSymbolicLink()||entry.isDirectory()&&entry.name==='node_modules')throw ocrError('OCR_ASSET_INVALID','OCR 运行组件含未允许的链接或嵌套依赖。',503);if(entry.isDirectory())await walk(path.join(dir,entry.name),name);else if(!entry.isFile()||!known.has(name)&&!allowUnlistedFiles)throw ocrError('OCR_ASSET_INVALID','OCR 运行组件出现清单外文件，请重新核验安装。',503);}};
  for(const pkg of lock.packages){
    if(typeof pkg.name!=='string'||!/^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(pkg.name)||typeof pkg.version!=='string'||typeof pkg.integrity!=='string'||!/^sha512-[A-Za-z0-9+/]+=*$/.test(pkg.integrity)||!pkg.url?.startsWith('https://registry.npmjs.org/'))throw ocrError('OCR_RUNTIME_UNAVAILABLE','OCR 依赖锁无效。',503);
    const pin=OCR_PACKAGES.find(p=>p.name===pkg.name);if(pin&&(pkg.version!==pin.version||pkg.integrity!==pin.integrity||pkg.url!==pin.url))throw ocrError('OCR_RUNTIME_UNAVAILABLE','OCR 依赖来源与固定清单不符。',503);
    const root=path.join(runtimeRoot,pkg.name);await assertNoOcrPathLinks(root);const real=await fs.realpath(root),allowed=await fs.realpath(runtimeRoot);if(!real.startsWith(allowed+path.sep))throw ocrError('OCR_ASSET_INVALID','OCR 依赖越过本地运行目录。',503);
    const manifest=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));if(manifest.name!==pkg.name||manifest.version!==pkg.version)throw ocrError('OCR_ASSET_INVALID','OCR 依赖版本不符合清单。',503);
    await walk(root,pkg.name);
    for(const dependency of Object.keys(manifest.dependencies||{})){
      if(!lock.packages.some(p=>p.name===dependency))throw ocrError('OCR_RUNTIME_UNAVAILABLE','OCR 传递依赖未完整固定。',503);
      requests.push({from:pkg.name,dependency});
    }
  }
  const results=await resolveRuntimeDependencies(runtimeRoot,requests,resolver);
  for(const [i,result] of results.entries()){
    if(result.from!==requests[i].from||result.dependency!==requests[i].dependency||result.error||typeof result.entry!=='string')throw ocrError('OCR_RUNTIME_UNAVAILABLE','OCR 依赖无法按当前 Node 规则解析。',503);
    // Some packages declare an npm fallback whose bare name is a Node built-in
    // (readable-stream -> string_decoder). Honor the actual fresh resolution.
    if(result.entry===result.dependency&&isBuiltin(result.entry))continue;
    if(!path.isAbsolute(result.entry))throw ocrError('OCR_RUNTIME_UNAVAILABLE','OCR 依赖没有固定物理入口。',503);
    const expectedRoot=path.join(runtimeRoot,result.dependency),within=path.relative(expectedRoot,result.entry),relative=path.relative(runtimeRoot,result.entry).replaceAll('\\','/');
    if(!within||within==='..'||within.startsWith('..'+path.sep)||path.isAbsolute(within)||!known.has(relative))throw ocrError('OCR_ASSET_INVALID','OCR 实际依赖解析指向未固定文件。',503);
    await assertNoOcrPathLinks(result.entry);
  }
}

/** The shipped runtime lock is trusted build metadata; local installation receipts cannot authorize code. */
export async function inspectOcrAssets({assetDir,runtimeRoot,runtimeLockPath,launchSpec,verifiedLaunch}={}){
  try{
    const receiptPath=path.join(assetDir,'installation.json');
    const receipt=JSON.parse(await fs.readFile(receiptPath,'utf8'));
    if(receipt.version!==1||receipt.language!=='eng'||receipt.packageIntegrity!==OCR_PACKAGES[2].integrity)throw ocrError('OCR_ASSET_INVALID','英语 OCR 安装记录无效。',503);
    const language=await checkedLocalFile(assetDir,'eng.traineddata.gz',receipt.languageHash,16*1024*1024);
    // Explicit runtime/lock overrides are retained for read-only policy tests.
    // Production callers use one fixed launch spec for inspection and execution.
    const spec=launchSpec||(!runtimeRoot&&!runtimeLockPath?await createOcrLaunchSpec():null);
    if(spec){if(!isVerifiedOcrLaunch(verifiedLaunch,spec))await verifyOcrLaunchSpec(spec);runtimeRoot=spec.runtimeRoot;runtimeLockPath=spec.runtimeLockPath;}
    runtimeRoot||=DEFAULT_RUNTIME_ROOT;runtimeLockPath||=DEFAULT_RUNTIME_LOCK;
    let lock;try{lock=JSON.parse(await fs.readFile(runtimeLockPath,'utf8'));}catch{throw ocrError('OCR_RUNTIME_UNAVAILABLE','本版本未包含经过校验的 OCR 运行组件。',503);}
    if(lock.version!==1||lock.packageVersion!=='7.0.0'||lock.coreVersion!=='7.0.0'||!Array.isArray(lock.files)||!lock.files.length||lock.files.length>1000)throw ocrError('OCR_RUNTIME_UNAVAILABLE','OCR 运行组件清单无效。',503);
    if(!HASH.test(lock.languageHash||'')||lock.languageHash!==language.sha256)throw ocrError('OCR_ASSET_INVALID','英语 OCR 数据不符合本版本的固定清单。',503);
    const required=['tesseract.js/src/index.js','tesseract.js/src/worker-script/node/index.js','tesseract.js/src/worker-script/node/getCore.js','tesseract.js-core/package.json',...OCR_CORE_FILES];
    if(required.some(f=>!lock.files.some(x=>x.path===f)))throw ocrError('OCR_RUNTIME_UNAVAILABLE','OCR 运行组件清单不完整。',503);
    await assertOcrRuntimeClosure(runtimeRoot,lock,spec?{resolver:{executable:spec.executable,entryPath:spec.resolverPath,cwd:spec.cwd}}:{});
    const files=[];for(const f of lock.files)files.push({name:f.path,...await checkedLocalFile(runtimeRoot,f.path,f.sha256)});
    return {state:'installed',available:true,language:'eng',packageVersion:'7.0.0',coreVersion:'7.0.0',languageVersion:'1.0.0',language,files,workerPath:path.join(runtimeRoot,'tesseract.js/src/worker-script/node/index.js'),modulePath:path.join(runtimeRoot,'tesseract.js/src/index.js'),assetDir,runtimeRoot,launchSpec:spec,runtimeLockHash:hash(Buffer.from(JSON.stringify(lock))),networkPolicy:'no_active_network_requests',memoryPolicy:'sampled_process_rss_with_termination'};
  }catch(e){return {state:'unavailable',available:false,code:e.code==='ENOENT'?'OCR_ASSETS_MISSING':e.code||'OCR_ASSET_INVALID',detail:e.code==='ENOENT'?'尚未安装英语 OCR；普通文字文档和练习仍可使用。':e.message};}
}
