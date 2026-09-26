import {packager} from '@electron/packager';
import {readFile,readdir,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ZipReader,Uint8ArrayReader,Uint8ArrayWriter} from '@zip.js/zip.js';
import {projectRoot,stageRelease,auditAsar,auditDirectory,sha256,json,walk,outputDirectory,asarUnpackPattern} from './audit-release.mjs';
// stageRelease and auditDirectory already enforce the exact release inventory.
// A function disables Packager's defaults, which otherwise remove lockfiles.
export const stagedCopyOptions=Object.freeze({prune:false,junk:false,ignore:()=>false});
async function runPackage(args=process.argv.slice(2)) {
const root=projectRoot;
if(args.length&&!(args.length===2&&args[0]==='--out'))throw new Error('Usage: node scripts/package.mjs [--out dist/BUILD]');
const out=resolve(root,args[1]??`dist/build-${Date.now()}`),rel=relative(resolve(root,'dist'),out);
if(!rel||rel.startsWith('..')||isAbsolute(rel))throw new Error('Package output must be a new directory inside dist.');
await outputDirectory(out,root);if((await readdir(out)).length)throw new Error('Package output must be empty.');
const tools=await json(resolve(root,'docs/development/release-tools.json'));
const electronVersion=(await json(resolve(root,'node_modules/electron/package.json'))).version;
if(electronVersion!==tools.electron.version)throw new Error('Electron release provenance is stale.');
const cache=resolve(process.env.PRACTICEBRIDGE_ELECTRON_CACHE??resolve(root,'.cache/electron'));
let archive;
for(const name of ['',...await readdir(cache)]){const candidate=resolve(cache,name,`electron-v${electronVersion}-win32-x64.zip`);try{const bytes=await readFile(candidate);if(sha256(bytes)!==tools.electron.windowsArchiveSha256)throw new Error('Electron archive hash mismatch');archive={path:candidate,bytes};break;}catch(error){if(!['ENOENT','ENOTDIR','EISDIR'].includes(error.code))throw error;}}
if(!archive)throw new Error('Verified Electron archive missing. Set PRACTICEBRIDGE_ELECTRON_CACHE to a local archive cache; packaging never downloads.');
const stage=await mkdtemp(resolve(out,'runtime-stage-'));
const inventory=await stageRelease({root,stage,kind:'runtime'});
await auditDirectory(stage,inventory);
const output=await packager({dir:stage,out,tmpdir:resolve(out,'packager-temporary'),name:'PracticeBridge',platform:'win32',arch:'x64',icon:resolve(stage,'desktop/icon.ico'),electronVersion,electronZipDir:resolve(archive.path,'..'),overwrite:false,asar:{unpack:asarUnpackPattern(inventory,out)},...stagedCopyOptions,win32metadata:{CompanyName:'2rr6',FileDescription:'PracticeBridge for TOEFL local practice workspace',ProductName:'PracticeBridge',InternalName:'PracticeBridge'}});
if(output.length!==1)throw new Error('Expected one Windows application');
const app=output[0],asarResult=await auditAsar(resolve(app,'resources/app.asar'),inventory);
// Check every distribution file against the pinned Electron archive. Only the
// renamed executable is intentionally rewritten by packager (icon/version/ASAR integrity).
const expected=new Map(),reader=new ZipReader(new Uint8ArrayReader(new Uint8Array(archive.bytes)));
try{for(const entry of await reader.getEntries())if(!entry.directory&&entry.filename!=='resources/default_app.asar'){
 const name=entry.filename==='electron.exe'?'PracticeBridge.exe':entry.filename;
 const bytes=await entry.getData(new Uint8ArrayWriter());expected.set(name,{sha256:sha256(bytes),bytes:bytes.length,origin:`electron@${electronVersion} official Windows archive`});
}}finally{await reader.close();}
expected.set('resources/app.asar',{origin:'PracticeBridge audited ASAR'});
for(const file of inventory.files.filter(f=>f.unpacked))expected.set(`resources/app.asar.unpacked/${file.path}`,{...file,origin:file.origin});
const applicationFiles=[];
for(const path of await walk(app)){
 const registered=expected.get(path);if(!registered)throw new Error(`Unexpected application distribution file: ${path}`);
 const bytes=await readFile(resolve(app,path)),hash=sha256(bytes);
 if(registered.sha256&&path!=='PracticeBridge.exe'&&(registered.sha256!==hash||registered.bytes!==bytes.length))throw new Error(`Electron distribution hash mismatch: ${path}`);
 applicationFiles.push({path,bytes:bytes.length,sha256:hash,origin:path==='PracticeBridge.exe'?`@electron/packager ${(await json(resolve(root,'node_modules/@electron/packager/package.json'))).version} metadata/icon/ASAR-integrity rewrite of pinned Electron executable`:registered.origin});expected.delete(path);
}
if(expected.size)throw new Error(`Missing application distribution files: ${[...expected.keys()]}`);
await writeFile(resolve(out,'runtime-inventory.json'),JSON.stringify({...inventory,audit:asarResult},null,2)+'\n');
await writeFile(resolve(out,'application-inventory.json'),JSON.stringify({schemaVersion:1,createdAt:new Date().toISOString(),electronArchiveSha256:sha256(archive.bytes),files:applicationFiles},null,2)+'\n');
await auditDirectory(app,{files:applicationFiles});
console.log(JSON.stringify({application:app,...asarResult,applicationFiles:applicationFiles.length},null,2));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await runPackage();
