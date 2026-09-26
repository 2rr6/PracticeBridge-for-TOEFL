// Fresh, bounded Node resolution only. No requested package is required or
// imported; no OCR code is executed by this preflight.
const path = require('node:path');
const { createRequire } = require('node:module');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  if (Buffer.byteLength(input) > 512 * 1024) process.exit(1);
});
process.stdin.on('end', () => {
  try {
    const payload=JSON.parse(input),{ runtimeRoot, requests, launch }=payload;
    if(Object.keys(payload).some(key=>!['runtimeRoot','requests','launch'].includes(key)))throw Error();
    if (!path.isAbsolute(runtimeRoot) || !Array.isArray(requests) || requests.length > 2500) throw Error();
    if(launch){
      const equal=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
      if(!launch||Object.keys(launch).some(key=>!['executionRoot','executable','entryPath'].includes(key))||typeof launch.executionRoot!=='string'||!path.isAbsolute(launch.executionRoot)||!equal(path.resolve(process.cwd()),launch.executionRoot)||!equal(path.resolve(runtimeRoot),path.join(launch.executionRoot,'node_modules'))||!equal(launch.executable,process.execPath)||!equal(launch.entryPath,__filename))throw Error();
    }
    const name = value => typeof value === 'string' && /^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(value);
    const results = requests.map(request => {
      if (!name(request.from) || !name(request.dependency)) throw Error();
      try {
        const entry = createRequire(path.join(runtimeRoot, request.from, 'package.json')).resolve(request.dependency);
        return { ...request, entry };
      } catch { return { ...request, error: 'unresolved' }; }
    });
    process.stdout.write(JSON.stringify({ results }));
  } catch { process.exitCode = 1; }
});
