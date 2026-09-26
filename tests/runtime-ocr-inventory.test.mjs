import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,mkdir,cp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));

test('the generated runtime inventory retains every file required by the reviewed OCR lock',async()=>{
  const result=spawnSync(process.execPath,['scripts/release-inventory.mjs'],{cwd:root,encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(result.error,undefined);assert.equal(result.status,0,result.stdout+result.stderr);
  const output=result.stdout.match(/Candidate only: (.+); \d+ production packages, \d+ exact files\./)?.[1];assert.ok(output,result.stdout);
  const candidate=JSON.parse(await readFile(output,'utf8')),ocr=JSON.parse(await readFile(resolve(root,'assets/ocr-runtime-lock.json'),'utf8'));
  const files=new Map(candidate.files.map(file=>[file.path,file]));
  const missing=ocr.files.filter(file=>!files.has('node_modules/'+file.path)).map(file=>file.path);
  assert.deepEqual(missing,[],'the OCR preflight validates its complete reviewed tree, including published package docs/test/type assets');
  for(const file of ocr.files){const included=files.get('node_modules/'+file.path);assert.equal(included.sha256,file.sha256);assert.equal(included.bytes,file.size);}
});

test('the runtime generator rejects changed, missing and additional OCR package files',async t=>{
  const base=resolve(root,'test-results/runtime-ocr-inventory');await mkdir(base,{recursive:true});const dir=await mkdtemp(resolve(base,'run-'));
  t.after(async()=>{assert.ok(dir.startsWith(base));await rm(dir,{recursive:true,force:true});});
  for(const name of ['scripts','assets','node_modules/tesseract.js/docs'])await mkdir(resolve(dir,name),{recursive:true});
  for(const name of ['release-inventory.mjs','audit-release.mjs'])await cp(resolve(root,'scripts',name),resolve(dir,'scripts',name));
  await writeFile(resolve(dir,'package.json'),JSON.stringify({type:'module'}));
  const pkg={name:'tesseract.js',version:'7.0.0',integrity:'sha512-'+Buffer.alloc(64).toString('base64'),url:'https://registry.npmjs.org/tesseract.js/-/tesseract.js-7.0.0.tgz'};
  await writeFile(resolve(dir,'package-lock.json'),JSON.stringify({packages:{'node_modules/tesseract.js':{version:pkg.version,integrity:pkg.integrity,resolved:pkg.url,license:'Apache-2.0'}}}));
  const values={'package.json':JSON.stringify({name:pkg.name,version:pkg.version}),'index.js':'// inert fixture; not executed','docs/pinned.md':'synthetic reviewed file'};
  const files=[];for(const [name,value] of Object.entries(values)){await writeFile(resolve(dir,'node_modules/tesseract.js',name),value);files.push({path:'tesseract.js/'+name,size:Buffer.byteLength(value),sha256:createHash('sha256').update(value).digest('hex')});}
  await writeFile(resolve(dir,'assets/ocr-runtime-lock.json'),JSON.stringify({version:1,packages:[pkg],files}));
  const run=()=>spawnSync(process.execPath,['scripts/release-inventory.mjs'],{cwd:dir,encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(run().status,0);
  await writeFile(resolve(dir,'node_modules/tesseract.js/unregistered.js'),'// unreviewed inert sidecar');let result=run();assert.notEqual(result.status,0);assert.match(result.stderr,/unreviewed file/);
  await rm(resolve(dir,'node_modules/tesseract.js/unregistered.js'));
  await writeFile(resolve(dir,'node_modules/tesseract.js/docs/pinned.md'),'changed');result=run();assert.notEqual(result.status,0);assert.match(result.stderr,/bytes differ/);
  await rm(resolve(dir,'node_modules/tesseract.js/docs/pinned.md'));result=run();assert.notEqual(result.status,0);assert.match(result.stderr,/files are missing/);
});
