import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startServer } from '../src/server.mjs';
import { readZip } from '../src/package.mjs';
import { appFetch } from './auth-client.mjs';

test('ASR configuration requires app authentication, stays outside backup, and restarts unconfirmed', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-asr-api-'));
  let runtime = await startServer({ dataDir: directory });
  t.after(async () => { await runtime.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const configuration = { interpreter: process.execPath, modelDirectory: path.join(directory, 'UNEXPORTED-MODEL-PATH'), modelId: 'base', device: 'cpu', deviceIndex: 0, computeType: 'int8_float32', dllDirectories: [], confirmed: true };
  const post = (name, body, authenticated = true) => (authenticated ? appFetch : fetch)(runtime.url + name, { method: 'POST', headers: { 'X-PracticeBridge': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('/api/asr/configure', configuration, false)).status, 403);
  assert.equal((await post('/api/asr/configure', { ...configuration, command: 'untrusted' })).status, 400);
  assert.equal((await post('/api/asr/configure', configuration)).status, 200);
  const state = await (await fetch(runtime.url + '/api/state')).json();
  assert(!JSON.stringify(state).includes('UNEXPORTED-MODEL-PATH'));
  const backup = await readZip(Buffer.from(await (await fetch(runtime.url + '/api/backup')).arrayBuffer()));
  assert.deepEqual([...backup.keys()], ['practicebridge-backup.json']);
  assert(![...backup.values()].some(bytes => bytes.includes(Buffer.from('UNEXPORTED-MODEL-PATH'))));
  await runtime.close(); runtime = await startServer({ dataDir: directory });
  const status = await (await fetch(runtime.url + '/api/asr')).json();
  assert.equal(status.state, 'unconfirmed'); assert.equal(status.configuration.confirmed, false);
  assert.equal((await post('/api/asr/test', {})).status, 409);
});
