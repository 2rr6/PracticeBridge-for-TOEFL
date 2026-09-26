// Build-time only: run after the specifically authorized, integrity-verified
// installation. This hashes an existing tree; it never downloads or installs.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {OCR_PACKAGES,hash,assertNoOcrPathLinks,assertOcrRuntimeClosure} from '../src/ocr-policy.mjs';

export async function collectOcrRuntimeLock({root,languageFile}){
  if(!languageFile||!path.isAbsolute(languageFile)||!root||!path.isAbsolute(root))throw Error('Pass absolute paths of the verified runtime and eng.traineddata.gz after download approval.');
  const runtime=path.join(root,'node_modules');await assertNoOcrPathLinks(runtime);await assertNoOcrPathLinks(languageFile);await assertNoOcrPathLinks(path.join(root,'package-lock.json'));
  const packageLock=JSON.parse(await fs.readFile(path.join(root,'package-lock.json'),'utf8')),files=[],packages=[],queue=['tesseract.js'],seen=new Set();
  const walk=async(dir,prefix)=>{for(const entry of (await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const name=`${prefix}/${entry.name}`;if(entry.isSymbolicLink()||entry.isDirectory()&&entry.name==='node_modules')throw Error(`Unreviewed link or nested runtime dependency: ${name}`);if(entry.isDirectory())await walk(path.join(dir,entry.name),name);else if(entry.isFile()){const bytes=await fs.readFile(path.join(dir,entry.name));files.push({path:name,sha256:hash(bytes),size:bytes.length});}else throw Error('Unsupported runtime file');}};
  while(queue.length){
    const name=queue.shift();if(seen.has(name))continue;seen.add(name);if(!/^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(name))throw Error('Invalid dependency name');
    const dir=path.join(runtime,name);await assertNoOcrPathLinks(dir);await assertNoOcrPathLinks(path.join(dir,'package.json'));
    const manifest=JSON.parse(await fs.readFile(path.join(dir,'package.json'),'utf8')),lock=packageLock.packages[`node_modules/${name}`];if(!lock||manifest.name!==name||manifest.version!==lock.version||!lock.integrity||!lock.resolved?.startsWith('https://registry.npmjs.org/'))throw Error(`Runtime provenance missing for ${name}`);const pin=OCR_PACKAGES.find(p=>p.name===name);if(pin&&(manifest.version!==pin.version||lock.integrity!==pin.integrity))throw Error(`Fixed package mismatch: ${name}`);packages.push({name,version:manifest.version,integrity:lock.integrity,url:lock.resolved});await walk(dir,name);queue.push(...Object.keys(manifest.dependencies||{}));
  }
  if(!seen.has('tesseract.js-core'))throw Error('Core dependency missing');
  const language=await fs.readFile(languageFile),lock={version:1,packageVersion:'7.0.0',coreVersion:'7.0.0',languageVersion:'1.0.0',languageHash:hash(language),languagePackage:OCR_PACKAGES[2],packages:packages.sort((a,b)=>a.name.localeCompare(b.name)),files:files.sort((a,b)=>a.path.localeCompare(b.path))};
  await assertOcrRuntimeClosure(runtime,lock);return lock;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=fileURLToPath(new URL('../',import.meta.url)),lock=await collectOcrRuntimeLock({root,languageFile:process.argv[2]}),destination=path.join(root,'assets','ocr-runtime-lock.json');
  await fs.mkdir(path.dirname(destination),{recursive:true});await assertNoOcrPathLinks(path.dirname(destination));try{await assertNoOcrPathLinks(destination);}catch(e){if(e.code!=='ENOENT')throw e;}
  await fs.writeFile(destination,JSON.stringify(lock,null,2)+'\n');console.log(JSON.stringify({packages:lock.packages.length,files:lock.files.length,languageHash:lock.languageHash,runtimeBytes:lock.files.reduce((n,f)=>n+f.size,0)}));
}
