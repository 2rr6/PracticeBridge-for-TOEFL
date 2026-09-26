// Tesseract's Node selector chooses its own core entry. Record the module it
// actually loads; corePath alone does not control this selection.
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {fileURLToPath} = require('node:url');
const coreNames = new Set(['tesseract-core','tesseract-core-lstm','tesseract-core-simd','tesseract-core-simd-lstm','tesseract-core-relaxedsimd','tesseract-core-relaxedsimd-lstm']);

function installCoreRecorder({runtime,receipt,expectedFiles}) {
  if (!runtime || !receipt || !path.isAbsolute(runtime) || !path.isAbsolute(receipt)) throw Error('OCR host configuration missing');
  const unverified=message=>Object.assign(new Error(message),{code:'OCR_CORE_UNVERIFIED'});
  if(!Array.isArray(expectedFiles)||expectedFiles.length<2||expectedFiles.length>12)throw unverified('OCR trusted core hashes missing');
  const expected=new Map();
  for(const file of expectedFiles){
    if(!file||Object.keys(file).some(key=>!['name','sha256'].includes(key))||typeof file.name!=='string'||!/^tesseract\.js-core\/tesseract-core(?:-(?:simd|relaxedsimd))?(?:-lstm)?\.(?:js|wasm)$/.test(file.name)||!/^[a-f0-9]{64}$/.test(file.sha256||'')||expected.has(file.name))throw unverified('OCR trusted core hashes invalid');
    expected.set(file.name,file.sha256);
  }
  const originalLoad=Module._load,originalRead=fs.readFileSync,originalJavaScript=Module._extensions['.js'],coreRoot=path.resolve(runtime,'tesseract.js-core');
  const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
  // The launch verifier accepts Windows case aliases. All consumer checks must
  // use that same identity, including direct fs reads and cache provenance.
  const identity=value=>process.platform==='win32'?value.toLowerCase():value;
  const pathIdentity=value=>identity(path.resolve(value));
  const relative=file=>identity(path.relative(runtime,file).replaceAll('\\','/'));
  const samePath=(a,b)=>pathIdentity(a)===pathIdentity(b);
  const inCore=file=>typeof file==='string'&&path.isAbsolute(file)&&pathIdentity(file).startsWith(pathIdentity(coreRoot)+path.sep);
  const checkedPath=file=>{const absolute=path.resolve(file);let current=path.parse(absolute).root;for(const part of ['',...path.relative(current,absolute).split(path.sep).filter(Boolean)]){if(part)current=path.join(current,part);if(fs.lstatSync(current).isSymbolicLink())throw unverified('OCR core path was redirected');}if(!samePath(fs.realpathSync(absolute),absolute))throw unverified('OCR core physical path changed');return absolute;};
  const isCore=file=>inCore(file)&&samePath(path.dirname(file),coreRoot)&&identity(path.basename(file)).endsWith('.js')&&coreNames.has(identity(path.basename(file)).slice(0,-3));
  let selection=null;
  Module._load=function(id,parent,isMain) {
    const resolved=Module._resolveFilename(id,parent,isMain);
    if(inCore(resolved)&&/\.(?:js|cjs|mjs)$/i.test(resolved)&&!isCore(resolved))throw unverified('OCR Node core entry is not approved');
    if(isCore(resolved)){
      if(selection&&selection.coreEntry!==relative(resolved))throw Error('OCR core changed within one worker');
      if(!selection){
        // This recorder is installed before the fixed worker entry. An entry
        // already in require.cache would not establish which bytes were loaded.
        if(Object.keys(require.cache).some(file=>samePath(file,resolved)))throw Error('OCR core was loaded before provenance recording');
      }
    }
    return originalLoad.apply(this,arguments);
  };
  Module._extensions['.js']=function(module,filename){
    if(!inCore(filename))return originalJavaScript(module,filename);
    if(!isCore(filename))throw unverified('OCR Node core entry is not approved');
    checkedPath(filename);const coreEntry=relative(filename),bytes=originalRead.call(fs,filename),coreHash=digest(bytes);
    if(expected.get(coreEntry)!==coreHash||!expected.has(coreEntry.slice(0,-3)+'.wasm'))throw unverified('OCR core JS changed before use');
    selection={coreEntry,coreHash};
    // Compile these verified bytes. Calling the default loader here would read
    // the path again and create a check/read race before executing the JS.
    module._compile(bytes.toString('utf8'),filename);
  };
  fs.readFileSync=function(file,...options) {
    const absolute=file instanceof URL?fileURLToPath(file):typeof file==='string'?path.resolve(file):null;
    if(absolute&&inCore(absolute)&&/\.wasm$/i.test(absolute)){
      if(!samePath(path.dirname(absolute),coreRoot))throw unverified('OCR WASM path is not approved');
      checkedPath(absolute);
      const wasmEntry=relative(absolute);
      if(!selection||wasmEntry!==selection.coreEntry.slice(0,-3)+'.wasm')throw Error('OCR loaded an unpaired WASM file');
      const bytes=originalRead.call(this,file,...options);
      if(!Buffer.isBuffer(bytes))throw unverified('OCR WASM bytes are invalid');
      const wasmHash=digest(bytes);
      if(expected.get(wasmEntry)!==wasmHash||selection.wasmHash&&selection.wasmHash!==wasmHash)throw unverified('OCR WASM changed before use');
      selection={...selection,wasmEntry,wasmHash};
      // These are bytes returned to Emscripten, not a guessed sibling path.
      fs.writeFileSync(receipt,JSON.stringify(selection),{flag:'w'});
      return bytes;
    }
    return originalRead.call(this,file,...options);
  };
  return ()=>{Module._load=originalLoad;Module._extensions['.js']=originalJavaScript;fs.readFileSync=originalRead;};
}

module.exports={installCoreRecorder};
if(require.main===module){
  const runtime=process.env.PRACTICEBRIDGE_OCR_RUNTIME,receipt=process.env.PRACTICEBRIDGE_OCR_CORE_RECEIPT;
  const expected=process.env.PRACTICEBRIDGE_OCR_CORE_FILES;if(!expected||Buffer.byteLength(expected)>16384)throw Error('OCR trusted core hashes missing');
  installCoreRecorder({runtime,receipt,expectedFiles:JSON.parse(expected)});
  require(path.join(runtime,'tesseract.js/src/worker-script/node/index.js'));
}
