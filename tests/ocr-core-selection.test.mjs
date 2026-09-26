import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {installCoreRecorder} from '../src/workers/ocr-thread.cjs';
import {assertOcrCoreSelection,hash} from '../src/ocr-policy.mjs';

const require=createRequire(import.meta.url);
async function fixture(body){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pb-ocr-core-record-')),runtime=path.join(dir,'node_modules'),coreRoot=path.join(runtime,'tesseract.js-core');
  await fs.mkdir(coreRoot,{recursive:true});
  const entry=path.join(coreRoot,'tesseract-core-relaxedsimd-lstm.js'),wasm=path.join(coreRoot,'tesseract-core-relaxedsimd-lstm.wasm'),receipt=path.join(dir,'receipt.json');
  await fs.writeFile(entry,body);await fs.writeFile(wasm,'authored recorder protocol bytes; not a WASM engine');
  return {dir,runtime,entry,wasm,receipt};
}
async function cleanup(f){delete require.cache[f.entry];const target=path.resolve(f.dir);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('pb-ocr-core-record-'));await fs.rm(target,{recursive:true,force:true});}
async function recorderOptions(f){return {...f,expectedFiles:[{name:'tesseract.js-core/tesseract-core-relaxedsimd-lstm.js',sha256:hash(await fs.readFile(f.entry))},{name:'tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm',sha256:hash(await fs.readFile(f.wasm))}]};}

test('core recorder observes external WASM bytes and retains the first actual module load across require cache hits',async()=>{
  // Controlled protocol fixture only. Actual Tesseract recognition is verified
  // separately with the approved official archives and authored images.
  const body="module.exports=()=>require('node:fs').readFileSync(require('node:path').join(__dirname,'tesseract-core-relaxedsimd-lstm.wasm'));";
  const f=await fixture(body);let restore;
  try{
    restore=installCoreRecorder(await recorderOptions(f));const readWasm=require(f.entry);
    await assert.rejects(fs.stat(f.receipt),e=>e.code==='ENOENT','file existence does not establish a WASM load');
    readWasm();const first=JSON.parse(await fs.readFile(f.receipt,'utf8'));
    assert.deepEqual(first,{coreEntry:'tesseract.js-core/tesseract-core-relaxedsimd-lstm.js',coreHash:hash(Buffer.from(body)),wasmEntry:'tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm',wasmHash:hash(await fs.readFile(f.wasm))});
    await fs.writeFile(f.entry,'module.exports="changed after cached load";');
    assert.equal(require(f.entry),readWasm);readWasm();assert.deepEqual(JSON.parse(await fs.readFile(f.receipt,'utf8')),first,'cache hit must not claim newly written source bytes were executed');
    await fs.writeFile(f.wasm,'changed WASM');assert.throws(readWasm,/WASM changed/);
  }finally{restore?.();await cleanup(f);}
});

test('core recorder refuses a module cached before recording and a mismatched external WASM',async()=>{
  const f=await fixture('module.exports=27;');let restore;
  try{
    require(f.entry);restore=installCoreRecorder(await recorderOptions(f));assert.throws(()=>require(f.entry),/loaded before provenance/);restore();restore=null;delete require.cache[f.entry];
    await fs.writeFile(f.entry,"module.exports=()=>require('node:fs').readFileSync(require('node:path').join(__dirname,'tesseract-core-simd-lstm.wasm'));");
    await fs.writeFile(path.join(path.dirname(f.wasm),'tesseract-core-simd-lstm.wasm'),'wrong paired bytes');restore=installCoreRecorder(await recorderOptions(f));
    assert.throws(require(f.entry),/unpaired WASM/);await assert.rejects(fs.stat(f.receipt),e=>e.code==='ENOENT');
  }finally{restore?.();await cleanup(f);}
});

test('a core JS changed after its trusted snapshot is refused before any marker code executes',async()=>{
  const f=await fixture('module.exports=27;'),options=await recorderOptions(f),marker=path.join(path.dirname(f.entry),'executed.txt');let restore;
  try{
    await fs.writeFile(f.entry,"require('node:fs').writeFileSync(require('node:path').join(__dirname,'executed.txt'),'changed code executed');module.exports=28;");
    restore=installCoreRecorder(options);assert.throws(()=>require(f.entry),e=>e.code==='OCR_CORE_UNVERIFIED');
    await assert.rejects(fs.stat(marker),e=>e.code==='ENOENT','changed code must not execute before a later host rejection');
  }finally{restore?.();await cleanup(f);}
});

test('WASM changed after its trusted snapshot is refused before read bytes reach a consumer',async()=>{
  const f=await fixture("module.exports=()=>require('node:fs').readFileSync(require('node:path').join(__dirname,'tesseract-core-relaxedsimd-lstm.wasm'));"),options=await recorderOptions(f);let restore,consumed=false;
  try{
    await fs.writeFile(f.wasm,'changed consumer bytes');restore=installCoreRecorder(options);const read=require(f.entry);
    assert.throws(()=>{read();consumed=true;},e=>e.code==='OCR_CORE_UNVERIFIED');assert.equal(consumed,false);
    await assert.rejects(fs.stat(f.receipt),e=>e.code==='ENOENT');
  }finally{restore?.();await cleanup(f);}
});

test('Windows case-equivalent runtime cannot let changed core JS execute a marker',{skip:process.platform!=='win32'},async()=>{
  const f=await fixture('module.exports=27;'),options=await recorderOptions(f),marker=path.join(path.dirname(f.entry),'case-alias-executed.txt');let restore,error=null;
  try{
    await fs.writeFile(f.entry,"require('node:fs').writeFileSync(require('node:path').join(__dirname,'case-alias-executed.txt'),'changed code executed');module.exports=28;");
    restore=installCoreRecorder({...options,runtime:f.runtime.toLowerCase()});try{require(f.entry);}catch(value){error=value;}
    const markerExecuted=await fs.stat(marker).then(()=>true,value=>{if(value.code!=='ENOENT')throw value;return false;});
    assert.deepEqual({code:error?.code||null,markerExecuted},{code:'OCR_CORE_UNVERIFIED',markerExecuted:false});
  }finally{restore?.();await cleanup(f);}
});

test('Windows uppercase WASM alias cannot return changed bytes to its consumer',{skip:process.platform!=='win32'},async()=>{
  const f=await fixture("module.exports=()=>require('node:fs').readFileSync(require('node:path').join(__dirname,'tesseract-core-relaxedsimd-lstm.wasm').toUpperCase());"),options=await recorderOptions(f);let restore,error=null,consumed=false;
  try{
    await fs.writeFile(f.wasm,'changed case-alias consumer bytes');restore=installCoreRecorder(options);
    try{require(f.entry)();consumed=true;}catch(value){error=value;}
    assert.deepEqual({code:error?.code||null,consumed},{code:'OCR_CORE_UNVERIFIED',consumed:false});await assert.rejects(fs.stat(f.receipt),value=>value.code==='ENOENT');
  }finally{restore?.();await cleanup(f);}
});

test('verified Windows case aliases preserve canonical JS and WASM receipt identities',{skip:process.platform!=='win32'},async()=>{
  const f=await fixture("module.exports=()=>require('node:fs').readFileSync(require('node:path').join(__dirname,'tesseract-core-relaxedsimd-lstm.wasm').toUpperCase());"),options=await recorderOptions(f);let restore;
  try{
    restore=installCoreRecorder({...options,runtime:f.runtime.toLowerCase()});assert.deepEqual(require(f.entry)(),await fs.readFile(f.wasm));
    const receipt=JSON.parse(await fs.readFile(f.receipt,'utf8'));assert.deepEqual(receipt,{coreEntry:options.expectedFiles[0].name,coreHash:options.expectedFiles[0].sha256,wasmEntry:options.expectedFiles[1].name,wasmHash:options.expectedFiles[1].sha256});
  }finally{restore?.();await cleanup(f);}
});

test('unapproved Windows core spelling cannot fall through to the ordinary JS loader',{skip:process.platform!=='win32'},async()=>{
  const f=await fixture('module.exports=27;'),options=await recorderOptions(f),other=path.join(path.dirname(f.entry),'tesseract-core-relaxedsimd-lstm.wasm.js'),marker=path.join(path.dirname(f.entry),'unapproved-executed.txt');let restore,error=null;
  try{
    await fs.writeFile(other,"require('node:fs').writeFileSync(require('node:path').join(__dirname,'unapproved-executed.txt'),'unapproved code executed');");
    restore=installCoreRecorder({...options,runtime:f.runtime.toLowerCase()});try{require(other);}catch(value){error=value;}
    const markerExecuted=await fs.stat(marker).then(()=>true,value=>{if(value.code!=='ENOENT')throw value;return false;});assert.deepEqual({code:error?.code||null,markerExecuted},{code:'OCR_CORE_UNVERIFIED',markerExecuted:false});
  }finally{restore?.();delete require.cache[other];await cleanup(f);}
});

test('host accepts only an observed JS and paired WASM whose byte hashes both match the runtime lock',()=>{
  const selection={coreEntry:'tesseract.js-core/tesseract-core-relaxedsimd-lstm.js',coreHash:'a'.repeat(64),wasmEntry:'tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm',wasmHash:'b'.repeat(64)},files=[{name:selection.coreEntry,sha256:selection.coreHash},{name:selection.wasmEntry,sha256:selection.wasmHash}];
  assert.deepEqual(assertOcrCoreSelection(selection,files),selection);
  for(const bad of [{...selection,coreHash:'c'.repeat(64)},{...selection,wasmHash:'c'.repeat(64)},{...selection,coreEntry:selection.coreEntry.replace('.js','.wasm.js')},{...selection,wasmEntry:'tesseract.js-core/tesseract-core-simd-lstm.wasm'},{...selection,wasmHash:undefined}])assert.throws(()=>assertOcrCoreSelection(bad,files),e=>e.code==='OCR_CORE_UNVERIFIED');
  assert.throws(()=>assertOcrCoreSelection(selection,files.slice(0,1)),e=>e.code==='OCR_CORE_UNVERIFIED');
});
