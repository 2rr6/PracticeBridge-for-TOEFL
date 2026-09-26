// Generates a candidate inventory for review; packaging never silently refreshes it.
import {readFile,writeFile,lstat,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {projectRoot,json,walk,sha256} from './audit-release.mjs';
const root=projectRoot,lock=await json(resolve(root,'package-lock.json')),files=[],packages=[];
// OCR preflight deliberately hashes the complete reviewed official package
// trees. Apply their exact manifest before generic dependency filtering.
const ocrFiles=new Map(),ocrPackages=new Set();
if(lock.packages['node_modules/tesseract.js']&&!lock.packages['node_modules/tesseract.js'].dev){
  const ocr=await json(resolve(root,'assets/ocr-runtime-lock.json'));
  if(ocr.version!==1||!Array.isArray(ocr.packages)||!ocr.packages.length||!Array.isArray(ocr.files)||!ocr.files.length)throw new Error('OCR release manifest is missing or invalid');
  for(const pkg of ocr.packages){
    const entry=lock.packages[`node_modules/${pkg.name}`];
    if(!/^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(pkg.name)||ocrPackages.has(`node_modules/${pkg.name}`)||!entry||entry.dev||pkg.version!==entry.version||pkg.integrity!==entry.integrity||pkg.url!==entry.resolved)throw new Error('OCR release package provenance differs from the reviewed lock');
    ocrPackages.add(`node_modules/${pkg.name}`);
  }
  for(const file of ocr.files){
    const name=`node_modules/${file.path}`;
    if(typeof file.path!=='string'||file.path.includes('\\')||file.path.split('/').some(p=>!p||p==='.'||p==='..')||!Array.from(ocrPackages).some(pkg=>name.startsWith(pkg+'/'))||ocrFiles.has(name)||!/^[a-f0-9]{64}$/.test(file.sha256)||!Number.isSafeInteger(file.size)||file.size<0)throw new Error('OCR release file manifest is invalid');
    ocrFiles.set(name,file);
  }
}
const remainingOcr=new Set(ocrFiles.keys());
for(const [path,entry] of Object.entries(lock.packages)) {
  if(!path||entry.dev)continue;
  try {await lstat(resolve(root,path));}catch(error){if(entry.optional&&error.code==='ENOENT')continue;throw error;}
  const installed=await json(resolve(root,path,'package.json'));
  if(installed.version!==entry.version)throw new Error(`Installed version differs from lock: ${path}`);
  packages.push({path,name:installed.name,version:entry.version,license:entry.license??installed.license,integrity:entry.integrity});
  for(const name of await walk(root,path)) {
    // Nested dependencies have their own lock entry and provenance.
    const nested=name.slice(path.length+1).includes('/node_modules/')||name.slice(path.length+1).startsWith('node_modules/');
    if(nested){if(ocrPackages.has(path))throw new Error(`OCR release refuses an unreviewed nested dependency: ${name}`);continue;}
    const pinned=ocrFiles.get(name);
    if(ocrPackages.has(path)&&!pinned)throw new Error(`OCR release refuses an unreviewed file: ${name}`);
    if(!pinned&&(/(?:^|\/)(?:test|tests|examples|docs|\.github)(?:\/|$)/.test(name.slice(path.length+1))||/\.(?:map|ts)$/.test(name)))continue;
    const bytes=await readFile(resolve(root,name));
    if(pinned){if(bytes.length!==pinned.size||sha256(bytes)!==pinned.sha256)throw new Error(`OCR release bytes differ from the reviewed lock: ${name}`);remainingOcr.delete(name);}
    files.push({path:name,bytes:bytes.length,sha256:sha256(bytes),origin:`npm:${installed.name}@${entry.version}`,license:entry.license??installed.license});
  }
}
if(remainingOcr.size)throw new Error(`OCR release files are missing: ${[...remainingOcr].join(', ')}`);
const candidate={schemaVersion:1,platform:`${process.platform}-${process.arch}`,lockfileCanonicalSha256:sha256(JSON.stringify(lock)),packages,files:files.sort((a,b)=>a.path.localeCompare(b.path,'en'))};
await mkdir(resolve(root,'test-results'),{recursive:true});
const output=resolve(root,'test-results',`runtime-dependencies-${Date.now()}.candidate.json`);
await writeFile(output,JSON.stringify(candidate,null,2)+'\n',{flag:'wx'});
console.log(`Candidate only: ${output}; ${packages.length} production packages, ${files.length} exact files. Review sources/licenses/assets before copying to docs/development/runtime-dependencies.json.`);
