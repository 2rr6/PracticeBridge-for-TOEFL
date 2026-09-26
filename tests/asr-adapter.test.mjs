import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAsrConfiguration, resolveAsrScript, validateAsrRequest, scrubAsrEnvironment, runAsrProcess, createAsrWorker } from '../src/workers/asr.mjs';
import { createAsrProvider } from '../src/asr-provider.mjs';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
test('configuration requires deliberately confirmed host paths and exact device/precision', () => {
  const input = { interpreter: path.resolve('python.exe'), modelDirectory: path.resolve('model'), modelId: 'base', device: 'cpu', computeType: 'int8', dllDirectories: [], confirmed: true };
  assert.equal(validateAsrConfiguration(input).device, 'cpu');
  assert.throws(() => validateAsrConfiguration({ ...input, device: 'auto' }));
  assert.throws(() => validateAsrConfiguration({ ...input, confirmed: false }));
  assert.throws(() => validateAsrConfiguration({ ...input, modelId: 'https://example.com' }));
});
const configuration = { interpreter: process.execPath, modelDirectory: path.resolve('missing-model'), modelId: 'base', device: 'cpu', deviceIndex: 0, computeType: 'int8_float32', dllDirectories: [], confirmed: true };
function childDouble(produce) {
  return (...args) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kills = 0;
    child.kill = () => { child.kills++; queueMicrotask(() => child.emit('close', -1)); };
    let input = ''; child.stdin.on('data', bytes => { input += bytes; });
    child.stdin.on('finish', () => produce(child, JSON.parse(input), args));
    return child;
  };
}
const budget = { timeoutMs: 100, maxOutputBytes: 8192, maxInputBytes: 1000, maxDurationSeconds: 10 };
test('simulated OOM remains one local failure; no retries or fallback and no secret environment', async () => {
  let calls = 0;
  const spawnProcess = childDouble((child, input, args) => {
    calls++; assert.equal(args[2].shell, false); assert.deepEqual(args[1].slice(0, 3), ['-I', '-B', '-u']);
    assert.equal(args[2].env.OPENAI_API_KEY, undefined); assert.equal(args[2].env.PYTHONPATH, undefined); assert.equal(input.configuration.profile.files.some(f => f.name === 'tokenizer.json'), true);
    child.stdout.end(JSON.stringify({ protocolVersion: 1, state: 'failed', errorCode: 'out_of_memory' })); child.emit('close', 1);
  });
  await assert.rejects(runAsrProcess({ configuration, request: { operation: 'selftest', budget }, spawnProcess, environment: { OPENAI_API_KEY: 'secret', PYTHONPATH: 'untrusted' } }), { code: 'out_of_memory' });
  assert.equal(calls, 1);
});
test('process output, timeout and cancellation terminate the child', async () => {
  for (const failure of ['output_budget', 'timeout', 'cancelled']) {
    const controller = new AbortController(); let spawned;
    const promise = runAsrProcess({ configuration, request: { operation: 'selftest', budget, cancelToken: controller.signal }, spawnProcess: childDouble(child => { spawned = child; if (failure === 'output_budget') child.stdout.write('x'.repeat(9000)); if (failure === 'cancelled') controller.abort(); }) });
    await assert.rejects(promise, { code: failure }); assert.equal(spawned.kills, 1);
  }
});
test('protocol rejects a transcript that was not produced by returned segments', async () => {
  const result = { protocolVersion: 1, state: 'completed', actual: { engine: 'faster-whisper', device: 'cpu', deviceIndex: [0], computeType: 'int8_float32', modelId: 'Systran/faster-whisper-base', modelRevision: 'ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66', versions: { 'faster-whisper': '1.2.1', ctranslate2: '4.8.2', av: '18.1.0' } }, segments: [], transcript: 'This invented text has no segment.', durationSeconds: 1 };
  await assert.rejects(runAsrProcess({ configuration, request: { operation: 'selftest', budget }, spawnProcess: childDouble(child => { child.stdout.end(JSON.stringify(result)); child.emit('close', 0); }) }), { code: 'protocol_invalid' });
});
test('a missing model is a real preflight state and never launches Python', async () => {
  let calls = 0;
  const worker = createAsrWorker({ configuration, spawnProcess: () => { calls++; } });
  await assert.rejects(worker.selfTest(), /模型/); assert.equal(calls, 0);
});
test('saved paths cannot autorun; cancelled selftest cannot overwrite reselected configuration', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'asr-provider-'));
  let finish;
  const workerFactory = () => ({ selfTest: () => new Promise(resolve => { finish = resolve; }) });
  const provider = await createAsrProvider({ dataDir: directory, workerFactory });
  try {
    assert.throws(() => provider.selfTest());
    await provider.configure(configuration); provider.selfTest(); provider.disable();
    finish({ actual: { device: 'cuda' } }); await new Promise(resolve => setImmediate(resolve));
    assert.equal(provider.view().state, 'disabled'); assert.equal(provider.view().result, undefined);
    const restored = await createAsrProvider({ dataDir: directory, workerFactory });
    assert.equal(restored.view().state, 'unconfirmed'); assert.equal(restored.view().configuration.confirmed, false); assert.throws(() => restored.selfTest());
    restored.close();
  } finally { provider.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
test('packaged worker is outside asar and environment does not inherit credentials', () => {
  assert.match(resolveAsrScript(path.resolve('app.asar')), /app\.asar\.unpacked[\\/]tools[\\/]asr-worker[\\/]worker.py$/);
  const env = scrubAsrEnvironment({ SystemRoot: 'C:/Windows', PATH: 'x', OPENAI_API_KEY: 'secret', HF_TOKEN: 'secret', PYTHONPATH: 'evil',Python_Manager_Automatic_Install:'1',PyLauncher_Allow_Install:'1',PYLAUNCHER_ALWAYS_INSTALL:'1' });
  assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.PYTHONPATH, undefined); assert.equal(env.HF_HUB_OFFLINE, '1');
  assert.equal(env.PYTHON_MANAGER_AUTOMATIC_INSTALL,'0');assert.equal(Object.keys(env).some(key=>/^PYLAUNCHER_(ALLOW_INSTALL|ALWAYS_INSTALL)$/i.test(key)),false);assert.equal(Object.keys(env).filter(key=>/^PYTHON_MANAGER_AUTOMATIC_INSTALL$/i.test(key)).length,1);
});
test('material request accepts only bounded internal asset IDs and time ranges', () => {
  const input = { jobId: 'job', expectedEpoch: 1, sourceRevision: 2, toolId: 'media.transcribe', inputAssetIds: ['a'.repeat(64)], parameters: { startSeconds: 0, endSeconds: 10 }, budget: { timeoutMs: 60000, maxOutputBytes: 65536, maxDurationSeconds: 10, maxInputBytes: 1000000 } };
  assert.equal(validateAsrRequest(input).parameters.endSeconds, 10);
  assert.equal(validateAsrRequest({ ...input, sourceRevision: 'b'.repeat(64), expectedEpoch: 'workspace-epoch' }).sourceRevision, 'b'.repeat(64));
  assert.throws(() => validateAsrRequest({ ...input, parameters: { path: 'C:/private.wav' } }));
  assert.throws(() => validateAsrRequest({ ...input, parameters: { startSeconds: 0, endSeconds: 30 } }));
  assert.throws(() => validateAsrRequest({ ...input, inputAssetIds: ['http://example.com/audio'] }));
});

test('F3 production response records actual PCM scope and classifies a short EOF as partial',async()=>{
  const cases=[
    {range:{startSeconds:0,endSeconds:30},duration:1,state:'partial',decoded:{startSeconds:0,endSeconds:1}},
    {range:{startSeconds:0,endSeconds:1},duration:1,state:'completed',decoded:{startSeconds:0,endSeconds:1}},
    {range:{startSeconds:1.25,endSeconds:1.75},duration:0.5,state:'completed',decoded:{startSeconds:1.25,endSeconds:1.75}},
    {range:{startSeconds:0.25001,endSeconds:1.25001},duration:1,state:'completed',decoded:{startSeconds:0.25,endSeconds:1.25}},
    {range:{startSeconds:0,endSeconds:1},duration:15999/16000,state:'partial',decoded:{startSeconds:0,endSeconds:15999/16000}},
    {range:{startSeconds:0,endSeconds:6.1428125},duration:6.1428125,state:'completed',decoded:{startSeconds:0,endSeconds:6.1428125}},
  ];
  for(const item of cases){const result=await runAsrProcess({configuration,request:{operation:'transcribe',parameters:item.range,budget:{...budget,maxDurationSeconds:30}},spawnProcess:childDouble((child,input)=>{child.stdout.end(JSON.stringify({protocolVersion:1,state:'completed',actual:{engine:'faster-whisper',device:'cpu',deviceIndex:[0],computeType:'int8_float32',modelId:input.configuration.profile.model_id,modelRevision:input.configuration.profile.revision,versions:{'faster-whisper':'1.2.1',ctranslate2:'4.8.2',av:'18.1.0'}},segments:[{start:Math.round(item.range.startSeconds*1000)/1000,end:Math.round((item.range.startSeconds+item.duration)*1000)/1000,text:'The gate opens.',avgLogprob:-0.1,noSpeechProb:0}],transcript:'The gate opens.',durationSeconds:item.duration,elapsedSeconds:1}));child.emit('close',0);})});assert.equal(result.state,item.state);assert.deepEqual(result.requestedRange,item.range);assert.deepEqual(result.decodedRange,item.decoded);assert.equal(result.rangeComplete,item.state==='completed');assert.equal(result.rangePrecision,'pcm-16000-floor-v1');}
});
