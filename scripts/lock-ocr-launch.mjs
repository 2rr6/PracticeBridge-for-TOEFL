// Build-time collector only. Hash an already installed and reviewed runtime
// inventory; never install, download, update a release inventory, or package.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {defaultSanitizePackageJson} from '@electron/packager';
import {OCR_LAUNCH_PROJECT_FILES,OCR_PHYSICAL_COMPANIONS,OCR_LAUNCH_LOCK,validateOcrLaunchLock} from '../src/ocr-launch.mjs';
import {hash,assertNoOcrPathLinks} from '../src/ocr-policy.mjs';

export const ocrRuntimePackageBytes=bytes=>Buffer.from(JSON.stringify(defaultSanitizePackageJson(JSON.parse(bytes)),null,2)+'\n');
export async function collectOcrLaunchLock({root,runtimeInventory}={}){
  if(!path.isAbsolute(root||'')||!path.isAbsolute(runtimeInventory||''))throw Error('Pass fixed absolute project and reviewed runtime inventory paths.');
  await assertNoOcrPathLinks(root);await assertNoOcrPathLinks(runtimeInventory);
  const inventoryBytes=await fs.readFile(runtimeInventory),inventory=JSON.parse(inventoryBytes),packageLock=JSON.parse(await fs.readFile(path.join(root,'package-lock.json'),'utf8'));
  const packageLockCanonicalHash=hash(Buffer.from(JSON.stringify(packageLock)));
  if(inventory.schemaVersion!==1||inventory.platform!=='win32-x64'||inventory.lockfileCanonicalSha256!==packageLockCanonicalHash||!Array.isArray(inventory.packages)||!Array.isArray(inventory.files))throw Error('Runtime inventory is stale or targets an unverified platform.');
  const packages=[];
  for(const pkg of inventory.packages){
    const locked=packageLock.packages[pkg.path];
    if(pkg.path!==`node_modules/${pkg.name}`||!locked||locked.dev||locked.version!==pkg.version||locked.integrity!==pkg.integrity||!locked.resolved?.startsWith('https://registry.npmjs.org/'))throw Error('Runtime package provenance differs from package-lock.json.');
    packages.push({name:pkg.name,version:pkg.version,integrity:pkg.integrity,url:locked.resolved});
  }
  const packageNames=new Set(packages.map(pkg=>pkg.name)),files=[];
  if(packageNames.size!==packages.length||!['@napi-rs/canvas','@napi-rs/canvas-win32-x64-msvc','pdfjs-dist','tesseract.js','tesseract.js-core'].every(name=>packageNames.has(name)))throw Error('OCR/PDF/native package closure is incomplete.');
  for(const file of inventory.files){
    if(typeof file.path!=='string'||!file.path.startsWith('node_modules/')||file.path.includes('\\')||file.path.split('/').some(value=>!value||value==='.'||value==='..')||!packages.some(pkg=>file.path.startsWith(`node_modules/${pkg.name}/`)))throw Error('Unsafe or unowned runtime inventory file.');
    const target=path.join(root,file.path);await assertNoOcrPathLinks(target);const stat=await fs.lstat(target),bytes=await fs.readFile(target);
    if(!stat.isFile()||bytes.length!==file.bytes||hash(bytes)!==file.sha256)throw Error(`Runtime inventory bytes changed: ${file.path}`);
    files.push({path:file.path,bytes:file.bytes,sha256:file.sha256});
  }
  let developmentPackageJson;
  for(const name of OCR_LAUNCH_PROJECT_FILES){
    const target=path.join(root,name);await assertNoOcrPathLinks(target);const stat=await fs.lstat(target),source=await fs.readFile(target);
    if(!stat.isFile())throw Error('Fixed project entry is not a file.');
    const bytes=name==='package.json'?ocrRuntimePackageBytes(source):source;
    if(name==='package.json')developmentPackageJson={path:name,bytes:source.length,sha256:hash(source)};
    files.push({path:name,bytes:bytes.length,sha256:hash(bytes)});
  }
  for(const companion of OCR_PHYSICAL_COMPANIONS){
    const target=path.join(root,companion.path);await assertNoOcrPathLinks(target);const stat=await fs.lstat(target),bytes=await fs.readFile(target);
    if(!stat.isFile()||bytes.length!==companion.bytes||hash(bytes)!==companion.sha256)throw Error(`Reviewed physical companion bytes changed: ${companion.path}`);
    files.push({path:companion.path,bytes:companion.bytes,sha256:companion.sha256});
  }
  const ocr=JSON.parse(await fs.readFile(path.join(root,'assets/ocr-runtime-lock.json'),'utf8'));
  for(const file of ocr.files){const entry=files.find(value=>value.path===`node_modules/${file.path}`);if(!entry||entry.sha256!==file.sha256||entry.bytes!==file.size)throw Error('Launch closure omits a reviewed OCR runtime file.');}
  const lock={version:1,profile:'windows-x64-ocr-physical-v1',platform:'win32-x64',packageLockCanonicalHash,sourceInventoryHash:hash(inventoryBytes),packageTransform:'@electron/packager.defaultSanitizePackageJson; JSON.stringify(value,null,2)+LF',developmentPackageJson,physicalCompanions:OCR_PHYSICAL_COMPANIONS.map(file=>({...file})),groups:{ocrPackages:ocr.packages.map(pkg=>pkg.name).sort(),documentPackages:['@napi-rs/canvas','@napi-rs/canvas-win32-x64-msvc','pdfjs-dist'],sharedRuntimePackages:packages.filter(pkg=>!ocr.packages.some(value=>value.name===pkg.name)&&!['@napi-rs/canvas','@napi-rs/canvas-win32-x64-msvc','pdfjs-dist'].includes(pkg.name)).map(pkg=>pkg.name).sort()},packages:packages.sort((a,b)=>a.name.localeCompare(b.name,'en')),files:files.sort((a,b)=>a.path.localeCompare(b.path,'en'))};
  validateOcrLaunchLock(lock);return lock;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=fileURLToPath(new URL('../',import.meta.url)),runtimeInventory=path.resolve(process.argv[2]||path.join(root,'docs/development/runtime-dependencies.json')),lock=await collectOcrLaunchLock({root,runtimeInventory}),output=path.join(root,OCR_LAUNCH_LOCK);
  await assertNoOcrPathLinks(path.dirname(output));try{await assertNoOcrPathLinks(output);}catch(error){if(error.code!=='ENOENT')throw error;}
  await fs.writeFile(output,JSON.stringify(lock,null,2)+'\n');
  process.stdout.write(JSON.stringify({output,packages:lock.packages.length,files:lock.files.length,bytes:lock.files.reduce((sum,file)=>sum+file.bytes,0),runtimePackageJson:lock.files.find(file=>file.path==='package.json'),developmentPackageJson:lock.developmentPackageJson})+'\n');
}
