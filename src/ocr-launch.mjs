import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const OCR_LAUNCH_PROJECT_FILES=Object.freeze(['package.json','package-lock.json','assets/ocr-runtime-lock.json','docs/practicebridge.v2.schema.json','src/package.mjs','src/package-schema.mjs','src/exam-plan.mjs','src/media-manifest.mjs','src/archive/zip-adapter.mjs','src/ocr-policy.mjs','src/ocr-evidence.mjs','src/ocr-launch.mjs','src/workers/ocr.mjs','src/workers/ocr-child.mjs','src/workers/ocr-thread.cjs','src/workers/ocr-resolve.cjs']);
// This shared-root companion is not an OCR import. Its exact reviewed bytes
// must coexist at the ASR launcher's original unpacked path, without permitting
// its directory or any future sidecar as an open-ended exception.
export const OCR_PHYSICAL_COMPANIONS=Object.freeze([Object.freeze({path:'tools/asr-worker/worker.py',role:'asr-worker',bytes:10607,sha256:'d72c899ab2a4de0ee99f806971dfc1936e7930072b2f279930a3695a8aade2ed'})]);
export const OCR_LAUNCH_LOCK='assets/ocr-launch-lock.json';
const MODULE_ROOT=path.resolve(fileURLToPath(new URL('../',import.meta.url)));
const HASH=/^[a-f0-9]{64}$/;
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const fail=(code,message)=>{throw Object.assign(new Error(message),{code,status:503});};
const safe=name=>typeof name==='string'&&name.length>0&&!path.isAbsolute(name)&&!/[\\:\x00-\x1f]/.test(name)&&name.split('/').every(part=>part&&part!=='.'&&part!=='..');
const virtualRoot=value=>path.resolve(value).split(path.sep).some(part=>part.toLowerCase().endsWith('.asar'));
const verifiedLaunches=new WeakSet();

export function ocrLaunchEnvironment(environment=process.env){
  const keys=new Set(['systemroot','windir','temp','tmp','tmpdir','lang','lc_all']);
  return Object.fromEntries(Object.entries(environment).filter(([key,value])=>keys.has(key.toLowerCase())&&typeof value==='string'));
}
export function ocrExecutionRoot(applicationRoot=MODULE_ROOT){
  if(typeof applicationRoot!=='string'||!path.isAbsolute(applicationRoot))fail('OCR_LAUNCH_INVALID','OCR 应用根目录无效。');
  const root=path.resolve(applicationRoot),name=path.basename(root);
  // One trusted conversion at the application-root boundary. Callers use the
  // resulting spec; worker paths never perform their own ASAR substitutions.
  return name.toLowerCase().endsWith('.asar')?path.join(path.dirname(root),name+'.unpacked'):root;
}
export function validateOcrLaunchLock(lock){
  if(!plain(lock)||lock.version!==1||lock.profile!=='windows-x64-ocr-physical-v1'||lock.platform!=='win32-x64'||!HASH.test(lock.packageLockCanonicalHash||'')||!Array.isArray(lock.packages)||lock.packages.length<13||lock.packages.length>50||!Array.isArray(lock.files)||!lock.files.length||lock.files.length>5000)fail('OCR_LAUNCH_INVALID','OCR 执行闭包清单无效。');
  const seen=new Set();
  for(const file of lock.files){if(!plain(file)||!safe(file.path)||!HASH.test(file.sha256||'')||!Number.isSafeInteger(file.bytes)||file.bytes<0||file.bytes>64*1024*1024||seen.has(file.path))fail('OCR_LAUNCH_INVALID','OCR 执行文件清单无效或重复。');seen.add(file.path);}
  if(!Array.isArray(lock.physicalCompanions)||lock.physicalCompanions.length!==OCR_PHYSICAL_COMPANIONS.length)fail('OCR_RUNTIME_INCOMPLETE','共享物理运行根缺少已审伴随文件清单。');
  for(const expected of OCR_PHYSICAL_COMPANIONS){
    const declared=lock.physicalCompanions.find(file=>file?.path===expected.path),listed=lock.files.find(file=>file.path===expected.path);
    if(!plain(declared)||Object.keys(declared).length!==4||Object.entries(expected).some(([key,value])=>declared[key]!==value)||!listed||listed.bytes!==expected.bytes||listed.sha256!==expected.sha256)fail('OCR_RUNTIME_INCOMPLETE','共享物理伴随文件没有匹配的已审字节清单。');
  }
  if(OCR_LAUNCH_PROJECT_FILES.some(name=>!seen.has(name))||lock.files.some(file=>!file.path.startsWith('node_modules/')&&!OCR_LAUNCH_PROJECT_FILES.includes(file.path)&&!OCR_PHYSICAL_COMPANIONS.some(companion=>companion.path===file.path)))fail('OCR_RUNTIME_INCOMPLETE','OCR 固定启动脚本或运行数据清单不完整。');
  const development=lock.developmentPackageJson;
  if(!plain(development)||development.path!=='package.json'||!HASH.test(development.sha256||'')||!Number.isSafeInteger(development.bytes)||development.bytes<1||lock.packageTransform!=='@electron/packager.defaultSanitizePackageJson; JSON.stringify(value,null,2)+LF')fail('OCR_LAUNCH_INVALID','OCR package 构建转换记录无效。');
  return lock;
}
const specFields=['version','launcher','profile','applicationRoot','executionRoot','executable','entryPath','workerPath','resolverPath','runtimeRoot','runtimeLockPath','launchLockPath','launchLockHash','cwd','writableJobDir'];
export function validateOcrLaunchSpec(spec){
  if(!plain(spec)||Object.keys(spec).some(key=>![...specFields,'specHash'].includes(key))||spec.version!==1||!['node','electron-run-as-node'].includes(spec.launcher)||!['development','runtime'].includes(spec.profile)||!HASH.test(spec.launchLockHash||'')||!HASH.test(spec.specHash||''))fail('OCR_LAUNCH_INVALID','OCR 启动规格无效。');
  for(const key of ['applicationRoot','executionRoot','executable','entryPath','workerPath','resolverPath','runtimeRoot','runtimeLockPath','launchLockPath','cwd'])if(typeof spec[key]!=='string'||!path.isAbsolute(spec[key])||!same(path.resolve(spec[key]),spec[key]))fail('OCR_LAUNCH_INVALID','OCR 启动路径不是固定绝对路径。');
  const root=spec.executionRoot;
  if(virtualRoot(root)||!same(spec.cwd,root)||!same(spec.executable,process.execPath)||spec.launcher!==(process.versions.electron?'electron-run-as-node':'node'))fail('OCR_LAUNCH_INVALID','OCR 需要当前程序与真实物理执行根。');
  for(const [key,relative] of [['entryPath','src/workers/ocr-child.mjs'],['workerPath','src/workers/ocr-thread.cjs'],['resolverPath','src/workers/ocr-resolve.cjs'],['runtimeRoot','node_modules'],['runtimeLockPath','assets/ocr-runtime-lock.json']])if(!same(spec[key],path.join(root,relative)))fail('OCR_LAUNCH_INVALID','OCR 脚本或依赖不属于同一固定执行根。');
  if(!same(spec.launchLockPath,path.join(spec.applicationRoot,OCR_LAUNCH_LOCK))||spec.profile!==(same(root,spec.applicationRoot)&&!virtualRoot(spec.applicationRoot)?'development':'runtime'))fail('OCR_LAUNCH_INVALID','OCR 构建清单或执行 profile 不匹配。');
  if(spec.writableJobDir!==null&&(typeof spec.writableJobDir!=='string'||!path.isAbsolute(spec.writableJobDir)||virtualRoot(spec.writableJobDir)||!same(path.resolve(spec.writableJobDir),spec.writableJobDir)))fail('OCR_LAUNCH_INVALID','OCR 作业目录必须是宿主的真实目录。');
  if(digest(Buffer.from(JSON.stringify(Object.fromEntries(specFields.map(key=>[key,spec[key]])))))!==spec.specHash)fail('OCR_LAUNCH_INVALID','OCR 启动规格已经改变。');
  return spec;
}
async function noLinks(file,checked=new Set()){
  const resolved=path.resolve(file);let current=path.parse(resolved).root;
  for(const part of ['',...path.relative(current,resolved).split(path.sep).filter(Boolean)]){
    if(part)current=path.join(current,part);if(checked.has(current))continue;
    const stat=await fs.lstat(current);if(stat.isSymbolicLink())fail('OCR_RUNTIME_REDIRECTED','OCR 执行路径含链接或重定向。');checked.add(current);
  }
  if(!same(await fs.realpath(resolved),resolved))fail('OCR_RUNTIME_REDIRECTED','OCR 实际执行路径与固定路径不同。');
  return resolved;
}
async function readLock(filename){
  await noLinks(filename);const stat=await fs.lstat(filename);if(!stat.isFile()||stat.size<1||stat.size>2*1024*1024)fail('OCR_LAUNCH_INVALID','OCR 执行清单大小无效。');
  const bytes=await fs.readFile(filename);return {bytes,lock:validateOcrLaunchLock(JSON.parse(bytes))};
}
export async function createOcrLaunchSpec({applicationRoot=MODULE_ROOT,executionRoot=ocrExecutionRoot(applicationRoot),writableJobDir=null}={}){
  applicationRoot=path.resolve(applicationRoot);executionRoot=path.resolve(executionRoot);
  const launchLockPath=path.join(applicationRoot,OCR_LAUNCH_LOCK);let bytes;
  try{({bytes}=await readLock(launchLockPath));}catch(error){if(error.code==='ENOENT')fail('OCR_LAUNCH_UNAVAILABLE','本版本还没有完整的固定 OCR 执行闭包。');throw error;}
  const value={version:1,launcher:process.versions.electron?'electron-run-as-node':'node',profile:same(executionRoot,applicationRoot)&&!virtualRoot(applicationRoot)?'development':'runtime',applicationRoot,executionRoot,executable:process.execPath,entryPath:path.join(executionRoot,'src/workers/ocr-child.mjs'),workerPath:path.join(executionRoot,'src/workers/ocr-thread.cjs'),resolverPath:path.join(executionRoot,'src/workers/ocr-resolve.cjs'),runtimeRoot:path.join(executionRoot,'node_modules'),runtimeLockPath:path.join(executionRoot,'assets/ocr-runtime-lock.json'),launchLockPath,launchLockHash:digest(bytes),cwd:executionRoot,writableJobDir:writableJobDir===null?null:path.resolve(writableJobDir)};
  const spec={...value,specHash:digest(Buffer.from(JSON.stringify(value)))};validateOcrLaunchSpec(spec);return Object.freeze(spec);
}
export function ocrLaunchForJob(spec,directory){
  validateOcrLaunchSpec(spec);const writableJobDir=path.resolve(directory);
  if(spec.writableJobDir!==null&&!same(spec.writableJobDir,writableJobDir))fail('OCR_LAUNCH_INVALID','OCR 启动规格不能挪用到另一作业目录。');
  const value=Object.fromEntries(specFields.map(key=>[key,key==='writableJobDir'?writableJobDir:spec[key]]));
  const result={...value,specHash:digest(Buffer.from(JSON.stringify(value)))};validateOcrLaunchSpec(result);return Object.freeze(result);
}
export const isVerifiedOcrLaunch=(value,spec)=>plain(value)&&verifiedLaunches.has(value)&&value.spec===spec;
export async function verifyOcrLaunchSpec(spec){
  validateOcrLaunchSpec(spec);const checked=new Set();let lock;
  try{
    await noLinks(spec.executionRoot,checked);if(!(await fs.lstat(spec.executionRoot)).isDirectory())fail('OCR_LAUNCH_INVALID','OCR 执行根必须是真实目录。');
    const loaded=await readLock(spec.launchLockPath);if(digest(loaded.bytes)!==spec.launchLockHash)fail('OCR_LAUNCH_INVALID','OCR 可信执行清单已经改变。');lock=loaded.lock;
    if(`${process.platform}-${process.arch}`!==lock.platform)fail('OCR_LAUNCH_PLATFORM','此 OCR 执行闭包只验证了 Windows x64。');
    for(const listed of lock.files){
      const file=listed.path==='package.json'&&spec.profile==='development'?lock.developmentPackageJson:listed,target=path.join(spec.executionRoot,file.path);
      await noLinks(target,checked);const stat=await fs.lstat(target);if(!stat.isFile()||stat.size!==file.bytes)fail('OCR_RUNTIME_CHANGED',`OCR 运行文件大小或类型不符：${file.path}`);
      if(digest(await fs.readFile(target))!==file.sha256)fail('OCR_RUNTIME_CHANGED',`OCR 运行文件校验失败：${file.path}`);
    }
    if(spec.profile==='runtime'){
      const known=new Set(lock.files.map(file=>file.path));
      const walk=async(dir,prefix='')=>{for(const entry of await fs.readdir(dir,{withFileTypes:true})){const name=prefix+entry.name;if(entry.isSymbolicLink())fail('OCR_RUNTIME_REDIRECTED','OCR 物理闭包含重定向。');if(entry.isDirectory())await walk(path.join(dir,entry.name),name+'/');else if(!entry.isFile()||!known.has(name))fail('OCR_RUNTIME_CHANGED',`OCR 物理闭包出现清单外文件：${name}`);}};
      await walk(spec.executionRoot);
    }
    if(spec.writableJobDir!==null){await noLinks(spec.writableJobDir);if(!(await fs.lstat(spec.writableJobDir)).isDirectory())fail('OCR_LAUNCH_INVALID','OCR 作业目录无效。');}
  }catch(error){if(error.code==='ENOENT')fail('OCR_RUNTIME_INCOMPLETE',`OCR 固定执行文件缺失：${error.path?path.relative(spec.executionRoot,error.path):'unknown'}`);throw error;}
  const runtimeFiles=lock.files.filter(file=>file.path.startsWith('node_modules/')).map(file=>({path:file.path.slice(13),sha256:file.sha256,size:file.bytes}));
  const {assertOcrRuntimeClosure}=await import('./ocr-policy.mjs');
  try{await assertOcrRuntimeClosure(spec.runtimeRoot,{packages:lock.packages,files:runtimeFiles},{resolver:{executable:spec.executable,entryPath:spec.resolverPath,cwd:spec.cwd},allowUnlistedFiles:spec.profile==='development'});}
  catch(error){if(error.code==='OCR_ASSET_INVALID'&&/实际依赖解析/.test(error.message))fail('OCR_RUNTIME_RESOLUTION_ESCAPE','OCR 实际模块解析逃离固定执行闭包。');throw error;}
  const verified=Object.freeze({spec,lock});verifiedLaunches.add(verified);return verified;
}
export function assertOcrLaunchModule(verified,resolvedUrl,packageName){
  if(!plain(verified)||!verifiedLaunches.has(verified))fail('OCR_LAUNCH_INVALID','OCR 模块验证缺少本进程预检凭据。');
  const filename=fileURLToPath(resolvedUrl),root=path.join(verified.spec.runtimeRoot,packageName),within=path.relative(root,filename),relative=path.relative(verified.spec.executionRoot,filename).replaceAll('\\','/');
  if(!within||within==='..'||within.startsWith('..'+path.sep)||path.isAbsolute(within)||!verified.lock.files.some(file=>file.path===relative))fail('OCR_RUNTIME_RESOLUTION_ESCAPE','OCR 实际入口解析到未固定模块。');
  return resolvedUrl;
}
