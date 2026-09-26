import {readFile, writeFile, mkdir, readdir, lstat, realpath} from 'node:fs/promises';
import {resolve, relative, dirname, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {listPackage, statFile, extractFile, uncacheAll} from '@electron/asar';
import {ZipReader, Uint8ArrayReader, Uint8ArrayWriter} from '@zip.js/zip.js';
import {defaultSanitizePackageJson} from '@electron/packager';

export const projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export const json=async file=>JSON.parse(await readFile(file,'utf8'));
const slash=value=>value.replaceAll('\\','/');
function safeName(name) {
  if(typeof name!=='string'||!name||name.includes('\\')||isAbsolute(name)||name.split('/').some(p=>!p||p==='.'||p==='..')||/[:\x00-\x1f]/.test(name)) throw new Error(`Unsafe release path: ${name}`);
  return name;
}
export async function walk(root, prefix='') {
  const output=[];
  for(const name of (await readdir(resolve(root,prefix))).sort()) {
    const rel=prefix?`${prefix}/${name}`:name, stat=await lstat(resolve(root,rel));
    if(stat.isSymbolicLink()) throw new Error(`Release refuses symbolic link: ${rel}`);
    if(stat.isDirectory()) output.push(...await walk(root,rel));
    else if(stat.isFile()) output.push(rel);
    else throw new Error(`Release refuses special file: ${rel}`);
  }
  return output;
}
async function readSafe(root,name) {
  safeName(name);let current=root;
  for(const part of name.split('/')) {current=resolve(current,part);if((await lstat(current)).isSymbolicLink())throw new Error(`Release refuses symbolic link: ${name}`);}
  return readFile(current);
}
export async function loadPolicy(root=projectRoot) {return json(resolve(root,'docs/development/release-policy.json'));}
export async function outputDirectory(value,root=projectRoot) {
  const target=resolve(root,value),rel=relative(resolve(root,'dist'),target);
  if(rel.startsWith('..')||isAbsolute(rel))throw new Error('Release output must remain inside this project dist directory');
  let current=root;
  for(const part of relative(root,target).split(/[\\/]/)) {
    current=resolve(current,part);
    try{if((await lstat(current)).isSymbolicLink())throw new Error('Release output refuses symbolic-link directories');}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  await mkdir(target,{recursive:true});return target;
}
export async function dependencyInventory(root=projectRoot) {
  const manifest=await json(resolve(root,'docs/development/runtime-dependencies.json')),lock=await json(resolve(root,'package-lock.json'));
  if(manifest.lockfileCanonicalSha256!==sha256(JSON.stringify(lock))) throw new Error('Runtime dependency inventory is stale; review dependency assets and regenerate it.');
  if(manifest.platform!==`${process.platform}-${process.arch}`) throw new Error(`Runtime inventory targets ${manifest.platform}; review an inventory for ${process.platform}-${process.arch}.`);
  return manifest.files;
}
export function validateInventory(manifest,kind,policy,dependencyFiles=[]) {
  if(manifest.kind!==kind)throw new Error('Release inventory kind mismatch');
  const expected=new Map([...policy[kind].map(path=>({path})),...(kind==='runtime'?dependencyFiles:[])].map(entry=>[entry.path,entry]));
  for(const file of manifest.files) {
    safeName(file.path);const entry=expected.get(file.path);
    if(!entry)throw new Error(`Unexpected/unregistered inventory file: ${file.path}`);
    const asset=policy.assets?.find(a=>a.path===file.path);
    if(entry.sha256?entry.sha256!==file.sha256:asset&&![asset.sha256,asset.gitLfSha256].includes(file.sha256))throw new Error(`Inventory differs from reviewed dependency/asset hash: ${file.path}`);
    const unpacked=kind==='runtime'&&((policy.unpacked??[]).includes(file.path)||file.path.endsWith('.node'));
    if(Boolean(file.unpacked)!==unpacked)throw new Error(`Inventory unpack policy mismatch: ${file.path}`);
    expected.delete(file.path);
  }
  if(expected.size)throw new Error(`Missing registered inventory files: ${[...expected.keys()].join(', ')}`);
}
export function asarUnpackPattern(manifest,buildDirectory) {
  // Include the literal build root: a bare globstar will not cross a hidden
  // ancestor such as .worktrees. ASAR/minimatch normalizes Windows separators.
  if(!buildDirectory)throw new Error('An explicit ASAR build directory is required');
  const escape=value=>value.replace(/[\\*?\[\]{},()!+@]/g,'\\$&');
  const prefix=escape(slash(resolve(buildDirectory)))+'/**/';
  // Share literal directory prefixes instead of repeating the absolute build
  // root for every file. A flat list exceeds minimatch's pattern-size limit
  // for the fixed OCR closure. Nested braces still enumerate exact leaves;
  // they do not authorize unpacking a directory or a filename wildcard.
  const tree=new Map();
  for(const file of manifest.files.filter(file=>file.unpacked)){
    let node=tree;for(const part of safeName(file.path).split('/')){if(!node.has(part))node.set(part,new Map());node=node.get(part);}
  }
  const render=node=>{
    const choices=[...node.entries()].sort(([a],[b])=>a.localeCompare(b,'en')).map(([part,children])=>escape(part)+(children.size?'/'+render(children):''));
    return choices.length>1?`{${choices.join(',')}}`:choices[0];
  };
  return tree.size?prefix+render(tree):undefined;
}
export async function stageRelease({root=projectRoot,stage,kind,policy,dependencyFiles}) {
  if(!['source','runtime'].includes(kind))throw new Error('Unknown release kind');
  policy??=await loadPolicy(root);
  const names=policy[kind];
  if(!Array.isArray(names)||new Set(names).size!==names.length)throw new Error('Invalid or duplicate release policy entries');
  const allowed=new Set(names);
  for(const prefix of policy.coverageRoots??[]) {
    try {await lstat(resolve(root,prefix));} catch(error){if(error.code==='ENOENT')continue;throw error;}
    for(const name of await walk(root,prefix))if(!allowed.has(name)&&!(kind==='runtime'&&!/^(src|public|desktop|schemas|tools\/asr-worker)(\/|$)/.test(prefix)&&policy.source?.includes(name)))throw new Error(`Unregistered release file: ${name}`);
  }
  const dependencies=kind==='runtime'?(dependencyFiles??await dependencyInventory(root)):[],expected=[...names.map(path=>({path})),...dependencies];
  if(new Set(expected.map(x=>x.path)).size!==expected.length)throw new Error('Duplicate staged path');
  // Callers own new output directories. Never empty or replace an existing directory.
  await outputDirectory(stage,root);if((await readdir(stage)).length)throw new Error('Release staging directory must be empty');
  const files=[];
  for(const entry of expected.sort((a,b)=>a.path.localeCompare(b.path,'en'))) {
    const original=await readSafe(root,entry.path),bytes=kind==='runtime'&&entry.path==='package.json'?Buffer.from(JSON.stringify(defaultSanitizePackageJson(JSON.parse(original)),null,2)+'\n'):original,hash=sha256(bytes);
    if(entry.sha256&&entry.sha256!==hash)throw new Error(`Dependency hash mismatch: ${entry.path}`);
    const asset=policy.assets?.find(a=>a.path===entry.path);
    if(asset&&![asset.sha256,asset.gitLfSha256].includes(hash))throw new Error(`Reviewed asset hash mismatch: ${entry.path}`);
    if(/\.(?:pdf|wav|mp3|ogg|webm|png|ico|zip|docx|wasm|node|traineddata)$/i.test(entry.path)&&!entry.sha256&&!asset)throw new Error(`Unregistered binary asset: ${entry.path}`);
    const target=resolve(stage,safeName(entry.path));await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes,{flag:'wx'});
    files.push({path:entry.path,bytes:bytes.length,sha256:hash,unpacked:kind==='runtime'&&((policy.unpacked??[]).includes(entry.path)||entry.path.endsWith('.node')),origin:entry.origin??asset?.source??'PracticeBridge source; see LICENSE and asset-provenance.json'});
  }
  return {schemaVersion:1,kind,version:(await json(resolve(root,'package.json'))).version,createdAt:new Date().toISOString(),files};
}
function compare(actual,manifest) {
  const expected=new Map(manifest.files.map(f=>[f.path,f]));
  for(const file of actual) {
    const entry=expected.get(file.path);if(!entry)throw new Error(`Unexpected/unregistered released file: ${file.path}`);
    if(entry.bytes!==file.bytes||entry.sha256!==file.sha256)throw new Error(`Released file size/hash mismatch: ${file.path}`);
    expected.delete(file.path);
  }
  if(expected.size)throw new Error(`Missing released files: ${[...expected.keys()].join(', ')}`);
  return {ok:true,fileCount:actual.length};
}
export async function auditDirectory(directory,manifest) {
  const files=[];for(const path of await walk(directory)){const bytes=await readFile(resolve(directory,path));files.push({path,bytes:bytes.length,sha256:sha256(bytes)});}
  return compare(files,manifest);
}
export async function auditAsar(archive,manifest) {
  uncacheAll();const files=[];
  for(const item of listPackage(archive)) {
    const nativePath=item.replace(/^[/\\]/,''),path=slash(nativePath);safeName(path);const stat=statFile(archive,nativePath,false);
    if(stat.link)throw new Error(`ASAR link is forbidden: ${path}`);if(stat.files)continue;
    const expected=manifest.files.find(f=>f.path===path);
    if(Boolean(stat.unpacked)!==Boolean(expected?.unpacked))throw new Error(`ASAR unpacked resource mismatch: ${path}`);
    const bytes=extractFile(archive,nativePath,false);files.push({path,bytes:bytes.length,sha256:sha256(bytes)});
  }
  const result=compare(files,manifest),unpacked=manifest.files.filter(f=>f.unpacked);
  if(unpacked.length)await auditDirectory(`${archive}.unpacked`,{files:unpacked});
  else {try{if((await walk(`${archive}.unpacked`)).length)throw new Error('Unexpected unpacked files');}catch(error){if(error.code!=='ENOENT')throw error;}}
  return {...result,unpackedFileCount:unpacked.length,asarSha256:sha256(await readFile(archive))};
}
export async function auditSource(archive,manifest) {
  const reader=new ZipReader(new Uint8ArrayReader(new Uint8Array(await readFile(archive)))),files=[];
  try {for(const entry of await reader.getEntries()) {
    if(entry.directory)continue;safeName(entry.filename);const bytes=await entry.getData(new Uint8ArrayWriter());files.push({path:entry.filename,bytes:bytes.length,sha256:sha256(bytes)});
  }} finally {await reader.close();}
  return {...compare(files,manifest),archiveSha256:sha256(await readFile(archive))};
}
export async function distPath(value,root=projectRoot) {
  if(!value)throw new Error('An explicit path inside dist is required');
  const target=await realpath(resolve(root,value)),dist=await realpath(resolve(root,'dist')),rel=relative(dist,target);
  if(dist!==resolve(await realpath(root),'dist'))throw new Error('Audit refuses a redirected dist directory');
  if(!rel||rel.startsWith('..')||isAbsolute(rel))throw new Error('Audit input must be inside this project dist directory');return target;
}
async function main() {
  const [mode,input,...extra]=process.argv.slice(2);
  if(extra.length||!['--source','--app'].includes(mode))throw new Error('Usage: node scripts/audit-release.mjs --source dist/FILE.zip | --app dist/APP-DIRECTORY');
  const target=await distPath(input),manifest=await json(mode==='--source'?`${target}.inventory.json`:resolve(dirname(target),'runtime-inventory.json'));
  validateInventory(manifest,mode==='--source'?'source':'runtime',await loadPolicy(),mode==='--app'?(await json(resolve(projectRoot,'docs/development/runtime-dependencies.json'))).files:[]);
  const result=mode==='--source'?await auditSource(target,manifest):await auditAsar(resolve(target,'resources/app.asar'),manifest);
  if(mode==='--app')await auditDirectory(target,await json(resolve(dirname(target),'application-inventory.json')));
  console.log(JSON.stringify({mode,input:slash(relative(projectRoot,target)),observedAt:new Date().toISOString(),...result},null,2));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
